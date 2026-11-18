import type {
  NativePermissionBehavior,
  NativePermissionDecision,
  NativePermissionDecisionRecord,
  NativePermissionDecisionSource,
  NativePermissionOutcome,
  NativePermissionReason,
  NativePermissionRule,
} from "./native-permission-outcome.js";
import type { NativeJson, NativeObject } from "./native-session-codec.js";
import {
  nativePermissionCircuitBreakers,
  nativePermissionClassifierCategories,
  nativePermissionHookEvents,
  nativePermissionOtherLabels,
  nativePermissionReasonText as text,
} from "./native-permission-reason-codes.js";

export interface NativeRecordedPermissionDecision {
  decision?: NativePermissionDecision | undefined;
  source?: NativePermissionDecisionSource | undefined;
  grantScope?: string | undefined;
}

export interface NativePermissionFallback {
  decision: NativePermissionDecision;
  source: NativePermissionDecisionSource;
}

/** W4s: actual matching rule source, not the launch's storage scope. */
export function nativePermissionRuleDecisionSource(
  source: string,
  behavior: "allow" | "deny" | "ask",
): NativePermissionDecisionSource {
  if (source === "session")
    return behavior === "allow" ? "user_temporary" : "user_reject";
  if (source === "localSettings" || source === "userSettings")
    return behavior === "allow" ? "user_permanent" : "user_reject";
  return "config";
}

/** LOt: only a real prompt/hook/rule/abort reason supplies those sources. */
export function nativePermissionReasonDecisionSource(
  reason: NativePermissionReason | undefined,
  behavior: "allow" | "deny" | "ask",
): NativePermissionDecisionSource {
  if (!reason) return "config";
  switch (reason.type) {
    case "permissionPromptTool": {
      const source = reason.toolResult?.decisionClassification;
      if (
        source === "user_temporary" ||
        source === "user_permanent" ||
        source === "user_reject"
      )
        return source;
      return behavior === "allow" ? "user_temporary" : "user_reject";
    }
    case "rule":
      return nativePermissionRuleDecisionSource(reason.rule.source, behavior);
    case "hook":
      return "hook";
    case "other":
      return reason.reason === text.canUseToolAborted ? "user_abort" : "config";
    default:
      return "config";
  }
}

/** FFr deliberately has no accepted fallback for passthrough. */
export function nativePermissionFallback(
  outcome: NativePermissionOutcome,
  abortRequested: boolean,
): Readonly<NativePermissionFallback> | undefined {
  if (outcome.behavior === "allow" || outcome.behavior === "deny")
    return Object.freeze({
      decision: outcome.behavior === "allow" ? "accept" : "reject",
      source: nativePermissionReasonDecisionSource(
        outcome.decisionReason,
        outcome.behavior,
      ),
    });
  if (outcome.behavior === "ask")
    return Object.freeze({
      decision: "reject",
      source: abortRequested ? "user_abort" : "config",
    });
  return;
}

function prefix(value: string): string {
  const colon = value.indexOf(":");
  return colon < 0 ? value : value.slice(0, colon);
}

const otherCodes = new Map<string, string>([
  [text.sandboxAutoAllow, "sandboxAutoAllow"],
  [text.readOnlyCommand, "readOnlyCommand"],
  [text.restrictedMode, "restrictedMode"],
  [text.outsideReadsBlocked, "outsideReadsBlocked"],
  [text.outsideFileReadsBlocked, "outsideReadsBlocked"],
  [text.outsideWritesBlocked, "outsideWritesBlocked"],
  [text.settingsWritesBlocked, "outsideWritesBlocked"],
  [text.noProjectDirectory, "noProjectDirectory"],
  [text.toolsHeld, "toolsHeld"],
  [text.noConfigHome, "noConfigHome"],
  [text.classifierTranscriptTooLong, "classifierTranscriptTooLong"],
  [text.permissionStreamClosed, "permissionStreamClosed"],
  [text.canUseToolInvalidResult, "canUseToolInvalidResult"],
  [text.canUseToolRequestFailed, "canUseToolRequestFailed"],
  [text.canUseToolAborted, "canUseToolAborted"],
  [text.canUseToolHeldForMessage, "canUseToolHeldForMessage"],
]);

function classifierCode(
  reason: Extract<NativePermissionReason, { type: "classifier" }>,
): string {
  const classifier = reason.classifier === "auto-mode" ? "auto-mode" : "other";
  if (reason.reason === text.classifierUnavailable)
    return `classifier:${classifier}:unavailable`;
  if (reason.noVerdict) return `classifier:${classifier}:no-verdict`;
  return `classifier:${classifier}`;
}

/** Epo/OZ: source membership and nested behavior filtering, without telemetry. */
export function nativePermissionReasonCode(
  behavior: NativePermissionBehavior,
  reason?: NativePermissionReason,
  matchedAskRule?: NativePermissionRule,
  resolvedSource?: string,
): string {
  if (resolvedSource !== undefined && resolvedSource !== "config") {
    if (resolvedSource === "hook") return "hook:PermissionRequest";
    if (resolvedSource === "classifier" && reason?.type === "classifier")
      return classifierCode(reason);
    return resolvedSource;
  }
  if (reason?.type !== "rule" && matchedAskRule !== undefined)
    return `rule:${matchedAskRule.source}`;
  if (!reason) return "unknown";
  switch (reason.type) {
    case "rule":
      return `rule:${reason.rule.source}`;
    case "mode":
      return `mode:${reason.mode}`;
    case "hook": {
      const event = prefix(reason.hookName);
      return `hook:${nativePermissionHookEvents.has(event) ? event : "other"}`;
    }
    case "classifier":
      return classifierCode(reason);
    case "subcommandResults": {
      const codes = new Set<string>();
      for (const child of reason.reasons.values()) {
        if (
          (child.behavior !== behavior &&
            !(behavior === "ask" && child.behavior === "passthrough")) ||
          child.decisionReason === undefined
        )
          continue;
        const code = nativePermissionReasonCode(behavior, child.decisionReason);
        for (const part of behavior === "ask" && code.startsWith("subcommands:")
          ? code.slice(12).split("+")
          : [code])
          codes.add(part);
      }
      const first = codes.values().next().value;
      if (codes.size === 1 && first !== undefined) return first;
      if (codes.size > 1) {
        const aggregate =
          behavior === "ask" ? codes : new Set([...codes].map(prefix));
        return `subcommands:${[...aggregate].sort().join("+")}`;
      }
      return "subcommandResults";
    }
    case "other":
      return (
        otherCodes.get(reason.reason) ??
        (reason.bashMissKind !== undefined
          ? `bashMiss:${reason.bashMissKind}`
          : nativePermissionOtherLabels.has(reason.label ?? "other")
            ? (reason.label ?? "other")
            : "other")
      );
    case "asyncAgent":
      return reason.reason === text.hookRewrittenInputAsk
        ? "hookRewrittenInputAsk"
        : reason.reason === text.noApprovalSurface
          ? "noApprovalSurface"
          : "asyncAgent";
    case "safetyCheck":
      return reason.reason === text.outsideReadsBlocked
        ? "outsideReadsBlocked"
        : reason.reason === text.noConfigHome
          ? "noConfigHome"
          : "safetyCheck";
    case "permissionPromptTool":
    case "sandboxOverride":
    case "workingDir":
      return reason.type;
  }
}

function nestedRule(
  reason: NativePermissionReason | undefined,
  behavior: NativePermissionBehavior,
): NativePermissionRule | undefined {
  if (reason?.type !== "subcommandResults") return;
  for (const outcome of reason.reasons.values()) {
    const nested =
      outcome.behavior === behavior ? outcome.decisionReason : undefined;
    const rule =
      nested?.type === "rule" ? nested.rule : nestedRule(nested, behavior);
    if (rule !== undefined) return rule;
  }
  return;
}

/** gmo/Uoe: source deny remains deny; all other nested searches use ask. */
function ruleSource(
  reason: NativePermissionReason | undefined,
  behavior: NativePermissionBehavior,
): string | undefined {
  return reason?.type === "rule"
    ? reason.rule.source
    : nestedRule(reason, behavior === "deny" ? "deny" : "ask")?.source;
}

function circuitBreaker(
  reason: NativePermissionReason | undefined,
  behavior: NativePermissionBehavior,
): string | undefined {
  if (reason?.type === "safetyCheck") {
    const key = reason.circuitBreaker;
    return key !== undefined && nativePermissionCircuitBreakers.has(key)
      ? key
      : undefined;
  }
  if (reason?.type === "subcommandResults")
    for (const child of reason.reasons.values())
      if (child.behavior === behavior) {
        const found = circuitBreaker(child.decisionReason, behavior);
        if (found !== undefined) return found;
      }
  return;
}

interface SelectedReason {
  behavior: NativePermissionBehavior;
  reason: NativePermissionReason | undefined;
  matchedAskRule: NativePermissionRule | undefined;
}

function selectReason(
  outcome: NativePermissionOutcome,
  shown: NativePermissionOutcome | undefined,
  hideDirectReason: boolean,
): SelectedReason | undefined {
  const reason = outcome.decisionReason,
    decisiveRefusal =
      outcome.behavior !== "allow" &&
      (reason?.type === "hook" || reason?.type === "classifier");
  if (shown?.behavior === "ask" && !decisiveRefusal)
    return {
      behavior: "ask",
      reason: shown.decisionReason,
      matchedAskRule: shown.matchedAskRule,
    };
  if (
    outcome.behavior === "deny" &&
    reason?.type === "asyncAgent" &&
    reason.ask !== undefined
  )
    return {
      behavior: "ask",
      reason: reason.ask.decisionReason,
      matchedAskRule: reason.ask.matchedAskRule,
    };
  if (outcome.behavior !== "allow")
    return {
      behavior: outcome.behavior,
      reason,
      matchedAskRule: outcome.matchedAskRule,
    };
  if (hideDirectReason && reason?.type !== "permissionPromptTool")
    return { behavior: "ask", reason, matchedAskRule: outcome.matchedAskRule };
  return;
}

/** NVn/Bkt. Fallback and shown/recorded data must be actual invocation facts. */
export function normalizeNativePermissionDecision(options: {
  outcome: NativePermissionOutcome;
  recorded?: NativeRecordedPermissionDecision | undefined;
  fallback: NativePermissionFallback;
  shown?:
    | {
        answered?: NativePermissionOutcome | undefined;
        result?: NativePermissionOutcome | undefined;
      }
    | undefined;
}): Readonly<NativePermissionDecisionRecord> {
  const { outcome, recorded, fallback } = options;
  if (outcome.behavior === "passthrough")
    throw new TypeError("Passthrough is not a final native permission outcome");
  const decision =
      outcome.behavior === "allow"
        ? recorded?.decision || fallback.decision
        : "reject",
    source = recorded?.source || fallback.source,
    reason = outcome.decisionReason,
    hide =
      outcome.behavior === "ask" ||
      recorded?.source?.startsWith("user_") === true ||
      source === "user_abort" ||
      reason?.type === "permissionPromptTool",
    selected = selectReason(
      outcome,
      options.shown?.answered ?? options.shown?.result,
      hide,
    ),
    rule =
      ruleSource(reason, outcome.behavior) ??
      outcome.matchedAskRule?.source ??
      (selected &&
        (ruleSource(selected.reason, selected.behavior) ??
          selected.matchedAskRule?.source)),
    grant =
      decision !== "accept"
        ? undefined
        : (recorded?.grantScope ??
          (outcome.behavior === "allow" ? outcome.grantScope : undefined)),
    circuit = selected && circuitBreaker(selected.reason, selected.behavior),
    category =
      selected?.reason?.type === "classifier"
        ? selected.reason.category
        : undefined;
  return Object.freeze({
    decision,
    source,
    ...(reason !== undefined && !hide ? { reasonType: reason.type } : {}),
    ...(reason?.type === "classifier" &&
    reason.autoModeRule !== undefined &&
    !hide
      ? { autoModeRule: structuredClone(reason.autoModeRule) }
      : {}),
    ...(rule === undefined ? {} : { ruleSource: rule }),
    ...(grant === undefined ? {} : { grantScope: grant }),
    ...(selected === undefined
      ? {}
      : {
          reasonCode: nativePermissionReasonCode(
            selected.behavior,
            selected.reason,
            selected.matchedAskRule,
          ),
        }),
    ...(circuit === undefined ? {} : { circuitBreaker: circuit }),
    ...(category !== undefined &&
    nativePermissionClassifierCategories.has(category)
      ? { classifierCategory: category }
      : {}),
  });
}

export interface NativePermissionDecisionAttachment {
  readonly rowIndex: number;
  readonly toolUseId: string;
  readonly rowUuid?: string;
  readonly permissionDecision: Readonly<NativePermissionDecisionRecord>;
}

function nativeObject(value: NativeJson | undefined): value is NativeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeArray(
  value: NativeJson | undefined,
): value is readonly NativeJson[] {
  return Array.isArray(value);
}

/** Kho/Fho target plan: attach only to a user's single matching result row. */
export function planNativePermissionDecisionAttachments(
  rows: readonly NativeObject[],
  toolUseId: string,
  decision: Readonly<NativePermissionDecisionRecord> | undefined,
): readonly NativePermissionDecisionAttachment[] {
  if (decision === undefined) return Object.freeze([]);
  const targets: NativePermissionDecisionAttachment[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.type !== "user" || !nativeObject(row.message)) continue;
    const content = row.message.content;
    if (!nativeArray(content)) continue;
    const results = content.filter(
      (block): block is NativeObject =>
        nativeObject(block) && block.type === "tool_result",
    );
    if (results.length !== 1 || results[0]?.tool_use_id !== toolUseId) continue;
    targets.push(
      Object.freeze({
        rowIndex,
        toolUseId,
        ...(typeof row.uuid === "string" ? { rowUuid: row.uuid } : {}),
        permissionDecision: decision,
      }),
    );
  }
  return Object.freeze(targets);
}
