#!/usr/bin/env python3
"""Diff the SDK message protocol (--output-format json/stream-json) of two runs.

Reads two stdout captures (one JSON value per line, or a json array/object),
normalizes run identity (session ids, the working directory), and compares the
message type sequence plus the selected fields in sdk_io_fields.json. Keys the
original emits that tau omits are listed as informative, not as failures.

  compare_sdk_io.py ORIGINAL TAU          exit 1 on any selected difference
  compare_sdk_io.py --project CAPTURE     print the normalized projection
"""
import argparse
import json
from pathlib import Path
import sys

FIELDS = json.loads((Path(__file__).parent / "sdk_io_fields.json").read_text())["fields"]
ABSENT = "<absent>"


def messages(path):
    """Accepts a stdout capture or a run_original.py/run_tau record (.json with result.stdout)."""
    text = path.read_text()
    if path.suffix == ".json":
        try:
            record = json.loads(text)
            if isinstance(record, dict) and isinstance(record.get("result"), dict) and "stdout" in record["result"]:
                text = record["result"]["stdout"]
        except ValueError:
            pass
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        rows.extend(value if isinstance(value, list) else [value])
    return rows


def kind(message):
    return message["type"] + ("/" + message["subtype"] if message["type"] == "system" else "")


def normalize(rows):
    sessions, cwds = {}, []
    for row in rows:
        if row.get("session_id") and row["session_id"] not in sessions:
            sessions[row["session_id"]] = "<session-%d>" % len(sessions)
        if kind(row) == "system/init":
            cwds.append(row["cwd"])
    cwds += [cwd[len("/private"):] for cwd in cwds if cwd.startswith("/private/")]

    def walk(value):
        if isinstance(value, str):
            if value in sessions:
                return sessions[value]
            for cwd in sorted(set(cwds), key=len, reverse=True):
                value = value.replace(cwd, "<cwd>")
            return value
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            return {key: walk(item) for key, item in value.items()}
        return value

    return walk(rows)


def select(value, path):
    head, _, rest = path.partition(".")
    if head.endswith("[]"):
        items = value.get(head[:-2], ABSENT) if isinstance(value, dict) else ABSENT
        if not isinstance(items, list):
            return ABSENT
        return [select(item, rest) if rest else item for item in items]
    item = value.get(head, ABSENT) if isinstance(value, dict) else ABSENT
    return select(item, rest) if rest and item is not ABSENT else item


def project(rows):
    return [{"kind": kind(row), **{path: select(row, path) for path in FIELDS.get(kind(row), [])}} for row in normalize(rows)]


def compare(original, tau):
    left, right = project(original), project(tau)
    report = {"original_sequence": [row["kind"] for row in left], "tau_sequence": [row["kind"] for row in right], "differences": [], "missing_keys": {}}
    if report["original_sequence"] != report["tau_sequence"]:
        report["differences"].append({"field": "<type sequence>", "original": report["original_sequence"], "tau": report["tau_sequence"]})
    for index, (a, b) in enumerate(zip(left, right)):
        if a["kind"] != b["kind"]:
            continue
        for path in FIELDS.get(a["kind"], []):
            if a[path] != b[path]:
                report["differences"].append({"index": index, "kind": a["kind"], "field": path, "original": a[path], "tau": b[path]})
    for a, b in zip(original, tau):
        if kind(a) == kind(b):
            missing = sorted(set(a) - set(b))
            if missing:
                report["missing_keys"].setdefault(kind(a), sorted(set(report["missing_keys"].get(kind(a), [])) | set(missing)))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("captures", type=Path, nargs="+")
    parser.add_argument("--project", action="store_true", help="Print the normalized projection of one capture")
    args = parser.parse_args()
    if args.project:
        if len(args.captures) != 1:
            parser.error("--project takes one capture")
        print(json.dumps(project(messages(args.captures[0])), indent=2))
        return 0
    if len(args.captures) != 2:
        parser.error("compare takes ORIGINAL and TAU captures")
    report = compare(messages(args.captures[0]), messages(args.captures[1]))
    print(json.dumps(report, indent=2))
    return 1 if report["differences"] else 0


if __name__ == "__main__":
    sys.exit(main())
