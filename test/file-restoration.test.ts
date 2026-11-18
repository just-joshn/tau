import { fixtureSse } from "./sse-fixture.js";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, onTestFinished } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import {
  estimateFileTokens,
  prepareFileRestoration,
} from "../src/file-restoration.js";
import { compactContext, freshCompactionState } from "../src/compaction.js";
import { runAgent } from "../src/agent.js";
import { AnthropicProvider } from "../src/provider.js";
import { projectMessages } from "../src/thinking-history.js";
import { estimateContextTokens } from "../src/context-usage.js";
import { newSession, SessionStore } from "../src/session.js";
import { resolveTimeoutPolicy } from "../src/timeout-policy.js";
import type {
  CompletionRequest,
  Message,
  PrepareCompaction,
  Provider,
} from "../src/types.js";
import { z } from "zod";

const model = "claude-sonnet-4-5-20250929";
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const answer = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const summary = "<summary>Continue the local file task.</summary>";
const provider: Provider = {
  complete: async () => ({
    content: [{ type: "text", text: summary }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 2 },
  }),
};
function testSignal(): AbortSignal {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  return controller.signal;
}
async function fixture() {
  const cwd = await realpath(
    await mkdtemp(path.join(tmpdir(), "tau-restoration-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const signal = testSignal();
  const state = new ReadState();
  const tools = createTools({
    cwd,
    readState: state,
    mode: "bypassPermissions",
    approve: async () => true,
  });
  const run = (name: string, input: Record<string, unknown>) =>
    tools.execute({ type: "tool_use", name, input, id: "call" }, signal);
  const file = async (name: string, text = name, mtime = 1000) => {
    const filename = path.join(cwd, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, text);
    await utimes(filename, mtime, mtime);
    return filename;
  };
  const prepare = (
    keptMessages: Message[] = [],
    countTokens?: (text: string) => Promise<number | undefined>,
  ) =>
    compactionPreparer(tools)({
      keptMessages,
      signal: signal,
      ...(countTokens ? { countTokens } : {}),
    });
  const request = (messages: Message[]): Omit<CompletionRequest, "onText"> => ({
    model,
    system: "",
    messages,
    tools: tools.definitions,
    maxTokens: 32000,
    signal: signal,
  });
  return { cwd, state, tools, run, file, prepare, request };
}

const requestBodySchema = z.looseObject({
  model: z.string().optional(),
  messages: z.array(z.looseObject({ content: z.unknown() })).optional(),
  tools: z.unknown().optional(),
});
type RequestBody = z.infer<typeof requestBodySchema>;
type Tools = ReturnType<typeof createTools>;
function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function compactionPreparer(tools: Tools): PrepareCompaction {
  return async (options) => {
    const prepared = tools.prepareCompaction?.(options);
    assert.ok(prepared);
    return prepared;
  };
}
function body(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("restoration chooses filesystem mtimes, uses touch order only for ties, and reads whole partial views", async () => {
  const f = await fixture();
  await f.file("new", "new\nbody", 3000);
  await f.run("Read", { file_path: "new", offset: 2 });
  await f.file("old", "old", 1000);
  await f.run("Read", { file_path: "old" });
  await f.file("tie-a", "a", 2000);
  await f.run("Read", { file_path: "tie-a" });
  await f.file("tie-b", "b", 2000);
  await f.run("Read", { file_path: "tie-b" });
  const restored = await f.prepare();
  assert.deepEqual(
    restored.messages.map((row) =>
      path.basename(present(row.restoredFile).path),
    ),
    ["new", "tie-b", "tie-a", "old"],
  );
  assert.match(body(present(restored.messages[0])), /1\tnew\n2\tbody/);
  restored.commit();
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "new",
        old_string: "body",
        new_string: "done",
      })
    ).content,
    "File edited",
  );
});

test("top five selection happens before rereads and failed candidates are not backfilled", async () => {
  const f = await fixture();
  for (let i = 0; i < 7; i++) {
    await f.file(String(i), `file ${i}`, 1000 + i);
    await f.run("Read", { file_path: String(i) });
  }
  await rm(path.join(f.cwd, "6"));
  await writeFile(path.join(f.cwd, "5"), Buffer.from([0, 0, 0]));
  const restored = await f.prepare();
  assert.deepEqual(
    restored.messages.map((row) =>
      path.basename(present(row.restoredFile).path),
    ),
    ["4", "3", "2"],
  );
  restored.commit();
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "1",
        old_string: "file",
        new_string: "done",
      })
    ).is_error,
    true,
  );
});

test("reread content replaces old baselines only on commit and remains subject to stale checks", async () => {
  const f = await fixture(),
    file = await f.file("a", "old");
  await f.run("Read", { file_path: "a" });
  await writeFile(file, "new");
  const restored = await f.prepare();
  assert.match(body(present(restored.messages[0])), /1\tnew/);
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "new",
        new_string: "done",
      })
    ).is_error,
    true,
  );
  restored.commit();
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "new",
        new_string: "done",
      })
    ).content,
    "File edited",
  );
  await writeFile(file, "external");
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "lost" })).is_error,
    true,
  );
});

test("retained Read paths, loaded instructions, supplied plan paths and tool-result artifacts are excluded", async () => {
  const f = await fixture();
  for (const name of [
    "a",
    "b",
    "CLAUDE.md",
    "plan.md",
    "tool-results/ArTiFaCt-1",
    "tool-results/result",
    "nested/CLAUDE.md",
  ]) {
    await f.file(name);
    await f.run("Read", { file_path: name });
  }
  const kept: Message[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "Read", input: { file_path: "a" } },
        { type: "tool_use", id: "b", name: "Read", input: { file_path: "b" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "b",
          content: "Unchanged notice",
          readContentOmitted: true,
        },
      ],
    },
  ];
  const tools = createTools({
    cwd: f.cwd,
    readState: f.state,
    mode: "bypassPermissions",
    restorationExcludedPaths: ["plan.md"],
    approve: async () => true,
  });
  const result = await compactionPreparer(tools)({
    keptMessages: kept,
    signal: testSignal(),
  });
  assert.deepEqual(
    result.messages
      .map((row) => path.relative(f.cwd, present(row.restoredFile).path))
      .sort(),
    ["b", "nested/CLAUDE.md", "tool-results/result"],
  );
  assert.equal(
    JSON.stringify(projectMessages(kept)).includes("readContentOmitted"),
    false,
  );
  result.commit();
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "a",
        new_string: "done",
      })
    ).is_error,
    true,
  );
});

test("restoration rechecks Read policy and workspace canonical paths", async () => {
  const f = await fixture(),
    file = await f.file("a", "inside");
  await f.run("Read", { file_path: "a" });
  const denied = createTools({
    cwd: f.cwd,
    readState: f.state,
    policy: { allowedTools: [], disallowedTools: ["Read"] },
    mode: "bypassPermissions",
    approve: async () => true,
  });
  assert.deepEqual(
    (
      await compactionPreparer(denied)({
        keptMessages: [],
        signal: testSignal(),
      })
    ).messages,
    [],
  );
  await rm(file);
  await symlink(path.join(f.cwd, "other"), file);
  await f.file("other", "replacement");
  assert.deepEqual((await f.prepare()).messages, []);
});

test("token estimates use UTF-16 length and denser JSON divisors", () => {
  assert.equal(estimateFileTokens("🌍".repeat(10), "a.ts"), 5);
  for (const ext of ["json", "jsonl", "jsonc"])
    assert.equal(estimateFileTokens("x".repeat(10), `a.${ext}`), 5);
  assert.equal(estimateFileTokens("x".repeat(10), "a.txt"), 3);
});

test("files above a quarter of the token cap use counting; over-cap files contain references only", async () => {
  const f = await fixture();
  await f.file("small", "s".repeat(5000), 2000);
  await f.run("Read", { file_path: "small" });
  await f.file("large", "SECRET".repeat(1000));
  await f.run("Read", { file_path: "large", limit: 1 });
  const counts: string[] = [];
  const result = await f.prepare([], async (text) => {
    counts.push(text);
    return 5001;
  });
  assert.equal(counts.length, 1);
  assert.equal(counts[0], "SECRET".repeat(1000));
  assert.deepEqual(
    result.messages.map((row) => present(row.restoredFile).kind),
    ["text", "reference"],
  );
  assert.equal(body(present(result.messages[1])).includes("SECRET"), false);
  result.commit();
  assert.equal(
    (await f.run("Write", { file_path: "large", content: "lost" })).is_error,
    true,
  );
});

test("count failure falls back to estimates and exactly 5000 tokens can restore", async () => {
  const f = await fixture();
  await f.file("a", "x".repeat(20000));
  await f.run("Read", { file_path: "a" });
  for (const count of [
    async () => undefined,
    async () => {
      throw new Error("count unavailable");
    },
    async () => 5000,
  ]) {
    assert.equal(
      present(present((await f.prepare([], count)).messages[0]).restoredFile)
        .kind,
      "text",
    );
  }
  await writeFile(path.join(f.cwd, "a"), "x".repeat(20004));
  assert.equal(
    present(
      present((await f.prepare([], async () => undefined)).messages[0])
        .restoredFile,
    ).kind,
    "reference",
  );
});

test("over-byte files produce a reference without a prefix or count request", async () => {
  const f = await fixture();
  await f.file("a", "initial");
  await f.run("Read", { file_path: "a" });
  await writeFile(path.join(f.cwd, "a"), "secret".repeat(60000));
  const result = await f.prepare([], async () => {
    throw new Error("must not count bounded prefixes");
  });
  assert.equal(
    present(present(result.messages[0]).restoredFile).kind,
    "reference",
  );
  assert.equal(body(present(result.messages[0])).includes("secret"), false);
  result.commit();
  assert.equal(
    (await f.run("Write", { file_path: "a", content: "lost" })).is_error,
    true,
  );
});

test("aggregate JSON attachment budget drops an oversized result and can retain a later candidate", async () => {
  const state = new ReadState();
  state.rememberPartial("/root/large", 2);
  state.rememberPartial("/root/small", 1);
  const result = await prepareFileRestoration({
    cwd: "/root",
    state,
    excludedPaths: [],
    keptMessages: [],
    signal: testSignal(),
    countTokens: async () => 5000,
    read: async (file) => ({
      bytes: Buffer.from(
        file.endsWith("large") ? "\u0001".repeat(65536) : "ok",
      ),
      mtimeMs: 10,
      truncated: false,
    }),
  });
  assert.deepEqual(
    result.messages.map((row) => present(row.restoredFile).path),
    ["/root/small"],
  );
  result.commit();
  assert.throws(
    () =>
      state.assertCurrent("/root/large", Buffer.from("\u0001".repeat(65536))),
    /Read/,
  );
});

test("UTF-16LE, BOM and CRLF restoration keeps a usable normalized baseline", async () => {
  const f = await fixture(),
    filename = path.join(f.cwd, "a");
  await writeFile(
    filename,
    Buffer.concat([
      Buffer.from([255, 254]),
      Buffer.from("α\r\nβ\r\n", "utf16le"),
    ]),
  );
  await f.run("Read", { file_path: "a", limit: 1 });
  const result = await f.prepare();
  assert.match(body(present(result.messages[0])), /1\tα\n2\tβ/);
  result.commit();
  assert.equal(
    (await f.run("Edit", { file_path: "a", old_string: "β", new_string: "γ" }))
      .content,
    "File edited",
  );
  assert.equal(
    (await readFile(filename)).subarray(2).toString("utf16le"),
    "α\r\nγ\r\n",
  );
});

test("manual compaction commits restored messages, persists metadata and authorizes edits before observers", async () => {
  const f = await fixture();
  await f.file("a", "old");
  await f.run("Read", { file_path: "a" });
  await writeFile(path.join(f.cwd, "a"), "fresh");
  const messages = [user("task"), answer("prior")];
  let observed = false;
  assert.equal(
    await compactContext({
      provider,
      request: f.request(messages),
      state: freshCompactionState(),
      reason: "manual",
      prepareCompaction: compactionPreparer(f.tools),
      onEvent: (event) => {
        if (event.type === "compaction" && event.stage === "complete") {
          observed = true;
          f.state.assertCurrent(path.join(f.cwd, "a"), Buffer.from("fresh"));
        }
      },
    }),
    true,
  );
  assert.ok(observed);
  assert.equal(present(messages.at(-1)).restoredFile?.kind, "text");
  assert.equal(
    present(messages.find((row) => row.contextBoundary)?.contextBoundary)
      .afterTokens,
    estimateContextTokens(messages),
  );
  const store = await SessionStore.create(f.cwd, path.join(f.cwd, "storage")),
    session = { ...newSession(f.cwd, model), messages };
  await store.save(session);
  assert.deepEqual((await store.load(session.id)).messages, messages);
  assert.equal(
    JSON.stringify(projectMessages(messages)).includes("restoredFile"),
    false,
  );
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "fresh",
        new_string: "done",
      })
    ).content,
    "File edited",
  );
});

test("invalid summaries do not start restoration and abort during restoration preserves history and cache", async () => {
  const f = await fixture();
  await f.file("a", "old");
  await f.run("Read", { file_path: "a" });
  const messages = [user("task"), answer("prior")],
    original = structuredClone(messages);
  let reads = 0;
  const invalid: Provider = {
    complete: async () => ({
      content: [{ type: "tool_use", id: "bad", name: "Write", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  };
  assert.equal(
    await compactContext({
      provider: invalid,
      request: f.request(messages),
      state: freshCompactionState(),
      reason: "manual",
      prepareCompaction: async (options) => {
        reads++;
        return compactionPreparer(f.tools)(options);
      },
      onEvent: () => {},
    }),
    false,
  );
  assert.equal(reads, 0);
  assert.deepEqual(messages, original);
  const controller = new AbortController();
  await writeFile(path.join(f.cwd, "a"), "x".repeat(6000));
  await assert.rejects(
    compactContext({
      provider: {
        ...provider,
        countFileTokens: async () => {
          controller.abort();
          return 2;
        },
      },
      request: { ...f.request(messages), signal: controller.signal },
      state: freshCompactionState(),
      reason: "manual",
      prepareCompaction: compactionPreparer(f.tools),
      onEvent: () => {},
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(messages, original);
  f.state.assertCurrent(path.join(f.cwd, "a"), Buffer.from("old"));
});

async function httpFixture(
  handler: (
    url: string,
    body: RequestBody,
    res: ServerResponse,
    headers: Record<string, unknown>,
  ) => void,
  timeout = 1000,
) {
  const requests: Array<{ url: string; body: RequestBody }> = [];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = requestBodySchema.parse(JSON.parse(raw));
    const url = req.url;
    assert.ok(url);
    requests.push({ url, body });
    handler(url, body, res, req.headers);
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    http.closeAllConnections();
    await new Promise<void>((done) => http.close(() => done()));
  });
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  const provider = new AnthropicProvider({
    apiKey: "loopback",
    baseUrl: `http://127.0.0.1:${addr.port}`,
    maxRetries: 0,
    timeoutPolicy: resolveTimeoutPolicy({
      env: { API_TIMEOUT_MS: String(timeout) },
    }),
  });
  return { provider, requests };
}
function respond(res: ServerResponse, text: string, tool = false) {
  const content = tool
    ? [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: "a", old_string: "fresh", new_string: "done" },
        },
      ]
    : [{ type: "text", text }];
  const [block] = content;
  assert.ok(block);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    fixtureSse([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]),
  );
}

test("direct count API uses the verified beta endpoint, model alias and an independent one-retry allowance", async () => {
  let calls = 0;
  const f = await httpFixture((url, body, res, headers) => {
    assert.equal(url, "/v1/messages/count_tokens?beta=true");
    assert.equal(headers["anthropic-beta"], "token-counting-2024-11-01");
    assert.equal(headers["x-api-key"], "loopback");
    assert.deepEqual(body.messages, [{ role: "user", content: "🌍" }]);
    assert.deepEqual(body.tools, []);
    assert.ok(!("stream" in body));
    if (++calls === 1) {
      res.writeHead(503, { "retry-after-ms": "1" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":17}');
    }
  });
  assert.equal(
    await f.provider.countFileTokens({
      model: "sonnet",
      text: "🌍",
      signal: testSignal(),
    }),
    17,
  );
  assert.equal(calls, 2);
  assert.equal(present(f.requests[0]).body.model, "claude-sonnet-5-5");
});

test("count API declines malformed, oversized, redirected and unsupported responses without disclosure", async () => {
  for (const variant of [
    "bad",
    "oversized",
    "redirect",
    "negative",
    "nonjson",
  ]) {
    const f = await httpFixture((_url, _body, res) => {
      if (variant === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type":
          variant === "nonjson" ? "text/plain" : "application/json",
      });
      res.end(
        variant === "bad"
          ? "{"
          : variant === "oversized"
            ? "x".repeat(65537)
            : variant === "negative"
              ? '{"input_tokens":-1}'
              : '{"input_tokens":1}',
      );
    });
    assert.equal(
      await f.provider.countFileTokens({
        model,
        text: "x",
        signal: testSignal(),
      }),
      undefined,
    );
    assert.equal(f.requests.length, 1);
  }
});

test("count API bounds a stalled accepted body and propagates caller cancellation", async () => {
  const f = await httpFixture((_url, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.write("{");
  }, 25);
  assert.equal(
    await f.provider.countFileTokens({
      model,
      text: "x",
      signal: testSignal(),
    }),
    undefined,
  );
  assert.equal(f.requests.length, 1);
  const controller = new AbortController();
  const pending = f.provider.countFileTokens({
    model,
    text: "x",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("automatic HTTP compaction restores fresh text before continuation and edits through the same executor", async () => {
  const f = await fixture();
  await f.file("a", "old");
  await f.run("Read", { file_path: "a", limit: 1 });
  await writeFile(path.join(f.cwd, "a"), "fresh");
  const http = await httpFixture((_url, _body, res) =>
    respond(
      res,
      http.requests.length === 1 ? summary : "done",
      http.requests.length === 2,
    ),
  );
  const messages = [
    user("task"),
    { ...answer("prior"), usage: { input_tokens: 190000, output_tokens: 2 } },
    user("continue"),
  ];
  await runAgent({
    provider: http.provider,
    tools: f.tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 2,
    autoCompactWindow: "200k",
    contextWindowTokens: 200000,
    maxApiAttempts: 3,
    signal: testSignal(),
    onEvent: () => {},
  });
  assert.equal(http.requests.length, 3);
  assert.match(
    JSON.stringify(present(http.requests[1]).body.messages),
    /Restored file after context compaction/,
  );
  assert.match(
    JSON.stringify(present(http.requests[1]).body.messages),
    /fresh/,
  );
  assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "done");
  assert.match(
    JSON.stringify(present(http.requests[2]).body.messages),
    /File edited/,
  );
});

test("manual restoration counts the full text even after the summary consumes its generation allowance", async () => {
  const f = await fixture(),
    contents = "fresh".repeat(1500);
  await f.file("a", contents);
  await f.run("Read", { file_path: "a", offset: 2 });
  const http = await httpFixture((url, body, res) => {
    if (url.includes("count_tokens")) {
      assert.equal(body.messages?.[0]?.content, contents);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":4999}');
    } else respond(res, summary);
  });
  const messages = [user("task"), answer("prior")];
  const { ApiAttemptBudget } = await import("../src/attempt-ledger.js");
  const budget = new ApiAttemptBudget(1);
  assert.equal(
    await compactContext({
      provider: http.provider,
      request: { ...f.request(messages), attemptBudget: budget },
      state: freshCompactionState(),
      reason: "manual",
      prepareCompaction: compactionPreparer(f.tools),
      onEvent: () => {},
    }),
    true,
  );
  assert.equal(budget.remaining, 0);
  assert.equal(http.requests.length, 2);
  assert.equal(present(present(messages.at(-1)).restoredFile).kind, "text");
});

test("a preferred larger summary keeps auxiliary restoration counts on the main Read model", async () => {
  const f = await fixture();
  await f.file("a", "fresh".repeat(1500));
  await f.run("Read", { file_path: "a" });
  const preferred = "claude-opus-5-5";
  const http = await httpFixture((url, _body, res) => {
    if (url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":2000}');
    } else respond(res, http.requests.length === 1 ? summary : "done");
  });
  const messages = [
    user("task"),
    {
      ...answer("prior"),
      requestedModel: preferred,
      usage: { input_tokens: 190000, output_tokens: 2 },
    },
    user("continue"),
  ];
  await runAgent({
    provider: http.provider,
    tools: f.tools,
    messages,
    model,
    system: "",
    maxTokens: 32000,
    maxTurns: 1,
    contextWindowTokens: 200000,
    maxApiAttempts: 2,
    signal: testSignal(),
    onEvent: () => {},
  });
  assert.equal(http.requests.length, 3);
  assert.equal(present(http.requests[0]).body.model, preferred);
  assert.equal(
    present(http.requests[1]).url,
    "/v1/messages/count_tokens?beta=true",
  );
  assert.equal(present(http.requests[1]).body.model, model);
  assert.equal(present(http.requests[2]).body.model, model);
  assert.equal(
    present(messages.find((row) => row.contextBoundary)?.contextBoundary)
      .summaryModel,
    preferred,
  );
  assert.match(
    JSON.stringify(present(http.requests[2]).body.messages),
    /Restored file after context compaction/,
  );
});
