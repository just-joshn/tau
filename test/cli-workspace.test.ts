import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
import { promisify } from "node:util";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "./sse-fixture.js";

const bodySchema = z.object({
  model: z.string(),
  tools: z.array(z.object({ name: z.string() })),
  messages: z.array(
    z.object({
      content: z.array(z.object({ is_error: z.boolean().optional() })),
    }),
  ),
});
const eventSchema = z.object({ pid: z.number(), event: z.string() });

test(
  "compiled nested-Git coding uses canonical local settings and MCP project identity",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-workspace-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, "repo"),
      cwd = join(repo, "packages/app"),
      user = join(root, "config"),
      home = join(root, "home"),
      managed = join(root, "managed");
    for (const directory of [
      join(repo, ".claude"),
      join(cwd, ".claude"),
      user,
      home,
      managed,
    ])
      await mkdir(directory, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: user,
      TAU_MANAGED_ROOT: managed,
      TAU_HOME: join(root, "state"),
    };
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: repo, env });
    const log = join(root, "mcp.jsonl"),
      server = join(root, "mcp.cjs");
    await writeFile(
      server,
      String.raw`
const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
const log=event=>fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({pid:process.pid,event})+'\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
log('start');process.on('exit',()=>log('exit'));process.on('SIGTERM',()=>process.exit(0));
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'legacy'}})+'\n');
 else if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'repo',version:'1'}});
 else if(m.method==='tools/list')send(m.id,{tools:[{name:'who',inputSchema:{type:'object',properties:{}}}]});
 else if(m.method==='tools/call'){log('call');send(m.id,{content:[{type:'text',text:'canonical local server'}]});}
});
`,
    );
    await writeFile(
      join(user, ".claude.json"),
      JSON.stringify({
        projects: {
          [repo]: {
            mcpServers: {
              repo: {
                command: process.execPath,
                args: [server],
                env: { FIXTURE_LOG: log },
              },
            },
          },
        },
      }),
    );
    await writeFile(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({
        model: "claude-opus-4-6",
        permissions: { allow: ["Bash"] },
      }),
    );
    await writeFile(
      join(cwd, ".claude/settings.local.json"),
      JSON.stringify({ model: "claude-sonnet-4-5" }),
    );
    await writeFile(
      join(repo, ".claude/settings.local.json"),
      JSON.stringify({
        model: "claude-haiku-4-5",
        permissions: { allow: ["Edit", "mcp__repo__who"] },
      }),
    );
    await writeFile(join(cwd, "a.txt"), "alpha\n");
    const calls = [
      { name: "Read", input: { file_path: "a.txt" } },
      {
        name: "Edit",
        input: { file_path: "a.txt", old_string: "alpha", new_string: "beta" },
      },
      { name: "mcp__repo__who", input: {} },
    ];
    const bodies: z.infer<typeof bodySchema>[] = [];
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      const call = calls[bodies.length - 1];
      const block = call
        ? { type: "tool_use", id: `call-${bodies.length}`, ...call }
        : { type: "text", text: "Done." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
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
            delta: { stop_reason: call ? "tool_use" : "end_turn" },
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
    const result = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "--cwd",
          cwd,
          "-p",
          "code",
          "--tools",
          "Read,Edit",
          "--output-format",
          "json",
        ],
        {
          env: {
            ...env,
            ANTHROPIC_API_KEY: "dummy",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            MCP_TIMEOUT: "2000",
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
    assert.equal(result.code, 0, result.err);
    assert.equal(
      z.object({ result: z.string() }).parse(JSON.parse(result.out)).result,
      "Done.",
    );
    assert.equal(bodies.length, 4);
    assert.ok(
      bodies.every((body) => body.model === "claude-haiku-4-5-20251001"),
    );
    assert.ok(bodies[0]?.tools.some((tool) => tool.name === "mcp__repo__who"));
    assert.ok(
      bodies.slice(1).every((body) => {
        const block = body.messages.at(-1)?.content[0];
        assert.ok(block);
        return !block.is_error;
      }),
    );
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "beta\n");
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => eventSchema.parse(JSON.parse(line)));
    assert.equal(events.filter((event) => event.event === "call").length, 1);
    assert.deepEqual(
      events
        .filter((event) => event.event === "exit")
        .map((event) => event.pid),
      events
        .filter((event) => event.event === "start")
        .map((event) => event.pid),
    );
  },
  { timeout: 15000 },
);
