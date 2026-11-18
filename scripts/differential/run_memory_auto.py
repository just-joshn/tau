#!/usr/bin/env python3
"""Auto memory differential: the original or tau (copied Bun + source) in one verified profile.

Two print runs share one isolation root: `save` writes a memory and MEMORY.md with no
permission flags, `recall` must receive MEMORY.md. See scenarios_memory_auto.py.
"""
import argparse
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256, Isolation
from bun_runtime import bun_environment
from mock_api import MODEL
from run_child_workflows import prepare_bun_adapter
from run_original import PINNED_TARGET
from scenarios_memory_auto import PROMPTS, STAGES, AutoMemoryMock, memory_directory, verify


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/memory-auto")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    state = AutoMemoryMock()
    isolation = Isolation(directory, state.handler())
    try:
        if args.executable == "tau":
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        state.memory = memory_directory(isolation.root)
        if args.executable == "original":
            command = [str(isolation.copy_target(PINNED_TARGET))]
            runtime = {"target_sha256": TARGET_SHA256}
        else:
            bun, entry, runtime, _probes = prepare_bun_adapter(isolation, directory, args.executable + "-memory-auto")
            command = [str(bun), "--no-install", str(entry)]
        stages = {}
        for stage in STAGES:
            arguments = ["--print", PROMPTS[stage], "--model", MODEL, "--output-format", "stream-json", "--verbose"]
            stages[stage] = {"arguments": arguments, "result": isolation.sandbox([*command, *arguments], timeout=60)}
        outcome = verify(state.requests, [stages[s]["result"]["stdout"] for s in STAGES], state.memory)
        record = {"executable": args.executable, "root": str(isolation.root), "memory": str(state.memory),
                  "isolation": isolation.report, "runtime": runtime, "stages": stages, "requests": state.requests,
                  "outcome": outcome, "original_executed": args.executable == "original"}
        stem = args.executable + "-memory-auto"
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        summary = {"executable": args.executable, **outcome,
                   "exit_codes": {s: stages[s]["result"]["exit_code"] for s in STAGES},
                   "stderr_tails": {s: stages[s]["result"]["stderr"][-400:] for s in STAGES}}
        (directory / (stem + ".summary.json")).write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
    finally:
        isolation.close()


if __name__ == "__main__":
    main()
