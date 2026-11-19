#!/usr/bin/env python3
"""Compact scope/origin/lifecycle evidence, retaining transport differences."""
import argparse
import hashlib
import json
from pathlib import Path
from isolation import REPO
from mcp_scope_fixture import SCOPE_CASES
from compare_settings import field_differences


def sha(value): return hashlib.sha256(value).hexdigest()


def describe(path):
    data = path.read_bytes()
    record = json.loads(data)
    result = record["result"]
    try: output = json.loads(result["stdout"])
    except ValueError: output = {}
    flags = {}
    content = {}
    for request in record["requests"]:
        for message in request["body"].get("messages", []):
            blocks = message.get("content", [])
            if not isinstance(blocks, list): continue
            for block in blocks:
                if block.get("type") == "tool_result":
                    flags.setdefault(block["tool_use_id"], block.get("is_error", False))
                    content.setdefault(block["tool_use_id"], sha(json.dumps(block.get("content", ""), sort_keys=True).encode()))
    phases = {}
    wire = {}
    for origin, events in record["lifecycle_by_origin"].items():
        methods = []
        phase_pids = {}
        wire[origin] = []
        for event in events:
            if event.get("event") in ["request", "response"]: wire[origin].append(event["message"])
            if event.get("event") == "request":
                method = event["message"].get("method")
                methods.append(method)
                phase_pids.setdefault(method, set()).add(event["pid"])
        phases[origin] = {"methods": methods, "started_pids": len({event["pid"] for event in events if event.get("event") == "start"}),
                          "discovery_initialize_same_pid": phase_pids.get("server/discover", set()) == phase_pids.get("initialize", set())}
    parameters = [{key: value for key, value in request["body"].items() if key not in ["messages", "system", "tools", "metadata"]} for request in record["requests"]]
    tools = [[tool["name"] for tool in request["body"].get("tools", [])] for request in record["requests"]]
    schemas = [{tool["name"]: tool.get("input_schema", {}) for tool in request["body"].get("tools", [])} for request in record["requests"]]
    return {"artifact": str(path.relative_to(REPO)), "sha256": sha(data), "isolation": record["isolation"]["passed"],
            "runtime_snapshot_sha256": sha(json.dumps(record["runtime"], sort_keys=True).encode()), "exit": result["exit_code"],
            "timeout": result["timed_out"], "limited": result["output_limited"], "requests": len(record["requests"]),
            "text": output.get("result"), "result_fields": sorted(output), "stderr_bytes": len(result["stderr"].encode()),
            "origins": sorted(record["lifecycle_by_origin"]), "calls": {key: value for key, value in record["tool_calls_by_origin"].items() if value},
            "errors": list(flags.values()), "tool_result_hashes": list(content.values()),
            "surviving_pids": record["fixture_pids_alive_after_group_cleanup"], "lifecycle": phases,
            "lifecycle_wire": wire, "request_parameters": parameters, "tools": tools, "schema": schemas,
            "skipped_original_flags": record.get("skipped_original_flags", [])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/mcp-scopes")
    parser.add_argument("--original-artifacts", type=Path)
    parser.add_argument("--tau-artifacts", type=Path)
    args = parser.parse_args()
    directory = args.artifacts.resolve()
    original_directory = args.original_artifacts.resolve() if args.original_artifacts else directory
    if args.tau_artifacts: directory = args.tau_artifacts.resolve()
    cases = {}
    for name in SCOPE_CASES:
        pair = {}
        for executable in ["original", "tau"]:
            path = (original_directory if executable == "original" else directory) / (executable + "-" + name + ".json")
            if path.exists(): pair[executable] = describe(path)
        if not pair: continue
        comparisons = {}
        parameter_differences = []
        if len(pair) == 2:
            left, right = pair["original"], pair["tau"]
            comparisons = {key: left[key] == right[key] for key in
                ["origins", "calls", "errors", "lifecycle", "requests", "exit", "text", "surviving_pids", "tools", "schema", "tool_result_hashes", "result_fields", "stderr_bytes", "lifecycle_wire", "request_parameters"]}
            comparisons["available_names"] = [sorted(tools) for tools in left["tools"]] == [sorted(tools) for tools in right["tools"]]
            parameter_differences = [field_differences(a, b) for a, b in zip(left["request_parameters"], right["request_parameters"])]
        cases[name] = {**pair, "comparisons": comparisons, "request_parameter_differences": parameter_differences}
    selected = ["origins", "calls", "errors", "lifecycle", "requests", "exit", "text", "surviving_pids", "available_names"]
    compared = [case for case in cases.values() if "original" in case and "tau" in case]
    complete = len(compared) == len(SCOPE_CASES)
    equal = bool(compared) and all(all(case["comparisons"][key] for key in selected) and
        all(case[side]["isolation"] and not case[side]["timeout"] and not case[side]["limited"] and not case[side]["surviving_pids"] for side in ["original", "tau"]) for case in compared)
    report = {"format_version": 1, "cases": cases, "selected_observables": selected, "complete_pair_set": complete,
              "all_compared_selected_observables_equal": equal,
              "limits": "Owned local scopes only; fixed host administrator paths excluded. Exact request/tool/stdio framing differences retained."}
    (directory / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    compact = {key: report[key] for key in ["format_version", "selected_observables", "complete_pair_set", "all_compared_selected_observables_equal", "limits"]}
    prefix = json.dumps(compact, indent=2).rstrip()[:-1]
    lines = [prefix + ',\n  "cases": {']
    entries = list(cases.items())
    for index, (name, case) in enumerate(entries):
        row = {side: {key: case[side][key] for key in ["sha256", "isolation", "origins", "calls", "errors", "lifecycle", "requests", "exit", "text", "surviving_pids"]}
               for side in ["original", "tau"] if side in case}
        row["comparisons"] = case["comparisons"]
        lines.append("    " + json.dumps(name) + ": " + json.dumps(row) + ("," if index < len(entries)-1 else ""))
    lines.append("  }\n}\n")
    (directory / "compact-comparison.json").write_text("\n".join(lines))
    print(json.dumps({"artifact": str(directory / "compact-comparison.json"), "cases": len(cases), "compared": len(compared),
                      "complete_pair_set": complete, "all_compared_selected_observables_equal": equal,
                      "mismatches": [name for name, case in cases.items() if case["comparisons"] and any(not case["comparisons"][key] for key in selected)]}))


if __name__ == "__main__": main()
