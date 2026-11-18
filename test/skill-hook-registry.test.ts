import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookRegistry, type HookInput, type HookResult, type HookRunOptions } from "../src/hooks.js";
import { createSkillHookExecutionRegistry, SessionSkillHookRegistry, SKILL_HOOK_COUNT_LIMIT,
  SKILL_HOOK_MATCHER_CHARACTER_LIMIT, type SkillHookRequest } from "../src/skill-hook-registry.js";

const hook = (command = "owned", extra: Record<string, unknown> = {}) => ({ type: "command", command, ...extra });
const hooks = (command = "owned", extra: Record<string, unknown> = {}, matcher = "Read") => ({ PreToolUse: [{ matcher, hooks: [hook(command, extra)] }] });
const request = (extra: Partial<SkillHookRequest> = {}): SkillHookRequest => ({ sessionId: "one", source: "userSettings", skillName: "owned", path: "/owned/SKILL.md", skillRoot: "/owned", hooks: hooks(), ...extra });
const input = (session = "one", tool = "Read"): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, transcript_path: "/owned/transcript.jsonl", cwd: "/owned", tool_name: tool, tool_input: { file_path: "a" }, tool_use_id: "call" });
function success(id: string): HookResult { return { id, event: "PreToolUse", origin: { source: "owned" }, command: "owned", status: "success", stdout: "", stderr: "", exitCode: 0, durationMs: 1 }; }

test("skill hook admission is transactional across policy, guard, schema and unsupported execution", () => {
  for (const [store, change, expected] of [
    [new SessionSkillHookRegistry({ disabled: true }), {}, "disabled"],
    [new SessionSkillHookRegistry({ managedOnly: true }), { source: "policySettings" }, "managed_only"],
    [new SessionSkillHookRegistry({ strictPluginOnly: true }), {}, "policy"],
    [new SessionSkillHookRegistry({ admit: () => ({ refusal: "guard", reason: "guard did not load" }) }), {}, "guard"],
    [new SessionSkillHookRegistry(), { hooks: { PreToolUse: [{ matcher: "Read", hooks: [hook(), { type: "prompt", prompt: "unimplemented" }] }] } }, "invalid"],
    [new SessionSkillHookRegistry(), { hooks: { PermissionRequest: [] } }, "unsupported"],
    [new SessionSkillHookRegistry(), { hooks: hooks("owned", { guard: true }) }, "invalid"],
    [new SessionSkillHookRegistry(), { hooks: hooks("owned", { once: true, async: true }) }, "unsupported"],
  ] as const) {
    const result = store.register(request(change));
    assert.equal(result.registered, false); assert.equal(result.refusal, expected);
    assert.deepEqual(store.snapshot("one").list(), []); assert.deepEqual(store.usage("one", "userSettings"), { hooks: 0, characters: 0 });
  }
  assert.equal(new SessionSkillHookRegistry({ strictPluginOnly: true }).register(request({ source: "policySettings" })).registered, true);
});

test("source lifetime quotas count matcher units and empty groups, cache same declarations and isolate sessions", () => {
  const store = new SessionSkillHookRegistry();
  const emptyGroups = { PreToolUse: Array.from({ length: SKILL_HOOK_COUNT_LIMIT }, () => ({ matcher: "", hooks: [] })) };
  assert.equal(store.register(request({ hooks: emptyGroups })).registered, true);
  assert.deepEqual(store.usage("one", "userSettings"), { hooks: SKILL_HOOK_COUNT_LIMIT, characters: 0 });
  assert.equal(store.register(request({ hooks: emptyGroups })).registered, true, "same declaration is not charged twice");
  assert.equal(store.register(request({ skillName: "new" })).refusal, "count");
  assert.equal(store.snapshot("one").list().length, 0, "quota-only groups do not manufacture commands");
  assert.equal(store.register(request({ sessionId: "two" })).registered, true);
  assert.equal(store.register(request({ source: "projectSettings" })).registered, true);
  const chars = new SessionSkillHookRegistry();
  assert.equal(chars.register(request({ hooks: hooks("owned", {}, "x".repeat(SKILL_HOOK_MATCHER_CHARACTER_LIMIT)) })).registered, true);
  assert.equal(chars.register(request({ skillName: "more", hooks: hooks("different") })).refusal, "characters");
  assert.equal(chars.register(request({ sourceKey: "repository:two", hooks: hooks() })).registered, true);
});

test("failed matcher admission is cached without partial registrations or quota consumption", () => {
  let checks = 0;
  const store = new SessionSkillHookRegistry({ testsSkillMatchers: () => { checks++; return false; } });
  const proposed = request({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [hook("first"), hook("second")] }] } });
  assert.equal(store.register(proposed).refusal, "matcher"); assert.equal(store.register(proposed).refusal, "matcher");
  assert.equal(checks, 1); assert.deepEqual(store.snapshot("one").list(), []);
  assert.deepEqual(store.usage("one", "userSettings"), { hooks: 0, characters: 0 });
});

test("duplicate command updates keep order, stable IDs and the initial success callback", () => {
  const store = new SessionSkillHookRegistry();
  const first = store.register(request({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [hook("a", { once: true, timeout: 1 }), hook("b")] }] } }));
  const again = store.register(request({ hooks: hooks("a", { once: false, timeout: 2 }) }));
  assert.equal(again.registrationIds[0], first.registrationIds[0]);
  const snapshot = store.snapshot("one"), listed = snapshot.list();
  assert.deepEqual(listed.map(entry => entry.hook.command), ["a", "b"]);
  assert.equal(listed[0]?.hook.timeout, 2); assert.equal(listed[0]?.hook.once, false);
  snapshot.observe(input(), success(listed[0].id));
  assert.deepEqual(store.snapshot("one").list().map(entry => entry.hook.command), ["b"], "replacement retained the initial once-success callback");
  const plain = store.register(request({ hooks: hooks("c") }));
  store.register(request({ hooks: hooks("c", { once: true }) }));
  const next = store.snapshot("one"); next.observe(input(), success(plain.registrationIds[0]!));
  assert.equal(store.snapshot("one").list().some(entry => entry.hook.command === "c"), true, "replacement does not add a callback to an existing ordinary entry");
});

test("one-shot success uses source getEntry lookup and removal spans same-root matchers only", () => {
  const store = new SessionSkillHookRegistry();
  store.register(request({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [hook("owned", { once: true })] }, { matcher: "Read|Write", hooks: [hook("owned", { once: true })] }], Stop: [{ hooks: [hook("owned", { once: true })] }] } }));
  store.register(request({ skillRoot: "/other", path: "/other/SKILL.md", hooks: hooks("owned", { once: true }) }));
  const snapshot = store.snapshot("one"); snapshot.observe(input(), success(snapshot.list()[0]!.id));
  assert.equal(store.snapshot("one").list().filter(entry => entry.event === "PreToolUse").length, 1);
  assert.equal(store.snapshot("one").list().some(entry => entry.event === "Stop"), true);
  const regex = new SessionSkillHookRegistry(); regex.register(request({ hooks: hooks("owned", { once: true }, "^Read$") }));
  const regexSnapshot = regex.snapshot("one"); regexSnapshot.observe(input(), success(regexSnapshot.list()[0]!.id));
  assert.equal(regex.snapshot("one").list().length, 1, "the source callback lookup does not equate regex matching with literal matcher equality");
});

test("root removal preserves quota draws and clear resets exactly the selected session", () => {
  const store = new SessionSkillHookRegistry(); store.register(request()); store.register(request({ sessionId: "two" }));
  assert.equal(store.removeRoots(new Set(["/owned"])), 2);
  assert.equal(store.usage("one", "userSettings").hooks, 1); assert.equal(store.usage("two", "userSettings").hooks, 1);
  store.clear("one"); assert.equal(store.usage("one", "userSettings").hooks, 0); assert.equal(store.usage("two", "userSettings").hooks, 1);
});

async function execution(t: any) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-skill-hook-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "hook.mjs"), state = join(cwd, "state"), log = join(cwd, "log.jsonl");
  await writeFile(file, `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';let text='';for await(const part of process.stdin)text+=part;appendFileSync(process.argv[2],JSON.stringify({input:JSON.parse(text),root:process.env.CLAUDE_PLUGIN_ROOT,data:process.env.CLAUDE_PLUGIN_DATA,skillDir:process.env.CLAUDE_SKILL_DIR,args:process.argv.slice(5)})+'\\n');if(!existsSync(process.argv[3])){writeFileSync(process.argv[3],'failed once');process.stderr.write('owned first failure');process.exitCode=3}else process.stdout.write('owned success');`);
  const owned = { type: "command", command: process.execPath, args: [file, log, state, "unused", "${CLAUDE_PLUGIN_ROOT}"], once: true };
  const store = new SessionSkillHookRegistry();
  const admitted = store.register(request({ path: join(cwd, "SKILL.md"), skillRoot: cwd, hooks: { PreToolUse: [{ matcher: "Read", hooks: [owned] }] } }));
  const registry = createSkillHookExecutionRegistry(store, "one"); t.after(() => registry.close());
  const options: HookRunOptions = { cwd, projectDir: cwd, env: {}, signal: new AbortController().signal, defaultTimeoutMs: 3000 };
  return { cwd, log, store, registry, options, admitted };
}

test("dynamic skill executor keeps one-shot hook through failure, removes on success and exports only skill root origin", async t => {
  const f = await execution(t), id = f.admitted.registrationIds[0]!;
  assert.equal(f.registry.list()[0]?.hook.once, true, "listing retains the declared one-shot metadata");
  assert.equal((await f.registry.run(input(), f.options)).results[0]?.status, "error");
  assert.equal(f.registry.list()[0]?.id, id);
  const successful = await f.registry.run(input(), f.options);
  assert.equal(successful.results[0]?.status, "success"); assert.equal(successful.results[0]?.id, id);
  assert.equal(f.registry.list().length, 0); assert.equal((await f.registry.run(input(), f.options)).results.length, 0);
  const rows = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 2); assert.equal(rows[0].root, f.cwd); assert.deepEqual(rows[0].args, [f.cwd]);
  assert.equal(rows[0].data, undefined); assert.equal(rows[0].skillDir, undefined);
});

test("static registry once state survives separate dynamic skill snapshots", async t => {
  const f = await execution(t);
  const base = createHookRegistry([{ source: "userSettings", hooks: { PreToolUse: [{ hooks: [hook(process.execPath, { args: ["-e", "process.stdout.write('base')"], once: true })] }] } }]);
  t.after(() => base.close());
  assert.equal((await base.run(input(), f.options)).results.length, 1);
  await f.registry.run(input(), f.options); await f.registry.run(input(), f.options);
  assert.equal((await base.run(input(), f.options)).results.length, 0);
  await assert.rejects(f.registry.run(input("other"), f.options), /different session/);
  await f.registry.close(); await assert.rejects(f.registry.run(input(), f.options), /closed/);
});

test("child dynamic hooks select a child scope while retaining the owning session payload", async t => {
  const f = await execution(t);
  f.store.register(request({ sessionId: "child", skillName: "owned-child", path: join(f.cwd, "child.md"), hooks: {
    PreToolUse: [{ matcher: "Write", hooks: [hook(process.execPath, { args: ["-e", "process.stdout.write('child only')"], once: true })] }],
  } }));
  const registry = createSkillHookExecutionRegistry(f.store, "child", { ownerSessionId: "one" }); t.after(() => registry.close());
  const first = await registry.run(input("one", "Write"), f.options);
  assert.equal(first.results.length, 1); assert.equal(first.results[0]!.stdout, "child only");
  assert.equal(f.store.snapshot("child").list().length, 0); assert.equal(f.store.snapshot("one").list().length, 1);
  await assert.rejects(registry.run(input("child"), f.options), /different session/);
});

test("closing active skill hooks cancels execution without consuming the success callback", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-skill-hook-cancel-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new SessionSkillHookRegistry(), registry = createSkillHookExecutionRegistry(store, "one");
  t.after(() => registry.close());
  assert.equal(registry.list().length, 0);
  const admitted = store.register(request({ hooks: hooks(process.execPath, { args: ["-e", "setInterval(()=>{},1000)"], once: true }) }));
  assert.equal(registry.list()[0]?.id, admitted.registrationIds[0], "execution side observes newly registered hooks");
  const pending = registry.run(input(), { cwd, projectDir: cwd, env: {}, signal: new AbortController().signal, defaultTimeoutMs: 3000 });
  const closing = registry.close();
  const batch = await pending; await closing;
  assert.equal(batch.cancelled, true); assert.equal(batch.results[0]?.status, "cancelled");
  assert.equal(store.snapshot("one").list()[0]?.id, admitted.registrationIds[0]);
});
