import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeMemoryJournal,
  type NativeMemoryJournalView,
} from "../src/native-memory-journal.js";
import { runAgent, type NativeAgentStopHooks } from "../src/agent.js";
import { AnthropicProvider } from "../src/provider.js";
import { createTools } from "../src/tools.js";
import { createHookRegistry } from "../src/hooks.js";
import { createToolHookRuntime } from "../src/tool-hook-runtime.js";
import {
  createNativeLifecycleAttachment,
  createNativeLifecycleConsumer,
} from "../src/native-lifecycle-hooks.js";
import {
  planNativePromptSnapshot,
  type NativePromptFact,
} from "../src/native-prompt-snapshot.js";
import { createNativeContextClassifiers } from "../src/native-context-classifiers.js";
import {
  captureNativeToolHookResult,
  type NativeHookCaptureFacts,
} from "../src/native-attachment-capture.js";
import {
  recordNativeJsonResponse,
  snapshotNativeResponseJson,
} from "../src/native-response-recording.js";
import {
  isNativeObject,
  type NativeObject,
  type NativeSourceRow,
} from "../src/native-session-codec.js";
import type { NativeJournalRequestOptions } from "../src/native-session-journal.js";
import type { Message, ToolUse } from "../src/types.js";
import { fixtureSse } from "./sse-fixture.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const call: ToolUse = {
  type: "tool_use",
  id: "actual-read",
  name: "Read",
  input: { file_path: "actual.txt" },
};
const profile = (): NativeJournalRequestOptions<NativeSourceRow> => ({
  requestedModel: MODEL,
  recovery: {
    callIdToolResults: true,
    descendantOrder: "depth-first",
    timestampFallback: "reject",
  },
  host: {
    systemTurns: false,
    reminderFold: false,
    withoutAttachmentHooks: true,
    admit: () => true,
  },
  classifiers: createNativeContextClassifiers({
    systemTurns: false,
    pollEventsEnabled: false,
  }),
  echoApiBlockOrder: false,
  preserveTrailingThinking: false,
  signal: signal(),
});
async function fixture(
  failAssistant = false,
  gate?: (rows: readonly NativeObject[]) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-fileless-journal-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "actual.txt"), "ACTUAL_FILE_CONTENT\n");
  const identities = new Set<string>();
  let serial = 0;
  const journal = await NativeMemoryJournal.open(
    { sessionId: SID },
    {
      stamp: () => {
        const uuid = `00000000-1111-1111-1111-${String(++serial).padStart(12, "0")}`;
        identities.add(uuid);
        return { uuid, timestamp: "2026-11-18T00:00:00Z" };
      },
      admission: {
        admitProducer: ({ sessionId, producer }) =>
          sessionId === SID &&
          producer.name === "actual-finalized-native-consumers",
        admitRetention: async ({ rows }) => {
          assert.ok(Object.isFrozen(rows));
          for (const row of rows) {
            assert.ok(identities.has(row.uuid));
            assert.equal(Object.hasOwn(row, "parentUuid"), false);
            assert.equal(Object.hasOwn(row, "sessionId"), false);
          }
          await gate?.(rows);
          return !(
            failAssistant && rows.some((row) => row.type === "assistant")
          );
        },
      },
    },
    signal(),
  );
  onTestFinished(() => journal.close(signal()).catch(() => {}));
  const requests: NativeObject[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += String(part);
      const parsed = snapshotNativeResponseJson(JSON.parse(body));
      assert.ok(isNativeObject(parsed));
      requests.push(parsed);
      const n = requests.length,
        blocks =
          n === 1
            ? [{ type: "text", text: "ACTUAL_READING" }, call]
            : [{ type: "text", text: `ACTUAL_ANSWER_${n}` }];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `actual-request-${n}`,
      });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `actual-api-${n}`,
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
              sdk_extra: { exact: n },
            },
          },
          ...blocks.flatMap((block, index) => [
            { type: "content_block_start", index, content_block: block },
            { type: "content_block_stop", index },
          ]),
          {
            type: "message_delta",
            delta: {
              stop_reason: n === 1 ? "tool_use" : "end_turn",
              resumable: true,
              stop_details: { source: n },
            },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]),
      );
    })().catch((error) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({
    apiKey: "owned-dummy",
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
    allowNonStreamingFallback: false,
  });
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "ACTUAL_USER" }] },
  ];
  const user = messages[0];
  assert.ok(user);
  await journal.recordUser(user, "ACTUAL_PROMPT_ID", signal());
  const registry = createHookRegistry([
    {
      source: "owned-memory-Read-hooks",
      hooks: Object.fromEntries(
        ["PreToolUse", "PostToolUse"].map((event) => [
          event,
          [
            {
              hooks: [
                {
                  type: "command",
                  command: process.execPath,
                  args: [
                    "-e",
                    "process.stdout.write(process.argv[1])",
                    JSON.stringify({
                      hookSpecificOutput: {
                        hookEventName: event,
                        additionalContext: `ACTUAL_${event}_CONTEXT`,
                      },
                    }),
                  ],
                },
              ],
            },
          ],
        ]),
      ),
    },
  ]);
  onTestFinished(() => registry.close());
  const tools = createTools({
    cwd: root,
    mode: "default",
    policy: { tools: ["Read"], allowedTools: [], disallowedTools: [] },
    approve: async () => false,
    hooks: createToolHookRuntime({
      registry,
      context: () => ({
        session_id: SID,
        cwd: root,
        transcript_path: join(root, "source-computed-but-unwritten.jsonl"),
      }),
      runOptions: () => ({
        cwd: root,
        projectDir: root,
        env: {},
        defaultTimeoutMs: 3000,
      }),
      nativeCapture: journal.attachmentHost(signal()),
    }),
    onTextReadResult: async (facts) => {
      assert.equal(facts.permissionTrace.branch, "readonly");
      assert.equal(facts.nativeCompatibility.status, "supported");
      await journal.recordToolResult(
        { result: facts.coreResult, toolUseResult: facts.rawResult },
        signal(),
      );
    },
  });
  const run = (stopHooks?: NativeAgentStopHooks<NativeMemoryJournalView>) =>
    runAgent({
      provider,
      tools,
      messages,
      model: MODEL,
      system: "ACTUAL_SYSTEM",
      maxTokens: 100,
      maxTurns: 5,
      autoCompact: false,
      signal: signal(),
      onEvent: () => {},
      nativeJournal: {
        journal,
        requestProfile: profile,
        admitToolCall: (tool) => tool.name === "Read",
        ...(stopHooks ? { stopHooks } : {}),
      },
    });
  const response = (text: string, tool?: ToolUse) => {
    const blocks = tool ? [tool] : [{ type: "text", text }];
    return journal.recordResponse(
      recordNativeJsonResponse(
        { requestedModel: MODEL, host: journal.responseHost },
        {
          id: `actual-direct-${serial}`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: blocks,
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        blocks,
      ),
      signal(),
    );
  };
  return { root, journal, requests, run, messages, response };
}

test("fileless agent owns real HTTP -> Read Pre/core/Post -> Stop retry, then a real new query replays retained diagnostics", async () => {
  const f = await fixture();
  const planned = planNativePromptSnapshot(
    {
      history: (await f.journal.readCommitted(signal())).state.entries.map(
        (e) => e.row,
      ),
      enabled: known(true),
      replayEnabled: known(true),
      bareFork: false,
      querySource: "sdk",
      systemPrompt: ["ACTUAL_SYSTEM"],
      resumeActive: false,
      model: MODEL,
      contextRendering: known("announced"),
    },
    {
      stamp: () => f.journal.stampAttachment(),
      owedPrompt: () => known(undefined),
      reminderFold: () => known(false),
      echoWireToolInputs: () => known(false),
      modelEffortAfterText: () => known(false),
      toolSchemaProvenance: () => known("actual-request-wire-entry"),
      noteCopied: () => {},
      noteRendered: () => {},
      redescribing: () => known(undefined),
      noteRedescribed: () => {},
    },
  );
  assert.equal(planned.status, "resolved");
  if (planned.status !== "resolved") assert.fail();
  assert.ok(planned.plan.creation);
  await f.journal.capturePromptSnapshot(planned.plan.creation, signal());
  let stops = 0;
  const stopHooks: NativeAgentStopHooks<NativeMemoryJournalView> = {
    blockCap: known(undefined),
    run: async (input) => {
      assert.equal(input.kind, "ephemeral");
      assert.equal(Object.hasOwn(input, "document"), false);
      const host = f.journal.lifecycleHost(input.signal),
        dispatch = `ACTUAL_STOP_${++stops}`;
      const consumer = createNativeLifecycleConsumer(
        { event: "Stop", dispatchToolUseID: dispatch, phase: "ordinary" },
        host,
      );
      const cause = {
        event: "Stop" as const,
        dispatchToolUseID: dispatch,
        branch: "actual-memory-Stop-consumer",
      };
      if (stops === 1) {
        const creation = createNativeLifecycleAttachment(
          host,
          {
            type: "hook_blocking_error",
            hookName: "Stop",
            hookEvent: "Stop",
            toolUseID: dispatch,
            blockingError: {
              blockingError: "ACTUAL_BLOCK_REASON",
              command: "owned-hook",
            },
          },
          cause,
        );
        await consumer.consume({
          kind: "blocking",
          text: "ACTUAL_BLOCK_REASON",
          command: "owned-hook",
          cause,
        });
        await consumer.consume({
          kind: "message",
          creation,
          retainForStop: false,
        });
      } else {
        const creation = createNativeLifecycleAttachment(
          host,
          {
            type: "hook_success",
            hookName: "Stop",
            hookEvent: "Stop",
            toolUseID: dispatch,
            content: "",
            stdout: "",
            stderr: "",
          },
          cause,
        );
        await consumer.consume({
          kind: "message",
          creation,
          retainForStop: false,
        });
      }
      return consumer.finish({ kind: "completed" });
    },
    reactions: async (input) =>
      createNativeLifecycleConsumer(
        {
          event: "Stop",
          dispatchToolUseID: "ACTUAL_REACTIONS",
          phase: "turn-end-reactions",
        },
        f.journal.lifecycleHost(input.signal),
      ).finish({ kind: "completed" }),
  };
  const result = await f.run(stopHooks);
  assert.equal(result.turns, 3);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(result.nativeTermination, { reason: "completed" });
  const retry = JSON.stringify(f.requests[2]?.messages);
  for (const marker of [
    "ACTUAL_PreToolUse_CONTEXT",
    "ACTUAL_FILE_CONTENT",
    "ACTUAL_PostToolUse_CONTEXT",
    "ACTUAL_BLOCK_REASON",
  ])
    assert.equal(retry.split(marker).length - 1, 1);
  assert.doesNotMatch(retry, /hook blocking error from command/);
  const view = await f.journal.readCommitted(signal()),
    entries = view.state.entries;
  assert.ok(
    entries.some(
      (e) =>
        isNativeObject(e.row.attachment) &&
        e.row.attachment.type === "hook_success",
    ),
  );
  const tool = entries.find((e) => isNativeObject(e.row.toolUseResult));
  assert.ok(tool);
  const source = entries.find(
    (e) => e.row.type === "assistant" && e.row.apiBlockIndex === 1,
  );
  assert.ok(source);
  const post = entries.find(
    (e) =>
      isNativeObject(e.row.attachment) &&
      e.row.attachment.hookEvent === "PostToolUse",
  );
  assert.ok(post);
  assert.ok(post.sequence > tool.sequence);
  assert.ok(post.row.uuid < tool.row.uuid);
  assert.equal(tool.row.sourceToolAssistantUUID, source.row.uuid);
  assert.ok(isNativeObject(source.row.message));
  assert.deepEqual(source.row.message.sdk_extra, { exact: 1 });
  assert.equal(source.row.message.stop_reason, "tool_use");
  assert.equal(source.row.requestId, "actual-request-1");
  for (const entry of entries)
    for (const field of [
      "parentUuid",
      "isSidechain",
      "sessionId",
      "version",
      "cwd",
    ])
      assert.equal(Object.hasOwn(entry.row, field), false);
  const next: Message = {
    role: "user",
    content: [{ type: "text", text: "ACTUAL_LATER_USER" }],
  };
  f.messages.push(next);
  await f.journal.recordUser(next, "ACTUAL_NEXT_PROMPT", signal());
  await f.run(stopHooks);
  assert.match(
    JSON.stringify(f.requests[3]?.messages),
    /hook blocking error from command/,
  );
  assert.match(JSON.stringify(f.requests[3]?.messages), /ACTUAL_LATER_USER/);
  assert.ok(
    f.requests.every((r) => !JSON.stringify(r.messages).includes('"uuid"')),
  );
  await f.journal.close(signal());
  assert.deepEqual(await readdir(f.root), ["actual.txt"]);
});

test("raw request context carries source rows without file positions, envelopes or ancestry", async () => {
  const f = await fixture();
  const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
  const projected = await f.journal.projectRequest({
    ...profile(),
    frame,
    host: (nodes) => {
      assert.ok(Object.isFrozen(nodes));
      for (const node of nodes) {
        assert.equal(Object.hasOwn(node, "parentUuid"), false);
        assert.equal(Object.hasOwn(node, "line"), false);
        assert.ok(Object.isFrozen(node.row));
      }
      return {
        systemTurns: false,
        reminderFold: false,
        withoutAttachmentHooks: true,
        admit: () => true,
      };
    },
  });
  for (const key of [
    "originalDocument",
    "documentForProjection",
    "parentRewrites",
  ])
    assert.equal(Object.hasOwn(projected.projection, key), false);
  assert.equal(projected.kind, "ephemeral");
  assert.match(JSON.stringify(projected.projection.messages), /ACTUAL_USER/);
  f.journal.endQueryFrame(frame);
  await f.journal.close(signal());
  assert.deepEqual(await readdir(f.root), ["actual.txt"]);
});

test("actual response retention rejection stops the agent before Read or another HTTP request", async () => {
  const f = await fixture(true);
  await assert.rejects(f.run(), /Native retained journal failed/);
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.journal.flush(signal()));
  await assert.rejects(f.journal.close(signal()));
  assert.deepEqual(await readdir(f.root), ["actual.txt"]);
});

for (const failure of [
  "foreign",
  "stale",
  "retired",
  "pending",
  "cancelled",
  "duplicate-result",
  "unsettled-Post",
] as const) {
  test(`fileless journal rejects ${failure} ownership without transcript state`, async () => {
    const f = await fixture();
    const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
    if (failure === "foreign")
      await assert.rejects(
        f.journal.projectRequest({ ...profile(), frame: { revision: 0 } }),
        /query owner/,
      );
    else if (failure === "stale") {
      const revision = frame.revision;
      await f.response("ACTUAL_RESPONSE");
      await assert.rejects(
        f.journal.projectRequest({
          ...profile(),
          frame,
          frameRevision: revision,
        }),
        /revision/,
      );
    } else if (failure === "retired") {
      f.journal.endQueryFrame(frame);
      await assert.rejects(
        f.journal.projectRequest({ ...profile(), frame }),
        /query owner/,
      );
    } else if (failure === "pending") {
      await f.journal.beginLifecycleTransition(frame, signal());
      await assert.rejects(
        f.journal.projectRequest({ ...profile(), frame }),
        /has not committed/,
      );
    } else if (failure === "cancelled") {
      const controller = new AbortController(),
        reason = new Error("ACTUAL_ABORT");
      controller.abort(reason);
      await assert.rejects(
        f.journal.projectRequest({
          ...profile(),
          frame,
          signal: controller.signal,
        }),
        (error: unknown) => error instanceof Error && error.cause === reason,
      );
    } else {
      await f.response("", call);
      if (failure === "duplicate-result") {
        await f.journal.recordToolResult(
          {
            result: {
              type: "tool_result",
              tool_use_id: call.id,
              content: "ACTUAL_RESULT",
            },
          },
          signal(),
        );
        await assert.rejects(
          f.journal.recordToolResult(
            {
              result: {
                type: "tool_result",
                tool_use_id: call.id,
                content: "FORGED_DUPLICATE",
              },
            },
            signal(),
          ),
          /unique actual assistant owner/,
        );
      } else {
        const facts: NativeHookCaptureFacts = {
          source: "tool-hook",
          phase: "post",
          event: "PostToolUse",
          toolName: call.name,
          toolUseID: call.id,
          toolInput: call.input,
          execution: "sync",
          transport: "command",
          commandHook: { type: "command", command: "ACTUAL_POST" },
          outcome: {
            id: "ACTUAL_POST",
            event: "PostToolUse",
            origin: { source: "owned" },
            command: "ACTUAL_POST",
            status: "success",
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
            additionalContext: "ACTUAL_POST",
          },
        };
        await captureNativeToolHookResult(
          f.journal.attachmentHost(signal()),
          facts,
          { kind: "tool-hook", phase: "post", call },
        );
        await assert.rejects(
          f.journal.projectRequest({ ...profile(), frame }),
          /await their actual core result/,
        );
      }
    }
    if (failure !== "retired") f.journal.endQueryFrame(frame);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await readdir(f.root), ["actual.txt"]);
  });
}

test("closing drains an admitted immutable retention batch and rejects late callbacks without poisoning that close", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const f = await fixture(false, async (rows) => {
    if (JSON.stringify(rows).includes("ACTUAL_QUEUED")) {
      entered.resolve();
      await resume.promise;
    }
  });
  const input: Message = {
    role: "user",
    content: [{ type: "text", text: "ACTUAL_QUEUED" }],
  };
  const accepted = f.journal.recordUser(
    input,
    "ACTUAL_QUEUED_PROMPT",
    signal(),
  );
  await entered.promise;
  input.content = [{ type: "text", text: "FORGED_AFTER_CAPTURE" }];
  const closing = f.journal.close(signal());
  await assert.rejects(
    f.journal.recordUser(
      { role: "user", content: [] },
      "ACTUAL_LATE",
      signal(),
    ),
    /closing/,
  );
  resume.resolve();
  await accepted;
  await closing;
  await assert.rejects(f.journal.readCommitted(signal()), /closing/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await readdir(f.root), ["actual.txt"]);
});

for (const kind of [
  "duplicate-continuation",
  "unowned",
  "captured-decision",
] as const) {
  test(`fileless Stop transition enforces ${kind} producer ownership`, async () => {
    const f = await fixture(),
      frame = await f.journal.beginQueryFrame(profile().recovery, signal());
    await f.response("ACTUAL_FINAL");
    await f.journal.beginLifecycleTransition(frame, signal());
    const host = f.journal.lifecycleHost(signal());
    const consumer = createNativeLifecycleConsumer(
      { event: "Stop", dispatchToolUseID: "ACTUAL_STOP", phase: "ordinary" },
      kind === "unowned" ? { ...host, capture: () => {} } : host,
    );
    await consumer.consume({ kind: "progress", toolUseID: "ACTUAL_STOP" });
    await consumer.consume({
      kind: "context",
      content: ["ACTUAL_OWNED_CONTEXT"],
      retainForStop: true,
      cause: {
        event: "Stop",
        dispatchToolUseID: "ACTUAL_STOP",
        branch: "actual-context",
      },
    });
    const actual = await consumer.finish({ kind: "completed" });
    if (kind === "duplicate-continuation")
      await assert.rejects(
        f.journal.commitLifecycleTransition(
          frame,
          {
            ...actual,
            continuationEvents: [
              ...actual.continuationEvents,
              ...actual.continuationEvents,
            ],
          },
          signal(),
        ),
        /unique actual retained producer/,
      );
    else if (kind === "unowned")
      await assert.rejects(
        f.journal.commitLifecycleTransition(frame, actual, signal()),
        /unowned creation/,
      );
    else {
      const mutable = structuredClone(actual),
        pending = f.journal.commitLifecycleTransition(frame, mutable, signal());
      mutable.continuationEvents = [];
      await pending;
      const request = await f.journal.projectRequest({ ...profile(), frame });
      assert.match(
        JSON.stringify(request.projection.messages),
        /ACTUAL_OWNED_CONTEXT/,
      );
    }
    f.journal.endQueryFrame(frame);
    assert.equal(f.requests.length, 0);
  });
}
