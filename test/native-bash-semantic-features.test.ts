import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeBashSemanticFeatures,
  type NativeBashSemanticEventSink,
} from "../src/native-bash-semantic-features.js";
import { createNativeBashSemantics } from "../src/native-bash-semantics.js";
import { createNativeBashParser } from "../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../src/native-bash-command-preparation.js";
const metadata = { cmdLength: 3, panic: false };

test("scrub flag parsing uses actual source values and no-reader default", () => {
  for (const value of [
    undefined,
    "",
    "false",
    "0",
    "off",
    "no",
    false,
    "unexpected",
  ])
    assert.equal(
      createNativeBashSemanticFeatures({
        environment: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: value },
      }).host.subprocessEnvironmentScrubEnabled(),
      false,
      String(value),
    );
  for (const value of ["1", "true", "TRUE", " yes ", "ON", true])
    assert.equal(
      createNativeBashSemanticFeatures({
        environment: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: value },
      }).host.subprocessEnvironmentScrubEnabled(),
      true,
      String(value),
    );
});

test("scrub latch reads its host environment once, accepts explicit overrides and resets to source state", () => {
  let value = "false";
  let reads = 0;
  const environment = {
    get CLAUDE_CODE_SUBPROCESS_ENV_SCRUB() {
      reads++;
      return value;
    },
  };
  const f = createNativeBashSemanticFeatures({ environment });
  assert.equal(f.host.subprocessEnvironmentScrubEnabled(), false);
  value = "true";
  assert.equal(f.host.subprocessEnvironmentScrubEnabled(), false);
  assert.equal(reads, 1);
  f.resetScrubLatch();
  assert.equal(f.host.subprocessEnvironmentScrubEnabled(), true);
  assert.equal(reads, 2);
  f.setScrubEnabledLatched(false);
  assert.equal(f.host.subprocessEnvironmentScrubEnabled(), false);
  assert.equal(reads, 2);
  f.setScrubEnabledLatched(undefined);
  assert.equal(f.host.subprocessEnvironmentScrubEnabled(), true);
  assert.equal(reads, 3);
});

test("native telemetry queue caps at 1000, drops oldest and preserves source metadata", () => {
  const f = createNativeBashSemanticFeatures({ environment: {} });
  for (let i = 0; i < 1002; i++)
    f.host.logParseEvent(`event${i}`, { cmdLength: i, panic: i % 2 === 0 });
  assert.equal(f.pendingEvents().length, 1000);
  assert.equal(f.droppedEventCount(), 2);
  assert.deepEqual(f.pendingEvents()[0], {
    eventName: "event2",
    metadata: { cmdLength: 2, panic: true },
    async: false,
  });
  assert.equal(f.pendingEvents().at(-1)?.eventName, "event1001");
  const snapshot = f.pendingEvents();
  assert.notEqual(snapshot, f.pendingEvents());
});

test("sink install runs live events immediately and drains queued sync/async events in its native microtask", async () => {
  const f = createNativeBashSemanticFeatures({ environment: {} });
  const seen: string[] = [];
  f.host.logParseEvent("queued-sync", metadata);
  await f.logParseEventAsync("queued-async", metadata);
  const sink: NativeBashSemanticEventSink = {
    logEvent(name) {
      seen.push(name);
    },
    async logEventAsync(name) {
      seen.push(name);
      await Promise.resolve();
      seen.push(`${name}-done`);
    },
  };
  assert.equal(f.installEventSink(sink), true);
  assert.equal(f.installEventSink(sink), false);
  assert.deepEqual(f.pendingEvents(), []);
  f.host.logParseEvent("live", metadata);
  assert.deepEqual(seen, ["live"]);
  await Promise.resolve();
  assert.deepEqual(seen, ["live", "queued-sync", "queued-async"]);
  await Promise.resolve();
  assert.deepEqual(seen, [
    "live",
    "queued-sync",
    "queued-async",
    "queued-async-done",
  ]);
  await f.logParseEventAsync("live-async", metadata);
  assert.equal(seen.at(-1), "live-async-done");
});

test("telemetry keepsWholeEvents defaults true and catches only its source-defined reader failure", () => {
  const absent = createNativeBashSemanticFeatures({ environment: {} });
  assert.equal(absent.keepsWholeEvents(), true);
  const negative = createNativeBashSemanticFeatures({ environment: {} });
  negative.installEventSink({
    logEvent() {},
    async logEventAsync() {},
    keepsWholeEvents: () => false,
  });
  assert.equal(negative.keepsWholeEvents(), false);
  const broken = createNativeBashSemanticFeatures({ environment: {} });
  broken.installEventSink({
    logEvent() {
      throw new Error("sink");
    },
    async logEventAsync() {
      throw new Error("async sink");
    },
    keepsWholeEvents() {
      throw new Error("reader");
    },
  });
  assert.equal(broken.keepsWholeEvents(), true);
  assert.throws(() => broken.host.logParseEvent("event", metadata), /sink/);
});

test("parser-null telemetry sink failure follows V1's native retry-as-panic order", async () => {
  let tick = 0;
  const parser = createNativeBashParser({ now: () => (tick += 100) });
  const host = createNativeBashSemanticFeatures({
    environment: {},
    cpuNow: () => 0,
  });
  const events: boolean[] = [];
  host.installEventSink({
    logEvent(_name, value) {
      events.push(value.panic);
      if (!value.panic) throw new Error("first event");
    },
    async logEventAsync() {},
  });
  const f = createNativeBashSemantics(
    parser,
    createNativeBashPreparationFeatures(),
    host.host,
  );
  const result = await f.parse("echo x;".repeat(100));
  assert.equal(result, f.parseAbort);
  assert.deepEqual(events, [false, true]);
});

test("injected CPU/home readers remain per owner and preserve a real semantic HOME expansion", async () => {
  let reads = 0;
  const host = createNativeBashSemanticFeatures({
    environment: {},
    cpuNow: () => {
      reads++;
      return 0;
    },
    home: () => "/explicit/home",
  });
  const f = createNativeBashSemantics(
    createNativeBashParser({ now: () => 0 }),
    createNativeBashPreparationFeatures(),
    host.host,
  );
  const observed = await f.observeBudget(() => f.analyze('echo "$HOME"'));
  assert.equal(observed.outOfTime, false);
  assert.ok(reads >= 2);
  const r = observed.result;
  assert.ok(r);
  assert.equal(r.kind, "simple");
  if (r.kind === "simple")
    assert.deepEqual(r.commands[0]?.argv, ["echo", "/explicit/home"]);
});
