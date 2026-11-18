#!/usr/bin/env python3
"""Capture tau's API requests for a mock_api scenario (copied Bun + source in the verified profile).

Uses the oracle's print-mode flags. Tau has no stream-json/--verbose yet, so the default
`--output-format json` drops those two flags; the record lists what was omitted.
"""
import argparse
import json
from pathlib import Path

from isolation import REPO, Isolation
from bun_runtime import bun_environment
from mock_api import MODEL, SCENARIOS, MockState
from run_child_workflows import prepare_bun_adapter

ORACLE_FLAGS = ["--output-format", "stream-json", "--verbose"]


def arguments(scenario, output_format):
    flags = ["--output-format", output_format] + (["--verbose"] if output_format == "stream-json" else [])
    return ["--print", "TAU_DIFFERENTIAL_" + scenario.upper(), "--model", MODEL, *flags,
            "--no-session-persistence", "--dangerously-skip-permissions"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=SCENARIOS)
    parser.add_argument("--output-format", choices=["json", "stream-json"], default="json")
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/prompt")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stem = "tau-" + args.scenario
    state = MockState(args.scenario)
    isolation = Isolation(directory, state.handler())
    try:
        isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        (isolation.root / "work" / "a.txt").write_text("alpha\n")
        bun, entry, runtime, _probes = prepare_bun_adapter(isolation, directory, stem)
        argv = arguments(args.scenario, args.output_format)
        result = isolation.sandbox([str(bun), "--no-install", str(entry), *argv], timeout=60)
        omitted = [flag for flag in ORACLE_FLAGS if flag not in argv and flag != "--output-format"]
        record = {"scenario": args.scenario, "executable": "tau", "arguments": argv, "omitted_oracle_flags": omitted,
                  "root": str(isolation.root), "isolation": isolation.report, "runtime": runtime, "result": result,
                  "requests": state.requests, "original_executed": False}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        print(json.dumps({"record": str(directory / (stem + ".json")), "exit_code": result["exit_code"],
                          "requests": len(state.requests), "omitted_oracle_flags": omitted}, indent=2))
    finally:
        isolation.close()


if __name__ == "__main__":
    main()
