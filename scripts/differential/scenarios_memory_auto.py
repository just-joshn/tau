"""Auto memory scenario: one session saves a memory, the next reads MEMORY.md back.

Stage `save` writes a topic file and the MEMORY.md index into the auto memory folder
with absolute paths and no permission flags, so each Write lands only through the
original's "auto memory files are allowed for writing" allowance. Stage `recall`
answers with text; its request must carry MEMORY.md. The folder is
<config>/projects/<cwd with every non-alphanumeric as '-'>/memory/ for a non-git cwd.
"""
import http.server
import json
import re
import threading
from pathlib import Path

from mock_api import MODEL, events

STAGES = ["save", "recall"]
PROMPTS = {stage: "TAU_DIFFERENTIAL_MEMORY_" + stage.upper() for stage in STAGES}
TOPIC = "user_role.md"
TOPIC_BODY = "---\nname: user-role\ndescription: the user's role\nmetadata:\n  type: user\n---\n\nTAU_AUTO_MEMORY_TOPIC_BODY\n"
INDEX_LINE = "- [User role](user_role.md) \u2014 TAU_AUTO_MEMORY_INDEX_LINE"


def memory_directory(root: Path) -> Path:
    work = str((root / "work").resolve())
    return root / "config" / "projects" / re.sub(r"[^a-zA-Z0-9]", "-", work) / "memory"


def _blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


def _texts(body):
    return [block.get("text", "") for message in body.get("messages", []) for block in _blocks(message)
            if isinstance(block, dict) and block.get("type") == "text"]


def _main(body):
    """The main loop offers Write; side queries (titles, classifiers) do not."""
    return any(isinstance(tool, dict) and tool.get("name") == "Write" for tool in body.get("tools") or [])


def _results(body):
    return [block for message in body.get("messages", []) for block in _blocks(message)
            if isinstance(block, dict) and block.get("type") == "tool_result"]


class AutoMemoryMock:
    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        self.memory = None  # Set from the isolation root before the first stage.

    def respond(self, body):
        texts = _texts(body) if _main(body) else []
        stage = next((name for name, marker in PROMPTS.items() if any(marker in text for text in texts)), None)
        if stage != "save":
            return [{"type": "text", "text": "TAU_AUTO_MEMORY_" + (stage or "side").upper() + "_DONE"}], "end_turn"
        steps = [("Write", {"file_path": str(self.memory / TOPIC), "content": TOPIC_BODY}),
                 ("Write", {"file_path": str(self.memory / "MEMORY.md"), "content": INDEX_LINE + "\n"})]
        done = len(_results(body))
        if done < len(steps):
            name, value = steps[done]
            return [{"type": "tool_use", "id": "auto-memory-" + str(done + 1), "name": name, "input": value}], "tool_use"
        return [{"type": "text", "text": "TAU_AUTO_MEMORY_SAVE_DONE"}], "end_turn"

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
                if self.path.split("?")[0] == "/v1/messages/count_tokens":
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(b'{"input_tokens":32}'); return
                content, stop = state.respond(body)
                self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                self.wfile.write("".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                                         for event in events(content, stop, body.get("model", MODEL))).encode())

        return Handler


def _stage_requests(requests, stage):
    return [r["body"] for r in requests if r["path"].split("?")[0] == "/v1/messages" and _main(r["body"])
            and any(PROMPTS[stage] in t for t in _texts(r["body"]))]


def _system(body):
    system = body.get("system", "")
    return system if isinstance(system, str) else "\n\n".join(block.get("text", "") for block in system)


def _init(stdout):
    for line in stdout.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("subtype") == "init":
            return value
    return None


def verify(requests, stdouts, memory: Path):
    """Observable outcomes only; every check names what a user would see differ."""
    folder = str(memory) + "/"
    save, recall = _stage_requests(requests, "save"), _stage_requests(requests, "recall")
    results = [r for body in save[-1:] for r in _results(body)]
    index_blocks = [t for body in recall[:1] for t in _texts(body) if "TAU_AUTO_MEMORY_INDEX_LINE" in t]
    topic, index = memory / TOPIC, memory / "MEMORY.md"
    checks = {
        "init_memory_paths": [(_init(out) or {}).get("memory_paths") for out in stdouts] == [{"auto": folder}] * len(stdouts),
        "prompt_section": bool(save) and f"# auto memory\n\nYou have a persistent, file-based memory system at `{folder}`." in _system(save[0]),
        "writes_allowed": len(results) == 2 and not any(r.get("is_error") for r in results),
        "topic_written": topic.is_file() and topic.read_text() == TOPIC_BODY,
        "index_written": index.is_file() and index.read_text() == INDEX_LINE + "\n",
        "index_loaded": len(index_blocks) == 1 and str(index) in index_blocks[0],
        "topic_not_loaded": not any("TAU_AUTO_MEMORY_TOPIC_BODY" in t for body in recall[:1] for t in _texts(body)),
    }
    return {"checks": checks, "write_results": results, "index_block": index_blocks[0] if index_blocks else None}
