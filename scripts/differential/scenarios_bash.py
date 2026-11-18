"""Loopback Bash scenario: the mock drives one Bash tool_use per request.

After the plan's last step the mock ends the turn ("waiting"). Both CLIs then
hold a print session open for the running background command and deliver its
completion as a new user turn; the mock answers that turn with DONE.
"""
import http.server
import json
import threading

from mock_api import MODEL, events

DONE = "bash workflow done"
# The dummy HOME's rc file, read by the shell snapshot. The profile denies awk
# and sed, which the snapshot uses to capture options and aliases.
BASHRC = "greet_fn() { echo function from bashrc; }\nalias greet_alias='echo alias from bashrc'\n"
STEPS = [
    {"command": "echo hi"},
    {"command": "cd sub && pwd"},
    {"command": "pwd"},
    {"command": "sh -c 'exit 3'"},
    {"command": "cd / && pwd"},
    {"command": "printf ''"},
    {"command": "echo out; echo err >&2"},
    {"command": "sleep 3", "timeout": 300},
    {"command": "sleep 30"},
    {"command": "greet_fn"},
    {"command": "greet_alias"},
    {"command": "sleep 1; echo bg", "run_in_background": True, "description": "Print bg after a second"},
]


def blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


def text_of(message):
    return "".join(block.get("text", "") for block in blocks(message) if isinstance(block, dict))


class BashMock:
    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()

    def prepare(self, isolation):
        (isolation.root / "work/sub").mkdir()
        (isolation.root / "home/.bashrc").write_text(BASHRC)

    def respond(self, body):
        model = body.get("model", MODEL)
        messages = body.get("messages") or []
        if messages and "<task-notification>" in text_of(messages[-1]):
            return events([{"type": "text", "text": DONE}], "end_turn", model), "notified"
        done = sum(1 for message in messages for block in blocks(message)
                   if isinstance(block, dict) and block.get("type") == "tool_result")
        if done < len(STEPS):
            block = {"type": "tool_use", "id": f"bash-step-{done + 1}", "name": "Bash", "input": STEPS[done]}
            return events([block], "tool_use", model), "step"
        return events([{"type": "text", "text": "waiting"}], "end_turn", model), "waiting"

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
                path = self.path.split("?")[0]
                with state.lock:
                    state.requests.append({"path": self.path, "body": retained})
                    generations = sum(1 for r in state.requests if r["path"].split("?")[0] == "/v1/messages")
                if path == "/v1/messages/count_tokens":
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}'); return
                if path != "/v1/messages" or generations > 24:
                    self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'); return
                stream, kind = state.respond(body)
                with state.lock:
                    state.requests[-1]["kind"] = kind
                if body.get("stream"):
                    self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                    self.wfile.write("".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in stream).encode())
                    return
                content = [e["content_block"] for e in stream if e["type"] == "content_block_start"]
                for e in stream:
                    if e["type"] == "content_block_delta" and e["delta"]["type"] == "text_delta":
                        content[e["index"]]["text"] += e["delta"]["text"]
                    if e["type"] == "content_block_delta" and e["delta"]["type"] == "input_json_delta":
                        content[e["index"]]["input"] = json.loads(e["delta"]["partial_json"])
                stop = next(e["delta"]["stop_reason"] for e in stream if e["type"] == "message_delta")
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps({"id": "msg_bash", "type": "message", "role": "assistant", "model": body.get("model", MODEL),
                                             "content": content, "stop_reason": stop, "stop_sequence": None,
                                             "usage": {"input_tokens": 10, "output_tokens": 3}}).encode())
        return Handler
