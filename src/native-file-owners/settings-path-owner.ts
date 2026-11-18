import { posix } from "node:path";
import {
  createNativeLocalSettingsStore,
  type NativeLocalStoreContext,
  type NativeLocalStoreReaders,
  type NativeSettingsSource,
} from "./local-settings-store.js";
import {
  createNativeConnectorSettingsOwner,
  nativeSettingsConnectorSpelling,
  type NativeConnectorSettingsContext,
  type NativeConnectorSettingsReaders,
} from "./connector-settings-owner.js";
import type { NativeFileSettingsOwner } from "./owner-fragments.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionProvenance,
  type NativePermissionScope,
} from "../native-permission-outcome.js";

export interface NativeSettingsPathContext
  extends NativeLocalStoreContext, NativeConnectorSettingsContext {
  diskless: boolean;
  coworkPlugins: boolean;
  /** Actual s.CLAUDE_CODE_USE_COWORK_PLUGINS, parsed by N.bool(). */
  coworkPluginsEnvironment: boolean;
  flagAgentsFilePaths: readonly string[];
  flagMcpConfigFilePaths: readonly string[];
}
export interface NativeSettingsPathReaders {
  context(
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeSettingsPathContext>;
  canonicalGitRoot: NativeLocalStoreReaders["canonicalGitRoot"];
  realpath: NativeLocalStoreReaders["realpath"];
  statUid: NativeLocalStoreReaders["statUid"];
  readdir: NativeConnectorSettingsReaders["readdir"];
  lstatFile: NativeConnectorSettingsReaders["lstatFile"];
  readMarkerNoFollow: NativeConnectorSettingsReaders["readMarkerNoFollow"];
}
const sources: readonly NativeSettingsSource[] = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
];
const unique = (values: readonly string[]) => [...new Set(values)];
const relative = (source: "projectSettings" | "localSettings") =>
  posix.join(
    ".claude",
    source === "projectSettings" ? "settings.json" : "settings.local.json",
  );

/** Tz/oPe/Lr/tn/_5r/zxt composition, independent from settings schema/admission. */
export function createNativeSettingsPathOwner(
  readers: NativeSettingsPathReaders,
) {
  // One synchronous source-context frame per projection, with independent native
  // local-store/connector caches. Nested authored callbacks restore prior frame.
  let frame: NativePermissionFact<NativeSettingsPathContext> | undefined;
  const current = (): NativePermissionFact<NativeSettingsPathContext> =>
    frame ?? {
      status: "unsupported",
      dependency: "native-settings-context-frame",
      reason: "No active source-owned settings context",
    };
  const local = createNativeLocalSettingsStore({
    context: current,
    canonicalGitRoot: readers.canonicalGitRoot,
    realpath: readers.realpath,
    statUid: readers.statUid,
  });
  const connector = createNativeConnectorSettingsOwner({
    context: current,
    readdir: readers.readdir,
    lstatFile: readers.lstatFile,
    readMarkerNoFollow: readers.readMarkerNoFollow,
  });
  // Retained YS/yEi/bu has a fixed macOS platform producer. Separate caches keep
  // its source lifetime explicit even though this build has no override hook.
  let managedRoot: string | undefined;
  let dropInDirectory: string | undefined;
  const managed = () =>
    (managedRoot ??= "/Library/Application Support/ClaudeCode");
  const dropIn = () =>
    (dropInDirectory ??= posix.join(managed(), "managed-settings.d"));

  function project<T>(
    scope: NativePermissionScope,
    operation: (
      context: NativeSettingsPathContext,
      read: <Value>(fact: NativePermissionFact<Value>) => Value,
    ) => T,
  ): NativePermissionFact<T> {
    const previous = frame;
    const receipts: NativePermissionProvenance[] = [];
    const read = <Value>(fact: NativePermissionFact<Value>): Value =>
      readNativePermissionFact(fact, scope, receipts);
    try {
      frame = readers.context(scope);
      const context = read(frame);
      if (!context.pathContext.macos || context.pathContext.cwd !== scope.cwd)
        throw new NativePermissionDependencyError(
          "native-settings-path-context",
          "Actual retained macOS evaluation context is required",
        );
      const value = operation(context, read);
      return {
        status: "known",
        value,
        provenance: {
          provider:
            "native-settings-path-owner(" +
            [...new Set(receipts.map((row) => row.provider))].join(",") +
            ")",
          sourceContracts: [
            ...new Set([
              "L/Tz/oPe/Lr/tn/_5r/zxt/bu",
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
            : "native-settings-path-owner",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      frame = previous;
    }
  }
  function connectorContext(
    context: NativeSettingsPathContext,
    scope: NativePermissionScope,
    read: <T>(fact: NativePermissionFact<T>) => T,
  ): boolean {
    const candidate = context.projectConfigDir ?? context.cwd;
    if (candidate === null) return false;
    const normalized = posix.resolve(scope.cwd, candidate);
    return (
      nativeSettingsConnectorSpelling(normalized + "/.") &&
      read(connector.inside(normalized, scope))
    );
  }
  function selected(
    source: NativeSettingsSource,
    context: NativeSettingsPathContext,
    scope: NativePermissionScope,
    read: <T>(fact: NativePermissionFact<T>) => T,
  ): string | undefined {
    switch (source) {
      case "userSettings":
        return posix.join(
          read(local.base(source, scope)),
          context.coworkPlugins || context.coworkPluginsEnvironment
            ? "cowork_settings.json"
            : "settings.json",
        );
      case "projectSettings":
      case "localSettings": {
        if (
          context.diskless ||
          (context.cwd === null && context.projectConfigDir === undefined)
        )
          return undefined;
        const root = read(local.base(source, scope));
        if (
          connectorContext(context, scope, read) &&
          nativeSettingsConnectorSpelling(root + "/.") &&
          read(connector.inside(root, scope))
        )
          return undefined;
        return posix.join(root, relative(source));
      }
      case "policySettings":
        return posix.join(managed(), "managed-settings.json");
      case "flagSettings":
        return context.flagPath;
    }
  }
  function legacy(
    context: NativeSettingsPathContext,
    scope: NativePermissionScope,
    read: <T>(fact: NativePermissionFact<T>) => T,
  ): string | undefined {
    if (context.diskless) return undefined;
    const root = read(local.legacyLocalRoot(scope));
    if (root === null || connectorContext(context, scope, read))
      return undefined;
    return posix.join(root, relative("localSettings"));
  }
  return {
    selected(source: NativeSettingsSource, scope: NativePermissionScope) {
      return project(scope, (context, read) =>
        selected(source, context, scope, read),
      );
    },
    additionalLocalPath(scope: NativePermissionScope) {
      return project(scope, (context, read) => legacy(context, scope, read));
    },
    ruleRoot(source: NativeSettingsSource, scope: NativePermissionScope) {
      return project(scope, (_context, read) =>
        read(local.ruleRoot(source, scope)),
      );
    },
    settings(
      scope: NativePermissionScope,
    ): NativePermissionFact<NativeFileSettingsOwner> {
      return project(scope, (context, read) => {
        const roots = unique([
          context.configDirectory,
          posix.join(context.homeDirectory, ".claude"),
        ]);
        const sourcePaths = sources.flatMap((source) => {
          const path = selected(source, context, scope, read);
          return path === undefined ? [] : [path];
        });
        // bx/Xso/KDt are pinned no-ops; zW is exactly Ye/remote-settings.json.
        const bodies = unique([
          ...roots.map((root) =>
            posix.resolve(scope.cwd, root, "remote-settings.json"),
          ),
          posix.resolve(
            scope.cwd,
            posix.join(context.configDirectory, "remote-settings.json"),
          ),
        ]);
        const vouchers = [
          ...bodies.flatMap((body) => [
            body + ".signature.json",
            body + ".signature-iat.json",
            body + ".synced-at",
          ]),
          ...roots.flatMap((root) => [
            posix.resolve(scope.cwd, root, "remote-settings-helper-consent"),
            posix.resolve(scope.cwd, root, "remote-settings-consent.json"),
          ]),
        ];
        return {
          settingsFiles: [
            ...context.flagAgentsFilePaths,
            ...context.flagMcpConfigFilePaths,
            ...bodies,
            ...vouchers,
          ],
          settingsSourcePaths: [
            ...sourcePaths,
            ...roots.flatMap((root) => [
              posix.join(root, "settings.json"),
              posix.join(root, "cowork_settings.json"),
            ]),
          ],
          flagSettingsPath: legacy(context, scope, read) ?? null,
          policySettingsPath:
            selected("policySettings", context, scope, read) ?? null,
          settingsBodyTemplates: roots.map((root) => ({
            root,
            relativePaths: [
              "remote-settings.json",
              "remote-settings.json.signature.json",
              "remote-settings.json.signature-iat.json",
              "remote-settings.json.synced-at",
              "remote-settings-helper-consent",
              "remote-settings-consent.json",
            ],
          })),
          managedSettingsDirectories: [dropIn()],
        };
      });
    },
    clearConnectorCache() {
      connector.clear();
    },
    clearCanonicalRootOwnerUids() {
      local.clearCanonicalRootOwnerUids();
    },
    clearNormalizedRealHomeDir() {
      local.clearNormalizedRealHomeDir();
    },
    clearDropInDirectory() {
      dropInDirectory = undefined;
    },
    resetManagedDirectories() {
      managedRoot = undefined;
      dropInDirectory = undefined;
    },
  };
}
