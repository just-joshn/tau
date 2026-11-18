#!/usr/bin/env python3
"""Catalog scenario: run tau under copied Bun in a verified disposable profile, or compare.

  python3 scripts/differential/run_original.py catalog --artifacts DIR
  python3 scripts/differential/run_catalog.py tau --artifacts DIR
  python3 scripts/differential/run_catalog.py compare --artifacts DIR
"""
import argparse
import json
from pathlib import Path

from bun_runtime import bun_environment, copy_bun_executable, copy_bun_source_runtime
from isolation import REPO, verified_isolation
from mock_api import MODEL, MockState
from scenarios_catalog import CATALOG_SCENARIO, setup, summarize


def run_tau(artifact_dir: Path):
    state = MockState(CATALOG_SCENARIO)
    with verified_isolation(artifact_dir, state.handler()) as isolation:
        isolation.env.update(bun_environment(isolation.root))
        bun, executable = copy_bun_executable(isolation.root)
        entry, runtime = copy_bun_source_runtime(isolation.root, executable)
        state.work = isolation.root / "work"
        setup(state.work)
        arguments = ["--print", "TAU_DIFFERENTIAL_CATALOG", "--model", MODEL, "--output-format", "stream-json",
                     "--dangerously-skip-permissions"]
        result = isolation.sandbox([str(bun), "--no-install", str(entry), *arguments], timeout=60)
        record = {"scenario": CATALOG_SCENARIO, "mode": "tau-bun-source", "original_executed": False,
                  "isolation": isolation.report, "runtime": runtime, "arguments": arguments,
                  "original_only_flags": ["--verbose", "--no-session-persistence"], "result": result,
                  "requests": state.requests, "final_file": (state.work / "nb.ipynb").read_text()}
    (artifact_dir / "tau-catalog.json").write_text(json.dumps(record, indent=2) + "\n")
    (artifact_dir / "tau-catalog.stdout.txt").write_text(result["stdout"])
    (artifact_dir / "tau-catalog.stderr.txt").write_text(result["stderr"])
    print(json.dumps({"exit_code": result["exit_code"], "requests": len(state.requests),
                      "timed_out": result["timed_out"], "stderr_tail": result["stderr"][-800:]}))


def compare(artifact_dir: Path):
    original = summarize(json.loads((artifact_dir / "original-catalog.json").read_text()))
    tau = summarize(json.loads((artifact_dir / "tau-catalog.json").read_text()))
    keys = ["requests", "deferred_listed_initially", "listing_header", "placeholder", "notebook_tool_per_request",
            "tool_search_result", "notebook_edit_result", "final_notebook"]
    rows = {key: {"equal": original[key] == tau[key], "original": original[key], "tau": tau[key]} for key in keys}
    rows["read_result_text"] = {"equal": original["read_result_text"] == tau["read_result_text"],
                                "original": original["read_result_text"], "tau": tau["read_result_text"]}
    # Tool order and the eager/deferred sets differ by design (tau lacks several original tools); report, never gate.
    for key in ["tool_names", "listed_names"]:
        rows[key] = {"equal": None, "original": original[key], "tau": tau[key]}
    (artifact_dir / "catalog-comparison.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(json.dumps({key: row["equal"] for key, row in rows.items()}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["tau", "compare"])
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/catalog")
    args = parser.parse_args()
    artifact_dir = args.artifacts.resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (run_tau if args.command == "tau" else compare)(artifact_dir)


if __name__ == "__main__":
    main()
