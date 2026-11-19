import assert from "node:assert/strict";
import { test } from "bun:test";
import { createNativeStopHookAccumulator } from "../../src/native-stop-hook-accumulator.js";
import type { NativeHookProgressRow } from "../../src/native-hook-progress.js";
import type {
  NativeLifecycleCause,
  NativeLifecycleYield,
} from "../../src/native-lifecycle-hooks.js";
import type { NativeObject } from "../../src/native-session-codec.js";

const DISPATCH = "00000000-4444-4444-4444-000000000900";
const cause: NativeLifecycleCause = {
  event: "Stop",
  dispatchToolUseID: DISPATCH,
  branch: "edge",
};
let serial = 0;
const stamp = () => ({
  uuid: `00000000-4444-4444-4444-${String(++serial).padStart(12, "0")}`,
  timestamp: "2026-01-01T00:00:00.000Z",
});
function row(command: string, promptText?: string): NativeHookProgressRow {
  return {
    type: "progress",
    ...stamp(),
    parentToolUseID: DISPATCH,
    toolUseID: DISPATCH,
    data: {
      type: "hook_progress",
      hookEvent: "Stop",
      hookName: "Stop",
      command,
      ...(promptText === undefined ? {} : { promptText }),
    },
  };
}
const message = (
  attachment: NativeObject,
): Extract<NativeLifecycleYield, { kind: "message" }> => ({
  kind: "message",
  retainForStop: false,
  creation: {
    cause,
    event: { type: "attachment", ...stamp(), attachment },
  },
});
function summary(
  accumulator: ReturnType<typeof createNativeStopHookAccumulator>,
) {
  const created = accumulator.finish({ kind: "completed" }, { stamp });
  assert.ok(created.status === "created");
  return created.row;
}

test("hook failures become summary errors, with the exit code when stderr is empty", () => {
  const accumulator = createNativeStopHookAccumulator();
  accumulator.progress(row("edge-fail"));
  accumulator.progress(row("edge-quiet"));
  accumulator.progress(row("edge-crash"));
  accumulator.observed(
    message({
      type: "hook_non_blocking_error",
      hookEvent: "Stop",
      command: "edge-fail",
      durationMs: 7,
      exitCode: 2,
      stderr: "EDGE_STDERR",
    }),
  );
  accumulator.observed(
    message({
      type: "hook_non_blocking_error",
      hookEvent: "SubagentStop",
      command: "edge-quiet",
      exitCode: 3,
      stderr: "",
    }),
  );
  accumulator.observed(
    message({
      type: "hook_error_during_execution",
      hookEvent: "Stop",
      command: "edge-unlisted",
      durationMs: 4,
      content: "EDGE_CRASH",
    }),
  );
  const saved = summary(accumulator);
  assert.deepEqual(saved.hookErrors, [
    "EDGE_STDERR",
    "Exit code 3",
    "EDGE_CRASH",
  ]);
  assert.equal(saved.hasOutput, true);
  assert.deepEqual(saved.hookInfos, [
    { command: "edge-fail", durationMs: 7 },
    { command: "edge-quiet" },
    { command: "edge-crash" },
  ]);
});

test("malformed Stop failure attachments are refused", () => {
  const missingExit = createNativeStopHookAccumulator();
  assert.throws(
    () =>
      missingExit.observed(
        message({ type: "hook_non_blocking_error", hookEvent: "Stop" }),
      ),
    /Missing observed hook exit code/,
  );
  const missingContent = createNativeStopHookAccumulator();
  assert.throws(
    () =>
      missingContent.observed(
        message({ type: "hook_error_during_execution", hookEvent: "Stop" }),
      ),
    /Invalid observed hook error/,
  );
});

test("messages for other events and unrelated yields leave the summary unchanged", () => {
  const accumulator = createNativeStopHookAccumulator();
  accumulator.progress(row("edge-a"));
  accumulator.observed(
    message({
      type: "hook_non_blocking_error",
      hookEvent: "UserPromptSubmit",
      exitCode: 1,
      stderr: "FOREIGN",
    }),
  );
  accumulator.observed({ kind: "session-title", text: "EDGE" });
  const saved = summary(accumulator);
  assert.deepEqual(saved.hookErrors, []);
  assert.equal(saved.hasOutput, false);
});

test("a prevention without a reason gets the default reason", () => {
  const accumulator = createNativeStopHookAccumulator();
  accumulator.progress(row("edge-a"));
  accumulator.observed({ kind: "prevent", cause });
  const saved = summary(accumulator);
  assert.equal(saved.preventedContinuation, true);
  assert.equal(saved.stopReason, "Stop hook prevented continuation");
});

test("prompt hooks keep their prompt text and commandless progress is counted but not listed", () => {
  const accumulator = createNativeStopHookAccumulator();
  accumulator.progress(row("edge-prompt", "EDGE_PROMPT_TEXT"));
  accumulator.progress(row(""));
  const saved = summary(accumulator);
  assert.equal(saved.hookCount, 2);
  assert.deepEqual(saved.hookInfos, [
    { command: "edge-prompt", promptText: "EDGE_PROMPT_TEXT" },
  ]);
});

test("an orphaned consumer produces no summary and a finished accumulator takes no more input", () => {
  const accumulator = createNativeStopHookAccumulator();
  accumulator.progress(row("edge-a"));
  assert.deepEqual(accumulator.finish({ kind: "orphaned" }, { stamp }), {
    status: "absent",
    reason: "not-normally-drained",
  });
  assert.throws(() => accumulator.progress(row("edge-b")), /is finished/);
  assert.throws(
    () => accumulator.observed({ kind: "session-title", text: "late" }),
    /is finished/,
  );
});
