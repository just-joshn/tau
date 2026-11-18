import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

const bodySchema = z.looseObject({
  model: z.string(),
  system: z.unknown(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.array(z.unknown())]),
    }),
  ),
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
const TOOLS_HASH =
  "66a62382745d1ae026ac3e5d33fe35c5ca515435c1b3e738a46a163d3bff1fed";
const GUIDANCE_HASH =
  "2096ac34f3bf27bb68cf7217475054f9b169fa212e722db614f127fb89b93099";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const blockText = (block: unknown): string => {
  if (typeof block !== "object" || block === null || !("text" in block))
    return "";
  return typeof block.text === "string" ? block.text : "";
};
const systemText = (system: unknown): string => {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map(blockText).join("\n\n");
};
const section = (body: string, heading: string): string => {
  const chunk = body
    .split("\n\n# ")
    .find(
      (part) =>
        part.startsWith(`${heading}\n`) || part.startsWith(`# ${heading}\n`),
    );
  if (!chunk) return "";
  return chunk.startsWith("# ") ? chunk : `# ${chunk}`;
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-fork-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    config = join(root, "config"),
    home = join(root, "home"),
    skill = join(config, "skills", "owned");
  for (const path of [cwd, skill, home, join(root, "managed")])
    await mkdir(path, { recursive: true });
  await writeFile(join(cwd, "owned.txt"), "CHILD_PRIVATE_FILE\n");
  await writeFile(
    join(skill, "SKILL.md"),
    "---\ndescription: An owned local workflow\n---\nOWNED_SKILL_BODY\n",
  );
  const bodies: Body[] = [];
  let responder: (body: Body) => Action = () => ({
    type: "text",
    text: "done",
  });
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = bodySchema.parse(JSON.parse(raw));
    bodies.push(body);
    const block = responder(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      fixtureSse([
        {
          type: "message_start",
          message: {
            id: `fork-response-${bodies.length}`,
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    TAU_MANAGED_ROOT: join(root, "managed"),
    TAU_HOME: join(root, "state"),
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    ANTHROPIC_API_KEY: "owned-dummy",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  for (const key of [
    "CLAUDE_CODE_FORK_SUBAGENT",
    "CLAUDE_CODE_EMBEDDED_SEARCH",
    "CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS",
    "CLAUDE_CODE_ENABLE_TASKS",
    "CLAUDE_CODE_ENABLE_TODO_TOOLS",
  ])
    delete env[key];
  if (env.CLAUDE_CODE_ENTRYPOINT === "local-agent")
    delete env.CLAUDE_CODE_ENTRYPOINT;
  const cli = () =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
            "--cwd",
            cwd,
            "-p",
            "PARENT_PRIVATE_PROMPT",
            "--model",
            "claude-sonnet-4-6",
            "--max-turns",
            "3",
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
          ],
          { env, stdio: ["ignore", "pipe", "pipe"] },
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
    bodies,
    cli,
    respond: (fn: (body: Body) => Action) => {
      responder = fn;
    },
  };
}

test(
  "compiled print CLI matches the fork prompt sections and keeps a fork's tool output out of the parent",
  async () => {
    const f = await fixture();
    f.respond((body) => {
      const transcript = JSON.stringify(body.messages);
      if (transcript.includes("<fork-boilerplate>")) {
        if (!transcript.includes("CHILD_PRIVATE_FILE"))
          return {
            type: "tool_use",
            id: "fork-read",
            name: "Read",
            input: { file_path: "owned.txt" },
          };
        return { type: "text", text: "FORK_FINAL_REPORT" };
      }
      if (!transcript.includes("FORK_FINAL_REPORT"))
        return {
          type: "tool_use",
          id: "parent-fork",
          name: "Agent",
          input: {
            description: "Fork the owned read",
            prompt: "Read owned.txt and report the marker",
            subagent_type: "fork",
            model: "opus",
            run_in_background: false,
          },
        };
      return { type: "text", text: "PARENT_FINAL" };
    });
    const execution = await f.cli();
    assert.equal(execution.code, 0, execution.err);
    const first = systemText(f.bodies[0]?.system);
    const tools = section(first, "Using your tools");
    const guidance = section(first, "Session-specific guidance");
    assert.equal(sha(tools), TOOLS_HASH, tools);
    assert.equal(sha(guidance), GUIDANCE_HASH, guidance);
    const child = f.bodies.find((body) =>
      JSON.stringify(body.messages).includes("<fork-boilerplate>"),
    );
    assert.ok(child);
    const childText = JSON.stringify(child.messages);
    assert.match(childText, /PARENT_PRIVATE_PROMPT/);
    assert.match(childText, /Your directive: Read owned.txt/);
    assert.equal(child.model, "claude-sonnet-4-6");
    const parentAgain = f.bodies.find(
      (body) =>
        JSON.stringify(body.messages).includes("FORK_FINAL_REPORT") &&
        !JSON.stringify(body.messages).includes("<fork-boilerplate>"),
    );
    assert.ok(parentAgain);
    assert.equal(
      JSON.stringify(parentAgain.messages).includes("CHILD_PRIVATE_FILE"),
      false,
    );
    assert.match(execution.out, /PARENT_FINAL/);
  },
  { timeout: 20000 },
);
