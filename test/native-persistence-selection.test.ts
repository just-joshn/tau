import assert from "node:assert/strict";
import { test, onTestFinished } from "bun:test";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyNativePersistenceRow,
  selectNativePersistenceRows,
  type NativePersistenceSelectionInput,
  type NativePersistenceSelectionHost,
} from "../src/native-persistence-selection.js";
import {
  createNativeAttachmentEvent,
  captureNativePersistenceEvents,
  type NativePersistenceEvent,
} from "../src/native-persistence-events.js";
import {
  decodeNativeSession,
  isNativeObject,
  type NativeObject,
} from "../src/native-session-codec.js";
import {
  openNativeSessionPersistence,
  type NativeSessionPersistenceOptions,
} from "../src/native-session-persistence.js";
import type { NativePromptFact } from "../src/native-prompt-snapshot.js";
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-3333-3333-3333-333333333333`;
const row = (
  type: string,
  n: number,
  fields: NativeObject = {},
): NativeObject => ({ type, uuid: id(n), ...fields });
const assistant = (
  n: number,
  content: NativeObject[],
  fields: NativeObject = {},
) =>
  row("assistant", n, { message: { role: "assistant", content }, ...fields });
const user = (
  n: number,
  content: NativeObject[] | string,
  fields: NativeObject = {},
) => row("user", n, { message: { role: "user", content }, ...fields });
const hook = (n: number, type: string, fields: NativeObject = {}) =>
  row("attachment", n, { attachment: { type, ...fields } });
const host: NativePersistenceSelectionHost = {
  original: () => known(undefined),
};
const options = (
  rows: readonly NativeObject[],
  changes: Partial<NativePersistenceSelectionInput> = {},
): NativePersistenceSelectionInput => ({
  rows,
  userType: known("external"),
  evalFeature: known(false),
  sessionCodeMode: known(false),
  toolResults: { kind: "derive", context: rows },
  ...changes,
});
const selected = (
  rows: readonly NativeObject[],
  changes: Partial<NativePersistenceSelectionInput> = {},
  owner: NativePersistenceSelectionHost = host,
) => {
  const result = selectNativePersistenceRows(options(rows, changes), owner);
  if (result.status !== "selected") throw new Error(result.reasons.join("; "));
  return result;
};
const text = { type: "text", text: "OWNED_TEXT" };

test("complete OE distinguishes empty plain success, structured stdout, diagnostics, system/UI rows and explicit persist flags", () => {
  assert.deepEqual(
    classifyNativePersistenceRow(
      hook(1, "hook_success", { content: "", stdout: " \n", stderr: "\t" }),
    ),
    { keep: false, reason: "empty-hook-success" },
  );
  for (const fields of [
    { content: "", stdout: '{"hookSpecificOutput":{}}', stderr: "" },
    { content: "", stdout: "", stderr: "OWNED_STDERR" },
    { content: "OWNED_CONTENT", stdout: "", stderr: "" },
  ])
    assert.deepEqual(
      classifyNativePersistenceRow(hook(2, "hook_success", fields)),
      { keep: true },
    );
  assert.deepEqual(
    classifyNativePersistenceRow(
      hook(3, "hook_non_blocking_error", { stdout: "", stderr: "" }),
    ),
    { keep: true },
  );
  assert.deepEqual(classifyNativePersistenceRow(row("progress", 4)), {
    keep: false,
    reason: "progress",
  });
  assert.deepEqual(
    classifyNativePersistenceRow(
      row("system", 5, {
        subtype: "informational",
        content: "UI",
        isDisplayOnly: true,
        isMeta: true,
      }),
    ),
    { keep: true },
  );
  assert.deepEqual(
    classifyNativePersistenceRow(row("system", 5, { persist: false })),
    { keep: false, reason: "persist-false" },
  );
  assert.deepEqual(
    classifyNativePersistenceRow(
      hook(6, "unknown_future_attachment", { content: "" }),
    ),
    { keep: true },
  );
  assert.deepEqual(
    classifyNativePersistenceRow(
      row("unknown_future_row", 7, { opaque: { owned: 42 } }),
    ),
    { keep: true },
  );
});

test("laptop memory exclusion is source exact, including absent content versus null", () => {
  for (const type of ["cowork_memory_context", "account_memory_recall"]) {
    for (const content of [undefined, "", { text: "DATA" }])
      assert.deepEqual(
        classifyNativePersistenceRow(
          hook(1, type, {
            leg: "laptop",
            ...(content === undefined ? {} : { content }),
          }),
        ),
        { keep: false, reason: "laptop-memory-context" },
      );
    assert.deepEqual(
      classifyNativePersistenceRow(
        hook(2, type, { leg: "laptop", content: null }),
      ),
      { keep: true },
    );
    assert.deepEqual(
      classifyNativePersistenceRow(
        hook(3, type, { leg: "server", content: "RETAINED" }),
      ),
      { keep: true },
    );
  }
});

test("OE precedes actual original-row restoration and unsent-media cleanup; missing originals never come from display text", () => {
  const restored = user(1, [
      {
        type: "tool_result",
        tool_use_id: "owned",
        content: [
          { type: "image", source: { type: "base64", data: "unsent:owned" } },
          { type: "text", text: "KEEP" },
        ],
      },
    ]),
    source = user(1, "CURRENT_DISPLAY");
  let calls = 0;
  const result = selected(
    [source],
    {},
    {
      original: (value, index) => {
        calls++;
        assert.ok(Object.isFrozen(value));
        assert.equal(index, 0);
        return known(restored);
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.decisions[0]?.originalRowRestored, true);
  assert.equal(result.decisions[0]?.unsentMediaReplaced, true);
  assert.ok(
    JSON.stringify(result.rows).includes("[media removed: request limit."),
  );
  assert.equal(JSON.stringify(result.rows).includes("unsent:owned"), false);
  assert.equal(JSON.stringify(result.rows).includes("CURRENT_DISPLAY"), false);
  assert.ok(JSON.stringify(restored).includes("unsent:owned"));
  const missing = selectNativePersistenceRows(options([source]), {
    original: () => ({
      status: "unsupported",
      reason: "actual mM carrier unknown",
    }),
  });
  assert.equal(missing.status, "unsupported");
  assert.match(JSON.stringify(missing), /CURRENT_DISPLAY/);
  assert.equal(
    selected(
      [hook(2, "hook_success", { content: "", stdout: "" })],
      {},
      {
        original: () => {
          throw new Error("OE must precede mM");
        },
      },
    ).rows.length,
    0,
  );
  assert.deepEqual(
    selected([source], {}, { original: () => known(user(9, "WRONG_ID")) })
      .rows[0]?.message,
    source.message,
  );
});

test("fir removes actual REPL calls/results using full-history IDs and keeps unrelated tools and unknown metadata", () => {
  const history = [
    assistant(1, [
      { type: "tool_use", name: "REPL", id: "hidden-call", input: {} },
    ]),
  ];
  const rows = [
    assistant(
      2,
      [
        { type: "tool_use", name: "REPL", id: "hidden-call", input: {} },
        {
          type: "tool_use",
          name: "Read",
          id: "read",
          input: { file_path: "owned" },
        },
        text,
      ],
      { extra: { full: "metadata" } },
    ),
    user(3, [
      { type: "tool_result", tool_use_id: "hidden-call", content: "HIDDEN" },
      { type: "tool_result", tool_use_id: "read", content: "VISIBLE" },
    ]),
    row("unknown_future_row", 4, { nativeUnknown: { kept: true } }),
  ];
  const result = selected(rows, {
    toolResults: { kind: "derive", context: history },
  });
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.decisions[0]?.removedToolCalls, ["hidden-call"]);
  assert.deepEqual(result.decisions[1]?.removedToolResults, ["hidden-call"]);
  assert.ok(JSON.stringify(result.rows).includes("VISIBLE"));
  assert.equal(JSON.stringify(result.rows).includes("HIDDEN"), false);
  assert.deepEqual(result.rows[0]?.extra, { full: "metadata" });
  assert.deepEqual(result.rows[2]?.nativeUnknown, { kept: true });
  const actual = selected(
    [
      user(5, [
        {
          type: "tool_result",
          tool_use_id: "historical",
          content: "SOURCE_SET",
        },
      ]),
    ],
    { toolResults: { kind: "actual-set", ids: ["historical"] } },
  );
  assert.deepEqual(actual.rows, []);
  assert.equal(actual.decisions[0]?.disposition, "empty-user");
  assert.equal(
    selected([
      assistant(
        6,
        [{ type: "tool_use", id: "input-call", name: "REPL", input: {} }],
        { madeBy: "input" },
      ),
    ]).rows.length,
    1,
  );
});

test("ant and actual code-mode fast paths bypass fir, while Eval and missing gates retain source conditional semantics", () => {
  const call = assistant(1, [
    { type: "tool_use", name: "Eval", id: "eval", input: {} },
  ]);
  assert.equal(selected([call]).rows.length, 1);
  assert.equal(
    selected([call], {
      evalFeature: known(true),
      sessionCodeMode: known(false),
    }).rows.length,
    0,
  );
  assert.equal(
    selected([call], { evalFeature: known(true), sessionCodeMode: known(true) })
      .rows.length,
    1,
  );
  const unknown: NativePromptFact<boolean> = {
    status: "unsupported",
    reason: "actual feature unknown",
  };
  assert.equal(
    selected(
      [
        assistant(2, [
          { type: "tool_use", name: "REPL", id: "repl", input: {} },
        ]),
      ],
      {
        userType: known("ant"),
        evalFeature: unknown,
        sessionCodeMode: unknown,
      },
    ).rows.length,
    1,
  );
  assert.equal(
    selectNativePersistenceRows(options([call], { evalFeature: unknown }), host)
      .status,
    "unsupported",
  );
});

test("virtual preservation follows actual Pet, resume state and _4r ranges rather than broad UI stripping", () => {
  const rows = [
      assistant(1, [text], { isVirtual: true }),
      user(2, "USER", { isVirtual: true }),
      user(3, "META", { isMeta: true, isVirtual: true }),
      hook(4, "unknown_context", { content: "UNKNOWN" }),
      row("system", 5, { isVirtual: true }),
      assistant(6, [text], { isVirtual: true, virtualInResumeRun: true }),
    ],
    result = selected(rows);
  assert.equal(result.rows[0]?.isVirtual, undefined);
  assert.equal(result.rows[1]?.isVirtual, undefined);
  assert.equal(result.rows[2]?.isVirtual, true);
  assert.equal(result.rows[4]?.isVirtual, undefined);
  assert.equal(result.rows[5]?.isVirtual, true);
  const resumed = [
    assistant(7, [text], {
      isVirtual: true,
      resumedFromIncompleteThinking: true,
    }),
    user(8, "RANGE", { isVirtual: true }),
  ];
  assert.equal(
    selectNativePersistenceRows(options(resumed), host).status,
    "unsupported",
  );
  const protectedRows = selected(
    resumed,
    {},
    {
      ...host,
      incompleteThinkingRanges: (values) => {
        assert.ok(Object.isFrozen(values));
        return known([{ fromIdx: 0, toIdx: 1 }]);
      },
    },
  );
  assert.equal(protectedRows.rows[0]?.isVirtual, true);
  assert.equal(protectedRows.rows[1]?.isVirtual, true);
  assert.equal(
    selectNativePersistenceRows(options(resumed), {
      ...host,
      incompleteThinkingRanges: () => known([{ fromIdx: 0, toIdx: 99 }]),
    }).status,
    "unsupported",
  );
});

test("selection snapshots callback inputs, refuses accessors and reports malformed native input explicitly", () => {
  const original = user(1, "ORIGINAL"),
    result = selected(
      [original],
      {},
      {
        original: (value) => {
          assert.ok(Object.isFrozen(value));
          assert.throws(() =>
            Object.assign(value, {
              message: { role: "user", content: "MUTATED" },
            }),
          );
          return known(undefined);
        },
      },
    );
  assert.deepEqual(result.rows[0]?.message, original.message);
  let getter = false;
  assert.throws(
    () =>
      selectNativePersistenceRows(
        options([
          {
            type: "attachment",
            uuid: id(2),
            get attachment() {
              getter = true;
              return { type: "hook_success", content: "" };
            },
          },
        ]),
        host,
      ),
    /accessor/,
  );
  assert.equal(getter, false);
  assert.equal(
    selectNativePersistenceRows(
      options([row("attachment", 3, { attachment: null })]),
      host,
    ).status,
    "unsupported",
  );
});

test("fresh first conversation inherits last surviving startup UUID with no empty-success cursor and immutable owned bytes", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-source-persistence-selection-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "owned.jsonl"),
    stamp = (n: number) => ({
      uuid: id(n),
      timestamp: `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z`,
    });
  const success = createNativeAttachmentEvent(
      {
        type: "hook_success",
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        toolUseID: id(90),
        content: "",
        stdout: " \n",
        stderr: "",
      },
      stamp(1),
    ),
    diagnostic = createNativeAttachmentEvent(
      {
        type: "hook_non_blocking_error",
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        toolUseID: id(91),
        stderr: "",
        stdout: "",
        exitCode: 2,
      },
      stamp(2),
    ),
    context = createNativeAttachmentEvent(
      {
        type: "hook_additional_context",
        hookName: "SessionStart",
        hookEvent: "SessionStart",
        toolUseID: "SessionStart",
        content: ["OWNED_STARTUP"],
      },
      stamp(3),
    );
  const prompt: NativePersistenceEvent = {
      type: "user",
      ...stamp(4),
      message: { role: "user", content: "OWNED_FIRST_PROMPT" },
    },
    selection = selected([success, diagnostic, context, prompt]);
  assert.deepEqual(
    selection.rows.map((value) => value.uuid),
    [id(2), id(3), id(4)],
  );
  let tail = Promise.resolve();
  const config: NativeSessionPersistenceOptions = {
    path,
    initial: { kind: "fresh" },
    context: {
      sessionId: id(99),
      cwd,
      version: "2.1.326",
      entrypoint: "cli",
      userType: "external",
      sidechain: false,
    },
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
  const owner = await openNativeSessionPersistence(
    config,
    new AbortController().signal,
  );
  await owner.appendEvents(
    captureNativePersistenceEvents(selection.rows),
    {},
    new AbortController().signal,
  );
  const bytes = await readFile(path),
    stored = decodeNativeSession(bytes, {
      parser: "source-line-fallback",
    }).lines.flatMap((line) =>
      isNativeObject(line.value) ? [line.value] : [],
    );
  assert.equal(
    stored.some((value) => value.uuid === id(1)),
    false,
  );
  assert.equal(stored.find((value) => value.uuid === id(2))?.parentUuid, null);
  assert.equal(stored.find((value) => value.uuid === id(3))?.parentUuid, id(2));
  assert.equal(stored.find((value) => value.uuid === id(4))?.parentUuid, id(3));
  await owner.close();
  assert.deepEqual(await readFile(path), bytes);
});
