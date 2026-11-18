import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, onTestFinished } from "bun:test";
import { AnthropicProvider } from "../../src/provider.js";
import { ApiAttemptBudget } from "../../src/attempt-ledger.js";
import { runAgent } from "../../src/agent.js";
import { createTools } from "../../src/tools.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, Message } from "../../src/types.js";

const requestBlock = z.looseObject({
  type: z.string().optional(),
  signature: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
  input: z.unknown().optional(),
});
const requestMessage = z.looseObject({
  role: z.string(),
  partial: z.unknown().optional(),
  content: z.array(requestBlock),
});
const requestBody = z.looseObject({
  stream: z.boolean().optional(),
  model: z.string(),
  messages: z.array(requestMessage),
});
type RequestBody = z.infer<typeof requestBody>;

const begin = {
  type: "message_start",
  message: {
    role: "assistant",
    content: [],
    usage: { input_tokens: 5, output_tokens: 0 },
  },
};
const sse = (event: unknown) => fixtureSse([event]);
const open = (index: number, content_block: unknown) => ({
  type: "content_block_start",
  index,
  content_block,
});
const close = (index: number) => ({ type: "content_block_stop", index });
const delta = (index: number, value: unknown) => ({
  type: "content_block_delta",
  index,
  delta: value,
});
const end = (stop_reason = "end_turn") => ({
  type: "message_delta",
  delta: { stop_reason },
  usage: { output_tokens: 3 },
});
const stop = { type: "message_stop" };
const text = (value: string) => [
  open(0, { type: "text", text: "" }),
  delta(0, { type: "text_delta", text: value }),
  close(0),
];
function send(res: ServerResponse, events: unknown[], broken = false): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const bytes = events.map(sse).join("");
  if (broken) {
    res.write(bytes);
    setTimeout(() => res.destroy(), 10);
  } else res.end(bytes);
}
const testSignal = () => {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  return controller.signal;
};
const request = (
  extra: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  model: "primary",
  system: "",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  maxTokens: 100,
  signal: testSignal(),
  onText: () => {},
  ...extra,
});
async function fixture(
  handler: (res: ServerResponse, body: RequestBody, calls: number) => void,
  options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) {
  let calls = 0;
  const bodies: RequestBody[] = [];
  const http = createServer(async (req, res) => {
    try {
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = requestBody.parse(JSON.parse(data));
      bodies.push(body);
      handler(res, body, ++calls);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return {
    provider: new AnthropicProvider({
      apiKey: "loopback",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 2,
      ...options,
    }),
    calls: () => calls,
    bodies,
  };
}

test("thinking, signature replacement and redacted blocks assemble without visible reasoning output", async () => {
  const f = await fixture((res) =>
    send(res, [
      begin,
      open(0, {
        type: "thinking",
        thinking: "initial ignored",
        signature: "initial ignored",
      }),
      delta(0, { type: "thinking_delta", thinking: "reason " }),
      delta(0, { type: "thinking_delta", thinking: "carefully" }),
      delta(0, { type: "signature_delta", signature: "old" }),
      delta(0, { type: "signature_delta", signature: "signed" }),
      close(0),
      open(1, { type: "redacted_thinking", data: "opaque" }),
      delta(1, { type: "thinking_delta", thinking: null }),
      close(1),
      open(2, { type: "text", text: "" }),
      delta(2, { type: "text_delta", text: "Answer" }),
      close(2),
      end(),
      stop,
    ]),
  );
  let shown = "";
  const result = await f.provider.complete(
    request({
      onText: (value) => {
        shown += value;
      },
    }),
  );
  assert.equal(shown, "Answer");
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "reason carefully", signature: "signed" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "text", text: "Answer" },
  ]);
});

test(
  "partial output connection retry explicitly resets provisional text and reuses the fixed request",
  async () => {
    const f = await fixture((res, _body, calls) =>
      calls === 1
        ? send(
            res,
            [
              begin,
              open(0, { type: "text", text: "" }),
              delta(0, { type: "text_delta", text: "discarded" }),
            ],
            true,
          )
        : send(res, [begin, ...text("replacement"), end(), stop]),
    );
    let shown = "";
    const resets: string[] = [];
    const result = await f.provider.complete(
      request({
        onText: (value) => {
          shown += value;
        },
        onTextReset: (value) => {
          shown = value;
          resets.push(value);
        },
      }),
    );
    assert.equal(shown, "replacement");
    assert.deepEqual(resets, [""]);
    assert.equal(f.calls(), 2);
    assert.deepEqual(f.bodies[0], f.bodies[1]);
    assert.deepEqual(result.content, [{ type: "text", text: "replacement" }]);
  },
  { timeout: 5000 },
);

test("partial malformed stream switches to JSON after reset with shared dispatch admission", async () => {
  const budget = new ApiAttemptBudget(2);
  const f = await fixture(
    (res, body) =>
      body.stream
        ? send(res, [
            begin,
            open(0, { type: "text", text: "partial" }),
            delta(0, { type: "input_json_delta", partial_json: "{}" }),
          ])
        : (res.writeHead(200, { "content-type": "application/json" }),
          res.end(
            JSON.stringify({
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "JSON answer" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 5, output_tokens: 3 },
            }),
          )),
    { allowNonStreamingFallback: true },
  );
  let shown = "";
  const resets: string[] = [];
  const result = await f.provider.complete(
    request({
      attemptBudget: budget,
      onText: (value) => {
        shown += value;
      },
      onTextReset: (value) => {
        shown = value;
        resets.push(value);
      },
    }),
  );
  assert.equal(shown, "JSON answer");
  assert.deepEqual(resets, [""]);
  assert.equal(budget.remaining, 0);
  assert.deepEqual(
    f.bodies.map((body) => body.stream),
    [true, false],
  );
  assert.equal(result.partial, undefined);
});

test("completed blocks survive truncation while an unfinished tool cannot enter history", async () => {
  const f = await fixture((res) =>
    send(res, [
      begin,
      ...text("Retained"),
      open(1, { type: "tool_use", id: "unfinished", name: "Write", input: {} }),
      delta(1, { type: "input_json_delta", partial_json: '{"path":' }),
    ]),
  );
  const result = await f.provider.complete(request());
  assert.deepEqual(result.content, [{ type: "text", text: "Retained" }]);
  assert.equal(result.stop_reason, "end_turn");
  assert.deepEqual(result.partial, { cause: "truncated" });
  assert.equal(f.calls(), 1);
});

test("coherent stop envelope completes after EOF without a final message_stop", async () => {
  const f = await fixture((res) =>
    send(res, [begin, ...text("Complete"), end()]),
  );
  const result = await f.provider.complete(request());
  assert.equal(result.partial, undefined);
  assert.equal(result.stop_reason, "end_turn");
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 3 });
  assert.equal(f.calls(), 1);
});

test("usage-only message deltas update counts without fabricating a stop envelope", async () => {
  const f = await fixture((res) =>
    send(res, [
      begin,
      ...text("Answer"),
      { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
      {
        type: "message_delta",
        delta: { stop_reason: null },
        usage: { input_tokens: 8 },
      },
      end(),
      stop,
    ]),
  );
  const result = await f.provider.complete(request());
  assert.deepEqual(result.usage, { input_tokens: 8, output_tokens: 3 });
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.partial, undefined);
});

test(
  "thinking-only retry discards the old attempt and preserves the replacement signature",
  async () => {
    const f = await fixture((res, _body, calls) =>
      send(
        res,
        calls === 1
          ? [
              begin,
              open(0, { type: "thinking", thinking: "", signature: "" }),
              delta(0, { type: "thinking_delta", thinking: "discard" }),
              delta(0, { type: "signature_delta", signature: "old" }),
              close(0),
            ]
          : [
              begin,
              open(0, { type: "thinking", thinking: "", signature: "" }),
              delta(0, { type: "thinking_delta", thinking: "keep" }),
              delta(0, { type: "signature_delta", signature: "new" }),
              close(0),
              open(1, { type: "text", text: "answer" }),
              close(1),
              end(),
              stop,
            ],
      ),
    );
    const result = await f.provider.complete(request());
    assert.equal(f.calls(), 2);
    assert.deepEqual(result.content[0], {
      type: "thinking",
      thinking: "keep",
      signature: "new",
    });
    assert.equal(result.partial, undefined);
  },
  { timeout: 5000 },
);

test(
  "body retry and subsequent HTTP failure share the ordinary retry count",
  async () => {
    const f = await fixture(
      (res, _body, calls) => {
        if (calls === 1)
          send(res, [begin, open(0, { type: "text", text: "discard" })], true);
        else {
          res.writeHead(503);
          res.end();
        }
      },
      { maxRetries: 1 },
    );
    const resets: string[] = [];
    await assert.rejects(
      f.provider.complete(
        request({ onTextReset: (value) => resets.push(value) }),
      ),
      /HTTP error 503/,
    );
    assert.equal(f.calls(), 2);
    assert.deepEqual(resets, [""]);
  },
  { timeout: 5000 },
);

test(
  "nonstreaming body connection failure retries inside the same phase before publishing text",
  async () => {
    const f = await fixture(
      (res, _body, calls) => {
        if (calls === 1) {
          res.writeHead(404);
          res.end();
        } else if (calls === 2) {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"type":"message"');
          setTimeout(() => res.destroy(), 10);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "message",
              role: "assistant",
              content: [
                { type: "thinking", thinking: "reason", signature: "sig" },
                { type: "text", text: "Final" },
              ],
              stop_reason: "end_turn",
              usage: { input_tokens: 5, output_tokens: 3 },
            }),
          );
        }
      },
      { allowNonStreamingFallback: true },
    );
    let shown = "";
    const result = await f.provider.complete(
      request({
        onText: (value) => {
          shown += value;
        },
      }),
    );
    assert.equal(shown, "Final");
    assert.deepEqual(
      f.bodies.map((body) => body.stream),
      [true, false, false],
    );
    assert.equal(result.content[0]?.type, "thinking");
  },
  { timeout: 5000 },
);

test("thinking-only server error executes model fallback without losing shared admission", async () => {
  const budget = new ApiAttemptBudget(2);
  const f = await fixture(
    (res, body) =>
      send(
        res,
        body.model === "primary"
          ? [
              begin,
              open(0, { type: "thinking", thinking: "", signature: "" }),
              close(0),
              {
                type: "error",
                error: { type: "api_error", message: "private" },
              },
            ]
          : [begin, ...text("Fallback answer"), end(), stop],
      ),
    { fallbackModel: "secondary" },
  );
  const result = await f.provider.complete(request({ attemptBudget: budget }));
  assert.deepEqual(
    f.bodies.map((body) => body.model),
    ["primary", "secondary"],
  );
  assert.equal(result.model, "secondary");
  assert.equal(budget.remaining, 0);
});

test(
  "aborting from a provisional reset prevents any replacement dispatch",
  async () => {
    const abort = new AbortController();
    const f = await fixture((res) =>
      send(res, [begin, open(0, { type: "text", text: "discard" })], true),
    );
    await assert.rejects(
      f.provider.complete(
        request({ signal: abort.signal, onTextReset: () => abort.abort() }),
      ),
      { name: "AbortError" },
    );
    assert.equal(f.calls(), 1);
  },
  { timeout: 5000 },
);

test(
  "agent retains closed tool calls once, trims open output and strips local metadata from replay",
  async () => {
    let executions = 0,
      displayed = "";
    const f = await fixture((res, body, calls) =>
      calls === 1
        ? send(res, [
            begin,
            open(0, {
              type: "tool_use",
              id: "closed",
              name: "Read",
              input: { file_path: "a" },
            }),
            close(0),
            open(1, { type: "text", text: "trim me" }),
          ])
        : send(res, [begin, ...text("Done"), end(), stop]),
    );
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
    ];
    await runAgent({
      provider: f.provider,
      tools: {
        definitions: [],
        execute: async (call) => {
          executions++;
          return { type: "tool_result", tool_use_id: call.id, content: "data" };
        },
      },
      messages,
      model: "primary",
      system: "",
      maxTokens: 100,
      maxTurns: 3,
      signal: testSignal(),
      onEvent: (event) => {
        if (event.type === "text") displayed += event.text;
        if (event.type === "text_reset") displayed = event.text;
      },
    });
    assert.equal(executions, 1);
    assert.equal(displayed, "Done");
    assert.equal(messages[1]?.partial?.cause, "truncated");
    assert.equal(f.bodies[1]?.messages[1]?.partial, undefined);
    assert.equal(f.bodies[1]?.messages[1]?.content.length, 1);
    assert.equal(f.bodies[1]?.messages[2]?.content[0]?.tool_use_id, "closed");
    assert.equal(f.calls(), 2);
  },
  { timeout: 5000 },
);

test("ordered model fallbacks advance once each and the primary is retried on the next query", async () => {
  const seen: string[] = [];
  const f = await fixture(
    (res, body, calls) => {
      seen.push(body.model);
      send(
        res,
        calls < 3
          ? [
              begin,
              open(0, { type: "thinking", thinking: "", signature: "" }),
              close(0),
              {
                type: "error",
                error: { type: "api_error", message: "private" },
              },
            ]
          : [begin, ...text("Answer"), end(), stop],
      );
    },
    { fallbackModel: " second,third,second ", maxRetries: 0 },
  );
  assert.equal((await f.provider.complete(request())).model, "third");
  assert.equal((await f.provider.complete(request())).model, undefined);
  assert.deepEqual(seen, ["primary", "second", "third", "primary"]);
});

test(
  "HTTP overload executes the fallback model after its distinct overload threshold",
  async () => {
    const f = await fixture(
      (res, body) => {
        if (body.model === "primary") {
          res.writeHead(529);
          res.end();
        } else send(res, [begin, ...text("Fallback"), end(), stop]);
      },
      { fallbackModel: "secondary" },
    );
    assert.equal((await f.provider.complete(request())).model, "secondary");
    assert.deepEqual(
      f.bodies.map((body) => body.model),
      ["primary", "primary", "primary", "secondary"],
    );
  },
  { timeout: 5000 },
);

test("JSON fallback is enabled by default and may be explicitly disabled", async () => {
  const f = await fixture(
    (res, body) => {
      if (body.stream) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        );
      }
    },
    { maxRetries: 0 },
  );
  await f.provider.complete(request());
  assert.deepEqual(
    f.bodies.map((body) => body.stream),
    [true, false],
  );
  const disabled = await fixture(
    (res) => {
      res.writeHead(404);
      res.end();
    },
    { maxRetries: 0, allowNonStreamingFallback: false },
  );
  await assert.rejects(disabled.provider.complete(request()), /HTTP error 404/);
  assert.equal(disabled.calls(), 1);
});

test("consumer display exceptions do not trigger replay or fallback", async () => {
  const f = await fixture((res) =>
    send(res, [begin, ...text("Answer"), end(), stop]),
  );
  await assert.rejects(
    f.provider.complete(
      request({
        onText: () => {
          throw new Error("display failure");
        },
      }),
    ),
    /display failure/,
  );
  assert.equal(f.calls(), 1);
});

test("reasoning delta/type corruption and failed tool JSON cannot become retained tool calls", async () => {
  for (const events of [
    [
      begin,
      open(0, { type: "text", text: "" }),
      delta(0, { type: "signature_delta", signature: "wrong block" }),
    ],
    [
      begin,
      open(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "thinking_delta", thinking: 42 }),
    ],
  ]) {
    const f = await fixture((res) => send(res, events), {
      maxRetries: 0,
      allowNonStreamingFallback: false,
    });
    await assert.rejects(f.provider.complete(request()), /protocol/);
    assert.equal(f.calls(), 1);
  }
});

test("malformed streamed tool JSON produces one tool error and can be repaired in the next model round", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-unparsed-tool-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const f = await fixture((res, body, calls) => {
    if (calls === 1)
      send(res, [
        begin,
        open(0, { type: "tool_use", id: "unparsed", name: "Read", input: {} }),
        delta(0, { type: "input_json_delta", partial_json: '{"broken":' }),
        close(0),
        end("tool_use"),
        stop,
      ]);
    else send(res, [begin, ...text("Recovered"), end(), stop]);
  });
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "read" }] },
  ];
  let starts = 0;
  await runAgent({
    provider: f.provider,
    tools: createTools({ cwd, mode: "plan", approve: async () => false }),
    messages,
    model: "primary",
    system: "",
    maxTokens: 100,
    maxTurns: 2,
    maxApiAttempts: 2,
    signal: testSignal(),
    onEvent: (event) => {
      if (event.type === "tool_start") starts++;
    },
  });
  assert.equal(starts, 1);
  assert.equal(f.calls(), 2);
  const result = f.bodies[1]?.messages.at(-1)?.content[0];
  assert.equal(result?.is_error, true);
  assert.ok(typeof result?.content === "string");
  assert.match(result.content, /input JSON failed to parse/);
  assert.deepEqual(f.bodies[1]?.messages[1]?.content[0]?.input, {
    __unparsedToolInput: { raw: '{"broken":', len: 10 },
  });
});

test("raw indexed streams normalize start fields and reconcile visible text with closed-block order", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      begin,
      open(9, { type: "text", text: "ignore" }),
      delta(9, { type: "text_delta", text: "A" }),
      open(2, { type: "text", text: "ignore" }),
      delta(2, { type: "text_delta", text: "B" }),
      delta(9, { type: "text_delta", text: "C" }),
      close(9),
      close(2),
      end(),
      stop,
    ];
    res.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({
    apiKey: "loopback",
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  let visible = "";
  const resets: string[] = [];
  const result = await provider.complete(
    request({
      onText: (text) => {
        visible += text;
      },
      onTextReset: (text) => {
        visible = text;
        resets.push(text);
      },
    }),
  );
  assert.equal(visible, "ACB");
  assert.deepEqual(resets, ["ACB"]);
  assert.equal(result.partial, undefined);
});
