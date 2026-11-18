import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, onTestFinished, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import {
  DIFFERENTIAL_MODEL,
  startDifferentialMock,
  type DifferentialScenario,
} from "../helpers/differential-mock.js";
import { startMockProvider, turn } from "../helpers/mock-provider.js";
import {
  originalProjection,
  projectSdk,
  sdkMessages,
} from "../helpers/sdk-io-projection.js";

setDefaultTimeout(30_000);

// Each case reruns one oracle capture of the pinned original
// (artifacts/workflow-oracles-2026-11-18, scripts/differential/run_original.py)
// against the same SSE, and compares the selected fields of every message.
const ORIGINAL_ARGS = [
  "--model",
  DIFFERENTIAL_MODEL,
  "--dangerously-skip-permissions",
];
const cases: {
  oracle: string;
  scenario: DifferentialScenario;
  args: string[];
  stdin?: string;
}[] = [
  {
    oracle: "text-streamjson",
    scenario: "text",
    args: [
      "--print",
      "TAU_DIFFERENTIAL_TEXT",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
  },
  {
    oracle: "files-streamjson",
    scenario: "files",
    args: [
      "--print",
      "TAU_DIFFERENTIAL_FILES",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
  },
  {
    oracle: "failures-streamjson",
    scenario: "failures",
    args: [
      "--print",
      "TAU_DIFFERENTIAL_FAILURES",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
  },
  {
    oracle: "files-json",
    scenario: "files",
    args: [
      "--print",
      "TAU_DIFFERENTIAL_FILES",
      "--output-format",
      "json",
      "--tools",
      "Read,Edit,Write",
    ],
  },
  {
    oracle: "text-partial",
    scenario: "text",
    args: [
      "--print",
      "TAU_DIFFERENTIAL_TEXT",
      "--output-format",
      "stream-json",
      "--tools",
      "Read,Edit,Write",
      "--verbose",
      "--include-partial-messages",
    ],
  },
  {
    oracle: "text-stdin2",
    scenario: "text",
    args: [
      "--print",
      "--output-format",
      "stream-json",
      "--tools",
      "Read,Edit,Write",
      "--verbose",
      "--input-format",
      "stream-json",
    ],
    stdin:
      '{"type":"user","message":{"role":"user","content":"first turn"}}\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second turn"}]}}\n',
  },
];

describe("compiled CLI SDK messages match the original's oracle captures", () => {
  for (const entry of cases)
    test(entry.oracle, async () => {
      const mock = await startDifferentialMock(entry.scenario);
      const run = await runCli({
        provider: mock,
        files: { "a.txt": "alpha\n" },
        args: [...entry.args, ...ORIGINAL_ARGS],
        ...(entry.stdin === undefined ? {} : { stdin: entry.stdin }),
      });
      assert.equal(run.exitCode, 0, run.stderr);
      assert.deepEqual(
        projectSdk(run.stdout),
        originalProjection(entry.oracle),
      );
    });
});

test("the second stream-json input turn continues the first turn's conversation", async () => {
  const mock = await startDifferentialMock("text");
  const run = await runCli({
    provider: mock,
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      ...ORIGINAL_ARGS,
    ],
    stdin:
      '{"type":"keep_alive"}\n\n{"type":"user","message":{"role":"user","content":"first turn"}}\n{"type":"control_request","request":{"subtype":"interrupt"}}\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second turn"}]}}',
  });
  assert.equal(run.exitCode, 0, run.stderr);
  const second = z
    .object({
      messages: z.array(
        z.object({
          role: z.string(),
          content: z.array(z.looseObject({ text: z.string().optional() })),
        }),
      ),
    })
    .parse(mock.requests[1]);
  assert.deepEqual(
    second.messages.map((message) => [
      message.role,
      message.content.flatMap((block) =>
        ["first turn", "mock done", "second turn"].includes(block.text ?? "")
          ? [block.text]
          : [],
      ),
    ]),
    [
      ["user", ["first turn"]],
      ["assistant", ["mock done"]],
      ["user", ["second turn"]],
    ],
  );
});

describe("stream-json input errors end the run like the original", () => {
  for (const [line, message] of [
    [
      '{"type":"user","message":{"role":"assistant","content":"x"}}',
      "Error: Expected message role 'user', got 'assistant'",
    ],
    [
      '{"type":"user", oops}',
      "Error parsing streaming input line (type=user, 21 chars): SyntaxError",
    ],
  ] as const)
    test(message, async () => {
      const provider = await startMockProvider([]);
      const run = await runCli({
        provider,
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--input-format",
          "stream-json",
        ],
        stdin: `${line}\n`,
      });
      assert.equal(run.exitCode, 1);
      assert.match(
        run.stderr,
        new RegExp(`${message.replace(/[()]/g, "\\$&")}\n$`),
      );
      assert.equal(provider.requests.length, 0);
    });
});

describe("print protocol flag errors use the original's messages and exit 1", () => {
  const session = randomUUID();
  for (const [args, message] of [
    [
      ["--output-format", "stream-json"],
      "Error: When using --print, --output-format=stream-json requires --verbose",
    ],
    [["--input-format", "xml"], 'Error: Unknown input format "xml".'],
    [
      ["--input-format", "stream-json"],
      "Error: --input-format=stream-json requires output-format=stream-json.",
    ],
    [
      ["--include-partial-messages"],
      "Error: --include-partial-messages requires --print and --output-format=stream-json.",
    ],
    [
      ["--session-id", "not-a-uuid"],
      "Error: Invalid session ID. Must be a valid UUID.",
    ],
    [
      ["--session-id", session, "--continue"],
      "Error: --session-id with --continue or --resume also needs --fork-session.",
    ],
  ] as const)
    test(message, async () => {
      const run = await runCli({ args: ["-p", "hi", ...args] });
      assert.equal(run.exitCode, 1);
      assert.equal(run.stderr, `${message}\n`);
      assert.equal(run.stdout, "");
    });
});

test("--session-id names the new session, and a used id is refused", async () => {
  const shared = await mkdtemp(join(tmpdir(), "tau-session-id-"));
  onTestFinished(() => rm(shared, { recursive: true, force: true }));
  await mkdir(join(shared, "workspace"));
  const id = randomUUID();
  const provider = await startMockProvider([
    turn({ type: "text", text: "ok" }),
  ]);
  const launch = () =>
    runCli({
      provider,
      env: { TAU_HOME: join(shared, "state") },
      args: [
        "-p",
        "hi",
        "--cwd",
        join(shared, "workspace"),
        "--output-format",
        "json",
        "--session-id",
        id,
      ],
    });
  const first = await launch();
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(
    z.object({ session_id: z.string() }).parse(JSON.parse(first.stdout))
      .session_id,
    id,
  );
  const second = await launch();
  assert.equal(second.exitCode, 1);
  assert.equal(second.stderr, `Error: Session ID ${id} is already in use.\n`);
  assert.equal(provider.requests.length, 1);
});

test("json --verbose prints every message as one array ending in the result", async () => {
  const mock = await startDifferentialMock("files");
  const run = await runCli({
    provider: mock,
    files: { "a.txt": "alpha\n" },
    args: [
      "--print",
      "go",
      "--output-format",
      "json",
      "--verbose",
      ...ORIGINAL_ARGS,
    ],
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout.trimEnd().split("\n").length, 1);
  assert.deepEqual(
    sdkMessages(run.stdout).map((message) => message.type),
    [
      "system",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "result",
    ],
  );
});

test("a max-turns stop is an error_max_turns result counting the refused turn", async () => {
  const mock = await startDifferentialMock("files");
  const run = await runCli({
    provider: mock,
    files: { "a.txt": "alpha\n" },
    args: [
      "--print",
      "go",
      "--output-format",
      "json",
      "--max-turns",
      "2",
      ...ORIGINAL_ARGS,
    ],
  });
  assert.equal(run.exitCode, 1);
  const result = z
    .looseObject({
      subtype: z.string(),
      is_error: z.boolean(),
      num_turns: z.number(),
      errors: z.array(z.string()),
      terminal_reason: z.string(),
      stop_reason: z.string(),
    })
    .parse(JSON.parse(run.stdout));
  assert.deepEqual(result, {
    ...result,
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 3,
    errors: ["Reached maximum number of turns (2)"],
    terminal_reason: "max_turns",
    stop_reason: "tool_use",
  });
  assert.equal("result" in result, false);
});

test("a print-mode permission denial is listed in permission_denials", async () => {
  const provider = await startMockProvider([
    turn({
      type: "tool_use",
      id: "toolu_bash",
      name: "Bash",
      input: { command: "echo hi" },
    }),
    turn({ type: "text", text: "denied" }),
  ]);
  const run = await runCli({
    provider,
    args: ["-p", "hi", "--output-format", "json"],
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(
    z
      .object({ permission_denials: z.array(z.unknown()) })
      .parse(JSON.parse(run.stdout)).permission_denials,
    [
      {
        tool_name: "Bash",
        tool_use_id: "toolu_bash",
        tool_input: { command: "echo hi" },
      },
    ],
  );
});
