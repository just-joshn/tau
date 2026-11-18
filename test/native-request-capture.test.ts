import assert from "node:assert/strict";
import { createServer } from "node:http";
import { onTestFinished, test } from "bun:test";
import { AnthropicProvider } from "../src/provider.js";
import { ApiAttemptBudget } from "../src/attempt-ledger.js";
import {
  NativeRequestCaptureError,
  type NativePreparedRequest,
} from "../src/native-request-capture.js";
import type { CompletionRequest } from "../src/types.js";
import { fixtureSse } from "./sse-fixture.js";

const MODEL = "claude-sonnet-4-6";
const message = {
  type: "message",
  id: "actual-reply",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "ACTUAL_REPLY" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 3 },
};
async function serverFixture(fallback = false) {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += String(part);
      bodies.push(body);
      if (fallback) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          fixtureSse([
            {
              type: "message_start",
              message: {
                ...message,
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: message.content[0],
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ]),
        );
      }
    })().catch((error) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    bodies,
    provider: new AnthropicProvider({
      apiKey: "owned-dummy",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 3,
    }),
  };
}
const request = (
  extra: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  model: MODEL,
  system: "ACTUAL_SYSTEM",
  messages: [
    { role: "user", content: [{ type: "text", text: "ACTUAL_PROMPT" }] },
  ],
  tools: [],
  maxTokens: 100,
  signal: new AbortController().signal,
  onText: () => {},
  ...extra,
});

test("prepared request observes the immutable actual serialized body and is awaited before HTTP or budget use", async () => {
  const f = await serverFixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    budget = new ApiAttemptBudget(1);
  let prepared: NativePreparedRequest | undefined;
  const tool = {
    name: "Read",
    description: "ACTUAL_READ",
    input_schema: { type: "object" as const },
    cache_control: { type: "ephemeral" },
  };
  const completion = f.provider.complete(
    request({
      tools: [tool],
      disablePromptCaching: true,
      attemptBudget: budget,
      nativeRequestPrepared: async (value) => {
        prepared = value;
        assert.ok(Object.isFrozen(value) && Object.isFrozen(value.body));
        assert.throws(
          () =>
            Object.assign(value.body, {
              model: "CANNOT_CHANGE_ACTUAL_REQUEST",
            }),
          TypeError,
        );
        entered.resolve();
        await release.promise;
      },
    }),
  );
  await entered.promise;
  assert.equal(f.bodies.length, 0);
  assert.equal(budget.remaining, 1);
  release.resolve();
  await completion;
  assert.ok(prepared);
  assert.equal(prepared.transport, "stream");
  assert.equal(prepared.wireModel, MODEL);
  assert.equal(prepared.byteLength, Buffer.byteLength(f.bodies[0] ?? ""));
  assert.equal(JSON.stringify(prepared.body), f.bodies[0]);
  assert.equal(JSON.stringify(prepared.body).includes("cache_control"), false);
  assert.ok(Object.hasOwn(tool, "cache_control"));
  assert.equal(budget.remaining, 0);
});

test("a prepared-request sink failure consumes no API attempt and cannot cause HTTP retry or fallback", async () => {
  const f = await serverFixture(),
    budget = new ApiAttemptBudget(1),
    cause = new Error("ACTUAL_SNAPSHOT_SINK_FAILURE");
  let captures = 0;
  await assert.rejects(
    f.provider.complete(
      request({
        attemptBudget: budget,
        nativeRequestPrepared: () => {
          captures++;
          throw cause;
        },
      }),
    ),
    (error) =>
      error instanceof NativeRequestCaptureError && error.cause === cause,
  );
  assert.equal(captures, 1);
  assert.equal(f.bodies.length, 0);
  assert.equal(budget.remaining, 1);
});

test("stream-to-JSON fallback captures each actual serialized transport without inventing another request", async () => {
  const f = await serverFixture(true),
    prepared: NativePreparedRequest[] = [];
  const reply = await f.provider.complete(
    request({
      nativeRequestPrepared: (value) => {
        prepared.push(value);
      },
    }),
  );
  assert.equal(reply.content[0]?.type, "text");
  assert.deepEqual(
    prepared.map((value) => value.transport),
    ["stream", "json"],
  );
  assert.deepEqual(
    prepared.map((value) => JSON.stringify(value.body)),
    f.bodies,
  );
  assert.equal(f.bodies.length, 2);
});

test("aborting the actual capture preserves its cancellation reason before transport starts", async () => {
  const f = await serverFixture(),
    controller = new AbortController(),
    cause = new Error("ACTUAL_PREPARE_ABORT"),
    budget = new ApiAttemptBudget(1);
  await assert.rejects(
    f.provider.complete(
      request({
        signal: controller.signal,
        attemptBudget: budget,
        nativeRequestPrepared: () => {
          controller.abort(cause);
          throw cause;
        },
      }),
    ),
    (error) => error === cause,
  );
  assert.equal(f.bodies.length, 0);
  assert.equal(budget.remaining, 1);
});
