import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fixtureSse } from "./sse-fixture.js";

const textSchema = z.object({ type: z.literal("text"), text: z.string() });
const bodySchema = z.object({
  system: z.union([z.string(), z.array(textSchema)]),
  messages: z.array(
    z.object({ role: z.string(), content: z.array(z.unknown()) }),
  ),
  tools: z.array(z.object({ name: z.string() })),
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
const tool = (
  name: string,
  input: Record<string, unknown>,
  id: string,
): Action => ({ type: "tool_use", name, input, id });
const system = (body: Body) =>
  typeof body.system === "string"
    ? body.system
    : body.system.map((value) => value.text).join("\n");
const resultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
});
function result(body: Body, id: string) {
  for (const message of body.messages)
    for (const block of message.content) {
      const parsed = resultSchema.safeParse(block);
      if (parsed.success && parsed.data.tool_use_id === id) return parsed.data;
    }
  throw Error(`Missing owned tool result: ${id}`);
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-memory-"))),
    cwd = join(root, "project"),
    config = join(root, ".claude"),
    state = join(root, "state");
  for (const path of [
    cwd,
    join(config, "agents"),
    state,
    join(root, "home"),
    join(root, "managed"),
  ])
    await mkdir(path, { recursive: true });
  const children = new Set<ChildProcess>(),
    bodies: Body[] = [];
  let handlerError: unknown;
  let respond: (body: Body) => Action = () => ({
    type: "text",
    text: "OWNED_FINAL",
  });
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      let action: Action;
      try {
        action =
          handlerError === undefined
            ? respond(body)
            : { type: "text", text: "OWNED_FIXTURE_FAILED" };
      } catch (error) {
        handlerError = error;
        action = { type: "text", text: "OWNED_FIXTURE_FAILED" };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `memory-${bodies.length}`,
              role: "assistant",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: action },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: action.type === "tool_use" ? "tool_use" : "end_turn",
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
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Owned API address missing");
  const port = address.port;
  onTestFinished(async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return done();
            child.once("close", () => done());
            child.kill("SIGTERM");
          }),
      ),
    );
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    cwd,
    config,
    bodies,
    respond(next: typeof respond) {
      respond = next;
    },
    async agent(name: string, memory: "user" | "project" | "local") {
      await writeFile(
        join(config, "agents", `${name}.md`),
        `---\nname: ${name}\ndescription: Owned memory fixture\ntools: Read\nmemory: ${memory}\nmodel: inherit\nmaxTurns: 6\n---\nOWNED_MEMORY_AGENT`,
      );
      return memory === "user"
        ? join(config, "agent-memory", name)
        : join(
            cwd,
            ".claude",
            memory === "project" ? "agent-memory" : "agent-memory-local",
            name,
          );
    },
    async cli(
      tools: string,
      extra: string[] = [],
      env: NodeJS.ProcessEnv = {},
    ) {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "--cwd",
          cwd,
          "--print",
          "OWNED_MEMORY_PARENT",
          "--model",
          "claude-sonnet-4-6",
          "--output-format",
          "json",
          "--tools",
          tools,
          "--max-turns",
          "5",
          ...extra,
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: config,
            TAU_MANAGED_ROOT: join(root, "managed"),
            TAU_HOME: state,
            CLAUDE_CODE_FORK_SUBAGENT: "0",
            CLAUDE_CODE_SIMPLE: "",
            CLAUDE_CODE_SAFE_MODE: "",
            CLAUDE_CODE_REMOTE: "",
            CLAUDE_CODE_REMOTE_MEMORY_DIR: "",
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "",
            ANTHROPIC_API_KEY: "owned-dummy",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let out = "",
        err = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
      children.delete(child);
      if (handlerError !== undefined) throw handlerError;
      return { code, out, err };
    },
  };
}
const delegate = (name: string, prompt: string, id: string) =>
  tool(
    "Agent",
    {
      subagent_type: name,
      description: "Owned memory",
      prompt,
      run_in_background: false,
    },
    id,
  );

test(
  "child user memory persists through Read/Edit/Write, reloads for the next child, and leaves non-Markdown writes held",
  async () => {
    const f = await fixture(),
      directory = await f.agent("memory-reader", "user"),
      index = join(directory, "MEMORY.md"),
      topic = join(directory, "topic.md"),
      blocked = join(directory, "blocked.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(index, "MEMORY_INDEX_OLD\n");
    let parent = 0,
      child = 0;
    f.respond((body) => {
      if (system(body).includes("OWNED_MEMORY_AGENT")) {
        const step = ++child;
        assert.deepEqual(body.tools.map((value) => value.name).sort(), [
          "Edit",
          "Read",
          "Write",
        ]);
        if (step === 1) {
          assert.match(system(body), /MEMORY_INDEX_OLD/);
          return tool("Read", { file_path: index }, "memory-read");
        }
        if (step === 2) {
          assert.equal(result(body, "memory-read").is_error, undefined);
          return tool(
            "Edit",
            {
              file_path: index,
              old_string: "MEMORY_INDEX_OLD",
              new_string: "MEMORY_INDEX_NEW",
            },
            "memory-edit",
          );
        }
        if (step === 3) {
          assert.equal(result(body, "memory-edit").is_error, undefined);
          return tool(
            "Write",
            { file_path: topic, content: "MEMORY_TOPIC_BODY" },
            "memory-write",
          );
        }
        if (step === 4) {
          assert.equal(result(body, "memory-write").is_error, undefined);
          return tool(
            "Write",
            { file_path: blocked, content: "MUST_NOT_WRITE" },
            "memory-blocked",
          );
        }
        if (step === 5) {
          assert.equal(result(body, "memory-blocked").is_error, true);
          return { type: "text", text: "FIRST_MEMORY_CHILD_FINISHED" };
        }
        assert.equal(step, 6);
        assert.match(system(body), /MEMORY_INDEX_NEW/);
        assert.equal(system(body).includes("MEMORY_TOPIC_BODY"), false);
        return { type: "text", text: "SECOND_MEMORY_CHILD_FINISHED" };
      }
      if (++parent === 1)
        return delegate("memory-reader", "FIRST_MEMORY_CHILD", "first-child");
      if (parent === 2) {
        assert.match(
          JSON.stringify(result(body, "first-child")),
          /FIRST_MEMORY_CHILD_FINISHED/,
        );
        return delegate("memory-reader", "SECOND_MEMORY_CHILD", "second-child");
      }
      if (parent === 3)
        return tool("Read", { file_path: topic }, "parent-memory-read");
      assert.match(
        JSON.stringify(result(body, "parent-memory-read")),
        /MEMORY_TOPIC_BODY/,
      );
      return { type: "text", text: "OWNED_MEMORY_PARENT_FINISHED" };
    });
    const execution = await f.cli("Agent,Read,Write,Edit");
    assert.equal(execution.code, 0, execution.err);
    assert.match(execution.out, /OWNED_MEMORY_PARENT_FINISHED/);
    assert.equal(parent, 4);
    assert.equal(child, 6);
    assert.equal(await readFile(index, "utf8"), "MEMORY_INDEX_NEW\n");
    assert.equal(await readFile(topic, "utf8"), "MEMORY_TOPIC_BODY");
    await assert.rejects(readFile(blocked), { code: "ENOENT" });
  },
  { timeout: 15000 },
);

for (const scope of ["project", "local"] as const)
  test(
    `declared ${scope} memory writes its real scoped index in default mode`,
    async () => {
      const f = await fixture(),
        name = `${scope}-memory`,
        directory = await f.agent(name, scope),
        index = join(directory, "MEMORY.md");
      let parent = 0,
        child = 0;
      f.respond((body) => {
        if (system(body).includes("OWNED_MEMORY_AGENT")) {
          if (++child === 1) {
            assert.ok(system(body).includes(directory));
            return tool(
              "Write",
              { file_path: index, content: `OWNED_${scope}_MEMORY` },
              "scope-write",
            );
          }
          assert.equal(result(body, "scope-write").is_error, undefined);
          return { type: "text", text: "SCOPED_MEMORY_WRITTEN" };
        }
        if (++parent === 1)
          return delegate(name, "WRITE_SCOPE_MEMORY", "scope-agent");
        return { type: "text", text: "SCOPED_PARENT_FINISHED" };
      });
      const execution = await f.cli("Agent,Read,Write,Edit");
      assert.equal(execution.code, 0, execution.err);
      assert.equal(child, 2);
      assert.equal(await readFile(index, "utf8"), `OWNED_${scope}_MEMORY`);
    },
    { timeout: 15000 },
  );

test(
  "memory file recognition remains separate from the disabled prompt/registry gate",
  async () => {
    const f = await fixture(),
      directory = await f.agent("disabled-memory", "user"),
      index = join(directory, "MEMORY.md"),
      note = join(directory, "topic.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(index, "DISABLED_INDEX_MUST_NOT_LOAD");
    await writeFile(note, "ARBITRARY_EXTENSION_MEMORY_READ");
    let parent = 0;
    f.respond((body) => {
      if (system(body).includes("OWNED_MEMORY_AGENT")) {
        assert.equal(
          system(body).includes("DISABLED_INDEX_MUST_NOT_LOAD"),
          false,
        );
        assert.deepEqual(
          body.tools.map((value) => value.name),
          ["Read"],
        );
        return { type: "text", text: "DISABLED_MEMORY_CHILD_FINISHED" };
      }
      if (++parent === 1)
        return delegate(
          "disabled-memory",
          "NO_MEMORY_PROMPT",
          "disabled-agent",
        );
      if (parent === 2) return tool("Read", { file_path: note }, "memory-note");
      assert.match(
        JSON.stringify(result(body, "memory-note")),
        /ARBITRARY_EXTENSION_MEMORY_READ/,
      );
      return { type: "text", text: "DISABLED_MEMORY_PARENT_FINISHED" };
    });
    const execution = await f.cli("Agent,Read,Write,Edit", [], {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    assert.equal(execution.code, 0, execution.err);
    assert.equal(parent, 3);
  },
  { timeout: 15000 },
);

test(
  "memory allowance cannot waive a settings target, parent deny, hook ask or external symlink",
  async () => {
    const f = await fixture(),
      directory = join(f.config, "agent-memory", "protected"),
      settings = join(directory, "settings.md"),
      denied = join(directory, "denied.md"),
      asked = join(directory, "asked.md"),
      escape = join(directory, "escape.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(settings, "{}");
    const outside = join(f.root, "outside.txt");
    await writeFile(outside, "OUTSIDE_MEMORY_SECRET");
    await symlink(outside, escape);
    let step = 0;
    f.respond((body) => {
      if (++step === 1)
        return tool("Read", { file_path: settings }, "settings-read");
      if (step === 2)
        return tool(
          "Write",
          { file_path: settings, content: "MUST_NOT_CHANGE_SETTINGS" },
          "settings-write",
        );
      if (step === 3) {
        assert.equal(result(body, "settings-write").is_error, true);
        return tool("Read", { file_path: escape }, "escape-read");
      }
      assert.equal(result(body, "escape-read").is_error, true);
      assert.equal(
        JSON.stringify(body.messages).includes("OUTSIDE_MEMORY_SECRET"),
        false,
      );
      return { type: "text", text: "PROTECTED_FINISHED" };
    });
    let execution = await f.cli("Read,Write", ["--settings", settings]);
    assert.equal(execution.code, 0, execution.err);
    assert.equal(await readFile(settings, "utf8"), "{}");
    step = 0;
    f.respond((body) => {
      if (++step === 1)
        return tool(
          "Write",
          { file_path: denied, content: "MUST_NOT_WRITE" },
          "denied-write",
        );
      assert.equal(result(body, "denied-write").is_error, true);
      return { type: "text", text: "DENY_FINISHED" };
    });
    execution = await f.cli("Read,Write", ["--disallowedTools", "Write"]);
    assert.equal(execution.code, 0, execution.err);
    await assert.rejects(readFile(denied), { code: "ENOENT" });
    const hook = join(f.root, "ask.cjs");
    await writeFile(
      hook,
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask'}})));",
    );
    step = 0;
    f.respond((body) => {
      if (++step === 1)
        return tool(
          "Write",
          { file_path: asked, content: "MUST_NOT_WRITE" },
          "asked-write",
        );
      assert.equal(result(body, "asked-write").is_error, true);
      return { type: "text", text: "ASK_FINISHED" };
    });
    execution = await f.cli("Read,Write", [
      "--settings",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [
                { type: "command", command: process.execPath, args: [hook] },
              ],
            },
          ],
        },
      }),
    ]);
    assert.equal(execution.code, 0, execution.err);
    await assert.rejects(readFile(asked), { code: "ENOENT" });
  },
  { timeout: 15000 },
);
