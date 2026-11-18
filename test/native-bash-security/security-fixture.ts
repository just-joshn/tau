import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import { createNativeBashSemantics } from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";
import { createNativeBashSecurityFileGate } from "../../src/native-bash-security/file-gate.js";
import {
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityFileHost as Host,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityRule as Rule,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityInspection as Inspection,
} from "../../src/native-bash-security/security-types.js";
export const scope: Scope = { policyId: "fixture-policy", cwd: "/work" };
export function known<T>(value: T, request: Scope = scope): Fact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "virtual-source-model",
      sourceContracts: ["native D1/pie unit facts"],
      scope: request,
    },
  };
}
export function policy(options: Partial<Policy> = {}): Policy {
  return {
    scope,
    mode: "default",
    restricted: false,
    alwaysDenyRules: {},
    alwaysAskRules: {},
    alwaysAllowRules: {},
    additionalWorkingDirectories: new Map(),
    ...options,
  };
}
export const rule: Rule = {
  source: "projectSettings",
  ruleBehavior: "deny",
  ruleValue: { toolName: "Read", ruleContent: "/denied" },
};
function inspect(path: string): Inspection {
  return {
    requested: path,
    landing: path,
    spellings: [path],
    unresolved: false,
    leafIsSymlink: false,
  };
}
export function fixture(
  options: {
    deny?: string;
    writeDeny?: string;
    outsideBlocked?: boolean;
    protectedWrite?: Decision;
    sensitive?: boolean;
    sandbox?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const receipts: Provenance[] = [];
  const semantic = createNativeBashSemantics(
    createNativeBashParser({ now: () => 0 }),
    createNativeBashPreparationFeatures(),
    createNativeBashSemanticFeatures({
      environment: {},
      cpuNow: () => 0,
      home: () => "/home/test",
    }).host,
  );
  const host: Host = {
    platform: "macos",
    filesystem: {
      inspect(path, s) {
        calls.push(`inspect:${path}`);
        return known(inspect(path), s);
      },
      canonical(path, s) {
        calls.push(`canonical:${path}`);
        return known(
          { resolvedPath: path, isCanonical: true, isSymlink: false },
          s,
        );
      },
      spellings(path, s) {
        return known([path], s);
      },
      canonicalInspection(path, s) {
        return known(inspect(path), s);
      },
      exists(_path, s) {
        return known(true, s);
      },
    },
    filePolicy: {
      matchRule(path, _policy, family, behavior, s) {
        calls.push(`rule:${family}:${behavior}:${path}`);
        return known(
          behavior === "deny" &&
            (family === "read"
              ? path === options.deny
              : path === options.writeDeny)
            ? rule
            : null,
          s,
        );
      },
      protectedWrite(_path, _spellings, _policy, s) {
        calls.push("protected-write");
        return known(
          options.protectedWrite ?? { behavior: "passthrough", message: "" },
          s,
        );
      },
      protectedRead(_path, _spellings, _policy, _options, s) {
        calls.push("protected-read");
        return known({ behavior: "passthrough", message: "" }, s);
      },
      sensitiveWrite(_path, _spellings, _policy, _options, s) {
        calls.push("sensitive-write");
        return known(
          options.sensitive
            ? {
                safe: false,
                message: "sensitive path",
                classifierApprovable: true,
              }
            : { safe: true },
          s,
        );
      },
      symlinkNote(_inspection, _policy, s) {
        return known(null, s);
      },
      writeNote(_path, _inspection, _policy, s) {
        return known(null, s);
      },
      pathWriteProtected(_path, _policy, s) {
        return known(false, s);
      },
      inWorkingDirectories(path, _spellings, _policy, s) {
        calls.push(`working:${path}`);
        return known(path === "/work" || path.startsWith("/work/"), s);
      },
      outsideReadBlocked(path, _spellings, _policy, s) {
        calls.push(`read-fence:${path}`);
        return known(
          options.outsideBlocked === true && !path.startsWith("/work/"),
          s,
        );
      },
      modelReadMode(_policy, s) {
        return known(false, s);
      },
      trustedAlias(path, s) {
        return known(path, s);
      },
      sandboxContains(path, root, _options, s) {
        return known(path === root || path.startsWith(root + "/"), s);
      },
    },
    sandbox(_policy, s) {
      return known(
        {
          enabled: options.sandbox === true,
          onButNotRunning: false,
          storedDenyListsMayBeShort: false,
          allowOnly: ["/outside"],
          denyWithinAllow: [],
          autoAllowSupported: false,
          autoAllowBashIfSandboxed: false,
          unsandboxedCommandsAllowed: false,
          unsandboxedCommandsDisabled: false,
        },
        s,
      );
    },
    servedMachine(_policy, s) {
      return known(false, s);
    },
    earlierSessionIds(_policy, s) {
      return known([], s);
    },
    home(s) {
      return known("/home/test", s);
    },
    formatPath(path, s) {
      return known(path, s);
    },
  };
  return {
    gate: createNativeBashSecurityFileGate(semantic, host, receipts),
    host,
    semantic,
    calls,
    receipts,
  };
}
