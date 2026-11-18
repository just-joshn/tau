"""Owned MCP autoload fixture layout, without launching any configured command."""
import json
import hashlib
from pathlib import Path
from isolation import REPO, clone_file

SCOPE_CASES = ["all", "user", "project", "local", "none", "explicit", "strict", "project-rejected", "shadowed-project-rejected"]


def install_scope_fixture(root: Path, case: str):
    if case not in SCOPE_CASES: raise ValueError("Unknown MCP scope fixture")
    files = {}
    root.mkdir(parents=True, exist_ok=True)
    (root / "work").mkdir(exist_ok=True)
    (root / "lifecycle").mkdir(exist_ok=True)
    fixture = root / "mcp-fixture.mjs"
    clone_file(REPO / "scripts/differential/mcp_fixture.mjs", fixture)
    node = root / "bin/node"
    def server(scope):
        return {"type": "stdio", "command": str(node), "args": [str(fixture), str(root / "lifecycle" / (scope + ".jsonl")), "allowed"], "alwaysLoad": True}
    def write(relative, document):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(document, indent=2) + "\n"
        path.write_text(text)
        files[relative] = text
    # Original blo(): CLAUDE_CONFIG_DIR or home, then .claude${Hz()}.json.
    # Jl(): the local project mcpServers live inside globalConfig.projects[cwd].
    write("config/.claude.json", {"mcpServers": {"fixture": server("user"), "user-only": server("user-only")},
          "projects": {str(root / "work"): {"mcpServers": {"fixture": server("local"), "local-only": server("local-only")}}}})
    # Distinct sentinel establishes whether a launch mistakenly ignores the
    # explicit config directory. It is still an entirely owned dummy document.
    write("home/.claude.json", {"mcpServers": {"home-sentinel": server("home-sentinel")}})
    write(".mcp.json", {"mcpServers": {"fixture": server("ancestor"), "ancestor-only": server("ancestor-only")}})
    write("work/.mcp.json", {"mcpServers": {"fixture": server("project"), "project-only": server("project-only")}})
    write("config/settings.json", {})
    write("work/.claude/settings.json", {})
    rejected = case in ["project-rejected", "shadowed-project-rejected"]
    write("work/.claude/settings.local.json", {"disabledMcpjsonServers": ["fixture", "project-only"]} if rejected else {})
    # The project-only rejection control must carry its rejection in an enabled
    # source; a project-source-only launch gates out local settings.
    if case == "project-rejected":
        write("work/.claude/settings.json", {"disabledMcpjsonServers": ["fixture", "project-only"]})
    explicit = {"mcpServers": {"fixture": server("explicit"), "explicit-only": server("explicit-only")}}
    write("explicit-mcp.json", explicit)
    arguments = ["--model", "claude-sonnet-4-5-20250929", "--tools", "", "--allowedTools", "mcp__fixture__lookup"]
    if case in ["user", "project", "local", "none"]:
        arguments += ["--setting-sources", "" if case == "none" else case]
    if case == "project-rejected": arguments += ["--setting-sources", "project"]
    if case in ["explicit", "strict"]: arguments += ["--mcp-config", json.dumps(explicit)]
    if case == "strict": arguments.append("--strict-mcp-config")
    return {"case": case, "files": files, "arguments": arguments,
            "global_config": str(root / "config/.claude.json"), "dummy_home_sentinel": str(root / "home/.claude.json"),
            "lifecycle_directory": str(root / "lifecycle"), "fixture": str(fixture), "expected_node": str(node),
            "fixture_sha256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
            "observations_to_collect": ["advertised qualified tool names", "spawned process origins from per-scope logs", "origin receiving tools/call", "project rejection vs local/user name shadowing", "headless project auto-approval"]}
