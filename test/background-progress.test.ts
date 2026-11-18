import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundProgressMeter } from "../src/background-progress.js";
import { MessageStream, streamEventSchema } from "../src/message-stream.js";
import { fixtureEvents } from "./sse-fixture.js";

test("stream accounting observes block-time usage before final reconciliation and retains the final streamed estimate", () => {
  const meter = createBackgroundProgressMeter();
  const replies = [
    {
      type: "tool_use",
      id: "owned-read",
      name: "Read",
      input: { file_path: "owned.txt" },
    },
    { type: "text", text: "OWNED_BACKGROUND_CHILD_FINAL" },
  ];
  for (const [index, block] of replies.entries()) {
    const stream = new MessageStream(
      () => {},
      (event) => meter.accept(event),
    );
    const events = fixtureEvents([
      {
        type: "message_start",
        message: {
          role: "assistant",
          id: `response-${index}`,
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: index ? "end_turn" : "tool_use" },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ]);
    for (const event of events) stream.accept(event);
    assert.deepEqual(stream.completion().usage, {
      input_tokens: 10,
      output_tokens: 3,
    });
  }
  assert.deepEqual(meter.snapshot(), {
    latestInputTokens: 10,
    cumulativeOutputTokens: 0,
    streamedTokenEstimate: 7,
    usageSource: "stream-stamped",
  });
});

test("a retry retracts its own estimate while a new response retires the preceding response estimate once", () => {
  const meter = createBackgroundProgressMeter();
  meter.accept({ type: "response_start" });
  meter.accept({ type: "length", chars: 20 });
  meter.accept({ type: "response_start" });
  meter.accept({ type: "length", chars: 8 });
  meter.accept({
    type: "assistant",
    responseId: "retry",
    usage: { input_tokens: 10, output_tokens: 1 },
  });
  meter.accept({ type: "response_end" });
  assert.equal(meter.snapshot().streamedTokenEstimate, 2);
  meter.accept({ type: "response_start" });
  meter.accept({ type: "length", chars: 12 });
  meter.accept({
    type: "assistant",
    responseId: "next",
    usage: { input_tokens: 12, output_tokens: 0 },
  });
  meter.accept({
    type: "assistant",
    responseId: "next",
    usage: { input_tokens: 12, output_tokens: 0 },
  });
  assert.equal(meter.snapshot().streamedTokenEstimate, 3);
  assert.equal(meter.snapshot().cumulativeOutputTokens, 1);
});

test("live token updates use the current host interval while response end forces the final fractional tail", () => {
  let now = 1000,
    interval = 500;
  const meter = createBackgroundProgressMeter({
    now: () => now,
    intervalMs: () => interval,
  });
  meter.accept({ type: "response_start" });
  meter.accept({ type: "length", chars: 4 });
  assert.equal(meter.snapshot().streamedTokenEstimate, 1);
  meter.accept({ type: "length", chars: 5 });
  assert.equal(meter.snapshot().streamedTokenEstimate, 1);
  now = 1500;
  meter.accept({ type: "length", chars: 4 });
  assert.equal(meter.snapshot().streamedTokenEstimate, 3);
  interval = 5000;
  now = 2000;
  meter.accept({ type: "length", chars: 4 });
  assert.equal(meter.snapshot().streamedTokenEstimate, 3);
  meter.accept({ type: "response_end" });
  assert.equal(meter.snapshot().streamedTokenEstimate, 4);
});

test("a coherent EOF normalizes the provider stop once after the completed envelope", () => {
  let ends = 0;
  const stream = new MessageStream(
    () => {},
    (event) => {
      if (event.type === "response_end") ends++;
    },
  );
  for (const event of fixtureEvents([
    {
      type: "message_start",
      message: {
        role: "assistant",
        id: "owned",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "done" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  ]))
    stream.accept(event);
  stream.completion();
  stream.completion();
  assert.equal(ends, 1);
});

test("thinking estimates preserve explicit values, per-delta rounding, signature floors and per-block resets", () => {
  const meter = createBackgroundProgressMeter();
  const stream = new MessageStream(
    () => {},
    (event) => meter.accept(event),
  );
  for (const event of [
    {
      type: "message_start",
      message: {
        role: "assistant",
        id: "thinking",
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "abcde" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "", estimated_tokens: 3 },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "ignored-for-estimate",
        estimated_tokens: 0,
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "a", estimated_tokens: null },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "a".repeat(40) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "a".repeat(16) },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ])
    stream.accept(streamEventSchema.parse(event));
  assert.equal(meter.snapshot().streamedTokenEstimate, 11);
  assert.equal(meter.snapshot().cumulativeOutputTokens, 0);
  assert.equal(stream.completion().usage.output_tokens, 4);
});
