import type { NativeFileResourceSnapshot } from "../native-file-adjudication-types.js";
import type { composeNativeStorageLaunch } from "../native-storage-paths.js";
import { NATIVE_STORAGE_COMPATIBILITY_VERSION } from "../native-storage-paths.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionProvenance,
  type NativePermissionScope,
} from "../native-permission-outcome.js";

/** State fragments come from their actual owners; no ordinary-launch defaults. */
export type NativeFileContextOwner = Pick<
  NativeFileResourceSnapshot,
  | "diskless"
  | "configHome"
  | "configContextCwd"
  | "originalCwd"
  | "aliasTranslationRoots"
  | "launchContextRoot"
  | "initialReadRoot"
  | "extraWorkingDirectories"
  | "workingDirPathsHeldAsNamed"
>;
export type NativeFileFeatureOwner = Pick<
  NativeFileResourceSnapshot,
  "blockFileReadProtectedExceptions" | "merryBoot"
>;
export type NativeFileAccountOwner = Pick<
  NativeFileResourceSnapshot["protected"],
  "hostCredentialsPath" | "profileStore" | "signInFiles"
>;
export type NativeFileSettingsOwner = Pick<
  NativeFileResourceSnapshot["protected"],
  | "settingsFiles"
  | "settingsSourcePaths"
  | "flagSettingsPath"
  | "policySettingsPath"
  | "settingsBodyTemplates"
  | "managedSettingsDirectories"
>;
type Reader<T> = (scope: NativePermissionScope) => NativePermissionFact<T>;
export interface NativeFileOwnerFragments {
  storage?: Reader<ReturnType<typeof composeNativeStorageLaunch>>;
  context?: Reader<NativeFileContextOwner>;
  features?: Reader<NativeFileFeatureOwner>;
  settings?: Reader<NativeFileSettingsOwner>;
  account?: Reader<NativeFileAccountOwner>;
  memory?: Reader<NativeFileResourceSnapshot["memory"]>;
  runtime?: Reader<NativeFileResourceSnapshot["runtime"]>;
  registry?: Reader<NativeFileResourceSnapshot["plugins"]>;
}

/** Assembly only: never reads personal/default state, performs I/O, or invents inactive facts. */
export function createNativeFileResourceOwnerReader(
  fragments: NativeFileOwnerFragments,
): Reader<NativeFileResourceSnapshot> {
  return (scope) => {
    const receipts: NativePermissionProvenance[] = [];
    function read<T>(name: string, reader: Reader<T> | undefined): T {
      if (reader === undefined)
        throw new NativePermissionDependencyError(
          name,
          "The actual production owner reader has not been bound",
        );
      return readNativePermissionFact(reader(scope), scope, receipts);
    }
    try {
      const storage = read("native-storage-owner", fragments.storage);
      if (storage.envelope.version !== NATIVE_STORAGE_COMPATIBILITY_VERSION)
        throw new NativePermissionDependencyError(
          "native-storage-owner",
          "Storage owner uses a different source compatibility version",
        );
      const context = read("native-working-context-owner", fragments.context);
      const features = read(
        "native-permission-feature-owner",
        fragments.features,
      );
      const settings = read("native-settings-owner", fragments.settings);
      const account = read("native-profile-owner", fragments.account);
      const memory = read("native-memory-owner", fragments.memory);
      const runtime = read("native-resource-owner", fragments.runtime);
      const registry = read(
        "native-producer-registry-owner",
        fragments.registry,
      );
      return {
        status: "known",
        value: {
          ...context,
          ...features,
          // These are exact owned producer outputs. Do not substitute the
          // ordinary launch's resolved userConfigDir or its port session ID.
          configDirectory: storage.paths.configDirectory,
          nativeSessionId: storage.envelope.sessionId,
          memory,
          runtime,
          protected: { ...account, ...settings },
          plugins: registry,
        },
        provenance: {
          provider:
            "native-file-owner-assembly(" +
            [...new Set(receipts.map((row) => row.provider))].join(",") +
            ")",
          sourceContracts: [
            ...new Set([
              "Ye/G/native-owner-fragments",
              ...receipts.flatMap((row) => row.sourceContracts),
            ]),
          ],
          scope,
        },
      };
    } catch (error) {
      return {
        status: "unsupported",
        dependency:
          error instanceof NativePermissionDependencyError
            ? error.dependency
            : "native-file-owner-assembly",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
