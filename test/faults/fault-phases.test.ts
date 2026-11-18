import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { AnthropicProvider } from "../../src/provider.js";
import { runCli, type CliRun } from "../helpers/cli-harness.js";
import { ManualClock } from "../helpers/manual-clock.js";
import {
  startMockProvider,
  type ContentBlock,
} from "../helpers/mock-provider.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

// STRATEGY section 6 phases at the provider and tool boundaries that the
// existing suites do not cover. Already covered elsewhere:
// - connection loss before headers and header deadlines: test/contract/provider.test.ts,
//   test/faults/provider-deadline.test.ts (in-process provider)
// - accepted-stream truncation, stalls, malformed records and partial retention:
//   test/faults/stream-recovery.test.ts, test/contract/sse-framing.test.ts (in-process)
// - retry-after parsing and the 60 s refusal: test/faults/retry.test.ts,
//   test/contract/provider.test.ts
// - write temp-file cleanup on a failed commit: test/contract/write-size.test.ts
// These tests add each phase at the real CLI boundary, where INV-13 is the
// observable claim: a failed or partial run never ends as a plain success.

const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
});

function envelope(run: CliRun) {
  return resultSchema.parse(JSON.parse(run.stdout.trim()));
}

/** INV-13: a failure ends non-zero with an error envelope. */
function assertFailed(run: CliRun) {
  assert.equal(run.timedOut, false);
  assert.equal(run.exitCode, 1, run.stderr);
  assert.equal(envelope(run).is_error, true);
}

const JSON_ARGS = ["--output-format", "json"];
const NO_RECOVERY = ["--max-retries", "0", "--no-nonstream-fallback"];

const bashMarker: ContentBlock = {
  type: "tool_use",
  id: "toolu_marker",
  name: "Bash",
  input: { command: "echo run >> marker.txt" },
};

function markerRuns(run: CliRun): number {
  const file = join(run.cwd, "marker.txt");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("run\n").length - 1
    : 0;
}

test("INV-13 before dispatch: a refused connection ends as an error without output", async () => {
  const closed = createTcpServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const address = closed.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const run = await runCli({
    args: ["-p", "hi", ...JSON_ARGS, ...NO_RECOVERY],
    provider: { url: `http://127.0.0.1:${address.port}` },
  });
  assertFailed(run);
  // A failed model request ends as the original's API-error reply.
  assert.equal(envelope(run).subtype, "success");
  assert.equal(envelope(run).api_error_status, null);
});

test("INV-13 during streaming: a drop before any completed block ends as an error", async () => {
  // turnEvents for one text block: message_start, block start, block stop, ...
  for (const events of [0, 1, 2]) {
    const provider = await startMockProvider([
      { kind: "drop", events },
      { kind: "drop", events },
    ]);
    const run = await runCli({
      args: ["-p", "hi", ...JSON_ARGS, ...NO_RECOVERY],
      provider,
    });
    assertFailed(run);
    assert.equal(provider.unexpected, 0, `drop after ${events} events`);
  }
});

test("INV-13 during streaming: a drop after a completed block exits 0 with the kept text and a warning", async () => {
  // Two text blocks; the cut follows the second block's text, which tau
  // prints only after it has read the first block's stop.
  let sawSecondBlock!: () => void;
  const cutAfter = new Promise<void>((resolve) => {
    sawSecondBlock = resolve;
  });
  const provider = await startMockProvider([
    {
      kind: "drop",
      events: 4,
      content: [
        { type: "text", text: "kept" },
        { type: "text", text: "discarded" },
      ],
      cutAfter,
    },
  ]);
  let stdout = "";
  const run = await runCli({
    args: [
      "-p",
      "hi",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...NO_RECOVERY,
    ],
    provider,
    onSpawn: (child) => {
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("discarded")) sawSecondBlock();
      });
    },
  });
  // docs/stream-recovery-contract.md: closed blocks survive a transport
  // failure, the open block is discarded, and the run warns it is incomplete.
  assert.equal(run.exitCode, 0, run.stderr);
  const result = resultSchema.parse(
    JSON.parse(run.stdout.trim().split("\n").at(-1) ?? ""),
  );
  assert.equal(result.is_error, false);
  assert.equal(result.result, "kept");
  assert.match(run.stderr, /Response interrupted/);
});

test("INV-13 during streaming: malformed event JSON ends as an error", async () => {
  const start = fixtureSse([
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  ]);
  let requests = 0;
  const server = createHttpServer((request, response: ServerResponse) => {
    requests++;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `${start}event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const run = await runCli({
    args: ["-p", "hi", ...JSON_ARGS, ...NO_RECOVERY],
    provider: { url: `http://127.0.0.1:${address.port}` },
  });
  assertFailed(run);
  assert.equal(requests, 1);
});

test("INV-07 after a tool ran, a dropped next request is retried without running the tool again", async () => {
  const provider = await startMockProvider([
    { kind: "turn", content: [bashMarker], stopReason: "tool_use" },
    { kind: "drop", events: 0 },
    {
      kind: "turn",
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    },
  ]);
  const run = await runCli({
    args: [
      "-p",
      "hi",
      ...JSON_ARGS,
      "--max-retries",
      "1",
      "--allowed-tools",
      "Bash",
    ],
    provider,
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(envelope(run).result, "done");
  assert.equal(markerRuns(run), 1);
  assert.equal(provider.requests.length, 3);
  // The retry resends the same history, with the one tool result.
  assert.deepEqual(provider.requests[2]?.body, provider.requests[1]?.body);
});

test("INV-07 INV-13 after a tool ran, an unrecoverable next request fails without running the tool again", async () => {
  const provider = await startMockProvider([
    { kind: "turn", content: [bashMarker], stopReason: "tool_use" },
    { kind: "drop", events: 0 },
    { kind: "drop", events: 0 },
    { kind: "drop", events: 0 },
  ]);
  const run = await runCli({
    args: [
      "-p",
      "hi",
      ...JSON_ARGS,
      "--max-retries",
      "1",
      "--allowed-tools",
      "Bash",
    ],
    provider,
  });
  assertFailed(run);
  assert.equal(markerRuns(run), 1);
  assert.equal(provider.unexpected, 0);
});

// KNOWN-GAP: a later model turn that repeats an executed tool_use id runs
// the tool again. MessageStream rejects duplicate ids only within one stream
// (src/message-stream.ts toolIds) and the agent loop in src/agent.ts executes
// every call of each turn without checking ids already executed in the run.
// A dropped stream whose closed tool call is kept and then re-sent by the
// retry reaches the same path.
test.failing(
  "KNOWN-GAP INV-07 a tool_use id repeated by a later turn does not run the tool again",
  async () => {
    const provider = await startMockProvider([
      { kind: "turn", content: [bashMarker], stopReason: "tool_use" },
      { kind: "turn", content: [bashMarker], stopReason: "tool_use" },
      {
        kind: "turn",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      },
    ]);
    const run = await runCli({
      args: ["-p", "hi", ...JSON_ARGS, "--allowed-tools", "Bash"],
      provider,
    });
    assert.equal(markerRuns(run), 1);
  },
);

async function retryServer(retryAfter: string) {
  const arrivals: number[] = [];
  const server = createHttpServer((request, response) => {
    arrivals.push(performance.now());
    request.resume();
    if (arrivals.length === 1) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": retryAfter,
      });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "slow" },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      fixtureSse([
        {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "ok" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { arrivals, url: `http://127.0.0.1:${address.port}` };
}

const completion = (signal: AbortSignal) => ({
  model: "fixture",
  system: "",
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
  ],
  tools: [],
  maxTokens: 10,
  signal,
  onText: () => {},
});

test("retry-after: a 429 is retried no earlier than the server asked", async () => {
  const server = await retryServer("1");
  const provider = new AnthropicProvider({
    apiKey: "fixture",
    baseUrl: server.url,
    maxRetries: 1,
  });
  const result = await provider.complete(
    completion(new AbortController().signal),
  );
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  const [first = 0, second = 0] = server.arrivals;
  assert.equal(server.arrivals.length, 2);
  assert.ok(second - first >= 1000, `retried after ${second - first} ms`);
});

// KNOWN-GAP: the retry wait in src/provider.ts (await wait(delay, ...) from
// node:timers/promises, after retryDelay) uses real timers and Math.random
// instead of the injected Clock, so STRATEGY section 6's fake-clock retry
// tests cannot run without real waiting.
test.failing(
  "KNOWN-GAP retry-after waits on the injected clock, so advancing a manual clock releases the retry",
  async () => {
    const server = await retryServer("30");
    const clock = new ManualClock();
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    const provider = new AnthropicProvider({
      apiKey: "fixture",
      baseUrl: server.url,
      maxRetries: 1,
      clock,
    });
    const pending = provider
      .complete(completion(controller.signal))
      .catch(() => undefined);
    for (let tick = 0; tick < 2000 && server.arrivals.length === 0; tick++)
      await pause(1);
    assert.equal(server.arrivals.length, 1);
    clock.advance(40_000);
    for (let tick = 0; tick < 50 && server.arrivals.length < 2; tick++)
      await pause(10);
    assert.equal(
      server.arrivals.length,
      2,
      "the retry still waits on real time",
    );
    await pending;
  },
);

test("INV-13 during cleanup: a session save failure after a finished turn ends as an error", async () => {
  // The tool makes the session directory read-only, so the final save fails.
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: [
        {
          type: "tool_use",
          id: "toolu_lock",
          name: "Bash",
          input: { command: "chmod -R a-w ../state/sessions" },
        },
      ],
      stopReason: "tool_use",
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    },
  ]);
  const run = await runCli({
    args: ["-p", "hi", ...JSON_ARGS, "--allowed-tools", "Bash"],
    provider,
  });
  execFileSync("chmod", ["-R", "u+w", join(run.root, "state")]);
  assertFailed(run);
  assert.equal(provider.requests.length, 2);
});
