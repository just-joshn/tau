import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureSse } from "./sse-fixture.js";

test("compiled task workflow keeps completion rollback, cycles, metadata removal and resumed identity", { timeout: 15000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-tasks-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), log = join(root, "complete.jsonl"), script = join(root, "complete.cjs");
  for (const directory of [config, join(root, "home"), join(root, "managed")]) await mkdir(directory);
  await writeFile(script, String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const fs=require('node:fs'),p=process.argv[2],old=fs.existsSync(p);fs.appendFileSync(p,raw.trim()+'\n');if(!old){process.stderr.write('OWNED_COMPLETION_HOLD');process.exitCode=2;}else process.stdout.write('{}');});`);
  await writeFile(join(config, "settings.json"), JSON.stringify({ hooks: { TaskCompleted: [{ hooks: [{ type: "command", command: process.execPath, args: [script, log] }] }] } }));
  const actions = [
    ["TaskCreate", { subject: "A", description: "owned", metadata: { drop: "remove", keep: true } }],
    ["TaskCreate", { subject: "B", description: "second" }],
    ["TaskUpdate", { taskId: "1", status: "completed", subject: "must roll back", metadata: { drop: null }, addBlocks: ["2"] }],
    ["TaskGet", { taskId: "1" }],
    ["TaskUpdate", { taskId: "1", status: "completed", subject: "changed", metadata: { drop: null }, addBlocks: ["2"] }],
    ["TaskUpdate", { taskId: "1", status: "pending", addBlockedBy: ["2"] }],
    ["TaskList", {}],
    null,
    ["TaskGet", { taskId: "1" }],
  ] as const;
  const bodies: any[] = [];
  const api = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw)); const index = bodies.length - 1, action = actions[index];
    const block = action ? { type: "tool_use", name: action[0], input: action[1], id: `task-${index + 1}` } : { type: "text", text: "done" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(fixtureSse([{ type: "message_start", message: { id: `unique-${index + 1}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: action ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]));
  });
  t.after(() => new Promise<void>(done => { api.closeAllConnections(); api.close(() => done()); }));
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "--cwd", root, "-p", "owned tasks", "--tools", "TaskCreate,TaskGet,TaskUpdate,TaskList", "--output-format", "json", ...args], {
      env: { ...process.env, HOME: join(root, "home"), CLAUDE_CONFIG_DIR: config, TAU_HOME: join(root, "state"), TAU_MANAGED_ROOT: join(root, "managed"),
        CLAUDE_CODE_ENABLE_TASKS: "1", CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_TASK_LIST_ID: "", ANTHROPIC_MODEL: "claude-sonnet-4-6",
        ANTHROPIC_API_KEY: "owned-dummy", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
    child.on("error", reject); child.on("close", code => done({ code, out, err }));
  });
  const first = await cli([]); assert.equal(first.code, 0, first.err); const result = JSON.parse(first.out);
  const blocked = bodies[3].messages.flatMap((row: any) => row.content).find((block: any) => block.type === "tool_result" && block.tool_use_id === "task-3");
  assert.equal(blocked.is_error, undefined); assert.match(blocked.content, /TaskCompleted hook feedback:[\s\S]*OWNED_COMPLETION_HOLD/);
  const retrieved = bodies[4].messages.flatMap((row: any) => row.content).find((block: any) => block.type === "tool_result" && block.tool_use_id === "task-4");
  assert.match(retrieved.content, /A/); assert.match(retrieved.content, /pending/); assert.equal(retrieved.content.includes("must roll back"), false);
  const directory = join(config, "tasks", result.session_id);
  const a = JSON.parse(await readFile(join(directory, "1.json"), "utf8")), b = JSON.parse(await readFile(join(directory, "2.json"), "utf8"));
  assert.equal(a.subject, "changed"); assert.equal(a.status, "pending"); assert.deepEqual(a.metadata, { keep: true });
  assert.deepEqual(a.blocks, ["2"]); assert.deepEqual(a.blockedBy, ["2"]); assert.deepEqual(b.blocks, ["1"]); assert.deepEqual(b.blockedBy, ["1"]);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
  const resumed = await cli(["--resume", result.session_id]); assert.equal(resumed.code, 0, resumed.err);
  assert.equal(bodies.length, 10); assert.equal(JSON.parse(resumed.out).session_id, result.session_id);
  const resumedResult = bodies[9].messages.flatMap((row: any) => row.content).find((block: any) => block.type === "tool_result" && block.tool_use_id === "task-9");
  assert.match(resumedResult.content, /changed/); assert.equal(resumedResult.is_error, undefined);
});
