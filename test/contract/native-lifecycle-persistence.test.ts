import assert from "node:assert/strict";
import { test, onTestFinished } from "bun:test";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createNativeAttachmentEvent,
  validateNativePersistenceEvent,
  type NativePersistenceEvent,
} from "../../src/native-persistence-events.js";
import {
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  isNativeObject,
  type NativeObject,
} from "../../src/native-session-codec.js";
import {
  planNativeResumeContext,
  selectOrdinaryNativeResumeHistory,
  type NativeResumeContextHost,
} from "../../src/native-resume-context.js";
import {
  openNativeSessionPersistence,
  type NativeSessionPersistenceOptions,
} from "../../src/native-session-persistence.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import { projectMessages } from "../../src/thinking-history.js";

const id = (n: number) =>
  `${String(n).padStart(8, "0")}-2222-2222-2222-222222222222`;
const stamp = (n: number) => ({
  uuid: id(n),
  timestamp: `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z`,
});
const signal = () => new AbortController().signal;
const hook = (
  type: string,
  extra: NativeObject = {},
  event = "SessionStart",
) => ({
  type,
  hookName: event,
  hookEvent: event,
  toolUseID: event === "SessionStart" ? "SessionStart" : id(90),
  ...extra,
});
const event = (n: number, payload: unknown) =>
  createNativeAttachmentEvent(payload, stamp(n));
const host = (): NativeResumeContextHost => ({
  systemTurns: false,
  reminderFold: false,
  withoutAttachmentHooks: true,
  admit: () => true,
});
const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;

test("strict native lifecycle DTOs retain physical diagnostics while exact source renderers distinguish model-visible and empty rows", () => {
  const success = event(
    1,
    hook("hook_success", {
      content: "OWNED</system-reminder>BODY",
      stdout: "RAW",
      stderr: "",
      exitCode: 0,
      command: "owned",
      durationMs: 4,
    }),
  );
  assert.deepEqual(success.rendered, [
    {
      content: wrap(
        "SessionStart hook success: OWNED&lt;/system-reminder>BODY",
      ),
    },
  ]);
  const stopped = event(
    2,
    hook("hook_stopped_continuation", { message: "OWNED_STOP" }, "Stop"),
  );
  assert.deepEqual(stopped.rendered, [
    { content: wrap("Stop hook stopped continuation: OWNED_STOP") },
  ]);
  const blocked = event(
    3,
    hook(
      "hook_blocking_error",
      {
        blockingError: {
          command: "OWNED_COMMAND",
          blockingError: "OWNED_BLOCK",
        },
      },
      "Stop",
    ),
  );
  assert.deepEqual(blocked.rendered, [
    {
      content: wrap(
        'Stop hook blocking error from command: "OWNED_COMMAND": OWNED_BLOCK',
      ),
    },
  ]);
  for (const [type, fields] of [
    [
      "hook_system_message",
      { content: "DIAGNOSTIC_ONLY", heldForServedCall: false },
    ],
    [
      "hook_non_blocking_error",
      {
        stderr: "DIAGNOSTIC_ONLY",
        stdout: "RAW",
        exitCode: 2,
        command: "owned",
        durationMs: 4,
      },
    ],
    [
      "hook_error_during_execution",
      { content: "DIAGNOSTIC_ONLY", command: "owned", durationMs: 4 },
    ],
    ["hook_cancelled", { command: "owned", timedOut: true, timeoutMs: 3000 }],
  ] satisfies [string, NativeObject][]) {
    const row = event(4, hook(type, fields));
    assert.equal(row.rendered, undefined);
    assert.equal(row.renderedRole, undefined);
    assert.ok(isNativeObject(row.attachment));
    assert.equal(row.attachment.type, type);
    assert.throws(() =>
      validateNativePersistenceEvent({
        ...row,
        rendered: [{ content: "FAKE" }],
        renderedRole: "system",
      }),
    );
  }
  const stopSuccess = event(
    5,
    hook("hook_success", { content: "STOP_STDOUT" }, "Stop"),
  );
  assert.equal(stopSuccess.rendered, undefined);
  const prompt = event(
    6,
    hook(
      "hook_additional_context",
      { content: ["OWNED_PROMPT_CONTEXT"], toolUseID: `hook-${id(99)}` },
      "UserPromptSubmit",
    ),
  );
  assert.deepEqual(prompt.rendered, [
    {
      content: wrap(
        "UserPromptSubmit hook additional context: OWNED_PROMPT_CONTEXT",
      ),
    },
  ]);
});

test("unknown lifecycle keys, transport metadata and fabricated rendered-role provenance still reject", () => {
  assert.throws(() =>
    event(1, hook("hook_success", { content: "TEXT", unknown: true })),
  );
  assert.throws(() =>
    event(
      1,
      hook("hook_non_blocking_error", {
        stderr: "ERR",
        stdout: "",
        exitCode: "2",
      }),
    ),
  );
  assert.throws(() =>
    event(
      1,
      hook("hook_blocking_error", {
        blockingError: {
          command: "c",
          blockingError: "e",
          promptEnding: { reason: "held" },
        },
      }),
    ),
  );
  assert.throws(() =>
    event(
      1,
      hook(
        "hook_additional_context",
        { content: ["TEXT"], hookName: "prompt.mention" },
        "UserPromptSubmit",
      ),
    ),
  );
  const row = event(1, hook("hook_success", { content: "TEXT" }));
  assert.throws(() =>
    validateNativePersistenceEvent({ ...row, renderedRole: "user" }),
  );
  assert.throws(() =>
    validateNativePersistenceEvent({
      ...row,
      rendered: [{ content: "OTHER" }],
    }),
  );
});

test("cold context validates empty lifecycle payloads instead of silently stripping metadata, with admission/error boundaries intact", async () => {
  const rows = [
    event(1, hook("hook_system_message", { content: "EMPTY_MODEL_CONTEXT" })),
    event(2, hook("hook_success", { content: "VISIBLE_START" })),
    event(
      3,
      hook("hook_stopped_continuation", { message: "VISIBLE_STOP" }, "Stop"),
    ),
  ].map((row, index) => ({
    ...row,
    parentUuid: index ? id(index) : null,
    sessionId: id(99),
    cwd: "/owned",
  }));
  const document = decodeNativeSession(encodeNativeSessionRows(rows), {
    parser: "source-line-fallback",
  });
  const nodes = [...indexNativeSession(document).nodes.values()];
  const planned = await planNativeResumeContext(nodes, host(), signal());
  assert.deepEqual(
    planned.map((value) => value.destination),
    ["none", "user-context", "user-context"],
  );
  assert.equal(planned[0]?.source, "native-empty");
  assert.ok(JSON.stringify(planned).includes("EMPTY_MODEL_CONTEXT"));
  const corrupt = nodes.map((node, index) =>
    index
      ? node
      : {
          ...node,
          row: {
            ...node.row,
            attachment: hook("hook_system_message", {
              content: "X",
              unknown: true,
            }),
          },
        },
  );
  await assert.rejects(
    planNativeResumeContext(corrupt, host(), signal()),
    /invalid-recorded-attachment/,
  );
  let admissions = 0;
  await assert.rejects(
    planNativeResumeContext(
      nodes,
      {
        ...host(),
        admit: () => {
          admissions++;
          return false;
        },
      },
      signal(),
    ),
    /context-admission-denied/,
  );
  assert.equal(admissions, 1);
  const controller = new AbortController();
  controller.abort(new Error("OWNED_CONTEXT_ABORT"));
  await assert.rejects(
    planNativeResumeContext(nodes, host(), controller.signal),
    /OWNED_CONTEXT_ABORT/,
  );
});

test("real owned append/checkpoint/reimport/reopen preserves all lifecycle rows and old file prefix without exposing empty diagnostics", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-lifecycle-persist-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "owned.jsonl");
  let tail = Promise.resolve();
  const options: NativeSessionPersistenceOptions = {
    path,
    context: {
      sessionId: id(99),
      cwd,
      version: "2.1.326",
      entrypoint: "cli",
      userType: "external",
      sidechain: false,
    },
    initial: { kind: "fresh" },
    admit: () => true,
    withExclusiveOwnership: async (_path, work) => {
      const previous = tail,
        next = Promise.withResolvers<void>();
      tail = next.promise;
      await previous;
      try {
        return await work();
      } finally {
        next.resolve();
      }
    },
  };
  const owner = await openNativeSessionPersistence(options, signal());
  const prompt: NativePersistenceEvent = {
    type: "user",
    ...stamp(1),
    message: { role: "user", content: "OWNED_PROMPT" },
  };
  const answer: NativePersistenceEvent = {
    type: "assistant",
    ...stamp(4),
    apiBlockIndex: 0,
    message: {
      id: "owned-response",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "OWNED_ANSWER" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  };
  await owner.appendEvents(
    [
      prompt,
      event(
        2,
        hook("hook_success", {
          content: "OWNED_START_STDOUT",
          stdout: "OWNED_START_STDOUT",
          stderr: "",
          exitCode: 0,
        }),
      ),
      event(
        3,
        hook("hook_additional_context", { content: ["OWNED_START_CONTEXT"] }),
      ),
      answer,
    ],
    { promptId: "owned-prompt" },
    signal(),
  );
  const prefix = await readFile(path);
  await owner.appendEvents(
    [
      event(
        5,
        hook(
          "hook_non_blocking_error",
          { stderr: "HIDDEN_ERROR", stdout: "", exitCode: 1 },
          "Stop",
        ),
      ),
      event(
        6,
        hook(
          "hook_additional_context",
          { content: ["OWNED_STOP_CONTEXT"] },
          "Stop",
        ),
      ),
      {
        type: "assistant",
        ...stamp(7),
        apiBlockIndex: 0,
        message: {
          id: "owned-continuation-response",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "OWNED_STOP_CONTINUATION" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
      event(8, {
        type: "prompt_snapshot",
        systemPrompt: ["OWNED_SYSTEM"],
        tools: [],
        reminderFold: false,
        echoWireToolInputs: false,
        systemTurns: false,
        inlineTools: false,
        keptReminders: false,
        projectDocsAsDocuments: false,
      }),
    ],
    {},
    signal(),
  );
  await owner.close();
  const bytes = await readFile(path);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  const stored = decodeNativeSession(bytes, {
    parser: "source-line-fallback",
  }).lines.flatMap((line) => (isNativeObject(line.value) ? [line.value] : []));
  assert.ok(
    stored.some(
      (row) =>
        isNativeObject(row.attachment) &&
        row.attachment.type === "hook_non_blocking_error",
    ),
  );
  assert.equal(stored.at(-1)?.leafUuid, id(8));
  const imported = await importNativeSessionFile({
    path,
    cwd,
    model: "claude-sonnet-4-6",
    signal: signal(),
    env: {},
  });
  const wire = JSON.stringify(projectMessages(imported.session.messages));
  for (const text of [
    "OWNED_START_STDOUT",
    "OWNED_START_CONTEXT",
    "OWNED_ANSWER",
    "OWNED_STOP_CONTEXT",
  ])
    assert.ok(wire.includes(text), text);
  assert.equal(wire.includes("HIDDEN_ERROR"), false);
  const reopened = await openNativeSessionPersistence(
    { ...options, initial: { kind: "owned-existing", cursorUuid: id(8) } },
    signal(),
  );
  await reopened.appendEvents(
    [
      {
        type: "user",
        ...stamp(9),
        message: { role: "user", content: "OWNED_CONTINUATION" },
      },
    ],
    {},
    signal(),
  );
  await reopened.close();
  assert.deepEqual((await readFile(path)).subarray(0, bytes.length), bytes);
});

test("thinking-only terminal lifecycle replies require the actual invisible-reply resume adapter", () => {
  const physical: NativePersistenceEvent[] = [
    {
      type: "user",
      ...stamp(1),
      message: { role: "user", content: "OWNED_PROMPT" },
    },
    {
      type: "assistant",
      ...stamp(2),
      apiBlockIndex: 0,
      message: {
        id: "owned-final",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            thinking: "OWNED_PRIVATE_THINKING",
            signature: "owned-signature",
            type: "thinking",
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    event(
      3,
      hook("hook_stopped_continuation", { message: "ACTUAL_STOPPED" }, "Stop"),
    ),
  ];
  const document = decodeNativeSession(
    encodeNativeSessionRows([
      ...physical.map((row, index) => ({
        ...row,
        parentUuid: index ? id(index) : null,
        sessionId: id(99),
        cwd: "/owned",
        isSidechain: false,
      })),
      { type: "last-prompt", leafUuid: id(3), sessionId: id(99) },
    ]),
    { parser: "source-line-fallback" },
  );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(document, {
        callIdToolResults: true,
        descendantOrder: "depth-first",
        timestampFallback: "reject",
      }),
    /unsupported-terminal-lifecycle-answer/,
  );
});
