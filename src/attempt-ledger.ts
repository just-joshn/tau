import { MAX_RETRIES } from "./retry.js";
import { ModelCallRecovery, NoResponseRetryLedger, decideRecovery, recoveryPolicy, type RecoveryFailure, type RecoveryPolicy } from "./recovery.js";

export const MAX_API_ATTEMPTS = 1_000_000;
export class ApiAttemptBudgetExhausted extends Error {
  constructor() { super("API attempt budget exhausted"); this.name = "ApiAttemptBudgetExhausted"; }
}

/** Caller-owned allowance, deliberately reusable across model rounds. */
export class ApiAttemptBudget {
  private left: number;
  constructor(count: number, private readonly parent?: ApiAttemptBudget) {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_API_ATTEMPTS) throw new Error(`maxApiAttempts must be an integer from 0 to ${MAX_API_ATTEMPTS}`);
    this.left = count;
  }
  get remaining(): number { return Math.min(this.left, this.parent?.remaining ?? Infinity); }
  child(count: number): ApiAttemptBudget { return new ApiAttemptBudget(count, this); }
  take(): boolean {
    if (this.left === 0 || this.parent && !this.parent.take()) return false;
    this.left--;
    return true;
  }
}

/** One completion's retry/fallback state; a separate caller allowance caps dispatches. */
export class RequestAttemptLedger {
  readonly recovery: ModelCallRecovery;
  readonly noResponse: NoResponseRetryLedger;
  private fallbackUsed = false;
  constructor(maxRetries: number, private readonly allowance?: ApiAttemptBudget, policy: Partial<Omit<RecoveryPolicy, "maxRetries">> = {}) {
    const broad = policy.persistent === true && policy.persistentCapacityOnly !== true;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || !broad && maxRetries > MAX_RETRIES) throw new Error(`maxRetries must be an integer from 0 to ${MAX_RETRIES} unless the persistent watchdog is enabled`);
    this.recovery = new ModelCallRecovery(recoveryPolicy(maxRetries, policy), allowance);
    this.noResponse = new NoResponseRetryLedger(policy.persistent === true && policy.persistentCapacityOnly !== true);
  }
  get retriesLeft(): number { return this.recovery.retriesLeft(); }
  assertAvailable(): void {
    if (this.allowance?.remaining === 0) throw new ApiAttemptBudgetExhausted();
  }
  takeAttempt(): void {
    if (!this.recovery.takeApiAttempt()) throw new ApiAttemptBudgetExhausted();
  }
  retry(failure: Exclude<RecoveryFailure, { kind: "streamFailed" }> = { kind: "noResponse", suspended: false, networkDown: false, turnedAwayOverloaded: false }, noResponseHeader = false): boolean {
    if (noResponseHeader && !this.noResponse.recordFailure()) return false;
    const decision = decideRecovery(failure, this.recovery.counts(), this.recovery.policy).decision;
    if (decision !== "retry") { this.recovery.reportRequestFailure(failure, "fail"); return false; }
    this.assertAvailable();
    this.recovery.reportRequestFailure(failure, "retry");
    return true;
  }
  fallback(): boolean {
    if (this.fallbackUsed) return false;
    this.assertAvailable();
    if (this.recovery.onRequestRetriesExhausted({ kind: "httpError", status: 404, fallbackModelCouldHelp: false }) !== "retryWithoutStreaming") return false;
    this.fallbackUsed = true;
    return true;
  }
}
