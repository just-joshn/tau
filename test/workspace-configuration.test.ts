import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  classifyLocalSettingsGitProbe,
  inspectWorkspaceConfiguration,
  selectLocalSettingsStoreRoot,
  type WorkspaceConfigurationOptions,
} from "../src/workspace-configuration.js";

async function fixture(
  run: (base: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  const base = await realpath(
      await mkdtemp(join(tmpdir(), "tau-workspace-config-")),
    ),
    home = join(base, "home");
  await mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  try {
    await run(base, env);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", ...args],
    { cwd, env, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
async function repository(
  base: string,
  env: NodeJS.ProcessEnv,
  name = "repo",
): Promise<string> {
  const root = join(base, name);
  await mkdir(root);
  git(root, env, "init", "-q");
  return root;
}
async function localFile(
  root: string,
  name = "settings.local.json",
): Promise<string> {
  const path = join(root, ".claude", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}");
  return path;
}
const inspect = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  extra: Partial<WorkspaceConfigurationOptions> = {},
) =>
  inspectWorkspaceConfiguration({
    cwd,
    configDirectory: join(env.HOME!, ".claude"),
    homeDirectory: env.HOME!,
    env,
    ...extra,
  });

test("plain directory uses cwd settings; trusted Git discovery remains indeterminate", async () =>
  fixture(async (base, env) => {
    const cwd = join(base, "plain");
    await mkdir(cwd);
    const result = await inspect(cwd, env, { workspaceTrustAccepted: true });
    assert.equal(result.gitRoot, null);
    assert.equal(result.projectKey, cwd);
    assert.equal(
      result.localSettingsPath,
      join(cwd, ".claude", "settings.local.json"),
    );
    assert.equal(result.localTracking.status, "indeterminate");
    assert.equal(result.localMcpApprovalTrusted, false);
    assert.equal(result.projectPermissionAllowsAdmitted, false);
    assert.equal(result.localPermissionAllowsAdmitted, true);
  }));
test("untrusted repo local settings cannot seed MCP approval despite being untracked", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env);
    await localFile(root);
    const result = await inspect(root, env);
    assert.equal(result.localTracking.status, "not-probed");
    assert.equal(result.localTracking.reason, "workspace-untrusted");
    assert.equal(result.localMcpApprovalTrusted, false);
    assert.equal(result.projectPermissionAllowsAdmitted, false);
    assert.equal(result.localPermissionAllowsAdmitted, false);
  }));
test("nested cwd keeps project settings path while owned local store and identity canonicalize", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      cwd = join(root, "packages", "app");
    await mkdir(cwd, { recursive: true });
    await localFile(root);
    const result = await inspect(cwd, env, { workspaceTrustAccepted: true });
    assert.equal(result.gitRoot, root);
    assert.equal(result.canonicalGitRoot, root);
    assert.equal(result.projectKey, root);
    assert.equal(
      result.projectSettingsPath,
      join(cwd, ".claude", "settings.json"),
    );
    assert.equal(
      result.localSettingsPath,
      join(root, ".claude", "settings.local.json"),
    );
    assert.equal(
      result.legacyLocalSettingsPath,
      join(cwd, ".claude", "settings.local.json"),
    );
    assert.equal(result.localStore?.reason, "ownership-verified");
    assert.equal(result.localMcpApprovalTrusted, true);
    assert.deepEqual(result.localTracking.checkedRoots, [cwd, root]);
  }));
test("linked worktree identity uses main repo after validating gitdir backlink", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env);
    await writeFile(join(root, "seed"), "fixture");
    git(root, env, "add", "seed");
    git(
      root,
      env,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const worktree = join(base, "worktree");
    git(root, env, "worktree", "add", "--detach", "-q", worktree);
    const cwd = join(worktree, "nested");
    await mkdir(cwd);
    const result = await inspect(cwd, env, { workspaceTrustAccepted: true });
    assert.equal(result.gitRoot, worktree);
    assert.equal(result.canonicalGitRoot, root);
    assert.equal(result.projectKey, root);
    assert.equal(
      result.localSettingsPath,
      join(root, ".claude", "settings.local.json"),
    );
    assert.equal(
      result.projectSettingsPath,
      join(cwd, ".claude", "settings.json"),
    );
    assert.equal(result.localMcpApprovalTrusted, true);
  }));
test("forged worktree backlink cannot borrow another repository identity", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      worktree = join(base, "fake"),
      metadata = join(root, ".git", "worktrees", "fake");
    await mkdir(worktree);
    await mkdir(metadata, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${metadata}\n`);
    await writeFile(join(metadata, "commondir"), "../..\n");
    await writeFile(join(metadata, "gitdir"), join(root, ".git"));
    const result = await inspect(worktree, env);
    assert.equal(result.gitRoot, worktree);
    assert.equal(result.canonicalGitRoot, worktree);
    assert.equal(result.projectKey, worktree);
  }));
test("local storage ownership mismatch, unavailable uid and home root retain cwd", () => {
  const base = {
    cwd: "/fixture/root/nested",
    canonicalGitRoot: "/fixture/root",
    realHomeDirectory: "/fixture/home",
    effectiveUid: 1000,
  };
  assert.equal(
    selectLocalSettingsStoreRoot(base).reason,
    "ownership-unavailable",
  );
  assert.equal(
    selectLocalSettingsStoreRoot({
      ...base,
      ownership: { rootUid: 1000, gitEntryUid: 1001, claudeEntryUid: null },
    }).reason,
    "ownership-mismatch",
  );
  assert.equal(
    selectLocalSettingsStoreRoot({
      ...base,
      effectiveUid: null,
      ownership: { rootUid: 1000, gitEntryUid: 1000, claudeEntryUid: null },
    }).root,
    base.cwd,
  );
  assert.equal(
    selectLocalSettingsStoreRoot({
      ...base,
      realHomeDirectory: base.canonicalGitRoot,
    }).reason,
    "home-root",
  );
  assert.equal(
    selectLocalSettingsStoreRoot({ ...base, realHomeDirectory: null }).reason,
    "home-unavailable",
  );
  assert.equal(
    selectLocalSettingsStoreRoot({
      ...base,
      ownership: { rootUid: 1000, gitEntryUid: 1000, claudeEntryUid: 1000 },
    }).root,
    base.canonicalGitRoot,
  );
});
test("indexed local settings block approval and aggregate root with legacy cwd", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      cwd = join(root, "nested");
    await mkdir(cwd);
    await localFile(root);
    git(root, env, "add", ".claude/settings.local.json");
    const result = await inspect(cwd, env, { workspaceTrustAccepted: true });
    assert.equal(result.localTracking.status, "tracked_in_index");
    assert.equal(result.localMcpApprovalTrusted, false);
    assert.equal(result.localPermissionAllowsAdmitted, false);
    const persisted = await inspect(cwd, env, { trustedProjectKeys: [root] });
    assert.equal(persisted.localPermissionAllowsAdmitted, true);
    assert.equal(persisted.projectPermissionAllowsAdmitted, true);
    assert.equal(persisted.localMcpApprovalTrusted, false);
  }));
test("tracked cwd legacy local settings block an untracked canonical local store", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      cwd = join(root, "nested");
    await mkdir(cwd);
    await localFile(cwd);
    git(root, env, "add", "nested/.claude/settings.local.json");
    const result = await inspect(cwd, env, { workspaceTrustAccepted: true });
    assert.equal(result.localTracking.status, "tracked_in_index");
    assert.equal(result.localMcpApprovalTrusted, false);
  }));
test("a settings file remaining only in the Git index still blocks MCP approval", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      path = await localFile(root);
    git(root, env, "add", ".claude/settings.local.json");
    await unlink(path);
    const result = await inspect(root, env, { workspaceTrustAccepted: true });
    assert.equal(result.localTracking.status, "tracked_in_index");
    assert.equal(result.localMcpApprovalTrusted, false);
  }));
test("Git tracking uses case insensitive local-settings pathspec", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env);
    await localFile(root, "SETTINGS.LOCAL.JSON");
    git(root, env, "add", ".claude/SETTINGS.LOCAL.JSON");
    assert.equal(
      (await inspect(root, env, { workspaceTrustAccepted: true })).localTracking
        .status,
      "tracked_in_index",
    );
  }));
test("symlinked local setting or .claude directory blocks approval before Git lookup", async () =>
  fixture(async (base, env) => {
    for (const kind of ["file", "directory"] as const) {
      const root = await repository(base, env, kind),
        target = join(base, `${kind}-target`);
      if (kind === "file") {
        await mkdir(join(root, ".claude"));
        await writeFile(target, "{}");
        await symlink(target, join(root, ".claude", "settings.local.json"));
      } else {
        await mkdir(target);
        await symlink(target, join(root, ".claude"));
      }
      const result = await inspect(root, env, {
        workspaceTrustAccepted: true,
        gitExecutable: null,
      });
      assert.equal(result.localTracking.status, "tracked");
      assert.equal(result.localMcpApprovalTrusted, false);
    }
  }));
test("nested .claude/.git marker is unsafe even without indexed settings", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env);
    await localFile(root);
    await writeFile(join(root, ".claude", ".git"), "fixture");
    assert.equal(
      (await inspect(root, env, { workspaceTrustAccepted: true })).localTracking
        .status,
      "tracked",
    );
  }));
test("bare repository cannot become a trusted local consent store", async () =>
  fixture(async (base, env) => {
    const bare = join(base, "bare");
    await mkdir(bare);
    git(bare, env, "init", "--bare", "-q");
    const result = await inspect(bare, env, { workspaceTrustAccepted: true });
    assert.equal(result.gitRoot, null);
    assert.equal(result.localTracking.status, "tracked");
    assert.equal(result.localMcpApprovalTrusted, false);
  }));
test("malformed .git file is an identity marker but Git failure blocks approval", async () =>
  fixture(async (base, env) => {
    const root = join(base, "malformed");
    await mkdir(root);
    await writeFile(join(root, ".git"), "not a git directory");
    const result = await inspect(root, env, { workspaceTrustAccepted: true });
    assert.equal(result.gitRoot, root);
    assert.equal(result.localTracking.status, "tracked");
  }));
test("Git overrides cannot redirect local tracking into another repository index", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      other = await repository(base, env, "other");
    await localFile(other);
    git(other, env, "add", ".claude/settings.local.json");
    const result = await inspect(
      root,
      {
        ...env,
        GIT_DIR: join(other, ".git"),
        GIT_WORK_TREE: other,
        GIT_INDEX_FILE: join(other, ".git", "index"),
      },
      { workspaceTrustAccepted: true },
    );
    assert.equal(result.localTracking.status, "untracked");
    assert.equal(result.localMcpApprovalTrusted, true);
  }));
test("home/config alias permits local MCP approval and project=user alias without workspace trust", async () =>
  fixture(async (_base, env) => {
    const result = await inspect(env.HOME!, env);
    assert.equal(result.projectEqualsUserSettings, true);
    assert.equal(result.localMcpApprovalTrusted, true);
    assert.equal(result.localTracking.reason, "user-location-exception");
    assert.equal(result.projectPermissionAllowsAdmitted, true);
    assert.equal(result.localPermissionAllowsAdmitted, true);
    assert.equal(
      (await inspect(env.HOME!, env, { projectConfigRoot: env.HOME! }))
        .localMcpApprovalTrusted,
      false,
    );
  }));
test("project override and launched local root retain distinct settings provenance", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      cwd = join(root, "nested"),
      project = join(base, "project"),
      launched = join(base, "consent");
    await Promise.all([mkdir(cwd), mkdir(project), mkdir(launched)]);
    const result = await inspect(cwd, env, { projectConfigRoot: project });
    assert.equal(result.projectKey, root);
    assert.equal(
      result.projectSettingsPath,
      join(project, ".claude", "settings.json"),
    );
    assert.equal(
      result.localSettingsPath,
      join(project, ".claude", "settings.local.json"),
    );
    assert.equal(result.legacyLocalSettingsPath, undefined);
    const launch = await inspect(cwd, env, {
      projectConfigRoot: project,
      launchLocalSettingsStoreRoot: launched,
    });
    assert.equal(
      launch.localSettingsPath,
      join(launched, ".claude", "settings.local.json"),
    );
    assert.equal(
      launch.legacyLocalSettingsPath,
      join(project, ".claude", "settings.local.json"),
    );
  }));
test("session/ancestor trust remains distinct from direct canonical persisted trust", async () =>
  fixture(async (base, env) => {
    const root = await repository(base, env),
      cwd = join(root, "nested");
    await mkdir(cwd);
    const trusted = await inspect(cwd, env, { trustedProjectKeys: [root] });
    assert.equal(trusted.persistedWorkspaceTrusted, true);
    assert.equal(trusted.currentWorkspaceTrusted, true);
    assert.equal(trusted.localMcpApprovalTrusted, true);
    assert.equal(
      (await inspect(cwd, env, { trustedProjectKeys: [base] }))
        .currentWorkspaceTrusted,
      false,
    );
    assert.equal(
      (
        await inspect(cwd, env, {
          trustedProjectKeys: [root],
          ignorePersistedTrust: true,
        })
      ).currentWorkspaceTrusted,
      false,
    );
    const accepted = await inspect(cwd, env, {
      workspaceTrustAccepted: true,
      ignorePersistedTrust: true,
    });
    assert.equal(accepted.currentWorkspaceTrusted, true);
    assert.equal(accepted.persistedWorkspaceTrusted, false);
    const deeper = join(cwd, "deeper");
    await mkdir(deeper);
    const ancestor = await inspect(deeper, env, { trustedProjectKeys: [cwd] });
    assert.equal(ancestor.persistedWorkspaceTrusted, false);
    assert.equal(ancestor.currentWorkspaceTrusted, true);
    assert.equal(ancestor.localMcpApprovalTrusted, true);
  }));
test("diskless/absent workspace has no local admission but retains user settings path", async () =>
  fixture(async (base, env) => {
    const result = await inspect(base, env, {
      diskless: true,
      workspaceTrustAccepted: true,
    });
    assert.equal(result.localSettingsPath, undefined);
    assert.equal(result.localMcpApprovalTrusted, false);
    assert.equal(result.localTracking.reason, "diskless");
    const missing = await inspectWorkspaceConfiguration({
      cwd: null,
      configDirectory: join(env.HOME!, ".claude"),
    });
    assert.equal(missing.projectKey, null);
    assert.equal(missing.projectSettingsPath, undefined);
    assert.equal(missing.localMcpApprovalTrusted, false);
  }));
test("Git result classifier preserves indeterminate, signal and unsafe error branches", () => {
  const probe = {
    status: 128,
    signal: null,
    stderr:
      "fatal: not a git repository (or any of the parent directories): .git\n",
  };
  assert.equal(classifyLocalSettingsGitProbe(probe), "indeterminate");
  assert.equal(
    classifyLocalSettingsGitProbe({
      ...probe,
      stderr: "fatal: detected dubious ownership",
    }),
    "tracked",
  );
  assert.equal(
    classifyLocalSettingsGitProbe({
      ...probe,
      status: null,
      signal: "SIGTERM",
    }),
    "tracked",
  );
  assert.equal(
    classifyLocalSettingsGitProbe({
      ...probe,
      error: Object.assign(new Error("fixture"), { code: "ENOENT" }),
    }),
    "untracked",
  );
  assert.equal(
    classifyLocalSettingsGitProbe({
      ...probe,
      error: Object.assign(new Error("fixture"), { code: "EACCES" }),
    }),
    "tracked",
  );
  assert.equal(
    classifyLocalSettingsGitProbe({ ...probe, status: 0 }),
    "tracked_in_index",
  );
  assert.equal(
    classifyLocalSettingsGitProbe({ ...probe, status: 1 }),
    "untracked",
  );
  assert.equal(
    classifyLocalSettingsGitProbe({ ...probe, status: 7 }),
    "tracked",
  );
});
