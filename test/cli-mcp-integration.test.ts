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
import { join, resolve } from "node:path";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "./sse-fixture.js";

const serverSource = String.raw`
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const log=value=>appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({pid:process.pid,origin:process.env.FIXTURE_ORIGIN,...value})+'\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const tool=name=>({name,description:'fixture lookup',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{query:{type:'object'}}}});
let changed=false;
log({event:'start'});
process.on('exit',()=>log({event:'exit'}));
process.on('SIGTERM',()=>process.exit(0));
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); log({event:'request',method:message.method,params:message.params});
 if(message.method==='server/discover') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'legacy fixture'}})+'\n');
 else if(message.method==='initialize') send(message.id,{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}});
 else if(message.method==='tools/list') send(message.id,{tools:[tool('lookup'),...(changed?[tool('followup')]:[])]});
 else if(message.method==='tools/call') {
  log({event:'called',arguments:message.params.arguments});
  changed=true;
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');
  send(message.id,{content:[{type:'text',text:'ordinary text replaced by structure'},
   {type:'image',mimeType:'image/png',data:'aW1hZ2U='}],structuredContent:{found:message.params.arguments.query},_meta:{local:'retained'}});
 }
});

`;

const requestBody = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  messages: z.array(
    z.looseObject({
      content: z.array(
        z.looseObject({
          type: z.string(),
          content: z.unknown().optional(),
          is_error: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
const cliResult = z.looseObject({ result: z.string() });
const sessionResult = cliResult.extend({ session_id: z.string() });
const fixtureEvent = z.looseObject({
  event: z.string(),
  pid: z.number(),
  origin: z.string().optional(),
  arguments: z.unknown().optional(),
});

function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) assert.fail(`no item at index ${String(index)}`);
  return item;
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("src/cli.ts"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, out, err }));
  });
}

test(
  "compiled MCP config→discovery→permitted rich call→refresh→save/resume and denied calls close every server",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-mcp-")),
    );
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const script = join(directory, "fixture.cjs"),
      log = join(directory, "events.jsonl"),
      config = join(directory, "mcp.json");
    await writeFile(script, serverSource);
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [script],
            env: { FIXTURE_LOG: log },
          },
        },
      }),
    );
    const bodies: unknown[] = [];
    const sentBody = (index: number) => requestBody.parse(bodies.at(index));
    let scenario = "allowed",
      request = 0;
    const api = createServer(async (incoming, response) => {
      let raw = "";
      for await (const chunk of incoming) raw += chunk;
      const body: unknown = JSON.parse(raw);
      bodies.push(body);
      request++;
      const content =
        scenario === "resume" || request === 2
          ? { type: "text", text: scenario === "resume" ? "Resumed." : "Done." }
          : {
              type: "tool_use",
              id: "mcp-call",
              name: "mcp__fixture__lookup",
              input: { query: { labels: ["a", "b"], limit: 2 } },
            };
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
          { type: "content_block_start", index: 0, content_block: content },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason:
                content.type === "tool_use" ? "tool_use" : "end_turn",
            },
            usage: { output_tokens: 4 },
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
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "dummy",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      TAU_HOME: join(directory, "state"),
      MCP_PROTOCOL_NEGOTIATION: "auto",
      MCP_TIMEOUT: "3000",
      CLAUDE_CODE_DISABLE_AUTO_COMPACT: "1",
    };
    const args = [
      "-p",
      "lookup",
      "--cwd",
      directory,
      "--mcp-config",
      config,
      "--tools",
      "",
      "--output-format",
      "json",
    ];
    const allowed = await run(
      [...args, "--allowedTools", "mcp__fixture__lookup"],
      env,
    );
    assert.equal(allowed.code, 0, allowed.err);
    const result = sessionResult.parse(JSON.parse(allowed.out));
    assert.equal(result.result, "Done.");
    assert.deepEqual(
      sentBody(0).tools.map((tool) => tool.name),
      ["mcp__fixture__lookup"],
    );
    assert.deepEqual(
      sentBody(1).tools.map((tool) => tool.name),
      ["mcp__fixture__lookup", "mcp__fixture__followup"],
    );
    const returned = at(at(sentBody(1).messages, -1).content, 0);
    assert.deepEqual(returned.content, [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
      { type: "text", text: '{"found":{"labels":["a","b"],"limit":2}}' },
    ]);
    assert.equal(JSON.stringify(bodies).includes('"_meta"'), false);
    scenario = "resume";
    request = 0;
    const resumed = await run([...args, "--resume", result.session_id], env);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(cliResult.parse(JSON.parse(resumed.out)).result, "Resumed.");
    const resumedToolMessage = sentBody(-1).messages.find((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    assert.ok(resumedToolMessage);
    assert.deepEqual(resumedToolMessage.content[0], returned);
    for (const flags of [
      [],
      [
        "--allowedTools",
        "mcp__fixture__lookup",
        "--disallowedTools",
        "mcp__fixture__lookup",
      ],
    ]) {
      scenario = "denied";
      request = 0;
      const denied = await run([...args, ...flags], env);
      assert.equal(denied.code, 0, denied.err);
      const error = at(at(sentBody(-1).messages, -1).content, 0);
      assert.equal(error.is_error, true);
      assert.ok(typeof error.content === "string");
      assert.match(error.content, /Permission denied|denied by policy/);
    }
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((row) => fixtureEvent.parse(JSON.parse(row)));
    assert.equal(events.filter((event) => event.event === "called").length, 1);
    const called = events.find((event) => event.event === "called");
    assert.ok(called);
    assert.deepEqual(called.arguments, {
      query: { labels: ["a", "b"], limit: 2 },
    });
    const started = events
      .filter((event) => event.event === "start")
      .map((event) => event.pid)
      .sort((a, b) => a - b);
    const exited = events
      .filter((event) => event.event === "exit")
      .map((event) => event.pid)
      .sort((a, b) => a - b);
    assert.equal(started.length, 4);
    assert.deepEqual(exited, started);
  },
  { timeout: 20000 },
);

test(
  "compiled MCP autoload selects scopes before connecting and honors strict, rejection, overrides and local disables",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-mcp-scopes-")),
    );
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "work"),
      user = join(root, "user"),
      managed = join(root, "managed");
    for (const directory of [join(cwd, ".claude"), user, managed])
      await mkdir(directory, { recursive: true });
    const script = join(root, "fixture.cjs"),
      log = join(root, "events.jsonl"),
      explicit = join(root, "explicit.json");
    await writeFile(script, serverSource);
    const config = (origin: string) => ({
      command: process.execPath,
      args: [script],
      env: { FIXTURE_LOG: log, FIXTURE_ORIGIN: origin },
    });
    const global = (disabled: string[] = []) => ({
      mcpServers: { fixture: config("user") },
      projects: {
        [cwd]: {
          mcpServers: { fixture: config("local") },
          disabledMcpServers: disabled,
        },
      },
    });
    await writeFile(join(user, ".claude.json"), JSON.stringify(global()));
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { fixture: config("ancestor") } }),
    );
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { fixture: config("project") } }),
    );
    await writeFile(
      explicit,
      JSON.stringify({ mcpServers: { fixture: config("explicit") } }),
    );
    const bodies: unknown[] = [];
    let firstRequest = true;
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = requestBody.parse(JSON.parse(raw));
      bodies.push(body);
      const call =
        firstRequest &&
        body.tools.some((tool) => tool.name === "mcp__fixture__lookup");
      firstRequest = false;
      const block = call
        ? {
            type: "tool_use",
            id: "scope-call",
            name: "mcp__fixture__lookup",
            input: { query: { fixture: "scope" } },
          }
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
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: user,
      TAU_MANAGED_ROOT: managed,
      TAU_HOME: join(root, "state"),
      ANTHROPIC_API_KEY: "dummy",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      MCP_TIMEOUT: "2000",
    };
    const scenarios: Array<{
      flags: string[];
      origin?: string;
      rejected?: boolean;
      disabled?: boolean;
    }> = [
      { flags: [], origin: "local" },
      { flags: ["--setting-sources", "user"], origin: "user" },
      { flags: ["--setting-sources", "project"], origin: "project" },
      { flags: ["--setting-sources", "local"], origin: "local" },
      { flags: ["--setting-sources", ""] },
      { flags: ["--mcp-config", explicit], origin: "explicit" },
      { flags: ["--strict-mcp-config"] },
      {
        flags: ["--strict-mcp-config", "--mcp-config", explicit],
        origin: "explicit",
      },
      {
        flags: ["--setting-sources", "user,project"],
        origin: "user",
        rejected: true,
      },
      {
        flags: ["--strict-mcp-config", "--mcp-config", explicit],
        disabled: true,
      },
    ];
    for (const scenario of scenarios) {
      await writeFile(log, "");
      firstRequest = true;
      const start = bodies.length;
      await writeFile(
        join(user, ".claude.json"),
        JSON.stringify(global(scenario.disabled ? ["fixture"] : [])),
      );
      await writeFile(
        join(cwd, ".claude/settings.json"),
        JSON.stringify({
          disabledMcpjsonServers: scenario.rejected ? ["fixture"] : [],
        }),
      );
      const result = await run(
        [
          "-p",
          "lookup",
          "--cwd",
          cwd,
          "--tools",
          "",
          "--allowedTools",
          "mcp__fixture__lookup",
          "--output-format",
          "json",
          ...scenario.flags,
        ],
        env,
      );
      assert.equal(result.code, 0, result.err);
      const events = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => fixtureEvent.parse(JSON.parse(line)));
      assert.deepEqual(
        events
          .filter((event) => event.event === "start")
          .map((event) => event.origin),
        scenario.origin ? [scenario.origin] : [],
      );
      assert.equal(
        events.filter((event) => event.event === "called").length,
        scenario.origin ? 1 : 0,
      );
      assert.equal(bodies.length - start, scenario.origin ? 2 : 1);
      const started = events
        .filter((event) => event.event === "start")
        .map((event) => event.pid)
        .sort((a, b) => a - b);
      assert.deepEqual(
        events
          .filter((event) => event.event === "exit")
          .map((event) => event.pid)
          .sort((a, b) => a - b),
        started,
      );
    }
  },
  { timeout: 20000 },
);
