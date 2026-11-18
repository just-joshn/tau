import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeSessionJournal,
  NativeSessionJournalError,
  type NativeJournalRequestOptions,
} from "../../src/native-session-journal.js";
import { recordNativeJsonResponse } from "../../src/native-response-recording.js";
import {
  captureNativeCatalogAttachments,
  captureNativeToolHookResult,
  type NativeHookCaptureFacts,
} from "../../src/native-attachment-capture.js";
import {
  captureNativeInstructions,
  nativeInstructionFileFacts,
  type NativeInstructionAttachment,
  type NativeInstructionPayloadFile,
} from "../../src/native-instruction-capture.js";
import { createNativeAttachmentEvent } from "../../src/native-persistence-events.js";
import { buildCatalogAttachments } from "../../src/catalog-projection.js";
import {
  decodeNativeSession,
  isNativeArray,
  isNativeObject,
} from "../../src/native-session-codec.js";
import type { NativeSessionPersistenceOptions } from "../../src/native-session-persistence.js";
import type { Message, ToolUse } from "../../src/types.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";

const SID = "22222222-2222-2222-2222-222222222222",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const prompt = (text = "EDGE_PROMPT"): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const requestProfile = (
  requestedModel = MODEL,
): NativeJournalRequestOptions => ({
  requestedModel,
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
    await mkdtemp(join(tmpdir(), "tau-native-journal-edges-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "owned.jsonl");
  let stamps = 0;
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
    withExclusiveOwnership: async (_path, work) => work(),
  };
  const host = {
    stamp: () => ({
      uuid: `00000000-2222-2222-2222-${String(++stamps).padStart(12, "0")}`,
      timestamp: `2026-11-18T00:00:00.${String(stamps).padStart(3, "0")}Z`,
    }),
  };
  const open = (initial = options.initial) =>
    NativeSessionJournal.open({ ...options, initial }, host, signal());
  return { root, path, open };
}
const rows = async (path: string) =>
  decodeNativeSession(await readFile(path), {
    parser: "source-line-fallback",
  }).lines.flatMap((line) => (isNativeObject(line.value) ? [line.value] : []));
async function checkpoint(path: string): Promise<string> {
  const leaf = (await rows(path)).findLast(
    (row) => row.type === "last-prompt",
  )?.leafUuid;
  if (typeof leaf !== "string") assert.fail("missing native checkpoint");
  return leaf;
}
const call: ToolUse = {
  type: "tool_use",
  id: "edge-read",
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
function recordInstructions(
  journal: NativeSessionJournal,
  attachment: NativeInstructionAttachment,
  currentFiles: readonly NativeInstructionPayloadFile[],
) {
  return journal.captureInstruction(
    {
      status: "captured",
      facts: { phase: "eager", files: [] },
      event: createNativeAttachmentEvent(attachment, journal.stampAttachment()),
      attachment,
      currentFiles,
    },
    signal(),
  );
}
function eagerInstructions(
  journal: NativeSessionJournal,
  files: readonly NativeInstructionPayloadFile[],
  trusted = true,
) {
  return captureNativeInstructions(
    {
      state: () => ({
        status: "known",
        previous: journal.instructionState(),
        reason: undefined,
      }),
      trust: () =>
        trusted
          ? { status: "verified", nativeProjection: "unclipped" }
          : { status: "unsupported", reason: "EDGE_UNTRUSTED" },
      stamp: () => journal.stampAttachment(),
      capture: (result) => journal.captureInstruction(result, signal()),
    },
    {
      phase: "eager",
      files: files.map((file) => {
        if (file.type === "AutoMem") throw new Error("ordinary files only");
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
function catalog(journal: NativeSessionJournal) {
  return captureNativeCatalogAttachments(
    journal.attachmentHost(signal()),
    buildCatalogAttachments({
      agents: [],
      skills: [{ name: "edge", description: "EDGE_SKILL" }],
      history: [],
      hasAgentTool: false,
      hasSkillTool: true,
    }),
    { kind: "catalog", message: prompt(), createdMessage: false },
  );
}

test("reopening restores every recorded instruction kind and its native clipping flags", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  const files: NativeInstructionPayloadFile[] = [
    { path: join(f.root, "managed.md"), type: "Managed", content: "M" },
    {
      path: join(f.root, "user.md"),
      type: "User",
      content: "U",
      startOnly: true,
    },
    {
      path: join(f.root, "local.md"),
      type: "Local",
      content: "L",
      cutForRoom: false,
    },
    { path: join(f.root, "project.md"), type: "Project", content: "P" },
  ];
  await recordInstructions(journal, { type: "instructions", files }, files);
  await journal.recordResponse(
    response(journal, "edge-final", [{ type: "text", text: "DONE" }]),
    signal(),
  );
  await journal.close();
  const reopened = await f.open({
    kind: "owned-existing",
    cursorUuid: await checkpoint(f.path),
  });
  assert.deepEqual(reopened.instructionState(), files);
  await reopened.close();
});

test("reopening rejects a changed instruction attachment that has no earlier bodies", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  const file: NativeInstructionPayloadFile = {
    path: join(f.root, "a.md"),
    type: "Project",
    content: "A",
  };
  await recordInstructions(
    journal,
    { type: "instructions", files: [file], changed: true },
    [file],
  );
  await journal.recordResponse(
    response(journal, "edge-final", [{ type: "text", text: "DONE" }]),
    signal(),
  );
  await journal.close();
  const cursorUuid = await checkpoint(f.path);
  await assert.rejects(
    f.open({ kind: "owned-existing", cursorUuid }),
    NativeSessionJournalError,
  );
});

test("reopening skips non-object transcript lines", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  await journal.close();
  await appendFile(f.path, "[]\n");
  const reopened = await f.open({
    kind: "owned-existing",
    cursorUuid: await checkpoint(f.path),
  });
  assert.equal(reopened.instructionState(), undefined);
  const request = await reopened.projectRequest(requestProfile());
  assert.deepEqual(request.projection.messages, [prompt()]);
  await reopened.close();
});

test("a non-advisory last-prompt row blocks the live request projection", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  await journal.close();
  const leafUuid = await checkpoint(f.path);
  await appendFile(
    f.path,
    `${JSON.stringify({ type: "last-prompt", sessionId: SID, leafUuid, extra: true })}\n`,
  );
  const reopened = await f.open({
    kind: "owned-existing",
    cursorUuid: leafUuid,
  });
  await assert.rejects(
    reopened.projectRequest(requestProfile()),
    NativeSessionJournalError,
  );
});

test("recordUser rejects non-text or non-user prompts and a missing prompt id without writing", async () => {
  const cases: [Message, string][] = [
    [{ role: "assistant", content: [{ type: "text", text: "X" }] }, "id"],
    [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "edge", content: "X" }],
      },
      "id",
    ],
    [prompt(), ""],
  ];
  for (const [message, promptId] of cases) {
    const f = await fixture(),
      journal = await f.open();
    await assert.rejects(
      journal.recordUser(message, promptId, signal()),
      NativeSessionJournalError,
    );
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});

test("a malformed response is wrapped as a journal failure that latches", async () => {
  const f = await fixture(),
    journal = await f.open();
  const failure = await journal
    .recordResponse({ status: "nonsense" }, signal())
    .then(
      () => assert.fail("expected rejection"),
      (error: unknown) => error,
    );
  assert.ok(failure instanceof NativeSessionJournalError);
  assert.notEqual(failure.cause, undefined);
  await assert.rejects(
    journal.recordUser(prompt(), "later", signal()),
    (error) => error === failure,
  );
});

test("a write after close begins is refused, latched, and reported by close", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  const closing = journal.close();
  await assert.rejects(
    journal.recordUser(prompt("LATE"), "late", signal()),
    /closing/,
  );
  await assert.rejects(closing, /closing/);
  assert.equal(
    (await rows(f.path)).filter((row) => row.type === "user").length,
    1,
  );
});

test("work queued behind a failing request inherits that failure and writes nothing", async () => {
  const f = await fixture(),
    journal = await f.open();
  const request = journal.projectRequest(requestProfile()),
    queued = journal.recordUser(prompt(), "prompt-one", signal());
  const failure = await request.then(
    () => assert.fail("expected rejection"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof NativeSessionJournalError);
  await assert.rejects(queued, (error) => error === failure);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("instruction capture: unsupported results fail, unchanged results write nothing", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  const file: NativeInstructionPayloadFile = {
    path: join(f.root, "a.md"),
    type: "Project",
    content: "A",
  };
  await eagerInstructions(journal, [file]);
  const before = await readFile(f.path);
  await eagerInstructions(journal, [file]);
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(journal.instructionState(), [file]);
  await assert.rejects(
    eagerInstructions(journal, [file], false),
    (error) =>
      error instanceof NativeSessionJournalError &&
      error.message.includes("EDGE_UNTRUSTED"),
  );
  assert.deepEqual(await readFile(f.path), before);
});

test("attachment capture rejects unsupported results and hooks without an active tool owner", async () => {
  const f = await fixture(),
    journal = await f.open();
  await assert.rejects(
    journal.captureAttachment(
      {
        status: "unsupported",
        facts: { source: "catalog", attachmentIndex: 0, projectedBlock: null },
        reasons: ["EDGE_UNSUPPORTED"],
      },
      { kind: "catalog", message: prompt(), createdMessage: false },
      signal(),
    ),
    NativeSessionJournalError,
  );
  const second = await fixture(),
    unowned = await second.open();
  await unowned.recordUser(prompt(), "prompt-one", signal());
  await assert.rejects(
    hook(unowned, "pre", "EDGE_CONTEXT"),
    /active physical tool owner/,
  );
});

test("tool results persist is_error and permission mode, and commitment is observable", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  await journal.recordResponse(
    response(journal, "edge-call", [call], "tool_use"),
    signal(),
  );
  await journal.recordToolResult(
    {
      result: {
        type: "tool_result",
        tool_use_id: call.id,
        content: "EDGE_FAILED",
        is_error: true,
      },
      permissionMode: "acceptEdits",
    },
    signal(),
  );
  await journal.flush();
  journal.assertToolResultCommitted(call.id);
  const stored = await rows(f.path),
    assistant = stored.find((row) => row.type === "assistant"),
    result = stored.findLast((row) => row.type === "user");
  assert.equal(result?.permissionMode, "acceptEdits");
  assert.equal(result?.sourceToolAssistantUUID, assistant?.uuid);
  const content =
    isNativeObject(result?.message) && isNativeArray(result.message.content)
      ? result.message.content
      : [];
  assert.deepEqual(content, [
    {
      type: "tool_result",
      tool_use_id: call.id,
      content: "EDGE_FAILED",
      is_error: true,
    },
  ]);
  assert.throws(
    () => journal.assertToolResultCommitted("never-called"),
    NativeSessionJournalError,
  );
  await assert.rejects(journal.close(), /committed native producer/);
});

test("projectRequest refuses pending Post contexts, a missing cursor, and an empty model", async () => {
  const pending = await fixture(),
    journal = await pending.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  await journal.recordResponse(
    response(journal, "edge-call", [call], "tool_use"),
    signal(),
  );
  await hook(journal, "post", "EDGE_POST");
  await assert.rejects(
    journal.projectRequest(requestProfile()),
    /cannot precede its actual core result/,
  );

  const empty = await fixture(),
    fresh = await empty.open();
  await assert.rejects(
    fresh.projectRequest(requestProfile()),
    /conversational cursor/,
  );

  const unnamed = await fixture(),
    modelless = await unnamed.open();
  await modelless.recordUser(prompt(), "prompt-one", signal());
  await assert.rejects(
    modelless.projectRequest(requestProfile("")),
    /actual current model/,
  );
});

test("a cursor on an attachment walks back to its conversational parent", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  await catalog(journal);
  const request = await journal.projectRequest(requestProfile());
  assert.equal(request.projection.messages[0]?.role, "user");
  await journal.close();
});

test("thinking from another model needs its signature host; the same model projects", async () => {
  const f = await fixture(),
    journal = await f.open();
  await journal.recordUser(prompt(), "prompt-one", signal());
  await journal.recordResponse(
    response(journal, "edge-thinking", [
      { type: "thinking", thinking: "EDGE_THOUGHT", signature: "EDGE_SIG" },
      { type: "text", text: "EDGE_ANSWER" },
    ]),
    signal(),
  );
  await journal.recordUser(prompt("NEXT"), "prompt-two", signal());
  const same = await journal.projectRequest(requestProfile());
  assert.deepEqual(
    same.projection.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  await assert.rejects(
    journal.projectRequest(requestProfile("claude-opus-4-1")),
    /signature compatibility host/,
  );
});
