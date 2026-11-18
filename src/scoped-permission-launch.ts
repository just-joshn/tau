import { posix } from "node:path";
import {
  createFilePermissionSession,
  type FilePermissionPolicyRule,
} from "./file-permission-session.js";
import { createBashPermissionSession } from "./bash-permission-session.js";
import { createNativeVerifiedPosixAliasResolver } from "./native-file-permission-host.js";
import { createOrdinaryNativeRelativePermissionRoots } from "./native-relative-permission-roots.js";
import { parseNativePermissionRule } from "./native-permission-rules.js";
import { parseNativeTriBoolean } from "./native-context-classifiers.js";
import type { LaunchConfiguration } from "./launch-configuration.js";
import type { PolicyRuleMatch, ToolPolicy } from "./tool-policy.js";
import type { PermissionMode } from "./types.js";

interface PermissionScope {
  policy(): ToolPolicy;
  mode(): PermissionMode;
}
const order = [
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
function rules(policy: ToolPolicy): FilePermissionPolicyRule[] {
  const result: FilePermissionPolicyRule[] = [];
  for (const [behavior, values] of [
    ["allow", policy.allowedTools],
    ["deny", policy.disallowedTools],
    ["ask", policy.askedTools ?? []],
  ] as const)
    for (const rule of values)
      result.push({ rule, behavior, source: "cliArg", origin: "direct" });
  for (const rule of policy.sourcedRules ?? [])
    result.push({
      rule: rule.rule,
      source: rule.source,
      behavior: rule.behavior,
      ...(rule.path === undefined ? {} : { path: rule.path }),
      origin: "sourced",
    });
  return result.sort(
    (a, b) => order.indexOf(a.source) - order.indexOf(b.source),
  );
}
export type ScopedPermissionAccess = ReturnType<
  ReturnType<typeof createLaunchScopedPermissionHost>["scope"]
>;
function inside(root: string, target: string): boolean {
  const relative = posix.relative(
    root.normalize("NFC"),
    target.normalize("NFC"),
  );
  return (
    relative !== ".." &&
    !relative.startsWith("../") &&
    !posix.isAbsolute(relative)
  );
}

/** Ordinary local owner: root and child scopes share the session's physical-path history. */
export function createLaunchScopedPermissionHost(options: {
  cwd: string;
  launch: LaunchConfiguration;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  let active: PermissionScope | undefined;
  function context(): PermissionScope {
    if (!active)
      throw new Error(
        "Scoped permission evaluation requires its owning tool context",
      );
    return active;
  }
  const profile = () => ({
    kind: "ordinary-local-posix" as const,
    mode: context().mode(),
    restricted: false,
    servedCall: false,
  });
  const admitRule = (rule: FilePermissionPolicyRule) => {
    if (!order.includes(rule.source))
      return {
        status: "unsupported" as const,
        reason: `Unknown permission source: ${rule.source}`,
      };
    if (rule.behavior !== "allow") return { status: "admit" as const };
    if (
      process.platform === "win32" ||
      parseNativeTriBoolean(env.CLAUDE_CODE_REMOTE) === true ||
      parseNativeTriBoolean(env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE) === true ||
      parseNativeTriBoolean(env.CLAUDE_CODE_TETHER_LIVE) === true
    )
      return {
        status: "unsupported" as const,
        reason:
          "Scoped grants require their native platform/remote/Code Mode host",
      };
    const mode = context().mode();
    if (mode === "plan")
      return {
        status: "exclude" as const,
        reason:
          "The local Plan host withholds ordinary scoped grants; designated-plan and memory stages remain separate",
      };
    if (
      mode !== "default" &&
      mode !== "acceptEdits" &&
      mode !== "bypassPermissions"
    )
      return {
        status: "unsupported" as const,
        reason: "Scoped grants require their native permission-mode host",
      };
    if (
      parseNativeTriBoolean(env.CLAUDE_CODE_EVAL_CONFINED) === true &&
      rule.source !== "cliArg"
    )
      return {
        status: "exclude" as const,
        reason: "Confined grants are admitted only from CLI rules",
      };
    return { status: "admit" as const };
  };
  const relativeRoots = createOrdinaryNativeRelativePermissionRoots({
    launchCwd: options.cwd,
    cwd: () => options.cwd,
    home: options.launch.importHome,
    evalConfined: parseNativeTriBoolean(env.CLAUDE_CODE_EVAL_CONFINED) === true,
    // This host exposes no native cwd/root/worktree transition or additional dirs.
    // Ot initializes all ordinary project anchors from canonical launch cwd;
    // configuration Git/consent roots are independent of these session anchors.
    admitOrdinaryLaunch: () =>
      process.platform !== "win32" &&
      parseNativeTriBoolean(env.CLAUDE_CODE_REMOTE) !== true &&
      parseNativeTriBoolean(env.CLAUDE_CODE_TETHER_LIVE) !== true &&
      parseNativeTriBoolean(env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE) !== true,
    // With no added/changed roots, either native read-fence state resolves to
    // the same initial launch anchor. The port's own path fence remains earlier.
    blockFileToolReadsOutsideWorkingDirectories: () => false,
  });
  const file = createFilePermissionSession({
    launch: options.launch,
    launchRoot: options.cwd,
    cwd: () => options.cwd,
    policy: () => context().policy(),
    profile,
    admitRule,
    relativeRoots: {
      kind: "host",
      resolve: (target, behavior) => relativeRoots.resolve(target, behavior),
    },
    physicalTwinsEnabled: process.platform !== "win32",
    fixedRootsBeforeRelative: false,
    trustedAlias: createNativeVerifiedPosixAliasResolver(),
  });
  const bash = createBashPermissionSession({
    policy: () => context().policy(),
    profile,
    admitRule,
  });
  function within<T>(scope: PermissionScope, run: () => T): T {
    const previous = active;
    active = scope;
    try {
      return run();
    } finally {
      active = previous;
    }
  }
  return {
    invalidate: () => file.invalidate(),
    scope(scope: PermissionScope) {
      return {
        filePermissionCandidates(request: Parameters<typeof file.evaluate>[0]) {
          return within(scope, () => {
            const current = rules(scope.policy());
            const applicable = current.filter((rule) => {
              const parsed = parseNativePermissionRule(rule.rule);
              return (
                parsed.kind !== "malformed" &&
                ["Read", "Edit", "Write"].includes(parsed.toolName) &&
                rule.rule.includes("(")
              );
            });
            if (!applicable.length) return;
            const result = file.evaluate(request);
            let compatibilityAllow: PolicyRuleMatch | undefined;
            // Ng's default compatibility wildcard is not an unrestricted bare
            // grant. iA's OLa considers the actual tool only, inside its directory.
            if (
              inside(options.cwd, request.requestedPath) &&
              inside(options.cwd, request.canonicalPath)
            )
              for (const rule of applicable) {
                if (rule.behavior !== "allow") continue;
                const parsed = parseNativePermissionRule(rule.rule);
                if (
                  parsed.kind !== "bare" ||
                  parsed.toolName !== request.operation
                )
                  continue;
                if (admitRule(rule).status !== "admit") continue;
                compatibilityAllow = {
                  rule: rule.rule,
                  source: rule.source,
                  ...(rule.path === undefined ? {} : { path: rule.path }),
                };
                break;
              }
            return {
              ...result,
              ...(compatibilityAllow === undefined
                ? {}
                : { compatibilityAllow }),
            };
          });
        },
        bashPermissionCandidates(request: Parameters<typeof bash.evaluate>[0]) {
          return within(scope, () => {
            if (
              !rules(scope.policy()).some((rule) => {
                const parsed = parseNativePermissionRule(rule.rule);
                return (
                  parsed.kind === "call" &&
                  parsed.toolName === "Bash" &&
                  rule.rule.includes("(")
                );
              })
            )
              return;
            return bash.evaluate(request);
          });
        },
      };
    },
  };
}
