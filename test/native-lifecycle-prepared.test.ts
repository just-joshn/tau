import assert from "node:assert/strict";
import { test, onTestFinished } from "bun:test";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHookRegistry,
  type HookInput,
  type HookRunOptions,
} from "../src/hooks.js";
import { createReducedScopedHookRegistry } from "../src/scoped-hook-dispatch.js";
import { createNativeStopHookAccumulator } from "../src/native-stop-hook-accumulator.js";
import { nativeLifecyclePreparedCommandRegistry } from "../src/native-lifecycle-prepared.js";
import {
  runNativeLifecycleHookDispatch,
  NativeLifecycleCaptureError,
  type NativeLifecycleCaptureHost,
  type NativeLifecycleCreation,
  type NativeLifecycleInput,
  type NativeLifecycleRuntimeOptions,
  type NativeLifecycleStartupCreation,
} from "../src/native-lifecycle-hooks.js";
import type {
  NativeHookProgressRow,
  NativeStopHookSummaryCreation,
} from "../src/native-hook-progress.js";
import type { NativePromptFact } from "../src/native-prompt-snapshot.js";
import {
  captureNativePersistenceJson,
  createNativeAttachmentEvent,
} from "../src/native-persistence-events.js";
import { isNativeObject } from "../src/native-session-codec.js";
import type { HookRegistryLike } from "../src/composite-hooks.js";

const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const nativeObject = (value: unknown) => {
  const saved = captureNativePersistenceJson(value);
  assert.ok(isNativeObject(saved));
  return saved;
};
const input = (event: NativeLifecycleInput["event"]): NativeLifecycleInput => ({
  event,
  dispatchToolUseID: id(900),
  phase: "ordinary",
  ...(event === "SessionStart"
    ? { start: { source: "startup", newPluginsOnly: false } }
    : {}),
  ...(event === "UserPromptSubmit"
    ? {
        prompt: {
          submitted: "owned",
          typed: "owned",
          suppressOriginalPrompt: false,
          stoppedText: "stopped",
        },
      }
    : {}),
});
async function commands(
  event: NativeLifecycleInput["event"],
  entries: {
    label: string;
    output?: unknown;
    delay?: number;
    exit?: number;
    once?: boolean;
    async?: boolean;
  }[],
) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-prepared-lifecycle-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "owned.mjs"),
    log = join(cwd, "log");
  await writeFile(
    script,
    `import {appendFileSync} from 'node:fs';for await(const p of process.stdin){};await new Promise(r=>setTimeout(r,Number(process.argv[3])));appendFileSync(process.argv[2],process.argv[4]+'\\n');process.stdout.write(process.argv[5]);process.exitCode=Number(process.argv[6]);`,
  );
  const declarations = entries.map((e) => ({
    type: "command",
    command: process.execPath,
    args: [
      script,
      log,
      String(e.delay ?? 0),
      e.label,
      typeof e.output === "string" ? e.output : JSON.stringify(e.output ?? {}),
      String(e.exit ?? 0),
    ],
    ...(e.once ? { once: true } : {}),
    ...(e.async ? { async: true } : {}),
  }));
  const registry = createHookRegistry([
    { source: "owned", hooks: { [event]: [{ hooks: declarations }] } },
  ]);
  onTestFinished(() => registry.close());
  const hookInput: HookInput = {
    hook_event_name: event,
    session_id: id(999),
    transcript_path: join(cwd, "no-transcript"),
    cwd,
    ...(event === "SessionStart"
      ? { source: "startup" }
      : event === "UserPromptSubmit"
        ? { prompt: "owned", source: "sdk" }
        : { stop_hook_active: false }),
  };
  const runOptions = (): Omit<
    HookRunOptions,
    "signal" | "validateUpdatedInput"
  > => ({ cwd, projectDir: cwd, env: {}, defaultTimeoutMs: 3000 });
  const lines = async () =>
    readFile(log, "utf8").then(
      (s) => s.trim().split("\n"),
      (): string[] => [],
    );
  return { registry, hookInput, runOptions, lines, declarations };
}
function capture() {
  let serial = 0;
  const stamp = () => ({
    uuid: id(++serial),
    timestamp: `2026-01-01T00:00:00.${String(serial).padStart(3, "0")}Z`,
  });
  const events: NativeLifecycleCreation[] = [],
    progress: NativeHookProgressRow[] = [],
    summaries: NativeStopHookSummaryCreation[] = [],
    unsupported: unknown[] = [],
    order: string[] = [];
  const host: NativeLifecycleCaptureHost = {
    stamp,
    capture(v) {
      events.push(v);
      order.push("attachment");
    },
    unsupported(v) {
      unsupported.push(v);
    },
  };
  return {
    stamp,
    events,
    progress,
    summaries,
    unsupported,
    order,
    host,
    serial: () => serial,
  };
}
function options(
  f: Awaited<ReturnType<typeof commands>>,
  c: ReturnType<typeof capture>,
  event: NativeLifecycleInput["event"],
  registry: HookRegistryLike = f.registry,
): NativeLifecycleRuntimeOptions {
  return {
    input: input(event),
    hookInput: nativeObject(f.hookInput),
    stages: {
      classicOrFunctionChain: known(false),
      managedOrRemoteTransport: known(false),
      activeGoalOrTaskEnforcement: known(false),
      backgroundRewake: known(false),
    },
    host: c.host,
    runner: nativeLifecyclePreparedCommandRegistry({
      registry,
      runOptions: f.runOptions,
      facts: () => ({
        output: known("structured"),
        command: known(process.execPath),
        structuredSuccessNotice: known(undefined),
        retainMessageForStop: known(false),
        retainContextForStop: known(true),
        hasProgress: known(true),
      }),
      finalDispatch: (_input, plan) => ({
        admission: { status: "admitted", source: "actual-final-dispatch" },
        origins: known(
          plan.candidates.map((v) => ({
            id: v.id,
            nativeOrigin: { namespace: "hook" as const, settingsSource: v.id },
          })),
        ),
        defaultShell: known("bash"),
        personalConfigRestricted: known(false),
        dispatchToolUseID: id(900),
        ...(event === "SessionStart" ? { matchQuery: "startup" } : {}),
      }),
      progressHost: {
        aliases: () => known([]),
        display: ({ candidate }) => {
          assert.ok(typeof candidate.hook.command === "string");
          return known({ command: candidate.hook.command });
        },
        stamp: c.stamp,
      },
    }),
    preparedCapture: {
      progress(row) {
        c.progress.push(row);
        c.order.push("progress");
      },
      summary: {
        host: { stamp: c.stamp },
        capture(v) {
          c.summaries.push(v);
          c.order.push("summary");
        },
      },
      ...(event === "SessionStart"
        ? {
            startup: {
              async finalize(v) {
                return {
                  status: "retained" as const,
                  source: "fresh-initial" as const,
                  creations: v.creations,
                };
              },
            },
          }
        : {}),
    },
  };
}
const context = (event: string, text: string) => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: text },
});

test("bound final preparation removes ordinary overlap once and executes the frozen winner without condition rematch", async () => {
  const f = await commands("Stop", [{ label: "once", once: true }]);
  let eligible = true;
  const registry = createHookRegistry(
    [
      {
        source: "owned",
        hooks: {
          Stop: [
            { hooks: [{ ...f.declarations[0], if: "admitted" }] },
            { hooks: [{ ...f.declarations[0], if: "admitted" }] },
          ],
        },
      },
    ],
    { matchesCondition: () => eligible },
  );
  onTestFinished(() => registry.close());
  const plan = await registry.prepareDispatch(f.hookInput, {
    ...f.runOptions(),
    signal: new AbortController().signal,
    preparedSelection: "bound-final",
  });
  assert.equal(plan.selection, "ordinary-command-key");
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0]?.id, "hook-1");
  eligible = false;
  const batch = await plan.runSelected(
    new Set(plan.candidates.map((v) => v.id)),
  );
  assert.equal(batch.results.length, 1);
  assert.deepEqual(await f.lines(), ["once"]);
  await assert.rejects(
    plan.runSelected(new Set(plan.candidates.map((v) => v.id))),
    /consumed/,
  );
  await plan.close();
});

test("prepared multi-backend lifecycle waits for every progress sink before any command, then summaries actual settlement-order contexts", async () => {
  const a = await commands("Stop", [
      { label: "slow", delay: 60, output: context("Stop", "SLOW") },
    ]),
    b = await commands("Stop", [
      { label: "fast", output: context("Stop", "FAST") },
    ]);
  const registry = createReducedScopedHookRegistry({
    ownerSessionId: id(999),
    defaultShell: "bash",
    personalConfigRestricted: false,
    backends: () => [
      {
        id: "a",
        registry: a.registry,
        nativeOrigin: () => ({ namespace: "hook", settingsSource: "a" }),
      },
      {
        id: "b",
        registry: b.registry,
        nativeOrigin: () => ({ namespace: "hook", settingsSource: "b" }),
      },
    ],
  });
  onTestFinished(() => registry.close());
  const c = capture(),
    o = options(a, c, "Stop", registry);
  let yielded = 0;
  assert.ok(o.preparedCapture);
  o.preparedCapture.progress = async (row) => {
    yielded++;
    c.progress.push(row);
    assert.deepEqual(await a.lines(), []);
    assert.deepEqual(await b.lines(), []);
    await Promise.resolve();
  };
  const decision = await runNativeLifecycleHookDispatch(
    o,
    new AbortController().signal,
  );
  assert.equal(yielded, 2);
  assert.equal(decision.continue, true);
  assert.deepEqual(await a.lines(), ["slow"]);
  assert.deepEqual(await b.lines(), ["fast"]);
  assert.equal(c.summaries.length, 1);
  const s = c.summaries[0];
  assert.equal(s?.status, "created");
  if (s?.status !== "created") throw new Error("summary missing");
  assert.equal(s.row.hookCount, 2);
  assert.deepEqual(s.row.hookAdditionalContext, ["FAST", "SLOW"]);
  assert.equal(s.row.hasOutput, true);
  assert.equal(s.row.hookInfos.length, 2);
  assert.ok(s.row.hookInfos.every((v) => typeof v.durationMs === "number"));
  assert.equal(
    new Set([
      ...c.progress.map((v) => v.uuid),
      ...c.events.map((v) => v.event.uuid),
      s.row.uuid,
    ]).size,
    7,
  );
});

test("Stop after-yield abort closes before the next stamp or command and creates no summary", async () => {
  const f = await commands("Stop", [{ label: "A" }, { label: "B" }]),
    c = capture(),
    o = options(f, c, "Stop"),
    controller = new AbortController();
  assert.ok(o.preparedCapture);
  o.preparedCapture.progress = (row) => {
    c.progress.push(row);
    controller.abort(new Error("owned cancel"));
  };
  const result = await runNativeLifecycleHookDispatch(o, controller.signal);
  assert.equal(c.serial(), 1);
  assert.equal(c.progress.length, 1);
  assert.deepEqual(await f.lines(), []);
  assert.equal(result.preventContinuation, true);
  assert.deepEqual(c.summaries, [
    { status: "absent", reason: "not-normally-drained" },
  ]);
});

test("progress sink failure retires only its lease without consuming once or launching any backend", async () => {
  const f = await commands("Stop", [{ label: "A", once: true }]),
    c = capture(),
    o = options(f, c, "Stop");
  assert.ok(o.preparedCapture);
  o.preparedCapture.progress = () => {
    throw new Error("sink failed");
  };
  await assert.rejects(
    runNativeLifecycleHookDispatch(o, new AbortController().signal),
    NativeLifecycleCaptureError,
  );
  assert.deepEqual(await f.lines(), []);
  assert.equal(c.serial(), 1);
  assert.deepEqual(c.summaries, []);
  const next = capture();
  await runNativeLifecycleHookDispatch(
    options(f, next, "Stop"),
    new AbortController().signal,
  );
  assert.deepEqual(await f.lines(), ["A"]);
});

test("summary uses raw block reason, contexts, actual prevent reason and diagnostic output; no duplicate progress on settlement", async () => {
  const f = await commands("Stop", [
      {
        label: "A",
        output: {
          decision: "block",
          reason: "<raw>FAIL</raw>",
          continue: false,
          stopReason: "ACTUAL",
          ...context("Stop", "CTX"),
        },
      },
    ]),
    c = capture();
  const result = await runNativeLifecycleHookDispatch(
    options(f, c, "Stop"),
    new AbortController().signal,
  );
  assert.equal(c.progress.length, 1);
  assert.equal(result.preventContinuation, true);
  const summary = c.summaries[0];
  assert.ok(summary?.status === "created");
  assert.deepEqual(summary.row.hookErrors, ["<raw>FAIL</raw>"]);
  assert.deepEqual(summary.row.hookAdditionalContext, ["CTX"]);
  assert.equal(summary.row.preventedContinuation, true);
  assert.equal(summary.row.stopReason, "ACTUAL");
});

test("unsupported command failure preserves progress/evidence but cannot invent a normal summary", async () => {
  const f = await commands("Stop", [
      { label: "failure", exit: 2, output: "owned error" },
    ]),
    c = capture();
  const result = await runNativeLifecycleHookDispatch(
    options(f, c, "Stop"),
    new AbortController().signal,
  );
  assert.equal(c.progress.length, 1);
  assert.ok(result.unsupported.length > 0);
  assert.deepEqual(c.summaries, [
    { status: "absent", reason: "not-normally-drained" },
  ]);
});

test("SessionStart buffers the entire vector until actual final owner selects retained rows", async () => {
  const f = await commands("SessionStart", [
      { label: "start", output: context("SessionStart", "OLD") },
    ]),
    c = capture(),
    o = options(f, c, "SessionStart");
  assert.ok(o.preparedCapture?.startup);
  let buffered: readonly NativeLifecycleStartupCreation[] = [];
  o.preparedCapture.startup.finalize = async (v) => {
    buffered = v.creations;
    assert.equal(c.events.length, 0);
    assert.equal(c.progress.length, 0);
    return {
      status: "retained",
      source: "actual-LBe",
      creations: v.creations.filter((e) => e.kind === "progress"),
    };
  };
  const result = await runNativeLifecycleHookDispatch(
    o,
    new AbortController().signal,
  );
  assert.deepEqual(
    buffered.map((e) => e.kind),
    ["progress", "attachment", "attachment"],
  );
  assert.equal(c.progress.length, 1);
  assert.equal(c.events.length, 0);
  assert.equal(result.emitted.length, 0);
  assert.equal(result.startupRetention, "retained");
});

test("SessionStart pending final ownership publishes nothing and has no invented fresh fallback", async () => {
  const f = await commands("SessionStart", [
      { label: "start", output: context("SessionStart", "CTX") },
    ]),
    c = capture(),
    o = options(f, c, "SessionStart");
  assert.ok(o.preparedCapture?.startup);
  o.preparedCapture.startup.finalize = async () => ({ status: "pending" });
  const result = await runNativeLifecycleHookDispatch(
    o,
    new AbortController().signal,
  );
  assert.equal(result.startupRetention, "pending");
  assert.deepEqual(c.events, []);
  assert.deepEqual(c.progress, []);
});

test("summary sink failure cannot stamp or execute again; missing actual-prefix capture refuses before launch", async () => {
  const f = await commands("Stop", [{ label: "A" }]),
    c = capture(),
    o = options(f, c, "Stop");
  assert.ok(o.preparedCapture?.summary);
  o.preparedCapture.summary.capture = (v) => {
    c.summaries.push(v);
    throw new Error("summary sink");
  };
  await assert.rejects(
    runNativeLifecycleHookDispatch(o, new AbortController().signal),
    NativeLifecycleCaptureError,
  );
  assert.equal(c.summaries.length, 1);
  assert.deepEqual(await f.lines(), ["A"]);
  const n = capture(),
    missing = options(f, n, "Stop");
  delete missing.preparedCapture;
  const result = await runNativeLifecycleHookDispatch(
    missing,
    new AbortController().signal,
  );
  assert.ok(result.unsupported.length);
  assert.equal(n.serial(), 0);
  assert.deepEqual(await f.lines(), ["A"]);
});

test("actual startup transform retains source UUID/time and renders changed payload before first publication", async () => {
  const f = await commands("SessionStart", [
      { label: "start", output: context("SessionStart", "OLD\nNEW") },
    ]),
    c = capture(),
    o = options(f, c, "SessionStart");
  assert.ok(o.preparedCapture?.startup);
  let originalUUID = "",
    originalTime = "";
  o.preparedCapture.startup.finalize = async (v) => ({
    status: "retained",
    source: "actual-LBe",
    creations: v.creations.map((e) => {
      if (
        e.kind !== "attachment" ||
        !isNativeObject(e.creation.event.attachment) ||
        e.creation.event.attachment.type !== "hook_additional_context"
      )
        return e;
      originalUUID = e.creation.event.uuid;
      originalTime = e.creation.event.timestamp;
      const event = createNativeAttachmentEvent(
        { ...e.creation.event.attachment, content: ["NEW"] },
        { uuid: originalUUID, timestamp: originalTime },
      );
      return { kind: "attachment", creation: { ...e.creation, event } };
    }),
  });
  const result = await runNativeLifecycleHookDispatch(
    o,
    new AbortController().signal,
  );
  const kept = c.events.at(-1);
  assert.ok(kept);
  assert.equal(kept.event.uuid, originalUUID);
  assert.equal(kept.event.timestamp, originalTime);
  assert.ok(isNativeObject(kept.event.attachment));
  assert.deepEqual(kept.event.attachment.content, ["NEW"]);
  assert.equal(JSON.stringify(kept.event).includes("OLD"), false);
  assert.equal(result.emitted.at(-1)?.event.uuid, originalUUID);
});

test("startup finalizer cannot reorder rows or introduce another creation identity", async () => {
  for (const mode of ["reorder", "invent"] as const) {
    const f = await commands("SessionStart", [
        { label: "start", output: context("SessionStart", "CTX") },
      ]),
      c = capture(),
      o = options(f, c, "SessionStart");
    assert.ok(o.preparedCapture?.startup);
    o.preparedCapture.startup.finalize = async (v) => ({
      status: "retained",
      source: "actual-LBe",
      creations:
        mode === "reorder"
          ? [...v.creations].reverse()
          : v.creations.map((e) =>
              e.kind === "progress"
                ? { ...e, row: { ...e.row, uuid: id(898) } }
                : e,
            ),
    });
    await assert.rejects(
      runNativeLifecycleHookDispatch(o, new AbortController().signal),
      NativeLifecycleCaptureError,
    );
    assert.deepEqual(c.events, []);
    assert.deepEqual(c.progress, []);
  }
});

test("qvo discard remains an actual per-progress callback and abort does not apply Stop prefix truncation", async () => {
  const f = await commands("UserPromptSubmit", [
      { label: "A" },
      { label: "B" },
    ]),
    c = capture(),
    o = options(f, c, "UserPromptSubmit"),
    controller = new AbortController();
  assert.ok(o.preparedCapture);
  const policies: string[] = [];
  o.preparedCapture.progress = (row, policy) => {
    c.progress.push(row);
    policies.push(policy.consumer);
    controller.abort(new Error("qvo abort"));
  };
  const result = await runNativeLifecycleHookDispatch(o, controller.signal);
  assert.equal(c.progress.length, 2);
  assert.deepEqual(policies, ["user-prompt-submit", "user-prompt-submit"]);
  assert.deepEqual(await f.lines(), []);
  assert.equal(result.wasCancelled, true);
  assert.deepEqual(c.summaries, []);
});

test("hasProgress false fails locally without fabricating extra rows", async () => {
  const f = await commands("Stop", [{ label: "A" }]),
    c = capture(),
    o = options(f, c, "Stop");
  o.runner = nativeLifecyclePreparedCommandRegistry({
    registry: f.registry,
    runOptions: f.runOptions,
    facts: () => ({
      output: known("plain"),
      command: known(process.execPath),
      structuredSuccessNotice: known(undefined),
      retainMessageForStop: known(false),
      retainContextForStop: known(false),
      hasProgress: known(false),
    }),
    finalDispatch: (_input, plan) => ({
      admission: { status: "admitted", source: "actual-final-dispatch" },
      origins: known(
        plan.candidates.map((v) => ({
          id: v.id,
          nativeOrigin: { namespace: "hook" as const },
        })),
      ),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: id(900),
    }),
    progressHost: {
      aliases: () => known([]),
      display: () => known({ command: process.execPath }),
      stamp: c.stamp,
    },
  });
  await assert.rejects(
    runNativeLifecycleHookDispatch(o, new AbortController().signal),
    NativeLifecycleCaptureError,
  );
  assert.equal(c.progress.length, 1);
  assert.deepEqual(c.events, []);
  assert.deepEqual(c.summaries, []);
  assert.deepEqual(await f.lines(), ["A"]);
});

test("bound native prefix retains unsupported async evidence and never creates an ordinary completion summary", async () => {
  const f = await commands("Stop", [
      { label: "async", async: true, output: context("Stop", "ASYNC") },
    ]),
    c = capture();
  const result = await runNativeLifecycleHookDispatch(
    options(f, c, "Stop"),
    new AbortController().signal,
  );
  assert.equal(c.progress.length, 1);
  assert.ok(result.unsupported.length > 0);
  assert.deepEqual(c.summaries, [
    { status: "absent", reason: "not-normally-drained" },
  ]);
  await f.registry.close();
});

test("a bound once plan detects intervening consumption before launching any of its frozen winners", async () => {
  const f = await commands("Stop", [
    { label: "A", once: true },
    { label: "B", once: true },
  ]);
  const plan = await f.registry.prepareDispatch(f.hookInput, {
    ...f.runOptions(),
    signal: new AbortController().signal,
    preparedSelection: "bound-final",
  });
  const other = await f.registry.prepareDispatch(f.hookInput, {
    ...f.runOptions(),
    signal: new AbortController().signal,
    preparedSelection: "bound-final",
  });
  await other.runSelected(new Set([other.candidates[1]?.id ?? ""]));
  await other.close();
  await assert.rejects(
    plan.runSelected(new Set(plan.candidates.map((v) => v.id))),
    /consumed by another/,
  );
  assert.deepEqual(await f.lines(), ["B"]);
  await plan.close();
});

test("unknown native origin facts are explicit unsupported before any stamp or command; no port-source inference", async () => {
  const f = await commands("Stop", [{ label: "A" }]),
    c = capture(),
    o = options(f, c, "Stop");
  o.runner = nativeLifecyclePreparedCommandRegistry({
    registry: f.registry,
    runOptions: f.runOptions,
    facts: () => {
      throw new Error("must not observe");
    },
    finalDispatch: () => ({
      admission: { status: "admitted", source: "actual-final-dispatch" },
      origins: {
        status: "unsupported",
        reason: "native settings provenance unavailable",
      },
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: id(900),
    }),
    progressHost: {
      aliases: () => {
        throw new Error("no aliases");
      },
      display: () => {
        throw new Error("no display");
      },
      stamp: c.stamp,
    },
  });
  const result = await runNativeLifecycleHookDispatch(
    o,
    new AbortController().signal,
  );
  assert.ok(result.unsupported.length);
  assert.equal(c.serial(), 0);
  assert.deepEqual(await f.lines(), []);
});

test("a progress identity host failure concurrent with abort remains fatal and is never reclassified as cancellation", async () => {
  const f = await commands("Stop", [{ label: "A" }]),
    c = capture(),
    o = options(f, c, "Stop"),
    controller = new AbortController();
  o.runner = nativeLifecyclePreparedCommandRegistry({
    registry: f.registry,
    runOptions: f.runOptions,
    facts: () => {
      throw new Error("no command");
    },
    finalDispatch: (_input, plan) => ({
      admission: { status: "admitted", source: "actual-final-dispatch" },
      origins: known(
        plan.candidates.map((v) => ({
          id: v.id,
          nativeOrigin: { namespace: "hook" as const },
        })),
      ),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: id(900),
    }),
    progressHost: {
      aliases: () => known([]),
      display: () => known({ command: process.execPath }),
      stamp() {
        controller.abort(new Error("cancel"));
        throw new Error("actual identity owner failed");
      },
    },
  });
  await assert.rejects(
    runNativeLifecycleHookDispatch(o, controller.signal),
    NativeLifecycleCaptureError,
  );
  assert.deepEqual(await f.lines(), []);
  assert.deepEqual(c.summaries, []);
});

test("empty actual success has no output in Eua and command capture failure drains siblings before rejection", async () => {
  const f = await commands("Stop", [{ label: "empty", output: "" }]),
    c = capture();
  await runNativeLifecycleHookDispatch(
    options(f, c, "Stop"),
    new AbortController().signal,
  );
  const summary = c.summaries[0];
  assert.ok(summary?.status === "created");
  assert.equal(summary.row.hasOutput, false);
  assert.deepEqual(summary.row.hookErrors, []);
  const g = await commands("Stop", [
      { label: "fast", output: context("Stop", "FAST") },
      { label: "slow", delay: 80, output: context("Stop", "SLOW") },
    ]),
    d = capture(),
    o = options(g, d, "Stop");
  o.host = {
    ...d.host,
    capture() {
      throw new Error("attachment sink failed");
    },
  };
  await assert.rejects(
    runNativeLifecycleHookDispatch(o, new AbortController().signal),
    NativeLifecycleCaptureError,
  );
  assert.deepEqual((await g.lines()).sort(), ["fast", "slow"]);
  assert.deepEqual(d.summaries, []);
});

test("Stop accumulator snapshots actual rows and issues its completion only once", () => {
  const accumulator = createNativeStopHookAccumulator(),
    c = capture();
  const row: NativeHookProgressRow = {
    type: "progress",
    uuid: id(700),
    timestamp: "2026-01-01T00:00:00.000Z",
    parentToolUseID: id(900),
    toolUseID: id(900),
    data: {
      type: "hook_progress",
      hookEvent: "Stop",
      hookName: "Stop",
      command: "ACTUAL",
    },
  };
  const mutable = { ...row, data: { ...row.data } };
  accumulator.progress(mutable);
  mutable.data = { ...mutable.data, command: "FORGED" };
  const result = accumulator.finish({ kind: "completed" }, { stamp: c.stamp });
  assert.ok(result.status === "created");
  assert.equal(result.row.hookInfos[0]?.command, "ACTUAL");
  assert.throws(
    () => accumulator.finish({ kind: "completed" }, { stamp: c.stamp }),
    /already finalized/,
  );
  assert.equal(c.serial(), 1);
});

test("summary stamp failure concurrent with abort propagates the owner error without a second finish", async () => {
  const f = await commands("Stop", [{ label: "A" }]),
    c = capture(),
    o = options(f, c, "Stop"),
    controller = new AbortController();
  assert.ok(o.preparedCapture?.summary);
  o.preparedCapture.summary.host.stamp = () => {
    controller.abort(new Error("cancel"));
    throw new Error("summary identity owner failed");
  };
  await assert.rejects(
    runNativeLifecycleHookDispatch(o, controller.signal),
    NativeLifecycleCaptureError,
  );
  assert.deepEqual(c.summaries, []);
  assert.deepEqual(await f.lines(), ["A"]);
});
