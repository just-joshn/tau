import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  NativePermissionOutcome,
  NativePermissionReason,
  NativePermissionRule,
} from "../../src/native-permission-outcome.js";
import { nativePermissionReasonText as text } from "../../src/native-permission-reason-codes.js";
import {
  nativePermissionFallback,
  nativePermissionReasonCode,
  nativePermissionReasonDecisionSource,
  nativePermissionRuleDecisionSource,
  normalizeNativePermissionDecision,
  planNativePermissionDecisionAttachments,
} from "../../src/native-permission-decision.js";
import type { NativeObject } from "../../src/native-session-codec.js";

const rule: NativePermissionRule = {
  source: "userSettings",
  ruleBehavior: "allow",
  ruleValue: { toolName: "Read", ruleContent: "./owned.md" },
};
const mode: NativePermissionOutcome = {
  behavior: "allow",
  decisionReason: { type: "mode", mode: "default" },
};
const fallback = { decision: "accept", source: "config" } as const;
const reject = { decision: "reject", source: "config" } as const;

test("fallback records actual source families and never grants an ask or passthrough", () => {
  for (const [source, accepted, denied] of [
    ["session", "user_temporary", "user_reject"],
    ["localSettings", "user_permanent", "user_reject"],
    ["userSettings", "user_permanent", "user_reject"],
    ["policySettings", "config", "config"],
  ] as const) {
    assert.equal(nativePermissionRuleDecisionSource(source, "allow"), accepted);
    assert.equal(nativePermissionRuleDecisionSource(source, "deny"), denied);
  }
  assert.deepEqual(
    nativePermissionFallback(
      { behavior: "ask", decisionReason: { type: "rule", rule } },
      false,
    ),
    reject,
  );
  assert.deepEqual(nativePermissionFallback({ behavior: "ask" }, true), {
    decision: "reject",
    source: "user_abort",
  });
  assert.equal(
    nativePermissionFallback({ behavior: "passthrough" }, false),
    undefined,
  );
  assert.equal(
    nativePermissionReasonDecisionSource(
      { type: "other", reason: text.canUseToolAborted },
      "deny",
    ),
    "user_abort",
  );
  assert.equal(
    nativePermissionReasonDecisionSource(
      { type: "hook", hookName: "PreToolUse:Read" },
      "allow",
    ),
    "hook",
  );
  assert.equal(
    nativePermissionReasonDecisionSource(
      {
        type: "permissionPromptTool",
        toolResult: { decisionClassification: "user_permanent" },
      },
      "allow",
    ),
    "user_permanent",
  );
  assert.equal(
    nativePermissionReasonDecisionSource(
      { type: "permissionPromptTool" },
      "deny",
    ),
    "user_reject",
  );
});

test("ordinary actual mode allow produces exactly the supported three-field record", () => {
  assert.deepEqual(
    normalizeNativePermissionDecision({ outcome: mode, fallback }),
    { decision: "accept", source: "config", reasonType: "mode" },
  );
  const outcome: NativePermissionOutcome = {
    behavior: "allow",
    decisionReason: { type: "rule", rule },
  };
  assert.deepEqual(
    normalizeNativePermissionDecision({
      outcome,
      fallback: { decision: "accept", source: "user_permanent" },
    }),
    {
      decision: "accept",
      source: "user_permanent",
      reasonType: "rule",
      ruleSource: "userSettings",
    },
  );
});

test("recorded user source and grant override hide direct reason without inventing a grant", () => {
  assert.deepEqual(
    normalizeNativePermissionDecision({
      outcome: { ...mode, grantScope: "once" },
      recorded: {
        decision: "accept",
        source: "user_permanent",
        grantScope: "session",
      },
      fallback,
    }),
    {
      decision: "accept",
      source: "user_permanent",
      grantScope: "session",
      reasonCode: "mode:default",
    },
  );
  const result = normalizeNativePermissionDecision({
    outcome: {
      behavior: "deny",
      grantScope: "once",
      decisionReason: { type: "rule", rule },
    },
    recorded: {
      decision: "accept",
      source: "user_temporary",
      grantScope: "session",
    },
    fallback,
  });
  assert.equal(result.decision, "reject");
  assert.equal(Object.hasOwn(result, "grantScope"), false);
  assert.equal(Object.hasOwn(result, "reasonType"), false);
  assert.equal(result.ruleSource, "userSettings");
});

test("actual ask hides direct type but preserves actual rule and shown reason code", () => {
  const result = normalizeNativePermissionDecision({
    outcome: { behavior: "ask", decisionReason: { type: "rule", rule } },
    fallback: reject,
  });
  assert.deepEqual(result, {
    decision: "reject",
    source: "config",
    ruleSource: "userSettings",
    reasonCode: "rule:userSettings",
  });
  const shown = {
    behavior: "ask",
    decisionReason: { type: "workingDir", reason: "outside" },
  } satisfies NativePermissionOutcome;
  assert.deepEqual(
    normalizeNativePermissionDecision({
      outcome: mode,
      fallback,
      shown: { result: shown },
    }),
    {
      decision: "accept",
      source: "config",
      reasonType: "mode",
      reasonCode: "workingDir",
    },
  );
});

test("non-allow hook or classifier remains decisive over a shown ask", () => {
  const shown: NativePermissionOutcome = {
    behavior: "ask",
    decisionReason: { type: "mode", mode: "plan" },
  };
  assert.deepEqual(
    normalizeNativePermissionDecision({
      outcome: {
        behavior: "deny",
        decisionReason: { type: "hook", hookName: "PreToolUse:Read" },
      },
      fallback: { decision: "reject", source: "hook" },
      shown: { answered: shown },
    }),
    {
      decision: "reject",
      source: "hook",
      reasonType: "hook",
      reasonCode: "hook:PreToolUse",
    },
  );
  const classifier: NativePermissionReason = {
    type: "classifier",
    reason: text.classifierUnavailable,
    classifier: "auto-mode",
    category: "credential_leakage",
    autoModeRule: { actual: "rule" },
  };
  const result = normalizeNativePermissionDecision({
    outcome: { behavior: "deny", decisionReason: classifier },
    fallback: reject,
    shown: { answered: shown },
  });
  assert.equal(result.reasonCode, "classifier:auto-mode:unavailable");
  assert.equal(result.classifierCategory, "credential_leakage");
  assert.deepEqual(result.autoModeRule, { actual: "rule" });
  assert.notEqual(result.autoModeRule, classifier.autoModeRule);
});

test("async embedded ask and matched-ask precedence retain the actual shown policy", () => {
  const result = normalizeNativePermissionDecision({
    outcome: {
      behavior: "deny",
      decisionReason: {
        type: "asyncAgent",
        reason: "timeout",
        ask: {
          behavior: "ask",
          decisionReason: { type: "workingDir", reason: "actual ask" },
          matchedAskRule: rule,
        },
      },
    },
    fallback: reject,
  });
  assert.equal(result.reasonType, "asyncAgent");
  assert.equal(result.reasonCode, "rule:userSettings");
  assert.equal(result.ruleSource, "userSettings");
});

test("nested source-rule matching uses deny or ask rather than successful subcommands", () => {
  const nested: NativePermissionReason = {
    type: "subcommandResults",
    reasons: new Map([
      [
        "allowed",
        { behavior: "allow", decisionReason: { type: "rule", rule } },
      ],
      [
        "asked",
        {
          behavior: "ask",
          decisionReason: {
            type: "rule",
            rule: { ...rule, source: "session" },
          },
        },
      ],
    ]),
  };
  assert.equal(
    normalizeNativePermissionDecision({
      outcome: { behavior: "allow", decisionReason: nested },
      fallback,
    }).ruleSource,
    "session",
  );
  assert.equal(
    nativePermissionReasonCode("allow", nested),
    "rule:userSettings",
  );
});

test("reason-code aggregation flattens ask subcommands but reduces non-ask prefixes", () => {
  const children: NativePermissionReason = {
    type: "subcommandResults",
    reasons: new Map([
      [
        "mode",
        {
          behavior: "allow",
          decisionReason: { type: "mode", mode: "default" },
        },
      ],
      [
        "hook",
        {
          behavior: "allow",
          decisionReason: { type: "hook", hookName: "PreToolUse:Read" },
        },
      ],
      [
        "ignored",
        {
          behavior: "deny",
          decisionReason: { type: "other", reason: "not counted" },
        },
      ],
    ]),
  };
  assert.equal(
    nativePermissionReasonCode("allow", children),
    "subcommands:hook+mode",
  );
  const ask: NativePermissionReason = {
    type: "subcommandResults",
    reasons: new Map([
      [
        "mode",
        { behavior: "ask", decisionReason: { type: "mode", mode: "plan" } },
      ],
      [
        "pass",
        {
          behavior: "passthrough",
          decisionReason: { type: "workingDir", reason: "actual" },
        },
      ],
    ]),
  };
  assert.equal(
    nativePermissionReasonCode("ask", ask),
    "subcommands:mode:plan+workingDir",
  );
  assert.equal(nativePermissionReasonCode("deny", ask), "subcommandResults");
});

test("finite labels, classifier categories and circuit breakers follow native membership", () => {
  assert.equal(
    nativePermissionReasonCode("deny", {
      type: "other",
      reason: text.outsideFileReadsBlocked,
    }),
    "outsideReadsBlocked",
  );
  assert.equal(
    nativePermissionReasonCode("deny", {
      type: "other",
      reason: "actual",
      label: "toolRemovedByPlugin",
    }),
    "toolRemovedByPlugin",
  );
  assert.equal(
    nativePermissionReasonCode("deny", {
      type: "other",
      reason: "actual",
      label: "invented",
    }),
    "other",
  );
  assert.equal(
    nativePermissionReasonCode("ask", {
      type: "classifier",
      classifier: "unknown",
      reason: "actual",
      noVerdict: true,
    }),
    "classifier:other:no-verdict",
  );
  assert.equal(
    nativePermissionReasonCode("ask", undefined, undefined, "hook"),
    "hook:PermissionRequest",
  );
  for (const value of ["outsideReadsBlocked", "invented"]) {
    const result = normalizeNativePermissionDecision({
      outcome: {
        behavior: "ask",
        decisionReason: {
          type: "safetyCheck",
          reason: "actual",
          circuitBreaker: value,
        },
      },
      fallback: reject,
    });
    assert.equal(
      result.circuitBreaker,
      value === "invented" ? undefined : value,
    );
  }
  assert.equal(
    normalizeNativePermissionDecision({
      outcome: {
        behavior: "ask",
        decisionReason: {
          type: "classifier",
          reason: "actual",
          category: "not-native",
        },
      },
      fallback: reject,
    }).classifierCategory,
    undefined,
  );
});

test("normalization leaves original Map/outcome/recorded data unchanged and rejects nonfinal pass", () => {
  const reason: NativePermissionReason = {
    type: "subcommandResults",
    reasons: new Map([
      [
        "x",
        {
          behavior: "deny",
          decisionReason: {
            type: "safetyCheck",
            reason: "actual",
            circuitBreaker: "restrictedMode",
          },
        },
      ],
    ]),
  };
  const outcome: NativePermissionOutcome = {
    behavior: "deny",
    decisionReason: reason,
  };
  const before = structuredClone(outcome);
  assert.equal(
    normalizeNativePermissionDecision({ outcome, fallback: reject })
      .circuitBreaker,
    "restrictedMode",
  );
  assert.deepEqual(outcome, before);
  assert.throws(
    () =>
      normalizeNativePermissionDecision({
        outcome: { behavior: "passthrough" },
        fallback,
      }),
    /not a final/,
  );
});

test("permission sidecar plan selects actual single-result user rows without guessing ownership", () => {
  const decision = normalizeNativePermissionDecision({
    outcome: mode,
    fallback,
  });
  const rows: NativeObject[] = [
    {
      type: "user",
      uuid: "actual-row",
      message: {
        content: [
          { type: "text", text: "context" },
          { type: "tool_result", tool_use_id: "call" },
        ],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "other" }] },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call" },
          { type: "tool_result", tool_use_id: "call" },
        ],
      },
    },
    {
      type: "assistant",
      message: { content: [{ type: "tool_result", tool_use_id: "call" }] },
    },
    { type: "user", message: { content: "plain user" } },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(
    planNativePermissionDecisionAttachments(rows, "call", decision),
    [
      {
        rowIndex: 0,
        toolUseId: "call",
        rowUuid: "actual-row",
        permissionDecision: decision,
      },
    ],
  );
  assert.deepEqual(
    planNativePermissionDecisionAttachments(rows, "call", undefined),
    [],
  );
  assert.deepEqual(rows, before);
  assert.equal(Object.hasOwn(rows[0] ?? {}, "permissionDecision"), false);
});
