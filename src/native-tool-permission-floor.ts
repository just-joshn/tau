import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact,
  type NativePermissionOutcome,
  type NativePermissionProvenance,
  type NativePermissionReason,
  type NativePermissionRule,
  type NativePermissionScope,
} from "./native-permission-outcome.js";
import { nativePermissionReasonText as reason } from "./native-permission-reason-codes.js";

export interface NativeToolFloorPolicy {
  scope: NativePermissionScope;
  mode: string;
  alwaysAskRules: Readonly<Record<string, readonly string[] | undefined>>;
}

export interface NativePermissionCheckTool<Input> {
  name: string;
  /** Source checks property presence, including an explicitly undefined value. */
  classifierOnly?: unknown;
  mcpInfo?: unknown;
  requiresUserInteraction?: (() => boolean) | undefined;
  checkPermissions(
    input: Input,
  ): NativePermissionOutcome<Input> | Promise<NativePermissionOutcome<Input>>;
}

export interface NativeToolPermissionFloorOptions<Input> {
  planModeWriteFloor?: boolean | undefined;
  crashIsObjection?: boolean | undefined;
  hookAsked?: boolean | undefined;
  hookUpdatedInput?: Input | undefined;
  onChecked?: ((outcome: NativePermissionOutcome<Input>) => void) | undefined;
}

export interface NativeToolPermissionFloorHost<Input> {
  currentPolicy?: (
    phase: "before" | "after-check",
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativeToolFloorPolicy>;
  genericFloor?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{
    toolsHeldUntilPerson: boolean;
    allowedWhileHeld: boolean;
    hookAgentException: boolean;
    removedByPlugin: boolean;
    hostOwnedTool: boolean;
    wholeToolDeny: NativePermissionRule | null;
  }>;
  classifierDenyExemption?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  inputRule?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    policy: NativeToolFloorPolicy,
    behavior: "deny" | "ask",
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionRule | null>;
  wholeToolAsk?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{
    rule: NativePermissionRule;
    inItsPlace?: NativePermissionOutcome<Input> | undefined;
  } | null>;
  sandboxAsk?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{ eligible: boolean; suspended: boolean }>;
  parseInput?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    scope: NativePermissionScope,
  ) => NativePermissionFact<{ parsedInput: Input; keysSetAside: boolean }>;
  checked?: (
    tool: NativePermissionCheckTool<Input>,
    parsedInput: Input,
    outcome: NativePermissionOutcome<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<void>;
  recoverCheckError?: (
    error: unknown,
    tool: NativePermissionCheckTool<Input>,
    originalInput: Input,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input> | undefined>;
  permissionMessage?: (
    tool: NativePermissionCheckTool<Input>,
    reason: NativePermissionReason<Input> | undefined,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  denyRuleMessage?: (
    tool: NativePermissionCheckTool<Input>,
    rule: NativePermissionRule,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  heldMessage?: (
    tool: NativePermissionCheckTool<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  sessionWriteGateAbsent?: (
    tool: NativePermissionCheckTool<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  parsedPlanWriteFloor?: (
    tool: NativePermissionCheckTool<Input>,
    input: Input,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  planWriteWouldMutate?: (
    tool: NativePermissionCheckTool<Input>,
    originalInput: Input,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  classifierOnlyDeclared?: (
    tool: NativePermissionCheckTool<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  reviewFloor?: (
    kind: "classifier" | "sandbox-network" | "desktop",
    tool: NativePermissionCheckTool<Input>,
    originalInput: Input,
    policy: NativeToolFloorPolicy,
    current: NativePermissionOutcome<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionOutcome<Input> | undefined>;
  requiresInteraction?: (
    tool: NativePermissionCheckTool<Input>,
    hookUpdatedInput: Input | undefined,
    metadata: NativePermissionOutcome<Input>["metadata"],
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  hardAskReason?: (
    reason: NativePermissionReason<Input> | undefined,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  needsSpecialApproval?: (
    tool: NativePermissionCheckTool<Input>,
    current: NativePermissionOutcome<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  specialApprovalException?: (
    current: NativePermissionOutcome<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  specialApprovalReason?: (
    tool: NativePermissionCheckTool<Input>,
    scope: NativePermissionScope,
  ) => NativePermissionFact<string>;
  planBypassAvailable?: (
    tool: NativePermissionCheckTool<Input>,
    current: NativePermissionOutcome<Input>,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  relaxedPlanGate?: (
    tool: NativePermissionCheckTool<Input>,
    policy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  mcpPolicyIncludesTool?: (
    tool: NativePermissionCheckTool<Input>,
    initialPolicy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<boolean>;
  currentWholeAskRule?: (
    tool: NativePermissionCheckTool<Input>,
    currentPolicy: NativeToolFloorPolicy,
    scope: NativePermissionScope,
  ) => NativePermissionFact<NativePermissionRule | null>;
}

export interface NativeToolPermissionFloorEffect<Input> {
  type: "mcp-incomplete-ask-reason" | "whole-ask-rule-checked";
  reason: NativePermissionReason<Input>;
}

export type NativeToolPermissionFloorResult<Input> =
  | {
      status: "evaluated";
      outcome: NativePermissionOutcome<Input> | null;
      facts: readonly NativePermissionProvenance[];
      effects: readonly NativeToolPermissionFloorEffect<Input>[];
    }
  | {
      status: "unsupported";
      dependency: string;
      reason: string;
      facts: readonly NativePermissionProvenance[];
      effects: readonly NativeToolPermissionFloorEffect<Input>[];
    };

class Evaluation<Input> {
  readonly facts: NativePermissionProvenance[] = [];
  readonly effects: NativeToolPermissionFloorEffect<Input>[] = [];
  constructor(
    readonly scope: NativePermissionScope,
    readonly host: NativeToolPermissionFloorHost<Input>,
    readonly tool: NativePermissionCheckTool<Input>,
    readonly input: Input,
  ) {}
  need<T>(value: T | undefined, name: string): T {
    if (value === undefined)
      throw new NativePermissionDependencyError(
        name,
        "Required source-backed host capability is unavailable",
      );
    return value;
  }
  read<T>(fact: NativePermissionFact<T>): T {
    return readNativePermissionFact(fact, this.scope, this.facts);
  }
  message(reason?: NativePermissionReason<Input>): string {
    return this.read(
      this.need(this.host.permissionMessage, "El")(
        this.tool,
        reason,
        this.scope,
      ),
    );
  }
  policy(phase: "before" | "after-check"): NativeToolFloorPolicy {
    return this.read(
      this.need(this.host.currentPolicy, "ee")(phase, this.scope),
    );
  }
  checkIncomplete(
    outcome: NativePermissionOutcome<Input>,
    rule: NativePermissionRule,
  ): NativePermissionOutcome<Input> {
    if (rule.source !== "mcpServerPolicy")
      return { ...outcome, checkIncomplete: true };
    const actualReason = outcome.decisionReason ?? { type: "rule", rule };
    this.effects.push({
      type: "mcp-incomplete-ask-reason",
      reason: actualReason,
    });
    return { ...outcome, decisionReason: actualReason };
  }
  report(parsedInput: Input, outcome: NativePermissionOutcome<Input>): void {
    this.read(
      this.need(this.host.checked, "Jjo")(
        this.tool,
        parsedInput,
        outcome,
        this.scope,
      ),
    );
  }
}

function conclusive<Input>(
  outcome: NativePermissionOutcome<Input> | undefined,
): boolean {
  return (
    outcome !== undefined &&
    !(outcome.behavior === "ask" && outcome.checkIncomplete === true)
  );
}
function mcpAsk(reason: NativePermissionReason | undefined): boolean {
  return (
    reason?.type === "rule" &&
    reason.rule.ruleBehavior === "ask" &&
    reason.rule.source === "mcpServerPolicy"
  );
}
function safety<Input>(
  reason: NativePermissionReason<Input> | undefined,
): boolean {
  if (reason?.type === "safetyCheck") return true;
  return (
    reason?.type === "subcommandResults" &&
    [...reason.reasons.values()].some((outcome) =>
      safety(outcome.decisionReason),
    )
  );
}

async function wholeAsk<Input>(
  evaluation: Evaluation<Input>,
  policy: NativeToolFloorPolicy,
  rule: NativePermissionRule,
  inItsPlace: NativePermissionOutcome<Input> | undefined,
  options: NativeToolPermissionFloorOptions<Input>,
): Promise<NativePermissionOutcome<Input>> {
  const { host, tool, input, scope } = evaluation,
    ruleReason: NativePermissionReason<Input> = { type: "rule", rule },
    fallback: NativePermissionOutcome<Input> = {
      behavior: "ask",
      decisionReason: ruleReason,
      message: evaluation.message(),
    };
  let keysSetAside = false;
  try {
    const parsed = evaluation.read(
      evaluation.need(host.parseInput, "cge")(tool, input, scope),
    );
    keysSetAside = parsed.keysSetAside;
    const actual = await tool.checkPermissions(parsed.parsedInput);
    evaluation.report(parsed.parsedInput, actual);
    if (actual.behavior === "deny") return actual;
    if (inItsPlace?.behavior === "deny") return inItsPlace;
    if (actual.behavior === "ask") {
      const { suggestions: _suggestions, ...retained } = actual,
        replacement = inItsPlace,
        useReplacement =
          replacement?.behavior === "ask" &&
          (replacement.personOnly === true ||
            (rule.source !== "mcpServerPolicy" &&
              mcpAsk(actual.decisionReason) &&
              actual.personOnly !== true)) &&
          !(
            actual.personOnly === true &&
            actual.defaultToNo === true &&
            actual.suppressAlwaysAllowRule === true &&
            actual.hooksMayAllow !== true &&
            (actual.message ?? "").includes(replacement.message ?? "")
          ),
        ask = useReplacement
          ? {
              ...replacement,
              ...(actual.checkIncomplete
                ? { checkIncomplete: actual.checkIncomplete }
                : {}),
              matchedAskRule: rule,
            }
          : { ...retained, matchedAskRule: rule };
      return keysSetAside ? evaluation.checkIncomplete(ask, rule) : ask;
    }
    evaluation.effects.push({
      type: "whole-ask-rule-checked",
      reason: ruleReason,
    });
  } catch (error) {
    if (error instanceof NativePermissionDependencyError) throw error;
    const recovered = evaluation.read(
      evaluation.need(host.recoverCheckError, "iEt")(error, tool, input, scope),
    );
    if (recovered?.behavior === "deny") return recovered;
    keysSetAside = true;
    if (inItsPlace?.behavior === "deny") return inItsPlace;
    if (!conclusive(recovered) && options.crashIsObjection === true) {
      const actualReason: NativePermissionReason<Input> = {
        type: "other",
        reason: "permission_check_crashed",
      };
      return {
        behavior: "ask",
        message: evaluation.message(actualReason),
        decisionReason: actualReason,
      };
    }
  }
  const result =
    inItsPlace?.behavior === "ask" && inItsPlace.decisionReason?.type !== "rule"
      ? { ...inItsPlace, matchedAskRule: rule }
      : (inItsPlace ?? fallback);
  return keysSetAside && result.behavior === "ask"
    ? evaluation.checkIncomplete(result, rule)
    : result;
}

async function floor<Input>(
  evaluation: Evaluation<Input>,
  options: NativeToolPermissionFloorOptions<Input>,
): Promise<NativePermissionOutcome<Input> | null> {
  const { host, tool, input, scope } = evaluation,
    initial = evaluation.policy("before"),
    early = evaluation.read(
      evaluation.need(host.genericFloor, "qQn")(tool, input, initial, scope),
    );
  if (
    early.toolsHeldUntilPerson &&
    !early.allowedWhileHeld &&
    !early.hookAgentException
  )
    return {
      behavior: "deny",
      decisionReason: { type: "other", reason: reason.toolsHeld },
      message: evaluation.read(
        evaluation.need(host.heldMessage, "HIo")(tool, scope),
      ),
    };
  if (!early.hostOwnedTool && early.removedByPlugin)
    return {
      behavior: "deny",
      decisionReason: {
        type: "other",
        reason: "tool.list hooks removed this tool",
        label: "toolRemovedByPlugin",
      },
      message: `${tool.name} is not available: a plugin removed it from this session.`,
    };
  let denyExemption: boolean | undefined;
  const exemption = () =>
    (denyExemption ??= evaluation.read(
      evaluation.need(host.classifierDenyExemption, "hIe")(
        tool,
        input,
        initial,
        scope,
      ),
    ));
  if (
    early.wholeToolDeny !== null &&
    !("classifierOnly" in tool && exemption())
  )
    return {
      behavior: "deny",
      decisionReason: { type: "rule", rule: early.wholeToolDeny },
      message: `Permission to use ${tool.name} has been denied.`,
    };
  const denied = evaluation.read(
    evaluation.need(host.inputRule, "Gc/deny")(
      tool,
      input,
      initial,
      "deny",
      scope,
    ),
  );
  if (denied && !exemption())
    return {
      behavior: "deny",
      decisionReason: { type: "rule", rule: denied },
      message: evaluation.read(
        evaluation.need(host.denyRuleMessage, "E5t")(tool, denied, scope),
      ),
    };
  const whole = evaluation.read(
    evaluation.need(host.wholeToolAsk, "YQn")(tool, input, initial, scope),
  );
  if (whole) {
    const sandbox =
      tool.name === "Bash"
        ? evaluation.read(
            evaluation.need(host.sandboxAsk, "KT/sandbox-ask")(
              tool,
              input,
              initial,
              scope,
            ),
          )
        : { eligible: false, suspended: false };
    if (!(
      sandbox.eligible &&
      !sandbox.suspended &&
      !initial.alwaysAskRules.command?.includes("Bash")
    ))
      return wholeAsk(
        evaluation,
        initial,
        whole.rule,
        whole.inItsPlace,
        options,
      );
  }
  let current: NativePermissionOutcome<Input> = {
    behavior: "passthrough",
    message: evaluation.message(),
  };
  const gateAbsent = () =>
    evaluation.read(
      evaluation.need(host.sessionWriteGateAbsent, "cpe")(tool, scope),
    );
  const planAsk = (): NativePermissionOutcome<Input> => ({
    behavior: "ask",
    message: `Cannot call ${tool.name} while in plan mode.`,
    decisionReason: { type: "mode", mode: "plan" },
  });
  try {
    const parsed = evaluation.read(
      evaluation.need(host.parseInput, "cge")(tool, input, scope),
    );
    current = await tool.checkPermissions(parsed.parsedInput);
    options.onChecked?.(current);
    evaluation.report(parsed.parsedInput, current);
    if (
      options.planModeWriteFloor === true &&
      gateAbsent() &&
      current.behavior === "passthrough" &&
      evaluation.read(
        evaluation.need(host.parsedPlanWriteFloor, "sEt")(
          tool,
          parsed.parsedInput,
          initial,
          scope,
        ),
      )
    )
      return planAsk();
  } catch (error) {
    if (error instanceof NativePermissionDependencyError) throw error;
    const recovered = evaluation.read(
      evaluation.need(host.recoverCheckError, "iEt")(error, tool, input, scope),
    );
    if (recovered !== undefined && conclusive(recovered)) current = recovered;
    else if (
      options.crashIsObjection === true &&
      !evaluation.read(
        evaluation.need(host.classifierOnlyDeclared, "wD")(tool, scope),
      )
    ) {
      const actualReason: NativePermissionReason<Input> = {
        type: "other",
        reason: "permission_check_crashed",
      };
      return {
        behavior: "ask",
        message: evaluation.message(actualReason),
        decisionReason: actualReason,
      };
    }
    if (
      options.planModeWriteFloor === true &&
      gateAbsent() &&
      current.behavior === "passthrough" &&
      evaluation.read(
        evaluation.need(host.planWriteWouldMutate, "PJ")(
          tool,
          input,
          initial,
          scope,
        ),
      )
    )
      return planAsk();
  }
  for (const kind of ["classifier", "sandbox-network", "desktop"] as const) {
    const reviewed = evaluation.read(
      evaluation.need(host.reviewFloor, "Zdt/zK/qdt")(
        kind,
        tool,
        input,
        initial,
        current,
        scope,
      ),
    );
    if (reviewed !== undefined) current = reviewed;
  }
  if (current.behavior === "deny") return current;
  const asked = evaluation.read(
    evaluation.need(host.inputRule, "Gc/ask")(
      tool,
      input,
      initial,
      "ask",
      scope,
    ),
  );
  if (asked)
    return current.behavior === "ask"
      ? { ...current, matchedAskRule: asked }
      : {
          behavior: "ask",
          decisionReason: { type: "rule", rule: asked },
          message: evaluation.message(),
        };
  const interaction = evaluation.read(
    evaluation.need(host.requiresInteraction, "Dzn")(
      tool,
      options.hookUpdatedInput,
      current.behavior === "ask" ? current.metadata : undefined,
      scope,
    ),
  );
  if (
    interaction &&
    !(options.hookAsked === true && !tool.requiresUserInteraction?.())
  )
    return current.behavior === "ask"
      ? current
      : {
          behavior: "ask",
          message: evaluation.message(),
          decisionReason: { type: "other", reason: "requiresUserInteraction" },
        };
  if (
    current.behavior === "ask" &&
    (evaluation.read(
      evaluation.need(host.hardAskReason, "t6t")(current.decisionReason, scope),
    ) ||
      current.matchedAskRule?.ruleBehavior === "ask")
  )
    return current;
  if (
    evaluation.read(
      evaluation.need(host.needsSpecialApproval, "G1")(tool, current, scope),
    )
  ) {
    if (
      (current.behavior === "ask" && current.orgLimit !== undefined) ||
      evaluation.read(
        evaluation.need(host.specialApprovalException, "OQn")(current, scope),
      )
    )
      return current;
    const actualReason: NativePermissionReason<Input> = {
      type: "other",
      reason: evaluation.read(
        evaluation.need(host.specialApprovalReason, "cNr")(tool, scope),
      ),
    };
    return {
      behavior: "ask",
      message: evaluation.message(actualReason),
      decisionReason: actualReason,
      ...(current.behavior === "ask" && current.defaultToNo === true
        ? { defaultToNo: true }
        : {}),
    };
  }
  if (
    options.hookAsked === true &&
    current.behavior === "ask" &&
    current.wholeToolRuleDoesNotCover === true
  )
    return current;
  const late = evaluation.policy("after-check"),
    bypass = () =>
      evaluation.read(
        evaluation.need(host.planBypassAvailable, "tEt/oa")(
          tool,
          current,
          late,
          scope,
        ),
      );
  if (
    current.behavior === "ask" &&
    (safety(current.decisionReason) ||
      current.decisionReason?.type === "sandboxOverride" ||
      (options.planModeWriteFloor === true &&
        current.decisionReason?.type === "mode" &&
        current.decisionReason.mode === "plan" &&
        !bypass()))
  )
    return current;
  if (
    options.planModeWriteFloor === true &&
    (gateAbsent() ||
      evaluation.read(
        evaluation.need(host.relaxedPlanGate, "Iks")(tool, late, scope),
      )) &&
    !tool.requiresUserInteraction?.() &&
    !bypass() &&
    evaluation.read(
      evaluation.need(host.planWriteWouldMutate, "PJ")(
        tool,
        input,
        late,
        scope,
      ),
    )
  )
    return current.behavior === "ask"
      ? current
      : { behavior: "ask", message: evaluation.message() };
  if (
    tool.mcpInfo !== undefined &&
    evaluation.read(
      evaluation.need(host.mcpPolicyIncludesTool, "CAe/ei")(
        tool,
        initial,
        scope,
      ),
    )
  ) {
    const rule = evaluation.read(
      evaluation.need(host.currentWholeAskRule, "ra")(tool, late, scope),
    );
    if (rule) {
      if (current.behavior === "ask") {
        const { suggestions: _suggestions, ...retained } = current;
        return { ...retained, matchedAskRule: rule };
      }
      return {
        behavior: "ask",
        decisionReason: { type: "rule", rule },
        message: evaluation.message(),
      };
    }
  }
  return null;
}

/** KT objection floor only: null must continue the actual outer permission pipeline. */
export async function evaluateNativeToolPermissionFloor<Input>(options: {
  tool: NativePermissionCheckTool<Input>;
  input: Input;
  scope: NativePermissionScope;
  host: NativeToolPermissionFloorHost<Input>;
  options?: NativeToolPermissionFloorOptions<Input> | undefined;
}): Promise<NativeToolPermissionFloorResult<Input>> {
  const evaluation = new Evaluation(
    options.scope,
    options.host,
    options.tool,
    options.input,
  );
  try {
    const outcome = await floor(evaluation, options.options ?? {});
    return {
      status: "evaluated",
      outcome,
      facts: Object.freeze(evaluation.facts.slice()),
      effects: Object.freeze(evaluation.effects.slice()),
    };
  } catch (error) {
    if (!(error instanceof NativePermissionDependencyError)) throw error;
    return {
      status: "unsupported",
      dependency: error.dependency,
      reason: error.reason,
      facts: Object.freeze(evaluation.facts.slice()),
      effects: Object.freeze(evaluation.effects.slice()),
    };
  }
}
