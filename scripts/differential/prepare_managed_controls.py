#!/usr/bin/env python3
"""Prepare administrator/parent merge controls without launching either CLI.

The pinned macOS original has no injected filesystem managed root. These inputs
are readiness fixtures, never evidence that its administrator tiers were run.
"""
import hashlib
import json
from pathlib import Path
from isolation import REPO, verified_isolation


def main():
    artifacts = REPO / "artifacts/differential-pass/managed-file-readiness"
    controls = {}
    with verified_isolation(artifacts) as isolation:
        for mode in ["first-wins", "merge"]:
            directory = isolation.root / "managed-fixtures" / mode
            directory.mkdir(parents=True)
            administrator = {"permissions": {"allow": ["Read", "Edit"], "deny": ["Write"]}}
            if mode == "merge": administrator["parentSettingsBehavior"] = "merge"
            parent = {"permissions": {"deny": ["Edit"], "allow": ["Write"]}}
            inputs = {"managed-settings.json": administrator, "parent-settings.json": parent}
            proofs = {}
            for name, document in inputs.items():
                text = json.dumps(document, indent=2) + "\n"
                path = directory / name
                path.write_text(text)
                result = isolation.sandbox(["/bin/cat", str(path)])
                if result["exit_code"] != 0 or result["stdout"] != text or result["timed_out"]:
                    raise RuntimeError("Disposable fixture read failed")
                proofs[name] = {"sha256": hashlib.sha256(text.encode()).hexdigest(), "sandbox_read_passed": True}
            controls[mode] = {"documents": inputs, "proofs": proofs}
        report = {"original_executed": False, "tau_cli_executed": False, "isolation": isolation.report,
                  "controls": controls, "runtime_administrator_tiers_exercised": False,
                  "blocked_by_target_design": "Pinned macOS YS() returns /Library/Application Support/ClaudeCode; yEi() is an empty override stub. No managed-root injection found.",
                  "constraint": "Approved profile unchanged. No host administrator policy path read or written. No filesystem remapping attempted.",
                  "next_validation": "Source-backed unit composition only, unless a supported disposable managed-root mechanism becomes available."}
        (artifacts / "readiness.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"artifact": str(artifacts / "readiness.json"), "controls": len(controls),
                          "original_executed": False, "runtime_administrator_tiers_exercised": False}))


if __name__ == "__main__": main()
