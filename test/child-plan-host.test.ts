import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildPlanHost, type ChildPlanHostOptions } from "../src/child-plan-host.js";
import { PlanFileManager, type PlanApproval, type PlanPermissionState } from "../src/plan-runtime.js";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import type { ToolPolicy } from "../src/tool-policy.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";
import type { PermissionMode, ToolExecutor, ToolUse } from "../src/types.js";
const signal = () => new AbortController().signal;
const call = (name = "ExitPlanMode", input: unknown = {}): ToolUse => ({ type: "tool_use", id: "owned-child-plan", name, input });
const pre = () => ({ additionalContext: [] as string[], preventContinuation: false });
const base: ToolExecutor = { definitions: [], async execute(tool) { return { type: "tool_result", tool_use_id: tool.id, content: "owned unrelated" }; } };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-child-plan-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"), plans = join(root, "owned-config", "plans"); await mkdir(cwd); await mkdir(plans, { recursive: true });
  const files = new PlanFileManager({ directory: plans, createSlug: () => "owned-shared-plan" });
  let state: PlanPermissionState = { mode: "plan", prePlanMode: "acceptEdits" }, sid = "owned-session", approve: PlanApproval = { approved: true };
  let policy: ToolPolicy = { allowedTools: [], disallowedTools: [] }, approvalReady = true;
  let before: ToolHookRuntime["before"] = async () => pre();
  const events: string[] = [], notices: string[] = []; let reads = 0, saves = 0, setters = 0, approvals = 0;
  const hooks: ToolHookRuntime = { async before(...args) { events.push(`pre:${args[0].name}`); return before(...args); },
    async after(tool, result) { events.push(`post:${tool.name}`); return result; }, async failure(tool) { events.push(`failure:${tool.name}`); } };
  const options: ChildPlanHostOptions = {
    cwd, sessionId: () => sid, actor: { agentId: "owned-agent" }, isAsync: false, fileBacked: true, files,
    permissions: () => state, setSessionPermissions(update) { setters++; state = update(state); },
    storage: { async read(path, active, context) { reads++; active.throwIfAborted(); assert.equal(context.sessionId, "owned-session"); assert.equal(context.agentId, "owned-agent");
      try { return await readFile(context.canonicalPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
      async save(path, text, active, context) { saves++; active.throwIfAborted(); await writeFile(context.canonicalPath, text); return { savedPath: path }; } },
    enabled: () => true, policy: () => policy, canRequestApproval: () => approvalReady,
    authorize(context) { events.push(`authorize:${context.agentId}:${context.hookPermission ?? "none"}`); return { behavior: "allow" }; },
    async approve(context) { approvals++; events.push(`approve:${context.agentId}:${context.isAsync}`); return approve; }, hooks,
    vetDirectory: (canonical, declared) => canonical === plans && declared === plans,
    onExecution(execution) { events.push(`executed:${execution.transition?.to ?? "same"}`); notices.push(...execution.notices); },
  };
  const host = (overrides: Partial<ChildPlanHostOptions> = {}) => createChildPlanHost({ ...options, ...overrides });
  return { cwd, plans, files, options, host, events, notices, hooks,
    setBefore(value: ToolHookRuntime["before"]) { before = value; }, setState(value: PlanPermissionState) { state = value; }, state: () => state,
    setPolicy(value: ToolPolicy) { policy = value; }, policy: () => policy, setApproval(value: PlanApproval) { approve = value; }, setReady(value: boolean) { approvalReady = value; }, setSession(value: string) { sid = value; },
    counts: () => ({ reads, saves, setters, approvals }) };
}

test("child designated files share session slug and use exact actor suffix without changing main designation", async t => {
  const f = await fixture(t), main = f.files.path("owned-session"), first = f.host(), second = f.host({ actor: { agentId: "sibling" } });
  assert.equal(main, join(f.plans, "owned-shared-plan.md"));
  assert.equal(first.location(), join(f.plans, "owned-shared-plan-agent-owned-agent.md"));
  assert.equal(second.location(), join(f.plans, "owned-shared-plan-agent-sibling.md"));
  assert.equal(f.files.path("owned-session"), main); assert.equal(first.sessionId, "owned-session");
});
test("coherent child Write→Read→Edit designated plan outside workspace→Exit asks and restores shared mode", async t => {
  const f = await fixture(t), host = f.host(), target = host.location()!, state = new ReadState();
  const tools = host.wrap(() => createTools({ cwd: f.cwd, mode: f.state().mode as PermissionMode, policy: f.policy(), readState: state,
    ...host.fileAccess, hooks: f.hooks, approve: async () => { throw Error("The admitted designated file does not need an ordinary default ask"); } }));
  assert.equal((await tools.execute(call("Write", { file_path: target, content: "Owned plan alpha\n" }), signal())).is_error, undefined);
  assert.equal((await tools.execute(call("Read", { file_path: target }), signal())).is_error, undefined);
  assert.equal((await tools.execute(call("Edit", { file_path: target, old_string: "alpha", new_string: "beta" }), signal())).is_error, undefined);
  const model = call(), result = await tools.execute(model, signal());
  assert.equal(result.is_error, undefined); assert.equal(f.state().mode, "acceptEdits"); assert.equal(f.counts().approvals, 1);
  assert.equal((result.hookResponse as any).isAgent, true); assert.equal((result.hookResponse as any).filePath, target);
  assert.equal((result.hookResponse as any).plan, "Owned plan beta\n"); assert.deepEqual(model.input, {});
  assert.equal(await readFile(target, "utf8"), "Owned plan beta\n");
});
test("Enter child guard rejects before hooks, storage, permissions and approvals", async t => {
  const f = await fixture(t), tools = f.host().wrap(base);
  for (const input of [{}, { unexpected: true }]) {
    const result = await tools.execute(call("EnterPlanMode", input), signal()); assert.equal(result.inputRejected, true);
  }
  assert.deepEqual(f.events, []); assert.deepEqual(f.counts(), { reads: 0, saves: 0, setters: 0, approvals: 0 });
  assert.equal(f.state().mode, "plan");
});
test("hook allow without update still asks; validated full update+allow satisfies interaction only after full host allow", async t => {
  const f = await fixture(t), host = f.host(), target = host.location()!; await writeFile(target, "disk");
  f.setBefore(async () => ({ ...pre(), permission: "allow" })); f.setApproval({ approved: false, reason: "Owned reject" });
  assert.equal((await host.wrap(base).execute(call(), signal())).permissionDenied, true); assert.equal(f.state().mode, "plan"); assert.equal(f.counts().approvals, 1);
  f.setBefore(async (_tool, _signal, validate) => ({ ...pre(), permission: "allow", updatedInput: await validate({ plan: "Owned hook plan", planFilePath: join(f.cwd, "forged") }) }));
  const result = await host.wrap(base).execute(call("ExitPlanMode", { plan: "model", planFilePath: join(f.cwd, "model") }), signal());
  assert.equal(result.is_error, undefined); assert.equal(f.counts().approvals, 1); assert.equal(await readFile(target, "utf8"), "Owned hook plan");
  await assert.rejects(readFile(join(f.cwd, "forged")), { code: "ENOENT" }); await assert.rejects(readFile(join(f.cwd, "model")), { code: "ENOENT" });
});
test("explicit parent ask/deny and protected full-host denial survive validated hook interaction exception", async t => {
  const f = await fixture(t); f.setBefore(async (_tool, _signal, validate) => ({ ...pre(), permission: "allow", updatedInput: await validate({ plan: "effective" }) }));
  f.setPolicy({ allowedTools: [], disallowedTools: [], askedTools: ["ExitPlanMode"] }); f.setApproval({ approved: false });
  assert.equal((await f.host().wrap(base).execute(call(), signal())).permissionDenied, true); assert.equal(f.counts().approvals, 1);
  f.setPolicy({ allowedTools: [], disallowedTools: ["ExitPlanMode"] });
  assert.equal((await f.host().wrap(base).execute(call(), signal())).permissionDenied, true); assert.equal(f.counts().approvals, 1);
  f.setPolicy({ allowedTools: [], disallowedTools: [] });
  const denied = f.host({ authorize: () => ({ behavior: "deny", reason: "Owned protected safety decision" }) });
  assert.match((await denied.wrap(base).execute(call(), signal())).content, /protected safety/); assert.equal(f.state().mode, "plan"); assert.equal(f.counts().saves, 0);
});
test("parent denial installed during actual approval prevents plan persistence and mode transition", async t => {
  const f = await fixture(t), host = f.host({ async approve() { f.setPolicy({ allowedTools: [], disallowedTools: ["ExitPlanMode"] }); return { approved: true, updatedInput: { plan: "must not save" } }; } });
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.permissionDenied, true); assert.equal(f.state().mode, "plan"); assert.equal(f.counts().saves, 0); assert.equal(f.counts().setters, 0);
});
test("approved ordinary async Exit uses explicit bridge but never invokes shared session setter", async t => {
  const f = await fixture(t); let approvals = 0;
  const host = f.host({ isAsync: true, setSessionPermissions() { throw Error("async setter must be a no-op"); }, async approve(context) { approvals++; assert.equal(context.isAsync, true); return { approved: true }; } });
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.is_error, undefined); assert.equal((result.hookResponse as any).isAgent, true); assert.equal(f.state().mode, "plan"); assert.equal(approvals, 1);
  assert.equal(host.wrap(base).definitions.some(tool => tool.name === "EnterPlanMode"), false);
});
test("approval empty replacement rereads fresh designated file; an approval UI mode change is preserved", async t => {
  const f = await fixture(t); let target = "";
  const host = f.host({ async approve() { await writeFile(target, "fresh after approval"); f.setState({ mode: "bypassPermissions", isBypassPermissionsModeAvailable: true }); return { approved: true, updatedInput: {} }; } });
  target = host.location()!; await writeFile(target, "old snapshot");
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.is_error, undefined); assert.equal((result.hookResponse as any).plan, "fresh after approval"); assert.equal((result.hookResponse as any).planWasEdited, undefined);
  assert.equal(f.state().mode, "bypassPermissions"); assert.equal(f.counts().saves, 0); assert.equal(f.counts().setters, 0);
});
test("session change during approval and public file admission prevents cross-session effects", async t => {
  const f = await fixture(t), host = f.host({ async approve() { f.setSession("different"); return { approved: true, updatedInput: { plan: "no" } }; } }), target = host.location()!;
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.inputRejected, true); assert.equal(f.counts().saves, 0); assert.equal(f.counts().setters, 0);
  await assert.rejects(host.fileAccess.extraPathAdmission({ operation: "Write", requestedPath: target, signal: signal() }), /different active session/);
});
test("fork, team, Doc and invalid actor metadata refuse this specific adapter", async t => {
  const f = await fixture(t);
  for (const options of [{ actor: { agentId: "owned-agent", builtInFork: true } }, { actor: { agentId: "owned-agent", teammate: { requiresApproval: true, taskAvailable: true } } }, { fileBacked: false }, { actor: { agentId: "../escape" } }]) assert.throws(() => f.host(options));
  f.setState({ mode: "plan", planDoc: { id: "owned-doc" } }); assert.throws(() => f.host(), /Doc/);
});
test("directory vetting refuses normalization storage and missing approval capability cannot fabricate approval", async t => {
  const f = await fixture(t), denied = f.host({ vetDirectory: () => false });
  assert.equal((await denied.wrap(base).execute(call(), signal())).inputRejected, true); assert.equal(f.counts().reads, 0); assert.deepEqual(f.events, []);
  f.setReady(false); const result = await f.host().wrap(base).execute(call(), signal());
  assert.equal(result.inputRejected, true); assert.equal(f.counts().approvals, 0); assert.equal(f.state().mode, "plan");
});
test("child save cannot adopt an alternate target or move shared session designation", async t => {
  const f = await fixture(t), host = f.host({ storage: { read: f.options.storage.read, async save() { return { savedPath: join(f.plans, "different.md") }; } } }), target = host.location()!;
  f.setBefore(async (_call, _signal, validate) => ({ ...pre(), permission: "allow", updatedInput: await validate({ plan: "approved effective text" }) }));
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.is_error, undefined); assert.equal((result.hookResponse as any).plan, "approved effective text"); assert.equal((result.hookResponse as any).filePath, undefined);
  assert.ok(f.notices.some(message => message.includes("unsupported alternate target"))); assert.equal(host.location(), undefined);
  assert.equal(f.files.path("owned-session", "owned-agent"), target); assert.equal(f.files.path("owned-session"), join(f.plans, "owned-shared-plan.md"));
});
test("save failure retains approved text and reports notice while cancellation prevents the call", async t => {
  const f = await fixture(t), failed = f.host({ storage: { read: f.options.storage.read, async save() { throw Error("Owned save failure"); } } });
  f.setBefore(async (_call, _signal, validate) => ({ ...pre(), permission: "allow", updatedInput: await validate({ plan: "kept approved text" }) }));
  const result = await failed.wrap(base).execute(call(), signal());
  assert.equal(result.is_error, undefined); assert.equal((result.hookResponse as any).plan, "kept approved text"); assert.ok(f.notices.includes("Owned save failure")); assert.equal(f.state().mode, "acceptEdits");
  f.setState({ mode: "plan" }); f.setBefore(async () => pre()); const controller = new AbortController();
  const cancelled = f.host({ async approve() { controller.abort(); return { approved: true }; } });
  await assert.rejects(cancelled.wrap(base).execute(call(), controller.signal), { name: "AbortError" }); assert.equal(f.state().mode, "plan");
});
test("file eligibility never waives explicit Read deny/Write ask or a symlinked save target", async t => {
  const f = await fixture(t), host = f.host(), target = host.location()!;
  const denied = createTools({ cwd: f.cwd, mode: "plan", ...host.fileAccess, policy: { allowedTools: [], disallowedTools: [], sourcedRules: [{ source: "policySettings", behavior: "deny", rule: "Read" }] }, approve: async () => true });
  assert.equal((await denied.execute(call("Write", { file_path: target, content: "no" }), signal())).permissionDenied, true);
  const asked = createTools({ cwd: f.cwd, mode: "plan", ...host.fileAccess, policy: { allowedTools: [], disallowedTools: [], askedTools: ["Write"] }, approve: async () => false });
  assert.equal((await asked.execute(call("Write", { file_path: target, content: "no" }), signal())).permissionDenied, true);
  const other = join(f.plans, "owned-shared-plan.md"); await writeFile(other, "unchanged"); await symlink(other, target);
  f.setBefore(async (_call, _signal, validate) => ({ ...pre(), permission: "allow", updatedInput: await validate({ plan: "cannot write through link" }) }));
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.is_error, undefined); assert.equal((result.hookResponse as any).filePath, undefined); assert.equal(await readFile(other, "utf8"), "unchanged");
});
