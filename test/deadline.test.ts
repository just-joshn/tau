import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleDeadline, StreamSuspendedError, TransportDeadline, TransportTimeoutError } from "../src/deadline.js";
import { MAX_TIMER_MS, firstHeaderWindow, resolveTimeoutPolicy } from "../src/timeout-policy.js";
import { ManualClock } from "./manual-clock.js";

const failureOf = (scope: TransportDeadline): Error | undefined => scope.failure;

test("timeout defaults distinguish trusted direct, custom URL and remote JSON profiles", () => {
  const direct = resolveTimeoutPolicy({ env: {} });
  assert.deepEqual(direct, {
    requestMs: 600000, configuredRequestMs: undefined, nonStreamingMs: 300000,
    eventIdleMs: 300000, byteIdleMs: 180000, firstByteMs: 180000,
    byteWatchdog: true, eventWatchdog: true, firstHeaderWatchdog: true, timerSlackMs: 0,
  });
  const custom = resolveTimeoutPolicy({ env: {}, baseUrl: "http://localhost:9000" });
  assert.equal(custom.byteIdleMs, 300000);
  assert.equal(custom.firstHeaderWatchdog, false);
  assert.equal(resolveTimeoutPolicy({ env: { CLAUDE_CODE_REMOTE: " yes " } }).nonStreamingMs, 120000);
  assert.equal(resolveTimeoutPolicy({ env: {}, baseUrl: "https://api.anthropic.com.example" }).firstHeaderWatchdog, false);
  assert.equal(resolveTimeoutPolicy({ env: { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "true" }, baseUrl: "http://localhost" }).byteIdleMs, 180000);
});

test("typed settings retain numeric grammar, raw watchdog overrides, floors and independent flags", () => {
  const policy = resolveTimeoutPolicy({ env: {
    API_TIMEOUT_MS: "1_000", CLAUDE_STREAM_IDLE_TIMEOUT_MS: "100", CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "20_000",
    CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "9e3", CLAUDE_ENABLE_BYTE_WATCHDOG: "off",
    CLAUDE_ENABLE_STREAM_WATCHDOG: " No ", CLAUDE_CODE_STREAM_TIMER_SLACK_MS: "500",
  } });
  assert.equal(policy.requestMs, 1000); assert.equal(policy.nonStreamingMs, 1000);
  assert.equal(policy.eventIdleMs, 300000); assert.equal(policy.byteIdleMs, 20000); assert.equal(policy.firstByteMs, 10000);
  assert.equal(policy.byteWatchdog, false); assert.equal(policy.eventWatchdog, false); assert.equal(policy.firstHeaderWatchdog, false);
  assert.equal(policy.timerSlackMs, 500);
  for (const setting of ["0", "-1"]) {
    const disabled = resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: setting } });
    assert.equal(disabled.requestMs, MAX_TIMER_MS); assert.equal(disabled.nonStreamingMs, 300000);
  }
  assert.equal(resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "1.5e0" } }).requestMs, 600000);
  assert.equal(resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "120ms" } }).requestMs, 120);
  assert.equal(resolveTimeoutPolicy({ env: { CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "Infinity" } }).byteIdleMs, 180000);
  assert.equal(resolveTimeoutPolicy({ env: { CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1e12", CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "1e12" } }).byteIdleMs, 1800000);
  assert.equal(resolveTimeoutPolicy({ env: { CLAUDE_CODE_STREAM_TIMER_SLACK_MS: "1e2" } }).timerSlackMs, 0);
  const remote = resolveTimeoutPolicy({ env: {}, remoteConfig: { api_timeout_ms: 42000, stream_idle_timeout_ms: 2000000 }, features: { streamTimerSlackMs: 100 } });
  assert.equal(remote.requestMs, 42000); assert.equal(remote.eventIdleMs, 1800000); assert.equal(remote.byteIdleMs, 1800000);
  assert.equal(remote.timerSlackMs, 100);
});

test("first-header windows account for upload size and escalation without crossing request deadline", () => {
  const direct = resolveTimeoutPolicy({ env: {} });
  assert.equal(firstHeaderWindow(direct, 32769, false), 182000);
  assert.equal(firstHeaderWindow(direct, 32769, true), 599000);
  assert.equal(firstHeaderWindow(resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "10000" } }), 1, false), undefined);
  assert.equal(firstHeaderWindow(resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "11000" } }), 1, false), 10000);
  const disabled = resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "0" } });
  assert.equal(firstHeaderWindow(disabled, 32769, true), 602000);
});

test("coalesced progress extends from the last touch and cleans every timer", () => {
  const clock = new ManualClock(); let expired = 0;
  const idle = new IdleDeadline(clock, 10000, 100, () => expired++);
  idle.touch(); clock.advance(80); idle.touch(); clock.advance(20); idle.touch();
  clock.advance(9950); assert.equal(expired, 0);
  clock.advance(50); assert.equal(expired, 1); assert.equal(clock.pending, 0);
  idle.close();
});

test("rapid coalesced touches do not expire at the original deadline", () => {
  const clock = new ManualClock(); let expired = 0;
  const idle = new IdleDeadline(clock, 10000, 100, () => expired++);
  idle.touch(); clock.advance(80); idle.touch(); clock.advance(9920);
  assert.equal(expired, 0); clock.advance(79); assert.equal(expired, 0);
  clock.advance(1); assert.equal(expired, 1);
});

test("dual clocks distinguish suspension from ordinary byte inactivity", () => {
  const clock = new ManualClock();
  const scope = new TransportDeadline(new AbortController().signal, resolveTimeoutPolicy({ env: {} }), clock, true, 10, false);
  scope.headersReceived(); scope.beginStream(); clock.suspend(180000);
  assert.ok(scope.failure instanceof StreamSuspendedError);
  assert.equal(scope.failure.sleptMs, 180000); assert.equal(clock.pending, 0); scope.close();
});

test("headers stop request timers and byte progress resets its own deadline", () => {
  const clock = new ManualClock();
  const scope = new TransportDeadline(new AbortController().signal, resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "75" } }), clock, true, 1, false);
  clock.advance(50); scope.headersReceived(); scope.beginStream(); clock.advance(179999); scope.byteReceived();
  clock.advance(179999); assert.equal(failureOf(scope), undefined);
  clock.advance(1); assert.ok(scope.failure instanceof TransportTimeoutError); assert.equal(scope.failure.stage, "byte-idle");
  assert.equal(clock.pending, 0); scope.close();
});

test("only thirty consecutive pings reset event progress, meaningful events renew that allowance", () => {
  const clock = new ManualClock();
  const scope = new TransportDeadline(new AbortController().signal, resolveTimeoutPolicy({ env: { CLAUDE_ENABLE_BYTE_WATCHDOG: "false" } }), clock, true, 1, false);
  scope.headersReceived(); scope.beginStream();
  for (let n = 0; n < 30; n++) { clock.advance(10000); scope.eventReceived(true); }
  clock.advance(10000); scope.eventReceived(true); clock.advance(280000); assert.equal(failureOf(scope), undefined);
  scope.eventReceived(false);
  for (let n = 0; n < 30; n++) { clock.advance(10000); scope.eventReceived(true); }
  clock.advance(299999); assert.equal(failureOf(scope), undefined); clock.advance(1);
  assert.ok(scope.failure instanceof TransportTimeoutError); assert.equal(scope.failure.stage, "event-idle");
  assert.equal(clock.pending, 0); scope.close();
});

test("raw bytes bridge to bounded ping progress without keeping an eventless response alive forever", () => {
  const clock = new ManualClock();
  const scope = new TransportDeadline(new AbortController().signal, resolveTimeoutPolicy({ env: {} }), clock, true, 1, false);
  scope.headersReceived(); scope.beginStream();
  for (let n = 0; n < 59; n++) { clock.advance(1); scope.byteReceived(); clock.advance(9999); }
  assert.equal(failureOf(scope), undefined); clock.advance(1); scope.byteReceived(); clock.advance(9999);
  assert.ok(scope.failure instanceof TransportTimeoutError); assert.equal(scope.failure.stage, "event-idle");
  scope.close(); assert.equal(clock.pending, 0);
});

test("parent cancellation dominates a timeout and disposes header and stream timers", () => {
  for (const streaming of [true, false]) {
    const clock = new ManualClock(), parent = new AbortController();
    const scope = new TransportDeadline(parent.signal, resolveTimeoutPolicy({ env: {} }), clock, streaming, 1, false);
    if (streaming) { scope.headersReceived(); scope.beginStream(); }
    parent.abort(); assert.throws(() => scope.check(), { name: "AbortError" });
    assert.equal(clock.pending, 0); scope.close(); clock.advance(1000000); assert.equal(failureOf(scope), undefined);
  }
});

test("JSON full-response timer remains armed after headers", () => {
  const clock = new ManualClock();
  const scope = new TransportDeadline(new AbortController().signal, resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "75" } }), clock, false, 1, false);
  clock.advance(25); scope.headersReceived(); clock.advance(50);
  assert.ok(scope.failure instanceof TransportTimeoutError); assert.equal(scope.failure.stage, "nonstream");
  scope.close(); assert.equal(clock.pending, 0);
});
