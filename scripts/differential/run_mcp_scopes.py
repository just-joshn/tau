#!/usr/bin/env python3
"""MCP discovery workflow under fresh reviewed isolation and owned scope files."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from isolation import REPO, TARGET_SHA256, verified_isolation
from mcp_scope_fixture import SCOPE_CASES, install_scope_fixture
from mock_api import MockState
from run_tau import copy_runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("case", choices=SCOPE_CASES)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/mcp-scopes")
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    state = MockState("mcp")
    with verified_isolation(artifacts, state.handler()) as isolation:
        node, tau_entry, runtime = copy_runtime(isolation.root)
        probe = isolation.sandbox([str(node), "-e", 'process.stdout.write("disposable-node-ready")'])
        if probe["exit_code"] != 0 or probe["stdout"] != "disposable-node-ready":
            raise RuntimeError("Copied Node bootstrap failed")
        recipe = install_scope_fixture(isolation.root, args.case)
        arguments = ["--print", "TAU_DIFFERENTIAL_MCP_SCOPE", "--output-format", "json", *recipe["arguments"]]
        skipped = []
        if args.executable == "original":
            target = isolation.copy_target(Path("/Users/josh-desktop/.local/bin/claude"))
            arguments.append("--no-session-persistence")
            command = [str(target), *arguments]
        else:
            skipped.append("--no-session-persistence")
            command = [str(node), "--preserve-symlinks", "--preserve-symlinks-main", str(tau_entry), *arguments]
        result = isolation.sandbox(command)
        lifecycle = {}
        for path in sorted((isolation.root / "lifecycle").glob("*.jsonl")):
            lifecycle[path.stem] = [json.loads(line) for line in path.read_text().splitlines()]
        spawned = sorted({event["pid"] for events in lifecycle.values() for event in events if event.get("event") == "start"})
        def alive(pid):
            try: os.kill(pid, 0); return True
            except ProcessLookupError: return False
        deadline = time.monotonic() + 2
        while any(alive(pid) for pid in spawned) and time.monotonic() < deadline: time.sleep(0.05)
        survivors = [pid for pid in spawned if alive(pid)]
        calls = {origin: sum(event.get("event") == "request" and event["message"].get("method") == "tools/call" for event in events)
                 for origin, events in lifecycle.items()}
        record = {"case": args.case, "executable": args.executable, "original_executed": args.executable == "original",
                  "target_sha256": TARGET_SHA256 if args.executable == "original" else None,
                  "isolation": isolation.report, "runtime": runtime, "runtime_probe": probe,
                  "recipe": recipe, "arguments": arguments, "skipped_original_flags": skipped,
                  "result": result, "requests": state.requests, "lifecycle_by_origin": lifecycle,
                  "tool_calls_by_origin": calls, "fixture_pids_alive_after_group_cleanup": survivors}
        stem = args.executable + "-" + args.case
        (artifacts / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        for stream in ["stdout", "stderr"]: (artifacts / (stem + "." + stream + ".txt")).write_text(result[stream])
        kernel = subprocess.run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate",
                                 'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifacts / (stem + ".denials.txt")).write_text(kernel.stdout)
        print(json.dumps({"case": args.case, "executable": args.executable, "exit": result["exit_code"],
                          "requests": len(state.requests), "origins": list(lifecycle), "calls": calls, "survivors": survivors,
                          "timed_out": result["timed_out"], "stderr_tail": result["stderr"][-600:]}))


if __name__ == "__main__": main()
