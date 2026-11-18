import assert from "node:assert/strict";
import { test, onTestFinished } from "bun:test";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
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
  serializeNativeSession,
  type NativeObject,
} from "../../src/native-session-codec.js";
import {
  materializeOrdinaryNativeResumeContext,
  selectOrdinaryNativeResumeHistory,
  type NativeResumeContextHost,
} from "../../src/native-resume-context.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import {
  openNativeSessionPersistence,
  type NativeSessionPersistenceOptions,
} from "../../src/native-session-persistence.js";
import { projectMessages } from "../../src/thinking-history.js";
const id = (n: number) =>
    `${String(n).padStart(8, "0")}-5555-5555-5555-555555555555`,
  SID = id(99),
  MODEL = "claude-sonnet-4-6",
  stamp = (n: number) => ({
    uuid: id(n),
    timestamp: `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z`,
  }),
  signal = () => new AbortController().signal;
const recovery = {
  callIdToolResults: true,
  descendantOrder: "depth-first",
  timestampFallback: "reject",
} as const;
const assistant = (
  n: number,
  text = "OWNED_FINAL",
  fields: NativeObject = {},
): NativePersistenceEvent => ({
  type: "assistant",
  ...stamp(n),
  apiBlockIndex: 0,
  message: {
    id: `owned-response-${n}`,
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 4, output_tokens: 2 },
    ...fields,
  },
});
const user = (n: number, text = "OWNED_PROMPT"): NativePersistenceEvent => ({
  type: "user",
  ...stamp(n),
  message: { role: "user", content: text },
});
const attachment = (n: number, payload: NativeObject) =>
  createNativeAttachmentEvent(payload, stamp(n));
const context = (n: number = 3) =>
  attachment(n, {
    type: "hook_additional_context",
    content: ["OWNED_STOP_CONTEXT"],
    hookName: "Stop",
    hookEvent: "Stop",
    toolUseID: id(90),
  });
const stopped = (n: number = 4) =>
  attachment(n, {
    type: "hook_stopped_continuation",
    message: "OWNED_STOPPED",
    hookName: "Stop",
    hookEvent: "Stop",
    toolUseID: id(90),
  });
const diagnostic = (n: number = 3) =>
  attachment(n, {
    type: "hook_non_blocking_error",
    stderr: "HIDDEN_DIAGNOSTIC",
    stdout: "",
    exitCode: 1,
    command: "owned",
    hookName: "Stop",
    hookEvent: "Stop",
    toolUseID: id(90),
  });
const warning = (n: number = 3) =>
  validateNativePersistenceEvent({
    type: "system",
    ...stamp(n),
    subtype: "informational",
    content: "OWNED_CAP_WARNING",
    level: "warning",
    isMeta: false,
  });
const snapshot = (n: number = 5, fields: NativeObject = {}) =>
  attachment(n, {
    type: "prompt_snapshot",
    systemPrompt: ["OWNED_SAVED_SYSTEM"],
    tools: [],
    reminderFold: false,
    systemTurns: false,
    ...fields,
  });
function rows(events: readonly NativeObject[], cwd = "/owned"): NativeObject[] {
  return events.map((event, index) => ({
    parentUuid: index ? (events[index - 1]?.uuid ?? null) : null,
    sessionId: SID,
    cwd,
    isSidechain: false,
    ...event,
  }));
}
const document = (values: readonly NativeObject[]) =>
  decodeNativeSession(encodeNativeSessionRows(values), {
    parser: "source-line-fallback",
  });
const host = (
  changes: Partial<NativeResumeContextHost> = {},
): NativeResumeContextHost => ({
  systemTurns: false,
  reminderFold: false,
  withoutAttachmentHooks: true,
  admit: () => true,
  ...changes,
});
const base = () => [user(1), assistant(2)];

test("completed lifecycle tails preserve the real terminal cursor, native-empty diagnostics and canonical visible context", async () => {
  const physical = rows([
      ...base(),
      diagnostic(3),
      context(4),
      stopped(5),
      warning(6),
      snapshot(7),
    ]),
    original = document([
      ...physical,
      { type: "last-prompt", sessionId: SID, leafUuid: id(7) },
    ]),
    before = serializeNativeSession(original),
    selected = selectOrdinaryNativeResumeHistory(original, recovery);
  assert.equal(selected.selectedLeaf.uuid, id(2));
  assert.equal(selected.terminalUuid, id(7));
  assert.deepEqual(
    selected.gateNodes.map((node) => node.uuid),
    physical.map((row) => row.uuid),
  );
  let resolved = 0;
  const admitted: string[] = [];
  const result = await materializeOrdinaryNativeResumeContext(original, {
    recovery,
    signal: signal(),
    host: (nodes) => {
      resolved++;
      assert.deepEqual(
        nodes.map((node) => node.uuid),
        physical.map((row) => row.uuid),
      );
      return host({
        admit: ({ uuid }) => {
          admitted.push(uuid);
          return true;
        },
      });
    },
  });
  assert.equal(resolved, 1);
  assert.deepEqual(admitted, [id(3), id(4), id(5), id(6), id(7)]);
  const wire = JSON.stringify(result.messages);
  assert.match(wire, /OWNED_STOP_CONTEXT/);
  assert.match(wire, /OWNED_STOPPED/);
  assert.equal(wire.includes("HIDDEN_DIAGNOSTIC"), false);
  assert.equal(wire.includes("OWNED_CAP_WARNING"), false);
  assert.deepEqual(serializeNativeSession(original), before);
});

test("each strict informational/lifecycle tail can complete without an invented prompt snapshot or assistant row", async () => {
  for (const tail of [
    diagnostic(),
    context(),
    stopped(3),
    warning(),
    attachment(3, {
      type: "hook_success",
      hookName: "Stop",
      hookEvent: "Stop",
      toolUseID: id(90),
      content: "",
      stdout: '{"continue":false}',
      stderr: "",
      exitCode: 0,
    }),
  ]) {
    const original = document(rows([...base(), tail]));
    const selected = selectOrdinaryNativeResumeHistory(original, recovery);
    assert.equal(selected.terminalUuid, id(3));
    const result = await materializeOrdinaryNativeResumeContext(original, {
      recovery,
      signal: signal(),
      host: host(),
    });
    assert.ok(result.messages.some((message) => message.role === "assistant"));
    assert.equal(
      selected.recovered.nodes.filter((node) => node.type === "assistant")
        .length,
      1,
    );
  }
});

test("max-turn absent and true markers follow source exact comparison while explicit false remains interrupted", () => {
  for (const marker of [undefined, true]) {
    const payload = {
      type: "max_turns_reached",
      maxTurns: 2,
      turnCount: 3,
      ...(marker === undefined ? {} : { exitCommitted: marker }),
    };
    const selected = selectOrdinaryNativeResumeHistory(
      document(rows([...base(), attachment(3, payload)])),
      recovery,
    );
    assert.equal(selected.terminalUuid, id(3));
  }
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(
          rows([
            ...base(),
            attachment(3, {
              type: "max_turns_reached",
              maxTurns: 2,
              turnCount: 3,
              exitCommitted: false,
            }),
          ]),
        ),
        recovery,
      ),
    /max-turn-interruption/,
  );
});

test("blank, thinking-only, synthetic, incomplete and virtual answers retain explicit unsupported boundaries", () => {
  const cases = [
    assistant(2, " "),
    assistant(2, "", {
      content: [
        { type: "thinking", thinking: "PRIVATE", signature: "owned-signature" },
      ],
    }),
    assistant(2, "VISIBLE", { model: "<synthetic>" }),
    assistant(2, "VISIBLE", { stop_reason: "tool_use" }),
  ];
  for (const final of cases)
    assert.throws(
      () =>
        selectOrdinaryNativeResumeHistory(
          document(rows([user(1), final, context()])),
          recovery,
        ),
      /lifecycle-answer/,
    );
  for (const marker of [
    { isVirtual: true },
    { isApiErrorMessage: true },
    { resumedFromIncompleteThinking: true },
    { interruptedByShutdown: true },
    { answeredWithoutRequest: true },
    { isVisibleInTranscriptOnly: true },
    { madeBy: "input" },
  ])
    assert.throws(
      () =>
        selectOrdinaryNativeResumeHistory(
          document(rows([user(1), { ...assistant(2), ...marker }, context()])),
          recovery,
        ),
      /lifecycle-recovery/,
    );
});

test("meta-user Stop feedback and restored-card/unresolved tool profiles are not attachment tails", () => {
  const feedback = {
    ...user(3, "Stop hook feedback:\nOWNED_BLOCK"),
    isMeta: true,
  };
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(rows([...base(), feedback, context(4)])),
        recovery,
      ),
    /lifecycle-answer/,
  );
  const call = assistant(2, "CALL", {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "pending",
          name: "Read",
          input: { file_path: "owned" },
        },
      ],
    }),
    final = assistant(3);
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(rows([user(1), call, final, context(4)])),
        recovery,
      ),
    /unresolved-calls/,
  );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(
          rows([
            ...base(),
            {
              ...context(),
              attachment: { type: "hook_deferred_tool", toolUseID: id(90) },
            },
          ]),
        ),
        recovery,
      ),
    /context-descendants/,
  );
});

test("settled ordinary tool history keeps actual result ownership; duplicate/orphan/human crossings reject", () => {
  const call = assistant(2, "CALL", {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: "owned" },
        },
      ],
    }),
    result: NativePersistenceEvent = {
      type: "user",
      ...stamp(3),
      sourceToolAssistantUUID: id(2),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "read", content: "OWNED_READ" },
        ],
      },
    };
  const physical = [user(1), call, result, assistant(4), context(5)];
  assert.equal(
    selectOrdinaryNativeResumeHistory(document(rows(physical)), recovery)
      .terminalUuid,
    id(5),
  );
  const orphan = {
    ...result,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "foreign", content: "WRONG" },
      ],
    },
  };
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(rows([user(1), call, orphan, assistant(4), context(5)])),
        recovery,
      ),
    /invalid-terminal-tool-result/,
  );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(
          rows([
            user(1),
            call,
            user(3, "HUMAN_CROSSING"),
            assistant(4),
            context(5),
          ]),
        ),
        recovery,
      ),
    /human-crosses-pending/,
  );
});

test("known tail payload/render roles and informational schemas validate; unknown types and changed context refuse", () => {
  const actual = context();
  for (const bad of [
    { ...actual, renderedRole: "user" },
    { ...actual, rendered: [{ content: "INVENTED" }] },
    {
      ...actual,
      attachment: {
        type: "hook_additional_context",
        hookName: "Stop",
        hookEvent: "Stop",
        toolUseID: id(90),
        content: ["TEXT"],
        unknown: true,
      },
    },
    { ...warning(), isMeta: true },
    { ...warning(), rendered: [{ content: "FAKE" }] },
  ])
    assert.throws(
      () =>
        selectOrdinaryNativeResumeHistory(
          document(rows([...base(), bad])),
          recovery,
        ),
      /invalid-terminal-lifecycle-event/,
    );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(
          rows([...base(), { ...warning(), subtype: "unknown-system" }]),
        ),
        recovery,
      ),
    /context-descendants/,
  );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document(rows([...base(), { ...actual, cwd: "/changed" }])),
        recovery,
      ),
    /lifecycle-context/,
  );
});

test("branch/scope/checkpoint/retraction and compaction protections remain unchanged", () => {
  const ordinary = rows([...base(), context(3)]);
  for (const extra of [
    {
      ...context(4),
      parentUuid: id(2),
      sessionId: SID,
      cwd: "/owned",
      isSidechain: false,
    },
    {
      ...context(4),
      parentUuid: id(3),
      sessionId: id(100),
      cwd: "/owned",
      isSidechain: false,
    },
    {
      ...context(4),
      parentUuid: id(3),
      sessionId: SID,
      cwd: "/owned",
      isSidechain: true,
    },
  ])
    assert.throws(
      () =>
        selectOrdinaryNativeResumeHistory(
          document([...ordinary, extra]),
          recovery,
        ),
      /context-descendants/,
    );
  for (const checkpoint of [
    { type: "last-prompt", leafUuid: id(2) },
    { type: "last-prompt", leafUuid: id(3), rewound: true },
    { type: "last-prompt", leafUuid: id(3), cutUuid: id(2) },
  ])
    assert.throws(
      () =>
        selectOrdinaryNativeResumeHistory(
          document([...ordinary, checkpoint]),
          recovery,
        ),
      /checkpoint/,
    );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document([
          ...ordinary,
          {
            type: "system",
            subtype: "compact_boundary",
            ...stamp(4),
            parentUuid: id(3),
            sessionId: SID,
          },
        ]),
        recovery,
      ),
    /retraction-or-compaction/,
  );
  assert.throws(
    () =>
      selectOrdinaryNativeResumeHistory(
        document([
          { ...ordinary[0], retractedMessageUuids: [id(2)] },
          ...ordinary.slice(1),
        ]),
        recovery,
      ),
    /retraction-or-compaction/,
  );
});

test("full terminal snapshots reach effective gates once; admission, projection gates and abort still fail locally", async () => {
  const snap = {
      ...snapshot(4),
      attachment: {
        type: "prompt_snapshot",
        systemPrompt: ["ACTUAL_LAST"],
        reminderFold: true,
      },
    },
    original = document(rows([...base(), context(3), snap]));
  let calls = 0;
  await assert.rejects(
    materializeOrdinaryNativeResumeContext(original, {
      recovery,
      signal: signal(),
      host: (nodes) => {
        calls++;
        assert.equal(nodes.at(-1)?.uuid, id(4));
        return host({ reminderFold: true });
      },
    }),
    /projection-gates/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    materializeOrdinaryNativeResumeContext(original, {
      recovery,
      signal: signal(),
      host: host({ admit: () => false }),
    }),
    /context-admission-denied/,
  );
  const aborted = new AbortController();
  aborted.abort(new Error("OWNED_TAIL_ABORT"));
  await assert.rejects(
    materializeOrdinaryNativeResumeContext(original, {
      recovery,
      signal: aborted.signal,
      host: host(),
    }),
    /OWNED_TAIL_ABORT/,
  );
});

test("real cold import and owning reopen preserve terminal lifecycle bytes, cursor and single context projection", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-tail-resume-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "owned.jsonl"),
    physical = rows(
      [...base(), diagnostic(3), context(4), stopped(5), warning(6)],
      cwd,
    ),
    bytes = encodeNativeSessionRows([
      ...physical,
      { type: "last-prompt", sessionId: SID, leafUuid: id(6) },
    ]);
  await writeFile(path, bytes);
  const imported = await importNativeSessionFile({
    path,
    cwd,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  const projection = JSON.stringify(projectMessages(imported.session.messages));
  assert.equal(projection.split("OWNED_STOP_CONTEXT").length, 2);
  assert.equal(projection.includes("HIDDEN_DIAGNOSTIC"), false);
  assert.equal(projection.includes("OWNED_CAP_WARNING"), false);
  assert.deepEqual(await readFile(path), Buffer.from(bytes));
  let tail = Promise.resolve();
  const options: NativeSessionPersistenceOptions = {
    path,
    context: {
      sessionId: SID,
      cwd,
      version: "2.1.326",
      entrypoint: "cli",
      userType: "external",
      sidechain: false,
    },
    initial: { kind: "owned-existing", cursorUuid: id(6) },
    admit: () => true,
    withExclusiveOwnership: async (_path, work) => {
      const prior = tail,
        next = Promise.withResolvers<void>();
      tail = next.promise;
      await prior;
      try {
        return await work();
      } finally {
        next.resolve();
      }
    },
  };
  const owner = await openNativeSessionPersistence(options, signal());
  await owner.appendEvents(
    [user(7, "OWNED_CONTINUATION"), assistant(8)],
    {},
    signal(),
  );
  await owner.close();
  assert.deepEqual(
    (await readFile(path)).subarray(0, bytes.length),
    Buffer.from(bytes),
  );
  const reopened = await importNativeSessionFile({
    path,
    cwd,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.equal(
    JSON.stringify(projectMessages(reopened.session.messages)).split(
      "OWNED_STOP_CONTEXT",
    ).length,
    2,
  );
});
