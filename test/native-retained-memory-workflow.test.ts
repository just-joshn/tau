import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeRetainedMemoryOwner,
  type NativeMemoryProducerCapability,
} from "../src/native-retained-memory.js";
import { AnthropicProvider } from "../src/provider.js";
import {
  snapshotNativeResponseJson,
  type NativeResponseRecordingHost,
} from "../src/native-response-recording.js";
import { createHookRegistry } from "../src/hooks.js";
import {
  nativeLifecycleCommandRegistry,
  runNativeLifecycleHookDispatch,
  type NativeLifecycleCaptureHost,
  type NativeLifecycleCommandFacts,
} from "../src/native-lifecycle-hooks.js";
import {
  planNativePromptSnapshot,
  readNativePromptSnapshot,
  type NativePromptSnapshotHost,
  type NativePromptFact,
} from "../src/native-prompt-snapshot.js";
import { classifyNativePersistenceRow } from "../src/native-persistence-selection.js";
import { createTools, type TextReadResultCapture } from "../src/tools.js";
import {
  isNativeObject,
  type NativeObject,
} from "../src/native-session-codec.js";
import type { CompletionRequest } from "../src/types.js";
import { fixtureSse } from "./sse-fixture.js";

const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const signal = () => new AbortController().signal;
const sid = "99999999-1111-1111-1111-111111111111";
const object = (value: unknown): NativeObject => {
  const saved = snapshotNativeResponseJson(value);
  assert.ok(isNativeObject(saved));
  return saved;
};

test("owned real provider -> Read -> answer -> lifecycle/snapshot workflow retains actual finalized history without any writable transcript", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-memory-workflow-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const actualFile = join(cwd, "owned.txt"),
    hookScript = join(cwd, "owned-hook.mjs");
  await writeFile(actualFile, "ACTUAL_LOCAL_FILE\n");
  await writeFile(
    hookScript,
    "for await(const _ of process.stdin){}process.stdout.write(process.argv[2]);",
  );
  const facts = new Map<string, NativeObject>(),
    identities = new Set<string>();
  let serial = 0;
  const stamp = () => {
    const uuid = `${String(++serial).padStart(8, "0")}-1111-1111-1111-111111111111`;
    identities.add(uuid);
    return {
      uuid,
      timestamp: `2026-01-01T00:00:00.${String(serial).padStart(3, "0")}Z`,
    };
  };
  const memory = NativeRetainedMemoryOwner.open(
    { sessionId: sid },
    {
      admitProducer: ({ producer }) =>
        [
          "prompt",
          "snapshot",
          "api-response",
          "Read-result",
          "Stop-consumer",
        ].includes(producer.name),
      admitRetention: ({ rows }) => {
        for (const row of rows) {
          assert.ok(identities.has(row.uuid));
          assert.deepEqual(row, facts.get(row.uuid));
        }
        return true;
      },
    },
  );
  onTestFinished(async () => {
    await memory.close();
  });
  const keep = async (
    producer: NativeMemoryProducerCapability,
    rows: readonly NativeObject[],
  ) => {
    for (const row of rows) {
      assert.ok(typeof row.uuid === "string");
      facts.set(row.uuid, object(row));
    }
    return memory.retain(producer, rows, { signal: signal() });
  };
  const prompt = await memory.admitProducer(
    { name: "prompt", kinds: ["user"] },
    signal(),
  );
  await keep(prompt, [
    {
      type: "user",
      ...stamp(),
      message: { role: "user", content: "Read owned.txt" },
    },
  ]);
  const snapshots = await memory.admitProducer(
    { name: "snapshot", kinds: ["attachment"] },
    signal(),
  );
  const snapshotHost: NativePromptSnapshotHost = {
    stamp,
    owedPrompt: () => known(undefined),
    reminderFold: () => known(false),
    echoWireToolInputs: () => known(false),
    modelEffortAfterText: () => known(false),
    toolSchemaProvenance: () => known("actual-request-wire-entry"),
    noteCopied: () => {},
    noteRendered: () => {},
    redescribing: () => known(undefined),
    noteRedescribed: () => {},
  };
  const planned = planNativePromptSnapshot(
    {
      history: (await memory.view(signal())).entries.map((entry) => entry.row),
      enabled: known(true),
      replayEnabled: known(true),
      bareFork: false,
      querySource: "sdk",
      systemPrompt: ["ACTUAL_MEMORY_SYSTEM"],
      resumeActive: false,
      model: "claude-sonnet-4-6",
      contextRendering: known("announced"),
    },
    snapshotHost,
  );
  assert.equal(planned.status, "resolved");
  if (planned.status !== "resolved")
    throw new Error("actual snapshot unavailable");
  const snapshot = planned.plan.creation;
  assert.ok(snapshot);
  assert.equal(snapshot.serialization.status, "supported");
  await keep(snapshots, [object(snapshot.record)]);

  let requests = 0;
  const requestBodies: NativeObject[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += String(part);
    requestBodies.push(object(JSON.parse(raw)));
    const call = ++requests;
    const blocks =
      call === 1
        ? [
            { type: "text", text: "READING" },
            {
              type: "tool_use",
              id: "actual-read-call",
              name: "Read",
              input: { file_path: "owned.txt" },
            },
          ]
        : [{ type: "text", text: "ACTUAL_LOCAL_FILE" }];
    const events: unknown[] = [
      {
        type: "message_start",
        message: {
          type: "message",
          id: `actual-sdk-${call}`,
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 19, output_tokens: 0 },
          diagnostics: { cache_miss_reason: "ACTUAL_SOURCE" },
          sdk_extra: { exact: call },
        },
      },
    ];
    blocks.forEach((block, index) =>
      events.push(
        { type: "content_block_start", index, content_block: block },
        { type: "content_block_stop", index },
      ),
    );
    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: call === 1 ? "tool_use" : "end_turn",
          stop_details: { type: "actual-stop", detail: call },
        },
        usage: { output_tokens: 2 },
      },
      {
        type: "message_delta",
        delta: { resumable: true },
        usage: {
          output_tokens: 29,
          output_tokens_details: { thinking_tokens: 7 },
        },
      },
      { type: "message_stop" },
    );
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "request-id": `actual-request-${call}`,
    });
    response.end(fixtureSse(events));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({
    apiKey: "owned-local-dummy",
    baseUrl: `http://127.0.0.1:${address.port}`,
    allowNonStreamingFallback: false,
    maxRetries: 0,
  });
  const api = await memory.admitProducer(
    { name: "api-response", kinds: ["assistant"] },
    signal(),
  );
  const nativeRecording: NativeResponseRecordingHost = { stamp };
  const request: CompletionRequest = {
    model: "claude-sonnet-4-6",
    system: "ACTUAL_MEMORY_SYSTEM",
    messages: [
      { role: "user", content: [{ type: "text", text: "Read owned.txt" }] },
    ],
    tools: [
      {
        name: "Read",
        description: "read actual local text",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
    ],
    maxTokens: 100,
    signal: signal(),
    onText: () => {},
    nativeRecording,
  };
  const first = await provider.complete(request);
  assert.equal(first.nativeResponse?.status, "complete");
  if (first.nativeResponse?.status !== "complete")
    throw new Error("missing actual recorded response");
  assert.equal(first.nativeResponse.rows.length, 2);
  await keep(api, first.nativeResponse.rows);
  const sourceAssistant = first.nativeResponse.rows.find(
    (row) => row.apiBlockIndex === 1,
  );
  assert.ok(sourceAssistant);
  for (const row of first.nativeResponse.rows) {
    assert.equal(row.message.stop_reason, "tool_use");
    assert.ok(isNativeObject(row.message.usage));
    assert.equal(row.message.usage.output_tokens, 29);
    assert.deepEqual(row.message.sdk_extra, { exact: 1 });
    assert.equal(row.requestId, "actual-request-1");
    assert.deepEqual(row.message.stop_details, {
      type: "actual-stop",
      detail: 1,
    });
    assert.equal(row.message.resumable, true);
    assert.deepEqual(row.message.usage.output_tokens_details, {
      thinking_tokens: 7,
    });
  }
  const toolUse = first.content.find((block) => block.type === "tool_use");
  assert.ok(toolUse && toolUse.type === "tool_use");
  const resultProducer = await memory.admitProducer(
    { name: "Read-result", kinds: ["user"] },
    signal(),
  );
  let observed: TextReadResultCapture | undefined;
  const tools = createTools({
    cwd,
    mode: "default",
    approve: async () => false,
    onTextReadResult: async (input) => {
      observed = input;
      assert.equal(input.permissionTrace.branch, "readonly");
      assert.equal(input.nativeCompatibility.status, "supported");
      await keep(resultProducer, [
        {
          type: "user",
          ...stamp(),
          sourceToolAssistantUUID: sourceAssistant.uuid,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: input.finalResult.content,
                ...(input.finalResult.is_error === undefined
                  ? {}
                  : { is_error: input.finalResult.is_error }),
              },
            ],
          },
          toolUseResult: object(input.rawResult),
        },
      ]);
    },
  });
  const result = await tools.execute(toolUse, signal());
  assert.ok(observed);
  assert.equal(observed.rawResult.file.content, "ACTUAL_LOCAL_FILE\n");
  const second = await provider.complete({
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [result] },
    ],
    signal: signal(),
  });
  if (second.nativeResponse?.status !== "complete")
    throw new Error("missing final recorded answer");
  await keep(api, second.nativeResponse.rows);

  const lifecycle = await memory.admitProducer(
    { name: "Stop-consumer", kinds: ["attachment", "user"] },
    signal(),
  );
  const hookRegistry = createHookRegistry([
    {
      source: "owned-command-fixture",
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [hookScript, ""],
              },
              {
                type: "command",
                command: process.execPath,
                args: [
                  hookScript,
                  JSON.stringify({
                    hookSpecificOutput: {
                      hookEventName: "Stop",
                      additionalContext: "REAL_STOP_CONTEXT",
                    },
                  }),
                ],
              },
            ],
          },
        ],
      },
    },
  ]);
  onTestFinished(() => hookRegistry.close());
  const lifecycleHost: NativeLifecycleCaptureHost = {
    stamp,
    capture: async (creation) => {
      await keep(lifecycle, [creation.event]);
    },
    unsupported: () => {
      throw new Error("Unexpected unsupported lifecycle producer");
    },
  };
  const commandFacts: NativeLifecycleCommandFacts = {
    output: known("structured"),
    command: known("ACTUAL_NATIVE_COMMAND"),
    structuredSuccessNotice: known(undefined),
    retainMessageForStop: known(false),
    retainContextForStop: known(true),
    hasProgress: known(true),
  };
  const decision = await runNativeLifecycleHookDispatch(
    {
      input: {
        event: "Stop",
        dispatchToolUseID: stamp().uuid,
        phase: "ordinary",
      },
      hookInput: {
        hook_event_name: "Stop",
        session_id: sid,
        transcript_path: join(cwd, "source-computed-but-unwritten.jsonl"),
        cwd,
        stop_hook_active: false,
      },
      host: lifecycleHost,
      stages: {
        classicOrFunctionChain: known(false),
        managedOrRemoteTransport: known(false),
        activeGoalOrTaskEnforcement: known(false),
        backgroundRewake: known(false),
      },
      runner: nativeLifecycleCommandRegistry({
        registry: hookRegistry,
        runOptions: () => ({ cwd, projectDir: cwd, env: {} }),
        facts: (value) => ({
          ...commandFacts,
          output: known(value.stdout ? "structured" : "plain"),
        }),
      }),
    },
    signal(),
  );
  assert.equal(decision.continue, true);
  assert.equal(decision.continuationEvents.length, 1);
  const view = await memory.flush(signal()),
    emptySuccess = view.entries.find(
      (entry) =>
        isNativeObject(entry.row.attachment) &&
        entry.row.attachment.type === "hook_success" &&
        entry.row.attachment.stdout === "",
    );
  assert.ok(emptySuccess);
  assert.equal(classifyNativePersistenceRow(emptySuccess.row).keep, false);
  assert.ok(
    view.entries.some(
      (entry) =>
        isNativeObject(entry.row.attachment) &&
        entry.row.attachment.type === "hook_additional_context",
    ),
  );
  assert.deepEqual(
    readNativePromptSnapshot(view.entries.map((entry) => entry.row))
      ?.systemPrompt,
    ["ACTUAL_MEMORY_SYSTEM"],
  );
  assert.equal(requests, 2);
  assert.ok(
    requestBodies.every((body) => !JSON.stringify(body).includes('"uuid"')),
  );
  assert.deepEqual((await readdir(cwd)).sort(), [
    "owned-hook.mjs",
    "owned.txt",
  ]);
  const closed = await memory.close();
  assert.equal(closed.status, "closed");
  assert.equal(closed.entries.length, view.entries.length);
  assert.deepEqual((await readdir(cwd)).sort(), [
    "owned-hook.mjs",
    "owned.txt",
  ]);
});
