import { posix } from "node:path";
import type { LaunchConfiguration } from "./launch-configuration.js";
import type { ToolPolicy } from "./tool-policy.js";
import {
  createNativeFilePermissionHost,
  type NativeFilePermissionHostOptions,
  type NativeFilePermissionRoots,
  type NativePosixPathInspection,
} from "./native-file-permission-host.js";
import {
  parseNativePermissionRule,
  type NativeFileRule,
  type NativeRuleBehavior,
} from "./native-permission-rules.js";

export interface FilePermissionPolicyRule {
  rule: string;
  source: string;
  behavior: NativeRuleBehavior;
  path?: string;
  origin: "direct" | "sourced";
}
export type FileRuleAdmission =
  | { status: "admit" }
  | { status: "exclude"; reason: string }
  | { status: "unsupported"; reason: string };
export interface FilePermissionSessionProfile {
  kind: "ordinary-local-posix";
  mode: string;
  restricted: boolean;
  servedCall: boolean;
}
export interface FilePermissionRuleCandidate extends FilePermissionPolicyRule {
  family: "Read" | "Edit";
  diagnostics: readonly string[];
}
export interface FilePermissionCandidates {
  deny?: FilePermissionRuleCandidate;
  ask?: FilePermissionRuleCandidate;
  allow?: FilePermissionRuleCandidate;
}
export interface FilePermissionSessionResult extends FilePermissionCandidates {
  status: "classified" | "unsupported";
  /** These write-family holds constrain iA's implication; they do not deny/ask a Read. */
  editImplication?: FilePermissionCandidates;
  inspection: NativePosixPathInspection;
  canonicalPath: string;
  generation: number;
  diagnostics: readonly string[];
  unsupported: readonly string[];
}
const sourceOrder = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
  "mcpMount",
  "toolsNarrowing",
  "mcpServerPolicy",
  "hostCredential",
];

/** AEi resolves settings-context roots, not consent-store or document parent roots. */
export function filePermissionRootsFromLaunch(
  launch: LaunchConfiguration,
  launchRoot: string,
): NativeFilePermissionRoots {
  const flagDocuments = launch.snapshot.documents.filter(
    (document) =>
      document.source === "flagSettings" && document.status === "loaded",
  );
  const flagPaths = new Set(flagDocuments.map((document) => document.path));
  if (flagPaths.size > 1)
    throw new Error(
      "Multiple flag-settings contexts require an explicit native source-root adapter",
    );
  const path = flagDocuments[0]?.path;
  return {
    launchRoot,
    settingsContextCwd: launch.snapshot.roots.cwd,
    userConfigDir: launch.userConfigDir,
    flagSettings:
      path !== undefined
        ? { kind: "file", path }
        : { kind: flagDocuments.length ? "inline" : "absent" },
  };
}

interface CompiledRuleSet {
  fingerprint: string;
  generation: number;
  rules: Record<NativeRuleBehavior, readonly NativeFileRule[]>;
  metadata: Map<NativeFileRule, FilePermissionPolicyRule>;
}
/** Matching candidates only. The caller retains full native permission ordering and final I/O checks. */
export function createFilePermissionSession(options: {
  launch: LaunchConfiguration | (() => LaunchConfiguration);
  launchRoot: string;
  cwd: () => string;
  /** The live, source-aware policy already includes admitted launch permissionRules. */
  policy: () => ToolPolicy;
  profile: () => FilePermissionSessionProfile;
  /** Required H/Bct mode/provenance admission; never default unknown grants to admitted. */
  admitRule: (
    rule: FilePermissionPolicyRule,
    profile: FilePermissionSessionProfile,
  ) => FileRuleAdmission;
  relativeRoots: NativeFilePermissionHostOptions["relativeRoots"];
  physicalTwinsEnabled: boolean;
  fixedRootsBeforeRelative: boolean;
  trustedAlias: NativeFilePermissionHostOptions["trustedAlias"];
  filesystem?: NativeFilePermissionHostOptions["filesystem"];
  admitPath?: NativeFilePermissionHostOptions["admitPath"];
}) {
  const launch = () =>
    typeof options.launch === "function" ? options.launch() : options.launch;
  const roots = () =>
    filePermissionRootsFromLaunch(launch(), options.launchRoot);
  const host = createNativeFilePermissionHost({
    cwd: options.cwd,
    home: launch().importHome,
    roots,
    relativeRoots: options.relativeRoots,
    physicalTwinsEnabled: options.physicalTwinsEnabled,
    fixedRootsBeforeRelative: options.fixedRootsBeforeRelative,
    trustedAlias: options.trustedAlias,
    ...(options.filesystem === undefined
      ? {}
      : { filesystem: options.filesystem }),
    ...(options.admitPath === undefined
      ? {}
      : { admitPath: options.admitPath }),
  });
  let compiled: CompiledRuleSet | undefined;
  let generation = 0;
  function collect(
    profile: FilePermissionSessionProfile,
    diagnostics: string[],
    unsupported: string[],
  ): CompiledRuleSet {
    const policy = options.policy();
    const raw: FilePermissionPolicyRule[] = [];
    for (const behavior of ["deny", "ask", "allow"])
      for (const rule of behavior === "deny"
        ? policy.disallowedTools
        : behavior === "ask"
          ? (policy.askedTools ?? [])
          : policy.allowedTools)
        raw.push({
          rule,
          source: "cliArg",
          behavior:
            behavior === "deny" ? "deny" : behavior === "ask" ? "ask" : "allow",
          origin: "direct",
        });
    for (const rule of policy.sourcedRules ?? [])
      raw.push({
        rule: rule.rule,
        source: rule.source,
        behavior: rule.behavior,
        ...(rule.path === undefined ? {} : { path: rule.path }),
        origin: "sourced",
      });
    raw.sort(
      (left, right) =>
        sourceOrder.indexOf(left.source) - sourceOrder.indexOf(right.source),
    );
    const admitted: FilePermissionPolicyRule[] = [];
    for (const rule of raw) {
      const parsed = parseNativePermissionRule(rule.rule);
      if (parsed.kind === "malformed") {
        if (/^(Read|Write|Edit)\(/.test(rule.rule))
          diagnostics.push(
            `Malformed file rule uses native literal-name fallback: ${rule.rule}`,
          );
        continue;
      }
      if (parsed.kind !== "call") continue;
      if (parsed.toolName === "Write") {
        diagnostics.push(
          `Write path rule is not the native Edit family: ${rule.rule}`,
        );
        continue;
      }
      if (parsed.toolName !== "Read" && parsed.toolName !== "Edit") continue;
      if (!sourceOrder.includes(rule.source)) {
        unsupported.push(`Unknown file-rule provenance: ${rule.source}`);
        continue;
      }
      const decision = options.admitRule(rule, profile);
      if (decision.status === "unsupported") {
        unsupported.push(decision.reason);
        continue;
      }
      if (decision.status === "exclude") {
        if (rule.behavior !== "allow")
          unsupported.push(
            `A restrictive file rule cannot be silently excluded: ${decision.reason}`,
          );
        else
          diagnostics.push(`File grant excluded by host: ${decision.reason}`);
        continue;
      }
      admitted.push(rule);
    }
    const fingerprint = JSON.stringify({
      admitted,
      roots: roots(),
      profile,
      cwd: options.cwd(),
    });
    if (compiled?.fingerprint === fingerprint) return compiled;
    const rules: Record<NativeRuleBehavior, NativeFileRule[]> = {
      deny: [],
      ask: [],
      allow: [],
    };
    const metadata = new Map<NativeFileRule, FilePermissionPolicyRule>();
    for (const rule of admitted) {
      const native = {
        rule: parseNativePermissionRule(rule.rule),
        source: rule.source,
      };
      rules[rule.behavior].push(native);
      metadata.set(native, rule);
    }
    compiled = { fingerprint, generation: ++generation, rules, metadata };
    return compiled;
  }
  return {
    /** Explicit recompilation refresh retains session-owned historical physical twins. */
    invalidate() {
      compiled = undefined;
    },
    evaluate(request: {
      operation: "Read" | "Write" | "Edit";
      /** Effective post-hook path, not committed model input or the earlier validation path. */
      requestedPath: string;
      /** Actual file tool's independently checked canonical path. */
      canonicalPath: string;
      signal: AbortSignal;
    }): FilePermissionSessionResult {
      request.signal.throwIfAborted();
      const diagnostics: string[] = [],
        unsupported: string[] = [];
      const inspection = host.inspectPath(request.requestedPath);
      const profile = options.profile();
      if (
        profile.kind !== "ordinary-local-posix" ||
        typeof profile.mode !== "string" ||
        typeof profile.restricted !== "boolean" ||
        typeof profile.servedCall !== "boolean"
      )
        unsupported.push(
          "An explicit ordinary local POSIX permission profile is required",
        );
      const physical = inspection.spellings.at(-1);
      if (
        !posix.isAbsolute(request.canonicalPath) ||
        request.canonicalPath.includes("\0") ||
        (inspection.status === "resolved" &&
          physical !== posix.resolve(request.canonicalPath).normalize("NFC"))
      )
        unsupported.push(
          "File permission inspection disagrees with the tool's canonical identity",
        );
      let set: CompiledRuleSet | undefined;
      try {
        set = collect(profile, diagnostics, unsupported);
      } catch (error) {
        unsupported.push(
          error instanceof Error ? error.message : String(error),
        );
      }
      const match = (
        family: "Read" | "Edit",
        behavior: NativeRuleBehavior,
      ): FilePermissionRuleCandidate | undefined => {
        if (set === undefined) return;
        const result = host.match({
          path: request.requestedPath,
          toolName: family,
          behavior,
          rules: set.rules[behavior],
          compilationKey: set,
        });
        diagnostics.push(...result.diagnostics);
        if (result.status === "unsupported") {
          unsupported.push(`${family} ${behavior}: ${result.reason}`);
          return;
        }
        if (result.status !== "matched") return;
        const metadata = set.metadata.get(result.rule);
        if (metadata === undefined) {
          unsupported.push("Native matcher returned unknown rule provenance");
          return;
        }
        return { ...metadata, family, diagnostics: result.diagnostics };
      };
      const candidates = (
        family: "Read" | "Edit",
      ): FilePermissionCandidates => {
        const deny = match(family, "deny"),
          ask = match(family, "ask"),
          allow = match(family, "allow");
        return {
          ...(deny === undefined ? {} : { deny }),
          ...(ask === undefined ? {} : { ask }),
          ...(allow === undefined ? {} : { allow }),
        };
      };
      const primary = candidates(
        request.operation === "Read" ? "Read" : "Edit",
      );
      const editImplication =
        request.operation === "Read" ? candidates("Edit") : undefined;
      request.signal.throwIfAborted();
      return {
        ...primary,
        ...(editImplication === undefined ? {} : { editImplication }),
        status: unsupported.length ? "unsupported" : "classified",
        inspection,
        canonicalPath: request.canonicalPath,
        generation: set?.generation ?? generation,
        diagnostics: [...new Set(diagnostics)],
        unsupported: [...new Set(unsupported)],
      };
    },
  };
}
