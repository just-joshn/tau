import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeHookProgressDispatch,
  nativeHookProgressRetention,
  createNativeStopHookSummary,
  validateNativeHookProgressRow,
  validateNativeStopHookSummaryRow,
  NativeHookProgressCaptureError,
  NativeHookProgressValidationError,
  type NativeHookProgressDispatchInput,
  type NativeHookProgressHost,
  type NativeHookProgressRow,
  type NativeStopHookSummaryAccumulators,
  type NativeStopHookSummaryInput,
} from "../src/native-hook-progress.js";
import type { NativePromptFact } from "../src/native-prompt-snapshot.js";
import { createHookRegistry } from "../src/hooks.js";
import { createReducedScopedHookRegistry } from "../src/scoped-hook-dispatch.js";
import { NativeRetainedMemoryOwner } from "../src/native-retained-memory.js";
import { snapshotNativeResponseJson } from "../src/native-response-recording.js";
import { classifyNativePersistenceRow } from "../src/native-persistence-selection.js";
import {
  isNativeObject,
  isNativeArray,
  type NativeObject,
} from "../src/native-session-codec.js";

const finiteObject = (value: unknown): NativeObject => {
  const saved = snapshotNativeResponseJson(value);
  assert.ok(isNativeObject(saved));
  return saved;
};
const signal = () => new AbortController().signal;
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
function input(
  event: NativeHookProgressDispatchInput["event"] = "Stop",
): NativeHookProgressDispatchInput {
  return {
    event,
    dispatchToolUseID: id(90),
    admission: { status: "admitted", source: "actual-final-dispatch" },
    candidates: [
      { id: "A", hook: { type: "command", command: "A" } },
      { id: "B", hook: { type: "command", command: "B", async: true } },
    ],
  };
}
function fixture() {
  const calls: string[] = [];
  let stamps = 0;
  const host: NativeHookProgressHost = {
    aliases: ({ candidates }) => {
      calls.push(`aliases:${candidates.map((value) => value.id).join(",")}`);
      return known([]);
    },
    display: ({ candidate, alias }) => {
      calls.push(`display:${candidate.id}`);
      const command =
        candidate.hook.type === "callback"
          ? "callback"
          : candidate.hook.command;
      assert.ok(typeof command === "string");
      return known({ command: alias ?? command });
    },
    stamp: ({ candidate, data }) => {
      assert.ok(Object.isFrozen(candidate.hook));
      assert.ok(Object.isFrozen(data));
      calls.push(`stamp:${candidate.id}`);
      return {
        uuid: id(++stamps),
        timestamp: `2026-01-01T00:00:00.${String(stamps).padStart(3, "0")}Z`,
      };
    },
  };
  return { host, calls, stamps: () => stamps };
}
async function first(event: NativeHookProgressDispatchInput["event"] = "Stop") {
  const f = fixture(),
    iterator = nativeHookProgressDispatch(input(event), f.host, signal()),
    yielded = await iterator.next();
  assert.equal(yielded.done, false);
  if (yielded.done) throw new Error("missing actual progress");
  await iterator.return(undefined);
  return yielded.value;
}
const accumulators = (
  progress: NativeHookProgressRow,
): NativeStopHookSummaryAccumulators => ({
  hookCount: 1,
  hookInfos: [{ command: progress.data.command, durationMs: 17 }],
  hookErrors: [],
  hookAdditionalContext: [],
  preventedContinuation: false,
  stopReason: "",
  hasOutput: false,
  level: "suggestion",
  toolUseID: progress.toolUseID,
});

test("actual progress identity is lazy, distinct from dispatch and created only when the next source yield is requested", async () => {
  const f = fixture(),
    original = input(),
    iterator = nativeHookProgressDispatch(original, f.host, signal());
  assert.deepEqual(f.calls, []);
  assert.ok(isNativeObject(original.candidates[0]?.hook));
  Object.assign(original.candidates[0]?.hook ?? {}, { command: "MUTATED" });
  const one = await iterator.next();
  assert.equal(one.done, false);
  if (one.done) throw new Error("missing progress");
  assert.deepEqual(f.calls, ["aliases:A,B", "display:A", "stamp:A"]);
  assert.equal(one.value.data.command, "A");
  assert.equal(one.value.uuid, id(1));
  assert.equal(one.value.toolUseID, id(90));
  assert.equal(one.value.parentToolUseID, id(90));
  assert.ok(Object.isFrozen(one.value) && Object.isFrozen(one.value.data));
  await iterator.return(undefined);
  assert.equal(f.stamps(), 1);
  assert.equal((await iterator.next()).done, true);
});

test("Stop abort retains its created prefix and closes upstream before the next identity; SessionStart and qvo use their own rules", async () => {
  const controller = new AbortController(),
    f = fixture(),
    iterator = nativeHookProgressDispatch(input(), f.host, controller.signal),
    one = await iterator.next();
  if (one.done) throw new Error("missing progress");
  controller.abort(new Error("ACTUAL_ABORT"));
  const disposition = nativeHookProgressRetention(one.value, {
    consumer: "blockable-stop",
    dispatchToolUseID: id(90),
    signalAborted: true,
  });
  assert.deepEqual(disposition, {
    status: "resolved",
    retention: "retain",
    closeUpstream: true,
  });
  if (disposition.status === "resolved" && disposition.closeUpstream)
    await iterator.return(undefined);
  assert.equal(f.stamps(), 1);
  const startup = await first("SessionStart");
  assert.deepEqual(
    nativeHookProgressRetention(startup, {
      consumer: "session-start",
      dispatchToolUseID: id(90),
      signalAborted: true,
      admission: { status: "buffer" },
    }),
    { status: "resolved", retention: "startup-buffer", closeUpstream: false },
  );
  const qvo = await first("UserPromptSubmit");
  assert.deepEqual(
    nativeHookProgressRetention(qvo, {
      consumer: "user-prompt-submit",
      dispatchToolUseID: id(90),
      signalAborted: true,
    }),
    { status: "resolved", retention: "discard", closeUpstream: false },
  );
  assert.deepEqual(
    nativeHookProgressRetention(one.value, {
      consumer: "turn-end-reactions",
      dispatchToolUseID: id(90),
      signalAborted: true,
    }),
    { status: "resolved", retention: "retain", closeUpstream: false },
  );
});

test("no universal mid-prefix abort rule truncates SessionStart; initial abort and actual global skips create nothing", async () => {
  const controller = new AbortController(),
    f = fixture(),
    iterator = nativeHookProgressDispatch(
      input("SessionStart"),
      f.host,
      controller.signal,
    );
  assert.equal((await iterator.next()).done, false);
  controller.abort();
  assert.equal((await iterator.next()).done, false);
  const end = await iterator.next();
  assert.ok(end.done && end.value?.status === "drained");
  assert.equal(f.stamps(), 2);
  const aborted = new AbortController();
  aborted.abort();
  const zero = fixture();
  assert.deepEqual(
    await nativeHookProgressDispatch(input(), zero.host, aborted.signal).next(),
    {
      done: true,
      value: { status: "skipped", reason: "initial-abort", created: 0 },
    },
  );
  assert.deepEqual(zero.calls, []);
  for (const reason of [
    "trust",
    "call-refusal",
    "no-hooks",
    "source-gate",
  ] as const) {
    const skipped = fixture();
    await nativeHookProgressDispatch(
      { ...input(), admission: { status: "skipped", reason } },
      skipped.host,
      signal(),
    ).next();
    assert.deepEqual(skipped.calls, []);
  }
});

test("internal callback progress uses actual notTested presence; async or withheld candidates still have pre-launch rows", async () => {
  const f = fixture(),
    candidate = input();
  const iterator = nativeHookProgressDispatch(
    {
      ...candidate,
      candidates: [
        ...candidate.candidates,
        { id: "INTERNAL", hook: { type: "callback", internal: true } },
        {
          id: "WITHHELD",
          hook: { type: "callback", internal: true },
          notTested: null,
        },
      ],
    },
    f.host,
    signal(),
  );
  const rows: NativeHookProgressRow[] = [];
  for await (const row of iterator) rows.push(row);
  assert.equal(rows.length, 3);
  assert.equal(f.stamps(), 3);
  assert.ok(!f.calls.some((value) => value.includes("display:INTERNAL")));
  assert.ok(f.calls.includes("display:WITHHELD"));
  assert.equal(rows[1]?.data.command, "B");
});

test("actual alias and Up projections preserve status-message presence and event-specific hookName", async () => {
  const f = fixture(),
    event = input("SessionStart");
  f.host.aliases = () =>
    known([
      { id: "A", alias: "command hook 1" },
      { id: "B", alias: "command hook 2" },
    ]);
  f.host.display = ({ candidate, alias }) =>
    known({
      command: alias ?? "",
      ...(candidate.id === "A"
        ? { statusMessage: "" }
        : { statusMessage: "LINE\u2424NEXT\u2409TAB" }),
    });
  const iterator = nativeHookProgressDispatch(
    {
      ...event,
      matchQuery: "resume",
      candidates: [
        {
          id: "A",
          hook: { type: "command", command: "ACTUAL_A", statusMessage: "" },
        },
        {
          id: "B",
          hook: {
            type: "command",
            command: "ACTUAL_B",
            statusMessage: "LINE\nNEXT\tTAB",
          },
        },
      ],
    },
    f.host,
    signal(),
  );
  const one = await iterator.next(),
    two = await iterator.next();
  if (one.done || two.done) throw new Error("missing actual rows");
  assert.equal(one.value.data.hookName, "SessionStart:resume");
  assert.equal(one.value.data.command, "command hook 1");
  assert.ok(Object.hasOwn(one.value.data, "statusMessage"));
  assert.equal(one.value.data.statusMessage, "");
  assert.equal(two.value.data.statusMessage, "LINE\u2424NEXT\u2409TAB");
  await iterator.return(undefined);
  const prompt = fixture();
  prompt.host.display = () =>
    known({ command: "ACTUAL_PROMPT", promptText: "ACTUAL_PROMPT" });
  const started = nativeHookProgressDispatch(
    {
      ...input(),
      candidates: [
        { id: "P", hook: { type: "prompt", prompt: "ACTUAL_PROMPT" } },
      ],
    },
    prompt.host,
    signal(),
  );
  const row = await started.next();
  if (row.done) throw new Error("missing prompt progress");
  assert.equal(row.value.data.promptText, "ACTUAL_PROMPT");
  await started.return(undefined);
});

test("unknown alias/display facts, late owner failure or reused identity never invent remaining progress", async () => {
  const unavailable = fixture();
  unavailable.host.aliases = () => ({
    status: "unsupported",
    reason: "ACTUAL_ALIAS_GATE_UNKNOWN",
  });
  const unknown = await nativeHookProgressDispatch(
    input(),
    unavailable.host,
    signal(),
  ).next();
  assert.ok(unknown.done && unknown.value?.status === "unsupported");
  assert.equal(unavailable.stamps(), 0);
  const failed = fixture();
  failed.host.display = ({ candidate }) => {
    if (candidate.id === "B") throw new Error("DISPLAY_OWNER_FAILED");
    return known({ command: "A" });
  };
  const iterator = nativeHookProgressDispatch(input(), failed.host, signal());
  await iterator.next();
  await assert.rejects(iterator.next(), NativeHookProgressCaptureError);
  assert.equal(failed.stamps(), 1);
  const reused = fixture();
  reused.host.stamp = () => ({
    uuid: id(1),
    timestamp: "2026-01-01T00:00:00Z",
  });
  const duplicate = nativeHookProgressDispatch(input(), reused.host, signal());
  await duplicate.next();
  await assert.rejects(duplicate.next(), /creation owner failed/);
});

test("strict raw progress DTO rejects transport frames, writer envelopes, correlation mismatch and unknown fields", async () => {
  const row = await first();
  for (const invalid of [
    { ...row, type: "stream_event" },
    { ...row, uuid: undefined },
    { ...row, toolUseID: "FOREIGN" },
    { ...row, parentUuid: null },
    { ...row, data: { ...row.data, future: true } },
    { ...row, data: { ...row.data, hookName: "UNRELATED" } },
  ])
    assert.throws(
      () => validateNativeHookProgressRow(invalid),
      NativeHookProgressValidationError,
    );
  const hostile = Object.defineProperty({}, "type", {
    enumerable: true,
    get: () => {
      throw new Error("GETTER_RAN");
    },
  });
  assert.throws(
    () => validateNativeHookProgressRow(hostile),
    NativeHookProgressValidationError,
  );
  assert.throws(
    () =>
      nativeHookProgressRetention(row, {
        consumer: "blockable-stop",
        dispatchToolUseID: "FOREIGN",
        signalAborted: false,
      }),
    NativeHookProgressValidationError,
  );
});

test("startup progress awaits its actual final LBe/overdue vector, preserving meaningful exclusion without restamping", async () => {
  const row = await first("SessionStart");
  assert.deepEqual(
    nativeHookProgressRetention(row, {
      consumer: "session-start",
      dispatchToolUseID: id(90),
      signalAborted: false,
      admission: {
        status: "resolved",
        source: "actual-LBe",
        retainedUuids: [],
      },
    }),
    { status: "resolved", retention: "discard", closeUpstream: false },
  );
  assert.deepEqual(
    nativeHookProgressRetention(row, {
      consumer: "session-start",
      dispatchToolUseID: id(90),
      signalAborted: false,
      admission: {
        status: "resolved",
        source: "actual-overdue-LBe",
        retainedUuids: [row.uuid],
      },
    }),
    { status: "resolved", retention: "retain", closeUpstream: false },
  );
  assert.equal(
    nativeHookProgressRetention(row, {
      consumer: "session-start",
      dispatchToolUseID: id(90),
      signalAborted: false,
      admission: {
        status: "unsupported",
        reason: "RESTORED_OWNER_NOT_ADAPTED",
      },
    }).status,
    "unsupported",
  );
});

test("separate Stop summary requires normal actual drain and complete matching accumulators, not progress count", async () => {
  const progress = await first(),
    calls: NativeObject[] = [],
    host = {
      stamp: ({ payload }: { payload: NativeStopHookSummaryAccumulators }) => {
        assert.ok(Object.isFrozen(payload.hookInfos));
        calls.push(payload);
        return { uuid: id(80), timestamp: "2026-01-01T00:00:00Z" };
      },
    };
  const normal: NativeStopHookSummaryInput = {
    phase: "blockable-turn-end",
    end: "normally-drained",
    observedProgress: [progress],
    accumulators: accumulators(progress),
  };
  const created = createNativeStopHookSummary(normal, host);
  assert.equal(created.status, "created");
  if (created.status !== "created") throw new Error("missing summary");
  assert.equal(created.row.subtype, "stop_hook_summary");
  assert.notEqual(created.row.uuid, progress.uuid);
  assert.equal(created.row.hookCount, 1);
  assert.equal(created.row.stopReason, "");
  assert.ok(!Object.hasOwn(created.row, "isMeta"));
  assert.ok(!Object.hasOwn(created.row, "hookLabel"));
  assert.ok(!Object.hasOwn(created.row, "totalDurationMs"));
  assert.deepEqual(validateNativeStopHookSummaryRow(created.row), created.row);
  assert.throws(
    () =>
      createNativeStopHookSummary(
        {
          phase: normal.phase,
          end: normal.end,
          observedProgress: normal.observedProgress,
        },
        host,
      ),
    NativeHookProgressValidationError,
  );
  assert.throws(
    () =>
      createNativeStopHookSummary(
        {
          ...normal,
          accumulators: { ...accumulators(progress), hookCount: 2 },
        },
        host,
      ),
    NativeHookProgressValidationError,
  );
  assert.throws(
    () =>
      createNativeStopHookSummary(
        {
          ...normal,
          accumulators: {
            ...accumulators(progress),
            hookInfos: [{ command: "GUESS" }],
          },
        },
        host,
      ),
    NativeHookProgressValidationError,
  );
  assert.equal(calls.length, 1);
});

test("summary omission and actual optional fields survive, while early abort/error/reaction never generates a completion", async () => {
  const progress = await first();
  let stamps = 0;
  const host = {
    stamp: () => ({
      uuid: id(80 + ++stamps),
      timestamp: "2026-01-01T00:00:00Z",
    }),
  };
  for (const end of [
    "aborted-in-loop",
    "aborted-exception",
    "control-stream-closed",
    "failed",
    "consumer-closed",
  ] as const)
    assert.equal(
      createNativeStopHookSummary(
        { phase: "blockable-turn-end", end, observedProgress: [progress] },
        host,
      ).status,
      "absent",
    );
  assert.equal(
    createNativeStopHookSummary(
      {
        phase: "turn-end-reactions",
        end: "normally-drained",
        observedProgress: [progress],
      },
      host,
    ).status,
    "absent",
  );
  assert.equal(
    createNativeStopHookSummary(
      {
        phase: "blockable-turn-end",
        end: "normally-drained",
        observedProgress: [],
      },
      host,
    ).status,
    "absent",
  );
  assert.equal(stamps, 0);
  const created = createNativeStopHookSummary(
    {
      phase: "blockable-turn-end",
      end: "normally-drained",
      observedProgress: [progress],
      accumulators: {
        ...accumulators(progress),
        hookLabel: "",
        totalDurationMs: 0,
        hookAdditionalContext: ["OBSERVED_EVEN_IF_FRAME_EXCLUDED"],
      },
    },
    host,
  );
  if (created.status !== "created") throw new Error("missing summary");
  assert.ok(Object.hasOwn(created.row, "hookLabel"));
  assert.equal(created.row.hookLabel, "");
  assert.equal(created.row.totalDurationMs, 0);
  assert.deepEqual(created.row.hookAdditionalContext, [
    "OBSERVED_EVEN_IF_FRAME_EXCLUDED",
  ]);
  assert.throws(
    () => validateNativeStopHookSummaryRow({ ...created.row, isMeta: false }),
    NativeHookProgressValidationError,
  );
});

test("real prepared multi-backend dispatch has a global lazy progress barrier; early close launches no command and memory keeps OE-excluded rows", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-progress-barrier-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "owned.mjs"),
    log = join(cwd, "executed.jsonl");
  await writeFile(
    script,
    "import{appendFileSync}from'node:fs';for await(const _ of process.stdin){}appendFileSync(process.argv[2],process.argv[3]+'\\n');",
  );
  const backends = ["A", "B"].map((name) => {
    const registry = createHookRegistry([
      {
        source: `owned-${name}`,
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: process.execPath,
                  args: [script, log, name],
                },
              ],
            },
          ],
        },
      },
    ]);
    onTestFinished(() => registry.close());
    return {
      id: name,
      registry,
      nativeOrigin: () => ({
        namespace: "hook" as const,
        settingsSource: `owned-${name}`,
      }),
    };
  });
  const registry = createReducedScopedHookRegistry({
    ownerSessionId: id(90),
    defaultShell: "bash",
    personalConfigRestricted: false,
    backends: () => backends,
  });
  onTestFinished(() => registry.close());
  const policy = { cwd, projectDir: cwd, env: {}, signal: signal() },
    hookInput = {
      hook_event_name: "Stop" as const,
      session_id: id(90),
      transcript_path: join(cwd, "never-written.jsonl"),
      cwd,
      stop_hook_active: false,
    };
  const prepared = await registry.prepareDispatch?.(hookInput, policy);
  assert.ok(prepared);
  const f = fixture();
  f.host.display = ({ candidate }) => {
    assert.ok(isNativeObject(candidate.hook));
    assert.ok(typeof candidate.hook.command === "string");
    const args = candidate.hook.args;
    assert.ok(args === undefined || isNativeArray(args));
    const parts = [candidate.hook.command];
    for (const arg of args ?? []) {
      assert.ok(typeof arg === "string");
      parts.push(arg);
    }
    const command = parts.join(" ");
    return known({ command });
  };
  const candidates = prepared.candidates.map((candidate) => ({
    id: candidate.id,
    hook: finiteObject(candidate.hook),
  }));
  const prefix = nativeHookProgressDispatch(
    { ...input(), candidates },
    f.host,
    signal(),
  );
  await prefix.next();
  await prefix.return(undefined);
  await prepared.close();
  await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" });
  assert.equal(f.stamps(), 1);
  const run = await registry.prepareDispatch?.(hookInput, policy);
  assert.ok(run);
  const g = fixture();
  g.host.display = f.host.display.bind(f.host);
  const progress = nativeHookProgressDispatch(
    {
      ...input(),
      candidates: run.candidates.map((candidate) => ({
        id: candidate.id,
        hook: finiteObject(candidate.hook),
      })),
    },
    g.host,
    signal(),
  );
  const memory = NativeRetainedMemoryOwner.open(
    { sessionId: id(90) },
    { admitProducer: () => true, admitRetention: () => true },
  );
  const producer = await memory.admitProducer(
    { name: "actual-progress-owner", kinds: ["progress", "system"] },
    signal(),
  );
  onTestFinished(async () => {
    await memory.close();
  });
  const observed: NativeHookProgressRow[] = [];
  for await (const row of progress) {
    await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" });
    await memory.retain(producer, [row], { signal: signal() });
    observed.push(row);
    assert.equal(classifyNativePersistenceRow(row).keep, false);
  }
  const batch = await run.runSelected(
    new Set(run.candidates.map((candidate) => candidate.id)),
  );
  await run.close();
  assert.equal(batch.results.length, 2);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").sort(), [
    "A",
    "B",
  ]);
  const summary = createNativeStopHookSummary(
    {
      phase: "blockable-turn-end",
      end: "normally-drained",
      observedProgress: observed,
      accumulators: {
        hookCount: observed.length,
        hookInfos: observed.map((row, index) => {
          const result = batch.results[index];
          assert.ok(result);
          return { command: row.data.command, durationMs: result.durationMs };
        }),
        hookErrors: [],
        hookAdditionalContext: [],
        preventedContinuation: false,
        stopReason: "",
        hasOutput: false,
        level: "suggestion",
        toolUseID: id(90),
      },
    },
    { stamp: () => ({ uuid: id(80), timestamp: "2026-01-01T00:00:00Z" }) },
  );
  if (summary.status !== "created")
    throw new Error("missing actual normally drained summary");
  await memory.retain(producer, [summary.row], { signal: signal() });
  const final = await memory.close();
  assert.equal(final.entries.length, 3);
  assert.deepEqual((await readdir(cwd)).sort(), [
    "executed.jsonl",
    "owned.mjs",
  ]);
});

test("internal-only source fast path needs no alias/display/stamp host, and malformed stamp cannot override a produced row", async () => {
  const f = fixture();
  f.host.aliases = () => {
    throw new Error("ALIAS_HOST_SHOULD_NOT_RUN");
  };
  const done = await nativeHookProgressDispatch(
    {
      ...input(),
      candidates: [
        { id: "INTERNAL", hook: { type: "callback", internal: true } },
      ],
    },
    f.host,
    signal(),
  ).next();
  assert.deepEqual(done, {
    done: true,
    value: { status: "drained", created: 0, eligible: 0, signalAborted: false },
  });
  assert.deepEqual(f.calls, []);
  const override = fixture();
  override.host.stamp = () =>
    Object.assign(
      { uuid: id(1), timestamp: "2026-01-01T00:00:00Z" },
      {
        data: {
          type: "hook_progress",
          hookEvent: "Stop",
          hookName: "Stop",
          command: "FORGED",
        },
      },
    );
  await assert.rejects(
    nativeHookProgressDispatch(input(), override.host, signal()).next(),
    NativeHookProgressCaptureError,
  );
});

test("ordinary Stop summary requires actual No/Ct/suggestion accumulators and alias/display unsupported preserves only created prefix", async () => {
  const progress = await first(),
    base = accumulators(progress),
    stamp = {
      stamp: () => ({ uuid: id(80), timestamp: "2026-01-01T00:00:00Z" }),
    };
  const { stopReason: _reason, ...withoutReason } = base,
    { hookAdditionalContext: _context, ...withoutContext } = base;
  for (const accumulators of [
    withoutReason,
    withoutContext,
    { ...base, level: "GUESS" },
  ])
    assert.throws(
      () =>
        createNativeStopHookSummary(
          {
            phase: "blockable-turn-end",
            end: "normally-drained",
            observedProgress: [progress],
            accumulators,
          },
          stamp,
        ),
      NativeHookProgressValidationError,
    );
  const f = fixture();
  f.host.display = ({ candidate }) =>
    candidate.id === "A"
      ? known({ command: "A" })
      : { status: "unsupported", reason: "ACTUAL_DISPLAY_NOT_ADAPTED" };
  const iterator = nativeHookProgressDispatch(input(), f.host, signal());
  assert.equal((await iterator.next()).done, false);
  const end = await iterator.next();
  assert.ok(end.done && end.value?.status === "unsupported");
  assert.equal(end.value?.created, 1);
  assert.equal(f.stamps(), 1);
});
