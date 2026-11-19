import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { posix } from "node:path";
import ignore from "ignore";
import {
  matchNativeFileRules,
  prepareNativeFileRule,
  type NativeFileRule,
  type NativeIgnoreBackend,
  type NativeRuleBehavior,
  type NativeRuleMatch,
  type PreparedNativeFileRule,
} from "./native-permission-rules.js";

/** Existing Ignore 7 dependency; no global instance or OS-dependent Windows setup. */
export function createNativeIgnoreBackend(): NativeIgnoreBackend {
  return {
    validate(pattern) {
      try {
        ignore().add([pattern]).test("probe");
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    test(patterns, relativePath) {
      const result = ignore().add(patterns).test(relativePath);
      return result.rule === undefined
        ? { ignored: result.ignored }
        : { ignored: result.ignored, pattern: result.rule.pattern };
    },
  };
}

export class NativeFilePermissionUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeFilePermissionUnsupported";
  }
}
export interface NativeFilePermissionRoots {
  launchRoot: string;
  /** AEi/lio configuration context; not consent-store, managed or .claude directory. */
  settingsContextCwd: string;
  userConfigDir?: string;
  flagSettings: { kind: "file"; path: string } | { kind: "inline" | "absent" };
}
const launchSources = new Set([
  "cliArg",
  "command",
  "session",
  "mcpMount",
  "toolsNarrowing",
  "mcpServerPolicy",
  "hostCredential",
]);
function absolute(value: string, label: string): string {
  if (!posix.isAbsolute(value) || value.includes("\0"))
    throw new NativeFilePermissionUnsupported(
      `${label} must be an explicit absolute POSIX path`,
    );
  return posix.resolve(value).normalize("NFC");
}
export function nativeFileRuleSourceRoot(
  source: string,
  roots: NativeFilePermissionRoots,
): string {
  if (launchSources.has(source))
    return absolute(roots.launchRoot, "Launch root");
  if (
    source === "projectSettings" ||
    source === "localSettings" ||
    source === "policySettings"
  )
    return absolute(roots.settingsContextCwd, "Settings context cwd");
  if (source === "userSettings") {
    if (roots.userConfigDir === undefined)
      throw new NativeFilePermissionUnsupported(
        "User settings rule root requires an explicit config directory",
      );
    return absolute(roots.userConfigDir, "User config directory");
  }
  if (source === "flagSettings")
    return roots.flagSettings.kind === "file"
      ? posix.dirname(absolute(roots.flagSettings.path, "Flag settings file"))
      : absolute(roots.settingsContextCwd, "Settings context cwd");
  throw new NativeFilePermissionUnsupported(
    `Unsupported rule source: ${source}`,
  );
}

export interface NativePosixPermissionFilesystem {
  lstat(path: string): Pick<Stats, "isSymbolicLink" | "isDirectory">;
  readlink(path: string): string;
  realpath(path: string): string;
}
const localFilesystem: NativePosixPermissionFilesystem = {
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync(path),
};
/** Native Ig/GSe equivalences only; checks metadata of fixed system aliases when explicitly called. */
export function createNativeVerifiedPosixAliasResolver(
  filesystem: Pick<
    NativePosixPermissionFilesystem,
    "realpath"
  > = localFilesystem,
): (path: string) => string {
  const pairs = [
    ["/private/tmp", "/tmp"],
    ["/private/var", "/var"],
    ["/private/etc", "/etc"],
    ["/usr/bin", "/bin"],
    ["/usr/lib", "/lib"],
    ["/usr/sbin", "/sbin"],
  ];
  const verified: { physical: string; alias: string }[] = [];
  for (const pair of pairs) {
    const physical = pair[0];
    const alias = pair[1];
    if (physical === undefined || alias === undefined) continue;
    try {
      if (filesystem.realpath(alias) === physical)
        verified.push({ physical, alias });
    } catch {
      /* Native unverified aliases are omitted. */
    }
  }
  return (path) => {
    for (const { physical, alias } of verified)
      if (path === physical || path.startsWith(`${physical}/`))
        return alias + path.slice(physical.length);
    return path;
  };
}

export type NativePosixPathInspection = {
  requested: string;
  spellings: readonly string[];
  leafIsSymlink: boolean;
  links: number;
} & (
  | {
      status: "resolved";
      landing: string;
      exists: boolean;
      isDirectory: boolean;
    }
  | { status: "unresolved"; reason: string; stoppedAt: string }
);
function codeOf(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
function ordinaryPath(path: string): boolean {
  return (
    !/^\/(?:net|Network|\.vol|\.file|\.nofollow|\.resolve)(?:\/|$)/.test(
      path,
    ) &&
    !/^\/(?:dev\/fd|proc\/(?:self|thread-self|\d+)\/fd)(?:\/|$)/.test(path) &&
    !path.includes("\0") &&
    !path.includes("\uFFFD")
  );
}
function normalizedTarget(path: string, cwd: string, home: string): string {
  const text = path.trim();
  const expanded =
    text === "~"
      ? home
      : text.startsWith("~/")
        ? posix.join(home, text.slice(2))
        : text;
  return posix.resolve(cwd, expanded).normalize("NFC");
}

/** Ordinary local POSIX branch only. No launch-ancestry, network or unreadable-ancestry allowance. */
export function inspectNativePosixPermissionPath(options: {
  path: string;
  cwd: string;
  home: string;
  filesystem?: NativePosixPermissionFilesystem;
  /** Host can withhold platform-specific mounts before metadata access. */
  admitPath?: (path: string) => boolean | string;
}): NativePosixPathInspection {
  const fs = options.filesystem ?? localFilesystem;
  const cwd = absolute(options.cwd, "Live cwd");
  const home = absolute(options.home, "Home");
  const requested = normalizedTarget(options.path, cwd, home);
  const spellings = new Set([requested]);
  let leafIsSymlink = false;
  let links = 0;
  let current = "/";
  let pending = requested.slice(1).split("/").filter(Boolean);
  const seen = new Set<string>();
  const unresolved = (
    reason: string,
    stoppedAt: string,
  ): NativePosixPathInspection => ({
    status: "unresolved",
    requested,
    spellings: [...spellings],
    leafIsSymlink,
    links,
    reason,
    stoppedAt,
  });
  const vet = (path: string) => {
    if (!ordinaryPath(path))
      return "A nonordinary POSIX path requires an explicit platform adapter";
    const decision = options.admitPath?.(path);
    return decision === false
      ? "Host withheld path inspection"
      : typeof decision === "string"
        ? decision
        : undefined;
  };
  if (options.path.trim().startsWith("//"))
    return unresolved("UNC-shaped input requires a network adapter", requested);
  if (normalizedTarget(requested, cwd, home) !== requested)
    return unresolved(
      "The normalized path is unstable under native whitespace normalization",
      requested,
    );
  const denied = vet(requested);
  if (denied) return unresolved(denied, requested);
  let lastDirectory = true;
  while (pending.length > 0) {
    if (links >= 64)
      return unresolved(
        "Symbolic link inspection reached the native 64-hop bound",
        current,
      );
    const component = pending.shift();
    if (component === undefined) break;
    const next = posix.join(current, component);
    const decision = vet(next);
    if (decision) return unresolved(decision, next);
    let stat: Pick<Stats, "isSymbolicLink" | "isDirectory">;
    try {
      stat = fs.lstat(next);
    } catch (error) {
      const code = codeOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR")
        return unresolved(
          `Cannot inspect path component (${String(code ?? "unknown")})`,
          next,
        );
      const remaining = [component, ...pending];
      if (links > 0 && remaining.some((part) => part === "." || part === ".."))
        return unresolved("Missing link target retains dot segments", next);
      const landing = posix.join(current, ...remaining).normalize("NFC");
      const allowed = vet(landing);
      if (allowed) return unresolved(allowed, landing);
      if (links > 0 || current !== "/") spellings.add(landing);
      try {
        const ancestor = fs.realpath(current).normalize("NFC");
        const physical = posix.join(ancestor, ...remaining).normalize("NFC");
        const allowedPhysical = vet(physical);
        if (allowedPhysical) return unresolved(allowedPhysical, physical);
        if (physical !== landing) spellings.add(physical);
      } catch (error) {
        return unresolved(
          `Cannot resolve existing ancestor (${String(codeOf(error) ?? "unknown")})`,
          current,
        );
      }
      return {
        status: "resolved",
        requested,
        spellings: [...spellings],
        landing,
        exists: false,
        isDirectory: false,
        leafIsSymlink,
        links,
      };
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      lastDirectory = stat.isDirectory();
      continue;
    }
    links++;
    const key = `${next}\0${[component, ...pending].join("\0")}`;
    if (seen.has(key)) return unresolved("Symbolic link cycle", next);
    seen.add(key);
    let text: string;
    try {
      text = fs.readlink(next);
    } catch (error) {
      return unresolved(
        `Cannot inspect symbolic link (${String(codeOf(error) ?? "unknown")})`,
        next,
      );
    }
    if (text.includes("\uFFFD") || text.includes("\0"))
      return unresolved("Symbolic link target is opaque", next);
    const composed = posix.resolve(current, text, ...pending).normalize("NFC");
    const targetDecision = vet(composed);
    if (targetDecision) return unresolved(targetDecision, composed);
    if (pending.length === 0) {
      leafIsSymlink = true;
      spellings.add(composed);
    }
    if (posix.isAbsolute(text)) {
      current = "/";
      pending = [...text.slice(1).split("/").filter(Boolean), ...pending];
    } else pending = [...text.split("/").filter(Boolean), ...pending];
  }
  try {
    const physical = fs.realpath(current).normalize("NFC");
    const decision = vet(physical);
    if (decision) return unresolved(decision, physical);
    spellings.delete(physical);
    spellings.add(physical);
  } catch (error) {
    return unresolved(
      `Cannot resolve inspected path (${String(codeOf(error) ?? "unknown")})`,
      current,
    );
  }
  return {
    status: "resolved",
    requested,
    spellings: [...spellings],
    landing: current.normalize("NFC"),
    exists: true,
    isDirectory: lastDirectory,
    leafIsSymlink,
    links,
  };
}

function literalPrefixComponent(component: string): string {
  return component.replace(/\\([\s\\[\]!#()|+^$*?])/g, "$1");
}
function escapePhysicalPattern(path: string): string {
  let text = path
    .replaceAll("\\", "\\\\")
    .replace(/[[\]()|+^$]/g, "\\$&")
    .replaceAll("*", "\\*");
  if (/^[!#]/.test(text)) text = `\\${text}`;
  return text.replace(/\s+$/, (tail) =>
    Array.from(tail, (char) => `\\${char}`).join(""),
  );
}
function originalPosixPattern(prepared: PreparedNativeFileRule): string {
  if (prepared.rule.rule.kind !== "call") return prepared.pattern;
  let text = prepared.rule.rule.content;
  if (text.startsWith("//") || text.startsWith("~/")) text = text.slice(1);
  else if (text.startsWith("./")) text = text.slice(2);
  text = text.replace(/\/{2,}/g, "/");
  if (!/^\s*(?:\/\*\*)?$/.test(text))
    text = text
      .replace(/^\uFEFF([!#]?)/, (_all, prefix: string) =>
        prefix ? `\\${prefix}` : "",
      )
      .replace(/^\uFEFF/, "[\uFEFF]");
  if (text === prepared.pattern) return text;
  const negation = text.startsWith("!") ? "!" : "";
  const suffix = text.endsWith("/**") ? "/**" : "";
  const body = literalPrefixComponent(
    text.slice(negation.length, text.length - suffix.length),
  );
  // Native Oi uses cPe without escapeGlobs here.
  let escaped = body.replaceAll("\\", "\\\\").replace(/[[\]()|+^$]/g, "\\$&");
  if (/^[!#]/.test(escaped)) escaped = `\\${escaped}`;
  escaped = escaped.replace(/\s+$/, (tail) =>
    Array.from(tail, (char) => `\\${char}`).join(""),
  );
  return negation + escaped + suffix;
}

export interface NativeFilePermissionHostOptions {
  cwd: () => string;
  home: string;
  roots: () => NativeFilePermissionRoots;
  /** Explicit Ewn gate. Disabling the native extra-root switch means live cwd only. */
  relativeRoots:
    | { kind: "live-cwd" }
    | {
        kind: "host";
        resolve: (
          target: string,
          behavior: "deny" | "ask",
        ) => readonly string[];
      };
  physicalTwinsEnabled: boolean;
  fixedRootsBeforeRelative: boolean;
  /** Independently verified native trusted aliases; no personal/system state discovery. */
  trustedAlias: (target: string) => string;
  filesystem?: NativePosixPermissionFilesystem;
  admitPath?: (path: string) => boolean | string;
}
export function createNativeFilePermissionHost(
  options: NativeFilePermissionHostOptions,
) {
  const backend = createNativeIgnoreBackend();
  const historicalTwins = new Map<
    string,
    Map<string, { root: string; pattern: string }>
  >();
  const compiledTwins = new WeakMap<
    object,
    Map<string, readonly { root: string; pattern: string }[]>
  >();
  const inspect = (path: string, cwd: string) =>
    inspectNativePosixPermissionPath({
      path,
      cwd,
      home: options.home,
      ...(options.filesystem ? { filesystem: options.filesystem } : {}),
      ...(options.admitPath ? { admitPath: options.admitPath } : {}),
    });
  function physicalTwins(
    prepared: PreparedNativeFileRule,
    cwd: string,
    compilation: Map<string, readonly { root: string; pattern: string }[]>,
    scope: string,
  ): readonly { root: string; pattern: string }[] {
    if (!options.physicalTwinsEnabled || prepared.root === null) return [];
    const pattern = originalPosixPattern(prepared);
    if (!pattern.startsWith("/")) return [];
    const key = `${prepared.root}\0${pattern}`;
    const cacheKey = `${scope}\0${key}`;
    const cached = compilation.get(cacheKey);
    if (cached !== undefined) return cached;
    let history = historicalTwins.get(key);
    if (history === undefined) {
      history = new Map();
      historicalTwins.set(key, history);
    }
    const finish = (candidate?: string) => {
      if (candidate !== undefined)
        history.set(candidate, { root: "/", pattern: candidate });
      const snapshot = [...history.values()];
      compilation.set(cacheKey, snapshot);
      return snapshot;
    };
    const parts = pattern.slice(1).split("/");
    let length = 0;
    while (
      length < parts.length &&
      parts[length] !== "" &&
      !/(?:^|[^\\])(?:\\\\)*[*?[]/.test(parts[length] ?? "")
    )
      length++;
    if (length === 0) return finish();
    const prefix = posix.join(
      prepared.root,
      parts.slice(0, length).map(literalPrefixComponent).join("/"),
    );
    const path = inspect(prefix, cwd);
    if (path.status !== "resolved") return finish();
    const physical = path.spellings.at(-1);
    if (
      physical === undefined ||
      physical === prefix ||
      posix.dirname(physical) === physical
    )
      return finish();
    const remaining = parts.slice(length);
    const candidate =
      escapePhysicalPattern(physical) +
      (remaining.length ? `/${remaining.join("/")}` : "");
    const normalized = candidate.replace(/\/{2,}/g, "/");
    const probe = normalized.endsWith("/**")
      ? normalized.slice(0, -3) || "/**"
      : normalized;
    if (
      backend.validate(probe) !== null ||
      /^\s*$|^#|(?:^|[^\\])\\$/.test(probe)
    )
      return finish();
    return finish(normalized);
  }
  return {
    backend,
    /** Host signals native compiled-rule invalidation; historical physical twins remain, as in q_(). */
    forgetCompilation(key: object) {
      compiledTwins.delete(key);
    },
    inspectPath(path: string) {
      return inspect(path, absolute(options.cwd(), "Live cwd"));
    },
    match(input: {
      path: string;
      toolName: "Read" | "Write" | "Edit";
      behavior: NativeRuleBehavior;
      rules: readonly NativeFileRule[];
      compilationKey?: object;
      caseInsensitiveTarget?: boolean;
    }): NativeRuleMatch {
      const diagnostics: string[] = [];
      try {
        const cwd = absolute(options.cwd(), "Live cwd");
        const path = inspect(input.path, cwd);
        if (path.status === "unresolved" && input.behavior === "allow")
          return { status: "unsupported", reason: path.reason, diagnostics };
        const roots = options.roots();
        const key = input.compilationKey ?? input.rules;
        let compilation = compiledTwins.get(key);
        if (compilation === undefined) {
          compilation = new Map();
          compiledTwins.set(key, compilation);
        }
        const twinCompilation = compilation;
        const result = matchNativeFileRules({
          ...input,
          platform: "posix",
          cwd,
          home: options.home,
          ignore: backend,
          sourceRoot: (source) => nativeFileRuleSourceRoot(source, roots),
          targetSpellings: path.spellings,
          candidateRoots: (target, behavior) => {
            if (
              behavior === "allow" ||
              options.relativeRoots.kind === "live-cwd"
            )
              return [cwd];
            return options.relativeRoots
              .resolve(target, behavior)
              .map((root) => absolute(root, "Relative rule root"));
          },
          physicalTwins: (prepared) =>
            physicalTwins(
              prepared,
              cwd,
              twinCompilation,
              `${input.toolName === "Read" ? "read" : "edit"}\0${input.behavior}`,
            ),
          trustedAlias: options.trustedAlias,
          fixedRootsBeforeRelative: options.fixedRootsBeforeRelative,
          isDirectory: path.status === "resolved" && path.isDirectory,
        });
        if (path.status === "unresolved" && result.status !== "matched")
          return {
            status: "unsupported",
            reason: path.reason,
            diagnostics: result.diagnostics,
          };
        return result;
      } catch (error) {
        return {
          status: "unsupported",
          reason: error instanceof Error ? error.message : String(error),
          diagnostics,
        };
      }
    },
    prepare(rule: NativeFileRule, behavior: NativeRuleBehavior) {
      const cwd = absolute(options.cwd(), "Live cwd");
      return prepareNativeFileRule(rule, behavior, {
        platform: "posix",
        cwd,
        home: options.home,
        ignore: backend,
        sourceRoot: (source) =>
          nativeFileRuleSourceRoot(source, options.roots()),
      });
    },
  };
}
