import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AnthropicProvider } from "../src/provider.js";
import { TransportTimeoutError } from "../src/deadline.js";
import { resolveTimeoutPolicy } from "../src/timeout-policy.js";
import type { CompletionRequest } from "../src/types.js";
import { fixtureEvents, fixtureSse } from "./sse-fixture.js";
import { ManualClock } from "./manual-clock.js";

const start = { type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } };
const events = [start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "mock done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" },
];
const jsonReply = { type: "message", role: "assistant", content: [{ type: "text", text: "mock done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } };
const request = (t: TestContext, extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "fixture", system: "", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [], maxTokens: 100, signal: t.signal, onText: () => {}, ...extra,
});
async function fixture(t: TestContext, stream: string | ((res: ServerResponse) => void), options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  const bodies: Array<{ stream: boolean }> = [];
  const http = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { stream: boolean }; bodies.push(body);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (typeof stream === "string") res.end(stream); else stream(res);
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(jsonReply)); }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  const address = http.address(); assert.ok(address && typeof address !== "string");
  return { bodies, provider: new AnthropicProvider({ apiKey: "loopback", baseUrl: `http://127.0.0.1:${address.port}`, maxRetries: 2, ...options }) };
}

test("named SSE succeeds once while a data-only stream uses one JSON fallback at the default retry allowance", async t => {
  for (const named of [true, false]) {
    const wire = named ? fixtureSse(events) : fixtureEvents(events).map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    const f = await fixture(t, wire);
    const displayed: string[] = [];
    const result = await f.provider.complete(request(t, { onText: text => displayed.push(text) }));
    assert.deepEqual(f.bodies.map(body => body.stream), named ? [true] : [true, false]);
    assert.deepEqual(result.content, [{ type: "text", text: "mock done" }]);
    assert.equal(displayed.join(""), "mock done");
  }
});

test("unknown, absent, empty and ping labels ignore data before JSON parsing or semantic dispatch", async t => {
  const ignored = [
    "data: {not-json}\n\n", "event:\ndata: {not-json}\n\n", "event: future_label\ndata: {not-json}\n\n",
    "event: ping\ndata: {not-json}\n\n", "event: ping\ndata: {\"type\":\"message_stop\"}\n\n",
    "event: unknown\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"ignored\"}}\n\n",
  ].join("");
  const f = await fixture(t, ignored + fixtureSse(events));
  assert.deepEqual((await f.provider.complete(request(t))).content, [{ type: "text", text: "mock done" }]);
  assert.deepEqual(f.bodies.map(body => body.stream), [true]);
});

test("recognized SSE labels dispatch by body.type rather than requiring matching labels", async t => {
  for (const label of ["message", "completion", "session.updated", "message_stop"]) {
    const wire = fixtureEvents(events).map(event => `event: ${label}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const f = await fixture(t, wire);
    assert.deepEqual((await f.provider.complete(request(t))).content, [{ type: "text", text: "mock done" }]);
    assert.equal(f.bodies.length, 1);
  }
});

test("wire error labels always take the error path even for malformed or output-shaped data", async t => {
  for (const data of ["{bad-json}", JSON.stringify(start), JSON.stringify({ error: { type: "permission_error", message: "private error" } })]) {
    const f = await fixture(t, `event: error\ndata: ${data}\n\n` + fixtureSse(events), { allowNonStreamingFallback: false });
    const displayed: string[] = [];
    await assert.rejects(f.provider.complete(request(t, { onText: text => displayed.push(text) })), /Messages API returned a streaming error/);
    assert.deepEqual(displayed, []); assert.equal(f.bodies.length, 1);
  }
});

test("future object body types and missing types are ignored without hiding known malformed bodies", async t => {
  const unknown = [{ type: "future_body", value: 1 }, {}, { type: { future: true } }, { type: "error", error: { type: "permission_error", message: "ordinary body" } }]
    .map(body => `event: message\ndata: ${JSON.stringify(body)}\n\n`).join("");
  const f = await fixture(t, unknown + fixtureSse(events));
  assert.deepEqual((await f.provider.complete(request(t))).content, [{ type: "text", text: "mock done" }]);
  assert.equal(f.bodies.length, 1);
  const malformed = await fixture(t, 'event: message\ndata: {"type":"message_start","message":5}\n\n', { allowNonStreamingFallback: false });
  await assert.rejects(malformed.provider.complete(request(t)), /protocol/);
  assert.equal(malformed.bodies.length, 1);
});

test("recognized labels parse empty data and null, while non-null primitives and arrays can precede valid output", async t => {
  for (const data of ["", "null"]) {
    const f = await fixture(t, `event: message\ndata: ${data}\n\n`, { allowNonStreamingFallback: false });
    await assert.rejects(f.provider.complete(request(t)), /protocol/);
    assert.equal(f.bodies.length, 1);
  }
  for (const data of ["1", "false", '"text"', "[]"]) {
    const f = await fixture(t, `event: message\ndata: ${data}\n\n` + fixtureSse(events));
    assert.deepEqual((await f.provider.complete(request(t))).content, [{ type: "text", text: "mock done" }]);
    assert.equal(f.bodies.length, 1);
  }
});

test("an unknown object from a recognized label renews semantic progress without replaying partial output", { timeout: 5000 }, async t => {
  const clock = new ManualClock(); let output: ServerResponse | undefined, shown = "";
  const f = await fixture(t, res => { output = res; res.write(fixtureSse(events.slice(0, 2))); }, {
    clock, timeoutPolicy: resolveTimeoutPolicy({ env: { CLAUDE_ENABLE_BYTE_WATCHDOG: "0" } }), allowNonStreamingFallback: false,
  });
  const pending = f.provider.complete(request(t, { onText: text => { shown += text; } }));
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof TransportTimeoutError && error.stage === "event-idle");
  for (let n = 0; n < 1000 && !shown; n++) await pause(1);
  assert.equal(shown, "mock done"); assert.ok(output);
  clock.advance(299999); const scheduled = clock.scheduled;
  output.write('event: message\ndata: {"type":"future_body"}\n\n');
  for (let n = 0; n < 1000 && clock.scheduled === scheduled; n++) await pause(1);
  assert.ok(clock.scheduled > scheduled);
  clock.advance(299999); assert.equal(f.bodies.length, 1);
  clock.advance(1); await rejected;
  assert.equal(f.bodies.length, 1); assert.equal(shown, "mock done"); assert.equal(clock.pending, 0);
});
