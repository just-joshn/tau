#!/usr/bin/env python3
"""Layered settings/instruction observation in freshly verified dummy isolation."""
import argparse
import json
from pathlib import Path
import subprocess
from isolation import REPO, TARGET_SHA256, verified_isolation
from mock_api import MockState
from settings_fixture import MODELS, install, marker, marker_hits
from run_tau import copy_runtime

CASES = ["all", "user", "project", "local", "none", "inline", "read-deny", "flag-allow", "project-cli-allow", "file", "cli-model", "env-model", "env-file", "env-cli-model", "resume", "resume-off", "eager-state", "managed-inline", "managed-clean-allow", "managed-clean-deny", "managed-empty"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=CASES)
    parser.add_argument("--executable", choices=["original", "tau"], default="original")
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/settings")
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    state = MockState("eager-instructions" if args.case == "eager-state" else "settings")
    with verified_isolation(artifacts, state.handler()) as isolation:
        env_overrides = {}
        if args.case in ["env-model", "env-file", "env-cli-model"]:
            # A new dummy model value only; no inherited host environment.
            env_overrides["ANTHROPIC_MODEL"] = MODELS["user"]
            isolation.env.update(env_overrides)
        files = install(isolation.root)
        if args.case == "eager-state":
            for relative in ["config/settings.json", "work/.claude/settings.json", "work/.claude/settings.local.json"]:
                document = json.loads(files[relative])
                document["permissions"] = {"allow": ["Read", "Edit", "Write"]}
                files[relative] = json.dumps(document, indent=2) + "\n"
                (isolation.root / relative).write_text(files[relative])
        runtime = None
        probe = None
        if args.executable == "original":
            target = isolation.copy_target(Path("/Users/josh-desktop/.local/bin/claude"))
            command = [str(target)]
        else:
            node, entry, runtime = copy_runtime(isolation.root)
            probe = isolation.sandbox([str(node), "-e", 'process.stdout.write("disposable-node-ready")'])
            if probe["exit_code"] != 0 or probe["stdout"] != "disposable-node-ready":
                raise RuntimeError("Copied Node bootstrap failed")
            command = [str(node), "--preserve-symlinks", "--preserve-symlinks-main", str(entry)]
        arguments = ["--print", "TAU_DIFFERENTIAL_SETTINGS", "--output-format", "json", "--tools", "Read,Edit,Write",
                     "--append-system-prompt", marker("CLI_SYSTEM")]
        if args.case in ["user", "project", "local", "none"]:
            arguments += ["--setting-sources", "" if args.case == "none" else args.case]
        if args.case == "inline":
            arguments += ["--setting-sources", "", "--settings", json.dumps({"model": MODELS["flag"], "permissions": {"deny": ["Read"], "allow": ["Edit", "Write"]}})]
        if args.case == "flag-allow":
            arguments += ["--setting-sources", "", "--settings", json.dumps({"model": MODELS["flag"], "permissions": {"allow": ["Edit", "Write"]}})]
        if args.case == "read-deny":
            arguments += ["--settings", json.dumps({"permissions": {"deny": ["Read"], "allow": ["Read"]}})]
        if args.case == "managed-inline":
            # Synthetic SDK-parent tier only. No host policy files or identity.
            arguments += ["--managed-settings", json.dumps({"model": MODELS["flag"], "claudeMd": marker("MANAGED_INLINE"),
                           "permissions": {"deny": ["Read"], "allow": ["Read", "Write"]}})]
        if args.case in ["managed-clean-allow", "managed-clean-deny", "managed-empty"]:
            permission = {"allow": ["Edit", "Write"]} if args.case == "managed-clean-allow" else {"deny": ["Read"]}
            parent = {"model": MODELS["flag"], "claudeMd": marker("MANAGED_INLINE")}
            if args.case != "managed-empty": parent["permissions"] = permission
            arguments += ["--setting-sources", "", "--managed-settings", json.dumps(parent)]
        if args.case == "project-cli-allow":
            arguments += ["--setting-sources", "project", "--allowedTools", "Write"]
        if args.case == "eager-state": arguments += ["--allowedTools", "Edit,Write"]
        if args.case in ["file", "cli-model", "env-file"]:
            arguments += ["--settings", str(isolation.root / "flag-settings.json")]
        if args.case == "cli-model": arguments += ["--model", MODELS["cli"]]
        if args.case == "env-cli-model": arguments += ["--model", MODELS["cli"]]
        skipped_flags = []
        if args.case not in ["resume", "resume-off"]:
            if args.executable == "original": arguments.append("--no-session-persistence")
            else: skipped_flags.append("--no-session-persistence")
        if args.case == "resume-off": arguments += ["--system-prompt-snapshot", "off"]
        result = isolation.sandbox([*command, *arguments])
        stages = [{"version": 1, "arguments": arguments, "result": result, "request_start": 0, "request_end": len(state.requests)}]
        fixtures = [{"version": 1, "files": files}]
        if args.case in ["resume", "resume-off"] and result["exit_code"] == 0:
            session_id = json.loads(result["stdout"])["session_id"]
            fixtures.append({"version": 2, "files": install(isolation.root, version=2)})
            start = len(state.requests)
            resumed_args = ["--resume", session_id, "--print", "TAU_DIFFERENTIAL_SETTINGS_RESUME", "--output-format", "json",
                            "--tools", "Read,Edit,Write", "--append-system-prompt", marker("CLI_SYSTEM", 2)]
            if args.case == "resume-off": resumed_args += ["--system-prompt-snapshot", "off"]
            resumed = isolation.sandbox([*command, *resumed_args])
            stages.append({"version": 2, "arguments": resumed_args, "result": resumed, "request_start": start, "request_end": len(state.requests)})
        observations = [{"request": index, "model": request["body"].get("model"),
                         "markers_v1": marker_hits(request["body"], 1), "markers_v2": marker_hits(request["body"], 2)}
                        for index, request in enumerate(state.requests)]
        record = {"case": args.case, "executable": args.executable, "target_sha256": TARGET_SHA256 if args.executable == "original" else None, "isolation": isolation.report,
                  "runtime": runtime, "runtime_probe": probe, "skipped_original_flags": skipped_flags,
                  "dummy_environment_overrides_after_canary": env_overrides,
                  "response_model_policy": "mirror each request model",
                  "fixtures": fixtures, "stages": stages, "requests": state.requests, "observations": observations,
                  "final_files": {relative: (isolation.root / "work" / relative).read_text()
                                  for relative in ["nested/a.txt", "nested/new.txt", "CLAUDE.md", ".claude/CLAUDE.md", "nested/CLAUDE.md", "nested/.claude/CLAUDE.md"]
                                  if (isolation.root / "work" / relative).exists()}}
        (artifacts / (args.executable + "-" + args.case + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        for index, stage in enumerate(stages):
            for stream in ["stdout", "stderr"]:
                (artifacts / (args.executable + "-" + args.case + "-" + str(index+1) + "." + stream + ".txt")).write_text(stage["result"][stream])
        kernel = subprocess.run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate",
                                 'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifacts / (args.executable + "-" + args.case + ".denials.txt")).write_text(kernel.stdout)
        print(json.dumps({"case": args.case, "executable": args.executable, "exits": [s["result"]["exit_code"] for s in stages], "requests": len(state.requests),
                          "models": [o["model"] for o in observations], "first_markers": sorted(observations[0]["markers_v1"]) if observations else [],
                          "final_files": record["final_files"]}))


if __name__ == "__main__": main()
