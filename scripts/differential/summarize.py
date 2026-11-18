#!/usr/bin/env python3
"""Generate a compact evidence index; omit original prompts and full schemas."""
import hashlib
import json
from pathlib import Path
from isolation import REPO
from mock_api import SCENARIOS

ARTIFACTS = REPO / "artifacts/differential-pass"


def hashed(value):
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return {"bytes": len(text.encode()), "sha256": hashlib.sha256(text.encode()).hexdigest()}


def describe(path):
    record = json.loads(path.read_text())
    result = record["result"]
    try:
        output = json.loads(result["stdout"])
    except ValueError:
        output = {}
    requests = []
    for request in record["requests"]:
        body = request["body"]
        tools = []
        for tool in body.get("tools", []):
            schema = tool.get("input_schema", {})
            tools.append({"name": tool["name"], "fields": sorted(schema.get("properties", {})),
                          "required": schema.get("required", [])})
        results = []
        for message in body.get("messages", []):
            content = message.get("content", [])
            if not isinstance(content, list):
                continue
            for block in content:
                if block.get("type") == "tool_result":
                    results.append({"tool_use_id": block.get("tool_use_id"), "is_error": block.get("is_error", False),
                                    "content": hashed(block.get("content", "")), "fields": sorted(block)})
        requests.append({"path": request["path"], "stream": body.get("stream"), "model": body.get("model"),
                         "max_tokens": body.get("max_tokens"), "tools": tools, "tool_results": results})
    seen = {}
    for request in requests:
        for block in request["tool_results"]:
            seen.setdefault(block["tool_use_id"], block["is_error"])
    mode = record.get("mode") or ("bare" if "--bare" in record["arguments"] else "ordinary")
    return {"artifact": str(path.relative_to(REPO)), "mode": mode, "sse_framing": record.get("sse_framing", "named"),
            "isolation_passed": record["isolation"]["passed"], "canaries": record["isolation"]["checks"],
            "target_sha256": record.get("target_sha256"), "exit_code": result["exit_code"],
            "timed_out": result["timed_out"], "output_limited": result["output_limited"],
            "result_text": output.get("result"), "result_fields": sorted(output), "is_error": output.get("is_error"),
            "final_file": record["final_file"], "stderr": hashed(result["stderr"]), "requests": requests,
            "runtime": record.get("runtime"), "arguments": record["arguments"], "tool_error_sequence": list(seen.values())}


def main():
    cases = {}
    for prefix, directory in [("bare", ARTIFACTS), ("ordinary", ARTIFACTS / "ordinary")]:
        for scenario in SCENARIOS:
            path = directory / ("original-" + scenario + ".json")
            if path.exists(): cases[prefix + "-" + scenario] = describe(path)
    for scenario in SCENARIOS:
        path = ARTIFACTS / ("tau-" + scenario + ".json")
        if path.exists(): cases["tau-" + scenario] = describe(path)
    for executable in ["original", "tau"]:
        path = ARTIFACTS / "sse-data-only" / (executable + "-text.json")
        if path.exists(): cases[executable + "-text-data-only"] = describe(path)
    comparisons = {}
    for scenario in SCENARIOS:
        left, right = cases.get("ordinary-" + scenario), cases.get("tau-" + scenario)
        if left and right:
            comparisons[scenario] = {key: left[key] == right[key] for key in ["exit_code", "result_text", "final_file", "tool_error_sequence"]}
            comparisons[scenario]["request_count_equal"] = len(left["requests"]) == len(right["requests"])
            comparisons[scenario]["tool_schemas_equal"] = [r["tools"] for r in left["requests"]] == [r["tools"] for r in right["requests"]]
            comparisons[scenario]["tool_result_content_equal"] = [[t["content"] for t in r["tool_results"]] for r in left["requests"]] == [[t["content"] for t in r["tool_results"]] for r in right["requests"]]
    summary = {"format_version": 1, "scope": "Disposable CLI baseline; no live accounts or internet APIs", "cases": cases,
               "comparisons": comparisons,
               "observations": ["Bare mode advertises Edit+Read, ordinary mode includes Write under identical --tools flags.",
                    "Initial data-only SSE original run retried nonstream; named SSE required one request. Preserved text-data-only-sse/.",
                    "Tau currently lacks --bare and --no-session-persistence; omission explicitly recorded in tau raw artifacts.",
                    "Output random IDs/timing/cost differ; full result fields and tool schema shapes retained as gaps."]}
    path = ARTIFACTS / "summary.json"
    path.write_text(json.dumps(summary, indent=2) + "\n")
    compact_cases = {}
    for name, case in cases.items():
        raw_path = REPO / case["artifact"]
        raw = json.loads(raw_path.read_text())
        scenario = raw["scenario"]
        expected_errors = [] if scenario == "text" else ([False, False, True] if case["mode"] == "bare" else [False, False, False])
        if scenario == "failures": expected_errors = [True, True, False, True, False]
        expected_file = "alpha\n" if scenario == "text" else ("beta\n" if case["mode"] == "bare" else "final\n")
        expected_count = 1 if scenario == "text" else (6 if scenario == "failures" else 4)
        if case["sse_framing"] == "data-only" and name.startswith("original-"): expected_count = 2
        fixture_passed = (case["exit_code"] == 0 and not case["timed_out"] and not case["output_limited"] and
                          case["final_file"] == expected_file and case["tool_error_sequence"] == expected_errors and
                          len(case["requests"]) == expected_count and case["result_text"] == ("mock done" if scenario == "text" else "file workflow done"))
        compact_cases[name] = {"artifact": case["artifact"], "sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            "isolation_passed": case["isolation_passed"], "profile_sha256": hashlib.sha256(raw["isolation"]["profile"].encode()).hexdigest(),
            "fixture_passed": fixture_passed, "exit_code": case["exit_code"], "requests": len(case["requests"]),
            "stream_flags": [r["stream"] for r in case["requests"]], "tool_errors": case["tool_error_sequence"],
            "final_file": case["final_file"]}
    compact = {"format_version": 1, "scope": summary["scope"], "cases": compact_cases,
               "all_fixture_checks_passed": all(c["fixture_passed"] and c["isolation_passed"] for c in compact_cases.values()),
               "comparisons": comparisons, "known_gaps": summary["observations"],
               "canary_coverage": sorted({key for case in cases.values() for key in case["canaries"]}),
               "full_canaries": "Embedded per source artifact; hashes above identify exact records. Historical checkpoint.json unchanged."}
    if "original-text-data-only" in cases and "tau-text-data-only" in cases:
        left, right = cases["original-text-data-only"], cases["tau-text-data-only"]
        compact["data_only_sse_comparison"] = {
            "request_count_equal": len(left["requests"]) == len(right["requests"]),
            "stream_flags_equal": [r["stream"] for r in left["requests"]] == [r["stream"] for r in right["requests"]],
            "result_text_equal": left["result_text"] == right["result_text"]}
    (ARTIFACTS / "compact-checkpoint.json").write_text(json.dumps(compact, indent=2) + "\n")
    print(json.dumps({"summary": str(path), "cases": list(cases), "comparisons": comparisons}))


if __name__ == "__main__": main()
