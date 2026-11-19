"""Deferred-catalog scenario: ToolSearch loads NotebookEdit, which edits a Read notebook.

The mock never expands tool_reference blocks; it scripts the model turns only.
Comparison reads the recorded request bodies (tools before and after discovery,
ToolSearch and NotebookEdit results) and the final notebook bytes.
"""
import json
from pathlib import Path

CATALOG_SCENARIO = "catalog"
NOTEBOOK = {
    "cells": [
        {"cell_type": "markdown", "id": "intro", "metadata": {}, "source": ["# Title\n", "text"]},
        {"cell_type": "code", "execution_count": 3, "id": "calc", "metadata": {},
         "outputs": [{"name": "stdout", "output_type": "stream", "text": ["1\n"]}], "source": "print(1)"},
    ],
    "metadata": {"language_info": {"name": "python"}},
    "nbformat": 4,
    "nbformat_minor": 5,
}
NOTEBOOK_TEXT = json.dumps(NOTEBOOK, indent=1) + "\n"
DEFERRED = "NotebookEdit"


def setup(work: Path) -> Path:
    notebook = work / "nb.ipynb"
    notebook.write_text(NOTEBOOK_TEXT)
    return notebook


def catalog_turn(generation: int, work: Path):
    """(content, stop_reason) for model request `generation` (1-based)."""
    notebook = str(work / "nb.ipynb")
    steps = [("ToolSearch", {"query": "select:" + DEFERRED, "max_results": 5}),
             ("Read", {"file_path": notebook}),
             (DEFERRED, {"notebook_path": notebook, "cell_id": "calc", "new_source": "print(2)"})]
    if generation <= len(steps):
        name, value = steps[generation - 1]
        return [{"type": "tool_use", "id": "fixture-catalog-" + str(generation), "name": name, "input": value}], "tool_use"
    return [{"type": "text", "text": "catalog workflow done"}], "end_turn"


def summarize(record: dict) -> dict:
    """Observable catalog facts from one recorded run, comparable across executables."""
    bodies = [r["body"] for r in record["requests"] if r["path"].split("?")[0] == "/v1/messages"]
    def tool(body, name):
        return next((t for t in body.get("tools", []) if t.get("name") == name), None)
    def result(body, suffix):
        for message in body.get("messages", []):
            for block in message.get("content", []) if isinstance(message.get("content"), list) else []:
                if block.get("type") == "tool_result" and block.get("tool_use_id") == "fixture-catalog-" + suffix:
                    return {"is_error": block.get("is_error", False), "content": block.get("content")}
        return None
    listing = [b.get("text", "") for m in (bodies[0]["messages"] if bodies else []) if isinstance(m.get("content"), list)
               for b in m["content"] if "deferred tools are now available" in b.get("text", "")]
    return {
        "requests": len(bodies),
        "deferred_listed_initially": bool(listing) and ("\n" + DEFERRED + "\n") in listing[0],
        # The header is comparable; the listed names differ with each executable's catalog.
        "listing_header": listing[0].split("\n")[1] if listing else None,
        "listed_names": listing[0].split("\n")[2:-1] if listing else None,
        "tool_names": [[t.get("name") for t in b.get("tools", [])] for b in bodies],
        "placeholder": [tool(b, "DeferredToolPlaceholder") for b in bodies[:1]],
        "notebook_tool_per_request": [None if tool(b, DEFERRED) is None else {"defer_loading": tool(b, DEFERRED).get("defer_loading")} for b in bodies],
        "tool_search_result": result(bodies[1], "1") if len(bodies) > 1 else None,
        "read_result_text": json.dumps(result(bodies[2], "2"), sort_keys=True) if len(bodies) > 2 else None,
        "notebook_edit_result": result(bodies[3], "3") if len(bodies) > 3 else None,
        "final_notebook": record.get("final_file"),
    }
