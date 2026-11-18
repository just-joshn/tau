import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";
import { ApiAttemptBudget } from "../../src/attempt-ledger.js";
import {
  compactContext,
  freshCompactionState,
  largerCompactionModel,
} from "../../src/compaction.js";
import { activeContextStart } from "../../src/context-usage.js";
import {
  AnthropicProvider,
  ModelUnavailableError,
} from "../../src/provider.js";
import { toolDefinitions } from "../../src/tools.js";
import type {
  AgentEvent,
  CompletionRequest,
  Message,
  ToolDefinition,
} from "../../src/types.js";

const requestBodySchema = z.looseObject({
  model: z.string(),
  system: z.unknown().optional(),
  thinking: z.unknown().optional(),
  messages: z.array(
    z.looseObject({
      content: z.array(
        z.looseObject({
          cache_control: z.unknown().optional(),
          input: z.unknown().optional(),
        }),
      ),
    }),
  ),
  tools: z
    .array(
      z.looseObject({
        name: z.string(),
        cache_control: z.unknown().optional(),
      }),
    )
    .optional(),
});
type RequestBody = z.infer<typeof requestBodySchema>;
function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function firstBlock(body: RequestBody, message: number) {
  return present(present(body.messages[message]).content[0]);
}
const user = (text = "pending"): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const rows = (): Message[] => [
  user("old request"),
  { role: "assistant", content: [{ type: "text", text: "old reply" }] },
  user(),
];
function respond(
  res: ServerResponse,
  text = "<summary>Facts for continuation</summary>",
  tool = false,
) {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ];
  if (tool)
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "summary-read",
          name: "Read",
          input: { file_path: "fixture.txt" },
        },
      },
      { type: "content_block_stop", index: 0 },
    );
  else if (text)
    events.push(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text },
      },
      { type: "content_block_stop", index: 0 },
    );
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  );
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(fixtureSse(events));
}
function fail(res: ServerResponse, status: number, message = "failure") {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ error: { type: "invalid_request_error", message } }),
  );
}
function controllerSignal(): AbortSignal {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  return controller.signal;
}
async function fixture(
  handler: (body: RequestBody, res: ServerResponse, count: number) => void,
  options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) {
  const bodies: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = requestBodySchema.parse(JSON.parse(raw));
    bodies.push(body);
    handler(body, res, bodies.length);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const signal = controllerSignal();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({
    apiKey: "loopback",
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
    allowNonStreamingFallback: false,
    ...options,
  });
  const request = (
    messages = rows(),
    extra: Partial<CompletionRequest> = {},
  ): CompletionRequest => ({
    model: "claude-sonnet-4-5",
    system: "Parent project system",
    messages,
    tools: toolDefinitions(["Read", "Write", "Bash"]),
    maxTokens: 32000,
    signal,
    onText: () => {
      throw new Error("Summary leaked");
    },
    ...extra,
  });
  return { provider, request, bodies };
}

test("an empty cached summary uses a distinct fresh body under the same caller allowance", async () => {
  const f = await fixture((_body, res, count) =>
    respond(res, count === 1 ? "" : "<summary>fresh facts</summary>"),
  );
  const messages = rows(),
    original = structuredClone(messages),
    budget = new ApiAttemptBudget(2),
    events: AgentEvent[] = [];
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages, {
        attemptBudget: budget,
        thinking: { mode: "disabled" },
      }),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: (event) => events.push(event),
    }),
    true,
  );
  assert.equal(f.bodies.length, 2);
  assert.equal(budget.remaining, 0);
  assert.equal(present(f.bodies[0]).system, "Parent project system");
  assert.notEqual(present(f.bodies[1]).system, present(f.bodies[0]).system);
  assert.deepEqual(
    present(f.bodies[0]).messages,
    present(f.bodies[1]).messages,
  );
  assert.deepEqual(present(f.bodies[1]).tools, toolDefinitions(["Read"]));
  assert.deepEqual(
    present(f.bodies[1]).thinking,
    present(f.bodies[0]).thinking,
  );
  assert.deepEqual(messages.slice(0, original.length), original);
  assert.equal(present(messages[3]).contextBoundary?.freshRequests, 1);
  assert.equal(events.filter((event) => event.type === "usage").length, 2);
});

test("a cached size refusal tries the fresh body before truncating messages", async () => {
  const f = await fixture((_body, res, count) =>
    count === 1
      ? fail(res, 400, "prompt is too long: 201000 tokens > 200000")
      : respond(res),
  );
  const messages = rows();
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: () => {},
    }),
    true,
  );
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(
    present(f.bodies[0]).messages,
    present(f.bodies[1]).messages,
  );
  assert.equal(present(messages[3]).contextBoundary?.headTruncations, 0);
});

test("cached errors can fall back once and a fresh tool call never executes or commits", async () => {
  const f = await fixture((_body, res, count) =>
    count === 1 ? fail(res, 503) : respond(res, "", true),
  );
  const messages = rows(),
    original = structuredClone(messages);
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: () => {},
    }),
    false,
  );
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(messages, original);
});

test("cache-prefix assignment can start fresh and explicitly supplied extra tools are deduplicated", async () => {
  const f = await fixture((_body, res) => respond(res));
  const extra: ToolDefinition[] = [
    ...toolDefinitions(["Read"]),
    {
      name: "ToolSearch",
      description: "Discover tools",
      input_schema: { type: "object" },
    },
    {
      name: "mcp__fixture__query",
      description: "Query",
      input_schema: { type: "object" },
    },
  ];
  const messages = rows();
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages),
      state: freshCompactionState(),
      reason: "manual",
      planning: { cachePrefix: false, freshTools: extra },
      onEvent: () => {},
    }),
    true,
  );
  assert.equal(f.bodies.length, 1);
  assert.deepEqual(
    present(f.bodies[0]).tools?.map((tool) => tool.name),
    ["Read", "ToolSearch", "mcp__fixture__query"],
  );
  assert.equal(present(messages[3]).contextBoundary?.freshRequests, 1);
});

test("fresh serialization removes protocol cache markers without removing nested user input", async () => {
  const f = await fixture((_body, res, count) =>
    respond(res, count === 1 ? "" : "<summary>facts</summary>"),
  );
  const marker = { type: "ephemeral" };
  const messages: Message[] = [
    user(),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "prior",
          name: "Write",
          input: { cache_control: "literal data" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "prior", content: "done" }],
    },
    user(),
  ];
  Reflect.set(
    present(present(messages[0]).content[0]),
    "cache_control",
    marker,
  );
  const tools = [
    { ...present(toolDefinitions(["Write"])[0]), cache_control: marker },
  ];
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages, { tools }),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: () => {},
    }),
    true,
  );
  assert.deepEqual(firstBlock(present(f.bodies[0]), 0).cache_control, marker);
  assert.equal(firstBlock(present(f.bodies[1]), 0).cache_control, undefined);
  assert.deepEqual(firstBlock(present(f.bodies[1]), 1).input, {
    cache_control: "literal data",
  });
  assert.equal(
    present(present(f.bodies[1]).tools?.[0]).cache_control,
    undefined,
  );
  assert.ok(!Object.hasOwn(present(f.bodies[1]), "disablePromptCaching"));
});

test("fresh model fallback uses a finite configured chain and preserves global admission", async () => {
  const f = await fixture(
    (body, res, count) =>
      count === 1
        ? respond(res, "")
        : body.model.includes("sonnet")
          ? fail(res, 529)
          : respond(res),
    { fallbackModel: "claude-haiku-4-5", recoveryPolicy: { maxOverloaded: 1 } },
  );
  const messages = rows(),
    budget = new ApiAttemptBudget(3);
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages, { attemptBudget: budget }),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: () => {},
    }),
    true,
  );
  assert.deepEqual(
    f.bodies.map((body) => body.model),
    [
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ],
  );
  assert.equal(budget.remaining, 0);
  assert.equal(
    present(messages[3]).contextBoundary?.summaryModel,
    "claude-haiku-4-5",
  );
  assert.ok(
    f.bodies
      .slice(1)
      .every(
        (body) => body.tools?.length === 1 && body.tools[0]?.name === "Read",
      ),
  );
});

test("declared unavailable models are skipped without dispatch and no-fallback collapses the chain", async () => {
  const previous = process.env.CLAUDE_CODE_NO_MODEL_FALLBACK;
  onTestFinished(() => {
    if (previous === undefined)
      delete process.env.CLAUDE_CODE_NO_MODEL_FALLBACK;
    else process.env.CLAUDE_CODE_NO_MODEL_FALLBACK = previous;
  });
  delete process.env.CLAUDE_CODE_NO_MODEL_FALLBACK;
  const f = await fixture((_body, res) => respond(res), {
    fallbackModel: "claude-haiku-4-5",
    modelAvailable: (model) => !model.includes("sonnet"),
  });
  const budget = new ApiAttemptBudget(1);
  const completion = await f.provider.complete(
    f.request(rows(), { attemptBudget: budget, onText: () => {} }),
  );
  assert.equal(completion.model, "claude-haiku-4-5");
  assert.equal(f.bodies.length, 1);
  assert.equal(budget.remaining, 0);
  const messages = rows();
  present(messages[1]).usage = { input_tokens: 250000, output_tokens: 10 };
  present(messages[1]).requestedModel = "claude-opus-5-5";
  const preferred = {
    provider: f.provider,
    messages,
    state: freshCompactionState(),
    model: "claude-sonnet-4-5",
    apiWindow: 200000,
    maxOutput: 32000,
  };
  assert.equal(largerCompactionModel(preferred), "claude-opus-5-5");
  process.env.CLAUDE_CODE_NO_MODEL_FALLBACK = "true";
  assert.equal(largerCompactionModel(preferred), undefined);
  await assert.rejects(
    f.provider.complete(f.request(rows(), { onText: () => {} })),
    ModelUnavailableError,
  );
  assert.equal(f.bodies.length, 1);
  const capped = await fixture(
    (_body, res, count) => (count === 1 ? respond(res, "") : fail(res, 529)),
    { fallbackModel: "claude-haiku-4-5", recoveryPolicy: { maxOverloaded: 1 } },
  );
  assert.equal(
    await compactContext({
      provider: capped.provider,
      request: capped.request(),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: () => {},
    }),
    false,
  );
  assert.equal(capped.bodies.length, 2);
  assert.ok(capped.bodies.every((body) => body.model.includes("sonnet")));
});

test("caller and one-attempt child allowances prevent a hidden fresh dispatch", async () => {
  for (const child of [false, true]) {
    const f = await fixture((_body, res) => respond(res, "")),
      messages = rows(),
      original = structuredClone(messages),
      state = freshCompactionState(),
      budget = new ApiAttemptBudget(child ? 3 : 1);
    const options = {
      provider: f.provider,
      request: f.request(messages, { attemptBudget: budget }),
      state,
      reason: "manual" as const,
      ...(child ? { attemptLimit: 1 } : {}),
      onEvent: () => {},
    };
    if (child) assert.equal(await compactContext(options), false);
    else
      await assert.rejects(compactContext(options), {
        name: "ApiAttemptBudgetExhausted",
      });
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(messages, original);
    assert.equal(state.consecutiveFailures, child ? 1 : 0);
    assert.equal(budget.remaining, child ? 2 : 0);
  }
});

test("an observer or cancellation after the cached response cannot trigger a fresh request", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController(),
      f = await fixture((_body, res) => respond(res, "")),
      messages = rows(),
      original = structuredClone(messages);
    const options = {
      provider: f.provider,
      request: f.request(messages, { signal: controller.signal }),
      state: freshCompactionState(),
      reason: "manual" as const,
      onEvent: (event: AgentEvent) => {
        if (event.type === "usage") {
          if (abort) controller.abort();
          else throw new Error("observer failed");
        }
      },
    };
    if (abort)
      await assert.rejects(compactContext(options), { name: "AbortError" });
    else assert.equal(await compactContext(options), false);
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(messages, original);
  }
});

test("fresh cancellation is terminal and preserves the original active transcript", async () => {
  const controller = new AbortController(),
    f = await fixture((_body, res, count) => {
      if (count === 1) respond(res, "");
      else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"ping"}\n\n');
        controller.abort();
      }
    });
  const messages = rows(),
    original = structuredClone(messages),
    state = freshCompactionState();
  await assert.rejects(
    compactContext({
      provider: f.provider,
      request: f.request(messages, { signal: controller.signal }),
      state,
      reason: "manual",
      onEvent: () => {},
    }),
    { name: "AbortError" },
  );
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(messages, original);
  assert.equal(state.consecutiveFailures, 0);
});

test("manual size retries recreate the cached/fresh pair but remain bounded to four plans", async () => {
  const f = await fixture((_body, res) =>
    fail(res, 400, "context_length_exceeded"),
  );
  const messages = [user()];
  for (let n = 0; n < 10; n++)
    messages.push(
      { role: "assistant", content: [{ type: "text", text: `answer${n}` }] },
      user(),
    );
  const original = structuredClone(messages),
    budget = new ApiAttemptBudget(9);
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages, { attemptBudget: budget }),
      state: freshCompactionState(),
      reason: "manual",
      onEvent: () => {},
    }),
    false,
  );
  assert.equal(f.bodies.length, 8);
  assert.equal(budget.remaining, 1);
  assert.deepEqual(messages, original);
  for (let n = 0; n < 8; n += 2)
    assert.deepEqual(
      present(f.bodies[n]).messages,
      present(f.bodies[n + 1]).messages,
    );
});

test("reactive prefix failure does not invent the full/manual fresh fallback", async () => {
  const f = await fixture((_body, res) => respond(res, "")),
    messages = rows();
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: f.request(messages),
      state: freshCompactionState(),
      reason: "reactive",
      planning: { cachePrefix: false },
      onEvent: () => {},
    }),
    false,
  );
  assert.equal(f.bodies.length, 1);
  assert.equal(activeContextStart(messages), 0);
});
