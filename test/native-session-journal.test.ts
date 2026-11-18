import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeSessionJournal,
  NativeSessionJournalError,
  type NativeJournalRequestOptions,
} from "../src/native-session-journal.js";
import {
  NativeStreamResponseRecording,
  recordNativeJsonResponse,
} from "../src/native-response-recording.js";
import {
  captureNativeToolHookResult,
  captureNativeCatalogAttachments,
  type NativeHookCaptureFacts,
} from "../src/native-attachment-capture.js";
import {
  captureNativeInstructions,
  nativeInstructionFileFacts,
  type NativeInstructionPayloadFile,
} from "../src/native-instruction-capture.js";
import { buildCatalogAttachments } from "../src/catalog-projection.js";
import {
  decodeNativeSession,
  isNativeObject,
} from "../src/native-session-codec.js";
import { importNativeSessionFile } from "../src/native-session-import.js";
import type { NativeSessionPersistenceOptions } from "../src/native-session-persistence.js";
import type { Message, ToolUse } from "../src/types.js";
import { projectMessages } from "../src/thinking-history.js";
import { createNativeContextClassifiers } from "../src/native-context-classifiers.js";

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
  const path = join(root, "owned.jsonl");
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
          { body: file.content, clipped: false, partial: false },
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
