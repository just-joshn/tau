import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  advanceNativeStopQuery,
  nativeStopStateAfterTools,
  type NativeStopQueryState,
} from "../../src/native-stop-query.js";
import { createNativeLifecycleConsumer } from "../../src/native-lifecycle-hooks.js";
import type { NativePromptFact } from "../../src/native-prompt-snapshot.js";

const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
async function decision(context = true, prevent = false) {
  let counter = 0;
  const consumer = createNativeLifecycleConsumer(
    { event: "Stop", dispatchToolUseID: "ACTUAL_DISPATCH", phase: "ordinary" },
    {
      stamp: () => ({
        uuid: `00000000-1111-1111-1111-${String(++counter).padStart(12, "0")}`,
        timestamp: "2026-11-18T00:00:00Z",
      }),
      capture: () => {},
      unsupported: () => assert.fail("Actual fixture is supported"),
    },
  );
  await consumer.consume({ kind: "progress", toolUseID: "ACTUAL_DISPATCH" });
  const cause = {
    event: "Stop" as const,
    dispatchToolUseID: "ACTUAL_DISPATCH",
    branch: "actual-test-yield",
  };
  if (context)
    await consumer.consume({
      kind: "context",
      content: ["ACTUAL_STOP_CONTEXT"],
      retainForStop: true,
      cause,
    });
  if (prevent)
    await consumer.consume({
      kind: "prevent",
      reason: "ACTUAL_PREVENT",
      cause,
    });
  return consumer.finish({ kind: "completed" });
}

test("ordinary Stop continuation increments actual query counters, including the source default eight-block cap", async () => {
  const produced = await decision();
  let state: NativeStopQueryState = { stopHookActive: false, blockingCount: 0 };
  for (let turn = 1; turn <= 9; turn++) {
    const before = structuredClone(state);
    const next = advanceNativeStopQuery({
      state,
      decision: produced,
      turn,
      maxTurns: 20,
      blockCap: known(undefined),
    });
    assert.deepEqual(state, before);
    if (turn <= 8) {
      assert.equal(next.kind, "continue");
      if (next.kind !== "continue") assert.fail();
      assert.deepEqual(next.state, {
        stopHookActive: true,
        blockingCount: turn,
      });
      assert.equal(next.nextTurn, turn + 1);
      state = next.state;
    } else {
      assert.equal(next.kind, "end");
      if (next.kind !== "end") assert.fail();
      assert.equal(next.reason, "block-cap");
      assert.equal(next.attemptedBlockingCount, 9);
      assert.match(next.warning ?? "", /9 consecutive times/);
      assert.equal(next.state.blockingCount, 8);
    }
    assert.ok(Object.isFrozen(next) && Object.isFrozen(next.state));
  }
});

test("maxTurns wins before cap lookup and actual nonpositive caps disable only the consecutive-block limit", async () => {
  const produced = await decision();
  const maximum = advanceNativeStopQuery({
    state: { stopHookActive: true, blockingCount: 9 },
    decision: produced,
    turn: 2,
    maxTurns: 2,
    blockCap: { status: "unsupported", reason: "MUST_NOT_BE_READ" },
  });
  assert.equal(maximum.kind, "end");
  if (maximum.kind !== "end") assert.fail();
  assert.equal(maximum.reason, "max-turns");
  assert.equal(maximum.nextTurn, 3);
  for (const cap of [0, -1]) {
    const next = advanceNativeStopQuery({
      state: { stopHookActive: true, blockingCount: 50 },
      decision: produced,
      turn: 2,
      maxTurns: 3,
      blockCap: known(cap),
    });
    assert.equal(next.kind, "continue");
    assert.equal(next.state.blockingCount, 51);
  }
  const fractional = advanceNativeStopQuery({
    state: { stopHookActive: false, blockingCount: 0 },
    decision: produced,
    turn: 1,
    maxTurns: 3,
    blockCap: known(0.5),
  });
  assert.equal(fractional.kind, "end");
});

test("prevent and an empty continuation end without consulting unused cap facts or inventing feedback", async () => {
  const state = { stopHookActive: true, blockingCount: 4 };
  for (const [produced, reason] of [
    [await decision(true, true), "prevented"],
    [await decision(false), "completed"],
  ] as const) {
    const next = advanceNativeStopQuery({
      state,
      decision: produced,
      turn: 1,
      maxTurns: 3,
      blockCap: { status: "unsupported", reason: "UNUSED" },
    });
    assert.equal(next.kind, "end");
    if (next.kind !== "end") assert.fail();
    assert.equal(next.reason, reason);
    assert.deepEqual(next.state, state);
    assert.equal(next.warning, undefined);
  }
});

test("ordinary tool batches reset consecutive blocks while the exact all-goal exception preserves active state", () => {
  const state = { stopHookActive: true, blockingCount: 7 };
  for (const names of [["SetGoal"], ["ProposeGoal", "PauseGoal", "GetGoal"]])
    assert.deepEqual(nativeStopStateAfterTools(state, names), state);
  for (const names of [
    [],
    ["Read"],
    ["SetGoal", "Read"],
    ["getgoal"],
    ["SetGoalExtra"],
  ])
    assert.deepEqual(nativeStopStateAfterTools(state, names), {
      stopHookActive: true,
      blockingCount: 0,
    });
});

test("unknown actual cap/consumer facts and malformed counters cannot authorize another query", async () => {
  const produced = await decision();
  const input = {
    state: { stopHookActive: false, blockingCount: 0 },
    decision: produced,
    turn: 1,
    maxTurns: 3,
    blockCap: known(undefined),
  };
  assert.throws(
    () =>
      advanceNativeStopQuery({
        ...input,
        blockCap: { status: "unsupported", reason: "ACTUAL_CAP_UNKNOWN" },
      }),
    /ACTUAL_CAP_UNKNOWN/,
  );
  assert.throws(
    () => advanceNativeStopQuery({ ...input, turn: 0 }),
    /actual ordinary query counters/,
  );
  assert.throws(
    () =>
      advanceNativeStopQuery({
        ...input,
        decision: { ...produced, continue: false },
      }),
    /reaction-only/,
  );
  assert.throws(
    () =>
      advanceNativeStopQuery({
        ...input,
        decision: {
          ...produced,
          unsupported: [
            {
              cause: {
                event: "Stop",
                dispatchToolUseID: "ACTUAL_DISPATCH",
                branch: "unknown-goal-owner",
              },
              facts: {},
              reasons: ["ACTUAL_GOAL_UNKNOWN"],
            },
          ],
        },
      }),
    /actual lifecycle decision/,
  );
});
