#!/usr/bin/env python3
"""Run tau's source CLI, unsandboxed, against the async-hook loopback mock and compare its
requests with recorded original runs.

This is the iteration path when run_async_hooks.py cannot nest its sandbox. It reuses
scenarios_async_hooks.py (hook script, settings and mock plan) and compares every request's
messages after the first user message. Temporary roots are normalized, and the original's
sandbox-only "Error opening /private/var/select/sh" stderr line is dropped.

  python3 scripts/differential/compare_async_hooks_loopback.py async-response rewake-exit2 rewake-sync \
      --original artifacts/differential-pass/async-hooks
"""
import argparse
import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from mock_api import MODEL
from scenarios_async_hooks import HOOK, VARIANTS, AsyncHookMock, settings

REPO = Path(__file__).resolve().parents[2]
NOISE = "Error opening /private/var/select/sh: Operation not permitted\n"
ROOT = re.compile(r"/[^\s\"]*?/tau-(?:differential|async-loopback)-[A-Za-z0-9_]+")


def run_tau(variant):
    state = AsyncHookMock(variant)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), state.handler())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="tau-async-loopback-") as raw:
        root = Path(raw).resolve()
        for name in ["home", "config", "state", "work", "tmp"]:
            (root / name).mkdir()
        script = root / "work/hook.sh"
        script.write_text(HOOK)
        state.marker = root / "work/hook-done.marker"
        (root / "config/settings.json").write_text(json.dumps(settings(variant, "/bin/sh", script, state.marker)))
        (root / "work/note.txt").write_text("NOTE_BODY\n")
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root / "home"), "CLAUDE_CONFIG_DIR": str(root / "config"),
               "TAU_HOME": str(root / "state"), "TMPDIR": str(root / "tmp"), "SHELL": "/bin/sh",
               "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_address[1]}", "ANTHROPIC_API_KEY": "loopback"}
        arguments = ["--print", "TAU_DIFFERENTIAL_ASYNC_HOOKS", "--model", MODEL, "--output-format", "json",
                     "--tools", "Read", "--allowedTools", "Read", "--no-session-persistence"]
        result = subprocess.run(["bun", str(REPO / "src/cli.ts"), *arguments], cwd=root / "work", env=env,
                                capture_output=True, text=True, timeout=90)
    server.shutdown()
    return {"variant": variant, "exit_code": result.returncode, "stderr_tail": result.stderr[-600:], "requests": state.requests}


def turns(record):
    """Messages after the first user message, per model request, with temp roots normalized."""
    rows = []
    for request in record["requests"]:
        if request["path"].split("?")[0] != "/v1/messages":
            continue
        text = ROOT.sub("<root>", json.dumps(request["body"]["messages"][1:])).replace(json.dumps(NOISE)[1:-1], "")
        messages = json.loads(text)
        for message in messages:
            for block in message["content"] if isinstance(message["content"], list) else []:
                block.pop("cache_control", None)
                if block.get("type") == "tool_result":
                    block.pop("is_error", None) if block.get("is_error") is False else None
        rows.append(messages)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("variants", nargs="+", choices=list(VARIANTS))
    parser.add_argument("--original", type=Path, default=REPO / "artifacts/differential-pass/async-hooks")
    parser.add_argument("--out", type=Path, help="Directory for tau-<variant>.loopback.json records")
    args = parser.parse_args()
    failed = 0
    for variant in args.variants:
        tau = run_tau(variant)
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / f"tau-{variant}.loopback.json").write_text(json.dumps(tau, indent=2) + "\n")
        original = json.loads((args.original / f"original-{variant}.json").read_text())
        left, right = turns(original), turns(tau)
        same = left == right
        failed += not same
        print(f"{variant}: {'MATCH' if same else 'DIFFER'} ({len(left)} original, {len(right)} tau requests, exit {tau['exit_code']})")
        if not same:
            for index, (a, b) in enumerate(zip(left, right)):
                if a != b:
                    print(f"  request {index}:\n    original {json.dumps(a)}\n    tau      {json.dumps(b)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
