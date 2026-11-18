import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHookRegistry, type HookBatchResult } from "../src/hooks.js";
import { createToolHookRuntime } from "../src/tool-hook-runtime.js";
import type { ToolUse } from "../src/types.js";

const call: ToolUse = {
  type: "tool_use",
  id: "owned-failure",
  name: "Read",
  input: { file_path: "/owned/missing.txt" },
};
const hookInputSchema = z.looseObject({
  hook_event_name: z.string(),
  error: z.string().optional(),
  is_interrupt: z.boolean().optional(),
  duration_ms: z.number().optional(),
  tool_input: z.unknown(),
  tool_use_id: z.string().optional(),
});
async function fixture(output: unknown, extras: Record<string, unknown> = {}) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-failure-hook-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "hook.mjs"),
    log = join(cwd, "input.json");
  await writeFile(
    file,
    `import {writeFileSync} from 'node:fs';let text='';for await(const part of process.stdin)text+=part;writeFileSync(process.argv[2],text);${typeof output === "string" ? output : `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`}`,
  );
  const registry = createHookRegistry([
    {
      source: "userSettings",
      hooks: {
        PostToolUseFailure: [
          {
            matcher: "^Read$",
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [file, log],
                ...extras,
              },
            ],
          },
        ],
      },
    },
  ]);
  onTestFinished(() => registry.close());
  const events: Array<{ event: string; batch: HookBatchResult }> = [];
  let observedError: unknown;
  const runtime = createToolHookRuntime({
    registry,
    context: () => ({
      session_id: "owned-session",
      transcript_path: join(cwd, "transcript.jsonl"),
      cwd,
      permission_mode: "default",
    }),
    runOptions: () => ({
      cwd,
      projectDir: cwd,
      env: {},
      defaultTimeoutMs: 3000,
    }),
    onBatch: (event, batch) => {
      events.push({ event, batch });
    },
    onToolFailure: (_call, error) => {
      observedError = error;
    },
  });
  const failure = (
    ...args: Parameters<NonNullable<typeof runtime.failure>>
  ) => {
    if (!runtime.failure) return assert.fail("runtime has no failure hook");
    return runtime.failure(...args);
  };
  return {
    registry,
    runtime,
    failure,
    events,
    log,
    observedError: () => observedError,
  };
}

test("failure runtime supplies effective call, error text, interrupt and execution duration", async () => {
  const f = await fixture({
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: "check another file",
    },
  });
  const error = new Error("owned file not found");
  const result = await f.failure(call, error, new AbortController().signal, {
    durationMs: 3.25,
    isInterrupt: true,
  });
  assert.deepEqual(result, {
    additionalContext: [],
    attachments: [
      {
        phase: "failure",
        event: "PostToolUseFailure",
        toolName: "Read",
        content: ["check another file"],
      },
    ],
  });
  const input = hookInputSchema.parse(
    JSON.parse(await readFile(f.log, "utf8")),
  );
  assert.equal(input.hook_event_name, "PostToolUseFailure");
  assert.equal(input.error, error.message);
  assert.equal(input.is_interrupt, true);
  assert.equal(input.duration_ms, 3.25);
  assert.deepEqual(input.tool_input, call.input);
  assert.equal(input.tool_use_id, call.id);
  assert.equal(f.observedError(), error);
  assert.equal(f.events[0]?.event, "PostToolUseFailure");
});

test("failure blocks add feedback but cannot stop continuation or rewrite the failed result", async () => {
  const f = await fixture({
    decision: "block",
    reason: "retry differently",
    continue: false,
    stopReason: "ignored by failure consumer",
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: "failure context",
      updatedToolOutput: "not an output rewrite",
    },
  });
  const result = await f.failure(
    call,
    "original failure text",
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    additionalContext: ["retry differently"],
    attachments: [
      {
        phase: "failure",
        event: "PostToolUseFailure",
        toolName: "Read",
        content: ["failure context"],
      },
    ],
  });
  assert.equal(
    f.events[0]?.batch.preventContinuation,
    true,
    "raw registry result remains inspectable",
  );
  assert.equal(f.events[0]?.batch.updatedToolOutput, undefined);
  const input = hookInputSchema.parse(
    JSON.parse(await readFile(f.log, "utf8")),
  );
  assert.equal(input.error, "original failure text");
  assert.equal(input.is_interrupt, false);
  assert.equal(
    Object.hasOwn(input, "duration_ms"),
    false,
    "hook time is not misreported as tool execution time",
  );
});

test("ordinary failure-hook errors are diagnostic while onFailure block supplies feedback", async () => {
  const ordinary = await fixture(
    "process.stderr.write('owned hook error');process.exitCode=7",
  );
  assert.deepEqual(
    await ordinary.failure(call, "original", new AbortController().signal),
    { additionalContext: [] },
  );
  assert.equal(ordinary.events[0]?.batch.results[0]?.status, "error");
  const blocking = await fixture(
    "process.stderr.write('owned hook error');process.exitCode=7",
    { onFailure: "block" },
  );
  assert.deepEqual(
    await blocking.failure(call, "original", new AbortController().signal),
    { additionalContext: ["Hook exited 7"] },
  );
  assert.equal(blocking.events[0]?.batch.results[0]?.status, "blocking");
});

test("cancelled failure hooks propagate abort rather than attaching partial feedback", async () => {
  const f = await fixture(
    'process.stdout.write(\'{"decision":"block","reason":"partial verdict"}\');setInterval(()=>{},1000)',
  );
  const controller = new AbortController();
  const pending = f.failure(call, "original", controller.signal);
  const timer = setTimeout(
    () => controller.abort(new Error("owned cancellation")),
    40,
  );
  try {
    await assert.rejects(pending, /owned cancellation/);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(f.events.length, 0);
  assert.equal(f.observedError(), undefined);
});
