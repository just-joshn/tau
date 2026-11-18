import type { NativeJson, NativeObject } from "./native-session-codec.js";

export type NativePermissionBehavior = "allow" | "ask" | "deny" | "passthrough";
export type NativePermissionRuleBehavior = Exclude<
  NativePermissionBehavior,
  "passthrough"
>;

export interface NativePermissionRule {
  source: string;
  ruleValue: { toolName: string; ruleContent?: string | undefined };
  ruleBehavior?: NativePermissionRuleBehavior | undefined;
  original?: string | undefined;
}

export type NativePermissionSuggestion =
  | { type: "addDirectories"; directories: string[]; destination: string }
  | { type: "setMode"; mode: string; destination: string }
  | {
      type: "addRules";
      rules: { toolName: string; ruleContent?: string | undefined }[];
      behavior: NativePermissionRuleBehavior;
      destination: string;
    };

export type NativePermissionReason<Input = unknown> =
  | { type: "rule"; rule: NativePermissionRule }
  | { type: "mode"; mode: string }
  | { type: "hook"; hookName: string; reason?: string | undefined }
  | {
      type: "classifier";
      reason: string;
      classifier?: string | undefined;
      category?: string | undefined;
      autoModeRule?: NativeJson | undefined;
      noVerdict?: boolean | undefined;
      hostCode?: string | undefined;
    }
  | {
      type: "subcommandResults";
      reasons: ReadonlyMap<string, NativePermissionOutcome<Input>>;
      typeOnWire?: string | undefined;
    }
  | {
      type: "asyncAgent";
      reason: string;
      ask?: NativePermissionOutcome<Input> | undefined;
    }
  | { type: "sandboxOverride"; reason: string }
  | { type: "workingDir"; reason: string }
  | {
      type: "safetyCheck";
      reason: string;
      classifierApprovable?: boolean | undefined;
      circuitBreaker?: string | undefined;
      also?: string[] | undefined;
      removalRule?: string | undefined;
    }
  | {
      type: "permissionPromptTool";
      permissionPromptToolName?: string | undefined;
      toolResult?: NativeObject | undefined;
    }
  | {
      type: "other";
      reason: string;
      label?: string | undefined;
      bashMissKind?: string | undefined;
      acceptEditsCannotAllow?: boolean | undefined;
      wasSafetyCheck?: boolean | undefined;
    };

export interface NativePermissionOutcome<Input = unknown> {
  behavior: NativePermissionBehavior;
  message?: string | undefined;
  decisionReason?: NativePermissionReason<Input> | undefined;
  updatedInput?: Input | undefined;
  suggestions?: NativePermissionSuggestion[] | undefined;
  blockedPath?: string | undefined;
  matchedAskRule?: NativePermissionRule | undefined;
  grantScope?: string | undefined;
  metadata?: NativeJson | undefined;
  orgLimit?: NativeJson | undefined;
  personOnly?: boolean | undefined;
  defaultToNo?: boolean | undefined;
  suppressAlwaysAllowRule?: boolean | undefined;
  hooksMayAllow?: boolean | undefined;
  checkIncomplete?: boolean | undefined;
  wholeToolRuleDoesNotCover?: boolean | undefined;
  bashAllowRuleOverridable?: boolean | undefined;
  standsInUnderHookAsk?: boolean | undefined;
  invalidInput?: boolean | undefined;
}

export type NativePermissionDecision = "accept" | "reject";
export type NativePermissionDecisionSource =
  | "config"
  | "hook"
  | "user_temporary"
  | "user_permanent"
  | "user_reject"
  | "user_abort";

export interface NativePermissionDecisionRecord {
  decision: NativePermissionDecision;
  source: NativePermissionDecisionSource;
  reasonType?: NativePermissionReason["type"] | undefined;
  autoModeRule?: NativeJson | undefined;
  ruleSource?: string | undefined;
  grantScope?: string | undefined;
  reasonCode?: string | undefined;
  circuitBreaker?: string | undefined;
  classifierCategory?: string | undefined;
}

/** Actual evaluation cwd and policy generation, independent of original roots. */
export interface NativePermissionScope {
  policyId: string;
  cwd: string;
}

export interface NativePermissionProvenance {
  provider: string;
  sourceContracts: readonly string[];
  scope: NativePermissionScope;
}

export type NativePermissionFact<T> =
  | { status: "known"; value: T; provenance: NativePermissionProvenance }
  | { status: "unsupported"; dependency: string; reason: string };

export class NativePermissionDependencyError extends Error {
  constructor(
    readonly dependency: string,
    readonly reason: string,
  ) {
    super(`${dependency}: ${reason}`);
    this.name = "NativePermissionDependencyError";
  }
}

export function readNativePermissionFact<T>(
  fact: NativePermissionFact<T>,
  scope: NativePermissionScope,
  receipts: NativePermissionProvenance[],
): T {
  if (fact.status === "unsupported")
    throw new NativePermissionDependencyError(fact.dependency, fact.reason);
  if (
    fact.provenance.scope.policyId !== scope.policyId ||
    fact.provenance.scope.cwd !== scope.cwd
  )
    throw new NativePermissionDependencyError(
      "host-scope",
      "Fact belongs to a different policy or evaluation cwd",
    );
  if (
    fact.provenance.provider === "" ||
    fact.provenance.sourceContracts.length === 0
  )
    throw new NativePermissionDependencyError(
      "host-provenance",
      "Source-backed host provenance is required",
    );
  receipts.push(fact.provenance);
  return fact.value;
}
