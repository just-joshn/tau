import type { ApiAttemptBudget } from "./attempt-ledger.js";

/** Independent implementation of the recovered model-call recovery decision table. */
export type RecoveryDecision =
  | "retry"
  | "retryWithoutStreaming"
  | "useFallbackModel"
  | "keepPartial"
  | "fail";
export type StreamProgress =
  "nothing" | "started" | "partialOutput" | "thinkingOnly" | "output";
export type StreamFailureCause =
  | "denied"
  | "outputFiltered"
  | "stalled"
  | "connectionLost"
  | "suspended"
  | "truncated"
  | "malformed"
  | "serverError"
  | "timedOut"
  | "overloaded"
  | "badRequest"
  | "unknown";
export type RecoveryFailure =
  | {
      kind: "noResponse";
      suspended: boolean;
      networkDown: boolean;
      turnedAwayOverloaded: boolean;
    }
  | { kind: "httpError"; status: number; fallbackModelCouldHelp: boolean }
  | {
      kind: "streamFailed";
      cause: StreamFailureCause;
      progress: StreamProgress;
      stopReasonReceived: boolean;
      outlastedNonStreamingTimeout: boolean;
    };
export interface RecoveryCounts {
  retries: number;
  sleptThrough: number;
  reconnects: number;
  overloaded: number;
  stalls: number;
  truncations: number;
  afterThinkingOnly: number;
  outputFiltered: number;
  triedWithoutStreaming: boolean;
}
export interface RecoveryPolicy {
  maxRetries: number;
  maxSleptThrough: number;
  maxReconnects: number;
  maxOverloaded: number;
  maxOutputFiltered: number;
  hasFallbackModel: boolean;
  persistent: boolean;
  persistentCapacityOnly: boolean;
  persistentOverloadOnly: boolean;
  background: boolean;
}
export interface RecoveryResult {
  decision: RecoveryDecision;
  counts: RecoveryCounts;
}
export function streamFailureCause(signals: {
  denied?: boolean;
  outputFiltered?: boolean;
  overloaded?: boolean;
  serverError?: boolean;
  timedOut?: boolean;
  stalled?: boolean;
  connectionError?: boolean;
  truncated?: boolean;
  suspended?: boolean;
  malformed?: boolean;
  badRequest?: boolean;
}): StreamFailureCause {
  if (signals.denied) return "denied";
  if (signals.outputFiltered) return "outputFiltered";
  if (signals.overloaded) return "overloaded";
  if (signals.serverError) return signals.timedOut ? "timedOut" : "serverError";
  if (signals.stalled) return "stalled";
  if (signals.connectionError)
    return signals.truncated
      ? "truncated"
      : signals.suspended
        ? "suspended"
        : "connectionLost";
  if (signals.malformed) return "malformed";
  return signals.badRequest ? "badRequest" : "unknown";
}
export const freshRecoveryCounts = (): RecoveryCounts => ({
  retries: 0,
  sleptThrough: 0,
  reconnects: 0,
  overloaded: 0,
  stalls: 0,
  truncations: 0,
  afterThinkingOnly: 0,
  outputFiltered: 0,
  triedWithoutStreaming: false,
});
export const recoveryPolicy = (
  maxRetries: number,
  overrides: Partial<RecoveryPolicy> = {},
): RecoveryPolicy => ({
  maxRetries,
  maxSleptThrough: Math.min(maxRetries, 10),
  maxReconnects: 0,
  maxOverloaded: 3,
  maxOutputFiltered: 1,
  hasFallbackModel: false,
  persistent: false,
  persistentCapacityOnly: false,
  persistentOverloadOnly: false,
  background: false,
  ...overrides,
});

export function decideRecovery(
  failure: RecoveryFailure,
  counts: RecoveryCounts,
  policy: RecoveryPolicy,
  allowNonStreaming = false,
): RecoveryResult {
  const result = (
    decision: RecoveryDecision,
    state = counts,
  ): RecoveryResult => ({ decision, counts: state });
  const fail = result("fail");
  const keep = result("keepPartial");
  const persistentAll = policy.persistent && !policy.persistentCapacityOnly;
  const retry = (
    state: RecoveryCounts,
    exhausted: RecoveryResult = result("fail", state),
  ): RecoveryResult =>
    state.retries < policy.maxRetries
      ? result("retry", { ...state, retries: state.retries + 1 })
      : exhausted;
  const json = (
    state: RecoveryCounts,
    allowed = allowNonStreaming,
  ): RecoveryResult => {
    if (
      !allowed ||
      (state.triedWithoutStreaming && state.retries >= policy.maxRetries)
    )
      return result("fail", state);
    return result("retryWithoutStreaming", {
      ...state,
      retries: Math.min(state.retries + 1, policy.maxRetries),
      triedWithoutStreaming: true,
    });
  };
  const special = (
    key: "stalls" | "truncations" | "afterThinkingOnly" | "outputFiltered",
    limit: number,
    exhausted: RecoveryResult,
  ): RecoveryResult =>
    counts[key] < limit
      ? retry({ ...counts, [key]: counts[key] + 1 }, exhausted)
      : exhausted;
  const suspended = (exhausted?: RecoveryResult): RecoveryResult =>
    counts.sleptThrough < policy.maxSleptThrough
      ? result("retry", { ...counts, sleptThrough: counts.sleptThrough + 1 })
      : retry(counts, exhausted);
  const overloaded = (streaming: boolean): RecoveryResult => {
    const state = { ...counts, overloaded: counts.overloaded + 1 };
    const exhausted = streaming ? json(state) : result("fail", state);
    if (policy.background && !persistentAll)
      return streaming && policy.hasFallbackModel
        ? result("useFallbackModel", state)
        : exhausted;
    if (state.overloaded < policy.maxOverloaded)
      return policy.persistent
        ? result("retry", state)
        : retry(state, exhausted);
    if (policy.hasFallbackModel) return result("useFallbackModel", state);
    return streaming
      ? exhausted
      : policy.persistent
        ? result("retry", state)
        : retry(state);
  };
  if (failure.kind === "noResponse") {
    if (failure.suspended) return suspended();
    if (failure.turnedAwayOverloaded) {
      if (policy.background && !persistentAll) return fail;
      if (policy.persistent) return result("retry");
    }
    return failure.networkDown && counts.reconnects < policy.maxReconnects
      ? result("retry", { ...counts, reconnects: counts.reconnects + 1 })
      : retry(counts);
  }
  if (failure.kind === "httpError") {
    if (failure.status === 529) return overloaded(false);
    if (
      failure.status === 429 &&
      policy.persistent &&
      !policy.persistentOverloadOnly
    )
      return result("retry");
    if (failure.fallbackModelCouldHelp && policy.hasFallbackModel)
      return result("useFallbackModel");
    if ([408, 409, 429].includes(failure.status) || failure.status >= 500)
      return retry(counts);
    if (failure.status === 404 && !counts.triedWithoutStreaming)
      return json(counts, true);
    return fail;
  }
  const { cause, progress, stopReasonReceived: stopped } = failure;
  const fallback = json(counts);
  if (cause === "denied") return fail;
  if (cause === "outputFiltered")
    return (progress === "nothing" || progress === "started") && !stopped
      ? special("outputFiltered", policy.maxOutputFiltered, fail)
      : fail;
  if (progress === "output")
    return cause === "badRequest" || cause === "unknown" ? fail : keep;
  if (progress === "thinkingOnly") {
    switch (cause) {
      case "stalled":
        return stopped ? keep : special("stalls", 1, keep);
      case "connectionLost":
      case "suspended":
      case "truncated":
      case "malformed":
        return stopped ? keep : special("afterThinkingOnly", 2, keep);
      case "serverError":
      case "timedOut":
        if (stopped) return fail;
        return policy.hasFallbackModel && !persistentAll
          ? result("useFallbackModel")
          : special("afterThinkingOnly", cause === "timedOut" ? 1 : 2, fail);
      case "overloaded":
        return stopped ? fail : overloaded(true);
      default:
        return fail;
    }
  }
  switch (cause) {
    case "overloaded":
      return progress === "partialOutput"
        ? json({ ...counts, overloaded: counts.overloaded + 1 })
        : overloaded(true);
    case "stalled":
      return progress === "nothing" ? special("stalls", 1, fallback) : fallback;
    case "truncated":
      return stopped ? fallback : special("truncations", 1, fallback);
    case "suspended":
      return stopped
        ? fallback
        : progress === "partialOutput"
          ? retry(counts, fallback)
          : suspended(fallback);
    case "connectionLost":
      return stopped ? fallback : retry(counts, fallback);
    case "serverError":
      return failure.outlastedNonStreamingTimeout &&
        !stopped &&
        progress !== "partialOutput"
        ? special("afterThinkingOnly", 2, fallback)
        : fallback;
    default:
      return fallback;
  }
}

/** Complete coherent envelope can survive transport loss before its final message_stop. */
export function classifyStreamFailure(input: {
  cause: StreamFailureCause;
  anyBlockFinished: boolean;
  anyOutputShown: boolean;
  anyEvent: boolean;
  stopReasonReceived: boolean;
  outlastedNonStreamingTimeout: boolean;
  complete: boolean;
}): Extract<RecoveryFailure, { kind: "streamFailed" }> | undefined {
  const progress: StreamProgress = input.anyBlockFinished
    ? input.anyOutputShown
      ? "output"
      : "thinkingOnly"
    : input.anyOutputShown
      ? "partialOutput"
      : input.anyEvent
        ? "started"
        : "nothing";
  if (
    input.complete &&
    (["connectionLost", "suspended", "truncated", "stalled"].includes(
      input.cause,
    ) ||
      (progress === "output" &&
        ["overloaded", "serverError", "timedOut"].includes(input.cause)))
  )
    return;
  return {
    kind: "streamFailed",
    cause: input.cause,
    progress,
    stopReasonReceived: input.stopReasonReceived,
    outlastedNonStreamingTimeout: input.outlastedNonStreamingTimeout,
  };
}

/** Per-query no-header limit is separate from ordinary/suspension counters. */
export class NoResponseRetryLedger {
  private count = 0;
  constructor(private readonly persistentAll = false) {}
  get escalated(): boolean {
    return this.count > 0;
  }
  recordFailure(): boolean {
    if (!this.persistentAll && this.count >= 1) return false;
    this.count++;
    return true;
  }
}

/** Query-owned mutable ledger; optional dispatch admission can span multiple queries. */
export class ModelCallRecovery {
  private state = freshRecoveryCounts();
  private previous = this.state;
  private terminal = false;
  private renewals = 2;
  readonly capacityWait = {
    spentMs: 0,
    usageLimitSpentMs: 0,
    overloadWaits: 0,
  };
  constructor(
    readonly policy: RecoveryPolicy,
    private readonly allowance?: ApiAttemptBudget,
  ) {
    for (const key of [
      "maxRetries",
      "maxSleptThrough",
      "maxReconnects",
      "maxOverloaded",
      "maxOutputFiltered",
    ] as const) {
      if (!Number.isSafeInteger(policy[key]) || policy[key] < 0)
        throw new Error(`Invalid recovery limit: ${key}`);
    }
  }
  counts(): RecoveryCounts {
    return { ...this.state };
  }
  retriesLeft(): number {
    return Math.max(0, this.policy.maxRetries - this.state.retries);
  }
  sleptThroughLeft(): number {
    return Math.max(0, this.policy.maxSleptThrough - this.state.sleptThrough);
  }
  reconnectsLeft(): number {
    return Math.max(0, this.policy.maxReconnects - this.state.reconnects);
  }
  outOfApiAttempts(): boolean {
    return this.allowance?.remaining === 0;
  }
  allowsApiAttempts(count: number): boolean {
    return this.allowance === undefined || this.allowance.remaining >= count;
  }
  takeApiAttempt(): boolean {
    return this.allowance?.take() ?? true;
  }
  takeCredentialRenewal(): boolean {
    if (this.renewals <= 0) return false;
    this.renewals--;
    return true;
  }
  onStreamFailed(
    failure: Extract<RecoveryFailure, { kind: "streamFailed" }>,
    allowNonStreaming: boolean,
  ): RecoveryDecision {
    this.previous = this.state;
    const result = decideRecovery(
      failure,
      this.state,
      this.policy,
      allowNonStreaming,
    );
    this.state = result.counts;
    const decision =
      result.decision === "keepPartial" || !this.outOfApiAttempts()
        ? result.decision
        : "fail";
    this.terminal = decision === "fail" || decision === "useFallbackModel";
    return decision;
  }
  undoLastCount(): void {
    this.state = this.previous;
    this.terminal = false;
  }
  /** The outer HTTP loop decides actual behavior; this records the corresponding model-query counts. */
  reportRequestFailure(
    failure: Exclude<RecoveryFailure, { kind: "streamFailed" }> | undefined,
    actual: RecoveryDecision,
  ): void {
    if (this.terminal) return;
    const wasNonStreaming = this.state.triedWithoutStreaming;
    if (failure)
      this.state = {
        ...decideRecovery(failure, this.state, this.policy).counts,
        triedWithoutStreaming: wasNonStreaming,
      };
    else if (actual === "retry")
      this.state = {
        ...this.state,
        retries: Math.min(this.state.retries + 1, this.policy.maxRetries),
      };
  }
  onRequestRetriesExhausted(
    failure: Exclude<RecoveryFailure, { kind: "streamFailed" }> | undefined,
  ): "retryWithoutStreaming" | "fail" {
    if (this.outOfApiAttempts()) return "fail";
    if (!failure || this.terminal) return "fail";
    const result = decideRecovery(failure, this.state, this.policy);
    this.state = result.counts;
    return result.decision === "retryWithoutStreaming"
      ? "retryWithoutStreaming"
      : "fail";
  }
}
