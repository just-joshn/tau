import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeSessionJournal,
  NativeSessionJournalError,
  type NativeJournalRequestOptions,
} from "../../src/native-session-journal.js";
import {
  NativeStreamResponseRecording,
  recordNativeJsonResponse,
  snapshotNativeResponseJson,
} from "../../src/native-response-recording.js";
import {
  captureNativeToolHookResult,
  captureNativeCatalogAttachments,
  type NativeHookCaptureFacts,
} from "../../src/native-attachment-capture.js";
import {
  captureNativeInstructions,
  nativeInstructionFileFacts,
  type NativeInstructionPayloadFile,
} from "../../src/native-instruction-capture.js";
import { buildCatalogAttachments } from "../../src/catalog-projection.js";
import {
  decodeNativeSession,
  isNativeArray,
  isNativeObject,
} from "../../src/native-session-codec.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import type { NativeSessionPersistenceOptions } from "../../src/native-session-persistence.js";
import type { Message, ToolUse } from "../../src/types.js";
import { projectMessages } from "../../src/thinking-history.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";
import { runAgent } from "../../src/agent.js";
import { AnthropicProvider } from "../../src/provider.js";
import { createTools, TextReadCaptureError } from "../../src/tools.js";
import { createHookRegistry } from "../../src/hooks.js";
import { createToolHookRuntime } from "../../src/tool-hook-runtime.js";
import { fixtureSse } from "../helpers/sse-fixture.js";
import type { NativeObject } from "../../src/native-session-codec.js";
import { NativeSessionOwnership } from "../../src/native-session-ownership.js";
import { NativeSessionLifetime } from "../../src/native-session-lifetime.js";
import { copyNativeSessionToOwnedFile } from "../../src/native-session-copy.js";
import type { NativePreparedRequestHost } from "../../src/native-request-capture.js";
import type { NativePromptTransportHost } from "../../src/native-prompt-transport.js";
import {
  prepareNativePromptRequest,
  verifyNativePromptPreparedRequest,
  type NativePromptRequestPlan,
} from "../../src/native-prompt-request.js";
import { createNativeLifecycleConsumer } from "../../src/native-lifecycle-hooks.js";
import { createNativeAttachmentEvent } from "../../src/native-persistence-events.js";
import type { NativeSessionJournalHost } from "../../src/native-session-journal.js";
import {
  planNativePromptSnapshot,
  updateNativePromptSnapshotTools,
  type NativePromptSnapshotHost,
  type NativePromptFact,
  type NativePromptSnapshotTool,
} from "../../src/native-prompt-snapshot.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const prompt = (text = "OWNED_PROMPT"): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const requestProfile = (): NativeJournalRequestOptions => ({
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
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-journal-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `${SID}.jsonl`);
  let queue = Promise.resolve(),
    stamps = 0;
  const options: NativeSessionPersistenceOptions = {
    path,
    context: {
      sessionId: SID,
      cwd: root,
      version: "2.1.326",
      entrypoint: "cli",
      userType: "external",
      sidechain: false,
    },
    initial: { kind: "fresh" },
    admit: () => true,
    withExclusiveOwnership: async (_path, work) => {
      const previous = queue,
        next = Promise.withResolvers<void>();
      queue = next.promise;
      await previous;
      try {
        return await work();
      } finally {
        next.resolve();
      }
    },
  };
  const host = {
    stamp: () => ({
      uuid: `00000000-1111-1111-1111-${String(++stamps).padStart(12, "0")}`,
      timestamp: `2026-11-18T00:00:00.${String(stamps).padStart(3, "0")}Z`,
    }),
  };
  const open = (initial = options.initial) =>
    NativeSessionJournal.open({ ...options, initial }, host, signal());
  return { root, path, options, host, open, stamps: () => stamps };
}
const rows = (bytes: Uint8Array) =>
  decodeNativeSession(bytes, { parser: "source-line-fallback" }).lines.flatMap(
    (line) => (isNativeObject(line.value) ? [line.value] : []),
  );
const call: ToolUse = {
  type: "tool_use",
  id: "owned-read",
  name: "Read",
  input: { file_path: "note.txt" },
};

function selectedPersistence(
  f: Awaited<ReturnType<typeof fixture>>,
): NonNullable<NativeSessionJournalHost["persistence"]> {
  return {
    freshHead: {
      status: "known",
      value: "ordinary-unchanged-owner-without-attachment-rewrites",
    },
    select: ({ history }) => ({
      facts: {
        userType: { status: "known", value: f.options.context.userType },
        evalFeature: { status: "known", value: false },
        sessionCodeMode: { status: "known", value: false },
        toolResults: { kind: "derive", context: history },
      },
      host: { original: () => ({ status: "known", value: undefined }) },
    }),
  };
}

test("fresh journal selects actual startup rows before buffering and materializes the real first user after the last surviving parent", async () => {
  const f = await fixture(),
    host = { ...f.host, persistence: selectedPersistence(f) };
  const journal = await NativeSessionJournal.open(f.options, host, signal());
  const sink = journal.lifecycleHost(signal());
  const cause = {
    event: "SessionStart" as const,
    dispatchToolUseID: "ACTUAL_START",
    branch: "actual-startup-message",
  };
  const empty = createNativeAttachmentEvent(
    {
      type: "hook_success",
      hookName: "SessionStart:startup",
      hookEvent: "SessionStart",
      toolUseID: "ACTUAL_START",
      content: "",
      stdout: "",
      stderr: "",
    },
    sink.stamp({ kind: "attachment", payload: {}, cause }),
  );
  await sink.capture({ cause, event: empty });
  const diagnostic = createNativeAttachmentEvent(
    {
      type: "hook_non_blocking_error",
      hookName: "SessionStart:startup",
      hookEvent: "SessionStart",
      toolUseID: "ACTUAL_START",
      stderr: "ACTUAL_DIAGNOSTIC",
      stdout: "",
    },
    sink.stamp({ kind: "attachment", payload: {}, cause }),
  );
  await sink.capture({ cause, event: diagnostic });
  const start = createNativeLifecycleConsumer(
    {
      event: "SessionStart",
      dispatchToolUseID: "ACTUAL_START",
      phase: "ordinary",
      start: { source: "startup", newPluginsOnly: false },
    },
    sink,
  );
  await start.consume({
    kind: "context",
    content: ["ACTUAL_FRESH_CONTEXT"],
    cause,
    retainForStop: false,
  });
  const finished = await start.finish({ kind: "completed" });
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  // External mutation of caller options cannot change the owner shared by pending and first-user rows.
  const actualCwd = f.options.context.cwd;
  f.options.context.cwd = "/CHANGED_CALLER_CWD";
  await journal.recordUser(prompt(), "ACTUAL_FIRST_PROMPT", signal());
  const stored = rows(await readFile(f.path));
  assert.deepEqual(
    stored.filter((row) => row.type !== "last-prompt").map((row) => row.uuid),
    [
      diagnostic.uuid,
      finished.emitted[0]?.event.uuid,
      "00000000-1111-1111-1111-000000000004",
    ],
  );
  assert.equal(stored[0]?.parentUuid, null);
  assert.equal(stored[1]?.parentUuid, diagnostic.uuid);
  assert.equal(stored[2]?.parentUuid, finished.emitted[0]?.event.uuid);
  assert.ok(
    stored.every((row) => row.type === "last-prompt" || row.cwd === actualCwd),
  );
  assert.ok(!stored.some((row) => row.uuid === empty.uuid));
  assert.equal(
    journal.persistenceSelectionAudit()[0]?.[0]?.disposition,
    "empty-hook-success",
  );
  const projected = await journal.projectRequest(requestProfile());
  assert.match(
    JSON.stringify(projected.projection.messages),
    /ACTUAL_FRESH_CONTEXT/,
  );
  assert.doesNotMatch(
    JSON.stringify(projected.projection.messages),
    /ACTUAL_DIAGNOSTIC/,
  );
  await journal.recordResponse(
    response(journal, "ACTUAL_FIRST_RESPONSE", [
      { type: "text", text: "ACTUAL_FIRST_FINAL" },
    ]),
    signal(),
  );
  const saved = await journal.checkpoint(signal());
  await journal.close(signal());
  assert.ok(saved.cursorUuid);
  f.options.context.cwd = actualCwd;
  const reopened = await NativeSessionJournal.open(
    {
      ...f.options,
      initial: { kind: "owned-existing", cursorUuid: saved.cursorUuid },
    },
    host,
    signal(),
  );
  await reopened.close(signal());
});

test("unmaterialized startup and unknown selection facts never claim a durable save or create a transcript", async () => {
  for (const variant of ["pending", "unknown"] as const) {
    const f = await fixture(),
      persistence = selectedPersistence(f);
    if (variant === "unknown")
      persistence.select = () => ({
        facts: {
          userType: { status: "known", value: "external" },
          evalFeature: {
            status: "unsupported",
            reason: "ACTUAL_FEATURE_UNKNOWN",
          },
          sessionCodeMode: { status: "known", value: false },
          toolResults: { kind: "actual-set", ids: [] },
        },
        host: { original: () => ({ status: "known", value: undefined }) },
      });
    const journal = await NativeSessionJournal.open(
      f.options,
      { ...f.host, persistence },
      signal(),
    );
    const start = createNativeLifecycleConsumer(
      {
        event: "SessionStart",
        dispatchToolUseID: "ACTUAL_START",
        phase: "ordinary",
        start: { source: "startup", newPluginsOnly: false },
      },
      journal.lifecycleHost(signal()),
    );
    await start.consume({
      kind: "context",
      content: ["ACTUAL_HEAD"],
      retainForStop: false,
      cause: {
        event: "SessionStart",
        dispatchToolUseID: "ACTUAL_START",
        branch: "actual-context",
      },
    });
    if (variant === "unknown")
      await assert.rejects(
        start.finish({ kind: "completed" }),
        /capture owner failed/,
      );
    else await start.finish({ kind: "completed" });
    await assert.rejects(journal.checkpoint(signal()));
    await assert.rejects(journal.close(signal()));
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});

test("journal lifecycle sink keeps actual aggregate resume startup and progress-correlated Stop identities through cold resume", async () => {
  const f = await fixture(),
    first = await f.open();
  await first.recordUser(
    prompt("ORIGINAL_PROMPT"),
    "ORIGINAL_PROMPT_ID",
    signal(),
  );
  await first.recordResponse(
    response(first, "ORIGINAL_RESPONSE", [
      { type: "text", text: "ORIGINAL_FINAL" },
    ]),
    signal(),
  );
  const firstBinding = await first.checkpoint(signal());
  await first.close(signal());
  assert.ok(firstBinding.cursorUuid);
  const journal = await f.open({
    kind: "owned-existing",
    cursorUuid: firstBinding.cursorUuid,
  });
  const start = createNativeLifecycleConsumer(
    {
      event: "SessionStart",
      dispatchToolUseID: "ACTUAL_START_DISPATCH",
      phase: "ordinary",
      start: { source: "resume", newPluginsOnly: false },
    },
    journal.lifecycleHost(signal()),
  );
  for (const text of ["ACTUAL_START_A", "ACTUAL_START_B"])
    await start.consume({
      kind: "context",
      content: [text],
      retainForStop: false,
      cause: {
        event: "SessionStart",
        dispatchToolUseID: "ACTUAL_START_DISPATCH",
        branch: "authored-actual-context",
      },
    });
  const started = await start.finish({ kind: "completed" });
  assert.equal(started.emitted.length, 1);
  await journal.recordUser(prompt(), "ACTUAL_PROMPT_ID", signal());
  await journal.recordResponse(
    response(journal, "ACTUAL_FIRST_RESPONSE", [
      { type: "text", text: "ACTUAL_FIRST_FINAL" },
    ]),
    signal(),
  );
  const stop = createNativeLifecycleConsumer(
    {
      event: "Stop",
      dispatchToolUseID: "ACTUAL_STOP_DISPATCH",
      phase: "ordinary",
    },
    journal.lifecycleHost(signal()),
  );
  await stop.consume({ kind: "progress", toolUseID: "ACTUAL_STOP_DISPATCH" });
  await stop.consume({
    kind: "context",
    content: ["ACTUAL_STOP_CONTEXT"],
    retainForStop: true,
    cause: {
      event: "Stop",
      dispatchToolUseID: "ACTUAL_STOP_DISPATCH",
      branch: "authored-actual-context",
    },
  });
  const stopped = await stop.finish({ kind: "completed" });
  assert.equal(stopped.continue, true);
  assert.equal(stopped.continuationEvents.length, 1);
  const savedStop = stopped.emitted[0]?.event;
  assert.ok(savedStop && isNativeObject(savedStop.attachment));
  assert.equal(savedStop.attachment.toolUseID, "ACTUAL_STOP_DISPATCH");
  const continuedRequest = await journal.projectRequest(requestProfile());
  assert.match(
    JSON.stringify(continuedRequest.projection.messages),
    /ACTUAL_STOP_CONTEXT/,
  );
  await journal.recordResponse(
    response(journal, "ACTUAL_CONTINUED_RESPONSE", [
      { type: "text", text: "ACTUAL_CONTINUED_FINAL" },
    ]),
    signal(),
  );
  const checkpoint = await journal.checkpoint(signal());
  await journal.close(signal());
  const prefix = await readFile(f.path),
    stored = rows(prefix);
  const attachments = stored.filter((row) => row.type === "attachment");
  assert.equal(attachments.length, 2);
  assert.deepEqual(
    attachments.map((row) => row.uuid),
    [started.emitted[0]?.event.uuid, savedStop.uuid],
  );
  const startup = attachments[0]?.attachment;
  assert.ok(isNativeObject(startup));
  assert.deepEqual(startup.content, ["ACTUAL_START_A", "ACTUAL_START_B"]);
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.match(
    JSON.stringify(imported.session.messages),
    /ACTUAL_START_A[\s\S]*ACTUAL_START_B[\s\S]*ACTUAL_STOP_CONTEXT[\s\S]*ACTUAL_CONTINUED_FINAL/,
  );
  assert.ok(checkpoint.cursorUuid);
  const reopened = await f.open({
    kind: "owned-existing",
    cursorUuid: checkpoint.cursorUuid,
  });
  await reopened.recordUser(
    prompt("LATER_PROMPT"),
    "ACTUAL_LATER_ID",
    signal(),
  );
  await reopened.close(signal());
  assert.deepEqual((await readFile(f.path)).subarray(0, prefix.length), prefix);
});

test("journal lifecycle sink latches unsupported facts and rejects mismatched event ownership", async () => {
  for (const variant of ["unsupported", "mismatch"] as const) {
    const f = await fixture(),
      journal = await f.open(),
      sink = journal.lifecycleHost(signal());
    if (variant === "unsupported")
      await assert.rejects(async () =>
        sink.unsupported({
          cause: {
            event: "Stop",
            dispatchToolUseID: "actual-dispatch",
            branch: "unknown-owner",
          },
          reasons: ["ACTUAL_UNSUPPORTED_OWNER"],
          facts: {},
        }),
      );
    else {
      const start = createNativeLifecycleConsumer(
        {
          event: "SessionStart",
          dispatchToolUseID: "actual-start",
          phase: "ordinary",
          start: { source: "startup", newPluginsOnly: false },
        },
        {
          ...sink,
          capture: (creation) =>
            sink.capture({
              ...creation,
              cause: { ...creation.cause, event: "Stop" },
            }),
        },
      );
      await start.consume({
        kind: "context",
        content: ["ACTUAL_START"],
        retainForStop: false,
        cause: {
          event: "SessionStart",
          dispatchToolUseID: "actual-start",
          branch: "actual-context",
        },
      });
      await assert.rejects(start.finish({ kind: "completed" }));
    }
    await assert.rejects(journal.checkpoint(signal()));
    await assert.rejects(journal.close(signal()));
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});
function response(
  journal: NativeSessionJournal,
  id: string,
  blocks: unknown[],
  stop = "end_turn",
) {
  return recordNativeJsonResponse(
    { requestedModel: MODEL, host: journal.responseHost, requestId: "" },
    {
      id,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: blocks,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    },
    blocks,
  );
}
async function hook(
  journal: NativeSessionJournal,
  phase: "pre" | "post",
  context: string,
) {
  const event = phase === "pre" ? "PreToolUse" : "PostToolUse";
  const facts: NativeHookCaptureFacts = {
    source: "tool-hook",
    phase,
    event,
    toolName: call.name,
    toolUseID: call.id,
    toolInput: call.input,
    execution: "sync",
    transport: "command",
    commandHook: { type: "command", command: context },
    outcome: {
      id: context,
      event,
      origin: { source: "owned" },
      command: context,
      status: "success",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      additionalContext: context,
    },
  };
  await captureNativeToolHookResult(journal.attachmentHost(signal()), facts, {
    kind: "tool-hook",
    phase,
    call,
  });
}

test("journal records real block fragments and queues earlier-created Post contexts after their core result", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "actual-prompt-id", signal(), "default");
  const firstRequest = await journal.projectRequest(requestProfile());
  assert.deepEqual(firstRequest.projection.messages, [prompt()]);
  assert.equal(firstRequest.omittedCheckpoints.length, 1);
  const stream = new NativeStreamResponseRecording({
    requestedModel: MODEL,
    host: journal.responseHost,
  });
  stream.start({
    type: "message_start",
    message: {
      id: "actual-stream",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
      stop_reason: null,
      stop_sequence: null,
    },
  });
  stream.closeBlock(2, { type: "text", text: "OWNED_PRELUDE" });
  stream.closeBlock(9, call);
  stream.delta({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 3 },
  });
  await journal.recordResponse(stream.completed(), signal());
  await hook(journal, "pre", "OWNED_PRE");
  await hook(journal, "post", "OWNED_POST_FIRST");
  await hook(journal, "post", "OWNED_POST_SECOND");
  const beforeResult = rows(await readFile(f.path));
  assert.equal(
    beforeResult.filter((row) => row.type === "attachment").length,
    1,
  );
  await journal.recordToolResult(
    {
      result: {
        type: "tool_result",
        tool_use_id: call.id,
        content: "1\tOWNED_FILE",
      },
      toolUseResult: {
        type: "text",
        file: {
          filePath: "note.txt",
          content: "OWNED_FILE",
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
      permissionDecision: {
        decision: "accept",
        source: "config",
        reasonType: "mode",
      },
    },
    signal(),
  );
  const beforeFinal = await readFile(f.path),
    liveRequest = await journal.projectRequest(requestProfile());
  assert.deepEqual(await readFile(f.path), beforeFinal);
  assert.deepEqual(
    liveRequest.projection.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.match(
    JSON.stringify(projectMessages(liveRequest.projection.messages)),
    /OWNED_PRE[\s\S]*OWNED_POST_FIRST[\s\S]*OWNED_POST_SECOND/,
  );
  assert.deepEqual(
    liveRequest.projection.messages.find(
      (message) => message.role === "assistant",
    )?.content,
    [{ type: "text", text: "OWNED_PRELUDE" }, call],
  );
  await journal.recordResponse(
    response(journal, "actual-final", [{ type: "text", text: "OWNED_FINAL" }]),
    signal(),
  );
  await journal.close();
  const stored = rows(await readFile(f.path)).filter(
    (row) => row.type !== "last-prompt",
  );
  assert.deepEqual(
    stored.map((row) => row.type),
    [
      "user",
      "assistant",
      "assistant",
      "attachment",
      "user",
      "attachment",
      "attachment",
      "assistant",
    ],
  );
  const result = stored[4],
    firstPost = stored[5],
    secondPost = stored[6];
  assert.equal(result?.sourceToolAssistantUUID, stored[2]?.uuid);
  assert.equal(result?.parentUuid, stored[2]?.uuid);
  assert.equal(firstPost?.parentUuid, result?.uuid);
  assert.ok(
    typeof firstPost?.timestamp === "string" &&
      typeof secondPost?.timestamp === "string" &&
      typeof result?.timestamp === "string",
  );
  assert.ok(firstPost.timestamp < result.timestamp);
  assert.ok(secondPost.timestamp < result.timestamp);
  assert.equal(stored.at(-1)?.requestId, "");
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  const toolResults = projectMessages(imported.session.messages).flatMap(
    (message) =>
      message.content.filter((block) => block.type === "tool_result"),
  );
  assert.equal(toolResults.length, 1);
  assert.match(
    JSON.stringify(projectMessages(imported.session.messages)),
    /OWNED_POST_FIRST[\s\S]*OWNED_POST_SECOND/,
  );
  assert.equal(
    JSON.stringify(projectMessages(imported.session.messages)).split(
      "OWNED_POST_FIRST",
    ).length - 1,
    1,
  );
  assert.equal(
    JSON.stringify(projectMessages(imported.session.messages)).split(
      "OWNED_POST_SECOND",
    ).length - 1,
    1,
  );
  assert.equal(f.stamps(), 8);
});

async function instructions(
  journal: NativeSessionJournal,
  files: readonly NativeInstructionPayloadFile[],
) {
  await captureNativeInstructions(
    {
      state: () => ({
        status: "known",
        previous: journal.instructionState(),
        reason: "settings_sync",
      }),
      trust: () => ({ status: "verified", nativeProjection: "unclipped" }),
      stamp: () => journal.stampAttachment(),
      capture: (result) => journal.captureInstruction(result, signal()),
    },
    {
      phase: "eager",
      files: files.map((file) => {
        if (file.type === "AutoMem")
          throw new Error(
            "This fixture requires an admitted ordinary instruction file",
          );
        return nativeInstructionFileFacts(
          {
            ...file,
            canonicalPath: file.path,
            kind: file.type,
            contentDiffersFromDisk: false,
          },
          { body: file.content.trim(), clipped: false, partial: false },
        );
      }),
    },
    { kind: "eager", message: prompt() },
  );
}

test("cold journal keeps full instruction state across deltas/removals and appends without changing the old prefix", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  const a = {
    path: join(f.root, "a.md"),
    type: "Project",
    content: "A",
  } satisfies NativeInstructionPayloadFile;
  const b = {
    path: join(f.root, "b.md"),
    type: "Project",
    content: "B",
  } satisfies NativeInstructionPayloadFile;
  const c = {
    path: join(f.root, "c.md"),
    type: "Project",
    content: "C",
  } satisfies NativeInstructionPayloadFile;
  await instructions(journal, [a, b]);
  await instructions(journal, [{ ...a, content: "A_CHANGED" }, b, c]);
  await instructions(journal, [b, c]);
  await captureNativeCatalogAttachments(
    journal.attachmentHost(signal()),
    buildCatalogAttachments({
      agents: [],
      skills: [{ name: "owned", description: "OWNED_SKILL" }],
      history: [],
      hasAgentTool: false,
      hasSkillTool: true,
    }),
    { kind: "catalog", message: prompt(), createdMessage: false },
  );
  await journal.recordResponse(
    response(journal, "final-one", [{ type: "text", text: "FIRST" }]),
    signal(),
  );
  await journal.close();
  const prefix = await readFile(f.path),
    leaf = rows(prefix).findLast((row) => row.type === "assistant")?.uuid;
  assert.equal(typeof leaf, "string");
  if (typeof leaf !== "string") assert.fail();
  const reopened = await f.open({ kind: "owned-existing", cursorUuid: leaf });
  assert.deepEqual(reopened.instructionState(), [b, c]);
  const detached = reopened.instructionState();
  assert.ok(detached);
  Object.assign(detached[0] ?? {}, { content: "FOREIGN_MUTATION" });
  assert.deepEqual(reopened.instructionState(), [b, c]);
  await reopened.recordUser(prompt("NEXT"), "prompt-two", signal());
  await reopened.recordResponse(
    response(reopened, "final-two", [{ type: "text", text: "SECOND" }]),
    signal(),
  );
  await reopened.close();
  assert.deepEqual((await readFile(f.path)).subarray(0, prefix.length), prefix);
});

test("journal latches unsupported producers and refuses later writes without inventing a response", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "owned-prompt", signal());
  const prefix = await readFile(f.path);
  await assert.rejects(
    journal.recordResponse(
      { status: "unsupported", reason: "actual partial response" },
      signal(),
    ),
    NativeSessionJournalError,
  );
  await assert.rejects(
    journal.recordUser(prompt("MUST_NOT_WRITE"), "later", signal()),
    /actual partial response/,
  );
  await assert.rejects(journal.close(), /actual partial response/);
  assert.deepEqual(await readFile(f.path), prefix);
});

test("request admission rejects foreign signed thinking before any trailing-thinking cleanup", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "actual-first-prompt", signal());
  const content = [
    { type: "text", text: "FOREIGN_VISIBLE" },
    {
      type: "thinking",
      thinking: "FOREIGN_SIGNED",
      signature: "actual-foreign-signature",
    },
  ];
  await journal.recordResponse(
    recordNativeJsonResponse(
      { requestedModel: MODEL, host: journal.responseHost },
      {
        type: "message",
        role: "assistant",
        id: "actual-foreign-model",
        model: "actual-other-model",
        content,
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      content,
    ),
    signal(),
  );
  await journal.recordUser(
    prompt("NEXT_ACTUAL_PROMPT"),
    "actual-next-prompt",
    signal(),
  );
  const prefix = await readFile(f.path);
  await assert.rejects(
    journal.projectRequest(requestProfile()),
    /Foreign-model native thinking/,
  );
  await assert.rejects(journal.close(), /Foreign-model native thinking/);
  assert.deepEqual(await readFile(f.path), prefix);
});

test("an explicit saved checkpoint cannot be discarded as advisory request metadata", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "actual-prompt", signal());
  await journal.recordResponse(
    response(journal, "actual-final", [{ type: "text", text: "ACTUAL_FINAL" }]),
    signal(),
  );
  await journal.close();
  const leaf = rows(await readFile(f.path)).findLast(
    (row) => row.type === "assistant",
  )?.uuid;
  assert.ok(typeof leaf === "string");
  await appendFile(
    f.path,
    JSON.stringify({
      type: "last-prompt",
      sessionId: SID,
      leafUuid: leaf,
      explicit: true,
    }) + "\n",
  );
  const reopened = await f.open({ kind: "owned-existing", cursorUuid: leaf });
  await reopened.recordUser(
    prompt("NEW_ACTUAL_PROMPT"),
    "new-prompt-id",
    signal(),
  );
  const prefix = await readFile(f.path);
  await assert.rejects(
    reopened.projectRequest(requestProfile()),
    /Non-advisory checkpoint/,
  );
  await assert.rejects(reopened.close(), /Non-advisory checkpoint/);
  assert.deepEqual(await readFile(f.path), prefix);
});

test("pending Post attachments surface flush/close failure instead of becoming unowned transcript rows", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "owned-prompt", signal());
  await journal.recordResponse(
    response(journal, "actual-call", [call], "tool_use"),
    signal(),
  );
  await hook(journal, "post", "PENDING_ACTUAL_CONTEXT");
  const prefix = await readFile(f.path);
  await assert.rejects(journal.flush(), /await their actual core result/);
  await assert.rejects(journal.close(), /await their actual core result/);
  assert.deepEqual(await readFile(f.path), prefix);
});

test("journal rejects duplicate tool results and keeps the first committed result intact", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "owned-prompt", signal());
  await journal.recordResponse(
    response(journal, "actual-call", [call], "tool_use"),
    signal(),
  );
  const result = {
    result: {
      type: "tool_result",
      tool_use_id: call.id,
      content: "FIRST_RESULT",
    },
  } as const;
  await journal.recordToolResult(result, signal());
  const prefix = await readFile(f.path);
  await assert.rejects(
    journal.recordToolResult(result, signal()),
    /unique active physical/,
  );
  await assert.rejects(journal.close(), /unique active physical/);
  assert.deepEqual(await readFile(f.path), prefix);
});

async function ownedApi() {
  const requests: NativeObject[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed = snapshotNativeResponseJson(JSON.parse(body));
      assert.ok(isNativeObject(parsed));
      requests.push(parsed);
      const count = requests.length,
        stop = count === 1 ? "tool_use" : "end_turn";
      const blocks =
        count === 1
          ? [{ type: "text", text: "READ_PRELUDE" }, call]
          : [
              {
                type: "text",
                text: count === 2 ? "FIRST_FINAL" : "CONTINUED_FINAL",
              },
            ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `owned-request-${count}`,
      });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `owned-response-${count}`,
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          ...blocks.flatMap((block, index) => [
            { type: "content_block_start", index, content_block: block },
            { type: "content_block_stop", index },
          ]),
          {
            type: "message_delta",
            delta: { stop_reason: stop },
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
  return {
    requests,
    provider: new AnthropicProvider({
      apiKey: "owned-dummy",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      allowNonStreamingFallback: false,
    }),
  };
}

function prepareSnapshots(journal: NativeSessionJournal): {
  promptPreparation: NativePromptTransportHost;
  requestPrepared: NativePreparedRequestHost;
} {
  let declarations: readonly NativePromptSnapshotTool[] = [],
    currentPlan: NativePromptRequestPlan | undefined;
  const promptPreparation: NativePromptTransportHost = {
    prepare: async (actual) => {
      const known = <T>(value: T): NativePromptFact<T> => ({
        status: "known",
        value,
      });
      const host: NativePromptSnapshotHost = {
        stamp: () => journal.stampAttachment(),
        owedPrompt: () => known(undefined),
        reminderFold: () => known(false),
        echoWireToolInputs: () => known(false),
        modelEffortAfterText: () => known(false),
        toolSchemaProvenance: (tool) => {
          assert.deepEqual(
            tool.schema,
            declarations.find((entry) => entry.name === tool.name)?.schema,
          );
          return known("actual-request-wire-entry");
        },
        noteCopied: () => {},
        noteRendered: () => {},
        redescribing: () => known(undefined),
        noteRedescribed: () => {},
      };
      const history = (
        await journal.projectRequest(requestProfile())
      ).originalDocument.lines.flatMap((line) =>
        isNativeObject(line.value) ? [line.value] : [],
      );
      const common = {
        history,
        enabled: known(true),
        replayEnabled: known(true),
        bareFork: false,
        querySource: "sdk",
      };
      const planned = planNativePromptSnapshot(
        {
          ...common,
          systemPrompt: [actual.currentSystem],
          resumeActive: false,
          model: actual.requestedModel,
          inheritedReminderFold: known(false),
          inheritedEchoWireToolInputs: known(false),
          inheritedWireShape: known(undefined),
          contextRendering: known("announced"),
        },
        host,
      );
      if (planned.status !== "resolved")
        assert.fail(planned.reasons.join("; "));
      if (planned.plan.creation) {
        await journal.capturePromptSnapshot(planned.plan.creation, signal());
        assert.equal(planned.plan.creation.serialization.status, "supported");
        if (planned.plan.creation.serialization.status === "supported")
          history.push(planned.plan.creation.serialization.event);
      }
      const input = {
        snapshot: planned.plan,
        attempt: {
          requestedModel: actual.requestedModel,
          wireModel: actual.wireModel,
          transport: actual.transport,
        },
        currentTools: actual.currentTools.map((baseEntry) => {
          if (typeof baseEntry.name !== "string")
            assert.fail("Actual tool name is missing");
          return {
            name: baseEntry.name,
            baseEntry,
            facts: {
              origin: known("current-render" as const),
              deferred: known(false),
              ignoreRecordedText: known(false),
              excludeRecordedSchema: known(false),
              withoutToolDescribeHooks: known(true),
              rewrittenByHook: known(false),
              hookCacheBreakerPresent: known(false),
              citationTool: known(false),
              modelAllowsCitations: known(false),
              limitedAttributes: known(false),
              allowDeferredWhenLimited: known(false),
            },
          };
        }),
        system: {
          systemContext: known({}),
          attributionHeader: known(""),
          provider: known("other" as const),
          isNonInteractive: known(false),
          hasAppendSystemPrompt: known(false),
          globalCache: known(false),
          skipGlobalCacheForSystemPrompt: known(false),
          promptCaching: known(!actual.disablePromptCaching),
          cacheTtl: known(undefined),
          cacheScopeRefused: known(false),
        },
        actualHeadWireShape: known({ systemTurns: false }),
        stages: {
          recordedOnlyTools: known(false),
          toolAdditionOrDeferredChannel: known(false),
          ownershipDecoration: known(false),
          schemaRefusalRepair: known(false),
          foundryFeatureRepair: known(false),
          inheritedThreadFields: known(false),
          extraToolSchemasOrPlaceholder: known(false),
        },
      };
      const replayed = prepareNativePromptRequest(input);
      if (replayed.status !== "prepared")
        assert.fail(replayed.reasons.join("; "));
      currentPlan = replayed.plan;
      // Capture only the actual earlier inline vector, before final body/cache serialization.
      promptPreparation.onInlineToolsDeclared = async (tools) => {
        declarations = tools;
        const updated = updateNativePromptSnapshotTools(
          { ...common, history, tools, removeAbsentToolSearch: known(false) },
          host,
        );
        if (updated.status === "unsupported")
          assert.fail(updated.reasons.join("; "));
        if (updated.status === "created")
          await journal.capturePromptSnapshot(updated.creation, signal());
      };
      return input;
    },
    onInlineToolsDeclared: () =>
      assert.fail("Actual prompt planning must precede declarations"),
  };
  return {
    promptPreparation,
    requestPrepared: (actual) => {
      assert.ok(currentPlan);
      assert.deepEqual(verifyNativePromptPreparedRequest(actual, currentPlan), {
        status: "verified",
      });
    },
  };
}

test("real provider and agent use journal history through instructions, catalogs, Read hooks, cold resume and continuation", async () => {
  const f = await fixture(),
    lifetime = await NativeSessionLifetime.open(
      {
        ownership: { directory: f.root, path: f.path, admit: () => true },
        persistence: f.options,
        initial: { kind: "fresh" },
        host: f.host,
      },
      signal(),
    ),
    journal = lifetime.journal,
    api = await ownedApi(),
    messages = [prompt("OWNED_PROMPT LEGACY_DUPLICATE_CONTEXT")];
  await writeFile(join(f.root, "note.txt"), "ACTUAL_READ_BYTES\n");
  const instructionPath = join(f.root, "CLAUDE.md");
  await writeFile(instructionPath, "ACTUAL_ADMITTED_INSTRUCTIONS\n");
  await journal.recordUser(prompt(), "actual-owner-prompt", signal());
  await instructions(journal, [
    {
      path: instructionPath,
      type: "Project",
      content: await readFile(instructionPath, "utf8"),
    },
  ]);
  await captureNativeCatalogAttachments(
    journal.attachmentHost(signal()),
    buildCatalogAttachments({
      agents: [],
      skills: [{ name: "owned", description: "ACTUAL_CATALOG_SKILL" }],
      history: [],
      hasAgentTool: false,
      hasSkillTool: true,
    }),
    {
      kind: "catalog",
      message: messages[0] ?? prompt(),
      createdMessage: false,
    },
  );
  const hookCommand = (event: "PreToolUse" | "PostToolUse") => ({
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
      source: "owned-only-context-hooks",
      hooks: {
        PreToolUse: [{ hooks: [hookCommand("PreToolUse")] }],
        PostToolUse: [{ hooks: [hookCommand("PostToolUse")] }],
      },
    },
  ]);
  onTestFinished(() => registry.close());
  const hooks = createToolHookRuntime({
    registry,
    context: () => ({ session_id: SID, cwd: f.root, transcript_path: f.path }),
    runOptions: () => ({
      cwd: f.root,
      projectDir: f.root,
      env: {},
      defaultTimeoutMs: 3000,
    }),
    nativeCapture: journal.attachmentHost(signal()),
  });
  const tools = createTools({
    cwd: f.root,
    mode: "default",
    policy: { tools: ["Read"], allowedTools: [], disallowedTools: [] },
    approve: async () => false,
    hooks,
    onTextReadResult: async (facts) => {
      assert.equal(facts.nativeCompatibility.status, "supported");
      assert.equal(facts.permissionTrace.branch, "readonly");
      // This authored fixture owns the complete bare/default/within-cwd profile,
      // no permission rules, rewrites, approval, classifier or hook verdict.
      await journal.recordToolResult(
        {
          result: facts.coreResult,
          toolUseResult: facts.rawResult,
          permissionDecision: {
            decision: "accept",
            source: "config",
            reasonType: "mode",
          },
        },
        signal(),
      );
    },
  });
  const first = await runAgent({
    provider: api.provider,
    tools,
    messages,
    model: MODEL,
    system: "ACTUAL_SYSTEM",
    maxTokens: 100,
    maxTurns: 3,
    signal: signal(),
    onEvent: () => {},
    autoCompact: false,
    nativeJournal: {
      journal,
      requestProfile,
      ...prepareSnapshots(journal),
      admitToolCall: (tool) => tool.name === "Read",
    },
  });
  assert.equal(first.turns, 2);
  assert.equal(api.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(api.requests), /LEGACY_DUPLICATE_CONTEXT/);
  const secondWire = JSON.stringify(api.requests[1]?.messages);
  for (const marker of [
    "ACTUAL_ADMITTED_INSTRUCTIONS",
    "ACTUAL_CATALOG_SKILL",
    "ACTUAL_READ_BYTES",
    "ACTUAL_PreToolUse_CONTEXT",
    "ACTUAL_PostToolUse_CONTEXT",
  ])
    assert.equal(secondWire.split(marker).length - 1, 1, marker);
  const savedBinding = await lifetime.save(signal());
  await lifetime.close(signal());
  const prefix = await readFile(f.path),
    stored = rows(prefix),
    leaf = stored.findLast((row) => row.type === "assistant")?.uuid;
  assert.equal(savedBinding.byteLength, prefix.length);
  assert.equal(stored.filter((row) => row.type === "assistant").length, 3);
  const snapshots = stored.filter(
    (row) =>
      isNativeObject(row.attachment) &&
      row.attachment.type === "prompt_snapshot",
  );
  assert.equal(snapshots.length, 2);
  const lastSnapshot = snapshots.at(-1)?.attachment;
  assert.ok(isNativeObject(lastSnapshot) && isNativeArray(lastSnapshot.tools));
  assert.deepEqual(
    lastSnapshot.tools.map((tool) =>
      isNativeObject(tool) ? tool.schema : null,
    ),
    api.requests[0]?.tools,
  );
  assert.equal(typeof leaf, "string");
  if (typeof leaf !== "string") assert.fail();
  const copyDirectory = join(f.root, "admitted-imported-project"),
    currentCwd = join(f.root, "current-workspace");
  await mkdir(copyDirectory, { mode: 0o700 });
  await mkdir(currentCwd, { mode: 0o700 });
  await chmod(f.path, 0o400);
  const copyPath = join(copyDirectory, `${SID}.jsonl`);
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: currentCwd,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  const nextOwnership = await NativeSessionOwnership.acquire(
    { directory: copyDirectory, path: copyPath, admit: () => true },
    signal(),
  );
  const copied = await copyNativeSessionToOwnedFile({
    imported,
    path: copyPath,
    ownership: nextOwnership,
    signal: signal(),
    admit: () => true,
  });
  assert.deepEqual(await readFile(copyPath), prefix);
  await nextOwnership.close();
  const resumedLifetime = await NativeSessionLifetime.open(
    {
      ownership: {
        directory: copyDirectory,
        path: copyPath,
        admit: () => true,
      },
      persistence: {
        ...f.options,
        context: { ...f.options.context, cwd: currentCwd },
      },
      initial: {
        kind: "owned-existing",
        binding: {
          path: copyPath,
          sessionId: SID,
          cursorUuid: copied.cursorUuid,
          byteLength: copied.byteLength,
          sha256: copied.sha256,
        },
      },
      host: f.host,
    },
    signal(),
  );
  const reopened = resumedLifetime.journal;
  await reopened.recordUser(
    prompt("CONTINUATION_PROMPT"),
    "continuation-prompt-id",
    signal(),
  );
  const restored = [
    ...imported.session.messages,
    prompt("CONTINUATION_PROMPT"),
  ];
  await runAgent({
    provider: api.provider,
    tools: createTools({
      cwd: currentCwd,
      mode: "default",
      policy: { tools: [], allowedTools: [], disallowedTools: [] },
      approve: async () => false,
    }),
    messages: restored,
    model: MODEL,
    system: "CHANGED_CURRENT_SYSTEM_REPLAY_USES_SAVED",
    maxTokens: 100,
    maxTurns: 1,
    signal: signal(),
    onEvent: () => {},
    autoCompact: false,
    nativeJournal: {
      journal: reopened,
      requestProfile,
      ...prepareSnapshots(reopened),
      admitToolCall: () => false,
    },
  });
  await resumedLifetime.close(signal());
  assert.equal(api.requests.length, 3);
  assert.deepEqual(api.requests[2]?.tools, []);
  assert.match(JSON.stringify(api.requests[2]?.system), /ACTUAL_SYSTEM/);
  assert.doesNotMatch(
    JSON.stringify(api.requests[2]?.system),
    /CHANGED_CURRENT_SYSTEM/,
  );
  assert.deepEqual(
    (await readFile(copyPath)).subarray(0, prefix.length),
    prefix,
  );
  assert.deepEqual(await readFile(f.path), prefix);
  assert.equal(
    rows(await readFile(copyPath)).findLast((row) => row.type === "assistant")
      ?.cwd,
    currentCwd,
  );
  const roundtrip = await importNativeSessionFile({
    path: copyPath,
    cwd: currentCwd,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.deepEqual(
    projectMessages(roundtrip.session.messages).slice(
      0,
      imported.session.messages.length,
    ),
    projectMessages(imported.session.messages),
  );
  assert.match(
    JSON.stringify(api.requests[2]?.messages),
    /FIRST_FINAL[\s\S]*CONTINUATION_PROMPT/,
  );
});

test("agent propagates an actual Read recording failure without a false tool result or another model request", async () => {
  const f = await fixture(),
    api = await ownedApi(),
    messages = [prompt()];
  let reportedResult = false;
  await writeFile(join(f.root, "note.txt"), "ACTUAL_READ_BYTES\n");
  await assert.rejects(
    runAgent({
      provider: api.provider,
      tools: createTools({
        cwd: f.root,
        mode: "default",
        approve: async () => false,
        onTextReadResult: () => {
          throw new Error("OWNED_CAPTURE_SINK_FAILED");
        },
      }),
      messages,
      model: MODEL,
      system: "ACTUAL_SYSTEM",
      maxTokens: 100,
      maxTurns: 3,
      signal: signal(),
      onEvent: (event) => {
        if (event.type === "tool_result") reportedResult = true;
      },
      autoCompact: false,
    }),
    (error) =>
      error instanceof TextReadCaptureError &&
      error.cause instanceof Error &&
      error.cause.message === "OWNED_CAPTURE_SINK_FAILED",
  );
  assert.equal(api.requests.length, 1);
  assert.equal(reportedResult, false);
  assert.equal(
    messages.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_result"),
    ).length,
    0,
  );
});
