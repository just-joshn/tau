import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

const bodySchema = z.object({
  system: z.union([z.string(), z.array(z.object({ text: z.string() }))]),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())),
      ]),
    }),
  ),
});
type Body = z.infer<typeof bodySchema>;
type Action =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object };

const systemText = (body: Body) =>
  typeof body.system === "string"
    ? body.system
    : body.system.map((block) => block.text).join("\n\n");
const messageText = (body: Body) => JSON.stringify(body.messages);
function toolResult(body: Body, id: string) {
  for (const message of body.messages)
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (block.type === "tool_result" && block.tool_use_id === id)
          return block;
  throw new Error(`Missing tool result ${id}`);
}

/** A loopback API whose replies come from `respond`, and a real CLI process per run. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-auto-mem-"))),
    cwd = join(root, "work"),
    config = join(root, "config");
  for (const path of [cwd, config, join(root, "home"), join(root, "state")])
    await mkdir(path, { recursive: true });
  const bodies: Body[] = [];
  let respond: (body: Body) => Action = () => ({ type: "text", text: "OK" });
  let failure: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = bodySchema.parse(JSON.parse(raw));
      bodies.push(body);
      let action: Action;
      try {
        action = respond(body);
      } catch (error) {
        failure ??= error;
        action = { type: "text", text: "FIXTURE_FAILED" };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `auto-memory-${bodies.length}`,
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
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  const memory = join(
    config,
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    "memory",
  );
  return {
    cwd,
    memory,
    bodies,
    respond(next: (body: Body) => Action) {
      respond = next;
    },
    async run(env: Record<string, string> = {}) {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
          "--print",
          "REMEMBER_THIS",
          "--model",
          "claude-sonnet-4-5",
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-turns",
          "5",
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: config,
            TAU_HOME: join(root, "state"),
            TAU_MANAGED_ROOT: join(root, "managed"),
            ANTHROPIC_API_KEY: "owned-dummy",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      const code = await new Promise<number | null>((done) =>
        child.once("close", done),
      );
      if (failure !== undefined) throw failure;
      const lines = out
        .split("\n")
        .filter(Boolean)
        .map((line) =>
          z.record(z.string(), z.unknown()).parse(JSON.parse(line)),
        );
      return { code, err, init: lines.find((line) => line.subtype === "init") };
    },
  };
}

test("a print session writes memory without approval and the next session loads MEMORY.md", async () => {
  const f = await fixture(),
    topic = join(f.memory, "user_role.md"),
    index = join(f.memory, "MEMORY.md");
  let step = 0;
  f.respond((body) => {
    step++;
    if (step === 1) {
      assert.match(
        systemText(body),
        new RegExp(
          `# auto memory\n\nYou have a persistent, file-based memory system at \`${f.memory}/\`\\.`,
        ),
      );
      return {
        type: "tool_use",
        id: "write-topic",
        name: "Write",
        input: {
          file_path: topic,
          content:
            "---\nname: user-role\ndescription: role\nmetadata:\n  type: user\n---\n\nUser is a data scientist.\n",
        },
      };
    }
    if (step === 2) {
      assert.equal(toolResult(body, "write-topic").is_error, undefined);
      return {
        type: "tool_use",
        id: "write-index",
        name: "Write",
        input: {
          file_path: index,
          content:
            "- [User role](user_role.md) \u2014 AUTO_MEMORY_INDEX_LINE\n",
        },
      };
    }
    assert.equal(toolResult(body, "write-index").is_error, undefined);
    return { type: "text", text: "SAVED" };
  });
  const first = await f.run();
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(first.init?.memory_paths, { auto: `${f.memory}/` });
  assert.match(await readFile(topic, "utf8"), /data scientist/);
  assert.match(await readFile(index, "utf8"), /AUTO_MEMORY_INDEX_LINE/);

  f.respond((body) => {
    assert.match(messageText(body), /AUTO_MEMORY_INDEX_LINE/);
    assert.match(messageText(body), new RegExp(`${f.memory}/MEMORY\\.md`));
    return { type: "text", text: "RECALLED" };
  });
  const second = await f.run();
  assert.equal(second.code, 0, second.err);
  assert.equal(f.bodies.length, 4);
});

test("a non-Markdown memory file still needs approval, which print mode denies", async () => {
  const f = await fixture();
  let step = 0;
  f.respond((body) => {
    if (++step === 1)
      return {
        type: "tool_use",
        id: "write-text",
        name: "Write",
        input: { file_path: join(f.memory, "notes.txt"), content: "x" },
      };
    assert.equal(toolResult(body, "write-text").is_error, true);
    return { type: "text", text: "HELD" };
  });
  const run = await f.run();
  assert.equal(run.code, 0, run.err);
  await assert.rejects(readFile(join(f.memory, "notes.txt")));
});

test("CLAUDE_CODE_DISABLE_AUTO_MEMORY drops the section, the index and memory_paths", async () => {
  const f = await fixture();
  await mkdir(f.memory, { recursive: true });
  await Bun.write(join(f.memory, "MEMORY.md"), "AUTO_MEMORY_DISABLED_LINE\n");
  f.respond((body) => {
    assert.equal(systemText(body).includes("# auto memory"), false);
    assert.equal(
      messageText(body).includes("AUTO_MEMORY_DISABLED_LINE"),
      false,
    );
    return { type: "text", text: "OFF" };
  });
  const run = await f.run({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.init?.memory_paths, undefined);
});
