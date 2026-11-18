#!/usr/bin/env python3
"""Owned command-hook workflows in fresh verified deny-default isolation."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import time

from isolation import REPO, TARGET_SHA256, clone_file, verified_isolation
from mock_api import MODEL, events
from run_tau import copy_runtime, digest

CASES = ["rewrite-allow", "deny", "protected-ask", "sensitive", "validation", "bash-nonzero", "invalid-rewrite", "stop", "session", "rewrite-path"]


def steps(scenario):
    if scenario == "validation":
        return [("Write", {"file_path": "a.txt", "content": "unread overwrite\n"}),
                ("Edit", {"file_path": "a.txt", "old_string": "alpha", "new_string": "unread"}),
                ("Edit", {"file_path": "missing-edit.txt", "old_string": "alpha", "new_string": "missing"}),
                ("Read", {"file_path": "missing-read.txt"}),
                ("Read", {"file_path": "a.txt"}),
                ("Edit", {"file_path": "a.txt", "old_string": "absent", "new_string": "missing"}),
                ("Edit", {"file_path": "a.txt", "old_string": "alpha", "new_string": "beta"})]
    if scenario == "bash-nonzero":
        return [("Bash", {"command": "printf owned-hook-bash; exit 7"})]
    if scenario in ["stop", "session"]:
        return []
    return [("Write", {"file_path": ".claude/hook-created.json" if scenario == "sensitive" else "new.txt", "content": "original model input\n"})]


class HookMock:
    def __init__(self, scenario):
        self.scenario = scenario
        self.requests = []
        self.generations = 0
        self.lock = threading.Lock()

    def handler(self):
        state = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                if length < 0 or length > 32 * 1024 * 1024:
                    self.send_response(413); self.end_headers(); return
                try: body = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_response(400); self.end_headers(); return
                with state.lock:
                    retained = dict(body); retained.pop("metadata", None)
                    state.requests.append({"path": self.path, "body": retained})
                    counting = self.path.split("?")[0] == "/v1/messages/count_tokens"
                    if not counting: state.generations += 1
                    generation = state.generations
                if counting:
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"input_tokens":32}'); return
                if self.path.split("?")[0] != "/v1/messages" or generation > 12:
                    self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"Owned fixture request bound"}}'); return
                actions = steps(state.scenario)
                if generation <= len(actions):
                    name, value = actions[generation - 1]
                    content = [{"type": "tool_use", "id": "owned-hook-" + str(generation), "name": name, "input": value}]; stop = "tool_use"
                else:
                    content = [{"type": "text", "text": "Owned hook response " + str(generation)}]; stop = "end_turn"
                if body.get("stream"):
                    self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                    self.wfile.write("".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n" for event in events(content, stop, body.get("model", MODEL))).encode())
                else:
                    self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
                    self.wfile.write(json.dumps({"id": "msg_owned_hook", "type": "message", "role": "assistant", "model": body.get("model", MODEL), "content": content,
                                                "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 3}}).encode())
        return Handler


def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("case", choices=CASES)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/hooks")
    args = parser.parse_args()
    artifacts = args.artifacts.resolve(); state = HookMock(args.case)
    with verified_isolation(artifacts, state.handler()) as isolation:
        node, tau_entry, runtime = copy_runtime(isolation.root)
        fixture = isolation.root / "hook-fixture.cjs"; clone_file(REPO / "scripts/differential/hook_fixture.cjs", fixture)
        ready_log = isolation.root / "hook-runtime-ready.jsonl"
        probe = isolation.sandbox([str(node), str(fixture), "ready", str(ready_log), args.case])
        if probe["exit_code"] != 0 or probe["timed_out"] or probe["stdout"] != "owned-hook-fixture-ready":
            raise RuntimeError("Authored hook runtime failed unchanged sandbox")
        lifecycle = isolation.root / "hook-lifecycle.jsonl"
        command = {"type": "command", "command": str(node), "args": [str(fixture), "hook", str(lifecycle), args.case], "timeout": 3}
        configured = {event: [{"hooks": [command]}] for event in (["Stop"] if args.case == "stop" else ["SessionStart"] if args.case == "session" else ["PreToolUse", "PostToolUse"])}
        settings = {"hooks": configured}
        if args.case == "protected-ask": settings["permissions"] = {"ask": ["Write"]}
        (isolation.root / "config/settings.json").write_text(json.dumps(settings, indent=2) + "\n")
        (isolation.root / "work/a.txt").write_text("alpha\n")
        (isolation.root / "work/.claude").mkdir()
        arguments = ["--print", "OWNED_DIFFERENTIAL_HOOK_" + args.case.upper(), "--model", MODEL,
                     "--output-format", "json", "--tools", "Bash" if args.case == "bash-nonzero" else "Read,Edit,Write"]
        if args.case == "validation": arguments += ["--allowedTools", "Read,Edit,Write"]
        if args.case == "bash-nonzero": arguments += ["--allowedTools", "Bash"]
        skipped = []
        if args.executable == "original":
            target = isolation.copy_target(Path("/Users/josh-desktop/.local/bin/claude")); command_prefix = [str(target)]
            if args.case != "session": arguments.append("--no-session-persistence")
        else:
            command_prefix = [str(node), "--preserve-symlinks", "--preserve-symlinks-main", str(tau_entry)]
            if args.case != "session": skipped.append("--no-session-persistence")
        isolation.report["original_executed"] = args.executable == "original"
        started = time.monotonic()
        result = isolation.sandbox([*command_prefix, *arguments])
        stages = [{"arguments": arguments, "result": result, "request_start": 0, "request_end": len(state.requests)}]
        if args.case == "session" and result["exit_code"] == 0:
            session = json.loads(result["stdout"])["session_id"]
            resumed_args = ["--resume", session, "--print", "OWNED_DIFFERENTIAL_HOOK_SESSION_RESUME", "--model", MODEL, "--output-format", "json", "--tools", "Read,Edit,Write"]
            start = len(state.requests)
            resumed = isolation.sandbox([*command_prefix, *resumed_args])
            stages.append({"arguments": resumed_args, "result": resumed, "request_start": start, "request_end": len(state.requests)})
        logs = [json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else []
        pids = sorted({event["pid"] for event in logs if event.get("event") == "start"})
        deadline = time.monotonic() + 2
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline: time.sleep(.05)
        survivors = [pid for pid in pids if alive(pid)]
        final_files = {name: (isolation.root / "work" / name).read_text() for name in ["a.txt", "new.txt", "invalid-hook-target.txt", ".claude/hook-created.json", "alternate/rewritten.txt"] if (isolation.root / "work" / name).exists()}
        record = {"case": args.case, "executable": args.executable, "scope": "Owned command hooks; unchanged verified deny-default profile", "target_sha256": TARGET_SHA256 if args.executable == "original" else None,
                  "isolation": isolation.report, "runtime": runtime, "runtime_probe": probe, "fixture_sha256": digest(fixture), "settings": settings,
                  "stages": stages, "requests": state.requests, "hook_lifecycle": logs, "hook_pids": pids, "surviving_hook_pids": survivors,
                  "final_files": final_files, "skipped_original_flags": skipped, "elapsed_seconds": round(time.monotonic() - started, 3)}
        stem = args.executable + "-" + args.case
        (artifacts / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        for index, stage in enumerate(stages):
            for stream in ["stdout", "stderr"]:
                (artifacts / (stem + "-" + str(index + 1) + "." + stream + ".txt")).write_text(stage["result"][stream])
        kernel = subprocess.run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate", 'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifacts / (stem + ".denials.txt")).write_text(kernel.stdout)
        print(json.dumps({"case": args.case, "executable": args.executable, "exits": [stage["result"]["exit_code"] for stage in stages], "requests": len(state.requests),
                          "hook_inputs": [event["input"].get("hook_event_name") + ":" + str(event["input"].get("tool_name", event["input"].get("source", ""))) for event in logs if event.get("event") == "input"],
                          "surviving_hook_pids": survivors, "final_files": final_files}))


if __name__ == "__main__": main()
