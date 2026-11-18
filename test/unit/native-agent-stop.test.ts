import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { runAgent, type NativeAgentStopHooks } from "../../src/agent.js";
import { AnthropicProvider } from "../../src/provider.js";
import { NativeSessionLifetime } from "../../src/native-session-lifetime.js";
import {
  createNativeLifecycleConsumer,
  createNativeLifecycleAttachment,
} from "../../src/native-lifecycle-hooks.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";
import {
  decodeNativeSession,
  isNativeObject,
  type NativeObject,
} from "../../src/native-session-codec.js";
import type { NativeJournalRequestOptions } from "../../src/native-session-journal.js";
import type { Message } from "../../src/types.js";
import { fixtureSse } from "../helpers/sse-fixture.js";
import { captureNativePersistenceJson } from "../../src/native-persistence-events.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import { createHookRegistry } from "../../src/hooks.js";
import { createToolHookRuntime } from "../../src/tool-hook-runtime.js";
import { createTools } from "../../src/tools.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const profile = (): NativeJournalRequestOptions => ({
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
async function fixture(readFirst = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-agent-stop-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `${SID}.jsonl`),
    requests: NativeObject[] = [];
  let stamps = 0;
  const lifetime = await NativeSessionLifetime.open(
    {
      ownership: { directory: root, path, admit: () => true },
      persistence: {
        context: {
          sessionId: SID,
          cwd: root,
          version: "2.1.326",
          userType: "external",
          sidechain: false,
        },
        admit: () => true,
      },
      initial: { kind: "fresh" },
      host: {
        stamp: () => ({
          uuid: `00000000-1111-1111-1111-${String(++stamps).padStart(12, "0")}`,
          timestamp: "2026-11-18T00:00:00Z",
        }),
        persistence: {
          freshHead: {
            status: "known",
            value: "ordinary-unchanged-owner-without-attachment-rewrites",
          },
          select: ({ history }) => ({
            facts: {
              userType: { status: "known", value: "external" },
              evalFeature: { status: "known", value: false },
              sessionCodeMode: { status: "known", value: false },
              toolResults: { kind: "derive", context: history },
            },
            host: { original: () => ({ status: "known", value: undefined }) },
          }),
        },
      },
    },
    signal(),
  );
  onTestFinished(() => lifetime.close(signal()).catch(() => {}));
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += String(part);
      const parsed = captureNativePersistenceJson(JSON.parse(body));
      assert.ok(isNativeObject(parsed));
      requests.push(parsed);
      const reading = readFirst && requests.length === 1;
      const content = reading
        ? {
            type: "tool_use",
            id: "actual-read",
            name: "Read",
            input: { file_path: "actual.txt" },
          }
        : { type: "text", text: `ACTUAL_ANSWER_${requests.length}` };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `actual-request-${requests.length}`,
      });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `actual-api-${requests.length}`,
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: content },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: reading ? "tool_use" : "end_turn" },
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
  // Startup is genuinely created before the first human; its selected bytes wait for that owner.
  const startup = createNativeLifecycleConsumer(
    {
      event: "SessionStart",
      dispatchToolUseID: "ACTUAL_START",
      phase: "ordinary",
      start: { source: "startup", newPluginsOnly: false },
    },
    lifetime.journal.lifecycleHost(signal()),
  );
  await startup.consume({
    kind: "context",
    content: ["ACTUAL_START_CONTEXT"],
    retainForStop: false,
    cause: {
      event: "SessionStart",
      dispatchToolUseID: "ACTUAL_START",
      branch: "actual-start-yield",
    },
  });
  await startup.finish({ kind: "completed" });
  const firstMessage = messages[0];
  assert.ok(firstMessage);
  await lifetime.journal.recordUser(firstMessage, "ACTUAL_PROMPT_ID", signal());
  const noTools = {
    definitions: [],
    execute: async () => assert.fail("No tool is available"),
  };
  let tools: ReturnType<typeof createTools> = noTools;
  if (readFirst) {
    await writeFile(join(root, "actual.txt"), "ACTUAL_OWNED_FILE_BYTES\n");
    const command = (event: "PreToolUse" | "PostToolUse") => ({
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
    });
    const registry = createHookRegistry([
      {
        source: "actual-owned-Read-hooks",
        hooks: {
          PreToolUse: [{ hooks: [command("PreToolUse")] }],
          PostToolUse: [{ hooks: [command("PostToolUse")] }],
        },
      },
    ]);
    onTestFinished(() => registry.close());
    tools = createTools({
      cwd: root,
      mode: "default",
      policy: { tools: ["Read"], allowedTools: [], disallowedTools: [] },
      approve: async () => false,
      hooks: createToolHookRuntime({
        registry,
        context: () => ({ session_id: SID, cwd: root, transcript_path: path }),
        runOptions: () => ({
          cwd: root,
          projectDir: root,
          env: {},
          defaultTimeoutMs: 3000,
        }),
        nativeCapture: lifetime.journal.attachmentHost(signal()),
      }),
      onTextReadResult: async (facts) => {
        assert.equal(facts.nativeCompatibility.status, "supported");
        assert.equal(facts.permissionTrace.branch, "readonly");
        await lifetime.journal.recordToolResult(
          { result: facts.coreResult, toolUseResult: facts.rawResult },
          signal(),
        );
      },
    });
  }
  const run = (stopHooks: NativeAgentStopHooks, maxTurns = 5) =>
    runAgent({
      provider,
      messages,
      model: MODEL,
      system: "ACTUAL_SYSTEM",
      maxTokens: 100,
      maxTurns,
      autoCompact: false,
      tools,
      signal: signal(),
      onEvent: () => {},
      nativeJournal: {
        journal: lifetime.journal,
        requestProfile: profile,
        admitToolCall: (call) => readFirst && call.name === "Read",
        stopHooks,
      },
    });
  const rows = async () =>
    decodeNativeSession(await readFile(path), {
      parser: "source-line-fallback",
    }).lines.flatMap((line) =>
      isNativeObject(line.value) ? [line.value] : [],
    );
  const imported = () =>
    importNativeSessionFile({
      path,
      cwd: root,
      model: MODEL,
      signal: signal(),
      env: {},
    });
  return { root, path, lifetime, requests, messages, run, rows, imported };
}
function hooks(
  f: Awaited<ReturnType<typeof fixture>>,
  behavior: "once" | "always" | "prevent" | "unowned",
  cap?: number,
) {
  const flags: boolean[] = [],
    reactions: string[] = [];
  let count = 0;
  const stopHooks: NativeAgentStopHooks = {
    blockCap: { status: "known", value: cap },
    run: async (context) => {
      count++;
      flags.push(context.stopHookActive);
      assert.match(
        JSON.stringify(context.document.lines),
        new RegExp(`ACTUAL_ANSWER_${count}`),
      );
      const dispatchToolUseID = `ACTUAL_STOP_${count}`;
      const host = f.lifetime.journal.lifecycleHost(context.signal);
      const consumer = createNativeLifecycleConsumer(
        { event: "Stop", dispatchToolUseID, phase: "ordinary" },
        behavior === "unowned" ? { ...host, capture: () => {} } : host,
      );
      await consumer.consume({
        kind: "progress",
        toolUseID: dispatchToolUseID,
      });
      const cause = {
        event: "Stop" as const,
        dispatchToolUseID,
        branch: "actual-stop-yield",
      };
      if (behavior !== "once" || count === 1)
        await consumer.consume({
          kind: "context",
          content: [`ACTUAL_STOP_CONTEXT_${count}`],
          cause,
          retainForStop: true,
        });
      if (behavior === "prevent")
        await consumer.consume({
          kind: "prevent",
          reason: "ACTUAL_PREVENT",
          cause,
        });
      if (behavior === "once" && count > 1) {
        const creation = createNativeLifecycleAttachment(
          host,
          {
            type: "hook_success",
            hookName: "Stop",
            hookEvent: "Stop",
            toolUseID: dispatchToolUseID,
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
    reactions: async (context) => {
      reactions.push(context.reason);
      return createNativeLifecycleConsumer(
        {
          event: "Stop",
          dispatchToolUseID: `ACTUAL_REACTION_${count}`,
          phase: "turn-end-reactions",
        },
        f.lifetime.journal.lifecycleHost(context.signal),
      ).finish({ kind: "completed" });
    },
  };
  return { stopHooks, flags, reactions };
}

test("actual agent continues from committed Stop context once with no synthetic feedback or duplicated startup", async () => {
  const f = await fixture(),
    h = hooks(f, "once"),
    result = await f.run(h.stopHooks);
  assert.equal(result.turns, 2);
  assert.deepEqual(result.nativeTermination, { reason: "completed" });
  assert.deepEqual(h.flags, [false, true]);
  assert.deepEqual(h.reactions, ["completed"]);
  assert.equal(f.requests.length, 2);
  const wire = JSON.stringify(f.requests[1]?.messages);
  assert.equal(wire.split("ACTUAL_STOP_CONTEXT_1").length - 1, 1);
  assert.equal(wire.split("ACTUAL_START_CONTEXT").length - 1, 1);
  assert.doesNotMatch(wire, /A Stop hook requested additional work/);
  assert.equal(
    f.messages.filter((message) => message.role === "user").length,
    1,
  );
  const stored = await f.rows();
  assert.equal(
    stored.filter(
      (row) =>
        isNativeObject(row.attachment) &&
        row.attachment.type === "hook_success",
    ).length,
    0,
  );
  const saved = await f.lifetime.save(signal());
  assert.ok(saved.cursorUuid);
  await f.lifetime.close(signal());
});

test("actual prevent keeps already-produced rows and runs terminal reactions without another request", async () => {
  const f = await fixture(),
    h = hooks(f, "prevent"),
    result = await f.run(h.stopHooks);
  assert.deepEqual(result.nativeTermination, { reason: "stop_hook_prevented" });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(h.reactions, ["stop_hook_prevented"]);
  const stored = JSON.stringify(await f.rows());
  assert.match(stored, /ACTUAL_STOP_CONTEXT_1/);
  assert.match(stored, /hook_stopped_continuation/);
  const restored = await f.imported();
  assert.match(JSON.stringify(restored.session.messages), /ACTUAL_ANSWER_1/);
  assert.match(JSON.stringify(restored.session.messages), /ACTUAL_PREVENT/);
});

test("native maxTurns retains the actual limit attachment and stops before an extra provider request", async () => {
  const f = await fixture(),
    h = hooks(f, "always"),
    result = await f.run(h.stopHooks, 1);
  assert.deepEqual(result.nativeTermination, {
    reason: "max_turns",
    turnCount: 2,
  });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(h.reactions, ["max_turns"]);
  const attachment = (await f.rows()).find(
    (row) =>
      isNativeObject(row.attachment) &&
      row.attachment.type === "max_turns_reached",
  )?.attachment;
  assert.deepEqual(attachment, {
    type: "max_turns_reached",
    maxTurns: 1,
    turnCount: 2,
  });
  assert.match(
    JSON.stringify((await f.imported()).session.messages),
    /ACTUAL_ANSWER_1/,
  );
});

test("native consecutive cap records the real informational warning and completes with terminal reactions", async () => {
  const f = await fixture(),
    h = hooks(f, "always", 1),
    result = await f.run(h.stopHooks);
  assert.deepEqual(result.nativeTermination, { reason: "completed" });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(h.flags, [false, true]);
  assert.deepEqual(h.reactions, ["completed"]);
  const warning = (await f.rows()).find((row) => row.type === "system");
  assert.equal(warning?.subtype, "informational");
  assert.equal(warning?.level, "warning");
  assert.equal(typeof warning?.content, "string");
  assert.match(
    typeof warning?.content === "string" ? warning.content : "",
    /2 consecutive times/,
  );
  const restored = await f.imported();
  assert.match(JSON.stringify(restored.session.messages), /ACTUAL_ANSWER_2/);
  assert.doesNotMatch(
    JSON.stringify(restored.session.messages),
    /2 consecutive times/,
  );
});

test("unowned continuation rows fail before any second request and cannot be reported as saved", async () => {
  const f = await fixture(),
    h = hooks(f, "unowned");
  await assert.rejects(f.run(h.stopHooks), /unowned creation/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(h.reactions, []);
  await assert.rejects(f.lifetime.save(signal()));
  await assert.rejects(f.lifetime.close(signal()));
});

for (const retainDiagnostic of [false, true]) {
  test(`owned Stop query frame uses actual diagnostic retention=${retainDiagnostic}, then resets for a genuine new query`, async () => {
    const f = await fixture(),
      h = hooks(f, "once");
    let iteration = 0;
    const active: boolean[] = [];
    h.stopHooks.run = async (input) => {
      iteration++;
      active.push(input.stopHookActive);
      const host = f.lifetime.journal.lifecycleHost(input.signal);
      const dispatch = `ACTUAL_BLOCK_${iteration}`;
      const consumer = createNativeLifecycleConsumer(
        { event: "Stop", dispatchToolUseID: dispatch, phase: "ordinary" },
        host,
      );
      if (iteration > 2) return consumer.finish({ kind: "completed" });
      const cause = {
        event: "Stop" as const,
        dispatchToolUseID: dispatch,
        branch: "actual-blocking-outcome",
      };
      const creation = createNativeLifecycleAttachment(
        host,
        {
          type: "hook_blocking_error",
          hookName: "Stop",
          hookEvent: "Stop",
          toolUseID: dispatch,
          blockingError: {
            blockingError: `ACTUAL_BLOCKING_TEXT_${iteration}`,
            command: "actual-owned-hook",
          },
        },
        cause,
      );
      await consumer.consume({ kind: "progress", toolUseID: dispatch });
      await consumer.consume({
        kind: "blocking",
        text: `ACTUAL_BLOCKING_TEXT_${iteration}`,
        command: "actual-owned-hook",
        cause,
      });
      await consumer.consume({
        kind: "message",
        creation,
        retainForStop: retainDiagnostic,
      });
      return consumer.finish({ kind: "completed" });
    };
    const result = await f.run(h.stopHooks);
    assert.equal(result.turns, 3);
    assert.deepEqual(active, [false, true, true]);
    assert.equal(f.requests.length, 3);
    const retry = JSON.stringify(f.requests[2]?.messages);
    for (const marker of ["ACTUAL_BLOCKING_TEXT_1", "ACTUAL_BLOCKING_TEXT_2"])
      assert.equal(retry.split(marker).length - 1, retainDiagnostic ? 2 : 1);
    assert.equal(
      retry.includes("hook blocking error from command"),
      retainDiagnostic,
    );
    assert.doesNotMatch(retry, /A Stop hook requested additional work/);
    const prefix = await readFile(f.path);
    const stored = await f.rows();
    assert.equal(stored.filter((row) => row.isMeta === true).length, 2);
    assert.equal(
      stored.filter(
        (row) =>
          isNativeObject(row.attachment) &&
          row.attachment.type === "hook_blocking_error",
      ).length,
      2,
    );
    const cold = await f.imported();
    assert.match(
      JSON.stringify(cold.session.messages),
      /hook blocking error from command/,
    );
    const later: Message = {
      role: "user",
      content: [{ type: "text", text: "ACTUAL_LATER_HUMAN" }],
    };
    f.messages.push(later);
    await f.lifetime.journal.recordUser(
      later,
      "ACTUAL_LATER_PROMPT_ID",
      signal(),
    );
    await f.run(h.stopHooks);
    const freshQuery = JSON.stringify(f.requests[3]?.messages);
    assert.match(freshQuery, /hook blocking error from command/);
    assert.match(freshQuery, /ACTUAL_LATER_HUMAN/);
    assert.deepEqual(
      (await readFile(f.path)).subarray(0, prefix.length),
      prefix,
    );
    await f.lifetime.close(signal());
  });
}

test("Read Pre/core/Post context survives a later Stop retry without replaying its record-only diagnostic", async () => {
  const f = await fixture(true),
    h = hooks(f, "once");
  let stops = 0;
  h.stopHooks.run = async (input) => {
    const host = f.lifetime.journal.lifecycleHost(input.signal);
    const consumer = createNativeLifecycleConsumer(
      {
        event: "Stop",
        dispatchToolUseID: "ACTUAL_READ_STOP",
        phase: "ordinary",
      },
      host,
    );
    if (++stops > 1) return consumer.finish({ kind: "completed" });
    const cause = {
      event: "Stop" as const,
      dispatchToolUseID: "ACTUAL_READ_STOP",
      branch: "actual-read-terminal-block",
    };
    const creation = createNativeLifecycleAttachment(
      host,
      {
        type: "hook_blocking_error",
        hookName: "Stop",
        hookEvent: "Stop",
        toolUseID: "ACTUAL_READ_STOP",
        blockingError: {
          blockingError: "ACTUAL_READ_STOP_REASON",
          command: "owned-hook",
        },
      },
      cause,
    );
    await consumer.consume({
      kind: "blocking",
      text: "ACTUAL_READ_STOP_REASON",
      command: "owned-hook",
      cause,
    });
    await consumer.consume({ kind: "message", creation, retainForStop: false });
    return consumer.finish({ kind: "completed" });
  };
  const result = await f.run(h.stopHooks);
  assert.equal(result.turns, 3);
  assert.equal(f.requests.length, 3);
  const second = JSON.stringify(f.requests[1]?.messages),
    retry = JSON.stringify(f.requests[2]?.messages);
  for (const marker of [
    "ACTUAL_PreToolUse_CONTEXT",
    "ACTUAL_OWNED_FILE_BYTES",
    "ACTUAL_PostToolUse_CONTEXT",
  ])
    assert.equal(retry.split(marker).length - 1, 1);
  assert.equal(retry.split("ACTUAL_READ_STOP_REASON").length - 1, 1);
  assert.doesNotMatch(retry, /hook blocking error from command/);
  assert.ok(
    retry.indexOf("ACTUAL_OWNED_FILE_BYTES") <
      retry.indexOf("ACTUAL_PostToolUse_CONTEXT"),
  );
  assert.ok(
    retry.indexOf("ACTUAL_PostToolUse_CONTEXT") <
      retry.indexOf("ACTUAL_READ_STOP_REASON"),
  );
  assert.ok(second.includes("ACTUAL_PreToolUse_CONTEXT"));
  const rows = await f.rows();
  const rawResult = rows.find((row) => isNativeObject(row.toolUseResult));
  assert.ok(rawResult);
  assert.match(
    JSON.stringify(rawResult.toolUseResult),
    /ACTUAL_OWNED_FILE_BYTES/,
  );
  assert.equal(
    rows.filter(
      (row) =>
        isNativeObject(row.attachment) &&
        row.attachment.type === "hook_blocking_error",
    ).length,
    1,
  );
  await f.lifetime.save(signal());
  await f.lifetime.close(signal());
  const restored = JSON.stringify((await f.imported()).session.messages);
  assert.match(restored, /hook blocking error from command/);
  assert.match(restored, /ACTUAL_OWNED_FILE_BYTES/);
});

test("tool turn-limit reactions acquire the terminal phase and retain their nonempty diagnostic without another request", async () => {
  const f = await fixture(true),
    h = hooks(f, "once");
  let stopCalls = 0,
    reactionCalls = 0;
  h.stopHooks.run = async () => {
    stopCalls++;
    assert.fail("Max-turn tool completion does not invoke ordinary Stop");
  };
  h.stopHooks.reactions = async (context) => {
    reactionCalls++;
    assert.equal(context.reason, "max_turns");
    const host = f.lifetime.journal.lifecycleHost(context.signal);
    const consumer = createNativeLifecycleConsumer(
      {
        event: "Stop",
        dispatchToolUseID: "ACTUAL_TOOL_MAX_REACTION",
        phase: "turn-end-reactions",
      },
      host,
    );
    const cause = {
      event: "Stop" as const,
      dispatchToolUseID: "ACTUAL_TOOL_MAX_REACTION",
      branch: "actual-terminal-reaction",
    };
    const creation = createNativeLifecycleAttachment(
      host,
      {
        type: "hook_non_blocking_error",
        hookName: "Stop",
        hookEvent: "Stop",
        toolUseID: "ACTUAL_TOOL_MAX_REACTION",
        stderr: "ACTUAL_TERMINAL_DIAGNOSTIC",
        stdout: "",
      },
      cause,
    );
    await consumer.consume({ kind: "message", creation, retainForStop: false });
    return consumer.finish({ kind: "completed" });
  };
  const result = await f.run(h.stopHooks, 1);
  assert.deepEqual(result.nativeTermination, {
    reason: "max_turns",
    turnCount: 2,
  });
  assert.equal(stopCalls, 0);
  assert.equal(reactionCalls, 1);
  assert.equal(f.requests.length, 1);
  const stored = JSON.stringify(await f.rows());
  assert.match(stored, /ACTUAL_TERMINAL_DIAGNOSTIC/);
  assert.match(stored, /max_turns_reached/);
  assert.match(stored, /ACTUAL_OWNED_FILE_BYTES/);
  await f.lifetime.save(signal());
  await f.lifetime.close(signal());
});
