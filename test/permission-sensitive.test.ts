import test from "node:test";
import assert from "node:assert/strict";
import { sensitiveWriteReason } from "../src/permission-sensitive.js";

const cwd = "/fixture/repo";
test("source sensitive directory/name tables hold ordinary config paths, not plain instruction filenames", () => {
  for (const file of ["nested/.claude/CLAUDE.md", ".claude/settings.local.json", ".vscode/settings.json", "sub/.idea/workspace.xml", ".husky/pre-commit", ".cargo/config.toml", ".devcontainer/devcontainer.json", ".yarn/plugin.cjs", ".mvn/maven.config", ".config/git/config", ".mcp.json", "sub/.npmrc", ".zshrc", "pyrightconfig.json"]) assert.ok(sensitiveWriteReason(file, cwd), file);
  assert.equal(sensitiveWriteReason("CLAUDE.md", cwd), undefined);
  assert.equal(sensitiveWriteReason("nested/CLAUDE.md", cwd), undefined);
});

test("sensitive path folding and current launch/worktree exceptions follow source structure", () => {
  assert.ok(sensitiveWriteReason(".ClAuDe /CLAUDE.md", cwd));
  assert.ok(sensitiveWriteReason(".cla\u200cude/config.json", cwd));
  assert.equal(sensitiveWriteReason(".claude/launch.json", cwd), undefined);
  assert.ok(sensitiveWriteReason("nested/.claude/launch.json", cwd));
  assert.equal(sensitiveWriteReason(".claude/worktrees/branch/source.ts", cwd), undefined);
  assert.ok(sensitiveWriteReason(".claude/worktrees/branch/.claude/CLAUDE.md", cwd));
  assert.equal(sensitiveWriteReason(".claude/worktrees/inner/source.ts", "/fixture/.claude/worktrees/outer/repo"), undefined);
});

test("explicit current-session settings paths hold files outside conventional directory names", () => {
  assert.ok(sensitiveWriteReason("custom.json", cwd, ["custom.json"]));
  assert.equal(sensitiveWriteReason("ordinary.json", cwd, ["custom.json"]), undefined);
});
