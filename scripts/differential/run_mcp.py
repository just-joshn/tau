#!/usr/bin/env python3
"""Explicit stdio MCP workflow inside a freshly verified disposable profile."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from isolation import REPO, TARGET_SHA256, clone_file, verified_isolation
from mock_api import MODEL, MockState
from run_tau import copy_runtime, digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("mode", choices=["allowed", "denied", "required"])
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/mcp")
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    state = MockState("mcp")
    with verified_isolation(artifacts, state.handler()) as isolation:
        node, tau_entry, runtime = copy_runtime(isolation.root)
        probe = isolation.sandbox([str(node), "-e", 'process.stdout.write("disposable-node-ready")'])
        if probe["exit_code"] != 0 or probe["stdout"] != "disposable-node-ready":
            raise RuntimeError("Copied Node bootstrap failed")
        fixture = isolation.root / "mcp-fixture.mjs"
        clone_file(REPO / "scripts/differential/mcp_fixture.mjs", fixture)
        lifecycle = isolation.root / "mcp-lifecycle.jsonl"
        config = {"mcpServers": {"fixture": {"type": "stdio", "command": str(node),
                   "args": [str(fixture), str(lifecycle), args.mode], "alwaysLoad": True}}}
        arguments = ["--print", "TAU_DIFFERENTIAL_MCP", "--model", MODEL, "--output-format", "json",
                     "--mcp-config", json.dumps(config), "--strict-mcp-config", "--tools", ""]
        if args.mode in ["allowed", "required"]:
            arguments.extend(["--allowedTools", "mcp__fixture__lookup"])
        if args.mode == "required":
            arguments.append("--dangerously-skip-permissions")
        if args.executable == "original":
            entry = isolation.copy_target(Path("/Users/josh-desktop/.local/bin/claude"))
            command = [str(entry), *arguments, "--no-session-persistence"]
        else:
            command = [str(node), "--preserve-symlinks", "--preserve-symlinks-main", str(tau_entry), *arguments]
        result = isolation.sandbox(command)
        logs = [json.loads(line) for line in lifecycle.read_text().splitlines()] if lifecycle.exists() else []
        spawned = sorted({event["pid"] for event in logs if event.get("event") == "start"})
        def alive(pid):
            try: os.kill(pid, 0); return True
            except ProcessLookupError: return False
        # Observe only fixture-owned PIDs, after run_bounded killed its group.
        deadline = time.monotonic() + 2
        while any(alive(pid) for pid in spawned) and time.monotonic() < deadline:
            time.sleep(0.05)
        survivors = [pid for pid in spawned if alive(pid)]
        calls = [event for event in logs if event.get("event") == "request" and event["message"].get("method") == "tools/call"]
        record = {"scenario": "mcp", "executable": args.executable, "mode": args.mode,
                  "target_sha256": TARGET_SHA256 if args.executable == "original" else None,
                  "fixture_sha256": digest(fixture), "runtime": runtime, "runtime_probe": probe,
                  "isolation": isolation.report, "arguments": arguments, "result": result,
                  "requests": state.requests, "mcp_lifecycle": logs, "mcp_tool_call_count": len(calls),
                  "fixture_pids_alive_after_group_cleanup": survivors}
        stem = args.executable + "-" + args.mode
        (artifacts / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        for stream in ["stdout", "stderr"]:
            (artifacts / (stem + "." + stream + ".txt")).write_text(result[stream])
        kernel = subprocess.run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate",
                                 'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifacts / (stem + ".denials.txt")).write_text(kernel.stdout)
        print(json.dumps({"executable": args.executable, "mode": args.mode, "exit_code": result["exit_code"],
                          "requests": len(state.requests), "tool_calls": len(calls), "timed_out": result["timed_out"],
                          "stderr_tail": result["stderr"][-600:]}))


if __name__ == "__main__": main()
