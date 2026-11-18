import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, onTestFinished } from "bun:test";
import {
  createInstructionCatalog,
  type InstructionFile,
} from "../src/instructions.js";
import {
  InstructionContext,
  projectNestedInstruction,
} from "../src/instruction-context.js";
import { ReadState } from "../src/read-state.js";
import { createTools } from "../src/tools.js";
import type { Message } from "../src/types.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";
import type {
  NativeInstructionCaptureHost,
  NativeInstructionCaptureResult,
  NativeInstructionPayloadFile,
  NativeInstructionReason,
} from "../src/native-instruction-capture.js";

function nativeCaptureFixture() {
  let previous: readonly NativeInstructionPayloadFile[] | undefined,
    reason: NativeInstructionReason | undefined = "session_start",
    stamps = 0;
  const records: NativeInstructionCaptureResult[] = [],
    beforeNotice: string[] = [];
  const host: NativeInstructionCaptureHost = {
    state: () => ({ status: "known", previous, reason }),
    trust: () => ({ status: "verified", nativeProjection: "unclipped" }),
    stamp: () => ({
      uuid: `${String(++stamps).padStart(8, "0")}-2222-2222-2222-222222222222`,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    capture: (record, delivery) => {
      records.push(record);
      beforeNotice.push(
        JSON.stringify(
          delivery.kind === "eager"
            ? delivery.message.content
            : delivery.result.content,
        ),
      );
      if (record.status === "captured") previous = record.currentFiles;
    },
  };
  return {
    host,
    records,
    beforeNotice,
    stamps: () => stamps,
    previous: (value: typeof previous) => {
      previous = value;
    },
    reason: (value: NativeInstructionReason) => {
      reason = value;
    },
  };
}

test("nested projection preserves Unicode boundaries, continuation lines and Managed exemption", () => {
  const file: InstructionFile = {
    path: "/project/CLAUDE.md",
    canonicalPath: "/project/CLAUDE.md",
    kind: "Project",
    content: "a".repeat(39999) + "😀tail",
    contentDiffersFromDisk: false,
  };
  const cut = projectNestedInstruction(file, 200000, "claude-sonnet-4-5");
  assert.equal(cut.record.partial, true);
  assert.ok(cut.body.startsWith("a".repeat(39999) + "\n"));
  assert.match(cut.body, /line 1/);
  const line = projectNestedInstruction(
    { ...file, content: "first\n" + "b".repeat(45000) },
    200000,
    "claude-sonnet-4-5",
  );
  assert.ok(line.body.startsWith("first\n\n"));
  assert.match(line.body, /line 2/);
  const managed = projectNestedInstruction(
    { ...file, kind: "Managed" },
    200000,
    "claude-sonnet-4-5",
  );
  assert.equal(managed.body, file.content);
  assert.equal(managed.record.partial, false);
});

test("nested clipped/processed instructions remain partial until a complete direct Read; eager print instructions do not seed", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-instruction-context-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src/.claude/rules"), { recursive: true });
  await writeFile(join(cwd, "CLAUDE.md"), "eager\n");
  await writeFile(join(cwd, "src/a.txt"), "alpha\n");
  await writeFile(join(cwd, "src/CLAUDE.md"), "large\n" + "x".repeat(45000));
  await writeFile(
    join(cwd, "src/.claude/rules/conditional.md"),
    '---\npaths: "*.txt"\n---\nprocessed rule\n',
  );
  const catalog = createInstructionCatalog({
    cwd,
    ancestorBoundary: cwd,
    sources: { user: false, project: true, local: false },
  });
  const context = new InstructionContext({
    cwd,
    catalog,
    model: () => "claude-sonnet-4-5",
    contextWindow: () => 200000,
  });
  const messages: Message[] = [],
    state = new ReadState();
  const prompt: Message = {
    role: "user",
    content: [{ type: "text", text: "task" }],
  };
  await context.announce(prompt, messages);
  messages.push(prompt);
  assert.equal(state.has(join(cwd, "CLAUDE.md")), false);
  const tools = context.wrap(
    createTools({
      cwd,
      mode: "acceptEdits",
      readState: state,
      approve: async () => false,
    }),
    messages,
    state,
  );
  const signal = new AbortController().signal;
  const result = await tools.execute(
    {
      type: "tool_use",
      id: "read",
      name: "Read",
      input: { file_path: "src/a.txt" },
    },
    signal,
  );
  assert.match(result.content, /Only the beginning/);
  assert.match(result.content, /processed rule/);
  assert.ok(result.instructionFiles?.every((record) => record.partial));
  assert.throws(
    () => state.requireComplete(join(cwd, "src/CLAUDE.md")),
    /Partial|Read/,
  );
  assert.throws(
    () => state.requireComplete(join(cwd, "src/.claude/rules/conditional.md")),
    /Partial|Read/,
  );
  messages.push({ role: "user", content: [result] });
  const forbidden = await tools.execute(
    {
      type: "tool_use",
      id: "edit",
      name: "Edit",
      input: {
        file_path: "src/CLAUDE.md",
        old_string: "large",
        new_string: "changed",
      },
    },
    signal,
  );
  assert.equal(forbidden.is_error, true);
  assert.match(forbidden.content, /Read the entire file/);
  await tools.execute(
    {
      type: "tool_use",
      id: "full",
      name: "Read",
      input: { file_path: "src/CLAUDE.md" },
    },
    signal,
  );
  const edited = await tools.execute(
    {
      type: "tool_use",
      id: "retry",
      name: "Edit",
      input: {
        file_path: "src/CLAUDE.md",
        old_string: "large",
        new_string: "changed",
      },
    },
    signal,
  );
  assert.equal(edited.is_error, undefined);
  assert.ok(
    (await readFile(join(cwd, "src/CLAUDE.md"), "utf8")).startsWith("changed"),
  );
});

test("instruction changes and removals are announced on resume without duplicating unchanged files", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-instruction-refresh-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const create = () =>
    new InstructionContext({
      cwd,
      catalog: createInstructionCatalog({
        cwd,
        ancestorBoundary: cwd,
        sources: { user: false, project: true, local: true },
      }),
      model: () => "claude-sonnet-4-5",
      contextWindow: () => 200000,
    });
  await writeFile(join(cwd, "CLAUDE.md"), "version one");
  await writeFile(join(cwd, "CLAUDE.local.md"), "local");
  const first: Message = { role: "user", content: [] };
  await create().announce(first, []);
  const same: Message = { role: "user", content: [] };
  await create().announce(same, [first]);
  assert.equal(same.content.length, 0);
  await writeFile(join(cwd, "CLAUDE.md"), "version two");
  await rm(join(cwd, "CLAUDE.local.md"));
  const next: Message = { role: "user", content: [] };
  await create().announce(next, [first]);
  assert.match(JSON.stringify(next.content), /version two/);
  assert.match(JSON.stringify(next.content), /removed from the active catalog/);
  assert.equal(
    next.instructionFiles?.filter((record) => record.removed).length,
    1,
  );
});

test("native eager capture uses real admitted files before rendering and full owning state across initial/change/removal", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-instruction-eager-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "CLAUDE.md"), "  REAL_INITIAL_BODY\n");
  await writeFile(join(cwd, "CLAUDE.local.md"), "REAL_LOCAL_BODY");
  const capture = nativeCaptureFixture();
  const create = () =>
    new InstructionContext({
      cwd,
      catalog: createInstructionCatalog({
        cwd,
        ancestorBoundary: cwd,
        userConfigDir: join(cwd, "user"),
        managedRoot: join(cwd, "managed"),
        sources: { user: false, project: true, local: true },
      }),
      model: () => "claude-sonnet-4-6",
      contextWindow: () => 200000,
      nativeCapture: capture.host,
    });
  const first: Message = {
    role: "user",
    content: [{ type: "text", text: "HUMAN_INITIAL" }],
  };
  await create().announce(first, []);
  const initial = capture.records[0];
  assert.ok(initial && initial.status === "captured");
  assert.equal(initial.attachment.changed, undefined);
  assert.equal(
    initial.currentFiles.find((file) => file.type === "Project")?.content,
    "REAL_INITIAL_BODY",
  );
  assert.equal(
    initial.facts.files.find((file) => file.kind === "Project")
      ?.admittedContent,
    "  REAL_INITIAL_BODY\n",
  );
  assert.equal(
    capture.beforeNotice[0],
    JSON.stringify([{ type: "text", text: "HUMAN_INITIAL" }]),
  );
  assert.match(JSON.stringify(first.content), /Current instruction files/);
  const same: Message = {
    role: "user",
    content: [{ type: "text", text: "HUMAN_SAME" }],
  };
  await create().announce(same, [first]);
  assert.equal(capture.records[1]?.status, "unchanged");
  assert.equal(capture.stamps(), 1);
  assert.equal(same.content.length, 1);
  await writeFile(join(cwd, "CLAUDE.md"), "REAL_CHANGED_BODY");
  await rm(join(cwd, "CLAUDE.local.md"));
  capture.reason("settings_sync");
  const changed: Message = {
    role: "user",
    content: [{ type: "text", text: "HUMAN_CHANGED" }],
  };
  await create().announce(changed, [first, same]);
  const update = capture.records[2];
  assert.ok(update && update.status === "captured");
  assert.equal(update.attachment.changed, true);
  assert.equal(update.attachment.reason, "settings_sync");
  assert.deepEqual(update.attachment.removed, [join(cwd, "CLAUDE.local.md")]);
  assert.equal(update.attachment.files[0]?.content, "REAL_CHANGED_BODY");
  assert.equal(
    capture.beforeNotice[2],
    JSON.stringify([{ type: "text", text: "HUMAN_CHANGED" }]),
  );
  assert.match(
    JSON.stringify(changed.content),
    /removed from the active catalog/,
  );
  // A new native owner has no native announcement even though legacy hashes already match.
  capture.previous(undefined);
  const nativeOnly: Message = {
    role: "user",
    content: [{ type: "text", text: "HUMAN_NATIVE_ONLY" }],
  };
  await create().announce(nativeOnly, [first, same, changed]);
  const independent = capture.records[3];
  assert.ok(independent && independent.status === "captured");
  assert.equal(independent.attachment.changed, undefined);
  assert.equal(independent.attachment.files[0]?.content, "REAL_CHANGED_BODY");
  assert.equal(nativeOnly.content.length, 1);
  assert.equal(nativeOnly.instructionFiles, undefined);
  assert.equal(capture.stamps(), 3);
});

test("native nested capture retains actual projected/full/baseline data before the port notice and leaves Read state behavior intact", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-instruction-nested-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src/.claude/rules"), { recursive: true });
  await writeFile(join(cwd, "CLAUDE.md"), "ROOT_NATIVE_BODY");
  await writeFile(join(cwd, "src/a.ts"), "REAL_DATA\n");
  await writeFile(
    join(cwd, "src/CLAUDE.md"),
    "NESTED_LONG_BODY\n" + "x".repeat(45000),
  );
  await writeFile(
    join(cwd, "src/.claude/rules/conditional.md"),
    '---\npaths: "*.ts"\n---\nREAL_PROCESSED_RULE\n',
  );
  const capture = nativeCaptureFixture(),
    context = new InstructionContext({
      cwd,
      catalog: createInstructionCatalog({
        cwd,
        ancestorBoundary: cwd,
        userConfigDir: join(cwd, "user"),
        managedRoot: join(cwd, "managed"),
        sources: { user: false, project: true, local: false },
      }),
      model: () => "claude-sonnet-4-6",
      contextWindow: () => 200000,
      nativeCapture: capture.host,
    });
  const messages: Message[] = [],
    state = new ReadState(),
    prompt: Message = {
      role: "user",
      content: [{ type: "text", text: "REAL_NESTED_REQUEST" }],
    };
  await context.announce(prompt, messages);
  messages.push(prompt);
  assert.equal(state.has(join(cwd, "CLAUDE.md")), false);
  const tools = context.wrap(
    createTools({
      cwd,
      mode: "default",
      readState: state,
      approve: async () => false,
    }),
    messages,
    state,
  );
  const result = await tools.execute(
    {
      type: "tool_use",
      id: "native-nested-read",
      name: "Read",
      input: { file_path: "src/a.ts" },
    },
    new AbortController().signal,
  );
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /Nested instruction files/);
  const nested = capture.records.find(
    (record) => record.facts.phase === "nested",
  );
  assert.ok(nested && nested.status === "unsupported");
  assert.equal("event" in nested, false);
  assert.match(nested.reasons[0] ?? "", /nested_memory/);
  const long = nested.facts.files.find((file) =>
    file.path.endsWith("src/CLAUDE.md"),
  );
  assert.ok(long);
  assert.equal(long.clipped, true);
  assert.ok(long.admittedContent.length > long.projectedBody.length);
  assert.match(long.projectedBody, /Only the beginning/);
  const processed = nested.facts.files.find((file) =>
    file.path.endsWith("conditional.md"),
  );
  assert.ok(processed);
  assert.equal(processed.contentDiffersFromDisk, true);
  assert.match(processed.admittedContent, /REAL_PROCESSED_RULE/);
  assert.match(processed.rawDiskText ?? "", /paths:/);
  assert.equal(processed.readBaselineCandidate.partial, true);
  assert.equal(
    capture.beforeNotice.at(-1)?.includes("Nested instruction files"),
    false,
  );
  assert.throws(
    () => state.requireComplete(join(cwd, "src/CLAUDE.md")),
    /Partial|Read/,
  );
  assert.throws(
    () => state.requireComplete(join(cwd, "src/.claude/rules/conditional.md")),
    /Partial|Read/,
  );
  assert.equal(capture.stamps(), 1);
});

test("native capture owner failure propagates before legacy eager content is modified", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-instruction-owner-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "CLAUDE.md"), "ACTUAL_BODY");
  const capture = nativeCaptureFixture();
  capture.host.capture = () => {
    throw Error("OWNED_JOURNAL_REJECTED");
  };
  const context = new InstructionContext({
    cwd,
    catalog: createInstructionCatalog({
      cwd,
      ancestorBoundary: cwd,
      userConfigDir: join(cwd, "user"),
      managedRoot: join(cwd, "managed"),
      sources: { user: false, project: true, local: false },
    }),
    model: () => "claude-sonnet-4-6",
    contextWindow: () => 200000,
    nativeCapture: capture.host,
  });
  const prompt: Message = {
    role: "user",
    content: [{ type: "text", text: "UNCHANGED_HUMAN" }],
  };
  await assert.rejects(context.announce(prompt, []), /OWNED_JOURNAL_REJECTED/);
  assert.deepEqual(prompt.content, [{ type: "text", text: "UNCHANGED_HUMAN" }]);
  assert.equal(prompt.instructionFiles, undefined);
});

test("nested activation stays in tool history and a direct instruction Read is not eagerly reannounced", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-instruction-delivery-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src/deeper"), { recursive: true });
  await writeFile(join(cwd, "src/CLAUDE.md"), "nested marker");
  await writeFile(join(cwd, "src/a.txt"), "alpha");
  await writeFile(join(cwd, "src/deeper/CLAUDE.md"), "direct read marker");
  const create = () =>
    new InstructionContext({
      cwd,
      catalog: createInstructionCatalog({
        cwd,
        ancestorBoundary: cwd,
        sources: { user: false, project: true, local: false },
      }),
      model: () => "claude-sonnet-4-5",
      contextWindow: () => 200000,
    });
  const context = create(),
    state = new ReadState(),
    messages: Message[] = [];
  const prompt: Message = {
    role: "user",
    content: [{ type: "text", text: "task" }],
  };
  await context.announce(prompt, messages);
  messages.push(prompt);
  const tools = context.wrap(
    createTools({
      cwd,
      mode: "default",
      readState: state,
      approve: async () => false,
    }),
    messages,
    state,
  );
  const signal = new AbortController().signal;
  const nested = await tools.execute(
    {
      type: "tool_use",
      id: "nested",
      name: "Read",
      input: { file_path: "src/a.txt" },
    },
    signal,
  );
  assert.match(nested.content, /nested marker/);
  messages.push({ role: "user", content: [nested] });
  await tools.beforeModelRequest?.(signal);
  assert.equal(messages.length, 2);
  const direct = await tools.execute(
    {
      type: "tool_use",
      id: "direct",
      name: "Read",
      input: { file_path: "src/deeper/CLAUDE.md" },
    },
    signal,
  );
  assert.match(direct.content, /direct read marker/);
  assert.equal(direct.instructionFiles, undefined);
  messages.push({ role: "user", content: [direct] });
  await tools.beforeModelRequest?.(signal);
  assert.equal(messages.length, 3);
  const resumed: Message = { role: "user", content: [] };
  await create().announce(resumed, messages);
  assert.equal(resumed.content.length, 0);
  assert.equal(resumed.instructionFiles, undefined);
});

test("a validated hook redirect activates instructions for the executed path without mutating the model call", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-instruction-redirect-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  for (const directory of ["original", "executed"])
    await mkdir(join(cwd, directory));
  await writeFile(join(cwd, "original/a.txt"), "original data");
  await writeFile(join(cwd, "original/CLAUDE.md"), "original path instruction");
  await writeFile(join(cwd, "executed/a.txt"), "executed data");
  await writeFile(join(cwd, "executed/CLAUDE.md"), "executed path instruction");
  const capture = nativeCaptureFixture();
  const context = new InstructionContext({
    cwd,
    catalog: createInstructionCatalog({
      cwd,
      ancestorBoundary: cwd,
      sources: { user: false, project: true, local: false },
    }),
    model: () => "claude-sonnet-4-5",
    contextWindow: () => 200000,
    nativeCapture: capture.host,
  });
  const state = new ReadState(),
    messages: Message[] = [];
  const hooks: ToolHookRuntime = {
    async before(_call, _signal, validate) {
      return {
        updatedInput: await validate({ file_path: "executed/a.txt" }),
        additionalContext: [],
        preventContinuation: false,
      };
    },
    async after(_call, result) {
      return result;
    },
  };
  const tools = context.wrap(
    createTools({
      cwd,
      mode: "default",
      readState: state,
      hooks,
      approve: async () => false,
    }),
    messages,
    state,
  );
  const call = {
    type: "tool_use" as const,
    id: "redirect",
    name: "Read",
    input: { file_path: "original/a.txt" },
  };
  const result = await tools.execute(call, new AbortController().signal);
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /executed data/);
  assert.match(result.content, /executed path instruction/);
  assert.doesNotMatch(result.content, /original path instruction/);
  assert.deepEqual(call.input, { file_path: "original/a.txt" });
  assert.equal(state.has(join(cwd, "executed/a.txt")), true);
  assert.equal(state.has(join(cwd, "original/a.txt")), false);
  const nested = capture.records.find(
    (record) => record.facts.phase === "nested",
  );
  assert.ok(nested && nested.status === "unsupported");
  assert.ok(
    nested.facts.files.some(
      (file) => file.canonicalPath === join(cwd, "executed/CLAUDE.md"),
    ),
  );
  assert.equal(
    nested.facts.files.some(
      (file) => file.canonicalPath === join(cwd, "original/CLAUDE.md"),
    ),
    false,
  );
  assert.equal(
    capture.beforeNotice.at(-1)?.includes("Nested instruction files"),
    false,
  );
});
