import { lstatSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  createNativeIgnoreBackend,
  nativeFileRuleSourceRoot,
} from "./native-file-permission-host.js";
import {
  inspectNativePermissionPath,
  nativeAutomountRoot,
  nativeKernelPath,
  nativeLocalWslPath,
  nativeNetworkHost,
  nativeNetworkVolume,
  nativePermissionPathContained,
  type NativePermissionPathContext,
  nativeUncPath,
  normalizeNativePermissionPath,
} from "./native-path-inspection.js";
import {
  matchNativeFileRules,
  parseNativePermissionRule,
  type NativeFileRule,
  type PreparedNativeFileRule,
} from "./native-permission-rules.js";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionOutcome,
  type NativePermissionProvenance,
  type NativePermissionRule,
  type NativePermissionScope,
} from "./native-permission-outcome.js";
import { nativePermissionReasonText as text } from "./native-permission-reason-codes.js";
import type {
  NativeFileAdjudicationHost,
  NativeFileAdjudicationPolicy,
  NativeFilePermissionInspection,
  NativeFileSensitiveWrite,
  NativeProtectedReadOptions,
} from "./native-file-adjudication.js";
import type {
  NativeConcreteFileHostOptions,
  NativeFileResourceSnapshot,
} from "./native-file-adjudication-types.js";
import {
  nativeAncestryPathSpelling,
  nativePermissionAncestryRisk,
  nativePermissionComparablePath,
  nativePermissionComparableContains,
  type NativeAncestryFilesystem,
} from "./native-path-ancestry.js";
import {
  scanNativeDevMods,
  type NativePluginDirectoryFilesystem,
} from "./native-plugin-permission-scan.js";

// oxlint-disable-next-line no-control-regex -- Source Uc renders these controls as numeric entities.
const controlCharacters = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const hiddenCharacters = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
const fold = (value: string) =>
  value
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u017f/g, "s");
/** Source Ga, distinct from Do and the network Gv fold. */
export function nativeSensitivePathComponent(value: string): string {
  const lower = fold(value);
  return (
    lower
      .replace(hiddenCharacters, "")
      .replace(/:.*$/, "")
      .replace(/[. ]+$/, "") || lower
  );
}
const comparable = (path: string) =>
  posix.normalize(path).split("/").map(nativeSensitivePathComponent).join("/");
const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const format = (path: string) =>
  path.replace(controlCharacters, (part) => `&#${part.charCodeAt(0)};`);
const safe = <Input>(): NativePermissionOutcome<Input> => ({
  behavior: "passthrough",
  message: "",
});
const allow = <Input>(
  input: Input | undefined,
  reason: string,
): NativePermissionOutcome<Input> => ({
  behavior: "allow",
  updatedInput: input,
  decisionReason: { type: "other", reason },
});
const memoryReason = "memory access blocked by /pause-memory";
function memoryFloor<Input>(
  operation: "read" | "write",
): NativePermissionOutcome<Input> {
  return {
    behavior: "deny",
    message: `Cannot ${operation} ${operation === "write" ? "to " : ""}memory while it is paused for this session; only the user can turn it back on.`,
    decisionReason: {
      type: "safetyCheck",
      reason: memoryReason,
      classifierApprovable: false,
    },
  };
}
const sensitiveDirectories = new Set([
  ".git",
  ".vscode",
  ".idea",
  ".claude",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);
const excludedMemorySegments = new Set([
  ".git",
  "hooks",
  ".husky",
  ".githooks",
  "node_modules",
  ".vscode",
  ".idea",
  "head",
  "config",
  "objects",
  "refs",
  ".claude",
  "skills",
  "commands",
  "agents",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);
const sensitiveFilenames = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".envrc",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  ".lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yaml",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  "pyrightconfig.json",
]);

export function nativeSuspiciousWindowsPath(
  path: string,
  trusted: readonly string[],
  platform: "macos" | "linux" | "windows" | "wsl",
  context: Pick<NativePermissionPathContext, "cwd" | "home">,
): string | undefined {
  if (
    /^[\\/]\?\?[\\/]/.test(path) ||
    (path.includes("??") && /^[\\/]\?\?[\\/]/.test(win32.normalize(path)))
  )
    return "nt_device_namespace";
  if (
    (platform === "windows" || platform === "wsl") &&
    path.indexOf(":", 2) !== -1
  )
    return "colon_past_drive_position";
  if (/~\d/.test(path)) return "tilde_digit";
  if (
    path.startsWith("\\\\?\\") ||
    path.startsWith("\\\\.\\") ||
    path.startsWith("//?/") ||
    path.startsWith("//./")
  )
    return "device_path_prefix";
  for (const part of path.split(/[/\\]/))
    if (part !== "" && part !== "." && part !== ".." && /[.\s]+$/.test(part))
      return "trailing_dot_or_whitespace";
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path))
    return "dos_device_suffix";
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) return "dot_run_segment";
  if (
    platform === "windows" &&
    nativeWindowsNetworkPathPattern(path) &&
    !nativeLocalWslPath(path) &&
    !trustedNetwork(path, trusted, context)
  )
    return "unc_or_webdav_form";
  return;
}
/** tP(...,true); its caller's actual Windows platform gate is kept above. */
export function nativeWindowsNetworkPathPattern(path: string): boolean {
  if (nativeUncPath(path)) return true;
  if (/^-[A-Za-z0-9]/.test(path)) {
    const rest = path.replace(/^(?:-[A-Za-z0-9]+)+/, "");
    if (rest.length && nativeWindowsNetworkPathPattern(rest)) return true;
  }
  const assignment = /^--?[A-Za-z0-9][\w-]*=/;
  if (assignment.test(path)) {
    let rest = path;
    while (assignment.test(rest)) rest = rest.slice(rest.indexOf("=") + 1);
    if (rest.length && nativeWindowsNetworkPathPattern(rest)) return true;
  }
  return (
    /\\\\[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i.test(path) ||
    /(?:^|[^A-Za-z0-9_])[\\/]\?\?(?:[\\/]|$)/.test(path) ||
    /(?<!:)\/\/[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i.test(path) ||
    /(?<![:\w])\/\\{1,}[^ \t\r\n\f\v\\/]+[\\/]/.test(path) ||
    /(?<![:\w])\\{1,}\/[^ \t\r\n\f\v\\/]+[\\/]/.test(path) ||
    /@SSL@\d+|@\d+@SSL|DavWWWRoot/i.test(path) ||
    /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(path) ||
    /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(path) ||
    /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(path) ||
    /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(path)
  );
}
function trustedNetwork(
  path: string,
  trusted: readonly string[],
  context: Pick<NativePermissionPathContext, "cwd" | "home">,
): boolean {
  if (/(^|[\\/])\.{1,2}[. ]*([\\/]|$)/.test(path)) return false;
  return trusted.some(
    (root) =>
      nativeUncPath(path) === nativeUncPath(root) &&
      nativePermissionPathContained(path, root, context),
  );
}
function networkKind(
  path: string,
): "unc" | "automount" | "browse" | "kernel" | undefined {
  if (nativeUncPath(path) && !nativeLocalWslPath(path)) return "unc";
  if (nativeNetworkHost(path) !== null || nativeAutomountRoot(path))
    return "automount";
  if (nativeNetworkVolume(path)) return "browse";
  if (nativeKernelPath(path)) return "kernel";
  return;
}
function nativeNetworkProbePath(path: string): boolean {
  return (
    nativeUncPath(path) ||
    nativeNetworkHost(path) !== null ||
    nativeNetworkVolume(path) ||
    nativeKernelPath(path)
  );
}
function systemDataAlias(path: string): string {
  const parts = path.split("/");
  const equal = (left: string, right: string) =>
    left.toUpperCase().toLowerCase() === right;
  if (
    parts.length < 5 ||
    parts[0] !== "" ||
    !equal(parts[1] ?? "", "system") ||
    !equal(parts[2] ?? "", "volumes") ||
    !equal(parts[3] ?? "", "data")
  )
    return path;
  const remaining = parts.slice(4);
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
    const expected = root.split("/");
    if (
      remaining.length >= expected.length &&
      expected.every((part, index) =>
        equal(remaining[index] ?? "", part.toUpperCase().toLowerCase()),
      )
    )
      return "/" + remaining.join("/");
  }
  return path;
}
function excludesProtectedChild(
  path: string,
  root: string,
  filenames = false,
): boolean {
  const parts = path
    .slice(root.length)
    .split("/")
    .map(nativeSensitivePathComponent);
  return (
    parts.some((part) => excludedMemorySegments.has(part)) ||
    (filenames && sensitiveFilenames.has(parts.at(-1) ?? ""))
  );
}
export function plainMemory(path: string, root: string | null): boolean {
  if (root === null || !root.endsWith("/")) return false;
  const base = root.replace(/[/\\]+$/, "");
  if (
    !posix.isAbsolute(base) ||
    base.length < 3 ||
    /^[A-Za-z]:$/.test(base) ||
    nativeUncPath(base) ||
    nativeNetworkHost(base) !== null ||
    nativeNetworkVolume(base) ||
    nativeKernelPath(base) ||
    base.includes("\0")
  )
    return false;
  const normalized = posix.normalize(path);
  return (
    normalized.startsWith(root) && !excludesProtectedChild(normalized, root)
  );
}
function memoryCandidate(
  path: string,
  state: NativeFileResourceSnapshot,
): boolean {
  return (
    state.memory.canLackFolderAndUnresolved ||
    (state.memory.autoMemoryRoot !== null &&
      posix.normalize(path).startsWith(state.memory.autoMemoryRoot))
  );
}
function planFile(path: string, state: NativeFileResourceSnapshot): boolean {
  const plan = state.runtime.plan;
  if (plan === null || posix.dirname(path) !== plan.directory) return false;
  const base = posix.basename(path);
  return (
    base === `${plan.slug}.md` ||
    (base.startsWith(`${plan.slug}-agent-`) && base.endsWith(".md"))
  );
}
function scratch(path: string, state: NativeFileResourceSnapshot): boolean {
  const root = state.runtime.scratchDirectory;
  if (root === null) return false;
  const compared = fold(posix.normalize(path));
  const directory = fold(root);
  return (
    compared === directory ||
    (compared.startsWith(directory + "/") &&
      !excludesProtectedChild(compared, directory + "/", true))
  );
}
function background(path: string, state: NativeFileResourceSnapshot): boolean {
  const root =
    state.runtime.backgroundJobDirectory === null
      ? null
      : posix.normalize(state.runtime.backgroundJobDirectory);
  if (
    root === null ||
    !root.startsWith(posix.join(state.configDirectory, "jobs") + "/")
  )
    return false;
  const temp = posix.join(root, "tmp");
  return (
    fold(path).startsWith(fold(temp + "/")) &&
    !excludesProtectedChild(path, temp + "/", true)
  );
}
function agentMemory(path: string, state: NativeFileResourceSnapshot): boolean {
  return state.memory.agentMemoryRoots.some(
    (root) => within(path, root) && !excludesProtectedChild(path, root),
  );
}
function remoteMode(policy: NativeFileAdjudicationPolicy): boolean {
  return (
    policy.isRemoteMode === true &&
    !policy.restricted &&
    policy.mode !== "auto" &&
    !(
      policy.mode === "plan" &&
      (policy.prePlanMode === "auto" || policy.strippedDangerousRules)
    ) &&
    policy.modeBeforeRewrite !== "auto"
  );
}

function configBoundary(
  parts: readonly string[],
  originalRootSpellings: readonly string[],
): number {
  let boundary = 0;
  for (const root of originalRootSpellings) {
    const prefix = posix.normalize(root.trim()).normalize("NFC").split("/");
    if (prefix.length > 1 && prefix.at(-1) === "") prefix.pop();
    if (!prefix.every((part, index) => part === parts[index])) continue;
    let start = prefix.length;
    for (let index = 0; index < prefix.length; index++)
      if (
        nativeSensitivePathComponent(prefix[index] ?? "") === ".claude" &&
        nativeSensitivePathComponent(prefix[index + 1] ?? "") !== "worktrees"
      ) {
        start = index;
        break;
      }
    boundary = Math.max(boundary, start);
  }
  return boundary;
}
/** Full source gg lexical tail; producer root scanning has a separate factual owner seam. */
export function nativeSensitiveLexicalPath(
  path: string,
  remote: boolean,
  originalRootSpellings: readonly string[],
): boolean {
  const parts = path.split("/");
  const boundary = configBoundary(parts, originalRootSpellings);
  let configSeen = false;
  for (let index = 0; index < parts.length; index++) {
    const part = nativeSensitivePathComponent(parts[index] ?? "");
    if (!sensitiveDirectories.has(part)) continue;
    if (part !== ".claude") return true;
    if (configSeen) return true;
    const current = index >= boundary;
    const next = nativeSensitivePathComponent(parts[index + 1] ?? "");
    if (
      remote &&
      next &&
      (["skills", "agents", "commands"].includes(next) ||
        (next === "scheduled_tasks.json" && index + 1 === parts.length - 1))
    ) {
      if (current && next !== "scheduled_tasks.json") configSeen = true;
      continue;
    }
    if (next === "worktrees") {
      if (current) configSeen = true;
      continue;
    }
    return true;
  }
  for (let index = 0; index + 1 < parts.length; index++)
    if (
      nativeSensitivePathComponent(parts[index] ?? "") === ".config" &&
      nativeSensitivePathComponent(parts[index + 1] ?? "") === "git"
    )
      return true;
  return sensitiveFilenames.has(
    nativeSensitivePathComponent(parts.at(-1) ?? ""),
  );
}

const protectedLiterals: Readonly<
  Record<string, { message: string; reason: string; circuitBreaker?: string }>
> = {
  Mc: {
    message:
      "Cannot write to memory while it is paused for this session; only the user can turn it back on.",
    reason: "memory access blocked by /pause-memory",
  },
  _i: {
    message:
      "Cannot read memory while it is paused for this session; only the user can turn it back on.",
    reason: "memory access blocked by /pause-memory",
  },
  vi: {
    message:
      "~/.claude/seed-admin holds the private git directories of cloud-session uploads and is managed by Claude Code; it cannot be written directly",
    reason:
      "seed-admin git configuration is a code-execution surface for the upload",
  },
  ii: {
    message:
      "adopt.json is the bg-fork handoff carrier and is managed by the harness; it cannot be written directly",
    reason: "adopt.json is a code-execution surface for the fork",
  },
  cg: {
    message:
      "This path is in, or leads into, the jobs folder of the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude); a Windows short name such as CLAUDE~1 counts as the folder in its place. Claude Code restarts background sessions from the files there, so they cannot be written directly. Scratch files of a background session go in $CLAUDE_JOB_DIR/tmp. A person can stop, restart or remove a session in `claude agents`, or with `claude stop <id>`, `claude respawn <id>` or `claude rm <id>`.",
    reason:
      "This writes to the Claude Code jobs folder. A file there can give a background session more permissions or run a command without asking anyone.",
  },
  dg: {
    message:
      "This path is in, or leads into, the daemon folder of the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude); a Windows short name such as CLAUDE~1 counts as the folder in its place. The service that runs background sessions acts on the files there, so they cannot be written directly. A person can check the service with `claude daemon status`.",
    reason:
      "This writes to the Claude Code daemon folder. A file there can start a background session without asking anyone.",
  },
  ug: {
    message:
      "This path is daemon.json in the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude), or a link, temp file or short name that stands in for it; above it, a Windows short name such as CLAUDE~1 counts as the folder in its place. The service that runs background sessions starts the workers listed there, so it cannot be written directly. A person can change it in an editor.",
    reason:
      "This writes to the Claude Code daemon.json, or to a file that stands in for it. The service that runs background sessions starts the workers listed there without asking anyone.",
  },
  mg: {
    message:
      "This path is in, or leads into, the shell-snapshots folder of the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude); a Windows short name such as SHELL-~1 or CLAUDE~1 counts as the folder in its place. Each Bash command first runs a snapshot, kept there, of the shell setup (aliases, functions, options), so the files cannot be written directly. Claude Code takes a new snapshot each time it starts, so a person can change their shell startup file, such as ~/.bashrc or ~/.zshrc, and restart Claude Code.",
    reason:
      "This writes to the Claude Code shell-snapshots folder. Each Bash command first runs a file from there, without asking anyone.",
  },
  fg: {
    message:
      "This path is in, or leads into, the session-env folder of the Claude Code config directory ($CLAUDE_CONFIG_DIR or ~/.claude); a Windows short name such as SESSIO~1 or CLAUDE~1 counts as the folder in its place. Claude Code runs the scripts that hooks leave there ahead of Bash commands, so they cannot be written directly. To set variables for later Bash commands, a person can add a SessionStart hook that appends export lines to the file named in $CLAUDE_ENV_FILE.",
    reason:
      "This writes to the Claude Code session-env folder. Claude Code runs the scripts there ahead of Bash commands, without asking anyone.",
  },
  mi: {
    message:
      "The Anthropic profile store holds the sign-in that decides which organization policy applies; it cannot be written directly",
    reason:
      "profile store write substitutes the credential and organization behind managed settings",
  },
  pi: {
    message:
      "Staged Claude Code settings changes are the owner\u2019s to review in /settings-review; the review store cannot be written directly",
    reason:
      "settings review store write substitutes a proposal the owner is about to accept",
    circuitBreaker: "claudeSettingsFile",
  },
  Si: {
    message:
      "The host credentials file is managed by the host process; it cannot be written directly",
    reason: "host-creds file rewrite redirects the bearer token",
  },
  Cc: {
    message:
      "This session has no config folder to check the path against, so the write is denied. A retry is denied the same way.",
    reason:
      "permission check needs a config or temp path; the session has none",
  },
};
function protectedFloor<Input>(key: string): NativePermissionOutcome<Input> {
  const row = protectedLiterals[key];
  if (row === undefined) throw new Error("Unknown authored protected literal");
  return {
    behavior: "deny",
    message: row.message,
    decisionReason: {
      type: "safetyCheck",
      reason: row.reason,
      classifierApprovable: false,
      ...(row.circuitBreaker === undefined
        ? {}
        : { circuitBreaker: row.circuitBreaker }),
    },
  };
}

/** File metadata needed for actual sign-in hard-link floors, never file contents. */
export interface NativeFileIdentity {
  isFile: boolean;
  nlink: bigint;
  dev: bigint;
  ino: bigint;
}
export interface NativeConcreteIdentityReaders {
  identity(path: string): NativeFileIdentity;
  followedIdentity(path: string): NativeFileIdentity;
  isDirectory(path: string): boolean;
}
export const nativeLocalConcreteIdentityReaders: NativeConcreteIdentityReaders =
  {
    identity(path) {
      const stat = lstatSync(path, { bigint: true });
      return {
        isFile: stat.isFile(),
        nlink: stat.nlink,
        dev: stat.dev,
        ino: stat.ino,
      };
    },
    followedIdentity(path) {
      const stat = statSync(path, { bigint: true });
      return {
        isFile: stat.isFile(),
        nlink: stat.nlink,
        dev: stat.dev,
        ino: stat.ino,
      };
    },
    isDirectory: (path) => statSync(path).isDirectory(),
  };

export interface NativeConcreteFileHostCapabilities<Input> {
  /** Remaining feature/account/classifier seams, with actual source outcome provenance. */
  readBypassAvailable?: NativeFileAdjudicationHost<Input>["readBypassAvailable"];
  modelReadMode?: NativeFileAdjudicationHost<Input>["modelReadMode"];
  servedReadFenceAskStaysDenied?: NativeFileAdjudicationHost<Input>["servedReadFenceAskStaysDenied"];
  /** Actual OLa/H/Ng/aW/amber-plover owner; collapsed bare syntax is insufficient. */
  wholeToolAllow?: NativeFileAdjudicationHost<Input>["wholeToolAllow"];
  /** Exact Gp reserved skill-name validation belongs to the skill registry owner. */
  isAdmittedSkillName?: (
    name: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  quotePath: (
    path: string,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
}

/** No process cwd/home/environment/account defaults; owners supply all contextual facts. */
export function createNativeConcreteFileAdjudicationHost<Input>(
  options: NativeConcreteFileHostOptions & {
    identities: NativeConcreteIdentityReaders;
    capabilities: NativeConcreteFileHostCapabilities<Input>;
    ancestryFilesystem: NativeAncestryFilesystem;
    pluginDirectoryFilesystem: NativePluginDirectoryFilesystem;
    now(): number;
    monotonicNow(): number;
  },
): NativeFileAdjudicationHost<Input> & { invalidateProducerPaths(): void } {
  const backend = createNativeIgnoreBackend();
  const historicalTwins = new Map<
    string,
    Map<string, { root: string; pattern: string }>
  >();
  const compiledRuleTwins = new Map<
    string,
    Map<string, readonly { root: string; pattern: string }[]>
  >();
  const workingCache = new Map<string, readonly string[]>();
  let producerMemo:
    | { at: number; roots: readonly string[]; needsCanonicalCandidate: boolean }
    | undefined;
  let inlineMemo:
    { at: number; key: string; roots: readonly string[] } | undefined;
  let settingsLinkMemo:
    { at: number; key: string; files: ReadonlyMap<string, string> } | undefined;
  const dependencyFrames: NativePermissionProvenance[][] = [];
  function value<T>(
    fact: NativePermissionFact<T>,
    scope: NativePermissionScope,
  ): T {
    return readNativePermissionFact(fact, scope, dependencyFrames.at(-1) ?? []);
  }
  function checkScope(scope: NativePermissionScope): void {
    if (scope.cwd !== options.pathContext.cwd)
      throw new NativePermissionDependencyError(
        "host-scope",
        "Filesystem context belongs to another actual evaluation cwd",
      );
  }
  function fact<T>(
    scope: NativePermissionScope,
    contracts: readonly string[],
    work: () => T,
  ): NativePermissionFact<T> {
    const dependencies: NativePermissionProvenance[] = [];
    dependencyFrames.push(dependencies);
    try {
      checkScope(scope);
      const computed = work();
      const owners = unique(
        dependencies.map((dependency) => dependency.provider),
      );
      return {
        status: "known",
        value: computed,
        provenance: {
          provider:
            "native-concrete-file-host" +
            (owners.length ? `(${owners.join(",")})` : ""),
          sourceContracts: unique([
            ...contracts,
            ...dependencies.flatMap((dependency) => dependency.sourceContracts),
          ]),
          scope,
        },
      };
    } catch (error) {
      return {
        status: "unsupported",
        dependency:
          error instanceof NativePermissionDependencyError
            ? error.dependency
            : contracts.join("/"),
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      dependencyFrames.pop();
    }
  }
  const state = (scope: NativePermissionScope) =>
    value(options.readResources(scope), scope);
  const normalize = (path: string) =>
    normalizeNativePermissionPath(path, options.pathContext);
  const inspect = (path: string) =>
    inspectNativePermissionPath(path, options.pathContext);
  function spellings(path: string): readonly string[] {
    const inspection = inspect(path);
    if (!inspection.unresolved) return inspection.spellings;
    // kgt/ko may add a separately verified canonical spelling; no fake landing.
    try {
      const physical = options.pathContext.filesystem.realpath(path);
      return unique([...inspection.spellings, physical]);
    } catch {
      return inspection.spellings;
    }
  }
  function roots(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): readonly string[] {
    if (resources.workingDirPathsHeldAsNamed.has(path)) return [path];
    let cached = workingCache.get(path);
    if (cached === undefined) {
      cached = resources.diskless ? [path] : spellings(path);
      workingCache.set(path, cached);
    }
    return cached;
  }
  function pathAlias(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): string {
    for (const named of resources.aliasTranslationRoots) {
      if (named === null) continue;
      for (const spelling of roots(named, resources)) {
        if (spelling === named) continue;
        if (path === spelling || path.startsWith(spelling + "/"))
          return named + path.slice(spelling.length);
      }
    }
    return options.trustedAlias(path);
  }
  function containsAll(
    paths: readonly string[],
    selectedRoots: readonly string[],
    resources: NativeFileResourceSnapshot,
    exemptions: readonly string[] = [],
  ): boolean {
    const admitted = selectedRoots.flatMap((root) => roots(root, resources));
    return paths.every(
      (path) =>
        admitted.some((root) =>
          nativePermissionPathContained(path, root, options.pathContext, {
            caseFold: false,
            uncShapeParity: true,
          }),
        ) ||
        exemptions.some((root) =>
          nativePermissionPathContained(path, root, options.pathContext, {
            caseFold: false,
            uncShapeParity: true,
            skipPrivateAlias: !options.pathContext.macos,
          }),
        ),
    );
  }
  function ordinaryWorkingRoots(
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
  ): string[] {
    return unique([
      resources.originalCwd,
      ...(policy.additionalWorkingDirectories?.keys() ?? []),
    ]);
  }
  function extraFenceRoots(
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
  ): string[] {
    return resources.extraWorkingDirectories
      .filter((entry) =>
        policy.blockFileToolReadsOutsideWorkingDirectories
          ? entry.readFenceAdmitted
          : entry.source !== "projectSettings",
      )
      .map((entry) => entry.path);
  }
  function includeOriginal(
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
  ): boolean {
    const initial = resources.initialReadRoot;
    if (
      policy.blockFileToolReadsOutsideWorkingDirectories !== true ||
      initial === undefined ||
      initial === resources.launchContextRoot
    )
      return true;
    return (
      resources.launchContextRoot !== null &&
      containsAll(
        roots(resources.launchContextRoot, resources),
        [
          ...(initial === null ? [] : [initial]),
          ...extraFenceRoots(resources, policy),
        ],
        resources,
      )
    );
  }
  function fenceRoots(
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
  ): string[] {
    return unique([
      ...(includeOriginal(resources, policy) ? [resources.originalCwd] : []),
      ...(policy.blockFileToolReadsOutsideWorkingDirectories &&
      resources.initialReadRoot
        ? [resources.initialReadRoot]
        : []),
      ...extraFenceRoots(resources, policy),
    ]);
  }
  function wholeRule(
    entry: NativeFileRule,
    behavior: "allow" | "ask" | "deny",
  ): NativePermissionRule {
    const parsed = entry.rule;
    if (parsed.kind === "malformed")
      throw new NativePermissionDependencyError(
        "xr",
        "Malformed rule cannot be emitted as a scoped file match",
      );
    return {
      source: entry.source,
      ruleBehavior: behavior,
      ruleValue: {
        toolName: parsed.toolName,
        ...(parsed.kind === "call" ? { ruleContent: parsed.content } : {}),
      },
      original: parsed.original,
    };
  }
  function originalRulePattern(prepared: PreparedNativeFileRule): string {
    if (prepared.rule.rule.kind !== "call") return prepared.pattern;
    let pattern = prepared.rule.rule.content;
    if (pattern.startsWith("//") || pattern.startsWith("~/"))
      pattern = pattern.slice(1);
    else if (pattern.startsWith("./")) pattern = pattern.slice(2);
    pattern = pattern.replace(/\/{2,}/g, "/");
    if (!/^\s*(?:\/\*\*)?$/.test(pattern))
      pattern = pattern
        .replace(/^\uFEFF([!#]?)/, (_all, prefix: string) =>
          prefix ? "\\" + prefix : "",
        )
        .replace(/^\uFEFF/, "[\uFEFF]");
    if (pattern === prepared.pattern) return pattern;
    const negative = pattern.startsWith("!") ? "!" : "";
    const suffix = pattern.endsWith("/**") ? "/**" : "";
    const literal = pattern
      .slice(negative.length, pattern.length - suffix.length)
      .replace(/\\([\s\\[\]!#()|+^$*?])/g, "$1");
    let escaped = literal
      .replaceAll("\\", "\\\\")
      .replace(/[[\]()|+^$]/g, "\\$&");
    if (/^[!#]/.test(escaped)) escaped = "\\" + escaped;
    escaped = escaped.replace(/\s+$/, (tail) =>
      Array.from(tail, (part) => "\\" + part).join(""),
    );
    return negative + escaped + suffix;
  }
  function physicalTwins(
    prepared: PreparedNativeFileRule,
    generation: string,
  ): readonly { root: string; pattern: string }[] {
    if (!options.physicalRuleTwins || prepared.root === null) return [];
    const sourcePattern = originalRulePattern(prepared);
    if (!sourcePattern.startsWith("/")) return [];
    let compilation = compiledRuleTwins.get(generation);
    if (compilation === undefined) {
      compilation = new Map();
      compiledRuleTwins.set(generation, compilation);
    }
    const key = prepared.root + "\0" + sourcePattern;
    const cached = compilation.get(key);
    if (cached !== undefined) return cached;
    let history = historicalTwins.get(key);
    if (!history) {
      history = new Map();
      historicalTwins.set(key, history);
    }
    const parts = sourcePattern.slice(1).split("/");
    let length = 0;
    while (
      length < parts.length &&
      parts[length] !== "" &&
      !/(?:^|[^\\])(?:\\\\)*[*?[]/.test(parts[length] ?? "")
    )
      length++;
    if (length > 0) {
      const prefix = posix.join(
        prepared.root,
        ...parts
          .slice(0, length)
          .map((part) => part.replace(/\\([\s\\[\]!#()|+^$*?])/g, "$1")),
      );
      const inspection = inspect(prefix);
      const physical = inspection.unresolved
        ? undefined
        : inspection.spellings.at(-1);
      if (
        physical !== undefined &&
        physical !== prefix &&
        posix.dirname(physical) !== physical
      ) {
        let escaped = physical
          .replaceAll("\\", "\\\\")
          .replace(/[[\]()|+^$]/g, "\\$&")
          .replaceAll("*", "\\*");
        if (/^[!#]/.test(escaped)) escaped = "\\" + escaped;
        escaped = escaped.replace(/\s+$/, (tail) =>
          Array.from(tail, (char) => "\\" + char).join(""),
        );
        const suffix = parts.slice(length);
        const pattern = (
          escaped + (suffix.length ? "/" + suffix.join("/") : "")
        ).replace(/\/{2,}/g, "/");
        const probe = pattern.endsWith("/**")
          ? pattern.slice(0, -3) || "/**"
          : pattern;
        if (
          backend.validate(probe) === null &&
          !/^\s*$|^#|(?:^|[^\\])\\$/.test(probe)
        )
          history.set(pattern, { root: "/", pattern });
      }
    }
    const snapshot = [...history.values()];
    compilation.set(key, snapshot);
    return snapshot;
  }
  function matched(
    path: string,
    policy: NativeFileAdjudicationPolicy,
    family: "read" | "edit",
    behavior: "allow" | "ask" | "deny",
    scope: NativePermissionScope,
  ): NativePermissionRule | null {
    const rules = value(options.readRules(policy, behavior, scope), scope);
    const sourceRoots = value(options.readRuleRoots(scope), scope);
    const result = matchNativeFileRules({
      toolName: family === "read" ? "Read" : "Edit",
      behavior,
      rules,
      cwd: scope.cwd,
      home: options.pathContext.home,
      platform: "posix",
      ignore: backend,
      sourceRoot: (source) => nativeFileRuleSourceRoot(source, sourceRoots),
      targetSpellings: [path],
      candidateRoots: (target, mode) =>
        mode === "allow"
          ? [scope.cwd]
          : value(options.relativeRuleRoots(target, mode, scope), scope),
      physicalTwins: (prepared) =>
        physicalTwins(prepared, `${scope.policyId}\0${family}\0${behavior}`),
      trustedAlias: (path) => options.trustedAlias(path),
      fixedRootsBeforeRelative: options.fixedRuleRootsBeforeRelative,
    });
    if (result.status === "unsupported")
      throw new NativePermissionDependencyError("Oa", result.reason);
    return result.status === "matched"
      ? wholeRule(result.rule, behavior)
      : null;
  }

  function configRootSpellings(
    resources: NativeFileResourceSnapshot,
    name: string,
  ): string[] {
    return unique(
      [
        resources.configDirectory,
        posix.join(options.pathContext.home, ".claude"),
      ].flatMap((root) =>
        [
          scopeCwd(),
          options.pathContext.initialCwd ?? scopeCwd(),
          options.pathContext.home,
        ].flatMap((base) => spellings(posix.resolve(base, root, name))),
      ),
    );
  }
  const scopeCwd = () => options.pathContext.cwd;
  function shortName(value: string): boolean {
    return /^(?=[^.]{3,8}(?:\.|$))[^.]{1,6}~[0-9]{1,6}(?:\.[^.]{1,3})?$/.test(
      value.replace(/\u0307/g, ""),
    );
  }
  function configRows(
    paths: readonly string[],
    name: string,
    resources: NativeFileResourceSnapshot,
    leafAlias?: RegExp,
  ): { written: string[]; folded: string[] }[] {
    const selectedRoots = configRootSpellings(resources, name)
      .flatMap((root) => [root, systemDataAlias(root)])
      .map((root) => comparable(root).split("/"));
    return paths
      .flatMap((path) => [path, systemDataAlias(path)])
      .flatMap((path) => {
        const written = posix.normalize(path).split("/");
        const folded = comparable(path).split("/");
        return selectedRoots
          .filter((root) =>
            root.every(
              (part, index) =>
                folded[index] === part ||
                (index < root.length - 1 &&
                  (shortName(folded[index] ?? "") || shortName(part))) ||
                (part === name && leafAlias?.test(folded[index] ?? "")),
            ),
          )
          .map((root) => ({
            written: written.slice(root.length),
            folded: folded.slice(root.length),
          }));
      });
  }
  function configFloor(
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
    phase: "exact" | "widest",
  ): NativePermissionOutcome<Input> | undefined {
    // The retained Mach-O never enters Rc's Windows-only expansion profile.
    if (phase === "widest" && resources.merryBoot) return;
    const jobs = configRows(paths, "jobs", resources);
    if (
      jobs.some(
        (row) =>
          row.folded.length === 2 && row.folded[1]?.startsWith("adopt.json"),
      )
    )
      return protectedFloor("ii");
    if (!resources.merryBoot) {
      if (
        phase === "widest" &&
        jobs.some(
          (row) =>
            row.folded.length === 2 &&
            /^ad[0-9a-z]{0,4}~\d+(?:\.[^.]{0,3})?$/.test(row.folded[1] ?? ""),
        )
      ) {
        const result = protectedFloor<Input>("ii");
        return {
          ...result,
          message: `This file name has the shape of a Windows short name (such as ADOPT~1.JSO), which may open adopt.json. ${result.message}. A name with no "~" followed by a digit is not refused for this reason.`,
        };
      }
      return;
    }
    let key: string | undefined;
    if (
      jobs.some(
        (row) =>
          row.written[1] !== "tmp" ||
          row.folded.some((part) =>
            /^[. ]*(:|$)/.test(part.replace(hiddenCharacters, "")),
          ),
      )
    )
      key = "cg";
    for (const [name, alias, literal] of [
      ["daemon", undefined, "dg"],
      ["daemon.json", /^daemon\.json\.tmp\.|^da[0-9a-z]{0,4}~\d+\.jso$/, "ug"],
      ["shell-snapshots", /^sh[0-9a-z-]{0,4}~\d+$/, "mg"],
      ["session-env", /^se[0-9a-z]{0,4}~\d+$/, "fg"],
    ] as const)
      if (key === undefined && configRows(paths, name, resources, alias).length)
        key = literal;
    if (key === undefined) return;
    const result = protectedFloor<Input>(key);
    if (!posix.isAbsolute(resources.configDirectory))
      result.message +=
        " CLAUDE_CONFIG_DIR is empty or relative here, so the config directory is worked out from each of three folders: the current one, the one where Claude Code was started and the home folder. That may be the only reason this path counts. Unset CLAUDE_CONFIG_DIR or set it to an absolute path to avoid that.";
    return result;
  }
  function exactPaths(
    paths: readonly string[],
    protectedPaths: readonly string[],
    subtree: boolean,
    folding: "segments" | "path" = "segments",
  ): boolean {
    return protectedPaths.flatMap(spellings).some((root) =>
      paths.some((path) => {
        const a =
          folding === "segments"
            ? comparable(path)
            : fold(posix.normalize(path));
        const b =
          folding === "segments"
            ? comparable(root)
            : fold(posix.normalize(root));
        return a === b || (subtree && within(a, b));
      }),
    );
  }
  function candidateIdentities(paths: readonly string[]): Set<string> {
    const identities = new Set<string>();
    for (const path of paths) {
      if (nativeNetworkProbePath(path)) continue;
      try {
        const row = options.identities.identity(
          posix.resolve(scopeCwd(), path),
        );
        if (
          row.isFile &&
          row.nlink > 1n &&
          ![0n, -1n, 0xffffffffffffffffn, 1n << 64n].includes(row.ino)
        )
          identities.add(`${row.dev}:${row.ino}`);
      } catch {
        /* zg's missing/unavailable identities do not establish an alias. */
      }
    }
    return identities;
  }
  function signInFloor(
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
  ): NativePermissionOutcome<Input> | undefined {
    const messages = {
      tokens: [
        "Claude Code keeps its sign-in tokens here; tools cannot write them",
        "This would change Claude Code’s sign-in tokens",
      ],
      device: [
        "Claude Code keeps the keys that identify this computer here; tools cannot write them",
        "This would change the keys that identify this computer to your account",
      ],
      lock: [
        "Claude Code takes this lock while it saves its sign-in tokens; tools cannot write it",
        "This would change a lock that Claude Code’s sign-in relies on",
      ],
    } as const;
    for (const group of resources.protected.signInFiles) {
      const alias =
        group.kind === "tokens"
          ? /^cr[0-9a-z]{0,4}~\d+\.jso$/
          : group.kind === "device"
            ? /^de[0-9a-z]{0,4}~\d+\.jso$/
            : /^st[0-9a-z]{0,4}~\d+\.loc$/;
      const rootNames = group.paths.map((path) =>
        nativeSensitivePathComponent(posix.basename(posix.dirname(path))),
      );
      const nameMatches = paths.some((path) => {
        if (
          !nativeSuspiciousWindowsPath(
            path,
            [],
            options.pathContext.macos ? "macos" : "linux",
            options.pathContext,
          )
        )
          return false;
        const parts = comparable(path).split("/");
        return parts.some(
          (part, index) =>
            index > 0 &&
            (group.paths.some(
              (file) =>
                part === nativeSensitivePathComponent(posix.basename(file)),
            ) ||
              alias.test(part)) &&
            (rootNames.includes(parts[index - 1] ?? "") ||
              /~\d/.test(parts[index - 1] ?? "")),
        );
      });
      if (exactPaths(paths, group.paths, true) || nameMatches) {
        const [message, reason] = messages[group.kind];
        return {
          behavior: "deny",
          message,
          decisionReason: {
            type: "safetyCheck",
            reason,
            classifierApprovable: false,
            circuitBreaker: "claudeSettingsFile",
          },
        };
      }
    }
    const candidate = candidateIdentities(paths);
    const originals = candidateIdentities(
      resources.protected.signInFiles.flatMap((group) =>
        group.paths.flatMap(spellings),
      ),
    );
    if ([...candidate].some((key) => originals.has(key)))
      return {
        behavior: "deny",
        message:
          "This is a hard link to one of Claude Code’s sign-in files, so a write to it could change that file; tools cannot write it. To use this name for a file of your own, delete it and create a new file",
        decisionReason: {
          type: "safetyCheck",
          reason:
            "This is a hard link to one of Claude Code’s sign-in files: a write to it can change that file, removing it does not",
          classifierApprovable: false,
          circuitBreaker: "claudeSettingsFile",
        },
      };
    return;
  }
  function identityFloor(
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
    hostFirst: boolean,
  ): NativePermissionOutcome<Input> | undefined {
    const host = () =>
      resources.protected.hostCredentialsPath !== null &&
      exactPaths(
        paths,
        [
          resources.protected.hostCredentialsPath.replace(/\/+$/, "") ||
            resources.protected.hostCredentialsPath,
        ],
        false,
        "path",
      )
        ? protectedFloor<Input>("Si")
        : undefined;
    if (hostFirst) {
      const result = host();
      if (result) return result;
    }
    const config = configFloor(paths, resources, "exact");
    if (config) return config;
    const seeds = [
      comparable(posix.join(resources.configDirectory, "seed-admin")),
    ];
    try {
      seeds.push(
        comparable(
          posix.join(
            options.pathContext.filesystem.realpath(
              posix.resolve(scopeCwd(), resources.configDirectory),
            ),
            "seed-admin",
          ),
        ),
      );
    } catch {
      /* Qp retains the named config seed root. */
    }
    if (
      paths.some((path) => seeds.some((root) => within(comparable(path), root)))
    )
      return protectedFloor("vi");
    if (!hostFirst) {
      const result = host();
      if (result) return result;
    }
    const profile = resources.protected.profileStore;
    if (
      profile &&
      (exactPaths(paths, profile.directories, true, "path") ||
        exactPaths(paths, profile.files, false, "path"))
    )
      return protectedFloor("mi");
    const review = posix.join(options.pathContext.home, ".claude/state");
    if (
      exactPaths(
        paths,
        [review, posix.join(review, "settings-review.json")],
        false,
      )
    )
      return protectedFloor("pi");
    return signInFloor(paths, resources);
  }
  function allSpellings(
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
    classify: (path: string) => NativePermissionOutcome<Input>,
  ): NativePermissionOutcome<Input> {
    let first: NativePermissionOutcome<Input> | undefined;
    for (const path of paths) {
      let result = classify(path);
      if (result.behavior === "passthrough") {
        const alias = pathAlias(path, resources);
        if (alias !== path) result = classify(alias);
      }
      if (result.behavior === "deny") return result;
      if (result.behavior !== "allow") return safe();
      first ??= result;
    }
    return first ?? safe();
  }
  function classifyWrite(
    path: string,
    input: Input | undefined,
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
    blockOutsideWrites: boolean,
  ): NativePermissionOutcome<Input> {
    if (resources.diskless) return protectedFloor("Cc");
    const normalized = posix.normalize(path);
    const protectedPath =
      configFloor([normalized], resources, "exact") ??
      configFloor([normalized], resources, "widest");
    if (protectedPath) return protectedPath;
    if (planFile(normalized, resources))
      return allow(
        input,
        "Plan files for current session are allowed for writing",
      );
    if (
      !policy.restricted &&
      !blockOutsideWrites &&
      resources.runtime.workflowDirectory !== null &&
      normalized.startsWith(resources.runtime.workflowDirectory) &&
      normalized.endsWith(".js")
    )
      return allow(
        input,
        "Workflow script files for current session are allowed for writing",
      );
    if (scratch(normalized, resources))
      return allow(
        input,
        "Scratchpad files for current session are allowed for writing",
      );
    if (background(normalized, resources))
      return allow(
        input,
        "Job tmp/ subtree for current bg session is allowed for writing",
      );
    if (
      !policy.restricted &&
      !blockOutsideWrites &&
      normalized.endsWith(".md") &&
      agentMemory(normalized, resources)
    )
      return allow(input, "Agent memory files are allowed for writing");
    if (memoryCandidate(normalized, resources) && resources.memory.paused)
      return memoryFloor("write");
    if (
      !policy.restricted &&
      (!resources.memory.requireExplicitMemoryWrites || blockOutsideWrites) &&
      normalized.endsWith(".md") &&
      ((plainMemory(normalized, resources.memory.autoMemoryRoot) &&
        !(blockOutsideWrites && resources.memory.memoryBlockedByReadFence)) ||
        (resources.memory.ownProjectMemoryEnabled &&
          plainMemory(normalized, resources.memory.ownProjectMemoryRoot)))
    )
      return allow(input, "auto memory files are allowed for writing");
    if (
      !policy.restricted &&
      normalized === posix.join(resources.originalCwd, ".claude/launch.json")
    )
      return allow(input, "Preview launch config is allowed for writing");
    return identityFloor([path, normalized], resources, false) ?? safe();
  }
  function protectedWrite(
    path: string,
    input: Input | undefined,
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
    blockOutsideWrites: boolean,
  ): NativePermissionOutcome<Input> {
    if (resources.diskless) return protectedFloor("Cc");
    if (paths.length) {
      const floor =
        identityFloor(paths, resources, true) ??
        configFloor(paths, resources, "widest");
      return (
        floor ??
        allSpellings(paths, resources, (candidate) =>
          classifyWrite(
            candidate,
            input,
            resources,
            policy,
            blockOutsideWrites,
          ),
        )
      );
    }
    return classifyWrite(path, input, resources, policy, blockOutsideWrites);
  }
  function classifyRead(
    path: string,
    input: Input | undefined,
    resources: NativeFileResourceSnapshot,
    settings: NativeProtectedReadOptions,
  ): NativePermissionOutcome<Input> {
    if (resources.diskless)
      return resources.memory.paused ? memoryFloor("read") : safe();
    const normalized = posix.normalize(path);
    if (memoryCandidate(normalized, resources) && resources.memory.paused)
      return memoryFloor("read");
    const runtime = resources.runtime;
    const projectStore = settings.blockOutsideReads
      ? runtime.originalProjectStoreDirectory
      : runtime.projectStoreDirectory;
    if (
      !settings.restricted &&
      projectStore !== null &&
      within(normalized, projectStore)
    )
      return allow(input, "Project directory files are allowed for reading");
    if (
      !settings.restricted &&
      runtime.connectorDownloadDirectory !== null &&
      normalized.split("/").includes("connector-downloads") &&
      normalized.startsWith(runtime.connectorDownloadDirectory + "/")
    ) {
      try {
        const identity = options.identities.followedIdentity(normalized);
        if (identity.isFile && identity.nlink <= 1n)
          return allow(
            input,
            "This project's connector downloads are allowed for reading",
          );
      } catch {
        /* Bg requires actual regular-file metadata. */
      }
    }
    if (planFile(normalized, resources))
      return allow(
        input,
        "Plan files for current session are allowed for reading",
      );
    if (runtime.toolResultDirectories.some((root) => within(normalized, root)))
      return allow(input, "Tool result files are allowed for reading");
    if (
      !settings.restricted &&
      runtime.ownSessionDirectory !== null &&
      within(normalized, runtime.ownSessionDirectory)
    )
      return allow(input, "This session's own files are allowed for reading");
    if (scratch(normalized, resources))
      return allow(
        input,
        "Scratchpad files for current session are allowed for reading",
      );
    if (background(normalized, resources))
      return allow(
        input,
        "Job tmp/ subtree for current bg session is allowed for reading",
      );
    if (
      runtime.taskOutputDirectory !== null &&
      posix.basename(posix.dirname(runtime.taskOutputDirectory)) ===
        resources.nativeSessionId &&
      (normalized === runtime.taskOutputDirectory ||
        (normalized.startsWith(runtime.taskOutputDirectory + "/") &&
          !normalized.includes("/", runtime.taskOutputDirectory.length + 1)))
    )
      return allow(
        input,
        "Task output files for current session are allowed for reading",
      );
    if (normalized.startsWith(runtime.projectTempPrefix))
      return allow(
        input,
        "Project temp directory files are allowed for reading",
      );
    const remote = settings.remoteSurface === true || settings.restricted;
    const fenced = remote || settings.blockOutsideReads;
    if (!fenced && agentMemory(normalized, resources))
      return allow(input, "Agent memory files are allowed for reading");
    if (
      settings.forTheModelHere &&
      !fenced &&
      runtime.allowEarlierToolResultsForModel &&
      runtime.earlierToolResultDirectories.some((root) =>
        within(normalized, root),
      )
    )
      return allow(
        input,
        "Tool result files saved under this session's earlier ids are allowed for reading",
      );
    if (
      !remote &&
      (plainMemory(normalized, resources.memory.autoMemoryRoot) ||
        (settings.searchRootFence &&
          plainMemory(normalized + "/", resources.memory.autoMemoryRoot))) &&
      !(settings.blockOutsideReads && resources.memory.memoryBlockedByReadFence)
    )
      return allow(input, "auto memory files are allowed for reading");
    if (
      !fenced &&
      within(normalized, posix.join(resources.configDirectory, "tasks"))
    )
      return allow(input, "Task files are allowed for reading");
    if (
      !fenced &&
      within(normalized, posix.join(resources.configDirectory, "teams"))
    )
      return allow(input, "Team files are allowed for reading");
    if (settings.readBlockFence && !settings.restricted) {
      if (normalized === posix.join(resources.configDirectory, "CLAUDE.md"))
        return allow(input, "The user memory file is allowed for reading");
      if (
        runtime.syncedPluginDirectories.some((root) => within(normalized, root))
      )
        return allow(input, "User plugins files are allowed for reading");
      for (const name of ["skills", "plugins", "rules", "agents", "commands"])
        if (within(normalized, posix.join(resources.configDirectory, name)))
          return allow(input, `User ${name} files are allowed for reading`);
    }
    if (
      !settings.remoteSurface &&
      normalized.startsWith(runtime.bundledSkillReferenceDirectory + "/")
    )
      return allow(
        input,
        "Bundled skill reference files are allowed for reading",
      );
    return safe();
  }

  function quote(path: string, scope: NativePermissionScope): string {
    return value(options.capabilities.quotePath(path, scope), scope);
  }
  function unresolved(
    path: string,
    operation: "read" | "write",
    scope: NativePermissionScope,
  ): NativePermissionOutcome<Input> {
    const quoted = quote(path, scope);
    return {
      behavior: "deny",
      message: `Refusing to ${operation} ${quoted}: where it leads on disk could not be determined (a link on the way could not be examined, or the links do not resolve).`,
      decisionReason: {
        type: "other",
        reason: `Where ${quoted} leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)`,
      },
    };
  }
  function settingsRoots(
    resources: NativeFileResourceSnapshot,
  ): readonly { root: string; names: readonly string[] }[] {
    return [
      ...unique([
        resources.configDirectory,
        posix.join(options.pathContext.home, ".claude"),
      ]).map((root) => ({
        root,
        names: ["settings.json", "cowork_settings.json"],
      })),
      ...unique([
        resources.originalCwd,
        ...(resources.configContextCwd === null
          ? []
          : [resources.configContextCwd]),
      ]).map((root) => ({
        root: posix.join(root, ".claude"),
        names: ["settings.json", "settings.local.json"],
      })),
    ];
  }
  function namedSettingsPaths(resources: NativeFileResourceSnapshot): string[] {
    return unique([
      ...resources.protected.settingsSourcePaths,
      ...unique([
        resources.configDirectory,
        posix.join(options.pathContext.home, ".claude"),
      ]).flatMap((root) =>
        ["settings.json", "cowork_settings.json"].map((name) =>
          posix.join(root, name),
        ),
      ),
    ]);
  }
  function namedSettingsFile(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): boolean {
    const normalized = normalize(path);
    const folded = comparable(normalized);
    if (
      folded.endsWith("/.claude/settings.json") ||
      folded.endsWith("/.claude/settings.local.json")
    )
      return true;
    if (
      namedSettingsPaths(resources).some((path) => comparable(path) === folded)
    )
      return true;
    if (
      folded.endsWith(".json") &&
      resources.protected.managedSettingsDirectories.some(
        (directory) => comparable(directory) === posix.dirname(folded),
      )
    )
      return true;
    const basename = posix.basename(folded);
    if (
      ![
        "settings.json",
        "cowork_settings.json",
        "settings.local.json",
      ].includes(basename)
    )
      return false;
    return settingsRoots(resources).some(({ root, names }) => {
      if (!names.includes(basename)) return false;
      try {
        return (
          posix.join(
            comparable(
              options.pathContext.filesystem.realpath(
                posix.resolve(scopeCwd(), root),
              ),
            ),
            basename,
          ) === folded
        );
      } catch {
        return false;
      }
    });
  }
  function settingsLinks(
    resources: NativeFileResourceSnapshot,
  ): ReadonlyMap<string, string> {
    const paths = unique([
      ...namedSettingsPaths(resources),
      ...(resources.protected.flagSettingsPath === null
        ? []
        : [resources.protected.flagSettingsPath]),
    ]);
    const key = paths.join("\0");
    const now = options.monotonicNow();
    if (
      settingsLinkMemo !== undefined &&
      settingsLinkMemo.key === key &&
      now - settingsLinkMemo.at < 2000
    )
      return settingsLinkMemo.files;
    const files = new Map<string, string>();
    settingsLinkMemo = { at: now, key, files };
    try {
      for (const path of paths) {
        const inspection = inspect(path);
        if (!inspection.leafIsSymlink) continue;
        for (const spelling of inspection.spellings)
          for (const candidate of unique([spelling, spelling.normalize("NFC")]))
            if (!namedSettingsFile(candidate, resources))
              files.set(comparable(candidate), path);
      }
    } catch {
      files.clear();
    }
    return files;
  }
  function protectedSettingsFile(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): boolean {
    const folded = comparable(normalize(path));
    if (
      settingsLinks(resources).has(folded) ||
      namedSettingsFile(path, resources)
    )
      return true;
    const named = resources.protected.settingsFiles.map(comparable);
    if (named.includes(folded)) return true;
    const basename = posix.basename(folded);
    if (!named.some((path) => posix.basename(path) === basename)) return false;
    return resources.protected.settingsBodyTemplates.some(
      ({ root, relativePaths }) => {
        let physical: string;
        try {
          physical = options.pathContext.filesystem.realpath(
            posix.resolve(scopeCwd(), root),
          );
        } catch {
          return false;
        }
        return relativePaths.some(
          (relative) => comparable(posix.join(physical, relative)) === folded,
        );
      },
    );
  }
  function settingsState(
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
  ): { certainty: "none" | "certain" | "possible" } {
    const directories = unique([
      resources.configDirectory,
      posix.join(options.pathContext.home, ".claude"),
      ...unique([
        resources.originalCwd,
        ...(resources.configContextCwd === null
          ? []
          : [resources.configContextCwd]),
      ]).map((root) => posix.join(root, ".claude")),
      ...(resources.protected.policySettingsPath === null
        ? []
        : [posix.dirname(resources.protected.policySettingsPath)]),
      ...resources.protected.managedSettingsDirectories,
    ]);
    for (const path of paths) {
      if (protectedSettingsFile(path, resources))
        return { certainty: "certain" };
      const folded = comparable(normalize(path)).replace(/[\\/]+$/, "");
      if (
        posix.basename(folded) === ".claude" ||
        directories.some((directory) => {
          if (comparable(directory) === folded) return true;
          try {
            return (
              comparable(
                options.pathContext.filesystem.realpath(
                  posix.resolve(scopeCwd(), directory),
                ),
              ) === folded
            );
          } catch {
            return false;
          }
        })
      )
        return { certainty: "certain" };
    }
    const candidates = paths.filter((path) =>
      nativeSensitivePathComponent(posix.basename(path)).endsWith(".json"),
    );
    if (candidates.length === 0) return { certainty: "none" };
    let allResolved = true;
    const locatedDirectories = [
      ...resources.protected.managedSettingsDirectories,
    ];
    for (const directory of resources.protected.managedSettingsDirectories) {
      let current = directory;
      const missing: string[] = [];
      for (;;) {
        try {
          const physical = options.pathContext.filesystem.realpath(
            posix.resolve(scopeCwd(), current),
          );
          const located = posix.join(physical, ...missing);
          locatedDirectories.push(located, located.normalize("NFC"));
          break;
        } catch (error) {
          const errno =
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined;
          if (errno === "ENOENT" && posix.dirname(current) !== current) {
            missing.unshift(posix.basename(current));
            current = posix.dirname(current);
            continue;
          }
          if (errno !== "EACCES" && errno !== "EPERM" && errno !== "ENOTDIR")
            allResolved = false;
          break;
        }
      }
    }
    if (
      candidates.some((path) =>
        locatedDirectories.some(
          (directory) =>
            comparable(directory) ===
            posix.dirname(comparable(normalize(path))),
        ),
      )
    )
      return { certainty: "certain" };
    return { certainty: allResolved ? "none" : "possible" };
  }
  function comparePluginPath(path: string, knownNotSuspect = false): string {
    return nativePermissionComparablePath(path, {
      cwd: scopeCwd(),
      filesystem: options.ancestryFilesystem,
      knownNotSuspect,
    });
  }
  function devModsSensitive(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): boolean {
    const directory = posix.resolve(
      scopeCwd(),
      resources.configDirectory,
      "dev-mods",
    );
    const named = spellings(directory);
    const folded = comparable(path);
    if (named.map(comparable).some((root) => within(folded, root))) return true;
    const mayVet = networkKind(path) === undefined || nativeLocalWslPath(path);
    if (
      mayVet &&
      nativePermissionAncestryRisk(path, options.ancestryFilesystem)
    )
      return true;
    const candidate = comparePluginPath(path, mayVet);
    const scan = scanNativeDevMods({
      root: directory,
      followLinks: resources.plugins.devModsFollowLinks,
      context: options.pathContext,
      filesystem: options.pluginDirectoryFilesystem,
    });
    if (!scan.isWhole) return true;
    return [...named, ...scan.links].some((root) =>
      nativePermissionComparableContains(comparePluginPath(root), candidate),
    );
  }
  function additionalProducerSensitive(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): boolean {
    const additional = resources.plugins.additionalProducerRoot;
    if (additional === null || resources.configHome === null) return false;
    const root = posix.resolve(scopeCwd(), additional);
    if (
      spellings(resources.configHome).some(
        (config) =>
          root === config ||
          root.startsWith(config + "/") ||
          config.startsWith(root + "/"),
      )
    )
      return false;
    return spellings(root).some((spelling) =>
      (path + "/").startsWith(spelling + "/"),
    );
  }
  function producerSensitive(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): boolean {
    const now = options.now();
    if (producerMemo === undefined || !(now - producerMemo.at < 5000)) {
      const original = comparePluginPath(resources.originalCwd);
      const config = comparePluginPath(resources.configDirectory);
      const ordinary = resources.plugins.producerRoots
        .map((root) => comparePluginPath(root))
        .filter((root) => !nativePermissionComparableContains(root, original));
      // Native Nti updates scannedAt before the retained paths are canonicalized.
      const at = options.now();
      const retained = resources.plugins.retainedProducerPaths.map((root) =>
        comparePluginPath(root),
      );
      producerMemo = {
        at,
        roots: [...ordinary, ...retained],
        needsCanonicalCandidate:
          retained.length > 0 ||
          ordinary.some(
            (root) => !nativePermissionComparableContains(config, root),
          ),
      };
    }
    const wslPrefix =
      /^([\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+[^\\/]+)((?:[\\/].*)?)$/i;
    if (
      resources.plugins.wslProviderUndeterminable &&
      (wslPrefix.test(nativeAncestryPathSpelling(path)) ||
        wslPrefix.test(comparePluginPath(path)))
    )
      return true;
    if (producerMemo.roots.length === 0) return false;
    if (
      producerMemo.needsCanonicalCandidate &&
      nativePermissionAncestryRisk(path, options.ancestryFilesystem)
    )
      return true;
    const candidate = producerMemo.needsCanonicalCandidate
      ? comparePluginPath(path, true)
      : posix.resolve(scopeCwd(), path).normalize("NFC").toLowerCase();
    return producerMemo.roots.some((root) =>
      nativePermissionComparableContains(root, candidate),
    );
  }
  function inlineProducerSensitive(
    path: string,
    resources: NativeFileResourceSnapshot,
  ): boolean {
    const selected = resources.plugins.inlineRoots;
    if (selected.length === 0) return false;
    if (nativePermissionAncestryRisk(path, options.ancestryFilesystem))
      return true;
    const key = selected.join("\0");
    if (
      inlineMemo === undefined ||
      inlineMemo.key !== key ||
      !(
        Number.isFinite(inlineMemo.at) &&
        Math.abs(options.now() - inlineMemo.at) < 30000
      )
    )
      inlineMemo = {
        key,
        roots: selected.map((root) =>
          comparePluginPath(
            root,
            !nativePermissionAncestryRisk(root, options.ancestryFilesystem),
          ),
        ),
        at: options.now(),
      };
    const candidate = comparePluginPath(path, true);
    return inlineMemo.roots.some((root) =>
      nativePermissionComparableContains(root, candidate),
    );
  }
  function sensitiveWrite(
    path: string,
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
  ): NativeFileSensitiveWrite {
    const standard = `Claude requested permissions to write to ${format(path)}, but you haven't granted it yet.`;
    if (resources.diskless)
      return { safe: false, message: standard, classifierApprovable: false };
    const settings = settingsState(paths, resources);
    const trusted = policy.trustedNetworkDirectories ?? [];
    if (
      paths.some((candidate) =>
        nativeSuspiciousWindowsPath(
          candidate,
          trusted,
          options.pathContext.macos ? "macos" : "linux",
          options.pathContext,
        ),
      )
    )
      return {
        safe: false,
        message: `Claude requested permissions to write to ${format(path)}, which contains a suspicious Windows path pattern that requires manual approval.`,
        classifierApprovable: false,
        circuitBreaker: "suspiciousWindowsPath",
        ...(settings.certainty !== "none"
          ? { also: ["claudeSettingsFile"] }
          : {}),
      };
    if (settings.certainty !== "none") {
      const links = settingsLinks(resources);
      const folded = paths.map((path) => comparable(normalize(path)));
      const linkedFrom = folded
        .map((path) => links.get(path))
        .find((path) => path !== undefined);
      return {
        safe: false,
        message:
          standard +
          (linkedFrom === undefined || folded.includes(comparable(linkedFrom))
            ? ""
            : ` The Claude Code settings file ${quote(linkedFrom, scope)} leads here through a link.`),
        classifierApprovable: linkedFrom === undefined,
        circuitBreaker: "claudeSettingsFile",
      };
    }
    const remote = remoteMode(policy);
    if (
      !remote &&
      paths.some((candidate) =>
        [scopeCwd(), resources.configContextCwd]
          .filter((root): root is string => root !== null)
          .some((root) =>
            ["commands", "agents", "skills"].some((name) =>
              nativePermissionPathContained(
                candidate,
                posix.join(root, ".claude", name),
                options.pathContext,
              ),
            ),
          ),
      )
    )
      return { safe: false, message: standard, classifierApprovable: true };
    const originalRoots = roots(resources.originalCwd, resources);
    for (const candidate of paths) {
      const normalized = normalize(candidate);
      const mayVet =
        networkKind(normalized) === undefined || nativeLocalWslPath(normalized);
      const pluginSensitive =
        devModsSensitive(normalized, resources) ||
        additionalProducerSensitive(normalized, resources) ||
        (mayVet &&
          (producerSensitive(normalized, resources) ||
            inlineProducerSensitive(normalized, resources)));
      if (
        pluginSensitive ||
        (((nativeUncPath(candidate) && !nativeLocalWslPath(candidate)) ||
          networkKind(candidate)) &&
          !trustedNetwork(candidate, trusted, options.pathContext)) ||
        nativeSensitiveLexicalPath(normalized, remote, originalRoots)
      )
        return {
          safe: false,
          message: `Claude requested permissions to edit ${format(path)} which is a sensitive file.`,
          classifierApprovable: true,
        };
    }
    return { safe: true };
  }
  function linkNote(
    path: string,
    inspection: NativeFilePermissionInspection,
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
    selectedRoots?: readonly string[],
  ): {
    landing: string;
    sentence: string;
    carriedOut: boolean;
    landingOutside: boolean;
  } | null {
    if (
      inspection.unresolved ||
      options.trustedAlias(
        posix.resolve(scopeCwd(), inspection.requested).normalize("NFC"),
      ) ===
        options.trustedAlias(
          posix.resolve(scopeCwd(), inspection.landing).normalize("NFC"),
        )
    )
      return null;
    const allowed = selectedRoots ?? ordinaryWorkingRoots(resources, policy);
    const outside = !containsAll([inspection.landing], allowed, resources);
    const inside = containsAll([inspection.requested], allowed, resources);
    return {
      landing: inspection.landing,
      carriedOut: inside && outside,
      landingOutside: outside,
      sentence: `${quote(path, scope)} resolves through a symlink to ${quote(inspection.landing, scope)}${outside ? ", which is outside the allowed working directories" : ""}`,
    };
  }
  function unexpectedNetworkLanding(path: string): boolean {
    // jr uses ce without pa's tilde expansion. Direct UNC input returns undefined
    // in that profile; a link may instead return a collapsed non-UNC spelling.
    if (nativeUncPath(path) && !nativeLocalWslPath(path)) return false;
    const probe = inspect(posix.resolve(scopeCwd(), path));
    if (probe.unresolved || !probe.endsUnexamined) return false;
    return (
      networkKind(probe.landing) === undefined &&
      !/^[\\/](GLOBAL\?\?|GLOBALROOT|DosDevices|Device)[\\/]/i.test(
        probe.landing,
      )
    );
  }
  function protectedRead(
    path: string,
    input: Input | undefined,
    paths: readonly string[],
    resources: NativeFileResourceSnapshot,
    settings: NativeProtectedReadOptions,
  ): NativePermissionOutcome<Input> {
    return paths.length
      ? allSpellings(paths, resources, (candidate) =>
          classifyRead(candidate, input, resources, settings),
        )
      : classifyRead(path, input, resources, settings);
  }
  function fence(
    path: string,
    inspection: NativeFilePermissionInspection,
    input: Input | undefined,
    resources: NativeFileResourceSnapshot,
    policy: NativeFileAdjudicationPolicy,
    scope: NativePermissionScope,
    operation: "read" | "write",
    readOptions?: NativeProtectedReadOptions,
  ): NativePermissionOutcome<Input> | null {
    const blocked =
      operation === "read"
        ? policy.blockReadsOutsideWorkingDirectories === true ||
          policy.blockFileToolReadsOutsideWorkingDirectories === true
        : policy.blockWritesOutsideWorkingDirectories === true;
    const selectedRoots = blocked
      ? fenceRoots(resources, policy)
      : ordinaryWorkingRoots(resources, policy);
    const reason = policy.restricted
      ? text.restrictedMode
      : operation === "write"
        ? text.outsideWritesBlocked
        : policy.blockReadsOutsideWorkingDirectories
          ? text.outsideReadsBlocked
          : text.outsideFileReadsBlocked;
    const additionalHelp = policy.blockFileToolReadsOutsideWorkingDirectories
      ? ""
      : " Ask the user to add the directory with /add-dir, or to remove that setting.";
    const settingNames = [
      policy.blockReadsOutsideWorkingDirectories &&
        "permissions.blockReadsOutsideWorkingDirectories",
      policy.blockFileToolReadsOutsideWorkingDirectories &&
        "permissions.blockFileToolReadsOutsideWorkingDirectories",
    ]
      .filter(Boolean)
      .join(" and ");
    const why = policy.restricted
      ? "--restricted confines the file tools to the working directory."
      : operation === "write"
        ? `the permissions.blockWritesOutsideWorkingDirectories setting blocks writes outside the working directories.${additionalHelp}`
        : `the ${settingNames} ${policy.blockFileToolReadsOutsideWorkingDirectories && policy.blockReadsOutsideWorkingDirectories ? "settings block" : "setting blocks"} reads outside the working directories.${additionalHelp}`;
    const generic = (): NativePermissionOutcome<Input> => ({
      behavior: "deny",
      message: `Where ${quote(path, scope)} leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve); ${why}`,
      decisionReason: { type: "other", reason },
    });
    if (inspection.unresolved) return generic();
    const exempt =
      operation === "read" && !policy.restricted
        ? (policy.readBlockExemptPaths ?? [])
        : [];
    let admitted =
      inspection.spellings.length > 0 &&
      containsAll(inspection.spellings, selectedRoots, resources, exempt);
    if (
      inspection.spellings.length > 0 &&
      !admitted &&
      !(
        policy.blockFileToolReadsOutsideWorkingDirectories &&
        resources.blockFileReadProtectedExceptions
      ) &&
      includeOriginal(resources, policy)
    ) {
      const classified =
        operation === "read"
          ? protectedRead(
              normalize(path),
              input,
              inspection.spellings,
              resources,
              readOptions ?? {
                restricted: policy.restricted,
                blockOutsideReads: blocked,
                transcriptsJudged: true,
              },
            )
          : protectedWrite(
              normalize(path),
              input,
              inspection.spellings,
              resources,
              policy,
              true,
            );
      admitted = classified.behavior === "allow";
    }
    const firstSpelling = inspection.spellings[0];
    if (
      admitted &&
      firstSpelling !== undefined &&
      !unexpectedNetworkLanding(firstSpelling)
    )
      return null;
    if (unexpectedNetworkLanding(inspection.requested)) return generic();
    const note = linkNote(
      path,
      inspection,
      resources,
      policy,
      scope,
      selectedRoots,
    );
    const folders =
      selectedRoots.join(", ") ||
      "every folder that the file tools may use (this session was launched with none)";
    const requested = posix.resolve(
      scopeCwd(),
      normalize(inspection.requested),
    );
    const components = requested.split(/\/+/).filter(Boolean);
    const caseCandidate =
      !options.pathContext.macos || note?.landingOutside
        ? undefined
        : selectedRoots
            .flatMap((root) => roots(root, resources))
            .map((root) =>
              posix.join(
                root,
                ...components.slice(root.split(/\/+/).filter(Boolean).length),
              ),
            )
            .find(
              (candidate) =>
                candidate !== requested && fold(candidate) === fold(requested),
            );
    return {
      behavior: "deny",
      message: format(
        note?.carriedOut
          ? `${quote(path, scope)} resolves through a symlink to ${quote(note.landing, scope)}, which is outside ${folders}; ${why}`
          : `${path} is outside ${folders}${caseCandidate === undefined ? "" : ` (letter case counts: ${caseCandidate} is inside)`}; ${why}`,
      ),
      decisionReason: { type: "other", reason },
      blockedPath: note?.carriedOut ? note.landing : path,
    };
  }
  function specialRule(
    path: string,
    resources: NativeFileResourceSnapshot,
    scope: NativePermissionScope,
  ): { pattern: string } | null {
    if (resources.diskless) return null;
    const normalized = normalize(path);
    for (const [rawRoot, prefix] of [
      [posix.join(resources.originalCwd, ".claude/skills"), "/.claude/skills/"],
      [
        posix.join(options.pathContext.home, ".claude/skills"),
        "~/.claude/skills/",
      ],
    ] as const) {
      const root = normalize(rawRoot);
      if (!fold(normalized).startsWith(fold(root) + "/")) continue;
      const rest = normalized.slice(root.length + 1);
      const separator = rest.indexOf("/");
      if (separator <= 0) return null;
      const skill = rest.slice(0, separator);
      if (
        !skill ||
        skill === "." ||
        skill.includes("..") ||
        /[*?[\]\\]/.test(skill)
      )
        return null;
      if (
        prefix === "~/.claude/skills/" ||
        resources.runtime.reservedSkillDirectories
          .map(fold)
          .includes(fold(root))
      ) {
        const reader = options.capabilities.isAdmittedSkillName;
        if (reader === undefined)
          throw new NativePermissionDependencyError(
            "Zte/oae",
            "Skill registry admission is unavailable",
          );
        if (!value(reader(skill, scope), scope)) return null;
      }
      if (
        nativeSensitivePathComponent(skill) === ".claude" ||
        rest
          .slice(separator + 1)
          .split(/[/\\]/)
          .some((part) => nativeSensitivePathComponent(part) === ".claude")
      )
        return null;
      return { pattern: prefix + skill + "/**" };
    }
    return null;
  }
  function parent(path: string): string {
    const normalized = normalize(path);
    if (nativeNetworkProbePath(normalized)) return posix.dirname(normalized);
    try {
      if (options.identities.isDirectory(normalized)) return normalized;
    } catch {
      /* Native missing targets use dirname. */
    }
    return posix.dirname(normalized);
  }
  function networkOutcome(
    path: string,
    kind: Exclude<ReturnType<typeof networkKind>, undefined>,
    glob: boolean,
  ): NativePermissionOutcome<Input> {
    const detected = " detected (defense-in-depth check)";
    const description =
      kind === "unc"
        ? `appears to be a UNC ${glob ? "pattern" : "path"} that could access network resources.`
        : kind === "automount"
          ? "is under the /net automount map and could trigger a DNS lookup and NFS mount to a remote host."
          : kind === "browse"
            ? "is under the /Network automount browse surface and could trigger a directory-service lookup and mount to a remote host."
            : "is under /.vol, /.file, /.nofollow or /.resolve (paths the macOS kernel redirects) and could reach a network mount, triggering a DNS lookup and mount to a remote host.";
    const reason =
      kind === "unc"
        ? `UNC ${glob ? "glob pattern" : "path"}`
        : kind === "automount"
          ? `Automount -hosts ${glob ? "glob pattern" : "path"}`
          : kind === "browse"
            ? `Automount browse surface${glob ? " glob pattern" : ""}`
            : `Kernel-resolved path prefix (/.vol etc.)${glob ? " glob pattern" : ""}`;
    return {
      behavior: "ask",
      message: `Claude requested permissions to ${glob ? "glob " + path : "read from " + format(path)}, which ${description}`,
      decisionReason: {
        type: "safetyCheck",
        classifierApprovable: false,
        reason: reason + detected,
      },
    };
  }
  return {
    invalidateProducerPaths() {
      producerMemo = undefined;
    },
    inspect: (path, scope) => fact(scope, ["pa/st/ce"], () => inspect(path)),
    normalize: (path, scope) => fact(scope, ["wt"], () => normalize(path)),
    format: (path, scope) => fact(scope, ["Uc"], () => format(path)),
    unresolvedPathText: (path, scope) =>
      fact(scope, ["hx/$7t"], () => {
        const quotedPath = quote(path, scope);
        return {
          quotedPath,
          reason: `Where ${quotedPath} leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)`,
        };
      }),
    matchRule: (path, policy, family, behavior, scope) =>
      fact(scope, ["Oa/qKt/Xxt"], () =>
        matched(path, policy, family, behavior, scope),
      ),
    allowAlias: (path, scope) =>
      fact(scope, ["GSe"], () => options.trustedAlias(path)),
    readProtection: (path, inspection, _policy, scope) =>
      fact(scope, ["ale/Jc/_i/C5r"], () => {
        const resources = state(scope);
        if (!resources.memory.paused) return {};
        const paths = [...inspection.spellings];
        try {
          paths.push(normalize(path));
        } catch {
          /* Source La yields null for an unnormalizable spelling. */
        }
        return resources.memory.canLackFolderAndUnresolved ||
          paths.some(
            (candidate) =>
              memoryCandidate(candidate + "/", resources) ||
              memoryCandidate(pathAlias(candidate, resources) + "/", resources),
          )
          ? { memoryPausedFloor: memoryFloor<Input>("read") }
          : {};
      }),
    outsideReadBlock: (policy, scope) =>
      fact(
        scope,
        ["lk"],
        () =>
          policy.blockReadsOutsideWorkingDirectories === true ||
          policy.blockFileToolReadsOutsideWorkingDirectories === true,
      ),
    readFence: (path, inspection, input, policy, settings, scope) =>
      fact(scope, ["Nc/Ci/mv/kwn/Mi/Wr/Ic"], () =>
        fence(
          path,
          inspection,
          input,
          state(scope),
          policy,
          scope,
          "read",
          settings,
        ),
      ),
    ...(options.capabilities.servedReadFenceAskStaysDenied === undefined
      ? {}
      : {
          servedReadFenceAskStaysDenied:
            options.capabilities.servedReadFenceAskStaysDenied,
        }),
    networkRead: (tool, input, policy, paths, scope) =>
      fact(scope, ["bct/Lte/wwn"], () => {
        if (!tool.getPath) return null;
        const requested = tool.getPath(input);
        const trusted = policy.trustedNetworkDirectories ?? [];
        const candidates = [
          ...(networkKind(requested) !== "unc" ? [requested] : []),
          ...paths,
        ];
        for (const path of candidates) {
          const kind = networkKind(path);
          if (
            kind === undefined ||
            trustedNetwork(path, trusted, options.pathContext)
          )
            continue;
          return networkOutcome(requested, kind, false);
        }
        if (
          tool.name === "Glob" &&
          typeof input === "object" &&
          input !== null &&
          "pattern" in input &&
          typeof input.pattern === "string"
        ) {
          const kind = networkKind(input.pattern);
          if (
            kind !== undefined &&
            !trustedNetwork(input.pattern, trusted, options.pathContext)
          )
            return networkOutcome(input.pattern, kind, true);
        }
        if (
          paths.some((path) =>
            nativeSuspiciousWindowsPath(
              path,
              trusted,
              options.pathContext.macos ? "macos" : "linux",
              options.pathContext,
            ),
          )
        )
          return {
            behavior: "ask",
            message: `Claude requested permissions to read from ${format(requested)}, which contains a suspicious Windows path pattern that requires manual approval.`,
            decisionReason: {
              type: "other",
              reason:
                "Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification",
            },
          };
        return null;
      }),
    ...(options.capabilities.readBypassAvailable === undefined
      ? {}
      : { readBypassAvailable: options.capabilities.readBypassAvailable }),
    writeFloor: (path, inspection, normalized, policy, scope) =>
      fact(scope, ["TVo/Qc/Nc/Vg/en/yi"], () => {
        for (const candidate of inspection.spellings) {
          const rule = matched(candidate, policy, "edit", "deny", scope);
          if (rule)
            return {
              behavior: "deny",
              message: `Permission to edit ${format(path)} has been denied.`,
              decisionReason: { type: "rule", rule },
            };
        }
        const resources = state(scope);
        if (policy.restricted || policy.blockWritesOutsideWorkingDirectories) {
          const result = fence(
            path,
            inspection,
            undefined,
            resources,
            policy,
            scope,
            "write",
          );
          if (result) return result;
        }
        if (
          policy.blockWritesOutsideWorkingDirectories &&
          settingsState(inspection.spellings, resources).certainty !== "none"
        )
          return {
            behavior: "deny",
            message: format(`${path}: ${text.settingsWritesBlocked}`),
            decisionReason: {
              type: "other",
              reason: text.settingsWritesBlocked,
            },
          };
        if (resources.diskless) return protectedFloor("Cc");
        if (
          resources.memory.paused &&
          (resources.memory.canLackFolderAndUnresolved ||
            [...inspection.spellings, normalized].some(
              (candidate) =>
                memoryCandidate(candidate + "/", resources) ||
                memoryCandidate(
                  pathAlias(candidate, resources) + "/",
                  resources,
                ),
            ))
        )
          return memoryFloor("write");
        const floor = identityFloor(inspection.spellings, resources, false);
        if (floor) return floor;
        if (inspection.unresolved) return unresolved(path, "write", scope);
        return configFloor(inspection.spellings, resources, "widest");
      }),
    sessionEditRuleEligible: (raw, paths, _policy, scope) =>
      fact(scope, ["GZn/pg"], () => {
        const parsed = parseNativePermissionRule(raw);
        if (parsed.kind !== "call") return false;
        const content = parsed.content;
        if (
          !(
            content.startsWith("/.claude/") || content.startsWith("~/.claude/")
          ) ||
          content.includes("..") ||
          !content.endsWith("/**")
        )
          return false;
        const base = normalize(
          posix.join(
            content.startsWith("~")
              ? options.pathContext.home
              : state(scope).originalCwd,
            ".claude",
          ),
        );
        return !paths.some(
          (path) =>
            within(normalize(path), base) &&
            normalize(path)
              .slice(base.length)
              .split("/")
              .some((part) => nativeSensitivePathComponent(part) === ".claude"),
        );
      }),
    writePathShape: (path, policy, scope) =>
      fact(scope, ["Hte/ic"], () => {
        const resources = state(scope);
        const parts = normalize(path).split("/");
        return {
          suspiciousNetwork:
            nativeSuspiciousWindowsPath(
              path,
              policy.trustedNetworkDirectories ?? [],
              options.pathContext.macos ? "macos" : "linux",
              options.pathContext,
            ) !== undefined,
          nestedConfigDirectories: parts
            .slice(
              configBoundary(parts, roots(resources.originalCwd, resources)),
            )
            .filter((part) => nativeSensitivePathComponent(part) === ".claude")
            .length,
        };
      }),
    protectedWrite: (path, input, paths, policy, scope) =>
      fact(scope, ["vct/Zc/en/yi"], () =>
        protectedWrite(path, input, paths, state(scope), policy, false),
      ),
    sensitiveWrite: (path, paths, policy, scope) =>
      fact(scope, ["uJ/OQn/qp/gg"], () =>
        sensitiveWrite(path, paths, state(scope), policy, scope),
      ),
    writeNote: (path, inspection, policy, scope) =>
      fact(scope, ["vVo/S6e/f7e"], () => {
        const resources = state(scope);
        const note = linkNote(path, inspection, resources, policy, scope);
        return note === null
          ? null
          : {
              landing: note.landing,
              sentence: note.sentence,
              personOnly:
                sensitiveWrite(
                  inspection.requested,
                  [inspection.requested],
                  resources,
                  policy,
                  scope,
                ).safe || note.carriedOut,
            };
      }),
    specialSessionWriteRule: (path, _policy, scope) =>
      fact(scope, ["Gp"], () => specialRule(path, state(scope), scope)),
    inWorkingDirectories: (_path, paths, policy, scope) =>
      fact(scope, ["vy/mv/oLe"], () => {
        const resources = state(scope);
        return containsAll(
          paths,
          ordinaryWorkingRoots(resources, policy),
          resources,
        );
      }),
    ...(options.capabilities.wholeToolAllow === undefined
      ? {}
      : { wholeToolAllow: options.capabilities.wholeToolAllow }),
    protectedRead: (path, input, paths, _policy, settings, scope) =>
      fact(scope, ["lLe/Zc"], () =>
        protectedRead(path, input, paths, state(scope), settings),
      ),
    ...(options.capabilities.modelReadMode === undefined
      ? {}
      : { modelReadMode: options.capabilities.modelReadMode }),
    suggestions: (path, family, paths, policy, scope) =>
      fact(scope, ["KKt/Gxt/yre/zKt"], () => {
        const resources = state(scope);
        const outside = !containsAll(
          paths,
          ordinaryWorkingRoots(resources, policy),
          resources,
        );
        if (family === "read" && outside)
          return spellings(parent(path))
            .filter((directory) => directory !== "/")
            .map((directory) => ({
              type: "addRules" as const,
              rules: [
                {
                  toolName: "Read",
                  ruleContent:
                    "/" +
                    directory
                      .replaceAll("\\", "\\\\")
                      .replace(/([*?[\]])/g, "\\$1") +
                    "/**",
                },
              ],
              behavior: "allow" as const,
              destination: "session",
            }));
        const forbidden = (mode: string | undefined) =>
          ["auto", "bypassPermissions", "acceptEdits", "dontAsk"].includes(
            mode ?? "",
          );
        const maySetMode =
          !forbidden(policy.modeBeforeRewrite) &&
          (policy.mode === "default" ||
            (policy.mode === "plan" && !forbidden(policy.prePlanMode)));
        const result = maySetMode
          ? [
              {
                type: "setMode" as const,
                mode: "acceptEdits",
                destination: "session",
              },
            ]
          : [];
        return family === "write" && outside
          ? [
              ...result,
              {
                type: "addDirectories" as const,
                directories: [...spellings(parent(path))],
                destination: "session",
              },
            ]
          : result;
      }),
    outsideAsk: (operation, path, inspection, policy, scope) =>
      fact(scope, ["Kc/S6e/f7e"], () => {
        const note = linkNote(path, inspection, state(scope), policy, scope);
        const message = `Claude requested permissions to ${operation} ${format(path)}, but you haven't granted it yet.`;
        return note?.carriedOut
          ? {
              message: `${message} ${note.sentence}.`,
              blockedPath: note.landing,
              decisionReason:
                operation === "write to"
                  ? {
                      type: "safetyCheck",
                      reason: note.sentence,
                      classifierApprovable: false,
                    }
                  : { type: "workingDir", reason: note.sentence },
            }
          : {
              message,
              decisionReason: {
                type: "workingDir",
                reason: text.workingDirectory,
              },
            };
      }),
  };
}
