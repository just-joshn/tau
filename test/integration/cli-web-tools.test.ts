import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { fixtureSse } from "../helpers/sse-fixture.js";

const tls = fileURLToPath(new URL("../fixtures/web-tls/", import.meta.url));
const PAGE = `<!doctype html><html><head><title>ignored</title><style>p{}</style></head>
<body><h1>Fixture Title</h1><p>The fixture says <b>hello</b> &amp; links <a href="https://example.com/x">onward</a>.</p>
<script>window.secret = 1</script></body></html>`;

const requestSchema = z.object({
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  messages: z.array(
    z.object({ role: z.string(), content: z.unknown() }).loose(),
  ),
});
const resultSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
});
const textSchema = z.object({ type: z.literal("text"), text: z.string() });

function blocks(message: { content: unknown }): unknown[] {
  return Array.isArray(message.content) ? message.content : [message.content];
}
function lastUserText(body: z.infer<typeof requestSchema>): string {
  const last = body.messages.at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return blocks(last)
    .flatMap((block) => {
      const parsed = textSchema.safeParse(block);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join("");
}
function toolResults(body: z.infer<typeof requestSchema>) {
  return body.messages.flatMap((message) =>
    blocks(message).flatMap((block) => {
      const parsed = resultSchema.safeParse(block);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}
function message(content: unknown[], stop: string): string {
  return fixtureSse([
    {
      type: "message_start",
      message: {
        id: "msg-web",
        role: "assistant",
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    ...content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stop },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);
}

type Step = { name: string; input: (pagePort: number) => unknown };
async function runWorkflow(steps: Step[], args: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-web-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  for (const directory of [config, join(root, "home"), join(root, "managed")])
    await mkdir(directory);
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({ skipWebFetchPreflight: true }),
  );
  const pageHits: string[] = [];
  const pages = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: {
      cert: Bun.file(join(tls, "cert.pem")),
      key: Bun.file(join(tls, "key.pem")),
    },
    fetch(request) {
      const url = new URL(request.url);
      pageHits.push(url.pathname);
      if (url.pathname === "/fixture/redirect")
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://localhost:${url.port}/fixture/page.html`,
          },
        });
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  onTestFinished(() => pages.stop(true));
  const bodies: z.infer<typeof requestSchema>[] = [];
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = requestSchema.parse(JSON.parse(raw));
    bodies.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (body.tools?.some((tool) => tool.type === "web_search_20250305"))
      return response.end(
        message(
          [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "tau web search" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Tau result",
                  url: "https://example.com/tau",
                  encrypted_content: "x",
                },
              ],
            },
            { type: "text", text: "Tau is a port." },
          ],
          "end_turn",
        ),
      );
    if (lastUserText(body).includes("Web page content:"))
      return response.end(
        message([{ type: "text", text: "FETCH_ANSWER fixture" }], "end_turn"),
      );
    const step = steps[toolResults(body).length];
    response.end(
      step
        ? message(
            [
              {
                type: "tool_use",
                id: `web-${toolResults(body).length + 1}`,
                name: step.name,
                input: step.input(Number(pages.port)),
              },
            ],
            "tool_use",
          )
        : message([{ type: "text", text: "done" }], "end_turn"),
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
  const result = await new Promise<{ code: number | null; err: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
          "--cwd",
          root,
          "-p",
          "use the web",
          "--output-format",
          "json",
          ...args,
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: config,
            TAU_HOME: join(root, "state"),
            TAU_MANAGED_ROOT: join(root, "managed"),
            NODE_EXTRA_CA_CERTS: join(tls, "cert.pem"),
            ANTHROPIC_MODEL: "claude-sonnet-4-6",
            ANTHROPIC_API_KEY: "web-dummy",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let err = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => done({ code, err }));
    },
  );
  assert.equal(result.code, 0, result.err);
  const final = bodies.at(-1);
  assert.ok(final);
  return { bodies, pageHits, results: toolResults(final) };
}

const fetchStep = (path: string): Step => ({
  name: "WebFetch",
  input: (port) => ({
    url: `http://127.0.0.1:${port}${path}`,
    prompt: "What does the fixture say?",
  }),
});

test(
  "compiled WebFetch upgrades to https, converts HTML and answers through the secondary model",
  async () => {
    const run = await runWorkflow(
      [fetchStep("/fixture/page.html")],
      ["--allowedTools", "WebFetch(domain:127.0.0.1)"],
    );
    assert.deepEqual(run.pageHits, ["/fixture/page.html"]);
    const secondary = run.bodies.find((body) =>
      lastUserText(body).includes("Web page content:"),
    );
    assert.ok(secondary);
    const prompt = lastUserText(secondary);
    assert.match(
      prompt,
      /Fixture Title\n=+\n\nThe fixture says \*\*hello\*\* & links \[onward\]\(https:\/\/example\.com\/x\)\./,
    );
    assert.match(prompt, /What does the fixture say\?/);
    assert.equal(prompt.includes("window.secret"), false);
    assert.deepEqual(secondary.tools, []);
    assert.deepEqual(run.results, [
      {
        type: "tool_result",
        tool_use_id: "web-1",
        content: "FETCH_ANSWER fixture",
      },
    ]);
  },
  { timeout: 20000 },
);

test(
  "compiled WebFetch returns a redirect notice instead of following a cross-host redirect",
  async () => {
    const run = await runWorkflow(
      [fetchStep("/fixture/redirect")],
      ["--permission-mode", "bypassPermissions"],
    );
    assert.deepEqual(run.pageHits, ["/fixture/redirect"]);
    const [result] = run.results;
    assert.ok(result);
    assert.equal(result.is_error, undefined);
    assert.match(result.content, /^REDIRECT DETECTED: /);
    assert.match(
      result.content,
      new RegExp(`- url: "https://localhost:\\d+/fixture/page\\.html"`),
    );
    assert.match(result.content, /Status: 302 Found/);
  },
  { timeout: 20000 },
);

test(
  "compiled WebFetch refuses a denied domain before fetching",
  async () => {
    const run = await runWorkflow(
      [fetchStep("/fixture/page.html")],
      [
        "--permission-mode",
        "bypassPermissions",
        "--disallowedTools",
        "WebFetch(domain:127.0.0.1)",
      ],
    );
    assert.deepEqual(run.pageHits, []);
    assert.deepEqual(run.results, [
      {
        type: "tool_result",
        tool_use_id: "web-1",
        content: "WebFetch denied access to domain:127.0.0.1.",
        is_error: true,
      },
    ]);
  },
  { timeout: 20000 },
);

test(
  "compiled WebSearch runs the server tool side query and surfaces its results",
  async () => {
    const run = await runWorkflow(
      [{ name: "WebSearch", input: () => ({ query: "tau web search" }) }],
      ["--tools", "Read,WebSearch", "--allowedTools", "WebSearch"],
    );
    assert.ok(run.bodies[0]?.tools?.some((tool) => tool.name === "WebSearch"));
    const side = run.bodies.find((body) =>
      body.tools?.some((tool) => tool.type === "web_search_20250305"),
    );
    assert.ok(side);
    assert.deepEqual(side.tools, [
      { type: "web_search_20250305", name: "web_search", max_uses: 8 },
    ]);
    assert.equal(
      lastUserText(side),
      "Perform a web search for the query: tau web search",
    );
    assert.deepEqual(run.results, [
      {
        type: "tool_result",
        tool_use_id: "web-1",
        content: `Web search results for query: "tau web search"\n\nLinks: [{"title":"Tau result","url":"https://example.com/tau"}]\n\nTau is a port.\n\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.`,
      },
    ]);
  },
  { timeout: 20000 },
);
