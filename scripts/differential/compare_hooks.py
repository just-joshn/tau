#!/usr/bin/env python3
"""Summarize/compare owned hook runs while preserving payload and framing gaps."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import REPO, TARGET_SHA256
from run_hooks import CASES

MARKER = re.compile(r"OWNED_(?:PRE_CONTEXT_[A-Za-z]+|POST_CONTEXT_[A-Za-z]+|STOP_CONTINUATION|SESSION_[A-Z]+)")


def walk(value, path=()):
    if isinstance(value, str): yield path, value
    elif isinstance(value, list):
        for index, item in enumerate(value): yield from walk(item, path + (index,))
    elif isinstance(value, dict):
        for key, item in value.items(): yield from walk(item, path + (key,))


def describe(path):
    raw = path.read_bytes(); record = json.loads(raw)
    assert record["isolation"]["passed"] is True
    if record["executable"] == "original": assert record["target_sha256"] == TARGET_SHA256
    root = record["isolation"]["root"]
    def normalized(value):
        if isinstance(value, str): return value.replace(root, "$DISPOSABLE")
        if isinstance(value, list): return [normalized(item) for item in value]
        if isinstance(value, dict): return {key: normalized(item) for key, item in value.items()}
        return value
    calls = {}; results = {}; markers = {}; channels = {}
    for index, request in enumerate(record["requests"]):
        body = request["body"]
        for message in body.get("messages", []):
            if not isinstance(message.get("content"), list): continue
            for block in message["content"]:
                if block.get("type") == "tool_use":
                    calls.setdefault(block["id"], {"name": block["name"], "input": normalized(block["input"])})
                if block.get("type") == "tool_result":
                    results[block["tool_use_id"]] = {"is_error": block.get("is_error", False),
                        "content_sha256": hashlib.sha256(json.dumps(block.get("content"), sort_keys=True).encode()).hexdigest()}
        for where, value in walk(body):
            for marker in MARKER.findall(value):
                markers.setdefault(marker, index)
                channel = "other"
                if where and where[0] == "system": channel = "system"
                elif len(where) >= 2 and where[0] == "messages":
                    message = body["messages"][where[1]]
                    kind = "text"
                    if len(where) >= 4 and where[2] == "content" and isinstance(where[3], int): kind = message["content"][where[3]].get("type", "unknown")
                    channel = message.get("role", "unknown") + ":" + kind
                channels.setdefault(marker, set()).add(channel)
    inputs = [event["input"] for event in record["hook_lifecycle"] if event.get("event") == "input"]
    stages = []
    for stage in record["stages"]:
        outcome = stage["result"]
        try: result = json.loads(outcome["stdout"])
        except ValueError: result = {}
        stages.append({"exit": outcome["exit_code"], "timeout": outcome["timed_out"], "limited": outcome["output_limited"],
                       "requests": stage["request_end"] - stage["request_start"], "text": result.get("result"),
                       "result_fields": sorted(result), "stderr_bytes": len(outcome["stderr"].encode())})
    return {"artifact": str(path.relative_to(REPO)), "sha256": hashlib.sha256(raw).hexdigest(), "isolation": True,
            "runtime": record["runtime"], "fixture_sha256": record["fixture_sha256"], "stage_count": len(stages), "stages": stages,
            "generation_requests": sum(request["path"].split("?")[0] == "/v1/messages" for request in record["requests"]),
            "request_parameters": [{key: value for key, value in request["body"].items() if key not in ["messages", "system", "tools", "metadata"]} for request in record["requests"]],
            "model_tool_inputs": list(calls.values()), "tool_errors": [value["is_error"] for value in results.values()],
            "tool_result_hashes": [value["content_sha256"] for value in results.values()],
            "hook_events": [value["hook_event_name"] + ":" + str(value.get("tool_name", value.get("source", ""))) for value in inputs],
            "hook_input_keys": [sorted(value) for value in inputs],
            "hook_effective_inputs": [normalized(value["tool_input"]) for value in inputs if "tool_input" in value],
            "post_tool_responses": [normalized(value["tool_response"]) for value in inputs if "tool_response" in value],
            "stop_active": [value.get("stop_hook_active") for value in inputs if value["hook_event_name"] == "Stop"],
            "last_assistant_messages": [value.get("last_assistant_message") for value in inputs if value["hook_event_name"] == "Stop"],
            "session_sources": [value.get("source") for value in inputs if value["hook_event_name"] == "SessionStart"],
            "marker_first_request": markers, "marker_channels": {name: sorted(values) for name, values in channels.items()},
            "final_files": record["final_files"], "survivors": record["surviving_hook_pids"],
            "hook_process_count": len(record["hook_pids"]), "hook_exit_count": sum(event.get("event") == "exit" for event in record["hook_lifecycle"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-artifacts", type=Path, default=REPO / "artifacts/differential-pass/hooks")
    parser.add_argument("--tau-artifacts", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    original_dir = args.original_artifacts.resolve(); tau_dir = args.tau_artifacts.resolve() if args.tau_artifacts else None
    output = (args.output or tau_dir or original_dir).resolve(); output.mkdir(parents=True, exist_ok=True)
    cases = {}; baseline = {}; raw_hashes = 0
    comparable = ["stage_count", "generation_requests", "hook_events", "model_tool_inputs", "tool_errors", "hook_effective_inputs", "post_tool_responses", "stop_active", "last_assistant_messages", "session_sources", "marker_first_request", "marker_channels", "final_files", "survivors", "hook_process_count", "hook_exit_count", "hook_input_keys", "tool_result_hashes", "request_parameters"]
    control_flow = ["stage_count", "generation_requests", "hook_events", "model_tool_inputs", "tool_errors", "stop_active", "session_sources", "final_files", "survivors", "hook_process_count", "hook_exit_count", "stage_results"]
    for case in CASES:
        path = original_dir / ("original-" + case + ".json")
        if not path.exists(): continue
        original = describe(path); baseline[case] = original; raw_hashes += 1
        entry = {"original": original}
        if tau_dir and (tau_dir / ("tau-" + case + ".json")).exists():
            tau = describe(tau_dir / ("tau-" + case + ".json")); raw_hashes += 1
            checks = {key: original[key] == tau[key] for key in comparable}
            checks["stage_results"] = [{key: stage[key] for key in ["exit", "timeout", "limited", "requests", "text"]} for stage in original["stages"]] == [{key: stage[key] for key in ["exit", "timeout", "limited", "requests", "text"]} for stage in tau["stages"]]
            checks["result_framing"] = original["stages"] == tau["stages"]
            entry.update({"tau": tau, "comparisons": checks})
        cases[case] = entry
    complete = len(cases) == len(CASES) and all("tau" in entry for entry in cases.values())
    report = {"format_version": 1, "scope": "Owned command hooks, original baseline and separately recorded reconstructed runs; no full wire equivalence implied", "expected_cases": CASES,
              "original_baseline_complete": len(baseline) == len(CASES), "complete_pair_set": complete,
              "control_flow_observables": control_flow,
              "all_control_flow_observables_equal": complete and all(entry["comparisons"][key] for entry in cases.values() for key in control_flow),
              "all_compared_observables_equal": complete and all(all(entry["comparisons"].values()) for entry in cases.values()), "cases": cases}
    (output / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    compact = {key: value for key, value in report.items() if key != "cases"}
    compact["cases"] = {name: {target: {key: entry[target][key] for key in ["sha256", "generation_requests", "hook_events", "tool_errors", "final_files", "stop_active", "session_sources", "hook_process_count", "survivors"]} for target in ["original", "tau"] if target in entry} | ({"comparisons": entry["comparisons"]} if "comparisons" in entry else {}) for name, entry in cases.items()}
    (output / "compact-comparison.json").write_text(json.dumps(compact, indent=2) + "\n")
    audit = {"original_cases": len(baseline), "raw_hashes_verified": raw_hashes,
             "original_cli_invocations": sum(value["stage_count"] for value in baseline.values()), "original_api_requests": sum(value["generation_requests"] for value in baseline.values()),
             "original_hook_processes": sum(value["hook_process_count"] for value in baseline.values()),
             "all_original_bounded_clean": all(not value["survivors"] and value["hook_process_count"] == value["hook_exit_count"] and all(not stage["timeout"] and not stage["limited"] and stage["exit"] == 0 for stage in value["stages"]) for value in baseline.values()),
             "target_sha256": TARGET_SHA256, "fixture_versions": sorted({value["fixture_sha256"] for value in baseline.values()}),
             "limits": ["Tau comparisons are absent until explicitly run after root integration.", "Original metadata and output framing remain in raw records; disposable root normalized only in owned field comparisons.", "Bash nonzero observed no PostToolUse despite executing the command; this corrects the earlier generic resolved-call inference."]}
    (output / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    print(json.dumps({key: value for key, value in audit.items() if key not in ["fixture_versions", "limits"]}))


if __name__ == "__main__": main()
