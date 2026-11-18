import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createHookRegistry,
  type HookBatchResult,
  type HookEvent,
  type HookRunOptions,
  type HookResult,
} from "../../src/hooks.js";
import { createToolHookRuntime } from "../../src/tool-hook-runtime.js";
import { createTools } from "../../src/tools.js";
import { projectMessages } from "../../src/thinking-history.js";
import {
  projectHookAttachmentHistory,
  type HookProjectionRow,
} from "../../src/hook-attachment-projection.js";
import type {
  NativeAttachmentCaptureHost,
  NativeAttachmentCaptureResult,
  NativeAttachmentDelivery,
} from "../../src/native-attachment-capture.js";
import type { ToolUse } from "../../src/types.js";

const signal = () => new AbortController().signal;
const call: ToolUse = {
  type: "tool_use",
  id: "owned-read",
  name: "Read",
  input: { file_path: "/owned/a" },
};
async function fixture() {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-hook-capture-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "owned-hook.mjs"),
    log = join(cwd, "settled.jsonl");
  await writeFile(
    script,
    `import {appendFileSync} from 'node:fs';let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw);await new Promise(r=>setTimeout(r,Number(process.argv[4])));appendFileSync(process.argv[2],JSON.stringify({label:process.argv[3],input})+'\\n');process.stdout.write(process.argv[5]);process.exitCode=Number(process.argv[6]);`,
  );
  const entry = (
    label: string,
    event: HookEvent,
    delay = 0,
    extras: Record<string, unknown> = {},
    extraOutput: Record<string, unknown> = {},
    exitCode = 0,
  ) => ({
    type: "command",
    command: process.execPath,
    args: [
      script,
      log,
      label,
      String(delay),
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: label,
          ...extraOutput,
        },
      }),
      String(exitCode),
    ],
    ...extras,
  });
  const runOptions = (): Omit<
    HookRunOptions,
    "signal" | "validateUpdatedInput"
  > => ({ cwd, projectDir: cwd, env: {}, defaultTimeoutMs: 3000 });
  const context = () => ({
    session_id: "owned-session",
    transcript_path: join(cwd, "owned.jsonl"),
    cwd,
  });
  const records: NativeAttachmentCaptureResult[] = [],
    deliveries: NativeAttachmentDelivery[] = [];
  let stamps = 0;
  const host: NativeAttachmentCaptureHost = {
    stamp: () => ({
      uuid: `44444444-4444-4444-4444-${String(++stamps).padStart(12, "0")}`,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    capture: (row, delivery) => {
      records.push(row);
      deliveries.push(delivery);
    },
  };
  const registry = (event: HookEvent, entries: unknown[]) => {
    const owned = createHookRegistry([
      { source: "owned-settings", hooks: { [event]: [{ hooks: entries }] } },
    ]);
    onTestFinished(() => owned.close());
    return owned;
  };
  return {
    cwd,
    log,
    entry,
    runOptions,
    context,
    host,
    records,
    deliveries,
    registry,
    stamps: () => stamps,
  };
}
const labels = (rows: readonly NativeAttachmentCaptureResult[]) =>
  rows.map((row) =>
    row.status === "captured" &&
    row.attachment.type === "hook_additional_context"
      ? row.attachment.content[0]
      : row.status,
  );

test("settlement capture creates separate ordered Pre/Post/Failure rows while legacy phase aggregation keeps configuration order", async () => {
  for (const event of [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
  ] as const) {
    const f = await fixture(),
      batches: HookBatchResult[] = [];
    const registry = f.registry(event, [
      f.entry("SLOW", event, 100),
      f.entry("FAST", event),
    ]);
    f.host.capture = async (row, delivery) => {
      f.records.push(row);
      f.deliveries.push(delivery);
      // A slow sink must not delay the next real result's stamp or manufacture phase grouping.
      if (
        row.status === "captured" &&
        row.attachment.type === "hook_additional_context" &&
        row.attachment.content[0] === "FAST"
      )
        await sleep(170);
    };
    const runtime = createToolHookRuntime({
      registry,
      context: f.context,
      runOptions: f.runOptions,
      nativeCapture: f.host,
      onBatch: (_event, batch) => {
        batches.push(batch);
      },
    });
    if (event === "PreToolUse")
      await runtime.before(call, signal(), async (input) => input);
    else if (event === "PostToolUse")
      await runtime.after(
        call,
        { type: "tool_result", tool_use_id: call.id, content: "RAW READ" },
        signal(),
      );
    else await runtime.failure?.(call, new Error("owned failure"), signal());
    assert.deepEqual(labels(f.records), ["FAST", "SLOW"]);
    assert.equal(f.stamps(), 2);
    assert.deepEqual(batches[0]?.additionalContext, ["SLOW", "FAST"]);
    assert.ok(
      f.records.every(
        (row) =>
          row.status === "captured" && row.event.renderedRole === "system",
      ),
    );
    assert.ok(
      f.deliveries.every(
        (delivery) => delivery.kind === "tool-hook" && delivery.call === call,
      ),
    );
  }
});

test("real Read rewrite capture retains original model input, effective post input and unmodified result ownership", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "original.txt"), "ORIGINAL FILE\n");
  await writeFile(join(f.cwd, "rewritten.txt"), "REWRITTEN FILE\n");
  const registry = createHookRegistry([
    {
      source: "owned-settings",
      hooks: {
        PreToolUse: [
          {
            hooks: [
              f.entry(
                "PRE RAW",
                "PreToolUse",
                0,
                {},
                {
                  permissionDecision: "allow",
                  updatedInput: { file_path: join(f.cwd, "rewritten.txt") },
                },
              ),
            ],
          },
        ],
        PostToolUse: [{ hooks: [f.entry("POST RAW", "PostToolUse")] }],
      },
    },
  ]);
  onTestFinished(() => registry.close());
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: f.runOptions,
    nativeCapture: f.host,
  });
  const tools = createTools({
    cwd: f.cwd,
    mode: "default",
    hooks: runtime,
    approve: async () => false,
  });
  const modelCall: ToolUse = {
    type: "tool_use",
    id: "actual-read",
    name: "Read",
    input: { file_path: "original.txt" },
  };
  const result = await tools.execute(modelCall, signal());
  assert.match(result.content, /REWRITTEN FILE/);
  assert.deepEqual(modelCall.input, { file_path: "original.txt" });
  assert.deepEqual(labels(f.records), ["PRE RAW", "POST RAW"]);
  const pre = f.records[0],
    post = f.records[1];
  assert.ok(
    pre?.facts.source === "tool-hook" && post?.facts.source === "tool-hook",
  );
  assert.deepEqual(pre.facts.toolInput, {
    file_path: join(f.cwd, "original.txt"),
  });
  assert.deepEqual(pre.facts.outcome.updatedInput, {
    file_path: join(f.cwd, "rewritten.txt"),
  });
  assert.deepEqual(post.facts.toolInput, {
    file_path: join(f.cwd, "rewritten.txt"),
  });
  assert.equal(
    f.deliveries[1]?.kind === "tool-hook" && f.deliveries[1].result?.content,
    result.content,
  );
  const wire = projectMessages([
    { role: "assistant", content: [modelCall] },
    { role: "user", content: [result] },
  ]);
  assert.equal(JSON.stringify(wire).includes("nativeCapture"), false);
  assert.equal(JSON.stringify(wire).includes("toolInput"), false);
  assert.deepEqual(wire[0]?.content[0], modelCall);
});

test("captured post context folds into its owning physical Read result and canonical text survives as one attachment", async () => {
  const f = await fixture(),
    registry = f.registry("PostToolUse", [
      f.entry("POST OWNED", "PostToolUse"),
    ]);
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: f.runOptions,
    nativeCapture: f.host,
  });
  const raw = {
    type: "tool_result" as const,
    tool_use_id: call.id,
    content: "READ BODY",
  };
  await runtime.after(call, raw, signal());
  const capture = f.records[0];
  assert.ok(
    capture?.status === "captured" &&
      capture.attachment.type === "hook_additional_context",
  );
  const rows: HookProjectionRow[] = [
    { type: "message", message: { role: "assistant", content: [call] } },
    { type: "message", message: { role: "user", content: [raw] } },
    {
      type: "hook_attachment",
      event: "PostToolUse",
      phase: "post",
      toolName: "Read",
      toolUseId: capture.attachment.toolUseID,
      content: capture.attachment.content,
    },
  ];
  const projection = projectHookAttachmentHistory(rows);
  assert.equal(projection.placements[0]?.channel, "tool_result");
  assert.equal(projection.placements[0]?.targetToolUseId, call.id);
  const result = projection.messages[1]?.content[0];
  assert.ok(result?.type === "tool_result");
  assert.match(JSON.stringify(result.content), /READ BODY/);
  assert.match(JSON.stringify(result.content), /POST OWNED/);
  assert.equal(projection.messages[1]?.content.length, 1);
  assert.match(JSON.stringify(capture.event.rendered), /POST OWNED/);
});

test("capture observer failures drain siblings, consume once and never rerun commands or mutate post result", async () => {
  const f = await fixture(),
    registry = f.registry("PostToolUse", [
      f.entry("FAST", "PostToolUse", 0, { once: true }),
      f.entry("SLOW", "PostToolUse", 70, { once: true }),
    ]);
  const original = {
    type: "tool_result" as const,
    tool_use_id: call.id,
    content: "RAW UNMUTATED",
  };
  f.host.capture = () => {
    throw new Error("journal rejected event");
  };
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: f.runOptions,
    nativeCapture: f.host,
  });
  await assert.rejects(
    runtime.after(call, original, signal()),
    /Hook result observation failed/,
  );
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(original, {
    type: "tool_result",
    tool_use_id: call.id,
    content: "RAW UNMUTATED",
  });
  const result = await runtime.after(call, original, signal());
  assert.deepEqual(result, original);
  assert.equal(f.stamps(), 2);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 2);
});

test("failed once hooks produce explicit unsupported evidence once and preserve registry consumption", async () => {
  const f = await fixture(),
    registry = f.registry("PreToolUse", [
      f.entry("FAILED ONCE", "PreToolUse", 0, { once: true }, {}, 7),
    ]);
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: f.runOptions,
    nativeCapture: f.host,
  });
  await runtime.before(call, signal(), async (input) => input);
  await runtime.before(call, signal(), async (input) => input);
  assert.deepEqual(labels(f.records), ["unsupported"]);
  assert.equal(f.stamps(), 0);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1);
});

test("background completion retains its callback/task ownership while native capture stays explicitly unsupported", async () => {
  const f = await fixture(),
    registry = f.registry("PostToolUse", [
      f.entry("BACKGROUND", "PostToolUse", 60, { async: true }),
    ]);
  const background: HookResult[] = [];
  let batch: HookBatchResult | undefined;
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: () => ({
      ...f.runOptions(),
      onBackgroundResult: (row) => {
        background.push(row);
      },
    }),
    nativeCapture: f.host,
    onBatch: (_event, value) => {
      batch = value;
    },
  });
  const raw = {
    type: "tool_result" as const,
    tool_use_id: call.id,
    content: "RAW",
  };
  assert.deepEqual(await runtime.after(call, raw, signal()), raw);
  assert.equal(batch?.background.length, 1);
  assert.equal(f.records[0]?.facts.source, "tool-hook-batch");
  await batch?.background[0]?.completion;
  await sleep(0);
  assert.equal(background.length, 1);
  assert.deepEqual(labels(f.records), ["unsupported", "unsupported"]);
  assert.equal(f.stamps(), 0);
});

test("capture snapshots precede existing observers and batch display mutations without leaking metadata into API messages", async () => {
  const f = await fixture(),
    registry = f.registry("PostToolUse", [
      f.entry("RAW BEFORE CALLBACK", "PostToolUse"),
    ]);
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    nativeCapture: f.host,
    runOptions: () => ({
      ...f.runOptions(),
      onResult: (outcome) => {
        outcome.additionalContext = "CHANGED BY EXISTING OBSERVER";
      },
    }),
    onBatch: (_event, batch) => {
      batch.additionalContext[0] = "CHANGED DISPLAY";
    },
  });
  const result = await runtime.after(
    call,
    { type: "tool_result", tool_use_id: call.id, content: "RAW RESULT" },
    signal(),
  );
  assert.deepEqual(labels(f.records), ["RAW BEFORE CALLBACK"]);
  const capture = f.records[0];
  assert.ok(capture?.facts.source === "tool-hook");
  assert.equal(capture.facts.outcome.additionalContext, "RAW BEFORE CALLBACK");
  assert.equal(result.hookAttachments?.[0]?.content[0], "CHANGED DISPLAY");
  assert.ok(Object.isFrozen(capture.facts.outcome));
  assert.ok(Object.isFrozen(capture.facts.toolInput));
});

test("background capture rejection remains visible on its task and preserves the original completion callback", async () => {
  const f = await fixture(),
    registry = f.registry("PostToolUse", [
      f.entry("BACKGROUND", "PostToolUse", 60, { async: true }),
    ]);
  const background: HookResult[] = [];
  let batch: HookBatchResult | undefined;
  f.host.capture = (row) => {
    if (row.facts.source === "tool-hook")
      throw new Error("background journal rejected");
  };
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: () => ({
      ...f.runOptions(),
      onBackgroundResult: (row) => {
        background.push(row);
      },
    }),
    nativeCapture: f.host,
    onBatch: (_event, value) => {
      batch = value;
    },
  });
  await runtime.after(
    call,
    { type: "tool_result", tool_use_id: call.id, content: "RAW" },
    signal(),
  );
  const task = batch?.background[0];
  assert.ok(task);
  await assert.rejects(task.completion, /Hook attachment capture failed/);
  await sleep(0);
  assert.equal(background.length, 1);
  assert.equal(background[0]?.additionalContext, "BACKGROUND");
  assert.equal(f.stamps(), 0);
});

test("a custom registry without creation observations yields explicit unsupported provenance instead of reconstructing aggregate context", async () => {
  const f = await fixture(),
    base = f.registry("PostToolUse", [f.entry("UNOBSERVED", "PostToolUse")]);
  const registry = {
    list: base.list.bind(base),
    close: base.close.bind(base),
    run: (
      input: Parameters<typeof base.run>[0],
      options: Parameters<typeof base.run>[1],
    ) => {
      const { onResult: _ignored, ...remaining } = options;
      return base.run(input, remaining);
    },
  };
  const runtime = createToolHookRuntime({
    registry,
    context: f.context,
    runOptions: f.runOptions,
    nativeCapture: f.host,
  });
  const raw = {
    type: "tool_result" as const,
    tool_use_id: call.id,
    content: "RAW",
  };
  const result = await runtime.after(call, raw, signal());
  assert.equal(f.records.length, 1);
  const record = f.records[0];
  assert.ok(
    record?.status === "unsupported" &&
      record.facts.source === "tool-hook-batch",
  );
  assert.deepEqual(record.facts.aggregateAdditionalContext, ["UNOBSERVED"]);
  assert.equal(record.facts.unobservedResults.length, 1);
  assert.deepEqual(result.hookAttachments?.[0]?.content, ["UNOBSERVED"]);
  assert.equal(f.stamps(), 0);
});
