import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpPermissionPrompt, parsePermissionPromptUpdates, permissionPromptAllowedInput, PERMISSION_UPDATE_ITEM_LIMIT } from "../src/permission-prompt.js";
import type { ExternalToolRegistry } from "../src/tool-router.js";
import type { ToolUse } from "../src/types.js";
import { McpManager } from "../src/mcp.js";
import { PlanFileManager, PlanRuntime, type PlanPermissionState } from "../src/plan-runtime.js";
import { wrapPlanRuntime } from "../src/plan-session.js";

const toolName = "mcp__owned__permit";
const call = (name = "Write", input: unknown = { file_path: "/owned/a", content: "owned" }): ToolUse => ({ type: "tool_use", id: "owned-call", name, input });
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
function fixture(initial: unknown = text({ behavior: "allow" })) {
  let raw = initial, available = true, fail: Error | undefined;
  const calls: Array<{ name: string; input: unknown }> = [];
  const registry: ExternalToolRegistry = {
    get definitions(): never { throw new Error("Permission helpers must not inspect or refresh model catalog"); },
    lookup: name => available && name === toolName ? { serverName: "owned", isReadOnly: false, requiresUserInteraction: true } : undefined,
    refreshTools: async () => { throw new Error("Permission helpers must not activate or refresh servers"); },
    async callTool(name, input) { calls.push({ name, input }); if (fail) throw fail; return { raw, projection: { text: "misleading model projection" } }; },
  };
  return { registry, calls, rawTo: (value: unknown) => { raw = value; }, availableTo: (value: boolean) => { available = value; }, failWith: (value: Error) => { fail = value; } };
}

test("MCP permission prompt sends exact effective request directly without routing or activation", async () => {
  const f = fixture(text({ behavior: "allow", updatedInput: { content: "approved" }, toolUseID: "owned-call", decisionClassification: "user_temporary" }));
  const prompt = createMcpPermissionPrompt({ toolName, registry: f.registry }), original = call();
  assert.equal(prompt.ready, true); assert.equal(prompt.isReady(), true);
  const result = await prompt.request(original, new AbortController().signal);
  assert.deepEqual(f.calls, [{ name: toolName, input: { tool_name: original.name, input: original.input, tool_use_id: original.id } }]);
  assert.deepEqual(result, { approved: true, updatedInput: { content: "approved" }, toolUseID: "owned-call", decisionClassification: "user_temporary" });
  assert.deepEqual(original.input, { file_path: "/owned/a", content: "owned" });
});

test("missing/non-MCP/ineligible prompt tools and host request floors never call a server", async () => {
  const f = fixture(); f.availableTo(false);
  const prompt = createMcpPermissionPrompt({ toolName, registry: f.registry });
  assert.equal(prompt.ready, false); assert.equal((await prompt.request(call(), new AbortController().signal)).approved, false);
  f.availableTo(true);
  assert.equal(createMcpPermissionPrompt({ toolName: "Read", registry: f.registry }).ready, false);
  const guarded = createMcpPermissionPrompt({ toolName, registry: f.registry, eligible: () => false });
  assert.equal(guarded.ready, false);
  assert.equal((await guarded.request(call(), new AbortController().signal)).approved, false);
  const requestFloor = createMcpPermissionPrompt({ toolName, registry: f.registry, admitRequest: () => "host-owned wording cannot use this wire" });
  assert.equal((await requestFloor.request(call(), new AbortController().signal)).reason, "host-owned wording cannot use this wire");
  assert.deepEqual(f.calls, []);
});

test("only the first content block is authoritative and projection/structuredContent cannot grant", async () => {
  const f = fixture({ content: [{ type: "text", text: JSON.stringify({ behavior: "allow" }) }, { type: "text", text: "later malformed text" }] });
  const prompt = createMcpPermissionPrompt({ toolName, registry: f.registry });
  assert.equal((await prompt.request(call(), new AbortController().signal)).approved, true);
  for (const raw of [
    { content: [] }, { structuredContent: { behavior: "allow" }, content: [] },
    { content: [{ type: "image", mimeType: "image/png", data: "AA==" }, { type: "text", text: JSON.stringify({ behavior: "allow" }) }] },
    { content: [{ type: "text", text: "not JSON" }], structuredContent: { behavior: "allow" } },
    { content: [{ type: "text", text: JSON.stringify({ behavior: "allow" }) }], isError: true },
  ]) { f.rawTo(raw); assert.equal((await prompt.request(call(), new AbortController().signal)).approved, false); }
  f.rawTo({ content: [{ type: "text", text: '\uFEFF{"behavior":"allow"}' }] });
  assert.equal((await prompt.request(call(), new AbortController().signal)).approved, true);
});

test("permission decisions validate literal allow/deny field types and preserve deny interruption", async () => {
  const f = fixture(), prompt = createMcpPermissionPrompt({ toolName, registry: f.registry });
  for (const decision of [null, true, [], { approved: true }, { behavior: "ask" }, { behavior: "allow", updatedInput: [] }, { behavior: "allow", updatedInput: null },
    { behavior: "deny" }, { behavior: "deny", message: 1 }, { behavior: "deny", message: "no", interrupt: "false" }]) {
    f.rawTo(text(decision)); assert.equal((await prompt.request(call(), new AbortController().signal)).approved, false);
  }
  f.rawTo(text({ behavior: "deny", message: "owned rejection", interrupt: true, toolUseID: "owned-call" }));
  assert.deepEqual(await prompt.request(call(), new AbortController().signal), { approved: false, reason: "owned rejection", interrupt: true, toolUseID: "owned-call" });
  f.rawTo(text({ behavior: "allow", interrupt: true, decisionClassification: "unknown classification" }));
  const allowed = await prompt.request(call(), new AbortController().signal);
  assert.equal(allowed.approved, true); assert.equal(allowed.interrupt, undefined); assert.equal(allowed.decisionClassification, undefined);
});

test("an MCP target interaction requirement rejects allow without rejecting a native plan approval", async () => {
  const f = fixture(), target = "mcp__owned__person", registry: ExternalToolRegistry = { definitions: [],
    lookup: name => name === target ? { serverName: "owned", isReadOnly: false, requiresUserInteraction: true } : f.registry.lookup(name),
    callTool: f.registry.callTool,
  };
  let applied = 0;
  const prompt = createMcpPermissionPrompt({ toolName, registry, applyUpdatedPermissions: () => { applied++; } });
  f.rawTo(text({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }));
  assert.equal((await prompt.request(call(target), new AbortController().signal)).approved, false); assert.equal(applied, 0);
  assert.equal((await prompt.request(call("ExitPlanMode", {}), new AbortController().signal)).approved, true); assert.equal(applied, 1);
});

test("empty/absent allow updates use native fallback and strip file-backed Exit plan fields", () => {
  const original = call("ExitPlanMode", { plan: "disk snapshot", planFilePath: "/owned/plan.md", allowedPrompts: [] });
  assert.deepEqual(permissionPromptAllowedInput(original), { allowedPrompts: [] });
  assert.deepEqual(permissionPromptAllowedInput(original, {}), { allowedPrompts: [] });
  assert.deepEqual(permissionPromptAllowedInput(original, { plan: "approved edit" }), { plan: "approved edit" });
  assert.deepEqual(original.input, { plan: "disk snapshot", planFilePath: "/owned/plan.md", allowedPrompts: [] });
  assert.deepEqual(permissionPromptAllowedInput(call("ExitPlanMode", { plan: "diskless text" }), undefined, { disklessPlan: true }), { plan: "diskless text" });
  assert.deepEqual(permissionPromptAllowedInput(call()), call().input);
});

test("valid permission updates are preserved without application and explicit host application is opt-in", async () => {
  const updates = [
    { type: "setMode", mode: "manual", destination: "session" },
    { type: "addRules", behavior: "deny", rules: [{ toolName: "Bash", ruleContent: "owned:*" }], destination: "session" },
    { type: "addDirectories", directories: ["/owned"], destination: "session" },
  ];
  const f = fixture(text({ behavior: "allow", updatedPermissions: updates })), diagnostics: string[] = [];
  const prompt = createMcpPermissionPrompt({ toolName, registry: f.registry, onDiagnostic: message => diagnostics.push(message) });
  const result = await prompt.request(call(), new AbortController().signal);
  assert.equal(result.approved, true); assert.equal(result.updatedPermissions?.[0]?.type, "setMode");
  assert.deepEqual(result.updatedPermissions?.[0], { type: "setMode", mode: "default", destination: "session" });
  assert.match(diagnostics[0]!, /has not applied/);
  let applied = 0;
  const applying = createMcpPermissionPrompt({ toolName, registry: f.registry, applyUpdatedPermissions: (admitted, context) => {
    applied++; assert.equal(admitted.length, 3); assert.deepEqual(context.approvedInput, call().input);
  } });
  assert.equal((await applying.request(call(), new AbortController().signal)).approved, true); assert.equal(applied, 1);
});

test("malformed and over-budget update metadata is dropped with diagnostics while allow survives", async () => {
  const f = fixture(), diagnostics: string[] = [], prompt = createMcpPermissionPrompt({ toolName, registry: f.registry, onDiagnostic: message => diagnostics.push(message) });
  for (const updates of [null, "not updates", [{ type: "setMode", mode: "invalid", destination: "session" }],
    [{ type: "addDirectories", directories: ["/owned"], destination: "policySettings" }],
    [{ type: "addRules", behavior: "deny", destination: "session", rules: Array.from({ length: PERMISSION_UPDATE_ITEM_LIMIT }, () => ({ toolName: "Read" })) }]]) {
    f.rawTo(text({ behavior: "allow", updatedPermissions: updates })); const result = await prompt.request(call(), new AbortController().signal);
    assert.equal(result.approved, true); assert.equal(result.updatedPermissions, undefined);
  }
  assert.equal(diagnostics.length, 5);
  assert.equal(parsePermissionPromptUpdates([{ type: "addRules", behavior: "ask", destination: "session", rules: Array.from({ length: PERMISSION_UPDATE_ITEM_LIMIT - 1 }, () => ({ toolName: "Read" })) }])?.length, 1);
});

test("RPC/application errors never grant and aborted in-flight replies cannot apply updates", async () => {
  const f = fixture(); f.failWith(new Error("owned RPC failure"));
  assert.equal((await createMcpPermissionPrompt({ toolName, registry: f.registry }).request(call(), new AbortController().signal)).approved, false);
  const applyFailure = fixture(text({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }));
  assert.equal((await createMcpPermissionPrompt({ toolName, registry: applyFailure.registry,
    applyUpdatedPermissions: () => { throw new Error("owned policy application failed"); } }).request(call(), new AbortController().signal)).approved, false);
  const controller = new AbortController();
  let finish!: (value: Awaited<ReturnType<ExternalToolRegistry["callTool"]>>) => void, applied = 0;
  const pendingRegistry: ExternalToolRegistry = { definitions: [], lookup: f.registry.lookup, callTool: async () => new Promise(resolve => { finish = resolve; }) };
  const prompt = createMcpPermissionPrompt({ toolName, registry: pendingRegistry, applyUpdatedPermissions: () => { applied++; } });
  const pending = prompt.request(call(), controller.signal), rejected = assert.rejects(pending, /owned abort/);
  controller.abort(new Error("owned abort")); await rejected;
  finish({ raw: text({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }), projection: { text: "unused" } });
  await Promise.resolve(); assert.equal(applied, 0);
});

test("abort before dispatch and synchronous transport cancellation produce no stray grant", async () => {
  const f = fixture(), before = new AbortController(); before.abort(new Error("already cancelled"));
  await assert.rejects(createMcpPermissionPrompt({ toolName, registry: f.registry }).request(call(), before.signal), /already cancelled/);
  assert.deepEqual(f.calls, []);
  const active = new AbortController(), registry: ExternalToolRegistry = { definitions: [], lookup: f.registry.lookup, async callTool() { active.abort(new Error("cancelled while starting")); throw new Error("transport cancelled"); } };
  await assert.rejects(createMcpPermissionPrompt({ toolName, registry }).request(call(), active.signal), /cancelled while starting/);
});

test("empty MCP approval replacement makes the plan call read fresh user edits instead of overwriting a snapshot", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-permission-fresh-plan-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, "plans"); await mkdir(directory);
  const files = new PlanFileManager({ directory, createSlug: () => "owned-plan" }), path = files.path("owned-session");
  await writeFile(path, "old snapshot"); let state: PlanPermissionState = { mode: "plan", prePlanMode: "default" }, writes = 0;
  const f = fixture(), registry: ExternalToolRegistry = { definitions: [], lookup: f.registry.lookup, async callTool(_name, input) {
    assert.equal((input as { input: { plan: string } }).input.plan, "old snapshot");
    await writeFile(path, "fresh user edit"); return { raw: text({ behavior: "allow", updatedInput: {} }), projection: { text: "unused" } };
  } };
  const prompt = createMcpPermissionPrompt({ toolName, registry });
  const runtime = new PlanRuntime({ files, sessionId: () => "owned-session", permissions: () => state, setPermissions: update => { state = update(state); },
    canRequestApproval: () => prompt.ready, approve: async () => { throw new Error("adapter owns approval"); },
    storage: { read: path => readFile(path, "utf8"), save: async (path, content) => { writes++; await writeFile(path, content); return { savedPath: path }; } } });
  const tools = wrapPlanRuntime({ definitions: [], async execute() { throw new Error("unexpected base tool"); } }, {
    runtime, authorize: () => ({ behavior: "allow" }), approve: ({ call, signal }) => prompt.request(call, signal),
  });
  const result = await tools.execute(call("ExitPlanMode", {}), new AbortController().signal);
  assert.equal(result.is_error, undefined); assert.equal(state.mode, "default"); assert.equal(writes, 0);
  assert.match(result.content, /fresh user edit/); assert.equal(await readFile(path, "utf8"), "fresh user edit");
});

test("permission prompt runs against an owned MCP stdio peer with exact request/response casing", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "tau-permission-prompt-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "server.mjs"), log = join(cwd, "calls.jsonl");
  await writeFile(file, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';let count=0;const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');createInterface({input:process.stdin}).on('line',line=>{let m=JSON.parse(line);if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned',version:'1'}});else if(m.method==='tools/list')send(m.id,{tools:[{name:'permit',inputSchema:{type:'object'}}]});else if(m.method==='tools/call'){appendFileSync(process.argv[2],JSON.stringify(m.params.arguments)+'\\n');const input=m.params.arguments;send(m.id,{content:[{type:'text',text:JSON.stringify(++count===1?{behavior:'deny',message:'OWNED_REJECT',interrupt:false,toolUseID:input.tool_use_id}:{behavior:'allow',updatedInput:input.input,toolUseID:input.tool_use_id})}]})}});`);
  const manager = await McpManager.connect({ owned: { command: process.execPath, args: [file, log] } }, { cwd, env: {}, negotiation: "legacy" });
  t.after(() => manager.close());
  const prompt = createMcpPermissionPrompt({ toolName, registry: manager }), owned = call("ExitPlanMode", { plan: "OWNED_PLAN_FINAL\n", planFilePath: join(cwd, "owned.md") });
  assert.equal(prompt.ready, true);
  assert.deepEqual(await prompt.request(owned, new AbortController().signal), { approved: false, reason: "OWNED_REJECT", interrupt: false, toolUseID: owned.id });
  assert.deepEqual(await prompt.request(owned, new AbortController().signal), { approved: true, updatedInput: owned.input, toolUseID: owned.id });
  const recorded = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(recorded, [0, 1].map(() => ({ tool_name: owned.name, input: owned.input, tool_use_id: owned.id })));
  await manager.close(); assert.equal(prompt.ready, false);
});
