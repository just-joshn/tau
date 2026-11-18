import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import { NativeMemoryJournal } from "../../src/native-memory-journal.js";
import { NativeSessionJournalError } from "../../src/native-session-journal.js";
import type { NativeJournalRequestOptions } from "../../src/native-session-journal.js";
import { recordNativeJsonResponse } from "../../src/native-response-recording.js";
import {
  captureNativeToolHookResult,
  type NativeAttachmentCaptureResult,
  type NativeHookCaptureFacts,
} from "../../src/native-attachment-capture.js";
import type { NativeInstructionPayloadFile } from "../../src/native-instruction-capture.js";
import type { NativeLifecycleDecision } from "../../src/native-lifecycle-hooks.js";
import { createNativeAttachmentEvent } from "../../src/native-persistence-events.js";
import {
  planNativePromptSnapshot,
  type NativePromptFact,
} from "../../src/native-prompt-snapshot.js";
import {
  createNativeStopHookSummary,
  nativeHookProgressDispatch,
  type NativeHookProgressRow,
} from "../../src/native-hook-progress.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";
import type { NativeSourceRow } from "../../src/native-session-codec.js";
import type { ToolUse } from "../../src/types.js";

const SID = "33333333-3333-3333-3333-333333333333",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const recovery: NativeJournalRequestOptions["recovery"] = {
  callIdToolResults: true,
  descendantOrder: "depth-first",
  timestampFallback: "reject",
};
const profile = (): NativeJournalRequestOptions<NativeSourceRow> => ({
  requestedModel: MODEL,
  recovery,
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
const call: ToolUse = {
  type: "tool_use",
  id: "edge-read",
  name: "Read",
  input: { file_path: "edge.txt" },
};
const silent: NativeLifecycleDecision = {
  event: "Stop",
  emitted: [],
  continuationEvents: [],
  continue: false,
  preventContinuation: false,
  wasCancelled: false,
  unsupported: [],
};

async function open(
  options: {
    refuse?: (rows: readonly unknown[]) => boolean;
    stamp?: () => { uuid: string; timestamp: string };
  } = {},
) {
  let serial = 0;
  const journal = await NativeMemoryJournal.open(
    { sessionId: SID },
    {
      stamp:
        options.stamp ??
        (() => ({
          uuid: `00000000-3333-3333-3333-${String(++serial).padStart(12, "0")}`,
          timestamp: "2026-11-18T00:00:00Z",
        })),
      admission: {
        admitProducer: () => true,
        admitRetention: ({ rows }) => !options.refuse?.(rows),
      },
    },
    signal(),
  );
  onTestFinished(() => journal.close(signal()).catch(() => {}));
  return journal;
}
type Journal = Awaited<ReturnType<typeof open>>;
const user = (journal: Journal, text = "EDGE_USER") =>
  journal.recordUser(
    { role: "user", content: [{ type: "text", text }] },
    "EDGE_PROMPT",
    signal(),
  );
function respond(
  journal: Journal,
  content: readonly unknown[],
  model = MODEL,
): Promise<void> {
  return journal.recordResponse(
    recordNativeJsonResponse(
      { requestedModel: MODEL, host: journal.responseHost },
      {
        id: "edge-api",
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: content.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "tool_use",
        )
          ? "tool_use"
          : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      content,
    ),
    signal(),
  );
}
async function rows(journal: Journal) {
  return (await journal.readCommitted(signal())).state.entries.map(
    (entry) => entry.row,
  );
}
function hookFacts(phase: "pre" | "post"): NativeHookCaptureFacts {
  const event = phase === "pre" ? "PreToolUse" : "PostToolUse";
  return {
    source: "tool-hook",
    phase,
    event,
    toolName: call.name,
    toolUseID: call.id,
    toolInput: call.input,
    execution: "sync",
    transport: "command",
    commandHook: { type: "command", command: "EDGE_HOOK" },
    outcome: {
      id: "EDGE_HOOK",
      event,
      origin: { source: "owned" },
      command: "EDGE_HOOK",
      status: "success",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      additionalContext: `EDGE_${phase.toUpperCase()}_CONTEXT`,
    },
  };
}
async function hookResult(
  journal: Journal,
  phase: "pre" | "post",
): Promise<Extract<NativeAttachmentCaptureResult, { status: "captured" }>> {
  let captured: NativeAttachmentCaptureResult | undefined;
  await captureNativeToolHookResult(
    {
      stamp: () => journal.stampAttachment(),
      capture: (result) => {
        captured = result;
      },
    },
    hookFacts(phase),
    { kind: "tool-hook", phase, call },
  );
  assert.ok(captured?.status === "captured");
  return captured;
}
async function stopProgress(journal: Journal) {
  const progress: NativeHookProgressRow[] = [];
  for await (const row of nativeHookProgressDispatch(
    {
      event: "Stop",
      dispatchToolUseID: "EDGE_STOP",
      admission: { status: "admitted", source: "actual-final-dispatch" },
      candidates: [
        { id: "edge", hook: { type: "command", command: "edge-stop" } },
      ],
    },
    {
      aliases: () => known([]),
      display: () => known({ command: "edge-stop" }),
      stamp: () => journal.stampHookProgress(),
    },
    signal(),
  ))
    progress.push(row);
  return progress;
}
async function startProgress(journal: Journal) {
  const progress: NativeHookProgressRow[] = [];
  for await (const row of nativeHookProgressDispatch(
    {
      event: "SessionStart",
      matchQuery: "startup",
      dispatchToolUseID: "EDGE_START",
      admission: { status: "admitted", source: "actual-final-dispatch" },
      candidates: [
        { id: "edge", hook: { type: "command", command: "edge-start" } },
      ],
    },
    {
      aliases: () => known([]),
      display: () => known({ command: "edge-start" }),
      stamp: () => journal.stampHookProgress(),
    },
    signal(),
  ))
    progress.push(row);
  const row = progress[0];
  assert.ok(row);
  return row;
}

test("a refused retention poisons the journal, including work already queued behind it", async () => {
  const journal = await open({
    refuse: (batch) => batch.some((row) => JSON.stringify(row).includes("BAD")),
  });
  const refused = user(journal, "BAD_PROMPT"),
    queued = user(journal, "GOOD_PROMPT");
  const failure = await refused.then(
    () => assert.fail("refused retention resolved"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof NativeSessionJournalError);
  await assert.rejects(queued, (error) => error === failure);
  await assert.rejects(user(journal, "LATER"), (error) => error === failure);
  assert.throws(
    () => journal.stampAttachment(),
    (error) => error === failure,
  );
  await assert.rejects(journal.flush(signal()), (error) => error === failure);
});

test("producer identities must be fresh and tool calls must have one owner", async () => {
  const repeated = await open({
    stamp: () => ({
      uuid: "00000000-3333-3333-3333-000000000001",
      timestamp: "2026-11-18T00:00:00Z",
    }),
  });
  await user(repeated);
  await assert.rejects(user(repeated), /already retained or absent/);

  const journal = await open();
  await user(journal);
  await respond(journal, [call]);
  await assert.rejects(respond(journal, [call]), /multiple source owners/);
});

test("a human prompt needs a prompt id and text-only content, and keeps its permission mode", async () => {
  await assert.rejects(
    (await open()).recordUser(
      { role: "user", content: [{ type: "text", text: "EDGE" }] },
      "",
      signal(),
    ),
    /actual text producer/,
  );
  await assert.rejects(
    (await open()).recordUser(
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "x" }],
      },
      "EDGE_PROMPT",
      signal(),
    ),
    /actual text producer/,
  );
  const journal = await open();
  await journal.recordUser(
    { role: "user", content: [{ type: "text", text: "EDGE_PLAN" }] },
    "EDGE_PROMPT",
    signal(),
    "plan",
  );
  const [row] = await rows(journal);
  assert.equal(row?.permissionMode, "plan");
});

test("an incomplete response recording is refused", async () => {
  const journal = await open();
  await assert.rejects(
    journal.recordResponse(
      { status: "unsupported", reason: "EDGE_TRUNCATED" },
      signal(),
    ),
    /Unsupported native response: EDGE_TRUNCATED/,
  );
});

test("hook progress follows its retention policy and Stop progress needs a pending Stop", async () => {
  const journal = await open();
  const start = await startProgress(journal);
  const base = {
    consumer: "session-start" as const,
    dispatchToolUseID: "EDGE_START",
    signalAborted: false,
  };
  await assert.rejects(
    journal.captureHookProgress(
      start,
      { ...base, admission: { status: "unsupported", reason: "EDGE_NOPE" } },
      signal(),
    ),
    /EDGE_NOPE/,
  );
  const fresh = await open();
  const buffered = await startProgress(fresh);
  await assert.rejects(
    fresh.captureHookProgress(
      buffered,
      { ...base, admission: { status: "buffer" } },
      signal(),
    ),
    /awaits its actual final retention owner/,
  );
  const third = await open(),
    discarded = await startProgress(third);
  await third.captureHookProgress(
    discarded,
    {
      ...base,
      admission: {
        status: "resolved",
        source: "fresh-initial",
        retainedUuids: [],
      },
    },
    signal(),
  );
  assert.deepEqual(await rows(third), []);

  const stop = await open();
  await user(stop);
  const [progress] = await stopProgress(stop);
  assert.ok(progress);
  await assert.rejects(
    stop.captureHookProgress(
      progress,
      {
        consumer: "blockable-stop",
        dispatchToolUseID: "EDGE_STOP",
        signalAborted: false,
      },
      signal(),
    ),
    /lacks its actual main-query phase/,
  );
});

test("a Stop summary needs an active pending query with observed progress", async () => {
  const journal = await open();
  await user(journal);
  await journal.captureStopSummary(
    { status: "absent", reason: "no-observed-progress" },
    signal(),
  );
  const progress = await stopProgress(journal);
  const last = progress.at(-1);
  assert.ok(last);
  const creation = createNativeStopHookSummary(
    {
      phase: "blockable-turn-end",
      end: "normally-drained",
      observedProgress: progress,
      accumulators: {
        hookCount: progress.length,
        hookInfos: progress.map((row) => ({ command: row.data.command })),
        hookErrors: [],
        hookAdditionalContext: [],
        preventedContinuation: false,
        stopReason: "",
        hasOutput: false,
        level: "suggestion",
        toolUseID: last.toolUseID,
      },
    },
    { stamp: () => journal.stampStopSummary() },
  );
  await assert.rejects(
    journal.captureStopSummary(creation, signal()),
    /actual observed progress owner/,
  );
});

test("instruction capture keeps a detached copy of the captured files", async () => {
  const journal = await open();
  assert.equal(journal.instructionState(), undefined);
  const facts = { phase: "eager" as const, files: [] };
  await assert.rejects(
    journal.captureInstruction(
      { status: "unsupported", facts, reasons: ["EDGE_UNTRUSTED"] },
      signal(),
    ),
    /EDGE_UNTRUSTED/,
  );
  const fresh = await open();
  await fresh.captureInstruction({ status: "unchanged", facts }, signal());
  assert.equal(fresh.instructionState(), undefined);
  const file: NativeInstructionPayloadFile = {
    path: "/edge/CLAUDE.md",
    type: "Project",
    content: "EDGE_RULE",
  };
  const attachment = { type: "instructions" as const, files: [file] };
  const currentFiles = [file];
  await fresh.captureInstruction(
    {
      status: "captured",
      facts,
      event: createNativeAttachmentEvent(attachment, fresh.stampAttachment()),
      attachment,
      currentFiles,
    },
    signal(),
  );
  const state = fresh.instructionState();
  assert.deepEqual(state, [file]);
  file.content = "MUTATED";
  assert.deepEqual(fresh.instructionState(), [
    { ...file, content: "EDGE_RULE" },
  ]);
  assert.equal((await rows(fresh)).length, 1);
});

test("a prompt snapshot must be supported and keep its creation provenance", async () => {
  const journal = await open();
  await user(journal);
  const planned = planNativePromptSnapshot(
    {
      history: await rows(journal),
      enabled: known(true),
      replayEnabled: known(true),
      bareFork: false,
      querySource: "sdk",
      systemPrompt: ["EDGE_SYSTEM"],
      resumeActive: false,
      model: MODEL,
      contextRendering: known("announced"),
    },
    {
      stamp: () => journal.stampAttachment(),
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
  assert.ok(planned.status === "resolved" && planned.plan.creation);
  const creation = planned.plan.creation;
  await assert.rejects(
    journal.capturePromptSnapshot(
      {
        ...creation,
        serialization: { status: "unsupported", reasons: ["EDGE_SCHEMA"] },
      },
      signal(),
    ),
    /EDGE_SCHEMA/,
  );
  const fresh = await open();
  await assert.rejects(
    fresh.capturePromptSnapshot(
      { ...creation, record: { ...creation.record, uuid: "foreign" } },
      signal(),
    ),
    /lost its actual creation provenance/,
  );
});

test("lifecycle creations need their branch and hook ownership, and unsupported facts poison", async () => {
  const journal = await open();
  await user(journal);
  const host = journal.lifecycleHost(signal());
  const stamp = host.stamp({
    kind: "feedback",
    payload: {},
    cause: { event: "Stop", dispatchToolUseID: "EDGE_STOP", branch: "edge" },
  });
  await assert.rejects(
    Promise.resolve(
      host.capture({
        cause: { event: "Stop", dispatchToolUseID: "EDGE_STOP", branch: "" },
        event: {
          type: "user",
          ...stamp,
          isMeta: true,
          message: { role: "user", content: "EDGE" },
        },
      }),
    ),
    /actual retained event ownership/,
  );
  const fresh = await open();
  await assert.rejects(
    Promise.resolve(
      fresh.lifecycleHost(signal()).unsupported({
        cause: { event: "Stop", dispatchToolUseID: "EDGE_STOP", branch: "x" },
        reasons: ["EDGE_UNSUPPORTED"],
        facts: {},
      }),
    ),
    /EDGE_UNSUPPORTED/,
  );
  await assert.rejects(user(fresh), /EDGE_UNSUPPORTED/);
});

test("attachment capture checks status, source and the owning tool call", async () => {
  const journal = await open();
  await user(journal);
  await respond(journal, [call]);
  const pre = await hookResult(journal, "pre");
  const toolHook = { kind: "tool-hook" as const, phase: "pre" as const, call };
  await assert.rejects(
    journal.captureAttachment(
      { status: "unsupported", facts: pre.facts, reasons: ["EDGE_BATCH"] },
      toolHook,
      signal(),
    ),
    /EDGE_BATCH/,
  );
  const foreign = await open();
  await user(foreign);
  await respond(foreign, [call]);
  const foreignPre = await hookResult(foreign, "pre");
  await assert.rejects(
    foreign.captureAttachment(
      {
        ...foreignPre,
        facts: { source: "catalog", attachmentIndex: 0, projectedBlock: null },
      },
      toolHook,
      signal(),
    ),
    /foreign creation source/,
  );
  const stranger = await open();
  await user(stranger);
  await respond(stranger, [call]);
  const strangerPre = await hookResult(stranger, "pre");
  await assert.rejects(
    stranger.captureAttachment(
      strangerPre,
      { ...toolHook, call: { ...call, id: "edge-other" } },
      signal(),
    ),
    /active actual tool owner/,
  );

  const catalog = await open();
  await user(catalog);
  const listed = await hookResult(catalog, "pre");
  await catalog.captureAttachment(
    listed,
    {
      kind: "catalog",
      message: { role: "user", content: [] },
      createdMessage: false,
    },
    signal(),
  );
  assert.equal((await rows(catalog)).at(-1)?.uuid, listed.event.uuid);
});

test("an uncommitted tool result is refused and poisons the journal", async () => {
  const journal = await open();
  await user(journal);
  await respond(journal, [call]);
  assert.throws(
    () => journal.assertToolResultCommitted(call.id),
    /lacks its actual retained producer/,
  );
  await assert.rejects(user(journal), /lacks its actual retained producer/);
});

test("two results for one call retain only the first", async () => {
  const journal = await open();
  await user(journal);
  await respond(journal, [call]);
  const result = {
    result: {
      type: "tool_result" as const,
      tool_use_id: call.id,
      content: "EDGE_DENIED",
    },
  };
  const first = journal.recordToolResult(result, signal()),
    duplicate = journal.recordToolResult(result, signal());
  await first;
  await assert.rejects(duplicate, /already retained/);
});

test("a committed tool result is readable with its error and permission facts", async () => {
  const journal = await open();
  await user(journal);
  await respond(journal, [call]);
  const post = await hookResult(journal, "post");
  await journal.captureAttachment(
    post,
    { kind: "tool-hook", phase: "post", call },
    signal(),
  );
  await journal.recordToolResult(
    {
      result: {
        type: "tool_result",
        tool_use_id: call.id,
        content: "EDGE_DENIED",
        is_error: true,
      },
      permissionDecision: {
        decision: "accept",
        source: "config",
        reasonType: "mode",
      },
      permissionMode: "default",
    },
    signal(),
  );
  journal.assertToolResultCommitted(call.id);
  const saved = await rows(journal);
  const [resultRow, postRow] = saved.slice(-2);
  assert.equal(resultRow?.permissionMode, "default");
  assert.deepEqual(resultRow?.permissionDecision, {
    decision: "accept",
    source: "config",
    reasonType: "mode",
  });
  assert.match(JSON.stringify(resultRow?.message), /"is_error":true/);
  assert.equal(postRow?.uuid, post.event.uuid);
});

test("a query frame needs conversation and only one active owner", async () => {
  const empty = await open();
  await assert.rejects(
    empty.beginQueryFrame(recovery, signal()),
    /requires actual conversation/,
  );
  const journal = await open();
  await user(journal);
  await journal.beginQueryFrame(recovery, signal());
  await assert.rejects(
    journal.beginQueryFrame(recovery, signal()),
    /already has an active owner/,
  );
  const pending = await open();
  await user(pending);
  const frame = await pending.beginQueryFrame(recovery, signal());
  await pending.beginLifecycleTransition(frame, signal());
  await assert.rejects(
    pending.beginLifecycleTransition(frame, signal()),
    /already pending/,
  );
  const ordinary = await open();
  await user(ordinary);
  const owned = await ordinary.beginQueryFrame(recovery, signal());
  await ordinary.beginLifecycleTransition(owned, signal());
  await assert.rejects(user(ordinary), /outside its owning query transition/);
});

test("queued lifecycle calls see the revision their caller saw", async () => {
  const journal = await open();
  await user(journal);
  const frame = await journal.beginQueryFrame(recovery, signal());
  const first = journal.beginLifecycleTransition(frame, signal()),
    second = journal.beginLifecycleTransition(frame, signal());
  await first;
  await assert.rejects(second, /revision changed/);
});

test("lifecycle decisions are checked for unsupported producers and an owning query", async () => {
  const journal = await open();
  await user(journal);
  await journal.assertLifecycleCommitted(silent, signal());
  await assert.rejects(
    journal.assertLifecycleCommitted({ ...silent, continue: true }, signal()),
    /requires its actual query owner/,
  );
  const prevented = await open();
  await user(prevented);
  await prevented.assertLifecycleCommitted(
    { ...silent, continue: true, preventContinuation: true },
    signal(),
  );
  const frame = await prevented.beginQueryFrame(recovery, signal());
  await prevented.assertLifecycleCommitted(silent, signal(), frame);
  await assert.rejects(
    prevented.assertLifecycleCommitted(
      {
        ...silent,
        unsupported: [
          {
            cause: { event: "Stop", dispatchToolUseID: "EDGE", branch: "x" },
            reasons: ["EDGE"],
            facts: {},
          },
        ],
      },
      signal(),
      frame,
    ),
    /unsupported producers/,
  );
});

test("only a pending Stop with continuation events commits a transition", async () => {
  const journal = await open();
  await user(journal);
  const frame = await journal.beginQueryFrame(recovery, signal());
  await assert.rejects(
    journal.commitLifecycleTransition(frame, silent, signal()),
    /not an owning Stop transition/,
  );
});

test("stop limits retain a max-turns attachment or a block-cap warning", async () => {
  const journal = await open();
  await user(journal);
  const state = { stopHookActive: false, blockingCount: 0 };
  const frame = await journal.beginQueryFrame(recovery, signal());
  await journal.recordStopLimit(
    { kind: "end", reason: "max-turns", state, nextTurn: 4 },
    3,
    signal(),
  );
  assert.equal(frame.revision, 1);
  await journal.recordStopLimit(
    { kind: "end", reason: "block-cap", state, warning: "EDGE_CAP" },
    3,
    signal(),
  );
  await journal.recordStopLimit(
    { kind: "end", reason: "completed", state },
    3,
    signal(),
  );
  const saved = await rows(journal);
  assert.equal(saved.length, 3);
  assert.match(JSON.stringify(saved[1]), /max_turns_reached/);
  assert.equal(saved[2]?.content, "EDGE_CAP");
  assert.equal(saved[2]?.level, "warning");
  await assert.rejects(
    journal.recordStopLimit(
      { kind: "end", reason: "block-cap", state },
      3,
      signal(),
    ),
    /lacks its actual warning/,
  );
});

test("a request without a frame projects every retained row", async () => {
  await assert.rejects(
    (await open()).projectRequest(profile()),
    /requires actual conversation/,
  );
  const journal = await open();
  await user(journal);
  await respond(journal, [{ type: "text", text: "EDGE_ANSWER" }]);
  await user(journal, "EDGE_FOLLOW_UP");
  const request = await journal.projectRequest(profile());
  assert.equal(request.queryFrame, undefined);
  assert.match(JSON.stringify(request.projection), /EDGE_ANSWER/);
  await assert.rejects(
    journal.projectRequest({ ...profile(), requestedModel: "" }),
    /requires actual current model/,
  );
});

test("an active frame owns the request and its recovery policy", async () => {
  const journal = await open();
  await user(journal);
  const frame = await journal.beginQueryFrame(recovery, signal());
  const request = await journal.projectRequest(profile());
  assert.equal(request.queryFrame?.revision, frame.revision);
  await assert.rejects(
    journal.projectRequest({
      ...profile(),
      recovery: { ...recovery, timestampFallback: "source-5s" },
    }),
    /recovery policy changed owner/,
  );
});

test("thinking from another model cannot be replayed to the requested model", async () => {
  const journal = await open();
  await user(journal);
  await respond(
    journal,
    [
      { type: "thinking", thinking: "EDGE", signature: "EDGE_SIG" },
      { type: "text", text: "EDGE" },
    ],
    "claude-opus-4-1",
  );
  await assert.rejects(
    journal.projectRequest(profile()),
    /Foreign-model native thinking/,
  );
  const same = await open();
  await user(same);
  await respond(same, [
    { type: "thinking", thinking: "EDGE", signature: "EDGE_SIG" },
    { type: "text", text: "EDGE" },
  ]);
  await user(same, "EDGE_FOLLOW_UP");
  assert.match(
    JSON.stringify((await same.projectRequest(profile())).projection),
    /EDGE_SIG/,
  );
});
