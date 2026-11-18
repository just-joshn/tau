#!/usr/bin/env python3
"""Compare original and tau Monitor/worktree captures from run_monitor_worktree.py.

The disposable root, task ids and output-file paths are normalized. Rows: each planned
tool's result, then each task notification in arrival order and the request it arrived
on. The deferred-tools listing and the tool schemas sent after ToolSearch also compare.
"""
import json
import re
import sys

from isolation import REPO

DIRECTORY = REPO / "artifacts/differential-pass/monitor-worktree"


def load(executable, variant):
    return json.loads((DIRECTORY / f"{executable}-{variant}.json").read_text())


def norm(record, value):
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    text = text.replace(record["root"], "ROOT").replace("/private" + record["root"], "ROOT")
    text = re.sub(r"\bb[0-9a-z]{8}\b", "TASK", text)
    return re.sub(r"<output-file>[^<]*</output-file>", "<output-file>OUT</output-file>", text)


def blocks(message):
    content = message.get("content")
    return content if isinstance(content, list) else [{"type": "text", "text": content or ""}]


def results(record):
    last = record["requests"][-1]["body"]["messages"]
    return {block["tool_use_id"]: norm(record, block.get("content")) for m in last for block in blocks(m)
            if isinstance(block, dict) and block.get("type") == "tool_result"}


def notifications(record):
    seen, out = set(), []
    for index, request in enumerate(record["requests"]):
        for message in request["body"].get("messages", []):
            for block in blocks(message):
                text = block.get("text", "") if isinstance(block, dict) else ""
                if "<task-notification>" in text and text not in seen:
                    seen.add(text)
                    out.append((index, norm(record, text)))
    return out


def schemas(record, names):
    for request in record["requests"]:
        tools = {tool.get("name"): tool for tool in request["body"].get("tools") or []}
        if all(name in tools for name in names):
            return {name: norm(record, {key: tools[name].get(key) for key in ["description", "input_schema"]}) for name in names}
    return None


def main(variant="monitor"):
    original, tau = load("original", variant), load("tau", variant)
    rows = []
    a, b = results(original), results(tau)
    for step in sorted(set(a) | set(b), key=lambda s: int(s.split("-")[-1])):
        rows.append((f"result {step}", "same" if a.get(step) == b.get(step) else "diff", (a.get(step) or "")[:200], (b.get(step) or "")[:200]))
    na, nb = notifications(original), notifications(tau)
    for index in range(max(len(na), len(nb))):
        x = na[index] if index < len(na) else (None, "")
        y = nb[index] if index < len(nb) else (None, "")
        rows.append((f"notification {index + 1} (requests {x[0]}/{y[0]})", "same" if x[1] == y[1] else "diff", x[1][-240:], y[1][-240:]))
    names = ["Monitor"] if variant == "monitor" else ["EnterWorktree", "ExitWorktree"]
    sa, sb = schemas(original, names), schemas(tau, names)
    for name in names:
        x, y = (sa or {}).get(name), (sb or {}).get(name)
        rows.append((f"schema {name}", "same" if x == y and x is not None else "diff", (x or "missing")[:160], (y or "missing")[:160]))
    for row in rows: print("\t".join(map(str, row)))
    differences = [r for r in rows if r[1] != "same"]
    (DIRECTORY / f"compare-{variant}.json").write_text(json.dumps({"rows": rows, "differences": len(differences)}, indent=1) + "\n")
    return 1 if differences else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
