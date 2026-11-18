import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  createNativeSettingsPathOwner,
  type NativeSettingsPathContext,
  type NativeSettingsPathReaders,
} from "../../src/native-file-owners/settings-path-owner.js";
import type {
  NativePermissionFact,
  NativePermissionScope,
} from "../../src/native-permission-outcome.js";
import type { NativeProfileIo } from "../../src/native-file-owners/account-path-owner.js";
import { nativeLocalPermissionPathFilesystem } from "../../src/native-path-inspection.js";

function owned(
  run: (input: {
    root: string;
    repository: string;
    launch: string;
    evaluation: string;
    context: NativeSettingsPathContext;
    readers: NativeSettingsPathReaders;
    scope: NativePermissionScope;
    setGitRoot: (path: string | undefined) => void;
    contextReads: () => number;
  }) => void,
) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-settings-path-owner-")),
  );
  const repository = posix.join(root, "repository");
  const launch = posix.join(repository, "launch");
  const evaluation = posix.join(root, "evaluation");
  const home = posix.join(root, "home");
  for (const path of [launch, evaluation, home, posix.join(repository, ".git")])
    mkdirSync(path, { recursive: true });
  const scope = { policyId: "owned-settings-path-epoch", cwd: evaluation };
  const uid = statSync(repository).uid;
  const context: NativeSettingsPathContext = {
    configDirectory: posix.join(home, ".claude"),
    configHome: posix.join(home, ".claude"),
    homeDirectory: home,
    cwd: launch,
    projectConfigDir: undefined,
    launchsLocalSettingsStoreRoot: undefined,
    flagPath: undefined,
    getuid: uid,
    geteuid: uid,
    diskless: false,
    coworkPlugins: false,
    coworkPluginsEnvironment: false,
    flagAgentsFilePaths: [],
    flagMcpConfigFilePaths: [],
    pathContext: {
      cwd: evaluation,
      home,
      initialCwd: launch,
      filesystem: nativeLocalPermissionPathFilesystem,
      macos: true,
    },
    homeIsAutomount: false,
  };
  let gitRoot: string | undefined = repository;
  let contextReadCount = 0;
  const fact = <T>(value: T): NativePermissionFact<T> => ({
    status: "known",
    value,
    provenance: {
      provider: "owned-settings-path-state",
      sourceContracts: ["owned-settings-path-fixture"],
      scope,
    },
  });
  function io<T>(
    path: string,
    operation: () => T,
  ): NativePermissionFact<NativeProfileIo<T>> {
    assert.ok(
      path === root || path.startsWith(root + "/"),
      "Only owned settings metadata/text may be read",
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
  const readers: NativeSettingsPathReaders = {
    context() {
      contextReadCount++;
      return fact(context);
    },
    canonicalGitRoot: () => fact(gitRoot),
    realpath: (path) => io(path, () => realpathSync.native(path)),
    statUid: (path, follow) =>
      io(path, () => (follow ? statSync(path) : lstatSync(path)).uid),
    readdir: (path) =>
      io(path, () =>
        readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
        })),
      ),
    lstatFile: (path) =>
      io(path, () => {
        const stat = lstatSync(path);
        return { isFile: stat.isFile(), size: stat.size };
      }),
    readMarkerNoFollow: (path, maxBytes) =>
      io(path, () => {
        const descriptor = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const buffer = Buffer.alloc(maxBytes);
          const count = readSync(descriptor, buffer, 0, buffer.length, 0);
          return buffer.subarray(0, count).toString("utf8");
        } finally {
          closeSync(descriptor);
        }
      }),
  };
  try {
    run({
      root,
      repository,
      launch,
      evaluation,
      context,
      readers,
      scope,
      setGitRoot(path) {
        gitRoot = path;
      },
      contextReads: () => contextReadCount,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
}
function known<T>(fact: NativePermissionFact<T>): T {
  if (fact.status !== "known") assert.fail(fact.reason);
  return fact.value;
}

test("selected local store, source-rule root and additional legacy local path remain distinct", () =>
  owned(({ repository, launch, evaluation, readers, scope }) => {
    const owner = createNativeSettingsPathOwner(readers);
    assert.notEqual(scope.cwd, launch);
    assert.notEqual(repository, launch);
    assert.equal(
      known(owner.selected("localSettings", scope)),
      posix.join(repository, ".claude/settings.local.json"),
    );
    assert.equal(
      known(owner.selected("projectSettings", scope)),
      posix.join(launch, ".claude/settings.json"),
    );
    assert.equal(known(owner.ruleRoot("localSettings", scope)), launch);
    assert.equal(
      known(owner.additionalLocalPath(scope)),
      posix.join(launch, ".claude/settings.local.json"),
    );
    assert.notEqual(known(owner.ruleRoot("localSettings", scope)), evaluation);
  }));

test("actual typed cowork false/true owner and raw empty flag path survive settings path assembly", () =>
  owned(({ context, readers, scope, contextReads }) => {
    context.coworkPluginsEnvironment = false;
    context.flagPath = "";
    context.flagAgentsFilePaths = ["./explicit-agents.json"];
    context.flagMcpConfigFilePaths = ["./explicit-mcp.json"];
    const owner = createNativeSettingsPathOwner(readers);
    assert.equal(
      known(owner.selected("userSettings", scope)),
      posix.join(context.configDirectory, "settings.json"),
    );
    context.coworkPluginsEnvironment = true;
    const start = contextReads();
    const settings = known(owner.settings(scope));
    assert.equal(contextReads() - start, 1);
    assert.equal(
      settings.settingsSourcePaths[0],
      posix.join(context.configDirectory, "cowork_settings.json"),
    );
    assert.ok(settings.settingsSourcePaths.includes(""));
    assert.deepEqual(
      settings.settingsFiles.slice(0, 2),
      context.flagAgentsFilePaths.concat(context.flagMcpConfigFilePaths),
    );
    assert.equal(
      settings.policySettingsPath,
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    assert.deepEqual(settings.managedSettingsDirectories, [
      "/Library/Application Support/ClaudeCode/managed-settings.d",
    ]);
  }));

test("actual connector context suppresses project/local paths but does not erase user or managed paths", () =>
  owned(({ context, readers, scope, launch, setGitRoot }) => {
    const connector = posix.join(launch, "connector-downloads");
    mkdirSync(connector);
    writeFileSync(posix.join(connector, ".gitignore"), "*");
    context.cwd = connector;
    setGitRoot(undefined);
    const owner = createNativeSettingsPathOwner(readers);
    assert.equal(known(owner.selected("projectSettings", scope)), undefined);
    assert.equal(known(owner.selected("localSettings", scope)), undefined);
    assert.equal(known(owner.additionalLocalPath(scope)), undefined);
    const settings = known(owner.settings(scope));
    assert.ok(
      settings.settingsSourcePaths.includes(
        posix.join(context.configDirectory, "settings.json"),
      ),
    );
    assert.ok(
      settings.settingsSourcePaths.includes(
        "/Library/Application Support/ClaudeCode/managed-settings.json",
      ),
    );
  }));

test("connector context only suppresses selected roots that independently classify as connector roots", () =>
  owned(({ context, readers, scope, launch, repository }) => {
    const connector = posix.join(launch, "connector-downloads");
    mkdirSync(connector);
    writeFileSync(posix.join(connector, ".gitignore"), "*");
    context.cwd = connector;
    const owner = createNativeSettingsPathOwner(readers);
    assert.equal(known(owner.selected("projectSettings", scope)), undefined);
    assert.equal(
      known(owner.selected("localSettings", scope)),
      posix.join(repository, ".claude/settings.local.json"),
    );
    assert.equal(known(owner.additionalLocalPath(scope)), undefined);
  }));

test("lexical connector name without actual marker does not suppress a project path", () =>
  owned(({ context, readers, scope, launch, setGitRoot }) => {
    const connector = posix.join(launch, "connector-downloads");
    mkdirSync(connector);
    context.cwd = connector;
    setGitRoot(undefined);
    const owner = createNativeSettingsPathOwner(readers);
    assert.equal(
      known(owner.selected("projectSettings", scope)),
      posix.join(connector, ".claude/settings.json"),
    );
  }));

test("unavailable actual connector owner cannot become absent settings paths or a guessed false gate", () =>
  owned(({ context, readers, scope, launch, setGitRoot }) => {
    const connector = posix.join(launch, "connector-downloads");
    mkdirSync(connector);
    context.cwd = connector;
    setGitRoot(undefined);
    const owner = createNativeSettingsPathOwner({
      ...readers,
      readdir: () => ({
        status: "unsupported",
        dependency: "actual-settings-connector-data",
        reason: "No admitted marker listing",
      }),
    });
    const result = owner.selected("projectSettings", scope);
    assert.equal(result.status, "unsupported");
    if (result.status === "unsupported")
      assert.equal(result.dependency, "actual-settings-connector-data");
    assert.notEqual(known(owner.selected("userSettings", scope)), undefined);
  }));

test("relative native config spelling is retained in templates while bodies use actual evaluation resolution", () =>
  owned(({ context, readers, scope, evaluation }) => {
    context.configDirectory = "./named-config ";
    const settings = known(
      createNativeSettingsPathOwner(readers).settings(scope),
    );
    assert.equal(settings.settingsBodyTemplates[0]?.root, "./named-config ");
    const body = posix.join(
      evaluation,
      "named-config ",
      "remote-settings.json",
    );
    assert.ok(settings.settingsFiles.includes(body));
    assert.ok(settings.settingsFiles.includes(body + ".signature.json"));
    assert.ok(settings.settingsFiles.includes(body + ".signature-iat.json"));
    assert.ok(settings.settingsFiles.includes(body + ".synced-at"));
    assert.ok(
      settings.settingsFiles.includes(
        posix.join(
          evaluation,
          "named-config ",
          "remote-settings-helper-consent",
        ),
      ),
    );
    assert.ok(
      settings.settingsFiles.includes(
        posix.join(evaluation, "named-config ", "remote-settings-consent.json"),
      ),
    );
  }));

test("diskless context suppresses only native project/local path branches", () =>
  owned(({ context, readers, scope }) => {
    context.diskless = true;
    context.cwd = null;
    const owner = createNativeSettingsPathOwner(readers);
    assert.equal(known(owner.selected("projectSettings", scope)), undefined);
    assert.equal(known(owner.selected("localSettings", scope)), undefined);
    assert.equal(known(owner.additionalLocalPath(scope)), undefined);
    assert.notEqual(known(owner.selected("userSettings", scope)), undefined);
    assert.notEqual(known(owner.selected("policySettings", scope)), undefined);
  }));
