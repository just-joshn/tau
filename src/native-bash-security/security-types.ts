import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionScope,
  type NativePermissionProvenance,
  type NativePermissionFact,
  type NativePermissionRule,
  type NativePermissionReason,
  type NativePermissionSuggestion,
  type NativePermissionOutcome,
} from "../native-permission-outcome.js";
export type NativeBashSecurityScope = NativePermissionScope;
export type NativeBashSecurityProvenance = NativePermissionProvenance;
export type NativeBashSecurityFact<T> = NativePermissionFact<T>;
export interface NativeBashSecurityInput {
  command: string;
  shellType?: "bash" | "powershell";
  dangerouslyDisableSandbox?: boolean;
  run_in_background?: boolean;
  description?: string;
  timeout?: number;
  allowed_domains?: unknown;
}
export type NativeBashSecurityRule = NativePermissionRule & {
  ruleBehavior: "allow" | "ask" | "deny";
};
export type NativeBashSecurityReason =
  NativePermissionReason<NativeBashSecurityInput>;
export type NativeBashSecuritySuggestion = NativePermissionSuggestion;
export type NativeBashSecurityDecision =
  NativePermissionOutcome<NativeBashSecurityInput>;
export interface NativeBashSecurityPolicy {
  scope: NativeBashSecurityScope;
  mode: string;
  modeBeforeRewrite?: string;
  prePlanMode?: string;
  strippedDangerousRules?: boolean;
  restricted: boolean;
  servedCall?: boolean;
  isBypassPermissionsModeAvailable?: boolean;
  sandboxAutoAllowSuspended?: boolean;
  isRemoteMode?: boolean;
  shouldAvoidPermissionPrompts?: boolean;
  blockReadsOutsideWorkingDirectories?: boolean;
  blockFileToolReadsOutsideWorkingDirectories?: boolean;
  blockWritesOutsideWorkingDirectories?: boolean;
  alwaysDenyRules: Readonly<Record<string, readonly string[] | undefined>>;
  alwaysAskRules: Readonly<Record<string, readonly string[] | undefined>>;
  alwaysAllowRules: Readonly<Record<string, readonly string[] | undefined>>;
  additionalWorkingDirectories: ReadonlyMap<string, unknown>;
  trustedNetworkDirectories?: readonly string[];
  bashCommandClamps?: readonly (readonly string[])[];
}
export type NativeBashSecurityInspection = {
  requested: string;
  spellings: readonly string[];
  leafIsSymlink: boolean;
  endsUnexamined?: boolean;
  linkTextClimbs?: boolean;
} & (
  | { unresolved: false; landing: string }
  | {
      unresolved: true;
      stoppedAt: string;
      reason: "past-a-link" | "unexamined";
    }
);
export interface NativeBashSecurityCanonicalPath {
  resolvedPath: string;
  isCanonical: boolean;
  isSymlink: boolean;
}
export interface NativeBashSecurityLinkNote {
  landing: string;
  landingOutside: boolean;
  spellingInside: boolean;
  carriedOut: boolean;
}
export interface NativeBashSecuritySentence {
  sentence: string;
  personOnly: boolean;
}
export interface NativeBashSecurityFileVerdict {
  allowed: boolean;
  resolvedPath?: string;
  decisionReason?: NativeBashSecurityReason | undefined;
  isInWorkingDir?: boolean;
  refusedByDefault?: boolean;
}
export interface NativeBashSecurityResolvedFileVerdict extends NativeBashSecurityFileVerdict {
  resolvedPath: string;
}
export type NativeBashSecurityFileOperation = "read" | "write" | "create";
export type NativeBashSecuritySensitivePath =
  | {
      safe: true;
      message?: never;
      classifierApprovable?: never;
      circuitBreaker?: never;
      also?: never;
    }
  | {
      safe: false;
      message: string;
      classifierApprovable: boolean;
      circuitBreaker?: string;
      also?: string[];
    };
export interface NativeBashSecuritySandboxFacts {
  enabled: boolean;
  onButNotRunning: boolean;
  storedDenyListsMayBeShort: boolean;
  allowOnly: readonly string[];
  denyWithinAllow: readonly string[];
  autoAllowSupported: boolean;
  autoAllowBashIfSandboxed: boolean;
  unsandboxedCommandsAllowed: boolean;
  unsandboxedCommandsDisabled: boolean;
}
export interface NativeBashSecurityFilesystemHost {
  inspect?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityInspection>;
  canonical?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityCanonicalPath>;
  spellings?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<readonly string[]>;
  canonicalInspection?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityInspection>;
  realpathSpelling?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<string | undefined>;
  lstat?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<
    | { status: "stat"; isSymbolicLink: boolean; isDirectory: boolean }
    | { status: "error"; error: unknown }
  >;
  exists?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
}
export interface NativeBashSecurityFilePolicyHost {
  matchRule?: (
    path: string,
    policy: NativeBashSecurityPolicy,
    family: "read" | "edit",
    behavior: "allow" | "ask" | "deny",
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityRule | null>;
  protectedWrite?: (
    path: string,
    spellings: readonly string[],
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityDecision>;
  protectedRead?: (
    path: string,
    spellings: readonly string[],
    policy: NativeBashSecurityPolicy,
    options: {
      restricted: boolean;
      transcriptsJudged?: boolean;
      forTheModelHere?: boolean;
      blockOutsideReads?: boolean;
      readBlockFence?: boolean;
    },
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityDecision>;
  internalAllowApplies?: (
    decision: NativeBashSecurityDecision,
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
  sensitiveWrite?: (
    path: string,
    spellings: readonly string[],
    policy: NativeBashSecurityPolicy,
    options: {
      remote: boolean;
      trustedNetworkDirectories: readonly string[] | undefined;
    },
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecuritySensitivePath>;
  symlinkNote?: (
    inspection: NativeBashSecurityInspection,
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecurityLinkNote | null>;
  writeNote?: (
    path: string,
    inspection: NativeBashSecurityInspection,
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecuritySentence | null>;
  pathWriteProtected?: (
    path: string,
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
  inWorkingDirectories?: (
    path: string,
    spellings: readonly string[],
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
  outsideReadBlocked?: (
    path: string,
    spellings: readonly string[],
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
  modelReadMode?: (
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
  trustedAlias?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<string>;
  sandboxContains?: (
    path: string,
    root: string,
    options: {
      caseFold?: boolean;
      uncShapeParity?: boolean;
      skipPrivateAlias?: boolean;
    },
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
}
export interface NativeBashSecurityFileHost {
  platform: "macos" | "linux" | "windows";
  filesystem: NativeBashSecurityFilesystemHost;
  filePolicy: NativeBashSecurityFilePolicyHost;
  sandbox?: (
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<NativeBashSecuritySandboxFacts>;
  servedMachine?: (
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<boolean>;
  earlierSessionIds?: (
    policy: NativeBashSecurityPolicy,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<readonly string[]>;
  home?: (scope: NativeBashSecurityScope) => NativeBashSecurityFact<string>;
  resolveConfigPath?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<readonly string[]>;
  networkHostShape?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<
    | "own_host"
    | "numeric_host"
    | "odd_host"
    | "wsl_host"
    | "short_name"
    | "device_namespace"
    | "drive_relative"
    | "webdav_host"
    | undefined
  >;
  pathPrimitive?: (
    primitive: "Vdo" | "o7n" | "r7n" | "Y4e" | "y4" | "Do",
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<string>;
  windowsPathAliases?: (
    home: string,
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<string[][]>;
  formatPath?: (
    path: string,
    scope: NativeBashSecurityScope,
  ) => NativeBashSecurityFact<string>;
  firstGlobOffset?: (path: string) => number;
}
export type NativeBashSecurityResult =
  | {
      status: "classified";
      decision: NativeBashSecurityDecision;
      facts: readonly NativeBashSecurityProvenance[];
    }
  | {
      status: "unsupported";
      dependency: string;
      reason: string;
      facts: readonly NativeBashSecurityProvenance[];
    };
export { NativePermissionDependencyError as NativeBashSecurityUnsupported };
export const readNativeBashSecurityFact = readNativePermissionFact;
export function needNativeBashSecurityCapability<T>(
  value: T | undefined,
  name: string,
): T {
  if (value === undefined)
    throw new NativePermissionDependencyError(
      name,
      "Required host capability is unavailable",
    );
  return value;
}
