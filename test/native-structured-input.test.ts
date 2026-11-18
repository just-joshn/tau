import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  NativeInputReadMarker,
  NativeStructuredInput,
  type NativeStructuredInputHost,
} from "../src/native-structured-input.js";
import {
  isNativeObject,
  type NativeObject,
} from "../src/native-session-codec.js";
import { snapshotNativeResponseJson } from "../src/native-response-recording.js";
import { nativeTypedEnvironmentBoolean } from "../src/native-rule-environment.js";

function channel() {
  const queued: IteratorResult<string>[] = [],
    waiting: ((value: IteratorResult<string>) => void)[] = [];
  let calls = 0,
    returns = 0;
  const iterator: AsyncIterator<string> = {
    next() {
      calls++;
      const value = queued.shift();
      return value
        ? Promise.resolve(value)
        : new Promise((resolve) => waiting.push(resolve));
    },
    return() {
      returns++;
      for (const wake of waiting.splice(0))
        wake({ done: true, value: undefined });
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const send = (value: IteratorResult<string>) => {
    const wake = waiting.shift();
    if (wake) wake(value);
    else queued.push(value);
  };
  return {
    input: { [Symbol.asyncIterator]: () => iterator },
    push: (value: string) => send({ done: false, value }),
    end: () => send({ done: true, value: undefined }),
    calls: () => calls,
    returns: () => returns,
  };
}
function fixture(maxLineChars?: number) {
  const feed = channel(),
    parsed: NativeObject[] = [],
    lines: string[] = [],
    budgets: string[] = [],
    effects: string[] = [];
  let probe = false;
  const fatal = new Error("ACTUAL_INPUT_FATAL");
  const host: NativeStructuredInputHost<NativeObject> = {
    processLine(line) {
      lines.push(line);
      if (!line.trim()) return;
      const value = snapshotNativeResponseJson(JSON.parse(line));
      assert.ok(isNativeObject(value));
      return value;
    },
    serialize: (value) => JSON.stringify(value),
    configProbe: () => probe,
    probeDiscarded: () => {
      effects.push("probe-discarded");
    },
    yieldTick: async () => {},
    parsed: (value) => {
      parsed.push(value);
    },
    lineBudgetExceeded: (at) => {
      budgets.push(at);
    },
    fatalInput: async () => {
      throw fatal;
    },
    inputClosed: () => {
      effects.push("closed");
    },
  };
  const reader = new NativeStructuredInput({
    input: feed.input,
    host,
    ...(maxLineChars === undefined ? {} : { maxLineChars }),
  });
  return {
    feed,
    reader,
    host,
    parsed,
    lines,
    budgets,
    effects,
    fatal,
    probe: (value: boolean) => {
      probe = value;
    },
  };
}
const line = (value: unknown) => JSON.stringify(value) + "\n";
async function next(f: ReturnType<typeof fixture>) {
  const value = await f.reader.structuredInput.next();
  if (value.done) assert.fail("Expected a genuine parsed input object");
  return value.value;
}

test("native marker counts newline-terminated matching lines once and reading-ended settles all barriers", async () => {
  const marker = new NativeInputReadMarker("MARK");
  marker.noteWritten("MARK MARK\nother\nMARK\nMARK");
  assert.deepEqual(marker.counts(), { written: 2, read: 0 });
  const pending = marker.whenRead();
  assert.ok(pending);
  marker.noteRead("unrelated");
  marker.noteRead("MARK MARK");
  assert.deepEqual(marker.counts(), { written: 2, read: 1 });
  assert.equal(marker.whenRead(), pending);
  marker.noteReadingEnded();
  await pending;
  assert.deepEqual(marker.counts(), { written: 2, read: Infinity });
  assert.equal(marker.whenRead(), undefined);
});

test("prepended process/person inputs are FIFO, outrank buffered wire input and retain actual object origin without IDs", async () => {
  const f = fixture();
  f.reader.prependUserMessage("PROCESS");
  f.reader.prependUserMessage("PERSON", "person");
  f.reader.readAgain({
    type: "user",
    message: { role: "user", content: "AGAIN" },
  });
  f.feed.push(line({ type: "wire", n: 1 }) + line({ type: "wire", n: 2 }));
  f.feed.end();
  const process = await next(f),
    person = await next(f),
    again = await next(f),
    wire = await next(f);
  assert.deepEqual(process, {
    type: "user",
    session_id: "",
    message: { role: "user", content: "PROCESS" },
    parent_tool_use_id: null,
  });
  assert.equal(f.reader.isLocallyPrependedMessage(process), true);
  assert.equal(f.reader.isPersonsOwnPrepend(process), false);
  assert.equal(f.reader.isLocallyPrependedMessage(person), true);
  assert.equal(f.reader.isPersonsOwnPrepend(person), true);
  assert.equal(f.reader.isLocallyPrependedMessage(again), false);
  assert.equal(f.reader.isPersonsOwnPrepend(again), false);
  assert.equal(
    f.reader.isLocallyPrependedMessage(structuredClone(process)),
    false,
  );
  assert.equal(f.reader.hasUnconsumedInput, true);
  assert.equal(wire.n, 1);
  f.reader.prependUserMessage("BETWEEN");
  assert.deepEqual((await next(f)).message, {
    role: "user",
    content: "BETWEEN",
  });
  assert.equal((await next(f)).n, 2);
  assert.equal((await f.reader.structuredInput.next()).done, true);
  assert.deepEqual(f.effects, ["closed"]);
  assert.equal(f.reader.inputClosed, true);
  assert.equal(f.feed.returns(), 0);
  assert.equal(f.parsed.length, 6);
});

test("a prepend wakes blocked upstream input without replacing or duplicating its one outstanding next", async () => {
  const f = fixture(),
    first = f.reader.structuredInput.next();
  await Promise.resolve();
  assert.equal(f.feed.calls(), 1);
  assert.deepEqual(f.reader.prependOwnedUserMessage("WAKE"), {
    status: "enqueued",
  });
  const result = await first;
  assert.ok(!result.done);
  assert.equal(f.reader.isLocallyPrependedMessage(result.value), true);
  assert.equal(f.feed.calls(), 1);
  const second = f.reader.structuredInput.next();
  f.feed.push(line({ type: "wire" }));
  assert.equal((await second).done, false);
  assert.equal(f.feed.calls(), 1);
  f.feed.end();
  await f.reader.structuredInput.next();
  assert.deepEqual(f.reader.prependOwnedUserMessage("LATE"), {
    status: "retired",
  });
});

test("actual typed config-probe discards before serialization, and checked retirement is separate from raw source enqueue", async () => {
  const f = fixture();
  f.probe(true);
  assert.deepEqual(f.reader.prependOwnedUserMessage("DROP"), {
    status: "probe-discarded",
  });
  assert.deepEqual(f.lines, []);
  assert.deepEqual(f.effects, ["probe-discarded"]);
  f.probe(nativeTypedEnvironmentBoolean("0"));
  f.reader.prependUserMessage("KEEP");
  f.feed.end();
  assert.deepEqual((await next(f)).message, { role: "user", content: "KEEP" });
  await f.reader.structuredInput.next();
  assert.deepEqual(f.reader.prependOwnedUserMessage("AFTER"), {
    status: "retired",
  });
  f.probe(true);
  f.reader.prependUserMessage("RAW_AFTER");
  assert.equal(f.effects.at(-1), "probe-discarded");
});

test("wire acknowledgement happens after its yielded object is consumed; prepended lookalikes are not transport acknowledgements", async () => {
  const f = fixture(),
    wire = line({ type: "control_response" }) + line({ type: "sdkMcpServers" });
  f.reader.noteInputWritten(wire);
  f.reader.readAgain({ type: "control_response" });
  const received = f.reader.whenReceivedAnswersRead();
  assert.ok(received);
  let done = false;
  void received.then(() => {
    done = true;
  });
  f.feed.push(wire);
  f.feed.end();
  await next(f);
  assert.equal(done, false);
  await next(f);
  await Promise.resolve();
  assert.equal(done, false);
  await next(f);
  await received;
  assert.equal(done, true);
  assert.ok(f.reader.whenReceivedSdkServersRead());
  await f.reader.structuredInput.next();
  assert.equal(f.reader.whenReceivedSdkServersRead(), undefined);
  assert.deepEqual(f.reader.barePluginsReloads(), {
    written: 0,
    read: Infinity,
  });
});

test("unterminated EOF tail is parsed once without a normal parsed notification and only later marks input closed", async () => {
  const f = fixture();
  f.feed.push(JSON.stringify({ type: "tail" }));
  f.feed.end();
  const tail = await next(f);
  assert.equal(tail.type, "tail");
  assert.equal(f.reader.readerRetired, true);
  assert.equal(f.reader.inputClosed, false);
  assert.equal(f.reader.hasUnconsumedInput, false);
  assert.deepEqual(f.parsed, []);
  assert.deepEqual(f.reader.prependOwnedUserMessage("CANNOT_DRAIN"), {
    status: "retired",
  });
  await f.reader.structuredInput.next();
  assert.equal(f.reader.inputClosed, true);
  assert.deepEqual(f.effects, ["closed"]);
});

test("line budget counts JS characters and checks incomplete block/tail, rather than rejecting a complete large line", async () => {
  for (const at of ["block", "tail"] as const) {
    const f = fixture(3);
    f.feed.push(at === "block" ? "😀😀" : line({ ok: true }) + "TAIL");
    if (at === "tail") await next(f);
    await assert.rejects(
      f.reader.structuredInput.next(),
      (error) => error === f.fatal,
    );
    assert.deepEqual(f.budgets, [at]);
    assert.equal(f.feed.returns(), 1);
    assert.equal(f.reader.inputClosed, false);
  }
  const f = fixture(3);
  f.feed.push(line({ largerThanBudget: "accepted-complete-line" }));
  f.feed.end();
  assert.equal((await next(f)).largerThanBudget, "accepted-complete-line");
  await f.reader.structuredInput.next();
  assert.deepEqual(f.budgets, []);
});

test("parser failure and early consumer return close only the actual upstream iterator and keep input-closed policy distinct", async () => {
  const failed = fixture();
  failed.feed.push("INVALID\n");
  failed.reader.noteInputWritten(line({ type: "control_response" }));
  const barrier = failed.reader.whenReceivedAnswersRead();
  assert.ok(barrier);
  await assert.rejects(failed.reader.structuredInput.next(), SyntaxError);
  await barrier;
  assert.equal(failed.feed.returns(), 1);
  assert.equal(failed.reader.inputClosed, false);
  assert.deepEqual(failed.effects, []);
  const f = fixture();
  f.feed.push(line({ n: 1 }) + line({ n: 2 }));
  assert.equal((await next(f)).n, 1);
  await f.reader.structuredInput.return();
  assert.equal(f.feed.returns(), 1);
  assert.equal(f.reader.readerRetired, true);
  assert.equal(f.reader.inputClosed, false);
  assert.equal(f.parsed.length, 1);
  assert.deepEqual(f.reader.prependOwnedUserMessage("AFTER_RETURN"), {
    status: "retired",
  });
  const neverStarted = fixture();
  await neverStarted.reader.structuredInput.return();
  assert.equal(neverStarted.feed.calls(), 0);
  assert.equal(neverStarted.feed.returns(), 0);
  assert.deepEqual(
    neverStarted.reader.prependOwnedUserMessage("RETIRED_BEFORE_START"),
    { status: "retired" },
  );
});

test("reader preserves the native 64-line yield boundary and does not turn its scheduling tick into input ownership", async () => {
  const feed = channel(),
    gate = Promise.withResolvers<void>();
  let yields = 0,
    parsed = 0;
  const host: NativeStructuredInputHost<NativeObject> = {
    processLine: (text) => ({ text }),
    serialize: JSON.stringify,
    configProbe: () => false,
    probeDiscarded: () => {},
    yieldTick: () => (++yields === 1 ? gate.promise : Promise.resolve()),
    parsed: () => {
      parsed++;
    },
    lineBudgetExceeded: () => assert.fail(),
    fatalInput: async () => {
      throw new Error("Unexpected fatal input");
    },
    inputClosed: () => {},
  };
  const reader = new NativeStructuredInput({ input: feed.input, host });
  feed.push(Array.from({ length: 65 }, (_, n) => String(n)).join("\n") + "\n");
  feed.end();
  for (let n = 0; n < 64; n++) {
    const value = await reader.structuredInput.next();
    assert.equal(value.done, false);
  }
  assert.equal(yields, 1);
  assert.equal(parsed, 64);
  await reader.structuredInput.next();
  assert.equal(yields, 2);
  assert.equal(parsed, 65);
  gate.resolve();
  await reader.structuredInput.next();
});
