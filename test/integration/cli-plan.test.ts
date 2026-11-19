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

const bodySchema = z.object({
  messages: z.array(
    z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
  ),
  tools: z.array(z.object({ name: z.string() })),
});
type Body = z.infer<typeof bodySchema>;
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const toolResultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.string(),
});
const printSchema = z.object({ session_id: z.string(), result: z.string() });
const peerEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("decision"),
    input: z.object({
      tool_name: z.string(),
      tool_use_id: z.string(),
      input: z.object({ plan: z.string() }),
    }),
  }),
  z.object({ event: z.enum(["start", "exit"]), pid: z.number() }),
]);

const blocks = (body: Body) =>
  body.messages.flatMap((row) =>
    typeof row.content === "string" ? [] : row.content,
  );
const toolResults = (body: Body) =>
  blocks(body).flatMap((block) => {
    const parsed = toolResultSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
function toolResult(body: Body | undefined, id: string) {
  const found = body && toolResults(body).find((r) => r.tool_use_id === id);
  return found ?? assert.fail(`missing tool_result ${id}`);
}
const planNotice = (body: Body) =>
  blocks(body)
    .flatMap((block) => {
      const parsed = textBlockSchema.safeParse(block);
      return parsed.success ? [parsed.data.text] : [];
    })
    .findLast((text) => /Session plan file: /.test(text));

test(
  "compiled plan mode writes its external designated file and resumes the same active plan",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-plan-")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project"),
      config = join(root, "config");
    for (const directory of [
      cwd,
      config,
      join(root, "home"),
      join(root, "managed"),
    ])
      await mkdir(directory);
    const bodies: Body[] = [];
    let planPath: string | undefined;
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      const notice = planNotice(body);
      planPath = /Session plan file: ([^\n]+)/.exec(notice ?? "")?.[1];
      const index = bodies.length;
      const action =
        index === 1
          ? {
              name: "Write",
              input: { file_path: planPath, content: "# Owned plan\n" },
            }
          : index === 2 || index === 5
            ? { name: "Read", input: { file_path: planPath } }
            : index === 3
              ? {
                  name: "Edit",
                  input: {
                    file_path: planPath,
                    old_string: "Owned",
                    new_string: "Reviewed",
                  },
                }
              : undefined;
      const block = action
        ? { type: "tool_use", id: `plan-${index}`, ...action }
        : { type: "text", text: "Plan prepared." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `unique-${index}`,
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
    const cli = (flags: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>(
        (done, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
              "--cwd",
              cwd,
              "-p",
              "prepare owned plan",
              "--tools",
              "Read,Write,Edit",
              "--output-format",
              "json",
              ...flags,
            ],
            {
              env: {
                ...process.env,
                HOME: join(root, "home"),
                CLAUDE_CONFIG_DIR: config,
                TAU_HOME: join(root, "state"),
                TAU_MANAGED_ROOT: join(root, "managed"),
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
    const first = await cli(["--permission-mode", "plan"]);
    assert.equal(first.code, 0, first.err);
    const result = printSchema.parse(JSON.parse(first.out));
    assert.equal(result.result, "Plan prepared.");
    const designated = planPath;
    assert.ok(designated);
    assert.ok(designated.startsWith(join(config, "plans") + "/"));
    assert.equal(await readFile(designated, "utf8"), "# Reviewed plan\n");
    assert.ok(
      bodies.slice(1, 4).every((body) => !toolResults(body).at(-1)?.is_error),
    );
    const before = planPath;
    const resumed = await cli(["--resume", result.session_id]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(planPath, before);
    assert.equal(bodies.length, 6);
    assert.ok(
      bodies.every((body) =>
        body.tools.every((tool) =>
          ["Read", "Write", "Edit"].includes(tool.name),
        ),
      ),
    );
    const read = toolResult(bodies[5], "plan-5");
    assert.match(read.content, /Reviewed plan/);
  },
  { timeout: 12000 },
);

test(
  "compiled headless Plan approval uses a hidden MCP bridge, retains rejection, then exits",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-plan-bridge-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project"),
      config = join(root, "config"),
      peer = join(root, "peer.cjs"),
      log = join(root, "peer.jsonl");
    for (const directory of [
      cwd,
      config,
      join(root, "home"),
      join(root, "managed"),
    ])
      await mkdir(directory);
    await writeFile(
      peer,
      String.raw`
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});let decisions=0;
const log=event=>fs.appendFileSync(process.argv[2],JSON.stringify({...event,pid:process.pid})+'\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');log({event:'start'});
process.on('exit',()=>log({event:'exit'}));process.on('SIGTERM',()=>process.exit(0));rl.on('close',()=>process.exit(0));
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'legacy'}})+'\n');
else if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'ownedplans',version:'1'}});
else if(m.method==='tools/list')send(m.id,{tools:[{name:'decide',description:'Owned test permission channel',inputSchema:{type:'object'}}]});
else if(m.method==='tools/call'){log({event:'decision',input:m.params.arguments});const approved=++decisions>1;send(m.id,{content:[{type:'text',text:JSON.stringify(approved?{behavior:'allow',updatedInput:m.params.arguments.input}:{behavior:'deny',message:'OWNED_PLAN_REJECTION'})}]});}
});
`,
    );
    const bodies: Body[] = [];
    let planPath: string | undefined;
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      const index = bodies.length;
      const notice = planNotice(body);
      planPath =
        /Session plan file: ([^\n]+)/.exec(notice ?? "")?.[1] ?? planPath;
      const action =
        index === 1
          ? { name: "EnterPlanMode", input: {} }
          : index === 2
            ? {
                name: "Write",
                input: { file_path: planPath, content: "# Owned plan\n" },
              }
            : index === 3 || index === 6 || index === 7
              ? { name: "ExitPlanMode", input: {} }
              : index === 4
                ? { name: "Read", input: { file_path: planPath } }
                : index === 5
                  ? {
                      name: "Edit",
                      input: {
                        file_path: planPath,
                        old_string: "Owned",
                        new_string: "Reviewed",
                      },
                    }
                  : undefined;
      const block = action
        ? { type: "tool_use", id: `owned-${index}`, ...action }
        : { type: "text", text: "Plan approved." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `response-${index}`,
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
    const output = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
          "--cwd",
          cwd,
          "-p",
          "prepare owned plan",
          "--output-format",
          "json",
          "--tools",
          "EnterPlanMode,ExitPlanMode,Read,Write,Edit",
          "--mcp-config",
          JSON.stringify({
            mcpServers: {
              ownedplans: { command: process.execPath, args: [peer, log] },
            },
          }),
          "--strict-mcp-config",
          "--permission-prompt-tool",
          "mcp__ownedplans__decide",
          "--permission-prompts",
          "host",
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: config,
            TAU_HOME: join(root, "state"),
            TAU_MANAGED_ROOT: join(root, "managed"),
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
    });
    assert.equal(output.code, 0, output.err);
    assert.equal(
      printSchema.parse(JSON.parse(output.out)).result,
      "Plan approved.",
    );
    assert.equal(bodies.length, 8);
    assert.ok(
      bodies.every(
        (body) =>
          !body.tools.some((tool) => tool.name === "mcp__ownedplans__decide"),
      ),
    );
    const denied = toolResult(bodies[3], "owned-3");
    assert.equal(denied.is_error, true);
    assert.match(denied.content, /OWNED_PLAN_REJECTION/);
    const outside = toolResult(bodies[7], "owned-7");
    assert.equal(outside.is_error, true);
    assert.match(outside.content, /Enter plan mode/);
    assert.ok(planPath);
    assert.equal(await readFile(planPath, "utf8"), "# Reviewed plan\n");
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => peerEventSchema.parse(JSON.parse(line)));
    const decisions = events.flatMap((event) =>
      event.event === "decision" ? [event.input] : [],
    );
    const pids = (kind: "start" | "exit") =>
      events.flatMap((event) =>
        event.event === kind && "pid" in event ? [event.pid] : [],
      );
    assert.deepEqual(
      decisions.map((input) => [input.tool_name, input.tool_use_id]),
      [
        ["ExitPlanMode", "owned-3"],
        ["ExitPlanMode", "owned-6"],
      ],
    );
    assert.deepEqual(
      decisions.map((input) => input.input.plan),
      ["# Owned plan\n", "# Reviewed plan\n"],
    );
    assert.deepEqual(pids("exit"), pids("start"));
  },
  { timeout: 18000 },
);
