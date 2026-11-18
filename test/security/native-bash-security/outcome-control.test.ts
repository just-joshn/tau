import { test, expect } from "bun:test";
import { createNativeBashSecurityOutcomeControl } from "../../../src/native-bash-security/outcome-control.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityReason as Reason,
} from "../../../src/native-bash-security/security-types.js";
const owner = createNativeBashSecurityOutcomeControl((_tool, reason) =>
  reason?.type === "other" ? reason.reason : "prompt",
);
const allow: Decision = {
  behavior: "allow",
  decisionReason: {
    type: "rule",
    rule: {
      source: "session",
      ruleBehavior: "allow",
      ruleValue: { toolName: "Bash", ruleContent: "cat file" },
    },
  },
};
const other: Decision = {
  behavior: "ask",
  decisionReason: { type: "other", reason: "needs approval" },
};
const hard: Decision = {
  behavior: "ask",
  decisionReason: {
    type: "safetyCheck",
    reason: "hard",
    classifierApprovable: false,
    circuitBreaker: "internalHardDeny",
  },
};
const removal: Decision = {
  behavior: "ask",
  decisionReason: {
    type: "safetyCheck",
    reason: "removal",
    classifierApprovable: false,
    circuitBreaker: "dangerousRemoval",
  },
};
const askRule: Decision = {
  behavior: "ask",
  decisionReason: {
    type: "rule",
    rule: {
      source: "session",
      ruleBehavior: "ask",
      ruleValue: { toolName: "Bash", ruleContent: "cat file" },
    },
  },
};
test("native reconciliation rank preserves source categories rather than generic severity", () => {
  expect(owner.nS(allow)).toBe(0);
  expect(
    owner.nS({
      behavior: "allow",
      decisionReason: { type: "other", reason: "Read-only command is allowed" },
    }),
  ).toBe(1);
  expect(owner.nS({ behavior: "passthrough" })).toBe(2);
  expect(owner.nS(other)).toBe(3);
  expect(owner.nS(hard)).toBe(4);
  expect(owner.nS(askRule)).toBe(5);
  expect(owner.nS(removal)).toBe(5);
  expect(owner.nS({ behavior: "deny" })).toBe(6);
  expect(owner.eIe(hard)).toBe(0);
  expect(owner.eIe(removal)).toBe(1);
  expect(
    owner.eIe({
      behavior: "ask",
      decisionReason: {
        type: "safetyCheck",
        reason: "read fence",
        circuitBreaker: "outsideReadsBlocked",
      },
    }),
  ).toBe(2);
});
test("nested asks carry actual explicit-ask and safety graph predicates", () => {
  const nested: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "subcommandResults",
      reasons: new Map([
        ["allowed", allow],
        ["plain", other],
      ]),
    },
  };
  expect(owner.VS(nested)).toBe(true);
  expect(owner.bk(nested)).toBe(false);
  const marked: Decision = {
    ...nested,
    matchedAskRule: {
      source: "session",
      ruleBehavior: "ask",
      ruleValue: { toolName: "Bash" },
    },
  };
  expect(owner.VS(marked)).toBe(false);
  expect(owner.bk(marked)).toBe(true);
  const reason: Reason = {
    type: "subcommandResults",
    reasons: new Map([
      [
        "nested",
        {
          behavior: "ask",
          decisionReason: {
            type: "subcommandResults",
            reasons: new Map([["deep", removal]]),
          },
        },
      ],
    ]),
  };
  expect(owner.Sa(reason)).toBe(
    removal.decisionReason?.type === "safetyCheck"
      ? removal.decisionReason
      : undefined,
  );
  expect(
    owner.Sa(reason, (r) => r.circuitBreaker === "outsideReadsBlocked"),
  ).toBeUndefined();
  expect(
    owner.Sa({ type: "asyncAgent", reason: "agent", ask: removal }),
  ).toBeUndefined();
});
test("source by-name reconciliation can downgrade only ordinary asks to passthrough", () => {
  const r = owner.qOr(allow, other);
  expect(r.behavior).toBe("passthrough");
  expect(r.decisionReason).toEqual(other.decisionReason);
  expect(Object.hasOwn(r, "message")).toBe(true);
  expect(owner.qOr(allow, hard)).toBe(hard);
  expect(owner.qOr(askRule, other)).toBe(askRule);
  expect(owner.qOr(other, { ...other, message: "first" }).message).toBe(
    "first",
  );
});
test("declaration-prefix aggregation distinguishes exhaustive readings and uncertain writes", () => {
  expect(owner.IOr(allow, [allow], true, false)).toBe(allow);
  const unfinished = owner.IOr(allow, [allow], false, false);
  expect(unfinished.behavior).toBe("ask");
  expect(unfinished.suggestions).toEqual([]);
  expect(owner.IOr(hard, [{ behavior: "deny" }], false, false).behavior).toBe(
    "deny",
  );
  expect(owner.IOr(hard, [removal], true, false)).toBe(hard);
  expect(owner.IOr(hard, [removal], true, true)).toBe(removal);
});
test("subcommand labels preserve duplicate source readings and removal suffix", () => {
  const labels = owner.YOe([
    ["cmd", allow],
    ["cmd #2", other],
    ["cmd", hard],
    ["cmd", removal],
  ]);
  expect([...labels.keys()]).toEqual(["cmd", "cmd #2", "cmd #3", "cmd #4"]);
  const joined = owner.A8("rm target", hard, removal);
  expect(joined.decisionReason?.type).toBe("subcommandResults");
  if (joined.decisionReason?.type === "subcommandResults")
    expect([...joined.decisionReason.reasons.keys()]).toEqual([
      "rm target",
      "rm target (removal)",
    ]);
});
test("read-only provenance traverses source subcommands without granting rule or mode receipts", () => {
  expect(owner.gbn(allow.decisionReason)).toBe(false);
  expect(owner.gbn({ type: "mode", mode: "acceptEdits" })).toBe(false);
  expect(
    owner.gbn({
      type: "subcommandResults",
      reasons: new Map([
        [
          "cat",
          {
            behavior: "allow",
            decisionReason: {
              type: "other",
              reason: "Read-only command is allowed",
            },
          },
        ],
      ]),
    }),
  ).toBe(true);
});
