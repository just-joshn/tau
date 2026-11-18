import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeStartupFinalizer,
  type NativeStartupFinalizationInput,
} from "../../src/native-startup-finalizer.js";
import {
  createNativeAttachmentEvent,
  renderNativePersistenceAttachment,
} from "../../src/native-persistence-events.js";
import type { NativeLifecycleStartupCreation } from "../../src/native-lifecycle-hooks.js";

function fixture() {
  let id = 0;
  const context = (content: string[]): NativeLifecycleStartupCreation => ({
    kind: "attachment",
    creation: {
      cause: {
        event: "SessionStart",
        dispatchToolUseID: "ACTUAL_START",
        branch: "actual-context",
      },
      event: createNativeAttachmentEvent(
        {
          type: "hook_additional_context",
          hookName: "SessionStart",
          hookEvent: "SessionStart",
          toolUseID: "SessionStart",
          content,
        },
        {
          uuid: `00000000-1111-1111-1111-${String(++id).padStart(12, "0")}`,
          timestamp: "2026-11-18T00:00:00Z",
        },
      ),
    },
  });
  const input = (
    creations: NativeLifecycleStartupCreation[],
  ): NativeStartupFinalizationInput => ({
    creations,
    end: { kind: "completed" },
  });
  return { context, input };
}
test("final startup callback reads current history after capture and returns transformed causes/identities before publication", async () => {
  const f = fixture(),
    old = f.context(["OLD"]),
    current = f.context(["OLD", "NEW"]),
    gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  assert.equal(old.kind, "attachment");
  if (old.kind !== "attachment") assert.fail();
  const owner = createNativeStartupFinalizer({
    readHistory: async (actual) => {
      assert.ok(Object.isFrozen(actual.creations));
      entered.resolve();
      await gate.promise;
      return {
        status: "ready",
        source: "actual-LBe",
        rows: [old.creation.event],
      };
    },
    rendering: {
      render: ({ attachment }) => ({
        status: "known",
        value: {
          rendered: [...renderNativePersistenceAttachment(attachment)],
          renderedRole: "system",
        },
      }),
    },
  });
  const input = { ...f.input([current]) },
    result = owner.finalize(input);
  await entered.promise;
  input.creations = [];
  gate.resolve();
  const selected = await result;
  assert.equal(selected.status, "retained");
  if (selected.status !== "retained") assert.fail();
  const row = selected.creations[0];
  assert.ok(row && row.kind === "attachment" && current.kind === "attachment");
  assert.equal(row.creation.event.uuid, current.creation.event.uuid);
  assert.deepEqual(row.creation.cause, current.creation.cause);
  assert.match(JSON.stringify(row.creation.event.attachment), /NEW/);
  assert.doesNotMatch(JSON.stringify(row.creation.event.attachment), /OLD/);
  assert.match(JSON.stringify(current.creation.event.attachment), /OLD/);
});
test("pending startup requires actual whole-vector ownership and missing history facts cannot claim retained rows", async () => {
  const f = fixture(),
    input = f.input([f.context(["NEW"])]);
  const missing = await createNativeStartupFinalizer({
    readHistory: () => ({ status: "pending" }),
  }).finalize(input);
  assert.equal(missing.status, "unsupported");
  let owned: NativeStartupFinalizationInput | undefined;
  const pending = await createNativeStartupFinalizer({
    readHistory: () => ({ status: "pending" }),
    pending: (actual) => {
      owned = actual;
    },
  }).finalize(input);
  assert.equal(pending.status, "pending");
  assert.deepEqual(owned, input);
  assert.ok(Object.isFrozen(owned));
  const unresolved = await createNativeStartupFinalizer({
    readHistory: () => ({
      status: "unsupported",
      reasons: ["ACTUAL_HISTORY_OWNER_UNAVAILABLE"],
      facts: {},
    }),
  }).finalize(input);
  assert.equal(unresolved.status, "unsupported");
});
test("fresh source cannot overwrite existing startup ownership and duplicate source creation identities reject", async () => {
  const f = fixture(),
    prior = f.context(["OLD"]),
    next = f.context(["NEW"]);
  if (prior.kind !== "attachment") assert.fail();
  const fresh = createNativeStartupFinalizer({
    readHistory: () => ({
      status: "ready",
      source: "fresh-initial",
      rows: [prior.creation.event],
    }),
  });
  assert.equal((await fresh.finalize(f.input([next]))).status, "unsupported");
  const owner = createNativeStartupFinalizer({
    readHistory: () => ({ status: "ready", source: "fresh-initial", rows: [] }),
  });
  assert.equal(
    (await owner.finalize(f.input([next, next]))).status,
    "unsupported",
  );
});
