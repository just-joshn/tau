import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  NativeRetainedMemoryOwner,
  NativeMemoryOwnerError,
  NativeMemoryCapabilityError,
  NativeMemoryConflictError,
  type NativeMemoryAdmissionHost,
  type NativeMemoryRawRow,
} from "../src/native-retained-memory.js";
import {
  isNativeObject,
  type NativeObject,
} from "../src/native-session-codec.js";
const signal = () => new AbortController().signal;
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const row = (n: number, text = `TEXT_${n}`): NativeObject => ({
  type: "user",
  uuid: id(n),
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: text },
});
const host = (): NativeMemoryAdmissionHost => ({
  admitProducer: () => true,
  admitRetention: () => true,
});
async function owner(admission = host()) {
  const memory = NativeRetainedMemoryOwner.open(
    { sessionId: id(90) },
    admission,
  );
  const producer = await memory.admitProducer(
    { name: "actual-user-owner", kinds: ["user"] },
    signal(),
  );
  return { memory, producer };
}
function gate() {
  let release: () => void = () => {
    throw new Error("gate not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test("memory retention captures raw unknown finite fields before admission and adds only external source order", async () => {
  const entered = gate(),
    proceed = gate();
  const admission = host();
  admission.admitRetention = async (input) => {
    assert.ok(Object.isFrozen(input.rows[0]));
    assert.throws(
      () => Object.assign(input.rows[0] ?? {}, { uuid: id(7) }),
      TypeError,
    );
    entered.release();
    await proceed.promise;
    return true;
  };
  const { memory, producer } = await owner(admission),
    original = row(1);
  Object.assign(original, { extra: { sourceOnly: true } });
  const pending = memory.retain(producer, [original], {
    signal: signal(),
    expectedRevision: 0,
  });
  assert.ok(isNativeObject(original.message));
  Object.assign(original.message, { content: "MUTATED_AFTER_CREATION" });
  await entered.promise;
  proceed.release();
  const saved = await pending;
  assert.equal(saved.kind, "ephemeral");
  assert.equal(saved.revision, 1);
  assert.equal(saved.nextSequence, 2);
  assert.deepEqual(saved.entries[0]?.row, {
    ...row(1),
    extra: { sourceOnly: true },
  });
  assert.deepEqual(Object.keys(saved.entries[0]?.row ?? {}).sort(), [
    "extra",
    "message",
    "timestamp",
    "type",
    "uuid",
  ]);
  assert.ok(
    Object.isFrozen(saved.entries) &&
      Object.isFrozen(saved.entries[0]?.row.extra),
  );
  assert.equal((await memory.close()).status, "closed");
  assert.equal(saved.status, "open");
});

test("opaque producer capability cannot be copied, borrowed across owners or broadened", async () => {
  const a = await owner(),
    b = await owner();
  assert.throws(
    () => Object.assign(a.producer.descriptor.kinds, { 0: "assistant" }),
    TypeError,
  );
  await assert.rejects(
    a.memory.retain({ ...a.producer }, [row(1)], { signal: signal() }),
    NativeMemoryCapabilityError,
  );
  await assert.rejects(
    a.memory.retain(b.producer, [row(1)], { signal: signal() }),
    NativeMemoryCapabilityError,
  );
  assert.equal(
    (await a.memory.retain(a.producer, [row(1)], { signal: signal() }))
      .revision,
    1,
  );
  assert.equal((await a.memory.view(signal())).failure, undefined);
  await a.memory.retireProducer(a.producer, signal());
  await assert.rejects(
    a.memory.retain(a.producer, [row(2)], { signal: signal() }),
    NativeMemoryCapabilityError,
  );
  await Promise.all([a.memory.close(), b.memory.close()]);
});

test("retained history rejects replacement or duplicate source UUID atomically and latches owned failure", async () => {
  const { memory, producer } = await owner();
  const first = await memory.retain(producer, [row(1)], { signal: signal() });
  await assert.rejects(
    memory.retain(producer, [row(2), row(1, "LATE_SAME_UUID_UPDATE")], {
      signal: signal(),
    }),
    /cannot be retained twice/,
  );
  const failed = await memory.view(signal());
  assert.equal(failed.entries.length, 1);
  assert.equal(failed.revision, 1);
  assert.ok(failed.failure);
  assert.deepEqual(first.entries[0]?.row, row(1));
  await assert.rejects(
    memory.retain(producer, [row(3)], { signal: signal() }),
    NativeMemoryOwnerError,
  );
  await assert.rejects(memory.close(), NativeMemoryOwnerError);
  assert.equal((await memory.view(signal())).status, "closed");
  const duplicate = await owner();
  await assert.rejects(
    duplicate.memory.retain(duplicate.producer, [row(4), row(4)], {
      signal: signal(),
    }),
    /cannot be retained twice/,
  );
  assert.equal((await duplicate.memory.view(signal())).entries.length, 0);
  await assert.rejects(duplicate.memory.close());
});

test("stale revisions do not retry producers, poison authority or reorder actual retained timestamps", async () => {
  const { memory, producer } = await owner();
  const later = row(1),
    earlier = row(2);
  Object.assign(later, { timestamp: "2026-01-01T00:00:02.000Z" });
  await memory.retain(producer, [later], {
    signal: signal(),
    expectedRevision: 0,
  });
  await assert.rejects(
    memory.retain(producer, [earlier], {
      signal: signal(),
      expectedRevision: 0,
    }),
    NativeMemoryConflictError,
  );
  const next = await memory.retain(producer, [earlier], {
    signal: signal(),
    expectedRevision: 1,
  });
  assert.deepEqual(
    next.entries.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(
    next.entries.map((entry) => entry.row.uuid),
    [id(1), id(2)],
  );
  assert.equal(next.revision, 2);
  assert.equal(next.failure, undefined);
  assert.equal(
    (await memory.retain(producer, [], { signal: signal() })).revision,
    2,
  );
  await memory.close();
});

test("abort around actual admission preserves reason and commits no rows while allowing later live prompt", async () => {
  const entered = gate(),
    proceed = gate(),
    admission = host();
  let calls = 0;
  admission.admitRetention = async () => {
    if (++calls === 1) {
      entered.release();
      await proceed.promise;
    }
    return true;
  };
  const { memory, producer } = await owner(admission),
    controller = new AbortController(),
    reason = new Error("ACTUAL_STOP");
  const pending = memory.retain(producer, [row(1)], {
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort(reason);
  proceed.release();
  await assert.rejects(pending, (error) => error === reason);
  assert.equal((await memory.view(signal())).entries.length, 0);
  const next = await memory.retain(producer, [row(2)], { signal: signal() });
  assert.equal(next.revision, 1);
  assert.equal(next.failure, undefined);
  const already = new AbortController();
  already.abort(reason);
  await assert.rejects(
    memory.retain(producer, [row(3)], { signal: already.signal }),
    (error) => error === reason,
  );
  await memory.close();
});

test("admission rejection or host failure is fatal with original cause and no partial successful history", async () => {
  for (const actual of [
    undefined,
    new Error("ACTUAL_ADMISSION_ERROR"),
    new NativeMemoryConflictError(),
    new NativeMemoryCapabilityError("HOST_ERROR"),
  ]) {
    const admission = host();
    admission.admitRetention = () => {
      if (actual) throw actual;
      return false;
    };
    const { memory, producer } = await owner(admission);
    await assert.rejects(
      memory.retain(producer, [row(1)], { signal: signal() }),
      (error) =>
        error instanceof NativeMemoryOwnerError &&
        (actual === undefined || error.cause === actual),
    );
    const view = await memory.flush(signal());
    assert.ok(view.failure);
    assert.equal(view.entries.length, 0);
    await assert.rejects(memory.close(), NativeMemoryOwnerError);
  }
  const memory = NativeRetainedMemoryOwner.open(
    { sessionId: id(90) },
    { admitProducer: () => false, admitRetention: () => true },
  );
  await assert.rejects(
    memory.admitProducer({ name: "unowned", kinds: ["user"] }, signal()),
    /was not admitted/,
  );
  await assert.rejects(memory.close());
});

test("close drains prior admitted work, retires capabilities and rejects late callback without false persistence", async () => {
  const entered = gate(),
    proceed = gate(),
    admission = host();
  admission.admitRetention = async () => {
    entered.release();
    await proceed.promise;
    return true;
  };
  const { memory, producer } = await owner(admission),
    pending = memory.retain(producer, [row(1)], { signal: signal() });
  await entered.promise;
  const closed = memory.close();
  await assert.rejects(
    memory.admitProducer({ name: "late", kinds: ["user"] }, signal()),
    NativeMemoryCapabilityError,
  );
  await assert.rejects(
    memory.retain(producer, [row(2)], { signal: signal() }),
    NativeMemoryCapabilityError,
  );
  proceed.release();
  await pending;
  const final = await closed;
  assert.equal(final.status, "closed");
  assert.equal(final.entries.length, 1);
  assert.equal(final.kind, "ephemeral");
  assert.equal(memory.close(), closed);
  assert.ok(!Object.hasOwn(final, "fileBinding"));
  assert.ok(!Object.hasOwn(final, "persistedCursor"));
});

test("only actual finite identified finalized source rows enter retention; getters and transport controls never mint identity", async () => {
  let getters = 0;
  const hostile = Object.defineProperty({}, "type", {
    enumerable: true,
    get: () => {
      getters++;
      return "user";
    },
  });
  const bad: NativeObject[] = [
    { type: "progress", data: { type: "hook_progress" } },
    {
      type: "progress",
      uuid: id(2),
      timestamp: "2026-01-01T00:00:00Z",
      data: { type: "hook_progress" },
    },
    { type: "stream_request_start" },
    { type: "stream_event", event: { type: "message_delta" } },
    { ...row(1), parentUuid: null },
    { ...row(1), isSidechain: false },
    {
      type: "assistant",
      uuid: id(1),
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        type: "message",
        id: "real-sdk",
        role: "assistant",
        model: "real-model",
        content: [],
        usage: {},
        stop_reason: null,
      },
    },
    { ...row(1), invalid: Number.NaN },
    hostile,
  ];
  for (const invalid of bad) {
    const { memory, producer } = await owner();
    await assert.rejects(
      memory.retain(producer, [invalid], { signal: signal() }),
      NativeMemoryOwnerError,
    );
    assert.equal((await memory.view(signal())).entries.length, 0);
    await assert.rejects(memory.close());
  }
  assert.equal(getters, 0);
  assert.throws(
    () =>
      NativeRetainedMemoryOwner.open(
        Object.assign({ sessionId: id(90) }, { restoredHistory: [] }),
        host(),
      ),
    /restored history/,
  );
});

test("deep actual tool JSON and raw progress remain immutable without writer serialization or disk selection", async () => {
  const memory = NativeRetainedMemoryOwner.open({ sessionId: id(90) }, host()),
    producer = await memory.admitProducer(
      { name: "actual-progress-owner", kinds: ["progress"] },
      signal(),
    );
  const deep: NativeObject = {};
  let leaf = deep;
  for (let n = 0; n < 5000; n++) {
    const child: NativeObject = {};
    Object.assign(leaf, { next: child });
    leaf = child;
  }
  Object.assign(leaf, { value: "DEEPEST" });
  const progress: NativeMemoryRawRow = {
    type: "progress",
    uuid: id(1),
    timestamp: "2026-01-01T00:00:00Z",
    data: { type: "hook_progress", actual: deep },
    parentToolUseID: "actual-parent",
    toolUseID: "actual-hook",
    persist: false,
  };
  const view = await memory.retain(producer, [progress], { signal: signal() });
  let found = view.entries[0]?.row.data;
  assert.ok(isNativeObject(found));
  found = found.actual;
  for (let n = 0; n < 5000; n++) {
    assert.ok(isNativeObject(found));
    assert.ok(Object.isFrozen(found));
    found = found.next;
  }
  assert.ok(isNativeObject(found));
  assert.equal(found.value, "DEEPEST");
  assert.equal(view.entries[0]?.row.persist, false);
  await memory.close();
});

test("an owned capture failure respects prior queued commits and cannot erase an earlier source revision", async () => {
  const entered = gate(),
    proceed = gate(),
    admission = host();
  admission.admitRetention = async () => {
    entered.release();
    await proceed.promise;
    return true;
  };
  const { memory, producer } = await owner(admission);
  const first = memory.retain(producer, [row(1)], { signal: signal() });
  await entered.promise;
  const failed = assert.rejects(
    memory.retain(producer, [{ type: "user" }], { signal: signal() }),
    NativeMemoryOwnerError,
  );
  proceed.release();
  assert.equal((await first).revision, 1);
  await failed;
  const view = await memory.view(signal());
  assert.deepEqual(
    view.entries.map((entry) => entry.row.uuid),
    [id(1)],
  );
  assert.ok(view.failure);
  await assert.rejects(memory.close());
});
