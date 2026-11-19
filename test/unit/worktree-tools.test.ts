import assert from "node:assert/strict";
import { expect, onTestFinished, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ShellTaskSnapshot } from "../../src/background-shells.js";
import {
  createWorktreeTools,
  enterWorktreeInputSchema,
  quoted,
  worktreeBaseRef,
  worktreeNameProblem,
} from "../../src/worktree-tools.js";
import type { ToolUse } from "../../src/types.js";

test("worktree names follow the original's segment rules", () => {
  expect(worktreeNameProblem("feature/login-2.0_x")).toBeUndefined();
  expect(worktreeNameProblem("a/../b")).toBe(
    'Invalid worktree name "a/../b": must not contain "." or ".." path segments',
  );
  expect(worktreeNameProblem("x/.GIT..")).toBe(
    'Invalid worktree name "x/.GIT..": ".GIT.." is a reserved git directory name',
  );
  expect(worktreeNameProblem("has space")).toBe(
    'Invalid worktree name "has space": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes',
  );
  expect(worktreeNameProblem("a".repeat(65))).toBe(
    "Invalid worktree name: must be 64 characters or fewer (got 65)",
  );
  expect(
    enterWorktreeInputSchema
      .safeParse({ name: "a", path: "b" })
      .error?.issues.map((issue) => issue.message),
  ).toEqual(["Provide at most one of `name` or `path`, not both."]);
  expect(enterWorktreeInputSchema.safeParse({ nam: "a" }).success).toBe(false);
});

test("display quoting and the baseRef setting", () => {
  expect(quoted("/repo/.claude/worktrees/x")).toBe(
    "“/repo/.claude/worktrees/x”",
  );
  expect(quoted('a\n"b"')).toBe("“a 'b'” (not its exact spelling)");
  expect(worktreeBaseRef({ worktree: { baseRef: "head" } })).toBe("head");
  expect(worktreeBaseRef({ worktree: { baseRef: "other" } })).toBe("fresh");
  expect(worktreeBaseRef({})).toBe("fresh");
});

/** A git repository with one commit, and a fake session shell standing in it. */
function repository() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tau-wt-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd: root, encoding: "utf8" },
    ).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const tasks: ShellTaskSnapshot[] = [];
  const shell = {
    cwd: root,
    root,
    relocate(next: { cwd: string; root: string }) {
      shell.cwd = next.cwd;
      shell.root = next.root;
    },
    shells: { list: () => tasks },
  };
  const tools = createWorktreeTools({
    shell,
    randomName: () => "random-name",
    baseRef: () => "fresh",
  });
  const call = (name: string): ToolUse => ({
    type: "tool_use",
    id: "t",
    name,
    input: {},
  });
  const signal = new AbortController().signal;
  return {
    root,
    git,
    shell,
    tasks,
    tools,
    enter: (input: { name?: string; path?: string }) =>
      tools.enter.run(input, call("EnterWorktree"), signal),
    validateExit: (input: {
      action: "keep" | "remove";
      discard_changes?: boolean;
    }) => tools.exit.validate?.(input),
    exit: (input: { action: "keep" | "remove"; discard_changes?: boolean }) =>
      tools.exit.run(input, call("ExitWorktree"), signal),
  };
}

test("a worktree with a commit and a file is refused, then removed when the user confirms", async () => {
  const repo = repository();
  expect(await repo.enter({})).toStartWith(
    `Created worktree at “${repo.root}/.claude/worktrees/random-name” on branch “worktree-random-name”.`,
  );
  const tree = repo.shell.cwd;
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "work",
    ],
    { cwd: tree },
  );
  writeFileSync(path.join(tree, "scratch.txt"), "x");
  expect(await repo.validateExit({ action: "remove" })).toBe(
    'Worktree has 1 uncommitted file and 1 commit on “worktree-random-name”. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.',
  );
  expect(
    await repo.validateExit({ action: "remove", discard_changes: true }),
  ).toBeUndefined();
  expect(await repo.exit({ action: "remove", discard_changes: true })).toBe(
    `Exited and removed worktree at “${tree}”. Discarded 1 commit and 1 uncommitted file. Session is now back in “${repo.root}”.`,
  );
  expect(repo.shell).toMatchObject({ cwd: repo.root, root: repo.root });
  expect(repo.git("branch", "--list", "worktree-*")).toBe("");
  expect(repo.tools.current()).toBeUndefined();
}, { timeout: 30_000 });

test("a running task in the worktree blocks removal; a second create is refused while one is active", async () => {
  const repo = repository();
  await repo.enter({ name: "busy" });
  const tree = repo.shell.cwd;
  repo.tasks.push({
    id: "bbusy0001",
    type: "local_bash",
    command: "sleep 100",
    description: "sleep",
    outputFile: "/dev/null",
    cwd: path.join(tree, "src"),
    status: "running",
    startTime: 0,
  });
  expect(await repo.validateExit({ action: "remove" })).toBe(
    'Nothing was removed: task bbusy0001 is still running and may be working in this worktree, and removing the worktree now could lose that work or land it in the main checkout. Wait for the task to finish, or ask the user before stopping it, then call this tool again — or use action: "keep" to preserve the worktree.',
  );
  expect(await repo.tools.enter.validate?.({ name: "other" })).toBe(
    "Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.",
  );
});

test("entering by path needs a registered linked worktree, and creating the same name again resumes it", async () => {
  const repo = repository();
  await assert.rejects(repo.enter({ path: "." }), {
    message:
      "Cannot enter worktree: . is the main working tree, not a linked worktree.",
  });
  await repo.enter({ name: "again" });
  await repo.exit({ action: "keep" });
  expect(await repo.enter({ name: "again" })).toContain("Resumed worktree at");
  await repo.exit({ action: "keep" });
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "tau-wt-x-")));
  onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
  await assert.rejects(repo.enter({ path: outside }), {
    message: `Cannot enter worktree: ${outside} is not a registered worktree of ${repo.root}. Run 'git -C ${repo.root} worktree list' to see registered worktrees.`,
  });
  expect(
    await repo.tools.enter.check({ path: ".claude/worktrees/again" }),
  ).toEqual({ behavior: "allow" });
  expect(await repo.tools.enter.check({ path: outside })).toEqual({
    behavior: "ask",
    prompt: `Enter the worktree at "${outside}"? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location.`,
  });
});

test("outside a git repository EnterWorktree says how to get isolation", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tau-wt-none-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const shell = {
    cwd: dir,
    root: dir,
    relocate() {},
    shells: { list: () => [] },
  };
  const tools = createWorktreeTools({ shell, baseRef: () => "fresh" });
  await assert.rejects(
    tools.enter.run(
      { name: "x" },
      { type: "tool_use", id: "t", name: "EnterWorktree", input: {} },
      new AbortController().signal,
    ),
    /^Error: Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured\./,
  );
});
