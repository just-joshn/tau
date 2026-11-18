import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import type {
  AgentEvent,
  Completion,
  CompletionRequest,
  Message,
  Provider,
  ToolExecutor,
  ToolUse,
} from "../src/types.js";

const first: ToolUse = {
  type: "tool_use",
  id: "one",
  name: "read",
  input: { path: "a.ts" },
};
const second: ToolUse = {
  type: "tool_use",
  id: "two",
  name: "read",
  input: { path: "b.ts" },
};

function completion(
  content: Completion["content"],
  stop_reason = "end_turn",
): Completion {
  return {
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

class FakeProvider implements Provider {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly completions: Completion[]) {}
  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
    });
    const next = this.completions.shift();
    assert.ok(next, "unexpected provider request");
    for (const block of next.content)
      if (block.type === "text") request.onText(block.text);
    return next;
  }
}

function fixture(completions: Completion[]) {
  const provider = new FakeProvider(completions);
  const events: AgentEvent[] = [];
  const calls: string[] = [];
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Help" }] },
  ];
  const tools: ToolExecutor = {
    definitions: [
      {
        name: "read",
        description: "Read file",
        input_schema: { type: "object" },
      },
    ],
    async execute(call) {
      calls.push(call.id);
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: `result ${call.id}`,
      };
    },
  };
  const options: Parameters<typeof runAgent>[0] = {
    provider,
    tools,
    messages,
    model: "test",
    system: "System",
    maxTokens: 200,
    maxTurns: 3,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  };
  return { provider, events, calls, messages, tools, options };
}

function assertPairedHistory(messages: Message[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    const ids = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => block.id);
    if (!ids.length) continue;
    const next = messages[index + 1];
    assert.equal(next?.role, "user");
    assert.deepEqual(
      next?.content.map((block) =>
        block.type === "tool_result" ? block.tool_use_id : "unexpected",
      ),
      ids,
    );
  }
}

test("returns completed text, forwards options, emits events and mutates the supplied messages", async () => {
  const f = fixture([completion([{ type: "text", text: "Hello" }])]);
  const result = await runAgent(f.options);
  assert.equal(result.messages, f.messages);
  assert.equal(result.turns, 1);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
  assert.deepEqual(
    f.events.map((event) => event.type),
    ["text", "usage", "assistant"],
  );
  assert.equal(f.messages.length, 2);
  const req = f.provider.requests[0];
  assert.ok(req);
  assert.equal(req.signal, f.options.signal);
  assert.equal(req.maxTokens, 200);
  assert.equal(req.model, "test");
  assert.equal(req.system, "System");
  assert.equal(req.tools, f.tools.definitions);
});

test("executes tools sequentially and batches results in one user message before the next turn", async () => {
  const f = fixture([
    completion([{ type: "text", text: "Reading" }, first, second], "tool_use"),
    completion([{ type: "text", text: "Done" }]),
  ]);
  let executing = false;
  f.tools.execute = async (call) => {
    assert.equal(
      executing,
      false,
      "permission/execution requests must not overlap",
    );
    executing = true;
    f.calls.push(call.id);
    await Promise.resolve();
    executing = false;
    return { type: "tool_result", tool_use_id: call.id, content: call.id };
  };
  const result = await runAgent(f.options);
  assert.equal(result.turns, 2);
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 4 });
  assert.deepEqual(f.calls, ["one", "two"]);
  assert.deepEqual(
    f.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(f.messages[2]?.content.length, 2);
  assert.equal(f.provider.requests[1]?.messages.length, 3);
  assert.deepEqual(
    f.events.map((event) => event.type),
    [
      "text",
      "usage",
      "assistant",
      "tool_start",
      "tool_result",
      "tool_start",
      "tool_result",
      "text",
      "usage",
      "assistant",
    ],
  );
  assertPairedHistory(f.messages);
});

test("tool exceptions become error results and allow the model to recover", async () => {
  const f = fixture([
    completion([first], "tool_use"),
    completion([{ type: "text", text: "Could not read" }]),
  ]);
  f.tools.execute = async () => {
    throw new Error("execution error");
  };
  await runAgent(f.options);
  assert.deepEqual(f.messages[2]?.content, [
    {
      type: "tool_result",
      tool_use_id: "one",
      content: "Tool execution failed",
      is_error: true,
    },
  ]);
  assertPairedHistory(f.messages);
});

test("cancellation during a tool preserves finished results and closes pending tool calls", async () => {
  const f = fixture([completion([first, second], "tool_use")]);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.tools.execute = async (call) => {
    if (call.id === "two") {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }
    return { type: "tool_result", tool_use_id: call.id, content: "finished" };
  };
  await assert.rejects(runAgent(f.options), { name: "AbortError" });
  assertPairedHistory(f.messages);
  assert.deepEqual(f.messages[2]?.content[0], {
    type: "tool_result",
    tool_use_id: "one",
    content: "finished",
  });
  assert.equal(f.messages[2]?.content[1]?.type, "tool_result");
  assert.deepEqual(f.messages[2]?.content[1], {
    type: "tool_result",
    tool_use_id: "two",
    content: "Tool execution interrupted before completion",
    is_error: true,
  });
  assert.equal(f.provider.requests.length, 1);
});

test("cancellation between tools never starts a later permission request", async () => {
  const f = fixture([completion([first, second], "tool_use")]);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.onEvent = (event) => {
    if (event.type === "tool_result") controller.abort();
  };
  await assert.rejects(runAgent(f.options), { name: "AbortError" });
  assert.deepEqual(f.calls, ["one"]);
  assertPairedHistory(f.messages);
});

test("abort in tool_start prevents execution and leaves replayable history", async () => {
  const f = fixture([completion([first, second], "tool_use")]);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.onEvent = (event) => {
    if (event.type === "tool_start") controller.abort();
  };
  await assert.rejects(runAgent(f.options), { name: "AbortError" });
  assert.deepEqual(f.calls, []);
  assertPairedHistory(f.messages);
});

test("callback errors cannot leave dangling tool calls", async () => {
  const f = fixture([completion([first, second], "tool_use")]);
  f.options.onEvent = () => {
    throw new Error("display failed");
  };
  await assert.rejects(runAgent(f.options), /display failed/);
  assertPairedHistory(f.messages);
});

test("a partial provider failure leaves history unchanged", async () => {
  const f = fixture([]);
  const before = structuredClone(f.messages);
  f.options.provider = {
    async complete(req) {
      req.onText("partial");
      throw new Error("truncated stream");
    },
  };
  await assert.rejects(runAgent(f.options), /truncated/);
  assert.deepEqual(f.messages, before);
  assert.deepEqual(f.events, [{ type: "text", text: "partial" }]);
});

test("pre-aborted and aborted completions do not mutate history", async () => {
  const f = fixture([completion([{ type: "text", text: "Done" }])]);
  f.options.signal = AbortSignal.abort();
  await assert.rejects(runAgent(f.options), { name: "AbortError" });
  assert.equal(f.provider.requests.length, 0);
  assert.equal(f.messages.length, 1);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.provider = {
    async complete() {
      controller.abort();
      return completion([first], "tool_use");
    },
  };
  await assert.rejects(runAgent(f.options), { name: "AbortError" });
  assert.equal(f.messages.length, 1);
});

test("max_tokens with a closed tool executes it once and continues with its result", async () => {
  const f = fixture([
    completion([{ type: "text", text: "Incomplete" }, first], "max_tokens"),
    completion([{ type: "text", text: "Done" }]),
  ]);
  await runAgent(f.options);
  assert.equal(f.messages[1]?.content[0]?.type, "text");
  assert.deepEqual(f.calls, ["one"]);
  assertPairedHistory(f.messages);
});

test("maxTurns reports exhaustion only after preserving tool results", async () => {
  const f = fixture([completion([first], "tool_use")]);
  f.options.maxTurns = 1;
  await assert.rejects(runAgent(f.options), /maxTurns/);
  assert.deepEqual(
    f.events.filter((event) => event.type === "usage"),
    [{ type: "usage", usage: { input_tokens: 10, output_tokens: 2 } }],
  );
  assert.deepEqual(f.calls, ["one"]);
  assertPairedHistory(f.messages);
});

test("a final answer on the last allowed turn succeeds", async () => {
  const f = fixture([
    completion([{ type: "text", text: "Done" }], "stop_sequence"),
  ]);
  f.options.maxTurns = 1;
  assert.equal((await runAgent(f.options)).turns, 1);
});

test("invalid limits fail before calling the provider", async () => {
  for (const limit of [0, -1, 0.5, Infinity]) {
    const f = fixture([]);
    await assert.rejects(
      runAgent({ ...f.options, maxTurns: limit }),
      /positive integer/,
    );
    await assert.rejects(
      runAgent({ ...f.options, maxTokens: limit }),
      /positive integer/,
    );
    assert.equal(f.provider.requests.length, 0);
  }
});

test("unsupported stop reasons cannot silently succeed or execute tools", async () => {
  for (const reason of ["refusal", "unknown", "end_turn"]) {
    const f = fixture([completion([first], reason)]);
    await assert.rejects(runAgent(f.options), /unsupported stop reason/);
    assert.deepEqual(f.calls, []);
    assertPairedHistory(f.messages);
  }
});

test("a terminal model refusal is retained as an answer without tool execution", async () => {
  const f = fixture([
    completion(
      [{ type: "text", text: "I cannot help with that request." }],
      "refusal",
    ),
  ]);
  const result = await runAgent(f.options);
  assert.equal(result.turns, 1);
  assert.equal(f.messages.at(-1)?.role, "assistant");
  assert.deepEqual(f.calls, []);
});

test("tool_use without calls fails explicitly", async () => {
  const f = fixture([completion([], "tool_use")]);
  await assert.rejects(runAgent(f.options), /without a tool call/);
});

test("mismatched tool IDs are rejected without corrupting history", async () => {
  const f = fixture([completion([first], "tool_use")]);
  f.tools.execute = async () => ({
    type: "tool_result",
    tool_use_id: "wrong",
    content: "wrong",
  });
  await assert.rejects(runAgent(f.options), /mismatched/);
  assertPairedHistory(f.messages);
});
