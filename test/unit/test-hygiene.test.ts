import assert from "node:assert/strict";
import { mock, onTestFinished, spyOn, test } from "bun:test";
import { z } from "zod";
import { LONG_CONTEXT_BETA } from "../../src/context-window.js";
import { AnthropicProvider, QUERY_EFFORT_BETA } from "../../src/provider.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

const clock = { now: () => "real" };
const callback = mock(() => "called");
const home = process.env.TAU_HOME;
const config = process.env.CLAUDE_CONFIG_DIR;

// Both tests check for pristine state and then leak every kind of change, so
// whichever runs second proves the first one's changes were undone, in any order.
function assertPristineThenLeak() {
  assert.equal(clock.now(), "real");
  assert.equal(callback.mock.calls.length, 0);
  assert.equal(process.env.TAU_HYGIENE_PROBE, undefined);
  assert.equal(process.env.TAU_HOME, home);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, config);

  spyOn(clock, "now").mockReturnValue("patched");
  callback();
  process.env.TAU_HYGIENE_PROBE = "added";
  process.env.TAU_HOME = "changed";
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(clock.now(), "patched");
}

test(
  "a spy, a mock call and env edits made in one test",
  assertPristineThenLeak,
);
test("are gone by the next test", assertPristineThenLeak);

// The provider's beta refusal latches last for the process, so each test must
// start from a fresh process's latches whatever ran before it.
const tagged = "claude-sonnet-4-5[1m]";
const refusals = [
  "This model does not support the effort parameter",
  "Unsupported anthropic-beta: thinking-resumption-2026-07-17",
  `Unsupported ${LONG_CONTEXT_BETA}`,
];
async function assertFreshLatchesThenLatch() {
  const seen: Array<{ beta: string; effort: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = z
        .looseObject({ output_config: z.looseObject({}).optional() })
        .parse(await req.json());
      seen.push({
        beta: req.headers.get("anthropic-beta") ?? "",
        effort: body.output_config?.effort,
      });
      const message = refusals[seen.length - 1];
      if (message !== undefined)
        return Response.json({ error: { message } }, { status: 400 });
      return new Response(
        fixtureSse([
          {
            type: "message_start",
            message: {
              role: "assistant",
              model: tagged,
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  onTestFinished(() => server.stop(true));
  const options = {
    apiKey: "loopback",
    baseUrl: server.url.href,
    maxRetries: 0,
    thinkingResumption: true,
    queryEffortPolicy: {
      capabilities: () => ({ supported: true, max: true, xhigh: true }),
      selection: () => ({ environment: "" }),
    },
  };
  await new AnthropicProvider(options).complete({
    model: tagged,
    system: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 4000,
    queryEffort: "high",
    signal: AbortSignal.timeout(30_000),
    onText: () => {},
  });

  const [first, last] = [seen[0], seen.at(-1)];
  for (const beta of [
    "thinking-resumption-2026-07-17",
    LONG_CONTEXT_BETA,
    QUERY_EFFORT_BETA,
  ])
    assert.ok(first?.beta.includes(beta), beta);
  assert.equal(first?.effort, "high");

  const next = new AnthropicProvider(options);
  assert.equal(next.thinkingResumption, false);
  assert.equal(next.contextWindowTokens(tagged), 200000);
  assert.equal(last?.effort, undefined);
}

test("beta refusals latched in one test", assertFreshLatchesThenLatch);
test("are unlatched by the next test", assertFreshLatchesThenLatch);
