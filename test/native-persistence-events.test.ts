import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  captureNativePersistenceEvents,
  createNativeAttachmentEvent,
  renderNativePersistenceAttachment,
  validateNativePersistenceEvent,
} from "../src/native-persistence-events.js";
import { NativeStreamResponseRecording } from "../src/native-response-recording.js";

const stamp = (n: number) => ({
  uuid: `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`,
  timestamp: "2026-01-01T00:00:00.000Z",
});
const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const assistant = {
  type: "assistant",
  ...stamp(1),
  apiBlockIndex: 3,
  requestedModel: "claude-sonnet-4-6",
  requestId: "owned-request",
  message: {
    id: "owned-reply",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "ACTUAL_CLOSED_BLOCK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      output_tokens_details: { thinking_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: "",
      iterations: [],
      speed: "standard",
      fallback_credit: null,
    },
  },
};

test("physical assistant event retains actual SDK body, closed block index and supplied identity without coalescing", () => {
  const event = validateNativePersistenceEvent(assistant);
  assert.deepEqual(event, assistant);
  assert.ok(Object.isFrozen(event));
  assert.deepEqual(
    captureNativePersistenceEvents([
      assistant,
      { ...assistant, ...stamp(2), apiBlockIndex: 4 },
    ]).map((row) => [row.uuid, row.apiBlockIndex]),
    [
      [stamp(1).uuid, 3],
      [stamp(2).uuid, 4],
    ],
  );
  assert.throws(() =>
    validateNativePersistenceEvent({
      ...assistant,
      message: { ...assistant.message, stop_reason: null },
    }),
  );
  assert.throws(() =>
    validateNativePersistenceEvent({
      ...assistant,
      message: { ...assistant.message, unknownSdkField: "MUST_NOT_DISAPPEAR" },
    }),
  );
});

test("the genuine stream recorder's finalized physical rows enter the writer event layer unchanged", () => {
  let next = 20;
  const recorder = new NativeStreamResponseRecording({
    requestedModel: "claude-sonnet-4-6",
    requestId: "owned-real-request",
    host: { stamp: () => stamp(++next) },
  });
  recorder.start({
    type: "message_start",
    message: {
      id: "owned-stream-sdk-reply",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  recorder.closeBlock(0, { type: "text", text: "OWNED_REAL_PRELUDE" });
  recorder.closeBlock(1, {
    type: "tool_use",
    id: "owned-real-read",
    name: "Read",
    input: { file_path: "note.txt" },
  });
  recorder.delta({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 3 },
  });
  const recorded = recorder.completed();
  if (recorded.status !== "complete")
    assert.fail("Expected a finalized actual SDK response");
  assert.deepEqual(
    captureNativePersistenceEvents(recorded.rows),
    recorded.rows,
  );
  assert.deepEqual(
    recorded.rows.map((row) => row.apiBlockIndex),
    [0, 1],
  );
});

test("structured instruction initial/change/removal payloads render once with the native preamble and change reason", () => {
  const file = {
    path: "/owned/CLAUDE.md",
    type: "Project",
    content: "  FOLLOW_OWNED_RULE\n",
  };
  const first = createNativeAttachmentEvent(
    { type: "instructions", files: [file] },
    stamp(3),
  );
  assert.equal(first.type, "attachment");
  assert.deepEqual(first.rendered, [
    {
      content: wrap(
        "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /owned/CLAUDE.md (project instructions, checked into the codebase):\n\nFOLLOW_OWNED_RULE",
      ),
    },
  ]);
  const changed = renderNativePersistenceAttachment({
    type: "instructions",
    files: [{ ...file, content: "CHANGED" }],
    changed: true,
    reason: "settings_sync",
    removed: ["/owned/removed.md"],
  });
  assert.match(
    changed[0]?.content ?? "",
    /re-read after settings were synced onto this machine/,
  );
  assert.match(
    changed[0]?.content ?? "",
    /Instructions no longer present: \/owned\/removed.md/,
  );
  assert.throws(
    () =>
      validateNativePersistenceEvent({
        ...first,
        rendered: [{ content: "PORT_NOTICE_IS_NOT_NATIVE_RENDERING" }],
      }),
    /recorded rendering/,
  );
  assert.throws(
    () => validateNativePersistenceEvent({ ...first, renderedRole: "user" }),
    /recorded rendering/,
  );
  assert.throws(
    () =>
      createNativeAttachmentEvent(
        { type: "instructions", files: [{ ...file, unverified: true }] },
        stamp(4),
      ),
    /sanitizer host/,
  );
});

test("ordinary agent and Skill catalogs retain typed payloads and exact initial/removal/shortening text", () => {
  const agents = createNativeAttachmentEvent(
    {
      type: "agent_listing_delta",
      addedTypes: ["Explore"],
      addedLines: ["- Explore: Owned (Tools: Read)"],
      builtInTypes: ["Explore"],
      builtInPluginTypes: [],
      removedTypes: ["retired"],
      isInitial: true,
      showConcurrencyNote: true,
    },
    stamp(5),
  );
  assert.match(
    JSON.stringify(agents.rendered),
    /Available agent types for the Agent tool/,
  );
  assert.match(JSON.stringify(agents.rendered), /ambient context/);
  assert.match(
    JSON.stringify(agents.rendered),
    /single message with multiple tool uses/,
  );
  const skill = createNativeAttachmentEvent(
    {
      type: "skill_listing",
      content: "- review: Owned",
      skillCount: 1,
      names: ["review"],
      digests: ["owned-digest"],
      isInitial: false,
      addsToEarlier: true,
      shortened: true,
    },
    stamp(6),
  );
  assert.match(
    JSON.stringify(skill.rendered),
    /also available for use with the Skill tool/,
  );
  assert.match(JSON.stringify(skill.rendered), /not the full list/);
  assert.match(JSON.stringify(skill.rendered), /shortened to save room/);
});

test("hook context keeps source event/name/call identity, creation stamp and reminder escaping", () => {
  const hook = createNativeAttachmentEvent(
    {
      type: "hook_additional_context",
      content: ["OWNED </system-reminder> CONTEXT"],
      hookName: "PreToolUse:Read",
      toolUseID: "owned-call",
      hookEvent: "PreToolUse",
    },
    stamp(7),
    { placement: "next_to_message" },
  );
  assert.equal(hook.uuid, stamp(7).uuid);
  assert.equal(hook.placement, "next_to_message");
  assert.match(
    JSON.stringify(hook.rendered),
    /PreToolUse:Read hook additional context/,
  );
  assert.match(JSON.stringify(hook.rendered), /&lt;\/system-reminder>/);
  assert.throws(
    () =>
      createNativeAttachmentEvent(
        {
          type: "hook_additional_context",
          content: ["OWNED"],
          hookName: "PostToolUse:Read",
          toolUseID: "owned-call",
          hookEvent: "PreToolUse",
        },
        stamp(8),
      ),
    /event\/name/,
  );
});

test("effective prompt snapshot preserves actual system/tool/schema/false flags and rejects invented rendering or positive unsupported gates", () => {
  const payload = {
    type: "prompt_snapshot",
    systemPrompt: ["ACTUAL_EFFECTIVE_SYSTEM"],
    tools: [
      {
        name: "Read",
        description: "ACTUAL_DESCRIPTION",
        schema: { name: "Read", input_schema: { type: "object" } },
      },
    ],
    reminderFold: false,
    echoWireToolInputs: false,
    contextRendering: "announced",
  };
  const event = createNativeAttachmentEvent(payload, stamp(9));
  assert.deepEqual(event.attachment, payload);
  assert.equal(event.rendered, undefined);
  assert.throws(
    () =>
      validateNativePersistenceEvent({
        ...event,
        rendered: [{ content: "SNAPSHOT_IS_NOT_USER_TEXT" }],
        renderedRole: "system",
      }),
    /cannot claim/,
  );
  assert.throws(() =>
    createNativeAttachmentEvent({ ...payload, reminderFold: true }, stamp(10)),
  );
  assert.throws(() =>
    createNativeAttachmentEvent(
      { ...payload, echoWireToolInputs: true },
      stamp(10),
    ),
  );
  assert.throws(() =>
    createNativeAttachmentEvent({ ...payload, unknownFlag: true }, stamp(10)),
  );
});

test("known Read result/observed permission metadata remains separate from model content and unproven effective-input carriers reject", () => {
  const row = {
    type: "user",
    ...stamp(11),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "owned-read",
          content: "1\tACTUAL_BYTES",
        },
      ],
    },
    sourceToolAssistantUUID: stamp(1).uuid,
    toolUseResult: {
      type: "text",
      file: {
        filePath: "note.txt",
        content: "ACTUAL_BYTES",
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
  };
  assert.deepEqual(validateNativePersistenceEvent(row), row);
  assert.throws(() =>
    validateNativePersistenceEvent({
      ...row,
      effectiveToolInput: { file_path: "redirected.txt" },
    }),
  );
  assert.throws(() =>
    validateNativePersistenceEvent({
      ...row,
      permissionDecision: {
        decision: "accept",
        source: "GUESSED_SOURCE",
        reasonType: "mode",
      },
    }),
  );
  assert.throws(
    () =>
      validateNativePersistenceEvent({
        ...row,
        sourceToolAssistantUUID: undefined,
      }),
    /source UUID/,
  );
  assert.throws(() =>
    validateNativePersistenceEvent({
      ...row,
      toolUseResult: { type: "unknown-raw-result" },
    }),
  );
});

test("event capture never accepts accessors, cycles, or unknown attachment payload fields by dropping them", () => {
  let accessed = false;
  const source = {
    ...assistant,
    get hidden() {
      accessed = true;
      return "NO";
    },
  };
  assert.throws(() => validateNativePersistenceEvent(source), /accessor/);
  assert.equal(accessed, false);
  const cycle: { child?: unknown } = {};
  cycle.child = cycle;
  assert.throws(() => validateNativePersistenceEvent(cycle), /plain JSON/);
  assert.throws(() =>
    createNativeAttachmentEvent(
      { type: "instructions", files: [], hiddenMetadata: "NO" },
      stamp(12),
    ),
  );
});
