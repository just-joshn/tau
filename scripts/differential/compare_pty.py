#!/usr/bin/env python3
"""Compare original and tau PTY screens from run_pty.py, step by step.

Both screens are normalized first: product name and version, the disposable
workspace path, session ids, the loopback port, clock times and the
completion verb. Everything else counts, so a row that differs is a real
layout or content difference. Reports per-step row equality (rows equal /
screen rows) and the differing rows.

`--export-fixtures DIR` writes the original's raw screens for the steps the
render snapshot tests use (test/unit/tui-render.test.ts).
"""
import argparse
import json
import re
from pathlib import Path

from isolation import REPO
from pty_driver import ROWS

DIRECTORY = REPO / "artifacts/differential-pass/pty"
HEADER = re.compile(r"^=== (\S+) sent=.*? skipped=(True|False) cursor=.*$", re.M)
RULES = [
    (re.compile(r"(Claude Code|tau) v\d+\.\d+\.\d+"), "PRODUCT vVERSION"),
    (re.compile(r"^( ▝▝   ▝▝   ).*$", re.M), r"\1CWD"),
    (re.compile(r"\S*/(tau-differential|tau-pty)-\w+/work"), "CWD"),
    (re.compile(r"\b(2\.1\.326|0\.1\.0)\b"), "VERSION"),
    (re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"), "UUID"),
    (re.compile(r"http://127\.0\.0\.1:\d+"), "URL"),
    (re.compile(r"done \d{1,2}:\d{2} [AP]M"), "done TIME"),
    (re.compile(r"^✻ \S+ for \d+[hms]( \d+[hms])*", re.M), "✻ VERB for N"),
    (re.compile(r"^(claude|tau)( --model| --resume)", re.M), r"BIN\2"),
]
# Steps whose original screen the render snapshot tests reproduce.
FIXTURES = {
    "tour": ["ready", "text", "edit", "edit-approve", "help-typed", "model-close", "ctrl-c-1"],
    "edit-always": ["edit-always"],
    "edit-reject": ["edit-reject"],
}


def screens(path):
    text = path.read_text()
    marks = list(HEADER.finditer(text))
    result = {}
    for index, mark in enumerate(marks):
        end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
        if mark.group(2) == "True":
            continue
        result[mark.group(1)] = text[mark.end() + 1:end].removesuffix("\n\n")
    return result


def normalize(screen):
    for pattern, replacement in RULES:
        screen = pattern.sub(replacement, screen)
    return screen


def rows(screen):
    lines = screen.split("\n")
    return lines + [""] * (ROWS - len(lines))


def common(left, right):
    """Longest common subsequence of rows: content equality that ignores a vertical shift."""
    lengths = [[0] * (len(right) + 1) for _ in range(len(left) + 1)]
    for i, a in enumerate(left):
        for j, b in enumerate(right):
            lengths[i + 1][j + 1] = lengths[i][j] + 1 if a == b else max(lengths[i][j + 1], lengths[i + 1][j])
    return lengths[-1][-1]


def compare(original, tau):
    steps = []
    for name, screen in original.items():
        if name not in tau:
            steps.append({"step": name, "equal": 0, "rows": ROWS, "percent": 0.0, "content": 0.0, "missing": True})
            continue
        left, right = rows(normalize(screen)), rows(normalize(tau[name]))
        total = max(len(left), len(right))
        left, right = left + [""] * (total - len(left)), right + [""] * (total - len(right))
        diffs = [{"row": i, "original": a, "tau": b} for i, (a, b) in enumerate(zip(left, right)) if a != b]
        equal = total - len(diffs)
        steps.append({"step": name, "equal": equal, "rows": total, "percent": round(100 * equal / total, 1),
                      "content": round(100 * common(left, right) / total, 1), "differences": diffs})
    return steps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario")
    parser.add_argument("--setup", default="trusted")
    parser.add_argument("--artifacts", type=Path, default=DIRECTORY)
    parser.add_argument("--tau", help="tau screens file stem (default: tau-<scenario>-<setup>, else its -unsandboxed run)")
    parser.add_argument("--export-fixtures", type=Path)
    parser.add_argument("--json", action="store_true", help="print every differing row as JSON")
    args = parser.parse_args()
    original = screens(args.artifacts / f"original-{args.scenario}-{args.setup}.screens.txt")
    if args.export_fixtures:
        args.export_fixtures.mkdir(parents=True, exist_ok=True)
        for step in FIXTURES.get(args.scenario, []):
            (args.export_fixtures / f"{args.scenario}-{step}.txt").write_text(original[step] + "\n")
        return
    stem = args.tau or f"tau-{args.scenario}-{args.setup}"
    path = args.artifacts / f"{stem}.screens.txt"
    if not path.exists() and not args.tau:
        path = args.artifacts / f"{stem}-unsandboxed.screens.txt"
    steps = compare(original, screens(path))
    if args.json:
        print(json.dumps(steps, indent=2, ensure_ascii=False))
        return
    equal = sum(step["equal"] for step in steps)
    total = sum(step["rows"] for step in steps)
    content = sum(step["content"] * step["rows"] / 100 for step in steps)
    print(f"{args.scenario} ({args.setup}) vs {path.name}: {equal}/{total} rows equal in place "
          f"({100 * equal / total:.1f}%), {100 * content / total:.1f}% in order (LCS)")
    for step in steps:
        print(f"  {step['step']:<16} {step['percent']:5.1f}% in place  {step['content']:5.1f}% in order"
              + ("  (missing in tau)" if step.get("missing") else ""))


if __name__ == "__main__":
    main()
