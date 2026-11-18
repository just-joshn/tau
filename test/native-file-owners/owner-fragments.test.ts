import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createNativeFileResourceOwnerReader,
  type NativeFileOwnerFragments,
} from "../../src/native-file-owners/owner-fragments.js";
import { composeNativeStorageLaunch } from "../../src/native-storage-paths.js";
import type {
  NativePermissionFact,
  NativePermissionScope,
} from "../../src/native-permission-outcome.js";

const scope: NativePermissionScope = {
  cwd: "/actual/evaluation",
  policyId: "actual-policy-generation",
};
const sessionId = "00000000-0000-4000-8000-000000000001";
function fact<T>(value: T): NativePermissionFact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-explicit-owner",
      sourceContracts: ["owned-source-producer"],
      scope,
    },
  };
}
function owners(configDirectory: string): NativeFileOwnerFragments {
  return {
    storage: () =>
      fact(
        composeNativeStorageLaunch({
          configDirectory: "/fallback/config",
          environment: { CLAUDE_CONFIG_DIR: configDirectory },
          originalCwd: "/storage/original",
          currentCwd: "/startup/recorded-cwd",
          sessionId,
          sessionIdAdmission: "ordinary",
          platform: "posix",
          diskless: false,
          lifecycle: {
            sessionPersistenceDisabled: false,
            interactive: true,
            inProcessContext: false,
            ambientChildMarkerInTmux: false,
            sealedForShutdown: false,
          },
        }),
      ),
    context: () =>
      fact({
        diskless: false,
        configHome: configDirectory,
        configContextCwd: "/configuration/context",
        originalCwd: "/actually/adopted",
        aliasTranslationRoots: [],
        launchContextRoot: "/actual/launch",
        initialReadRoot: undefined,
        extraWorkingDirectories: [],
        workingDirPathsHeldAsNamed: new Set(),
      }),
    features: () =>
      fact({ blockFileReadProtectedExceptions: false, merryBoot: true }),
    settings: () =>
      fact({
        settingsFiles: [],
        settingsSourcePaths: [],
        flagSettingsPath: null,
        policySettingsPath: null,
        settingsBodyTemplates: [],
        managedSettingsDirectories: [],
      }),
    account: () =>
      fact({ hostCredentialsPath: null, profileStore: null, signInFiles: [] }),
    memory: () =>
      fact({
        paused: false,
        canLackFolderAndUnresolved: false,
        autoMemoryRoot: null,
        ownProjectMemoryRoot: null,
        ownProjectMemoryEnabled: false,
        requireExplicitMemoryWrites: false,
        memoryBlockedByReadFence: false,
        agentMemoryRoots: [],
      }),
    runtime: () =>
      fact({
        plan: null,
        workflowDirectory: null,
        scratchDirectory: null,
        backgroundJobDirectory: null,
        projectStoreDirectory: null,
        originalProjectStoreDirectory: null,
        connectorDownloadDirectory: null,
        toolResultDirectories: [],
        ownSessionDirectory: null,
        taskOutputDirectory: null,
        projectTempPrefix: "/actual/tmp/",
        earlierToolResultDirectories: [],
        allowEarlierToolResultsForModel: false,
        bundledSkillReferenceDirectory: "/actual/resources",
        syncedPluginDirectories: [],
        reservedSkillDirectories: [],
      }),
    registry: () =>
      fact({
        devModsFollowLinks: true,
        producerRoots: [],
        retainedProducerPaths: [],
        wslProviderUndeterminable: false,
        inlineRoots: [],
        additionalProducerRoot: null,
      }),
  };
}

test("explicit native storage outputs preserve empty/relative config spelling and actual SID", () => {
  for (const raw of ["", "../native-config", "./native-config"]) {
    const result = createNativeFileResourceOwnerReader(owners(raw))(scope);
    if (result.status !== "known") assert.fail(result.reason);
    assert.equal(result.value.configDirectory, raw);
    assert.equal(result.value.nativeSessionId, sessionId);
    assert.equal(result.value.originalCwd, "/actually/adopted");
    assert.equal(result.provenance.scope.cwd, "/actual/evaluation");
  }
});

test("missing profile/registry owners are unavailable facts rather than inactive defaults", () => {
  const profile = owners("/explicit/config");
  delete profile.account;
  const missingProfile = createNativeFileResourceOwnerReader(profile)(scope);
  assert.equal(missingProfile.status, "unsupported");
  if (missingProfile.status === "unsupported")
    assert.equal(missingProfile.dependency, "native-profile-owner");
  const registry = owners("/explicit/config");
  delete registry.registry;
  const missingRegistry = createNativeFileResourceOwnerReader(registry)(scope);
  assert.equal(missingRegistry.status, "unsupported");
  if (missingRegistry.status === "unsupported")
    assert.equal(missingRegistry.dependency, "native-producer-registry-owner");
});

test("unavailable actual settings evidence preserves its dependency and cannot become an empty set", () => {
  const input = owners("/explicit/config");
  input.settings = () => ({
    status: "unsupported",
    dependency: "native-managed-settings-reader",
    reason: "The actual policy source is unreadable",
  });
  const result = createNativeFileResourceOwnerReader(input)(scope);
  assert.equal(result.status, "unsupported");
  if (result.status === "unsupported")
    assert.equal(result.dependency, "native-managed-settings-reader");
});

test("foreign owner epochs are rejected and known assembly preserves owner provenance", () => {
  const input = owners("/explicit/config");
  input.account = () => ({
    status: "known",
    value: { hostCredentialsPath: null, profileStore: null, signInFiles: [] },
    provenance: {
      provider: "foreign-profile",
      sourceContracts: ["actual-profile"],
      scope: { ...scope, policyId: "stale-generation" },
    },
  });
  const rejected = createNativeFileResourceOwnerReader(input)(scope);
  assert.equal(rejected.status, "unsupported");
  const accepted = createNativeFileResourceOwnerReader(
    owners("/explicit/config"),
  )(scope);
  if (accepted.status !== "known") assert.fail(accepted.reason);
  assert.ok(
    accepted.provenance.sourceContracts.includes("owned-source-producer"),
  );
  assert.match(accepted.provenance.provider, /authored-explicit-owner/);
});
