import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  composeHookRegistries,
  type HookRegistryLike,
} from "../../src/composite-hooks.js";
import type { HookBatchResult, HookInput } from "../../src/hooks.js";

const batch = (overrides: Partial<HookBatchResult> = {}): HookBatchResult => ({
  results: [],
  background: [],
  additionalContext: [],
  systemMessages: [],
  blockingErrors: [],
  preventContinuation: false,
  cancelled: false,
  watchPaths: [],
  reloadSkills: false,
  ...overrides,
});
const registry = (result: HookBatchResult): HookRegistryLike => ({
  list: () => [],
  run: async () => result,
  close: async () => {},
});
const input = (hook_event_name: HookInput["hook_event_name"]): HookInput => ({
  hook_event_name,
  session_id: "session",
  transcript_path: "/tmp/transcript.json",
  cwd: "/tmp",
});
const options = {
  cwd: "/tmp",
  projectDir: "/tmp",
  env: {},
  signal: new AbortController().signal,
};

test("the strongest permission and its reason survive a weaker later decision", async () => {
  const merged = await composeHookRegistries(
    registry(batch({ permission: "allow", reason: "first allows" })),
    registry(batch({ permission: "deny", reason: "second denies" })),
    registry(batch({ permission: "ask", reason: "third asks" })),
  ).run(input("PreToolUse"), options);
  assert.equal(merged.permission, "deny");
  assert.equal(merged.reason, "second denies");
});

test("a winning permission without a reason leaves the reason unset", async () => {
  const merged = await composeHookRegistries(
    registry(batch()),
    registry(batch({ permission: "deny" })),
  ).run(input("PreToolUse"), options);
  assert.equal(merged.permission, "deny");
  assert.equal(merged.reason, undefined);
});

test("scalar outputs come from the last registry that set them", async () => {
  const merged = await composeHookRegistries(
    registry(
      batch({
        updatedInput: { path: "first" },
        stopReason: "first stop",
        sessionTitle: "first title",
      }),
    ),
    registry(
      batch({
        updatedInput: { path: "second" },
        initialUserMessage: "hello",
      }),
    ),
  ).run(input("SessionStart"), options);
  assert.deepEqual(merged.updatedInput, { path: "second" });
  assert.equal(merged.stopReason, "first stop");
  assert.equal(merged.sessionTitle, "first title");
  assert.equal(merged.initialUserMessage, "hello");
  assert.equal(merged.permission, undefined);
});
