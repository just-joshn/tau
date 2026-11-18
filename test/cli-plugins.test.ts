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
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "./sse-fixture.js";

const requestBodySchema = z.looseObject({
  system: z.unknown().optional(),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.array(
        z.looseObject({
          type: z.string(),
          text: z.string().optional(),
          tool_use_id: z.string().optional(),
          content: z.unknown().optional(),
          is_error: z.unknown().optional(),
        }),
      ),
    }),
  ),
  tools: z.array(
    z.looseObject({ name: z.string(), description: z.string().optional() }),
  ),
});
type RequestBody = z.infer<typeof requestBodySchema>;
type ReplyBlock = Record<string, unknown> & { type: string };
const hookRowSchema = z.looseObject({
  input: z.looseObject({
    tool_name: z.string(),
    permission_mode: z.string().optional(),
  }),
  root: z.string(),
});
const mcpRowSchema = z.looseObject({
  pid: z.number(),
  event: z.string(),
  method: z.string().optional(),
  root: z.string().optional(),
  data: z.string().optional(),
  state: z.string().optional(),
});
function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function bodyAt(bodies: readonly RequestBody[], index: number): RequestBody {
  return present(bodies[index]);
}
function toolNamed(body: RequestBody, name: string) {
  return body.tools.find((entry) => entry.name === name);
}
async function readRows<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((row) => schema.parse(JSON.parse(row)));
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-cli-plugins-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    plugin = join(root, "owned-plugin"),
    config = join(root, "config"),
    log = join(root, "hooks.jsonl");
  for (const path of [
    cwd,
    config,
    join(root, "home"),
    join(root, "managed"),
    join(plugin, ".claude-plugin"),
    join(plugin, "commands"),
    join(plugin, "skills", "prepare"),
    join(plugin, "agents"),
    join(plugin, "hooks"),
  ])
    await mkdir(path, { recursive: true });
  const manifest = join(plugin, ".claude-plugin", "plugin.json");
  await writeFile(manifest, JSON.stringify({ name: "owned" }));
  await writeFile(
    join(plugin, "skills", "prepare", "SKILL.md"),
    "---\ndescription: Owned preparation\nallowed-tools: Write\n---\nPLUGIN_PREPARE_BODY $ARGUMENTS ${CLAUDE_PLUGIN_ROOT}",
  );
  await writeFile(
    join(plugin, "commands", "legacy.md"),
    "---\ndescription: Owned legacy command\n---\nLEGACY_BODY $ARGUMENTS",
  );
  await writeFile(
    join(plugin, "agents", "reader.md"),
    "---\nname: reader\ndescription: Read an owned result\ntools: Read\nmodel: inherit\npermissionMode: bypassPermissions\n---\nPLUGIN_CHILD_MARKER",
  );
  await writeFile(
    join(plugin, "hook.cjs"),
    String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{require('node:fs').appendFileSync(process.argv[2],JSON.stringify({input:JSON.parse(raw),root:process.env.CLAUDE_PLUGIN_ROOT})+'\n');process.stdout.write('{}');});`,
  );
  await writeFile(
    join(plugin, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Read|Write",
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: ["${CLAUDE_PLUGIN_ROOT}/hook.cjs", log],
              },
            ],
          },
        ],
      },
    }),
  );
  let responder: (body: RequestBody, index: number) => ReplyBlock = () => ({
    type: "text",
    text: "done",
  });
  const bodies: RequestBody[] = [];
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = requestBodySchema.parse(JSON.parse(raw));
    bodies.push(body);
    const block = responder(body, bodies.length);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      fixtureSse([
        {
          type: "message_start",
          message: {
            id: `plugin-response-${bodies.length}`,
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
          usage: { output_tokens: 3 },
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
  const cli = (prompt = "owned plugin workflow", args: string[] = []) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
            "--cwd",
            cwd,
            "-p",
            prompt,
            "--plugin-dir",
            plugin,
            "--tools",
            "Skill,Read,Write,Agent",
            "--model",
            "claude-sonnet-4-6",
            "--output-format",
            "json",
            ...args,
          ],
          {
            env: {
              ...process.env,
              HOME: join(root, "home"),
              CLAUDE_CONFIG_DIR: config,
              TAU_MANAGED_ROOT: join(root, "managed"),
              TAU_HOME: join(root, "state"),
              CLAUDE_CODE_FORK_SUBAGENT: "0",
              CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
              CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "",
              CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "0",
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
  return {
    root,
    cwd,
    plugin,
    config,
    managed: join(root, "managed"),
    manifest,
    log,
    bodies,
    cli,
    respond: (fn: typeof responder) => {
      responder = fn;
    },
  };
}
const tool = (name: string, input: unknown, id: number) => ({
  type: "tool_use",
  name,
  input,
  id: `plugin-call-${id}`,
});
const result = (body: RequestBody, id: number) =>
  present(
    body.messages
      .flatMap((row) => row.content)
      .find(
        (block) =>
          block.type === "tool_result" &&
          block.tool_use_id === `plugin-call-${id}`,
      ),
  );

test(
  "compiled explicit plugin Skill→Write→Agent→Read registers namespaces, grants and hook origins",
  async () => {
    const f = await fixture();
    f.respond((_body, index) =>
      index === 1
        ? tool(
            "Skill",
            { skill: "owned:prepare", args: "owned-argument" },
            index,
          )
        : index === 2
          ? tool(
              "Write",
              { file_path: "result.txt", content: "OWNED_PLUGIN_FILE" },
              index,
            )
          : index === 3
            ? tool(
                "Agent",
                {
                  description: "Read plugin output",
                  prompt: "Read result.txt",
                  subagent_type: "owned:reader",
                  run_in_background: false,
                },
                index,
              )
            : index === 4
              ? tool("Read", { file_path: "result.txt" }, index)
              : {
                  type: "text",
                  text: index === 5 ? "PLUGIN_CHILD_REPORT" : "PLUGIN_DONE",
                },
    );
    const execution = await f.cli("owned workflow", [
      "--allowed-tools",
      "Skill(owned:prepare)",
    ]);
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 6);
    assert.equal(
      await readFile(join(f.cwd, "result.txt"), "utf8"),
      "OWNED_PLUGIN_FILE",
    );
    assert.match(
      JSON.stringify(bodyAt(f.bodies, 1).messages),
      /PLUGIN_PREPARE_BODY owned-argument/,
    );
    assert.match(JSON.stringify(bodyAt(f.bodies, 1).messages), /owned-plugin/);
    assert.match(
      JSON.stringify(bodyAt(f.bodies, 3).system),
      /PLUGIN_CHILD_MARKER/,
    );
    assert.deepEqual(
      bodyAt(f.bodies, 3).tools.map((entry) => entry.name),
      ["Read"],
    );
    const readContent = result(bodyAt(f.bodies, 4), 4).content;
    assert.ok(typeof readContent === "string");
    assert.match(readContent, /OWNED_PLUGIN_FILE/);
    assert.match(
      JSON.stringify(result(bodyAt(f.bodies, 5), 3).content),
      /PLUGIN_CHILD_REPORT/,
    );
    const rows = await readRows(f.log, hookRowSchema);
    assert.deepEqual(
      rows.map((row) => row.input.tool_name),
      ["Write", "Read"],
    );
    assert.ok(rows.every((row) => row.root === f.plugin));
    assert.equal(
      present(rows[1]).input.permission_mode,
      "default",
      "Plugin agent frontmatter cannot activate bypass mode",
    );
  },
  { timeout: 15000 },
);

test(
  "compiled plugin legacy slash command keeps command invocation without a skill base-directory prefix",
  async () => {
    const f = await fixture();
    const execution = await f.cli("/owned:legacy owned-argument", [
      "--setting-sources",
      "",
    ]);
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 1);
    const expanded = bodyAt(f.bodies, 0)
      .messages.flatMap((row) => row.content)
      .filter(
        (block) => block.type === "text" && block.text?.includes("LEGACY_BODY"),
      );
    assert.equal(expanded.length, 1);
    const expandedText = present(present(expanded[0]).text);
    assert.match(expandedText, /LEGACY_BODY owned-argument/);
    assert.equal(
      expandedText.includes("Base directory for this skill:"),
      false,
    );
  },
  { timeout: 15000 },
);

test(
  "compiled disabled, managed-locked and missing-dependency plugins have no active prompts, agents or hooks",
  async () => {
    const f = await fixture();
    for (const [settings, managed, dependencies] of [
      [{ enabledPlugins: { "owned@inline": false } }, undefined, undefined],
      [{}, { enabledPlugins: { "owned@market": false } }, undefined],
      [{}, { enabledPlugins: { "owned@market": true } }, undefined],
      [{}, { disableSideloadFlags: true }, undefined],
      [{}, undefined, ["missing"]],
    ] as const) {
      await writeFile(
        join(f.config, "settings.json"),
        JSON.stringify(settings),
      );
      await writeFile(
        join(f.managed, "managed-settings.json"),
        JSON.stringify(managed ?? {}),
      );
      await writeFile(
        f.manifest,
        JSON.stringify({
          name: "owned",
          ...(dependencies ? { dependencies } : {}),
        }),
      );
      f.bodies.length = 0;
      f.respond((_body, index) =>
        index === 1
          ? tool("Skill", { skill: "owned:prepare" }, index)
          : { type: "text", text: "held" },
      );
      const execution = await f.cli("owned refusal");
      assert.equal(execution.code, 0, execution.err);
      assert.equal(f.bodies.length, 2);
      assert.equal(result(bodyAt(f.bodies, 1), 1).is_error, true);
      assert.equal(
        bodyAt(f.bodies, 0).tools.some((entry) => entry.name === "Skill"),
        false,
        JSON.stringify({
          settings,
          managed,
          dependencies,
          tools: bodyAt(f.bodies, 0).tools.map((entry) => entry.name),
          diagnostics: execution.err,
        }),
      );
      assert.equal(
        JSON.stringify(bodyAt(f.bodies, 0).messages).includes("owned:reader"),
        false,
      );
      await assert.rejects(readFile(f.log), { code: "ENOENT" });
      assert.equal(
        JSON.stringify(f.bodies).includes("PLUGIN_PREPARE_BODY"),
        false,
      );
    }
  },
  { timeout: 15000 },
);

test(
  "plugin-only customization retains inline skills and agents while withholding ordinary customizations",
  async () => {
    const f = await fixture(),
      marker = join(f.root, "ordinary-hook-ran");
    await mkdir(join(f.config, "skills", "ordinary"), { recursive: true });
    await mkdir(join(f.config, "agents"));
    await writeFile(
      join(f.config, "skills", "ordinary", "SKILL.md"),
      "---\ndescription: Ordinary forbidden catalog\n---\nORDINARY_BODY",
    );
    await writeFile(
      join(f.config, "agents", "ordinary.md"),
      "---\nname: ordinary\ndescription: Ordinary forbidden agent\n---\nORDINARY_AGENT",
    );
    await writeFile(
      join(f.config, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: process.execPath,
                  args: [
                    "-e",
                    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const execution = await f.cli("owned catalogs", [
      "--managed-settings",
      JSON.stringify({
        strictPluginOnlyCustomization: ["skills", "agents", "hooks"],
      }),
    ]);
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 1);
    const skill = present(toolNamed(bodyAt(f.bodies, 0), "Skill")),
      agent = present(toolNamed(bodyAt(f.bodies, 0), "Agent"));
    assert.equal(present(skill.description).includes("owned:prepare"), false);
    assert.equal(present(agent.description).includes("owned:reader"), false);
    const catalogs = bodyAt(f.bodies, 0)
      .messages.filter((message) => message.role === "user")
      .flatMap((message) => message.content)
      .filter(
        (block) =>
          block.type === "text" && block.text?.includes("<system-reminder>"),
      );
    assert.match(
      catalogs.find((block) => block.text?.includes("Agent types available"))
        ?.text ?? "",
      /owned:reader/,
    );
    assert.match(
      catalogs.find((block) => block.text?.includes("Skills available"))
        ?.text ?? "",
      /owned:prepare/,
    );
    assert.equal(JSON.stringify(catalogs).includes("ordinary"), false);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
  { timeout: 15000 },
);

test(
  "compiled plugin MCP discovers, calls and closes a qualified stdio server with plugin context",
  async () => {
    const f = await fixture(),
      log = join(f.root, "mcp.jsonl"),
      script = join(f.plugin, "mcp.cjs");
    await writeFile(
      script,
      String.raw`const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin}),log=x=>fs.appendFileSync(process.env.LOG,JSON.stringify({pid:process.pid,...x})+'\n'),send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');log({event:'start',root:process.env.CLAUDE_PLUGIN_ROOT,data:process.env.CLAUDE_PLUGIN_DATA,state:process.env.STATE});process.on('exit',()=>log({event:'exit'}));process.on('SIGTERM',()=>process.exit(0));rl.on('line',line=>{const m=JSON.parse(line);log({event:'request',method:m.method,params:m.params});if(m.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'owned legacy'}})+'\n');else if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned-plugin',version:'1'}});else if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:'Owned plugin echo',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{value:{type:'string'}}}}]});else if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:'PLUGIN_MCP_REPLY'}]});});`,
    );
    await writeFile(
      join(f.plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          probe: {
            command: process.execPath,
            args: ["${CLAUDE_PLUGIN_ROOT}/mcp.cjs"],
            env: { LOG: log, STATE: "${CLAUDE_PLUGIN_DATA}" },
          },
        },
      }),
    );
    f.respond((_body, index) =>
      index === 1
        ? tool("mcp__plugin_owned_probe__echo", { value: "owned" }, index)
        : { type: "text", text: "done" },
    );
    const execution = await f.cli("owned plugin MCP", [
      "--allowed-tools",
      "mcp__plugin_owned_probe__echo",
      "--setting-sources",
      "",
    ]);
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 2);
    assert.ok(
      bodyAt(f.bodies, 0).tools.some(
        (entry) => entry.name === "mcp__plugin_owned_probe__echo",
      ),
    );
    assert.match(
      JSON.stringify(result(bodyAt(f.bodies, 1), 1).content),
      /PLUGIN_MCP_REPLY/,
    );
    const rows = await readRows(log, mcpRowSchema);
    const first = present(rows[0]);
    assert.equal(first.root, f.plugin);
    assert.equal(first.data, join(f.config, "plugins", "data", "owned-inline"));
    assert.equal(first.state, first.data);
    assert.equal(
      rows.filter(
        (row) => row.event === "request" && row.method === "tools/call",
      ).length,
      1,
    );
    assert.equal(present(rows.at(-1)).event, "exit");
    assert.throws(() => process.kill(first.pid, 0), { code: "ESRCH" });
    f.bodies.length = 0;
    await rm(log);
    const strict = await f.cli("strict plugin MCP", ["--strict-mcp-config"]);
    assert.equal(strict.code, 0, strict.err);
    assert.equal(
      bodyAt(f.bodies, 0).tools.some((entry) => entry.name.startsWith("mcp__")),
      false,
    );
    await assert.rejects(readFile(log), { code: "ENOENT" });
  },
  { timeout: 15000 },
);
