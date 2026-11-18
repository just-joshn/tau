import { expect, test } from "bun:test";
import { createOuterFixture } from "./outer-fixture.js";
import { known, policy } from "./security-fixture.js";
import { createNativeBashOuterControl } from "../../../src/native-bash-security/outer-control.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityRule as Rule,
} from "../../../src/native-bash-security/security-types.js";

const allow: Decision = {
  behavior: "allow",
  message: "inner allow",
  decisionReason: { type: "mode", mode: "default" },
};
const askRule: Rule = {
  source: "projectSettings",
  ruleBehavior: "ask",
  ruleValue: { toolName: "Bash", ruleContent: "echo:*" },
};
const ruleAsk: Decision = {
  behavior: "ask",
  message: "ask rule",
  decisionReason: { type: "rule", rule: askRule },
};
const restrictedAsk: Decision = {
  behavior: "ask",
  message: "restricted",
  decisionReason: {
    type: "safetyCheck",
    reason: "restricted",
    circuitBreaker: "restrictedMode",
    classifierApprovable: false,
  },
};
const overrideAsk: Decision = {
  behavior: "ask",
  message: "sandbox override",
  decisionReason: { type: "sandboxOverride", reason: "sandbox override" },
};
const passthrough: Decision = { behavior: "passthrough", message: "pass" };
const readOnly: Decision = {
  behavior: "allow",
  decisionReason: { type: "other", reason: "Read-only command is allowed" },
};
type Fixture = ReturnType<typeof createOuterFixture>;

function sandboxed(f: Fixture, unsandboxedAllowed = false) {
  const base = f.policyHost.sandbox;
  if (!base) throw new Error("Missing authored sandbox profile");
  f.policyHost.sandbox = (permission, s) => {
    const fact = base(permission, s);
    if (fact.status !== "known") throw new Error("Missing sandbox fact");
    return known(
      {
        ...fact.value,
        enabled: true,
        unsandboxedCommandsAllowed: unsandboxedAllowed,
      },
      s,
    );
  };
}

// The refused reading marks a refusal; the as-bash and rule-off rereads
// then return their own decisions.
function readings(
  f: Fixture,
  refused: Decision,
  asBash: Decision,
  ruleOff: Decision,
) {
  const features = f.syntax.preparation.features;
  f.main.native.nIe = async () => {
    if (features.readsAsBash()) return asBash;
    if (features.readingRuleOff()) return ruleOff;
    features.markReadingRefusal("authored reading differs");
    return refused;
  };
}

test.each([
  { name: "ask rule", ruleOff: ruleAsk },
  { name: "non-waivable circuit", ruleOff: restrictedAsk },
  { name: "sandbox override", ruleOff: overrideAsk },
])(
  "reading reread: a rule-off $name ask wins without standing in under hook asks",
  async ({ ruleOff }) => {
    const f = createOuterFixture();
    readings(f, allow, allow, ruleOff);
    const result = await f.stage("QOr", { command: "echo hi" }).result;
    expect(result).toEqual({ ...ruleOff, suggestions: [] });
    expect(result.standsInUnderHookAsk).toBeUndefined();
  },
);

test("reading reread: agreeing allows keep the refused reading", async () => {
  const f = createOuterFixture();
  readings(f, allow, allow, allow);
  expect(await f.stage("QOr", { command: "echo hi" }).result).toBe(allow);
});

test("reading reread: a refused passthrough with the sandbox disabled becomes a too-complex ask", async () => {
  const f = createOuterFixture();
  sandboxed(f, true);
  readings(f, passthrough, passthrough, passthrough);
  const disabled = await f.stage("QOr", {
    command: "echo hi",
    dangerouslyDisableSandbox: true,
  }).result;
  expect(disabled).toMatchObject({
    behavior: "ask",
    decisionReason: {
      type: "other",
      reason: "authored reading differs",
      bashMissKind: "too-complex",
    },
    standsInUnderHookAsk: true,
  });
  expect(await f.stage("QOr", { command: "echo hi" }).result).toBe(passthrough);
});

test("reading reread: a sandbox-disabled call keeps a rule-off deny", async () => {
  const f = createOuterFixture();
  sandboxed(f, true);
  const deny: Decision = { behavior: "deny", message: "rule-off deny" };
  readings(f, passthrough, passthrough, deny);
  expect(
    await f.stage("QOr", {
      command: "echo hi",
      dangerouslyDisableSandbox: true,
    }).result,
  ).toBe(deny);
});

function promptOff(f: Fixture) {
  f.outerHost.exportedVariablePromptDisabled = (s) =>
    known("string-nonempty", s);
}

test("sandboxed read-only git: a variable that can make git run a program cannot stay allowed", async () => {
  const f = createOuterFixture();
  sandboxed(f);
  promptOff(f);
  f.main.native.nIe = async () => readOnly;
  const result = await f.stage("ibn", {
    command: "GIT_SSH_COMMAND=x; git fetch",
  }).result;
  expect(result).toMatchObject({
    behavior: "passthrough",
    decisionReason: {
      reason:
        "This command sets a variable that can make git run a program. Approve only if you trust it.",
      bashMissKind: "assigned-variable",
    },
    suggestions: [],
  });
  expect(await f.stage("ibn", { command: "GIT_DIR=x; git fetch" }).result).toBe(
    readOnly,
  );
});

test("sandboxed read-only: a command that cannot be finished checking cannot stay allowed", async () => {
  const f = createOuterFixture();
  sandboxed(f);
  promptOff(f);
  f.main.native.nIe = async () => readOnly;
  const seen: string[] = [];
  const result = await f.stage(
    "ibn",
    { command: "git log `x`" },
    f.outerContext(),
    (decision) => {
      seen.push(decision.behavior);
      return decision.behavior === "passthrough"
        ? { ...decision, message: "transformed" }
        : undefined;
    },
  ).result;
  expect(result).toMatchObject({
    behavior: "passthrough",
    message: "transformed",
    decisionReason: { bashMissKind: "too-complex" },
  });
  expect(seen).toEqual(["allow", "passthrough"]);
});

test("unsandboxed read-only git keeps the inner allow", async () => {
  const f = createOuterFixture();
  promptOff(f);
  f.main.native.nIe = async () => readOnly;
  expect(
    await f.stage("ibn", { command: "GIT_SSH_COMMAND=x; git fetch" }).result,
  ).toBe(readOnly);
});

test("outer control refuses process owners that are not shared", () => {
  const f = createOuterFixture();
  const other = createOuterFixture();
  expect(() =>
    createNativeBashOuterControl(other.primitives, f.alternates, f.outerHost),
  ).toThrow("Native Bash outer process owners must be shared");
});

test("outer checks outside a policy scope fail instead of reading unscoped rules", () => {
  const f = createOuterFixture();
  expect(() =>
    f.outer.native.Zwn(
      { behavior: "ask", message: "ask" },
      { command: "echo hi" },
      policy(),
    ),
  ).toThrow("Missing native outer-control invariant");
});

test("declaration-prefix readings also gate the assigned-variable check", async () => {
  const f = createOuterFixture();
  f.main.native.nIe = async (...args) => {
    if (args[5] === undefined) args[6]?.(1, undefined, false);
    return allow;
  };
  expect(
    await f.stage("ibn", { command: "declare x=1; echo $x" }).result,
  ).toMatchObject({
    behavior: "passthrough",
    decisionReason: { bashMissKind: "assigned-variable" },
  });
});

test("an ordinary ask carrying allowed domains in auto mode keeps the ask for a simple command", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "auto" }));
  const ask: Decision = {
    behavior: "ask",
    message: "ordinary",
    decisionReason: { type: "other", reason: "ordinary" },
  };
  f.main.native.nIe = async () => ask;
  expect(
    await f.stage("QOr", {
      command: "curl example.test",
      allowed_domains: ["example.test"],
    }).result,
  ).toEqual(ask);
});

function arithmetic(f: Fixture) {
  const features = f.semantic.parser.features;
  const deny: Decision = { behavior: "deny", message: "arithmetic deny" };
  const ask: Decision = {
    behavior: "ask",
    message: "ordinary",
    decisionReason: { type: "other", reason: "ordinary" },
  };
  f.main.native.nIe = async () => (features.arithmeticGuardOff() ? deny : ask);
}

test("an arithmetic command is reread only when its feature receipt is unavailable", async () => {
  const f = createOuterFixture();
  arithmetic(f);
  expect((await f.stage("YOr", { command: "(( 1 ))" }).result).behavior).toBe(
    "ask",
  );
  f.outerHost.glimmeringGlacier = (_fallback, s) => known(false, s);
  expect((await f.stage("YOr", { command: "(( 1 ))" }).result).behavior).toBe(
    "deny",
  );
});

test("arithmetic reread runs when served feature values change during the check", async () => {
  const f = createOuterFixture();
  arithmetic(f);
  let changes = 0;
  f.outerHost.servedValuesChangeCount = (s) => known(changes++, s);
  expect((await f.stage("YOr", { command: "(( 1 ))" }).result).behavior).toBe(
    "deny",
  );
});
