import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import {
  AnthropicProvider,
  QUERY_EFFORT_BETA,
  type ProviderQueryEffortPolicy,
} from "../src/provider.js";
import {
  firstPartyQueryEffortFacts,
  type QueryEffortCapabilities,
} from "../src/query-model-effort.js";
import type { CompletionRequest } from "../src/types.js";
import { fixtureSse } from "./sse-fixture.js";
import { ApiAttemptBudget } from "../src/attempt-ledger.js";

const bodySchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  queryEffort: z.unknown().optional(),
  thinking: z.object({ type: z.string() }).optional(),
  output_config: z.looseObject({ effort: z.string().optional() }).optional(),
});
type Body = z.infer<typeof bodySchema>;

const all: QueryEffortCapabilities = {
  supported: true,
  max: true,
  xhigh: true,
};
const policy = (): ProviderQueryEffortPolicy => ({
  capabilities: (model) => firstPartyQueryEffortFacts(model)?.capabilities,
  selection: (request) => ({
    environment: "",
    defaults: firstPartyQueryEffortFacts(request.model)?.defaults ?? {
      catalog: "high",
    },
  }),
});
function request(extra: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: "claude-sonnet-4-6",
    system: "owned",
    messages: [{ role: "user", content: [{ type: "text", text: "owned" }] }],
    tools: [],
    maxTokens: 2048,
    signal: new AbortController().signal,
    onText() {},
    ...extra,
  };
}
function success(res: ServerResponse, stream = true, index = 0) {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "message",
        role: "assistant",
        id: `owned-${index}`,
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    fixtureSse([
      {
        type: "message_start",
        message: {
          id: `owned-${index}`,
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
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
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
}
const fail = (message: string): never => {
  throw new Error(message);
};
async function fixture(
  handler?: (body: Body, res: ServerResponse, count: number) => void,
) {
  const seen: Array<{ body: Body; beta: string; path: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = bodySchema.parse(JSON.parse(raw));
    seen.push({
      body,
      beta: String(req.headers["anthropic-beta"] ?? ""),
      path: req.url ?? "",
    });
    if (handler) handler(body, res, seen.length);
    else success(res, body.stream !== false, seen.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const make = (
    extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
  ) =>
    new AnthropicProvider({
      apiKey: "loopback-owned",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
      thinkingResumption: false,
      allowNonStreamingFallback: false,
      ...extra,
    });
  const row = (index: number) =>
    seen.at(index) ?? fail(`Owned request missing: ${String(index)}`);
  return { seen, row, make };
}

test("effort is opt-in through explicit capability policy; default requests keep their existing shape", async () => {
  const f = await fixture();
  await f.make().complete(request());
  assert.equal(f.row(0).body.output_config, undefined);
  assert.equal(f.row(0).beta.includes(QUERY_EFFORT_BETA), false);
  await assert.rejects(
    f.make().complete(request({ queryEffort: "low" })),
    /capability policy/,
  );
  assert.equal(f.seen.length, 1);
  const provider = f.make({ queryEffortPolicy: policy() });
  await provider.complete(request({ queryEffort: "low" }));
  assert.deepEqual(f.row(1).body.output_config, { effort: "low" });
  assert.equal(f.row(1).body.queryEffort, undefined);
  assert.ok(f.row(1).beta.includes(QUERY_EFFORT_BETA));
});

test("known first-party fallback facts use effort capability gates rather than thinking flags", async () => {
  const f = await fixture(),
    provider = f.make({ queryEffortPolicy: policy() });
  await provider.complete(
    request({ model: "claude-opus-4-5", queryEffort: "max" }),
  );
  assert.deepEqual(f.row(0).body.output_config, { effort: "high" });
  await provider.complete(
    request({ model: "claude-sonnet-4-6", queryEffort: "xhigh" }),
  );
  assert.deepEqual(f.row(1).body.output_config, { effort: "high" });
  await provider.complete(
    request({ model: "claude-haiku-4-5", queryEffort: "low" }),
  );
  assert.equal(f.row(2).body.output_config, undefined);
  assert.equal(f.row(2).beta.includes(QUERY_EFFORT_BETA), false);
  await provider.complete(request({ model: "claude-opus-5-5" }));
  assert.deepEqual(f.row(3).body.output_config, { effort: "medium" });
  assert.equal(firstPartyQueryEffortFacts("sonnet"), undefined);
  assert.equal(firstPartyQueryEffortFacts("unlisted-custom"), undefined);
});

test("provider resolves explicit query effort against host environment, hook, settings and server caps", async () => {
  const f = await fixture();
  let environment = "max",
    hook: "low" | undefined,
    settingsCap: "medium" | undefined;
  const selected: ProviderQueryEffortPolicy = {
    capabilities: () => all,
    selection: () => ({
      environment,
      defaults: { catalog: "high" },
      ...(hook ? { hookEffort: hook } : {}),
      ...(settingsCap ? { settingsCap } : {}),
    }),
  };
  const provider = f.make({ queryEffortPolicy: selected });
  await provider.complete(request({ queryEffort: "low" }));
  assert.equal(f.row(-1).body.output_config?.effort, "max");
  hook = "low";
  await provider.complete(request({ queryEffort: "high" }));
  assert.equal(f.row(-1).body.output_config?.effort, "low");
  hook = undefined;
  settingsCap = "medium";
  await provider.complete(request({ queryEffort: "high" }));
  assert.equal(f.row(-1).body.output_config?.effort, "medium");
  environment = "auto";
  settingsCap = undefined;
  await provider.complete(request({ queryEffort: "high" }));
  assert.equal(f.row(-1).body.output_config, undefined);
  assert.ok(f.row(-1).beta.includes(QUERY_EFFORT_BETA));
  environment = "";
  await provider.complete(request({ queryEffort: 17 }));
  assert.equal(f.row(-1).body.output_config, undefined);
  assert.equal(f.row(-1).beta.includes(QUERY_EFFORT_BETA), false);
});

test("existing output config wins insertion, unsupported models remove effort and disabled thinking clamps named levels", async () => {
  const f = await fixture();
  const existing = { effort: "max", format: { type: "json_schema" } },
    configured = { ...policy(), outputConfig: () => existing };
  await f
    .make({ queryEffortPolicy: configured })
    .complete(request({ queryEffort: "low" }));
  assert.deepEqual(f.row(0).body.output_config, existing);
  assert.equal(f.row(0).beta.includes(QUERY_EFFORT_BETA), false);
  await f
    .make({ queryEffortPolicy: configured })
    .complete(request({ model: "claude-haiku-4-5", queryEffort: "low" }));
  assert.deepEqual(f.row(1).body.output_config, { format: existing.format });
  await f.make({ queryEffortPolicy: policy() }).complete(
    request({
      model: "claude-opus-4-7",
      queryEffort: "max",
      thinking: { mode: "disabled", mechanical: true },
    }),
  );
  assert.equal(f.row(2).body.thinking?.type, "disabled");
  assert.equal(f.row(2).body.output_config?.effort, "high");
  await f.make({ queryEffortPolicy: policy() }).complete(
    request({
      model: "claude-opus-5",
      queryEffort: "max",
      thinking: { mode: "disabled" },
    }),
  );
  assert.equal(f.row(3).body.output_config?.effort, "high");
  assert.equal(existing.effort, "max");
});

test("effort projection survives a nonstream fallback and ordinary HTTP retry", async () => {
  const f = await fixture((body, res, count) => {
    if (count === 1) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "stream endpoint unavailable" } }),
      );
    } else if (count === 2) {
      res.writeHead(500, {
        "content-type": "application/json",
        "retry-after-ms": "1",
      });
      res.end(JSON.stringify({ error: { type: "api_error" } }));
    } else success(res, false, count);
  });
  await f
    .make({
      queryEffortPolicy: policy(),
      allowNonStreamingFallback: true,
      maxRetries: 2,
    })
    .complete(request({ queryEffort: "low" }));
  assert.deepEqual(
    f.seen.map((row) => row.body.stream),
    [true, false, false],
  );
  assert.deepEqual(
    f.seen.map((row) => row.body.output_config?.effort),
    ["low", "low", "low"],
  );
  assert.ok(f.seen.every((row) => row.beta.includes(QUERY_EFFORT_BETA)));
});

test("effort unsupported response retries once without field/beta and latches that model for this process", async () => {
  const f = await fixture((_body, res, count) => {
    if (count === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "This model does not support the effort parameter",
          },
        }),
      );
    } else success(res, true, count);
  });
  const configured: ProviderQueryEffortPolicy = {
    capabilities: () => all,
    selection: () => ({ environment: "" }),
  };
  const input = request({ model: "effort-refusal-owned", queryEffort: "high" });
  await f.make({ queryEffortPolicy: configured }).complete(input);
  await f
    .make({ queryEffortPolicy: configured })
    .complete({ ...input, queryEffort: "max" });
  assert.equal(f.row(0).body.output_config?.effort, "high");
  assert.ok(f.row(0).beta.includes(QUERY_EFFORT_BETA));
  for (const row of f.seen.slice(1)) {
    assert.equal(row.body.output_config, undefined);
    assert.equal(row.beta.includes(QUERY_EFFORT_BETA), false);
  }
  await f
    .make({ queryEffortPolicy: configured })
    .complete({ ...input, model: "effort-other-owned", queryEffort: "low" });
  assert.equal(f.row(-1).body.output_config?.effort, "low");
});

test("effort repair obeys shared API attempt budget and cannot spin on unsupported errors", async () => {
  const f = await fixture((_body, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "This model does not support the effort parameter" },
      }),
    );
  });
  const configured: ProviderQueryEffortPolicy = {
    capabilities: () => all,
    selection: () => ({ environment: "" }),
  };
  await assert.rejects(
    f.make({ queryEffortPolicy: configured }).complete(
      request({
        model: "effort-attempt-budget-owned",
        queryEffort: "high",
        attemptBudget: new ApiAttemptBudget(1),
      }),
    ),
    /API attempt budget exhausted/,
  );
  assert.equal(f.seen.length, 1);
  await assert.rejects(
    f
      .make({ queryEffortPolicy: configured })
      .complete(
        request({ model: "effort-repeated-error-owned", queryEffort: "high" }),
      ),
    /HTTP error 400/,
  );
  assert.equal(f.seen.length, 3);
});

test("fallback capability resolution uses the actual request model, and count requests remain independent", async () => {
  const f = await fixture((body, res, count) => {
    if (body.stream === undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 7 }));
    } else success(res, true, count);
  });
  const models: string[] = [],
    configured = policy();
  const provider = f.make({
    fallbackModel: "claude-opus-4-5",
    modelAvailable: (model) => model !== "claude-sonnet-4-6",
    queryEffortPolicy: {
      ...configured,
      capabilities: (model) => {
        models.push(model);
        return configured.capabilities(model);
      },
    },
  });
  await provider.complete(request({ queryEffort: "max" }));
  assert.deepEqual(models, ["claude-opus-4-5"]);
  assert.equal(f.row(0).body.output_config?.effort, "high");
  assert.equal(f.row(0).body.model, "claude-opus-4-5-20251101");
  assert.equal(
    await provider.countFileTokens({
      model: "claude-opus-4-5",
      text: "owned",
      signal: new AbortController().signal,
    }),
    7,
  );
  assert.equal(f.row(1).body.output_config, undefined);
  assert.equal(f.row(1).beta.includes(QUERY_EFFORT_BETA), false);
  assert.equal(models.length, 1);
});
