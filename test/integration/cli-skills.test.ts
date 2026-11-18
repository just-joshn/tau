import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

const unknownField = z.unknown().optional();
const contentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: unknownField,
});
const requestBody = z.looseObject({
  model: z.string().optional(),
  tools: z.array(z.looseObject({ name: z.string(), description: z.string() })),
  messages: z.array(
    z.looseObject({ role: z.string(), content: z.array(contentBlock) }),
  ),
  output_config: z.looseObject({ effort: unknownField }).optional(),
});
type RequestBody = z.infer<typeof requestBody>;
type ResponseBlock =
  | { type: "tool_use"; name: string; input: unknown; id: string }
  | { type: "text"; text: string };
const hookRow = z.looseObject({
  event: unknownField,
  tool: unknownField,
  root: unknownField,
  tool_name: unknownField,
});
const cliResult = z.looseObject({
  result: unknownField,
  session_id: z.string(),
});
const savedSession = z.looseObject({ model: unknownField });
const blocksOf = (body: RequestBody) =>
  body.messages.flatMap((row) => row.content);
const hasSkillTool = (body: RequestBody) =>
  body.tools.some((entry) => entry.name === "Skill");

async function fixture(
  content: string,
  project = false,
  settings: object = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-skills-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    config = join(root, "config"),
    home = join(root, "home"),
    state = join(root, "state");
  const skill = join(
    project ? join(cwd, ".claude") : config,
    "skills",
    "owned",
  );
  for (const directory of [skill, home, config, join(root, "managed")])
    await mkdir(directory, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), content);
  await writeFile(join(config, "settings.json"), JSON.stringify(settings));
  let responder: (body: RequestBody, index: number) => ResponseBlock = () => ({
    type: "text",
    text: "done",
  });
  const bodies: RequestBody[] = [];
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = requestBody.parse(JSON.parse(raw));
    bodies.push(body);
    const block = responder(body, bodies.length);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      fixtureSse([
        {
          type: "message_start",
          message: {
            id: `owned-${bodies.length}`,
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
  const cli = (
    prompt: string,
    args: string[] = [],
    extraEnv: NodeJS.ProcessEnv = {},
  ) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
            "--cwd",
            cwd,
            "-p",
            prompt,
            "--output-format",
            "json",
            ...args,
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              CLAUDE_CONFIG_DIR: config,
              TAU_MANAGED_ROOT: join(root, "managed"),
              TAU_HOME: state,
              ANTHROPIC_MODEL: "claude-opus-4-6",
              ANTHROPIC_API_KEY: "owned-dummy",
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
              ...extraEnv,
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
    bodies,
    body: (index: number) => {
      const found = bodies[index];
      assert.ok(found);
      return found;
    },
    state,
    cli,
    skillPath: join(skill, "SKILL.md"),
    config,
    respond: (next: typeof responder) => {
      responder = next;
    },
  };
}
const tool = (name: string, input: unknown, id: number): ResponseBlock => ({
  type: "tool_use",
  name,
  input,
  id: `call-${id}`,
});
const instruction =
  "---\ndescription: An owned local workflow\nallowed-tools: Write\nmodel: haiku\n---\nPRIVATE_SKILL_BODY $ARGUMENTS";

test(
  "a guarded missing Read activates a conditional skill before the next catalog scan",
  async () => {
    const f = await fixture(
      "---\ndescription: Conditional owned workflow\npaths: ['src/**']\n---\nCONDITIONAL_SKILL_BODY",
    );
    f.respond((_body, index) =>
      index === 1
        ? tool("Read", { file_path: "src/missing.txt" }, index)
        : index === 2
          ? tool("Skill", { skill: "owned" }, index)
          : { type: "text", text: "conditional done" },
    );
    const execution = await f.cli("inspect missing source");
    assert.equal(execution.code, 0, execution.err);
    assert.equal(hasSkillTool(f.body(0)), true);
    assert.equal(
      JSON.stringify(f.body(0).messages).includes("Conditional owned workflow"),
      false,
    );
    assert.equal(hasSkillTool(f.body(1)), true);
    assert.match(
      JSON.stringify(f.body(1).messages),
      /owned: Conditional owned workflow/,
    );
    assert.match(JSON.stringify(f.body(2).messages), /CONDITIONAL_SKILL_BODY/);
    await assert.rejects(readFile(join(f.cwd, "src", "missing.txt")), {
      code: "ENOENT",
    });
  },
  { timeout: 15000 },
);

test(
  "compiled Skill → Write applies grants, preserves the query model snapshot and clears grants on resume",
  async () => {
    const f = await fixture(instruction, false, {
      permissions: { allow: ["Skill(owned)"] },
    });
    f.respond((_body, index) =>
      index === 1
        ? tool("Skill", { skill: "owned", args: "one" }, index)
        : index === 2
          ? tool("Write", { file_path: "first.txt", content: "first" }, index)
          : index === 4
            ? tool(
                "Write",
                { file_path: "second.txt", content: "must not be written" },
                index,
              )
            : { type: "text", text: "done" },
    );
    const first = await f.cli("do owned task");
    assert.equal(first.code, 0, first.err);
    const result = cliResult.parse(JSON.parse(first.out));
    assert.equal(result.result, "done");
    assert.equal(await readFile(join(f.cwd, "first.txt"), "utf8"), "first");
    assert.ok(hasSkillTool(f.body(0)));
    assert.equal(
      f
        .body(0)
        .tools.find((entry) => entry.name === "Skill")
        ?.description.includes("owned"),
      false,
    );
    assert.match(
      JSON.stringify(f.body(0).messages),
      /owned: An owned local workflow/,
    );
    assert.equal(
      JSON.stringify(f.body(0)).includes("PRIVATE_SKILL_BODY"),
      false,
    );
    assert.match(JSON.stringify(f.body(1).messages), /PRIVATE_SKILL_BODY one/);
    assert.deepEqual(
      f.bodies.map((body) => body.model),
      ["claude-opus-4-6", "claude-opus-4-6", "claude-opus-4-6"],
    );
    const [partition] = await readdir(join(f.state, "sessions"));
    assert.ok(partition);
    const saved = savedSession.parse(
      JSON.parse(
        await readFile(
          join(f.state, "sessions", partition, `${result.session_id}.json`),
          "utf8",
        ),
      ),
    );
    assert.equal(saved.model, "claude-opus-4-6");
    const next = await f.cli("ordinary next query", [
      "--resume",
      result.session_id,
    ]);
    assert.equal(next.code, 0, next.err);
    assert.ok(
      f.bodies.slice(3).every((body) => body.model === "claude-opus-4-6"),
    );
    const denied = blocksOf(f.body(4)).find(
      (block) => block.type === "tool_result" && block.tool_use_id === "call-4",
    );
    assert.ok(denied);
    assert.equal(denied.is_error, true);
    assert.match(JSON.stringify(denied), /Permission denied/);
    await assert.rejects(readFile(join(f.cwd, "second.txt")), {
      code: "ENOENT",
    });
  },
  { timeout: 15000 },
);

test(
  "explicit slash skill expands before first request while inherited deny defeats its grant",
  async () => {
    const f = await fixture(instruction, false, {
      permissions: { deny: ["Write"] },
    });
    f.respond((_body, index) =>
      index === 1
        ? tool("Write", { file_path: "denied.txt", content: "no" }, index)
        : { type: "text", text: "denied safely" },
    );
    const result = await f.cli("/owned explicit arguments");
    assert.equal(result.code, 0, result.err);
    assert.match(
      JSON.stringify(f.body(0).messages),
      /PRIVATE_SKILL_BODY explicit arguments/,
    );
    assert.equal(f.body(0).model, "claude-haiku-5-5");
    assert.equal(
      blocksOf(f.body(1)).find((block) => block.type === "tool_result")
        ?.is_error,
      true,
    );
    await assert.rejects(readFile(join(f.cwd, "denied.txt")), {
      code: "ENOENT",
    });
  },
  { timeout: 10000 },
);

test(
  "ignored persisted trust withholds project skill grants after explicit Skill authorization",
  async () => {
    const f = await fixture(instruction, true, {
      permissions: { allow: ["Skill(owned)"] },
    });
    f.respond((_body, index) =>
      index === 1
        ? tool("Skill", { skill: "owned", args: "project" }, index)
        : index === 2
          ? tool("Write", { file_path: "untrusted.txt", content: "no" }, index)
          : { type: "text", text: "done" },
    );
    const result = await f.cli("owned task", ["--ignore-persisted-trust"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.err, /automatic grants withheld \(untrusted_folder\)/);
    assert.match(
      JSON.stringify(f.body(1).messages),
      /PRIVATE_SKILL_BODY project/,
    );
    assert.equal(
      blocksOf(f.body(2)).findLast((block) => block.type === "tool_result")
        ?.is_error,
      true,
    );
    await assert.rejects(readFile(join(f.cwd, "untrusted.txt")), {
      code: "ENOENT",
    });
  },
  { timeout: 10000 },
);

test(
  "native settings once metadata repeats while session Skill hooks remove only after success",
  async () => {
    const f = await fixture("placeholder"),
      script = join(f.root, "hook.cjs"),
      log = join(f.root, "hooks.jsonl");
    await writeFile(
      script,
      String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const i=JSON.parse(raw);require('node:fs').appendFileSync(process.argv[2],JSON.stringify({event:i.hook_event_name,tool:i.tool_name,root:process.env.CLAUDE_PLUGIN_ROOT})+'\n');process.stdout.write(JSON.stringify(i.hook_event_name==='PostToolUse'?{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'OWNED_POST_ATTACHMENT'}}:{}));});`,
    );
    const command = {
      type: "command",
      command: process.execPath,
      args: [script, log],
      once: true,
    };
    await writeFile(
      join(f.config, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Skill(owned)"] },
        hooks: { PreToolUse: [{ hooks: [command] }] },
      }),
    );
    await writeFile(
      f.skillPath,
      `---\n${JSON.stringify({ description: "owned hooked skill", "allowed-tools": "Write", hooks: { PostToolUse: [{ matcher: "Write", hooks: [command] }] } })}\n---\nOWNED_HOOKED_SKILL`,
    );
    f.respond((_body, index) =>
      index === 1
        ? tool("Skill", { skill: "owned" }, index)
        : index <= 3
          ? tool(
              "Write",
              { file_path: `${index}.txt`, content: "written" },
              index,
            )
          : { type: "text", text: "done" },
    );
    const result = await f.cli("run hooked skill");
    assert.equal(result.code, 0, result.err);
    assert.equal(await readFile(join(f.cwd, "2.txt"), "utf8"), "written");
    assert.equal(await readFile(join(f.cwd, "3.txt"), "utf8"), "written");
    const rows = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => hookRow.parse(JSON.parse(line)));
    assert.deepEqual(
      rows.map((row) => [row.event, row.tool]),
      [
        ["PreToolUse", "Skill"],
        ["PreToolUse", "Write"],
        ["PostToolUse", "Write"],
        ["PreToolUse", "Write"],
      ],
    );
    assert.equal(rows[2]?.root, join(f.config, "skills", "owned"));
    const blocks = blocksOf(f.body(2));
    const completed = blocks.find(
      (block) => block.type === "tool_result" && block.tool_use_id === "call-2",
    );
    assert.ok(typeof completed?.content === "string");
    assert.match(
      completed.content,
      /PostToolUse:Write hook additional context: OWNED_POST_ATTACHMENT/,
    );
    assert.equal(
      blocks.some(
        (block) =>
          block.type === "text" &&
          block.text?.includes("OWNED_POST_ATTACHMENT"),
      ),
      false,
    );
  },
  { timeout: 10000 },
);

test(
  "a blocked one-shot skill pre hook survives until success, then stops running",
  async () => {
    const f = await fixture("placeholder", false, {
      permissions: { allow: ["Skill(owned)"] },
    });
    const script = join(f.root, "pre.cjs"),
      log = join(f.root, "pre.jsonl");
    await writeFile(
      script,
      String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const fs=require('node:fs'),path=process.argv[2],old=fs.existsSync(path)?fs.readFileSync(path,'utf8'):'';fs.appendFileSync(path,raw+'\n');if(!old){process.stderr.write('owned first hold');process.exitCode=2;}else process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'OWNED_PRE_ATTACHMENT'}}));});`,
    );
    const hooks = {
      PreToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [script, log],
              once: true,
            },
          ],
        },
      ],
    };
    await writeFile(
      f.skillPath,
      `---\n${JSON.stringify({ description: "owned pre hook", "allowed-tools": "Write", hooks })}\n---\nOWNED_PRE_SKILL`,
    );
    f.respond((_body, index) =>
      index === 1
        ? tool("Skill", { skill: "owned" }, index)
        : index <= 4
          ? tool(
              "Write",
              { file_path: `${index}.txt`, content: "written" },
              index,
            )
          : { type: "text", text: "done" },
    );
    const result = await f.cli("run pre skill");
    assert.equal(result.code, 0, result.err);
    await assert.rejects(readFile(join(f.cwd, "2.txt")), { code: "ENOENT" });
    for (const name of ["3.txt", "4.txt"])
      assert.equal(await readFile(join(f.cwd, name), "utf8"), "written");
    const rows = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => hookRow.parse(JSON.parse(line)));
    assert.deepEqual(
      rows.map((row) => row.tool_name),
      ["Write", "Write"],
    );
    const blocks = blocksOf(f.body(3));
    assert.ok(
      blocks.some(
        (block) =>
          block.type === "text" && block.text?.includes("OWNED_PRE_ATTACHMENT"),
      ),
    );
    assert.equal(
      blocks.some(
        (block) =>
          block.type === "tool_result" &&
          JSON.stringify(block.content).includes("OWNED_PRE_ATTACHMENT"),
      ),
      false,
    );
  },
  { timeout: 10000 },
);

test(
  "disabled skill hook admission also withholds its dependent automatic grants",
  async () => {
    const f = await fixture("placeholder", false, {
      disableAllHooks: true,
      permissions: { allow: ["Skill(owned)"] },
    });
    const hooks = {
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
            },
          ],
        },
      ],
    };
    await writeFile(
      f.skillPath,
      `---\n${JSON.stringify({ description: "disabled owned hooks", "allowed-tools": "Write", hooks })}\n---\nOWNED_DISABLED_SKILL`,
    );
    f.respond((_body, index) =>
      index === 1
        ? tool("Skill", { skill: "owned" }, index)
        : index === 2
          ? tool("Write", { file_path: "disabled.txt", content: "no" }, index)
          : { type: "text", text: "done" },
    );
    const result = await f.cli("run disabled hook skill");
    assert.equal(result.code, 0, result.err);
    assert.match(result.err, /automatic tool grants were withheld/);
    await assert.rejects(readFile(join(f.cwd, "disabled.txt")), {
      code: "ENOENT",
    });
  },
  { timeout: 10000 },
);

test(
  "inline skill effort stays live while environment and settings caps retain precedence",
  async () => {
    const cases = [
      { effort: "low", settings: {}, env: {}, expected: ["high", "low"] },
      {
        effort: "high",
        settings: {},
        env: { CLAUDE_CODE_EFFORT_LEVEL: "medium" },
        expected: ["medium", "medium"],
      },
      {
        effort: "high",
        settings: { maxEffortLevel: "medium" },
        env: {},
        expected: ["medium", "medium"],
      },
      {
        effort: 80,
        settings: { maxEffortLevel: "medium" },
        env: {},
        expected: ["medium", "medium"],
      },
      {
        effort: "high",
        settings: {},
        env: { CLAUDE_CODE_EFFORT_LEVEL: "unset" },
        expected: [undefined, undefined],
      },
    ];
    for (const item of cases) {
      const f = await fixture(
        `---\ndescription: owned effort\neffort: ${item.effort}\n---\nOWNED_EFFORT_BODY`,
        false,
        item.settings,
      );
      f.respond((_body, index) =>
        index === 1
          ? tool("Skill", { skill: "owned" }, index)
          : { type: "text", text: "done" },
      );
      const result = await f.cli("use effort skill", [], {
        CLAUDE_CODE_EFFORT_LEVEL: "",
        ...item.env,
      });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(
        f.bodies.map((body) => body.model),
        ["claude-opus-4-6", "claude-opus-4-6"],
      );
      assert.deepEqual(
        f.bodies.map((body) => body.output_config?.effort),
        item.expected,
      );
    }
  },
  { timeout: 15000 },
);
