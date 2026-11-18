import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { MessageStream, streamEventSchema } from "../src/message-stream.js";
import {
  NativeResponseRecordingError,
  initialNativeResponseUsage,
  mergeNativeResponseUsage,
  nativeResponseRecordingSchema,
  recordNativeJsonResponse,
  snapshotNativeResponseJson,
  type NativeResponseRecording,
  type NativeResponseRecordingHost,
} from "../src/native-response-recording.js";
import { AnthropicProvider } from "../src/provider.js";
import { newSession, SessionStore } from "../src/session.js";
import { projectMessages } from "../src/thinking-history.js";
import { runAgent } from "../src/agent.js";
import type { CompletionRequest } from "../src/types.js";
import { fixtureSse } from "./sse-fixture.js";
import { isNativeObject } from "../src/native-session-codec.js";

function identities() {
  const calls: Parameters<NativeResponseRecordingHost["stamp"]>[0][] = [];
  const host: NativeResponseRecordingHost = {
    stamp(event) {
      calls.push(event);
      return {
        uuid: `00000000-0000-0000-0000-${String(calls.length).padStart(12, "0")}`,
        timestamp: `2026-11-18T00:00:00.${String(calls.length).padStart(3, "0")}Z`,
      };
    },
  };
  return { host, calls };
}
const beginning = (id = "actual-sdk-id") => ({
  type: "message_start",
  message: {
    type: "message",
    id,
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 0,
      server_tool_use: { web_fetch_requests: 2 },
      speed: "fast",
    },
    diagnostics: { cache_miss_reason: "owned-fixture" },
  },
});
const open = (index: number, content_block: unknown) => ({
  type: "content_block_start",
  index,
  content_block,
});
const change = (index: number, delta: unknown) => ({
  type: "content_block_delta",
  index,
  delta,
});
const close = (index: number) => ({ type: "content_block_stop", index });
const end = (stop_reason = "end_turn") => ({
  type: "message_delta",
  delta: { stop_reason },
  usage: { output_tokens: 3 },
});
const stopped = { type: "message_stop" };
const text = (value: string, index = 0) => [
  open(index, { type: "text", text: "" }),
  change(index, { type: "text_delta", text: value }),
  close(index),
];
function completed(value: NativeResponseRecording | undefined) {
  assert.ok(value && value.status === "complete");
  return value;
}

test("native usage merging retains actual source defaults, positive cache counts, zero output updates and nullish detail semantics", () => {
  const initial = initialNativeResponseUsage();
  const first = mergeNativeResponseUsage(
    initial,
    snapshotNativeResponseJson({
      input_tokens: 17,
      output_tokens: 8,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 6,
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 7,
      },
      output_tokens_details: { thinking_tokens: 3 },
      server_tool_use: { web_search_requests: 4 },
      service_tier: "priority",
      inference_geo: "owned",
      iterations: [{ type: "owned" }],
      speed: "fast",
      fallback_credit: { amount: 2 },
      ignored_sdk_field: "must-not-appear",
    }),
  );
  assert.equal(first.cache_creation_input_tokens, 40);
  assert.deepEqual(first.cache_creation, {
    ephemeral_1h_input_tokens: 2,
    ephemeral_5m_input_tokens: 7,
  });
  const second = mergeNativeResponseUsage(
    first,
    snapshotNativeResponseJson({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_search_requests: 0 },
      iterations: [],
      speed: null,
      fallback_credit: null,
    }),
  );
  assert.equal(second.input_tokens, 17);
  assert.equal(second.output_tokens, 0);
  assert.equal(second.cache_creation_input_tokens, 40);
  assert.equal(second.cache_read_input_tokens, 6);
  assert.deepEqual(second.cache_creation, first.cache_creation);
  assert.deepEqual(second.output_tokens_details, { thinking_tokens: 0 });
  assert.deepEqual(second.server_tool_use, {
    web_search_requests: 0,
    web_fetch_requests: 0,
  });
  assert.deepEqual(second.iterations, []);
  assert.equal(second.speed, "fast");
  assert.deepEqual(second.fallback_credit, { amount: 2 });
  assert.equal(second.ignored_sdk_field, undefined);
  const third = mergeNativeResponseUsage(second, {
    cache_creation: { ephemeral_5m_input_tokens: 5 },
  });
  assert.equal(third.cache_creation_input_tokens, 5);
  assert.deepEqual(third.cache_creation, {
    ephemeral_1h_input_tokens: 2,
    ephemeral_5m_input_tokens: 5,
  });
  assert.deepEqual(initial, initialNativeResponseUsage());
});

test("real stream fragments are stamped at closure with actual indices and receive later SDK usage/stop updates", () => {
  const ids = identities();
  const stream = new MessageStream(() => {}, undefined, {
    host: ids.host,
    requestedModel: "requested-model",
    requestId: "owned-request",
  });
  const events = [
    beginning(),
    open(9, { type: "text", text: "ignored" }),
    open(2, { type: "tool_use", id: "read-call", name: "Read", input: {} }),
    change(9, { type: "text_delta", text: "ACTUAL_PRELUDE" }),
    change(2, {
      type: "input_json_delta",
      partial_json: '{"file_path":"owned.txt"}',
    }),
    close(2),
    close(9),
    {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_details: {
          reason: "owned-stop",
          fallback_credit_token: "PRIVATE_CREDIT_TOKEN",
        },
        resumable: true,
      },
      usage: {
        output_tokens: 3,
        output_tokens_details: { thinking_tokens: 1 },
      },
    },
    { type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
    stopped,
  ];
  for (const event of events) {
    stream.accept(streamEventSchema.parse(event), event);
    if (event.type === "content_block_start") assert.equal(ids.calls.length, 0);
    if (event.type === "message_delta") assert.equal(ids.calls.length, 2);
  }
  const result = stream.completion(),
    native = completed(result.nativeResponse);
  assert.equal(native.transport, "stream");
  assert.equal(native.rows.length, 2);
  assert.deepEqual(
    native.rows.map((row) => row.apiBlockIndex),
    [2, 9],
  );
  assert.deepEqual(
    ids.calls.map((call) => call.apiBlockIndex),
    [2, 9],
  );
  for (const row of native.rows) {
    assert.equal(row.message.id, "actual-sdk-id");
    assert.equal(row.requestedModel, "requested-model");
    assert.equal(row.requestId, "owned-request");
    assert.equal(row.message.stop_reason, "tool_use");
    assert.equal(row.message.stop_sequence, null);
    assert.deepEqual(row.message.stop_details, { reason: "owned-stop" });
    assert.equal(row.message.resumable, true);
    assert.deepEqual(row.message.usage, {
      ...initialNativeResponseUsage(),
      input_tokens: 12,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 1 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 2 },
      speed: "fast",
    });
    assert.deepEqual(row.message.diagnostics, {
      cache_miss_reason: "owned-fixture",
    });
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.message));
  }
  assert.equal(JSON.stringify(native).includes("PRIVATE_CREDIT_TOKEN"), false);
  assert.deepEqual(native.rows[0]?.message.content, [
    {
      type: "tool_use",
      id: "read-call",
      name: "Read",
      input: { file_path: "owned.txt" },
    },
  ]);
  assert.deepEqual(native.rows[1]?.message.content, [
    { type: "text", text: "ACTUAL_PRELUDE" },
  ]);
  assert.equal(result.content.length, 2);
  assert.deepEqual(stream.completion().nativeResponse, native);
  assert.equal(ids.calls.length, 2);
});

test("JSON response records one actual body with all blocks instead of fabricating streamed block identities", () => {
  const ids = identities();
  const source = {
    ...beginning().message,
    content: [
      { type: "text", text: "ONE" },
      { type: "text", text: "TWO" },
    ],
    stop_reason: "stop_sequence",
    stop_sequence: "OWNED_STOP",
    usage: { input_tokens: 11, output_tokens: 9 },
    container: { id: "actual-container" },
  };
  const result = completed(
    recordNativeJsonResponse(
      { host: ids.host, requestedModel: "owned-json-model" },
      source,
      source.content,
    ),
  );
  assert.equal(result.transport, "json");
  assert.equal(result.rows.length, 1);
  assert.equal(ids.calls.length, 1);
  assert.equal(result.rows[0]?.apiBlockIndex, 0);
  assert.equal(result.rows[0]?.message.stop_reason, "stop_sequence");
  assert.equal(result.rows[0]?.message.stop_sequence, "OWNED_STOP");
  assert.deepEqual(result.rows[0]?.message.content, source.content);
  assert.deepEqual(result.rows[0]?.message.container, source.container);
  assert.equal(result.rows[0]?.message.stop_details, undefined);
});

test("response capture rejects accessors, cycles, symbols and malformed arrays without invoking getters, and copies deep JSON iteratively", () => {
  let invoked = false;
  const getter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      invoked = true;
      return "NO";
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const input of [
    getter,
    cycle,
    { value: NaN },
    new Date(),
    [undefined],
    Object.assign([], { extra: true }),
    { [Symbol("owned")]: true },
  ])
    assert.throws(
      () => snapshotNativeResponseJson(input),
      NativeResponseRecordingError,
    );
  assert.equal(invoked, false);
  let nested: Record<string, unknown> = { end: "DEEP" };
  for (let depth = 0; depth < 5000; depth++) nested = { nested };
  let saved = snapshotNativeResponseJson(nested);
  for (let depth = 0; depth < 5000; depth++) {
    assert.ok(isNativeObject(saved));
    saved = saved.nested ?? null;
  }
  assert.deepEqual(saved, { end: "DEEP" });
});

test("native recording rejects absent actual SDK identity, duplicate stamps and unsupported context projection", () => {
  const ids = identities();
  const start = beginning();
  Reflect.deleteProperty(start.message, "model");
  const absent = new MessageStream(() => {}, undefined, {
    host: ids.host,
    requestedModel: "known",
  });
  assert.throws(
    () => absent.accept(streamEventSchema.parse(start), start),
    /missing SDK model/,
  );
  const duplicate = new MessageStream(() => {}, undefined, {
    host: {
      stamp: () => ({
        uuid: "00000000-0000-0000-0000-000000000001",
        timestamp: "2026-11-18T00:00:00Z",
      }),
    },
    requestedModel: "known",
  });
  for (const event of [beginning(), ...text("first")])
    duplicate.accept(streamEventSchema.parse(event), event);
  const more = text("second", 1);
  duplicate.accept(streamEventSchema.parse(more[0]));
  duplicate.accept(streamEventSchema.parse(more[1]));
  assert.throws(
    () => duplicate.accept(streamEventSchema.parse(more[2])),
    /reused a block identity/,
  );
  const context = new MessageStream(() => {}, undefined, {
    host: ids.host,
    requestedModel: "known",
  });
  const unmanaged = {
    ...beginning(),
    message: { ...beginning().message, context_management: { edits: [] } },
  };
  assert.throws(
    () => context.accept(streamEventSchema.parse(unmanaged), unmanaged),
    /actual projection host/,
  );
});

test("partial and output-limit adapters cannot relabel observed blocks as a complete native response", () => {
  const ids = identities(),
    stream = new MessageStream(() => {}, undefined, {
      host: ids.host,
      requestedModel: "known",
    });
  for (const event of [beginning(), ...text("closed-before-failure")])
    stream.accept(streamEventSchema.parse(event), event);
  assert.equal(
    stream.partial("connectionLost").nativeResponse?.status,
    "unsupported",
  );
  assert.equal(stream.outputLimited().nativeResponse?.status, "unsupported");
  assert.equal(ids.calls.length, 1);
});

async function api(
  handler: (response: ServerResponse, call: number, body: unknown) => void,
  options: { allowNonStreamingFallback?: boolean; maxRetries?: number } = {},
) {
  let calls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      handler(response, ++calls, JSON.parse(raw));
    })().catch(() => response.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    provider: new AnthropicProvider({
      apiKey: "owned-dummy",
      baseUrl: `http://127.0.0.1:${address.port}`,
      allowNonStreamingFallback: false,
      ...options,
    }),
    calls: () => calls,
  };
}
function request(
  nativeRecording: NativeResponseRecordingHost,
): CompletionRequest {
  return {
    model: "claude-sonnet-4-6",
    system: "OWNED_NATIVE_RECORDING",
    messages: [
      { role: "user", content: [{ type: "text", text: "record this" }] },
    ],
    tools: [],
    maxTokens: 100,
    signal: new AbortController().signal,
    onText: () => {},
    nativeRecording,
  };
}
function send(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "request-id": "actual-http-request",
  });
  response.end(fixtureSse(events));
}

test("real provider preserves raw SDK extras and agent/session schemas retain physical rows without leaking them into model history", async () => {
  const ids = identities(),
    bodies: unknown[] = [];
  const f = await api((response, _call, body) => {
    bodies.push(body);
    send(response, [
      beginning(),
      ...text("SDK_ONE", 3),
      ...text("SDK_TWO", 7),
      end(),
      stopped,
    ]);
  });
  const session = newSession("/owned-work", "claude-sonnet-4-6");
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: "owned" }],
  });
  await runAgent({
    provider: f.provider,
    tools: {
      definitions: [],
      execute: async () => {
        throw Error("No tools allowed");
      },
    },
    messages: session.messages,
    model: session.model,
    system: "OWNED",
    maxTokens: 100,
    maxTurns: 1,
    signal: new AbortController().signal,
    autoCompact: false,
    onEvent: () => {},
    nativeRecording: ids.host,
  });
  const native = completed(session.messages.at(-1)?.nativeResponse);
  assert.deepEqual(
    native.rows.map((row) => row.apiBlockIndex),
    [3, 7],
  );
  assert.equal(native.rows[0]?.requestId, "actual-http-request");
  assert.equal(JSON.stringify(bodies).includes("nativeRecording"), false);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-response-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = await SessionStore.create(root, root);
  session.cwd = root;
  await store.save(session);
  const loaded = await store.load(session.id);
  assert.deepEqual(loaded.messages.at(-1)?.nativeResponse, native);
  assert.equal(
    JSON.stringify(projectMessages(loaded.messages)).includes("nativeResponse"),
    false,
  );
  assert.equal(nativeResponseRecordingSchema.safeParse(native).success, true);
});

test(
  "retry attempts retain their own stamped block rows instead of assigning old thinking to the replacement response",
  async () => {
    const ids = identities();
    const f = await api(
      (response, call) =>
        send(
          response,
          call === 1
            ? [
                beginning("abandoned-sdk"),
                open(0, { type: "thinking", thinking: "", signature: "" }),
                change(0, { type: "thinking_delta", thinking: "discard" }),
                change(0, { type: "signature_delta", signature: "old" }),
                close(0),
              ]
            : [
                beginning("replacement-sdk"),
                ...text("replacement"),
                end(),
                stopped,
              ],
        ),
      { maxRetries: 1 },
    );
    const result = completed(
      (await f.provider.complete(request(ids.host))).nativeResponse,
    );
    assert.equal(f.calls(), 2);
    assert.equal(ids.calls.length, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.uuid.endsWith("000000000002"), true);
    assert.equal(result.rows[0]?.message.id, "replacement-sdk");
    assert.equal(JSON.stringify(result).includes("discard"), false);
  },
  { timeout: 10000 },
);

test("recording-host failure is local and cannot trigger a new model attempt or JSON fallback", async () => {
  const f = await api(
    (response) =>
      send(response, [beginning(), ...text("owned"), end(), stopped]),
    { maxRetries: 2, allowNonStreamingFallback: true },
  );
  await assert.rejects(
    f.provider.complete(
      request({
        stamp() {
          throw Error("owned host failure");
        },
      }),
    ),
    NativeResponseRecordingError,
  );
  assert.equal(f.calls(), 1);
});

test("real provider records completed tool ingest at its original API index", async () => {
  const ids = identities();
  const f = await api((response) =>
    send(response, [
      beginning(),
      open(4, { type: "tool_use", id: "actual-read", name: "Read", input: {} }),
      change(4, {
        type: "input_json_delta",
        partial_json: '{"file_path":"note.txt","offset":"+2"}',
      }),
      close(4),
      end("tool_use"),
      stopped,
    ]),
  );
  const reply = await f.provider.complete({
    ...request(ids.host),
    tools: [
      {
        name: "Read",
        description: "Owned Read",
        input_schema: { type: "object" },
      },
    ],
  });
  const rows = completed(reply.nativeResponse).rows;
  assert.equal(rows[0]?.apiBlockIndex, 4);
  assert.deepEqual(rows[0]?.message.content, reply.content);
  assert.deepEqual(reply.content, [
    {
      type: "tool_use",
      id: "actual-read",
      name: "Read",
      input: { file_path: "note.txt", offset: 2 },
    },
  ]);
});

test("provider JSON fallback stamps the genuine complete reply once and preserves its complete body", async () => {
  const ids = identities();
  const message = {
    ...beginning("actual-json-reply").message,
    content: [
      { type: "text", text: "JSON_FIRST" },
      { type: "text", text: "JSON_SECOND" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 5, service_tier: "priority" },
  };
  const f = await api(
    (response, call) => {
      if (call === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end();
      } else {
        response.writeHead(200, {
          "content-type": "application/json",
          "request-id": "actual-json-request",
        });
        response.end(JSON.stringify(message));
      }
    },
    { allowNonStreamingFallback: true },
  );
  const reply = await f.provider.complete(request(ids.host)),
    native = completed(reply.nativeResponse);
  assert.equal(f.calls(), 2);
  assert.equal(ids.calls.length, 1);
  assert.equal(native.transport, "json");
  assert.equal(native.rows.length, 1);
  assert.equal(native.rows[0]?.requestId, "actual-json-request");
  assert.deepEqual(native.rows[0]?.message.content, reply.content);
  assert.deepEqual(native.rows[0]?.message.usage, {
    ...initialNativeResponseUsage(),
    input_tokens: 8,
    output_tokens: 5,
    service_tier: "priority",
  });
});
