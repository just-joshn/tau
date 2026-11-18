import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AnthropicProvider } from "../src/provider.js";
import { StreamFailure } from "../src/message-stream.js";
import type { CompletionRequest } from "../src/types.js";
import { fixtureSse } from "./sse-fixture.js";

const start = {
  type: "message_start",
  message: {
    role: "assistant",
    content: [],
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};
const blocks = [
  start,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "done" },
  },
  { type: "content_block_stop", index: 0 },
];
const end = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 1 },
};
const stop = { type: "message_stop" };
const all = [...blocks, end, stop];
const request = (
  t: TestContext,
  extra: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  model: "fixture",
  system: "",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  maxTokens: 100,
  signal: t.signal,
  onText: () => {},
  ...extra,
});
async function fixture(
  t: TestContext,
  wire: string | Buffer | ((response: ServerResponse) => Promise<void>),
) {
  const calls: boolean[] = [];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { stream: boolean };
    calls.push(body.stream);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (typeof wire === "function") await wire(res);
      else res.end(wire);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "fallback" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return {
    calls,
    provider: new AnthropicProvider({
      apiKey: "loopback",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 2,
    }),
  };
}

test("CR-only and mixed LF/CRLF/CR frames complete one stream, including a final held CR", async (t) => {
  const mixed = fixtureSse(all)
    .split("\n")
    .map((line, index) => line + ["\r", "\r\n", "\n"][index % 3])
    .join("");
  for (const wire of [fixtureSse(all, "\r"), mixed]) {
    const f = await fixture(t, wire);
    const result = await f.provider.complete(request(t));
    assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
    assert.equal(result.partial, undefined);
    assert.deepEqual(f.calls, [true]);
  }
});

test("line BOMs and CRLF spanning one-byte chunks retain Unicode and genuine record boundaries", async (t) => {
  const events = all.map((event) =>
    event.type === "content_block_start"
      ? { ...event, content_block: { type: "text", text: "done 🌍" } }
      : event,
  );
  const bytes = Buffer.from(
    fixtureSse(events, "\r\n")
      .split("\r\n")
      .map((line) => `\uFEFF${line}`)
      .join("\r\n"),
  );
  const f = await fixture(t, async (response) => {
    for (const byte of bytes) {
      if (response.destroyed) return;
      response.write(Buffer.from([byte]));
      await setImmediate();
    }
    response.end();
  });
  const result = await f.provider.complete(request(t));
  assert.deepEqual(result.content, [{ type: "text", text: "done 🌍" }]);
  assert.equal(result.partial, undefined);
  assert.deepEqual(f.calls, [true]);
});

test("invalid UTF-8 within a JSON string uses replacement decoding without a fallback request", async (t) => {
  const raw = fixtureSse(all);
  const position = raw.indexOf("done");
  assert.ok(position > 0);
  const bytes = Buffer.concat([
    Buffer.from(raw.slice(0, position)),
    Buffer.from([0xf0, 0x28, 0x8c, 0x28]),
    Buffer.from(raw.slice(position + 4)),
  ]);
  const f = await fixture(t, bytes);
  const result = await f.provider.complete(request(t));
  assert.deepEqual(result.content, [{ type: "text", text: "�(�(" }]);
  assert.equal(result.partial, undefined);
  assert.deepEqual(f.calls, [true]);
});

test("EOF discards undelimited event/data and comment tails after a coherent stop envelope", async (t) => {
  for (const tail of [
    "event: message_start\ndata: {bad-json",
    "event: message_start\ndata: {bad-json\n",
    ": unterminated comment",
    "id: unterminated ignored field",
    "event: message_start\ndata: {bad-json\r",
  ]) {
    const f = await fixture(t, fixtureSse([...blocks, end]) + tail);
    const result = await f.provider.complete(request(t));
    assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
    assert.equal(result.partial, undefined);
    assert.deepEqual(f.calls, [true]);
  }
});

test("EOF cannot promote an undelimited stop envelope or suppress a delimited malformed record", async (t) => {
  const undelimited = await fixture(
    t,
    fixtureSse(blocks) + `event: message_delta\ndata: ${JSON.stringify(end)}`,
  );
  const partial = await undelimited.provider.complete(request(t));
  assert.deepEqual(partial.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(partial.partial, { cause: "truncated" });
  assert.deepEqual(undelimited.calls, [true]);
  const delimited = await fixture(
    t,
    fixtureSse([...blocks, end]) + "event: message_start\ndata: {bad-json\n\n",
  );
  const malformed = await delimited.provider.complete(request(t));
  assert.deepEqual(malformed.partial, { cause: "malformed" });
  assert.deepEqual(delimited.calls, [true]);
});

test("non-null primitive and array bodies count as unknown events and allow following output", async (t) => {
  for (const body of [0, false, "", "opaque", [], [1, 2]]) {
    const wire =
      `event: message\ndata: ${JSON.stringify(body)}\n\n` + fixtureSse(all);
    const f = await fixture(t, wire);
    const result = await f.provider.complete(request(t));
    assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
    assert.equal(result.partial, undefined);
    assert.deepEqual(f.calls, [true]);
  }
});

test("null uses unknown-error recovery: JSON fallback before output, terminal failure after closed output", async (t) => {
  const before = await fixture(
    t,
    "event: message\ndata: null\n\n" + fixtureSse(all),
  );
  assert.deepEqual((await before.provider.complete(request(t))).content, [
    { type: "text", text: "fallback" },
  ]);
  assert.deepEqual(before.calls, [true, false]);
  const after = await fixture(
    t,
    fixtureSse(blocks) +
      "event: message\ndata: null\n\n" +
      fixtureSse([end, stop]),
  );
  let shown = "";
  await assert.rejects(
    after.provider.complete(
      request(t, {
        onText: (text) => {
          shown += text;
        },
      }),
    ),
    (error: unknown) =>
      error instanceof StreamFailure && error.causeCode === "unknown",
  );
  assert.equal(shown, "done");
  assert.deepEqual(after.calls, [true]);
});
