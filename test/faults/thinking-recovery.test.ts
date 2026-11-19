import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, onTestFinished } from "bun:test";
import { runAgent } from "../../src/agent.js";
import { ApiAttemptBudget } from "../../src/attempt-ledger.js";
import {
  betaHeaderRejected,
  ProviderHttpError,
  resumePrefillRefused,
} from "../../src/http-error.js";
import { MessageStream, streamEventSchema } from "../../src/message-stream.js";
import { AnthropicProvider } from "../../src/provider.js";
import {
  canResumeThinking,
  markThinkingStripped,
  planThinkingStrip,
  prefixMismatchLocation,
  projectMessages,
  type ThinkingStrip,
} from "../../src/thinking-history.js";
import type {
  AgentEvent,
  Completion,
  CompletionRequest,
  Message,
  Provider,
} from "../../src/types.js";

const model = "claude-sonnet-4-5-20250929";
const requestBlock = z.looseObject({
  type: z.string().optional(),
  signature: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
  input: z.unknown().optional(),
});
const requestMessage = z.looseObject({
  role: z.string(),
  partial: z.unknown().optional(),
  content: z.array(requestBlock),
});
const requestBody = z.looseObject({
  stream: z.boolean().optional(),
  model: z.string(),
  messages: z.array(requestMessage),
});
type RequestBody = z.infer<typeof requestBody>;

const think = (signature = "sig") => ({
  type: "thinking" as const,
  thinking: "reason",
  signature,
});
const text = (value: string) => ({ type: "text" as const, text: value });
const user = (): Message => ({ role: "user", content: [text("hello")] });
const assistant = (
  content: Message["content"],
  extra: Partial<Message> = {},
): Message => ({ role: "assistant", content, ...extra });
const finish = (
  stop_reason = "end_turn",
  extra: Record<string, unknown> = {},
) => ({
  type: "message_delta",
  delta: { stop_reason, ...extra },
  usage: { input_tokens: 2, output_tokens: 3 },
});
const begin = {
  type: "message_start",
  message: {
    role: "assistant",
    model,
    content: [],
    usage: { input_tokens: 2, output_tokens: 0 },
  },
};
const stop = { type: "message_stop" };
const textEvents = (value = "Done.") => [
  { type: "content_block_start", index: 0, content_block: text("") },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: value },
  },
  { type: "content_block_stop", index: 0 },
];
const thinkingEvents = (signature = "sig") => [
  { type: "content_block_start", index: 0, content_block: think("") },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "reason" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature },
  },
  { type: "content_block_stop", index: 0 },
];
const filtered = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Output blocked by content filtering policy",
  },
};
function send(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(fixtureSse(events));
}
function reject(
  res: ServerResponse,
  status = 400,
  message = "Thinking was not created in this conversation",
  header?: string,
  code?: string,
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(header ? { "anthropic-thinking-prefix-mismatch": header } : {}),
  });
  res.end(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        message,
        ...(code ? { details: { error_code: code } } : {}),
      },
    }),
  );
}
const testSignal = () => {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  return controller.signal;
};
const request = (
  extra: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  model,
  system: "",
  messages: [user()],
  tools: [],
  maxTokens: 4000,
  signal: testSignal(),
  onText: () => {},
  ...extra,
});
async function fixture(
  handler: (
    body: RequestBody,
    res: ServerResponse,
    count: number,
    headers: Record<string, unknown>,
  ) => void,
  options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) {
  const bodies: RequestBody[] = [],
    headers: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = requestBody.parse(JSON.parse(raw));
    bodies.push(body);
    headers.push(req.headers);
    handler(body, res, bodies.length, req.headers);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    bodies,
    headers,
    provider: new AnthropicProvider({
      apiKey: "loopback-only",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      ...options,
    }),
  };
}

test("history projection removes orphan/unsigned/abandoned reasoning and trims trailing reasoning/whitespace", () => {
  const rows = [
    user(),
    assistant([think()]),
    user(),
    assistant([text("answer"), think(), text("  \n")]),
  ];
  assert.deepEqual(projectMessages(rows), [
    { role: "user", content: [text("hello\n"), text("hello")] },
    { role: "assistant", content: [text("answer")] },
  ]);
  assert.equal(rows[1]?.content.length, 1);
  assert.deepEqual(projectMessages([assistant([think("")])], true), []);
  assert.deepEqual(
    projectMessages(
      [assistant([think()], { abandonedByStreamRetry: true })],
      true,
    ),
    [],
  );
  assert.deepEqual(
    projectMessages(
      [
        assistant([think("good")]),
        assistant([think("bad")], { abandonedByStreamRetry: true }),
      ],
      true,
    ),
    [{ role: "assistant", content: [think("good")] }],
  );
  assert.deepEqual(projectMessages([assistant([text("   ")])]), []);
});

test("resumed assistant chains retain signed thinking through a later answer and next prompt", () => {
  const rows = [
    user(),
    assistant([think("one")]),
    assistant([think("two")], { resumedFromIncompleteThinking: true }),
  ];
  assert.equal(projectMessages(rows, true).length, 3);
  assert.equal(projectMessages(rows).length, 1);
  rows.push(
    assistant([text("answer")], { resumedFromIncompleteThinking: true }),
    user(),
  );
  const projected = projectMessages(rows);
  assert.equal(projected.length, 5);
  assert.deepEqual(projected[1]?.content, [think("one")]);
  assert.ok(projected.every((row) => Object.keys(row).length === 2));
});

test("strip metadata preserves original blocks, earlier thinking and meaningful text/tool content", () => {
  const call = {
    type: "tool_use" as const,
    id: "tool",
    name: "Read",
    input: {},
  };
  const rows = [
    assistant([think("a"), text("  "), think("b"), text("answer"), call]),
    user(),
  ];
  const marked = markThinkingStripped(rows, {
    scope: "partial",
    from: { messageIndex: 0, thinkingIndex: 1 },
  });
  assert.equal(marked[0]?.thinkingStripFrom, 1);
  assert.equal(rows[0]?.thinkingStripFrom, undefined);
  assert.deepEqual(projectMessages(marked)[0]?.content, [
    think("a"),
    text("  "),
    text("answer"),
    call,
  ]);
  assert.equal(
    markThinkingStripped(marked, {
      scope: "partial",
      from: { messageIndex: 0, thinkingIndex: 2 },
    }),
    marked,
  );
  assert.deepEqual(
    projectMessages(
      markThinkingStripped([assistant([think(), text(" ")]), user()], {
        scope: "all",
      }),
    )[0]?.content,
    [text("[Thinking removed]")],
  );
});

test("prefix header grammar is bounded, exact and uses the first duplicate key", () => {
  assert.deepEqual(
    prefixMismatchLocation(
      "kind=prefix_binding_mismatch; block=messages.12.content.3; block=messages.1.content.0",
    ),
    { messageIndex: 12, blockIndex: 3 },
  );
  for (const value of [
    null,
    "",
    "block=messages.-1.content.0",
    "block=messages.1000000.content.0",
    "block=messages.1.content.2.extra",
    "Block=messages.1.content.2",
    "x".repeat(2049),
  ])
    assert.equal(prefixMismatchLocation(value), undefined);
});

test("prefix repair maps unique signatures and bounds targeted recovery to two attempts", () => {
  const rows = [assistant([think("a"), text("answer"), think("b")]), user()];
  const header = "block=messages.0.content.2";
  const partial = {
    scope: "partial",
    from: { messageIndex: 0, thinkingIndex: 1 },
  };
  assert.deepEqual(
    planThinkingStrip(rows, projectMessages(rows), header, 1),
    partial,
  );
  assert.deepEqual(
    planThinkingStrip(rows, projectMessages(rows), header, 2),
    partial,
  );
  assert.deepEqual(planThinkingStrip(rows, projectMessages(rows), header, 3), {
    scope: "all",
  });
  const duplicates = [assistant([think("a"), text("one"), think("a")]), user()];
  assert.deepEqual(
    planThinkingStrip(
      duplicates,
      projectMessages(duplicates),
      "block=messages.0.content.0",
      1,
    ),
    { scope: "all" },
  );
  const stripped = markThinkingStripped(rows, { scope: "all" });
  assert.equal(
    planThinkingStrip(stripped, projectMessages(stripped), null, 2),
    undefined,
  );
  const reused = [
    assistant([think("same"), text("old")], { thinkingStripFrom: 0 }),
    assistant([think("same"), text("answer")]),
    user(),
  ];
  assert.deepEqual(
    planThinkingStrip(
      reused,
      projectMessages(reused),
      "block=messages.1.content.0",
      1,
    ),
    { scope: "partial", from: { messageIndex: 1, thinkingIndex: 0 } },
  );
});

test("resumption requires one signed block, explicit signal, matching model and 2048 context headroom including cache", () => {
  const complete: Completion = {
    content: [think()],
    stop_reason: "max_tokens",
    resumable: true,
    responseModel: model,
    usage: {
      input_tokens: 100,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
    },
  };
  assert.equal(canResumeThinking(complete, "claude-sonnet-4-5", 3249), true);
  assert.equal(canResumeThinking(complete, model, 3248), false);
  for (const change of [
    { resumable: false },
    { stop_reason: "end_turn" },
    { responseModel: "other" },
    { responseModel: undefined },
    { content: [think("")] },
    { content: [think(), text("answer")] },
  ])
    assert.equal(
      canResumeThinking(Object.assign({}, complete, change), model, 200000),
      false,
    );
});

test("message deltas alone set resumable, with boolean delta precedence and positive cache usage merge", () => {
  const stream = new MessageStream(() => {});
  for (const event of [
    {
      ...begin,
      message: {
        ...begin.message,
        resumable: true,
        usage: {
          input_tokens: 2,
          output_tokens: 0,
          cache_read_input_tokens: 100,
        },
      },
    },
    ...thinkingEvents(),
    {
      ...finish("max_tokens", { resumable: true }),
      resumable: false,
      usage: {
        output_tokens: 5,
        cache_creation: {
          ephemeral_1h_input_tokens: 50,
          ephemeral_5m_input_tokens: 20,
        },
      },
    },
    {
      type: "message_delta",
      delta: {},
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: null,
      },
    },
    stop,
  ])
    stream.accept(streamEventSchema.parse(event));
  const complete = stream.completion();
  assert.equal(complete.resumable, true);
  assert.equal(complete.responseModel, model);
  assert.deepEqual(complete.usage, {
    input_tokens: 2,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 70,
  });
  const initial = new MessageStream(() => {});
  for (const event of [
    { ...begin, message: { ...begin.message, resumable: true } },
    finish(),
    stop,
  ])
    initial.accept(streamEventSchema.parse(event));
  assert.equal(initial.completion().resumable, undefined);
});

test("early output filter retries streaming once without JSON or fallback-model routing", async () => {
  const f = await fixture(
    (_body, res, count) =>
      send(
        res,
        count === 1
          ? [begin, filtered]
          : [begin, ...textEvents(), finish("refusal"), stop],
      ),
    { maxRetries: 1, fallbackModel: "other" },
  );
  const complete = await f.provider.complete(
    request({ attemptBudget: new ApiAttemptBudget(2) }),
  );
  assert.equal(complete.stop_reason, "refusal");
  assert.equal(f.bodies.length, 2);
  assert.ok(
    f.bodies.every((body) => body.stream === true && body.model === model),
  );
});

test("output filter after visible, closed thinking or terminal stop does not retry or keep partial", async () => {
  for (const before of [
    [begin, ...textEvents()],
    [begin, ...thinkingEvents()],
    [begin, finish()],
  ]) {
    const f = await fixture((_body, res) => send(res, [...before, filtered]), {
      maxRetries: 2,
    });
    await assert.rejects(f.provider.complete(request()), /streaming error/);
    assert.equal(f.bodies.length, 1);
  }
});

test("repeated early output filters exhaust one special retry; DLP denial takes precedence", async () => {
  const f = await fixture((_body, res) => send(res, [begin, filtered]), {
    maxRetries: 2,
  });
  await assert.rejects(f.provider.complete(request()), /streaming error/);
  assert.equal(f.bodies.length, 2);
  const denied = await fixture(
    (_body, res) =>
      send(res, [
        begin,
        {
          ...filtered,
          error: {
            ...filtered.error,
            details: { error_code: "dlp_request_denied" },
          },
        },
      ]),
    { maxRetries: 2 },
  );
  await assert.rejects(denied.provider.complete(request()), /streaming error/);
  assert.equal(denied.bodies.length, 1);
});

test("real HTTP prefix repair performs two targeted strips then all, without ordinary retries", async () => {
  const rows = [
    user(),
    assistant([think("a"), text("answer"), think("b"), think("c")]),
    user(),
  ];
  const strips: ThinkingStrip[] = [];
  const f = await fixture((_body, res, count) =>
    count < 4
      ? reject(
          res,
          400,
          "Thinking bound to a different conversation",
          `block=messages.1.content.${count === 1 ? 3 : count === 2 ? 2 : 0}`,
        )
      : send(res, [begin, ...textEvents(), finish(), stop]),
  );
  const budget = new ApiAttemptBudget(4);
  await f.provider.complete(
    request({
      messages: rows,
      attemptBudget: budget,
      onThinkingStrip: (strip) => strips.push(strip),
    }),
  );
  assert.deepEqual(strips, [
    { scope: "partial", from: { messageIndex: 1, thinkingIndex: 2 } },
    { scope: "partial", from: { messageIndex: 1, thinkingIndex: 1 } },
    { scope: "all" },
  ]);
  assert.deepEqual(
    f.bodies.map((body) =>
      body.messages[1]?.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.signature),
    ),
    [["a", "b", "c"], ["a", "b"], ["a"], []],
  );
  assert.equal(rows[1]?.thinkingStripFrom, undefined);
  assert.equal(budget.remaining, 0);
});

test("prefix repair stops when nothing can be stripped and respects caller abort and admission", async () => {
  const rows = [user(), assistant([think(), text("answer")]), user()];
  const f = await fixture((_body, res) => reject(res));
  await assert.rejects(
    f.provider.complete(request({ messages: rows })),
    /HTTP error 400/,
  );
  assert.equal(f.bodies.length, 2);
  const controller = new AbortController();
  const aborted = await fixture((_body, res) => reject(res));
  await assert.rejects(
    aborted.provider.complete(
      request({
        messages: rows,
        signal: controller.signal,
        onThinkingStrip: () => controller.abort(),
      }),
    ),
    { name: "AbortError" },
  );
  assert.equal(aborted.bodies.length, 1);
  const bounded = await fixture((_body, res) => reject(res));
  await assert.rejects(
    bounded.provider.complete(
      request({ messages: rows, attemptBudget: new ApiAttemptBudget(1) }),
    ),
    /attempt budget/,
  );
  assert.equal(bounded.bodies.length, 1);
});

test("denied prefix-looking400 and non400 messages cannot heal", async () => {
  const rows = [user(), assistant([think(), text("answer")]), user()];
  for (const [status, code] of [
    [400, "dlp_request_denied"],
    [500, undefined],
  ] as const) {
    const f = await fixture((_body, res) =>
      reject(res, status, undefined, undefined, code),
    );
    await assert.rejects(
      f.provider.complete(request({ messages: rows })),
      /HTTP error/,
    );
    assert.equal(f.bodies.length, 1);
  }
});

test("agent continues max_tokens three times and retains each committed response", async () => {
  let count = 0;
  const provider: Provider = {
    async complete() {
      count++;
      return {
        content: [text("part")],
        stop_reason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const messages = [user()];
  await assert.rejects(
    runAgent({
      provider,
      tools: {
        definitions: [],
        execute: async () => {
          throw new Error("unexpected tool");
        },
      },
      messages,
      model,
      system: "",
      maxTokens: 100,
      maxTurns: 10,
      signal: testSignal(),
      onEvent: () => {},
    }),
    /three continuation/,
  );
  assert.equal(count, 4);
  assert.equal(
    messages.filter((message) => message.role === "assistant").length,
    4,
  );
  assert.equal(messages.filter((message) => message.role === "user").length, 4);
});

test("HTTP agent resumes two signed thinking blocks without nudges and preserves the chain next prompt", async () => {
  const f = await fixture(
    (_body, res, count) =>
      send(
        res,
        count < 3
          ? [
              begin,
              ...thinkingEvents(`sig-${count}`),
              finish("max_tokens", { resumable: true }),
              stop,
            ]
          : [begin, ...textEvents(), finish(), stop],
      ),
    { thinkingResumption: true },
  );
  const messages = [user()],
    events: AgentEvent[] = [];
  const options = {
    provider: f.provider,
    tools: {
      definitions: [],
      execute: async () => {
        throw new Error("unexpected tool");
      },
    },
    messages,
    model,
    system: "",
    maxTokens: 100,
    maxTurns: 5,
    signal: testSignal(),
    onEvent: (event: AgentEvent) => events.push(event),
  };
  await runAgent(options);
  assert.equal(f.bodies.length, 3);
  assert.equal(f.bodies[1]?.messages.at(-1)?.role, "assistant");
  assert.deepEqual(
    f.bodies[2]?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content[0]?.signature),
    ["sig-1", "sig-2"],
  );
  assert.equal(messages[2]?.resumedFromIncompleteThinking, true);
  assert.equal(messages[3]?.resumedFromIncompleteThinking, true);
  messages.push(user());
  await runAgent(options);
  assert.equal(f.bodies[3]?.messages.length, 5);
  assert.ok(
    f.headers.every(
      (headers) =>
        headers["anthropic-beta"] ===
        "thinking-resumption-2026-07-17,context-management-2025-06-27",
    ),
  );
  assert.ok(
    f.bodies.every((body) =>
      body.messages.every((message) => Object.keys(message).length === 2),
    ),
  );
});

test("refused thinking prefill surfaces immediately then agent adds one nudge and drops orphan thinking", async () => {
  const f = await fixture(
    (_body, res, count) =>
      count === 1
        ? send(res, [
            begin,
            ...thinkingEvents(),
            finish("max_tokens", { resumable: true }),
            stop,
          ])
        : count === 2
          ? reject(res, 404)
          : send(res, [begin, ...textEvents(), finish(), stop]),
    { thinkingResumption: true, maxRetries: 2 },
  );
  const messages = [user()];
  await runAgent({
    provider: f.provider,
    tools: {
      definitions: [],
      execute: async () => {
        throw new Error("unexpected tool");
      },
    },
    messages,
    model,
    system: "",
    maxTokens: 100,
    maxTurns: 5,
    maxApiAttempts: 3,
    signal: testSignal(),
    onEvent: () => {},
  });
  assert.equal(f.bodies.length, 3);
  assert.ok(f.bodies.every((body) => body.stream));
  assert.equal(f.bodies[2]?.messages.at(-1)?.role, "user");
  assert.equal(
    f.bodies[2]?.messages.some((message) => message.role === "assistant"),
    false,
  );
  assert.equal(messages.length, 4);
});

test("prefill client refusal excludes auth/transient451 and explicit denial/version codes", () => {
  for (const status of [400, 404, 405, 422])
    assert.equal(resumePrefillRefused(new ProviderHttpError(status)), true);
  for (const status of [401, 408, 409, 429, 451, 500])
    assert.equal(resumePrefillRefused(new ProviderHttpError(status)), false);
  for (const code of [
    "dlp_request_denied",
    "claude_code_version_too_old",
    "safety_monitor_blocked",
  ])
    assert.equal(resumePrefillRefused(new ProviderHttpError(400, code)), false);
});

test("resume-prefill prefix rejection never strips the signed prefill or falls back to JSON", async () => {
  const strips: ThinkingStrip[] = [];
  const f = await fixture(
    (_body, res) => reject(res, 400, undefined, "block=messages.1.content.0"),
    { thinkingResumption: true, maxRetries: 2 },
  );
  await assert.rejects(
    f.provider.complete(
      request({
        messages: [user(), assistant([think()])],
        resumeIncompleteThinking: true,
        onThinkingStrip: (strip) => strips.push(strip),
      }),
    ),
    /HTTP error 400/,
  );
  assert.equal(f.bodies.length, 1);
  assert.deepEqual(strips, []);
  assert.equal(f.bodies[0]?.messages[1]?.content[0]?.signature, "sig");
});

test("source tool-cut errors retain closed calls once and discard open arguments and provisional text", async () => {
  const cut = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "tool block cut",
      details: { error_code: "tool_use_block_cut_off" },
    },
  };
  const events = [
    begin,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "read", name: "Read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' },
    },
    { type: "content_block_stop", index: 0 },
    ...textEvents("kept").map((event) => ({ ...event, index: 1 })),
    {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "write",
        name: "Write",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"file_path":' },
    },
    { type: "content_block_start", index: 3, content_block: text("") },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "text_delta", text: "discard" },
    },
    cut,
  ];
  const f = await fixture((_body, res, count) =>
    send(res, count === 1 ? events : [begin, ...textEvents(), finish(), stop]),
  );
  const calls: string[] = [],
    emitted: AgentEvent[] = [],
    messages = [user()];
  await runAgent({
    provider: f.provider,
    tools: {
      definitions: [],
      execute: async (call) => {
        calls.push(call.id);
        return { type: "tool_result", tool_use_id: call.id, content: "read" };
      },
    },
    messages,
    model,
    system: "",
    maxTokens: 100,
    maxTurns: 5,
    maxApiAttempts: 2,
    signal: testSignal(),
    onEvent: (event) => emitted.push(event),
  });
  assert.deepEqual(calls, ["read"]);
  assert.equal(f.bodies.length, 2);
  assert.ok(
    emitted.some(
      (event) => event.type === "text_reset" && event.text === "kept",
    ),
  );
  assert.ok(!JSON.stringify(messages).includes("discard"));
  assert.ok(!JSON.stringify(messages).includes('"id":"write"'));
  assert.equal(f.bodies[1]?.messages.at(-1)?.content[0]?.tool_use_id, "read");
});

test("thinking returned by a fallback model uses a nudge when the next query starts primary", async () => {
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    thinkingResumption: true,
    async complete(req) {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      return requests.length === 1
        ? {
            content: [think()],
            stop_reason: "max_tokens",
            model: "other",
            responseModel: "other",
            resumable: true,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            content: [text("Done")],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
    },
  };
  await runAgent({
    provider,
    tools: {
      definitions: [],
      execute: async () => {
        throw new Error("unexpected tool");
      },
    },
    messages: [user()],
    model,
    system: "",
    maxTokens: 100,
    maxTurns: 3,
    signal: testSignal(),
    onEvent: () => {},
  });
  assert.equal(requests[1]?.resumeIncompleteThinking, undefined);
  assert.equal(requests[1]?.messages.at(-1)?.role, "user");
});

test("prefix repair's two-target limit survives an intervening accepted-stream retry", async () => {
  const rows = [
    user(),
    assistant([think("a"), text("answer"), think("b"), think("c"), think("d")]),
    user(),
  ];
  const strips: ThinkingStrip[] = [];
  const f = await fixture(
    (_body, res, count) => {
      if (count === 2)
        send(res, [
          begin,
          { type: "content_block_start", index: 0, content_block: text("") },
        ]);
      else if (count < 5)
        reject(
          res,
          400,
          undefined,
          `block=messages.1.content.${count === 1 ? 4 : count === 3 ? 3 : 2}`,
        );
      else send(res, [begin, ...textEvents(), finish(), stop]);
    },
    { maxRetries: 1, allowNonStreamingFallback: false },
  );
  await f.provider.complete(
    request({
      messages: rows,
      onThinkingStrip: (strip) => strips.push(strip),
      attemptBudget: new ApiAttemptBudget(5),
    }),
  );
  assert.equal(f.bodies.length, 5);
  assert.deepEqual(strips.at(-1), { scope: "all" });
  assert.deepEqual(f.bodies[4]?.messages[1]?.content, [text("answer")]);
});

test("beta refusal recognizes qualified headers and bounded capability markers", () => {
  const beta = "thinking-resumption-2026-07-17";
  assert.equal(betaHeaderRejected(`Unsupported beta: ${beta}`, beta), false);
  assert.equal(
    betaHeaderRejected(`Invalid anthropic_beta: ${beta}`, beta),
    true,
  );
  assert.equal(
    betaHeaderRejected(`capability_rejected: beta_header:${beta}`, beta),
    true,
  );
  assert.equal(
    betaHeaderRejected(`capability_rejected: beta_header:${beta}-extra`, beta),
    false,
  );
});

test("mentioning a beta name without a rejection qualifier does not disable or retry it", async () => {
  const f = await fixture(
    (_body, res) =>
      reject(res, 400, "Unsupported beta: thinking-resumption-2026-07-17"),
    { thinkingResumption: true },
  );
  await assert.rejects(f.provider.complete(request()), /HTTP error 400/);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.provider.thinkingResumption, true);
});

// This intentionally verifies the source's process-lifetime refusal latch.
test("rejected resumption beta retries an ordinary request once and remains disabled in the process", async () => {
  const f = await fixture(
    (_body, res, count) =>
      count === 1
        ? reject(
            res,
            400,
            "Unsupported anthropic-beta: thinking-resumption-2026-07-17",
          )
        : send(res, [begin, ...textEvents(), finish(), stop]),
    { thinkingResumption: true },
  );
  await f.provider.complete(request());
  assert.equal(f.bodies.length, 2);
  assert.equal(
    f.headers[1]?.["anthropic-beta"],
    "context-management-2025-06-27",
  );
  const another = new AnthropicProvider({
    apiKey: "dummy",
    thinkingResumption: true,
  });
  assert.equal(another.thinkingResumption, false);
});
