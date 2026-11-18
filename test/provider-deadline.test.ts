import { fixtureSse } from "./sse-fixture.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AnthropicProvider } from "../src/provider.js";
import { ApiAttemptBudget } from "../src/attempt-ledger.js";
import { TransportTimeoutError } from "../src/deadline.js";
import { resolveTimeoutPolicy, type TimeoutPolicy } from "../src/timeout-policy.js";
import type { RecoveryPolicy } from "../src/recovery.js";
import type { CompletionRequest } from "../src/types.js";
import { ManualClock } from "./manual-clock.js";

const start = { type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } };
const block = { type: "content_block_start", index: 0, content_block: { type: "text", text: "visible" } };
const sse = (event: unknown) => fixtureSse([event]);
const request = (extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "fixture", system: "", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [], maxTokens: 10, signal: new AbortController().signal, onText: () => {}, ...extra,
});
async function until(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 2000; n++) { if (predicate()) return; await pause(1); }
  assert.fail("local fixture did not reach expected state");
}
async function fixture(t: TestContext, handler: (res: ServerResponse, index: number) => void, clock: ManualClock, policy: TimeoutPolicy, extra: { maxRetries?: number; allowNonStreamingFallback?: boolean; recoveryPolicy?: Partial<Omit<RecoveryPolicy, "maxRetries">> } = {}) {
  let calls = 0, closed = 0;
  const http = createServer((req, res) => { calls++; req.socket.once("close", () => closed++); handler(res, calls); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return {
    provider: new AnthropicProvider({ apiKey: "loopback", baseUrl: `http://127.0.0.1:${address.port}`, timeoutPolicy: policy, clock, maxRetries: 0, allowNonStreamingFallback: false, ...extra }),
    calls: () => calls, closed: () => closed,
  };
}

test("a pending-header deadline aborts the actual connection with a sanitized error", { timeout: 5000 }, async t => {
  const clock = new ManualClock();
  const f = await fixture(t, () => {}, clock, resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "75" }, baseUrl: "http://localhost" }));
  const result = f.provider.complete(request());
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "request" && error.milliseconds === 75);
  await until(() => f.calls() === 1); clock.advance(75); await rejection;
  await until(() => f.closed() === 1); assert.equal(clock.pending, 0); assert.equal(f.calls(), 1);
});

test("first-header retries escalate the window and consume the shared attempt allowance", { timeout: 5000 }, async t => {
  const clock = new ManualClock(), budget = new ApiAttemptBudget(2);
  const policy = resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "60000", CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "10000" } });
  const f = await fixture(t, () => {}, clock, policy, { maxRetries: 1 });
  const result = f.provider.complete(request({ attemptBudget: budget }));
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "first-header" && error.milliseconds === 59000);
  await until(() => f.calls() === 1); clock.advance(11000);
  await until(() => f.calls() === 2); assert.equal(budget.remaining, 0);
  clock.advance(58999); assert.equal(f.closed(), 1);
  clock.advance(1); await rejection; assert.equal(f.calls(), 2); assert.equal(clock.pending, 0);
});

test("accepted SSE outlives its header timeout but a body stall aborts without replay", { timeout: 5000 }, async t => {
  const clock = new ManualClock(); let text = "";
  const policy = resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "75", CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "10000" }, baseUrl: "http://localhost" });
  const f = await fixture(t, res => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(start) + sse(block)); }, clock, policy, { maxRetries: 2 });
  const result = f.provider.complete(request({ onText: value => { text += value; } }));
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "byte-idle");
  await until(() => text === "visible"); clock.advance(9999); assert.equal(f.calls(), 1);
  clock.advance(1); await rejection; await until(() => f.closed() === 1);
  assert.equal(text, "visible"); assert.equal(f.calls(), 1); assert.equal(clock.pending, 0);
});

test("byte and event watchdogs can both be disabled while cancellation still closes SSE", { timeout: 5000 }, async t => {
  const clock = new ManualClock(), abort = new AbortController(); let text = "";
  const policy = resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "75", CLAUDE_ENABLE_BYTE_WATCHDOG: "false", CLAUDE_ENABLE_STREAM_WATCHDOG: "false" } });
  const f = await fixture(t, res => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(start) + sse(block)); }, clock, policy);
  const result = f.provider.complete(request({ signal: abort.signal, onText: value => { text += value; } }));
  const rejection = assert.rejects(result, { name: "AbortError" });
  await until(() => text === "visible"); assert.equal(clock.pending, 0);
  clock.advance(10000000); abort.abort(); await rejection; await until(() => f.closed() === 1); assert.equal(clock.pending, 0);
});

test("fallback deadline covers the whole JSON body even after headers and partial bytes", { timeout: 5000 }, async t => {
  const clock = new ManualClock(); let text = "";
  const policy = resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "75" }, baseUrl: "http://localhost" });
  const f = await fixture(t, (res, index) => {
    if (index === 1) { res.writeHead(404); res.end(); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.write('{"type":"message","role":"assistant","content":['); }
  }, clock, policy, { allowNonStreamingFallback: true, maxRetries: 1 });
  const result = f.provider.complete(request({ onText: value => { text += value; } }));
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "nonstream");
  await until(() => f.calls() === 2); await pause(10); clock.advance(75); await rejection;
  assert.equal(f.calls(), 2); assert.equal(text, ""); assert.equal(clock.pending, 0);
});

test("cancelling from the final JSON text callback cannot commit a successful completion", { timeout: 5000 }, async t => {
  const clock = new ManualClock(), abort = new AbortController();
  const f = await fixture(t, (res, index) => {
    if (index === 1) { res.writeHead(404); res.end(); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })); }
  }, clock, resolveTimeoutPolicy({ env: {} }), { allowNonStreamingFallback: true });
  await assert.rejects(f.provider.complete(request({ signal: abort.signal, onText: () => abort.abort() })), { name: "AbortError" });
  assert.equal(clock.pending, 0);
});

test("ignored HTTP pings feed only thirty raw-byte heartbeats before event progress expires", { timeout: 5000 }, async t => {
  const clock = new ManualClock(); let output: ServerResponse | undefined, text = "";
  const policy = resolveTimeoutPolicy({ env: { CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1800000" }, baseUrl: "http://localhost" });
  const f = await fixture(t, res => { output = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(start) + sse(block)); }, clock, policy, { maxRetries: 2 });
  const result = f.provider.complete(request({ onText: value => { text += value; } }));
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "event-idle");
  await until(() => text === "visible"); assert.ok(output);
  for (let n = 0; n < 31; n++) {
    // Put bytes between heartbeat ticks, so the strict last-byte > base check
    // observes fresh bytes during every ten-second interval.
    clock.advance(1000); const scheduled = clock.scheduled;
    output.write(sse({ type: "ping" }));
    await until(() => clock.scheduled > scheduled);
    clock.advance(9000);
  }
  clock.advance(289999); assert.equal(f.calls(), 1); clock.advance(1); await rejection;
  assert.equal(text, "visible"); assert.equal(f.calls(), 1); assert.equal(clock.pending, 0);
});

test("successful SSE completion disposes request, idle and heartbeat timers", { timeout: 5000 }, async t => {
  const clock = new ManualClock(); let output: ServerResponse | undefined, text = "";
  const f = await fixture(t, res => { output = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(start) + sse(block)); }, clock, resolveTimeoutPolicy({ env: {} }));
  const result = f.provider.complete(request({ onText: value => { text += value; } }));
  await until(() => text === "visible"); assert.ok(output); clock.advance(5000);
  output.end(sse({ type: "content_block_stop", index: 0 }) + sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + sse({ type: "message_stop" }));
  assert.deepEqual((await result).content, [{ type: "text", text: "visible" }]);
  assert.equal(clock.pending, 0); clock.advance(10000000); assert.equal(clock.pending, 0);
});

test("ordinary retry capacity cannot bypass the independent first-header cap", { timeout: 5000 }, async t => {
  const clock = new ManualClock(), budget = new ApiAttemptBudget(10);
  const f = await fixture(t, () => {}, clock, resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "60000", CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "10000" } }), { maxRetries: 3 });
  const result = f.provider.complete(request({ attemptBudget: budget }));
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "first-header" && error.milliseconds === 59000);
  await until(() => f.calls() === 1); clock.advance(11000);
  await until(() => f.calls() === 2); clock.advance(59000); await rejection;
  assert.equal(f.calls(), 2); assert.equal(budget.remaining, 8); assert.equal(clock.pending, 0);
});

test("header suspension leaves the first-header escalation and ordinary retry allowance untouched", { timeout: 5000 }, async t => {
  const clock = new ManualClock();
  const f = await fixture(t, () => {}, clock, resolveTimeoutPolicy({ env: { API_TIMEOUT_MS: "60000", CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "10000" } }), { maxRetries: 1 });
  const result = f.provider.complete(request());
  const rejection = assert.rejects(result, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "first-header" && error.milliseconds === 59000);
  await until(() => f.calls() === 1); clock.suspend(11000);
  await until(() => f.calls() === 2); clock.advance(11000);
  await until(() => f.calls() === 3); clock.advance(59000); await rejection;
  assert.equal(f.calls(), 3); assert.equal(clock.pending, 0);
});

test("persistent capacity can retry429 at zero ordinary budget, while background529 fails", { timeout: 5000 }, async t => {
  const clock = new ManualClock(), policy = resolveTimeoutPolicy({ env: {} });
  const f = await fixture(t, (res, index) => {
    if (index === 1) { res.writeHead(429); res.end(); }
    else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse(start) + sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + sse({ type: "message_stop" })); }
  }, clock, policy, { maxRetries: 0, recoveryPolicy: { persistent: true, persistentCapacityOnly: true } });
  await f.provider.complete(request()); assert.equal(f.calls(), 2); assert.equal(clock.pending, 0);
  const background = await fixture(t, res => { res.writeHead(529); res.end(); }, clock, policy, { maxRetries: 2, recoveryPolicy: { background: true } });
  await assert.rejects(background.provider.complete(request()), /HTTP error 529/);
  assert.equal(background.calls(), 1); assert.equal(clock.pending, 0);
});
