#!/usr/bin/env python3
"""Controlled original smoke runs. Requires live passing isolation canaries."""
import argparse
import json
from pathlib import Path
import subprocess
from isolation import REPO, TARGET_SHA256, verified_isolation
from mock_api import MODEL, SCENARIOS, RECOVERY_SCENARIO, MockState

PINNED_TARGET = Path("/Users/josh-desktop/.local/share/claude/versions/2.1.326")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=["version", "help", *SCENARIOS, RECOVERY_SCENARIO])
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass")
    parser.add_argument("--ordinary", action="store_true", help="Exercise ordinary startup with empty disposable settings instead of --bare")
    parser.add_argument("--sse-framing", choices=["named", "data-only"], default="named")
    args = parser.parse_args()
    artifact_dir = args.artifacts.resolve()
    application = args.scenario if args.scenario not in ["version", "help"] else "text"
    state = MockState(application, args.sse_framing)
    with verified_isolation(artifact_dir, state.handler()) as isolation:
        target = isolation.copy_target(PINNED_TARGET)
        if args.scenario == "version": arguments = ["--version"]
        elif args.scenario == "help": arguments = ["--help"]
        elif args.scenario == RECOVERY_SCENARIO:
            (isolation.root / "work" / "a.txt").write_text("alpha\n")
            arguments = ["--print", "OWNED_TRANSPORT_RECOVERY_PROMPT", "--model", MODEL,
                         "--output-format", "json", "--no-session-persistence", "--dangerously-skip-permissions",
                         "--tools", "Read,Edit,Write"]
        else:
            (isolation.root / "work" / "a.txt").write_text("alpha\n")
            arguments = ([] if args.ordinary else ["--bare"]) + ["--print", "TAU_DIFFERENTIAL_"+args.scenario.upper(), "--model", MODEL,
                         "--output-format", "json", "--no-session-persistence", "--dangerously-skip-permissions",
                         "--tools", "Read,Edit,Write"]
        result = isolation.sandbox([str(target), *arguments], timeout=20)
        record = {"scenario": args.scenario, "sse_framing": args.sse_framing, "mode": "ordinary" if args.ordinary else "bare", "target_sha256": TARGET_SHA256, "original_executed": True,
                  "isolation": isolation.report, "arguments": arguments, "result": result, "requests": state.requests,
                  "final_file": (isolation.root / "work" / "a.txt").read_text() if args.scenario not in ["version", "help"] else None}
        (artifact_dir / ("original-" + args.scenario + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        (artifact_dir / ("original-" + args.scenario + ".stdout.txt")).write_text(result["stdout"])
        (artifact_dir / ("original-" + args.scenario + ".stderr.txt")).write_text(result["stderr"])
        logs = subprocess.run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate",
                               'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifact_dir / ("original-" + args.scenario + ".denials.txt")).write_text(logs.stdout)
        print(json.dumps({"scenario": args.scenario, "isolation_passed": isolation.verified, "exit_code": result["exit_code"], "requests": len(state.requests), "timed_out": result["timed_out"], "stdout_tail": result["stdout"][-800:], "stderr_tail": result["stderr"][-800:]}))

if __name__ == "__main__": main()
