"""Loopback Monitor and worktree scenarios: the mock drives ToolSearch, then the tools.

`monitor` loads Monitor and watches a command that prints three lines and exits; the
lines carry no sleep (the isolation profile does not grant /bin/sleep), so they arrive
as one batched event. Every later request gets an idle text answer, so the capture shows
which notifications reach the model and when.

`worktree` first records whether git runs inside the profile (/usr/bin/git is granted,
but on macOS it is the xcrun shim, which may need the developer tools outside it). It
then creates a worktree, runs pwd in it, dirties it, tries remove (refused), keeps it,
and runs pwd back home. If git is unavailable the EnterWorktree result records that.
"""
import http.server
import json
import threading

from mock_api import MODEL, events

VARIANTS = ["monitor", "worktree"]
GIT_INIT = ("git --version; git init -q -b main && git -c user.email=t@t -c user.name=t "
            "commit -q --allow-empty -m init; echo git-exit=$?")
PLANS = {
    "monitor": [
        ("ToolSearch", {"query": "select:Monitor", "max_results": 5}),
        ("Monitor", {"description": "count lines", "command": "echo line1; echo line2; echo line3"}),
    ],
    "worktree": [
        ("Bash", {"command": GIT_INIT, "description": "Make a repository"}),
        ("ToolSearch", {"query": "select:EnterWorktree,ExitWorktree", "max_results": 5}),
        ("EnterWorktree", {"name": "diff-x"}),
        ("Bash", {"command": "pwd; git branch --show-current", "description": "Where am I"}),
        ("Bash", {"command": "echo hi > new.txt", "description": "Dirty the worktree"}),
        ("ExitWorktree", {"action": "remove"}),
        ("ExitWorktree", {"action": "keep"}),
        ("Bash", {"command": "pwd; git worktree list --porcelain", "description": "Back home"}),
    ],
}


def _blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


class MonitorWorktreeMock:
    def __init__(self, variant):
        if variant not in VARIANTS:
            raise ValueError("Unknown monitor/worktree variant")
        self.variant = variant
        self.requests = []
        self.lock = threading.Lock()

    def respond(self, body):
        model = body.get("model", MODEL)
        blocks = [block for message in body.get("messages") or [] for block in _blocks(message) if isinstance(block, dict)]
        done = sum(1 for block in blocks if block.get("type") == "tool_result")
        plan = PLANS[self.variant]
        if done < len(plan):
            name, value = plan[done]
            return events([{"type": "tool_use", "id": f"step-{done + 1}", "name": name, "input": value}], "tool_use", model), "main"
        return events([{"type": "text", "text": f"idle after {done} results"}], "end_turn", model), "idle"

    def handler(self):
        state = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_response(413); self.end_headers(); return
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_response(400); self.end_headers(); return
                retained = dict(body); retained.pop("metadata", None)
                with state.lock:
                    state.requests.append({"path": self.path, "body": retained})
                    generations = sum(1 for r in state.requests if r["path"].split("?")[0] == "/v1/messages")
                path = self.path.split("?")[0]
                if path == "/v1/messages/count_tokens":
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}'); return
                if path != "/v1/messages" or generations > 24:
                    self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'); return
                stream, kind = state.respond(body)
                with state.lock:
                    state.requests[-1]["kind"] = kind
                if not body.get("stream"):
                    self.send_response(400); self.end_headers(); return
                self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                self.wfile.write("".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in stream).encode())
        return Handler
