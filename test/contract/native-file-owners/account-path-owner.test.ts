import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  createNativeAccountPathOwner,
  nativeCredentialPathGroups,
  nativeProfileStoreDirectory,
  type NativeAccountPathContext,
  type NativeAccountPathReaders,
  type NativeProfileEnvironment,
  type NativeProfileIo,
} from "../../../src/native-file-owners/account-path-owner.js";
import type {
  NativePermissionFact,
  NativePermissionScope,
} from "../../../src/native-permission-outcome.js";

function owned(
  run: (context: {
    root: string;
    work: string;
    home: string;
    environment: NativeProfileEnvironment;
    context: NativeAccountPathContext;
    scope: NativePermissionScope;
    readers: NativeAccountPathReaders;
    reads: string[];
  }) => void,
) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-profile-owner-")),
  );
  const work = posix.join(root, "work");
  const home = posix.join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
  const scope = { policyId: "owned-profile-policy", cwd: work };
  const environment: NativeProfileEnvironment = { HOME: home };
  const context: NativeAccountPathContext = {
    diskless: false,
    configDirectory: posix.join(home, ".claude"),
    configHome: posix.join(home, ".claude"),
    homeDirectory: home,
    environment,
  };
  const reads: string[] = [];
  const fact = <T>(value: T): NativePermissionFact<T> => ({
    status: "known",
    value,
    provenance: {
      provider: "owned-profile-data-driver",
      sourceContracts: ["owned-temp-profile-state"],
      scope,
    },
  });
  function io<T>(
    path: string,
    operation: () => T,
  ): NativePermissionFact<NativeProfileIo<T>> {
    assert.ok(
      path === root || path.startsWith(root + "/"),
      "Only owned fixture state may be read",
    );
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
  const readers: NativeAccountPathReaders = {
    context: () => fact(context),
    realpath: (path) => io(path, () => realpathSync.native(path)),
    isDirectory: (path) => io(path, () => lstatSync(path).isDirectory()),
    readText(path) {
      reads.push(path);
      return io(path, () => readFileSync(path, "utf8"));
    },
  };
  try {
    run({ root, work, home, environment, context, scope, readers, reads });
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("M uses actual env precedence and never infers profile absence from API-key mode", () =>
  owned(({ context, environment, home }) => {
    assert.equal(
      nativeProfileStoreDirectory(context),
      posix.join(home, ".config/anthropic"),
    );
    environment.XDG_CONFIG_HOME = " /explicit/xdg ";
    assert.equal(
      nativeProfileStoreDirectory(context),
      "/explicit/xdg/anthropic",
    );
    environment.ANTHROPIC_CONFIG_DIR = " ./explicit/profile ";
    assert.equal(nativeProfileStoreDirectory(context), "./explicit/profile");
    context.diskless = true;
    assert.equal(nativeProfileStoreDirectory(context), null);
  }));

test("uC/rwn preserve secure override emptiness, NFC and exact token/device/lock roots", () =>
  owned(({ context, environment, home }) => {
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
    let groups = nativeCredentialPathGroups(context);
    assert.deepEqual(groups[0]?.paths, [
      posix.join(home, ".claude/.credentials.json"),
    ]);
    assert.deepEqual(groups[1]?.paths, [
      posix.join(home, ".claude/.device-keys.json"),
    ]);
    assert.deepEqual(groups[2]?.paths, [
      posix.join(home, ".claude/.storage-write.lock"),
    ]);
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = "./secure-e\u0301";
    groups = nativeCredentialPathGroups(context);
    assert.ok(groups[0]?.paths.includes("secure-é/.credentials.json"));
  }));

test("actual absent owned profile files still produce a protected store and a complete cache", () =>
  owned(({ readers, scope, home, reads }) => {
    const owner = createNativeAccountPathOwner(readers);
    const first = owner.profile(scope);
    if (first.status !== "known") assert.fail(first.reason);
    assert.deepEqual(first.value.value, {
      directories: [posix.join(home, ".config/anthropic")],
      files: [],
    });
    assert.equal(first.value.complete, true);
    assert.equal(first.value.cacheHit, false);
    assert.equal(reads.length, 2);
    const second = owner.profile(scope);
    if (second.status !== "known") assert.fail(second.reason);
    assert.equal(second.value.cacheHit, true);
    assert.equal(reads.length, 2);
  }));

test("store containing cwd narrows protected dirs and includes both actual relative credential spellings", () =>
  owned(({ root, environment, readers, scope, work }) => {
    environment.ANTHROPIC_CONFIG_DIR = root;
    mkdirSync(posix.join(root, "configs"));
    writeFileSync(
      posix.join(root, "configs/default.json"),
      JSON.stringify({
        authentication: { credentials_path: "external-token.json" },
      }),
    );
    const result = createNativeAccountPathOwner(readers).profile(scope);
    if (result.status !== "known") assert.fail(result.reason);
    assert.deepEqual(result.value.value, {
      directories: [
        posix.join(root, "configs"),
        posix.join(root, "credentials"),
      ],
      files: [
        posix.join(root, "active_config"),
        posix.join(root, "external-token.json"),
        posix.join(work, "external-token.json"),
      ],
    });
  }));

test("unavailable file owners remain unsupported while actual EIO follows only the native incomplete fallback", () =>
  owned(({ readers, scope, home }) => {
    const unavailable = createNativeAccountPathOwner({
      ...readers,
      readText: () => ({
        status: "unsupported",
        dependency: "actual-profile-file-owner",
        reason: "Owned file data has not been materialized",
      }),
    }).profile(scope);
    assert.equal(unavailable.status, "unsupported");
    if (unavailable.status === "unsupported")
      assert.equal(unavailable.dependency, "actual-profile-file-owner");
    const errorOwner = createNativeAccountPathOwner({
      ...readers,
      readText: (_path, _purpose, input) => ({
        status: "known",
        value: { kind: "error", code: "EIO" },
        provenance: {
          provider: "actual-io-error",
          sourceContracts: ["g/actual-error"],
          scope: input,
        },
      }),
    });
    const error = errorOwner.profile(scope);
    if (error.status !== "known") assert.fail(error.reason);
    assert.equal(error.value.complete, false);
    assert.deepEqual(error.value.value?.directories, [
      posix.join(home, ".config/anthropic"),
    ]);
    const retry = errorOwner.profile(scope);
    if (retry.status !== "known") assert.fail(retry.reason);
    assert.equal(retry.value.cacheHit, false);
  }));

test("actual primed files avoid text reads and preserve selected-profile credential references", () =>
  owned(({ root, context, readers, scope, reads }) => {
    const store = posix.join(root, "profiles");
    context.environment = { ANTHROPIC_CONFIG_DIR: store };
    context.primedFiles = new Map([
      [posix.join(store, "active_config"), "chosen"],
      [
        posix.join(store, "configs/chosen.json"),
        JSON.stringify({
          authentication: {
            credentials_path: posix.join(root, "external.json"),
          },
        }),
      ],
    ]);
    const result = createNativeAccountPathOwner(readers).profile(scope);
    if (result.status !== "known") assert.fail(result.reason);
    assert.deepEqual(result.value.value?.files, [
      posix.join(root, "external.json"),
    ]);
    assert.deepEqual(reads, []);
  }));

test("complete native realm cache persists until explicit host-realm reset", () =>
  owned(({ root, environment, readers, scope }) => {
    const owner = createNativeAccountPathOwner(readers);
    const first = owner.profile(scope);
    if (first.status !== "known") assert.fail(first.reason);
    environment.ANTHROPIC_CONFIG_DIR = posix.join(root, "another-profile");
    const cached = owner.profile(scope);
    if (cached.status !== "known") assert.fail(cached.reason);
    assert.deepEqual(cached.value.value, first.value.value);
    owner.resetHostRealm();
    const next = owner.profile(scope);
    if (next.status !== "known") assert.fail(next.reason);
    assert.notDeepEqual(next.value.value, first.value.value);
  }));

test("profile containment uses actual physical ancestors and lstat directory semantics", () =>
  owned(({ root, work, context, readers, scope }) => {
    const alias = posix.join(root, "profile-alias");
    symlinkSync(root, alias);
    const tokenDirectory = posix.join(work, "token-directory");
    mkdirSync(tokenDirectory);
    const tokenAlias = posix.join(work, "token-alias");
    symlinkSync(tokenDirectory, tokenAlias);
    context.environment = { ANTHROPIC_CONFIG_DIR: alias };
    context.primedFiles = new Map([
      [posix.join(alias, "active_config"), "chosen"],
      [
        posix.join(alias, "configs/chosen.json"),
        JSON.stringify({ authentication: { credentials_path: tokenAlias } }),
      ],
    ]);
    const result = createNativeAccountPathOwner(readers).profile(scope);
    if (result.status !== "known") assert.fail(result.reason);
    assert.deepEqual(result.value.value, {
      directories: [
        posix.join(alias, "configs"),
        posix.join(alias, "credentials"),
      ],
      files: [posix.join(alias, "active_config"), tokenAlias],
    });
  }));

test("metadata owner refusal is never converted to a native filesystem fallback", () =>
  owned(({ root, context, readers, scope }) => {
    const unavailable: NativePermissionFact<NativeProfileIo<string>> = {
      status: "unsupported",
      dependency: "real-profile-identity",
      reason: "No admitted identity owner",
    };
    const failed = createNativeAccountPathOwner({
      ...readers,
      realpath: () => unavailable,
    }).profile(scope);
    assert.equal(failed.status, "unsupported");
    if (failed.status === "unsupported")
      assert.equal(failed.dependency, "real-profile-identity");
    const store = posix.join(root, "profiles");
    context.environment = { ANTHROPIC_CONFIG_DIR: store };
    context.primedFiles = new Map([
      [posix.join(store, "active_config"), "chosen"],
      [
        posix.join(store, "configs/chosen.json"),
        JSON.stringify({
          authentication: {
            credentials_path: posix.join(root, "external.json"),
          },
        }),
      ],
    ]);
    const rejected = createNativeAccountPathOwner({
      ...readers,
      isDirectory: () => ({
        status: "unsupported",
        dependency: "profile-lstat-owner",
        reason: "No admitted lstat owner",
      }),
    }).profile(scope);
    assert.equal(rejected.status, "unsupported");
    if (rejected.status === "unsupported")
      assert.equal(rejected.dependency, "profile-lstat-owner");
  }));

test("actual nonmissing realpath errors walk ancestors while native text errors stay selective", () =>
  owned(({ root, context, readers, scope }) => {
    context.environment = {
      ANTHROPIC_CONFIG_DIR: posix.join(root, "profiles"),
    };
    let realpathCalls = 0;
    const owner = createNativeAccountPathOwner({
      ...readers,
      realpath(path, input) {
        realpathCalls++;
        return path.endsWith("/profiles")
          ? {
              status: "known",
              value: { kind: "error", code: "EIO" },
              provenance: {
                provider: "actual-realpath-error",
                sourceContracts: ["L/catch-all-ancestor"],
                scope: input,
              },
            }
          : readers.realpath(path, input);
      },
    });
    const projected = owner.profile(scope);
    if (projected.status !== "known") assert.fail(projected.reason);
    assert.equal(projected.value.complete, true);
    assert.ok(realpathCalls >= 2);
  }));

test("host credential path uses actual typed N.str while raw secure/profile environment spellings remain separate", () =>
  owned(({ root, environment, context, readers, scope }) => {
    context.diskless = true;
    const path = posix.join(root, "host-creds.json");
    environment.CLAUDE_CODE_HOST_CREDS_FILE = " \t" + path + " \n";
    const owner = createNativeAccountPathOwner(readers);
    const selected = owner.account(scope);
    if (selected.status !== "known") assert.fail(selected.reason);
    assert.equal(selected.value.hostCredentialsPath, path);
    environment.CLAUDE_CODE_HOST_CREDS_FILE = " \t\n ";
    const empty = owner.account(scope);
    if (empty.status !== "known") assert.fail(empty.reason);
    assert.equal(empty.value.hostCredentialsPath, null);
    context.diskless = false;
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = " raw-secure-root ";
    assert.ok(
      nativeCredentialPathGroups(context)[0]?.paths.includes(
        " raw-secure-root /.credentials.json",
      ),
    );
    environment.ANTHROPIC_CONFIG_DIR = " ./raw-profile ";
    assert.equal(nativeProfileStoreDirectory(context), "./raw-profile");
  }));
