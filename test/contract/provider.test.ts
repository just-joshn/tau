import { fixtureSse } from "../helpers/sse-fixture.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { AnthropicProvider } from "../../src/provider.js";
import type { CompletionRequest } from "../../src/types.js";
import { ApiAttemptBudget } from "../../src/attempt-ledger.js";

const start = {
  type: "message_start",
  message: {
    role: "assistant",
    content: [],
    usage: { input_tokens: 12, output_tokens: 0 },
  },
};
const textStart = {
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
};
const textDelta = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "Hi 🌍" },
};
const textStop = { type: "content_block_stop", index: 0 };
const end = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 4 },
};
const stop = { type: "message_stop" };

function sse(
  event: { type: string; [key: string]: unknown },
  newline = "\n",
): string {
  return fixtureSse([event], newline);
}

function request(
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    model: "test-model",
    system: "System",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [
      {
        name: "read",
        description: "Read file",
        input_schema: { type: "object" },
      },
    ],
    maxTokens: 100,
    signal: new AbortController().signal,
    onText: () => undefined,
    ...overrides,
  };
}

async function server(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  options: { maxRetries?: number; allowNonStreamingFallback?: boolean } = {},
): Promise<AnthropicProvider> {
  const http = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return new AnthropicProvider({
    apiKey: "secret-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    allowNonStreamingFallback: false,
    ...options,
  });
}

function respond(
  res: ServerResponse,
  events: Array<{ type: string; [key: string]: unknown }>,
): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((event) => sse(event)).join(""));
}

test("POSTs the Messages API request and handles fragmented UTF-8, CRLF and multiline SSE", async () => {
  let seen: unknown;
  const provider = await server(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "secret-key");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers["content-type"], "application/json");
    let body = "";
    for await (const chunk of req) body += String(chunk);
    seen = JSON.parse(body);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const multilineStart = `: keepalive\r\nevent: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":${JSON.stringify(start.message)}}\r\n\r\n`;
    const bytes = Buffer.from(
      multilineStart +
        [textStart, textDelta, textStop, end, stop]
          .map((event) => sse(event, "\r\n"))
          .join(""),
    );
    for (const byte of bytes) {
      res.write(Buffer.from([byte]));
      await setImmediate();
    }
    res.end();
  });
  const text: string[] = [];
  const input = request({ onText: (value) => text.push(value) });
  const result = await provider.complete(input);
  assert.deepEqual(seen, {
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    max_tokens: 100,
    thinking: { type: "adaptive" },
    stream: true,
  });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "Hi 🌍" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 4 },
  });
  assert.equal(text.join(""), "Hi 🌍");
});

test("nonstream fallback emits one finalized assistant usage observation without synthetic stream lengths", async () => {
  let calls = 0;
  const provider = await server(
    async (req, res) => {
      for await (const _chunk of req) {
        /* Consume the owned request. */
      }
      if (++calls === 1) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { type: "not_found_error", message: "stream unavailable" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          role: "assistant",
          id: "json-owned",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      );
    },
    { allowNonStreamingFallback: true },
  );
  const observations: unknown[] = [];
  await provider.complete(
    request({ onStreamProgress: (event) => observations.push(event) }),
  );
  assert.equal(calls, 2);
  assert.deepEqual(observations, [
    {
      type: "assistant",
      responseId: "json-owned",
      usage: { input_tokens: 10, output_tokens: 3 },
    },
  ]);
});

test("assembles multiple text/tool blocks and fragmented JSON arguments", async () => {
  const provider = await server((_req, res) =>
    respond(res, [
      start,
      { type: "ping" },
      textStart,
      textDelta,
      textStop,
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-1",
          name: "read",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"a' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '.ts","nested":{"n":2}}',
        },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 15, output_tokens: 30 },
      },
      stop,
    ]),
  );
  assert.deepEqual(await provider.complete(request()), {
    content: [
      { type: "text", text: "Hi 🌍" },
      {
        type: "tool_use",
        id: "call-1",
        name: "read",
        input: { path: "a.ts", nested: { n: 2 } },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 15, output_tokens: 30 },
  });
});

test("assembles tool input deltas and retains the max_tokens stop reason", async () => {
  const provider = await server((_req, res) =>
    respond(res, [
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "c",
          name: "read",
          input: { path: "x" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 100 },
      },
      stop,
    ]),
  );
  const result = await provider.complete(request());
  assert.equal(result.stop_reason, "max_tokens");
  assert.deepEqual(result.content, [
    { type: "tool_use", id: "c", name: "read", input: { path: "x" } },
  ]);
});

const invalidStreams = [
  { name: "missing message_start", raw: sse(end) + sse(stop) },
  { name: "unknown event", raw: sse({ type: "mystery" }) },
  {
    name: "wrong event shape",
    raw: 'event: message_start\ndata: {"type":"message_start","message":5}\n\n',
  },
  {
    name: "ping cannot substitute a message",
    raw: 'event: ping\ndata: {"type":"message_stop"}\n\n',
  },
  { name: "invalid JSON", raw: "event: message_start\ndata: {bad}\n\n" },
  {
    name: "start-only response with an undelimited trailing event",
    raw: sse(start) + 'data: {"type":"message_stop"}',
  },
  {
    name: "open block at stop",
    raw: [start, textStart, end, stop].map((event) => sse(event)).join(""),
  },
  {
    name: "wrong block index",
    raw: [start, textDelta].map((event) => sse(event)).join(""),
  },
  { name: "duplicate message_start", raw: sse(start) + sse(start) },
  { name: "missing stop reason", raw: sse(start) + sse(stop) },
  {
    name: "wrong delta kind",
    raw: [
      start,
      textStart,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
    ]
      .map((event) => sse(event))
      .join(""),
  },
  { name: "event size limit", raw: `data: ${"x".repeat(1024 * 1024)}\n\n` },
];
for (const item of invalidStreams) {
  test(`rejects ${item.name}`, async () => {
    const provider = await server((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(item.raw);
    });
    await assert.rejects(
      provider.complete(request()),
      /protocol|message_stop|size limit/,
    );
  });
}

test("bounds total response size independently of per-event size", async () => {
  const provider = await server(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 18; i++) {
      if (res.destroyed) return;
      res.write(`: ${"x".repeat(512 * 1024)}\n\n`.repeat(2));
      await setImmediate();
    }
    res.end();
  });
  await assert.rejects(
    provider.complete(request()),
    /response exceeds size limit/,
  );
});

test("replacement decoding of invalid UTF-8 alone cannot fabricate a message envelope", async () => {
  const provider = await server((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(Buffer.from([0xff]));
  });
  await assert.rejects(provider.complete(request()), /protocol/);
});

test("does not expose API error messages or HTTP bodies containing credentials", async () => {
  for (const status of [200, 401]) {
    const provider = await server((_req, res) => {
      res.writeHead(status, { "content-type": "text/event-stream" });
      res.end(
        sse({
          type: "error",
          error: { type: "secret-key", message: "secret-key" },
        }),
      );
    });
    await assert.rejects(provider.complete(request()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP error 401|streaming error/);
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    });
  }
});

test("rejects non-SSE responses", async () => {
  const provider = await server((_req, res) => {
    res.end("secret-key");
  });
  await assert.rejects(provider.complete(request()), /not an event stream/);
});

test("cancels an in-flight stream and rejects with AbortError", async () => {
  const controller = new AbortController();
  const provider = await server((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      [start, textStart, textDelta].map((event) => sse(event)).join(""),
    );
  });
  await assert.rejects(
    provider.complete(
      request({ signal: controller.signal, onText: () => controller.abort() }),
    ),
    { name: "AbortError" },
  );
});

test("cancels while waiting for the next stream chunk", async () => {
  const controller = new AbortController();
  const provider = await server((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      [start, textStart, textDelta].map((event) => sse(event)).join(""),
    );
  });
  await assert.rejects(
    provider.complete(
      request({
        signal: controller.signal,
        onText: () => {
          setTimeout(() => controller.abort(), 10);
        },
      }),
    ),
    { name: "AbortError" },
  );
});

test("message_stop completes without waiting for the server to close the response", async () => {
  const provider = await server((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write([start, end, stop].map((event) => sse(event)).join(""));
  });
  assert.equal((await provider.complete(request())).stop_reason, "end_turn");
});

test("invalid base URLs are rejected without echoing their contents", () => {
  for (const baseUrl of [
    "secret-key",
    "https://user:secret-key@example.com",
    "file:///secret-key",
  ]) {
    assert.throws(
      () => new AnthropicProvider({ apiKey: "secret-key", baseUrl }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid Messages API base URL");
        return true;
      },
    );
  }
});

test("does not send an already-cancelled request", async () => {
  let requests = 0;
  const provider = await server((_req, res) => {
    requests++;
    res.end();
  });
  await assert.rejects(
    provider.complete(request({ signal: AbortSignal.abort() })),
    { name: "AbortError" },
  );
  assert.equal(requests, 0);
});

test(
  "retries pre-stream transient HTTP failures without duplicating text",
  async () => {
    let calls = 0;
    const bodies: string[] = [];
    const provider = await server(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push(body);
      if (++calls < 3) {
        res.writeHead(calls === 1 ? 429 : 503);
        res.end("private error body");
      } else respond(res, [start, textStart, textDelta, textStop, end, stop]);
    });
    const text: string[] = [];
    const result = await provider.complete(
      request({ onText: (chunk) => text.push(chunk) }),
    );
    assert.equal(calls, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(text, ["Hi 🌍"]);
    assert.equal(result.usage.output_tokens, 4);
  },
  { timeout: 10000 },
);

test(
  "retry budget stops after the final attempt and does not expose response bodies",
  async () => {
    let calls = 0;
    const provider = await server(
      (_req, res) => {
        calls++;
        res.writeHead(500);
        res.end("secret-key");
      },
      { maxRetries: 2 },
    );
    await assert.rejects(provider.complete(request()), {
      message: "Messages API HTTP error 500",
    });
    assert.equal(calls, 3);
  },
  { timeout: 10000 },
);

test(
  "retry headers can decline a transient failure or request another retryable status",
  async () => {
    let declined = 0;
    const no = await server((_req, res) => {
      declined++;
      res.writeHead(503, { "x-should-retry": "false" });
      res.end();
    });
    await assert.rejects(no.complete(request()), /HTTP error 503/);
    assert.equal(declined, 1);
    let forced = 0;
    const yes = await server((_req, res) => {
      if (++forced === 1) {
        res.writeHead(418, { "x-should-retry": "true" });
        res.end();
      } else respond(res, [start, end, stop]);
    });
    assert.equal((await yes.complete(request())).stop_reason, "end_turn");
    assert.equal(forced, 2);
  },
  { timeout: 10000 },
);

test(
  "a retry wait is cancellable and overlong server delays are refused",
  async () => {
    let calls = 0;
    const controller = new AbortController();
    const provider = await server((_req, res) => {
      calls++;
      res.writeHead(429, { "retry-after": "30" });
      res.end();
      setTimeout(() => controller.abort(), 20);
    });
    await assert.rejects(
      provider.complete(request({ signal: controller.signal })),
      { name: "AbortError" },
    );
    assert.equal(calls, 1);
    let longCalls = 0;
    const tooLong = await server((_req, res) => {
      longCalls++;
      res.writeHead(429, { "retry-after-ms": "90000" });
      res.end();
    });
    await assert.rejects(tooLong.complete(request()), /retry delay exceeds/);
    assert.equal(longCalls, 1);
  },
  { timeout: 3000 },
);

test(
  "connection loss before headers retries, while zero ordinary budget prevents partial replay",
  async () => {
    let calls = 0;
    const provider = await server((req, res) => {
      if (++calls === 1) req.socket.destroy();
      else respond(res, [start, end, stop]);
    });
    assert.equal((await provider.complete(request())).stop_reason, "end_turn");
    assert.equal(calls, 2);
    let streams = 0;
    const partial = await server(
      (_req, res) => {
        streams++;
        respond(res, [start, textStart, textDelta]);
      },
      { maxRetries: 0 },
    );
    const text: string[] = [];
    await assert.rejects(
      partial.complete(request({ onText: (chunk) => text.push(chunk) })),
      /message_stop/,
    );
    assert.equal(streams, 1);
    assert.deepEqual(text, ["Hi 🌍"]);
  },
  { timeout: 10000 },
);

test("HTTP redirects are never followed or retried, even with a retry hint", async () => {
  let requests = 0;
  const provider = await server((_req, res) => {
    requests++;
    res.writeHead(307, { location: "/redirect", "x-should-retry": "true" });
    res.end();
  });
  await assert.rejects(provider.complete(request()));
  assert.equal(requests, 1);
});

test("terminal billing and policy failures do not retry, even with positive retry hints", async () => {
  const cases: Array<[number, object, Record<string, string>]> = [
    [429, { details: { error_code: "credits_required" } }, {}],
    [429, { message: "usage credits are required" }, {}],
    [429, { message: "service_spend_limit_reached" }, {}],
    [
      429,
      {},
      {
        "anthropic-ratelimit-unified-overage-disabled-reason":
          "org_spend_cap_reached",
      },
    ],
    [
      500,
      { details: { error_code: "dlp_request_denied" }, message: "secret-key" },
      {},
    ],
    [400, { type: "policy_blocked" }, {}],
  ];
  for (const [status, error, headers] of cases) {
    let calls = 0;
    const provider = await server((_req, res) => {
      calls++;
      res.writeHead(status, {
        "content-type": "application/json",
        "x-should-retry": "true",
        ...headers,
      });
      res.end(JSON.stringify({ type: "error", error }));
    });
    await assert.rejects(provider.complete(request()), (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.doesNotMatch(failure.message, /secret-key/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

function jsonReply(
  res: ServerResponse,
  content: unknown = [{ type: "text", text: "JSON answer" }],
): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      type: "message",
      role: "assistant",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
  );
}

test("opted-in 404 fallback sends a fixed request with stream false, including when retries are zero", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = await server(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push(z.record(z.string(), z.unknown()).parse(JSON.parse(body)));
      if (bodies.length === 1) {
        res.writeHead(404);
        res.end();
      } else
        jsonReply(res, [
          { type: "text", text: "before" },
          {
            type: "tool_use",
            id: "call",
            name: "Read",
            input: { file_path: "a" },
          },
          { type: "text", text: "after" },
        ]);
    },
    { maxRetries: 0, allowNonStreamingFallback: true },
  );
  const text: string[] = [];
  const result = await provider.complete(
    request({ onText: (value) => text.push(value) }),
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.stream, true);
  assert.deepEqual(bodies[1], { ...bodies[0], stream: false });
  assert.deepEqual(text, ["before", "after"]);
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal(result.content[1]?.type, "tool_use");
});

test("fallback is opt-in, cannot override a refusal hint and cannot repeat", async () => {
  for (const [enabled, hint, expected] of [
    [false, undefined, 1],
    [true, "false", 1],
    [true, undefined, 2],
  ] as const) {
    let calls = 0;
    const provider = await server(
      (_req, res) => {
        calls++;
        res.writeHead(404, hint ? { "x-should-retry": hint } : {});
        res.end();
      },
      { allowNonStreamingFallback: enabled },
    );
    await assert.rejects(provider.complete(request()), /HTTP error 404/);
    assert.equal(calls, expected);
  }
});

test(
  "stream and JSON phases share both retry counts and dispatch allowance",
  async () => {
    for (const maxRetries of [1, 2]) {
      let calls = 0;
      const provider = await server(
        (_req, res) => {
          calls++;
          if (calls <= 2) {
            res.writeHead(calls === 1 ? 404 : 503);
            res.end();
          } else jsonReply(res);
        },
        { maxRetries, allowNonStreamingFallback: true },
      );
      const attemptBudget = new ApiAttemptBudget(3);
      if (maxRetries === 1)
        await assert.rejects(
          provider.complete(request({ attemptBudget })),
          /HTTP error 503/,
        );
      else
        assert.equal(
          (await provider.complete(request({ attemptBudget }))).content[0]
            ?.type,
          "text",
        );
      assert.equal(calls, maxRetries === 1 ? 2 : 3);
    }
    let calls = 0;
    const provider = await server(
      (_req, res) => {
        calls++;
        res.writeHead(404);
        res.end();
      },
      { allowNonStreamingFallback: true },
    );
    await assert.rejects(
      provider.complete(request({ attemptBudget: new ApiAttemptBudget(1) })),
      /API attempt budget exhausted/,
    );
    assert.equal(calls, 1);
  },
  { timeout: 5000 },
);

test("JSON fallback validates the whole response before publishing any text", async () => {
  for (const content of [
    [
      { type: "text", text: "uncommitted" },
      { type: "thinking", thinking: "unsupported" },
    ],
    [
      { type: "text", text: "uncommitted" },
      { type: "tool_use", id: "dup", name: "Read", input: {} },
      { type: "tool_use", id: "dup", name: "Read", input: {} },
    ],
  ]) {
    let calls = 0;
    const provider = await server(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(404);
          res.end();
        } else jsonReply(res, content);
      },
      { allowNonStreamingFallback: true },
    );
    const text: string[] = [];
    await assert.rejects(
      provider.complete(request({ onText: (chunk) => text.push(chunk) })),
      /protocol/,
    );
    assert.deepEqual(text, []);
    assert.equal(calls, 2);
  }
});

test("JSON fallback can be cancelled during body reading", async () => {
  let calls = 0;
  const controller = new AbortController();
  const provider = await server(
    (_req, res) => {
      if (++calls === 1) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        setTimeout(() => controller.abort(), 10);
      }
    },
    { allowNonStreamingFallback: true },
  );
  await assert.rejects(
    provider.complete(request({ signal: controller.signal })),
    { name: "AbortError" },
  );
  assert.equal(calls, 2);
});

test(
  "error metadata is bounded and best-effort for malformed, oversized or stalled bodies",
  async () => {
    for (const mode of ["invalid", "large", "stalled"] as const) {
      let calls = 0;
      const provider = await server(
        (_req, res) => {
          if (++calls > 1) {
            respond(res, [start, end, stop]);
            return;
          }
          res.writeHead(503, { "content-type": "application/json" });
          if (mode === "invalid") res.end("{private-broken-json");
          else if (mode === "large")
            res.write('{"error":{"message":"' + "x".repeat(70000));
          else res.write("{");
        },
        { maxRetries: 1 },
      );
      assert.equal(
        (await provider.complete(request())).stop_reason,
        "end_turn",
      );
      assert.equal(calls, 2);
    }
  },
  { timeout: 6000 },
);

test("cancellation during error metadata inspection does not retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = await server((_req, res) => {
    calls++;
    res.writeHead(503, { "content-type": "application/json" });
    res.write("{");
    setTimeout(() => controller.abort(), 10);
  });
  await assert.rejects(
    provider.complete(request({ signal: controller.signal })),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("fallback rejects malformed UTF8/JSON and non-JSON responses without exposing bodies", async () => {
  for (const [type, body, expected] of [
    ["application/json", Buffer.from([255]), /protocol/],
    ["application/json", Buffer.from("{private-data"), /protocol/],
    ["text/plain", Buffer.from("private-data"), /not JSON/],
  ] as const) {
    let calls = 0;
    const provider = await server(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(404);
          res.end();
        } else {
          res.writeHead(200, { "content-type": type });
          res.end(body);
        }
      },
      { allowNonStreamingFallback: true },
    );
    await assert.rejects(provider.complete(request()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-data/);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test("fallback JSON has the same bounded total response size as streaming", async () => {
  let calls = 0;
  const provider = await server(
    async (_req, res) => {
      if (++calls === 1) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      for (let index = 0; index < 17; index++) {
        if (res.destroyed) return;
        res.write("x".repeat(1024 * 1024));
        await setImmediate();
      }
      res.end();
    },
    { allowNonStreamingFallback: true },
  );
  await assert.rejects(
    provider.complete(request()),
    /response exceeds size limit/,
  );
  assert.equal(calls, 2);
});
