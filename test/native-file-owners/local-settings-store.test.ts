import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  createNativeLocalSettingsStore,
  type NativeLocalStoreContext,
  type NativeLocalStoreReaders,
} from "../../src/native-file-owners/local-settings-store.js";
import type { NativeProfileIo } from "../../src/native-file-owners/account-path-owner.js";
import type {
  NativePermissionFact,
  NativePermissionScope,
} from "../../src/native-permission-outcome.js";

function owned(
  run: (input: {
    root: string;
    repository: string;
    work: string;
    home: string;
    context: NativeLocalStoreContext;
    readers: NativeLocalStoreReaders;
    scope: NativePermissionScope;
    calls: string[];
    fact: <T>(value: T) => NativePermissionFact<T>;
  }) => void,
) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-local-settings-owner-")),
  );
  const repository = posix.join(root, "repository");
  const work = posix.join(repository, "child");
  const home = posix.join(root, "home");
  mkdirSync(work, { recursive: true });
  mkdirSync(home);
  mkdirSync(posix.join(repository, ".git"));
  const scope = { policyId: "owned-settings-epoch", cwd: work };
  const uid = statSync(repository).uid;
  const context: NativeLocalStoreContext = {
    configDirectory: posix.join(home, ".claude"),
    homeDirectory: home,
    cwd: work,
    projectConfigDir: undefined,
    launchsLocalSettingsStoreRoot: undefined,
    flagPath: undefined,
    getuid: uid,
    geteuid: uid,
  };
  const fact = <T>(value: T): NativePermissionFact<T> => ({
    status: "known",
    value,
    provenance: {
      provider: "owned-local-store-facts",
      sourceContracts: ["owned-settings-fixture"],
      scope,
    },
  });
  const calls: string[] = [];
  function io<T>(
    path: string,
    operation: () => T,
  ): NativePermissionFact<NativeProfileIo<T>> {
    assert.ok(
      path === root || path.startsWith(root + "/"),
      "Only owned metadata may be inspected",
    );
    calls.push(path);
    try {
      return fact({ kind: "value", value: operation() });
    } catch (error) {
      return fact({
        kind: "error",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined,
      });
    }
  }
  const readers: NativeLocalStoreReaders = {
    context: () => fact(context),
    canonicalGitRoot: () => fact(repository),
    realpath: (path) => io(path, () => realpathSync.native(path)),
    statUid: (path, follow) =>
      io(path, () => (follow ? statSync(path) : lstatSync(path)).uid),
  };
  try {
    run({ root, repository, work, home, context, readers, scope, calls, fact });
  } finally {
    rmSync(root, { recursive: true });
  }
}

function known<T>(fact: NativePermissionFact<T>): T {
  if (fact.status !== "known") assert.fail(fact.reason);
  return fact.value;
}

test("native local store adopts same-owner Gitroot but source-rule roots remain settings cwd", () =>
  owned(({ repository, work, readers, scope, calls }) => {
    const owner = createNativeLocalSettingsStore(readers);
    assert.equal(known(owner.base("localSettings", scope)), repository);
    assert.equal(known(owner.ruleRoot("localSettings", scope)), work);
    assert.equal(known(owner.ruleRoot("projectSettings", scope)), work);
    assert.equal(known(owner.legacyLocalRoot(scope)), work);
    assert.ok(calls.includes(posix.join(repository, ".git")));
    assert.ok(calls.includes(posix.join(repository, ".claude")));
  }));

test("native followed root and lstat entry ownership facts stay distinct", () =>
  owned(({ root, repository, readers, scope }) => {
    const target = posix.join(root, "claude-directory");
    mkdirSync(target);
    symlinkSync(target, posix.join(repository, ".claude"));
    const flags: { path: string; follow: boolean }[] = [];
    const owner = createNativeLocalSettingsStore({
      ...readers,
      statUid(path, follow, input) {
        flags.push({ path, follow });
        return readers.statUid(path, follow, input);
      },
    });
    assert.equal(known(owner.base("localSettings", scope)), repository);
    assert.deepEqual(flags, [
      { path: posix.join(repository, ".claude"), follow: false },
      { path: repository, follow: true },
      { path: posix.join(repository, ".git"), follow: false },
    ]);
  }));

test("home repository and actual unavailable home metadata keep consent store at cwd", () =>
  owned(({ repository, work, context, readers, scope, fact }) => {
    context.homeDirectory = repository;
    assert.equal(
      known(
        createNativeLocalSettingsStore(readers).base("localSettings", scope),
      ),
      work,
    );
    context.homeDirectory = posix.join(repository, "absent-home");
    assert.equal(
      known(
        createNativeLocalSettingsStore(readers).base("localSettings", scope),
      ),
      work,
    );
    const unavailable = createNativeLocalSettingsStore({
      ...readers,
      realpath: () => ({
        status: "unsupported",
        dependency: "admitted-home-owner",
        reason: "No real home observation",
      }),
    }).base("localSettings", scope);
    assert.equal(unavailable.status, "unsupported");
    if (unavailable.status === "unsupported")
      assert.equal(unavailable.dependency, "admitted-home-owner");
    assert.equal(
      known(
        createNativeLocalSettingsStore({
          ...readers,
          canonicalGitRoot: () => fact(undefined),
        }).base("localSettings", scope),
      ),
      work,
    );
  }));

test("unknown UID semantics, mismatched entries and actual non-ENOENT claude errors refuse canonicalization", () =>
  owned(({ repository, work, context, readers, scope, fact }) => {
    context.getuid = undefined;
    context.geteuid = undefined;
    assert.equal(
      known(
        createNativeLocalSettingsStore(readers).base("localSettings", scope),
      ),
      work,
    );
    context.getuid = statSync(repository).uid;
    context.geteuid = context.getuid + 1;
    assert.equal(
      known(
        createNativeLocalSettingsStore(readers).base("localSettings", scope),
      ),
      work,
    );
    context.geteuid = context.getuid;
    const error = createNativeLocalSettingsStore({
      ...readers,
      statUid(path, follow, input) {
        return path.endsWith("/.claude")
          ? fact({ kind: "error", code: "EACCES" })
          : readers.statUid(path, follow, input);
      },
    });
    assert.equal(known(error.base("localSettings", scope)), work);
    assert.equal(error.hasCanonicalRootOwnerUids(repository), false);
  }));

test("complete UID probes remain cached until exact owner cache reset", () =>
  owned(({ repository, work, context, readers, scope, calls, fact }) => {
    let mismatch = false;
    const owner = createNativeLocalSettingsStore({
      ...readers,
      statUid(path, follow, input) {
        return mismatch
          ? fact({ kind: "value", value: (context.getuid ?? 0) + 1 })
          : readers.statUid(path, follow, input);
      },
    });
    assert.equal(known(owner.base("localSettings", scope)), repository);
    const observed = calls.length;
    mismatch = true;
    assert.equal(known(owner.base("localSettings", scope)), repository);
    assert.equal(calls.length, observed);
    owner.clearCanonicalRootOwnerUids();
    assert.equal(known(owner.base("localSettings", scope)), work);
    assert.equal(owner.hasCanonicalRootOwnerUids(repository), true);
    assert.equal(
      owner.primeCanonicalRootOwnerUids(
        repository,
        fact({
          rootUid: context.getuid ?? 0,
          gitEntryUid: context.getuid ?? 0,
          claudeEntryUid: null,
        }),
        scope,
      ),
      false,
    );
  }));

test("launch local root retains raw empty spelling and legacy root stays separate", () =>
  owned(({ work, context, readers, scope }) => {
    context.launchsLocalSettingsStoreRoot = "";
    const owner = createNativeLocalSettingsStore(readers);
    assert.equal(known(owner.base("localSettings", scope)), "");
    assert.equal(known(owner.legacyLocalRoot(scope)), work);
    context.projectConfigDir = "./explicit-project";
    assert.equal(
      known(owner.base("projectSettings", scope)),
      posix.join(work, "explicit-project"),
    );
    assert.equal(known(owner.ruleRoot("projectSettings", scope)), work);
    context.launchsLocalSettingsStoreRoot = undefined;
    assert.equal(known(owner.legacyLocalRoot(scope)), null);
  }));

test("BPn preserves flag truthiness and user relative-config versus required-cwd gates", () =>
  owned(({ work, context, readers, scope }) => {
    const owner = createNativeLocalSettingsStore(readers);
    context.configDirectory = "";
    assert.equal(known(owner.base("userSettings", scope)), work);
    context.flagPath = "";
    assert.equal(known(owner.base("flagSettings", scope)), work);
    context.flagPath = " ./named-flags/settings.json ";
    assert.equal(
      known(owner.base("flagSettings", scope)),
      posix.join(work, " ./named-flags"),
    );
    context.cwd = null;
    assert.equal(owner.base("policySettings", scope).status, "unsupported");
    assert.equal(known(owner.base("userSettings", scope)), work);
  }));
