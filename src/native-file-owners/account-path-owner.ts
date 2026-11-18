import { posix } from "node:path";
import type { NativeFileAccountOwner } from "./owner-fragments.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionProvenance,
  type NativePermissionScope,
} from "../native-permission-outcome.js";

export interface NativeProfileEnvironment {
  ANTHROPIC_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
  ANTHROPIC_PROFILE?: string;
  CLAUDE_SECURESTORAGE_CONFIG_DIR?: string;
  /** Raw input for the ci consumer's N.str() producer; M/u5 use other raw fields. */
  CLAUDE_CODE_HOST_CREDS_FILE?: string;
}
export interface NativeAccountPathContext {
  diskless: boolean;
  configDirectory: string;
  configHome: string | null;
  homeDirectory: string;
  environment: Readonly<NativeProfileEnvironment>;
  /** Actual p.of(F().host).primedFiles; absent means the owner established no map. */
  primedFiles?: ReadonlyMap<string, string | null>;
}
export type NativeProfileIo<T> =
  { kind: "value"; value: T } | { kind: "error"; code: string | undefined };
export interface NativeAccountPathReaders {
  context(
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeAccountPathContext>;
  realpath(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<string>>;
  isDirectory(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<boolean>>;
  /** Explicit admitted file owner only; no default filesystem/text reader is installed. */
  readText(
    path: string,
    purpose: "profile-selection" | "profile-configuration",
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<string>>;
}
type ProfilePaths = NativeFileAccountOwner["profileStore"];
type ProfileProjection = {
  value: ProfilePaths;
  complete: boolean;
  cacheHit: boolean;
};
class ActualProfileIoError extends Error {
  constructor(readonly code: string | undefined) {
    super("Actual profile file read failed: " + (code ?? "UNKNOWN"));
  }
}
const missingCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "EROFS",
  "EISDIR",
]);

/** M/xP, over explicit actual native context; API-key auth does not imply null. */
export function nativeProfileStoreDirectory(
  context: NativeAccountPathContext,
): string | null {
  if (context.diskless) return null;
  const explicit = context.environment.ANTHROPIC_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = context.environment.XDG_CONFIG_HOME?.trim();
  if (xdg) return posix.join(xdg, "anthropic");
  const home = context.environment.HOME?.trim();
  return home ? posix.join(home, ".config", "anthropic") : null;
}

/** uC/rwn/oEe/u5: path production only, no environment or personal-store discovery. */
export function nativeCredentialPathGroups(
  context: NativeAccountPathContext,
): NativeFileAccountOwner["signInFiles"] {
  const legacy = posix.join(context.homeDirectory, ".claude");
  const override = context.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const secure = context.diskless
    ? null
    : override === undefined
      ? context.configDirectory
      : (override || legacy).normalize("NFC");
  const roots = [
    ...new Set(
      [context.configHome, legacy, secure].filter(
        (root): root is string => root !== null,
      ),
    ),
  ];
  return [
    {
      kind: "tokens",
      paths: roots.map((root) => posix.join(root, ".credentials.json")),
    },
    {
      kind: "device",
      paths: [posix.join(legacy, ".device-keys.json").normalize("NFC")],
    },
    {
      kind: "lock",
      paths: roots.map((root) => posix.join(root, ".storage-write.lock")),
    },
  ];
}

/** Concrete source computation over owned data/metadata readers. No default reader exists. */
export function createNativeAccountPathOwner(
  readers: NativeAccountPathReaders,
) {
  let cache:
    | { value: ProfilePaths; receipts: readonly NativePermissionProvenance[] }
    | undefined;
  function known<T>(
    value: T,
    scope: NativePermissionScope,
    receipts: readonly NativePermissionProvenance[],
    contracts: readonly string[],
  ): NativePermissionFact<T> {
    return {
      status: "known",
      value,
      provenance: {
        provider:
          "native-account-path-owner(" +
          [...new Set(receipts.map((row) => row.provider))].join(",") +
          ")",
        sourceContracts: [
          ...new Set([
            ...contracts,
            ...receipts.flatMap((row) => row.sourceContracts),
          ]),
        ],
        scope,
      },
    };
  }
  function unsupported(error: unknown): NativePermissionFact<never> {
    return {
      status: "unsupported",
      dependency:
        error instanceof NativePermissionDependencyError
          ? error.dependency
          : "native-account-path-owner",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  function profile(
    scope: NativePermissionScope,
  ): NativePermissionFact<ProfileProjection> {
    if (cache !== undefined)
      return known(
        { value: cache.value, complete: true, cacheHit: true },
        scope,
        cache.receipts,
        ["Eur/complete-cache"],
      );
    const receipts: NativePermissionProvenance[] = [];
    const read = <T>(fact: NativePermissionFact<T>) =>
      readNativePermissionFact(fact, scope, receipts);
    try {
      const context = read(readers.context(scope));
      const store = nativeProfileStoreDirectory(context);
      if (store === null) {
        cache = { value: null, receipts };
        return known(
          { value: null, complete: true, cacheHit: false },
          scope,
          receipts,
          ["M/xP/Eur/ye"],
        );
      }
      function canonical(path: string): string {
        let current = posix.resolve(scope.cwd, path);
        let tail = "";
        for (;;) {
          const located = read(readers.realpath(current, scope));
          if (located.kind === "value")
            return posix.join(located.value, tail).toLowerCase();
          const parent = posix.dirname(current);
          if (parent === current)
            return posix.join(current, tail).toLowerCase();
          tail = tail
            ? posix.join(posix.basename(current), tail)
            : posix.basename(current);
          current = parent;
        }
      }
      function coversCwd(path: string): boolean {
        const root = canonical(path);
        if (root === posix.parse(root).root) return true;
        const relative = posix.relative(root, canonical(scope.cwd));
        return (
          relative === "" ||
          (relative.split("/")[0] !== ".." && !posix.isAbsolute(relative))
        );
      }
      function text(
        path: string,
        purpose: "profile-selection" | "profile-configuration",
      ): string | null {
        if (context.primedFiles?.has(path))
          return context.primedFiles.get(path) ?? null;
        const result = read(
          readers.readText(posix.resolve(scope.cwd, path), purpose, scope),
        );
        if (result.kind === "value") return result.value;
        if (result.code !== undefined && missingCodes.has(result.code))
          return null;
        throw new ActualProfileIoError(result.code);
      }
      // The public file snapshot names this field directories. Source ye uses
      // dirs internally; preserve only the actual path producer semantics here.
      let value: Exclude<ProfilePaths, null> = {
        directories: [store],
        files: [],
      };
      try {
        const resolved = posix.resolve(scope.cwd, store);
        value = coversCwd(resolved)
          ? {
              directories: [
                posix.join(resolved, "configs"),
                posix.join(resolved, "credentials"),
              ],
              files: [posix.join(resolved, "active_config")],
            }
          : { directories: [resolved], files: [] };
        const selected =
          context.environment.ANTHROPIC_PROFILE?.trim() ||
          text(
            posix.join(store, "active_config"),
            "profile-selection",
          )?.trim() ||
          "default";
        const raw = text(
          posix.join(store, "configs", selected + ".json"),
          "profile-configuration",
        );
        let parsed: unknown;
        if (raw !== null)
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* A retains the actual default on invalid JSON. */
          }
        let candidate: unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "authentication" in parsed
        ) {
          const auth = parsed.authentication;
          if (
            typeof auth === "object" &&
            auth !== null &&
            "credentials_path" in auth
          )
            candidate = auth.credentials_path;
        }
        const fallback = posix.join(store, "credentials", selected + ".json");
        candidate ??= fallback;
        if (!candidate) candidate = fallback;
        const reference = typeof candidate === "string" ? candidate : null;
        const paths =
          reference === null || !reference.trim()
            ? []
            : posix.isAbsolute(reference)
              ? [posix.resolve(reference)]
              : [
                  ...new Set([
                    posix.resolve(scope.cwd, store, reference),
                    posix.resolve(scope.cwd, reference),
                  ]),
                ];
        const extra = paths.filter((path) => {
          if (
            value.directories.some(
              (root) => path === root || path.startsWith(root + "/"),
            ) ||
            value.files.includes(path) ||
            coversCwd(path)
          )
            return false;
          const directory = read(readers.isDirectory(path, scope));
          return directory.kind === "error" || !directory.value;
        });
        value = {
          directories: value.directories,
          files: [...value.files, ...extra],
        };
        cache = { value, receipts: [...receipts] };
        return known(
          { value, complete: true, cacheHit: false },
          scope,
          receipts,
          ["M/xP/Eur/ye/A/Ae/Re/ILt/n4e/g/L/b/we"],
        );
      } catch (error) {
        if (!(error instanceof ActualProfileIoError)) throw error;
        return known(
          { value, complete: false, cacheHit: false },
          scope,
          receipts,
          ["Eur/ye/actual-incomplete-fallback"],
        );
      }
    } catch (error) {
      return unsupported(error);
    }
  }
  return {
    profile,
    resetHostRealm() {
      cache = undefined;
    },
    account(
      scope: NativePermissionScope,
    ): NativePermissionFact<NativeFileAccountOwner> {
      const receipts: NativePermissionProvenance[] = [];
      try {
        const context = readNativePermissionFact(
          readers.context(scope),
          scope,
          receipts,
        );
        const paths = readNativePermissionFact(profile(scope), scope, receipts);
        return known(
          {
            hostCredentialsPath:
              context.environment.CLAUDE_CODE_HOST_CREDS_FILE?.trim() || null,
            profileStore: paths.value,
            signInFiles: nativeCredentialPathGroups(context),
          },
          scope,
          receipts,
          ["ci/Eur/uC/rwn/oEe/u5"],
        );
      } catch (error) {
        return unsupported(error);
      }
    },
  };
}
