import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  classifyLocalSettingsGitProbe,
  inspectWorkspaceConfiguration,
  type WorkspaceConfigurationOptions,
} from "../../src/workspace-configuration.js";

async function scratch() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "tau-workspace-edges-")),
  );
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  await mkdir(home);
  const inspect = (
    cwd: string,
    extra: Partial<WorkspaceConfigurationOptions> = {},
  ) =>
    inspectWorkspaceConfiguration({
      cwd,
      configDirectory: join(home, ".claude"),
      homeDirectory: home,
      gitExecutable: null,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      ...extra,
    });
  const directory = async (...parts: string[]) => {
    const path = join(base, ...parts);
    await mkdir(path, { recursive: true });
    return path;
  };
  return { base, inspect, directory };
}

/** A minimal on-disk Git directory: HEAD plus objects and refs. */
async function gitDirectoryAt(path: string, head = "ref: refs/heads/main\n") {
  await mkdir(join(path, "objects"), { recursive: true });
  await mkdir(join(path, "refs"), { recursive: true });
  await writeFile(join(path, "HEAD"), head);
}

test("a .git symlink marks a repository root only when its target is a usable file or directory", async () => {
  const { base, inspect, directory } = await scratch();
  const realGit = await directory("store", "real.git");
  const toDirectory = await directory("to-directory");
  await symlink(realGit, join(toDirectory, ".git"));
  assert.equal((await inspect(toDirectory)).gitRoot, toDirectory);

  const marker = join(base, "store", "marker");
  await writeFile(marker, "gitdir: elsewhere\n");
  const toFile = await directory("to-file");
  await symlink(marker, join(toFile, ".git"));
  assert.equal((await inspect(toFile)).gitRoot, toFile);

  const dangling = await directory("dangling");
  await symlink(join(base, "missing"), join(dangling, ".git"));
  assert.equal((await inspect(dangling)).gitRoot, null);

  // A target that cannot even be inspected (ENAMETOOLONG) is never a marker.
  const unusable = await directory("unusable");
  await symlink(join(base, "x".repeat(300)), join(unusable, ".git"));
  const result = await inspect(unusable, { workspaceTrustAccepted: true });
  assert.equal(result.gitRoot, null);
  // The bare-repository scan treats that unresolvable marker as unsafe.
  assert.equal(result.localTracking.status, "tracked");
  assert.equal(result.localTracking.reason, "unsafe-local-path-or-repository");
});

test("a worktree of a bare repository takes the bare repository's identity", async () => {
  const { inspect, directory } = await scratch();
  const store = await directory("project-store");
  await gitDirectoryAt(store);
  const gitDir = await directory("project-store", "worktrees", "wt");
  const worktree = await directory("wt");
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, "commondir"), "../..\n");
  await writeFile(join(gitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  const result = await inspect(worktree);
  assert.equal(result.gitRoot, worktree);
  assert.equal(result.canonicalGitRoot, store);
  assert.equal(result.projectKey, store);

  // A common directory that is itself a checkout is not a bare repository.
  await writeFile(join(store, ".git"), "gitdir: elsewhere\n");
  assert.equal((await inspect(worktree)).canonicalGitRoot, worktree);
});

test("a gitdir pointer without a complete, consistent worktree layout keeps the checkout identity", async () => {
  const { base, inspect, directory } = await scratch();
  const cases: Array<
    [string, (gitDir: string, root: string) => Promise<void>]
  > = [
    // Target directory exists but has no commondir/gitdir files.
    ["no-metadata", async () => {}],
    // commondir does not place the gitdir under <common>/worktrees.
    [
      "wrong-layout",
      async (gitDir, root) => {
        await writeFile(join(gitDir, "commondir"), ".\n");
        await writeFile(join(gitDir, "gitdir"), join(root, ".git"));
      },
    ],
    // POSIX paths containing backslashes are refused.
    [
      "backslash",
      async (gitDir) => {
        await writeFile(join(gitDir, "commondir"), "../..\n");
        await writeFile(join(gitDir, "gitdir"), "C:\\elsewhere\\.git");
      },
    ],
  ];
  for (const [name, prepare] of cases) {
    const gitDir = await directory("main.git", "worktrees", name);
    const root = await directory(name);
    await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`);
    await prepare(gitDir, root);
    const result = await inspect(root);
    assert.equal(result.gitRoot, root, name);
    assert.equal(result.canonicalGitRoot, root, name);
  }
  const unusable = await directory("unusable-target");
  await writeFile(
    join(unusable, ".git"),
    `gitdir: ${join(base, "y".repeat(300))}\n`,
  );
  assert.equal((await inspect(unusable)).canonicalGitRoot, unusable);
});

test("ancestor trust outside a repository applies to nested directories", async () => {
  const { base, inspect, directory } = await scratch();
  const cwd = await directory("plain", "nested");
  const untrusted = await inspect(cwd);
  assert.equal(untrusted.currentWorkspaceTrusted, false);
  assert.equal(untrusted.localTracking.reason, "workspace-untrusted");
  const trusted = await inspect(cwd, {
    trustedProjectKeys: [join(base, "plain")],
  });
  assert.equal(trusted.persistedWorkspaceTrusted, false);
  assert.equal(trusted.currentWorkspaceTrusted, true);
});

test("without Git, a safe trusted workspace's local settings count as untracked", async () => {
  const { inspect, directory } = await scratch();
  const cwd = await directory("no-git");
  const result = await inspect(cwd, { workspaceTrustAccepted: true });
  assert.equal(result.localTracking.status, "untracked");
  assert.equal(result.localMcpApprovalTrusted, true);
  assert.equal(result.localPermissionAllowsAdmitted, true);
});

test("a project config root override is the only tracking root checked", async () => {
  const { inspect, directory } = await scratch();
  const cwd = await directory("cwd");
  const project = await directory("project");
  const result = await inspect(cwd, {
    projectConfigRoot: project,
    workspaceTrustAccepted: true,
  });
  assert.deepEqual(result.localTracking.checkedRoots, [project]);
  assert.equal(result.localStore?.reason, "project-override");
});

test("directories that look like bare Git repositories are unsafe local stores", async () => {
  const { base, inspect, directory } = await scratch();
  const status = async (cwd: string) => {
    const result = await inspect(cwd, { workspaceTrustAccepted: true });
    assert.equal(result.gitRoot, null);
    return result.localTracking.status;
  };
  const symbolicHead = await directory("symbolic-head");
  await gitDirectoryAt(symbolicHead);
  await rm(join(symbolicHead, "HEAD"));
  await symlink("refs/heads/main", join(symbolicHead, "HEAD"));
  assert.equal(await status(symbolicHead), "tracked");

  const detached = await directory("detached");
  await gitDirectoryAt(detached, `${"a".repeat(40)}\n`);
  assert.equal(await status(detached), "tracked");

  const linked = await directory("linked-metadata");
  await writeFile(join(linked, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(linked, "commondir"), "..\n");
  assert.equal(await status(linked), "tracked");

  const foreignHead = await directory("foreign-head");
  await gitDirectoryAt(foreignHead);
  await rm(join(foreignHead, "HEAD"));
  await symlink(join(base, "elsewhere"), join(foreignHead, "HEAD"));
  assert.equal(await status(foreignHead), "untracked");

  const headDirectory = await directory("head-directory");
  for (const name of ["HEAD", "objects", "refs"])
    await mkdir(join(headDirectory, name));
  assert.equal(await status(headDirectory), "untracked");
});

test("an ordinary .git directory stops the bare-repository scan only when it is a complete Git directory", async () => {
  const { inspect, directory } = await scratch();
  const complete = await directory("complete");
  await gitDirectoryAt(join(complete, ".git"));
  assert.equal(
    (await inspect(complete, { workspaceTrustAccepted: true })).localTracking
      .status,
    "untracked",
  );

  // An incomplete .git (objects is a file) does not stop the scan, so the
  // bare-looking parent below it is still found.
  const parent = await directory("bare-parent");
  await writeFile(join(parent, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(parent, "commondir"), "..\n");
  const child = await directory("bare-parent", "child");
  await mkdir(join(child, ".git", "refs"), { recursive: true });
  await writeFile(join(child, ".git", "objects"), "");
  await writeFile(join(child, ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.equal(
    (await inspect(child, { workspaceTrustAccepted: true })).localTracking
      .status,
    "tracked",
  );
});

test("a .git symlink to a complete Git directory is a safe repository marker", async () => {
  const { inspect, directory } = await scratch();
  const store = await directory("linked-store");
  await gitDirectoryAt(store);
  const cwd = await directory("linked-checkout");
  await symlink(store, join(cwd, ".git"));
  const result = await inspect(cwd, { workspaceTrustAccepted: true });
  assert.equal(result.gitRoot, cwd);
  assert.equal(result.localTracking.status, "untracked");
});

test("an excluded Git directory is neither a root nor a safe store", async () => {
  const { inspect, directory } = await scratch();
  const cwd = await directory("excluded");
  await gitDirectoryAt(join(cwd, ".git"));
  const result = await inspect(cwd, {
    workspaceTrustAccepted: true,
    excludedGitDirectories: [cwd],
  });
  assert.equal(result.gitRoot, null);
  assert.equal(result.localTracking.status, "tracked");
});

test("a missing cwd below a symlink is unsafe, while a plain missing cwd is not", async () => {
  const { base, inspect, directory } = await scratch();
  const target = await directory("target");
  await symlink(join(base, "gone"), join(target, "alias"));
  const below = await inspect(join(target, "alias", "missing"), {
    workspaceTrustAccepted: true,
  });
  assert.equal(below.localTracking.status, "tracked");
  const plain = await inspect(join(base, "missing", "deeper"), {
    workspaceTrustAccepted: true,
  });
  assert.equal(plain.localTracking.status, "untracked");
});

test("an indeterminate root does not soften another root already found tracked", async () => {
  const { base, inspect, directory } = await scratch();
  const project = await directory("tracked-project");
  await mkdir(join(project, ".claude"));
  await symlink(
    join(base, "anywhere"),
    join(project, ".claude", "settings.local.json"),
  );
  const store = await directory("plain-store");
  // On its own the plain store is indeterminate: Git finds no repository there.
  assert.equal(
    (
      await inspect(store, {
        workspaceTrustAccepted: true,
        gitExecutable: "git",
      })
    ).localTracking.status,
    "indeterminate",
  );
  const result = await inspect(project, {
    workspaceTrustAccepted: true,
    launchLocalSettingsStoreRoot: store,
    gitExecutable: "git",
  });
  assert.deepEqual(result.localTracking.checkedRoots, [project, store]);
  assert.equal(result.localTracking.status, "tracked");
  assert.equal(result.localMcpApprovalTrusted, false);
});

test("a Git probe launch error without an error code counts as tracked", () => {
  assert.equal(
    classifyLocalSettingsGitProbe({
      status: null,
      signal: null,
      error: new Error("spawn failed"),
      stderr: "",
    }),
    "tracked",
  );
});

test("an unreadable .claude directory makes the local store unsafe", async () => {
  const { inspect, directory } = await scratch();
  const cwd = await directory("locked");
  const claude = await directory("locked", ".claude");
  await chmod(claude, 0o000);
  const result = await inspect(cwd, { workspaceTrustAccepted: true }).finally(
    () => chmod(claude, 0o700),
  );
  assert.equal(result.localTracking.status, "tracked");
  assert.equal(result.localTracking.reason, "unsafe-local-path-or-repository");
});
