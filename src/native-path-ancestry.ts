import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import {
  nativeAutomountRoot,
  nativeKernelPath,
  nativeNetworkHost,
  nativeNetworkVolume,
  nativeUncPath,
} from "./native-path-inspection.js";

export interface NativeAncestryFilesystem {
  lstat(path: string): {
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    dev: bigint;
    ino: bigint;
  };
  readlink(path: string): string;
  realpath(path: string): string;
}
export const nativeLocalAncestryFilesystem: NativeAncestryFilesystem = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  readlink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync.native(path),
};
export interface NativeAncestryReport {
  chain?: { path: string; dev: bigint; ino: bigint }[];
  metLink?: boolean;
  endedMissing?: boolean;
  unclassifiable?: string;
}
const dots = (path: string) => /(^|[\\/])\.{1,2}[. ]*([\\/]|$)/.test(path);
function dosDevice(part: string): boolean {
  const dot = part.indexOf(".");
  const base = (dot === -1 ? part : part.slice(0, dot)).replace(/ +$/, "");
  return /^(con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])$/i.test(
    base,
  );
}
/** qhe is lexical even on the retained POSIX host. */
export function nativeAncestryPathSpelling(path: string): string {
  const prefix = /^(?:\\\\[?.]\\|\\\?\?\\)(?=[A-Za-z]:[\\/])/.exec(path);
  if (prefix === null) return path;
  const drive = path.slice(prefix[0].length);
  const rest = drive.slice(2);
  const suspect =
    dots(rest) ||
    /[. :](?=[\\/]|$)/.test(rest) ||
    rest
      .split(/[\\/]/)
      .some(
        (part) =>
          dosDevice(part) ||
          dosDevice(part.slice(0, Math.max(0, part.indexOf(":")))),
      );
  return (prefix[0].includes("\\") && rest.includes("/")) || suspect
    ? path
    : drive;
}
export function nativeAncestryNetworkShape(path: string): boolean {
  const text = nativeAncestryPathSpelling(path);
  return (
    nativeUncPath(text) ||
    nativeNetworkHost(text) !== null ||
    nativeAutomountRoot(text) ||
    nativeNetworkVolume(text) ||
    nativeKernelPath(text) ||
    /^[\\/](GLOBAL\?\?|GLOBALROOT|DosDevices|Device)[\\/]/i.test(text)
  );
}
function code(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
/** eZ/Ris/y: actual retained POSIX metadata traversal. Yet and Tt are pinned no-ops. */
export function nativePermissionAncestryRisk(
  path: string,
  filesystem: NativeAncestryFilesystem,
  report?: NativeAncestryReport,
): boolean {
  function inspect(input: string): boolean {
    const spelling = nativeAncestryPathSpelling(input);
    if (!posix.isAbsolute(spelling)) return true;
    if (report) {
      report.chain = [];
      report.metLink = false;
      report.endedMissing = false;
    }
    function walk(
      start: string,
      parts: readonly string[],
      hops: number,
    ): boolean {
      if (nativeAncestryNetworkShape(start)) return true;
      let current = start;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (part === undefined || part === ".") continue;
        if (part === "..") {
          current = posix.dirname(current);
          continue;
        }
        const next = posix.join(current, part);
        if (nativeAncestryNetworkShape(next)) return true;
        let metadata: ReturnType<NativeAncestryFilesystem["lstat"]>;
        try {
          metadata = filesystem.lstat(next);
        } catch (error) {
          const errno = code(error);
          if (errno !== "ENOENT" && errno !== "ENOTDIR") {
            if (report) report.unclassifiable = errno ?? "UNKNOWN";
            return true;
          }
          if (report) report.endedMissing = true;
          let remaining = next;
          for (const tail of parts.slice(index + 1)) {
            remaining =
              tail === ".."
                ? posix.dirname(remaining)
                : tail === "."
                  ? remaining
                  : posix.join(remaining, tail);
            if (nativeAncestryNetworkShape(remaining)) return true;
          }
          return false;
        }
        if (!metadata.isSymbolicLink()) {
          if (metadata.isDirectory())
            report?.chain?.push({
              path: next,
              dev: metadata.dev,
              ino: metadata.ino,
            });
          current = next;
          continue;
        }
        if (report) report.metLink = true;
        if (hops >= 40) return true;
        let text: string;
        try {
          text = filesystem.readlink(next);
        } catch (error) {
          if (report) report.unclassifiable = code(error) ?? "UNKNOWN";
          return true;
        }
        const linked = text.replace(/^\/{2,}/, "/");
        if (nativeAncestryNetworkShape(linked)) return true;
        const remaining = parts.slice(index + 1);
        if (posix.isAbsolute(linked)) {
          const root = posix.parse(linked).root;
          return walk(
            root,
            [
              ...linked.slice(root.length).split(/\/+/).filter(Boolean),
              ...remaining,
            ],
            hops + 1,
          );
        }
        return walk(
          current,
          [...linked.split(/\/+/).filter(Boolean), ...remaining],
          hops + 1,
        );
      }
      return false;
    }
    const root = posix.parse(spelling).root;
    return walk(
      root,
      spelling.slice(root.length).split(/\/+/).filter(Boolean),
      0,
    );
  }
  return (
    inspect(path) ||
    (dots(path) && inspect(posix.resolve(posix.parse(path).root || "/", path)))
  );
}
function physicalSpelling(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice(8);
  if (path.startsWith("\\\\?\\") && path.length >= 7 && path[5] === ":")
    return path.slice(4);
  return path;
}
/** uS, with an explicit cwd replacing the source's implicit path.resolve base. */
export function nativePermissionComparablePath(
  path: string,
  options: {
    cwd: string;
    filesystem: NativeAncestryFilesystem;
    foldCase?: boolean;
    knownNotSuspect?: boolean;
  },
): string {
  if (!posix.isAbsolute(options.cwd) || options.cwd.includes("\0"))
    throw new TypeError("Comparable paths require an explicit absolute cwd");
  const spelling = nativeAncestryPathSpelling(path);
  const finish = (value: string) =>
    options.foldCase === false
      ? value.normalize("NFC")
      : value.normalize("NFC").toLowerCase();
  const absolute = posix.resolve(options.cwd, spelling);
  if (nativeUncPath(spelling) || nativeNetworkHost(spelling) !== null)
    return finish(absolute);
  if (
    !options.knownNotSuspect &&
    nativePermissionAncestryRisk(absolute, options.filesystem)
  )
    return finish(absolute);
  let current = absolute;
  const missing: string[] = [];
  let canonical: string | undefined;
  for (;;) {
    try {
      canonical = physicalSpelling(options.filesystem.realpath(current));
    } catch {
      canonical = undefined;
    }
    if (canonical !== undefined || posix.dirname(current) === current) break;
    missing.unshift(posix.basename(current));
    current = posix.dirname(current);
  }
  return finish(
    missing.length
      ? posix.resolve(canonical ?? current, ...missing)
      : (canonical ?? current),
  );
}
export function nativePermissionComparableContains(
  root: string,
  path: string,
): boolean {
  const relative = posix.relative(root, path);
  return (
    relative === "" ||
    (!posix.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith("../"))
  );
}
