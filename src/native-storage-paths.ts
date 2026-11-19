import { posix, win32 } from "node:path";
import type { NativeWriterContext } from "./native-session-writer.js";

/** Compatibility facts from the retained build, not the port's package version. */
export const NATIVE_STORAGE_COMPATIBILITY_VERSION = "2.1.326" as const;

export interface NativeStorageEnvironment {
  CLAUDE_CONFIG_DIR?: string;
  CLAUDE_CODE_PROJECT_DIR_NAME?: string;
  CLAUDE_CODE_ENTRYPOINT?: string;
  CLAUDE_CODE_SESSION_KIND?: string;
  CLAUDE_CODE_SKIP_PROMPT_HISTORY?: string;
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE?: string;
  CLAUDE_CODE_CHILD_SESSION?: string;
}

export type NativeStoragePlatform = "posix" | "win32";
export type NativeSessionIdAdmission = "ordinary" | "sdk-custom";
export type NativeStorageSessionKind = "bg" | "daemon" | "daemon-worker";

const reservedBasename = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function stringFact(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`Invalid native ${name}`);
}

function booleanFact(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`Invalid native ${name}`);
}

function environmentFacts(environment: NativeStorageEnvironment): void {
  if (environment === null || typeof environment !== "object")
    throw new TypeError("Explicit native environment facts are required");
  for (const value of Object.values(environment))
    if (value !== undefined) stringFact(value, "environment value");
}

/** Source BF: safe filename shape, deliberately broader than resume adoption. */
export function isNativeSessionBasenameId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(value) &&
    !reservedBasename.test(value)
  );
}

/** Source Vk/Q: inspect the final _01 plus exactly 22 base58 digits. */
export function decodeNativeEncodedSessionId(
  value: string,
): string | undefined {
  stringFact(value, "encoded session ID");
  const separator = value.lastIndexOf("_");
  if (separator < 0) return;
  const suffix = value.slice(separator + 1);
  if (!suffix.startsWith("01") || suffix.length !== 24) return;
  let decoded = 0n;
  for (const character of suffix.slice(2)) {
    const digit = base58.indexOf(character);
    if (digit < 0) return;
    decoded = decoded * 58n + BigInt(digit);
  }
  const hex = decoded.toString(16).padStart(32, "0");
  if (hex.length !== 32) return;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Source wYe/p3r: a basename-safe arbitrary ID needs the SDK custom-ID lane. */
export function canAdoptNativeSessionId(
  value: unknown,
  admission: NativeSessionIdAdmission,
): value is string {
  if (admission !== "ordinary" && admission !== "sdk-custom")
    throw new TypeError("Explicit native session ID admission is required");
  if (!isNativeSessionBasenameId(value)) return false;
  return (
    admission === "sdk-custom" ||
    uuid.test(value) ||
    (/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(value) &&
      decodeNativeEncodedSessionId(value) !== undefined)
  );
}

/** Source Edt: invalid adoption becomes a fork; no replacement ID is invented. */
export function planNativeSessionIdAdoption(
  value: unknown,
  options: { fork: boolean; admission: NativeSessionIdAdmission },
): Readonly<{ adoptedSessionId: string | null; effectiveFork: boolean }> {
  booleanFact(options.fork, "fork flag");
  if (options.admission !== "ordinary" && options.admission !== "sdk-custom")
    throw new TypeError("Explicit native session ID admission is required");
  if (options.fork)
    return Object.freeze({ adoptedSessionId: null, effectiveFork: true });
  if (value === undefined)
    return Object.freeze({ adoptedSessionId: null, effectiveFork: false });
  return canAdoptNativeSessionId(value, options.admission)
    ? Object.freeze({ adoptedSessionId: value, effectiveFork: false })
    : Object.freeze({ adoptedSessionId: null, effectiveFork: true });
}

/** Source WIi: no trimming, reserved-name normalization or alternate spelling. */
export function validateNativeProjectDirectoryOverride(
  value: unknown,
): string | undefined {
  if (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value) &&
    !reservedBasename.test(value)
  )
    return value;
  return;
}

/** Source nH/$Q. This function intentionally does not normalize its raw input. */
export function encodeNativeProjectDirectoryName(value: string): string {
  stringFact(value, "project directory input");
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let index = 0; index < value.length; index++)
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

export interface NativeStoragePathFacts {
  /** Explicit fallback root. Native-default hosts supply homedir/.claude. */
  configDirectory: string;
  originalCwd: string | null;
  /** WQ/Jb's adopted directory, with null/absence meaning no override. */
  adoptedSessionDirectory?: string | null;
  sessionId: string;
  sessionIdAdmission: NativeSessionIdAdmission;
  platform: NativeStoragePlatform;
  diskless: boolean;
  environment: Readonly<NativeStorageEnvironment>;
}

export interface NativeStoragePaths {
  readonly configDirectory: string;
  readonly projectsDirectory: string;
  readonly projectDirectory: string;
  readonly projectKey: string | null;
  readonly transcriptPath: string;
  readonly originalCwd: string | null;
  readonly effectiveProjectOverride: string | undefined;
  readonly selection: "adopted" | "original-cwd" | "project-name";
  readonly absolute: boolean;
}

/** Source Ye/$mr/Cy/T6e/$te/um, without host caching or filesystem admission. */
export function resolveNativeStoragePaths(
  facts: NativeStoragePathFacts,
): Readonly<NativeStoragePaths> {
  stringFact(facts.configDirectory, "configuration directory");
  if (facts.originalCwd !== null) stringFact(facts.originalCwd, "original cwd");
  if (facts.adoptedSessionDirectory != null)
    stringFact(facts.adoptedSessionDirectory, "adopted session directory");
  booleanFact(facts.diskless, "diskless host flag");
  environmentFacts(facts.environment);
  if (facts.platform !== "posix" && facts.platform !== "win32")
    throw new TypeError("Explicit native path platform is required");
  if (!canAdoptNativeSessionId(facts.sessionId, facts.sessionIdAdmission))
    throw new TypeError("Native storage requires an admitted session ID");
  const paths = facts.platform === "win32" ? win32 : posix,
    configDirectory = (
      facts.environment.CLAUDE_CONFIG_DIR ?? facts.configDirectory
    ).normalize("NFC"),
    projectsDirectory = paths.join(configDirectory, "projects"),
    originalCwd = facts.originalCwd?.normalize("NFC") ?? null,
    effectiveProjectOverride =
      facts.environment.CLAUDE_CONFIG_DIR || facts.diskless
        ? validateNativeProjectDirectoryOverride(
            facts.environment.CLAUDE_CODE_PROJECT_DIR_NAME,
          )
        : undefined;
  let projectDirectory: string,
    projectKey: string | null,
    selection: NativeStoragePaths["selection"];
  if (facts.adoptedSessionDirectory != null) {
    projectDirectory = facts.adoptedSessionDirectory;
    projectKey = null;
    selection = "adopted";
  } else {
    if (effectiveProjectOverride !== undefined)
      projectKey = effectiveProjectOverride;
    else {
      if (originalCwd === null)
        throw new TypeError("Native project context is unavailable");
      projectKey = encodeNativeProjectDirectoryName(originalCwd);
    }
    projectDirectory = paths.join(projectsDirectory, projectKey);
    selection =
      effectiveProjectOverride === undefined ? "original-cwd" : "project-name";
  }
  const transcriptPath = paths.join(
    projectDirectory,
    `${facts.sessionId}.jsonl`,
  );
  return Object.freeze({
    configDirectory,
    projectsDirectory,
    projectDirectory,
    projectKey,
    transcriptPath,
    originalCwd,
    effectiveProjectOverride,
    selection,
    absolute: paths.isAbsolute(transcriptPath),
  });
}

export interface NativeLaunchEnvelope {
  readonly sessionId: string;
  readonly version: typeof NATIVE_STORAGE_COMPATIBILITY_VERSION;
  readonly userType: "external";
  readonly cwd?: string;
  readonly entrypoint?: string;
  readonly sessionKind?: NativeStorageSessionKind;
}

/** Source lHo/Ca/dHo/qQe/vY, for fresh ordinary rows, not imported versions. */
export function composeNativeLaunchEnvelope(facts: {
  sessionId: string;
  sessionIdAdmission: NativeSessionIdAdmission;
  currentCwd: string | null;
  environment: Readonly<NativeStorageEnvironment>;
}): Readonly<NativeLaunchEnvelope> {
  environmentFacts(facts.environment);
  if (!canAdoptNativeSessionId(facts.sessionId, facts.sessionIdAdmission))
    throw new TypeError("Native envelope requires an admitted session ID");
  if (facts.currentCwd !== null) stringFact(facts.currentCwd, "current cwd");
  const entrypoint = facts.environment.CLAUDE_CODE_ENTRYPOINT,
    kind = facts.environment.CLAUDE_CODE_SESSION_KIND;
  return Object.freeze({
    sessionId: facts.sessionId,
    version: NATIVE_STORAGE_COMPATIBILITY_VERSION,
    userType: "external",
    ...(facts.currentCwd === null
      ? {}
      : { cwd: facts.currentCwd.normalize("NFC") }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(kind === "bg" || kind === "daemon" || kind === "daemon-worker"
      ? { sessionKind: kind }
      : {}),
  });
}

export interface NativePersistenceLaunchFacts {
  sessionPersistenceDisabled: boolean;
  interactive: boolean;
  /** Effective native ou(): in-process agent or dynamic team context. */
  inProcessContext: boolean;
  ambientChildMarkerInTmux: boolean;
  sealedForShutdown: boolean;
}

export type NativePersistenceDisabledReason =
  "explicit_disable" | "skip_prompt_history" | "nested_marker";

/** Pinned production C$r/xMt/shouldSkipPersistence; never probes tmux or env. */
export function resolveNativePersistenceAdmission(
  facts: NativePersistenceLaunchFacts,
  environment: Readonly<NativeStorageEnvironment>,
): Readonly<{
  disabledReason: NativePersistenceDisabledReason | null;
  skipPersistence: boolean;
}> {
  environmentFacts(environment);
  for (const [name, value] of Object.entries(facts)) booleanFact(value, name);
  for (const name of [
    "sessionPersistenceDisabled",
    "interactive",
    "inProcessContext",
    "ambientChildMarkerInTmux",
    "sealedForShutdown",
  ] as const)
    booleanFact(facts[name], name);
  let disabledReason: NativePersistenceDisabledReason | null = null;
  if (facts.sessionPersistenceDisabled) disabledReason = "explicit_disable";
  else if (environment.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
    disabledReason = "skip_prompt_history";
  else if (
    !environment.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE &&
    environment.CLAUDE_CODE_CHILD_SESSION &&
    facts.interactive &&
    !facts.inProcessContext &&
    !facts.ambientChildMarkerInTmux
  )
    disabledReason = "nested_marker";
  return Object.freeze({
    disabledReason,
    skipPersistence: disabledReason !== null || facts.sealedForShutdown,
  });
}

/** Caller still owns directory admission, locking, persistence and lifecycle. */
export function composeNativeStorageLaunch(
  facts: NativeStoragePathFacts & {
    currentCwd: string | null;
    lifecycle: NativePersistenceLaunchFacts;
  },
): Readonly<{
  paths: Readonly<NativeStoragePaths>;
  envelope: Readonly<NativeLaunchEnvelope>;
  persistence: ReturnType<typeof resolveNativePersistenceAdmission>;
}> {
  return Object.freeze({
    paths: resolveNativeStoragePaths(facts),
    envelope: composeNativeLaunchEnvelope(facts),
    persistence: resolveNativePersistenceAdmission(
      facts.lifecycle,
      facts.environment,
    ),
  });
}

/** Narrow ordinary writer adapter; does not confer path or lock ownership. */
export function nativeMainWriterContext(
  envelope: Readonly<NativeLaunchEnvelope>,
): Readonly<NativeWriterContext> {
  if (envelope.cwd === undefined)
    throw new TypeError("The ordinary native writer requires an actual cwd");
  return Object.freeze({
    sessionId: envelope.sessionId,
    cwd: envelope.cwd,
    version: envelope.version,
    userType: envelope.userType,
    ...(envelope.entrypoint === undefined
      ? {}
      : { entrypoint: envelope.entrypoint }),
    ...(envelope.sessionKind === undefined
      ? {}
      : { sessionKind: envelope.sessionKind }),
    sidechain: false,
  });
}
