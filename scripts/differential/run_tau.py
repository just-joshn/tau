#!/usr/bin/env python3
"""Run the built TypeScript port in the same freshly verified disposable profile.

Copies only the Node executable, compiled source and recursively enumerated public
runtime packages. Never grants sandbox access to the checkout or the host home.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from isolation import REPO, clone_file, verified_isolation
from mock_api import MODEL, SCENARIOS, MockState


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def copy_runtime(root):
    node_source = Path(shutil.which("node")).resolve()
    node = root / "bin/node"
    clone_file(node_source, node)
    node.chmod(0o700)
    if digest(node) != digest(node_source):
        raise RuntimeError("Node copy hash mismatch")
    destination = root / "tau"
    destination.mkdir()
    shutil.copytree(REPO / "dist/src", destination / "src", copy_function=clone_file)
    (destination / "package.json").write_text('{"type":"module"}\n')
    dependencies = json.loads((REPO / "package.json").read_text())["dependencies"]
    copied = {}
    pending = list(dependencies)
    while pending:
        name = pending.pop()
        if name in copied:
            continue
        source = REPO / "node_modules" / name
        manifest = json.loads((source / "package.json").read_text())
        copied[name] = manifest["version"]
        # Reject symlinks rather than inadvertently exposing host paths.
        if any(path.is_symlink() for path in source.rglob("*")):
            raise RuntimeError("Unexpected symlink in runtime package " + name)
        shutil.copytree(source, destination / "node_modules" / name, copy_function=clone_file)
        pending.extend(manifest.get("dependencies", {}))
    files = sorted((destination / "src").rglob("*.js"))
    return node, destination / "src/cli.js", {"copy_method": "APFS cp -c; distinct inode and full SHA-256 verified per file", "node_sha256": digest(node), "packages": copied,
            "compiled_files": {str(p.relative_to(destination)): digest(p) for p in files}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=SCENARIOS)
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass")
    parser.add_argument("--sse-framing", choices=["named", "data-only"], default="named")
    args = parser.parse_args()
    artifact_dir = args.artifacts.resolve()
    state = MockState(args.scenario, args.sse_framing)
    with verified_isolation(artifact_dir, state.handler()) as isolation:
        node, entry, runtime = copy_runtime(isolation.root)
        probe = isolation.sandbox([str(node), "-e", 'process.stdout.write("disposable-node-ready")'])
        (artifact_dir / "tau-runtime-probe.json").write_text(json.dumps(probe, indent=2) + "\n")
        if probe["exit_code"] != 0 or probe["stdout"] != "disposable-node-ready" or probe["timed_out"]:
            raise RuntimeError("Copied Node runtime failed unchanged sandbox profile")
        (isolation.root / "work/a.txt").write_text("alpha\n")
        # Record original-only flag differences explicitly; no bare/session flags
        # are silently pretended to be implemented in tau.
        arguments = ["--print", "TAU_DIFFERENTIAL_" + args.scenario.upper(), "--model", MODEL,
                     "--output-format", "json", "--dangerously-skip-permissions", "--tools", "Read,Edit,Write"]
        # Node's resolver otherwise lstats every host path ancestor. Preserve the
        # copied absolute module paths; do not expand the filesystem profile.
        result = isolation.sandbox([str(node), "--preserve-symlinks", "--preserve-symlinks-main", str(entry), *arguments])
        record = {"scenario": args.scenario, "sse_framing": args.sse_framing, "mode": "tau-current", "original_executed": False,
                  "isolation": isolation.report, "runtime": runtime, "runtime_probe": probe,
                  "arguments": arguments, "original_only_flags": ["--bare", "--no-session-persistence"],
                  "result": result, "requests": state.requests,
                  "final_file": (isolation.root / "work/a.txt").read_text()}
        (artifact_dir / ("tau-" + args.scenario + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        for stream in ["stdout", "stderr"]:
            (artifact_dir / ("tau-" + args.scenario + "." + stream + ".txt")).write_text(result[stream])
        logs = subprocess.run(["/usr/bin/log", "show", "--last", "2m", "--style", "compact", "--predicate",
                               'eventMessage CONTAINS "' + isolation.tag + '"'], capture_output=True, text=True, timeout=10)
        (artifact_dir / ("tau-" + args.scenario + ".denials.txt")).write_text(logs.stdout)
        print(json.dumps({"scenario": args.scenario, "isolation_passed": isolation.verified,
                          "exit_code": result["exit_code"], "requests": len(state.requests), "final_file": record["final_file"],
                          "timed_out": result["timed_out"], "stderr_tail": result["stderr"][-800:]}))


if __name__ == "__main__":
    main()
