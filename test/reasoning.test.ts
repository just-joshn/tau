import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { modelFacts } from "../src/model-facts.js";
import {
  defaultOutputTokens,
  resolveModelFacts,
  thinkingRequest,
} from "../src/reasoning.js";
import { parseOptions } from "../src/options.js";
import { AnthropicProvider } from "../src/provider.js";
import { fixtureSse } from "./sse-fixture.js";

test("pinned first-party model facts resolve catalog aliases, dated IDs and output defaults", () => {
  assert.equal(modelFacts("sonnet").canonical, "claude-sonnet-5-5");
  assert.equal(
    modelFacts("claude-sonnet-4-5").wire,
    "claude-sonnet-4-5-20250929",
  );
  assert.equal(
    modelFacts("claude-sonnet-4-5-20250929").canonical,
    "claude-sonnet-4-5",
  );
  assert.equal(defaultOutputTokens("claude-sonnet-4-5", {}), 32000);
  assert.equal(defaultOutputTokens("claude-opus-5-5", {}), 128000);
  assert.equal(defaultOutputTokens("unknown", {}), 32000);
  assert.equal(defaultOutputTokens("claude-3-opus", {}), 4096);
  assert.equal(
    defaultOutputTokens("claude-sonnet-4-5", {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "100000",
    }),
    64000,
  );
  assert.equal(
    defaultOutputTokens("claude-sonnet-4-5", {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "invalid",
    }),
    32000,
  );
});

test("thinking defaults choose old-model budgets, new-model adaptive and unsupported omission", () => {
  assert.deepEqual(thinkingRequest("claude-sonnet-4-5", 8192, {}, {}), {
    type: "enabled",
    budget_tokens: 8191,
  });
  assert.deepEqual(thinkingRequest("claude-opus-5-5", 64000, {}, {}), {
    type: "adaptive",
  });
  assert.equal(thinkingRequest("claude-3-7-sonnet", 8192, {}, {}), undefined);
  assert.deepEqual(thinkingRequest("unknown", 8192, {}, {}), {
    type: "adaptive",
  });
});

test("explicit thinking mode takes precedence over environment and deprecated numeric budget", () => {
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-5",
      8192,
      { mode: "enabled", maxThinkingTokens: 1200 },
      { MAX_THINKING_TOKENS: "0" },
    ),
    { type: "enabled", budget_tokens: 8191 },
  );
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-5",
      8192,
      { mode: "disabled", maxThinkingTokens: 4096 },
      { MAX_THINKING_TOKENS: "4096" },
    ),
    { type: "disabled" },
  );
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-5",
      8192,
      { maxThinkingTokens: 5000 },
      { MAX_THINKING_TOKENS: "2_000" },
    ),
    { type: "enabled", budget_tokens: 2000 },
  );
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-5",
      8192,
      {},
      { MAX_THINKING_TOKENS: "nonsense" },
    ),
    { type: "disabled" },
  );
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-5",
      8192,
      {},
      { MAX_THINKING_TOKENS: "-1" },
    ),
    { type: "disabled" },
  );
});

test("budget floor/output limit, adaptive exception and always-on behavior follow source order", () => {
  assert.deepEqual(
    thinkingRequest("claude-sonnet-4-5", 8192, { maxThinkingTokens: 1 }, {}),
    { type: "enabled", budget_tokens: 1024 },
  );
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-5",
      3000,
      { maxThinkingTokens: 100000 },
      {},
    ),
    { type: "enabled", budget_tokens: 2999 },
  );
  assert.deepEqual(thinkingRequest("claude-sonnet-4-5", 100, {}, {}), {
    type: "enabled",
    budget_tokens: 1024,
  });
  assert.deepEqual(
    thinkingRequest(
      "claude-sonnet-4-6",
      8192,
      {},
      { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "true" },
    ),
    { type: "enabled", budget_tokens: 8191 },
  );
  assert.deepEqual(
    thinkingRequest(
      "claude-opus-5-5",
      8192,
      {},
      { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "true" },
    ),
    { type: "adaptive" },
  );
  assert.deepEqual(
    thinkingRequest("claude-opus-5-5", 8192, { mode: "disabled" }, {}),
    { type: "adaptive" },
  );
  assert.equal(
    thinkingRequest(
      "claude-opus-5-5",
      8192,
      { mode: "disabled", mechanical: true },
      {},
    ),
    undefined,
  );
  assert.equal(
    thinkingRequest(
      "claude-opus-5-5",
      8192,
      {},
      { CLAUDE_CODE_DISABLE_THINKING: "true" },
    ),
    undefined,
  );
});

test("custom model capability declarations control thinking/adaptive support", () => {
  const env = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: "custom",
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "thinking",
  };
  assert.equal(resolveModelFacts("sonnet", env).wire, "custom");
  assert.deepEqual(thinkingRequest("custom", 64000, {}, env), {
    type: "enabled",
    budget_tokens: 31999,
  });
  assert.equal(
    thinkingRequest(
      "custom",
      64000,
      {},
      { ...env, ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "" },
    ),
    undefined,
  );
  assert.deepEqual(
    thinkingRequest(
      "custom",
      64000,
      {},
      {
        ...env,
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
          "thinking, adaptive_thinking",
      },
    ),
    { type: "adaptive" },
  );
});

test("CLI reasoning modes/legacy budget are strict and expose model-specific token defaults", () => {
  assert.equal(parseOptions(["--thinking", "adaptive"]).thinking, "adaptive");
  assert.equal(
    parseOptions(["--max-thinking-tokens", "0"]).maxThinkingTokens,
    0,
  );
  assert.equal(parseOptions(["--model", "claude-opus-5-5"]).maxTokens, 128000);
  assert.equal(parseOptions(["--max-tokens", "1000"]).maxTokensExplicit, true);
  for (const args of [
    ["--thinking", "sometimes"],
    ["--max-thinking-tokens", "-1"],
    ["--max-thinking-tokens", "NaN"],
  ])
    assert.throws(() => parseOptions(args));
});

test("real HTTP requests recompute model ID, output limit and reasoning after model fallback", async (t) => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const begin = {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    };
    res.end(
      fixtureSse(
        bodies.length === 1
          ? [
              begin,
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "thinking",
                  thinking: "",
                  signature: "",
                },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "error",
                error: { type: "api_error", message: "unavailable" },
              },
            ]
          : [
              begin,
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "answer" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new AnthropicProvider({
    apiKey: "loopback",
    baseUrl: `http://127.0.0.1:${address.port}`,
    fallbackModel: "claude-opus-5-5",
    maxRetries: 0,
  });
  await provider.complete({
    model: "claude-sonnet-4-5",
    system: "",
    messages: [],
    tools: [],
    maxTokens: 32000,
    useModelTokenDefaults: true,
    signal: t.signal,
    onText: () => {},
  });
  assert.deepEqual(
    bodies.map((body) => [body.model, body.max_tokens, body.thinking]),
    [
      [
        "claude-sonnet-4-5-20250929",
        32000,
        { type: "enabled", budget_tokens: 31999 },
      ],
      ["claude-opus-5-5", 128000, { type: "adaptive" }],
    ],
  );
});
