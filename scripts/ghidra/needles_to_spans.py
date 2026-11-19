#!/usr/bin/env python3
"""Turn {label: needle} into span_provenance.py input by finding the one recovered module holding each needle once."""
import json, re, sys
from pathlib import Path
BUNDLE = Path(__file__).resolve().parents[2] / "artifacts/claude-bundle"
needles = json.loads(Path(sys.argv[1]).read_text())
texts = {p.name: p.read_bytes() for p in sorted(BUNDLE.glob("*.js"))}
spans, problems = [], []
for label, needle in needles.items():
    raw = needle.encode()
    hits = [(name, data.count(raw)) for name, data in texts.items() if raw in data]
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", label)[:58]  # span labels allow [A-Za-z0-9_-]{1,64} with a part suffix
    if len(hits) == 1 and hits[0][1] == 1: spans.append({"label": safe, "module": hits[0][0], "needle": needle})
    else: problems.append({"label": label, "hits": hits})
Path(sys.argv[2]).write_text(json.dumps(spans, indent=1) + "\n")
print(json.dumps({"spans": len(spans), "problems": problems}, indent=1))
