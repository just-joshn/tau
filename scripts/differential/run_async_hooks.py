#!/usr/bin/env python3
"""Async command-hook differential: the original or tau (copied Bun + source) in one verified profile.

A disposable config/settings.json registers one PostToolUse:Read command hook with the
variant's `async`/`asyncRewake` flags. The summary lists, per model request, the user text
carrying hook output (async_hook_response reminders) or a rewake task notification.
"""
import argparse
import json
import time
from pathlib import Path

from isolation import REPO, TARGET_SHA256, Isolation
from bun_runtime import bun_environment
from mock_api import MODEL
from run_child_workflows import prepare_bun_adapter
from run_original import PINNED_TARGET
from scenarios_async_hooks import HOOK, VARIANTS, AsyncHookMock, settings, summarize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("variant", choices=list(VARIANTS))
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/async-hooks")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    stem = args.executable + "-" + args.variant
    state = AsyncHookMock(args.variant)
    isolation = Isolation(directory, state.handler())
    try:
        if args.executable == "tau":
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        script = isolation.root / "work/hook.sh"
        script.write_text(HOOK)
        state.marker = isolation.root / "work/hook-done.marker"
        configured = settings(args.variant, "/bin/sh", script, state.marker)
        (isolation.root / "config/settings.json").write_text(json.dumps(configured, indent=2) + "\n")
        (isolation.root / "work/note.txt").write_text("NOTE_BODY\n")
        arguments = ["--print", "TAU_DIFFERENTIAL_ASYNC_HOOKS", "--model", MODEL, "--output-format", "json",
                     "--tools", "Read", "--allowedTools", "Read", "--no-session-persistence"]
        if args.executable == "original":
            command = [str(isolation.copy_target(PINNED_TARGET))]
            runtime = {"target_sha256": TARGET_SHA256}
        else:
            bun, entry, runtime, _probes = prepare_bun_adapter(isolation, directory, stem)
            command = [str(bun), "--no-install", str(entry)]
        started = time.monotonic()
        result = isolation.sandbox([*command, *arguments], timeout=60)
        elapsed = round(time.monotonic() - started, 3)
        record = {"executable": args.executable, "variant": args.variant, "arguments": arguments, "settings": configured,
                  "isolation": isolation.report, "runtime": runtime, "result": result, "requests": state.requests,
                  "elapsed_seconds": elapsed, "original_executed": args.executable == "original"}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        models = [r for r in state.requests if r["path"].split("?")[0] == "/v1/messages"]
        summary = {"executable": args.executable, "variant": args.variant, "exit_code": result["exit_code"],
                   "timed_out": result["timed_out"], "model_requests": len(models), "elapsed_seconds": elapsed,
                   "hook_marker_written": state.marker.exists(), "carried": summarize(state.requests),
                   "stdout_tail": result["stdout"][-600:], "stderr_tail": result["stderr"][-600:]}
        (directory / (stem + ".summary.json")).write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
    finally:
        isolation.close()


if __name__ == "__main__":
    main()
