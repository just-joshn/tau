import assert from "node:assert/strict";
import { expect, onTestFinished, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ShellTaskSnapshot } from "../../src/background-shells.js";
import { createWorktreeTools } from "../../src/worktree-tools.js";
import type { ToolUse } from "../../src/types.js";

const signal = new AbortController().signal;
const call = (name: string): ToolUse => ({
  type: "tool_use",
  id: "t",
  name,
  input: {},
});

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function gitIn(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function setup(
  options: {
    commit?: boolean;
    baseRef?: "fresh" | "head";
    randomName?: boolean;
    cwdSub?: string;
  } = {},
) {
  const root = temp("tau-wtb-");
  gitIn(root, "init", "-q", "-b", "main");
  if (options.commit !== false)
    gitIn(root, "commit", "-q", "--allow-empty", "-m", "init");
  let start = root;
  if (options.cwdSub) {
    start = path.join(root, options.cwdSub);
    mkdirSync(start);
  }
  const tasks: ShellTaskSnapshot[] = [];
  const shell = {
    cwd: start,
    root,
    relocate(next: { cwd: string; root: string }) {
      shell.cwd = next.cwd;
      shell.root = next.root;
    },
    shells: { list: () => tasks },
  };
  const tools = createWorktreeTools({
    shell,
    ...(options.randomName === false ? {} : { randomName: () => "rand" }),
    baseRef: () => options.baseRef ?? "fresh",
  });
  return {
    root,
    shell,
    tasks,
    tools,
    enter: (input: { name?: string; path?: string }) =>
      tools.enter.run(input, call("EnterWorktree"), signal),
    exit: (input: { action: "keep" | "remove"; discard_changes?: boolean }) =>
      tools.exit.run(input, call("ExitWorktree"), signal),
    validateExit: (input: {
      action: "keep" | "remove";
      discard_changes?: boolean;
    }) => tools.exit.validate?.(input),
  };
}

const T = { timeout: 60_000 };

test(
  "a random session name is used when none is supplied",
  async () => {
    const repo = setup({ randomName: false });
    const out = await repo.enter({});
    expect(out).toMatch(/worktree-session-[0-9a-f]{8}/);
    await repo.exit({ action: "remove", discard_changes: true });
  },
  T,
);

test("exit without a session is a validation message and a run error", async () => {
  const repo = setup();
  expect(await repo.validateExit({ action: "keep" })).toStartWith("No-op:");
  await assert.rejects(repo.exit({ action: "keep" }), {
    message: "Not in a worktree session",
  });
  expect(await repo.tools.exit.check({ action: "keep" })).toEqual({
    behavior: "allow",
  });
  expect(repo.tools.enter.definition().name).toBe("EnterWorktree");
  expect(repo.tools.exit.definition().name).toBe("ExitWorktree");
});

test(
  "head mode branches from HEAD; fresh mode uses origin and falls back",
  async () => {
    const head = setup({ baseRef: "head" });
    expect(await head.enter({ name: "h" })).toContain("Created worktree");
    await head.exit({ action: "keep" });

    const fresh = setup();
    // No origin: fetch fails, falls back to HEAD.
    expect(await fresh.enter({ name: "f" })).toContain("Created worktree");
    await fresh.exit({ action: "keep" });

    // With an origin that has main: origin/main is known after fetch.
    const upstream = temp("tau-wtb-up-");
    gitIn(upstream, "init", "-q", "-b", "main");
    gitIn(upstream, "commit", "-q", "--allow-empty", "-m", "up");
    const clone = temp("tau-wtb-clone-");
    gitIn(clone, "clone", "-q", upstream, "c");
    const cloneDir = path.join(clone, "c");
    const shell = {
      cwd: cloneDir,
      root: cloneDir,
      relocate(next: { cwd: string; root: string }) {
        shell.cwd = next.cwd;
        shell.root = next.root;
      },
      shells: { list: () => [] },
    };
    const tools = createWorktreeTools({ shell, baseRef: () => "fresh" });
    expect(
      await tools.enter.run({ name: "o" }, call("EnterWorktree"), signal),
    ).toContain("Created worktree");
    await tools.exit.run({ action: "keep" }, call("ExitWorktree"), signal);

    // origin without refs/remotes/origin/HEAD, but with origin/master only.
    gitIn(cloneDir, "remote", "set-head", "origin", "--delete");
    gitIn(cloneDir, "update-ref", "-d", "refs/remotes/origin/main");
    gitIn(cloneDir, "branch", "-m", "main", "master");
    gitIn(upstream, "branch", "-m", "main", "master");
    gitIn(cloneDir, "fetch", "-q", "origin");
    expect(
      await tools.enter.run({ name: "p" }, call("EnterWorktree"), signal),
    ).toContain("Created worktree");
  },
  T,
);

test(
  "a repository with no commit cannot make a worktree",
  async () => {
    const repo = setup({ commit: false });
    await assert.rejects(
      repo.enter({ name: "x" }),
      /Failed to resolve base branch/,
    );
  },
  T,
);

test(
  "a stray directory or broken checkout under the worktree name is reported",
  async () => {
    const repo = setup();
    const dir = path.join(repo.root, ".claude", "worktrees", "stray");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "file"), "x");
    await assert.rejects(
      repo.enter({ name: "stray" }),
      /Failed to create worktree/,
    );
    const broken = path.join(repo.root, ".claude", "worktrees", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent/place\n");
    await assert.rejects(repo.enter({ name: "broken" }), /cannot be reused/);
  },
  T,
);

test(
  "settings.local.json is copied once and only when it is a file",
  async () => {
    const repo = setup();
    mkdirSync(path.join(repo.root, ".claude"), { recursive: true });
    writeFileSync(path.join(repo.root, ".claude", "settings.local.json"), "{}");
    await repo.enter({ name: "copy" });
    const tree = repo.shell.cwd;
    expect(
      execFileSync("cat", [path.join(tree, ".claude", "settings.local.json")], {
        encoding: "utf8",
      }),
    ).toBe("{}");
    await repo.exit({ action: "keep" });

    // Tracked settings already exist in the new worktree: not overwritten.
    gitIn(repo.root, "add", "-f", ".claude/settings.local.json");
    gitIn(repo.root, "commit", "-q", "-m", "track");
    await repo.enter({ name: "tracked" });
    await repo.exit({ action: "keep" });

    // A directory is not copied.
    rmSync(path.join(repo.root, ".claude", "settings.local.json"));
    gitIn(repo.root, "rm", "-q", "--cached", ".claude/settings.local.json");
    gitIn(repo.root, "commit", "-q", "-m", "untrack");
    mkdirSync(path.join(repo.root, ".claude", "settings.local.json"));
    await repo.enter({ name: "dir" });
    await repo.exit({ action: "keep" });
  },
  T,
);

test(
  "entering by path: errors, existing worktrees, and switching",
  async () => {
    const repo = setup();
    await assert.rejects(
      repo.enter({ path: path.join(repo.root, "nope") }),
      /Cannot enter worktree: .*nope/,
    );
    await assert.rejects(repo.enter({ path: repo.root }), /main working tree/);
    const managed = path.join(repo.root, ".claude", "worktrees", "m1");
    gitIn(repo.root, "worktree", "add", "-q", "-b", "m1", managed);
    const detached = path.join(repo.root, ".claude", "worktrees", "m2");
    gitIn(repo.root, "worktree", "add", "-q", "--detach", detached);
    const unmanaged = path.join(temp("tau-wtb-un-"), "u");
    gitIn(repo.root, "worktree", "add", "-q", "-b", "u", unmanaged);

    const entered = await repo.enter({ path: managed });
    expect(entered).toContain("on branch “m1”");
    expect(repo.tools.current()?.enteredExisting).toBe(true);
    await assert.rejects(repo.enter({ path: managed }), /main working tree/);
    // Switching: unmanaged target is refused while active.
    await assert.rejects(repo.enter({ path: unmanaged }), /not under/);
    const second = await repo.enter({ path: detached });
    expect(second).not.toContain(" on branch");
    expect(repo.tools.current()?.worktreeBranch).toBeUndefined();
    expect(repo.tools.current()?.originalCwd).toBe(repo.root);
    // Removal of an entered worktree is refused; keep is fine without a branch.
    expect(await repo.validateExit({ action: "remove" })).toContain(
      "not the owner",
    );
    expect(await repo.exit({ action: "keep" })).toStartWith(
      "Exited worktree. Your work is preserved at",
    );
    // Unmanaged path works from outside a session.
    expect(await repo.enter({ path: unmanaged })).toContain("Entered worktree");
    await repo.exit({ action: "keep" });
  },
  T,
);

test(
  "path entry checks git state: outside a repo, prunable and missing entries",
  async () => {
    const outside = temp("tau-wtb-out-");
    const target = temp("tau-wtb-tgt-");
    const shell = {
      cwd: outside,
      root: outside,
      relocate() {},
      shells: { list: () => [] },
    };
    const tools = createWorktreeTools({ shell, baseRef: () => "fresh" });
    await assert.rejects(
      tools.enter.run({ path: target }, call("EnterWorktree"), signal),
      /not in a git repository/,
    );
    expect(await tools.enter.check({ path: target })).toMatchObject({
      behavior: "ask",
    });

    const repo = setup();
    const prunable = path.join(repo.root, ".claude", "worktrees", "pr");
    gitIn(repo.root, "worktree", "add", "-q", "-b", "pr", prunable);
    // Make the entry prunable while the directory still resolves.
    rmSync(path.join(prunable, ".git"));
    const link = path.join(repo.root, "alias");
    symlinkSync(prunable, link);
    const ask = await repo.tools.enter.check({ path: link });
    expect(ask.behavior).toBe("allow");
    const resolved = path.join(temp("tau-wtb-r-"), "alias");
    symlinkSync(repo.root, resolved);
    const askLink = await repo.tools.enter.check({ path: resolved });
    expect(askLink).toMatchObject({ behavior: "ask" });
    expect(askLink.behavior === "ask" && askLink.prompt).toContain(
      "(resolves to",
    );
    await assert.rejects(repo.enter({ path: prunable }), /marked prunable/);
  },
  T,
);

test(
  "exit: unverifiable state, running tasks, failed removal, vanished origin",
  async () => {
    const repo = setup({ cwdSub: "sub" });
    await repo.enter({ name: "e1" });
    const tree = repo.shell.cwd;
    repo.tasks.push({
      id: "t1",
      type: "local_bash",
      command: "x",
      description: "x",
      outputFile: "/dev/null",
      cwd: tree,
      status: "running",
      startTime: 0,
    });
    // A clean tree with only a running task asks to wait.
    expect(await repo.validateExit({ action: "remove" })).toContain(
      "Wait for the task to finish",
    );
    // discard_changes skips the checks, but run refuses nothing then.
    expect(
      await repo.validateExit({ action: "remove", discard_changes: true }),
    ).toBeUndefined();
    await assert.rejects(
      repo.exit({ action: "remove" }),
      /task t1 is still running/,
    );
    repo.tasks.length = 0;
    // Unrelated and finished tasks do not block.
    repo.tasks.push(
      { ...taskAt("t2", "/elsewhere"), status: "running" },
      { ...taskAt("t3", tree), status: "completed" },
      { ...taskAt("t4", undefined), status: "running" },
    );
    expect(await repo.validateExit({ action: "remove" })).toBeUndefined();
    repo.tasks.length = 0;

    // Stake cannot be read when the worktree directory has vanished.
    rmSync(tree, { recursive: true, force: true });
    rmSync(path.join(repo.root, "sub"), { recursive: true });
    const unverifiable = await repo.validateExit({ action: "remove" });
    expect(unverifiable).toContain("Could not verify worktree state");
    const out = await repo.exit({ action: "remove", discard_changes: true });
    expect(out).toContain("no longer exists");
    expect(out).toContain("Consider restarting Claude");
  },
  T,
);

function taskAt(id: string, cwd: string | undefined): ShellTaskSnapshot {
  return {
    id,
    type: "local_bash",
    command: "x",
    description: "x",
    outputFile: "/dev/null",
    ...(cwd === undefined ? {} : { cwd }),
    status: "running",
    startTime: 0,
  };
}

test(
  "keep with a vanished origin, uncommitted-only and commit-only removal text",
  async () => {
    const repo = setup({ cwdSub: "sub" });
    await repo.enter({ name: "k1" });
    const tree = repo.shell.cwd;
    rmSync(path.join(repo.root, "sub"), { recursive: true });
    const kept = await repo.exit({ action: "keep" });
    expect(kept).toContain("no longer exists");
    expect(kept).not.toContain("Consider restarting");

    await repo.enter({ name: "k2" });
    const tree2 = repo.shell.cwd;
    writeFileSync(path.join(tree2, "a.txt"), "a");
    expect(await repo.validateExit({ action: "remove" })).toContain(
      "Worktree has 1 uncommitted file. Removing",
    );
    gitIn(tree2, "add", ".");
    gitIn(tree2, "commit", "-q", "-m", "c");
    gitIn(tree2, "commit", "-q", "--allow-empty", "-m", "c2");
    repo.tasks.push(taskAt("tk", tree2));
    const msg = await repo.validateExit({ action: "remove" });
    expect(msg).toContain("Worktree has 2 commits on “worktree-k2”.");
    expect(msg).toContain("task tk is still running");
    repo.tasks.length = 0;
    const done = await repo.exit({ action: "remove", discard_changes: true });
    expect(done).toContain("Discarded 2 commits.");
    void tree;
  },
  T,
);

test(
  "a worktree git refuses to remove is kept and says so",
  async () => {
    const repo = setup();
    await repo.enter({ name: "locked" });
    const tree = repo.shell.cwd;
    gitIn(repo.root, "worktree", "lock", tree);
    const out = await repo.exit({ action: "remove", discard_changes: true });
    expect(out).toContain("could not remove it");
    gitIn(repo.root, "worktree", "unlock", tree);
  },
  T,
);
