// The istanbul coverage gate in scripts/coverage must not report a number it
// did not measure.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { join, resolve } from "node:path";
import { parseRunArgs, resolveFocus } from "../../scripts/coverage/gate.ts";

const root = resolve(import.meta.dir, "../..");
const sources = [join(root, "src/read.ts"), join(root, "src/retry.ts")];

test("--focus resolves a src file to its absolute path", () => {
  assert.deepEqual(resolveFocus(root, ["src/read.ts"], sources), [
    join(root, "src/read.ts"),
  ]);
});

test("--focus naming no instrumented src file fails the run", () => {
  assert.throws(
    () => resolveFocus(root, ["src/read.ts", "src/read.js"], sources),
    /src\/read\.js/,
  );
});

test("--focus without a value fails the run", () => {
  assert.throws(() => parseRunArgs(["--focus"]), /--focus/);
});
