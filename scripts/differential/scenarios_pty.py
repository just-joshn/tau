"""Interactive PTY scenarios: a prompt-keyed Messages mock, keystroke scripts and dummy config.

The mock answers by the marker in the newest user text of a request that offers
tools (the main loop). Requests without tools (titles, summaries) get a short text.
"""
import http.server
import json
from pathlib import Path
import threading

from mock_api import MODEL, events
from pty_driver import Step

TEXT, EDIT = "TAU_PTY_TEXT", "TAU_PTY_EDIT"
TEXT_REPLY, EDIT_REPLY = "TAU_PTY_TEXT_REPLY", "TAU_PTY_EDIT_REPLY"
EDITS = [("alpha", "beta"), ("beta", "gamma"), ("gamma", "delta")]


class PtyMock:
    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        self.work: Path | None = None
        self.edits = 0

    def respond(self, body):
        messages = body.get("messages") or []
        last = messages[-1] if messages else {}
        blocks = last.get("content") if isinstance(last.get("content"), list) else [{"type": "text", "text": last.get("content") or ""}]
        results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if not body.get("tools"):
            return [{"type": "text", "text": "ok"}], "end_turn"
        if EDIT in text:
            return [{"type": "tool_use", "id": f"pty-read-{self.edits + 1}", "name": "Read",
                     "input": {"file_path": str(self.work / "a.txt")}}], "tool_use"
        if TEXT in text:
            return [{"type": "text", "text": TEXT_REPLY + " mock done"}], "end_turn"
        if results:
            done = results[-1]
            if done.get("tool_use_id", "").startswith("pty-read-"):
                old, new = EDITS[min(self.edits, len(EDITS) - 1)]
                self.edits += 1
                return [{"type": "tool_use", "id": f"pty-edit-{self.edits}", "name": "Edit",
                         "input": {"file_path": str(self.work / "a.txt"), "old_string": old, "new_string": new}}], "tool_use"
            return [{"type": "text", "text": f"{EDIT_REPLY} error={bool(done.get('is_error'))}"}], "end_turn"
        return [{"type": "text", "text": "ok"}], "end_turn"

    def handler(self):
        state = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass

            def reply(self, status, payload, kind="application/json"):
                self.send_response(status); self.send_header("content-type", kind); self.end_headers(); self.wfile.write(payload)

            def do_GET(self):
                with state.lock:
                    state.requests.append({"method": "GET", "path": self.path})
                self.reply(404, b'{"error":{"type":"not_found_error","message":"mock"}}')

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 32 * 1024 * 1024:
                    return self.reply(413, b"{}")
                try:
                    body = json.loads(self.rfile.read(length))
                except ValueError:
                    return self.reply(400, b"{}")
                path = self.path.split("?")[0]
                with state.lock:
                    retained = dict(body); retained.pop("metadata", None)
                    state.requests.append({"method": "POST", "path": self.path, "body": retained})
                    if path == "/v1/messages/count_tokens":
                        return self.reply(200, b'{"input_tokens":32}')
                    if path != "/v1/messages":
                        return self.reply(404, b'{"error":{"type":"not_found_error","message":"mock"}}')
                    content, stop = state.respond(body)
                    message_id = f"msg_pty_mock_{len(state.requests)}"
                model = body.get("model", MODEL)
                if body.get("stream"):
                    stream = events(content, stop, model)
                    stream[0]["message"]["id"] = message_id
                    self.reply(200, "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n"
                                            for e in stream).encode(), "text/event-stream")
                else:
                    self.reply(200, json.dumps({"id": message_id, "type": "message", "role": "assistant", "model": model,
                                                "content": content, "stop_reason": stop, "stop_sequence": None,
                                                "usage": {"input_tokens": 10, "output_tokens": 3}}).encode())
        return Handler


def seed(root: Path, api_key: str, setup: str) -> None:
    """Workspace file and the dummy global config ($CLAUDE_CONFIG_DIR/.claude.json) for one setup.

    `fresh` writes no config, so every first-run screen shows. `onboarded` skips
    onboarding and approves the dummy key (by its last 20 characters) but leaves the
    trust dialog. `trusted` also marks the workspace realpath as trusted.
    """
    work = root / "work"
    (work / "a.txt").write_text("alpha\n")
    if setup == "fresh":
        return
    config = {"hasCompletedOnboarding": True, "lastOnboardingVersion": "2.1.326", "numStartups": 1,
              "customApiKeyResponses": {"approved": [api_key.strip()[-20:]], "rejected": []}}
    if setup == "trusted":
        config["projects"] = {str(work.resolve()): {"hasTrustDialogAccepted": True}}
    (root / "config" / ".claude.json").write_text(json.dumps(config, indent=2) + "\n")


SETUPS = ["onboarded", "fresh", "trusted"]


# First-run screens: (regex on screen, keys). Each is optional and runs once, in order.
FIRST_RUN = [
    ("theme", r"(?i)choose the text style|dark mode", "\r"),
    ("api-key", r"(?i)do you want to use this api key", "1"),  # focus starts on "No (recommended)"
    ("security-notes", r"(?i)security notes|press enter to continue", "\r"),
    ("terminal-setup", r"(?i)use claude code's terminal setup", "\x1b"),
    ("trust", r"(?i)quick safety check|trust this folder", "\r"),
]
READY = {"original": r"\? for shortcuts", "tau": r"(?m)^tau> ?$"}
DIALOG = {"original": r"(?i)do you want to make this edit", "tau": r"(?i)do you want to make this edit"}
TYPE_WAIT = 3


def startup():
    steps = [Step("startup", screen=r"(?i)trust|theme|api key|for shortcuts|tau> ", timeout=30, quiet=1.0)]
    # Two passes: a screen may appear later than its position in the list.
    steps += [Step(f"first-run-{name}-{attempt}", when=pattern, send=keys, quiet=1.0, timeout=5)
              for attempt in (1, 2) for name, pattern, keys in FIRST_RUN]
    return steps + [Step("ready", screen=READY, timeout=20, quiet=0.8, fresh=False)]


def prompt(name, text, wait, timeout=30):
    return [Step(name + "-typed", send=text, screen=text, timeout=TYPE_WAIT),
            Step(name, send="\r", screen=wait, timeout=timeout, quiet=0.8)]


def dialog(name, keys):
    return [Step(name, send=keys, screen=EDIT_REPLY, timeout=30, quiet=0.8)]


def command(name):
    # The original renders slash-command dialogs; Escape closes them and is harmless at tau's prompt.
    return prompt(name, "/" + name, {"original": None, "tau": READY["tau"]}, timeout=10) + \
        [Step(name + "-close", send={"original": "\x1b", "tau": None}, quiet=0.8, timeout=5)]


def exit_twice():
    # The second press must land within the original's 800ms window.
    return [Step("ctrl-c-1", send="\x03", quiet=0.2, timeout=0.5),
            Step("ctrl-c-2", send="\x03", exit=True, timeout=10)]


SCENARIOS = {
    "tour": lambda: startup() + prompt("text", TEXT, TEXT_REPLY) + prompt("edit", EDIT, DIALOG)
    + dialog("edit-approve", {"original": "1", "tau": "1"}) + command("help") + command("status")
    + command("model") + exit_twice(),
    "edit-always": lambda: startup() + prompt("edit", EDIT, DIALOG) + dialog("edit-always", {"original": "2", "tau": "2"})
    + prompt("edit-again", EDIT, EDIT_REPLY) + exit_twice(),
    "edit-reject": lambda: startup() + prompt("edit", EDIT, DIALOG)
    + [Step("edit-reject", send={"original": "3", "tau": "3"}, quiet=1.0, timeout=10)] + exit_twice(),
}

# Files read back after the run, relative to the disposable root.
OBSERVED_FILES = ["work/a.txt", "work/.claude/settings.local.json", "work/.claude/settings.json", "config/.claude.json",
                  "config/settings.json", "home/.claude.json"]
