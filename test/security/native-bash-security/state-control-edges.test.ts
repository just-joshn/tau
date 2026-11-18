import { expect, test } from "bun:test";
import { createStateFixture, removal, denyRule } from "./state-fixture.js";
import { known, policy } from "./security-fixture.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityRule as Rule,
} from "../../../src/native-bash-security/security-types.js";

const readFence: Decision = {
  behavior: "ask",
  message: "read fence",
  decisionReason: {
    type: "safetyCheck",
    reason: "read fence",
    circuitBreaker: "outsideReadsBlocked",
    classifierApprovable: false,
  },
};
const askRule: Rule = {
  source: "projectSettings",
  ruleBehavior: "ask",
  ruleValue: { toolName: "Bash", ruleContent: "git push" },
};
const ruleAsk: Decision = {
  behavior: "ask",
  message: "ask rule",
  decisionReason: { type: "rule", rule: askRule },
};
const tooComplex: Decision = {
  behavior: "ask",
  message: "too complex",
  decisionReason: {
    type: "other",
    reason: "parser could not analyze",
    bashMissKind: "too-complex",
  },
};

test("state reads outside a policy scope fail instead of reading an unscoped fact", () => {
  const f = createStateFixture();
  expect(() => f.state.native.fxe(policy({ mode: "plan" }))).toThrow(
    "Missing native state scope",
  );
});

test("unfinished-check fallback keeps an ask whose only non-waivable circuit is listed in also", () => {
  const f = createStateFixture();
  const restricted: Decision = {
    behavior: "ask",
    message: "restricted",
    decisionReason: {
      type: "safetyCheck",
      reason: "restricted",
      also: ["restrictedMode"],
      classifierApprovable: false,
    },
  };
  expect(
    f.stateRun(() => f.state.native.Qlt(restricted, f.context("").context)),
  ).toBe(restricted);
});

test("removal ranking under bypassPermissions depends on the even-more-dangerous waiver", () => {
  const f = createStateFixture();
  f.setPolicy(policy({ mode: "bypassPermissions" }));
  const context = f.context("").context;
  // Waiver active (skip flag on, rules clear, managed sources readable): removal asks are waived.
  expect(f.stateRun(() => f.state.native.Zde(removal(), context))).toBe(false);
  f.setSkip(false);
  expect(f.stateRun(() => f.state.native.Zde(removal(), context))).toBe(true);
});

test.each([
  {
    name: "a higher-ranked candidate wins",
    candidate: readFence,
    incumbent: { behavior: "allow" },
    mode: "default" as const,
    expected: true,
  },
  {
    name: "equal rank: a non-classifier circuit outranks a classifier-routed removal",
    candidate: readFence,
    incumbent: removal(),
    mode: "default" as const,
    expected: true,
  },
  {
    name: "equal rank: a classifier-routed removal does not outrank a non-classifier circuit",
    candidate: removal(),
    incumbent: readFence,
    mode: "default" as const,
    expected: false,
  },
  {
    name: "equal rank: an ask-rule incumbent is never displaced by circuit weight",
    candidate: readFence,
    incumbent: ruleAsk,
    mode: "default" as const,
    expected: false,
  },
  {
    name: "equal rank in auto mode: a reviewable removal candidate outranks a plain fence",
    candidate: removal(),
    incumbent: readFence,
    mode: "auto" as const,
    expected: true,
  },
  {
    name: "equal rank in auto mode: a reviewable removal incumbent is kept",
    candidate: readFence,
    incumbent: removal(),
    mode: "auto" as const,
    expected: false,
  },
])("Ubn: $name", ({ candidate, incumbent, mode, expected }) => {
  const f = createStateFixture();
  f.setPolicy(policy({ mode }));
  expect(
    f.stateRun(() =>
      f.state.native.Ubn(candidate, incumbent, f.context("").context),
    ),
  ).toBe(expected);
});

test("cut-short decisions: a deny stays, a default-mode removal ask stays, other asks become unfinished checks", () => {
  const f = createStateFixture();
  const deny: Decision = { behavior: "deny", message: "denied" };
  const context = f.context("").context;
  expect(f.stateRun(() => f.state.native.ZOr(deny, context))).toBe(deny);
  const dangerous = removal();
  expect(f.stateRun(() => f.state.native.ZOr(dangerous, context))).toBe(
    dangerous,
  );
  const plain: Decision = {
    behavior: "ask",
    message: "plain",
    decisionReason: { type: "other", reason: "plain" },
  };
  const unfinished = f.stateRun(() => f.state.native.ZOr(plain, context));
  expect(unfinished.decisionReason).toMatchObject({
    type: "safetyCheck",
    circuitBreaker: "unfinishedCheck",
  });
  // Under bypassPermissions without the waiver, the removal ask is still reviewable and kept.
  f.setSkip(false);
  f.setPolicy(policy({ mode: "bypassPermissions" }));
  expect(f.stateRun(() => f.state.native.ZOr(dangerous, context))).toBe(
    dangerous,
  );
  // Read deny rules with content force a deny because the truncated text was never checked.
  f.denied.push(denyRule("Bash", "projectSettings", "rm:*"));
  expect(
    f.stateRun(() => f.state.native.ZOr(dangerous, context)).behavior,
  ).toBe("deny");
});

test("exact allow-rule detection matches only an allow rule for the whole trimmed command", () => {
  const f = createStateFixture();
  f.add("allow", "git status");
  const context = f.context("").context;
  expect(
    f.stateRun(() => f.state.native.Hbn({ command: "git status" }, context)),
  ).toBe(true);
  expect(
    f.stateRun(() => f.state.native.Hbn({ command: "git log" }, context)),
  ).toBe(false);
});

const merges: {
  name: string;
  first: Decision;
  second: Decision;
  expected: Partial<Decision>;
}[] = [
  {
    name: "an earlier deny wins",
    first: { behavior: "deny", message: "first" },
    second: { behavior: "allow" },
    expected: { behavior: "deny", message: "first" },
  },
  {
    name: "an alternate deny wins over an allow",
    first: { behavior: "allow" },
    second: { behavior: "deny", message: "second" },
    expected: { behavior: "deny", message: "second" },
  },
  {
    name: "a non-overridable alternate ask wins with its suggestions cleared",
    first: { behavior: "allow" },
    second: { ...readFence, suggestions: [] },
    expected: { ...readFence, suggestions: [] },
  },
  {
    name: "an allow with an ordinary alternate ask becomes a too-complex ask",
    first: { behavior: "allow" },
    second: {
      behavior: "ask",
      message: "ordinary",
      decisionReason: { type: "other", reason: "ordinary" },
    },
    expected: {
      behavior: "ask",
      decisionReason: {
        type: "other",
        reason: "reading differs",
        bashMissKind: "too-complex",
      },
      suggestions: [],
    },
  },
  {
    name: "an allow confirmed by the alternate stays",
    first: { behavior: "allow", message: "kept" },
    second: { behavior: "allow" },
    expected: { behavior: "allow", message: "kept" },
  },
  {
    name: "a passthrough stays when the alternate is an ordinary ask",
    first: { behavior: "passthrough", message: "kept" },
    second: {
      behavior: "ask",
      decisionReason: { type: "other", reason: "ordinary" },
    },
    expected: { behavior: "passthrough", message: "kept" },
  },
];
test.each(merges)("reading merge: $name", ({ first, second, expected }) => {
  const f = createStateFixture();
  expect(
    f.stateRun(() => f.state.native.rbn(first, second, "reading differs")),
  ).toMatchObject(expected);
});

test("a too-complex ask under the read block asks unless the sandbox enforces read fences", () => {
  const f = createStateFixture();
  const blocked = policy({ blockReadsOutsideWorkingDirectories: true });
  const input = { command: "cat $(x)" };
  let fencesUsable = false;
  f.policyHost.sandboxReadFencesUsable = (s) => known(fencesUsable, s);
  f.policyHost.globalReadBlock = (s) => known(true, s);
  const result = f.stateRun(() =>
    f.state.native.Plt(tooComplex, input, blocked),
  );
  expect(result.behavior).toBe("ask");
  expect(result.decisionReason).toMatchObject({
    type: "safetyCheck",
    circuitBreaker: "outsideReadsBlocked",
    classifierApprovable: false,
  });
  fencesUsable = true;
  expect(f.stateRun(() => f.state.native.Plt(tooComplex, input, blocked))).toBe(
    tooComplex,
  );
  expect(
    f.stateRun(() => f.state.native.Plt(tooComplex, input, policy())),
  ).toBe(tooComplex);
});
