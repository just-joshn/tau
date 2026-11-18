#!/usr/bin/env python3
"""Compare original and tau WebFetch/WebSearch captures from run_web.py.

Ports are normalized. Main-loop request shape (system prompt, catalog) is out of
scope here; only the web side queries and the model-visible tool results compare.
"""
import json
import re
import sys
from pathlib import Path

from isolation import REPO

DIRECTORY = REPO / "artifacts/differential-pass/web"
SHARED_SYSTEM = 2  # billing header + SDK identity blocks, owned by the system-prompt port


def load(executable, variant):
    return json.loads((DIRECTORY / f"{executable}-{variant}.json").read_text())


def norm(value):
    return re.sub(r":\d{4,5}/", ":PORT/", json.dumps(value, sort_keys=True))


def side(record, kind):
    bodies = [r["body"] for r in record["requests"] if r.get("kind") == kind]
    return bodies[0] if bodies else None


def tool_results(record):
    names, out = {}, []
    for message in record["requests"][-1]["body"]["messages"]:
        for block in message["content"] if isinstance(message["content"], list) else []:
            if block.get("type") == "tool_use": names[block["id"]] = block["name"]
            if block.get("type") == "tool_result" and names.get(block["tool_use_id"]) != "ToolSearch":
                out.append(norm(block["content"]))
    return out


def main(variant="web"):
    original, tau = load("original", variant), load("tau", variant)
    rows = []
    for kind in ["fetch-apply", "search"]:
        o, t = side(original, kind), side(tau, kind)
        if o is None or t is None:
            rows.append((kind, "missing", o is not None, t is not None)); continue
        for key in sorted(set(o) | set(t)):
            a, b = o.get(key), t.get(key)
            if key == "system" and isinstance(a, list):
                a = a[SHARED_SYSTEM:] or ""
                if isinstance(b, str) and len(a) == 1: a = a[0]["text"]
            rows.append((f"{kind}.{key}", "same" if norm(a) == norm(b) else "diff", norm(a)[:160], norm(b)[:160]))
    results = list(zip(tool_results(original), tool_results(tau)))
    rows.append(("tool_results", "same" if all(a == b for a, b in results) and len(results) == 3 else "diff", len(results), ""))
    rows.append(("page_paths", "same" if [h["path"] for h in original["page_hits"]] == [h["path"] for h in tau["page_hits"]] else "diff", "", ""))
    for row in rows: print("\t".join(map(str, row)))
    differences = [r for r in rows if r[1] != "same"]
    (DIRECTORY / f"compare-{variant}.json").write_text(json.dumps({"rows": rows, "differences": len(differences)}, indent=1) + "\n")
    return 1 if differences else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
