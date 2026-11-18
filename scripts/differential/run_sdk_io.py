#!/usr/bin/env python3
"""Run one print-protocol case (scenarios_sdk_io.py) for the original or for tau.

Both targets run in a freshly verified disposable isolation context against the
loopback mock_api.py fixture: the original from its pinned copied executable,
tau from copied public Bun and a snapshot of src/ (bun_runtime.py). NDJSON
stdin is fed through /bin/sh redirection, as run_original.py does.

  run_sdk_io.py original files-streamjson
  run_sdk_io.py tau files-streamjson
  compare_sdk_io.py artifacts/differential-pass/sdk-io/original-files-streamjson.stdout.txt \\
                    artifacts/differential-pass/sdk-io/tau-files-streamjson.stdout.txt
"""
import argparse
import json
from pathlib import Path
import shlex

from bun_runtime import bun_environment, copy_bun_executable, copy_bun_source_runtime
from isolation import REPO, TARGET_SHA256, Isolation
from mock_api import MODEL, MockState
from run_original import PINNED_TARGET
from scenarios_sdk_io import CASES


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("target", choices=["original", "tau"])
    parser.add_argument("case", choices=sorted(CASES))
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/sdk-io")
    args = parser.parse_args()
    case = CASES[args.case]
    directory = args.artifacts.resolve()
    stem = args.target + "-" + args.case
    state = MockState(case["scenario"])
    isolation = Isolation(directory, state.handler())
    try:
        if args.target == "tau":
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        (isolation.root / "work" / "a.txt").write_text("alpha\n")
        arguments = [*case["args"], "--model", MODEL] + (["--dangerously-skip-permissions"] if case.get("skip_permissions", True) else [])
        runtime = None
        if args.target == "original":
            command = [str(isolation.copy_target(PINNED_TARGET))]
            arguments.append("--no-session-persistence")
        else:
            bun, executable = copy_bun_executable(isolation.root)
            entry, runtime = copy_bun_source_runtime(isolation.root, executable)
            command = [str(bun), "--no-install", str(entry)]
        if "stdin" in case:
            feed = isolation.root / "work" / "stdin.ndjson"
            feed.write_text(case["stdin"])
            launch = ["/bin/sh", "-c", "exec " + shlex.join([*command, *arguments]) + " < " + shlex.quote(str(feed))]
        else:
            launch = [*command, *arguments]
        result = isolation.sandbox(launch, timeout=20)
        record = {"target": args.target, "case": args.case, "scenario": case["scenario"], "arguments": arguments,
                  "stdin": case.get("stdin"), "original_executed": args.target == "original",
                  "target_sha256": TARGET_SHA256 if args.target == "original" else None, "runtime": runtime,
                  "isolation": isolation.report, "result": result, "requests": state.requests,
                  "final_file": (isolation.root / "work" / "a.txt").read_text(),
                  "probe_file_exists": (isolation.root / "work" / "probe.txt").exists()}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        (directory / (stem + ".stdout.txt")).write_text(result["stdout"])
        (directory / (stem + ".stderr.txt")).write_text(result["stderr"])
        print(json.dumps({"target": args.target, "case": args.case, "isolation_passed": isolation.verified,
                          "exit_code": result["exit_code"], "timed_out": result["timed_out"], "requests": len(state.requests),
                          "stderr_tail": result["stderr"][-600:]}))
    finally:
        isolation.close()


if __name__ == "__main__":
    main()
