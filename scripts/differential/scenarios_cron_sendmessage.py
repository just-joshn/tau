"""Loopback cron and SendMessage scenarios: the mock drives ToolSearch, then the tools.

`session` loads the four tools, creates a session job, lists it, refuses a bad
cron expression, cancels the job by the id in the create result, then sends to
main and to an unknown name.

`durable` loads CronCreate and writes one recurring job with durable true.
The runner records `.claude/scheduled_tasks.json` under the sandbox work dir.
"""
import http.server
import json
import re
import threading

from mock_api import MODEL, events

VARIANTS = ["session", "durable"]


def _blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


def _text(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return ""


def _job_id(blocks):
    for block in blocks:
        if block.get("type") != "tool_result":
            continue
        match = re.search(r"Scheduled recurring job ([0-9a-f]{8})", _text(block))
        if match:
            return match.group(1)
    return "missing"


def _use(done, name, value):
    return {"type": "tool_use", "id": f"step-{done + 1}", "name": name, "input": value}


class CronSendMessageMock:
    def __init__(self, variant):
        if variant not in VARIANTS:
            raise ValueError("Unknown cron/send variant")
        self.variant = variant
        self.requests = []
        self.lock = threading.Lock()

    def respond(self, body):
        model = body.get("model", MODEL)
        blocks = [
            block
            for message in body.get("messages") or []
            for block in _blocks(message)
            if isinstance(block, dict)
        ]
        done = sum(1 for block in blocks if block.get("type") == "tool_result")
        job = _job_id(blocks)
        if self.variant == "session":
            plan = [
                _use(done, "ToolSearch", {
                    "query": "select:CronCreate,CronDelete,CronList,SendMessage",
                    "max_results": 5,
                }),
                _use(done, "CronCreate", {"cron": "7 * * * *", "prompt": "ping the build"}),
                _use(done, "CronList", {}),
                _use(done, "CronCreate", {"cron": "not a cron", "prompt": "nope"}),
                _use(done, "CronDelete", {"id": job}),
                _use(done, "SendMessage", {"to": "main", "message": "hello"}),
                _use(done, "SendMessage", {"to": "nobody", "message": "hi"}),
            ]
        else:
            plan = [
                _use(done, "ToolSearch", {"query": "select:CronCreate", "max_results": 5}),
                _use(done, "CronCreate", {
                    "cron": "*/5 * * * *",
                    "prompt": "keep this",
                    "durable": True,
                }),
            ]
        if done < len(plan):
            return events([plan[done]], "tool_use", model), "main"
        return events([{"type": "text", "text": f"idle after {done} results"}], "end_turn", model), "idle"

    def handler(self):
        state = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_response(413)
                    self.end_headers()
                    return
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_response(400)
                    self.end_headers()
                    return
                retained = dict(body)
                retained.pop("metadata", None)
                with state.lock:
                    state.requests.append({"path": self.path, "body": retained})
                    generations = sum(
                        1 for item in state.requests if item["path"].split("?")[0] == "/v1/messages"
                    )
                path = self.path.split("?")[0]
                if path == "/v1/messages/count_tokens":
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}')
                    return
                if path != "/v1/messages" or generations > 24:
                    self.send_response(400)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        b'{"error":{"type":"invalid_request_error","message":"Unexpected mock request"}}'
                    )
                    return
                stream, kind = state.respond(body)
                with state.lock:
                    state.requests[-1]["kind"] = kind
                if not body.get("stream"):
                    self.send_response(400)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self.wfile.write(
                    "".join(
                        "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                        for event in stream
                    ).encode()
                )

        return Handler
