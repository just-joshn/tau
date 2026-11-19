#!/usr/bin/env python3
"""Compact marker/provenance observations; never copy original system prompts."""
import hashlib
import json
from pathlib import Path
from isolation import REPO
from run_settings import CASES
from settings_fixture import marker, MARKER_NAMES, MODELS

DIRECTORY = REPO / "artifacts/differential-pass/settings"


def error_class(block):
    if not block.get("is_error"): return "ok"
    text = str(block.get("content", ""))
    if "No such tool available" in text: return "unavailable"
    if "covered by a Read deny rule" in text: return "read-rule"
    if "not been read yet" in text: return "read-precondition"
    if "requested permissions" in text or "requires permission" in text: return "approval"
    return "other-error"


def describe(path):
    raw = path.read_bytes()
    record = json.loads(raw)
    seen = {}
    for index, request in enumerate(record["requests"]):
        for message in request["body"].get("messages", []):
            content = message.get("content", [])
            if not isinstance(content, list): continue
            for block in content:
                if block.get("type") == "tool_result":
                    seen.setdefault(block["tool_use_id"], {"request": index, "class": error_class(block)})
    stages = []
    for stage in record["stages"]:
        start, end, version = stage["request_start"], stage["request_end"], stage["version"]
        observations = record["observations"][start:end]
        initial = observations[0]["markers_v" + str(version)] if observations else {}
        first = {}
        for relative, observation in enumerate(observations):
            for name in observation["markers_v" + str(version)]: first.setdefault(name, relative)
        system_versions = [v for v in [1, 2] if observations and "CLI_SYSTEM" in observations[0]["markers_v" + str(v)]]
        # Exact pointers and marker-version locations remain in the hashed raw record.
        result = stage["result"]
        try: text = json.loads(result["stdout"]).get("result")
        except ValueError: text = None
        expected_count = 6 if record["case"] == "eager-state" else 4
        expected_text = "eager workflow done" if record["case"] == "eager-state" else "settings workflow done"
        stages.append({"version": version, "requests": end-start,
            "models": ",".join(dict.fromkeys(o["model"] for o in observations)),
            "tools": ",".join(t["name"] for t in record["requests"][start]["body"].get("tools", [])) if observations else "",
            "initial_markers": ",".join(initial),
            "late_markers": ",".join(name + "@" + str(index) for name, index in first.items() if index > 0),
            "system_marker_versions": ",".join(str(v) for v in system_versions),
            "tool_outcomes": ",".join(block["class"] for block in seen.values() if start <= block["request"] < end),
            "complete": result["exit_code"] == 0 and not result["timed_out"] and not result["output_limited"] and end-start == expected_count and text == expected_text})
    changed = [relative for relative, text in record["final_files"].items() if relative.endswith(".md") and
               record["fixtures"][0]["files"].get("work/" + relative) != text]
    return {"sha256": hashlib.sha256(raw).hexdigest(), "isolation_passed": record["isolation"]["passed"],
            "profile_sha256": hashlib.sha256(record["isolation"]["profile"].encode()).hexdigest(),
            "stages": stages,
            "final_data_files": {key: value for key, value in record["final_files"].items() if key.endswith(".txt")},
            "changed_instruction_files": ",".join(changed)}


def main():
    cases = {}
    for case in CASES:
        path = DIRECTORY / ("original-" + case + ".json")
        if path.exists(): cases[case] = describe(path)
    first = json.loads((DIRECTORY / "original-all.json").read_text())
    origins = {}
    for name in MARKER_NAMES:
        origins[name] = next((path for path, text in first["fixtures"][0]["files"].items() if marker(name) in text),
                             "--managed-settings.claudeMd" if name == "MANAGED_INLINE" else "--append-system-prompt")
    summary = {"format_version": 1, "scope": "Original-only dummy layered settings and instruction workflows",
        "artifacts": "Each case maps to original-CASE.json in this directory; exact marker JSON pointers, fixtures and full canaries embedded there.",
        "cases": cases, "all_executions_complete": all(s["complete"] and c["isolation_passed"] for c in cases.values() for s in c["stages"]),
        "model_fixture_values": MODELS, "marker_origins": origins,
        "provenance": {"eager_instructions": "First user-context message", "late_instructions": "Read tool-result text on the following request", "CLI_SYSTEM": "System block"},
        "all_case_canaries": first["isolation"]["checks"],
        "limits": "Fresh untrusted print workspaces, dummy local configuration and synthetic SDK-parent managed inline tier only. No real administrator policy composition or interactive trust UI exercised."}
    path = DIRECTORY / "checkpoint.json"
    path.write_text(json.dumps(summary, indent=2) + "\n")
    compact_cases = {}
    aliases = {value: key for key, value in MODELS.items()}
    def mask(names):
        return hex(sum(1 << MARKER_NAMES.index(name) for name in names if name))
    for name, case in cases.items():
        stages = []
        for stage in case["stages"]:
            late = {}
            for entry in filter(None, stage["late_markers"].split(",")):
                label, request = entry.split("@")
                late.setdefault(request, []).append(label)
            stages.append({"v": stage["version"], "requests": stage["requests"], "model": aliases.get(stage["models"], stage["models"]),
                "tools": stage["tools"], "initial_mask": mask(stage["initial_markers"].split(",")),
                "late_masks_by_request": {key: mask(value) for key, value in late.items()},
                "system_v": stage["system_marker_versions"], "outcomes": stage["tool_outcomes"], "complete": stage["complete"]})
        compact_cases[name] = {"sha256": case["sha256"], "isolation": case["isolation_passed"], "stages": stages,
                               "data_files": case["final_data_files"], "changed_instructions": case["changed_instruction_files"]}
    # Keep each case on one line while retaining ordinary machine-readable JSON.
    compact = {"format_version": 1, "scope": summary["scope"], "case_artifacts": "original-CASE.json under this directory",
               "marker_bits_in_order": MARKER_NAMES, "models": MODELS, "all_executions_complete": summary["all_executions_complete"],
               "full_provenance_and_canaries": "checkpoint.json and each hashed raw record; no original prompts copied into compact report"}
    prefix = json.dumps(compact, indent=2).rstrip()[:-1]
    lines = [prefix + ',\n  "cases": {']
    entries = list(compact_cases.items())
    for index, (name, case) in enumerate(entries):
        lines.append("    " + json.dumps(name) + ": " + json.dumps(case) + ("," if index < len(entries)-1 else ""))
    lines.append("  }\n}\n")
    (DIRECTORY / "compact-checkpoint.json").write_text("\n".join(lines))
    print(json.dumps({"artifact": str(path), "cases": len(cases), "all_executions_complete": summary["all_executions_complete"]}))


if __name__ == "__main__": main()
