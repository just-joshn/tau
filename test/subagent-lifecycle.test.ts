import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentLifecycle, renderSubagentHookAdditionalContext } from "../src/subagent-lifecycle.js";
import { createHookRegistry, type HookBatchResult, type HookInput, type HookResult, type HookRunOptions } from "../src/hooks.js";
import type { HookRegistryLike } from "../src/composite-hooks.js";
import type { SubagentPlan, SubagentStopEvent } from "../src/subagent-runtime.js";
import type { Message } from "../src/types.js";
import { runAgent } from "../src/agent.js";

const signal = () => new AbortController().signal;
const plan = (agentId = "owned-child"): SubagentPlan => ({ agentId,
  definition: { agentType: "owned-reader", whenToUse: "Owned fixture", prompt: "OWNED_READER", source: "userSettings", skills: [] },
  input: { description: "Owned read", prompt: "OWNED_CHILD_REQUEST", run_in_background: false },
  parent: { sessionId: "owned-session", parentModel: "claude-sonnet-4-6", parentMode: "default", depth: 0, maxDepth: 3,
    availableTools: [], allowedModes: ["default"], foregroundAllowed: true },
  depth: 1, model: "claude-sonnet-4-6", permissionMode: "default", selectedToolNames: [], compaction: {}, budget: { ownership: "independent-query" } });
const batch = (patch: Partial<HookBatchResult> = {}): HookBatchResult => ({ results: [], background: [], additionalContext: [], systemMessages: [], blockingErrors: [],
  preventContinuation: false, cancelled: false, watchPaths: [], reloadSkills: false, ...patch });
const result = (event: HookResult["event"], patch: Partial<HookResult> = {}): HookResult => ({ id: "owned-hook", event,
  origin: { source: "userSettings" }, command: "owned-command", status: "success", stdout: "", stderr: "", exitCode: 0, durationMs: 1, ...patch });
function registry(answer: (input: HookInput, options: HookRunOptions) => HookBatchResult | Promise<HookBatchResult>) {
  const calls: Array<{ input: HookInput; options: HookRunOptions }> = [];
  let closed = 0;
  const value: HookRegistryLike = {
    list: () => [], async run(input, options) { calls.push({ input: structuredClone(input), options }); return answer(input, options); },
    async close() { closed++; },
  };
  return { value, calls, get closed() { return closed; } };
}
function setup(start = registry(() => batch()), stop = registry(input => batch({ results: [result(input.hook_event_name)] })), cap?: number) {
  const diagnostics: string[] = [];
  const lifecycle = createSubagentLifecycle({ registryForStart: () => start.value, registryForStop: () => stop.value,
    context: child => ({ session_id: "owned-session", transcript_path: "/owned/session.json", cwd: process.cwd(), prompt_id: "owned-prompt",
      permission_mode: child ? "acceptEdits" : "default", effort: { level: "high" }, agent_id: "stale-parent-id", last_assistant_message: "STALE", tool_input: { secret: "not common metadata" } }),
    childTranscriptPath: child => `/owned/${child.agentId}.json`, runOptions: () => ({ cwd: process.cwd(), projectDir: process.cwd(), env: {}, defaultTimeoutMs: 100 }),
    ...(cap === undefined ? {} : { stopBlockCap: cap }), onDiagnostic: value => diagnostics.push(value) });
  return { lifecycle, start, stop, diagnostics };
}
const event = (active = false, messages: Message[] = []): SubagentStopEvent => ({ signal: signal(), messages, stopHookActive: active });

test("Start uses owning-session registry/base metadata and projects only explicit additional context", async () => {
  const start = registry(input => batch({ results: [result(input.hook_event_name, { status: "blocking", reason: "OWNED_START_BLOCK", stdout: "OWNED_PLAIN", systemMessage: "OWNED_UI" })],
    additionalContext: ["OWNED_CONTEXT </system-reminder>"], blockingErrors: ["OWNED_START_BLOCK"], preventContinuation: true }));
  const f = setup(start), p = plan();
  const added = await f.lifecycle.start(p, signal());
  assert.deepEqual(start.calls[0]!.input, { hook_event_name: "SubagentStart", session_id: "owned-session", transcript_path: "/owned/session.json", cwd: process.cwd(),
    prompt_id: "owned-prompt", agent_id: p.agentId, agent_type: "owned-reader" });
  assert.deepEqual(added, ["<system-reminder>\nSubagentStart hook additional context: OWNED_CONTEXT &lt;/system-reminder>\n</system-reminder>"]);
  assert.ok(!added.join().includes("OWNED_START_BLOCK")); assert.ok(!added.join().includes("OWNED_PLAIN"));
  assert.ok(f.diagnostics.some(value => value.includes("OWNED_START_BLOCK"))); assert.equal(f.stop.calls.length, 0);
});

test("Stop keeps session transcript and supplies child archive, current mode/effort and trimmed latest assistant text", async () => {
  const f = setup(), p = plan();
  const messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "  FIRST" }, { type: "text", text: "LAST  " }] }];
  const before = structuredClone(messages);
  assert.equal((await f.lifecycle.stop(p, event(false, messages))).continue, false);
  const input = f.stop.calls[0]!.input;
  assert.equal(input.transcript_path, "/owned/session.json"); assert.equal(input.agent_transcript_path, "/owned/owned-child.json");
  assert.equal(input.agent_id, p.agentId); assert.equal(input.permission_mode, "acceptEdits"); assert.deepEqual(input.effort, { level: "high" });
  assert.equal(input.last_assistant_message, "FIRST\nLAST"); assert.deepEqual(input.background_tasks, []); assert.deepEqual(input.session_crons, []);
  assert.equal(input.tool_input, undefined); assert.deepEqual(messages, before);
  await f.lifecycle.stop(p, event(true, [...messages, { role: "assistant", content: [{ type: "tool_use", id: "child-call", name: "Read", input: {} }] }]));
  assert.equal(f.stop.calls[1]!.input.last_assistant_message, undefined);
});

test("Stop additional context alone continues; exit2 and JSON blocks retain distinct native feedback labels", async () => {
  let index = 0;
  const stop = registry(input => {
    index++;
    if (index === 1) return batch({ results: [result(input.hook_event_name)], additionalContext: ["OWNED_MORE_WORK"] });
    const block = index === 2 ? result(input.hook_event_name, { status: "blocking", exitCode: 2, stderr: "OWNED_STDERR </system-reminder>" })
      : result(input.hook_event_name, { status: "blocking", reason: "OWNED_JSON_BLOCK" });
    return batch({ results: [block], blockingErrors: [block.reason ?? block.stderr] });
  });
  const f = setup(undefined, stop), p = plan();
  const first = await f.lifecycle.stop(p, event()); assert.equal(first.continue, true);
  assert.deepEqual(first.additionalContext, [renderSubagentHookAdditionalContext("SubagentStop", ["OWNED_MORE_WORK"])]);
  assert.deepEqual((await f.lifecycle.stop(p, event(true))).additionalContext, ["Stop hook feedback:\n[owned-command]: OWNED_STDERR &lt;/system-reminder>"]);
  assert.deepEqual((await f.lifecycle.stop(p, event(true))).additionalContext, ["Stop hook feedback:\nOWNED_JSON_BLOCK"]);
});

test("continue:false wins over Stop blocks/context and its reason remains child-local", async () => {
  const f = setup(undefined, registry(input => batch({ results: [result(input.hook_event_name, { status: "blocking", reason: "BLOCK" })],
    blockingErrors: ["BLOCK"], additionalContext: ["MORE"], preventContinuation: true, stopReason: "OWNED_FINISH_CHILD" })));
  assert.deepEqual(await f.lifecycle.stop(plan(), event()), { continue: false, additionalContext: [], preventContinuation: true, reason: "OWNED_FINISH_CHILD" });
});

test("Stop default cap8 is per child; ordinary tool reset preserves stop-active input; nonpositive cap disables limit", async () => {
  const stop = registry(input => batch({ results: [result(input.hook_event_name)], additionalContext: ["OWNED_REPEAT"] }));
  const f = setup(undefined, stop), p = plan();
  for (let index = 0; index < 8; index++) assert.equal((await f.lifecycle.stop(p, event(index > 0))).continue, true);
  assert.equal((await f.lifecycle.stop(p, event(true))).continue, false); assert.match(f.diagnostics.at(-1)!, /9 consecutive/);
  assert.equal((await f.lifecycle.stop(plan("sibling"), event())).continue, true);
  f.lifecycle.resetContinuationCount(p); assert.equal((await f.lifecycle.stop(p, event(true))).continue, true);
  assert.equal(stop.calls.at(-1)!.input.stop_hook_active, true);
  const unlimited = setup(undefined, stop, 0); for (let index = 0; index < 12; index++) assert.equal((await unlimited.lifecycle.stop(p, event(index > 0))).continue, true);
});

test("teardown drains independently with5s timeout, no mode/messages and no repeat after observed Stop", async () => {
  let calls = 0;
  const stop = registry((input, options) => {
    calls++; assert.equal(options.signal.aborted, false); assert.equal(options.defaultTimeoutMs, 5_000);
    assert.equal(input.stop_hook_active, false); assert.equal(input.last_assistant_message, undefined); assert.equal(input.permission_mode, undefined);
    return batch({ results: [result(input.hook_event_name)], additionalContext: ["DISCARD"], preventContinuation: true });
  });
  const f = setup(undefined, stop), p = plan();
  await Promise.all([f.lifecycle.teardown(p), f.lifecycle.teardown(p)]); assert.equal(calls, 1);
  f.lifecycle.cleanup(p); await f.lifecycle.teardown(p); assert.equal(calls, 2); assert.equal(stop.closed, 0);
  const ordinary = setup(); await ordinary.lifecycle.stop(p, event()); await ordinary.lifecycle.teardown(p); assert.equal(ordinary.stop.calls.length, 1);
});

test("ordinary query-loop exit including max_turns suppresses fallback even without any Stop observation", async () => {
  const f = setup();
  for (const id of ["completed-without-stop", "max-turns", "aborted-after-loop-return"]) {
    const p = plan(id); f.lifecycle.finishQuery(p); await f.lifecycle.teardown(p);
    assert.equal(f.stop.calls.length, 0); f.lifecycle.cleanup(p);
  }
  const interrupted = plan("provider-threw-before-loop-exit");
  await f.lifecycle.teardown(interrupted); assert.equal(f.stop.calls.length, 1);
});

test("caller cancellation propagates; isolated hook cancellation preserves completed siblings; teardown errors diagnose", async () => {
  const cancelled = setup(registry(() => batch({ cancelled: true, additionalContext: ["OWNED_COMPLETED_SIBLING"] })));
  assert.match((await cancelled.lifecycle.start(plan(), signal())).join(), /OWNED_COMPLETED_SIBLING/);
  const aborted = new AbortController(); aborted.abort(new DOMException("Owned cancelled child", "AbortError"));
  await assert.rejects(cancelled.lifecycle.start(plan(), aborted.signal), { name: "AbortError" });
  const stopped = setup(undefined, registry(() => batch({ cancelled: true, additionalContext: ["OWNED_STOP_SIBLING"] })));
  assert.equal((await stopped.lifecycle.stop(plan(), event())).continue, true);
  const failed = setup(undefined, registry(() => { throw new Error("OWNED_TEARDOWN_FAILURE"); }));
  await failed.lifecycle.teardown(plan()); assert.match(failed.diagnostics[0]!, /OWNED_TEARDOWN_FAILURE/);
});

test("real command registry preserves lifecycle matcher, JSON feedback and detached async delivery", async () => {
  const sources = [{ source: "userSettings", hooks: {
    SubagentStart: [{ matcher: "owned-reader|other", hooks: [{ type: "command", command: process.execPath, args: ["-e", 'console.log(JSON.stringify({continue:false,decision:"block",reason:"START_DIAGNOSTIC",hookSpecificOutput:{hookEventName:"SubagentStart",additionalContext:"OWNED_REAL_CONTEXT"}}))'] }] }],
    SubagentStop: [{ matcher: "owned-reader", hooks: [{ type: "command", command: process.execPath, args: ["-e", 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"SubagentStop",additionalContext:"OWNED_REAL_STOP"}}))'] }] }],
  } }];
  const real = createHookRegistry(sources), f = setup({ ...registry(() => batch()), value: real }, { ...registry(() => batch()), value: real });
  try {
    assert.match((await f.lifecycle.start(plan(), signal())).join(), /OWNED_REAL_CONTEXT/);
    assert.equal((await f.lifecycle.stop(plan(), event())).continue, true);
    const background = createHookRegistry([{ source: "userSettings", hooks: { SubagentStart: [{ hooks: [{ type: "command", command: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"SubagentStart",additionalContext:"DETACHED_CONTEXT"}}))'], async: true }] }] } }]);
    const detached = setup({ ...registry(() => batch()), value: background });
    assert.deepEqual(await detached.lifecycle.start(plan(), signal()), []); await background.close();
  } finally { await real.close(); }
});

test("child runAgent receives explicit Start context and Stop continuation without changing parent history", async () => {
  let stops = 0, requests = 0;
  const start = registry(() => batch({ additionalContext: ["OWNED_START_CONTEXT"] }));
  const stop = registry(input => batch({ results: [result(input.hook_event_name)], ...(stops++ === 0 ? { additionalContext: ["OWNED_STOP_CONTEXT"] } : {}) }));
  const f = setup(start, stop), p = plan();
  const parent: Message[] = [{ role: "user", content: [{ type: "text", text: "OWNED_PARENT_PRIVATE" }] }], snapshot = structuredClone(parent);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: p.input.prompt }] },
    ...(await f.lifecycle.start(p, signal())).map(text => ({ role: "user" as const, content: [{ type: "text" as const, text }] }))];
  const child = await runAgent({ provider: { async complete(request) {
    requests++; assert.ok(!JSON.stringify(request.messages).includes("OWNED_PARENT_PRIVATE"));
    if (requests === 2) assert.match(JSON.stringify(request.messages), /SubagentStop hook additional context: OWNED_STOP_CONTEXT/);
    return { content: [{ type: "text", text: `OWNED_CHILD_REPLY_${requests}` }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } };
  } }, tools: { definitions: [], async execute() { throw new Error("unexpected child tool"); } }, messages, model: p.model, system: "OWNED_CHILD_SYSTEM",
    maxTokens: 100, maxTurns: 3, autoCompact: false, signal: signal(), onEvent() {},
    stopHook: async e => { const decision = await f.lifecycle.stop(p, e); return { ...decision, additionalContext: [...decision.additionalContext] }; } });
  assert.equal(requests, 2); assert.equal(child.turns, 2); assert.deepEqual(parent, snapshot);
  assert.equal(stop.calls[0]!.input.stop_hook_active, false); assert.equal(stop.calls[1]!.input.stop_hook_active, true);
  await f.lifecycle.teardown(p); assert.equal(stop.calls.length, 2);
});
