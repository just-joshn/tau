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
import test from "node:test";
import { fixtureSse } from "./sse-fixture.js";

test(
  "compiled plan mode writes its external designated file and resumes the same active plan",
  { timeout: 12000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-plan-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project"),
      config = join(root, "config");
    for (const directory of [
      cwd,
      config,
      join(root, "home"),
      join(root, "managed"),
    ])
      await mkdir(directory);
    const bodies: any[] = [];
    let planPath: string | undefined;
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      const notice = body.messages
        .flatMap((row: any) => row.content)
        .findLast(
          (block: any) =>
            block.type === "text" && /Session plan file: /.test(block.text),
        );
      planPath = /Session plan file: ([^\n]+)/.exec(notice?.text ?? "")?.[1];
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
    t.after(
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
              fileURLToPath(new URL("../src/cli.js", import.meta.url)),
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
    const result = JSON.parse(first.out);
    assert.equal(result.result, "Plan prepared.");
    assert.ok(planPath?.startsWith(join(config, "plans") + "/"));
    assert.equal(await readFile(planPath!, "utf8"), "# Reviewed plan\n");
    assert.ok(
      bodies
        .slice(1, 4)
        .every(
          (body) =>
            !body.messages
              .flatMap((row: any) => row.content)
              .findLast((block: any) => block.type === "tool_result")?.is_error,
        ),
    );
    const before = planPath;
    const resumed = await cli(["--resume", result.session_id]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(planPath, before);
    assert.equal(bodies.length, 6);
    assert.ok(
      bodies.every((body) =>
        body.tools.every((tool: any) =>
          ["Read", "Write", "Edit"].includes(tool.name),
        ),
      ),
    );
    const read = bodies[5].messages
      .flatMap((row: any) => row.content)
      .find(
        (block: any) =>
          block.type === "tool_result" && block.tool_use_id === "plan-5",
      );
    assert.match(read.content, /Reviewed plan/);
  },
);

test(
  "compiled headless Plan approval uses a hidden MCP bridge, retains rejection, then exits",
  { timeout: 18000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-cli-plan-bridge-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
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
    const bodies: any[] = [];
    let planPath: string | undefined;
    const api = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      const index = bodies.length;
      const notice = body.messages
        .flatMap((row: any) => row.content)
        .findLast(
          (block: any) =>
            block.type === "text" && /Session plan file: /.test(block.text),
        );
      planPath =
        /Session plan file: ([^\n]+)/.exec(notice?.text ?? "")?.[1] ?? planPath;
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
    t.after(
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
          fileURLToPath(new URL("../src/cli.js", import.meta.url)),
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
    assert.equal(JSON.parse(output.out).result, "Plan approved.");
    assert.equal(bodies.length, 8);
    assert.ok(
      bodies.every(
        (body) =>
          !body.tools.some(
            (tool: any) => tool.name === "mcp__ownedplans__decide",
          ),
      ),
    );
    const denied = bodies[3].messages
      .flatMap((row: any) => row.content)
      .find(
        (block: any) =>
          block.type === "tool_result" && block.tool_use_id === "owned-3",
      );
    assert.equal(denied.is_error, true);
    assert.match(denied.content, /OWNED_PLAN_REJECTION/);
    const outside = bodies[7].messages
      .flatMap((row: any) => row.content)
      .find(
        (block: any) =>
          block.type === "tool_result" && block.tool_use_id === "owned-7",
      );
    assert.equal(outside.is_error, true);
    assert.match(outside.content, /Enter plan mode/);
    assert.equal(await readFile(planPath!, "utf8"), "# Reviewed plan\n");
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decisions = events.filter((event) => event.event === "decision");
    assert.deepEqual(
      decisions.map((event) => [
        event.input.tool_name,
        event.input.tool_use_id,
      ]),
      [
        ["ExitPlanMode", "owned-3"],
        ["ExitPlanMode", "owned-6"],
      ],
    );
    assert.equal(decisions[0].input.input.plan, "# Owned plan\n");
    assert.equal(decisions[1].input.input.plan, "# Reviewed plan\n");
    assert.deepEqual(
      events
        .filter((event) => event.event === "exit")
        .map((event) => event.pid),
      events
        .filter((event) => event.event === "start")
        .map((event) => event.pid),
    );
  },
);
