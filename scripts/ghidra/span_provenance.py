#!/usr/bin/env python3
"""Batch Ghidra byte provenance for recovered-JavaScript spans a port cites.

Input JSON: [{"label": str, "module": "chunk-xxxx.js", "needle": str}] or
{"label", "module", "start": int, "end": int} with module byte offsets. A needle
must occur exactly once in its module; the span runs from the needle's first byte
for "length" bytes (default: the needle itself).

Every span is located inside the pinned executable through its whole module,
split into parts of at most 8192 bytes, written to manifests of at most 64 rows,
and checked against the imported Ghidra program with InspectEmbeddedSpans.java,
one headless batch at a time. The output directory receives the manifests,
reports, and results.json. Recovered code is data only; nothing is executed.
"""
import argparse
import hashlib
import json
import mmap
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = Path.home() / ".local/share/claude/versions/2.1.326"
SHA = "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837"
BUNDLE = ROOT / "artifacts/claude-bundle"
RUN = ROOT / "artifacts/ghidra/run.FXQI6l"
TOOL = ROOT / "artifacts/ghidra/tool"
PART, BATCH = 8192, 64


def sha(data):
    return hashlib.sha256(data).hexdigest()


def locate(specs):
    with TARGET.open("rb") as f:
        assert hashlib.file_digest(f, "sha256").hexdigest() == SHA, "pinned target changed"
    rows, modules = [], {}
    with TARGET.open("rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as binary:
        for spec in specs:
            name = spec["module"]
            if name not in modules:
                data = (BUNDLE / name).read_bytes()
                base = binary.find(data)
                assert base >= 0, f"{name} not embedded whole in the target"
                modules[name] = (data, base)
            data, base = modules[name]
            if "needle" in spec:
                needle = spec["needle"].encode()
                start = data.find(needle)
                assert start >= 0 and data.find(needle, start + 1) < 0, f"{spec['label']}: needle not unique in {name}"
                end = start + spec.get("length", len(needle))
            else:
                start, end = spec["start"], spec["end"]
            assert 0 <= start < end <= len(data)
            for part, cursor in enumerate(range(start, end, PART)):
                piece = data[cursor:min(end, cursor + PART)]
                label = f"{spec['label']}_{part:02d}"
                assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", label), label
                rows.append((label, base + cursor, len(piece), sha(piece), name, cursor))
    return rows, {n: {"offset": b, "bytes": len(d), "sha256": sha(d)} for n, (d, b) in modules.items()}


def run_batches(rows, out):
    env = {**os.environ, "GHIDRA_HOME": str(TOOL), "GHIDRA_HEADLESS_MAXMEM": "4G",
           "_JAVA_OPTIONS": f"-Duser.home={RUN}/home -Djava.io.tmpdir={RUN}/tmp"}
    results = []
    for i, start in enumerate(range(0, len(rows), BATCH), 1):
        assert shutil.disk_usage(ROOT).free >= 1024**3, "need 1 GiB free"
        procs = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True, check=True).stdout
        assert "AnalyzeHeadless" not in procs and "analyzeHeadless" not in procs, "another headless Ghidra is active"
        batch = rows[start:start + BATCH]
        manifest, report = out / f"spans-{i}.tsv", out / f"spans-{i}.txt"
        manifest.write_text("sha256\t" + SHA + "\n" + "".join(f"{l}\t{o}\t{n}\t{d}\n" for l, o, n, d, *_ in batch))
        args = [str(TOOL / "support/analyzeHeadless"), str(RUN), "Timing", "-process", "2.1.326", "-noanalysis",
                "-max-cpu", "2", "-scriptPath", str(ROOT / "scripts/ghidra"), "-postScript", "InspectEmbeddedSpans.java",
                str(manifest), str(report), "-log", str(out / f"headless-{i}.log"), "-scriptlog", str(out / f"script-{i}.log")]
        began = time.time()
        with (out / f"console-{i}.txt").open("w") as log:
            subprocess.run(args, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        lines = report.read_text().splitlines()
        complete = f"COMPLETE requested={len(batch)} matched={len(batch)} failed=0"
        assert lines[0] == "SHA256 " + SHA and lines[-1] == complete, lines[-1]
        expected = {l: (o, n, d) for l, o, n, d, *_ in batch}
        matched = set()
        for line in lines:
            m = re.fullmatch(r"(\S+) file=(\d+) preferred=\S+ bytes=(\d+) sha256=([a-f0-9]{64}) equal=true", line)
            if m:
                assert expected[m[1]] == (int(m[2]), int(m[3]), m[4]); matched.add(m[1])
        assert matched == set(expected)
        results.append({"batch": i, "count": len(batch), "complete": complete, "seconds": round(time.time() - began, 2)})
        print(complete, f"batch={i}", flush=True)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spans", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--locate-only", action="store_true")
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    assert not (out / "results.json").exists(), "refusing to overwrite a completed run"
    rows, modules = locate(json.loads(args.spans.read_text()))
    (out / "located.json").write_text(json.dumps({"target_sha256": SHA, "modules": modules, "spans": [
        {"label": l, "file_offset": o, "bytes": n, "sha256": d, "module": m, "module_offset": c} for l, o, n, d, m, c in rows]}, indent=1) + "\n")
    print(f"located {len(rows)} span parts in {len(modules)} modules", flush=True)
    if args.locate_only:
        return
    results = run_batches(rows, out)
    (out / "results.json").write_text(json.dumps({"target_sha256": SHA, "original_executed": False, "all_complete": True,
        "matched": sum(r["count"] for r in results), "failed": 0, "batches": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()
