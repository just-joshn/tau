import { posix } from "node:path";
import {
  inspectNativeMetadataPath,
  NativeMetadataPathError,
  type NativePermissionPathContext,
} from "../native-path-inspection.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionProvenance,
  type NativePermissionScope,
} from "../native-permission-outcome.js";
import type { NativeProfileIo } from "./account-path-owner.js";

export interface NativeConnectorSettingsContext {
  pathContext: NativePermissionPathContext;
  /** Actual mf() can be null even though Ye() has a configured spelling. */
  configHome: string | null;
  homeIsAutomount: boolean;
}
export interface NativeConnectorSettingsReaders {
  context(
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeConnectorSettingsContext>;
  readdir(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<readonly { name: string }[]>>;
  lstatFile(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<{ isFile: boolean; size: number }>>;
  /** Actual O_RDONLY|O_NOFOLLOW|O_NONBLOCK, read at most4 bytes, close descriptor. */
  readMarkerNoFollow(
    path: string,
    maximumBytes: 4,
    scope: NativePermissionScope,
  ): NativePermissionFact<NativeProfileIo<string>>;
}
class ActualConnectorIoError extends Error {}
const connectorFilePattern =
  /^(download-[0-9a-f]{8}(-\d+)?(\.[^./\\]*)?|\..+\.from\.json|\.download-[0-9a-f]{8}(-\d+)?(\.[^./\\]*)?\.part)$/;

/** Ga at the settings connector seam, including fallback after complete folding. */
function foldComponent(value: string): string {
  const original = value
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u017f/g, "s");
  return (
    original
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
      .replace(/:.*$/, "")
      .replace(/[. ]+$/, "") || original
  );
}
export function nativeSettingsConnectorSpelling(path: string): boolean {
  return path
    .split(/[\\/]/)
    .slice(0, -1)
    .some((part) => foldComponent(part) === "connector-downloads");
}

/** dht/IS/MS for the retained POSIX profile; no file/default readers are installed. */
export function createNativeConnectorSettingsOwner(
  readers: NativeConnectorSettingsReaders,
) {
  const cache = new Map<
    string,
    { value: boolean; receipts: readonly NativePermissionProvenance[] }
  >();
  function inside(
    path: string,
    scope: NativePermissionScope,
  ): NativePermissionFact<boolean> {
    const receipts: NativePermissionProvenance[] = [];
    const known = (value: boolean): NativePermissionFact<boolean> => ({
      status: "known",
      value,
      provenance: {
        provider:
          "native-connector-settings-owner(" +
          [...new Set(receipts.map((row) => row.provider))].join(",") +
          ")",
        sourceContracts: [
          ...new Set([
            "dht/IS/MS/$le/ou/Ga",
            ...receipts.flatMap((row) => row.sourceContracts),
          ]),
        ],
        scope,
      },
    });
    const read = <T>(fact: NativePermissionFact<T>): T =>
      readNativePermissionFact(fact, scope, receipts);
    const actual = <T>(result: NativeProfileIo<T>): T => {
      if (result.kind === "error")
        throw new ActualConnectorIoError(
          "Actual connector settings I/O error: " + (result.code ?? "UNKNOWN"),
        );
      return result.value;
    };
    try {
      const cached = cache.get(path);
      if (cached !== undefined) {
        receipts.push(...cached.receipts);
        return known(cached.value);
      }
      const context = read(readers.context(scope));
      if (
        !context.pathContext.macos ||
        context.pathContext.cwd !== scope.cwd ||
        typeof context.homeIsAutomount !== "boolean"
      )
        throw new NativePermissionDependencyError(
          "native-connector-settings-context",
          "Actual retained macOS evaluation context and automount owner are required",
        );
      function marker(file: string): boolean {
        try {
          const inspected = inspectNativeMetadataPath(
            file,
            context.pathContext,
            { homeIsAutomount: context.homeIsAutomount },
          );
          if (
            actual(
              read(readers.readdir(file.replace(/[\\/][^\\/]*$/, ""), scope)),
            ).some((entry) => connectorFilePattern.test(entry.name))
          )
            return true;
          if (inspected.absentAt !== undefined) return false;
          const metadata = actual(read(readers.lstatFile(file, scope)));
          if (!metadata.isFile || metadata.size > 3) return false;
          const text = actual(read(readers.readMarkerNoFollow(file, 4, scope)));
          return ["*", "*\n", "*\r\n"].includes(text);
        } catch (error) {
          if (error instanceof NativePermissionDependencyError) throw error;
          if (
            error instanceof NativeMetadataPathError ||
            error instanceof ActualConnectorIoError
          )
            return true;
          throw error;
        }
      }
      function projectNamespace(candidate: string): boolean {
        if (context.configHome === null) return false;
        const split = (value: string) =>
          value.split(/[\\/]/).map(foldComponent);
        const prefix = split(
          posix.resolve(scope.cwd, posix.join(context.configHome, "projects")),
        );
        const parts = split(candidate);
        return (
          parts.length === prefix.length + 2 &&
          prefix.every((value, index) => value === parts[index]) &&
          /\.[0-9a-f]{16}$/.test(parts.at(-2) ?? "")
        );
      }
      // Retained POSIX ou(path) is [path]. Windows short-name alternatives need
      // their distinct owner and are not replaced by a lexical approximation.
      const parts = posix.resolve(scope.cwd, path).split(/[\\/]/);
      let result = false;
      for (let index = 0; index < parts.length && !result; index++) {
        if (foldComponent(parts[index] ?? "") !== "connector-downloads")
          continue;
        const candidate = parts.slice(0, index + 1).join("/");
        // Fle=nS=posix.join(posix.dirname(nI), nPe), pinned source constants.
        const builtin = posix.join(
          posix.dirname("/mnt/user-data/uploads"),
          "/connector-downloads",
        );
        result =
          candidate === builtin ||
          projectNamespace(candidate) ||
          marker(candidate + "/.gitignore");
      }
      if (cache.size >= 64) cache.clear();
      if (result || !path.includes("~"))
        cache.set(path, { value: result, receipts: [...receipts] });
      return known(result);
    } catch (error) {
      return {
        status: "unsupported",
        dependency:
          error instanceof NativePermissionDependencyError
            ? error.dependency
            : "native-connector-settings-owner",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    inside,
    clear() {
      cache.clear();
    },
  };
}
