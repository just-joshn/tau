import { fixtureSse } from "./sse-fixture.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { runAgent } from "../src/agent.js";
import { ApiAttemptBudget } from "../src/attempt-ledger.js";
import {
  compactContext,
  compactWindowSetting,
  compactionStatus,
  contextExchangeCount,
  freshCompactionState,
  largerCompactionModel,
} from "../src/compaction.js";
import { contextRejection } from "../src/context-error.js";
import { ProviderHttpError } from "../src/http-error.js";
import { contextWindow, LONG_CONTEXT_BETA } from "../src/context-window.js";
import {
  activeContextStart,
  clearedInputTokens,
  contextTokens,
  contextUsage,
  estimateContextTokens,
  estimateMessageTokens,
} from "../src/context-usage.js";
import { AnthropicProvider } from "../src/provider.js";
import { resolveModelFacts } from "../src/reasoning.js";
import {
  markThinkingStripped,
  planThinkingStrip,
  projectMessages,
} from "../src/thinking-history.js";
import type {
  AgentEvent,
  CompletionRequest,
  Message,
  Provider,
  Usage,
} from "../src/types.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const user = (value = "next"): Message => ({
  role: "user",
  content: [text(value)],
});
const thought = (signature: string) => ({
  type: "thinking" as const,
  thinking: "reason",
  signature,
});
const model = "claude-sonnet-4-5-20250929";
const request = (
  t: TestContext,
  extra: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  model,
  system: "",
  messages: [user()],
  tools: [],
  maxTokens: 32000,
  signal: t.signal,
  onText: () => {},
  ...extra,
});
function send(
  res: ServerResponse,
  value = "Done",
  options: {
    model?: string;
    usage?: Usage;
    resumable?: boolean;
    thinking?: boolean;
    tool?: boolean;
  } = {},
) {
  const block = options.tool
    ? { type: "tool_use", id: "summary-tool", name: "Write", input: {} }
    : options.thinking
      ? { type: "thinking", thinking: "", signature: "" }
      : text("");
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        role: "assistant",
        model: options.model ?? model,
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
  ];
  if (options.thinking)
    events.push(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reason" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
    );
  else if (!options.tool)
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: value },
    });
  events.push(
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: options.resumable
          ? "max_tokens"
          : options.tool
            ? "tool_use"
            : "end_turn",
        ...(options.resumable ? { resumable: true } : {}),
      },
      usage: options.usage ?? { input_tokens: 10, output_tokens: 2 },
    },
    { type: "message_stop" },
  );
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(fixtureSse(events));
}
async function fixture(
  t: TestContext,
  handler: (
    body: any,
    res: ServerResponse,
    count: number,
    beta: string | undefined,
  ) => void,
  options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) {
  const bodies: any[] = [],
    betas: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const beta = req.headers["anthropic-beta"] as string | undefined;
    betas.push(beta);
    handler(body, res, bodies.length, beta);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    bodies,
    betas,
    provider: new AnthropicProvider({
      apiKey: "loopback",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      ...options,
    }),
  };
}
const tools = {
  definitions: [],
  execute: async () => {
    throw new Error("Unexpected tool execution");
  },
};
const seeded = (inputTokens = 170000): Message[] => [
  user("old request"),
  {
    role: "assistant",
    content: [text("Original answer")],
    usage: { input_tokens: inputTokens, output_tokens: 1000 },
  },
  user(),
];
const summary =
  "<summary>Continue editing a.ts. The earlier requested change is complete; verify its behavior before making another edit.</summary>";

function rejectContext(
  res: ServerResponse,
  message = "prompt is too long: 210000 tokens > 200000",
) {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ error: { type: "invalid_request_error", message } }),
  );
}

test("context errors retain only typed token counts and bounded capability markers", () => {
  assert.deepEqual(
    contextRejection(400, "prompt is too long: 210000 tokens > 200000"),
    { kind: "prompt", actualTokens: 210000, limitTokens: 200000, gap: 10000 },
  );
  for (const phrase of [
    "CONTEXT_LENGTH_EXCEEDED",
    "input is too long for requested model",
    "capability_rejected: prompt_too_long.",
  ]) {
    // A period is part of a marker identifier, so the third string must not match.
    assert.equal(
      contextRejection(422, phrase)?.kind,
      phrase.endsWith(".") ? undefined : "prompt",
    );
  }
  assert.deepEqual(
    contextRejection(400, "capability_rejected: max_tokens_context_overflow;"),
    { kind: "combined" },
  );
  assert.equal(
    contextRejection(400, "capability_rejected: prompt_too_long_extra"),
    undefined,
  );
  for (const phrase of [
    "maximum context length policy_blocked",
    "maximum prompt length expected maxlength",
    "unrelated failure",
  ])
    assert.equal(contextRejection(400, phrase), undefined);
  assert.equal(contextRejection(500, "maximum context length"), undefined);
  assert.deepEqual(
    contextRejection(400, "prompt is too long: 99999999999999999 tokens > 1"),
    { kind: "prompt" },
  );
});

test("exchange grouping respects response ids, resumption and active boundaries", () => {
  const messages: Message[] = [
    user(),
    { role: "assistant", responseId: "a", content: [text("one")] },
    { role: "assistant", responseId: "a", content: [text("two")] },
    user(),
    {
      role: "assistant",
      responseId: "b",
      content: [text("more")],
      resumedFromIncompleteThinking: true,
    },
  ];
  assert.equal(contextExchangeCount(messages), 2);
  messages.push({
    role: "assistant",
    responseId: "c",
    content: [text("next")],
  });
  assert.equal(contextExchangeCount(messages), 3);
  messages.push(
    {
      ...user("summary"),
      contextBoundary: {
        reason: "reactive",
        beforeTokens: 100,
        afterTokens: 5,
      },
    },
    user(),
  );
  assert.equal(contextExchangeCount(messages), 1);
});

test("default historical windows defer estimate compaction and blocking to the API", async (t) => {
  const f = await fixture(t, (_body, res) => send(res));
  const messages = seeded();
  messages[1]!.usage!.input_tokens = 220000;
  const sizing = compactionStatus(220000, 200000, 32000, model, {}, {});
  assert.equal(sizing.source, "auto");
  assert.equal(sizing.deferToServer, true);
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 1);
  assert.ok(JSON.stringify(f.bodies[0]).includes("Original answer"));
  assert.equal(
    compactionStatus(170000, 200000, 32000, model, { window: "200k" }, {})
      .deferToServer,
    false,
  );
  assert.equal(
    compactionStatus(970000, 1000000, 32000, "claude-opus-5-5", {}, {}).source,
    "model-default",
  );
  assert.equal(
    compactionStatus(970000, 1000000, 32000, "custom", {}, {}).source,
    "unknown-model",
  );
  assert.equal(
    compactionStatus(
      970000,
      1000000,
      32000,
      "custom",
      {},
      { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1" },
    ).deferToServer,
    true,
  );
});

test("server context rejection compacts once and retries without spending a completed round", async (t) => {
  const f = await fixture(t, (_body, res, count) =>
    count === 1
      ? rejectContext(res)
      : send(res, count === 2 ? summary : "Done"),
  );
  const messages = seeded(),
    events: AgentEvent[] = [];
  const result = await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "Parent",
    maxTokens: 32000,
    maxTurns: 1,
    maxApiAttempts: 3,
    signal: t.signal,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.turns, 1);
  assert.equal(f.bodies.length, 3);
  assert.equal(activeContextStart(messages), 2);
  assert.equal(messages[2]!.contextBoundary?.reason, "reactive");
  assert.ok(!JSON.stringify(f.bodies[2]).includes("Original answer"));
  assert.ok(f.bodies.every((body) => body.model === model));
  assert.equal(result.usage.input_tokens, 20);
  assert.equal(
    events.filter(
      (event) => event.type === "compaction" && event.stage === "complete",
    ).length,
    1,
  );
});

test("reactive compaction keeps closed tool calls paired and executes each only once", async (t) => {
  const f = await fixture(t, (_body, res, count) =>
    count === 1
      ? send(res, "", { tool: true })
      : count === 2
        ? rejectContext(res)
        : send(res, count === 3 ? summary : "Done"),
  );
  let executed = 0;
  const executor = {
    definitions: [],
    execute: async () => {
      executed++;
      return {
        type: "tool_result" as const,
        tool_use_id: "summary-tool",
        content: "written",
      };
    },
  };
  const messages = seeded();
  const result = await runAgent({
    provider: f.provider,
    tools: executor,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 2,
    maxApiAttempts: 4,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(executed, 1);
  assert.equal(result.turns, 2);
  assert.equal(f.bodies.length, 4);
  const tail = f.bodies[3].messages;
  assert.equal(tail[1].content[0].type, "tool_use");
  assert.equal(tail[2].content[0].type, "tool_result");
  assert.equal(tail[1].content[0].id, tail[2].content[0].tool_use_id);
});

test("repeated context rejection, one exchange and disabled compaction stop without a loop", async (t) => {
  for (const mode of [
    "again",
    "single",
    "disabled",
    "invalid-summary",
  ] as const) {
    const f = await fixture(t, (_body, res, count) =>
      count === 2 && mode !== "invalid-summary"
        ? send(res, summary)
        : rejectContext(res),
    );
    const messages = mode === "single" ? [user()] : seeded();
    await assert.rejects(
      runAgent({
        provider: f.provider,
        tools,
        messages,
        model,
        system: "",
        maxTokens: 32000,
        maxTurns: 1,
        ...(mode === "disabled" ? { autoCompact: false } : {}),
        signal: t.signal,
        onEvent: () => {},
      }),
      ProviderHttpError,
    );
    assert.equal(
      f.bodies.length,
      mode === "again" ? 3 : mode === "invalid-summary" ? 2 : 1,
    );
  }
});

test("reactive summaries share admission and abort before retrying an accepted summary", async (t) => {
  for (const allowance of [1, 2]) {
    const f = await fixture(t, (_body, res, count) =>
      count === 1 ? rejectContext(res) : send(res, summary),
    );
    const messages = seeded();
    await assert.rejects(
      runAgent({
        provider: f.provider,
        tools,
        messages,
        model,
        system: "",
        maxTokens: 32000,
        maxTurns: 1,
        maxApiAttempts: allowance,
        signal: t.signal,
        onEvent: () => {},
      }),
      { name: "ApiAttemptBudgetExhausted" },
    );
    assert.equal(f.bodies.length, allowance);
    assert.equal(activeContextStart(messages), allowance === 2 ? 2 : 0);
  }
  const f = await fixture(t, (_body, res, count) =>
      count === 1 ? rejectContext(res) : send(res, summary),
    ),
    controller = new AbortController();
  await assert.rejects(
    runAgent({
      provider: f.provider,
      tools,
      messages: seeded(),
      model,
      system: "",
      maxTokens: 32000,
      maxTurns: 1,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "compaction" && event.stage === "complete")
          controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(f.bodies.length, 2);
});

test("a blocked conversation can summarize on the last requested larger model before default deferral", async (t) => {
  const larger = "claude-opus-5-5",
    messages = seeded();
  messages[1]!.usage!.input_tokens = 250000;
  messages[1]!.requestedModel = larger;
  messages[1]!.responseModel = "unrelated-served-label";
  const f = await fixture(t, (_body, res, count) =>
    send(res, count === 1 ? summary : "Done"),
  );
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "Parent",
    maxTokens: 32000,
    maxTurns: 1,
    maxApiAttempts: 2,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.deepEqual(
    f.bodies.map((body) => body.model),
    [larger, model],
  );
  assert.equal(activeContextStart(messages), 2);
  assert.ok(!JSON.stringify(f.bodies[1]).includes("Original answer"));
  assert.equal(messages.at(-1)!.requestedModel, model);
});

test("larger-model summary has one dispatch then falls back under configured proactive policy", async (t) => {
  const messages = seeded(),
    state = freshCompactionState();
  messages[1]!.usage!.input_tokens = 250000;
  messages[1]!.requestedModel = "claude-opus-5-5";
  const f = await fixture(
    t,
    (_body, res, count) => {
      if (count === 1) {
        res.writeHead(503);
        res.end();
      } else send(res, count === 2 ? summary : "Done");
    },
    { maxRetries: 3 },
  );
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    autoCompactWindow: "200k",
    maxTurns: 1,
    maxApiAttempts: 3,
    compactionState: state,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.deepEqual(
    f.bodies.map((body) => body.model),
    ["claude-opus-5-5", model, model],
  );
  assert.equal(state.consecutiveFailures, 0);
  assert.ok(
    f.bodies[1].messages
      .at(-1)
      .content[0].text.includes("Create a continuation summary"),
  );
});

test("exhausting the caller during a larger summary is terminal and preserves the original context", async (t) => {
  const messages = seeded(),
    state = freshCompactionState();
  messages[1]!.usage!.input_tokens = 250000;
  messages[1]!.requestedModel = "claude-opus-5-5";
  const before = structuredClone(messages),
    f = await fixture(
      t,
      (_body, res) => {
        res.writeHead(503);
        res.end();
      },
      { maxRetries: 3 },
    );
  await assert.rejects(
    runAgent({
      provider: f.provider,
      tools,
      messages,
      model,
      system: "",
      maxTokens: 32000,
      maxTurns: 1,
      maxApiAttempts: 1,
      compactionState: state,
      signal: t.signal,
      onEvent: () => {},
    }),
    { name: "ApiAttemptBudgetExhausted" },
  );
  assert.equal(f.bodies.length, 1);
  assert.deepEqual(messages, before);
  assert.equal(state.consecutiveFailures, 0);
});

test("a failed larger-model fork returns a default-window request to API admission", async (t) => {
  const messages = seeded();
  messages[1]!.usage!.input_tokens = 250000;
  messages[1]!.requestedModel = "claude-opus-5-5";
  const f = await fixture(
    t,
    (_body, res, count) => {
      if (count === 1) {
        res.writeHead(503);
        res.end();
      } else send(res);
    },
    { maxRetries: 3 },
  );
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    maxApiAttempts: 2,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 2);
  assert.equal(activeContextStart(messages), 0);
  assert.equal(f.bodies[1].messages.at(-1).content[0].text, "next");
});

test("larger-model selection needs a usage anchor, recognition, permission and more usable capacity", () => {
  const messages = seeded(),
    provider: Provider = {
      complete: async () => {
        throw new Error("unexpected");
      },
    },
    state = freshCompactionState();
  messages[1]!.usage!.input_tokens = 250000;
  messages[1]!.requestedModel = "claude-opus-5-5";
  const options = {
    provider,
    messages,
    state,
    model,
    apiWindow: 200000,
    maxOutput: 32000,
  };
  assert.equal(largerCompactionModel(options), "claude-opus-5-5");
  assert.equal(
    largerCompactionModel({
      ...options,
      provider: { ...provider, canUseModel: () => false },
    }),
    undefined,
  );
  assert.equal(
    largerCompactionModel({
      ...options,
      provider: {
        ...provider,
        contextWindow: (name) =>
          contextWindow(name, { longContextCreditsBlocked: true }, {}),
      },
    }),
    undefined,
  );
  assert.equal(
    largerCompactionModel({
      ...options,
      state: { ...state, consecutiveFailures: 1 },
    }),
    undefined,
  );
  messages[1]!.requestedModel = "unknown";
  assert.equal(largerCompactionModel(options), undefined);
  messages[1]!.requestedModel = model;
  assert.equal(largerCompactionModel(options), undefined);
  messages[1]!.requestedModel = "claude-opus-5-5";
  messages[1]!.usage!.input_tokens = 1000;
  assert.equal(largerCompactionModel(options), undefined);
  messages[1]!.usage!.input_tokens = 0;
  messages[1]!.usage!.output_tokens = 250000;
  assert.equal(largerCompactionModel(options), undefined);
});

test("blocking after summary commit uses the reset output limit for the retained tail", async (t) => {
  let limit = 8192,
    calls = 0;
  const provider: Provider = {
    outputTokenLimit: () => limit,
    resetRequestLimits: () => {
      limit = Infinity;
    },
    complete: async () => {
      calls++;
      return {
        content: [text("<summary>Summary</summary>")],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
  const messages = seeded();
  messages.at(-1)!.content = [text("x".repeat(720000))];
  await assert.rejects(
    runAgent({
      provider,
      tools,
      messages,
      model,
      system: "",
      maxTokens: 32000,
      autoCompactWindow: "200k",
      maxTurns: 1,
      signal: t.signal,
      onEvent: () => {},
    }),
    /Context is full/,
  );
  assert.equal(calls, 1);
  assert.equal(activeContextStart(messages), 2);
  assert.equal(limit, Infinity);
});

test("proactive prefix summaries skip a two-group nonblocking request, while a first rapid refill summarizes all", async (t) => {
  const f = await fixture(t, (body, res) =>
    send(
      res,
      body.messages
        .at(-1)
        .content[0].text.includes("Create a continuation summary")
        ? summary
        : "Done",
    ),
  );
  await runAgent({
    provider: f.provider,
    tools,
    messages: seeded(),
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    autoCompactWindow: "200k",
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 1);
  assert.ok(
    !JSON.stringify(f.bodies[0]).includes("Create a continuation summary"),
  );
  const state = { ...freshCompactionState(), compacted: true },
    messages = seeded();
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    autoCompactWindow: "200k",
    compactionState: state,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 3);
  assert.equal(state.consecutiveRapidRefills, 1);
  assert.equal(messages[2]!.contextBoundary?.groupsPreserved, 0);
});

test("HTTP prefix summary excludes the retained reply and persists its old usage as ineligible", async (t) => {
  const messages: Message[] = [
    user("opening"),
    { role: "assistant", responseId: "old", content: [text("OLD-ONLY")] },
    user("middle"),
    {
      role: "assistant",
      responseId: "latest",
      content: [text("KEEP-THIS")],
      usage: { input_tokens: 170000, output_tokens: 10 },
    },
    user("pending"),
  ];
  const f = await fixture(t, (_body, res, count) =>
    send(res, count === 1 ? summary : "Done"),
  );
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    autoCompactWindow: "200k",
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 2);
  assert.ok(JSON.stringify(f.bodies[0]).includes("OLD-ONLY"));
  assert.ok(!JSON.stringify(f.bodies[0]).includes("KEEP-THIS"));
  assert.ok(JSON.stringify(f.bodies[1]).includes("KEEP-THIS"));
  assert.ok(!JSON.stringify(f.bodies[1]).includes("OLD-ONLY"));
  assert.equal(activeContextStart(messages), 3);
  assert.equal(messages[3]!.contextBoundary?.groupsPreserved, 1);
  assert.equal(messages[4]!.contextUsageDiscarded, true);
  assert.equal(messages[4]!.usage!.input_tokens, 170000);
});

test("a summary size failure retains more groups, enables one deeper reactive pass and keeps the round count", async (t) => {
  const messages: Message[] = [user("opening")];
  for (const id of ["a", "b", "c", "d"])
    messages.push(
      { role: "assistant", responseId: id, content: [text(id.repeat(4000))] },
      user(`after-${id}`),
    );
  const f = await fixture(t, (_body, res, count) =>
    [1, 2, 4].includes(count)
      ? rejectContext(res, "context_length_exceeded")
      : send(res, count === 6 ? "Done" : `<summary>Summary${count}</summary>`),
  );
  const events: AgentEvent[] = [],
    state = freshCompactionState();
  const result = await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    maxApiAttempts: 6,
    compactionState: state,
    signal: t.signal,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.turns, 1);
  assert.equal(f.bodies.length, 6);
  assert.ok(f.bodies[3].messages.length > f.bodies[5].messages.length);
  assert.equal(
    events.filter(
      (event) => event.type === "compaction" && event.stage === "complete",
    ).length,
    2,
  );
  assert.equal(state.consecutiveRapidRefills, 0);
  assert.equal(state.consecutiveFailures, 0);
  assert.ok(JSON.stringify(f.bodies[4]).includes("Summary3"));
  assert.ok(!JSON.stringify(f.bodies[5]).includes("Summary3"));
});

test("a third reactive refusal cannot create another deeper summary", async (t) => {
  const messages: Message[] = [user()];
  for (const id of ["a", "b", "c", "d", "e"])
    messages.push(
      { role: "assistant", responseId: id, content: [text(id.repeat(4000))] },
      user(),
    );
  const f = await fixture(t, (_body, res, count) =>
    [4, 7].includes(count)
      ? send(res, summary)
      : rejectContext(res, "context_length_exceeded"),
  );
  await assert.rejects(
    runAgent({
      provider: f.provider,
      tools,
      messages,
      model,
      system: "",
      maxTokens: 32000,
      maxTurns: 1,
      signal: t.signal,
      onEvent: () => {},
    }),
    ProviderHttpError,
  );
  assert.equal(f.bodies.length, 8);
  assert.equal(contextExchangeCount(messages), 3);
});

test("a completed tool round ends the immediate deeper-recovery opportunity", async (t) => {
  const messages: Message[] = [user()];
  for (const id of ["a", "b", "c", "d"])
    messages.push(
      { role: "assistant", responseId: id, content: [text(id.repeat(4000))] },
      user(),
    );
  const f = await fixture(t, (_body, res, count) =>
    count === 3
      ? send(res, summary)
      : count === 4
        ? send(res, "", { tool: true })
        : rejectContext(res, "context_length_exceeded"),
  );
  let executed = 0;
  await assert.rejects(
    runAgent({
      provider: f.provider,
      tools: {
        definitions: [],
        execute: async () => {
          executed++;
          return {
            type: "tool_result",
            tool_use_id: "summary-tool",
            content: "done",
          };
        },
      },
      messages,
      model,
      system: "",
      maxTokens: 32000,
      maxTurns: 2,
      signal: t.signal,
      onEvent: () => {},
    }),
    ProviderHttpError,
  );
  assert.equal(f.bodies.length, 5);
  assert.equal(executed, 1);
});

test("summary head reduction stops after three passes and global exhaustion never commits scratch context", async (t) => {
  for (const allowance of [undefined, 2]) {
    const messages: Message[] = [user()];
    for (let index = 0; index < 10; index++)
      messages.push(
        {
          role: "assistant",
          responseId: String(index),
          content: [text("answer")],
        },
        user(),
      );
    const before = structuredClone(messages),
      state = freshCompactionState(),
      f = await fixture(t, (_body, res) =>
        rejectContext(res, "context_length_exceeded"),
      );
    const options = {
      provider: f.provider,
      request: request(t, {
        messages,
        ...(allowance === undefined
          ? {}
          : { attemptBudget: new ApiAttemptBudget(allowance) }),
      }),
      state,
      planning: { keepNoRound: true },
      onEvent: () => {},
    };
    if (allowance === undefined)
      assert.equal(await compactContext(options), false);
    else
      await assert.rejects(compactContext(options), {
        name: "ApiAttemptBudgetExhausted",
      });
    assert.equal(f.bodies.length, allowance ?? 4);
    assert.deepEqual(messages, before);
    assert.equal(state.consecutiveFailures, allowance === undefined ? 1 : 0);
  }
});

test("tool-result omission stays in a summary scratch request and cannot leak after an invalid summary", async (t) => {
  const messages: Message[] = [
    user(),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "big", name: "Bash", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "big", content: "x".repeat(12000) },
      ],
    },
  ];
  const before = structuredClone(messages),
    f = await fixture(t, (_body, res) => send(res, "", { tool: true }));
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: request(t, { messages }),
      state: freshCompactionState(),
      planning: { omitLargeToolResults: true, keepNoRound: true },
      inputError: { kind: "prompt", gap: 100 },
      onEvent: () => {},
    }),
    false,
  );
  assert.ok(JSON.stringify(f.bodies[0]).includes("already ran"));
  assert.ok(!JSON.stringify(f.bodies[0]).includes("x".repeat(12000)));
  assert.deepEqual(messages, before);
});

test("later summary cancellation and one-child admission preserve raw context", async (t) => {
  for (const mode of ["abort", "child"] as const) {
    const messages: Message[] = [user()];
    for (const id of ["a", "b", "c"])
      messages.push(
        { role: "assistant", responseId: id, content: [text("reply")] },
        user(),
      );
    const original = structuredClone(messages),
      controller = new AbortController(),
      state = freshCompactionState(),
      budget = new ApiAttemptBudget(3);
    const f = await fixture(t, (_body, res, count) => {
      if (count === 1) rejectContext(res, "context_length_exceeded");
      else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"ping"}\n\n');
        controller.abort();
      }
    });
    const options = {
      provider: f.provider,
      request: request(t, {
        messages,
        signal: controller.signal,
        attemptBudget: budget,
      }),
      state,
      onEvent: () => {},
      ...(mode === "child" ? { attemptLimit: 1 } : {}),
    };
    if (mode === "abort")
      await assert.rejects(compactContext(options), { name: "AbortError" });
    else assert.equal(await compactContext(options), false);
    assert.deepEqual(messages, original);
    assert.equal(f.bodies.length, mode === "child" ? 1 : 2);
    assert.equal(state.consecutiveFailures, mode === "child" ? 1 : 0);
    assert.equal(budget.remaining, mode === "child" ? 2 : 1);
  }
});

test("catalog context rules distinguish200k, native1m, preview, unknown and disabled1m", () => {
  for (const name of [
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-3-7-sonnet",
  ])
    assert.equal(contextWindow(name, {}, {}).window, 200000);
  for (const name of [
    "sonnet",
    "claude-opus-5-5",
    "claude-mythos-preview",
    "unknown",
  ])
    assert.equal(contextWindow(name, {}, {}).window, 1000000);
  assert.equal(
    contextWindow("sonnet", {}, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }).window,
    200000,
  );
  assert.equal(
    contextWindow("unknown", {}, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "true" })
      .window,
    200000,
  );
});

test("suffix/sdk opt-in, historical exclusions and native beta suppression follow separate rules", () => {
  assert.equal(contextWindow("claude-sonnet-4-5[1m]", {}, {}).window, 1000000);
  assert.equal(contextWindow("claude-haiku-4-5[1m]", {}, {}).window, 1000000);
  assert.equal(
    contextWindow("claude-sonnet-4-5", { sdkBetas: [LONG_CONTEXT_BETA] }, {})
      .window,
    1000000,
  );
  assert.equal(
    contextWindow("claude-haiku-4-5", { sdkBetas: [LONG_CONTEXT_BETA] }, {})
      .window,
    200000,
  );
  assert.equal(contextWindow("claude-opus-5-5[1m]", {}, {}).beta, false);
  assert.equal(
    contextWindow("claude-sonnet-4-5[1m]", { context1mRefused: true }, {})
      .window,
    200000,
  );
  assert.equal(
    contextWindow("claude-opus-5-5", { context1mRefused: true }, {}).window,
    1000000,
  );
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5" };
  assert.equal(resolveModelFacts(" sonnet[1m] ", env).wire, model);
  assert.equal(contextWindow("sonnet[1m]", {}, env).beta, true);
});

test("environment/context-credit precedence preserves explicit disable-compact overrides", () => {
  assert.equal(
    contextWindow("unknown", {}, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "600_000" })
      .window,
    600000,
  );
  assert.equal(
    contextWindow(
      "claude-sonnet-4-5",
      {},
      { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "600000" },
    ).window,
    200000,
  );
  assert.equal(
    contextWindow("sonnet", { longContextCreditsBlocked: true }, {}).window,
    200000,
  );
  assert.equal(
    contextWindow(
      "sonnet",
      { longContextCreditsBlocked: true },
      { DISABLE_COMPACT: "true", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000" },
    ).window,
    500000,
  );
  assert.equal(
    contextWindow(
      "sonnet",
      {},
      { DISABLE_COMPACT: "true", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "0" },
    ).window,
    1000000,
  );
});

test("runtime declarations clamp to baked no-opt-in caps and validate100k–10m bounds", () => {
  assert.equal(
    contextWindow(
      "claude-sonnet-4-5",
      { runtime: { maxInputTokens: 600000 } },
      {},
    ).window,
    200000,
  );
  assert.equal(
    contextWindow(
      "claude-sonnet-4-5[1m]",
      { runtime: { maxInputTokens: 600000 } },
      {},
    ).window,
    1000000,
  );
  assert.equal(
    contextWindow(
      "claude-opus-5-5",
      { runtime: { maxInputTokens: 800000 } },
      {},
    ).window,
    800000,
  );
  assert.equal(
    contextWindow(
      "claude-opus-5-5",
      { runtime: { maxInputTokens: 99999, contextWindow: 500000 } },
      {},
    ).window,
    1000000,
  );
  assert.equal(
    contextWindow(
      "custom",
      { runtime: { maxInputTokens: 900000 }, sdkBetas: [LONG_CONTEXT_BETA] },
      {},
    ).window,
    900000,
  );
});

test("Sonnet client-data and authenticated intermediate windows honor source gates", () => {
  assert.equal(
    contextWindow(
      "claude-sonnet-4-6",
      { sonnetContextWindow: "500001suffix" },
      {},
    ).window,
    500001,
  );
  assert.equal(
    contextWindow("claude-sonnet-4-6", { sonnetContextWindow: "1000001" }, {})
      .window,
    200000,
  );
  assert.equal(
    contextWindow(
      "claude-sonnet-4-6",
      {
        authenticatedFirstParty: true,
        intermediateWindows: { "claude-sonnet-4-6": 600000 },
        runtime: { maxInputTokens: 450000 },
      },
      {},
    ).window,
    450000,
  );
  assert.equal(
    contextWindow(
      "claude-opus-4-6",
      { intermediateWindows: { "claude-opus-4-6": 600000 } },
      {},
    ).window,
    200000,
  );
  assert.equal(
    contextWindow(
      "claude-sonnet-4-6",
      { sonnetContextWindow: "500000", context1mRefused: true },
      {},
    ).window,
    200000,
  );
});

test("context usage selects the last eligible message iteration without changing billing totals", () => {
  const usage: Usage = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 200,
    iterations: [
      {
        type: "message",
        input_tokens: 300,
        output_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
      {
        type: "fallback_message",
        input_tokens: 400,
        output_tokens: 15,
        cache_creation_input_tokens: 25,
        cache_read_input_tokens: 35,
      },
      { type: "advisor_message" },
      { type: "compaction" },
    ],
  };
  assert.equal(contextTokens(usage), 475);
  assert.equal(usage.input_tokens, 1000);
  assert.equal(
    contextTokens({
      ...usage,
      iterations: [...usage.iterations!, { type: "invalid" }],
    }),
    1300,
  );
  assert.equal(
    contextTokens({ ...usage, input_tokens: 0, cache_read_input_tokens: 0 }),
    100,
  );
});

test("token estimates use per-block UTF16 rounding and the latest usable API anchor", () => {
  assert.equal(
    estimateMessageTokens({
      role: "assistant",
      content: [
        text("😀"),
        text("a"),
        { type: "thinking", thinking: "abcdef", signature: "not counted" },
        { type: "tool_use", id: "a", name: "Go", input: { a: 1 } },
        { type: "tool_result", tool_use_id: "a", content: "abc" },
      ],
    }),
    6,
  );
  const rows: Message[] = [
    user("x".repeat(100)),
    {
      role: "assistant",
      content: [text("answer")],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
      },
    },
    user("tailtailtail"),
  ];
  assert.equal(estimateContextTokens(rows), 153);
  rows[1]!.usage = { input_tokens: 0, output_tokens: 100 };
  assert.equal(estimateContextTokens(rows), 30);
});

test("boundaries reset estimates, discard retained old usage and scope prefix repair to active history", () => {
  const boundary: Message = {
    role: "user",
    content: [text("summary!")],
    contextBoundary: {
      beforeTokens: 10000,
      afterTokens: 5,
      reason: "automatic",
    },
  };
  const rows: Message[] = [
    {
      role: "assistant",
      content: [thought("same"), text("old")],
      usage: { input_tokens: 900000, output_tokens: 10 },
    },
    boundary,
    {
      role: "assistant",
      content: [thought("same"), text("abcd")],
      contextUsageDiscarded: true,
      usage: { input_tokens: 900000, output_tokens: 10 },
    },
    user("done"),
  ];
  assert.equal(activeContextStart(rows), 1);
  assert.equal(estimateContextTokens(rows), 6);
  const strip = planThinkingStrip(
    rows,
    projectMessages(rows),
    "block=messages.1.content.0",
    1,
  );
  assert.deepEqual(strip, {
    scope: "partial",
    from: { messageIndex: 2, thinkingIndex: 0 },
  });
  assert.equal(
    markThinkingStripped(rows, { scope: "all" })[0]?.thinkingStripFrom,
    undefined,
  );
});

test("cleared tool-input accounting distinguishes measured estimates and client cuts", () => {
  assert.equal(
    clearedInputTokens({
      applied_edits: [
        { type: "clear_tool_uses_20250919", cleared_input_tokens: 100 },
      ],
      client_estimated_cleared_input_tokens: 80,
    }),
    80,
  );
  assert.equal(
    clearedInputTokens({
      applied_edits: [
        { type: "clear_tool_uses_20250919", cleared_input_tokens: 100 },
      ],
      client_estimated_cleared_input_tokens: 120,
      client_estimate_measured_from_prompts: true,
    }),
    120,
  );
  assert.equal(
    clearedInputTokens({
      client_cut_tool_uses: 1,
      client_estimated_cleared_input_tokens: 200,
    }),
    200,
  );
});

test("compaction reserves20k output/13k summary headroom and blocks3k before capacity", () => {
  assert.equal(
    compactionStatus(166999, 200000, 32000, model, {}, {}).level,
    "warn",
  );
  const ready = compactionStatus(167000, 200000, 32000, model, {}, {});
  assert.equal(ready.level, "compact");
  assert.equal(ready.threshold, 167000);
  assert.equal(ready.blocking, 177000);
  assert.equal(
    compactionStatus(177000, 200000, 32000, model, {}, {}).level,
    "blocked",
  );
  assert.equal(
    compactionStatus(170000, 200000, 32000, model, { enabled: false }, {})
      .level,
    "warn",
  );
  const reduced = compactionStatus(
    250000,
    1000000,
    1000,
    model,
    { window: "500k" },
    { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" },
  );
  assert.equal(reduced.threshold, 249500);
  assert.equal(reduced.blocking, 996000);
});

test("size settings preserve suffix grammar, environment clamps and auto-compact disables", () => {
  assert.equal(compactWindowSetting(".1205m"), 120500);
  assert.equal(compactWindowSetting("500", true), 500000);
  assert.equal(compactWindowSetting("500"), 100000);
  assert.equal(compactWindowSetting("2m"), 1000000);
  assert.equal(compactWindowSetting("120junkk"), 120000);
  assert.equal(compactWindowSetting("auto"), undefined);
  assert.equal(compactWindowSetting("0"), undefined);
  assert.equal(
    compactionStatus(
      100000,
      1000000,
      32000,
      model,
      { window: 500000 },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "50k" },
    ).window,
    100000,
  );
  assert.equal(
    compactionStatus(
      100000,
      1000000,
      32000,
      model,
      {},
      { DISABLE_AUTO_COMPACT: "true" },
    ).enabled,
    false,
  );
  assert.throws(
    () => compactionStatus(0, 200000, 32000, model, { window: 0 }, {}),
    /autoCompactWindow/,
  );
});

test("native1m resumption uses recovered model capacity beyond the former200k adapter", async (t) => {
  const native = "claude-opus-5-5";
  const f = await fixture(
    t,
    (_body, res, count) =>
      send(
        res,
        "Done",
        count === 1
          ? {
              model: native,
              thinking: true,
              resumable: true,
              usage: { input_tokens: 300000, output_tokens: 100 },
            }
          : { model: native },
      ),
    { thinkingResumption: true },
  );
  const messages = [user()];
  await runAgent({
    provider: f.provider,
    tools,
    messages,
    model: native,
    system: "",
    maxTokens: 32000,
    maxTurns: 3,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[1].messages.at(-1).role, "assistant");
  assert.ok(f.betas.every((beta) => !beta?.includes(LONG_CONTEXT_BETA)));
});

test("automatic HTTP compaction preserves archived history and sends only summary plus paired tail", async (t) => {
  const f = await fixture(t, (body, res) =>
    send(
      res,
      body.messages
        .at(-1)
        .content.some(
          (block: any) =>
            block.type === "text" &&
            block.text.includes("Create a continuation summary"),
        )
        ? summary
        : "Done",
    ),
  );
  const messages = seeded(190000),
    old = structuredClone(messages),
    events: AgentEvent[] = [],
    state = freshCompactionState();
  const result = await runAgent({
    provider: f.provider,
    tools,
    messages,
    model,
    system: "Project instructions",
    maxTokens: 32000,
    autoCompactWindow: "200k",
    maxTurns: 2,
    maxApiAttempts: 2,
    compactionState: state,
    signal: t.signal,
    onEvent: (event) => events.push(event),
  });
  assert.equal(f.bodies.length, 2);
  assert.equal(result.turns, 1);
  assert.equal(activeContextStart(messages), 2);
  assert.deepEqual(messages.slice(0, 2), old.slice(0, 2));
  assert.equal(f.bodies[1].messages.length, 1);
  assert.equal(f.bodies[1].messages[0].role, "user");
  assert.equal(f.bodies[1].messages[0].content.length, 2);
  assert.match(
    f.bodies[1].messages[0].content[0].text,
    /Continue editing a\.ts\.[\s\S]*\n$/,
  );
  assert.deepEqual(f.bodies[1].messages[0].content[1], text("next"));
  assert.ok(!JSON.stringify(f.bodies[1]).includes("Original answer"));
  assert.deepEqual(f.bodies[0].thinking, f.bodies[1].thinking);
  assert.equal(f.bodies[0].system, "Project instructions");
  assert.ok(
    events.some(
      (event) => event.type === "compaction" && event.stage === "complete",
    ),
  );
  assert.ok(
    !events.some(
      (event) =>
        event.type === "text" && event.text.includes("Continue editing"),
    ),
  );
  assert.ok(
    f.bodies.every((body) =>
      body.messages.every((message: any) => Object.keys(message).length === 2),
    ),
  );
  assert.equal(state.turnCounter, 1);
});

test("compaction cannot execute returned tools and keeps original context after an invalid summary", async (t) => {
  let called = 0;
  const f = await fixture(t, (_body, res, count) =>
    count === 1 ? send(res, "", { tool: true }) : send(res),
  );
  const messages: Message[] = [
      user("earlier request"),
      { role: "assistant", content: [text("Earlier reply")] },
      ...seeded(),
    ],
    state = freshCompactionState();
  await runAgent({
    provider: f.provider,
    tools: {
      definitions: [],
      execute: async () => {
        called++;
        throw new Error("unexpected");
      },
    },
    messages,
    model,
    system: "",
    maxTokens: 32000,
    autoCompactWindow: "200k",
    maxTurns: 1,
    compactionState: state,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(called, 0);
  assert.equal(activeContextStart(messages), 0);
  assert.equal(state.consecutiveFailures, 1);
  assert.ok(JSON.stringify(f.bodies[1]).includes("Original answer"));
});

test("summary forks preserve parent tool schemas/system/thinking while refusing tool execution", async (t) => {
  const f = await fixture(t, (_body, res) => send(res, "", { tool: true }), {
    thinking: { mode: "disabled" },
  });
  const definitions = [
    {
      name: "Write",
      description: "Write a file",
      input_schema: { type: "object" as const },
    },
  ];
  const messages = seeded(),
    original = structuredClone(messages);
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: request(t, {
        messages,
        system: "Parent project instructions",
        tools: definitions,
      }),
      state: freshCompactionState(),
      onEvent: () => {},
    }),
    false,
  );
  assert.deepEqual(f.bodies[0].tools, definitions);
  assert.equal(f.bodies[0].system, "Parent project instructions");
  assert.deepEqual(f.bodies[0].thinking, { type: "disabled" });
  assert.deepEqual(messages, original);
});

test("summary cancellation leaves history and failure counts unchanged", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (_body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"ping"}\n\n');
    setTimeout(() => controller.abort(), 20);
  });
  const messages = seeded(),
    before = structuredClone(messages),
    state = freshCompactionState();
  await assert.rejects(
    compactContext({
      provider: f.provider,
      request: request(t, { messages, signal: controller.signal }),
      state,
      onEvent: () => {},
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(messages, before);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(f.bodies.length, 1);
});

test("compaction failure and rapid-refill breakers prevent further summary dispatch", async (t) => {
  let calls = 0;
  const provider: Provider = {
    async complete() {
      calls++;
      throw new Error("failed");
    },
  };
  const state = freshCompactionState(),
    messages = seeded();
  for (let i = 0; i < 4; i++)
    await compactContext({
      provider,
      request: request(t, { messages }),
      state,
      onEvent: () => {},
    });
  assert.equal(calls, 3);
  assert.equal(state.consecutiveFailures, 3);
  assert.equal(activeContextStart(messages), 0);
  const rapid = {
    ...freshCompactionState(),
    compacted: true,
    turnCounter: 2,
    consecutiveRapidRefills: 2,
  };
  await compactContext({
    provider,
    request: request(t, { messages }),
    state: rapid,
    onEvent: () => {},
  });
  assert.equal(calls, 3);
});

test("retained tool tails stay paired and old usage cannot defeat the new boundary", async (t) => {
  const messages: Message[] = [
    user("old"),
    {
      role: "assistant",
      content: [text("old answer")],
      usage: { input_tokens: 170000, output_tokens: 1000 },
    },
    user("read"),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: "a" },
        },
      ],
      usage: { input_tokens: 170000, output_tokens: 1000 },
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "read", content: "file" }],
    },
  ];
  const f = await fixture(t, (_body, res) => send(res, summary));
  assert.equal(
    await compactContext({
      provider: f.provider,
      request: request(t, { messages }),
      state: freshCompactionState(),
      onEvent: () => {},
    }),
    true,
  );
  assert.equal(activeContextStart(messages), 3);
  assert.equal(messages[4]?.contextUsageDiscarded, true);
  assert.ok(estimateContextTokens(messages) < 1000);
  const projected = projectMessages(messages);
  assert.equal(projected[1]?.content[0]?.type, "tool_use");
  assert.equal(projected[2]?.content[0]?.type, "tool_result");
});

test("summary dispatch shares API admission and disabled compaction makes no hidden model call", async (t) => {
  const f = await fixture(t, (_body, res) => send(res, summary));
  const messages = seeded(190000);
  await assert.rejects(
    runAgent({
      provider: f.provider,
      tools,
      messages,
      model,
      system: "",
      maxTokens: 32000,
      autoCompactWindow: "200k",
      maxTurns: 1,
      maxApiAttempts: 1,
      signal: t.signal,
      onEvent: () => {},
    }),
    /attempt budget/,
  );
  assert.equal(f.bodies.length, 1);
  assert.equal(activeContextStart(messages), 2);
  const disabled = await fixture(t, (_body, res) => send(res));
  await runAgent({
    provider: disabled.provider,
    tools,
    messages: seeded(),
    model,
    system: "",
    maxTokens: 32000,
    autoCompactWindow: "200k",
    maxTurns: 1,
    autoCompact: false,
    signal: t.signal,
    onEvent: () => {},
  });
  assert.equal(disabled.bodies.length, 1);
  assert.ok(JSON.stringify(disabled.bodies[0]).includes("Original answer"));
});

test("budget exhaustion before or during a summary is terminal without failure-count or history changes", async (t) => {
  for (const allowance of [0, 1]) {
    const f = await fixture(
      t,
      (_body, res) => {
        res.writeHead(503);
        res.end();
      },
      { maxRetries: 1 },
    );
    const messages = seeded(),
      before = structuredClone(messages),
      state = freshCompactionState();
    messages[1]!.usage!.input_tokens = 190000;
    before[1]!.usage!.input_tokens = 190000;
    await assert.rejects(
      runAgent({
        provider: f.provider,
        tools,
        messages,
        model,
        system: "",
        maxTokens: 32000,
        autoCompactWindow: "200k",
        maxTurns: 1,
        maxApiAttempts: allowance,
        compactionState: state,
        signal: t.signal,
        onEvent: () => {},
      }),
      { name: "ApiAttemptBudgetExhausted" },
    );
    assert.equal(f.bodies.length, allowance);
    assert.equal(state.consecutiveFailures, 0);
    assert.deepEqual(messages, before);
  }
});

test("an observer error after summary commit does not count the accepted summary as a failure", async (t) => {
  const f = await fixture(t, (_body, res) => send(res, summary));
  const messages = seeded(),
    state = freshCompactionState();
  await assert.rejects(
    compactContext({
      provider: f.provider,
      request: request(t, { messages }),
      state,
      onEvent: (event) => {
        if (event.type === "compaction" && event.stage === "complete")
          throw new Error("display failed");
      },
    }),
    /display failed/,
  );
  assert.equal(activeContextStart(messages), 2);
  assert.equal(state.consecutiveFailures, 0);
});

// Last tests exercise the process-wide long-context refusal state.
test("a failed no-beta resend does not prove rejection or suppress the next query", async (t) => {
  const f = await fixture(t, (_body, res, count) => {
    if (count <= 2) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid beta flag" } }));
    } else send(res);
  });
  const tagged = "claude-sonnet-4-5[1m]";
  await assert.rejects(
    f.provider.complete(request(t, { model: tagged })),
    /HTTP error400|HTTP error 400/,
  );
  await f.provider.complete(request(t, { model: tagged }));
  assert.ok(f.betas[0]?.includes(LONG_CONTEXT_BETA));
  assert.equal(f.betas[1], undefined);
  assert.ok(f.betas[2]?.includes(LONG_CONTEXT_BETA));
  assert.equal(f.provider.contextWindowTokens(tagged), 1000000);
  assert.equal(f.bodies[0].model, model);
});

test("successful message-start after no-beta resend latches the model and shrinks future windows", async (t) => {
  const f = await fixture(t, (_body, res, count) => {
    if (count === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `Unsupported ${LONG_CONTEXT_BETA}` },
        }),
      );
    } else send(res);
  });
  const tagged = "claude-sonnet-4-5[1m]";
  await f.provider.complete(request(t, { model: tagged }));
  assert.equal(f.provider.contextWindowTokens(tagged), 200000);
  const next = new AnthropicProvider({ apiKey: "not-used" });
  assert.equal(next.contextWindowTokens(tagged), 200000);
  await f.provider.complete(request(t, { model: tagged }));
  assert.equal(f.betas[2], undefined);
});
