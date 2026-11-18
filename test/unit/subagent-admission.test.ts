import { test } from "bun:test";
import assert from "node:assert/strict";
import { ordinarySubagentConcurrencyLimit } from "../../src/subagent-admission.js";

test("ordinary concurrency uses the typed decimal descriptor and default20", () => {
  for (const value of [
    undefined,
    "",
    "0",
    "-1",
    "1.2",
    "1e2",
    "0x10",
    "2extra",
    "9".repeat(400),
  ])
    assert.equal(ordinarySubagentConcurrencyLimit(value), 20);
  assert.equal(ordinarySubagentConcurrencyLimit(" +02 "), 2);
  assert.equal(
    ordinarySubagentConcurrencyLimit("9".repeat(20)),
    Number("9".repeat(20)),
  );
});
