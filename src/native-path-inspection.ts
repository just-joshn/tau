import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import type { NativeFilePermissionInspection } from "./native-file-adjudication.js";

export interface NativePermissionPathFilesystem {
  lstat(path: string): { isSymbolicLink(): boolean };
  openDirectoryNoFollow(path: string): void;
  readlink(path: string): string;
  realpath(path: string): string;
}

/** Metadata operations only. Callers own filesystem admission and operation-time revalidation. */
export const nativeLocalPermissionPathFilesystem: NativePermissionPathFilesystem =
  {
    lstat: (path) => lstatSync(path),
    openDirectoryNoFollow(path) {
      const descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      closeSync(descriptor);
    },
    readlink: (path) => readlinkSync(path),
    realpath: (path) => realpathSync(path),
  };

export interface NativePermissionPathContext {
  cwd: string;
  home: string;
  initialCwd: string | null;
  /** Native retained Mach-O uses Node's POSIX path operations. */
  filesystem: NativePermissionPathFilesystem;
  /** The source dh gate changes prefix treatment of absolute link text. */
  macos: boolean;
}

const hasDots = (path: string) => /(^|[\\/])\.{1,2}[. ]*([\\/]|$)/.test(path);
const hasExactDots = (path: string) => /(^|\/)\.{1,2}(\/|$)/.test(path);
const namespace = (path: string) =>
  /^[\\/]\?\?[\\/]/.test(path) ||
  (path.includes("??") && /^[\\/]\?\?[\\/]/.test(win32.normalize(path)));
export const nativeUncPath = (path: string): boolean =>
  /^[\\/]{2}/.test(path) || namespace(path);
export function nativeLocalWslPath(path: string): boolean {
  const match = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]*)/i.exec(path);
  return match !== null && !/^\.{0,2}[. ]*$/.test(match[1] ?? "");
}
function foldedComponents(path: string): string[] {
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") parts.pop();
    else parts.push(component);
  }
  return parts;
}
export function nativeNetworkHost(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      parts.pop();
      continue;
    }
    parts.push(component);
    if (
      (parts.length === 2 && networkFold(parts[0] ?? "") === "net") ||
      (parts.length === 3 &&
        networkFold(parts[0] ?? "") === "network" &&
        networkFold(parts[1] ?? "") === "servers")
    )
      return "/" + parts.join("/");
  }
  return null;
}
function networkFold(value: string): string {
  return value
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
    .toUpperCase()
    .toLowerCase();
}
export function nativeNetworkVolume(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") parts.pop();
    else {
      parts.push(component);
      if (parts.length === 1 && parts[0]?.toLowerCase() === "network")
        return true;
    }
  }
  return false;
}
export function nativeAutomountRoot(path: string): boolean {
  const parts = foldedComponents(path);
  return (
    path.startsWith("/") &&
    parts.length === 1 &&
    parts[0]?.toLowerCase() === "net"
  );
}
export function nativeKernelPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") parts.pop();
    else {
      parts.push(component);
      if (
        parts.length === 1 &&
        /^\.(?:vol|file|nofollow|resolve)$/i.test(component)
      )
        return true;
    }
  }
  return false;
}
function validateContext(context: NativePermissionPathContext): void {
  for (const path of [context.cwd, context.home, context.initialCwd])
    if (path !== null && (!posix.isAbsolute(path) || path.includes("\0")))
      throw new TypeError(
        "Native path context requires explicit absolute POSIX roots",
      );
}

/** wt/mb, separate from pa and from Bash op's whitespace-preserving spelling. */
export function normalizeNativePermissionPath(
  path: string,
  context: Pick<NativePermissionPathContext, "cwd" | "home">,
  stable = false,
): string {
  for (const root of [context.cwd, context.home])
    if (!posix.isAbsolute(root) || root.includes("\0"))
      throw new TypeError(
        "Native normalization requires explicit absolute POSIX roots",
      );
  if (path.includes("\0")) throw new TypeError("Path contains a null byte");
  const normalize = (value: string) => {
    const text = value.trim();
    const expanded =
      text === "~"
        ? context.home
        : text.startsWith("~/")
          ? posix.join(context.home, text.slice(2))
          : text;
    return posix.resolve(context.cwd, expanded).normalize("NFC");
  };
  const result = normalize(path);
  if (stable && normalize(result) !== result)
    throw new Error(
      "UnstablePathError: path has trailing whitespace after normalization",
    );
  return result;
}

/** Qd for the retained POSIX host. wt trimming occurs at this comparison seam. */
export function nativePermissionPathContained(
  path: string,
  root: string,
  context: Pick<NativePermissionPathContext, "cwd" | "home">,
  options?: {
    caseFold?: boolean;
    skipPrivateAlias?: boolean;
    uncShapeParity?: boolean;
  },
): boolean {
  const target = normalizeNativePermissionPath(path, context);
  const base = normalizeNativePermissionPath(root, context);
  if (
    options?.uncShapeParity &&
    (nativeUncPath(target) !== nativeUncPath(base) ||
      nativeUncPath(path) !== nativeUncPath(root))
  )
    return false;
  // Source's default applies to the entire options object, not an omitted field.
  const foldCase = options === undefined ? true : options.caseFold;
  const stripAlias = (value: string) => {
    if (options?.skipPrivateAlias) return value;
    return value
      .replace(foldCase ? /^\/private\/var\//i : /^\/private\/var\//, "/var/")
      .replace(
        foldCase ? /^\/private\/tmp(\/|$)/i : /^\/private\/tmp(\/|$)/,
        "/tmp$1",
      );
  };
  const comparable = (value: string) =>
    foldCase
      ? value
          .toLowerCase()
          .replace(/\u0131/g, "i")
          .replace(/\u017f/g, "s")
      : value;
  const relative = posix.relative(
    comparable(stripAlias(base)),
    comparable(stripAlias(target)),
  );
  if (relative === "") return true;
  if (/(?:^|[\\/])\.\.([\\/]|$)/.test(relative)) return false;
  return !posix.isAbsolute(relative);
}

function within(path: string, root: string): boolean {
  const base = root.length > 1 ? root.replace(/\/+$/, "") : root;
  return path === base || path.startsWith(base === "/" ? base : base + "/");
}
function prefixBeforeDots(path: string): string {
  let prefix = "";
  for (const part of path.split(/([\\/]+)/)) {
    if (part === "." || part === "..") break;
    prefix += part;
  }
  return prefix.replace(/(?<=[^\\/])[\\/]+$/, "") || path;
}
function rawNetworkPrefix(path: string): string {
  if (path.startsWith("\\\\")) return prefixBeforeDots(path);
  const collapsed = path.replace(/^\/+/, "/");
  return nativeNetworkHost(collapsed) ?? prefixBeforeDots(path);
}
function linkNetworkProbe(path: string, macos: boolean): string {
  if (!macos || path.includes("\uFFFD")) return path;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === ".." && parts.length > 1) break;
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("errno" in error && typeof error.errno === "string") return error.errno;
  return undefined;
}

type QueryFailure = { errno: string | undefined };
type NativePathQuery = <T>(
  kind: "lstat" | "opendir" | "readlink" | "realpath",
  value: string,
  operation: () => T,
) => T | QueryFailure;
type Outcome =
  | {
      kind: "absent";
      at: string;
      remaining: string[];
      fromLinkTarget?: boolean;
      notAFolder?: true;
    }
  | { kind: "resolved"; path: string };
const unverified = Symbol("native-unverified-ancestry");
const undecodable = Symbol("native-undecodable-link-text");

export interface NativeMetadataPathOptions {
  failClosed?: boolean;
  /** Actual ht owner result on macOS; no system/default reader is installed. */
  homeIsAutomount: boolean;
}
export interface NativeMetadataPathInspection {
  resolvedPath: string;
  isSymlink: false;
  isCanonical: false;
  linksResolvedPath: string | undefined;
  absentAt:
    | {
        at: string;
        remaining: string[];
        fromLinkTarget: boolean;
        notAFolder?: true;
      }
    | undefined;
}
/** Native metadata refusal, distinct from an unavailable factual owner. */
export class NativeMetadataPathError extends Error {
  readonly code = "ERR_SYMLINK_TO_NETWORK_PATH";
  constructor(
    message: string,
    readonly path: string,
    readonly reason: "unexamined" | "network",
  ) {
    super(message);
  }
}
interface MetadataWalkProfile {
  anchors: readonly string[] | undefined;
  unreadableUnverified: boolean;
  homeIsAutomount: boolean;
}
function metadataNamespace(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice(8);
  if (path.startsWith("\\\\?\\") && path.length >= 7 && path[5] === ":")
    return path.slice(4);
  return path;
}
function metadataDeviceNamespace(path: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(path) || /^[\\/]\?\?[\\/]/.test(path);
}
function metadataUncProvider(path: string): string | null {
  if (/^[\\/]{2}[?.][\\/](?!unc[\\/])/i.test(path)) return null;
  return (
    /^[\\/]{2}(?:[?.][\\/]unc[\\/])?([^\\/]+)/i
      .exec(path)?.[1]
      ?.replace(/[A-Z]/g, (value) => value.toLowerCase()) ?? null
  );
}
function metadataSystemAlias(path: string): string {
  const parts = path.split("/");
  const fold = (value: string) => value.toUpperCase().toLowerCase();
  if (
    parts.length < 5 ||
    parts[0] !== "" ||
    fold(parts[1] ?? "") !== "system" ||
    fold(parts[2] ?? "") !== "volumes" ||
    fold(parts[3] ?? "") !== "data"
  )
    return path;
  const tail = parts.slice(4);
  for (const root of [
    "usr/local",
    "usr/libexec/cups",
    "usr/share/snmp",
    "AppleInternal",
    "Applications",
    "Library",
    "Users",
    "Volumes",
    "cores",
    "home",
    "media",
    "mnt",
    "opt",
    "pkg",
    "private",
    "sw",
  ]) {
    const prefix = root.split("/");
    if (
      tail.length >= prefix.length &&
      prefix.every((value, index) => fold(tail[index] ?? "") === fold(value))
    )
      return "/" + tail.join("/");
  }
  return path;
}
function metadataAliasShapes(
  path: string,
  context: NativePermissionPathContext,
  profile: MetadataWalkProfile,
): { complete: string[]; partial: string[] } {
  const complete: string[] = [],
    partial: string[] = [];
  if (!path.startsWith("/")) return { complete, partial };
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      parts.pop();
      continue;
    }
    parts.push(component);
    if (parts.length > 6) continue;
    const prefix = "/" + parts.join("/");
    const aliases = (context.macos ? metadataSystemAlias(prefix) : prefix)
      .split("/")
      .filter(Boolean);
    const head = aliases[0]?.toLowerCase();
    const ascii = (value: string) =>
      value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (head === "network") {
      if (aliases.length === 1) partial.push("/network/");
      else if (aliases.length === 2)
        partial.push(`/network/${ascii(aliases[1] ?? "")}/`);
      else if (aliases.length === 3)
        complete.push(
          `/network/${ascii(aliases[1] ?? "")}/${ascii(aliases[2] ?? "")}`,
        );
    } else if (
      profile.homeIsAutomount &&
      head === "home" &&
      aliases.length === 2
    )
      complete.push(`/home/${aliases[1] ?? ""}`);
  }
  return { complete, partial };
}
function metadataMacSuspect(
  path: string,
  context: NativePermissionPathContext,
  profile: MetadataWalkProfile,
): boolean {
  if (!context.macos) return false;
  if (nativeNetworkVolume(path) || nativeKernelPath(path)) return true;
  if (!path.startsWith("/")) return false;
  const shape = metadataAliasShapes(path, context, profile);
  if (
    shape.partial.length ||
    shape.complete.some((value) => value.startsWith("/network/"))
  )
    return true;
  const home = /^\/home\/([^/]+)/.exec(metadataSystemAlias(context.home));
  const own = home ? `/home/${home[1] ?? ""}` : null;
  return shape.complete.some(
    (value) => value.startsWith("/home/") && value !== own,
  );
}
function metadataDifferent(
  path: string,
  anchor: string,
  context: NativePermissionPathContext,
  profile: MetadataWalkProfile,
): boolean {
  if (nativeKernelPath(path)) return true;
  if (
    nativeNetworkHost(path) !== null &&
    (metadataNetworkProvider(path) === null ||
      metadataNetworkProvider(path) !== metadataNetworkProvider(anchor))
  )
    return true;
  if (!context.macos || !metadataMacSuspect(path, context, profile))
    return false;
  const expected =
    metadataAliasShapes(anchor, context, profile).complete[0] ?? null;
  const shape = metadataAliasShapes(path, context, profile);
  return (
    (!shape.complete.length && !shape.partial.length) ||
    expected === null ||
    shape.complete.some((value) => value !== expected) ||
    shape.partial.some((value) => !expected.startsWith(value))
  );
}
function metadataNetworkProvider(path: string): string | null {
  return (
    nativeNetworkHost(path)
      ?.split("/")
      .at(-1)
      ?.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) ?? null
  );
}
function metadataForeignUnc(
  path: string,
  anchors: readonly string[] | undefined,
): boolean {
  if (!nativeUncPath(path)) return false;
  if (metadataDeviceNamespace(path) || namespace(path) || hasDots(path))
    return true;
  const provider = metadataUncProvider(path);
  return (
    anchors === undefined ||
    anchors.every(
      (anchor) => provider === null || provider !== metadataUncProvider(anchor),
    )
  );
}
function commonLaunchAncestry(
  context: NativePermissionPathContext,
): string | null {
  const initial = context.initialCwd;
  if (
    initial === null ||
    posix.parse(initial).root !== posix.parse(context.cwd).root
  )
    return null;
  const left = posix.resolve(initial).split(/\/+/).filter(Boolean);
  const right = posix.resolve(context.cwd).split(/\/+/).filter(Boolean);
  let index = 0;
  while (index < left.length && left[index] === right[index]) index++;
  return index > 0 ? "/" + left.slice(0, index).join("/") : null;
}

function joinedNetwork(
  base: string,
  remaining: string[],
  onCollapsed?: (path: string) => void,
): string {
  const dots = hasDots(base);
  if (
    remaining.length === 0 ||
    dots ||
    remaining.some((part) => part === "." || part === "..")
  ) {
    if (remaining.length > 0 || dots)
      onCollapsed?.(posix.join(base, ...remaining));
    return dots ? rawNetworkPrefix(base) : base;
  }
  return posix.join(base, ...remaining);
}

function walkNativePath(
  input: string,
  context: NativePermissionPathContext,
  query: NativePathQuery,
  launchAncestry: string | null,
  observers: {
    onHop(composed: string, leaf: boolean, text: string): void;
    onOutcome?: (value: Outcome) => void;
    onCollapsed?: (path: string) => void;
  },
  metadata?: MetadataWalkProfile,
): string | typeof unverified | typeof undecodable | undefined {
  const fs = context.filesystem;
  const foreign = (path: string) =>
    metadata === undefined ||
    metadata.anchors === undefined ||
    metadata.anchors.every((anchor) =>
      metadataDifferent(path, anchor, context, metadata),
    );
  const volumeAllowed = (path: string) =>
    metadata !== undefined &&
    metadata.anchors !== undefined &&
    metadata.anchors.some(
      (anchor) =>
        nativeNetworkVolume(anchor) &&
        !metadataDifferent(path, anchor, context, metadata) &&
        (within(path, anchor) || nativeNetworkHost(path) !== null),
    );
  const volumeAncestor = (path: string) =>
    metadata !== undefined &&
    metadata.anchors !== undefined &&
    metadata.anchors.some(
      (anchor) => nativeNetworkVolume(anchor) && within(anchor, path),
    );
  if (metadata !== undefined) {
    if (nativeNetworkVolume(input) && !volumeAllowed(input)) return input;
    if (
      (nativeUncPath(input) &&
        !nativeLocalWslPath(input) &&
        metadataForeignUnc(input, metadata.anchors)) ||
      (nativeNetworkHost(input) !== null && foreign(input))
    )
      return;
  }
  const absolute = posix.resolve(context.cwd, input);
  let current = posix.parse(absolute).root;
  let pending = absolute.slice(current.length).split(/\/+/).filter(Boolean);
  let hops = 0;
  let originalTail = pending.length;
  let unverifiedLaunch = false;
  let inspectedExisting = false;
  let networkLanding: string | undefined;
  const seen = new Set<string>();
  while (pending.length > 0 && hops < 64) {
    const part = pending[0];
    if (part === undefined) break;
    if (unverifiedLaunch && hasDots(part)) return unverified;
    const next = posix.join(current, part);
    if (
      metadata === undefined
        ? nativeNetworkHost(next) !== null || nativeNetworkVolume(next)
        : (nativeNetworkHost(next) !== null && foreign(next)) ||
          (nativeNetworkVolume(next) &&
            !(volumeAllowed(next) || volumeAncestor(next)))
    )
      return joinedNetwork(next, pending.slice(1), observers.onCollapsed);
    if (nativeKernelPath(next)) return unverified;
    const descriptor = next !== "/dev/fd" && within(next, "/dev/fd");
    if (
      descriptor &&
      posix.dirname(next) === "/dev/fd" &&
      pending.some(
        (value, index) => index > 0 && (value === "." || value === ".."),
      )
    ) {
      pending.shift();
      while (pending[0] === "." && pending.length > 1) pending.shift();
      current = next;
      continue;
    }
    const entryMetadata = descriptor
      ? { errno: "ENOENT" }
      : query("lstat", next, () => fs.lstat(next));
    if ("errno" in entryMetadata) {
      const errno = entryMetadata.errno;
      if (
        errno !== undefined &&
        errno !== "ENOENT" &&
        errno !== "ENOTDIR" &&
        errno !== "ENAMETOOLONG"
      ) {
        const opened = query("opendir", next, () => {
          fs.openDirectoryNoFollow(next);
          return "ok";
        });
        if (typeof opened === "string") {
          inspectedExisting = true;
          pending.shift();
          current = next;
          continue;
        }
      }
      if (
        launchAncestry &&
        !inspectedExisting &&
        (errno === "EPERM" || errno === "EACCES") &&
        next !== launchAncestry &&
        within(launchAncestry, next)
      ) {
        unverifiedLaunch = true;
        pending.shift();
        current = next;
        continue;
      }
      if (errno === "ENOENT" || errno === "ENOTDIR")
        observers.onOutcome?.({
          kind: "absent",
          at: current,
          remaining: [...pending],
          ...(metadata === undefined
            ? {}
            : {
                fromLinkTarget: pending.length > originalTail,
                ...(errno === "ENOTDIR" ? { notAFolder: true as const } : {}),
              }),
        });
      if (errno === "ENOENT" || errno === "ENOTDIR") return;
      if (
        errno === "ENAMETOOLONG" &&
        hops === 0 &&
        !pending.some(hasDots) &&
        !/[. ]$/.test(part)
      )
        return;
      return metadata !== undefined && !metadata.unreadableUnverified
        ? undefined
        : unverified;
    }
    inspectedExisting = true;
    if (!entryMetadata.isSymbolicLink()) {
      pending.shift();
      current = next;
      continue;
    }
    hops++;
    const key = next + "\0" + pending.join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    const text = query("readlink", next, () => fs.readlink(next));
    if (typeof text !== "string")
      return metadata !== undefined &&
        (!metadata.unreadableUnverified ||
          text.errno === "ENOENT" ||
          text.errno === "ENOTDIR")
        ? undefined
        : unverified;
    if (metadata !== undefined && text.includes("\uFFFD")) return undecodable;
    if (networkLanding !== undefined && text.includes("\uFFFD"))
      return networkLanding;
    if (!posix.isAbsolute(text)) {
      const linked = text.split(/\/+/).filter(Boolean);
      if (metadata !== undefined) {
        const raw =
          (current.endsWith("/") ? current : current + "/") +
          [...linked, ...pending.slice(1)].join("/");
        if (
          nativeNetworkHost(raw) !== null &&
          foreign(nativeNetworkHost(raw) ?? raw)
        ) {
          const collapsedRaw = posix.join(raw);
          if (
            nativeNetworkHost(collapsedRaw) !== null &&
            metadataNetworkProvider(collapsedRaw) ===
              metadataNetworkProvider(raw)
          )
            return collapsedRaw;
          return joinedNetwork(raw, [], observers.onCollapsed);
        }
      }
      pending.shift();
      observers.onHop(
        posix.resolve(current, text, ...pending),
        pending.length === 0,
        text,
      );
      originalTail = Math.min(originalTail, pending.length);
      pending = [...linked, ...pending];
      continue;
    }
    if (
      metadata !== undefined &&
      pending.length > 1 &&
      nativeAutomountRoot(text)
    ) {
      const raw = [text, ...pending.slice(1)].join("/");
      const host = nativeNetworkHost(raw);
      if (host !== null && foreign(host)) {
        const normalized = posix.join(raw);
        if (
          nativeNetworkHost(normalized) !== null &&
          metadataNetworkProvider(normalized) === metadataNetworkProvider(host)
        )
          return normalized;
        return joinedNetwork(raw, [], observers.onCollapsed);
      }
    }
    if (
      metadata === undefined
        ? (nativeUncPath(text) && !nativeLocalWslPath(text)) ||
          nativeNetworkHost(linkNetworkProbe(text, context.macos)) !== null ||
          (!hasDots(text) && nativeNetworkVolume(text))
        : (nativeUncPath(text) &&
            !nativeLocalWslPath(text) &&
            metadataForeignUnc(text, metadata.anchors)) ||
          (nativeNetworkHost(text) !== null && foreign(text)) ||
          (!hasDots(text) &&
            nativeNetworkVolume(text) &&
            !(
              volumeAllowed(text) ||
              (pending.length > 1 && volumeAncestor(text))
            ))
    ) {
      pending.shift();
      return joinedNetwork(text, pending, observers.onCollapsed);
    }
    if (nativeNetworkHost(text) !== null || nativeNetworkVolume(text))
      observers.onCollapsed?.(posix.join(text, ...pending.slice(1)));
    if (nativeNetworkHost(text) !== null)
      networkLanding ??= rawNetworkPrefix(text);
    else if (nativeNetworkVolume(text)) networkLanding ??= "/Network";
    if (networkLanding !== undefined && text.includes("\uFFFD"))
      return networkLanding;
    if (
      metadata !== undefined &&
      hasDots(text) &&
      (nativeUncPath(text) ||
        nativeNetworkHost(text) !== null ||
        nativeNetworkVolume(text) ||
        nativeAutomountRoot(text))
    ) {
      pending.shift();
      return pending.length === 0 ? text : text + "/" + pending.join("/");
    }
    pending.shift();
    const root = posix.parse(text).root || "/";
    observers.onHop(
      pending.length === 0 ? text : posix.resolve(text, ...pending),
      pending.length === 0,
      text,
    );
    current = root;
    inspectedExisting = false;
    originalTail = Math.min(originalTail, pending.length);
    pending = [
      ...text.slice(root.length).split(/\/+/).filter(Boolean),
      ...pending,
    ];
  }
  if (pending.length > 0) return unverified;
  if (hops > 0 && nativeAutomountRoot(current)) return current;
  if (
    nativeNetworkVolume(current) &&
    (metadata === undefined || !volumeAllowed(current))
  )
    return current;
  observers.onOutcome?.({ kind: "resolved", path: current });
  return;
}

/** pa permission profile; the screen profile is a separate public entrypoint. */
export function inspectNativePermissionPath(
  path: string,
  context: NativePermissionPathContext,
): NativeFilePermissionInspection {
  return inspectNativePath(path, context, "permission");
}

/** st(...,"screen"), used by L5; it does not authorize a tool operation. */
export function inspectNativeScreenPath(
  path: string,
  context: NativePermissionPathContext,
): NativeFilePermissionInspection {
  return inspectNativePath(path, context, "screen");
}

/** dI/Xe/et metadata profile. This is neither tool admission nor an open receipt. */
export function inspectNativeMetadataPath(
  path: string,
  context: NativePermissionPathContext,
  options: NativeMetadataPathOptions,
): NativeMetadataPathInspection {
  validateContext(context);
  if (!context.macos)
    throw new TypeError(
      "Metadata inspection requires the retained macOS path profile",
    );
  if (typeof options.homeIsAutomount !== "boolean")
    throw new TypeError(
      "Metadata inspection requires the actual ht owner result",
    );
  const refusal = (message: string, reason: "unexamined" | "network") =>
    new NativeMetadataPathError(message, path, reason);
  const deviceMessage =
    "Refusing to read a file whose path could not be vetted (a device-namespace spelling; use the plain drive or share path)";
  const plain = metadataNamespace(path);
  if (metadataDeviceNamespace(plain))
    throw refusal(deviceMessage, "unexamined");
  const asWritten = metadataNamespace(posix.resolve(context.cwd, plain));
  if (metadataDeviceNamespace(asWritten))
    throw refusal(deviceMessage, "unexamined");
  const ownHost =
    nativeNetworkVolume(asWritten) ||
    nativeNetworkHost(asWritten) !== null ||
    (nativeUncPath(asWritten) && !nativeLocalWslPath(asWritten));
  const profile: MetadataWalkProfile = {
    anchors: ownHost ? [asWritten] : undefined,
    unreadableUnverified: !ownHost || options.failClosed === true,
    homeIsAutomount: options.homeIsAutomount,
  };
  const query: NativePathQuery = (_kind, _value, operation) => {
    try {
      return operation();
    } catch (error) {
      return { errno: errorCode(error) };
    }
  };
  let outcome: Outcome | undefined;
  const result = walkNativePath(
    asWritten,
    context,
    query,
    profile.unreadableUnverified ? commonLaunchAncestry(context) : null,
    {
      onHop() {},
      onOutcome(value) {
        outcome = value;
      },
    },
    profile,
  );
  if (result !== undefined) {
    if (result === unverified)
      throw refusal(
        "Refusing to read a file whose path could not be vetted (a component that could not be examined, or a symbolic link chain too long to follow)",
        "unexamined",
      );
    if (result === undecodable)
      throw refusal(
        'Refusing to read a file whose path could not be vetted: a symbolic link on its path has a target that may lead to a different folder than the one that was checked (such as a target that is not valid UTF-8, or, on Windows, one with ".." after a folder name), or the path runs through too many links. Replace that link, or the chain of links, with a regular folder or file.',
        "unexamined",
      );
    if (!(nativeNetworkVolume(asWritten) && result === asWritten)) {
      if (!(
        nativeUncPath(result) ||
        nativeNetworkHost(result) !== null ||
        nativeNetworkVolume(result) ||
        nativeAutomountRoot(result)
      ))
        throw refusal(
          "Refusing to read a file whose path could not be vetted (a component that could not be examined, or a symbolic link chain too long to follow)",
          "unexamined",
        );
      throw refusal(
        "Refusing to read a file through a symbolic link that leads onto a network share or automount path; replace the link with a regular file to use it",
        "network",
      );
    }
  }
  return {
    resolvedPath: asWritten,
    isSymlink: false,
    isCanonical: false,
    linksResolvedPath:
      outcome?.kind === "resolved" ? outcome.path.normalize("NFC") : undefined,
    absentAt:
      outcome?.kind === "absent"
        ? {
            at: outcome.at,
            remaining: outcome.remaining,
            fromLinkTarget: outcome.fromLinkTarget === true,
            ...(outcome.notAFolder ? { notAFolder: true } : {}),
          }
        : undefined,
  };
}

function inspectNativePath(
  path: string,
  context: NativePermissionPathContext,
  profile: "permission" | "screen",
): NativeFilePermissionInspection {
  validateContext(context);
  let requested = path;
  if (requested === "~") requested = context.home.normalize("NFC");
  else if (requested.startsWith("~/"))
    requested = posix.join(context.home.normalize("NFC"), requested.slice(2));
  const spellings = new Set([requested]);
  let leafIsSymlink = false;
  let linkTextClimbs = false;
  const resolved = (
    landing: string,
    unexamined = false,
    leaf = leafIsSymlink,
  ): NativeFilePermissionInspection => ({
    unresolved: false,
    requested,
    spellings: [...spellings],
    landing,
    leafIsSymlink: leaf,
    ...(unexamined ? { endsUnexamined: true } : {}),
    ...(linkTextClimbs ? { linkTextClimbs: true } : {}),
  });
  const network = (value: string) =>
    (nativeUncPath(value) && !nativeLocalWslPath(value)) ||
    nativeNetworkHost(value) !== null ||
    nativeNetworkVolume(value);
  if (network(requested)) return resolved(requested, true);
  const fs = context.filesystem;
  let stoppedAt = requested;
  let lastError: string | undefined;
  let readlinkAttempted = false;
  let readlinkError = false;
  let opaqueText = false;
  let directoryLoop = false;
  let outcome: Outcome | undefined;
  const collapsed: string[] = [];
  function query<T>(
    kind: "lstat" | "opendir" | "readlink" | "realpath",
    value: string,
    operation: () => T,
  ): T | QueryFailure {
    stoppedAt = value;
    if (kind === "readlink") readlinkAttempted = true;
    else lastError = undefined;
    try {
      const result = operation();
      opaqueText ||= typeof result === "string" && result.includes("\uFFFD");
      return result;
    } catch (error) {
      const errno = errorCode(error);
      if (kind !== "readlink") {
        lastError = errno;
        directoryLoop ||= kind === "opendir" && errno === "ELOOP";
      } else readlinkError = true;
      return { errno };
    }
  }
  const initial = context.initialCwd;
  // gde takes the common initial/current ancestor; a bare root is not an anchor.
  let launchAncestry: string | null = null;
  if (
    initial !== null &&
    posix.parse(initial).root === posix.parse(context.cwd).root
  ) {
    const left = posix.resolve(initial).split(/\/+/).filter(Boolean);
    const right = posix.resolve(context.cwd).split(/\/+/).filter(Boolean);
    let index = 0;
    while (index < left.length && left[index] === right[index]) index++;
    if (index > 0) launchAncestry = "/" + left.slice(0, index).join("/");
  }
  const unresolved = (): NativeFilePermissionInspection => {
    if (
      profile === "permission" &&
      !readlinkAttempted &&
      (lastError === "ENAMETOOLONG" ||
        lastError === "EACCES" ||
        lastError === "EPERM")
    ) {
      const normalized = requested.normalize("NFC");
      spellings.add(normalized);
      return resolved(normalized, false, false);
    }
    return {
      unresolved: true,
      requested,
      spellings: [...new Set([requested, ...collapsed, ...spellings])],
      stoppedAt,
      leafIsSymlink,
      reason: readlinkAttempted || directoryLoop ? "past-a-link" : "unexamined",
    };
  };
  const probePaths: string[] = [];
  const probeKeys = new Set<string>();
  const climbs = (text: string) =>
    /(^|[\\/])\.\.([\\/]|$)/.test(
      posix.isAbsolute(text)
        ? text
        : text.replace(/^(?:\.\.(?:[\\/]+|$))+/, ""),
    );
  function addProbe(path: string) {
    const key = posix.resolve(context.cwd, path);
    if (!probeKeys.has(key)) {
      probeKeys.add(key);
      probePaths.push(path);
    }
  }
  const result = walkNativePath(requested, context, query, launchAncestry, {
    onOutcome: (value) => {
      outcome = value;
    },
    onCollapsed: (value) => {
      collapsed.push(value);
    },
    onHop(composed, leaf, text) {
      if (leaf) {
        spellings.add(composed);
        leafIsSymlink = true;
      }
      if (profile === "screen" && climbs(text)) {
        linkTextClimbs = true;
        addProbe(composed);
      }
    },
  });
  function probeClimbingLinks(): boolean {
    for (let index = 0; index < probePaths.length; index++) {
      if (index >= 8) return false;
      const candidate = probePaths[index];
      if (candidate === undefined) return false;
      if (network(candidate)) {
        spellings.add(candidate);
        continue;
      }
      const result = walkNativePath(candidate, context, query, launchAncestry, {
        onHop(composed, _leaf, text) {
          if (climbs(text)) addProbe(composed);
        },
      });
      if (result === unverified || result === undecodable || readlinkError)
        return false;
      if (result !== undefined) spellings.add(result);
    }
    return true;
  }
  function normalizedRequested(): NativeFilePermissionInspection {
    const normalized = requested.normalize("NFC");
    spellings.add(normalized);
    return resolved(normalized, false, false);
  }
  if (result === unverified || result === undecodable) return unresolved();
  if (result !== undefined) {
    if (profile === "screen" && !probeClimbingLinks()) return unresolved();
    for (const value of collapsed) spellings.add(value);
    spellings.delete(result);
    spellings.add(result);
    return opaqueText ? unresolved() : resolved(result, true);
  }
  if (outcome === undefined) {
    if (profile === "screen" && !readlinkError)
      return probeClimbingLinks() && !opaqueText
        ? normalizedRequested()
        : unresolved();
    return unresolved();
  }
  if (
    outcome.kind === "absent" &&
    (profile === "screen"
      ? outcome.remaining.some(hasDots)
      : readlinkAttempted && outcome.remaining.some(hasExactDots))
  )
    return unresolved();
  const ancestor = outcome.kind === "absent" ? outcome.at : outcome.path;
  const tail = outcome.kind === "absent" ? outcome.remaining.join("/") : "";
  const landing = (
    tail === "" ? ancestor : posix.join(ancestor, tail)
  ).normalize("NFC");
  if (readlinkAttempted || ancestor !== posix.parse(ancestor).root)
    spellings.add(landing);
  // st's final realpath is outside its tracking generator; it cannot change the
  // opaque-readlink flag or the recorded failing walk operation.
  let canonical: string | undefined;
  try {
    canonical = fs.realpath(ancestor);
  } catch {
    canonical = undefined;
  }
  if (typeof canonical === "string" && canonical !== ancestor) {
    const physical = tail === "" ? canonical : posix.join(canonical, tail);
    if (physical !== landing) {
      spellings.delete(physical);
      spellings.add(physical);
    }
  }
  if (profile === "screen" && !probeClimbingLinks()) return unresolved();
  return opaqueText ? unresolved() : resolved(landing);
}
