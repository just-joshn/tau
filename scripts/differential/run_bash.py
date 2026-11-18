#!/usr/bin/env python3
"""Bash differential: the original or tau (copied Bun + source) in one verified profile.

The mock drives scenarios_bash.STEPS, one Bash call per request, then waits
for the background command's completion notification. The record keeps every
request body, the shell output files and which shells the profile allowed.
"""
import argparse
import json
from pathlib import Path

from bun_runtime import bun_environment
from isolation import REPO, SYSTEM_PROGRAMS, TARGET_SHA256, Isolation
from mock_api import MODEL
from run_child_workflows import prepare_bun_adapter
from run_original import PINNED_TARGET
from scenarios_bash import BashMock


def task_outputs(root):
    """Background output files under CLAUDE_CODE_TMPDIR, with their contents."""
    files = {}
    for path in sorted((root / "tmp").rglob("*.output")):
        if path.is_file() and not path.is_symlink():
            files[str(path)] = path.read_text(errors="replace")
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/bash")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    stem = args.executable + "-bash"
    state = BashMock()
    isolation = Isolation(directory, state.handler())
    try:
        if args.executable == "tau":
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        state.prepare(isolation)
        arguments = ["--print", "TAU_DIFFERENTIAL_BASH", "--model", MODEL, "--output-format", "json",
                     "--dangerously-skip-permissions", "--no-session-persistence"]
        if args.executable == "original":
            command = [str(isolation.copy_target(PINNED_TARGET))]
            runtime = {"target_sha256": TARGET_SHA256}
        else:
            bun, entry, runtime, _probes = prepare_bun_adapter(isolation, directory, stem)
            command = [str(bun), "--no-install", str(entry)]
        result = isolation.sandbox([*command, *arguments], timeout=90)
        record = {"executable": args.executable, "arguments": arguments, "isolation": isolation.report,
                  "runtime": runtime, "result": result, "requests": state.requests, "root": str(isolation.root),
                  "task_outputs": task_outputs(isolation.root), "profile_programs": SYSTEM_PROGRAMS,
                  "shell_env": isolation.env.get("SHELL"), "original_executed": args.executable == "original"}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        summary = {"executable": args.executable, "exit_code": result["exit_code"], "timed_out": result["timed_out"],
                   "request_kinds": [r.get("kind") for r in state.requests],
                   "tool_results": [block for r in state.requests[-1:] for m in r["body"].get("messages", [])
                                    for block in (m["content"] if isinstance(m["content"], list) else [])
                                    if isinstance(block, dict) and block.get("type") == "tool_result"],
                   "stdout_tail": result["stdout"][-600:], "stderr_tail": result["stderr"][-600:]}
        (directory / (stem + ".summary.json")).write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
    finally:
        isolation.close()


if __name__ == "__main__":
    main()
