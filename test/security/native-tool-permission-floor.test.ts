import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  evaluateNativeToolPermissionFloor,
  type NativePermissionCheckTool,
  type NativeToolFloorPolicy,
  type NativeToolPermissionFloorHost,
  type NativeToolPermissionFloorOptions,
  type NativeToolPermissionFloorResult,
} from "../../src/native-tool-permission-floor.js";
import type {
  NativePermissionFact,
  NativePermissionOutcome,
  NativePermissionRule,
} from "../../src/native-permission-outcome.js";

type Input = { value: string };
const scope = { policyId: "policy", cwd: "/actual/check" };
const fact = <T>(value: T): NativePermissionFact<T> => ({
  status: "known",
  value,
  provenance: { provider: "authored", sourceContracts: ["KT"], scope },
});
const policy: NativeToolFloorPolicy = {
  scope,
  mode: "default",
  alwaysAskRules: {},
};
const input = { value: "original" };
const allow: NativePermissionOutcome<Input> = {
  behavior: "allow",
  updatedInput: input,
};
const ask: NativePermissionOutcome<Input> = {
  behavior: "ask",
  message: "actual ask",
};
const deny: NativePermissionOutcome<Input> = {
  behavior: "deny",
  message: "actual deny",
};
const pass: NativePermissionOutcome<Input> = { behavior: "passthrough" };
const rule: NativePermissionRule = {
  source: "userSettings",
  ruleBehavior: "ask",
  ruleValue: { toolName: "Read" },
};
const early = {
  toolsHeldUntilPerson: false,
  allowedWhileHeld: false,
  hookAgentException: false,
  removedByPlugin: false,
  hostOwnedTool: true,
  wholeToolDeny: null,
};
function host(
  changes: Partial<NativeToolPermissionFloorHost<Input>> = {},
): NativeToolPermissionFloorHost<Input> {
  return {
    currentPolicy: () => fact(policy),
    genericFloor: () => fact(early),
    classifierDenyExemption: () => fact(false),
    inputRule: () => fact(null),
    wholeToolAsk: () => fact(null),
    sandboxAsk: () => fact({ eligible: false, suspended: false }),
    parseInput: (_tool, original) =>
      fact({ parsedInput: original, keysSetAside: false }),
    checked: () => fact(undefined),
    recoverCheckError: () => fact(undefined),
    permissionMessage: (_tool, reason) =>
      fact(
        reason?.type === "other" ? reason.reason : "actual approval message",
      ),
    denyRuleMessage: () => fact("actual rule denial"),
    heldMessage: () => fact("tools held"),
    sessionWriteGateAbsent: () => fact(true),
    parsedPlanWriteFloor: () => fact(false),
    planWriteWouldMutate: () => fact(false),
    classifierOnlyDeclared: () => fact(false),
    reviewFloor: () => fact(undefined),
    requiresInteraction: () => fact(false),
    hardAskReason: () => fact(false),
    needsSpecialApproval: () => fact(false),
    specialApprovalException: () => fact(false),
    specialApprovalReason: () => fact("actual special approval"),
    planBypassAvailable: () => fact(false),
    relaxedPlanGate: () => fact(false),
    mcpPolicyIncludesTool: () => fact(false),
    currentWholeAskRule: () => fact(null),
    ...changes,
  };
}
async function run(
  changes: Partial<NativeToolPermissionFloorHost<Input>> = {},
  options: NativeToolPermissionFloorOptions<Input> = {},
  check: NativePermissionCheckTool<Input>["checkPermissions"] = () => allow,
  toolChanges: Partial<NativePermissionCheckTool<Input>> = {},
): Promise<NativeToolPermissionFloorResult<Input>> {
  return evaluateNativeToolPermissionFloor({
    tool: { name: "Read", checkPermissions: check, ...toolChanges },
    input,
    scope,
    host: host(changes),
    options,
  });
}
function outcome(
  result: NativeToolPermissionFloorResult<Input>,
): NativePermissionOutcome<Input> | null {
  if (result.status !== "evaluated")
    throw new Error(`${result.dependency}: ${result.reason}`);
  return result.outcome;
}

test("KT held and plugin-removed floors precede rules and actual tool check", async () => {
  const never = () => {
    throw new Error("tool must not run");
  };
  assert.deepEqual(
    outcome(
      await run(
        {
          genericFloor: () => fact({ ...early, toolsHeldUntilPerson: true }),
          inputRule: never,
        },
        {},
        never,
      ),
    )?.message,
    "tools held",
  );
  assert.equal(
    outcome(
      await run(
        {
          genericFloor: () =>
            fact({ ...early, removedByPlugin: true, hostOwnedTool: false }),
        },
        {},
        never,
      ),
    )?.decisionReason?.type,
    "other",
  );
  assert.equal(
    outcome(
      await run({
        genericFloor: () =>
          fact({ ...early, removedByPlugin: true, hostOwnedTool: true }),
      }),
    ),
    null,
  );
});

test("whole-tool deny uses classifierOnly property presence and real exemption", async () => {
  const changes = {
    genericFloor: () => fact({ ...early, wholeToolDeny: rule }),
    classifierDenyExemption: () => fact(true),
  };
  assert.equal(outcome(await run(changes))?.behavior, "deny");
  assert.equal(
    outcome(await run(changes, {}, () => allow, { classifierOnly: undefined })),
    null,
  );
  assert.equal(
    outcome(
      await run({
        inputRule: (_tool, _input, _policy, behavior) =>
          fact(behavior === "deny" ? rule : null),
      }),
    )?.message,
    "actual rule denial",
  );
});

test("whole-tool ask performs actual check and preserves deny before inItsPlace", async () => {
  let checks = 0;
  const result = await run(
    { wholeToolAsk: () => fact({ rule, inItsPlace: ask }) },
    {},
    () => {
      checks++;
      return deny;
    },
  );
  assert.equal(outcome(result), deny);
  assert.equal(checks, 1);
});

test("whole-tool ask removes suggestions and records actual incomplete-key semantics", async () => {
  const changes = {
    wholeToolAsk: () => fact({ rule }),
    parseInput: () => fact({ parsedInput: input, keysSetAside: true }),
  };
  const result = await run(changes, {}, () => ({
    ...ask,
    suggestions: [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
  }));
  assert.equal(outcome(result)?.matchedAskRule, rule);
  assert.equal(outcome(result)?.suggestions, undefined);
  assert.equal(outcome(result)?.checkIncomplete, true);
  const mcp = { ...rule, source: "mcpServerPolicy" };
  const policyResult = await run(
    { ...changes, wholeToolAsk: () => fact({ rule: mcp }) },
    {},
    () => ask,
  );
  assert.equal(outcome(policyResult)?.checkIncomplete, undefined);
  assert.equal(policyResult.effects[0]?.type, "mcp-incomplete-ask-reason");
});

test("successful whole-ask check still asks and preserves its source identity sidechannel", async () => {
  const result = await run({
    wholeToolAsk: () => fact({ rule }),
    sandboxAsk: () => {
      throw new Error("non-Bash never queries sandbox");
    },
  });
  assert.equal(outcome(result)?.behavior, "ask");
  assert.equal(result.effects[0]?.type, "whole-ask-rule-checked");
  assert.equal(outcome(result)?.decisionReason, result.effects[0]?.reason);
});

test("sandbox whole-ask exception needs eligible unsuspended Bash without explicit command ask", async () => {
  const changes = {
    wholeToolAsk: () => fact({ rule }),
    sandboxAsk: () => fact({ eligible: true, suspended: false }),
  };
  assert.equal(
    outcome(await run(changes, {}, () => allow, { name: "Bash" })),
    null,
  );
  assert.equal(
    outcome(
      await run(
        {
          ...changes,
          currentPolicy: () =>
            fact({ ...policy, alwaysAskRules: { command: ["Bash"] } }),
        },
        {},
        () => allow,
        { name: "Bash" },
      ),
    )?.behavior,
    "ask",
  );
  assert.equal(
    outcome(
      await run(
        {
          ...changes,
          sandboxAsk: () => fact({ eligible: true, suspended: true }),
        },
        {},
        () => allow,
        { name: "Bash" },
      ),
    )?.behavior,
    "ask",
  );
});

test("normal check uses parsed input but generic rule queries keep original input and callback order", async () => {
  const seen: string[] = [],
    parsed = { value: "parsed" };
  const result = await run(
    {
      parseInput: () => fact({ parsedInput: parsed, keysSetAside: false }),
      inputRule: (_tool, checked, _policy, behavior) => {
        seen.push(`${behavior}:${checked.value}`);
        return fact(null);
      },
      checked: (_tool, checked, actual) => {
        seen.push(`reported:${checked.value}:${actual.behavior}`);
        return fact(undefined);
      },
    },
    { onChecked: (actual) => seen.push(`callback:${actual.behavior}`) },
    (checked) => {
      seen.push(`checked:${checked.value}`);
      return allow;
    },
  );
  assert.equal(outcome(result), null);
  assert.deepEqual(seen, [
    "deny:original",
    "checked:parsed",
    "callback:allow",
    "reported:parsed:allow",
    "ask:original",
  ]);
});

test("check errors retain actual recovery, crash objection and abort propagation", async () => {
  const failure = () => {
    throw new Error("actual check failed");
  };
  assert.equal(
    outcome(await run({ recoverCheckError: () => fact(deny) }, {}, failure)),
    deny,
  );
  assert.equal(
    outcome(await run({}, { crashIsObjection: true }, failure))?.decisionReason
      ?.type,
    "other",
  );
  assert.equal(
    outcome(
      await run(
        { classifierOnlyDeclared: () => fact(true) },
        { crashIsObjection: true },
        failure,
      ),
    ),
    null,
  );
  const aborted = new Error("actual abort");
  await assert.rejects(
    () =>
      run(
        {
          recoverCheckError: () => {
            throw aborted;
          },
        },
        {},
        failure,
      ),
    (error) => error === aborted,
  );
});

test("parsed passthrough plan-write floor runs before review and respects session gate", async () => {
  const changes = {
    parsedPlanWriteFloor: () => fact(true),
    reviewFloor: () => {
      throw new Error("plan is earlier");
    },
  };
  assert.deepEqual(
    outcome(await run(changes, { planModeWriteFloor: true }, () => pass))
      ?.decisionReason,
    { type: "mode", mode: "plan" },
  );
  assert.equal(
    outcome(
      await run(
        {
          sessionWriteGateAbsent: () => fact(false),
          parsedPlanWriteFloor: () => {
            throw new Error("gate prevents parsed floor");
          },
        },
        { planModeWriteFloor: true },
        () => pass,
      ),
    ),
    null,
  );
});

test("classifier, network and desktop review floors run in source order before scoped ask", async () => {
  const seen: string[] = [];
  const result = await run({
    reviewFloor: (kind, _tool, _input, _policy, current) => {
      seen.push(`${kind}:${current.behavior}`);
      return fact(
        kind === "classifier" ? ask : kind === "desktop" ? deny : undefined,
      );
    },
    inputRule: (_tool, _input, _policy, behavior) => {
      if (behavior === "ask") throw new Error("deny is earlier");
      return fact(null);
    },
  });
  assert.equal(outcome(result), deny);
  assert.deepEqual(seen, [
    "classifier:allow",
    "sandbox-network:ask",
    "desktop:ask",
  ]);
});

test("scoped ask follows checks, preserving actual ask metadata and matched rule", async () => {
  const changes = {
    inputRule: (
      _tool: NativePermissionCheckTool<Input>,
      _input: Input,
      _policy: NativeToolFloorPolicy,
      behavior: "deny" | "ask",
    ) => fact(behavior === "ask" ? rule : null),
  };
  assert.equal(outcome(await run(changes))?.decisionReason?.type, "rule");
  assert.deepEqual(
    outcome(
      await run(changes, {}, () => ({ ...ask, metadata: { actual: true } })),
    )?.metadata,
    { actual: true },
  );
});

test("interaction hook-asked exception and declared interaction remain distinct", async () => {
  const changes = { requiresInteraction: () => fact(true) };
  assert.equal(outcome(await run(changes))?.decisionReason?.type, "other");
  assert.equal(outcome(await run(changes, { hookAsked: true })), null);
  assert.equal(
    outcome(
      await run(changes, { hookAsked: true }, () => allow, {
        requiresUserInteraction: () => true,
      }),
    )?.behavior,
    "ask",
  );
});

test("hard asks and special approval retain actual org/default facts", async () => {
  assert.equal(
    outcome(await run({ hardAskReason: () => fact(true) }, {}, () => ask)),
    ask,
  );
  const limited = { ...ask, orgLimit: { actual: true } };
  assert.equal(
    outcome(
      await run(
        {
          needsSpecialApproval: () => fact(true),
          specialApprovalException: () => {
            throw new Error("org limit is earlier");
          },
        },
        {},
        () => limited,
      ),
    ),
    limited,
  );
  const special = outcome(
    await run({ needsSpecialApproval: () => fact(true) }, {}, () => ({
      ...ask,
      defaultToNo: true,
    })),
  );
  assert.equal(special?.defaultToNo, true);
  assert.deepEqual(special?.decisionReason, {
    type: "other",
    reason: "actual special approval",
  });
});

test("hook uncovered whole-tool ask returns before late policy and nested safety ignores bypass", async () => {
  const uncovered = { ...ask, wholeToolRuleDoesNotCover: true };
  assert.equal(
    outcome(
      await run(
        {
          currentPolicy: (phase) => {
            if (phase === "after-check") throw new Error("hook ask is earlier");
            return fact(policy);
          },
        },
        { hookAsked: true },
        () => uncovered,
      ),
    ),
    uncovered,
  );
  const guarded: NativePermissionOutcome<Input> = {
    ...ask,
    decisionReason: {
      type: "subcommandResults",
      reasons: new Map([
        [
          "other",
          {
            behavior: "deny",
            decisionReason: {
              type: "safetyCheck",
              reason: "actual nested floor",
            },
          },
        ],
      ]),
    },
  };
  assert.equal(
    outcome(
      await run(
        {
          planBypassAvailable: () => {
            throw new Error("safety is earlier");
          },
        },
        { planModeWriteFloor: true },
        () => guarded,
      ),
    ),
    guarded,
  );
});

test("plan ask and final write floor require actual bypass/readonly/session facts", async () => {
  const planned: NativePermissionOutcome<Input> = {
    ...ask,
    decisionReason: { type: "mode", mode: "plan" },
  };
  assert.equal(
    outcome(await run({}, { planModeWriteFloor: true }, () => planned)),
    planned,
  );
  assert.equal(
    outcome(
      await run(
        { planBypassAvailable: () => fact(true) },
        { planModeWriteFloor: true },
        () => planned,
      ),
    ),
    null,
  );
  const final = outcome(
    await run(
      { planWriteWouldMutate: () => fact(true) },
      { planModeWriteFloor: true },
    ),
  );
  assert.equal(final?.behavior, "ask");
  assert.equal(final?.decisionReason, undefined);
});

test("MCP policy ask strips suggestions and retains its actual matched rule", async () => {
  const changes = {
    mcpPolicyIncludesTool: () => fact(true),
    currentWholeAskRule: () => fact(rule),
  };
  const result = outcome(
    await run(
      changes,
      {},
      () => ({
        ...ask,
        suggestions: [
          { type: "setMode", mode: "default", destination: "session" },
        ],
      }),
      { mcpInfo: {} },
    ),
  );
  assert.equal(result?.matchedAskRule, rule);
  assert.equal(result?.suggestions, undefined);
  assert.equal(
    outcome(await run(changes, {}, () => allow, { mcpInfo: {} }))
      ?.decisionReason?.type,
    "rule",
  );
  assert.equal(
    outcome(
      await run({
        mcpPolicyIncludesTool: () => {
          throw new Error("non-MCP cannot query MCP policy");
        },
      }),
    ),
    null,
  );
});

test("missing or foreign facts stop the floor without manufacturing an accepted outcome", async () => {
  const missing = host();
  delete missing.parseInput;
  const result = await evaluateNativeToolPermissionFloor({
    tool: {
      name: "Read",
      checkPermissions: () => {
        throw new Error("parse capability is earlier");
      },
    },
    input,
    scope,
    host: missing,
  });
  assert.equal(result.status, "unsupported");
  const foreign = await run({
    currentPolicy: () => ({
      status: "known",
      value: policy,
      provenance: {
        provider: "foreign",
        sourceContracts: ["KT"],
        scope: { ...scope, policyId: "foreign" },
      },
    }),
  });
  assert.equal(foreign.status, "unsupported");
});
