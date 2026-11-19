#!/usr/bin/env python3
"""WebFetch/WebSearch differential: the original or tau (copied Bun + source) in one verified profile.

`web` sets skipWebFetchPreflight; `web-preflight` leaves the api.anthropic.com domain
check on, which the loopback-only profile denies.
"""
import argparse
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256, Isolation
from bun_runtime import bun_environment
from mock_api import MODEL
from run_child_workflows import prepare_bun_adapter
from run_original import PINNED_TARGET
from scenarios_web import VARIANTS, WebMock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("variant", choices=VARIANTS)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/web")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    stem = args.executable + "-" + args.variant
    state = WebMock(args.variant)
    isolation = Isolation(directory, state.handler())
    try:
        if args.executable == "tau":
            isolation.env.update(bun_environment(isolation.root))
        isolation.verify()
        state.prepare(isolation)
        arguments = ["--print", "TAU_DIFFERENTIAL_WEB", "--model", MODEL, "--output-format", "json",
                     "--dangerously-skip-permissions", "--no-session-persistence"]
        if args.executable == "original":
            command = [str(isolation.copy_target(PINNED_TARGET))]
            runtime = {"target_sha256": TARGET_SHA256}
        else:
            bun, entry, runtime, _probes = prepare_bun_adapter(isolation, directory, stem)
            command = [str(bun), "--no-install", str(entry)]
        result = isolation.sandbox([*command, *arguments], timeout=60)
        record = {"executable": args.executable, "variant": args.variant, "arguments": arguments, "isolation": isolation.report,
                  "runtime": runtime, "result": result, "requests": state.requests, "page_hits": state.page_hits,
                  "original_executed": args.executable == "original"}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        summary = {"executable": args.executable, "variant": args.variant, "exit_code": result["exit_code"], "timed_out": result["timed_out"],
                   "request_kinds": [r.get("kind") for r in state.requests], "page_hits": state.page_hits,
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
