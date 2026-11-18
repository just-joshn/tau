// The real-CLI process contract: exit codes, stream discipline, arguments,
// environment isolation and output volume. Cancellation and concurrency live
// in cli-process-signals.test.ts.
//
// Pinned exit codes: success 0; usage error, runtime failure, request time
// limit and SIGINT all 1.
import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider } from "../helpers/mock-provider.js";
import { sentinel } from "../helpers/sentinels.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

const requestSchema = z.object({
  model: z.string(),
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string() })),
      }),
    )
    .min(1),
});
const resultSchema = z.object({
  type: z.literal("result"),
  session_id: z.uuid(),
  result: z.string(),
  is_error: z.boolean(),
  error: z.string().optional(),
});

/** The prompt text as the provider received it: the first user text block. */
function promptSent(body: unknown): string {
  const first = requestSchema.parse(body).messages[0]?.content[0];
  assert.ok(first !== undefined);
  return first.text;
}

const answer = (text: string) => ({
  kind: "turn" as const,
  content: [{ type: "text" as const, text }],
  stopReason: "end_turn" as const,
});

/**
 * Serves one streamed answer as `text_delta` events of `deltaBytes` each, so
 * answers beyond tau's 1 MiB single-event limit stay valid. Any further
 * request gets HTTP 500 and is counted.
 */
async function startDeltaProvider(text: string, deltaBytes: number) {
  const deltas: unknown[] = [];
  for (let at = 0; at < text.length; at += deltaBytes)
    deltas.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(at, at + deltaBytes) },
    });
  const body = fixtureSse([
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    ...deltas,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      if (requests > 1) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
    });
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", () => done()),
  );
  onTestFinished(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
  };
}

const STACK_FRAME = /^\s+at /m;
/** ESC, the one-byte C1 CSI and BEL: what a terminal would act on. */
const hasEscapes = (text: string) =>
  ["\u001b", "\u009b", "\u0007"].some((byte) => text.includes(byte));

function assertUsageError(
  run: { exitCode: number | null; stdout: string; stderr: string },
  message: string,
): void {
  assert.equal(run.exitCode, 1, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, `tau: ${message}\n`);
}

// Exit codes and usage errors

test("--version and -v print the version alone and exit 0", async () => {
  for (const flag of ["--version", "-v"]) {
    const run = await runCli({ args: [flag] });
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stdout, "tau 0.1.0\n");
    assert.equal(run.stderr, "");
  }
});

test("-h prints the same usage as --help", async () => {
  const [long, short] = await Promise.all([
    runCli({ args: ["--help"] }),
    runCli({ args: ["-h"] }),
  ]);
  assert.equal(short.exitCode, 0, short.stderr);
  assert.equal(short.stdout, long.stdout);
  assert.equal(short.stderr, "");
});

test("an unknown option exits 1 with one tau: line, nothing on stdout and no request", async () => {
  const provider = await startMockProvider([]);
  const run = await runCli({ args: ["-p", "hi", "--bogus"], provider });
  assertUsageError(
    run,
    `Unknown option '--bogus'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--bogus"`,
  );
  assert.equal(provider.requests.length, 0);
});

test("an option missing its value exits 1 with one tau: line", async () => {
  assertUsageError(
    await runCli({ args: ["-p", "hi", "--model"] }),
    "Option '--model <value>' argument missing",
  );
});

test("a repeated --tools exits 1 while a repeated --model keeps the last value", async () => {
  assertUsageError(
    await runCli({ args: ["-p", "hi", "--tools", "Read", "--tools", "Bash"] }),
    "--tools may only be specified once",
  );
  const provider = await startMockProvider([answer("ok")]);
  const run = await runCli({
    args: ["-p", "hi", "--model", "first-model", "--model", "second-model"],
    provider,
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(
    requestSchema.parse(provider.requests[0]?.body).model,
    "second-model",
  );
});

test("an invalid option value exits 1 with a tau: diagnostic, no stack trace and empty stdout", async () => {
  for (const args of [
    ["--permission-mode", "sometimes"],
    ["--output-format", "xml"],
    ["--max-retries", "99"],
  ]) {
    const run = await runCli({ args: ["-p", "hi", ...args] });
    assert.equal(run.exitCode, 1, run.stderr);
    assert.equal(run.stdout, "");
    assert.ok(run.stderr.startsWith("tau: "), run.stderr);
    assert.doesNotMatch(run.stderr, STACK_FRAME);
  }
});

// tau prints the raw zod issue array for a bad option value, so the diagnostic
// spans a dozen lines of JSON instead of one stable `tau:` line.
test.failing(
  "KNOWN-GAP an invalid option value prints a single tau: line",
  async () => {
    const run = await runCli({
      args: ["-p", "hi", "--permission-mode", "sometimes"],
    });
    assert.match(run.stderr, /^tau: [^\n]+\n$/);
  },
);

test("a missing --cwd directory exits 1 without contacting the provider", async () => {
  const provider = await startMockProvider([]);
  const run = await runCli({
    args: ["-p", "hi", "--cwd", "missing-directory"],
    provider,
  });
  assert.equal(run.exitCode, 1, run.stderr);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^tau: ENOENT[^\n]*missing-directory'\n$/);
  assert.equal(provider.requests.length, 0);
});

test("a runtime provider failure with retries disabled exits 1 after one request", async () => {
  const failure = {
    kind: "error" as const,
    status: 500,
    body: { type: "error", error: { type: "api_error", message: "boom" } },
  };
  const textProvider = await startMockProvider([failure]);
  const text = await runCli({
    args: ["-p", "hi", "--max-retries", "0"],
    provider: textProvider,
  });
  assert.equal(text.exitCode, 1);
  assert.equal(text.stderr, "tau: Messages API HTTP error 500\n");
  // Text mode still ends stdout with the (empty) answer's newline.
  assert.equal(text.stdout, "\n");
  assert.equal(textProvider.requests.length, 1);
  assert.equal(textProvider.unexpected, 0);

  const jsonProvider = await startMockProvider([failure]);
  const json = await runCli({
    args: ["-p", "hi", "--max-retries", "0", "--output-format", "json"],
    provider: jsonProvider,
  });
  assert.equal(json.exitCode, 1);
  assert.equal(json.stderr, "");
  const result = resultSchema.parse(JSON.parse(json.stdout));
  assert.equal(result.is_error, true);
  assert.equal(result.error, "Messages API HTTP error 500");
  assert.equal(jsonProvider.requests.length, 1);
});

test("the API_TIMEOUT_MS request limit ends a hung request with exit 1", async () => {
  const provider = await startMockProvider([{ kind: "hang" }]);
  const run = await runCli({
    args: ["-p", "hi", "--max-retries", "0", "--no-nonstream-fallback"],
    provider,
    env: { API_TIMEOUT_MS: "800" },
    deadlineMs: 10_000,
  });
  assert.equal(run.timedOut, false);
  assert.equal(run.exitCode, 1);
  assert.equal(run.stderr, "tau: Messages API request timeout after 800 ms\n");
  assert.ok(run.elapsedMs < 5_000, `took ${run.elapsedMs}ms`);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.unexpected, 0);
});

// Prompt sources and bytes

test("arguments after -- are prompt text, not options", async () => {
  const provider = await startMockProvider([answer("ok")]);
  const run = await runCli({
    args: ["-p", "--", "--version", "--bogus"],
    provider,
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout, "ok\n");
  assert.equal(promptSent(provider.requests[0]?.body), "--version --bogus");
});

test("a piped stdin prompt is trimmed and appended after the argument prompt", async () => {
  const provider = await startMockProvider([answer("one"), answer("two")]);
  const piped = await runCli({ args: ["-p"], provider, stdin: "from stdin\n" });
  assert.equal(piped.exitCode, 0, piped.stderr);
  assert.equal(promptSent(provider.requests[0]?.body), "from stdin");
  const both = await runCli({
    args: ["-p", "from", "args"],
    provider,
    stdin: "from stdin\n",
  });
  assert.equal(both.exitCode, 0, both.stderr);
  assert.equal(
    promptSent(provider.requests[1]?.body),
    "from args\n\nfrom stdin",
  );
});

test("empty stdin without a prompt exits 1 and sends nothing", async () => {
  const provider = await startMockProvider([]);
  for (const stdin of ["", "  \n\t\n"]) {
    assertUsageError(
      await runCli({ args: ["-p"], provider, stdin }),
      "Provide a prompt with -p or on stdin",
    );
  }
  assert.equal(provider.requests.length, 0);
});

test("piped stdin over 1 MiB exits 1 and sends nothing", async () => {
  const provider = await startMockProvider([]);
  assertUsageError(
    await runCli({
      args: ["-p"],
      provider,
      stdin: "y".repeat(1024 * 1024 + 1),
    }),
    "Piped input exceeds 1 MiB",
  );
  assert.equal(provider.requests.length, 0);
});

test("Unicode, quoted, newline and 100 KB prompt arguments reach the provider byte-exactly", async () => {
  const tricky =
    `naïve "double" 'single' $HOME \`id\` ; | & \\ back\\slash\nline two\ttab ` +
    "日本語 😀 e\u0301 \u200d end";
  // Under Linux's 128 KiB single-argument limit, over 100 KB of UTF-8.
  const large = "長い😀 prompt\n".repeat(5_700).trimEnd();
  assert.ok(Buffer.byteLength(large) >= 100_000);
  assert.ok(Buffer.byteLength(large) < 128 * 1024);
  const provider = await startMockProvider([answer("one"), answer("two")]);
  for (const [index, prompt] of [tricky, large].entries()) {
    const run = await runCli({ args: ["-p", prompt], provider });
    assert.equal(run.exitCode, 0, run.stderr);
    const sent = promptSent(provider.requests[index]?.body);
    assert.ok(
      Buffer.from(sent).equals(Buffer.from(prompt)),
      "prompt bytes changed",
    );
  }
});

// Stream discipline

test("JSON mode prints exactly one JSON document and keeps tool progress off stdout", async () => {
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: [
        {
          type: "tool_use",
          id: "read_1",
          name: "Read",
          input: { file_path: "notes.txt" },
        },
      ],
      stopReason: "tool_use",
    },
    answer("The notes say hello."),
  ]);
  const run = await runCli({
    args: ["-p", "read notes", "--output-format", "json"],
    provider,
    files: { "notes.txt": "hello\n" },
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.ok(run.stdout.endsWith("\n"));
  assert.equal(run.stdout.trimEnd().split("\n").length, 1);
  const result = resultSchema.parse(JSON.parse(run.stdout));
  assert.equal(result.result, "The notes say hello.");
  assert.equal(result.is_error, false);
  assert.equal(run.stderr, "");
  assert.equal(provider.requests.length, 2);
});

test("text mode writes only the answer to stdout and tool progress to stderr", async () => {
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: [
        {
          type: "tool_use",
          id: "read_1",
          name: "Read",
          input: { file_path: "notes.txt" },
        },
      ],
      stopReason: "tool_use",
    },
    answer("Done reading."),
  ]);
  const run = await runCli({
    args: ["-p", "read notes"],
    provider,
    files: { "notes.txt": "hello\n" },
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout, "Done reading.\n");
  assert.match(run.stderr, /\[Read\] \{"file_path":"notes.txt"\}/);
});

test("non-TTY stdout and stderr carry no escape or bell bytes from model text or tool output", async () => {
  const hostile = "\u001b]0;pwned\u0007\u001b[31mred\u001b[0m alert\u0007";
  const script = () => [
    {
      kind: "turn" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "read_1",
          name: "Read",
          input: { file_path: "evil.txt" },
        },
      ],
      stopReason: "tool_use" as const,
    },
    answer(hostile),
  ];
  for (const format of ["text", "json", "stream-json"]) {
    const provider = await startMockProvider(script());
    const run = await runCli({
      args: ["-p", "show", "--output-format", format],
      provider,
      files: { "evil.txt": `${hostile}\n` },
    });
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(!hasEscapes(run.stdout), `${format} stdout`);
    assert.ok(!hasEscapes(run.stderr), `${format} stderr`);
    if (format === "text") {
      assert.equal(run.stdout, "red alert\n");
      assert.ok(run.stderr.includes("red alert"), "tool output was not shown");
    }
    if (format === "json")
      assert.equal(resultSchema.parse(JSON.parse(run.stdout)).result, hostile);
  }
});

/** Splits newline-delimited JSON fed in arbitrary byte fragments. */
function jsonLineParser() {
  const decoder = new StringDecoder("utf8");
  const records: unknown[] = [];
  let pending = "";
  return {
    records,
    push(chunk: Buffer) {
      // Only the new text can hold a newline, so scanning stays linear.
      const text = decoder.write(chunk);
      let start = 0;
      for (
        let newline = text.indexOf("\n");
        newline !== -1;
        newline = text.indexOf("\n", start)
      ) {
        const record: unknown = JSON.parse(
          pending + text.slice(start, newline),
        );
        records.push(record);
        pending = "";
        start = newline + 1;
      }
      pending += text.slice(start);
    },
    /** Bytes after the last newline; a complete stream leaves none. */
    rest: () => pending + decoder.end(),
  };
}

test("stream-json is newline-terminated JSONL that parses under any read fragmentation", async () => {
  const text = "streamed ✓ “quoted” 😀\n".repeat(12_000);
  const provider = await startDeltaProvider(text, 4_096);
  const live = jsonLineParser();
  let liveChunks = 0;
  const run = await runCli({
    args: ["-p", "stream", "--output-format", "stream-json"],
    provider,
    onSpawn: (child: ChildProcess) => {
      child.stdout?.on("data", (chunk: string) => {
        liveChunks++;
        live.push(Buffer.from(chunk));
      });
    },
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.ok(liveChunks > 1, "the output arrived in one read");
  assert.equal(live.rest(), "");
  const bytes = Buffer.from(run.stdout);
  for (const size of [1, 3, 4_093]) {
    const fragmented = jsonLineParser();
    for (let at = 0; at < bytes.length; at += size)
      fragmented.push(bytes.subarray(at, at + size));
    assert.equal(fragmented.rest(), "");
    assert.deepEqual(fragmented.records, live.records);
  }
  const streamed = z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(live.records);
  assert.equal(
    streamed
      .flatMap((event) => (event.type === "text" ? [event.text] : []))
      .join(""),
    text,
  );
  assert.equal(resultSchema.parse(live.records.at(-1)).result, text);
});

// Output volume

/** Reads a stream in short bursts so the child keeps hitting a full pipe. */
function readSlowly(stream: NodeJS.ReadableStream | null): void {
  if (stream === null) return;
  stream.pause();
  const timer = setInterval(() => {
    stream.resume();
    setTimeout(() => stream.pause(), 2);
  }, 25);
  stream.once("end", () => {
    clearInterval(timer);
  });
}

test("a 2 MB answer read slowly through the pipe arrives complete without a hang", async () => {
  const text = "line of the 2 MB answer — ünïcödé 😀\n".repeat(52_000);
  assert.ok(Buffer.byteLength(text) >= 2 * 1024 * 1024);
  const provider = await startDeltaProvider(text, 32 * 1024);
  const run = await runCli({
    args: ["-p", "big"],
    provider,
    deadlineMs: 30_000,
    onSpawn: (child: ChildProcess) => readSlowly(child.stdout),
  });
  assert.equal(run.timedOut, false);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout.length, text.length + 1);
  assert.ok(run.stdout === `${text}\n`, "the answer was altered or truncated");
}, 40_000);

test("stderr far beyond the pipe buffer, read slowly, completes without loss", async () => {
  const count = 300;
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index++)
    files[`f${index}.txt`] = `${"x".repeat(1_500)}\n`;
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: Array.from({ length: count }, (_, index) => ({
        type: "tool_use" as const,
        id: `read_${index}`,
        name: "Read",
        input: { file_path: `f${index}.txt` },
      })),
      stopReason: "tool_use",
    },
    answer("done"),
  ]);
  const run = await runCli({
    args: ["-p", "read all"],
    provider,
    files,
    deadlineMs: 30_000,
    onSpawn: (child: ChildProcess) => readSlowly(child.stderr),
  });
  assert.equal(run.timedOut, false);
  assert.equal(run.exitCode, 0, run.stderr.slice(-500));
  assert.equal(run.stdout, "done\n");
  assert.ok(run.stderr.length > 256 * 1024, `${run.stderr.length} bytes`);
  for (let index = 0; index < count; index++)
    assert.ok(
      run.stderr.includes(`[Read] {"file_path":"f${index}.txt"}\n`),
      `f${index}`,
    );
}, 40_000);

test("a reader that closes stdout early, like | head, ends the run with exit 0", async () => {
  const text = "early close line\n".repeat(150_000);
  const provider = await startDeltaProvider(text, 32 * 1024);
  let received = 0;
  const run = await runCli({
    args: ["-p", "big"],
    provider,
    deadlineMs: 15_000,
    onSpawn: (child: ChildProcess) => {
      child.stdout?.once("data", (chunk: string) => {
        received = chunk.length;
        child.stdout?.destroy();
      });
    },
  });
  assert.equal(run.timedOut, false);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.ok(received > 0 && received < text.length);
});

// Environment isolation

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("INV-04 with only HOME and PATH the run writes under its own HOME and leaks no key", async () => {
  const provider = await startMockProvider([answer("isolated")]);
  const apiKey = sentinel("API_KEY");
  const run = await runCli({
    args: ["-p", "hi", "--output-format", "json"],
    provider,
    env: {
      ANTHROPIC_API_KEY: apiKey,
      TAU_HOME: undefined,
      CLAUDE_CONFIG_DIR: undefined,
      TAU_MANAGED_ROOT: undefined,
      TMPDIR: undefined,
      USERPROFILE: undefined,
      CI: undefined,
    },
  });
  assert.equal(run.exitCode, 0, run.stderr);
  const { session_id: id } = resultSchema.parse(JSON.parse(run.stdout));
  assert.equal(provider.requests[0]?.headers["x-api-key"], apiKey);

  const written = filesUnder(run.root).map((path) => relative(run.root, path));
  const sessions = written.filter((path) => path.startsWith("home/.tau/"));
  assert.deepEqual(
    sessions.map((path) =>
      path.replace(/sessions\/[0-9a-f]{24}\//, "sessions/<project>/"),
    ),
    [`home/.tau/sessions/<project>/${id}.json`],
  );
  // Besides the session, only Bun's own transpiler cache lands in HOME.
  assert.deepEqual(
    written.filter(
      (path) =>
        !path.startsWith("home/.tau/") &&
        !path.startsWith("home/Library/Caches/bun/") &&
        !path.startsWith("home/.cache/bun/") &&
        !path.startsWith("home/.bun/install/cache/@t@/"),
    ),
    [],
  );
  for (const path of filesUnder(run.root))
    assert.ok(!readFileSync(path).includes(apiKey), `key in ${path}`);

  const realSessions = join(homedir(), ".tau", "sessions");
  let realProjects: string[] = [];
  try {
    realProjects = readdirSync(realSessions);
  } catch {
    // No real session store at all.
  }
  for (const project of realProjects)
    assert.ok(
      !readdirSync(join(realSessions, project)).includes(`${id}.json`),
      "session written to the real HOME",
    );
});
