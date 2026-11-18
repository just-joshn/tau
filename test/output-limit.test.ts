import { fixtureSse } from "./sse-fixture.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { AnthropicProvider } from "../src/provider.js";
import { ApiAttemptBudget } from "../src/attempt-ledger.js";
import { OutputLimitRepair } from "../src/output-limit.js";
import { thinkingRequest, usesAssumedOutputLimit } from "../src/reasoning.js";
import type { CompletionRequest } from "../src/types.js";

const model = "claude-sonnet-4-5";
function fail(res: ServerResponse, status: number, message: string, type = "invalid_request_error") {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message, type } }));
}
const capMessage = (limit = 8192) => `max_tokens: 64000 > ${limit}, which is the maximum allowed number of output tokens for test-model`;
function success(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(fixtureSse([{ type: "message_start", message: { id: "response-id", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]
    ));
}
async function fixture(t: TestContext, handler: (body: any, res: ServerResponse, count: number) => void, options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => { let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); bodies.push(body); handler(body, res, bodies.length); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({ apiKey: "loopback", baseUrl: `http://127.0.0.1:${address.port}`, maxRetries: 0, allowNonStreamingFallback: false, ...options });
  const request = (extra: Partial<CompletionRequest> = {}): CompletionRequest => ({ model, system: "", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [], maxTokens: 64000, signal: t.signal, onText: () => {}, ...extra });
  return { bodies, provider, request };
}

test("explicit server output cap retries once, recomputes thinking, learns on message start and resets", async t => {
  const f = await fixture(t, (_body, res, count) => count === 1 ? fail(res, 402, capMessage()) : success(res), { thinking: { mode: "enabled" } });
  const completion = await f.provider.complete(f.request());
  assert.equal(completion.responseId, "response-id"); assert.deepEqual(f.bodies.map(body => body.max_tokens), [64000, 8192]);
  assert.equal(f.bodies[1].thinking.budget_tokens, 8191); assert.equal(f.provider.outputTokenLimit(model), 8192);
  await f.provider.complete(f.request({ model: "claude-sonnet-4-5-20250929" })); assert.equal(f.bodies[2].max_tokens, 8192);
  f.provider.resetRequestLimits(); await f.provider.complete(f.request()); assert.equal(f.bodies[3].max_tokens, 64000);
  assert.ok(!JSON.stringify(f.bodies).includes("requestedModel"));
});

test("headers and malformed message starts cannot prove a tentative output cap", async t => {
  for (const malformed of [false, true]) {
    const f = await fixture(t, (_body, res, count) => {
      if (count === 1) fail(res, 400, capMessage());
      else if (count === 2) { res.writeHead(200, { "content-type": malformed ? "text/event-stream" : "text/plain" }); res.end(malformed ? 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n' : "not a reply"); }
      else success(res);
    });
    await assert.rejects(f.provider.complete(f.request())); assert.equal(f.provider.outputTokenLimit(model), Infinity);
    await f.provider.complete(f.request()); assert.deepEqual(f.bodies.map(body => body.max_tokens), [64000, 8192, 64000]);
  }
});

test("a second eligible rejection spends the repair and cancels pending learning", async t => {
  const f = await fixture(t, (_body, res, count) => count <= 2 ? fail(res, 400, capMessage(count === 1 ? 8192 : 4096)) : success(res));
  await assert.rejects(f.provider.complete(f.request()), /HTTP error 400/);
  assert.equal(f.bodies.length, 2); assert.equal(f.provider.outputTokenLimit(model), Infinity);
  await f.provider.complete(f.request()); assert.equal(f.bodies[2].max_tokens, 64000);
});

test("output repair uses the caller allowance even with ordinary retries disabled", async t => {
  const f = await fixture(t, (_body, res) => fail(res, 422, capMessage()));
  await assert.rejects(f.provider.complete(f.request({ attemptBudget: new ApiAttemptBudget(1) })), { name: "ApiAttemptBudgetExhausted" });
  assert.equal(f.bodies.length, 1); assert.equal(f.provider.outputTokenLimit(model), Infinity);
});

test("a validated JSON fallback proves an output cap without enabling another stream fallback", async t => {
  const f = await fixture(t, (_body, res, count) => {
    if (count === 1) { res.writeHead(404); res.end(); }
    else if (count === 2) fail(res, 429, capMessage());
    else {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "message", role: "assistant", id: "json-response", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
    }
  }, { allowNonStreamingFallback: true });
  const completion = await f.provider.complete(f.request({ attemptBudget: new ApiAttemptBudget(3) }));
  assert.equal(completion.responseId, "json-response"); assert.deepEqual(f.bodies.map(body => body.stream), [true, false, false]);
  assert.deepEqual(f.bodies.map(body => body.max_tokens), [64000, 64000, 8192]); assert.equal(f.provider.outputTokenLimit(model), 8192);
});

test("unknown output defaults can try32k for generic or combined errors but preserve specialized failures", async t => {
  for (const message of ["unrecognized request option", "input length and `max_tokens` exceed context limit", "capability_rejected: max_tokens_context_overflow"]) {
    const f = await fixture(t, (_body, res, count) => count === 1 ? fail(res, 413, message) : success(res));
    await f.provider.complete(f.request({ model: "custom-model" })); assert.deepEqual(f.bodies.map(body => body.max_tokens), [64000, 32000]);
  }
  for (const message of ["prompt is too long: 210000 tokens > 200000", "could not process image", "capability_rejected: prompt_too_long", "dlp_request_denied"]) {
    const f = await fixture(t, (_body, res) => fail(res, 400, message));
    await assert.rejects(f.provider.complete(f.request({ model: "custom-model" }))); assert.equal(f.bodies.length, 1);
  }
});

test("known models, billing failures and implausible explicit limits do not get guessed caps", () => {
  for (const [status, message, type, name] of [
    [400, "unknown error", "invalid_request_error", model], [401, capMessage(), "invalid_request_error", "custom"],
    [500, capMessage(), "api_error", "custom"], [400, "unknown error", "billing_error", "custom"],
    [400, capMessage(1024), "invalid_request_error", model], [400, capMessage(128000), "invalid_request_error", model],
  ] as const) {
    const repair = new OutputLimitRepair(name, name, new Map()); assert.equal(repair.onError(status, { message, type }, 64000), false);
  }
  const learned = new Map<string, number>(), repair = new OutputLimitRepair(model, model, learned);
  assert.equal(repair.onError(429, { message: capMessage() }, 64000), true);
  assert.equal(repair.onError(429, { message: "later rejection" }, 8192), false);
  repair.onReplyBegun(); assert.equal(learned.size, 0);
});

test("explicit positive output overrides remove the unknown-model thinking assumption", () => {
  assert.equal(usesAssumedOutputLimit("custom", {}), true);
  assert.equal(usesAssumedOutputLimit("custom", { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" }), false);
  assert.deepEqual(thinkingRequest("custom", 64000, {}, { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "50000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", ANTHROPIC_CUSTOM_MODEL_OPTION: "custom", ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "thinking" }), { type: "enabled", budget_tokens: 50000 });
  assert.deepEqual(thinkingRequest("custom", 64000, {}, { MAX_THINKING_TOKENS: "50000", ANTHROPIC_CUSTOM_MODEL_OPTION: "custom", ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "thinking" }), { type: "enabled", budget_tokens: 31999 });
});
