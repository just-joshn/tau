import assert from "node:assert/strict";
import { test } from "bun:test";
import { AgentMaxTurnsError } from "../../src/agent.js";
import { streamEventSchema } from "../../src/message-stream.js";
import {
  responseCostUsd,
  SdkSession,
  sdkQueryOutcome,
  type SdkMessage,
} from "../../src/sdk-messages.js";
import type { AgentEvent, AssistantBlock, Message } from "../../src/types.js";

function session(
  options: { partial?: boolean; sinceLast?: boolean; clock?: number[] } = {},
) {
  let id = 0;
  const ticks = options.clock ?? [];
  let now = 1_000;
  return new SdkSession({
    version: "0.1.0",
    includePartialMessages: options.partial ?? false,
    usageSinceLastResult: options.sinceLast ?? true,
    limits: () => ({ contextWindow: 200_000, maxOutputTokens: 32_000 }),
    now: () => (now = ticks.shift() ?? now),
    uuid: () => `uuid-${++id}`,
  });
}

const stream = (raw: unknown, block?: AssistantBlock): AgentEvent => ({
  type: "stream_event",
  event: streamEventSchema.parse(raw),
  raw,
  ...(block ? { block } : {}),
});
const start = (id?: string) =>
  stream({
    type: "message_start",
    message: {
      ...(id ? { id } : {}),
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: null,
      },
    },
  });
const text: AssistantBlock = { type: "text", text: "hi" };
const assistant = (message: Partial<Message> = {}): AgentEvent => ({
  type: "assistant",
  message: { role: "assistant", content: [text], ...message },
  stopReason: "end_turn",
});
const kinds = (messages: SdkMessage[]) =>
  messages.map((message) =>
    message.type === "system" ? `system/${message.subtype}` : message.type,
  );

test("sdkQueryOutcome separates completion, the turn limit and other failures", () => {
  assert.deepEqual(sdkQueryOutcome(undefined, "done"), {
    kind: "completed",
    result: "done",
  });
  assert.deepEqual(
    sdkQueryOutcome({ error: new AgentMaxTurnsError(3), message: "x" }, ""),
    { kind: "max_turns", maxTurns: 3 },
  );
  assert.deepEqual(
    sdkQueryOutcome({ error: new Error("boom"), message: "boom" }, ""),
    { kind: "failed", message: "boom" },
  );
});

test("responseCostUsd uses the model's pricing tier and the default tier otherwise", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  };
  assert.equal(
    responseCostUsd("claude-sonnet-4-5", usage),
    3 + 15 + 0.3 + 3.75,
  );
  assert.equal(responseCostUsd("unknown-model", usage), 5 + 25 + 0.5 + 6.25);
  assert.equal(
    responseCostUsd("claude-sonnet-4-5", {
      input_tokens: 10,
      output_tokens: 3,
    }),
    7.500000000000001e-5,
  );
});

test("init reports session facts and the original's legacy Agent tool name", () => {
  const init = session().init("s1", {
    cwd: "/w",
    tools: ["Agent", "Read"],
    mcpServers: [{ name: "m", status: "connected" }],
    model: "m1",
    permissionMode: "default",
    slashCommands: ["skill"],
    agents: ["Explore"],
    skills: ["skill"],
    plugins: [{ name: "p", path: "/p", source: "p@local" }],
  });
  assert.deepEqual(init, {
    type: "system",
    subtype: "init",
    cwd: "/w",
    session_id: "s1",
    tools: ["Task", "Read"],
    mcp_servers: [{ name: "m", status: "connected" }],
    model: "m1",
    permissionMode: "default",
    slash_commands: ["skill"],
    apiKeySource: "ANTHROPIC_API_KEY",
    claude_code_version: "0.1.0",
    output_style: "default",
    agents: ["Explore"],
    skills: ["skill"],
    plugins: [{ name: "p", path: "/p", source: "p@local" }],
    uuid: "uuid-1",
  });
});

test("streamed blocks become assistant messages before their stop event, with partial wrappers", () => {
  const query = session({
    partial: true,
    clock: [0, 5, 12, 13, 14, 15, 16, 17],
  }).query("s", "claude-sonnet-4-5-20250929");
  const out = [
    { type: "model_request" } as const,
    start("msg_1"),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    }),
    stream({ type: "content_block_stop", index: 0 }, text),
    stream({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    }),
    stream({ type: "message_stop" }),
    assistant({ responseId: "msg_1" }),
  ].flatMap((event) => query.accept(event));
  assert.deepEqual(kinds(out), [
    "system/status",
    "stream_event",
    "stream_event",
    "stream_event",
    "assistant",
    "stream_event",
    "stream_event",
    "stream_event",
  ]);
  const [, first] = out;
  assert.ok(first?.type === "stream_event");
  assert.equal(first.ttft_ms, 7);
  assert.equal(first.api_message_id, "msg_1");
  const reply = out[4];
  assert.ok(reply?.type === "assistant");
  assert.deepEqual(reply.message, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [text],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2 },
    context_management: null,
  });
  const result = query.finish({ kind: "completed", result: "hi" });
  assert.ok(result.subtype === "success");
  assert.equal(result.ttft_ms, 13);
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.num_turns, 1);
});

test("without partial messages only committed blocks are emitted, and a JSON reply emits its blocks", () => {
  const query = session().query("s", "claude-sonnet-4-5-20250929");
  assert.deepEqual(query.accept({ type: "model_request" }), []);
  assert.deepEqual(query.accept(start()), []);
  const streamed = query.accept(
    stream({ type: "content_block_stop", index: 0 }, text),
  );
  assert.ok(streamed[0]?.type === "assistant");
  assert.equal(streamed[0].message.id, null);
  assert.deepEqual(query.accept(assistant()), []);
  // A block stop without a response start, as after a lost message_start, emits nothing.
  assert.deepEqual(
    query.accept(stream({ type: "content_block_stop", index: 0 }, text)),
    [],
  );
  const fallback = query.accept(
    assistant({
      content: [text, { type: "tool_use", id: "t", name: "Read", input: {} }],
      responseModel: "served",
      responseId: "msg_json",
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
  );
  assert.deepEqual(
    fallback.map((message) =>
      message.type === "assistant"
        ? [
            message.message.id,
            message.message.model,
            message.message.stop_reason,
            message.message.usage,
          ]
        : [],
    ),
    [
      ["msg_json", "served", "end_turn", { input_tokens: 4, output_tokens: 2 }],
      ["msg_json", "served", "end_turn", { input_tokens: 4, output_tokens: 2 }],
    ],
  );
  const bare = query.accept(assistant({ model: "requested" }));
  assert.ok(bare[0]?.type === "assistant");
  assert.equal(bare[0].message.model, "requested");
  assert.deepEqual(bare[0].message.usage, {
    input_tokens: 0,
    output_tokens: 0,
  });
  const unnamed = query.accept(assistant());
  assert.ok(unnamed[0]?.type === "assistant");
  assert.equal(unnamed[0].message.model, "claude-sonnet-4-5-20250929");
});

test("tool results become user messages and print denials are listed once", () => {
  const query = session().query("s", "m");
  const call = {
    type: "tool_use" as const,
    id: "t1",
    name: "Agent",
    input: { a: 1 },
  };
  query.accept({ type: "tool_start", tool: call });
  const denied = {
    type: "tool_result" as const,
    tool_use_id: "t1",
    content: "<tool_use_error>No</tool_use_error>",
    is_error: true,
    permissionDenied: true,
  };
  const [user] = query.accept({ type: "tool_result", result: denied });
  assert.deepEqual(user, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "<tool_use_error>No</tool_use_error>",
          is_error: true,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "uuid-1",
    timestamp: new Date(1_000).toISOString(),
    tool_use_result: "Error: No",
  });
  query.accept({ type: "tool_result", result: denied });
  query.accept({
    type: "tool_result",
    result: { ...denied, tool_use_id: "unknown" },
  });
  const [plain] = query.accept({
    type: "tool_result",
    result: {
      type: "tool_result",
      tool_use_id: "t2",
      content: "rich",
      apiContent: [{ type: "text", text: "rich" }],
    },
  });
  assert.ok(plain?.type === "user");
  assert.deepEqual(plain.message.content[0], {
    type: "tool_result",
    tool_use_id: "t2",
    content: [{ type: "text", text: "rich" }],
  });
  assert.equal(plain.tool_use_result, "rich");
  const [failed] = query.accept({
    type: "tool_result",
    result: {
      type: "tool_result",
      tool_use_id: "t3",
      content: "plain failure",
      is_error: true,
    },
  });
  assert.ok(failed?.type === "user");
  assert.equal(failed.tool_use_result, "Error: plain failure");
  const result = query.finish({ kind: "failed", message: "boom" });
  assert.deepEqual(result.permission_denials, [
    { tool_name: "Task", tool_use_id: "t1", tool_input: { a: 1 } },
  ]);
  assert.ok(result.subtype === "error_during_execution");
  assert.deepEqual(result.errors, ["boom"]);
  assert.equal(result.stop_reason, null);
  assert.equal("terminal_reason" in result, false);
});

test("compaction completes as a compact boundary; other agent events emit nothing", () => {
  const query = session().query("s", "m");
  const [manual] = query.accept({
    type: "compaction",
    stage: "complete",
    reason: "manual",
    beforeTokens: 90,
    afterTokens: 10,
  });
  assert.ok(manual?.type === "system" && manual.subtype === "compact_boundary");
  assert.deepEqual(manual.compact_metadata, {
    trigger: "manual",
    pre_tokens: 90,
    post_tokens: 10,
  });
  const [auto] = query.accept({
    type: "compaction",
    stage: "complete",
    reason: "reactive",
  });
  assert.ok(auto?.type === "system" && auto.subtype === "compact_boundary");
  assert.deepEqual(auto.compact_metadata, { trigger: "auto", pre_tokens: 0 });
  const quiet: AgentEvent[] = [
    { type: "compaction", stage: "start" },
    { type: "text", text: "x" },
    { type: "text_reset", text: "" },
    { type: "warning", message: "w" },
    { type: "thinking_stripped", strip: { scope: "all" } },
    { type: "api_error", status: 529 },
  ];
  for (const event of quiet) assert.deepEqual(query.accept(event), []);
});

test("a failed model request ends as an API-error reply", () => {
  const query = session().query("s", "m");
  query.accept({ type: "api_error", status: null });
  const result = query.finish({
    kind: "failed",
    message: "Messages API HTTP error 529",
  });
  assert.equal(result.subtype, "success");
  assert.ok(result.subtype === "success");
  assert.equal(result.is_error, true);
  assert.equal(result.api_error_status, null);
  assert.equal(result.result, "Messages API HTTP error 529");
  assert.equal("ttft_ms" in result, false);
});

test("the turn limit reports the refused next turn", () => {
  const result = session()
    .query("s", "m")
    .finish({ kind: "max_turns", maxTurns: 4 });
  assert.ok(result.subtype === "error_max_turns");
  assert.equal(result.num_turns, 5);
  assert.equal(result.terminal_reason, "max_turns");
  assert.deepEqual(result.errors, ["Reached maximum number of turns (4)"]);
});

test("cost, model usage and result_index accumulate across queries; per-query usage resets", () => {
  const sdk = session({ clock: [0, 0, 7, 7, 7, 20, 20, 25, 25, 25] });
  const usage = {
    input_tokens: 10,
    output_tokens: 3,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 2,
  };
  const first = sdk.query("s", "claude-sonnet-4-5-20250929");
  first.accept({ type: "model_request" });
  first.accept({ type: "usage", usage });
  first.accept(assistant());
  const one = first.finish({ kind: "completed", result: "a" });
  const second = sdk.query("s", "claude-sonnet-4-5-20250929");
  second.accept({
    type: "usage",
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  const two = second.finish({ kind: "completed", result: "b" });
  assert.equal(one.result_index, 0);
  assert.equal(two.result_index, 1);
  assert.equal(one.duration_api_ms, 7);
  assert.equal(two.total_cost_usd, one.total_cost_usd + 7.500000000000001e-5);
  assert.equal(two.usage.input_tokens, 10);
  assert.equal(two.usage.cache_read_input_tokens, 0);
  assert.equal(one.usage.cache_creation_input_tokens, 2);
  assert.deepEqual(
    [
      two.modelUsage["claude-sonnet-4-5-20250929"]?.inputTokens,
      two.model_usage_since_last_result?.["claude-sonnet-4-5-20250929"]
        ?.inputTokens,
    ],
    [20, 10],
  );
  assert.equal(
    two.modelUsage["claude-sonnet-4-5-20250929"]?.canonicalModel,
    "claude-sonnet-4-5",
  );
  const json = session({ sinceLast: false })
    .query("s", "m")
    .finish({ kind: "completed", result: "" });
  assert.equal("model_usage_since_last_result" in json, false);
});
