import { posix } from "node:path";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionProvenance,
  type NativePermissionScope,
} from "../native-permission-outcome.js";
import type { NativeProfileIo } from "./account-path-owner.js";

export type NativeSettingsSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings";
export interface NativeLocalStoreContext {
  configDirectory: string;
  homeDirectory: string;
  /** Actual _s(), not evaluation cwd or Te(). */
  cwd: string | null;
  projectConfigDir: string | undefined;
  launchsLocalSettingsStoreRoot: string | undefined;
  flagPath: string | undefined;
  getuid: number | undefined;
  geteuid: number | undefined;
}
export interface NativeLocalRootUids {
  rootUid: number;
  gitEntryUid: number;
  claudeEntryUid: number | null;
}
export interface NativeLocalStoreReaders {
  context(
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeLocalStoreContext>;
  canonicalGitRoot(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<string | null | undefined>;
  realpath(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<string>>;
  statUid(
    path: string,
    follow: boolean,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<number>>;
}

class ActualLocalStoreError extends Error {}

/** Complete BPn/dp/SF/tns/aal/AEi path selection, over explicit owners.
 * Tz/oPe connector suppression is deliberately a separate component. */
export function createNativeLocalSettingsStore(
  readers: NativeLocalStoreReaders,
) {
  type Cached<T> = {
    value: T;
    receipts: readonly NativePermissionProvenance[];
  };
  const uidCache = new Map<string, Cached<NativeLocalRootUids>>();
  let homeCache: Cached<string> | undefined;

  function run<T>(
    scope: NativePermissionScope,
    project: (
      context: NativeLocalStoreContext,
      read: <Value>(fact: NativePermissionFact<Value>) => Value,
      receipts: NativePermissionProvenance[],
    ) => T,
  ): NativePermissionFact<T> {
    const receipts: NativePermissionProvenance[] = [];
    const read = <Value>(fact: NativePermissionFact<Value>): Value =>
      readNativePermissionFact(fact, scope, receipts);
    try {
      const context = read(readers.context(scope));
      const value = project(context, read, receipts);
      return {
        status: "known",
        value,
        provenance: {
          provider:
            "native-local-settings-store(" +
            [...new Set(receipts.map((row) => row.provider))].join(",") +
            ")",
          sourceContracts: [
            ...new Set([
              "BPn/dp/SF/tns/aal/AEi/je",
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
            : "native-local-settings-store",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  function requireCwd(context: NativeLocalStoreContext): string {
    if (context.cwd === null)
      throw new ActualLocalStoreError("Native settings owner has no cwd");
    return context.cwd;
  }
  function resolve(scope: NativePermissionScope, path: string): string {
    return posix.resolve(scope.cwd, path);
  }
  function actual<T>(result: NativeProfileIo<T>): T {
    if (result.kind === "error")
      throw new ActualLocalStoreError(
        "Actual local-store metadata error: " + (result.code ?? "UNKNOWN"),
      );
    return result.value;
  }
  function store(
    scope: NativePermissionScope,
    context: NativeLocalStoreContext,
    read: <Value>(fact: NativePermissionFact<Value>) => Value,
    receipts: NativePermissionProvenance[],
  ): string {
    const cwd = requireCwd(context);
    const root = read(readers.canonicalGitRoot(cwd, scope));
    if (!root) return resolve(scope, cwd);
    const candidate = resolve(scope, root);
    const current = resolve(scope, cwd);
    if (candidate === current) return candidate;
    try {
      if (homeCache === undefined) {
        const start = receipts.length;
        // Uh/Yk/hn: POSIX native realpath, then NFC; no private-path folding.
        const home = actual(
          read(readers.realpath(context.homeDirectory, scope)),
        ).normalize("NFC");
        homeCache = { value: home, receipts: receipts.slice(start) };
      } else receipts.push(...homeCache.receipts);
      if (candidate === homeCache.value) return current;
    } catch (error) {
      if (error instanceof NativePermissionDependencyError) throw error;
      if (!(error instanceof ActualLocalStoreError)) throw error;
      return current;
    }
    if (context.getuid === undefined && context.geteuid === undefined)
      return current;
    const expectedUid = context.geteuid ?? context.getuid;
    try {
      let cached = uidCache.get(candidate);
      if (cached === undefined) {
        const start = receipts.length;
        const claude = read(
          readers.statUid(posix.join(candidate, ".claude"), false, scope),
        );
        const claudeEntryUid =
          claude.kind === "error" && claude.code === "ENOENT"
            ? null
            : actual(claude);
        const rootUid = actual(read(readers.statUid(candidate, true, scope)));
        const gitEntryUid = actual(
          read(readers.statUid(posix.join(candidate, ".git"), false, scope)),
        );
        cached = {
          value: { rootUid, gitEntryUid, claudeEntryUid },
          receipts: receipts.slice(start),
        };
        uidCache.set(candidate, cached);
      } else receipts.push(...cached.receipts);
      const uids = cached.value;
      return uids.rootUid === expectedUid &&
        uids.gitEntryUid === expectedUid &&
        (uids.claudeEntryUid === null || uids.claudeEntryUid === expectedUid)
        ? candidate
        : current;
    } catch (error) {
      if (error instanceof NativePermissionDependencyError) throw error;
      if (!(error instanceof ActualLocalStoreError)) throw error;
      return current;
    }
  }
  function base(
    source: NativeSettingsSource,
    scope: NativePermissionScope,
    context: NativeLocalStoreContext,
    read: <Value>(fact: NativePermissionFact<Value>) => Value,
    receipts: NativePermissionProvenance[],
  ): string {
    // Retained326 lp(source) is an observed no-op.
    switch (source) {
      case "userSettings":
        return resolve(scope, context.configDirectory);
      case "projectSettings":
        return resolve(scope, context.projectConfigDir ?? requireCwd(context));
      case "policySettings":
        return resolve(scope, requireCwd(context));
      case "flagSettings":
        return context.flagPath
          ? posix.dirname(resolve(scope, context.flagPath))
          : resolve(scope, requireCwd(context));
      case "localSettings":
        if (context.launchsLocalSettingsStoreRoot !== undefined)
          return context.launchsLocalSettingsStoreRoot;
        if (context.projectConfigDir !== undefined)
          return resolve(scope, context.projectConfigDir);
        return store(scope, context, read, receipts);
    }
  }
  return {
    base(source: NativeSettingsSource, scope: NativePermissionScope) {
      return run(scope, (context, read, receipts) =>
        base(source, scope, context, read, receipts),
      );
    },
    ruleRoot(source: NativeSettingsSource, scope: NativePermissionScope) {
      return run(scope, (context, read, receipts) =>
        source === "localSettings" || source === "projectSettings"
          ? resolve(scope, requireCwd(context))
          : base(source, scope, context, read, receipts),
      );
    },
    legacyLocalRoot(scope: NativePermissionScope) {
      return run(scope, (context, read, receipts) => {
        if (context.launchsLocalSettingsStoreRoot !== undefined) {
          const cwd = context.projectConfigDir ?? context.cwd;
          return cwd !== null &&
            context.launchsLocalSettingsStoreRoot !== resolve(scope, cwd)
            ? resolve(scope, cwd)
            : null;
        }
        if (context.projectConfigDir !== undefined || context.cwd === null)
          return null;
        const current = resolve(scope, context.cwd);
        return store(scope, context, read, receipts) !== current
          ? current
          : null;
      });
    },
    hasCanonicalRootOwnerUids(root: string) {
      return uidCache.has(root);
    },
    primeCanonicalRootOwnerUids(
      root: string,
      fact: NativePermissionFact<NativeLocalRootUids>,
      scope: NativePermissionScope,
    ): boolean {
      if (uidCache.has(root)) return false;
      const receipts: NativePermissionProvenance[] = [];
      const value = readNativePermissionFact(fact, scope, receipts);
      uidCache.set(root, { value, receipts });
      return true;
    },
    clearCanonicalRootOwnerUids() {
      uidCache.clear();
    },
    clearNormalizedRealHomeDir() {
      homeCache = undefined;
    },
  };
}
