#!/usr/bin/env python3
"""Compare recorded settings workflows without hiding defaults/schema/framing gaps."""
import hashlib
import argparse
import json
from pathlib import Path
from isolation import REPO
from run_settings import CASES
from settings_fixture import MARKER_NAMES

BASE = REPO / "artifacts/differential-pass"


def sha(value): return hashlib.sha256(value).hexdigest()


def field_differences(left, right, path=""):
    if isinstance(left, dict) and isinstance(right, dict):
        output = []
        for key in sorted(set(left) | set(right)):
            location = path + "/" + key
            if key not in left: output.append({"path": location, "original_missing": True, "tau": right[key]})
            elif key not in right: output.append({"path": location, "original": left[key], "tau_missing": True})
            else: output.extend(field_differences(left[key], right[key], location))
        return output
    if left != right: return [{"path": path or "/", "original": left, "tau": right}]
    return []


def describe(path):
    data = path.read_bytes()
    record = json.loads(data)
    results = {}
    for index, request in enumerate(record["requests"]):
        for message in request["body"].get("messages", []):
            content = message.get("content", [])
            if not isinstance(content, list): continue
            for block in content:
                if block.get("type") == "tool_result":
                    results.setdefault(block["tool_use_id"], {"first_request": index, "error": block.get("is_error", False),
                        "hash": sha(json.dumps(block.get("content", ""), sort_keys=True).encode())})
    stages = []
    for stage in record["stages"]:
        start, end, version = stage["request_start"], stage["request_end"], stage["version"]
        requests = record["requests"][start:end]
        observations = record["observations"][start:end]
        first = {}
        channels = {}
        for index, observation in enumerate(observations):
            for name, locations in observation["markers_v" + str(version)].items():
                first.setdefault(name, index)
                if name in channels: continue
                kinds = set()
                for location in locations:
                    pieces = location.split("/")
                    if location == "/system" or location.startswith("/system/"): kinds.add("system")
                    elif location.startswith("/messages/"):
                        message = requests[index]["body"]["messages"][int(pieces[2])]
                        block = message.get("content", [])
                        kind = "text"
                        if isinstance(block, list) and len(pieces) > 4 and pieces[4].isdigit():
                            kind = block[int(pieces[4])].get("type", "unknown")
                        kinds.add(str(message.get("role")) + ":" + kind)
                channels[name] = sorted(kinds)
        marker_versions = [v for v in [1, 2] if observations and "CLI_SYSTEM" in observations[0]["markers_v" + str(v)]]
        tools = requests[0]["body"].get("tools", []) if requests else []
        shapes = {tool["name"]: {"fields": sorted(tool.get("input_schema", {}).get("properties", {})),
                                 "required": tool.get("input_schema", {}).get("required", [])} for tool in tools}
        result = stage["result"]
        try: output = json.loads(result["stdout"])
        except ValueError: output = {}
        blocks = [block for block in results.values() if start <= block["first_request"] < end]
        stages.append({"requests": end-start, "models": list(dict.fromkeys(o["model"] for o in observations)),
            "request_parameters": {key: value for key, value in requests[0]["body"].items() if key not in ["messages", "system", "tools", "metadata"]} if requests else {},
            "request_parameters_by_request": [{key: value for key, value in request["body"].items() if key not in ["messages", "system", "tools", "metadata"]} for request in requests],
            "marker_first_requests": dict(sorted(first.items())), "marker_channels": dict(sorted(channels.items())), "system_marker_versions": marker_versions,
            "tools": [tool["name"] for tool in tools], "schema_shapes": shapes,
            "errors": [block["error"] for block in blocks], "content_hashes": [block["hash"] for block in blocks],
            "exit": result["exit_code"], "timeout": result["timed_out"], "limited": result["output_limited"],
            "text": output.get("result"), "result_fields": sorted(output), "stderr_bytes": len(result["stderr"].encode())})
    return {"artifact": str(path.relative_to(REPO)), "sha256": sha(data), "isolation_passed": record["isolation"]["passed"],
            "runtime": record.get("runtime"), "skipped_original_flags": record.get("skipped_original_flags", []),
            "stages": stages, "final_files": record["final_files"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-artifacts", type=Path, default=BASE / "settings")
    parser.add_argument("--tau-artifacts", type=Path, default=BASE / "settings-tau")
    args = parser.parse_args()
    original_directory, directory = args.original_artifacts.resolve(), args.tau_artifacts.resolve()
    cases = {}
    for case in CASES:
        original_path, tau_path = original_directory / ("original-"+case+".json"), directory / ("tau-"+case+".json")
        if not original_path.exists() or not tau_path.exists(): continue
        original, tau = describe(original_path), describe(tau_path)
        comparisons = []
        for left, right in zip(original["stages"], tau["stages"]):
            comparisons.append({key: left[key] == right[key] for key in
                ["requests", "models", "request_parameters", "request_parameters_by_request", "marker_first_requests", "marker_channels", "system_marker_versions", "errors", "exit", "text", "tools", "schema_shapes", "content_hashes", "result_fields", "stderr_bytes"]})
            comparisons[-1]["available_tool_names"] = sorted(left["tools"]) == sorted(right["tools"])
        original_data = {key: value for key, value in original["final_files"].items() if key.endswith(".txt")}
        tau_data = {key: value for key, value in tau["final_files"].items() if key.endswith(".txt")}
        instruction_files = [key for key in original["final_files"] if key.endswith(".md")]
        cases[case] = {"original": original, "tau": tau, "comparisons": comparisons,
            "request_parameter_differences_by_stage": [[field_differences(left, right) for left, right in zip(a["request_parameters_by_request"], b["request_parameters_by_request"])] for a, b in zip(original["stages"], tau["stages"])],
            "stage_count_equal": len(original["stages"]) == len(tau["stages"]), "data_files_equal": original_data == tau_data,
            "instruction_files_equal_when_original_recorded": all(original["final_files"][key] == tau["final_files"].get(key) for key in instruction_files),
            "original_instruction_files_recorded": bool(instruction_files)}
    semantic_keys = ["requests", "models", "marker_first_requests", "marker_channels", "system_marker_versions", "errors", "exit", "text"]
    all_semantics_equal = all(case["stage_count_equal"] and case["data_files_equal"] and
        case["instruction_files_equal_when_original_recorded"] and case["original"]["isolation_passed"] and case["tau"]["isolation_passed"] and
        all(comparison[key] for comparison in case["comparisons"] for key in semantic_keys) for case in cases.values())
    differences = {key: [name for name, case in cases.items() if any(not comparison[key] for comparison in case["comparisons"])]
                   for key in ["request_parameters_by_request", "tools", "available_tool_names", "schema_shapes", "content_hashes", "result_fields", "stderr_bytes"]}
    parameter_paths = sorted({difference["path"] for case in cases.values() for stage in case["request_parameter_differences_by_stage"] for request in stage for difference in request})
    summary = {"format_version": 1, "scope": "Same owned settings/instruction fixtures; original vs tau, full differences retained", "cases": cases,
               "all_selected_observables_equal": all_semantics_equal, "selected_observables": semantic_keys + ["stage_count", "final_data_files", "recorded_instruction_files"],
               "remaining_difference_cases": differences, "request_parameter_difference_paths": parameter_paths,
               "limits": ["Tau lacks --no-session-persistence; skipped flags explicitly recorded.", "Original default model, schema and framing differences are not normalized away."]}
    (directory / "comparison.json").write_text(json.dumps(summary, indent=2) + "\n")
    compact = {"format_version": 1, "scope": summary["scope"], "case_count": len(cases), "all_selected_observables_equal": all_semantics_equal,
               "selected_observables": summary["selected_observables"], "request_parameter_difference_paths": parameter_paths,
               "remaining_difference_cases": {key: len(value) for key, value in differences.items()}, "marker_bits_in_order": MARKER_NAMES,
               "limits": summary["limits"]}
    prefix = json.dumps(compact, indent=2).rstrip()[:-1]
    lines = [prefix + ',\n  "cases": {']
    entries = list(cases.items())
    for index, (name, case) in enumerate(entries):
        def stage(value):
            first = value["marker_first_requests"]
            initial = hex(sum(1 << MARKER_NAMES.index(key) for key, index in first.items() if index == 0))
            late = {key: index for key, index in first.items() if index > 0}
            return {"model": ",".join(value["models"]), "requests": value["requests"], "initial_mask": initial, "late": late,
                    "system_versions": value["system_marker_versions"], "errors": value["errors"], "exit": value["exit"]}
        row = {"original_sha256": case["original"]["sha256"], "tau_sha256": case["tau"]["sha256"],
               "isolated": case["original"]["isolation_passed"] and case["tau"]["isolation_passed"],
               "original": [stage(s) for s in case["original"]["stages"]], "tau": [stage(s) for s in case["tau"]["stages"]],
               "comparisons": case["comparisons"], "data_files_equal": case["data_files_equal"],
               "instruction_files_equal": case["instruction_files_equal_when_original_recorded"]}
        lines.append("    " + json.dumps(name) + ": " + json.dumps(row) + ("," if index < len(entries)-1 else ""))
    lines.append("  }\n}\n")
    path = directory / "compact-comparison.json"
    path.write_text("\n".join(lines))
    print(json.dumps({"artifact": str(path), "cases": len(cases), "data_file_mismatches": [name for name, case in cases.items() if not case["data_files_equal"]],
                      "semantic_mismatches": [name for name, case in cases.items() if any(not comparison[key] for comparison in case["comparisons"] for key in semantic_keys)],
                      "all_selected_observables_equal": all_semantics_equal}))


if __name__ == "__main__": main()
