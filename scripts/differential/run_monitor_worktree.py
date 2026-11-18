#!/usr/bin/env python3
"""Monitor/worktree differential: the original or tau (copied Bun + source) in one verified profile.

Both run in print mode with permissions skipped, so the comparison is about what the tools
do and say, and which notifications reach later requests. The profile grants no /bin/sleep
and only the /usr/bin/git shim, so the worktree capture also records whether git runs there.
"""
import argparse
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256, Isolation
from bun_runtime import bun_environment
from mock_api import MODEL
from run_child_workflows import prepare_bun_adapter
from run_original import PINNED_TARGET
from scenarios_monitor_worktree import VARIANTS, MonitorWorktreeMock


def tool_results(requests):
    blocks = [block for r in requests[-1:] for m in r["body"].get("messages", [])
              for block in (m["content"] if isinstance(m["content"], list) else []) if isinstance(block, dict)]
    return [block for block in blocks if block.get("type") == "tool_result"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("variant", choices=VARIANTS)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/monitor-worktree")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stem = args.executable + "-" + args.variant
    state = MonitorWorktreeMock(args.variant)
    isolation = Isolation(directory, state.handler())
    try:
        if args.executable == "tau":
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        arguments = ["--print", "TAU_DIFFERENTIAL_MONITOR_WORKTREE", "--model", MODEL, "--output-format", "json",
                     "--dangerously-skip-permissions", "--no-session-persistence"]
        if args.executable == "original":
            command = [str(isolation.copy_target(PINNED_TARGET))]
            runtime = {"target_sha256": TARGET_SHA256}
        else:
            bun, entry, runtime, _probes = prepare_bun_adapter(isolation, directory, stem)
            command = [str(bun), "--no-install", str(entry)]
        result = isolation.sandbox([*command, *arguments], timeout=90)
        record = {"executable": args.executable, "variant": args.variant, "arguments": arguments, "isolation": isolation.report,
                  "runtime": runtime, "result": result, "requests": state.requests, "root": str(isolation.root),
                  "original_executed": args.executable == "original"}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        summary = {"executable": args.executable, "variant": args.variant, "exit_code": result["exit_code"], "timed_out": result["timed_out"],
                   "request_kinds": [r.get("kind") for r in state.requests], "tool_results": tool_results(state.requests),
                   "stdout_tail": result["stdout"][-600:], "stderr_tail": result["stderr"][-600:]}
        (directory / (stem + ".summary.json")).write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
    finally:
        isolation.close()


if __name__ == "__main__":
    main()
