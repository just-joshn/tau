#!/usr/bin/env python3
"""Prepare owned source/strict/approval fixtures; do not launch either CLI/MCP."""
import hashlib
import json
from isolation import REPO, verified_isolation
from mcp_scope_fixture import SCOPE_CASES, install_scope_fixture


def main():
    artifacts = REPO / "artifacts/differential-pass/mcp-scope-readiness"
    with verified_isolation(artifacts) as isolation:
        cases = {}
        for name in SCOPE_CASES:
            recipe = install_scope_fixture(isolation.root / "scope-fixtures" / name, name)
            cases[name] = {"recipe": recipe, "file_sha256": {path: hashlib.sha256(text.encode()).hexdigest() for path, text in recipe["files"].items()}}
        report = {"isolation": isolation.report, "original_executed": False, "tau_cli_executed": False,
                  "mcp_commands_executed": False, "cases": cases,
                  "readiness_only": "Paths are examples in a removed disposable tree. Regenerate each recipe in its own freshly verified context before any execution.",
                  "contracts": ["Global user mcpServers and projects[cwd].mcpServers share the owned config/.claude.json.",
                      "Ancestor and cwd .mcp.json distinguish project discovery and shadowing.",
                      "Every configured command refers to a future copied disposable Node and the independent fixture server.",
                      "No administrator managed-mcp.json path is injected or read; that tier remains source/unit coverage."]}
        path = artifacts / "readiness.json"
        path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"artifact": str(path), "cases": len(cases), "original_executed": False, "mcp_commands_executed": False}))


if __name__ == "__main__": main()
