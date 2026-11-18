import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstructionCatalog, type InstructionFile } from "../src/instructions.js";
import { InstructionContext, projectNestedInstruction } from "../src/instruction-context.js";
import { ReadState } from "../src/read-state.js";
import { createTools } from "../src/tools.js";
import type { Message } from "../src/types.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";

test("nested projection preserves Unicode boundaries, continuation lines and Managed exemption", () => {
  const file: InstructionFile = { path: "/project/CLAUDE.md", canonicalPath: "/project/CLAUDE.md", kind: "Project", content: "a".repeat(39999) + "😀tail", contentDiffersFromDisk: false };
  const cut = projectNestedInstruction(file, 200000, "claude-sonnet-4-5");
  assert.equal(cut.record.partial, true);
  assert.ok(cut.body.startsWith("a".repeat(39999) + "\n"));
  assert.match(cut.body, /line 1/);
  const line = projectNestedInstruction({ ...file, content: "first\n" + "b".repeat(45000) }, 200000, "claude-sonnet-4-5");
  assert.ok(line.body.startsWith("first\n\n")); assert.match(line.body, /line 2/);
  const managed = projectNestedInstruction({ ...file, kind: "Managed" }, 200000, "claude-sonnet-4-5");
  assert.equal(managed.body, file.content); assert.equal(managed.record.partial, false);
});

test("nested clipped/processed instructions remain partial until a complete direct Read; eager print instructions do not seed", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-instruction-context-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src/.claude/rules"), { recursive: true });
  await writeFile(join(cwd, "CLAUDE.md"), "eager\n");
  await writeFile(join(cwd, "src/a.txt"), "alpha\n");
  await writeFile(join(cwd, "src/CLAUDE.md"), "large\n" + "x".repeat(45000));
  await writeFile(join(cwd, "src/.claude/rules/conditional.md"), '---\npaths: "*.txt"\n---\nprocessed rule\n');
  const catalog = createInstructionCatalog({ cwd, ancestorBoundary: cwd, sources: { user: false, project: true, local: false } });
  const context = new InstructionContext({ cwd, catalog, model: () => "claude-sonnet-4-5", contextWindow: () => 200000 });
  const messages: Message[] = [], state = new ReadState();
  const prompt: Message = { role: "user", content: [{ type: "text", text: "task" }] };
  await context.announce(prompt, messages); messages.push(prompt);
  assert.equal(state.has(join(cwd, "CLAUDE.md")), false);
  const tools = context.wrap(createTools({ cwd, mode: "acceptEdits", readState: state, approve: async () => false }), messages, state);
  const signal = new AbortController().signal;
  const result = await tools.execute({ type: "tool_use", id: "read", name: "Read", input: { file_path: "src/a.txt" } }, signal);
  assert.match(result.content, /Only the beginning/);
  assert.match(result.content, /processed rule/);
  assert.ok(result.instructionFiles?.every(record => record.partial));
  assert.throws(() => state.requireComplete(join(cwd, "src/CLAUDE.md")), /Partial|Read/);
  assert.throws(() => state.requireComplete(join(cwd, "src/.claude/rules/conditional.md")), /Partial|Read/);
  messages.push({ role: "user", content: [result] });
  const forbidden = await tools.execute({ type: "tool_use", id: "edit", name: "Edit", input: { file_path: "src/CLAUDE.md", old_string: "large", new_string: "changed" } }, signal);
  assert.equal(forbidden.is_error, true);
  assert.match(forbidden.content, /Read the entire file/);
  await tools.execute({ type: "tool_use", id: "full", name: "Read", input: { file_path: "src/CLAUDE.md" } }, signal);
  const edited = await tools.execute({ type: "tool_use", id: "retry", name: "Edit", input: { file_path: "src/CLAUDE.md", old_string: "large", new_string: "changed" } }, signal);
  assert.equal(edited.is_error, undefined);
  assert.ok((await readFile(join(cwd, "src/CLAUDE.md"), "utf8")).startsWith("changed"));
});

test("instruction changes and removals are announced on resume without duplicating unchanged files", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-instruction-refresh-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const create = () => new InstructionContext({ cwd,
    catalog: createInstructionCatalog({ cwd, ancestorBoundary: cwd, sources: { user: false, project: true, local: true } }),
    model: () => "claude-sonnet-4-5", contextWindow: () => 200000 });
  await writeFile(join(cwd, "CLAUDE.md"), "version one");
  await writeFile(join(cwd, "CLAUDE.local.md"), "local");
  const first: Message = { role: "user", content: [] };
  await create().announce(first, []);
  const same: Message = { role: "user", content: [] };
  await create().announce(same, [first]); assert.equal(same.content.length, 0);
  await writeFile(join(cwd, "CLAUDE.md"), "version two"); await rm(join(cwd, "CLAUDE.local.md"));
  const next: Message = { role: "user", content: [] };
  await create().announce(next, [first]);
  assert.match(JSON.stringify(next.content), /version two/);
  assert.match(JSON.stringify(next.content), /removed from the active catalog/);
  assert.equal(next.instructionFiles?.filter(record => record.removed).length, 1);
});

test("nested activation stays in tool history and a direct instruction Read is not eagerly reannounced", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-instruction-delivery-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src/deeper"), { recursive: true });
  await writeFile(join(cwd, "src/CLAUDE.md"), "nested marker");
  await writeFile(join(cwd, "src/a.txt"), "alpha");
  await writeFile(join(cwd, "src/deeper/CLAUDE.md"), "direct read marker");
  const create = () => new InstructionContext({ cwd,
    catalog: createInstructionCatalog({ cwd, ancestorBoundary: cwd, sources: { user: false, project: true, local: false } }),
    model: () => "claude-sonnet-4-5", contextWindow: () => 200000 });
  const context = create(), state = new ReadState(), messages: Message[] = [];
  const prompt: Message = { role: "user", content: [{ type: "text", text: "task" }] };
  await context.announce(prompt, messages); messages.push(prompt);
  const tools = context.wrap(createTools({ cwd, mode: "default", readState: state, approve: async () => false }), messages, state);
  const signal = new AbortController().signal;
  const nested = await tools.execute({ type: "tool_use", id: "nested", name: "Read", input: { file_path: "src/a.txt" } }, signal);
  assert.match(nested.content, /nested marker/);
  messages.push({ role: "user", content: [nested] });
  await tools.beforeModelRequest?.(signal);
  assert.equal(messages.length, 2);
  const direct = await tools.execute({ type: "tool_use", id: "direct", name: "Read", input: { file_path: "src/deeper/CLAUDE.md" } }, signal);
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

test("a validated hook redirect activates instructions for the executed path without mutating the model call", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-instruction-redirect-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const directory of ["original", "executed"]) await mkdir(join(cwd, directory));
  await writeFile(join(cwd, "original/a.txt"), "original data");
  await writeFile(join(cwd, "original/CLAUDE.md"), "original path instruction");
  await writeFile(join(cwd, "executed/a.txt"), "executed data");
  await writeFile(join(cwd, "executed/CLAUDE.md"), "executed path instruction");
  const context = new InstructionContext({ cwd,
    catalog: createInstructionCatalog({ cwd, ancestorBoundary: cwd, sources: { user: false, project: true, local: false } }),
    model: () => "claude-sonnet-4-5", contextWindow: () => 200000 });
  const state = new ReadState(), messages: Message[] = [];
  const hooks: ToolHookRuntime = {
    async before(_call, _signal, validate) { return { updatedInput: await validate({ file_path: "executed/a.txt" }), additionalContext: [], preventContinuation: false }; },
    async after(_call, result) { return result; },
  };
  const tools = context.wrap(createTools({ cwd, mode: "default", readState: state, hooks, approve: async () => false }), messages, state);
  const call = { type: "tool_use" as const, id: "redirect", name: "Read", input: { file_path: "original/a.txt" } };
  const result = await tools.execute(call, new AbortController().signal);
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /executed data/);
  assert.match(result.content, /executed path instruction/);
  assert.doesNotMatch(result.content, /original path instruction/);
  assert.deepEqual(call.input, { file_path: "original/a.txt" });
  assert.equal(state.has(join(cwd, "executed/a.txt")), true);
  assert.equal(state.has(join(cwd, "original/a.txt")), false);
});
