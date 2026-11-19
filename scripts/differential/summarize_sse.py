#!/usr/bin/env python3
"""Record preserved before/after SSE behavior plus named-event regressions."""
import hashlib
import json
from pathlib import Path
from isolation import REPO

BASE = REPO / "artifacts/differential-pass"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def describe(path):
    data = path.read_bytes()
    record = json.loads(data)
    result = record["result"]
    output = json.loads(result["stdout"])
    errors = {}
    for request in record["requests"]:
        for message in request["body"].get("messages", []):
            content = message.get("content", [])
            if not isinstance(content, list): continue
            for block in content:
                if block.get("type") == "tool_result":
                    errors.setdefault(block["tool_use_id"], block.get("is_error", False))
    provider_hash = record.get("runtime", {}).get("compiled_files", {}).get("src/provider.js")
    return {"artifact": str(path.relative_to(REPO)), "sha256": sha(data),
            "isolation_passed": record["isolation"]["passed"], "profile_sha256": sha(record["isolation"]["profile"].encode()),
            "canary_checks_sha256": sha(json.dumps(record["isolation"]["checks"], sort_keys=True).encode()),
            "provider_sha256": provider_hash, "exit_code": result["exit_code"], "timed_out": result["timed_out"],
            "output_limited": result["output_limited"], "process_group_cleanup_killed_remaining": result["remaining_process_group_killed"],
            "stream_flags": [r["body"].get("stream") for r in record["requests"]],
            "result_text": output.get("result"), "tool_errors": list(errors.values()), "final_file": record["final_file"]}


def main():
    cases = {}
    for phase in ["before", "after"]:
        for executable in ["original", "tau"]:
            path = BASE / ("sse-data-only-" + phase) / (executable + "-text.json")
            cases[phase + "-" + executable] = describe(path)
    for scenario in ["text", "files", "failures"]:
        cases["named-" + scenario] = describe(BASE / "sse-named-after" / ("tau-" + scenario + ".json"))
    for name, case in cases.items():
        if name.startswith("named-"):
            scenario = name.removeprefix("named-")
            expected_flags = [True] * {"text": 1, "files": 4, "failures": 6}[scenario]
            expected_text = "mock done" if scenario == "text" else "file workflow done"
            expected_file = "alpha\n" if scenario == "text" else "final\n"
            expected_errors = {"text": [], "files": [False, False, False], "failures": [True, True, False, True, False]}[scenario]
        else:
            expected_flags = [True] if name == "before-tau" else [True, False]
            expected_text, expected_file, expected_errors = "mock done", "alpha\n", []
        case["fixture_passed"] = (case["isolation_passed"] and case["exit_code"] == 0 and not case["timed_out"] and
                                  not case["output_limited"] and case["stream_flags"] == expected_flags and
                                  case["result_text"] == expected_text and case["final_file"] == expected_file and
                                  case["tool_errors"] == expected_errors)
    after_checks = json.loads((BASE / "sse-data-only-after/tau-text.json").read_text())["isolation"]["checks"]
    summary = {"format_version": 1, "scope": "Unlabeled Messages SSE before/after and named-event workflow regressions",
               "cases": cases, "all_fixture_checks_passed": all(case["fixture_passed"] for case in cases.values()),
               "before_stream_sequence_equal": cases["before-original"]["stream_flags"] == cases["before-tau"]["stream_flags"],
               "after_stream_sequence_equal": cases["after-original"]["stream_flags"] == cases["after-tau"]["stream_flags"],
               "after_result_equal": cases["after-original"]["result_text"] == cases["after-tau"]["result_text"],
               "after_canaries": after_checks,
               "cleanup": "Every run invokes bounded process-group cleanup on normal exit and timeout; boolean records whether a group remained to kill.",
               "limits": "Deterministic fixture only; complete original CLI equivalence remains unproven."}
    path = BASE / "sse-data-only-after/checkpoint.json"
    path.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"artifact": str(path), "cases": len(cases), "all_fixture_checks_passed": summary["all_fixture_checks_passed"],
                      "after_stream_sequence_equal": summary["after_stream_sequence_equal"]}))
    if not summary["all_fixture_checks_passed"]: raise SystemExit(1)


if __name__ == "__main__": main()
