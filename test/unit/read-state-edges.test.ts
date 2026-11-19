import assert from "node:assert/strict";
import { test } from "bun:test";
import { ReadState } from "../../src/read-state.js";

const bytes = Buffer.from("text\n");

test("ReadState remembers at most 512 paths and evicts the least recently used", () => {
  const state = new ReadState();
  state.remember("/w/kept", bytes, 1);
  state.remember("/w/first-other", bytes, 2);
  for (let index = 0; index < 510; index += 1)
    state.remember(`/w/file-${index}`, bytes, 3);
  assert.equal(state.candidates().length, 512);

  // A verified write refreshes recency, so the next eviction skips this path.
  state.assertCurrent("/w/kept", bytes);
  state.rememberPartial("/w/newest", 4);

  assert.equal(state.candidates().length, 512);
  assert.equal(state.has("/w/kept"), true);
  assert.equal(state.has("/w/first-other"), false);
  assert.equal(state.has("/w/newest"), true);
});

test("ReadState stamps a remembered read with the current time by default", () => {
  const state = new ReadState();
  const before = Date.now();
  state.remember("/w/a", bytes);
  const after = Date.now();
  const [entry] = state.candidates();
  assert.equal(entry?.file, "/w/a");
  assert.ok(entry.timestamp >= before && entry.timestamp <= after);
  assert.doesNotThrow(() => state.requireComplete("/w/a"));
});
