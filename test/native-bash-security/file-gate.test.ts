import assert from "node:assert/strict";
import { test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import { createNativeBashSemantics } from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";
import { createNativeBashSecurityFileGate } from "../../src/native-bash-security/file-gate.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityFileHost as Host,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityRule as Rule,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityInspection as Inspection,
} from "../../src/native-bash-security/security-types.js";
const scope: Scope = { policyId: "fixture-policy", cwd: "/work" };
function known<T>(value: T, request: Scope = scope): Fact<T> {
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
function policy(options: Partial<Policy> = {}): Policy {
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
const rule: Rule = {
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
function fixture(
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

test("Read denial precedes read-block and working-directory positive facts", () => {
  const f = fixture({ deny: "/work/denied", outsideBlocked: true });
  const r = f.gate.check(
    "denied",
    "/work",
    policy({ blockReadsOutsideWorkingDirectories: true }),
    "read",
  );
  assert.equal(r.allowed, false);
  assert.equal(r.decisionReason?.type, "rule");
  assert.equal(r.resolvedPath, "/work/denied");
  assert.equal(
    f.calls.some((c) => c.startsWith("read-fence:")),
    false,
  );
  assert.equal(
    f.calls.some((c) => c.startsWith("working:")),
    false,
  );
});

test("known working-directory Read remains an actual sourced file-policy result", () => {
  const f = fixture();
  const r = f.gate.check("file", "/work", policy(), "read");
  assert.deepEqual(r, { allowed: true, resolvedPath: "/work/file" });
  assert.ok(f.receipts.length >= 4);
  assert.equal(f.calls.includes("protected-read"), false);
});

test("Edit denial remains before acceptEdits and before sandbox write allowances", () => {
  const f = fixture({ writeDeny: "/work/denied", sandbox: true });
  const r = f.gate.check(
    "denied",
    "/work",
    policy({ mode: "acceptEdits" }),
    "create",
  );
  assert.equal(r.allowed, false);
  assert.equal(r.decisionReason?.type, "rule");
  assert.equal(f.calls.includes("protected-write"), false);
  assert.equal(f.calls.includes("sensitive-write"), false);
});

test("default working-directory writes retain overrideable default refusal instead of becoming file grants", () => {
  const f = fixture();
  const r = f.gate.check("file", "/work", policy(), "write");
  assert.deepEqual(r, {
    allowed: false,
    isInWorkingDir: true,
    refusedByDefault: true,
    resolvedPath: "/work/file",
  });
  const accepted = f.gate.check(
    "file",
    "/work",
    policy({ mode: "acceptEdits" }),
    "write",
  );
  assert.equal(accepted.allowed, true);
});

test("read block holds an outside path before later protected-read/allow branches", () => {
  const f = fixture({ outsideBlocked: true });
  const r = f.gate.check(
    "/outside/file",
    "/work",
    policy({ blockReadsOutsideWorkingDirectories: true }),
    "read",
  );
  assert.equal(r.allowed, false);
  assert.equal(r.decisionReason?.type, "safetyCheck");
  if (r.decisionReason?.type === "safetyCheck")
    assert.equal(r.decisionReason.circuitBreaker, "outsideReadsBlocked");
  assert.equal(f.calls.includes("protected-read"), false);
});

test("internal deny and sensitive-write facts merge their full native circuit-breaker provenance", () => {
  const f = fixture({
    sensitive: true,
    protectedWrite: {
      behavior: "deny",
      message: "hard deny",
      decisionReason: {
        type: "safetyCheck",
        reason: "hard deny",
        classifierApprovable: false,
        circuitBreaker: "claudeSettingsFile",
      },
    },
  });
  const r = f.gate.check("file", "/work", policy(), "write");
  assert.equal(r.allowed, false);
  assert.equal(r.decisionReason?.type, "safetyCheck");
  if (r.decisionReason?.type === "safetyCheck") {
    assert.equal(r.decisionReason.reason, "hard deny");
    assert.equal(r.decisionReason.classifierApprovable, false);
    assert.equal(r.decisionReason.circuitBreaker, "claudeSettingsFile");
    assert.deepEqual(r.decisionReason.also, ["internalHardDeny"]);
  }
});

test("known complete sandbox write roots can allow outside writes only at their source position", () => {
  const f = fixture({ sandbox: true });
  const r = f.gate.check("/outside/file", "/work", policy(), "create");
  assert.equal(r.allowed, true);
  assert.deepEqual(r.decisionReason, {
    type: "other",
    reason: "Path is in sandbox write allowlist",
  });
  const denied = fixture({ sandbox: true, writeDeny: "/outside/file" });
  assert.equal(
    denied.gate.check("/outside/file", "/work", policy(), "write").allowed,
    false,
  );
});

test("missing and mismatched positive host capabilities become explicit unsupported errors", () => {
  const f = fixture();
  delete f.host.filePolicy.inWorkingDirectories;
  assert.throws(
    () => f.gate.check("file", "/work", policy(), "read"),
    (e) =>
      e instanceof NativeBashSecurityUnsupported &&
      e.dependency === "filePolicy.inWorkingDirectories",
  );
  const wrong = fixture();
  wrong.host.filePolicy.inWorkingDirectories = () =>
    known(true, { policyId: "another-policy", cwd: "/other" });
  assert.throws(
    () => wrong.gate.check("file", "/work", policy(), "read"),
    (e) =>
      e instanceof NativeBashSecurityUnsupported &&
      e.dependency === "host-scope",
  );
});

test("quoted argv spaces survive native D1 and every rule/filesystem callback", () => {
  const f = fixture();
  const r = f.gate.check(" spaced ", "/work", policy(), "read");
  assert.equal(r.resolvedPath, "/work/ spaced ");
  assert.ok(f.calls.includes("canonical:/work/ spaced "));
  assert.ok(f.calls.includes("rule:read:deny:/work/ spaced "));
  assert.equal(f.calls.includes("canonical:/work/spaced"), false);
});

test("evaluation cwd fact scope is separate from original native working roots", () => {
  const f = fixture();
  const original = policy();
  const r = f.gate.check("file", "/elsewhere", original, "read");
  assert.equal(r.allowed, false);
  assert.equal(r.resolvedPath, "/elsewhere/file");
  assert.equal(original.scope.cwd, "/work");
  assert.ok(f.receipts.every((p) => p.scope.cwd === "/elsewhere"));
});

test("unresolved symlink inspection preserves source reason and restricted/read-block circuit distinctions", () => {
  const f = fixture();
  f.host.filesystem.canonical = (path, s) =>
    known({ resolvedPath: path, isCanonical: true, isSymlink: false }, s);
  f.host.filesystem.canonicalInspection = (path, s) =>
    known(
      {
        requested: path,
        spellings: [path],
        unresolved: true,
        stoppedAt: "/work/link",
        leafIsSymlink: true,
        reason: "past-a-link",
      },
      s,
    );
  const r = f.gate.check(
    "file",
    "/work",
    policy({ blockReadsOutsideWorkingDirectories: true }),
    "read",
  );
  assert.equal(r.allowed, false);
  if (r.decisionReason?.type === "safetyCheck")
    assert.equal(r.decisionReason.circuitBreaker, "outsideReadsBlocked");
  else assert.fail("Missing source read-block safety reason");
});

test("tilde home expansion preserves trailing path bytes while unsupported variants and write globs refuse", () => {
  const f = fixture();
  const r = f.gate.check("~/a ", "/work", policy(), "read");
  assert.equal(r.resolvedPath, "/home/test/a ");
  for (const target of [
    "~user/file",
    "$HOME/file",
    "=cmd",
    "a*.txt",
    "{a,b}",
  ]) {
    const result = f.gate.check(target, "/work", policy(), "create");
    assert.equal(result.allowed, false, target);
    assert.equal(result.decisionReason?.type, "other");
  }
});
