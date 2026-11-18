import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, onTestFinished } from "bun:test";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { loadLaunchMcp } from "../../src/mcp-launch.js";
import { parseOptions } from "../../src/options.js";

test("nested repository launch merges legacy and canonical local settings while keeping permission and MCP trust distinct", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-workspace-launch-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"),
    cwd = join(repo, "packages/app"),
    user = join(root, "user"),
    home = join(root, "home"),
    managed = join(root, "managed");
  for (const directory of [
    join(repo, ".claude"),
    join(cwd, ".claude"),
    user,
    home,
    managed,
  ])
    await mkdir(directory, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: user,
    TAU_MANAGED_ROOT: managed,
  };
  const git = (...args: string[]) =>
    promisify(execFile)("git", args, { cwd: repo, env });
  await git("init", "--quiet");
  await writeFile(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({
      model: "project",
      permissions: { allow: ["Edit"], deny: ["Bash"] },
    }),
  );
  await writeFile(
    join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ model: "legacy", permissions: { allow: ["Read"] } }),
  );
  await writeFile(
    join(repo, ".claude/settings.local.json"),
    JSON.stringify({
      model: "canonical",
      enabledMcpjsonServers: ["project"],
      permissions: { allow: ["Write"] },
    }),
  );
  await writeFile(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        project: { command: process.execPath, args: ["--version"] },
      },
    }),
  );
  const global = (trusted = false) => ({
    projects: {
      [repo]: {
        hasTrustDialogAccepted: trusted,
        mcpServers: {
          local: { command: process.execPath, args: ["--version"] },
        },
      },
    },
  });
  await writeFile(join(user, ".claude.json"), JSON.stringify(global()));
  const launch = () =>
    loadLaunchConfiguration(parseOptions([]), {
      cwd,
      env,
      homeDirectory: home,
      nonInteractive: false,
      workspaceTrustAccepted: true,
    });
  const load = (resolved: Awaited<ReturnType<typeof launch>>) =>
    loadLaunchMcp({
      cwd,
      launch: resolved,
      env,
      specs: [],
      strict: false,
      nonInteractive: false,
      bypassPermissions: false,
      signal: new AbortController().signal,
    });
  const untracked = await launch();
  assert.equal(untracked.model, "canonical");
  assert.equal(untracked.workspace.projectKey, repo);
  assert.equal(untracked.snapshot.roots.project, cwd);
  assert.equal(untracked.snapshot.roots.local, repo);
  assert.equal(untracked.snapshot.roots.legacyLocal, cwd);
  assert.deepEqual(
    untracked.snapshot.permissionRules.map((rule) => [
      rule.source,
      rule.behavior,
      rule.rule,
    ]),
    [
      ["projectSettings", "deny", "Bash"],
      ["localSettings", "allow", "Read"],
      ["localSettings", "allow", "Write"],
    ],
  );
  assert.equal(untracked.workspace.localMcpApprovalTrusted, true);
  assert.deepEqual(Object.keys((await load(untracked)).configs).sort(), [
    "local",
    "project",
  ]);
  await git("add", ".claude/settings.local.json");
  const tracked = await launch();
  assert.equal(tracked.model, "canonical"); // Tracking gates grants, not the settings document.
  assert.equal(tracked.workspace.localTracking.status, "tracked_in_index");
  assert.deepEqual(
    tracked.snapshot.permissionRules.map((rule) => rule.rule),
    ["Bash"],
  );
  const pending = await load(tracked);
  assert.deepEqual(Object.keys(pending.configs), ["local"]);
  assert.deepEqual(pending.resolution.pendingProjectNames, ["project"]);
  await writeFile(join(user, ".claude.json"), JSON.stringify(global(true)));
  const persisted = await launch();
  assert.equal(persisted.workspace.persistedWorkspaceTrusted, true);
  assert.equal(persisted.workspace.localMcpApprovalTrusted, false);
  assert.deepEqual(
    persisted.snapshot.permissionRules.map((rule) => rule.rule),
    ["Edit", "Bash", "Read", "Write"],
  );
  assert.deepEqual(Object.keys((await load(persisted)).configs).sort(), [
    "local",
    "project",
  ]);
});

test("interactive trust does not inherit print acceptance, and an ancestor record is not strict persisted project trust", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-workspace-trust-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo/subdir"),
    user = join(root, "user"),
    home = join(root, "home"),
    managed = join(root, "managed");
  for (const directory of [join(cwd, ".claude"), user, home, managed])
    await mkdir(directory, { recursive: true });
  await writeFile(
    join(cwd, ".claude/settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Write"] } }),
  );
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: user,
    TAU_MANAGED_ROOT: managed,
  };
  const run = (nonInteractive: boolean) =>
    loadLaunchConfiguration(parseOptions([]), {
      cwd,
      env,
      homeDirectory: home,
      nonInteractive,
    });
  assert.equal((await run(false)).workspace.currentWorkspaceTrusted, false);
  assert.equal((await run(false)).snapshot.permissionRules.length, 0);
  const print = await run(true);
  assert.equal(print.workspace.currentWorkspaceTrusted, true);
  assert.equal(print.workspace.persistedWorkspaceTrusted, false);
  assert.equal(print.workspace.localPermissionAllowsAdmitted, true);
  assert.equal(print.workspace.localMcpApprovalTrusted, false);
  assert.deepEqual(
    print.snapshot.permissionRules.map((rule) => rule.rule),
    ["Write"],
  );
  await writeFile(
    join(user, ".claude.json"),
    JSON.stringify({
      projects: { [join(root, "repo")]: { hasTrustDialogAccepted: true } },
    }),
  );
  const ancestor = await run(false);
  assert.equal(ancestor.workspace.currentWorkspaceTrusted, true);
  assert.equal(ancestor.workspace.persistedWorkspaceTrusted, false);
  assert.equal(ancestor.workspace.projectPermissionAllowsAdmitted, false);
});
