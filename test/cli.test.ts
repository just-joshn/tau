import { fixtureSse } from "./sse-fixture.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";

function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input = "",
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [resolve("src/cli.ts"), ...args],
      { env, stdio: "pipe" },
    );
    let out = "",
      err = "";
    process.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
    });
    process.stderr.setEncoding("utf8").on("data", (chunk) => {
      err += chunk;
    });
    process.on("error", reject);
    process.on("close", (code) => done({ code, out, err }));
    process.stdin.end(input);
  });
}
function respond(
  response: ServerResponse,
  block:
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      },
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
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
      delta: {
        stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  response.end(fixtureSse(events));
}
const requestSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.array(
        z.object({
          type: z.string(),
          content: z.string().optional(),
          is_error: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
const resultSchema = z.object({
  type: z.literal("result"),
  session_id: z.uuid(),
  result: z.string(),
  is_error: z.boolean(),
});
const requestBody = z.looseObject({
  model: z.string(),
  max_tokens: z.number().optional(),
  thinking: z.unknown().optional(),
  tools: z.unknown().optional(),
  system: z.unknown().optional(),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.array(
        z.looseObject({
          type: z.string().optional(),
          text: z.string().optional(),
          signature: z.string().optional(),
        }),
      ),
    }),
  ),
});
type RequestBody = z.infer<typeof requestBody>;
const streamEvent = z.looseObject({
  type: z.string().optional(),
  stage: z.string().optional(),
});
const storedSession = z.looseObject({
  model: z.string().optional(),
  messages: z.array(
    z.looseObject({
      model: z.string().optional(),
      requestedModel: z.string().optional(),
      responseId: z.string().optional(),
      contextUsageDiscarded: z.boolean().optional(),
      thinkingStripFrom: z.number().optional(),
      resumable: z.boolean().optional(),
      contextBoundary: z
        .looseObject({
          reason: z.string().optional(),
          groupsPreserved: z.number().optional(),
          totalGroups: z.number().optional(),
        })
        .optional(),
      content: z
        .array(
          z.looseObject({
            text: z.string().optional(),
            signature: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  compaction: z
    .looseObject({
      consecutiveFailures: z.number(),
      turnCounter: z.number(),
    })
    .optional(),
});
async function readStored(temp: string, sessionId: string) {
  const [partition] = await readdir(join(temp, "state", "sessions"));
  assert.ok(partition);
  return storedSession.parse(
    JSON.parse(
      await readFile(
        join(temp, "state", "sessions", partition, `${sessionId}.json`),
        "utf8",
      ),
    ),
  );
}

test(
  "compiled CLI applies thinking precedence and model defaults to HTTP bodies",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-thinking-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const bodies: RequestBody[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(requestBody.parse(JSON.parse(raw)));
      respond(response, { type: "text", text: "Done." });
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "local-test-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
      MAX_THINKING_TOKENS: "2500",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined,
      CLAUDE_CODE_DISABLE_THINKING: undefined,
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: undefined,
      ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
      ANTHROPIC_MODEL: undefined,
      ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
    };
    for (const flags of [
      [],
      [
        "--model",
        "claude-sonnet-4-5",
        "--thinking",
        "enabled",
        "--max-tokens",
        "4000",
      ],
      [
        "--model",
        "claude-sonnet-4-5",
        "--max-thinking-tokens",
        "1200",
        "--max-tokens",
        "4000",
      ],
      ["--model", "claude-sonnet-4-5", "--thinking", "disabled"],
      ["--model", "sonnet"],
    ]) {
      const result = await cli(["-p", "hello", "--cwd", temp, ...flags], env);
      assert.equal(result.code, 0, result.err);
      assert.equal(result.out.trim(), "Done.");
    }
    assert.deepEqual(
      bodies.map((body) => [body.model, body.max_tokens, body.thinking]),
      [
        ["claude-opus-5-5", 128000, { type: "adaptive" }],
        [
          "claude-sonnet-4-5-20250929",
          4000,
          { type: "enabled", budget_tokens: 3999 },
        ],
        [
          "claude-sonnet-4-5-20250929",
          4000,
          { type: "enabled", budget_tokens: 2500 },
        ],
        ["claude-sonnet-4-5-20250929", 32000, { type: "disabled" }],
        ["claude-sonnet-5-5", 128000, { type: "adaptive" }],
      ],
    );
  },
  { timeout: 10000 },
);

test(
  "CLI print tool loop, denied edits, approved edits, JSON and session resume",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    let calls = 0;
    let denied = false;
    const advertised: string[][] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      calls++;
      advertised.push(body.tools.map((tool) => tool.name));
      const last = body.messages.at(-1);
      const tool = last?.content.find((block) => block.type === "tool_result");
      if (tool) {
        denied = tool.is_error === true;
        respond(response, {
          type: "text",
          text: denied ? "Edit denied." : "File created.",
        });
      } else {
        respond(response, {
          type: "tool_use",
          id: `call-${calls}`,
          name: "Write",
          input: { file_path: "created.txt", content: "hello" },
        });
      }
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "local-test-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
    };
    const args = [
      "-p",
      "make a file",
      "--cwd",
      temp,
      "--output-format",
      "json",
    ];
    const first = await cli(args, env);
    assert.equal(first.code, 0, first.err);
    const result = resultSchema.parse(JSON.parse(first.out));
    assert.equal(result.result, "Edit denied.");
    assert.equal(denied, true);
    await assert.rejects(readFile(join(temp, "created.txt")));
    const approved = await cli([...args, "--allowed-tools", "Write"], env);
    assert.equal(approved.code, 0, approved.err);
    assert.equal(
      resultSchema.parse(JSON.parse(approved.out)).result,
      "File created.",
    );
    await rm(join(temp, "created.txt"));
    for (const flags of [
      [
        "--tools",
        "",
        "--allowedTools",
        "Write",
        "--permission-mode",
        "bypassPermissions",
      ],
      ["--disallowedTools", "Write", "--permission-mode", "acceptEdits"],
    ]) {
      const index = advertised.length;
      const restricted = await cli([...args, ...flags], env);
      assert.equal(restricted.code, 0, restricted.err);
      assert.equal(
        resultSchema.parse(JSON.parse(restricted.out)).result,
        "Edit denied.",
      );
      assert.ok(!advertised[index]?.includes("Write"));
      await assert.rejects(readFile(join(temp, "created.txt")));
    }
    const second = await cli(
      [
        ...args,
        "--resume",
        result.session_id,
        "--permission-mode",
        "acceptEdits",
      ],
      env,
    );
    assert.equal(second.code, 0, second.err);
    assert.equal(
      resultSchema.parse(JSON.parse(second.out)).session_id,
      result.session_id,
    );
    assert.equal(await readFile(join(temp, "created.txt"), "utf8"), "hello");
    const streaming = await cli(
      ["--cwd", temp, "--output-format", "stream-json"],
      env,
      "create it",
    );
    assert.equal(streaming.code, 0, streaming.err);
    const lines = streaming.out
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    assert.equal(resultSchema.parse(lines.at(-1)).is_error, false);
    assert.ok(lines.length > 3);
    const exhausted = await cli([...args, "--max-turns", "1"], env);
    assert.equal(exhausted.code, 1);
    const failed = z
      .object({
        is_error: z.literal(true),
        usage: z.object({
          input_tokens: z.literal(10),
          output_tokens: z.literal(4),
        }),
        error: z.string(),
      })
      .parse(JSON.parse(exhausted.out));
    assert.match(failed.error, /maxTurns/);
  },
  { timeout: 15000 },
);

test(
  "compiled CLI recovers a server context rejection within one round and resumes the saved boundary",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-reactive-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const bodies: RequestBody[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = requestBody.parse(JSON.parse(raw));
      bodies.push(body);
      if (bodies.length === 2) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "prompt is too long: 210000 tokens > 200000",
            },
          }),
        );
        return;
      }
      const summary = body.messages
        .at(-1)
        ?.content[0]?.text?.includes("Create a continuation summary");
      respond(response, {
        type: "text",
        text:
          bodies.length === 1
            ? "Original archived answer"
            : summary
              ? "<summary>Continuation facts for a.ts</summary>"
              : "Done.",
      });
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "loopback",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
      DISABLE_COMPACT: undefined,
      DISABLE_AUTO_COMPACT: undefined,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined,
      CLAUDE_CODE_MAX_RETRIES: "0",
    };
    const args = [
      "--cwd",
      temp,
      "--model",
      "claude-sonnet-4-5",
      "--max-turns",
      "1",
    ];
    const first = await cli(
      [...args, "-p", "initial", "--output-format", "json"],
      env,
    );
    assert.equal(first.code, 0, first.err);
    const initial = resultSchema.parse(JSON.parse(first.out));
    const second = await cli(
      [
        ...args,
        "-p",
        "next",
        "--resume",
        initial.session_id,
        "--output-format",
        "stream-json",
        "--max-api-attempts",
        "3",
      ],
      env,
    );
    assert.equal(second.code, 0, second.err);
    const events = second.out
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    assert.equal(resultSchema.parse(events.at(-1)).result, "Done.");
    assert.ok(!second.out.includes("Continuation facts"));
    assert.equal(bodies.length, 4);
    assert.ok(!JSON.stringify(bodies[3]).includes("Original archived answer"));
    const third = await cli(
      [
        ...args,
        "-p",
        "again",
        "--resume",
        initial.session_id,
        "--output-format",
        "json",
      ],
      env,
    );
    assert.equal(third.code, 0, third.err);
    assert.equal(bodies.length, 5);
    assert.ok(!JSON.stringify(bodies[4]).includes("Original archived answer"));
    const stored = await readStored(temp, initial.session_id);
    assert.ok(
      stored.messages.some(
        (message) => message.contextBoundary?.reason === "reactive",
      ),
    );
    assert.equal(stored.messages[1]?.requestedModel, "claude-sonnet-4-5");
    assert.equal(
      stored.messages[1]?.content?.[0]?.text,
      "Original archived answer",
    );
    assert.ok(
      bodies.every((body) =>
        body.messages.every((message) => Object.keys(message).length === 2),
      ),
    );
  },
  { timeout: 10000 },
);

test(
  "compiled CLI saves retained reply groups and excludes stale usage when resuming again",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-prefix-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const bodies: RequestBody[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(requestBody.parse(JSON.parse(raw)));
      const count = bodies.length;
      const value =
        count === 1
          ? "OLD-ARCHIVED"
          : count === 2
            ? "RECENT-RETAINED"
            : count === 3
              ? "<summary>Prefix summary</summary>"
              : "Done";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `reply-${count}`,
              role: "assistant",
              content: [],
              usage: {
                input_tokens: count === 2 ? 170000 : 10,
                output_tokens: 0,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: value },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "loopback",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
      DISABLE_COMPACT: undefined,
      DISABLE_AUTO_COMPACT: undefined,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined,
    };
    const args = [
      "--cwd",
      temp,
      "--model",
      "claude-sonnet-4-5",
      "--max-turns",
      "1",
      "--output-format",
      "json",
    ];
    const first = await cli([...args, "-p", "one"], env);
    assert.equal(first.code, 0, first.err);
    const session = resultSchema.parse(JSON.parse(first.out)).session_id;
    for (const prompt of ["two", "PENDING-THREE", "four"]) {
      const result = await cli(
        [...args, "-p", prompt, "--resume", session, "--max-api-attempts", "2"],
        env,
      );
      assert.equal(result.code, 0, result.err);
    }
    assert.equal(bodies.length, 5);
    assert.ok(JSON.stringify(bodies[2]).includes("OLD-ARCHIVED"));
    assert.ok(!JSON.stringify(bodies[2]).includes("RECENT-RETAINED"));
    assert.ok(!JSON.stringify(bodies[2]).includes("PENDING-THREE"));
    assert.ok(JSON.stringify(bodies[3]).includes("RECENT-RETAINED"));
    assert.ok(JSON.stringify(bodies[4]).includes("RECENT-RETAINED"));
    assert.ok(!JSON.stringify(bodies[4]).includes("OLD-ARCHIVED"));
    const stored = await readStored(temp, session);
    assert.equal(stored.messages[3]?.contextBoundary?.groupsPreserved, 1);
    assert.equal(stored.messages[3]?.contextBoundary?.totalGroups, 3);
    assert.equal(stored.messages[4]?.responseId, "reply-2");
    assert.equal(stored.messages[4]?.contextUsageDiscarded, true);
    assert.ok(
      bodies.every((body) =>
        body.messages.every((message) => Object.keys(message).length === 2),
      ),
    );
  },
  { timeout: 10000 },
);

test("CLI help and missing credentials do not contact a service", async () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const help = await cli(["--help"], env);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: tau/);
  const missing = await cli(["-p", "hello"], env);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /ANTHROPIC_API_KEY/);
});

test(
  "compiled CLI compacts a resumed context, retains raw history and uses the boundary after restart",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-context-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const bodies: RequestBody[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = requestBody.parse(JSON.parse(raw));
      bodies.push(body);
      const first = bodies.length === 1,
        compact = body.messages
          .at(-1)
          ?.content.some(
            (block) =>
              block.type === "text" &&
              block.text?.includes("Create a continuation summary"),
          );
      const value = first
        ? "Original answer stays in history."
        : compact
          ? "<summary>Continue work on a.ts; the original request has been completed.</summary>"
          : "Done.";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              role: "assistant",
              content: [],
              usage: { input_tokens: first ? 190000 : 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: value },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: first ? 1000 : 2 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "loopback",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
      DISABLE_COMPACT: undefined,
      DISABLE_AUTO_COMPACT: undefined,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: undefined,
    };
    const first = await cli(
      [
        "-p",
        "initial",
        "--model",
        "claude-sonnet-4-5",
        "--cwd",
        temp,
        "--output-format",
        "json",
      ],
      env,
    );
    assert.equal(first.code, 0, first.err);
    const initial = resultSchema.parse(JSON.parse(first.out));
    const second = await cli(
      [
        "-p",
        "next",
        "--resume",
        initial.session_id,
        "--cwd",
        temp,
        "--output-format",
        "stream-json",
        "--max-api-attempts",
        "2",
      ],
      env,
    );
    assert.equal(second.code, 0, second.err);
    const events = second.out
      .trim()
      .split("\n")
      .map((line) => streamEvent.parse(JSON.parse(line)));
    assert.ok(
      events.some(
        (event) => event.type === "compaction" && event.stage === "complete",
      ),
    );
    assert.equal(resultSchema.parse(events.at(-1)).result, "Done.");
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[1]?.tools, bodies[0]?.tools);
    assert.deepEqual(bodies[1]?.thinking, bodies[0]?.thinking);
    assert.equal(bodies[1]?.system, bodies[0]?.system);
    assert.ok(
      !JSON.stringify(bodies[2]).includes("Original answer stays in history."),
    );
    assert.equal(bodies[2]?.messages.length, 1);
    const [compacted] = bodies[2]?.messages ?? [];
    assert.ok(compacted);
    assert.equal(compacted.role, "user");
    assert.equal(compacted.content.length, 2);
    assert.match(
      compacted.content[0]?.text ?? "",
      /Continue work on a\.ts;[\s\S]*\n$/,
    );
    assert.deepEqual(compacted.content[1], {
      type: "text",
      text: "next",
    });
    const third = await cli(
      [
        "-p",
        "again",
        "--resume",
        initial.session_id,
        "--cwd",
        temp,
        "--output-format",
        "json",
      ],
      env,
    );
    assert.equal(third.code, 0, third.err);
    assert.equal(bodies.length, 4);
    assert.ok(
      !JSON.stringify(bodies[3]).includes("Original answer stays in history."),
    );
    const stored = await readStored(temp, initial.session_id);
    assert.equal(
      stored.messages[1]?.content?.[0]?.text,
      "Original answer stays in history.",
    );
    assert.ok(
      stored.messages.some((message) => message.contextBoundary !== undefined),
    );
    assert.ok(stored.compaction);
    assert.equal(stored.compaction.consecutiveFailures, 0);
    assert.ok(stored.compaction.turnCounter >= 2);
    assert.ok(
      bodies.every((body) =>
        body.messages.every((message) => Object.keys(message).length === 2),
      ),
    );
  },
  { timeout: 15000 },
);

test(
  "compiled CLI recovers a refused thinking prefill and persists later prefix stripping across resume",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-thinking-resume-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const bodies: RequestBody[] = [],
      betas: Array<string | string[] | undefined> = [];
    const model = "claude-sonnet-4-5-20250929";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = requestBody.parse(JSON.parse(raw));
      bodies.push(body);
      betas.push(request.headers["anthropic-beta"]);
      const count = bodies.length;
      if (count === 2 || count === 4) {
        const index = body.messages.findIndex((message) =>
          message.content.some((block) => block.signature === "stable"),
        );
        response.writeHead(400, {
          "content-type": "application/json",
          ...(count === 4
            ? {
                "anthropic-thinking-prefix-mismatch": `block=messages.${index}.content.0`,
              }
            : {}),
        });
        response.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message:
                count === 2
                  ? "Unsupported anthropic-beta: thinking-resumption-2026-07-17"
                  : "Thinking was not created in this conversation",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events: unknown[] = [
        {
          type: "message_start",
          message: {
            role: "assistant",
            model,
            content: [],
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        },
      ];
      if (count === 1 || count === 3)
        events.push(
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reason" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "signature_delta",
              signature: count === 1 ? "cut" : "stable",
            },
          },
          { type: "content_block_stop", index: 0 },
        );
      if (count !== 1)
        events.push(
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "text",
              text: count === 3 ? "Done." : "Again.",
            },
          },
          { type: "content_block_stop", index: 1 },
        );
      events.push(
        {
          type: "message_delta",
          delta: {
            stop_reason: count === 1 ? "max_tokens" : "end_turn",
            ...(count === 1 ? { resumable: true } : {}),
          },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      );
      response.end(fixtureSse(events));
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "loopback-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
      TAU_THINKING_RESUMPTION: "true",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined,
    };
    const first = await cli(
      [
        "-p",
        "hello",
        "--model",
        model,
        "--cwd",
        temp,
        "--output-format",
        "json",
        "--max-retries",
        "0",
      ],
      env,
    );
    assert.equal(first.code, 0, first.err);
    const initial = resultSchema.parse(JSON.parse(first.out));
    assert.equal(initial.result, "Done.");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[1]?.messages.at(-1)?.role, "assistant");
    assert.ok(
      !bodies[2]?.messages.some((message) => message.role === "assistant"),
    );
    assert.equal(betas[2], undefined);
    const resumed = await cli(
      [
        "-p",
        "next",
        "--cwd",
        temp,
        "--resume",
        initial.session_id,
        "--output-format",
        "stream-json",
        "--max-retries",
        "0",
      ],
      env,
    );
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(bodies.length, 5);
    const events = resumed.out
      .trim()
      .split("\n")
      .map((line) => streamEvent.parse(JSON.parse(line)));
    assert.ok(events.some((event) => event.type === "thinking_stripped"));
    assert.equal(resultSchema.parse(events.at(-1)).result, "Again.");
    assert.equal(betas[3], "thinking-resumption-2026-07-17");
    assert.ok(
      !bodies[4]?.messages.some((message) =>
        message.content.some((block) => block.type === "thinking"),
      ),
    );
    assert.ok(
      bodies.every((body) =>
        body.messages.every((message) => Object.keys(message).length === 2),
      ),
    );
    const stored = await readStored(temp, initial.session_id);
    const stable = stored.messages.find((message) =>
      message.content?.some((block) => block.signature === "stable"),
    );
    assert.ok(stable);
    assert.equal(stable.thinkingStripFrom, 0);
    assert.equal(stable.content?.[0]?.signature, "stable");
    assert.equal(stored.messages[1]?.resumable, true);
  },
  { timeout: 15000 },
);

test(
  "compiled CLI refuses stale edits and recovers with a fresh Read",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-stale-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const file = join(temp, "a.txt");
    await writeFile(file, "one\ntwo\n");
    const actions: Array<{ name: string; input: Record<string, unknown> }> = [
      {
        name: "Edit",
        input: { file_path: "a.txt", old_string: "one", new_string: "ONE" },
      },
      { name: "Read", input: { file_path: "a.txt" } },
      {
        name: "Edit",
        input: { file_path: "a.txt", old_string: "one", new_string: "ONE" },
      },
      { name: "Read", input: { file_path: "a.txt" } },
      { name: "Write", input: { file_path: "a.txt", content: "done" } },
    ];
    const observed: Array<{
      content?: string | undefined;
      is_error?: boolean | undefined;
    }> = [];
    let step = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      const previous = body.messages
        .at(-1)
        ?.content.find((block) => block.type === "tool_result");
      if (previous) observed.push(previous);
      if (step === 2) await writeFile(file, "one\nexternal\n");
      const action = actions[step++];
      respond(
        response,
        action
          ? { type: "tool_use", id: `stale-${step}`, ...action }
          : { type: "text", text: "Done." },
      );
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await cli(
      [
        "-p",
        "edit",
        "--cwd",
        temp,
        "--permission-mode",
        "acceptEdits",
        "--output-format",
        "stream-json",
      ],
      {
        ...process.env,
        ANTHROPIC_API_KEY: "local-test-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        TAU_HOME: join(temp, "state"),
      },
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(observed.length, 5);
    assert.equal(observed[0]?.is_error, true);
    assert.match(observed[0]?.content ?? "", /Read.*before/);
    assert.equal(observed[1]?.is_error, undefined);
    assert.equal(observed[2]?.is_error, true);
    assert.match(observed[2]?.content ?? "", /changed.*Read/);
    assert.equal(observed[3]?.is_error, undefined);
    assert.equal(observed[4]?.content, "File written");
    assert.equal(await readFile(file, "utf8"), "done");
  },
  { timeout: 15000 },
);

test(
  "compiled CLI preserves UTF16/BOM and creates files through Edit",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-encoding-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const file = join(temp, "a");
    await writeFile(file, Buffer.from("\uFEFF“one”\r\n", "utf16le"));
    await chmod(file, 0o640);
    const actions = [
      { name: "Read", input: { file_path: "a" } },
      {
        name: "Edit",
        input: {
          file_path: "a",
          old_string: '"one"',
          new_string: '"two"\r\nnext',
        },
      },
      { name: "Write", input: { file_path: "a", content: "final\n" } },
      {
        name: "Edit",
        input: {
          file_path: "nested/new.json",
          old_string: "",
          new_string: '{"name":"\\u00E9"}',
        },
      },
      {
        name: "Edit",
        input: {
          file_path: "nested/new.json",
          old_string: "é",
          new_string: "à",
        },
      },
    ];
    let step = 0;
    const observed: Array<{
      content?: string | undefined;
      is_error?: boolean | undefined;
    }> = [];
    let intermediate: Buffer | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      const result = body.messages
        .at(-1)
        ?.content.find((block) => block.type === "tool_result");
      if (result) observed.push(result);
      if (step === 2) intermediate = await readFile(file);
      const action = actions[step++];
      respond(
        response,
        action
          ? { type: "tool_use", id: `encoding-${step}`, ...action }
          : { type: "text", text: "Done." },
      );
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await cli(
      [
        "-p",
        "edit",
        "--cwd",
        temp,
        "--permission-mode",
        "acceptEdits",
        "--output-format",
        "stream-json",
      ],
      {
        ...process.env,
        ANTHROPIC_API_KEY: "local-test-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        TAU_HOME: join(temp, "state"),
      },
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(observed.length, actions.length);
    assert.ok(
      observed.every((result) => !result.is_error),
      JSON.stringify(observed),
    );
    assert.deepEqual(
      intermediate,
      Buffer.from("\uFEFF“two”\r\nnext\r\n", "utf16le"),
    );
    assert.deepEqual(
      await readFile(file),
      Buffer.from("\uFEFFfinal\n", "utf16le"),
    );
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.equal(
      await readFile(join(temp, "nested/new.json"), "utf8"),
      '{"name":"\\u00E0"}',
    );
    assert.ok(!(await readdir(temp)).some((name) => name.includes(".tmp.")));
    const events = result.out
      .trim()
      .split("\n")
      .map((line) => streamEvent.parse(JSON.parse(line)));
    assert.equal(
      events.filter((event) => event.type === "tool_result").length,
      actions.length,
    );
    assert.equal(resultSchema.parse(events.at(-1)).result, "Done.");
  },
  { timeout: 15000 },
);

test(
  "compiled CLI honors a disabled or one-retry budget",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-retry-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    let calls = 0;
    const server = createServer((_request, response) => {
      if (++calls === 1) {
        response.writeHead(503);
        response.end("secret-key");
      } else respond(response, { type: "text", text: "Recovered." });
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "local-test-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
    };
    const args = [
      "-p",
      "hello",
      "--cwd",
      temp,
      "--output-format",
      "json",
      "--max-retries",
    ];
    const disabled = await cli([...args, "0"], env);
    assert.equal(disabled.code, 1);
    assert.equal(calls, 1);
    assert.equal(resultSchema.parse(JSON.parse(disabled.out)).is_error, true);
    assert.doesNotMatch(disabled.out + disabled.err, /secret-key/);
    calls = 0;
    const retried = await cli([...args, "1"], env);
    assert.equal(retried.code, 0, retried.err);
    assert.equal(calls, 2);
    assert.equal(
      resultSchema.parse(JSON.parse(retried.out)).result,
      "Recovered.",
    );
  },
  { timeout: 10000 },
);

test(
  "compiled CLI shares an API-attempt allowance across retries and tool rounds",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-allowance-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    await writeFile(join(temp, "a"), "fixture");
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      if (calls === 1) {
        response.writeHead(503);
        response.end();
      } else if (calls === 2)
        respond(response, {
          type: "tool_use",
          id: "read-a",
          name: "Read",
          input: { file_path: "a" },
        });
      else respond(response, { type: "text", text: "Finished." });
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "local-test-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
    };
    const args = [
      "-p",
      "inspect",
      "--cwd",
      temp,
      "--output-format",
      "stream-json",
      "--max-api-attempts",
    ];
    const blocked = await cli([...args, "2"], env);
    assert.equal(blocked.code, 1, blocked.err);
    assert.equal(calls, 2);
    const events = blocked.out
      .trim()
      .split("\n")
      .map((line) => streamEvent.parse(JSON.parse(line)));
    assert.equal(
      events.filter((event) => event.type === "tool_result").length,
      1,
    );
    const result = z
      .looseObject({
        error: z.string(),
        usage: z.unknown(),
        session_id: z.string(),
      })
      .parse(events.at(-1));
    assert.match(result.error, /API attempt budget exhausted/);
    assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4 });
    const directory = join(temp, "state", "sessions");
    // Resuming must have a replayable completed tool result, not an unclosed assistant call.
    calls = 2;
    const resumed = await cli(
      [
        "-p",
        "continue",
        "--cwd",
        temp,
        "--resume",
        result.session_id,
        "--output-format",
        "json",
        "--max-api-attempts",
        "1",
      ],
      env,
    );
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(calls, 3);
    assert.equal(
      resultSchema.parse(JSON.parse(resumed.out)).result,
      "Finished.",
    );
    assert.ok((await readdir(directory)).length > 0);
    calls = 0;
    const zero = await cli([...args, "0"], env);
    assert.equal(zero.code, 1);
    assert.equal(calls, 0);
  },
  { timeout: 10000 },
);

test(
  "compiled CLI uses the same allowance for JSON fallback and the following tool round",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-json-fallback-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    await writeFile(join(temp, "a"), "fixture");
    const sent: boolean[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const body = z
        .looseObject({ stream: z.boolean() })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      sent.push(body.stream);
      if (sent.length === 1) {
        response.writeHead(404);
        response.end();
      } else if (sent.length === 2) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "json-read",
                name: "Read",
                input: { file_path: "a" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
        );
      } else respond(response, { type: "text", text: "Finished." });
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await cli(
      [
        "-p",
        "inspect",
        "--cwd",
        temp,
        "--output-format",
        "stream-json",
        "--max-retries",
        "0",
        "--max-api-attempts",
        "3",
        "--allow-nonstream-fallback",
      ],
      {
        ...process.env,
        ANTHROPIC_API_KEY: "local-test-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        TAU_HOME: join(temp, "state"),
      },
    );
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(sent, [true, false, true]);
    const events = result.out
      .trim()
      .split("\n")
      .map((line) => streamEvent.parse(JSON.parse(line)));
    assert.equal(
      events.filter((event) => event.type === "tool_result").length,
      1,
    );
    assert.deepEqual(
      z.looseObject({ usage: z.unknown() }).parse(events.at(-1)).usage,
      {
        input_tokens: 17,
        output_tokens: 7,
      },
    );
    assert.equal(resultSchema.parse(events.at(-1)).result, "Finished.");
  },
  { timeout: 10000 },
);

test(
  "CLI retries revoke only current-round text and preserve reasoning in saved/resumed history",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-recovery-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    let requests = 0,
      plainAttempts = 0,
      resumedSignature = false;
    const start = {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    };
    const open = (index: number, content_block: unknown) => ({
      type: "content_block_start",
      index,
      content_block,
    });
    const close = (index: number) => ({ type: "content_block_stop", index });
    const end = (stop_reason: string) => ({
      type: "message_delta",
      delta: { stop_reason },
      usage: { output_tokens: 3 },
    });
    const emit = (res: ServerResponse, events: unknown[], broken = false) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = fixtureSse(events);
      if (broken) {
        res.write(bytes);
        setTimeout(() => res.destroy(), 10);
      } else res.end(bytes);
    };
    const server = createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = requestBody.parse(JSON.parse(data));
      const last = body.messages.at(-1);
      if (body.messages[0]?.content[0]?.text === "plain") {
        emit(
          res,
          ++plainAttempts === 1
            ? [start, open(0, { type: "text", text: "obsolete" })]
            : [
                start,
                open(0, { type: "text", text: "Only" }),
                close(0),
                end("end_turn"),
                { type: "message_stop" },
              ],
          plainAttempts === 1,
        );
        return;
      }
      if (last?.content[0]?.text === "again") {
        resumedSignature = body.messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.some(
              (b) => b.type === "thinking" && b.signature === "signed",
            ),
        );
        respond(res, { type: "text", text: "Resumed" });
        return;
      }
      requests++;
      if (requests === 1)
        emit(res, [
          start,
          open(0, { type: "text", text: "Before." }),
          close(0),
          open(1, {
            type: "tool_use",
            id: "read-once",
            name: "Read",
            input: { file_path: "a" },
          }),
          close(1),
          end("tool_use"),
          { type: "message_stop" },
        ]);
      else if (requests === 2)
        emit(res, [start, open(0, { type: "text", text: "obsolete" })], true);
      else
        emit(res, [
          start,
          open(0, { type: "thinking", thinking: "", signature: "" }),
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reason" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signed" },
          },
          close(0),
          open(1, { type: "text", text: "After." }),
          close(1),
          end("end_turn"),
          { type: "message_stop" },
        ]);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(join(temp, "a"), "data");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "loopback",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
    };
    const output = await cli(
      [
        "-p",
        "inspect",
        "--cwd",
        temp,
        "--output-format",
        "stream-json",
        "--max-api-attempts",
        "4",
      ],
      env,
    );
    assert.equal(output.code, 0, output.err);
    const events = output.out
      .trim()
      .split("\n")
      .map((line) => streamEvent.parse(JSON.parse(line)));
    const result = resultSchema.parse(events.at(-1));
    assert.equal(result.result, "After.");
    assert.equal(result.is_error, false);
    assert.deepEqual(
      events.filter((e) => e.type === "text_reset"),
      [{ type: "text_reset", text: "" }],
    );
    assert.equal(events.filter((e) => e.type === "tool_start").length, 1);
    assert.equal(requests, 3);
    const saved = await readStored(temp, result.session_id);
    assert.equal(JSON.stringify(saved.messages).includes("obsolete"), false);
    assert.equal(saved.messages.at(-1)?.content?.[0]?.signature, "signed");
    const resumed = await cli(
      [
        "-p",
        "again",
        "--cwd",
        temp,
        "--resume",
        result.session_id,
        "--output-format",
        "json",
      ],
      env,
    );
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(resumedSignature, true);
    const plain = await cli(
      ["-p", "plain", "--cwd", temp, "--max-retries", "1"],
      env,
    );
    assert.equal(plain.code, 0, plain.err);
    assert.equal(plain.out.trim(), "Only");
    assert.equal(plain.out.includes("obsolete"), false);
  },
  { timeout: 12000 },
);

test(
  "CLI ordered fallback models persist actual model metadata while each turn starts with the primary",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "tau-cli-model-fallback-"));
    onTestFinished(() => rm(temp, { recursive: true, force: true }));
    const models: string[] = [];
    const server = createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = requestBody.parse(JSON.parse(data));
      models.push(body.model);
      if (
        body.messages.at(-1)?.content[0]?.text === "again" ||
        body.model === "third"
      ) {
        respond(res, { type: "text", text: "Answer" });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
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
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "error", error: { type: "api_error", message: "unavailable" } },
      ];
      res.end(fixtureSse(events));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "loopback",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(temp, "state"),
    };
    const first = await cli(
      [
        "-p",
        "answer",
        "--cwd",
        temp,
        "--model",
        "primary",
        "--fallback-model",
        "second,third",
        "--max-retries",
        "0",
        "--max-api-attempts",
        "3",
        "--output-format",
        "json",
      ],
      env,
    );
    assert.equal(first.code, 0, first.err);
    const result = resultSchema.parse(JSON.parse(first.out));
    const saved = await readStored(temp, result.session_id);
    assert.equal(saved.model, "primary");
    assert.equal(saved.messages.at(-1)?.model, "third");
    const resumed = await cli(
      [
        "-p",
        "again",
        "--cwd",
        temp,
        "--resume",
        result.session_id,
        "--output-format",
        "json",
      ],
      env,
    );
    assert.equal(resumed.code, 0, resumed.err);
    assert.deepEqual(models, ["primary", "second", "third", "primary"]);
  },
  { timeout: 8000 },
);
