#!/usr/bin/env python3
"""Section-by-section comparison of the main request's system blocks, first-turn reminders and
request-level fields between an original capture and a tau capture of the same scenario.

Both files hold {"requests": [{"path", "body"}, ...]} (run_original.py / run_tau_capture.py records,
or the workflow oracles). Temp roots, dates, ports and the billing fingerprint are normalized first.
"""
import argparse
import difflib
import json
import re
import sys

LABELS = [
    ("environment", re.compile(r"^# Environment\n")),
    ("model", re.compile(r"^You are powered by the model")),
    ("deferred_tools", re.compile(r"^The following deferred tools")),
    ("agent_listing", re.compile(r"agent types (?:for|are now available)|agent types are no longer")),
    ("skill_listing", re.compile(r"^The following skills are")),
    ("total_tokens", re.compile(r"^<total_tokens>")),
    ("date", re.compile(r"^Today's date is|^The date has changed")),
    ("git_attribution", re.compile(r"^Attribution for git|^From here on, do not add attribution")),
]
REMINDER = re.compile(r"^<system-reminder>\n(.*)\n</system-reminder>\n?$", re.S)
SKIPPED_FIELDS = {"messages", "system", "tools", "metadata"}


def normalize(text, roots):
    for root in roots:
        text = text.replace(root, "<ROOT>")
    text = re.sub(r"/(?:private/)?(?:var/folders/[^\s`'\"]+?/T/|tmp/)tau-differential-[A-Za-z0-9_]+", "<ROOT>", text)
    text = re.sub(r"(cc_version=\d+\.\d+\.\d+)\.[0-9a-f]{3}", r"\1.<FP>", text)
    text = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "<DATE>", text)
    return re.sub(r"127\.0\.0\.1:\d+", "127.0.0.1:<PORT>", text)


def main_request(record):
    bodies = [r["body"] for r in record["requests"] if r["path"].split("?")[0] == "/v1/messages"]
    if not bodies:
        sys.exit("no /v1/messages request in capture")
    return max(bodies, key=lambda body: len(json.dumps(body.get("system", ""))))


def system_sections(body, roots):
    system = body.get("system", "")
    blocks = [{"text": system}] if isinstance(system, str) else system
    out = []
    for index, block in enumerate(blocks):
        text = normalize(block["text"], roots)
        cache = "cached" if block.get("cache_control") else "uncached"
        if "\n\n# " not in text:
            out.append((f"block{index}[{cache}]", text))
            continue
        chunks = text.split("\n\n# ")
        out.append((f"block{index}[{cache}] intro", chunks[0]))
        for chunk in chunks[1:]:
            out.append((f"block{index}[{cache}] # {chunk.split(chr(10), 1)[0]}", "# " + chunk))
    return out


def reminder_sections(body, roots):
    first = next((m for m in body["messages"] if m["role"] == "user"), {"content": []})
    content = first["content"] if isinstance(first["content"], list) else [{"type": "text", "text": first["content"]}]
    out = []
    for block in content:
        text = normalize(block.get("text", json.dumps(block)), roots)
        match = REMINDER.match(text)
        inner = match.group(1) if match else None
        label = next((name for name, pattern in LABELS if inner is not None and pattern.search(inner)), None)
        out.append((label or ("reminder:other" if match else "prompt-or-context"), text))
    # The prompt is the last block; anything else unlabeled (CLAUDE.md context) is numbered.
    if out and out[-1][0] == "prompt-or-context":
        out[-1] = ("prompt", out[-1][1])
    counts = {}
    for index, (key, text) in enumerate(out):
        counts[key] = counts.get(key, 0) + 1
        if counts[key] > 1 or key in ("reminder:other", "prompt-or-context"):
            out[index] = (f"{key}#{counts[key]}", text)
    return out


def compare(kind, left, right, report):
    lmap, rmap = dict(left), dict(right)
    order_equal = [k for k, _ in left] == [k for k, _ in right]
    report.append(f"== {kind}: order {'equal' if order_equal else 'differs'}")
    if not order_equal:
        report.append(f"   original: {[k for k, _ in left]}\n   tau:      {[k for k, _ in right]}")
    rows = []
    for key in list(dict.fromkeys([k for k, _ in left] + [k for k, _ in right])):
        status = ("missing-in-tau" if key not in rmap else "extra-in-tau" if key not in lmap
                  else "equal" if lmap[key] == rmap[key] else "differs")
        rows.append({"section": key, "status": status})
        report.append(f"   {status:15} {key}")
        if status == "differs":
            report.extend("      " + line for line in difflib.unified_diff(
                lmap[key].splitlines(), rmap[key].splitlines(), "original", "tau", lineterm="", n=1))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original")
    parser.add_argument("tau")
    parser.add_argument("--json", help="write a machine-readable summary here")
    args = parser.parse_args()
    records = [json.load(open(path)) for path in (args.original, args.tau)]
    roots = [r["root"] for r in records if r.get("root")]
    bodies = [main_request(r) for r in records]
    report, summary = [], {}
    summary["system"] = compare("system blocks", *(system_sections(b, roots) for b in bodies), report)
    summary["reminders"] = compare("first user message", *(reminder_sections(b, roots) for b in bodies), report)
    fields = [{k: v for k, v in b.items() if k not in SKIPPED_FIELDS} for b in bodies]
    report.append("== request fields")
    summary["fields"] = []
    for key in sorted(set(fields[0]) | set(fields[1])):
        same = fields[0].get(key) == fields[1].get(key)
        summary["fields"].append({"field": key, "status": "equal" if same else "differs"})
        report.append(f"   {'equal' if same else 'differs':15} {key}" +
                      ("" if same else f": original={json.dumps(fields[0].get(key))} tau={json.dumps(fields[1].get(key))}"))
    print("\n".join(report))
    if args.json:
        with open(args.json, "w") as handle:
            json.dump(summary, handle, indent=2)


if __name__ == "__main__":
    main()
