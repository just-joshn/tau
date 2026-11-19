import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import {
  createHookRegistry,
  type HookBatchResult,
  type HookRegistry,
  type HookResult,
  type PreparedHookDispatch,
} from "../../src/hooks.js";
import type { HookRegistryLike } from "../../src/composite-hooks.js";
import {
  nativeLifecyclePreparedCommandRegistry,
  type NativeLifecycleFinalDispatchFacts,
} from "../../src/native-lifecycle-prepared.js";
import {
  NativeLifecycleCaptureError,
  runNativeLifecycleHookDispatch,
  type NativeLifecycleCommandFacts,
  type NativeLifecycleRuntimeOptions,
} from "../../src/native-lifecycle-hooks.js";
import type { NativeHookProgressRow } from "../../src/native-hook-progress.js";
import type { NativePromptFact } from "../../src/native-prompt-snapshot.js";
import { captureNativePersistenceJson } from "../../src/native-persistence-events.js";
import { isNativeObject } from "../../src/native-session-codec.js";

const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-2222-2222-2222-222222222222`;
const DISPATCH = id(900);
const capturedInput = captureNativePersistenceJson({
  hook_event_name: "Stop",
  session_id: id(999),
  transcript_path: "/edge/no-transcript",
  cwd: "/edge",
  stop_hook_active: false,
});
if (!isNativeObject(capturedInput)) throw new Error("hook input is an object");
const hookInput = capturedInput;
const empty: HookBatchResult = {
  results: [],
  background: [],
  additionalContext: [],
  systemMessages: [],
  blockingErrors: [],
  preventContinuation: false,
  cancelled: false,
  watchPaths: [],
  reloadSkills: false,
};
const progressFacts = (): NativeLifecycleCommandFacts => ({
  output: known("plain"),
  command: known("edge-a"),
  structuredSuccessNotice: known(undefined),
  retainMessageForStop: known(false),
  retainContextForStop: known(false),
  hasProgress: known(true),
});

type Prepare = NonNullable<HookRegistryLike["prepareDispatch"]>;
/** A real bound-final registry whose prepared plan a test may alter; no command ever runs. */
function registry(
  commands: readonly string[],
  change: (
    plan: PreparedHookDispatch,
    options: Parameters<Prepare>[1],
  ) => PreparedHookDispatch = (plan) => ({
    ...plan,
    candidates: plan.candidates,
    runSelected: async () => empty,
  }),
): HookRegistryLike {
  const base: HookRegistry = createHookRegistry([
    {
      source: "owned",
      hooks: {
        Stop: commands.map((command) => ({
          hooks: [{ type: "command", command }],
        })),
      },
    },
  ]);
  onTestFinished(() => base.close());
  return {
    list: (event) => base.list(event),
    run: (input, options) => base.run(input, options),
    close: () => base.close(),
    prepareDispatch: async (input, options) =>
      change(await base.prepareDispatch(input, options), options),
  };
}
function harness(
  hooks: HookRegistryLike,
  overrides: {
    finalDispatch?: (
      candidates: readonly { id: string }[],
    ) => NativeLifecycleFinalDispatchFacts;
    facts?: () => NativeLifecycleCommandFacts;
  } = {},
) {
  let serial = 0;
  const stamp = () => ({
    uuid: id(++serial),
    timestamp: `2026-01-01T00:00:00.${String(serial).padStart(3, "0")}Z`,
  });
  const progress: NativeHookProgressRow[] = [];
  const runner = nativeLifecyclePreparedCommandRegistry({
    registry: hooks,
    runOptions: () => ({
      cwd: "/edge",
      projectDir: "/edge",
      env: {},
      defaultTimeoutMs: 3000,
    }),
    facts: overrides.facts ?? progressFacts,
    finalDispatch: (_input, plan) =>
      overrides.finalDispatch?.(plan.candidates) ?? {
        admission: { status: "admitted", source: "actual-final-dispatch" },
        origins: known(
          plan.candidates.map((candidate) => ({
            id: candidate.id,
            nativeOrigin: { namespace: "hook" as const },
          })),
        ),
        defaultShell: known("bash"),
        personalConfigRestricted: known(false),
        dispatchToolUseID: DISPATCH,
      },
    progressHost: {
      aliases: () => known([]),
      display: ({ candidate }) => {
        assert.ok(typeof candidate.hook.command === "string");
        return known({ command: candidate.hook.command });
      },
      stamp,
    },
  });
  const options: NativeLifecycleRuntimeOptions = {
    input: { event: "Stop", dispatchToolUseID: DISPATCH, phase: "ordinary" },
    hookInput,
    stages: {
      classicOrFunctionChain: known(false),
      managedOrRemoteTransport: known(false),
      activeGoalOrTaskEnforcement: known(false),
      backgroundRewake: known(false),
    },
    host: { stamp, capture: () => {}, unsupported: () => {} },
    runner,
    preparedCapture: {
      progress(row) {
        progress.push(row);
      },
      summary: { host: { stamp }, capture: () => {} },
    },
  };
  return {
    runner,
    progress,
    run: () =>
      runNativeLifecycleHookDispatch(options, new AbortController().signal),
  };
}
const settled = (
  hookId: string,
  command = "edge-a",
): HookResult & { id: string } => ({
  id: hookId,
  event: "Stop",
  origin: { source: "owned" },
  command,
  status: "success",
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
});
/** Reports a settlement the way a registry does, then finishes without spawning. */
function settles(
  pick: (plan: PreparedHookDispatch) => HookResult,
): Parameters<typeof registry>[1] {
  return (plan, options) => ({
    ...plan,
    candidates: plan.candidates,
    runSelected: async () => {
      const result = pick(plan);
      await options.onResult?.(result, {
        background: false,
        hook: { type: "command", command: result.command },
      });
      return { ...empty, results: [result] };
    },
  });
}

test("an actual-prefix runner refuses to run without its progress consumer", async () => {
  const { runner } = harness(registry(["edge-a"]));
  await assert.rejects(
    runner.run(hookInput, new AbortController().signal, async () => {}),
    NativeLifecycleCaptureError,
  );
});

test("a registry without prepared dispatch or final proof is refused before any progress", async () => {
  const base = registry(["edge-a"]);
  const bare = harness({
    list: (event) => base.list(event),
    run: (input, options) => base.run(input, options),
    close: () => base.close(),
  });
  await assert.rejects(bare.run(), /lacks prepared dispatch/);
  assert.deepEqual(bare.progress, []);

  const unproven = harness(
    registry(["edge-a"], (plan) => {
      const { selection: _selection, ...rest } = plan;
      return { ...rest, candidates: plan.candidates };
    }),
  );
  await assert.rejects(unproven.run(), NativeLifecycleCaptureError);
  assert.deepEqual(unproven.progress, []);
});

test("final origins must cover each candidate exactly", async () => {
  const short = harness(registry(["edge-a"]), {
    finalDispatch: () => ({
      admission: { status: "admitted", source: "actual-final-dispatch" },
      origins: known([]),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: DISPATCH,
    }),
  });
  await assert.rejects(short.run(), NativeLifecycleCaptureError);
  const foreign = harness(registry(["edge-a"]), {
    finalDispatch: () => ({
      admission: { status: "admitted", source: "actual-final-dispatch" },
      origins: known([{ id: "foreign", nativeOrigin: { namespace: "hook" } }]),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: DISPATCH,
    }),
  });
  await assert.rejects(foreign.run(), NativeLifecycleCaptureError);
  assert.deepEqual([...short.progress, ...foreign.progress], []);
});

test("a bound selection that native reduction would shrink is refused", async () => {
  const duplicated = harness(
    registry(["edge-a"], (plan) => {
      const [first] = plan.candidates;
      assert.ok(first);
      return {
        ...plan,
        candidates: [first, { ...first, id: `${first.id}-twin` }],
        runSelected: async () => empty,
      };
    }),
  );
  await assert.rejects(duplicated.run(), NativeLifecycleCaptureError);
  assert.deepEqual(duplicated.progress, []);
});

test("an unsupported admission is reported as unsupported, and a skipped one runs nothing", async () => {
  let ran = 0;
  const count: Parameters<typeof registry>[1] = (plan) => ({
    ...plan,
    candidates: plan.candidates,
    runSelected: async () => {
      ran++;
      return empty;
    },
  });
  const unsupported = harness(registry(["edge-a"], count), {
    finalDispatch: () => ({
      admission: { status: "unsupported", reasons: ["EDGE_ADMISSION"] },
      origins: known([]),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: DISPATCH,
    }),
  });
  const decision = await unsupported.run();
  assert.match(JSON.stringify(decision.unsupported), /EDGE_ADMISSION/);
  const skipped = harness(registry(["edge-a"], count), {
    finalDispatch: () => ({
      admission: { status: "skipped", reason: "trust" },
      origins: known([]),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: DISPATCH,
    }),
  });
  const quiet = await skipped.run();
  assert.deepEqual(quiet.unsupported, []);
  assert.deepEqual(skipped.progress, []);
  assert.equal(ran, 0);
});

test("a settlement must belong to an unobserved progress candidate with known facts", async () => {
  const ghost = harness(
    registry(
      ["edge-a"],
      settles(() => settled("ghost")),
    ),
  );
  await assert.rejects(ghost.run(), NativeLifecycleCaptureError);
  assert.equal(ghost.progress.length, 1);

  const unknown = harness(
    registry(
      ["edge-a"],
      settles((plan) => settled(plan.candidates[0]?.id ?? "")),
    ),
    {
      facts: () => ({
        ...progressFacts(),
        hasProgress: { status: "unsupported", reason: "EDGE_UNKNOWN" },
      }),
    },
  );
  await assert.rejects(unknown.run(), NativeLifecycleCaptureError);
  assert.equal(unknown.progress.length, 1);
});

test("a failed plan close fails the dispatch whether or not it already failed", async () => {
  const closing: Parameters<typeof registry>[1] = (plan) => ({
    ...plan,
    candidates: plan.candidates,
    runSelected: async () => empty,
    close: async () => {
      await plan.close();
      throw new Error("EDGE_CLOSE");
    },
  });
  const afterSuccess = harness(registry(["edge-a"], closing));
  await assert.rejects(afterSuccess.run(), (error: unknown) => {
    assert.ok(error instanceof NativeLifecycleCaptureError);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 1);
    return true;
  });

  const afterFailure = harness(registry(["edge-a"], closing), {
    finalDispatch: () => ({
      admission: { status: "admitted", source: "actual-final-dispatch" },
      origins: known([]),
      defaultShell: known("bash"),
      personalConfigRestricted: known(false),
      dispatchToolUseID: DISPATCH,
    }),
  });
  await assert.rejects(afterFailure.run(), (error: unknown) => {
    assert.ok(error instanceof NativeLifecycleCaptureError);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    return true;
  });
});
