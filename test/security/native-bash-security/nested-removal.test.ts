import { expect, test } from "bun:test";
import { createNestedFixture as owner } from "./nested-fixture.js";
import { known, policy } from "./security-fixture.js";
import { NativeBashSecurityUnsupported } from "../../../src/native-bash-security/security-types.js";
test("native maybe-unset reader preserves direct environment, spawn-key and shell-export order", () => {
  const f = owner();
  const context = f.context("").context;
  context.sessionEnvVars = new Map([
    ["KNOWN", "redacted-test"],
    ["EXPORTED", "redacted-test"],
  ]);
  f.environment.set("FULL", { kind: "string", empty: false });
  f.environment.set("EMPTY", { kind: "string", empty: true });
  f.exports.add("EXPORTED");
  const result = f.run(() => {
    const config = f.nested.native.Rbn(false, context);
    if (!config) throw new Error("Missing source config");
    return ["FULL", "EMPTY", "KNOWN", "EXPORTED", "UNKNOWN", "TMP"].map(
      config.mayBeUnset,
    );
  });
  expect(result).toEqual([false, true, false, true, true, true]);
  expect(f.reads).toEqual([
    "env:FULL",
    "env:EMPTY",
    "env:KNOWN",
    "export:KNOWN",
    "env:EXPORTED",
    "export:EXPORTED",
    "env:UNKNOWN",
    "env:TMP",
  ]);
  expect(
    f.run(() => f.nested.native.Rbn(true, context)?.mayBeUnset("FULL")),
  ).toBe(true);
  expect(f.reads).toHaveLength(8);
});

test("nested variable removal preserves source candidate, removal rule and explicit approval", async () => {
  const f = owner();
  const result = await f.scan('rm -rf "$BUILD/*"');
  expect(result?.kind).toBe("emptyVariable");
  expect(result?.result.behavior).toBe("ask");
  expect(result?.result.decisionReason).toMatchObject({
    type: "safetyCheck",
    circuitBreaker: "dangerousRemoval",
    classifierApprovable: false,
  });
  expect(result?.result.message).toContain("${BUILD:?}");
  expect(f.errors).toEqual([]);
});

test("native first substitution cap asks before later feature or file-policy consumers", async () => {
  const f = owner();
  delete f.host.removalReviewFeature;
  const command =
    "echo " + Array.from({ length: 65 }, () => "$(echo x)").join(" ");
  const result = await f.scan(command);
  expect(result?.kind).toBe("tooManySubstitutions");
  expect(result?.result.message).toContain("65 command substitutions");
  expect(result?.result.decisionReason).toMatchObject({
    removalRule: "tooManySubstitutions",
    classifierApprovable: false,
  });
  expect(f.reads).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("ordinary nested-analysis errors use source logging and overrun prompt while unsupported facts propagate", async () => {
  const f = owner();
  const failure = new Error("authored unavailable state");
  f.host.processEnvironment = () => {
    throw failure;
  };
  const result = await f.scan('rm -rf "$BUILD/etc"');
  expect(result?.kind).toBe("nestedSpansOverrun");
  expect(result?.result.decisionReason).toMatchObject({
    removalRule: "nestedSpansOverrun",
  });
  expect(f.errors).toEqual([failure]);
  f.host.processEnvironment = () => ({
    status: "unsupported",
    dependency: "actual.environment",
    reason: "not supplied",
  });
  let caught: unknown;
  try {
    await f.scan('rm -rf "$BUILD/etc"');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeBashSecurityUnsupported);
  expect(f.errors).toEqual([failure]);
});

test("native aborted context rethrows an actual classified request abort without logging fallback", async () => {
  const f = owner();
  const abort = new Error("author request-aborted shape");
  f.host.processEnvironment = () => {
    throw abort;
  };
  f.host.isAbortError = (error, s) => known(error === abort, s);
  const command = 'rm -rf "$BUILD/etc"';
  const root = await f.semantic.parse(command);
  if (!root || root === f.semantic.parseAbort)
    throw new Error("Missing authored tree");
  const state = f.context(command);
  state.context.abortController.abort();
  let caught: unknown;
  try {
    await f.run(() =>
      f.nested.native.Pbn(
        root,
        "/work",
        policy(),
        undefined,
        false,
        state,
        state.context,
      ),
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(abort);
  expect(f.errors).toEqual([]);
});

test("native missing logger cannot silently manufacture a successful fallback", async () => {
  const f = owner();
  f.host.processEnvironment = () => {
    throw new Error("authored source error");
  };
  delete f.host.reportError;
  let caught: unknown;
  try {
    await f.scan('rm -rf "$BUILD/etc"');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeBashSecurityUnsupported);
  expect(f.errors).toEqual([]);
});

test("native whole-substitution prompt follows projected removal argv and retains disabled-stage nonauthority", async () => {
  const f = owner(true);
  const command = 'rm -rf "$(printf /)"';
  const result = await f.scan(command);
  expect(result?.kind).toBe("wholeSubstitution");
  expect(result?.result.decisionReason).toMatchObject({
    removalRule: "wholeSubstitution",
    classifierApprovable: false,
  });
  expect(f.removalCalls).toEqual([{ name: "rm", args: ["-rf", "__CMDSUB__"] }]);
  const rows: string[] = [];
  f.host.substitutionRemovalDisabled = (s) => known(true, s);
  f.host.tooComplexTelemetry = (kind, s) => {
    rows.push(kind);
    return known(undefined, s);
  };
  expect(await f.scan(command)).toBeNull();
  expect(rows).toEqual(["wholeSubstitution"]);
  expect(f.errors).toEqual([]);
});

test("native TMPDIR unset probe skips environment reads only while sandbox is actually enabled", () => {
  const f = owner();
  const sandbox = f.policyHost.sandbox;
  if (!sandbox) throw new Error("Missing authored sandbox fact");
  f.policyHost.sandbox = (permission, s) => {
    const value = sandbox(permission, s);
    if (value.status !== "known")
      throw new Error("Missing authored sandbox profile");
    return known({ ...value.value, enabled: true }, s);
  };
  expect(
    f.run(() =>
      f.nested.native.Rbn(false, f.context("").context)?.mayBeUnset("TMPDIR"),
    ),
  ).toBe(false);
  expect(f.reads).toEqual([]);
});
