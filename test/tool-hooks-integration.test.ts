import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import { createHookRegistry } from "../src/hooks.js";
import { createToolHookRuntime, type PreToolHookResult, type ToolHookRuntime } from "../src/tool-hook-runtime.js";
import { routeExternalTools, type ExternalToolRegistry } from "../src/tool-router.js";
import { projectMessages } from "../src/thinking-history.js";
import { runAgent } from "../src/agent.js";
import { ApiAttemptBudgetExhausted } from "../src/attempt-ledger.js";
import type { CompletionRequest, Message, Provider, ToolUse } from "../src/types.js";

const signal = () => new AbortController().signal;
const call = (name: string, input: unknown): ToolUse => ({ type: "tool_use", id: "owned-call", name, input });
const defaultPre = (): PreToolHookResult => ({ additionalContext: [], preventContinuation: false });
async function directory(t: any) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-tool-hook-integration-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("builtin validation precedes hooks, while missing ordinary Read reaches pre hook then call failure", async t => {
  const cwd = await directory(t), events: string[] = [], state = new ReadState();
  await writeFile(join(cwd, "a.txt"), "alpha\n");
  const hooks: ToolHookRuntime = {
    async before(tool) { events.push(`pre:${tool.name}`); return { ...defaultPre(), permission: "allow" }; },
    async after(tool, result) { events.push(`post:${tool.name}`); return result; },
    async failure(tool) { events.push(`failure:${tool.name}`); },
  };
  const tools = createTools({ cwd, mode: "default", readState: state, hooks, approve: async () => false });
  for (const tool of [call("Write", { file_path: "a.txt", content: "no" }),
    call("Edit", { file_path: "a.txt", old_string: "alpha", new_string: "no" }),
    call("Edit", { file_path: "absent", old_string: "alpha", new_string: "no" })]) {
    assert.equal((await tools.execute(tool, signal())).is_error, true);
  }
  assert.deepEqual(events, []);
  assert.equal((await tools.execute(call("Read", { file_path: "absent" }), signal())).is_error, true);
  assert.deepEqual(events, ["pre:Read", "failure:Read"]);
  events.length = 0;
  await tools.execute(call("Read", { file_path: "a.txt" }), signal()); events.length = 0;
  for (const old_string of ["missing", "a"]) {
    // Missing replacement and repeated match fail before the pre hook.
    assert.equal((await tools.execute(call("Edit", { file_path: "a.txt", old_string, new_string: "no" }), signal())).is_error, true);
  }
  assert.deepEqual(events, []);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "alpha\n");
});

test("normalized pre input, full rewritten validation and effective metadata preserve original model input", async t => {
  const cwd = await directory(t), seen: any[] = [];
  const hooks: ToolHookRuntime = {
    async before(tool, _signal, validate) {
      seen.push(tool.input);
      return { ...defaultPre(), permission: "allow", updatedInput: await validate({ file_path: join(cwd, "rewritten.txt"), content: "rewritten\n" }) };
    },
    async after(tool, result) { seen.push(tool.input, result.hookResponse); return result; },
  };
  const tools = createTools({ cwd, mode: "default", hooks, approve: async () => false });
  const modelCall = call("Write", { file_path: "new.txt", content: "model input\n" });
  const result = await tools.execute(modelCall, signal());
  assert.equal(result.is_error, undefined);
  assert.deepEqual(modelCall.input, { file_path: "new.txt", content: "model input\n" });
  assert.equal(seen[0].file_path, join(cwd, "new.txt"));
  assert.equal(seen[1].file_path, join(cwd, "rewritten.txt"));
  assert.deepEqual(result.effectiveToolInput, seen[1]);
  assert.deepEqual(seen[2], { type: "create", filePath: join(cwd, "rewritten.txt"), content: "rewritten\n", structuredPatch: [], originalFile: null, userModified: false });
  assert.equal(await readFile(join(cwd, "rewritten.txt"), "utf8"), "rewritten\n");
  await assert.rejects(readFile(join(cwd, "new.txt")), { code: "ENOENT" });
  const wire = projectMessages([{ role: "assistant", content: [modelCall] }, { role: "user", content: [result] }]);
  assert.equal(JSON.stringify(wire).includes("effectiveToolInput"), false);
  assert.equal(JSON.stringify(wire).includes("hookResponse"), false);
  assert.deepEqual(wire[0]?.content[0], modelCall);
});

test("hook inputs omit unspecified Read offsets and Bash timeouts but retain explicit values", async t => {
  const cwd = await directory(t), seen: Array<{ name: string; input: any }> = [];
  await writeFile(join(cwd, "a.txt"), "alpha\n");
  const hooks: ToolHookRuntime = { async before(tool) { seen.push({ name: tool.name, input: tool.input }); return defaultPre(); }, async after(_tool, result) { return result; } };
  const tools = createTools({ cwd, mode: "bypassPermissions", hooks, approve: async () => true });
  for (const input of [{ file_path: "a.txt" }, { file_path: "a.txt", offset: 1 }]) assert.equal((await tools.execute(call("Read", input), signal())).is_error, undefined);
  for (const input of [{ command: "printf owned" }, { command: "printf owned", timeout: 1000 }]) assert.equal((await tools.execute(call("Bash", input), signal())).is_error, undefined);
  assert.equal(Object.hasOwn(seen[0]!.input, "offset"), false); assert.equal(seen[1]!.input.offset, 1);
  assert.equal(Object.hasOwn(seen[2]!.input, "timeout"), false); assert.equal(seen[3]!.input.timeout, 1000);
});

test("invalid complete hook replacement cannot inherit allow or create files", async t => {
  const cwd = await directory(t);
  const hooks: ToolHookRuntime = { async before() { return { ...defaultPre(), permission: "allow", updatedInput: { file_path: "bad" } }; }, async after(_tool, result) { return result; } };
  const tools = createTools({ cwd, mode: "bypassPermissions", hooks, approve: async () => true });
  assert.equal((await tools.execute(call("Write", { file_path: "original", content: "model" }), signal())).inputRejected, true);
  await assert.rejects(readFile(join(cwd, "original")), { code: "ENOENT" });
  await assert.rejects(readFile(join(cwd, "bad")), { code: "ENOENT" });
});

test("hook allow cannot waive explicit ask, sensitive writes, plan mode or deny; hook ask survives bypass", async t => {
  const cwd = await directory(t); let permission: PreToolHookResult["permission"] = "allow", approvals = 0, posts = 0;
  const hooks: ToolHookRuntime = { async before() { return { ...defaultPre(), ...(permission ? { permission } : {}) }; }, async after(_tool, result) { posts++; return result; } };
  const tool = call("Write", { file_path: "ordinary", content: "ok" });
  const run = (mode: "default" | "plan" | "bypassPermissions", policy = {}) => createTools({ cwd, mode, hooks, policy: { allowedTools: [], disallowedTools: [], ...policy },
    approve: async () => { approvals++; return false; } }).execute(tool, signal());
  assert.equal((await run("default", { askedTools: ["Write"] })).permissionDenied, true);
  assert.equal((await run("plan")).permissionDenied, true);
  assert.equal((await run("bypassPermissions", { disallowedTools: ["Write"] })).permissionDenied, true);
  const sensitive = createTools({ cwd, mode: "default", hooks, approve: async () => { approvals++; return false; } });
  assert.equal((await sensitive.execute(call("Write", { file_path: ".claude/settings.json", content: "{}" }), signal())).permissionDenied, true);
  permission = "ask";
  assert.equal((await run("bypassPermissions")).permissionDenied, true);
  assert.equal(posts, 0); assert.equal(approvals, 3);
  permission = "allow";
  assert.equal((await run("default")).is_error, undefined);
  assert.equal(posts, 1); assert.equal(approvals, 3);
});

test("Read/Edit post payloads use execution data and Bash nonzero is failure, not a success post hook", async t => {
  const cwd = await directory(t), records: any[] = [];
  await writeFile(join(cwd, "a.txt"), "alpha\n");
  const hooks: ToolHookRuntime = { async before() { return { ...defaultPre(), permission: "allow" }; },
    async after(tool, result) { records.push({ event: "post", name: tool.name, response: result.hookResponse }); return result; },
    async failure(tool) { records.push({ event: "failure", name: tool.name }); } };
  const tools = createTools({ cwd, mode: "default", hooks, approve: async () => false });
  await tools.execute(call("Read", { file_path: "a.txt" }), signal());
  await tools.execute(call("Edit", { file_path: "a.txt", old_string: "alpha", new_string: "beta" }), signal());
  const failed = await tools.execute(call("Bash", { command: "printf owned; exit 7" }), signal());
  assert.equal(failed.is_error, true);
  assert.deepEqual(records[0].response, { type: "text", file: { filePath: "a.txt", content: "alpha\n", numLines: 2, startLine: 1, totalLines: 2 } });
  assert.deepEqual(records[1].response, { filePath: "a.txt", oldString: "alpha", newString: "beta", originalFile: "alpha\n",
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-alpha", "+beta"] }], userModified: false, replaceAll: false });
  assert.deepEqual(records[2], { event: "failure", name: "Bash" });
  await tools.execute(call("Bash", { command: "printf '\nowned success\n'; printf error >&2" }), signal());
  assert.deepEqual(records[3], { event: "post", name: "Bash", response: { stdout: "owned success", stderr: "error", interrupted: false, isImage: false } });
});

test("actual registry commands rewrite after validation, preserve raw response, and reject unvalidated output replacement", async t => {
  const cwd = await directory(t), log = join(cwd, "hooks.jsonl"), script = join(cwd, "hook.cjs");
  await writeFile(script, String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const i=JSON.parse(raw);require('node:fs').appendFileSync(process.env.LOG,JSON.stringify(i)+'\n');process.stdout.write(JSON.stringify(i.hook_event_name==='PreToolUse'?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...i.tool_input,content:'hook content\n'}}}:{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'post context',updatedToolOutput:{unsupported:'shape'}}}));});`);
  const registry = createHookRegistry([{ source: "userSettings", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: process.execPath, args: [script] }] }], PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: process.execPath, args: [script] }] }] } }]);
  t.after(() => registry.close()); const diagnostics: string[] = [];
  const hooks = createToolHookRuntime({ registry, context: () => ({ session_id: "owned", transcript_path: join(cwd, "session.json"), cwd }),
    runOptions: () => ({ cwd, projectDir: cwd, env: { LOG: log }, maxOutputBytes: 65536 }), onDiagnostic: message => diagnostics.push(message) });
  const result = await createTools({ cwd, mode: "default", hooks, approve: async () => false }).execute(call("Write", { file_path: "new", content: "original" }), signal());
  assert.equal(result.is_error, undefined); assert.match(result.content, /File written/); assert.deepEqual(result.hookAttachments?.flatMap(item => item.content), ["post context"]);
  assert.equal(await readFile(join(cwd, "new"), "utf8"), "hook content\n");
  const rows = (await readFile(log, "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.equal(rows[0].tool_input.file_path, join(cwd, "new"));
  assert.equal(rows[1].tool_input.content, "hook content\n");
  assert.equal(rows[1].tool_response.content, "hook content\n");
  assert.equal(diagnostics.length, 1); assert.match(diagnostics[0]!, /no output-schema validator/);
});

test("external hook rewrites revalidate and respect interaction/ask floors; MCP isError skips success post", async t => {
  const cwd = await directory(t), name = "mcp__owned__lookup"; let calls = 0, posts = 0, failures = 0, interaction = false, isError = false;
  const registry: ExternalToolRegistry = { definitions: [{ name, description: "owned", input_schema: { type: "object" } }],
    lookup: value => value === name ? { serverName: "owned", isReadOnly: true, requiresUserInteraction: interaction } : undefined,
    validateInput(_name, value) { if (!(value && typeof value === "object" && "query" in value && typeof value.query === "string")) throw new Error("query must be a string"); return value; },
    async callTool(_name, input) { calls++; assert.deepEqual(input, { query: "hook" }); return { raw: { content: [{ type: "text", text: "result" }], isError }, projection: { text: "result", isError } }; } };
  const hooks: ToolHookRuntime = { async before(_tool, _signal, validate) { return { ...defaultPre(), permission: "allow", updatedInput: await validate({ query: "hook" }) }; },
    async after(_tool, result) { posts++; return result; }, async failure() { failures++; } };
  const make = (policy = {}) => routeExternalTools(createTools({ cwd, mode: "default", approve: async () => false }), registry, { mode: "default", hooks, policy: { allowedTools: [], disallowedTools: [], ...policy }, approve: async () => false });
  assert.equal((await make().execute(call(name, { query: "original" }), signal())).is_error, false);
  interaction = true; assert.equal((await make().execute(call(name, { query: "original" }), signal())).permissionDenied, true); interaction = false;
  assert.equal((await make({ askedTools: [name] }).execute(call(name, { query: "original" }), signal())).permissionDenied, true);
  isError = true; assert.equal((await make().execute(call(name, { query: "original" }), signal())).is_error, true);
  assert.deepEqual({ calls, posts, failures }, { calls: 2, posts: 1, failures: 1 });
});

function agentFixture() {
  const requests: CompletionRequest[] = [], flags: boolean[] = [], messages: Message[] = [{ role: "user", content: [{ type: "text", text: "owned" }] }];
  const provider: Provider = { async complete(request) { requests.push(request); if (request.attemptBudget && !request.attemptBudget.take()) throw new ApiAttemptBudgetExhausted();
    return { content: [{ type: "text", text: `answer ${requests.length}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }; } };
  const options: Parameters<typeof runAgent>[0] = { provider, tools: { definitions: [], async execute() { throw new Error("unexpected"); } }, messages,
    model: "test", system: "owned", maxTokens: 100, maxTurns: 3, maxApiAttempts: 2, autoCompact: false, signal: signal(), onEvent: () => {},
    stopHook: async ({ stopHookActive }) => { flags.push(stopHookActive); return { continue: !stopHookActive, additionalContext: ["Finish the owned check"] }; } };
  return { requests, flags, messages, options };
}

test("Stop continuation shares prompt API allowance and round budget and exposes active state", async () => {
  const f = agentFixture(); const result = await runAgent(f.options);
  assert.equal(result.turns, 2); assert.deepEqual(f.flags, [false, true]);
  assert.equal(f.requests[0]?.attemptBudget, f.requests[1]?.attemptBudget);
  assert.equal(f.requests[1]?.attemptBudget?.remaining, 0);
  assert.match(JSON.stringify(f.messages), /Finish the owned check/);
  const bounded = agentFixture(); bounded.options.maxApiAttempts = 1;
  await assert.rejects(runAgent(bounded.options), /API attempt budget exhausted/);
  assert.equal(bounded.requests.length, 2); assert.equal(bounded.requests[0]?.attemptBudget, bounded.requests[1]?.attemptBudget);
  const rounds = agentFixture(); rounds.options.maxTurns = 1;
  await assert.rejects(runAgent(rounds.options), /maxTurns/); assert.equal(rounds.requests.length, 1);
});

test("a tool hook stop preserves paired results and skips all remaining side effects and model requests", async () => {
  const f = agentFixture(); let count = 0;
  f.options.provider = { async complete() { return { content: [call("Write", {}), { ...call("Write", {}), id: "second" }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }; } };
  f.options.tools.execute = async tool => { count++; return { type: "tool_result", tool_use_id: tool.id, content: "stopped", hookStop: { reason: "owned stop" } }; };
  await runAgent(f.options); assert.equal(count, 1);
  const results = f.messages.at(-1)!.content;
  assert.deepEqual(results.map(result => result.type === "tool_result" && result.tool_use_id), ["owned-call", "second"]);
  assert.match(results[1]?.type === "tool_result" ? results[1].content : "", /skipped because a hook/);
  assert.equal(JSON.stringify(projectMessages(f.messages)).includes("hookStop"), false);
});

test("agent commits hook attachments after tool results without contaminating raw or rich payloads", async () => {
  const f = agentFixture(); let requests = 0;
  f.options.stopHook = async () => ({ continue: false });
  f.options.provider = { async complete() {
    requests++;
    if (requests === 1) return { content: [call("Read", { file_path: "owned" })], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
    const row = projectMessages(f.messages).at(-1)!;
    assert.deepEqual(row.content, [
      { type: "tool_result", tool_use_id: "owned-call", content: [{ type: "text", text: "raw result" }] },
      { type: "text", text: "pre context" }, { type: "text", text: "post context" },
    ]);
    return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  } };
  f.options.tools.execute = async tool => ({ type: "tool_result", tool_use_id: tool.id, content: "raw result",
    apiContent: [{ type: "text", text: "raw result" }], hookContext: ["pre context", "post context"] });
  await runAgent(f.options); assert.equal(requests, 2);
});

test("failure-only command hooks attach feedback after failed execution without stopping or replacing it", async t => {
  const cwd = await directory(t), script = join(cwd, "failure.cjs"), log = join(cwd, "failure.jsonl");
  await writeFile(script, String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const i=JSON.parse(raw);require('node:fs').appendFileSync(process.env.LOG,JSON.stringify(i)+'\n');process.stdout.write(JSON.stringify({continue:false,stopReason:'not a failure stop',hookSpecificOutput:{hookEventName:'PostToolUseFailure',additionalContext:'owned recovery feedback'}}));});`);
  const registry = createHookRegistry([{ source: "userSettings", hooks: { PostToolUseFailure: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] } }]);
  t.after(() => registry.close());
  const hooks = createToolHookRuntime({ registry, context: () => ({ session_id: "owned", transcript_path: join(cwd, "session.json"), cwd }),
    runOptions: () => ({ cwd, projectDir: cwd, env: { LOG: log } }) });
  const tools = createTools({ cwd, mode: "bypassPermissions", hooks, approve: async () => false });
  const failed = await tools.execute(call("Bash", { command: "printf owned-failure >&2; exit 7" }), signal());
  assert.equal(failed.is_error, true); assert.match(failed.content, /owned-failure/);
  assert.equal(failed.hookStop, undefined); assert.deepEqual(failed.hookAttachments?.flatMap(item => item.content), ["owned recovery feedback"]);
  const missing = await tools.execute(call("Read", { file_path: "missing" }), signal());
  assert.equal(missing.is_error, true); assert.deepEqual(missing.hookAttachments?.flatMap(item => item.content), ["owned recovery feedback"]);
  const rows = (await readFile(log, "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.deepEqual(rows.map(row => row.tool_name), ["Bash", "Read"]);
  assert.ok(rows.every(row => typeof row.error === "string" && row.is_interrupt === false));
  assert.match(rows[0].error, /owned-failure/);
});

test("registry Stop receives current assistant text and active state while continuation stays in one agent run", async t => {
  const cwd = await directory(t), log = join(cwd, "stop.jsonl"), script = join(cwd, "stop.cjs");
  await writeFile(script, String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const i=JSON.parse(raw);require('node:fs').appendFileSync(process.env.LOG,JSON.stringify(i)+'\n');process.stdout.write(JSON.stringify(i.stop_hook_active?{}:{decision:'block',reason:'Finish the owned stop requirement'}));});`);
  const registry = createHookRegistry([{ source: "userSettings", hooks: { Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] } }]);
  t.after(() => registry.close());
  const hooks = createToolHookRuntime({ registry, context: () => ({ session_id: "owned", transcript_path: join(cwd, "session.json"), cwd }),
    runOptions: () => ({ cwd, projectDir: cwd, env: { LOG: log } }) });
  const f = agentFixture(); f.options.stopHook = hooks.stop!;
  const result = await runAgent(f.options); assert.equal(result.turns, 2);
  const rows = (await readFile(log, "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.deepEqual(rows.map(row => [row.stop_hook_active, row.last_assistant_message]), [[false, "answer 1"], [true, "answer 2"]]);
  assert.equal(f.requests[0]?.attemptBudget, f.requests[1]?.attemptBudget);
});

test("MCP post replacement validates raw output and retains pre/post context in model-visible rich projection", async t => {
  const cwd = await directory(t), script = join(cwd, "mcp-hook.cjs"); let invalid = false;
  await writeFile(script, String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const i=JSON.parse(raw);process.stdout.write(JSON.stringify(i.hook_event_name==='PreToolUse'?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',additionalContext:'pre context'}}:{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'post context',updatedMCPToolOutput:process.env.INVALID==='1'?{content:'invalid'}:{content:[{type:'text',text:'rewritten result'}]}}}));});`);
  const command = { type: "command", command: process.execPath, args: [script] };
  const registry = createHookRegistry([{ source: "userSettings", hooks: { PreToolUse: [{ hooks: [command] }], PostToolUse: [{ hooks: [command] }] } }]);
  t.after(() => registry.close()); const diagnostics: string[] = [];
  const hooks = createToolHookRuntime({ registry, context: () => ({ session_id: "owned", transcript_path: join(cwd, "session.json"), cwd }),
    runOptions: () => ({ cwd, projectDir: cwd, env: { INVALID: invalid ? "1" : "0" } }), onDiagnostic: message => diagnostics.push(message) });
  const name = "mcp__owned__lookup";
  const external: ExternalToolRegistry = { definitions: [{ name, description: "owned", input_schema: { type: "object" } }],
    lookup: input => input === name ? { serverName: "owned", isReadOnly: true, requiresUserInteraction: false } : undefined,
    async callTool() { return { raw: { content: [{ type: "text", text: "original result" }] }, projection: { text: "original result", blocks: [{ type: "text", text: "original result" }] } }; } };
  const tools = routeExternalTools(createTools({ cwd, mode: "default", approve: async () => false }), external,
    { mode: "default", hooks, hookOutputDirectory: join(cwd, "artifacts"), approve: async () => false });
  const result = await tools.execute(call(name, {}), signal());
  assert.match(result.content, /rewritten result/); assert.deepEqual(result.hookAttachments?.flatMap(item => item.content), ["pre context", "post context"]);
  assert.ok(result.apiContent?.some(block => block.type === "text" && block.text === "rewritten result"));
  assert.deepEqual(result.mcpResult, { content: [{ type: "text", text: "original result" }] });
  assert.deepEqual(result.hookRewrittenOutput, { content: [{ type: "text", text: "rewritten result" }] });
  assert.equal(JSON.stringify(projectMessages([{ role: "user", content: [result] }])).includes("hookRewrittenOutput"), false);
  assert.equal(result.apiContent?.filter(block => block.type === "text" && block.text.includes("pre context")).length, 0);
  invalid = true;
  const kept = await tools.execute(call(name, {}), signal());
  assert.match(kept.content, /original result/); assert.deepEqual(kept.hookAttachments?.flatMap(item => item.content), ["pre context", "post context"]);
  assert.equal(diagnostics.length, 1); assert.match(diagnostics[0]!, /invalid hook output rewrite/);
});
