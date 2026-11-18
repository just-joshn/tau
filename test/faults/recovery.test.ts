import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  ApiAttemptBudget,
  RequestAttemptLedger,
} from "../../src/attempt-ledger.js";
import {
  ModelCallRecovery,
  NoResponseRetryLedger,
  classifyStreamFailure,
  decideRecovery,
  freshRecoveryCounts,
  recoveryPolicy,
  streamFailureCause,
  type RecoveryCounts,
  type RecoveryDecision,
  type RecoveryPolicy,
  type RecoveryFailure,
  type StreamFailureCause,
  type StreamProgress,
} from "../../src/recovery.js";
import { resolveRetryConfiguration } from "../../src/retry.js";

const stream = (
  cause: StreamFailureCause,
  progress: StreamProgress = "nothing",
  stopReasonReceived = false,
  outlastedNonStreamingTimeout = false,
): Extract<RecoveryFailure, { kind: "streamFailed" }> => ({
  kind: "streamFailed",
  cause,
  progress,
  stopReasonReceived,
  outlastedNonStreamingTimeout,
});
const connection: RecoveryFailure = {
  kind: "noResponse",
  suspended: false,
  networkDown: false,
  turnedAwayOverloaded: false,
};
type Case = {
  name: string;
  failure: RecoveryFailure;
  expected: RecoveryDecision;
  counts?: Partial<RecoveryCounts>;
  policy?: Partial<RecoveryPolicy>;
  json?: boolean;
  changed?: Partial<RecoveryCounts>;
};
const cases: Case[] = [
  {
    name: "ordinary connection failure spends one retry",
    failure: connection,
    expected: "retry",
    changed: { retries: 1 },
  },
  {
    name: "suspension uses its independent allowance first",
    failure: { ...connection, suspended: true },
    expected: "retry",
    changed: { sleptThrough: 1 },
  },
  {
    name: "exhausted suspension allowance falls back to ordinary retries",
    failure: { ...connection, suspended: true },
    counts: { sleptThrough: 2 },
    expected: "retry",
    changed: { retries: 1, sleptThrough: 2 },
  },
  {
    name: "network recovery uses reconnect allowance",
    failure: { ...connection, networkDown: true },
    policy: { maxReconnects: 1 },
    expected: "retry",
    changed: { reconnects: 1 },
  },
  {
    name: "background turned-away requests fail outside broad persistence",
    failure: { ...connection, turnedAwayOverloaded: true },
    policy: { background: true },
    expected: "fail",
  },
  {
    name: "persistent turned-away requests preserve ordinary count",
    failure: { ...connection, turnedAwayOverloaded: true },
    policy: { persistent: true },
    expected: "retry",
  },
  {
    name: "persistent rate limits preserve ordinary count",
    failure: { kind: "httpError", status: 429, fallbackModelCouldHelp: false },
    policy: { persistent: true },
    expected: "retry",
  },
  {
    name: "overload-only persistence does not bypass ordinary429 limit",
    failure: { kind: "httpError", status: 429, fallbackModelCouldHelp: false },
    policy: { persistent: true, persistentOverloadOnly: true },
    expected: "retry",
    changed: { retries: 1 },
  },
  {
    name: "HTTP fallback model can take precedence over transient retry",
    failure: { kind: "httpError", status: 500, fallbackModelCouldHelp: true },
    policy: { hasFallbackModel: true },
    expected: "useFallbackModel",
  },
  {
    name: "HTTP404 admits JSON at exhausted ordinary budget",
    failure: { kind: "httpError", status: 404, fallbackModelCouldHelp: false },
    counts: { retries: 2 },
    expected: "retryWithoutStreaming",
    changed: { retries: 2, triedWithoutStreaming: true },
  },
  {
    name: "repeated HTTP404 does not select JSON again",
    failure: { kind: "httpError", status: 404, fallbackModelCouldHelp: false },
    counts: { triedWithoutStreaming: true },
    expected: "fail",
  },
  {
    name: "third overload selects fallback model",
    failure: { kind: "httpError", status: 529, fallbackModelCouldHelp: false },
    counts: { overloaded: 2 },
    policy: { hasFallbackModel: true },
    expected: "useFallbackModel",
    changed: { overloaded: 3 },
  },
  {
    name: "background HTTP overload fails immediately",
    failure: { kind: "httpError", status: 529, fallbackModelCouldHelp: false },
    policy: { background: true },
    expected: "fail",
    changed: { overloaded: 1 },
  },
  {
    name: "background stream overload can select a model even when JSON disabled",
    failure: stream("overloaded"),
    policy: { background: true, hasFallbackModel: true },
    expected: "useFallbackModel",
    changed: { overloaded: 1 },
  },
  {
    name: "capacity-only persistent background stream does not retry forever",
    failure: stream("overloaded"),
    policy: {
      background: true,
      persistent: true,
      persistentCapacityOnly: true,
    },
    json: true,
    expected: "retryWithoutStreaming",
    changed: { retries: 1, overloaded: 1, triedWithoutStreaming: true },
  },
  {
    name: "denial cannot keep completed output",
    failure: stream("denied", "output"),
    expected: "fail",
  },
  {
    name: "output filter before content uses its own counter",
    failure: stream("outputFiltered", "started"),
    expected: "retry",
    changed: { retries: 1, outputFiltered: 1 },
  },
  {
    name: "output filter does not replay partial visible output",
    failure: stream("outputFiltered", "partialOutput"),
    json: true,
    expected: "fail",
  },
  {
    name: "completed output survives a dropped connection",
    failure: stream("connectionLost", "output"),
    expected: "keepPartial",
  },
  {
    name: "completed output survives server errors",
    failure: stream("serverError", "output"),
    expected: "keepPartial",
  },
  {
    name: "unknown errors do not finalize completed output",
    failure: stream("unknown", "output"),
    expected: "fail",
  },
  {
    name: "thinking-only stall retries once",
    failure: stream("stalled", "thinkingOnly"),
    expected: "retry",
    changed: { retries: 1, stalls: 1 },
  },
  {
    name: "repeated thinking-only stall keeps completed thinking",
    failure: stream("stalled", "thinkingOnly"),
    counts: { stalls: 1 },
    expected: "keepPartial",
  },
  {
    name: "thinking-only suspend uses bounded after-thinking retry",
    failure: stream("suspended", "thinkingOnly"),
    expected: "retry",
    changed: { retries: 1, afterThinkingOnly: 1 },
  },
  {
    name: "thinking-only timed-out retry limit is one",
    failure: stream("timedOut", "thinkingOnly"),
    counts: { afterThinkingOnly: 1 },
    json: true,
    expected: "fail",
  },
  {
    name: "thinking-only server failure can switch model",
    failure: stream("serverError", "thinkingOnly"),
    policy: { hasFallbackModel: true },
    expected: "useFallbackModel",
  },
  {
    name: "broad persistence retries thinking server failures before switching",
    failure: stream("serverError", "thinkingOnly"),
    policy: { hasFallbackModel: true, persistent: true },
    expected: "retry",
    changed: { retries: 1, afterThinkingOnly: 1 },
  },
  {
    name: "thinking-only received stop reason keeps connection-cut content",
    failure: stream("truncated", "thinkingOnly", true),
    expected: "keepPartial",
  },
  {
    name: "thinking-only server error after stop reason fails",
    failure: stream("serverError", "thinkingOnly", true),
    expected: "fail",
  },
  {
    name: "no-event stall retries once before JSON",
    failure: stream("stalled"),
    json: true,
    expected: "retry",
    changed: { retries: 1, stalls: 1 },
  },
  {
    name: "started-but-no-output stall selects JSON directly",
    failure: stream("stalled", "started"),
    json: true,
    expected: "retryWithoutStreaming",
    changed: { retries: 1, triedWithoutStreaming: true },
  },
  {
    name: "truncated stream retries once before JSON",
    failure: stream("truncated", "started"),
    json: true,
    expected: "retry",
    changed: { retries: 1, truncations: 1 },
  },
  {
    name: "started suspension preserves ordinary retry budget",
    failure: stream("suspended", "started"),
    json: true,
    expected: "retry",
    changed: { sleptThrough: 1 },
  },
  {
    name: "partial visible suspension spends ordinary retry budget",
    failure: stream("suspended", "partialOutput"),
    json: true,
    expected: "retry",
    changed: { retries: 1 },
  },
  {
    name: "stream connection loss uses ordinary retry before JSON",
    failure: stream("connectionLost", "started"),
    json: true,
    expected: "retry",
    changed: { retries: 1 },
  },
  {
    name: "server error after long wait uses after-thinking counter even without blocks",
    failure: stream("serverError", "started", false, true),
    json: true,
    expected: "retry",
    changed: { retries: 1, afterThinkingOnly: 1 },
  },
  {
    name: "early server error selects JSON",
    failure: stream("serverError", "started"),
    json: true,
    expected: "retryWithoutStreaming",
    changed: { retries: 1, triedWithoutStreaming: true },
  },
  {
    name: "partial output overload selects JSON without streaming replay",
    failure: stream("overloaded", "partialOutput"),
    json: true,
    expected: "retryWithoutStreaming",
    changed: { retries: 1, overloaded: 1, triedWithoutStreaming: true },
  },
  {
    name: "JSON attempt can repeat while ordinary budget remains",
    failure: stream("malformed", "started"),
    counts: { triedWithoutStreaming: true },
    json: true,
    expected: "retryWithoutStreaming",
    changed: { retries: 1, triedWithoutStreaming: true },
  },
  {
    name: "JSON fallback stops once both admission and retry budget exhausted",
    failure: stream("malformed", "started"),
    counts: { triedWithoutStreaming: true, retries: 2 },
    json: true,
    expected: "fail",
  },
];
for (const item of cases)
  test(item.name, () => {
    const original = { ...freshRecoveryCounts(), ...item.counts };
    const snapshot = { ...original };
    const result = decideRecovery(
      item.failure,
      original,
      recoveryPolicy(2, item.policy),
      item.json,
    );
    assert.equal(result.decision, item.expected);
    assert.deepEqual(result.counts, { ...snapshot, ...item.changed });
    assert.deepEqual(
      original,
      snapshot,
      "decision must not mutate caller snapshot",
    );
  });

test("classifier distinguishes incomplete output from completed blocks and coherent stop envelopes", () => {
  const input = {
    cause: "connectionLost" as const,
    anyBlockFinished: false,
    anyOutputShown: false,
    anyEvent: false,
    stopReasonReceived: false,
    outlastedNonStreamingTimeout: false,
    complete: false,
  };
  for (const [anyBlockFinished, anyOutputShown, anyEvent, expected] of [
    [false, false, false, "nothing"],
    [false, false, true, "started"],
    [false, true, true, "partialOutput"],
    [true, false, true, "thinkingOnly"],
    [true, true, true, "output"],
  ] as const) {
    assert.equal(
      classifyStreamFailure({
        ...input,
        anyBlockFinished,
        anyOutputShown,
        anyEvent,
      })?.progress,
      expected,
    );
  }
  assert.equal(classifyStreamFailure({ ...input, complete: true }), undefined);
  assert.equal(
    classifyStreamFailure({
      ...input,
      complete: true,
      cause: "serverError",
      anyBlockFinished: true,
      anyOutputShown: true,
    }),
    undefined,
  );
  assert.equal(
    classifyStreamFailure({ ...input, complete: true, cause: "badRequest" })
      ?.cause,
    "badRequest",
  );
});

test("failure cause classification preserves denial/filter/server/stall/connection precedence", () => {
  assert.equal(
    streamFailureCause({
      denied: true,
      outputFiltered: true,
      overloaded: true,
    }),
    "denied",
  );
  assert.equal(
    streamFailureCause({
      outputFiltered: true,
      overloaded: true,
      stalled: true,
    }),
    "outputFiltered",
  );
  assert.equal(
    streamFailureCause({ overloaded: true, serverError: true, stalled: true }),
    "overloaded",
  );
  assert.equal(
    streamFailureCause({ serverError: true, timedOut: true, stalled: true }),
    "timedOut",
  );
  assert.equal(
    streamFailureCause({
      stalled: true,
      connectionError: true,
      malformed: true,
    }),
    "stalled",
  );
  assert.equal(
    streamFailureCause({
      connectionError: true,
      truncated: true,
      suspended: true,
    }),
    "truncated",
  );
  assert.equal(
    streamFailureCause({
      connectionError: true,
      suspended: true,
      malformed: true,
    }),
    "suspended",
  );
  assert.equal(
    streamFailureCause({ malformed: true, badRequest: true }),
    "malformed",
  );
  assert.equal(streamFailureCause({ badRequest: true }), "badRequest");
  assert.equal(streamFailureCause({}), "unknown");
});

test("ledger preserves partial results at exhausted admission, supports undo and suppresses terminal HTTP recount", () => {
  const budget = new ApiAttemptBudget(1),
    ledger = new ModelCallRecovery(recoveryPolicy(2), budget);
  assert.equal(ledger.takeApiAttempt(), true);
  assert.equal(ledger.takeApiAttempt(), false);
  assert.equal(
    ledger.onStreamFailed(stream("stalled", "started"), true),
    "fail",
  );
  assert.equal(ledger.counts().triedWithoutStreaming, true);
  ledger.undoLastCount();
  assert.equal(ledger.counts().triedWithoutStreaming, false);
  assert.equal(
    ledger.onStreamFailed(stream("connectionLost", "output"), true),
    "keepPartial",
  );
  assert.equal(
    ledger.onRequestRetriesExhausted({
      kind: "httpError",
      status: 404,
      fallbackModelCouldHelp: false,
    }),
    "fail",
  );
  const terminal = new ModelCallRecovery(
    recoveryPolicy(2, { hasFallbackModel: true }),
  );
  terminal.onStreamFailed(stream("serverError", "thinkingOnly"), true);
  terminal.reportRequestFailure(connection, "retry");
  assert.equal(terminal.counts().retries, 0);
  terminal.undoLastCount();
  terminal.reportRequestFailure(connection, "retry");
  assert.equal(terminal.counts().retries, 1);
});

test("HTTP shadow accounting preserves JSON admission and has a separate credential renewal allowance", () => {
  const ledger = new ModelCallRecovery(recoveryPolicy(2));
  ledger.reportRequestFailure(
    { kind: "httpError", status: 404, fallbackModelCouldHelp: false },
    "fail",
  );
  assert.equal(ledger.counts().triedWithoutStreaming, false);
  assert.equal(ledger.counts().retries, 1);
  assert.equal(
    ledger.onRequestRetriesExhausted({
      kind: "httpError",
      status: 404,
      fallbackModelCouldHelp: false,
    }),
    "retryWithoutStreaming",
  );
  assert.equal(ledger.counts().triedWithoutStreaming, true);
  assert.equal(ledger.retriesLeft(), 0);
  assert.deepEqual(
    [
      ledger.takeCredentialRenewal(),
      ledger.takeCredentialRenewal(),
      ledger.takeCredentialRenewal(),
    ],
    [true, true, false],
  );
});

test("header retry cap and suspension admission remain independent across a query", () => {
  const headers = new NoResponseRetryLedger();
  assert.equal(headers.escalated, false);
  assert.equal(headers.recordFailure(), true);
  assert.equal(headers.escalated, true);
  assert.equal(headers.recordFailure(), false);
  const persistent = new NoResponseRetryLedger(true);
  for (let n = 0; n < 10; n++) assert.equal(persistent.recordFailure(), true);
  const ledger = new RequestAttemptLedger(1);
  assert.equal(ledger.retry({ ...connection, suspended: true }), true);
  assert.equal(ledger.retriesLeft, 1);
  assert.equal(ledger.noResponse.escalated, false);
  assert.equal(ledger.retry(connection, true), true);
  assert.equal(ledger.retriesLeft, 0);
  assert.equal(ledger.noResponse.escalated, true);
  assert.equal(ledger.retry(connection, true), false);
});

test("source retry defaults, integer grammar, clamping and watchdog scope are distinct", () => {
  assert.deepEqual(resolveRetryConfiguration({}), {
    maxRetries: 10,
    watchdog: false,
    capacityOnly: false,
  });
  assert.equal(
    resolveRetryConfiguration({ CLAUDE_CODE_MAX_RETRIES: "100" }).maxRetries,
    15,
  );
  assert.equal(
    resolveRetryConfiguration({ CLAUDE_CODE_MAX_RETRIES: "-1" }).maxRetries,
    10,
  );
  assert.equal(
    resolveRetryConfiguration({ CLAUDE_CODE_MAX_RETRIES: "1e1" }).maxRetries,
    10,
  );
  assert.equal(
    resolveRetryConfiguration({ CLAUDE_CODE_MAX_RETRIES: "0" }).maxRetries,
    0,
  );
  assert.deepEqual(
    resolveRetryConfiguration({ CLAUDE_CODE_RETRY_WATCHDOG: "yes" }),
    { maxRetries: 300, watchdog: true, capacityOnly: false },
  );
  assert.deepEqual(
    resolveRetryConfiguration({
      CLAUDE_CODE_RETRY_WATCHDOG: "true",
      CLAUDE_CODE_RETRY_WATCHDOG_SCOPE: "capacity",
    }),
    { maxRetries: 10, watchdog: true, capacityOnly: true },
  );
  assert.equal(
    resolveRetryConfiguration({
      CLAUDE_CODE_RETRY_WATCHDOG: "true",
      CLAUDE_CODE_MAX_RETRIES: "1_000",
    }).maxRetries,
    1000,
  );
});
