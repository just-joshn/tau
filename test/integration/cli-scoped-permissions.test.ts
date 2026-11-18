import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

const bodySchema = z.object({
  system: z.union([z.string(), z.array(z.object({ text: z.string() }))]),
  messages: z.array(
    z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
  ),
});
const resultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
type Body = z.infer<typeof bodySchema>;
const result = (body: Body, id: string) => {
  for (const message of body.messages)
    for (const block of typeof message.content === "string"
      ? []
      : message.content) {
      const parsed = resultSchema.safeParse(block);
      if (parsed.success && parsed.data.tool_use_id === id) return parsed.data;
    }
  throw Error(`Missing result ${id}`);
};
const tool = (name: string, input: Record<string, unknown>, id: string) => ({
  type: "tool_use" as const,
  name,
  input,
  id,
});

test(
  "Bun CLI binds scoped file and Bash policies for main and child tools and rechecks hook replacements",
  async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "tau-cli-scoped-")),
      ),
      cwd = join(root, "work"),
      config = join(root, "config");
    for (const dir of [cwd, config, join(config, "agents"), join(root, "home")])
      await mkdir(dir, { recursive: true });
    await writeFile(join(cwd, "private.txt"), "MUST_NOT_EXPOSE");
    await writeFile(
      join(config, "agents/scoped-child.md"),
      "---\nname: scoped-child\ndescription: Owned scoped fixture\ntools: Read, Write, Bash\nmodel: inherit\nmaxTurns: 5\n---\nOWNED_SCOPED_CHILD",
    );
    const hook = join(root, "rewrite.cjs");
    await writeFile(
      hook,
      `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{let e=JSON.parse(s);if(e.tool_input.file_path.endsWith('/out/rewrite.txt'))process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{file_path:'blocked.txt',content:'MUST_NOT_WRITE'}}}));});`,
    );
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Agent", "Edit(out/**)", "Bash(printf:*)"],
          deny: [
            "Read(private.txt)",
            "Edit(blocked.txt)",
            "Bash(printf blocked:*)",
          ],
          ask: ["Edit(out/asked.txt)"],
        },
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
    );
    let parent = 0,
      child = 0,
      request = 0,
      handlerError: unknown;
    let processChild: ChildProcess | undefined;
    let rejectHandler: (reason: unknown) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      rejectHandler = reject;
    });
    const server = createServer((req, res) => {
      void (async () => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const body = bodySchema.parse(JSON.parse(raw));
        const system =
          typeof body.system === "string"
            ? body.system
            : body.system.map((block) => block.text).join("\n");
        const action = (() => {
          if (system.includes("OWNED_SCOPED_CHILD")) {
            if (++child === 1)
              return tool(
                "Write",
                { file_path: "out/child.txt", content: "CHILD_GRANTED" },
                "child-write",
              );
            if (child === 2) {
              assert.equal(result(body, "child-write").is_error, undefined);
              return tool("Read", { file_path: "private.txt" }, "child-denied");
            }
            assert.equal(result(body, "child-denied").is_error, true);
            assert.equal(
              JSON.stringify(body.messages).includes("MUST_NOT_EXPOSE"),
              false,
            );
            return { type: "text" as const, text: "CHILD_SCOPE_FINISHED" };
          }
          switch (++parent) {
            case 1:
              return tool(
                "Write",
                { file_path: "out/main.txt", content: "MAIN_GRANTED" },
                "main-write",
              );
            case 2:
              assert.equal(result(body, "main-write").is_error, undefined);
              return tool(
                "Write",
                { file_path: "other.txt", content: "NO" },
                "outside-scope",
              );
            case 3:
              assert.equal(result(body, "outside-scope").is_error, true);
              return tool(
                "Write",
                { file_path: "out/asked.txt", content: "NO" },
                "ask",
              );
            case 4:
              assert.equal(result(body, "ask").is_error, true);
              return tool(
                "Write",
                { file_path: "out/rewrite.txt", content: "NO" },
                "rewrite",
              );
            case 5:
              assert.equal(result(body, "rewrite").is_error, true);
              return tool(
                "Bash",
                { command: "printf owned-command" },
                "bash-allow",
              );
            case 6:
              assert.equal(result(body, "bash-allow").is_error, undefined);
              return tool(
                "Bash",
                { command: "printf blocked now" },
                "bash-deny",
              );
            case 7:
              assert.equal(result(body, "bash-deny").is_error, true);
              return tool(
                "Agent",
                {
                  subagent_type: "scoped-child",
                  description: "Owned scope",
                  prompt: "USE_INHERITED_SCOPE",
                  run_in_background: false,
                },
                "child",
              );
            default:
              assert.match(
                JSON.stringify(result(body, "child")),
                /CHILD_SCOPE_FINISHED/,
              );
              return {
                type: "text" as const,
                text: "SCOPED_WORKFLOW_FINISHED",
              };
          }
        })();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          fixtureSse([
            {
              type: "message_start",
              message: {
                id: `scoped-${++request}`,
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
                stop_reason:
                  action.type === "tool_use" ? "tool_use" : "end_turn",
              },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ]),
        );
      })().catch((error) => {
        handlerError = error;
        rejectHandler(error);
        res.destroy();
      });
    });
    onTestFinished(async () => {
      if (
        processChild &&
        processChild.exitCode === null &&
        processChild.signalCode === null
      ) {
        const closed = new Promise<void>((done) =>
          processChild?.once("close", () => done()),
        );
        processChild.kill("SIGTERM");
        await closed;
      }
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Owned server missing");
    processChild = spawn(
      process.execPath,
      [
        resolve("src/cli.ts"),
        "--cwd",
        cwd,
        "--print",
        "OWNED_SCOPED_PARENT",
        "--model",
        "claude-sonnet-4-6",
        "--tools",
        "Read,Write,Bash,Agent",
        "--max-turns",
        "12",
      ],
      {
        env: {
          ...process.env,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: config,
          TAU_MANAGED_ROOT: join(root, "managed"),
          TAU_HOME: join(root, "state"),
          ANTHROPIC_API_KEY: "owned-dummy",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CODE_SIMPLE: "",
          CLAUDE_CODE_REMOTE: "",
          CLAUDE_CODE_TETHER_LIVE: "",
          CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "",
          CLAUDE_CODE_EVAL_CONFINED: "",
          CLAUDE_CODE_FORK_SUBAGENT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    processChild.stdout?.on("data", (chunk) => (out += String(chunk)));
    processChild.stderr?.on("data", (chunk) => (err += String(chunk)));
    const code = await Promise.race([
      failed,
      new Promise<number | null>((done, reject) => {
        processChild?.once("error", reject);
        processChild?.once("close", done);
      }),
    ]);
    if (handlerError) throw handlerError;
    assert.equal(code, 0, err);
    assert.match(out, /SCOPED_WORKFLOW_FINISHED/);
    assert.equal(parent, 8);
    assert.equal(child, 3);
    assert.equal(
      await readFile(join(cwd, "out/main.txt"), "utf8"),
      "MAIN_GRANTED",
    );
    assert.equal(
      await readFile(join(cwd, "out/child.txt"), "utf8"),
      "CHILD_GRANTED",
    );
    for (const name of [
      "other.txt",
      "out/asked.txt",
      "out/rewrite.txt",
      "blocked.txt",
    ])
      await assert.rejects(readFile(join(cwd, name)), { code: "ENOENT" });
  },
  { timeout: 15000 },
);
