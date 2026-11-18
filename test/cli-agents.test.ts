import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const toolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(textBlock)]),
  is_error: z.boolean().optional(),
});
type ToolResult = z.infer<typeof toolResult>;
const bodySchema = z.object({
  model: z.string(),
  system: z.unknown(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.array(z.unknown())]),
    }),
  ),
  tools: z.array(z.object({ name: z.string() })).default([]),
  max_tokens: z.number(),
});
type Body = z.infer<typeof bodySchema>;
type Action =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
const outputSchema = z.object({
  result: z.string(),
  usage: z.unknown(),
  session_id: z.string(),
  result_index: z.number(),
  num_turns: z.number(),
});
const metadataSchema = z.object({
  output_file: z.string(),
  agentId: z.string(),
});
const archiveSchema = z.object({ status: z.string(), messages: z.unknown() });
const taskSchema = z.object({
  status: z.string(),
  settled: z.boolean(),
  agentId: z.string().optional(),
  killedBy: z.string().optional(),
  notification: z.string().optional(),
  result: z.object({ totalTokens: z.number() }).optional(),
  usage: z.object({ totalTokens: z.number() }).optional(),
});
const hookRowSchema = z.object({
  input: z.object({
    hook_event_name: z.string(),
    permission_mode: z.unknown().optional(),
    effort: z.unknown().optional(),
    stop_hook_active: z.boolean().optional(),
    transcript_path: z.string().optional(),
    agent_id: z.string().optional(),
    agent_transcript_path: z.string().optional(),
  }),
  archive: z.unknown().optional(),
});
const fail = (message: string): never => {
  throw new Error(message);
};
const lastLine = (text: string) => text.split("\n").at(-1) ?? "";
const firstText = (content: ToolResult["content"]) =>
  typeof content === "string" ? content : (content[0]?.text ?? "");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-agents-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    config = join(root, "config"),
    home = join(root, "home");
  for (const path of [cwd, join(config, "agents"), home, join(root, "managed")])
    await mkdir(path, { recursive: true });
  await writeFile(join(cwd, "owned.txt"), "CHILD_PRIVATE_FILE\n");
  await writeFile(
    join(config, "agents", "reader.md"),
    "---\nname: reader\ndescription: Read an owned file\ntools: Read\nmodel: sonnet\nmaxTurns: 3\n---\nCHILD_SYSTEM_MARKER",
  );
  const bodies: Body[] = [];
  let responder: (
    body: Body,
    index: number,
  ) => Action | Promise<Action> = () => ({ type: "text", text: "done" });
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = bodySchema.parse(JSON.parse(raw));
    bodies.push(body);
    const index = bodies.length,
      block = await responder(body, index);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      fixtureSse([
        {
          type: "message_start",
          message: {
            id: `agent-response-${index}`,
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
  const cli = (
    args: string[] = [],
    extraEnv: NodeJS.ProcessEnv = {},
    selectedTools = "Agent,Read",
  ) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
            "--cwd",
            cwd,
            "-p",
            "PARENT_PRIVATE_PROMPT",
            "--tools",
            selectedTools,
            "--model",
            "claude-sonnet-4-6",
            "--max-turns",
            "2",
            "--max-tokens",
            "17",
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
              TAU_HOME: join(root, "state"),
              CLAUDE_CODE_FORK_SUBAGENT: "0",
              CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
              CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "",
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
    cwd,
    config,
    state: join(root, "state"),
    bodies,
    body: (index: number) =>
      bodies[index] ?? fail(`Owned request missing: ${String(index)}`),
    cli,
    respond: (fn: typeof responder) => {
      responder = fn;
    },
  };
}
const agent = (overrides: Record<string, unknown> = {}): Action => ({
  type: "tool_use",
  id: "parent-agent",
  name: "Agent",
  input: {
    description: "Read owned fixture",
    prompt: "CHILD_PRIVATE_TASK",
    subagent_type: "reader",
    run_in_background: false,
    ...overrides,
  },
});
function result(body: Body, id: string) {
  for (const row of body.messages)
    if (typeof row.content !== "string")
      for (const block of row.content) {
        const parsed = toolResult.safeParse(block);
        if (parsed.success && parsed.data.tool_use_id === id)
          return parsed.data;
      }
  throw new Error(`Owned result missing: ${id}`);
}

test(
  "compiled foreground Agent isolates child history, narrows tools and uses independent query defaults",
  async () => {
    const f = await fixture();
    f.respond((_body, index) =>
      index === 1
        ? agent()
        : index === 2
          ? {
              type: "tool_use",
              id: "child-read",
              name: "Read",
              input: { file_path: "owned.txt" },
            }
          : index === 3
            ? { type: "text", text: "OWNED_CHILD_REPORT" }
            : { type: "text", text: "PARENT_FINAL" },
    );
    const execution = await f.cli();
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 4);
    assert.deepEqual(
      f.bodies.map((body) => body.model),
      Array(4).fill("claude-sonnet-4-6"),
    );
    assert.deepEqual(
      f.body(1).tools.map((tool) => tool.name),
      ["Read"],
    );
    assert.equal(
      JSON.stringify(f.body(1).messages).includes("PARENT_PRIVATE_PROMPT"),
      false,
    );
    assert.match(JSON.stringify(f.body(1).system), /CHILD_SYSTEM_MARKER/);
    assert.equal(f.body(0).max_tokens, 17);
    assert.ok(f.body(1).max_tokens > 17);
    assert.match(
      firstText(result(f.body(2), "child-read").content),
      /CHILD_PRIVATE_FILE/,
    );
    const report = result(f.body(3), "parent-agent");
    assert.ok(Array.isArray(report.content));
    assert.match(JSON.stringify(report.content), /OWNED_CHILD_REPORT/);
    assert.match(JSON.stringify(report.content), /subagent_tokens: 13/);
    assert.match(JSON.stringify(report.content), /tool_uses: 1/);
    assert.equal(
      JSON.stringify(f.body(3).messages).includes("CHILD_PRIVATE_FILE"),
      false,
    );
    const output = outputSchema.parse(JSON.parse(execution.out));
    assert.equal(output.result, "PARENT_FINAL");
    assert.deepEqual(output.usage, { input_tokens: 20, output_tokens: 6 });
    const id = /agentId: ([^\n]+)/.exec(firstText(report.content))?.[1];
    assert.ok(id);
    const key = createHash("sha256").update(f.cwd).digest("hex").slice(0, 24);
    const archive = archiveSchema.parse(
      JSON.parse(
        await readFile(
          join(
            f.state,
            "sessions",
            key,
            output.session_id,
            "subagents",
            `${id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    assert.equal(archive.status, "completed");
    assert.match(JSON.stringify(archive.messages), /CHILD_PRIVATE_FILE/);
    assert.equal(
      JSON.stringify(archive.messages).includes("PARENT_PRIVATE_PROMPT"),
      false,
    );
  },
  { timeout: 15000 },
);

test(
  "compiled Agent refuses unknown, denied and unsupported isolation before child requests",
  async () => {
    const f = await fixture();
    for (const [input, args, expected] of [
      [{ subagent_type: "missing" }, [], /not found/],
      [{}, ["--disallowed-tools", "Agent(reader)"], /denied/],
      [{ isolation: "remote" }, [], /isolation/],
    ] as const) {
      f.bodies.length = 0;
      f.respond((_body, index) =>
        index === 1 ? agent(input) : { type: "text", text: "held" },
      );
      const execution = await f.cli([...args]);
      assert.equal(execution.code, 0, execution.err);
      assert.equal(f.bodies.length, 2);
      const failure = result(f.body(1), "parent-agent");
      assert.equal(failure.is_error, true);
      assert.match(firstText(failure.content), expected);
      assert.equal(
        f.bodies.some((body) =>
          JSON.stringify(body.system).includes("CHILD_SYSTEM_MARKER"),
        ),
        false,
      );
    }
  },
  { timeout: 15000 },
);

test(
  "compiled default background Agent returns before child completion, drains a new parent query and reads owned output",
  async () => {
    const f = await fixture();
    let release!: () => void, continued!: () => void;
    const childGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parentContinued = new Promise<void>((resolve) => {
      continued = resolve;
    });
    onTestFinished(() => release());
    let parentRequests = 0,
      childRequests = 0,
      outputFile = "",
      childFinished = false;
    f.respond(async (body) => {
      const isChild = JSON.stringify(body.system).includes(
        "CHILD_SYSTEM_MARKER",
      );
      if (isChild) {
        childRequests++;
        assert.equal(
          JSON.stringify(body.messages).includes("PARENT_PRIVATE_PROMPT"),
          false,
        );
        if (childRequests === 1) {
          await childGate;
          return {
            type: "tool_use",
            id: "background-read",
            name: "Read",
            input: { file_path: "owned.txt" },
          };
        }
        assert.match(
          JSON.stringify(result(body, "background-read")),
          /CHILD_PRIVATE_FILE/,
        );
        childFinished = true;
        return { type: "text", text: "BACKGROUND_CHILD_REPORT" };
      }
      parentRequests++;
      if (parentRequests === 1) return agent({ run_in_background: undefined });
      if (parentRequests === 2) {
        assert.equal(childFinished, false);
        const launch = result(body, "parent-agent");
        assert.equal(launch.is_error, undefined);
        outputFile = metadataSchema.parse(
          JSON.parse(lastLine(firstText(launch.content))),
        ).output_file;
        assert.match(outputFile, /\.output$/);
        continued();
        return { type: "text", text: "PARENT_WHILE_CHILD_RUNNING" };
      }
      if (parentRequests === 3) {
        assert.match(JSON.stringify(body.messages), /<task-notification>/);
        assert.match(JSON.stringify(body.messages), /BACKGROUND_CHILD_REPORT/);
        assert.match(
          JSON.stringify(body.messages),
          /<subagent_tokens>15<\/subagent_tokens>/,
        );
        assert.match(
          JSON.stringify(body.messages),
          /<tool-use-id>parent-agent<\/tool-use-id>/,
        );
        return {
          type: "tool_use",
          id: "owned-output",
          name: "Read",
          input: { file_path: outputFile },
        };
      }
      const output = result(body, "owned-output");
      assert.equal(output.is_error, undefined);
      assert.match(JSON.stringify(output), /BACKGROUND_CHILD_REPORT/);
      return { type: "text", text: "PARENT_AFTER_NOTIFICATION" };
    });
    const executionPromise = f.cli();
    await parentContinued;
    assert.equal(childFinished, false);
    release();
    const execution = await executionPromise;
    assert.equal(execution.code, 0, execution.err);
    assert.equal(parentRequests, 4);
    assert.equal(childRequests, 2);
    const terminal = outputSchema.parse(JSON.parse(execution.out));
    assert.equal(terminal.result, "PARENT_AFTER_NOTIFICATION");
    assert.deepEqual(terminal.usage, { input_tokens: 20, output_tokens: 6 });
    assert.equal(terminal.result_index, 1);
    assert.equal(terminal.num_turns, 2);
    const task = taskSchema.parse(
      JSON.parse(
        await readFile(outputFile.replace(/\.output$/, ".task.json"), "utf8"),
      ),
    );
    assert.equal(task.status, "completed");
    assert.equal(task.settled, true);
    assert.equal(task.notification, "enqueued");
    assert.equal(task.result?.totalTokens, 13);
    assert.equal(task.usage?.totalTokens, 15);
  },
  { timeout: 15000 },
);

for (const disabled of ["true", "false"])
  test(
    `raw truthy background-disabled setting ${disabled} resolves an explicit async request to foreground`,
    async () => {
      const f = await fixture();
      f.respond((_body, index) =>
        index === 1
          ? agent({ run_in_background: true })
          : {
              type: "text",
              text: index === 2 ? "DISABLED_SYNC_CHILD" : "PARENT_DONE",
            },
      );
      const execution = await f.cli([], {
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: disabled,
      });
      assert.equal(execution.code, 0, execution.err);
      assert.equal(f.bodies.length, 3);
      const report = result(f.body(2), "parent-agent");
      assert.match(JSON.stringify(report), /DISABLED_SYNC_CHILD/);
      assert.equal(
        JSON.stringify(report).includes("Background agent launched"),
        false,
      );
    },
    { timeout: 15000 },
  );

test(
  "compiled TaskStop cancels a detached child while the parent continues and archives killed ownership",
  async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    const childStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let parentRequests = 0,
      childRequests = 0,
      agentId = "",
      outputFile = "";
    f.respond(async (body) => {
      if (JSON.stringify(body.system).includes("CHILD_SYSTEM_MARKER")) {
        childRequests++;
        started();
        await gate;
        return { type: "text", text: "CHILD_MUST_NOT_FINISH" };
      }
      parentRequests++;
      assert.ok(body.tools.some((tool) => tool.name === "TaskStop"));
      if (parentRequests === 1) return agent({ run_in_background: true });
      if (parentRequests === 2) {
        await childStarted;
        const metadata = metadataSchema.parse(
          JSON.parse(lastLine(firstText(result(body, "parent-agent").content))),
        );
        agentId = metadata.agentId;
        outputFile = metadata.output_file;
        return {
          type: "tool_use",
          id: "stop-child",
          name: "TaskStop",
          input: { task_id: agentId },
        };
      }
      assert.equal(result(body, "stop-child").is_error, undefined);
      return { type: "text", text: "PARENT_STOPPED_CHILD" };
    });
    const execution = await f.cli(
      ["--max-turns", "4"],
      {},
      "Agent,Read,TaskStop",
    );
    assert.equal(execution.code, 0, execution.err);
    assert.equal(childRequests, 1);
    assert.equal(
      outputSchema.parse(JSON.parse(execution.out)).result,
      "PARENT_STOPPED_CHILD",
    );
    assert.equal(execution.out.includes("CHILD_MUST_NOT_FINISH"), false);
    const archived = taskSchema.parse(
      JSON.parse(
        await readFile(outputFile.replace(/\.output$/, ".task.json"), "utf8"),
      ),
    );
    assert.equal(archived.agentId, agentId);
    assert.equal(archived.status, "killed");
    assert.equal(archived.killedBy, "parent");
    assert.equal(archived.settled, true);
  },
  { timeout: 15000 },
);

test(
  "compiled child retains parent Read asks and rejects model-selected tools outside the admitted scope",
  async () => {
    const f = await fixture();
    await writeFile(
      join(f.config, "settings.json"),
      JSON.stringify({ permissions: { ask: ["Read"] } }),
    );
    f.respond((_body, index) =>
      index === 1
        ? agent()
        : index === 2
          ? {
              type: "tool_use",
              id: "child-read",
              name: "Read",
              input: { file_path: "owned.txt" },
            }
          : index === 3
            ? {
                type: "tool_use",
                id: "child-write",
                name: "Write",
                input: { file_path: "owned.txt", content: "must not change" },
              }
            : index === 4
              ? { type: "text", text: "child held" }
              : { type: "text", text: "parent held" },
    );
    const execution = await f.cli();
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 5);
    assert.equal(result(f.body(2), "child-read").is_error, true);
    assert.equal(result(f.body(3), "child-write").is_error, true);
    assert.equal(
      await readFile(join(f.cwd, "owned.txt"), "utf8"),
      "CHILD_PRIVATE_FILE\n",
    );
  },
  { timeout: 15000 },
);

test(
  "compiled fresh Agent distinguishes exact type asks from generic argument asks",
  async () => {
    const f = await fixture();
    for (const [rule, expected] of [
      ["Agent(reader)", 3],
      ["Agent(subagent_type:read*)", 2],
    ] as const) {
      await writeFile(
        join(f.config, "settings.json"),
        JSON.stringify({ permissions: { ask: [rule] } }),
      );
      f.bodies.length = 0;
      f.respond((_body, index) =>
        index === 1 ? agent() : { type: "text", text: "done" },
      );
      const execution = await f.cli();
      assert.equal(execution.code, 0, execution.err);
      assert.equal(f.bodies.length, expected);
      assert.equal(
        f.bodies.filter((body) =>
          JSON.stringify(body.system).includes("CHILD_SYSTEM_MARKER"),
        ).length,
        expected === 3 ? 1 : 0,
      );
    }
  },
  { timeout: 15000 },
);

test(
  "compiled custom agent model precedence preserves family inheritance only for call and definition",
  async () => {
    const f = await fixture();
    for (const [declared, call, env, expected] of [
      [
        "sonnet",
        "haiku",
        { CLAUDE_CODE_SUBAGENT_MODEL: "opus" },
        "claude-haiku-5-5",
      ],
      [
        "inherit",
        undefined,
        { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
        "claude-sonnet-4-6",
      ],
      [
        undefined,
        undefined,
        { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
        "claude-sonnet-5-5",
      ],
      [
        "sonnet",
        "sonnet",
        {
          CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
        },
        "claude-haiku-5-5",
      ],
    ] as const) {
      await writeFile(
        join(f.config, "agents", "reader.md"),
        `---\nname: reader\ndescription: Owned model selection\ntools: Read\n${declared ? `model: ${declared}\n` : ""}---\nCHILD_SYSTEM_MARKER`,
      );
      f.bodies.length = 0;
      f.respond((_body, index) =>
        index === 1
          ? agent(call ? { model: call } : {})
          : { type: "text", text: "done" },
      );
      const execution = await f.cli([], env);
      assert.equal(execution.code, 0, execution.err);
      assert.equal(f.bodies.length, 3);
      assert.equal(f.body(1).model, expected);
      assert.equal(f.body(0).model, "claude-sonnet-4-6");
      assert.equal(f.body(2).model, "claude-sonnet-4-6");
    }
  },
  { timeout: 15000 },
);

test(
  "compiled child mode declarations retain sticky parent modes and personal/explicit permission floors",
  async () => {
    const f = await fixture();
    let caseIndex = 0;
    for (const [declared, args, extraEnv, ask, permitted] of [
      ["acceptEdits", [], {}, false, true],
      [
        "acceptEdits",
        [],
        { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "1" },
        false,
        false,
      ],
      ["plan", ["--permission-mode", "acceptEdits"], {}, false, true],
      ["acceptEdits", [], {}, true, false],
      ["bypassPermissions", [], {}, false, false],
    ] as const) {
      const path = `mode-${caseIndex++}.txt`;
      await writeFile(
        join(f.config, "settings.json"),
        JSON.stringify(ask ? { permissions: { ask: ["Write"] } } : {}),
      );
      await writeFile(
        join(f.config, "agents", "reader.md"),
        `---\nname: reader\ndescription: Owned permission selection\ntools: Write\npermissionMode: ${declared}\n---\nCHILD_SYSTEM_MARKER`,
      );
      f.bodies.length = 0;
      f.respond((_body, index) =>
        index === 1
          ? agent()
          : index === 2
            ? {
                type: "tool_use",
                name: "Write",
                id: "mode-write",
                input: { file_path: path, content: "owned" },
              }
            : { type: "text", text: "done" },
      );
      const execution = await f.cli(
        [...args],
        {
          CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "0",
          CLAUDE_CODE_EVAL_CONFINED: "0",
          ...extraEnv,
        },
        "Agent,Write",
      );
      assert.equal(execution.code, 0, execution.err);
      assert.equal(f.bodies.length, 4);
      assert.equal(
        result(f.body(2), "mode-write").is_error === true,
        !permitted,
      );
      if (permitted)
        assert.equal(await readFile(join(f.cwd, path), "utf8"), "owned");
      else
        await assert.rejects(readFile(join(f.cwd, path)), { code: "ENOENT" });
    }
  },
  { timeout: 15000 },
);

test(
  "compiled Subagent hooks project Start context, continue only the child and preserve transcript identities",
  async () => {
    const f = await fixture(),
      script = join(f.config, "lifecycle.cjs"),
      log = join(f.cwd, "hooks.jsonl"),
      counter = join(f.cwd, "stop-count");
    await writeFile(
      script,
      String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const fs=require('node:fs'),i=JSON.parse(raw),mode=process.argv[4];fs.appendFileSync(process.argv[2],JSON.stringify({input:i,archive:i.agent_transcript_path&&fs.existsSync(i.agent_transcript_path)})+'\n');if(mode==='error'){process.stderr.write('START_TRANSCRIPT_ONLY');process.exitCode=2;return}if(i.hook_event_name==='SubagentStart'){process.stdout.write(JSON.stringify({continue:false,hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'START_VISIBLE'}}));return}if(i.hook_event_name==='SubagentStop'){const p=process.argv[3],n=fs.existsSync(p)?+fs.readFileSync(p,'utf8'):0;fs.writeFileSync(p,String(n+1));process.stdout.write(JSON.stringify(n===0?{hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'STOP_RETRY'}}:{continue:false,decision:'block',reason:'STOP_FINISH',hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'STOP_HIDDEN_FINISH'}}));return}process.stdout.write('{}');});`,
    );
    const command = (mode = "normal") => ({
      type: "command",
      command: process.execPath,
      args: [script, log, counter, mode],
    });
    await writeFile(
      join(f.config, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [command()] }],
          SubagentStart: [
            { matcher: "reader", hooks: [command(), command("error")] },
          ],
          SubagentStop: [{ matcher: "reader", hooks: [command()] }],
        },
      }),
    );
    f.respond((_body, index) =>
      index === 1
        ? agent()
        : index === 2
          ? {
              type: "tool_use",
              id: "hook-read",
              name: "Read",
              input: { file_path: "owned.txt" },
            }
          : {
              type: "text",
              text:
                index === 3
                  ? "CHILD_BEFORE_STOP"
                  : index === 4
                    ? "CHILD_AFTER_STOP"
                    : "PARENT_DONE",
            },
    );
    const execution = await f.cli();
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 5);
    assert.match(JSON.stringify(f.body(1).messages), /START_VISIBLE/);
    assert.equal(
      JSON.stringify(f.body(1).messages).includes("START_TRANSCRIPT_ONLY"),
      false,
    );
    assert.match(JSON.stringify(f.body(3).messages), /STOP_RETRY/);
    assert.equal(
      JSON.stringify(f.bodies).includes("STOP_HIDDEN_FINISH"),
      false,
    );
    const rows = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((row) => hookRowSchema.parse(JSON.parse(row))),
      starts = rows.filter(
        (row) => row.input.hook_event_name === "SubagentStart",
      ),
      stops = rows.filter(
        (row) => row.input.hook_event_name === "SubagentStop",
      );
    assert.equal(starts.length, 2);
    const [start] = starts;
    assert.ok(start);
    assert.equal(start.input.permission_mode, undefined);
    assert.equal(start.input.effort, undefined);
    assert.equal(stops.length, 2);
    const [stop] = stops;
    assert.ok(stop);
    assert.deepEqual(
      stops.map((row) => row.input.stop_hook_active),
      [false, true],
    );
    assert.ok(stops.every((row) => row.archive));
    const pre = rows.filter(
      (row) => row.input.hook_event_name === "PreToolUse",
    );
    assert.equal(pre.length, 2);
    const [pre0, pre1] = pre;
    assert.ok(pre0 && pre1);
    assert.equal(pre0.input.transcript_path, pre1.input.transcript_path);
    assert.equal(pre1.input.agent_id, stop.input.agent_id);
    assert.equal(stop.input.transcript_path, pre0.input.transcript_path);
    assert.notEqual(
      stop.input.agent_transcript_path,
      stop.input.transcript_path,
    );
    assert.match(
      JSON.stringify(result(f.body(4), "parent-agent").content),
      /CHILD_AFTER_STOP/,
    );
    assert.equal(
      JSON.stringify(f.body(4).messages).includes("STOP_RETRY"),
      false,
    );
  },
  { timeout: 15000 },
);

test(
  "compiled child reaching maxTurns exits normally without a teardown SubagentStop",
  async () => {
    const f = await fixture(),
      script = join(f.config, "teardown.cjs"),
      log = join(f.cwd, "teardown.jsonl");
    await writeFile(
      join(f.config, "agents", "reader.md"),
      "---\nname: reader\ndescription: Owned limit\ntools: Read\nmaxTurns: 1\n---\nCHILD_SYSTEM_MARKER",
    );
    await writeFile(
      script,
      String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{require('node:fs').appendFileSync(process.argv[2],raw.trim()+'\n');process.stdout.write(JSON.stringify({decision:'block',reason:'teardown must not resume',hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'TEARDOWN_HIDDEN'}}));});`,
    );
    await writeFile(
      join(f.config, "settings.json"),
      JSON.stringify({
        hooks: {
          SubagentStop: [
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
    f.respond((_body, index) =>
      index === 1
        ? agent()
        : index === 2
          ? {
              type: "tool_use",
              id: "limited-read",
              name: "Read",
              input: { file_path: "owned.txt" },
            }
          : { type: "text", text: "parent done" },
    );
    const execution = await f.cli();
    assert.equal(execution.code, 0, execution.err);
    assert.equal(f.bodies.length, 3);
    await assert.rejects(readFile(log), { code: "ENOENT" });
    assert.equal(JSON.stringify(f.bodies).includes("TEARDOWN_HIDDEN"), false);
    const handoff = result(f.body(2), "parent-agent");
    assert.equal(handoff.is_error, undefined);
    assert.match(JSON.stringify(handoff.content), /partial|turn limit/);
  },
  { timeout: 15000 },
);
