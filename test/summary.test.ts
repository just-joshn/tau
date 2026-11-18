import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { fixtureSse } from "./sse-fixture.js";
import { AnthropicProvider } from "../src/provider.js";
import { ApiAttemptBudget } from "../src/attempt-ledger.js";
import { compactContext, freshCompactionState } from "../src/compaction.js";
import { activeContextStart } from "../src/context-usage.js";
import { SummaryPlanner } from "../src/compaction-plan.js";
import { readSummary, renderSummary, summaryShape } from "../src/summary-response.js";
import type { AgentEvent, Completion, CompletionRequest, Message } from "../src/types.js";

const user = (text = "pending"): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
const rows = (): Message[] => [user("opening"), assistant("older answer"), user("middle"), assistant("latest answer"), user()];
const closed = (text: string) => `<summary>${text}</summary>`;
function respond(res: ServerResponse, text: string, stop = "end_turn") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(fixtureSse([{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text } }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 2 } }, { type: "message_stop" }]));
}
function fail(res: ServerResponse, status = 400, message = status === 400 ? "prompt is too long: 201000 tokens > 200000" : "failed") {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
}
async function fixture(t: TestContext, handler: (body: any, res: ServerResponse, count: number) => void, maxRetries = 0) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => { let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); bodies.push(body); handler(body, res, bodies.length); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({ apiKey: "loopback", baseUrl: `http://127.0.0.1:${address.port}`, maxRetries, allowNonStreamingFallback: false });
  const request = (messages = rows(), extra: Partial<CompletionRequest> = {}): CompletionRequest => ({ model: "claude-sonnet-4-5", system: "Parent", messages,
    tools: [{ name: "Write", description: "Write", input_schema: { type: "object" } }], maxTokens: 32000, signal: t.signal, onText: () => { throw new Error("Summary text leaked"); }, ...extra });
  return { bodies, provider, request };
}

test("summary shapes ignore one completed analysis block and distinguish open anchors from inline text", () => {
  assert.equal(summaryShape("<analysis><summary>not a summary</summary></analysis>plain"), "none");
  assert.equal(summaryShape("<analysis>reasoning</analysis>\n  <summary>open"), "open");
  assert.equal(summaryShape("text <summary>open"), "none");
  assert.equal(summaryShape("text <summary>closed</summary> after"), "closed");
  assert.equal(summaryShape("<Summary>different case</Summary>"), "none");
  assert.equal(renderSummary("<analysis>private reasoning</analysis>\n<summary>  facts \n</summary>\n\n\nmore"), "Summary:\nfacts\n\nmore");
});

test("summary text selection uses the first text block and accepts an output-limited open summary", () => {
  const completion: Completion = { content: [{ type: "text", text: "<summary>open" }, { type: "text", text: "later" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal(readSummary(completion).shape, "open"); assert.equal(readSummary(completion).raw, "<summary>open");
  assert.throws(() => readSummary({ ...completion, content: [{ type: "text", text: "" }, { type: "text", text: closed("later") }] }));
  assert.throws(() => readSummary({ ...completion, partial: { cause: "connectionLost" } }));
});

test("a missing block gets one bounded formatting request with fresh original input and shared admission", async t => {
  const f = await fixture(t, (_body, res, count) => respond(res, count === 1 ? "first candidate" : closed("repaired")));
  const messages = rows(), budget = new ApiAttemptBudget(3), events: AgentEvent[] = [];
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages, { attemptBudget: budget }), state: freshCompactionState(), onEvent: event => events.push(event) }), true);
  assert.equal(f.bodies.length, 2); assert.equal(budget.remaining, 1);
  assert.deepEqual(f.bodies[0].messages.slice(0, -1), f.bodies[1].messages.slice(0, -1)); assert.ok(!JSON.stringify(f.bodies[1]).includes("first candidate"));
  const initialTail = f.bodies[0].messages.at(-1), repairTail = f.bodies[1].messages.at(-1);
  assert.equal(repairTail.role, "user"); assert.deepEqual(initialTail.content.slice(0, -1), repairTail.content.slice(0, -1));
  assert.ok(initialTail.content.at(-1).text.startsWith("Create a continuation summary"));
  assert.ok(!initialTail.content.at(-1).text.includes("formatting retry"));
  assert.ok(repairTail.content.at(-1).text.includes("formatting retry"));
  assert.deepEqual(f.bodies[0].tools, f.bodies[1].tools); assert.equal(f.bodies[0].system, "Parent");
  const boundary = messages[activeContextStart(messages)]!;
  assert.ok(JSON.stringify(boundary).includes("Summary:\\nrepaired")); assert.equal(boundary.contextBoundary?.formatRepairs, 1);
  assert.equal(events.filter(event => event.type === "usage").length, 2);
});

test("format repair has one dispatch, then ordinary scope may retain its first unmarked text", async t => {
  for (const mode of ["failure", "unmarked", "disabled"] as const) {
    const f = await fixture(t, (_body, res, count) => count === 2 && mode === "failure" ? fail(res, 503) : respond(res, count === 1 ? "first candidate" : "second candidate"), 3);
    const messages = rows();
    assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state: freshCompactionState(), planning: { retryMissingSummary: mode !== "disabled" }, onEvent: () => {} }), true);
    assert.equal(f.bodies.length, mode === "disabled" ? 1 : 2); assert.ok(JSON.stringify(messages[activeContextStart(messages)]).includes("first candidate"));
  }
});

test("a one-attempt summary scope rejects unmarked text but accepts an open block without repair", async t => {
  for (const marked of [false, true]) {
    const f = await fixture(t, (_body, res) => respond(res, marked ? "<summary>open" : "unmarked", "max_tokens"));
    const messages = rows(), original = structuredClone(messages), budget = new ApiAttemptBudget(3);
    assert.equal(await compactContext({ provider: f.provider, request: f.request(messages, { attemptBudget: budget }), state: freshCompactionState(), attemptLimit: 1, onEvent: () => {} }), marked);
    assert.equal(f.bodies.length, 1); assert.equal(budget.remaining, 2); if (!marked) assert.deepEqual(messages, original);
  }
});

test("opening rescue uses the70k margin before sacrificing a substantive first exchange", async t => {
  const original: Message[] = [user("O".repeat(360000)), assistant("keep this reply"), user()];
  const f = await fixture(t, (_body, res) => respond(res, closed("opening facts")));
  const messages = structuredClone(original);
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state: freshCompactionState(), inputError: { kind: "prompt", gap: 1000 }, onEvent: () => {} }), true);
  assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].messages.length, 1); assert.equal(f.bodies[0].messages[0].role, "user");
  assert.equal(f.bodies[0].messages[0].content.length, 2); assert.equal(f.bodies[0].messages[0].content[0].text, "O".repeat(360000) + "\n");
  assert.ok(f.bodies[0].messages[0].content[1].text.startsWith("Create a continuation summary"));
  assert.equal(activeContextStart(messages), 1); assert.equal(messages[1]!.contextBoundary?.openingRescue, true); assert.equal(messages[1]!.contextBoundary?.headTruncations, 0);
  assert.deepEqual(messages[0], original[0]); assert.deepEqual(messages.slice(2), original.slice(1));
  const boundary = [user("x".repeat(320000)), assistant("reply"), user()];
  assert.equal(new SummaryPlanner(boundary, {}, { kind: "prompt", gap: 2000 }).next()?.openingOnly, true);
  assert.notEqual(new SummaryPlanner(boundary, {}, { kind: "prompt", gap: 2001 }).next()?.openingOnly, true);
});

test("a failed or unclosed opening-only result is discarded before head reduction", async t => {
  for (const mode of ["open", "error"] as const) {
    const f = await fixture(t, (_body, res, count) => count === 1 && mode === "error" ? fail(res, 503) : respond(res, count === 1 ? "<summary>unfinished" : closed("remaining facts")));
    const messages = [user("O".repeat(360000)), assistant("keep"), user()], original = structuredClone(messages);
    assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state: freshCompactionState(), inputError: { kind: "prompt", gap: 1000 }, onEvent: () => {} }), true);
    assert.equal(f.bodies.length, 2); assert.ok(!JSON.stringify(f.bodies[1]).includes("O".repeat(1000)));
    assert.deepEqual(messages.slice(0, 2), original.slice(0, 2)); assert.equal(messages[2]!.contextBoundary?.headTruncations, 1); assert.equal(messages[2]!.contextBoundary?.openingRescue, false);
  }
});

test("a full-summary size refusal can rescue the opening alone without truncating it", async t => {
  const f = await fixture(t, (_body, res, count) => count === 1 ? fail(res) : respond(res, closed("opening facts")));
  const messages = [user("O".repeat(360000)), assistant("tail"), user()];
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state: freshCompactionState(), planning: { keepNoRound: true }, onEvent: () => {} }), true);
  assert.equal(f.bodies.length, 2); assert.equal(f.bodies[1].messages.length, 1); assert.equal(f.bodies[1].messages[0].role, "user");
  assert.equal(f.bodies[1].messages[0].content.length, 2); assert.equal(f.bodies[1].messages[0].content[0].text, "O".repeat(360000) + "\n");
  assert.ok(f.bodies[1].messages[0].content[1].text.startsWith("Create a continuation summary"));
  assert.equal(messages[1]!.contextBoundary?.openingRescue, true);
});

test("an optional retained-round summary combines the first summary and completed tail", async t => {
  const f = await fixture(t, (_body, res, count) => respond(res, closed(count === 1 ? "first facts" : "combined facts")));
  const messages = rows();
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state: freshCompactionState(), planning: { summarizeKeptRounds: true }, onEvent: () => {} }), true);
  assert.equal(f.bodies.length, 2); assert.ok(JSON.stringify(f.bodies[1]).includes("first facts")); assert.ok(JSON.stringify(f.bodies[1]).includes("latest answer"));
  assert.ok(!JSON.stringify(f.bodies[1]).includes("older answer"));
  assert.equal(activeContextStart(messages), 4); assert.equal(messages[4]!.contextBoundary?.secondarySummary, true); assert.equal(messages[4]!.contextBoundary?.groupsPreserved, 0);
  assert.deepEqual(messages[5], user());
});

test("an unsuccessful optional second summary salvages the first valid result without a third plan", async t => {
  for (const mode of ["size", "open", "format", "exhausted"] as const) {
    const f = await fixture(t, (_body, res, count) => count === 2 && mode === "size" ? fail(res) : respond(res, count === 1 ? closed("first facts") : mode === "open" ? "<summary>open" : "unmarked"));
    const messages = rows(), budget = new ApiAttemptBudget(mode === "exhausted" ? 1 : 5), state = freshCompactionState();
    assert.equal(await compactContext({ provider: f.provider, request: f.request(messages, { attemptBudget: budget }), state, planning: { summarizeKeptRounds: true }, onEvent: () => {} }), true);
    assert.equal(f.bodies.length, mode === "exhausted" ? 1 : mode === "format" ? 3 : 2);
    assert.equal(activeContextStart(messages), 3); assert.equal(messages[3]!.contextBoundary?.secondarySummary, false); assert.equal(state.consecutiveFailures, 0);
    assert.ok(JSON.stringify(messages[3]).includes("first facts")); assert.equal(messages[4]!.content[0]!.type, "text");
  }
});

test("cancellation during a repair or secondary summary prevents salvage and preserves history", async t => {
  for (const secondary of [false, true]) {
    const controller = new AbortController(), f = await fixture(t, (_body, res, count) => {
      if (count === 1) respond(res, secondary ? closed("first") : "plain");
      else { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"ping"}\n\n'); controller.abort(); }
    });
    const messages = rows(), original = structuredClone(messages), state = freshCompactionState();
    await assert.rejects(compactContext({ provider: f.provider, request: f.request(messages, { signal: controller.signal }), state, planning: { summarizeKeptRounds: secondary }, onEvent: () => {} }), { name: "AbortError" });
    assert.equal(f.bodies.length, 2); assert.deepEqual(messages, original); assert.equal(state.consecutiveFailures, 0);
  }
});

test("manual compaction summarizes all active messages, bypasses automatic breakers and permits one user", async t => {
  for (const messages of [rows(), [user("unfinished request")]]) {
    const f = await fixture(t, (_body, res) => respond(res, "manual plain summary")), original = structuredClone(messages);
    const state = { ...freshCompactionState(), consecutiveFailures: 3, compacted: true, consecutiveRapidRefills: 3 };
    assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state, reason: "manual", onEvent: () => {} }), true);
    assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].messages.length, original.length);
    assert.deepEqual(f.bodies[0].messages.slice(0, -1), original.slice(0, -1));
    const tail = f.bodies[0].messages.at(-1);
    assert.equal(tail.role, "user"); assert.equal(tail.content.length, 2);
    assert.deepEqual(tail.content[0], { type: "text", text: (original.at(-1)!.content[0] as { text: string }).text + "\n" });
    assert.ok(tail.content[1].text.startsWith("Create a continuation summary"));
    assert.deepEqual(messages.slice(0, original.length), original);
    assert.equal(activeContextStart(messages), original.length); assert.equal(messages.length, original.length + 1); assert.equal(state.consecutiveRapidRefills, 0);
  }
});

test("manual summary size retries drop whole groups at most three times and charge shared admission", async t => {
  const messages = [user()]; for (let n = 0; n < 10; n++) messages.push(assistant(`reply${n}`), user());
  const original = structuredClone(messages), f = await fixture(t, (_body, res) => fail(res, 400, "context_length_exceeded")), budget = new ApiAttemptBudget(5);
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages, { attemptBudget: budget }), state: freshCompactionState(), reason: "manual", planning: { cachePrefix: false }, onEvent: () => {} }), false);
  assert.equal(f.bodies.length, 4); assert.equal(budget.remaining, 1); assert.deepEqual(messages, original);
});

test("caller exhaustion before a format retry cannot create an extra dispatch", async t => {
  const f = await fixture(t, (_body, res) => respond(res, "usable first text")), messages = rows(), budget = new ApiAttemptBudget(1);
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages, { attemptBudget: budget }), state: freshCompactionState(), onEvent: () => {} }), true);
  assert.equal(f.bodies.length, 1); assert.equal(budget.remaining, 0); assert.ok(JSON.stringify(messages[activeContextStart(messages)]).includes("usable first text"));
});

test("an unusable opening cannot consume another dispatch after global exhaustion", async t => {
  const f = await fixture(t, (_body, res) => respond(res, "<summary>unfinished")), messages = [user("O".repeat(360000)), assistant("tail"), user()];
  const original = structuredClone(messages), state = freshCompactionState();
  await assert.rejects(compactContext({ provider: f.provider, request: f.request(messages, { attemptBudget: new ApiAttemptBudget(1) }), state,
    inputError: { kind: "prompt", gap: 1000 }, onEvent: () => {} }), { name: "ApiAttemptBudgetExhausted" });
  assert.equal(f.bodies.length, 1); assert.deepEqual(messages, original); assert.equal(state.consecutiveFailures, 0);
});

test("an observer failure in the optional summary is not swallowed as a model failure to salvage", async t => {
  const f = await fixture(t, (_body, res) => respond(res, closed("facts"))), messages = rows(), original = structuredClone(messages);
  let usages = 0;
  assert.equal(await compactContext({ provider: f.provider, request: f.request(messages), state: freshCompactionState(), planning: { summarizeKeptRounds: true },
    onEvent: event => { if (event.type === "usage" && ++usages === 2) throw new Error("observer failed"); } }), false);
  assert.equal(f.bodies.length, 2); assert.deepEqual(messages, original);
});
