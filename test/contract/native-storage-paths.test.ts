import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  NATIVE_STORAGE_COMPATIBILITY_VERSION,
  canAdoptNativeSessionId,
  composeNativeLaunchEnvelope,
  composeNativeStorageLaunch,
  decodeNativeEncodedSessionId,
  encodeNativeProjectDirectoryName,
  isNativeSessionBasenameId,
  nativeMainWriterContext,
  planNativeSessionIdAdoption,
  resolveNativePersistenceAdmission,
  resolveNativeStoragePaths,
  validateNativeProjectDirectoryOverride,
  type NativePersistenceLaunchFacts,
  type NativeStoragePathFacts,
} from "../../src/native-storage-paths.js";

const SID = "eb4a72c3-fb27-40a5-b34a-b5e7f2c03553";
const facts: NativeStoragePathFacts = {
  configDirectory: "/owned/config",
  originalCwd: "/owned/repo/packages/app",
  sessionId: SID,
  sessionIdAdmission: "ordinary",
  platform: "posix",
  diskless: false,
  environment: {},
};
const lifecycle: NativePersistenceLaunchFacts = {
  sessionPersistenceDisabled: false,
  interactive: true,
  inProcessContext: false,
  ambientChildMarkerInTmux: false,
  sealedForShutdown: false,
};

test("native project encoding preserves UTF16, punctuation and conditional hash", () => {
  assert.equal(
    encodeNativeProjectDirectoryName("/owned/repo/packages/app"),
    "-owned-repo-packages-app",
  );
  assert.equal(encodeNativeProjectDirectoryName("/owned/a.b"), "-owned-a-b");
  assert.equal(encodeNativeProjectDirectoryName("/owned/a-b"), "-owned-a-b");
  assert.equal(encodeNativeProjectDirectoryName("/owned/😀"), "-owned---");
  assert.equal(encodeNativeProjectDirectoryName("A//._ B"), "A-----B");
  assert.equal(
    encodeNativeProjectDirectoryName("x".repeat(200)),
    "x".repeat(200),
  );
  assert.equal(
    encodeNativeProjectDirectoryName("/" + "x".repeat(200)),
    "-" + "x".repeat(199) + "-d0i18x",
  );
  assert.notEqual(
    encodeNativeProjectDirectoryName("x".repeat(201) + "."),
    encodeNativeProjectDirectoryName("x".repeat(201) + "-"),
  );
  assert.notEqual(
    encodeNativeProjectDirectoryName("/cafe\u0301"),
    encodeNativeProjectDirectoryName("/caf\u00e9"),
  );
});

test("ordinary SID adoption differs from basename admission and SDK custom IDs", () => {
  for (const value of [SID, SID.toUpperCase()])
    assert.equal(canAdoptNativeSessionId(value, "ordinary"), true);
  assert.equal(isNativeSessionBasenameId("owned_custom-id"), true);
  assert.equal(canAdoptNativeSessionId("owned_custom-id", "ordinary"), false);
  assert.equal(canAdoptNativeSessionId("owned_custom-id", "sdk-custom"), true);
  for (const value of [
    "",
    "../escape",
    "a/b",
    "a\\b",
    ".",
    "nul",
    "COM0",
    "a".repeat(201),
    null,
    1,
  ]) {
    assert.equal(isNativeSessionBasenameId(value), false);
    assert.equal(canAdoptNativeSessionId(value, "sdk-custom"), false);
  }
  assert.equal(isNativeSessionBasenameId("_owned"), true);
  assert.equal(isNativeSessionBasenameId("a".repeat(200)), true);
});

test("encoded native IDs retain exact suffix decoding and ordinary prefix gate", () => {
  const encoded = "sess_01" + "1".repeat(21) + "2";
  assert.equal(
    decodeNativeEncodedSessionId(encoded),
    "00000000-0000-0000-0000-000000000001",
  );
  assert.equal(canAdoptNativeSessionId(encoded, "ordinary"), true);
  assert.equal(
    decodeNativeEncodedSessionId("_01" + "1".repeat(22)),
    "00000000-0000-0000-0000-000000000000",
  );
  assert.equal(
    canAdoptNativeSessionId("_01" + "1".repeat(22), "ordinary"),
    false,
  );
  assert.equal(
    canAdoptNativeSessionId(
      "prefix-with-hyphen_01" + "1".repeat(22),
      "ordinary",
    ),
    false,
  );
  for (const value of [
    "no_suffix",
    "s_00" + "1".repeat(22),
    "s_01" + "1".repeat(21),
    "s_01" + "1".repeat(23),
    "s_01" + "0".repeat(22),
    "s_01" + "z".repeat(22),
  ])
    assert.equal(decodeNativeEncodedSessionId(value), undefined);
});

test("native adoption planning forks invalid IDs without inventing an owner ID", () => {
  assert.deepEqual(
    planNativeSessionIdAdoption(SID, { fork: false, admission: "ordinary" }),
    { adoptedSessionId: SID, effectiveFork: false },
  );
  assert.deepEqual(
    planNativeSessionIdAdoption(undefined, {
      fork: false,
      admission: "ordinary",
    }),
    { adoptedSessionId: null, effectiveFork: false },
  );
  for (const value of [null, "unsafe/../id", "safe_custom"])
    assert.deepEqual(
      planNativeSessionIdAdoption(value, {
        fork: false,
        admission: "ordinary",
      }),
      { adoptedSessionId: null, effectiveFork: true },
    );
  assert.deepEqual(
    planNativeSessionIdAdoption(SID, { fork: true, admission: "ordinary" }),
    { adoptedSessionId: null, effectiveFork: true },
  );
  assert.deepEqual(
    planNativeSessionIdAdoption("safe_custom", {
      fork: false,
      admission: "sdk-custom",
    }),
    { adoptedSessionId: "safe_custom", effectiveFork: false },
  );
});

test("project directory override validates exact native length and reserved names", () => {
  for (const value of ["A_b-12", "_", "-", "x".repeat(64)])
    assert.equal(validateNativeProjectDirectoryOverride(value), value);
  for (const value of [
    "",
    " a",
    "a ",
    "../a",
    "a.b",
    "a/b",
    "CON",
    "con",
    "com0",
    "LPT9",
    "x".repeat(65),
    null,
  ])
    assert.equal(validateNativeProjectDirectoryOverride(value), undefined);
});

test("native default paths use original cwd and an admitted native SID", () => {
  const paths = resolveNativeStoragePaths(facts);
  assert.equal(paths.projectKey, "-owned-repo-packages-app");
  assert.equal(
    paths.projectDirectory,
    "/owned/config/projects/-owned-repo-packages-app",
  );
  assert.equal(
    paths.transcriptPath,
    `/owned/config/projects/-owned-repo-packages-app/${SID}.jsonl`,
  );
  assert.equal(paths.selection, "original-cwd");
  assert.equal(paths.absolute, true);
  const launch = composeNativeStorageLaunch({
    ...facts,
    currentCwd: "/owned/repo/other",
    lifecycle,
  });
  assert.equal(launch.paths.transcriptPath, paths.transcriptPath);
  assert.equal(launch.envelope.cwd, "/owned/repo/other");
  assert.equal(launch.envelope.version, NATIVE_STORAGE_COMPATIBILITY_VERSION);
  assert.equal(launch.envelope.userType, "external");
  assert.equal(Object.hasOwn(launch.envelope, "entrypoint"), false);
  assert.equal(Object.hasOwn(launch.envelope, "sessionKind"), false);
  assert.equal(Object.hasOwn(launch.envelope, "accountUuid"), false);
  const widened = { ...launch.envelope, accountUuid: "not-an-envelope-fact" };
  assert.equal(
    Object.hasOwn(nativeMainWriterContext(widened), "accountUuid"),
    false,
  );
  assert.equal(Object.isFrozen(launch.paths), true);
});

test("raw config and diskless gates determine whether project override is effective", () => {
  const name = { CLAUDE_CODE_PROJECT_DIR_NAME: "explicit_name" };
  assert.equal(
    resolveNativeStoragePaths({ ...facts, environment: name }).projectKey,
    "-owned-repo-packages-app",
  );
  assert.equal(
    resolveNativeStoragePaths({ ...facts, environment: name, diskless: true })
      .projectKey,
    "explicit_name",
  );
  const override = resolveNativeStoragePaths({
    ...facts,
    environment: { ...name, CLAUDE_CONFIG_DIR: "/other/config" },
  });
  assert.equal(
    override.transcriptPath,
    `/other/config/projects/explicit_name/${SID}.jsonl`,
  );
  assert.equal(override.selection, "project-name");
  assert.equal(
    resolveNativeStoragePaths({
      ...facts,
      environment: { ...name, CLAUDE_CONFIG_DIR: "" },
    }).transcriptPath,
    `projects/-owned-repo-packages-app/${SID}.jsonl`,
  );
  assert.equal(
    resolveNativeStoragePaths({
      ...facts,
      environment: { ...name, CLAUDE_CONFIG_DIR: "" },
      diskless: true,
    }).projectKey,
    "explicit_name",
  );
  assert.equal(
    resolveNativeStoragePaths({
      ...facts,
      environment: {
        CLAUDE_CONFIG_DIR: "/other",
        CLAUDE_CODE_PROJECT_DIR_NAME: "CON",
      },
    }).projectKey,
    "-owned-repo-packages-app",
  );
});

test("NFC and relative config semantics are distinct from trimming and cwd encoding", () => {
  const paths = resolveNativeStoragePaths({
    ...facts,
    originalCwd: "/owned/cafe\u0301",
    environment: { CLAUDE_CONFIG_DIR: "relative/cafe\u0301" },
  });
  assert.equal(paths.originalCwd, "/owned/caf\u00e9");
  assert.equal(paths.projectKey, "-owned-caf-");
  assert.equal(paths.configDirectory, "relative/caf\u00e9");
  assert.equal(paths.absolute, false);
  const spaced = resolveNativeStoragePaths({
    ...facts,
    environment: { CLAUDE_CONFIG_DIR: " /owned/config " },
  });
  assert.equal(spaced.configDirectory, " /owned/config ");
  assert.equal(spaced.absolute, false);
});

test("explicit adopted directory selects SID basename without encoding or implicit context", () => {
  const paths = resolveNativeStoragePaths({
    ...facts,
    originalCwd: null,
    adoptedSessionDirectory: "/owned/import-copy",
  });
  assert.equal(paths.transcriptPath, `/owned/import-copy/${SID}.jsonl`);
  assert.equal(paths.projectKey, null);
  assert.equal(paths.selection, "adopted");
  assert.equal(
    resolveNativeStoragePaths({ ...facts, adoptedSessionDirectory: "" })
      .transcriptPath,
    `${SID}.jsonl`,
  );
  assert.throws(
    () => resolveNativeStoragePaths({ ...facts, originalCwd: null }),
    /context is unavailable/,
  );
  assert.equal(
    resolveNativeStoragePaths({
      ...facts,
      originalCwd: null,
      diskless: true,
      environment: { CLAUDE_CODE_PROJECT_DIR_NAME: "bound" },
    }).projectDirectory,
    "/owned/config/projects/bound",
  );
});

test("explicit platform determines path joins without consulting host platform", () => {
  const windows = resolveNativeStoragePaths({
    ...facts,
    platform: "win32",
    configDirectory: "C:\\owned\\config",
    originalCwd: "C:\\owned\\repo",
  });
  assert.equal(windows.projectKey, "C--owned-repo");
  assert.equal(
    windows.transcriptPath,
    `C:\\owned\\config\\projects\\C--owned-repo\\${SID}.jsonl`,
  );
  assert.equal(windows.absolute, true);
  const relative = resolveNativeStoragePaths({
    ...facts,
    platform: "win32",
    configDirectory: "C:relative",
  });
  assert.equal(relative.absolute, false);
});

test("launch envelope preserves optional entrypoint and admitted kinds without defaults", () => {
  for (const entrypoint of [undefined, "", "custom-entry"]) {
    const envelope = composeNativeLaunchEnvelope({
      sessionId: SID,
      sessionIdAdmission: "ordinary",
      currentCwd: "/owned/cafe\u0301",
      environment:
        entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint },
    });
    assert.equal(envelope.entrypoint, entrypoint);
    assert.equal(
      Object.hasOwn(envelope, "entrypoint"),
      entrypoint !== undefined,
    );
    assert.equal(envelope.cwd, "/owned/caf\u00e9");
    assert.equal(nativeMainWriterContext(envelope).sidechain, false);
  }
  for (const kind of ["bg", "daemon", "daemon-worker", "normal", "", " BG "]) {
    const envelope = composeNativeLaunchEnvelope({
      sessionId: SID,
      sessionIdAdmission: "ordinary",
      currentCwd: null,
      environment: { CLAUDE_CODE_SESSION_KIND: kind },
    });
    assert.equal(
      envelope.sessionKind,
      ["bg", "daemon", "daemon-worker"].includes(kind) ? kind : undefined,
    );
    assert.equal(Object.hasOwn(envelope, "cwd"), false);
    assert.throws(() => nativeMainWriterContext(envelope), /actual cwd/);
  }
});

test("production persistence admission keeps string truthiness and nested marker precedence", () => {
  assert.deepEqual(resolveNativePersistenceAdmission(lifecycle, {}), {
    disabledReason: null,
    skipPersistence: false,
  });
  assert.equal(
    resolveNativePersistenceAdmission(lifecycle, {
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "0",
    }).disabledReason,
    "skip_prompt_history",
  );
  assert.equal(
    resolveNativePersistenceAdmission(lifecycle, {
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "",
    }).disabledReason,
    null,
  );
  assert.equal(
    resolveNativePersistenceAdmission(
      { ...lifecycle, sessionPersistenceDisabled: true },
      {
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
      },
    ).disabledReason,
    "explicit_disable",
  );
  const child = { CLAUDE_CODE_CHILD_SESSION: "0" };
  assert.equal(
    resolveNativePersistenceAdmission(lifecycle, child).disabledReason,
    "nested_marker",
  );
  for (const changed of [
    { interactive: false },
    { inProcessContext: true },
    { ambientChildMarkerInTmux: true },
  ])
    assert.equal(
      resolveNativePersistenceAdmission({ ...lifecycle, ...changed }, child)
        .disabledReason,
      null,
    );
  assert.equal(
    resolveNativePersistenceAdmission(lifecycle, {
      ...child,
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "0",
    }).disabledReason,
    null,
  );
  assert.deepEqual(
    resolveNativePersistenceAdmission(
      { ...lifecycle, sealedForShutdown: true },
      {},
    ),
    { disabledReason: null, skipPersistence: true },
  );
});

test("explicit host facts are validated and input objects remain untouched", () => {
  const input = Object.freeze({
    ...facts,
    environment: Object.freeze({}),
    currentCwd: "/owned/current",
    lifecycle: Object.freeze(lifecycle),
  });
  const before = structuredClone(input);
  composeNativeStorageLaunch(input);
  assert.deepEqual(input, before);
  assert.throws(
    () => resolveNativeStoragePaths({ ...facts, sessionId: "../escape" }),
    /admitted session ID/,
  );
  const invalidPlatform = { ...facts };
  Reflect.set(invalidPlatform, "platform", "other");
  assert.throws(() => resolveNativeStoragePaths(invalidPlatform), /platform/);
  const invalidEnvironment = {
    ...facts,
    environment: { CLAUDE_CODE_ENTRYPOINT: "known" },
  };
  Reflect.set(invalidEnvironment.environment, "CLAUDE_CODE_ENTRYPOINT", 1);
  assert.throws(
    () => resolveNativeStoragePaths(invalidEnvironment),
    /environment value/,
  );
  const missingLifecycle = { ...lifecycle };
  Reflect.deleteProperty(missingLifecycle, "interactive");
  assert.throws(
    () => resolveNativePersistenceAdmission(missingLifecycle, {}),
    /interactive/,
  );
  const invalidAdmission = { ...facts };
  Reflect.set(invalidAdmission, "sessionIdAdmission", "unknown");
  assert.throws(
    () => canAdoptNativeSessionId(SID, invalidAdmission.sessionIdAdmission),
    /admission/,
  );
});
