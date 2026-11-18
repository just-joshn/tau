import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

const requestSchema = z.object({
  messages: z.array(z.object({ content: z.unknown() })),
});
const toolResultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.string(),
});
const sessionSchema = z.object({ session_id: z.string() });
const taskSchema = z.object({
  subject: z.string(),
  status: z.string(),
  metadata: z.unknown().optional(),
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
});

function toolResult(body: unknown, id: string) {
  for (const row of requestSchema.parse(body).messages)
    for (const block of Array.isArray(row.content)
      ? row.content
      : [row.content]) {
      const parsed = toolResultSchema.safeParse(block);
      if (parsed.success && parsed.data.tool_use_id === id) return parsed.data;
    }
  return assert.fail(`missing tool_result ${id}`);
}

test(
  "compiled task workflow keeps completion rollback, cycles, metadata removal and resumed identity",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-tasks-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const config = join(root, "config"),
      log = join(root, "complete.jsonl"),
      script = join(root, "complete.cjs");
    for (const directory of [config, join(root, "home"), join(root, "managed")])
      await mkdir(directory);
    await writeFile(
      script,
      String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const fs=require('node:fs'),p=process.argv[2],old=fs.existsSync(p);fs.appendFileSync(p,raw.trim()+'\n');if(!old){process.stderr.write('OWNED_COMPLETION_HOLD');process.exitCode=2;}else process.stdout.write('{}');});`,
    );
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({
        hooks: {
          TaskCompleted: [
            {
              hooks: [
                {
                  type: "command",
                  command: process.execPath,
                  args: [script, log],
                },
              ],
            },
          ],
        },
      }),
    );
    const actions = [
      [
        "TaskCreate",
        {
          subject: "A",
          description: "owned",
          metadata: { drop: "remove", keep: true },
        },
      ],
      ["TaskCreate", { subject: "B", description: "second" }],
      [
        "TaskUpdate",
        {
          taskId: "1",
          status: "completed",
          subject: "must roll back",
          metadata: { drop: null },
          addBlocks: ["2"],
        },
      ],
      ["TaskGet", { taskId: "1" }],
      [
        "TaskUpdate",
        {
          taskId: "1",
          status: "completed",
          subject: "changed",
          metadata: { drop: null },
          addBlocks: ["2"],
        },
      ],
      ["TaskUpdate", { taskId: "1", status: "pending", addBlockedBy: ["2"] }],
      ["TaskList", {}],
      null,
      ["TaskGet", { taskId: "1" }],
    ] as const;
    const bodies: unknown[] = [];
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(JSON.parse(raw));
      const index = bodies.length - 1,
        action = actions[index];
      const block = action
        ? {
            type: "tool_use",
            name: action[0],
            input: action[1],
            id: `task-${index + 1}`,
          }
        : { type: "text", text: "done" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `unique-${index + 1}`,
              role: "assistant",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: block },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: action ? "tool_use" : "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    onTestFinished(
      () =>
        new Promise<void>((done) => {
          api.closeAllConnections();
          api.close(() => done());
        }),
    );
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    const cli = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>(
        (done, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
              "--cwd",
              root,
              "-p",
              "owned tasks",
              "--tools",
              "TaskCreate,TaskGet,TaskUpdate,TaskList",
              "--output-format",
              "json",
              ...args,
            ],
            {
              env: {
                ...process.env,
                HOME: join(root, "home"),
                CLAUDE_CONFIG_DIR: config,
                TAU_HOME: join(root, "state"),
                TAU_MANAGED_ROOT: join(root, "managed"),
                CLAUDE_CODE_ENABLE_TASKS: "1",
                CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
                CLAUDE_CODE_TASK_LIST_ID: "",
                ANTHROPIC_MODEL: "claude-sonnet-4-6",
                ANTHROPIC_API_KEY: "owned-dummy",
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let out = "",
            err = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.stderr.on("data", (chunk) => (err += chunk));
          child.on("error", reject);
          child.on("close", (code) => done({ code, out, err }));
        },
      );
    const first = await cli([]);
    assert.equal(first.code, 0, first.err);
    const result = sessionSchema.parse(JSON.parse(first.out));
    const blocked = toolResult(bodies[3], "task-3");
    assert.equal(blocked.is_error, undefined);
    assert.match(
      blocked.content,
      /TaskCompleted hook feedback:[\s\S]*OWNED_COMPLETION_HOLD/,
    );
    const retrieved = toolResult(bodies[4], "task-4");
    assert.match(retrieved.content, /A/);
    assert.match(retrieved.content, /pending/);
    assert.equal(retrieved.content.includes("must roll back"), false);
    const directory = join(config, "tasks", result.session_id);
    const a = taskSchema.parse(
        JSON.parse(await readFile(join(directory, "1.json"), "utf8")),
      ),
      b = taskSchema.parse(
        JSON.parse(await readFile(join(directory, "2.json"), "utf8")),
      );
    assert.equal(a.subject, "changed");
    assert.equal(a.status, "pending");
    assert.deepEqual(a.metadata, { keep: true });
    assert.deepEqual(a.blocks, ["2"]);
    assert.deepEqual(a.blockedBy, ["2"]);
    assert.deepEqual(b.blocks, ["1"]);
    assert.deepEqual(b.blockedBy, ["1"]);
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
    const resumed = await cli(["--resume", result.session_id]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(bodies.length, 10);
    assert.equal(
      sessionSchema.parse(JSON.parse(resumed.out)).session_id,
      result.session_id,
    );
    const resumedResult = toolResult(bodies[9], "task-9");
    assert.match(resumedResult.content, /changed/);
    assert.equal(resumedResult.is_error, undefined);
  },
  { timeout: 15000 },
);
