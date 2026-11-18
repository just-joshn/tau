import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createTools, type FileToolCallContext } from "../src/tools.js";
import { createLocalSkillRegistry } from "../src/skills.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";
import type { ToolUse } from "../src/types.js";
const signal = () => new AbortController().signal;
const call = (name: string, input: unknown): ToolUse => ({ type: "tool_use", id: "owned-file-call", name, input });
const pre = () => ({ additionalContext: [] as string[], preventContinuation: false });
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-file-activation-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("missing Read activates matching conditional skill before its call fails", async t => {
  const cwd = await fixture(t), skill = join(cwd, ".claude", "skills", "owned-conditional", "SKILL.md");
  await mkdir(dirname(skill), { recursive: true });
  await writeFile(skill, "---\ndescription: Owned conditional metadata\npaths: ['src/**']\n---\nOwned instructions\n");
  const registry = await createLocalSkillRegistry({ cwd, projectDirectories: [cwd], sources: { user: false, project: true } });
  assert.deepEqual(registry.catalog(), []);
  const events: string[] = [], controller = new AbortController();
  const tools = createTools({ cwd, mode: "default", approve: async () => false, onFileToolCall(context) {
    assert.equal(context.name, "Read"); assert.equal(context.path, join(cwd, "src", "absent.ts")); assert.equal(context.signal, controller.signal);
    events.push(...registry.activateForPaths([context.path]));
  } });
  const result = await tools.execute(call("Read", { file_path: "src/absent.ts" }), controller.signal);
  assert.equal(result.is_error, true); assert.match(result.content, /ENOENT/);
  assert.deepEqual(events, ["owned-conditional"]);
  assert.deepEqual(registry.catalog().map(skill => skill.name), ["owned-conditional"]);
});
test("Write callback precedes parent creation, then later filesystem/read-state failure remains visible", async t => {
  const cwd = await fixture(t), target = join(cwd, "new", "file.txt"), seen: FileToolCallContext[] = [];
  const tools = createTools({ cwd, mode: "acceptEdits", approve: async () => false, async onFileToolCall(context) {
    seen.push(context); await assert.rejects(readFile(target), { code: "ENOENT" });
    // An owned concurrent actor creates an unread file while the asynchronous callback is running.
    await mkdir(dirname(target)); await writeFile(target, "external content");
  } });
  const result = await tools.execute(call("Write", { file_path: "new/file.txt", content: "replacement" }), signal());
  assert.equal(result.is_error, true); assert.match(result.content, /Read/);
  assert.equal(seen.length, 1); assert.equal(seen[0]!.name, "Write"); assert.equal(seen[0]!.path, target);
  assert.equal(await readFile(target, "utf8"), "external content");
});
test("effective hook path activates after PreToolUse and permission but before execution and PostToolUse", async t => {
  const cwd = await fixture(t), events: string[] = [];
  const hooks: ToolHookRuntime = { async before(_call, _signal, validate) {
    events.push("pre"); return { ...pre(), updatedInput: await validate({ file_path: "effective.txt", content: "effective" }) };
  }, async after(_call, result) { events.push("post"); return result; } };
  const tools = createTools({ cwd, mode: "default", hooks,
    approve: async () => { events.push("permission"); return true; },
    async onFileToolCall(context) { events.push("activate"); assert.equal(context.path, join(cwd, "effective.txt")); await assert.rejects(readFile(context.path), { code: "ENOENT" }); } });
  const model = call("Write", { file_path: "original.txt", content: "original" });
  assert.equal((await tools.execute(model, signal())).is_error, undefined);
  assert.deepEqual(events, ["pre", "permission", "activate", "post"]);
  assert.deepEqual(model.input, { file_path: "original.txt", content: "original" });
  assert.equal(await readFile(join(cwd, "effective.txt"), "utf8"), "effective");
  await assert.rejects(readFile(join(cwd, "original.txt")), { code: "ENOENT" });
});
test("validated Read and Edit invoke callback once each, before new content is written", async t => {
  const cwd = await fixture(t), target = join(cwd, "file.txt"), names: string[] = [];
  await writeFile(target, "alpha");
  const tools = createTools({ cwd, mode: "acceptEdits", approve: async () => false,
    async onFileToolCall(context) { names.push(context.name); assert.equal(await readFile(target, "utf8"), "alpha"); } });
  assert.equal((await tools.execute(call("Read", { file_path: "file.txt" }), signal())).is_error, undefined);
  assert.equal((await tools.execute(call("Edit", { file_path: "file.txt", old_string: "alpha", new_string: "beta" }), signal())).is_error, undefined);
  assert.deepEqual(names, ["Read", "Edit"]); assert.equal(await readFile(target, "utf8"), "beta");
});
test("denied, rejected, unread, stopped and invalid hook-replacement inputs never activate", async t => {
  const cwd = await fixture(t), seen: string[] = [], onFileToolCall = (context: FileToolCallContext) => { seen.push(context.path); };
  await writeFile(join(cwd, "unread"), "alpha");
  const options = { cwd, mode: "default" as const, onFileToolCall, approve: async () => false };
  const tools = createTools(options);
  for (const tool of [call("Read", {}), call("Read", { file_path: "../outside" }), call("Write", { file_path: "unread", content: "no" }),
    call("Edit", { file_path: "unread", old_string: "alpha", new_string: "no" }), call("Edit", { file_path: "missing", old_string: "alpha", new_string: "no" }),
    call("Write", { file_path: "new", content: "approval denied" })]) assert.equal((await tools.execute(tool, signal())).is_error, true);
  const denied = createTools({ ...options, policy: { allowedTools: [], disallowedTools: ["Read"] } });
  assert.equal((await denied.execute(call("Read", { file_path: "unread" }), signal())).permissionDenied, true);
  for (const before of [async () => ({ ...pre(), permission: "deny" as const }), async () => ({ ...pre(), preventContinuation: true }),
    async () => ({ ...pre(), permission: "allow" as const, updatedInput: { file_path: "bad" } })]) {
    const hooks: ToolHookRuntime = { before, async after(_call, result) { return result; } };
    assert.equal((await createTools({ ...options, hooks }).execute(call("Write", { file_path: "new", content: "owned" }), signal())).is_error, true);
  }
  assert.deepEqual(seen, []);
});
test("post-permission path changes fail before callback rather than activating a rejected call", async t => {
  const cwd = await fixture(t), outside = await fixture(t), seen: string[] = [];
  const tools = createTools({ cwd, mode: "default", onFileToolCall(context) { seen.push(context.path); },
    async approve() { await symlink(outside, join(cwd, "changed")); return true; } });
  const result = await tools.execute(call("Write", { file_path: "changed/file", content: "no" }), signal());
  assert.equal(result.permissionDenied, true); assert.deepEqual(seen, []);
  await assert.rejects(readFile(join(outside, "file")), { code: "ENOENT" });
});
test("callback errors stop I/O and reach failure hook; callback cancellation stops I/O", async t => {
  const cwd = await fixture(t), events: string[] = [];
  const hooks: ToolHookRuntime = { async before() { return { ...pre(), permission: "allow" }; }, async after(_call, result) { events.push("post"); return result; },
    async failure(_call, error) { events.push(error instanceof Error ? error.message : "failure"); } };
  const failed = createTools({ cwd, mode: "default", hooks, approve: async () => false,
    onFileToolCall() { throw new Error("owned activation refused"); } });
  const result = await failed.execute(call("Write", { file_path: "new/file", content: "no" }), signal());
  assert.equal(result.is_error, true); assert.equal(result.content, "owned activation refused"); assert.deepEqual(events, ["owned activation refused"]);
  await assert.rejects(readFile(join(cwd, "new/file")), { code: "ENOENT" });
  const controller = new AbortController();
  const cancelled = createTools({ cwd, mode: "acceptEdits", approve: async () => false, onFileToolCall() { controller.abort(new Error("owned abort")); } });
  assert.equal((await cancelled.execute(call("Write", { file_path: "cancelled", content: "no" }), controller.signal)).is_error, true);
  await assert.rejects(readFile(join(cwd, "cancelled")), { code: "ENOENT" });
});
test("Bash, Glob, and Grep never invoke file call activation", async t => {
  const cwd = await fixture(t), names: string[] = [];
  await writeFile(join(cwd, "file.txt"), "owned marker");
  const tools = createTools({ cwd, mode: "bypassPermissions", approve: async () => false, onFileToolCall(context) { names.push(context.name); } });
  for (const tool of [call("Bash", { command: "printf owned" }), call("Glob", { pattern: "*.txt" }), call("Grep", { pattern: "owned" })]) {
    assert.equal((await tools.execute(tool, signal())).is_error, undefined);
  }
  assert.deepEqual(names, []);
});
