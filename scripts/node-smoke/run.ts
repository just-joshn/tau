// Cross-runtime smoke, executed by Node (type stripping) through
// scripts/node-smoke.mjs: bundle the CLI for Node, then drive the bundle with
// `node` against a loopback Messages API mock. Only erasable TypeScript here.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

type Block =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, string>;
    };
type Run = { code: number | null; out: string; err: string };

const toolResultSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.union([
    z.string(),
    z.array(z.looseObject({ text: z.string().optional() })),
  ]),
});
type ToolResult = z.infer<typeof toolResultSchema>;
const requestSchema = z.looseObject({
  messages: z.array(
    z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
  ),
});
type Request = z.infer<typeof requestSchema>;
const resultSchema = z.looseObject({
  result: z.string(),
  is_error: z.boolean(),
});

const root = fileURLToPath(new URL("../..", import.meta.url));
const { version } = z
  .looseObject({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
const temp = mkdtempSync(join(tmpdir(), "tau-node-smoke-"));

function sse(block: Block): string {
  const start =
    block.type === "text"
      ? { type: "text", text: "" }
      : { type: "tool_use", id: block.id, name: block.name, input: {} };
  const delta =
    block.type === "text"
      ? { type: "text_delta", text: block.text }
      : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  const events = [
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: start },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function run(
  cli: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Run> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (out += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => done({ code, out, err }));
  });
}

/** Serves one scripted reply per request and records every request body. */
async function startMock(reply: (body: Request) => Block) {
  const bodies: Request[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = requestSchema.parse(JSON.parse(raw));
    bodies.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(reply(body)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return { url: `http://127.0.0.1:${address.port}`, bodies, close };
}

function toolResult(body: Request): ToolResult | undefined {
  const content = body.messages.at(-1)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const parsed = toolResultSchema.safeParse(block);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

const servers: { close: () => Promise<void> }[] = [];
try {
  const cli = join(temp, "cli.mjs");
  const build = spawnSync(
    "bun",
    ["build", join(root, "src/cli.ts"), "--target=node", "--outfile", cli],
    {
      encoding: "utf8",
    },
  );
  assert.equal(build.status, 0, build.stderr);

  const cwd = join(temp, "workspace");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: join(temp, "home"),
    TAU_HOME: join(temp, "state"),
    CLAUDE_CONFIG_DIR: join(temp, "user"),
    TAU_MANAGED_ROOT: join(temp, "managed"),
  };
  for (const dir of ["home", "state", "user", "managed", "workspace"])
    mkdirSync(join(temp, dir));

  const versionRun = await run(cli, ["--version"], env);
  assert.equal(versionRun.code, 0, versionRun.err);
  assert.equal(versionRun.out.trim(), `tau ${version}`);

  const help = await run(cli, ["--help"], env);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /Usage: tau/);
  assert.equal(help.err, "");

  const unknown = await run(cli, ["--no-such-flag"], env);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /^tau: /m);
  assert.doesNotMatch(unknown.err, /\n\s+at /);

  const apiEnv = { ...env, ANTHROPIC_API_KEY: "TAU_SENTINEL_node_smoke_key" };
  const textMock = await startMock(() => ({
    type: "text",
    text: "node smoke reply",
  }));
  servers.push(textMock);
  const printed = await run(
    cli,
    ["-p", "say hi", "--cwd", cwd, "--output-format", "json"],
    {
      ...apiEnv,
      ANTHROPIC_BASE_URL: textMock.url,
    },
  );
  assert.equal(printed.code, 0, printed.err);
  const printedResult = resultSchema.parse(JSON.parse(printed.out));
  assert.equal(printedResult.is_error, false);
  assert.equal(printedResult.result, "node smoke reply");

  const fileContent = "node smoke file content 7c1e";
  writeFileSync(join(cwd, "smoke.txt"), fileContent);
  const toolMock = await startMock((body) =>
    toolResult(body)
      ? { type: "text", text: "read it" }
      : {
          type: "tool_use",
          id: "toolu_smoke",
          name: "Read",
          input: { file_path: "smoke.txt" },
        },
  );
  servers.push(toolMock);
  const tooled = await run(
    cli,
    ["-p", "read smoke.txt", "--cwd", cwd, "--output-format", "json"],
    {
      ...apiEnv,
      ANTHROPIC_BASE_URL: toolMock.url,
    },
  );
  assert.equal(tooled.code, 0, tooled.err);
  assert.equal(resultSchema.parse(JSON.parse(tooled.out)).result, "read it");
  const followUp = toolMock.bodies
    .map(toolResult)
    .find((result) => result !== undefined);
  assert.ok(followUp, "follow-up request carried no tool_result");
  assert.equal(followUp.tool_use_id, "toolu_smoke");
  assert.notEqual(followUp.is_error, true);
  const content =
    typeof followUp.content === "string"
      ? followUp.content
      : followUp.content.map((block) => block.text ?? "").join("");
  assert.ok(
    content.includes(fileContent),
    `tool_result lacks the file content: ${content}`,
  );

  console.log(
    `PASS Node ${process.version} bundle smoke: version, help, usage error, print JSON, Read tool loop`,
  );
} finally {
  await Promise.all(servers.map((server) => server.close()));
  rmSync(temp, { recursive: true, force: true });
}
