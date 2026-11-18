import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStream, streamEventSchema } from "../src/message-stream.js";
import {
  normalizeToolInput,
  normalizeToolName,
  unparsedToolInput,
} from "../src/tool-input.js";

const begin = {
  type: "message_start",
  message: {
    role: "assistant",
    content: [],
    usage: { input_tokens: 5, output_tokens: 0 },
  },
};
const start = (index: number, content_block: unknown) => ({
  type: "content_block_start",
  index,
  content_block,
});
const delta = (index: number, value: unknown) => ({
  type: "content_block_delta",
  index,
  delta: value,
});
const close = (index: number) => ({ type: "content_block_stop", index });
const finish = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 3 },
};
const stop = { type: "message_stop" };
function parse(events: unknown[]): MessageStream {
  const stream = new MessageStream(() => {});
  for (const event of events) stream.accept(streamEventSchema.parse(event));
  return stream;
}

test("raw block starts clear text/tool/thinking fields before their deltas", () => {
  const stream = parse([
    begin,
    start(7, { type: "text", text: "ignored" }),
    delta(7, { type: "text_delta", text: "actual" }),
    close(7),
    start(19, {
      type: "tool_use",
      id: "tool",
      name: "Read",
      input: { ignored: true },
    }),
    delta(19, { type: "input_json_delta", partial_json: '{"file_path":"a"}' }),
    close(19),
    start(30, { type: "thinking", thinking: "ignored", signature: "ignored" }),
    delta(30, { type: "thinking_delta", thinking: "reason" }),
    delta(30, { type: "signature_delta", signature: "sig" }),
    close(30),
    finish,
    stop,
  ]);
  assert.deepEqual(stream.completion().content, [
    { type: "text", text: "actual" },
    { type: "tool_use", id: "tool", name: "Read", input: { file_path: "a" } },
    { type: "thinking", thinking: "reason", signature: "sig" },
  ]);
  assert.equal(stream.visibleText, "actual");
});

test("noncontiguous concurrent indices complete in closure order", () => {
  const stream = parse([
    begin,
    start(9, { type: "text", text: "" }),
    delta(9, { type: "text_delta", text: "A" }),
    start(2, { type: "text", text: "" }),
    delta(2, { type: "text_delta", text: "B" }),
    delta(9, { type: "text_delta", text: "C" }),
    close(9),
    close(2),
    finish,
    stop,
  ]);
  assert.deepEqual(stream.completion().content, [
    { type: "text", text: "AC" },
    { type: "text", text: "B" },
  ]);
  assert.equal(stream.visibleText, "ABC");
  assert.equal(stream.retainedText, "ACB");
});

test("indexed replacement discards open state and permits closed-text index reuse", () => {
  const stream = parse([
    begin,
    start(4, { type: "tool_use", id: "call", name: "Read", input: {} }),
    delta(4, { type: "input_json_delta", partial_json: '{"discard":' }),
    start(4, { type: "tool_use", id: "call", name: "Read", input: {} }),
    delta(4, { type: "input_json_delta", partial_json: '{"file_path":"a"}' }),
    close(4),
    start(8, { type: "text", text: "" }),
    delta(8, { type: "text_delta", text: "first" }),
    close(8),
    start(8, { type: "text", text: "" }),
    delta(8, { type: "text_delta", text: "second" }),
    close(8),
    finish,
    stop,
  ]);
  assert.deepEqual(stream.completion().content[0], {
    type: "tool_use",
    id: "call",
    name: "Read",
    input: { file_path: "a" },
  });
  assert.equal(stream.retainedText, "firstsecond");
});

test("closed block delta/stop and same-id closed tool restart remain protocol errors", () => {
  for (const extra of [
    delta(3, { type: "text_delta", text: "late" }),
    close(3),
  ])
    assert.throws(
      () =>
        parse([begin, start(3, { type: "text", text: "" }), close(3), extra]),
      /protocol/,
    );
  assert.throws(
    () =>
      parse([
        begin,
        start(3, { type: "tool_use", id: "closed", name: "Read", input: {} }),
        close(3),
        start(3, { type: "tool_use", id: "closed", name: "Read", input: {} }),
      ]),
    /protocol/,
  );
  assert.throws(
    () => parse([begin, delta(99, { type: "text_delta", text: "unknown" })]),
    /protocol/,
  );
});

test("repeated stop-reason deltas overwrite state and zero input usage does not erase known counts", () => {
  const stream = parse([
    begin,
    finish,
    {
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { input_tokens: 0, output_tokens: 4 },
    },
    stop,
  ]);
  assert.equal(stream.completion().stop_reason, "max_tokens");
  assert.deepEqual(stream.usage, { input_tokens: 5, output_tokens: 4 });
});

test("tool conversion retains empty/null/primitive JSON and marks malformed input", () => {
  for (const value of ["", "null", " null "])
    assert.deepEqual(normalizeToolInput(value), {});
  assert.deepEqual(normalizeToolInput('\uFEFF{"a":1}'), { a: 1 });
  assert.deepEqual(normalizeToolInput("[1]"), [1]);
  assert.equal(normalizeToolInput("false"), false);
  assert.equal(normalizeToolInput("42"), 42);
  assert.deepEqual(unparsedToolInput(normalizeToolInput(" {bad")), {
    raw: " {bad",
    len: 5,
  });
  assert.deepEqual(unparsedToolInput(normalizeToolInput("  ")), {
    raw: "  ",
    len: 2,
  });
  assert.throws(() => normalizeToolInput(null), /string or object/);
  const stream = parse([
    begin,
    start(0, { type: "tool_use", id: "bad", name: "Read", input: {} }),
    delta(0, { type: "input_json_delta", partial_json: "{bad" }),
    close(0),
    finish,
    stop,
  ]);
  const block = stream.content[0];
  assert.ok(block?.type === "tool_use");
  assert.deepEqual(unparsedToolInput(block.input), { raw: "{bad", len: 4 });
});

test("tool normalization removes nested __proto__ keys without removing constructor data", () => {
  const result = normalizeToolInput(
    '{"__proto__":{"polluted":true},"nested":[{"__proto__":{"bad":1},"constructor":"kept"}]}',
  );
  assert.deepEqual(result, { nested: [{ constructor: "kept" }] });
  assert.equal(({} as any).polluted, undefined);
  const long = "x".repeat(2047) + "😀broken";
  const marker = unparsedToolInput(normalizeToolInput(long));
  assert.equal(marker?.raw, "x".repeat(2047));
  assert.equal(marker?.len, long.length);
  assert.equal(normalizeToolName("😀".repeat(201)), "😀".repeat(200));
});

test("deep tool input sanitization is iterative", () => {
  let source: any = JSON.parse('{"__proto__":1,"leaf":true}');
  for (let n = 0; n < 12000; n++) source = { child: source };
  let result: any = normalizeToolInput(source);
  for (let n = 0; n < 12000; n++) result = result.child;
  assert.deepEqual(result, { leaf: true });
});
