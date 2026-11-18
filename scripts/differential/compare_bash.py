#!/usr/bin/env python3
"""Compare original and tau Bash captures from run_bash.py.

Normalized: the disposable root, background task ids, session ids, and the
original's trailing <total_tokens> reminder (owned by the system-prompt lane).
The Bash description is compared after one declared gate: the original runs
with embedded find/grep (RI() true), tau has Glob/Grep tools instead.
"""
import json
import re
import sys
from pathlib import Path

from isolation import REPO
from scenarios_bash import STEPS

DIRECTORY = REPO / "artifacts/differential-pass/bash"
TOKENS = re.compile(r"\n\n<system-reminder>\n<total_tokens>[^<]*</total_tokens>\n</system-reminder>$")
EMBEDDED = [
    ("Avoid using this tool to run `cat`, `head`,", "Avoid using this tool to run `find`, `grep`, `cat`, `head`,"),
    ("\n - Read files: Use Read (NOT cat/head/tail)",
     "\n - File search: Use Glob (NOT find or ls)\n - Content search: Use Grep (NOT grep or rg)\n - Read files: Use Read (NOT cat/head/tail)"),
    ("\n - When running `find`, search from `.` (or a specific path), not `/` \u2014 scanning the full filesystem can exhaust system resources on large trees.", ""),
    ("\n - When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` \u2014 the second form silently skips `.tsx` files.", ""),
]


def load(executable):
    return json.loads((DIRECTORY / f"{executable}-bash.json").read_text())


def normalizer(record):
    root = record["root"]
    def norm(text):
        text = text.replace(root, "ROOT")
        text = re.sub(r"\bb[0-9a-z]{8}\b", "TASK", text)
        text = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "SESSION", text)
        return TOKENS.sub("", text)
    return norm


def generations(record):
    return [r for r in record["requests"] if r["path"].split("?")[0] == "/v1/messages"]


def bash_definition(record):
    for request in generations(record):
        for tool in request["body"].get("tools") or []:
            if tool.get("name") == "Bash":
                return tool
    return None


def text(content):
    if isinstance(content, list):
        return "".join(block.get("text", "") for block in content if isinstance(block, dict))
    return content or ""


def step_results(record):
    norm = normalizer(record)
    out = {}
    for request in generations(record):
        for message in request["body"].get("messages", []):
            for block in message["content"] if isinstance(message["content"], list) else []:
                if block.get("type") == "tool_result" and block.get("tool_use_id", "").startswith("bash-step-"):
                    out[block["tool_use_id"]] = {"content": norm(text(block.get("content"))), "is_error": bool(block.get("is_error"))}
    return out


def notification(record):
    norm = normalizer(record)
    for request in generations(record):
        if request.get("kind") == "notified":
            last = request["body"]["messages"][-1]
            return norm(text(last["content"]) if isinstance(last["content"], list) else last["content"])
    return None


def main():
    original, tau = load("original"), load("tau")
    rows = []
    o_def, t_def = bash_definition(original), bash_definition(tau)
    rows.append(("definition.input_schema", "same" if o_def and t_def and o_def["input_schema"] == t_def["input_schema"] else "diff", "", ""))
    expected = o_def["description"] if o_def else ""
    for before, after in EMBEDDED:
        expected = expected.replace(before, after, 1)
    t_desc = t_def["description"] if t_def else ""
    rows.append(("definition.description", "same" if o_def and t_desc == o_def["description"] else
                 "same-modulo-embedded-search-gate" if o_def and t_desc == expected else "diff", len(expected), len(t_desc)))
    o_steps, t_steps = step_results(original), step_results(tau)
    for index, step in enumerate(STEPS, 1):
        key = f"bash-step-{index}"
        a, b = o_steps.get(key), t_steps.get(key)
        rows.append((f"{key} {json.dumps(step)}", "same" if a == b and a is not None else "diff", json.dumps(a)[:400], json.dumps(b)[:400]))
    a, b = notification(original), notification(tau)
    rows.append(("notification", "same" if a == b and a is not None else "diff", json.dumps(a)[:900], json.dumps(b)[:900]))
    o_out = sorted(normalizer(original)(v) for v in original["task_outputs"].values())
    t_out = sorted(normalizer(tau)(v) for v in tau["task_outputs"].values())
    rows.append(("task_outputs", "same" if o_out == t_out else "diff", json.dumps(o_out)[:300], json.dumps(t_out)[:300]))
    rows.append(("request_kinds", "same" if [r.get("kind") for r in original["requests"]] == [r.get("kind") for r in tau["requests"]] else "diff",
                 json.dumps([r.get("kind") for r in original["requests"]]), json.dumps([r.get("kind") for r in tau["requests"]])))
    for row in rows:
        print("\t".join(map(str, row)))
    differences = [r for r in rows if r[1] not in ("same", "same-modulo-embedded-search-gate")]
    (DIRECTORY / "compare-bash.json").write_text(json.dumps({"rows": rows, "differences": len(differences)}, indent=1) + "\n")
    return 1 if differences else 0


if __name__ == "__main__":
    sys.exit(main())
