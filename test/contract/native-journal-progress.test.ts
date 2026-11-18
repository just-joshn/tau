import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { NativeSessionLifetime } from "../../src/native-session-lifetime.js";
import { NativeMemoryJournal } from "../../src/native-memory-journal.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";
import { recordNativeJsonResponse } from "../../src/native-response-recording.js";
import {
  nativeHookProgressDispatch,
  createNativeStopHookSummary,
  type NativeHookProgressRow,
  type NativeStopHookSummaryCreation,
} from "../../src/native-hook-progress.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import {
  decodeNativeSession,
  isNativeObject,
  type NativeSourceRow,
} from "../../src/native-session-codec.js";
import type { NativeJournalRequestOptions } from "../../src/native-session-journal.js";
import type { NativeSessionJournal } from "../../src/native-session-journal.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const profile = () =>
  ({
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
  }) satisfies NativeJournalRequestOptions<NativeSourceRow>;

async function fixture(
  kind: "file" | "memory",
  beforeHuman?: (
    journal: NativeSessionJournal | NativeMemoryJournal,
    root: string,
  ) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-journal-progress-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let serial = 0;
  const stamp = () => ({
    uuid: `00000000-1111-1111-1111-${String(++serial).padStart(12, "0")}`,
    timestamp: "2026-11-18T00:00:00Z",
  });
  const context = {
    sessionId: SID,
    cwd: root,
    version: "2.1.326",
    userType: "external",
    sidechain: false,
  };
  const makeFile = async () => {
    const path = join(root, `${SID}.jsonl`);
    const lifetime = await NativeSessionLifetime.open(
      {
        ownership: { directory: root, path, admit: () => true },
        persistence: { context, admit: () => true },
        initial: { kind: "fresh" },
        host: {
          stamp,
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
    return {
      kind: "file" as const,
      root,
      path,
      journal: lifetime.journal,
      close: () => lifetime.close(signal()),
      rows: async () =>
        decodeNativeSession(await readFile(path), {
          parser: "source-line-fallback",
        }).lines.flatMap((line) =>
          isNativeObject(line.value) && typeof line.value.uuid === "string"
            ? [line.value]
            : [],
        ),
    };
  };
  const makeMemory = async () => {
    const journal = await NativeMemoryJournal.open(
      { sessionId: SID },
      {
        stamp,
        admission: { admitProducer: () => true, admitRetention: () => true },
      },
      signal(),
    );
    onTestFinished(() => journal.close(signal()).catch(() => {}));
    return {
      kind: "memory" as const,
      root,
      journal,
      close: () => journal.close(signal()),
      rows: async () =>
        (await journal.readCommitted(signal())).state.entries.map(
          (entry) => entry.row,
        ),
    };
  };
  const f = kind === "file" ? await makeFile() : await makeMemory();
  await beforeHuman?.(f.journal, root);
  await f.journal.recordUser(
    { role: "user", content: [{ type: "text", text: "ACTUAL_HUMAN" }] },
    "ACTUAL_PROMPT",
    signal(),
  );
  const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
  await f.journal.recordResponse(
    recordNativeJsonResponse(
      { requestedModel: MODEL, host: f.journal.responseHost },
      {
        id: "actual-api",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "ACTUAL_COMPLETED" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      [{ type: "text", text: "ACTUAL_COMPLETED" }],
    ),
    signal(),
  );
  await f.journal.beginLifecycleTransition(frame, signal());
  return { ...f, frame, stamps: () => serial };
}
function dispatch(
  f: Awaited<ReturnType<typeof fixture>>,
  event: "Stop" | "UserPromptSubmit" = "Stop",
  actualSignal = signal(),
) {
  const input = {
    event,
    dispatchToolUseID: "ACTUAL_DISPATCH",
    admission: {
      status: "admitted" as const,
      source: "actual-final-dispatch" as const,
    },
    candidates: [
      { id: "first", hook: { type: "command", command: "owned-first" } },
      { id: "second", hook: { type: "command", command: "owned-second" } },
    ],
  };
  return nativeHookProgressDispatch(
    input,
    {
      aliases: () => ({ status: "known", value: [] }),
      display: ({ candidate }) => {
        assert.ok(typeof candidate.hook.command === "string");
        return { status: "known", value: { command: candidate.hook.command } };
      },
      stamp: () => f.journal.stampHookProgress(),
    },
    actualSignal,
  );
}
async function progress(
  f: Awaited<ReturnType<typeof fixture>>,
  event: "Stop" | "UserPromptSubmit" = "Stop",
  keep?: (row: NativeHookProgressRow) => Promise<void>,
) {
  const rows: NativeHookProgressRow[] = [];
  for await (const row of dispatch(f, event)) {
    rows.push(row);
    await keep?.(row);
  }
  return rows;
}
function summary(
  f: Awaited<ReturnType<typeof fixture>>,
  rows: readonly NativeHookProgressRow[],
  end: "normally-drained" | "aborted-in-loop" = "normally-drained",
): NativeStopHookSummaryCreation {
  const last = rows.at(-1);
  assert.ok(last);
  return createNativeStopHookSummary(
    {
      phase: "blockable-turn-end",
      end,
      observedProgress: rows,
      accumulators: {
        hookCount: rows.length,
        hookInfos: rows.map((row) => ({ command: row.data.command })),
        hookErrors: [],
        hookAdditionalContext: [],
        preventedContinuation: false,
        stopReason: "",
        hasOutput: false,
        level: "suggestion",
        toolUseID: last.toolUseID,
      },
    },
    { stamp: () => f.journal.stampStopSummary() },
  );
}

for (const kind of ["file", "memory"] as const) {
  test(`${kind} final fresh-start owner retains progress before the first human without forcing a transcript row`, async () => {
    let uuid: string | undefined;
    const f = await fixture(kind, async (journal, root) => {
      const iterator = nativeHookProgressDispatch(
        {
          event: "SessionStart",
          matchQuery: "startup",
          dispatchToolUseID: "ACTUAL_START",
          admission: { status: "admitted", source: "actual-final-dispatch" },
          candidates: [
            {
              id: "actual-start",
              hook: { type: "command", command: "owned-start" },
            },
          ],
        },
        {
          aliases: () => ({ status: "known", value: [] }),
          display: () => ({
            status: "known",
            value: { command: "owned-start" },
          }),
          stamp: () => journal.stampHookProgress(),
        },
        signal(),
      );
      const yielded = await iterator.next();
      if (yielded.done || !yielded.value) assert.fail();
      uuid = yielded.value.uuid;
      await journal.captureHookProgress(
        yielded.value,
        {
          consumer: "session-start",
          dispatchToolUseID: "ACTUAL_START",
          signalAborted: false,
          admission: {
            status: "resolved",
            source: "fresh-initial",
            retainedUuids: [uuid],
          },
        },
        signal(),
      );
      await iterator.next();
      await assert.rejects(readFile(join(root, `${SID}.jsonl`)), {
        code: "ENOENT",
      });
    });
    assert.ok(uuid);
    const rows = await f.rows();
    assert.equal(
      rows.some((row) => row.uuid === uuid),
      kind === "memory",
    );
    f.journal.endQueryFrame(f.frame);
    await f.journal.recordUser(
      { role: "user", content: [{ type: "text", text: "ACTUAL_NEXT" }] },
      "ACTUAL_NEXT",
      signal(),
    );
    const frame = await f.journal.beginQueryFrame(profile().recovery, signal());
    const request = await f.journal.projectRequest({ ...profile(), frame });
    assert.doesNotMatch(
      JSON.stringify(request.projection.messages),
      /owned-start|hook_progress/,
    );
    f.journal.endQueryFrame(frame);
    await f.close();
    if (kind === "memory") assert.deepEqual(await readdir(f.root), []);
  });

  test(`${kind} summary cannot claim progress that its actual phase never retained`, async () => {
    const f = await fixture(kind),
      rows = await progress(f),
      before = await f.rows();
    await assert.rejects(
      f.journal.captureStopSummary(summary(f, rows), signal()),
      /actual observed progress owner/,
    );
    if (f.kind === "file") {
      const disk = decodeNativeSession(await readFile(f.path), {
        parser: "source-line-fallback",
      }).lines.flatMap((line) =>
        isNativeObject(line.value) && typeof line.value.uuid === "string"
          ? [line.value]
          : [],
      );
      assert.deepEqual(disk, before);
    }
    f.journal.endQueryFrame(f.frame);
    await assert.rejects(f.close());
  });

  test(`${kind} journal retains actual Stop summary while progress obeys its independent disk/memory policy`, async () => {
    const f = await fixture(kind),
      before = await f.rows(),
      prior = before.at(-1);
    assert.ok(prior);
    const rows = await progress(f, "Stop", async (row) =>
      f.journal.captureHookProgress(
        row,
        {
          consumer: "blockable-stop",
          dispatchToolUseID: "ACTUAL_DISPATCH",
          signalAborted: false,
        },
        signal(),
      ),
    );
    const made = summary(f, rows);
    assert.equal(made.status, "created");
    if (made.status !== "created") assert.fail();
    assert.ok(!rows.some((row) => row.uuid === made.row.uuid));
    await f.journal.captureStopSummary(made, signal());
    const retained = await f.rows(),
      system = retained.find((row) => row.uuid === made.row.uuid);
    assert.ok(system);
    assert.equal(system.subtype, "stop_hook_summary");
    assert.equal(
      retained.filter((row) => row.type === "progress").length,
      kind === "file" ? 0 : 2,
    );
    if (f.kind === "file") {
      assert.equal(system.parentUuid, prior.uuid);
      assert.equal(
        (await f.journal.checkpoint(signal())).cursorUuid,
        made.row.uuid,
      );
      assert.ok(
        f.journal
          .persistenceSelectionAudit()
          .flat()
          .filter((d) => d.disposition === "progress").length === 2,
      );
    } else assert.equal(Object.hasOwn(system, "parentUuid"), false);
    f.journal.endQueryFrame(f.frame);
    if (f.kind === "file") {
      const imported = await importNativeSessionFile({
        path: f.path,
        cwd: f.root,
        model: MODEL,
        signal: signal(),
        env: {},
      });
      assert.match(
        JSON.stringify(imported.session.messages),
        /ACTUAL_COMPLETED/,
      );
      assert.doesNotMatch(
        JSON.stringify(imported.session.messages),
        /owned-first|stop_hook_summary|hook_progress/,
      );
    }
    await f.journal.recordUser(
      { role: "user", content: [{ type: "text", text: "ACTUAL_NEXT_HUMAN" }] },
      "ACTUAL_NEXT",
      signal(),
    );
    const next = await f.journal.beginQueryFrame(profile().recovery, signal());
    const projected = await f.journal.projectRequest({
      ...profile(),
      frame: next,
    });
    assert.doesNotMatch(
      JSON.stringify(projected.projection.messages),
      /owned-first|owned-second|stop_hook_summary|hook_progress/,
    );
    assert.match(
      JSON.stringify(projected.projection.messages),
      /ACTUAL_NEXT_HUMAN/,
    );
    f.journal.endQueryFrame(next);
    await f.close();
    if (kind === "memory") assert.deepEqual(await readdir(f.root), []);
  });

  test(`${kind} journal qvo drops its created progress and an aborted prefix creates no summary`, async () => {
    const f = await fixture(kind),
      before = await f.rows(),
      promptProgress = await progress(f, "UserPromptSubmit");
    for (const row of promptProgress)
      await f.journal.captureHookProgress(
        row,
        {
          consumer: "user-prompt-submit",
          dispatchToolUseID: "ACTUAL_DISPATCH",
          signalAborted: true,
        },
        signal(),
      );
    assert.deepEqual(await f.rows(), before);
    const controller = new AbortController(),
      lazy = dispatch(f, "Stop", controller.signal),
      beforePrefix = f.stamps();
    const yielded = await lazy.next();
    if (yielded.done || !yielded.value)
      assert.fail("Missing actual yielded progress");
    const first = yielded.value;
    controller.abort(new Error("ACTUAL_PARENT_ABORT"));
    await f.journal.captureHookProgress(
      first,
      {
        consumer: "blockable-stop",
        dispatchToolUseID: "ACTUAL_DISPATCH",
        signalAborted: true,
      },
      signal(),
    );
    await lazy.return(undefined);
    assert.equal(f.stamps(), beforePrefix + 1);
    const stamps = f.stamps(),
      made = summary(f, [first], "aborted-in-loop");
    assert.equal(made.status, "absent");
    assert.equal(f.stamps(), stamps);
    await f.journal.captureStopSummary(made, signal());
    assert.ok(
      (await f.rows()).every((row) => row.subtype !== "stop_hook_summary"),
    );
    f.journal.endQueryFrame(f.frame);
    await f.close();
    if (kind === "memory") assert.deepEqual(await readdir(f.root), []);
  });
}
