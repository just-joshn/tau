"""Independent dummy settings and instructions; no host configuration discovery."""
import json

MODELS = {"user": "claude-haiku-4-5-20251001", "project": "claude-sonnet-4-5-20250929",
          "local": "claude-opus-4-6", "flag": "claude-sonnet-4-6", "cli": "claude-opus-4-5-20251101"}
MARKER_NAMES = ["USER_ROOT", "USER_IMPORT", "USER_RULE", "USER_CONDITIONAL", "PROJECT_ROOT", "PROJECT_DOT",
                "PROJECT_IMPORT", "PROJECT_DEEP_IMPORT", "PROJECT_RULE", "PROJECT_CONDITIONAL", "LOCAL_ROOT",
                "NESTED_ROOT", "NESTED_DOT", "NESTED_LOCAL", "NESTED_IMPORT", "NESTED_RULE", "NESTED_CONDITIONAL",
                "NONMATCHING_RULE", "CLI_SYSTEM", "MANAGED_INLINE"]


def marker(name, version=1):
    return "TAU_CFG_PROOF_" + name + "_V" + str(version)


def install(root, version=1):
    files = {}
    def text(relative, value):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        files[relative] = value
    def instruction(relative, name, extra=""):
        text(relative, "Fixture provenance: " + marker(name, version) + ".\n" + extra)
    def rule(relative, name, paths=None):
        instruction(relative, name)
        if paths:
            text(relative, "---\npaths: " + json.dumps(paths) + "\n---\n" + files[relative])
    configs = {
        "config/settings.json": {"model": MODELS["user"], "permissions": {"allow": ["Read", "Edit"], "deny": ["Write"]}},
        "work/.claude/settings.json": {"model": MODELS["project"], "permissions": {"allow": ["Write"], "deny": ["Edit"]}},
        "work/.claude/settings.local.json": {"model": MODELS["local"], "permissions": {"allow": ["Edit"]}},
        "flag-settings.json": {"model": MODELS["flag"], "permissions": {"allow": ["Write"]}},
    }
    if version == 2:
        configs["work/.claude/settings.local.json"]["model"] = MODELS["flag"]
        configs["config/settings.json"]["permissions"] = {"allow": ["Read", "Edit", "Write"]}
        configs["work/.claude/settings.json"]["permissions"] = {"allow": ["Edit", "Write"]}
    for relative, value in configs.items(): text(relative, json.dumps(value, indent=2) + "\n")
    instruction("config/CLAUDE.md", "USER_ROOT", "@user-import.md\n")
    instruction("config/user-import.md", "USER_IMPORT")
    rule("config/rules/base.md", "USER_RULE")
    rule("config/rules/conditional.md", "USER_CONDITIONAL", ["nested/**"])
    instruction("work/CLAUDE.md", "PROJECT_ROOT", "@instructions/project-import.md\n")
    instruction("work/.claude/CLAUDE.md", "PROJECT_DOT")
    instruction("work/CLAUDE.local.md", "LOCAL_ROOT")
    instruction("work/instructions/project-import.md", "PROJECT_IMPORT", "@deep.md\n")
    instruction("work/instructions/deep.md", "PROJECT_DEEP_IMPORT")
    rule("work/.claude/rules/base.md", "PROJECT_RULE")
    rule("work/.claude/rules/conditional.md", "PROJECT_CONDITIONAL", ["nested/**"])
    rule("work/.claude/rules/nonmatching.md", "NONMATCHING_RULE", ["elsewhere/**"])
    instruction("work/nested/CLAUDE.md", "NESTED_ROOT", "@nested-import.md\n")
    instruction("work/nested/.claude/CLAUDE.md", "NESTED_DOT")
    instruction("work/nested/CLAUDE.local.md", "NESTED_LOCAL")
    instruction("work/nested/nested-import.md", "NESTED_IMPORT")
    rule("work/nested/.claude/rules/base.md", "NESTED_RULE")
    rule("work/nested/.claude/rules/conditional.md", "NESTED_CONDITIONAL", ["*.txt"])
    text("work/nested/a.txt", "alpha\n")
    (root / "work/nested/new.txt").unlink(missing_ok=True)
    return files


def marker_hits(value, version=1, path=""):
    found = {}
    if isinstance(value, str):
        for name in MARKER_NAMES:
            if marker(name, version) in value: found[name] = [path]
    elif isinstance(value, dict):
        for key, item in value.items():
            for name, locations in marker_hits(item, version, path + "/" + key).items(): found.setdefault(name, []).extend(locations)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            for name, locations in marker_hits(item, version, path + "/" + str(index)).items(): found.setdefault(name, []).extend(locations)
    return found
