import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fixtureSse } from "./sse-fixture.js";

const text = z.object({ type: z.literal("text"), text: z.string() });
const resultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(text)]),
  is_error: z.boolean().optional(),
});
const bodySchema = z.object({
  model: z.string(),
  system: z.union([z.string(), z.array(text)]),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.array(z.unknown()),
    }),
  ),
  tools: z.array(z.object({ name: z.string() })),
  output_config: z.object({ effort: z.string().optional() }).optional(),
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
const use = (
  name: string,
  input: Record<string, unknown>,
  id: string,
): Action => ({ type: "tool_use", id, name, input });
const system = (body: Body) =>
  typeof body.system === "string"
    ? body.system
    : body.system.map((block) => block.text).join("\n");
const userText = (body: Body) =>
  body.messages
    .filter((row) => row.role === "user")
    .flatMap((row) =>
      row.content.flatMap((block) => {
        const parsed = text.safeParse(block);
        return parsed.success ? [parsed.data.text] : [];
      }),
    )
    .join("\n");
function result(body: Body, id: string) {
  for (const row of body.messages)
    for (const block of row.content) {
      const parsed = resultSchema.safeParse(block);
      if (parsed.success && parsed.data.tool_use_id === id) return parsed.data;
    }
  throw new Error(`Owned result missing: ${id}`);
}
async function fixture() {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-child-capabilities-")),
    ),
    cwd = join(root, "project"),
    config = join(root, "config"),
    state = join(root, "state");
  for (const path of [
    cwd,
    join(config, "agents"),
    join(config, "skills"),
    join(root, "home"),
    join(root, "managed"),
  ])
    await mkdir(path, { recursive: true });
  const bodies: Body[] = [];
  let responder: (body: Body, index: number) => Action = () => ({
    type: "text",
    text: "done",
  });
  const children = new Set<ChildProcess>();
  let handlerError: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = bodySchema.parse(JSON.parse(raw)),
        index = bodies.push(body);
      let block: Action;
      try {
        block =
          handlerError === undefined
            ? responder(body, index)
            : { type: "text", text: "OWNED_FIXTURE_FAILED" };
      } catch (error) {
        handlerError = error;
        block = { type: "text", text: "OWNED_FIXTURE_FAILED" };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              role: "assistant",
              id: `capability-${index}`,
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
    })().catch((error) => {
      handlerError = error;
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("close", () => resolve());
            child.kill("SIGTERM");
          }),
      ),
    );
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned API address missing");
  const cli = (tools: string, extra: string[] = []) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
            "--cwd",
            cwd,
            "-p",
            "MAIN_PRIVATE_TASK",
            "--model",
            "claude-sonnet-4-6",
            "--output-format",
            "json",
            "--tools",
            tools,
            ...extra,
          ],
          {
            env: {
              ...process.env,
              HOME: join(root, "home"),
              CLAUDE_CONFIG_DIR: config,
              TAU_HOME: state,
              TAU_MANAGED_ROOT: join(root, "managed"),
              CLAUDE_CODE_FORK_SUBAGENT: "0",
              CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
              CLAUDE_CODE_ENABLE_TASKS: "1",
              CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
              CLAUDE_CODE_TASK_LIST_ID: "",
              CLAUDE_CODE_EFFORT_LEVEL: "",
              CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "",
              ANTHROPIC_API_KEY: "owned-dummy",
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.add(child);
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          children.delete(child);
          if (handlerError !== undefined) reject(handlerError);
          else resolve({ code, stdout, stderr });
        });
      },
    );
  const skill = async (
    name: string,
    metadata: Record<string, unknown>,
    body: string,
  ) => {
    const path = join(config, "skills", name);
    await mkdir(path);
    await writeFile(
      join(path, "SKILL.md"),
      `---\n${JSON.stringify(metadata)}\n---\n${body}`,
    );
  };
  return {
    root,
    cwd,
    config,
    state,
    bodies,
    cli,
    skill,
    respond: (next: typeof responder) => {
      responder = next;
    },
  };
}

test(
  "compiled omitted Agent type runs built-in general-purpose with fresh child history",
  async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, "input.txt"), "OWNED_DEFAULT_BYTES");
    f.respond((_body, index) =>
      index === 1
        ? use(
            "Agent",
            {
              description: "Read owned data",
              prompt: "DEFAULT_PRIVATE_CHILD_TASK",
              run_in_background: false,
            },
            "delegate",
          )
        : index === 2
          ? use("Read", { file_path: "input.txt" }, "read")
          : {
              type: "text",
              text: index === 3 ? "DEFAULT_CHILD_REPORT" : "PARENT_DONE",
            },
    );
    const execution = await f.cli("Agent,Read");
    assert.equal(execution.code, 0, execution.stderr);
    assert.equal(f.bodies.length, 4);
    const child = f.bodies[1];
    if (!child) throw new Error("Child request missing");
    assert.match(userText(child), /DEFAULT_PRIVATE_CHILD_TASK/);
    assert.equal(userText(child).includes("MAIN_PRIVATE_TASK"), false);
    const parent = f.bodies[3];
    if (!parent) throw new Error("Parent result request missing");
    assert.match(
      JSON.stringify(result(parent, "delegate")),
      /DEFAULT_CHILD_REPORT/,
    );
  },
  { timeout: 15000 },
);

test(
  "built-in Explore omits all initial instruction context and still discovers nested instructions after Read",
  async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, "nested"));
    await writeFile(join(f.cwd, "CLAUDE.md"), "INITIAL_PROJECT_PRIVATE");
    await writeFile(join(f.config, "CLAUDE.md"), "INITIAL_USER_PRIVATE");
    await writeFile(
      join(f.root, "managed", "CLAUDE.md"),
      "INITIAL_MANAGED_PRIVATE",
    );
    await writeFile(join(f.cwd, "nested", "CLAUDE.md"), "NESTED_READ_GUIDANCE");
    await writeFile(join(f.cwd, "nested", "input.txt"), "NESTED_BYTES");
    f.respond((body, index) => {
      if (index === 1) {
        assert.match(userText(body), /INITIAL_PROJECT_PRIVATE/);
        assert.match(userText(body), /INITIAL_USER_PRIVATE/);
        assert.match(userText(body), /INITIAL_MANAGED_PRIVATE/);
        return use(
          "Agent",
          {
            description: "Explore owned tree",
            prompt: "EXPLORE_CHILD_TASK",
            subagent_type: "Explore",
            run_in_background: false,
          },
          "explore",
        );
      }
      if (index === 2) {
        assert.equal(userText(body).includes("INITIAL_"), false);
        assert.equal(
          body.tools.some((tool) =>
            ["Write", "Edit", "Agent"].includes(tool.name),
          ),
          false,
        );
        return use("Read", { file_path: "nested/input.txt" }, "nested-read");
      }
      if (index === 3) {
        assert.match(
          JSON.stringify(result(body, "nested-read")),
          /NESTED_READ_GUIDANCE/,
        );
        assert.equal(
          JSON.stringify(body.messages).includes("INITIAL_MANAGED_PRIVATE"),
          false,
        );
        return { type: "text", text: "EXPLORE_REPORT" };
      }
      assert.match(JSON.stringify(result(body, "explore")), /EXPLORE_REPORT/);
      return { type: "text", text: "PARENT_EXPLORED" };
    });
    const execution = await f.cli("Agent,Read,Write,Edit");
    assert.equal(execution.code, 0, execution.stderr);
    assert.equal(f.bodies.length, 4);
  },
  { timeout: 15000 },
);

test(
  "compiled foreground child preloads passively, applies inline Skill locally and shares parent Task CRUD",
  async () => {
    const f = await fixture();
    await f.skill(
      "passive-a",
      {
        description: "Passive A",
        "allowed-tools": "Write",
        model: "haiku",
        effort: "max",
        context: "fork",
      },
      "PASSIVE_A_BODY",
    );
    await f.skill("passive-b", { description: "Passive B" }, "PASSIVE_B_BODY");
    await f.skill(
      "conditional",
      { description: "Inactive conditional", paths: ["never/**"] },
      "CONDITIONAL_HIDDEN_BODY",
    );
    await f.skill(
      "inline",
      {
        description: "Inline write",
        "allowed-tools": "Write",
        model: "claude-haiku-4-5-20251001",
        effort: "low",
      },
      "INLINE_CHILD_BODY",
    );
    await writeFile(
      join(f.config, "agents", "capable.md"),
      `---\n${JSON.stringify({ name: "capable", description: "Owned composition", tools: "Write,Skill,TaskCreate,TaskGet,TaskUpdate,TaskList", model: "inherit", effort: "high", maxTurns: 8, skills: ["passive-a", "passive-b", "passive-a", "conditional"] })}\n---\nCHILD_CAPABILITIES_SYSTEM`,
    );
    const hook = join(f.config, "start.cjs");
    await writeFile(
      hook,
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'START_CAP_CONTEXT'}})));",
    );
    await writeFile(
      join(f.config, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Skill(inline)"] },
        hooks: {
          SubagentStart: [
            {
              matcher: "capable",
              hooks: [
                { type: "command", command: process.execPath, args: [hook] },
              ],
            },
          ],
        },
      }),
    );
    let childRequests = 0,
      parentRequests = 0;
    f.respond((body) => {
      if (system(body).includes("CHILD_CAPABILITIES_SYSTEM")) {
        const step = ++childRequests;
        if (step === 1) {
          const context = userText(body);
          assert.ok(
            context.indexOf("CHILD_PRIVATE_TASK") <
              context.indexOf("START_CAP_CONTEXT"),
          );
          assert.ok(
            context.indexOf("START_CAP_CONTEXT") <
              context.indexOf("PASSIVE_A_BODY"),
          );
          assert.ok(
            context.indexOf("PASSIVE_A_BODY") <
              context.indexOf("PASSIVE_B_BODY"),
          );
          assert.equal(context.includes("CONDITIONAL_HIDDEN_BODY"), false);
          assert.equal(context.split("PASSIVE_A_BODY").length, 2);
          return use(
            "Write",
            { file_path: "before.txt", content: "must be denied" },
            "before",
          );
        }
        if (step === 2) {
          assert.equal(result(body, "before").is_error, true);
          return use("Skill", { skill: "inline" }, "skill");
        }
        assert.equal(
          result(body, "skill").is_error,
          undefined,
          JSON.stringify(result(body, "skill")),
        );
        assert.equal(body.model, "claude-sonnet-4-6");
        assert.equal(body.output_config?.effort, "low");
        if (step === 3) {
          assert.match(userText(body), /INLINE_CHILD_BODY/);
          return use(
            "Write",
            { file_path: "after.txt", content: "CHILD_WRITE" },
            "after",
          );
        }
        if (step === 4) {
          assert.equal(result(body, "after").is_error, undefined);
          return use(
            "TaskCreate",
            { subject: "Owned shared task", description: "child-created" },
            "create",
          );
        }
        if (step === 5) return use("TaskGet", { taskId: "1" }, "get");
        if (step === 6) {
          assert.match(
            JSON.stringify(result(body, "get")),
            /Owned shared task/,
          );
          return use(
            "TaskUpdate",
            { taskId: "1", status: "completed" },
            "update",
          );
        }
        if (step === 7) return use("TaskList", {}, "list");
        assert.match(JSON.stringify(result(body, "list")), /completed/);
        return { type: "text", text: "CAPABLE_CHILD_REPORT" };
      }
      if (++parentRequests === 1)
        return use(
          "Agent",
          {
            description: "Owned composition",
            prompt: "CHILD_PRIVATE_TASK",
            subagent_type: "capable",
            run_in_background: false,
          },
          "delegate",
        );
      if (parentRequests === 2) {
        assert.equal(result(body, "delegate").is_error, undefined);
        return use("TaskGet", { taskId: "1" }, "parent-get");
      }
      assert.match(JSON.stringify(result(body, "parent-get")), /completed/);
      return { type: "text", text: "PARENT_SHARED_TASK_DONE" };
    });
    const execution = await f.cli(
      "Agent,Write,Skill,TaskCreate,TaskGet,TaskUpdate,TaskList",
      ["--max-turns", "3"],
    );
    assert.equal(execution.code, 0, execution.stderr);
    assert.equal(childRequests, 8);
    assert.equal(parentRequests, 3);
    assert.equal(
      await readFile(join(f.cwd, "after.txt"), "utf8"),
      "CHILD_WRITE",
    );
    await assert.rejects(readFile(join(f.cwd, "before.txt")), {
      code: "ENOENT",
    });
    const terminal = z
      .object({ session_id: z.string(), result: z.string() })
      .parse(JSON.parse(execution.stdout));
    assert.equal(terminal.result, "PARENT_SHARED_TASK_DONE");
    const stored = z
      .object({ status: z.string(), owner: z.string().optional() })
      .parse(
        JSON.parse(
          await readFile(
            join(f.config, "tasks", terminal.session_id, "1.json"),
            "utf8",
          ),
        ),
      );
    assert.equal(stored.status, "completed");
    assert.equal(stored.owner, undefined);
  },
  { timeout: 15000 },
);
