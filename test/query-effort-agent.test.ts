import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "../src/agent.js";
import type { QueryEffort } from "../src/query-model-effort.js";
import type {
  CompletionRequest,
  Message,
  Provider,
  ToolExecutor,
} from "../src/types.js";

test("agent samples live query effort after context preparation for each model round without transcript metadata", async () => {
  let current: QueryEffort | undefined,
    round = 0,
    samples = 0,
    prepared = 0;
  const seen: CompletionRequest[] = [],
    messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "owned" }] },
    ];
  const provider: Provider = {
    async complete(request) {
      seen.push(request);
      round++;
      return {
        content:
          round < 3
            ? [
                {
                  type: "tool_use",
                  id: `tool-${round}`,
                  name: "Fixture",
                  input: {},
                },
              ]
            : [{ type: "text", text: "done" }],
        stop_reason: round < 3 ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const tools: ToolExecutor = {
    definitions: [],
    async beforeModelRequest() {
      prepared++;
      if (prepared === 3) current = "high";
    },
    async execute(call) {
      current = "low";
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: "context updated",
      };
    },
  };
  await runAgent({
    provider,
    tools,
    messages,
    model: "fixed-request-model",
    system: "owned",
    maxTokens: 100,
    maxTurns: 4,
    autoCompact: false,
    queryEffort: () => {
      samples++;
      return current;
    },
    signal: new AbortController().signal,
    onEvent() {},
  });
  assert.deepEqual(
    seen.map((request) => request.queryEffort),
    [undefined, "low", "high"],
  );
  assert.equal(Object.hasOwn(seen[0]!, "queryEffort"), false);
  assert.equal(samples, 3);
  assert.ok(seen.every((request) => request.model === "fixed-request-model"));
  assert.equal(JSON.stringify(messages).includes("queryEffort"), false);
});

test("output-limit continuation resamples effort and absent callback leaves provider request shape unchanged", async () => {
  let current: QueryEffort = "medium",
    round = 0;
  const seen: CompletionRequest[] = [];
  const provider: Provider = {
    async complete(request) {
      seen.push(request);
      round++;
      current = "max";
      return {
        content: [{ type: "text", text: round === 1 ? "part" : "done" }],
        stop_reason: round === 1 ? "max_tokens" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const tools: ToolExecutor = {
    definitions: [],
    async execute() {
      throw new Error("unexpected");
    },
  };
  const common = {
    provider,
    tools,
    model: "test",
    system: "owned",
    maxTokens: 100,
    maxTurns: 3,
    autoCompact: false,
    signal: new AbortController().signal,
    onEvent() {},
  };
  await runAgent({
    ...common,
    messages: [{ role: "user", content: [{ type: "text", text: "owned" }] }],
    queryEffort: () => current,
  });
  assert.deepEqual(
    seen.map((request) => request.queryEffort),
    ["medium", "max"],
  );
  await runAgent({
    ...common,
    messages: [{ role: "user", content: [{ type: "text", text: "owned" }] }],
  });
  assert.equal(Object.hasOwn(seen.at(-1)!, "queryEffort"), false);
});
