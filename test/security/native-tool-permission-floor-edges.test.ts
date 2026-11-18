import { describe, expect, test } from "bun:test";
import {
  NativePermissionDependencyError,
  type NativePermissionFact,
  type NativePermissionOutcome,
  type NativePermissionRule,
} from "../../src/native-permission-outcome.js";
import {
  evaluateNativeToolPermissionFloor,
  type NativePermissionCheckTool,
  type NativeToolFloorPolicy,
  type NativeToolPermissionFloorHost,
  type NativeToolPermissionFloorOptions,
  type NativeToolPermissionFloorResult,
} from "../../src/native-tool-permission-floor.js";

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
const userRule: NativePermissionRule = {
  source: "userSettings",
  ruleBehavior: "ask",
  ruleValue: { toolName: "Read" },
};
const mcpRule: NativePermissionRule = {
  source: "mcpServerPolicy",
  ruleBehavior: "ask",
  ruleValue: { toolName: "mcp__server__tool" },
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
      fact(reason?.type === "other" ? reason.reason : "approval message"),
    denyRuleMessage: () => fact("rule denial"),
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
    specialApprovalReason: () => fact("special approval"),
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

const crash = () => {
  throw new Error("checker crashed");
};

/** Runs the whole-tool ask path with an optional outcome standing in for the rule. */
function whole(
  rule: NativePermissionRule,
  inItsPlace: NativePermissionOutcome<Input> | undefined,
  check: NativePermissionCheckTool<Input>["checkPermissions"],
  changes: Partial<NativeToolPermissionFloorHost<Input>> = {},
  options: NativeToolPermissionFloorOptions<Input> = {},
) {
  return run(
    { wholeToolAsk: () => fact({ rule, inItsPlace }), ...changes },
    options,
    check,
  );
}

describe("whole-tool ask rule", () => {
  test("a crashed check that recovers to a deny keeps the deny", async () => {
    const denied: NativePermissionOutcome<Input> = {
      behavior: "deny",
      message: "recovered deny",
    };
    expect(
      outcome(
        await whole(userRule, undefined, crash, {
          recoverCheckError: () => fact(denied),
        }),
      ),
    ).toEqual(denied);
  });

  test("a deny standing in for the rule wins over a crash or a non-deny check", async () => {
    const standIn: NativePermissionOutcome<Input> = {
      behavior: "deny",
      message: "stand-in deny",
    };
    expect(outcome(await whole(userRule, standIn, crash))).toEqual(standIn);
    expect(outcome(await whole(userRule, standIn, () => allow))).toEqual(
      standIn,
    );
  });

  test("a crash with no conclusive recovery is an objection when asked to be", async () => {
    const crashed: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "permission_check_crashed",
      decisionReason: { type: "other", reason: "permission_check_crashed" },
    };
    expect(
      outcome(
        await whole(userRule, undefined, crash, {}, { crashIsObjection: true }),
      ),
    ).toEqual(crashed);
    const incomplete: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "partial",
      checkIncomplete: true,
    };
    expect(
      outcome(
        await whole(
          userRule,
          undefined,
          crash,
          { recoverCheckError: () => fact(incomplete) },
          { crashIsObjection: true },
        ),
      ),
    ).toEqual(crashed);
  });

  test("a crash otherwise falls back to the rule ask, marked incomplete", async () => {
    expect(outcome(await whole(userRule, undefined, crash))).toEqual({
      behavior: "ask",
      message: "approval message",
      decisionReason: { type: "rule", rule: userRule },
      checkIncomplete: true,
    });
    const conclusive: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "recovered ask",
    };
    expect(
      outcome(
        await whole(
          userRule,
          undefined,
          crash,
          { recoverCheckError: () => fact(conclusive) },
          { crashIsObjection: true },
        ),
      ),
    ).toMatchObject({
      checkIncomplete: true,
      decisionReason: { type: "rule" },
    });
  });

  test("a missing host owner raised by the check is unsupported, not recovered", async () => {
    const result = await whole(userRule, undefined, () => {
      throw new NativePermissionDependencyError("owner", "missing owner");
    });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported")
      expect(result.dependency).toBe("owner");
  });

  test("an ask that a person must answer replaces the tool's own ask", async () => {
    const personOnly: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "person only",
      personOnly: true,
    };
    const actual: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "tool ask",
      checkIncomplete: true,
      suggestions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    };
    expect(outcome(await whole(userRule, personOnly, () => actual))).toEqual({
      ...personOnly,
      checkIncomplete: true,
      matchedAskRule: userRule,
    });
  });

  test("an MCP policy ask from the tool yields to the stand-in under a non-MCP rule", async () => {
    const standIn: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "stand-in ask",
    };
    const actual: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "tool ask",
      decisionReason: { type: "rule", rule: mcpRule },
    };
    expect(outcome(await whole(userRule, standIn, () => actual))).toEqual({
      ...standIn,
      matchedAskRule: userRule,
    });
    // Under the MCP policy rule itself, the tool's own ask is kept.
    expect(outcome(await whole(mcpRule, standIn, () => actual))).toEqual({
      ...actual,
      matchedAskRule: mcpRule,
    });
  });

  test("a stricter person-only ask that already says the same thing is kept", async () => {
    const standIn: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "confirm",
      personOnly: true,
    };
    const actual: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "please confirm",
      personOnly: true,
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
      suggestions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    };
    const { suggestions: _dropped, ...kept } = actual;
    expect(outcome(await whole(userRule, standIn, () => actual))).toEqual({
      ...kept,
      matchedAskRule: userRule,
    });
    expect(
      outcome(
        await whole(userRule, standIn, () => ({
          ...actual,
          hooksMayAllow: true,
        })),
      ),
    ).toEqual({ ...standIn, matchedAskRule: userRule });
  });

  test("set-aside input keys mark the ask incomplete, or carry the MCP reason", async () => {
    const actual: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "tool ask",
    };
    const parse = {
      parseInput: () => fact({ parsedInput: input, keysSetAside: true }),
    };
    expect(
      outcome(await whole(userRule, undefined, () => actual, parse)),
    ).toEqual({ ...actual, matchedAskRule: userRule, checkIncomplete: true });
    const mcp = await whole(mcpRule, undefined, () => actual, parse);
    expect(outcome(mcp)).toEqual({
      ...actual,
      matchedAskRule: mcpRule,
      decisionReason: { type: "rule", rule: mcpRule },
    });
    expect(mcp.effects).toEqual([
      {
        type: "mcp-incomplete-ask-reason",
        reason: { type: "rule", rule: mcpRule },
      },
    ]);
  });

  test("an allowed check keeps a non-rule stand-in ask and records the checked rule", async () => {
    const standIn: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "stand-in",
      decisionReason: { type: "other", reason: "stand-in" },
    };
    const result = await whole(userRule, standIn, () => allow);
    expect(outcome(result)).toEqual({ ...standIn, matchedAskRule: userRule });
    expect(result.effects).toEqual([
      {
        type: "whole-ask-rule-checked",
        reason: { type: "rule", rule: userRule },
      },
    ]);
    const ruleStandIn: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "rule stand-in",
      decisionReason: { type: "rule", rule: userRule },
    };
    expect(outcome(await whole(userRule, ruleStandIn, () => allow))).toEqual(
      ruleStandIn,
    );
  });
});

describe("later floors", () => {
  test("a hook ask skips the interaction floor only for tools that do not need a person", async () => {
    const interaction = { requiresInteraction: () => fact(true) };
    expect(outcome(await run(interaction, { hookAsked: true }))).toBeNull();
    expect(
      outcome(
        await run(interaction, { hookAsked: true }, () => allow, {
          requiresUserInteraction: () => true,
        }),
      ),
    ).toMatchObject({
      behavior: "ask",
      decisionReason: { type: "other", reason: "requiresUserInteraction" },
    });
    const ask: NativePermissionOutcome<Input> = {
      behavior: "ask",
      message: "tool ask",
    };
    expect(outcome(await run(interaction, {}, () => ask))).toEqual(ask);
  });

  test("a special-approval ask keeps the tool's default-to-no", async () => {
    const special = { needsSpecialApproval: () => fact(true) };
    expect(
      outcome(
        await run(special, {}, () => ({
          behavior: "ask",
          message: "tool ask",
          defaultToNo: true,
        })),
      ),
    ).toEqual({
      behavior: "ask",
      message: "special approval",
      decisionReason: { type: "other", reason: "special approval" },
      defaultToNo: true,
    });
  });

  test("a safety check inside subcommand results is kept as the final ask", async () => {
    const nested = (safety: boolean) =>
      run({}, {}, () => ({
        behavior: "ask",
        message: "compound",
        decisionReason: {
          type: "subcommandResults",
          reasons: new Map<string, NativePermissionOutcome<Input>>([
            ["ls", { behavior: "allow" }],
            [
              "rm",
              {
                behavior: "ask",
                decisionReason: safety
                  ? { type: "safetyCheck", reason: "rm needs care" }
                  : { type: "other", reason: "rm needs care" },
              },
            ],
          ]),
        },
      }));
    expect(outcome(await nested(true))?.message).toBe("compound");
    expect(outcome(await nested(false))).toBeNull();
  });

  test("a plan-mode write by a tool that needs a person is not re-asked here", async () => {
    expect(
      outcome(
        await run(
          { planWriteWouldMutate: () => fact(true) },
          { planModeWriteFloor: true },
          () => ({ behavior: "passthrough" }),
          { requiresUserInteraction: () => true },
        ),
      ),
    ).toBeNull();
    expect(
      outcome(
        await run(
          { planWriteWouldMutate: () => fact(true) },
          { planModeWriteFloor: true },
          () => ({ behavior: "passthrough" }),
          { requiresUserInteraction: () => false },
        ),
      ),
    ).toEqual({ behavior: "ask", message: "approval message" });
  });

  test("an MCP policy whole-tool ask keeps the tool's own ask without suggestions", async () => {
    const result = await run(
      {
        mcpPolicyIncludesTool: () => fact(true),
        currentWholeAskRule: () => fact(mcpRule),
      },
      {},
      () => ({
        behavior: "ask",
        message: "tool ask",
        suggestions: [
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
      }),
      { mcpInfo: { serverName: "server" } },
    );
    expect(outcome(result)).toEqual({
      behavior: "ask",
      message: "tool ask",
      matchedAskRule: mcpRule,
    });
  });

  test("a host failure that is not a missing owner propagates to the caller", async () => {
    const failure = new Error("policy store exploded");
    let caught: unknown;
    try {
      await run({
        currentPolicy: () => {
          throw failure;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});
