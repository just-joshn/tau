"""Loopback async command-hook scenarios: a PostToolUse:Read hook with `async`/`asyncRewake`.

The hook is a POSIX sh script (only /bin/sh is executable in the profile). It touches a
marker when it has written its output; the mock holds the response that must follow the
hook until that marker exists, so delivery order does not race the hook.
"""
import json
import threading
import time

from mock_api import MODEL, events

HOOK = r"""#!/bin/sh
variant="$1"; marker="$2"
cat > /dev/null
case "$variant" in
  async-response)
    printf '%s\n' '{"async":true}' '{"systemMessage":"ASYNC_SYSTEM","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"ASYNC_CONTEXT"}}'
    : > "$marker"; exit 0 ;;
  async-silent)
    printf '%s\n' '{"async":true}'; : > "$marker"; exit 0 ;;
  rewake-late)
    start=$SECONDS; while [ $((SECONDS - start)) -lt 3 ]; do :; done
    printf 'REWAKE_FEEDBACK' >&2; : > "$marker"; exit 2 ;;
  rewake-exit0) printf 'REWAKE_FEEDBACK' >&2; : > "$marker"; exit 0 ;;
  rewake-exit1) printf 'REWAKE_FEEDBACK' >&2; : > "$marker"; exit 1 ;;
  *) printf 'REWAKE_FEEDBACK' >&2; : > "$marker"; exit 2 ;;
esac
"""

# variant: (hook flags, mock plan). A plan entry is (response, wait for the hook marker first).
READ = ("tool", {"file_path": "note.txt"})
VARIANTS = {
    "async-response": ({"async": True}, [(READ, False), (READ, True), (("text", "done"), False)]),
    "async-silent": ({"async": True}, [(READ, False), (READ, True), (("text", "done"), False)]),
    "rewake-exit2": ({"async": True, "asyncRewake": True},
                     [(READ, False), (("text", "first answer"), True), (("text", "woken answer"), False)]),
    "rewake-exit0": ({"async": True, "asyncRewake": True}, [(READ, False), (("text", "only answer"), True)]),
    "rewake-exit1": ({"async": True, "asyncRewake": True}, [(READ, False), (("text", "only answer"), True)]),
    "rewake-late": ({"async": True, "asyncRewake": True}, [(READ, False), (("text", "only answer"), False)]),
    "rewake-sync": ({"asyncRewake": True}, [(READ, False), (("text", "only answer"), False)]),
}
MARKERS = ["ASYNC_SYSTEM", "ASYNC_CONTEXT", "REWAKE_FEEDBACK"]


def settings(variant, sh, script, marker):
    flags, _plan = VARIANTS[variant]
    hook = {"type": "command", "command": sh, "args": [str(script), variant, str(marker)], "timeout": 20, **flags}
    return {"hooks": {"PostToolUse": [{"matcher": "Read", "hooks": [hook]}]}}


def _blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


def summarize(requests):
    """Per model request: user text blocks carrying hook output or a task notification."""
    rows = []
    for index, request in enumerate(r for r in requests if r["path"].split("?")[0] == "/v1/messages"):
        carried = []
        for message in request["body"].get("messages", []):
            if message.get("role") != "user":
                continue
            for block in _blocks(message):
                text = block.get("text") if block.get("type") == "text" else json.dumps(block.get("content"))
                if isinstance(text, str) and ("<task-notification>" in text or any(m in text for m in MARKERS)):
                    carried.append({"type": block.get("type"), "text": text})
        rows.append({"request": index + 1, "carried": carried})
    return rows


class AsyncHookMock:
    def __init__(self, variant):
        if variant not in VARIANTS:
            raise ValueError("Unknown async hook variant")
        self.variant = variant
        self.plan = VARIANTS[variant][1]
        self.marker = None
        self.requests = []
        self.lock = threading.Lock()

    def respond(self, generation, model):
        if generation > len(self.plan):
            return None
        (kind, value), wait = self.plan[generation - 1]
        if wait:
            deadline = time.monotonic() + 15
            while self.marker is not None and not self.marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            time.sleep(0.3)
        if kind == "tool":
            return events([{"type": "tool_use", "id": f"async-hook-{generation}", "name": "Read", "input": value}], "tool_use", model)
        return events([{"type": "text", "text": value}], "end_turn", model)

    def handler(self):
        import http.server
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
                    state.requests.append({"path": self.path, "body": retained, "at": time.monotonic()})
                    generation = sum(1 for r in state.requests if r["path"].split("?")[0] == "/v1/messages")
                if path == "/v1/messages/count_tokens":
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}'); return
                stream = state.respond(generation, body.get("model", MODEL)) if path == "/v1/messages" else None
                if stream is None:
                    self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'); return
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
                self.wfile.write(json.dumps({"id": "msg_async_hook", "type": "message", "role": "assistant", "model": body.get("model", MODEL),
                                             "content": content, "stop_reason": stop, "stop_sequence": None,
                                             "usage": {"input_tokens": 10, "output_tokens": 3}}).encode())
        return Handler
