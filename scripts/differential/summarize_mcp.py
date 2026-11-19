#!/usr/bin/env python3
"""Compact, prompt-free MCP differential evidence checkpoint."""
import argparse
import hashlib
import json
from pathlib import Path
from isolation import REPO


def sha(data):
    return hashlib.sha256(data).hexdigest()


def describe(path):
    raw = path.read_bytes()
    record = json.loads(raw)
    result = record["result"]
    try: output = json.loads(result["stdout"])
    except ValueError: output = {}
    phases = {}
    for event in record["mcp_lifecycle"]:
        if event.get("event") == "request":
            phases.setdefault(event["message"]["method"], set()).add(event["pid"])
    tool_results = []
    for request in record["requests"][-1:]:
        for message in request["body"].get("messages", []):
            content = message.get("content", [])
            if not isinstance(content, list): continue
            for block in content:
                if block.get("type") != "tool_result": continue
                content = block.get("content", "")
                tool_results.append({"is_error": block.get("is_error", False),
                    "content_sha256": sha(json.dumps(content, sort_keys=True).encode()),
                    "block_types": [b.get("type") for b in content] if isinstance(content, list) else ["string"]})
    expected_error = record["mode"] != "allowed"
    fixture_passed = (result["exit_code"] == 0 and not result["timed_out"] and not result["output_limited"] and
                      record.get("fixture_pids_alive_after_group_cleanup", []) == [] and
                      len(record["requests"]) == 2 and record["mcp_tool_call_count"] == (0 if expected_error else 1) and
                      len(tool_results) == 1 and tool_results[0]["is_error"] == expected_error and
                      output.get("result") == "MCP workflow done")
    return {"artifact": str(path.relative_to(REPO)), "sha256": sha(raw), "fixture_sha256": record["fixture_sha256"],
            "isolation_passed": record["isolation"]["passed"], "profile_sha256": sha(record["isolation"]["profile"].encode()),
            "fixture_passed": fixture_passed, "exit_code": result["exit_code"], "model_requests": len(record["requests"]),
            "mcp_tool_calls": record["mcp_tool_call_count"], "tool_results": tool_results,
            "discovery_processes": len(phases.get("server/discover", set())),
            "initialization_processes": len(phases.get("initialize", set())),
            "discovery_initialization_same_process": phases.get("server/discover", set()) == phases.get("initialize", set()),
            "process_group_cleanup_sent": result["remaining_process_group_killed"],
            "fixture_pids_alive_after_group_cleanup": record.get("fixture_pids_alive_after_group_cleanup", "not sampled in initial record"),
            "advertised_tools": [tool["name"] for tool in record["requests"][0]["body"].get("tools", [])] if record["requests"] else []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/mcp")
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    cases = {}
    for executable in ["original", "tau"]:
        for mode in ["allowed", "denied", "required"]:
            path = directory / (executable + "-" + mode + ".json")
            if path.exists(): cases[executable + "-" + mode] = describe(path)
    summary = {"format_version": 1, "scope": "Explicit stdio MCP; independent mixed resource/structured-content fixture; no real config or accounts",
               "cases": cases, "all_fixture_checks_passed": all(case["isolation_passed"] and case["fixture_passed"] for case in cases.values()),
               "observations": ["--tools empty retains explicitly configured MCP tools in both CLIs.",
                    "Default approval denies tools/call; exact allowance permits one call.",
                    "Required user interaction denies dispatch even with bypass plus exact allowance.",
                    "Structured content suppresses initial text; resource text and JSON retained. Exact framing differs.",
                    "Lifecycle equality is recorded separately; semantic fixture checks do not imply complete equivalence."],
               "full_canaries": "Embedded in each source record, identified by SHA-256 above."}
    comparisons = {}
    for mode in ["allowed", "denied", "required"]:
        original, tau = cases.get("original-" + mode), cases.get("tau-" + mode)
        if original and tau:
            comparisons[mode] = {key: original[key] == tau[key] for key in
                ["exit_code", "model_requests", "mcp_tool_calls", "discovery_initialization_same_process", "advertised_tools"]}
            comparisons[mode]["tool_errors"] = [b["is_error"] for b in original["tool_results"]] == [b["is_error"] for b in tau["tool_results"]]
            comparisons[mode]["tool_result_content"] = [b["content_sha256"] for b in original["tool_results"]] == [b["content_sha256"] for b in tau["tool_results"]]
    summary["comparisons"] = comparisons
    (directory / "checkpoint.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"artifact": str(directory / "checkpoint.json"), "cases": len(cases),
                      "all_fixture_checks_passed": summary["all_fixture_checks_passed"]}))


if __name__ == "__main__": main()
