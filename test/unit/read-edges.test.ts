import assert from "node:assert/strict";
import { test } from "bun:test";
import { renderReadView } from "../../src/read.js";

function view(
  text: string | Buffer,
  input: { offset?: number; limit?: number } = {},
  truncated = false,
) {
  return renderReadView({
    input: {
      file_path: "/w/file",
      offset: input.offset ?? 1,
      limit: input.limit,
    },
    bytes: typeof text === "string" ? Buffer.from(text) : text,
    truncated,
  });
}

test("renderReadView rejects RIFF WEBP media but reads other RIFF-prefixed text", () => {
  assert.throws(() => view("RIFF1234WEBPdata"), /binary\/media/);
  assert.deepEqual(view("RIFF1234WAVEdata"), {
    content: "1\tRIFF1234WAVEdata",
    complete: true,
  });
});

test("renderReadView numbers from line 0 when offset is 0 and counts it as complete", () => {
  assert.deepEqual(view("a\nb", { offset: 0 }), {
    content: "0\ta\n1\tb",
    complete: true,
  });
});

test("renderReadView reports an offset past the end as an incomplete end-of-file view", () => {
  assert.deepEqual(view("a\nb\n", { offset: 9 }), {
    content: "[end of file: requested offset 9; file has 3 lines]",
    complete: false,
  });
});

test("renderReadView refuses an offset beyond a truncated prefix", () => {
  assert.throws(
    () => view("a\nb\n", { offset: 3 }, true),
    /beyond the bounded file prefix/,
  );
});

test("renderReadView drops the empty tail of a truncated prefix and marks it truncated", () => {
  assert.deepEqual(view("a\nb\n", {}, true), {
    content:
      "[read truncated: only first 4 bytes inspected; prefix may end mid-line]\n1\ta\n2\tb",
    complete: false,
  });
});

test("renderReadView applies limit and is complete only when the file fits under it", () => {
  assert.deepEqual(view("a\nb\nc", { limit: 2 }), {
    content: "1\ta\n2\tb",
    complete: false,
  });
  assert.deepEqual(view("a\nb", { limit: 3 }), {
    content: "1\ta\n2\tb",
    complete: true,
  });
  // A limit on an empty file is never a complete view, per the read-state contract.
  assert.deepEqual(view("", { limit: 5 }), {
    content: "[empty file]",
    complete: false,
  });
});

test("renderReadView is incomplete when the text ends with a bare CR or starts past line 1", () => {
  assert.equal(view("a\r").complete, false);
  assert.deepEqual(view("a\nb\nc", { offset: 2 }), {
    content: "2\tb\n3\tc",
    complete: false,
  });
});
