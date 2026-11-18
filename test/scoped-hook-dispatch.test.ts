import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHookRegistry,
  type CommandHook,
  type HookInput,
  type HookRunOptions,
} from "../src/hooks.js";
import { createAgentDefinitionHookScope } from "../src/agent-definition-hooks.js";
import {
  createSkillHookExecutionRegistry,
  SessionSkillHookRegistry,
} from "../src/skill-hook-registry.js";
import {
  createReducedScopedHookRegistry,
  nativeCommandHookReductionKey,
  ordinaryDirectAgentDefinitionHookProvenance,
  reduceMatchedOrdinaryCommandHooks,
  type ScopedHookSelectionBackend,
} from "../src/scoped-hook-dispatch.js";

const signal = () => new AbortController().signal;
const input = (patch: Partial<HookInput> = {}): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "owner",
  transcript_path: "/owned/transcript.jsonl",
  cwd: "/owned",
  agent_id: "child",
  agent_type: "owned-agent",
  tool_name: "Read",
  tool_use_id: "owned-read",
  tool_input: { file_path: "/owned/file" },
  ...patch,
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tau-owned-hook-dispatch-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, "log.jsonl"),
    run: HookRunOptions = {
      cwd,
      projectDir: cwd,
      env: {},
      signal: signal(),
      defaultTimeoutMs: 3000,
    };
  const command: CommandHook = {
    type: "command",
    command: process.execPath,
    args: [
      "-e",
      `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(log)},"OWNED EXECUTION\\n");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"OWNED CONTEXT"}}))`,
    ],
  };
  return { cwd, log, run, command };
}
const hooks = (command: CommandHook) => ({
  PreToolUse: [{ matcher: "Read", hooks: [command] }],
});
function child(command: CommandHook) {
  const scope = createAgentDefinitionHookScope({
    agentId: "child",
    ownerSessionId: "owner",
    definition: {
      agentType: "owned-agent",
      source: "userSettings",
      prompt: "OWNED",
      whenToUse: "Owned",
      skills: [],
      hooks: hooks(command),
    },
    policy: () => ({
      disabled: false,
      managedOnly: false,
      strictPluginOnly: false,
    }),
    admitDefinition: () => true,
    admitOrigin: () => true,
    provenance: () => ({ personal: false, checkout: false }),
    admitExecution: () => true,
  });
  onTestFinished(() => scope.close());
  return scope;
}
function reduced(backends: ScopedHookSelectionBackend[]) {
  const registry = createReducedScopedHookRegistry({
    ownerSessionId: "owner",
    defaultShell: "bash",
    personalConfigRestricted: false,
    backends: () => backends,
  });
  onTestFinished(() => registry.close());
  return registry;
}
async function lines(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n");
}

test("native reduction uses real origin namespace and last winner at original key position", () => {
  assert.deepEqual(
    ordinaryDirectAgentDefinitionHookProvenance({
      personalConfigRestricted: false,
    }),
    { personal: false, checkout: false, nativeOrigin: { namespace: "hook" } },
  );
  assert.throws(
    () =>
      ordinaryDirectAgentDefinitionHookProvenance({
        personalConfigRestricted: true,
      }),
    /host adapter/,
  );
  const command: CommandHook = { type: "command", command: "owned" };
  const candidates = [
    {
      backendId: "base",
      id: "one",
      hook: command,
      nativeOrigin: { namespace: "hook" },
    },
    {
      backendId: "base",
      id: "two",
      hook: { ...command, command: "another" },
      nativeOrigin: { namespace: "hook" },
    },
    {
      backendId: "child",
      id: "three",
      hook: { ...command, timeout: 2 },
      nativeOrigin: { namespace: "hook" },
    },
  ] satisfies Parameters<typeof reduceMatchedOrdinaryCommandHooks>[0];
  assert.deepEqual(
    reduceMatchedOrdinaryCommandHooks(candidates, {
      defaultShell: "bash",
      personalConfigRestricted: false,
    }).map((entry) => entry.id),
    ["three", "two"],
  );
  const a = candidates[0];
  assert.ok(a);
  assert.throws(
    () =>
      reduceMatchedOrdinaryCommandHooks(
        [{ ...a, nativeOrigin: { namespace: "goal" } }],
        { defaultShell: "bash", personalConfigRestricted: false },
      ),
    /Goal hook arbitration/,
  );
  assert.notEqual(
    nativeCommandHookReductionKey(a, "bash"),
    nativeCommandHookReductionKey(
      { ...a, hook: { ...command, args: [] } },
      "bash",
    ),
  );
  assert.equal(
    nativeCommandHookReductionKey(a, "bash"),
    nativeCommandHookReductionKey(
      { ...a, hook: { ...command, shell: "bash" } },
      "bash",
    ),
  );
  assert.notEqual(
    nativeCommandHookReductionKey(a, "bash"),
    nativeCommandHookReductionKey(
      {
        ...a,
        nativeOrigin: { namespace: "hook", pluginRoot: "/owned/plugin" },
      },
      "bash",
    ),
  );
  assert.throws(
    () =>
      reduceMatchedOrdinaryCommandHooks(candidates, {
        defaultShell: "bash",
        personalConfigRestricted: true,
      }),
    /provenance adapter/,
  );
});

test("actual settings and definition identical command runs once; overwritten persistent once is never burned", async () => {
  const f = await fixture(),
    base = createHookRegistry([
      { source: "userSettings", hooks: hooks({ ...f.command, once: true }) },
    ]),
    scope = child({ ...f.command, once: true, timeout: 2 });
  onTestFinished(() => base.close());
  await scope.afterStart(signal());
  const registry = reduced([
    {
      id: "settings",
      registry: base,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
    {
      id: "definition",
      registry: scope.registry,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
  ]);
  const batch = await registry.run(input(), f.run);
  assert.equal(batch.results.length, 1);
  assert.match(batch.results[0]?.id ?? "", /definition/);
  assert.equal((await lines(f.log)).length, 1);
  scope.cleanup();
  assert.equal((await registry.run(input(), f.run)).results.length, 1);
  assert.equal((await lines(f.log)).length, 2);
  assert.equal((await registry.run(input(), f.run)).results.length, 0);
  assert.equal((await lines(f.log)).length, 2);
});

test("global origin.source is not invented native settingsSource; distinct plugin roots keep both commands", async () => {
  const f = await fixture(),
    base = createHookRegistry([
      { source: "userSettings", hooks: hooks(f.command) },
      { source: "projectSettings", hooks: hooks(f.command) },
    ]);
  onTestFinished(() => base.close());
  const ordinary = reduced([
    { id: "base", registry: base, nativeOrigin: () => ({ namespace: "hook" }) },
  ]);
  assert.equal((await ordinary.run(input(), f.run)).results.length, 1);
  assert.equal((await lines(f.log)).length, 1);
  const plugins = createHookRegistry([
    { source: "plugin-one", pluginRoot: "/owned/one", hooks: hooks(f.command) },
    { source: "plugin-two", pluginRoot: "/owned/two", hooks: hooks(f.command) },
  ]);
  onTestFinished(() => plugins.close());
  const separate = reduced([
    {
      id: "plugins",
      registry: plugins,
      nativeOrigin: (entry) => ({
        namespace: "hook",
        ...(entry.origin.pluginRoot === undefined
          ? {}
          : { pluginRoot: entry.origin.pluginRoot }),
      }),
    },
  ]);
  assert.equal((await separate.run(input(), f.run)).results.length, 2);
  assert.equal((await lines(f.log)).length, 3);
});

test("core prepare is immutable, nonmutating and only selected IDs consume persistent state", async () => {
  const f = await fixture(),
    registry = createHookRegistry([
      { source: "userSettings", hooks: hooks({ ...f.command, once: true }) },
    ]);
  onTestFinished(() => registry.close());
  const request = input();
  const prepared = await registry.prepareDispatch(request, f.run);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(Object.isFrozen(prepared.candidates[0]?.hook), true);
  request.tool_name = "Write";
  request.tool_input = { changed: true };
  assert.equal((await prepared.runSelected(new Set())).results.length, 0);
  const id = prepared.candidates[0]?.id;
  assert.ok(id);
  assert.equal((await prepared.runSelected(new Set([id]))).results.length, 1);
  await assert.rejects(prepared.runSelected(new Set([id])), /consumed/);
  await prepared.close();
  assert.equal((await registry.run(input(), f.run)).results.length, 0);
});

test("Skill prepared snapshot preserves IDs and old executable when store clears/reorders before run", async () => {
  const f = await fixture(),
    store = new SessionSkillHookRegistry();
  const original = store.register({
    sessionId: "owner",
    skillName: "owned",
    source: "userSettings",
    path: "/owned/SKILL.md",
    hooks: hooks({ ...f.command, once: true }),
  });
  assert.equal(original.registered, true);
  const registry = createSkillHookExecutionRegistry(store, "owner");
  onTestFinished(() => registry.close());
  const prepared = await registry.prepareDispatch(input(), f.run),
    id = prepared.candidates[0]?.id;
  assert.equal(id, original.registrationIds[0]);
  assert.ok(id);
  store.clear("owner");
  const replacement = store.register({
    sessionId: "owner",
    skillName: "replacement",
    source: "userSettings",
    path: "/owned/new/SKILL.md",
    hooks: hooks({ ...f.command, command: "SHOULD_NOT_EXECUTE" }),
  });
  assert.equal(replacement.registered, true);
  const batch = await prepared.runSelected(new Set([id]));
  assert.equal(batch.results[0]?.status, "success");
  assert.equal(batch.results[0]?.id, id);
  assert.equal((await lines(f.log)).length, 1);
  assert.equal(
    store.snapshot("owner").list()[0]?.hook.command,
    "SHOULD_NOT_EXECUTE",
  );
  await prepared.close();
});

test("actual child Skill owner-key effects stay out of child dispatch and survive child definition cleanup", async () => {
  const f = await fixture(),
    store = new SessionSkillHookRegistry(),
    scope = child({
      ...f.command,
      args: [...(f.command.args ?? []), "DEFINITION"],
    });
  await scope.afterStart(signal());
  store.register({
    sessionId: "owner",
    skillName: "inline-child",
    source: "userSettings",
    path: "/owned/SKILL.md",
    hooks: hooks(f.command),
  });
  const childSkills = createSkillHookExecutionRegistry(store, "child", {
      ownerSessionId: "owner",
    }),
    rootSkills = createSkillHookExecutionRegistry(store, "owner");
  onTestFinished(() => childSkills.close());
  onTestFinished(() => rootSkills.close());
  const childRegistry = reduced([
    {
      id: "child-skills",
      registry: childSkills,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
    {
      id: "definition",
      registry: scope.registry,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
  ]);
  assert.equal((await childRegistry.run(input(), f.run)).results.length, 1);
  assert.equal(store.snapshot("owner").list().length, 1);
  scope.cleanup();
  assert.equal((await childRegistry.run(input(), f.run)).results.length, 0);
  assert.equal(
    (await rootSkills.run(input({ agent_id: undefined }), f.run)).results
      .length,
    1,
  );
  assert.equal((await lines(f.log)).length, 2);
});

test("overwritten Skill once callback remains registered until an actual selected success", async () => {
  const f = await fixture(),
    store = new SessionSkillHookRegistry();
  store.register({
    sessionId: "owner",
    skillName: "owned",
    source: "userSettings",
    path: "/owned/SKILL.md",
    hooks: hooks({ ...f.command, once: true }),
  });
  const skills = createSkillHookExecutionRegistry(store, "owner"),
    scope = child(f.command);
  onTestFinished(() => skills.close());
  await scope.afterStart(signal());
  const registry = reduced([
    {
      id: "skills",
      registry: skills,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
    {
      id: "def",
      registry: scope.registry,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
  ]);
  assert.equal((await registry.run(input(), f.run)).results.length, 1);
  assert.equal(store.snapshot("owner").list().length, 1);
  scope.cleanup();
  assert.equal((await registry.run(input(), f.run)).results.length, 1);
  assert.equal(store.snapshot("owner").list().length, 0);
});

test("prepared Skill callback lookup uses current native entry identity after replacement", async () => {
  const f = await fixture(),
    store = new SessionSkillHookRegistry(),
    request = {
      sessionId: "owner",
      skillName: "owned",
      source: "userSettings",
      path: "/owned/SKILL.md",
      hooks: hooks(f.command),
    };
  store.register(request);
  const registry = createSkillHookExecutionRegistry(store, "owner");
  onTestFinished(() => registry.close());
  const prepared = await registry.prepareDispatch(input(), f.run),
    id = prepared.candidates[0]?.id;
  assert.ok(id);
  store.clear("owner");
  store.register({ ...request, hooks: hooks({ ...f.command, once: true }) });
  await prepared.runSelected(new Set([id]));
  await prepared.close();
  assert.equal(store.snapshot("owner").list().length, 0);
});

test("prepared dynamic async execution retains settlement after dispatcher snapshot retirement", async () => {
  const f = await fixture(),
    done = join(f.cwd, "async-done"),
    store = new SessionSkillHookRegistry();
  store.register({
    sessionId: "owner",
    skillName: "owned",
    source: "userSettings",
    path: "/owned/SKILL.md",
    hooks: hooks({
      ...f.command,
      args: [
        "-e",
        `setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(done)},"OWNED DONE");process.stdout.write("{}");},30)`,
      ],
      async: true,
    }),
  });
  const skills = createSkillHookExecutionRegistry(store, "owner");
  onTestFinished(() => skills.close());
  const registry = reduced([
    {
      id: "skills",
      registry: skills,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
  ]);
  const batch = await registry.run(input(), f.run);
  assert.equal(batch.background.length, 1);
  assert.equal((await batch.background[0]?.completion)?.status, "success");
  assert.equal(await readFile(done, "utf8"), "OWNED DONE");
});

test("closing reduced dispatcher retires selection but never closes borrowed registries", async () => {
  const f = await fixture(),
    base = createHookRegistry([
      { source: "userSettings", hooks: hooks(f.command) },
    ]);
  onTestFinished(() => base.close());
  const registry = reduced([
    { id: "base", registry: base, nativeOrigin: () => ({ namespace: "hook" }) },
  ]);
  const prepared = await registry.prepareDispatch?.(input(), f.run);
  assert.ok(prepared);
  await registry.close();
  await assert.rejects(
    prepared.runSelected(new Set(prepared.candidates.map((entry) => entry.id))),
    /retired/,
  );
  assert.equal((await base.run(input(), f.run)).results.length, 1);
});

test("cross-backend output follows native first-key position even when the later child wins", async () => {
  const f = await fixture(),
    another = { ...f.command, args: [...(f.command.args ?? []), "OTHER"] };
  const base = createHookRegistry([
      {
        source: "userSettings",
        hooks: {
          PreToolUse: [{ matcher: "Read", hooks: [f.command, another] }],
        },
      },
    ]),
    scope = child(f.command);
  onTestFinished(() => base.close());
  await scope.afterStart(signal());
  const registry = reduced([
    { id: "base", registry: base, nativeOrigin: () => ({ namespace: "hook" }) },
    {
      id: "child",
      registry: scope.registry,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
  ]);
  const batch = await registry.run(input(), f.run);
  assert.equal(batch.results.length, 2);
  assert.match(batch.results[0]?.id ?? "", /child/);
  assert.match(batch.results[1]?.id ?? "", /base/);
});

test("prepared child admission is checked again before executing a selected command", async () => {
  const f = await fixture();
  let admitted = true;
  const scope = createAgentDefinitionHookScope({
    agentId: "child",
    ownerSessionId: "owner",
    definition: {
      agentType: "owned-agent",
      source: "userSettings",
      prompt: "OWNED",
      whenToUse: "Owned",
      skills: [],
      hooks: hooks(f.command),
    },
    policy: () => ({
      disabled: false,
      managedOnly: false,
      strictPluginOnly: false,
    }),
    admitDefinition: () => true,
    admitOrigin: () => true,
    provenance: () => ({ personal: false, checkout: false }),
    admitExecution: () => admitted,
  });
  onTestFinished(() => scope.close());
  await scope.afterStart(signal());
  const registry = reduced([
    {
      id: "child",
      registry: scope.registry,
      nativeOrigin: () => ({ namespace: "hook" }),
    },
  ]);
  const prepared = await registry.prepareDispatch?.(input(), f.run);
  assert.ok(prepared);
  assert.equal(prepared.candidates.length, 1);
  admitted = false;
  assert.equal(
    (
      await prepared.runSelected(
        new Set(prepared.candidates.map((entry) => entry.id)),
      )
    ).results.length,
    0,
  );
  await prepared.close();
  await assert.rejects(readFile(f.log));
  admitted = true;
  assert.equal((await registry.run(input(), f.run)).results.length, 1);
});

test("failure during origin reduction retires all prepared leases without closing borrowed owners", async () => {
  const f = await fixture(),
    base = createHookRegistry([
      { source: "userSettings", hooks: hooks(f.command) },
    ]);
  onTestFinished(() => base.close());
  let retired = 0;
  const wrapped = {
    list: base.list.bind(base),
    run: base.run.bind(base),
    close: async () => {
      throw new Error("Borrowed owner must not close");
    },
    async prepareDispatch(call: HookInput, options: HookRunOptions) {
      const prepared = await base.prepareDispatch(call, options);
      return {
        ...prepared,
        close: async () => {
          retired++;
          await prepared.close();
        },
      };
    },
  };
  const registry = reduced([
    {
      id: "base",
      registry: wrapped,
      nativeOrigin: () => {
        throw new Error("Owned unsupported provenance");
      },
    },
  ]);
  await assert.rejects(registry.run(input(), f.run), /unsupported provenance/);
  assert.equal(retired, 1);
  assert.equal((await base.run(input(), f.run)).results.length, 1);
});

test("explicit owned teardown is deduplicated by registry identity and remains idempotent", async () => {
  const f = await fixture(),
    base = createHookRegistry([
      { source: "userSettings", hooks: hooks(f.command) },
    ]);
  let closes = 0;
  const registry = createReducedScopedHookRegistry({
    ownerSessionId: "owner",
    defaultShell: "bash",
    personalConfigRestricted: false,
    backends: () => [
      {
        id: "owned",
        registry: base,
        nativeOrigin: () => ({ namespace: "hook" }),
        closeOwned: async () => {
          closes++;
          await base.close();
        },
      },
    ],
  });
  registry.list();
  await registry.run(input(), f.run);
  registry.list();
  await registry.close();
  await registry.close();
  assert.equal(closes, 1);
  assert.equal((await base.run(input(), f.run)).cancelled, true);
});
