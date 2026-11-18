import assert from "node:assert/strict";
import { test } from "bun:test";
import { sensitiveWriteReason } from "../../src/permission-sensitive.js";

const cwd = "/fixture/repo";

test("INV-06 a .claude directory inside a project worktree asks, even another worktrees directory", () => {
  assert.equal(
    sensitiveWriteReason(
      ".claude/worktrees/a/.claude/worktrees/b/source.ts",
      cwd,
    ),
    "This path changes a sensitive configuration directory",
  );
  assert.equal(
    sensitiveWriteReason(".claude/worktrees/a/source.ts", cwd),
    undefined,
  );
});

test("INV-06 only .config/git is Git configuration; other .config and git directories write freely", () => {
  assert.equal(
    sensitiveWriteReason(".config/git/config", cwd),
    "This path changes Git configuration",
  );
  for (const file of [".config/nvim/init.lua", "src/git/index.ts"])
    assert.equal(sensitiveWriteReason(file, cwd), undefined, file);
});
