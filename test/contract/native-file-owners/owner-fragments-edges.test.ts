import assert from "node:assert/strict";
import { test } from "bun:test";
import { createNativeFileResourceOwnerReader } from "../../../src/native-file-owners/owner-fragments.js";
import { composeNativeStorageLaunch } from "../../../src/native-storage-paths.js";
import type { NativePermissionScope } from "../../../src/native-permission-outcome.js";

type StorageLaunch = ReturnType<typeof composeNativeStorageLaunch>;
const scope: NativePermissionScope = {
  cwd: "/edge/evaluation",
  policyId: "edge-policy-generation",
};
const storage = composeNativeStorageLaunch({
  configDirectory: "/edge/config",
  environment: {},
  originalCwd: "/edge/original",
  currentCwd: "/edge/current",
  sessionId: "00000000-0000-4000-8000-000000000007",
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
});
/** Models a storage owner that does not honor its declared compatibility type, such as one built by another release. */
function fromOtherRelease(value: object): value is StorageLaunch {
  return typeof value === "object";
}

test("a storage owner from another compatibility version is unsupported", () => {
  const foreign = {
    ...storage,
    envelope: { ...storage.envelope, version: "0.0.0" },
  };
  assert.ok(fromOtherRelease(foreign));
  const result = createNativeFileResourceOwnerReader({
    storage: () => ({
      status: "known",
      value: foreign,
      provenance: { provider: "edge", sourceContracts: ["edge"], scope },
    }),
  })(scope);
  assert.ok(result.status === "unsupported");
  assert.equal(result.dependency, "native-storage-owner");
  assert.match(result.reason, /different source compatibility version/);
});

test("an owner that throws is reported against the assembly, with its message", () => {
  const thrown = createNativeFileResourceOwnerReader({
    storage: () => {
      throw new Error("EDGE_OWNER_FAILED");
    },
  })(scope);
  assert.deepEqual(thrown, {
    status: "unsupported",
    dependency: "native-file-owner-assembly",
    reason: "EDGE_OWNER_FAILED",
  });
  const raw = createNativeFileResourceOwnerReader({
    storage: () => {
      throw "EDGE_RAW";
    },
  })(scope);
  assert.deepEqual(raw, {
    status: "unsupported",
    dependency: "native-file-owner-assembly",
    reason: "EDGE_RAW",
  });
});
