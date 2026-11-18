import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, onTestFinished } from "bun:test";
import {
  ModelContextRoom,
  readAllowance,
  type ReadToolContext,
} from "../../src/context-room.js";
import { modelBytesPerToken } from "../../src/reasoning.js";
import { createTools } from "../../src/tools.js";
import { ReadState } from "../../src/read-state.js";
import { runAgent } from "../../src/agent.js";
import type {
  Completion,
  Message,
  Provider,
  ToolExecutor,
  ToolUse,
} from "../../src/types.js";

const model = "claude-sonnet-4-5-20250929";
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const readCall = (id: string, file = "a"): ToolUse => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: file, allow_large: true },
});
const reply = (calls: ToolUse[] = [], input = 1000): Completion => ({
  content: calls.length ? calls : [{ type: "text", text: "done" }],
  stop_reason: calls.length ? "tool_use" : "end_turn",
  model,
  usage: { input_tokens: input, output_tokens: 0 },
});
function testSignal(): AbortSignal {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  return controller.signal;
}
async function fixture(tokens = 1000) {
  const cwd = await realpath(
    await mkdtemp(path.join(tmpdir(), "tau-large-read-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const defaultSignal = testSignal();
  const state = new ReadState(),
    tools = createTools({
      cwd,
      readState: state,
      fileReadMaxTokens: tokens,
      mode: "bypassPermissions",
      approve: async () => true,
    });
  const file = path.join(cwd, "a"),
    read = (input = {}, signal = defaultSignal) =>
      tools.execute(
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: "a", ...input },
        },
        signal,
      );
  const setReadContext = (context: ReadToolContext | undefined) => {
    assert.ok("setReadContext" in tools);
    tools.setReadContext?.(context);
  };
  return { cwd, file, tools, state, read, setReadContext };
}
function context(
  threshold = 20000,
  held = 1000,
): ReadToolContext & { room: ModelContextRoom } {
  return {
    room: new ModelContextRoom(
      () => threshold,
      threshold + 13000,
      () => held,
    ),
    bytesPerToken: 4,
  };
}

test("allocation uses maximum parent/held usage plus shared claims, then floor70%", () => {
  const ctx = context(20000, 2000);
  ctx.parentUsage = {
    input_tokens: 3000,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 2000,
    output_tokens: 100,
  };
  ctx.room.claim(500);
  assert.deepEqual(readAllowance(ctx, 1000, 262144), {
    roomTokens: 9380,
    raised: { maxTokens: 9380, maxSizeBytes: 262144 },
  });
  ctx.room.claim(20000);
  assert.deepEqual(readAllowance(ctx, 1000, 262144), { roomTokens: 0 });
});

test("parent usage with zero inputs is ignored and normalized fallback iterations are honored", () => {
  const ctx = context(10000, 100);
  ctx.parentUsage = { input_tokens: 0, output_tokens: 999999 };
  assert.equal(readAllowance(ctx, 1000, 262144).roomTokens, 6930);
  ctx.parentUsage = {
    input_tokens: 1,
    output_tokens: 0,
    iterations: [
      {
        type: "fallback_message",
        input_tokens: 2000,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
      },
    ],
  };
  assert.equal(readAllowance(ctx, 1000, 262144).roomTokens, 4830);
});

test("raised raw bytes use three times the source model byte ratio", () => {
  const ctx = context(1000000, 0);
  ctx.bytesPerToken = 3;
  const { raised } = readAllowance(ctx, 25000, 262144);
  assert.ok(raised);
  assert.equal(raised.maxSizeBytes, 6300000);
  for (const name of [
    model,
    "claude-opus-4-6",
    "claude-3-opus",
    "claude-3-opus-20240229",
    "claude-3-7-sonnet-20250219",
  ])
    assert.equal(modelBytesPerToken(name), 4);
  for (const name of ["claude-sonnet-5-5", "claude-opus-5-5", "custom-model"])
    assert.equal(modelBytesPerToken(name), 3);
  assert.equal(modelBytesPerToken(), 4);
});

test("missing, remote and another-machine contexts do not lift caps", () => {
  assert.deepEqual(readAllowance(undefined, 1000, 262144), {});
  for (const unavailable of [
    { remote: true },
    { inputFromAnotherMachine: true },
  ])
    assert.deepEqual(
      readAllowance({ ...context(), ...unavailable }, 1000, 262144),
      {},
    );
  assert.deepEqual(readAllowance(context(1000, 0), 1000, 262144), {
    roomTokens: 700,
  });
});

test("allow_large has normal-cap behavior with no room, and strict boolean input", async () => {
  const f = await fixture();
  await writeFile(f.file, "x".repeat(8000));
  const result = await f.read({ allow_large: true });
  assert.match(result.content, /truncated by token limit/);
  assert.match(result.content, /unavailable/);
  for (const value of [1, "true", null])
    assert.equal((await f.read({ allow_large: value })).is_error, true);
  assert.equal((await f.read({ allow_large: false })).is_error, undefined);
});

test("normal overflow recommends opting in only when the current room can fit it", async () => {
  const f = await fixture();
  await writeFile(f.file, "x".repeat(8000));
  f.setReadContext(context());
  assert.match((await f.read()).content, /Retry with allow_large: true/);
  f.setReadContext(context(1000, 0));
  assert.match((await f.read()).content, /exceeds the available context room/);
});

test("lifted counting includes line numbers and a UTF8 byte/2 estimate floor", async () => {
  const f = await fixture(),
    ctx = context(20000, 0);
  f.setReadContext(ctx);
  await writeFile(f.file, "🌍".repeat(4000));
  const result = await f.read({ allow_large: true });
  assert.equal(result.content, "1\t" + "🌍".repeat(4000));
  assert.equal(ctx.room.claimed(), 8001);
  f.state.assertCurrent(f.file, Buffer.from("🌍".repeat(4000)));
});

test("successful raised reads share claims and exhausted whole reads page to the base token cap", async () => {
  const f = await fixture(),
    ctx = context(20000, 0);
  ctx.countTokens = async (text) => {
    assert.match(text, /^1\t/);
    return 6000;
  };
  f.setReadContext(ctx);
  await writeFile(f.file, "x".repeat(20000));
  for (let i = 0; i < 2; i++)
    assert.doesNotMatch(
      (await f.read({ allow_large: true })).content,
      /truncated/,
    );
  assert.equal(ctx.room.claimed(), 12000);
  const third = await f.read({ allow_large: true });
  assert.match(third.content, /truncated by token limit/);
  assert.equal(ctx.room.claimed(), 12000);
  const shown = third.content.split("\t")[1];
  assert.ok(shown !== undefined);
  assert.ok(shown.length < 4000);
  assert.throws(
    () => f.state.assertCurrent(f.file, Buffer.from("x".repeat(20000))),
    /Read the entire/,
  );
});

test("ordinary and unraised opted-in reads do not claim room", async () => {
  const f = await fixture(),
    ctx = context();
  f.setReadContext(ctx);
  await writeFile(f.file, "small");
  await f.read();
  assert.equal(ctx.room.claimed(), 0);
  f.setReadContext({
    ...ctx,
    room: new ModelContextRoom(
      () => 1000,
      14000,
      () => 0,
    ),
  });
  assert.equal((await f.read({ allow_large: true })).content, "1\tsmall");
});

test("a raised explicit range lifts its byte budget but still rejects token overflow", async () => {
  const f = await fixture(10),
    ctx = context(10000, 0);
  f.setReadContext(ctx);
  await writeFile(f.file, "x".repeat(2000));
  assert.equal((await f.read({ limit: 1 })).is_error, true);
  assert.equal(
    (await f.read({ limit: 1, allow_large: true })).content,
    "1\t" + "x".repeat(2000),
  );
  await writeFile(f.file, "x".repeat(5000));
  ctx.countTokens = async () => 99999;
  assert.equal((await f.read({ limit: 1, allow_large: true })).is_error, true);
});

test("a lifted whole read can exceed262144 raw bytes", async () => {
  const f = await fixture(25000),
    ctx = context(300000, 0);
  ctx.countTokens = async () => 80000;
  f.setReadContext(ctx);
  const text = "x".repeat(300000);
  await writeFile(f.file, text);
  const refusal = await f.read();
  assert.equal(refusal.is_error, true);
  assert.match(refusal.content, /allow_large: true/);
  const result = await f.read({ allow_large: true });
  assert.equal(result.content, "1\t" + text);
  assert.equal(ctx.room.claimed(), 80000);
  assert.equal(await readFile(f.file, "utf8"), text);
});

test("parallel counted reads recheck room after awaiting and do not both claim the initial allowance", async () => {
  const f = await fixture(),
    ctx = context(10000, 0);
  await writeFile(f.file, "x".repeat(10000));
  let arrived = 0,
    release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  ctx.countTokens = async () => {
    if (++arrived === 2) release();
    await barrier;
    return 5000;
  };
  f.setReadContext(ctx);
  const results = await Promise.all([
    f.read({ allow_large: true }),
    f.read({ allow_large: true }),
  ]);
  assert.equal(ctx.room.claimed(), 5000);
  assert.equal(
    results.filter((row) => row.content.includes("truncated by token limit"))
      .length,
    1,
  );
});

test("post-count loss of a raised allowance falls back to the source base-cap recheck", async () => {
  const f = await fixture(),
    ctx = context(10000, 0);
  await writeFile(f.file, "x".repeat(10000));
  ctx.countTokens = async () => {
    ctx.room.claim(9500);
    return 800;
  };
  f.setReadContext(ctx);
  assert.doesNotMatch(
    (await f.read({ allow_large: true })).content,
    /truncated/,
  );
  assert.equal(ctx.room.claimed(), 10300);
});

test("abort during counting creates neither a claim nor a baseline", async () => {
  const f = await fixture(),
    ctx = context(20000, 0),
    controller = new AbortController();
  await writeFile(f.file, "x".repeat(20000));
  ctx.countTokens = async () => {
    controller.abort();
    return 5000;
  };
  f.setReadContext(ctx);
  assert.equal(
    (await f.read({ allow_large: true }, controller.signal)).is_error,
    true,
  );
  assert.equal(ctx.room.claimed(), 0);
  assert.throws(
    () => f.state.assertCurrent(f.file, Buffer.from("x".repeat(20000))),
    /Read the entire/,
  );
});

test("agent room is shared within a reply, reset on the next round and cleared on exit", async () => {
  const claimed: number[] = [],
    thresholds: number[] = [];
  let current: ReadToolContext | undefined,
    resets = 0,
    calls = 0;
  const tools: ToolExecutor = {
    definitions: [],
    setReadContext(context) {
      current = context;
      if (!context) resets++;
    },
    execute: async (call) => {
      assert.ok(current?.room);
      claimed.push(current.room.claimed());
      thresholds.push(current.room.threshold);
      current.room.claim(1000);
      return { type: "tool_result", tool_use_id: call.id, content: "small" };
    },
  };
  const replies = [
    reply([readCall("a"), readCall("b")]),
    reply([readCall("c")]),
    reply(),
  ];
  const provider: Provider = {
    complete: async () => {
      const next = replies[calls++];
      assert.ok(next);
      return next;
    },
  };
  await runAgent({
    provider,
    tools,
    model,
    system: "",
    messages: [user("task")],
    maxTokens: 1,
    maxTurns: 3,
    contextWindowTokens: 200000,
    autoCompact: false,
    autoCompactWindow: "100k",
    signal: testSignal(),
    onEvent: () => {},
  });
  assert.deepEqual(claimed, [0, 1000, 0]);
  assert.deepEqual(thresholds, [167000, 167000, 167000]);
  assert.equal(current, undefined);
  assert.equal(resets, 3);
});

test("agent held history includes cleared tokens and uses current parent usage for admission", async () => {
  let observed = 0;
  const messages: Message[] = [
    user("task"),
    {
      role: "assistant",
      content: [{ type: "text", text: "old" }],
      usage: { input_tokens: 50000, output_tokens: 50 },
      contextClearedInputTokens: 1000,
    },
    user("next"),
  ];
  let context: ReadToolContext | undefined,
    calls = 0;
  const tools: ToolExecutor = {
    definitions: [],
    setReadContext(value) {
      context = value;
    },
    execute: async (call) => {
      assert.ok(context?.room);
      observed = context.room.held();
      assert.equal(
        readAllowance(context, 25000, 262144).roomTokens,
        Math.floor((167000 - 51051) * 0.7),
      );
      return { type: "tool_result", tool_use_id: call.id, content: "ok" };
    },
  };
  const provider: Provider = {
    complete: async () =>
      calls++ === 0 ? reply([readCall("r")], 1000) : reply(),
  };
  await runAgent({
    provider,
    tools,
    model,
    system: "",
    messages,
    maxTokens: 1,
    maxTurns: 2,
    contextWindowTokens: 200000,
    autoCompact: false,
    signal: testSignal(),
    onEvent: () => {},
  });
  assert.equal(observed, 51051);
});

test("actual agent tools use the shared room across three large Reads in one reply", async () => {
  const f = await fixture();
  await writeFile(f.file, "x".repeat(20000));
  let completions = 0,
    counts = 0;
  const provider: Provider = {
    complete: async () =>
      completions++ === 0
        ? reply([readCall("a"), readCall("b"), readCall("c")])
        : reply(),
    countFileTokens: async (request) => {
      counts++;
      assert.equal(request.model, model);
      assert.match(request.text, /^1\t/);
      return 6000;
    },
  };
  const messages = [user("task")];
  await runAgent({
    provider,
    tools: f.tools,
    model,
    system: "",
    messages,
    maxTokens: 1,
    maxTurns: 2,
    contextWindowTokens: 50000,
    autoCompact: false,
    signal: testSignal(),
    onEvent: () => {},
  });
  const results = messages.flatMap((row) =>
    row.content.filter((block) => block.type === "tool_result"),
  );
  assert.equal(results.length, 3);
  assert.equal(counts, 3);
  assert.equal(
    results.filter((row) => row.content.includes("truncated by token limit"))
      .length,
    1,
  );
});
