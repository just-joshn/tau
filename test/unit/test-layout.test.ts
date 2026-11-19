import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "bun:test";

const testRoot = join(import.meta.dir, "..");
const TIERS = new Set([
  "unit",
  "contract",
  "security",
  "integration",
  "property",
  "faults",
]);

const testFiles = readdirSync(testRoot, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".test.ts"))
  .map((path) => relative(testRoot, join(testRoot, path)).split(sep));

// A tier may group files in subfolders; test/helpers and test/fixtures hold no tests.
test("every test file sits in one strategy tier", () => {
  assert.ok(testFiles.length > 0);
  const misplaced = testFiles.filter(
    (parts) => parts.length < 2 || !TIERS.has(parts[0] ?? ""),
  );
  assert.deepEqual(misplaced, []);
});
