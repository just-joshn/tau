import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChildCapabilityTools,
  preloadDeclaredChildSkills,
  type ChildCapabilityToolsOptions,
} from "../src/child-capability-tools.js";
import { createSessionSkillHost } from "../src/skill-session.js";
import {
  createLocalSkillRegistry,
  type LocalSkill,
  type SkillSource,
} from "../src/skills.js";
import { createLocalTaskStore } from "../src/task-store.js";
import { createTaskRuntime } from "../src/task-runtime.js";
import { loadLaunchConfiguration } from "../src/launch-configuration.js";
import { parseOptions } from "../src/options.js";
import { parseToolPolicy, type ToolPolicy } from "../src/tool-policy.js";
import { createTools } from "../src/tools.js";
import { runAgent } from "../src/agent.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";
import type {
  CompletionRequest,
  Message,
  Provider,
  ToolUse,
  ToolExecutor,
} from "../src/types.js";
const signal = () => new AbortController().signal;
const call = (name: string, input: unknown, id = "owned-call"): ToolUse => ({
  type: "tool_use",
  id,
  name,
  input,
});
const pre = () => ({
  additionalContext: [] as string[],
  preventContinuation: false,
});
const hooks: ToolHookRuntime = {
  async before() {
    return pre();
  },
  async after(_call, result) {
    return result;
  },
};
const allNames = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "EnterPlanMode",
  "ExitPlanMode",
];
async function fixture(t: TestContext) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-child-capability-")),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const user = join(cwd, "config"),
    managed = join(cwd, "managed");
  await mkdir(user);
  await mkdir(managed);
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed };
  const launch = await loadLaunchConfiguration(parseOptions([]), {
    cwd,
    env,
    homeDirectory: cwd,
    nonInteractive: true,
  });
  const skill = async (name: string, body: string) => {
    const dir = join(cwd, ".claude", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), body);
  };
  const registry = () =>
    createLocalSkillRegistry({
      cwd,
      projectDirectories: [cwd],
      sources: { user: false, project: true },
      validateHooks: (value) => value,
    });
  let policy = parseToolPolicy({
      tools: allNames.join(","),
      allowedTools: ["Skill"],
    }),
    approvals = 0;
  const store = createLocalTaskStore({
    root: join(cwd, "tasks"),
    listId: "parent-session-list",
  });
  const lifecycle: {
    event: string;
    sessionId: string;
    actor: string | undefined;
    listId: string;
  }[] = [];
  const make = async (options: Partial<ChildCapabilityToolsOptions> = {}) =>
    createChildCapabilityTools({
      cwd,
      launch,
      agentId: "owned-child",
      agentType: "owned:reader",
      isAsync: false,
      sessionId: () => "parent-session",
      selectedToolNames: allNames,
      policy: () => policy,
      mode: () => "default",
      model: () => "claude-sonnet-4-6",
      effort: () => "medium",
      hooks,
      interactive: false,
      approve: async () => {
        approvals++;
        return false;
      },
      registry: await registry(),
      env,
      signal: signal(),
      tasks: {
        store,
        enabled: () => true,
        lifecycle: {
          async created(context) {
            lifecycle.push({
              event: "created",
              sessionId: context.context.sessionId,
              actor: context.context.actor,
              listId: context.listId,
            });
          },
          async completed(context) {
            lifecycle.push({
              event: "completed",
              sessionId: context.context.sessionId,
              actor: context.context.actor,
              listId: context.listId,
            });
          },
        },
      },
      ...options,
    });
  return {
    cwd,
    launch,
    env,
    skill,
    registry,
    make,
    store,
    lifecycle,
    approvals: () => approvals,
    getPolicy: () => policy,
    setPolicy: (next: ToolPolicy) => {
      policy = next;
    },
  };
}

test("real child Skill grants affect scoped file tools; primary model stays fixed while context model/effort advance", async (t) => {
  const f = await fixture(t);
  await f.skill(
    "prepare",
    "---\ndescription: Owned prepare\nallowed-tools: Write\nmodel: haiku\neffort: high\n---\nOWNED_CHILD_SKILL",
  );
  const child = await f.make(),
    messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Owned child task" }] },
    ],
    requests: CompletionRequest[] = [];
  const tools = child.tools.wrap(
    () =>
      createTools({
        cwd: f.cwd,
        mode: "default",
        policy: child.policy(),
        approve: async () => false,
      }),
    messages,
  );
  const provider: Provider = {
    async complete(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
      });
      const round = requests.length;
      return {
        content:
          round === 1
            ? [call("Skill", { skill: "prepare" }, "skill")]
            : round === 2
              ? [
                  call(
                    "Write",
                    { file_path: "owned.txt", content: "owned" },
                    "write",
                  ),
                ]
              : [{ type: "text", text: "done" }],
        stop_reason: round < 3 ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  await runAgent({
    provider,
    tools,
    messages,
    model: child.primaryModel,
    queryEffort: child.queryEffort,
    system: "Owned system",
    maxTokens: 100,
    maxTurns: 4,
    autoCompact: false,
    signal: signal(),
    onEvent() {},
  });
  assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "owned");
  assert.deepEqual(
    requests.map((request) => request.model),
    ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"],
  );
  assert.deepEqual(
    requests.map((request) => request.queryEffort),
    ["medium", "high", "high"],
  );
  assert.equal(child.contextModel(), "haiku");
  assert.equal(child.primaryModel, "claude-sonnet-4-6");
  const second = requests[1]!.messages,
    result = second.findIndex((message) =>
      message.content.some(
        (block) =>
          block.type === "tool_result" && block.tool_use_id === "skill",
      ),
    );
  const body = second.findIndex((message) =>
    message.content.some(
      (block) =>
        block.type === "text" && block.text.includes("OWNED_CHILD_SKILL"),
    ),
  );
  assert.ok(body > result);
  assert.equal(f.approvals(), 0);
});
test("live parent deny/ask and narrowed declared pool remain floors after a child Skill grant", async (t) => {
  const f = await fixture(t);
  await f.skill("grant", "---\nallowed-tools: Write\n---\nOwned grant");
  const child = await f.make(),
    messages: Message[] = [],
    tools = child.wrap(
      () =>
        createTools({
          cwd: f.cwd,
          mode: "default",
          policy: child.policy(),
          approve: async () => false,
        }),
      messages,
    );
  assert.equal(
    (await tools.execute(call("Skill", { skill: "grant" }), signal())).is_error,
    undefined,
  );
  f.setPolicy({ ...f.getPolicy(), disallowedTools: ["Write"] });
  assert.equal(
    (
      await tools.execute(
        call("Write", { file_path: "denied", content: "no" }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  f.setPolicy({ ...f.getPolicy(), disallowedTools: [], askedTools: ["Write"] });
  assert.equal(
    (
      await tools.execute(
        call("Write", { file_path: "asked", content: "no" }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  const narrow = await f.make({ selectedToolNames: ["Skill", "Read"] });
  const scoped = narrow.wrap(
    () =>
      createTools({
        cwd: f.cwd,
        mode: "default",
        policy: narrow.policy(),
        approve: async () => false,
      }),
    [],
  );
  await scoped.execute(call("Skill", { skill: "grant" }), signal());
  assert.equal(
    (
      await scoped.execute(
        call("Write", { file_path: "unselected", content: "no" }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  for (const name of ["denied", "asked", "unselected"])
    await assert.rejects(readFile(join(f.cwd, name)), { code: "ENOENT" });
});
test("live Skill policy changes are read after hook rewrites and cannot apply withheld effects", async (t) => {
  const f = await fixture(t);
  await f.skill("safe", "Owned safe");
  await f.skill("grant", "---\nallowed-tools: Write\n---\nOwned grant");
  const child = await f.make({
    hooks: {
      async before() {
        f.setPolicy({ ...f.getPolicy(), disallowedTools: ["Skill(grant)"] });
        return {
          ...pre(),
          permission: "allow",
          updatedInput: { skill: "grant" },
        };
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  const tools = child.wrap(
    {
      definitions: [],
      async execute() {
        throw Error("unrelated");
      },
    },
    [],
  );
  const result = await tools.execute(
    call("Skill", { skill: "safe" }),
    signal(),
  );
  assert.equal(result.permissionDenied, true);
  assert.equal(child.policy().allowedTools.includes("Write"), false);
});
test("foreground CRUD shares parent store/list and child lifecycle identity without creator ownership locks", async (t) => {
  const f = await fixture(t),
    child = await f.make(),
    tools = child.wrap(
      {
        definitions: [],
        async execute() {
          throw Error("unrelated");
        },
      },
      [],
    );
  const parent = createTaskRuntime({
    store: f.store,
    context: () => ({ sessionId: "parent-session", mode: "local" }),
    authorize: () => true,
  });
  const created = await tools.execute(
    call("TaskCreate", {
      subject: "Owned child task",
      description: "Shared list",
    }),
    signal(),
  );
  assert.equal(created.is_error, undefined);
  const rows = await f.store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.owner, undefined);
  assert.match(
    (await parent.execute(call("TaskList", {}), signal())).content,
    /Owned child task/,
  );
  await parent.execute(
    call("TaskUpdate", { taskId: rows[0]!.id, subject: "Parent edit" }),
    signal(),
  );
  assert.match(
    (await tools.execute(call("TaskGet", { taskId: rows[0]!.id }), signal()))
      .content,
    /Parent edit/,
  );
  await tools.execute(
    call("TaskUpdate", { taskId: rows[0]!.id, status: "completed" }),
    signal(),
  );
  assert.deepEqual(
    f.lifecycle,
    ["created", "completed"].map((event) => ({
      event,
      actor: "owned-child",
      sessionId: "parent-session",
      listId: "parent-session-list",
    })),
  );
});
test("child task lifecycle blocking retains native create rollback and whole update rollback", async (t) => {
  const f = await fixture(t);
  const child = await f.make({
    tasks: {
      store: f.store,
      enabled: () => true,
      lifecycle: {
        async created() {
          return { blockingErrors: ["Owned created block"] };
        },
        async completed() {
          return { blockingErrors: ["Owned completion block"] };
        },
      },
    },
  });
  const tools = child.wrap(
    {
      definitions: [],
      async execute() {
        throw Error("unrelated");
      },
    },
    [],
  );
  assert.equal(
    (
      await tools.execute(
        call("TaskCreate", { subject: "removed", description: "removed" }),
        signal(),
      )
    ).is_error,
    true,
  );
  assert.deepEqual(await f.store.list(), []);
  const row = await f.store.create(
    { subject: "before", description: "before" },
    signal(),
  );
  const update = await tools.execute(
    call("TaskUpdate", {
      taskId: row.id,
      status: "completed",
      subject: "after",
    }),
    signal(),
  );
  assert.equal(update.is_error, undefined);
  assert.match(update.content, /Owned completion block/);
  assert.equal((await f.store.get(row.id))!.subject, "before");
  assert.equal((await f.store.get(row.id))!.status, "pending");
});
test("ordinary async child permits pure Skill, avoids prompts, and excludes CRUD", async (t) => {
  const f = await fixture(t);
  await f.skill("pure", "Owned body");
  await f.skill("grant", "---\nallowed-tools: Write\n---\nOwned grant");
  f.setPolicy({ ...f.getPolicy(), allowedTools: [] });
  const child = await f.make({ isAsync: true }),
    tools = child.wrap(
      {
        definitions: [],
        async execute() {
          throw Error("unrelated");
        },
      },
      [],
    );
  assert.ok(tools.definitions.some((tool) => tool.name === "Skill"));
  assert.equal(
    tools.definitions.some((tool) => tool.name.startsWith("Task")),
    false,
  );
  assert.equal(
    (await tools.execute(call("Skill", { skill: "pure" }), signal())).is_error,
    undefined,
  );
  assert.equal(
    (await tools.execute(call("Skill", { skill: "grant" }), signal()))
      .permissionDenied,
    true,
  );
  assert.equal(
    (
      await tools.execute(
        call("TaskCreate", { subject: "no", description: "no" }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  assert.equal(f.approvals(), 0);
  assert.deepEqual(await f.store.list(), []);
});
test("foreground command denies publish only via explicit session adapter; async setter remains no-op", async (t) => {
  const f = await fixture(t);
  await f.skill("deny", "---\ndisallowed-tools: Bash\n---\nOwned deny");
  const calls: unknown[] = [];
  const foreground = await f.make({
    publishSessionCommandDenies: (rules, actor) => {
      calls.push({ rules, actor });
    },
  });
  const base: ToolExecutor = {
    definitions: [],
    async execute() {
      throw Error("unrelated");
    },
  };
  assert.equal(
    (
      await foreground
        .wrap(base, [])
        .execute(call("Skill", { skill: "deny" }), signal())
    ).is_error,
    undefined,
  );
  assert.ok(
    foreground
      .policy()
      .sourcedRules?.some(
        (rule) => rule.rule === "Bash" && rule.behavior === "deny",
      ),
  );
  assert.deepEqual(calls, [
    { rules: ["Bash"], actor: { agentId: "owned-child" } },
  ]);
  const background = await f.make({
    isAsync: true,
    publishSessionCommandDenies: () => {
      throw Error("must not publish");
    },
  });
  assert.equal(
    (
      await background
        .wrap(base, [])
        .execute(call("Skill", { skill: "deny" }), signal())
    ).is_error,
    undefined,
  );
  assert.equal(
    background
      .policy()
      .sourcedRules?.some(
        (rule) => rule.rule === "Bash" && rule.behavior === "deny",
      ) ?? false,
    false,
  );
  const missing = await f.make();
  assert.equal(
    (
      await missing
        .wrap(base, [])
        .execute(call("Skill", { skill: "deny" }), signal())
    ).is_error,
    true,
  );
});
test("child Skill hook registration retains session key and invoking actor, without merging root hooks", async (t) => {
  const f = await fixture(t);
  await f.skill(
    "hooked",
    "---\nallowed-tools: Write\nhooks: {Stop: []}\n---\nOwned hooked",
  );
  const registrations: unknown[] = [],
    seen: string[] = [];
  const child = await f.make({
    registerSkillHooks(request, actor) {
      registrations.push({ request, actor });
      return { registered: true };
    },
    hooks: {
      async before(tool) {
        seen.push(tool.name);
        return pre();
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  const tools = child.wrap(
    {
      definitions: [],
      async execute() {
        throw Error("unrelated");
      },
    },
    [],
  );
  assert.equal(
    (await tools.execute(call("Skill", { skill: "hooked" }), signal()))
      .is_error,
    undefined,
  );
  assert.equal((registrations[0] as any).request.sessionId, "parent-session");
  assert.deepEqual((registrations[0] as any).actor, { agentId: "owned-child" });
  assert.deepEqual(seen, ["Skill"]);
  assert.equal(registrations.length, 1);
});
test("declared preloads use explicit parent renderer without grant/model/effort/hooks publication", async (t) => {
  const f = await fixture(t);
  await f.skill(
    "preload",
    "---\ndescription: Owned preload\nallowed-tools: Write\ndisallowed-tools: Bash\nmodel: haiku\neffort: low\ncontext: fork\nhooks: {Stop: []}\n---\nPRELOAD ${CLAUDE_SESSION_ID} ${CLAUDE_EFFORT}",
  );
  const registry = await f.registry(),
    parent = await createSessionSkillHost({
      cwd: f.cwd,
      launch: f.launch,
      registry,
      policy: f.getPolicy(),
      sessionId: () => "parent-session",
      mode: () => "default",
      hooks,
      interactive: false,
      approve: async () => {
        throw Error("must not authorize invocation");
      },
      registerHooks() {
        throw Error("must not register hooks");
      },
      env: f.env,
    });
  const child = await f.make({
    registry,
    declaredSkills: ["preload", "preload"],
    preloadRender: (skill, request) =>
      parent.renderPreload(skill.name, {
        sessionId: "parent-render-session",
        effortLevel: "max",
        signal: request.signal,
      }),
    publishSessionCommandDenies() {
      throw Error("must not publish");
    },
    registerSkillHooks() {
      throw Error("must not register");
    },
  });
  assert.deepEqual(child.preloadedSkills, ["preload"]);
  assert.deepEqual(child.handledFeatures, ["skills"]);
  assert.match(
    JSON.stringify(child.preloadMessages),
    /PRELOAD parent-render-session max/,
  );
  assert.equal(child.contextModel(), child.primaryModel);
  assert.equal(child.queryEffort(), "medium");
  assert.equal(child.policy().allowedTools.includes("Write"), false);
  assert.equal(child.policy().sourcedRules?.length ?? 0, 0);
});
test("main-only Enter and unsupported Exit do not block child materialization or execute hooks", async (t) => {
  const f = await fixture(t);
  let hookCalls = 0;
  const child = await f.make({
    hooks: {
      async before() {
        hookCalls++;
        return pre();
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  const tools = child.wrap(
    createTools({ cwd: f.cwd, mode: "default", approve: async () => false }),
    [],
  );
  assert.ok(tools.definitions.some((tool) => tool.name === "EnterPlanMode"));
  assert.equal(
    tools.definitions.some((tool) => tool.name === "ExitPlanMode"),
    false,
  );
  assert.match(
    (await tools.execute(call("EnterPlanMode", {}), signal())).content,
    /Only the main session/,
  );
  assert.match(
    (await tools.execute(call("ExitPlanMode", {}), signal())).content,
    /actor-aware/,
  );
  assert.equal(hookCalls, 0);
  await writeFile(join(f.cwd, "owned.txt"), "readable");
  assert.equal(
    (await tools.execute(call("Read", { file_path: "owned.txt" }), signal()))
      .is_error,
    undefined,
  );
});
function info(name: string, source: SkillSource = "plugin"): LocalSkill {
  return {
    name,
    displayName: name,
    description: "Owned",
    hasUserSpecifiedDescription: true,
    path: `/owned/${name}/SKILL.md`,
    canonicalPath: `/owned/${name}/SKILL.md`,
    baseDir: `/owned/${name}`,
    source,
    allowedTools: [],
    disallowedTools: [],
    argumentNames: [],
    userInvocable: true,
    disableModelInvocation: false,
    contentLength: 0,
  };
}
test("preload lookup preserves exact/alias, agent namespace then plugin suffix fallback and dedup/cap32", async () => {
  const aliases = { ...info("canonical"), aliases: ["alias"] },
    ns = info("owned:prepare"),
    other = info("other:fallback");
  const seen: string[] = [];
  const result = await preloadDeclaredChildSkills({
    names: ["alias", "prepare", "fallback", "missing", "prepare"],
    agentType: "owned:reader",
    catalog: [aliases, ns, other],
    signal: signal(),
    async render(skill) {
      seen.push(skill.name);
      return { skill, text: skill.name };
    },
  });
  assert.deepEqual(seen, ["canonical", "owned:prepare", "other:fallback"]);
  assert.equal(result.warnings.length, 1);
  const names = Array.from({ length: 34 }, (_, i) => `skill${i}`),
    cap = await preloadDeclaredChildSkills({
      names,
      agentType: "owned:reader",
      catalog: names.map((name) => info(name)),
      signal: signal(),
      async render(skill) {
        return { skill, text: skill.name };
      },
    });
  assert.equal(cap.preloaded.length, 32);
  assert.equal(cap.warnings.length, 1);
});
test("preload render failure aborts sibling render, disabled catalog entries skip, and identity changes reject", async () => {
  const disabled = { ...info("disabled"), disableModelInvocation: true };
  const skipped = await preloadDeclaredChildSkills({
    names: ["disabled"],
    agentType: "owned",
    catalog: [disabled],
    signal: signal(),
    async render() {
      throw Error("must not render");
    },
  });
  assert.deepEqual(skipped.preloaded, []);
  let aborted = false;
  await assert.rejects(
    preloadDeclaredChildSkills({
      names: ["first", "second"],
      agentType: "owned",
      catalog: [info("first"), info("second")],
      signal: signal(),
      async render(skill, request) {
        if (skill.name === "first") throw Error("owned render failure");
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        request.signal.throwIfAborted();
        return { skill, text: "never" };
      },
    }),
    /owned render failure/,
  );
  assert.equal(aborted, true);
  await assert.rejects(
    preloadDeclaredChildSkills({
      names: ["owned"],
      agentType: "owned",
      catalog: [info("owned")],
      signal: signal(),
      async render() {
        return { skill: info("different"), text: "no" };
      },
    }),
    /identity/,
  );
});

test("child task authorize rechecks a parent deny installed during PreToolUse despite hook allow", async (t) => {
  const f = await fixture(t);
  const child = await f.make({
    hooks: {
      async before(tool) {
        if (tool.name === "TaskCreate")
          f.setPolicy({ ...f.getPolicy(), disallowedTools: ["TaskCreate"] });
        return { ...pre(), permission: "allow" };
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  const tools = child.wrap(
    {
      definitions: [],
      async execute() {
        throw Error("unrelated");
      },
    },
    [],
  );
  assert.equal(
    (
      await tools.execute(
        call("TaskCreate", { subject: "denied", description: "denied" }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  assert.deepEqual(await f.store.list(), []);
  assert.deepEqual(f.lifecycle, []);
  assert.equal(
    tools.definitions.some((tool) => tool.name === "TaskCreate"),
    false,
  );
});
test("child captures session/model/effort identity snapshots while continuing to use live parent policy", async (t) => {
  const f = await fixture(t);
  let sid = "parent-session",
    model = "claude-sonnet-4-6",
    effort = "medium" as "medium" | "high";
  const child = await f.make({
    sessionId: () => sid,
    model: () => model,
    effort: () => effort,
  });
  sid = "another-session";
  model = "haiku";
  effort = "high";
  assert.equal(child.sessionId, "parent-session");
  assert.equal(child.primaryModel, "claude-sonnet-4-6");
  assert.equal(child.queryEffort(), "medium");
  const tools = child.wrap(
    {
      definitions: [],
      async execute() {
        throw Error("unrelated");
      },
    },
    [],
  );
  await tools.execute(
    call("TaskCreate", { subject: "snapshot", description: "snapshot" }),
    signal(),
  );
  assert.equal(f.lifecycle[0]!.sessionId, "parent-session");
  f.setPolicy({ ...f.getPolicy(), tools: ["Read"] });
  assert.equal(
    tools.definitions.some((tool) => tool.name === "TaskCreate"),
    false,
  );
});

test("history getter flushes Skill instructions into actual cloned child history after paired tool result", async (t) => {
  const f = await fixture(t);
  await f.skill("context", "Owned dynamic history instructions");
  const child = await f.make(),
    original: Message[] = [];
  let messages = original;
  const tools = child.wrap(
    {
      definitions: [],
      async execute() {
        throw Error("unrelated");
      },
    },
    () => messages,
  );
  const result = await tools.execute(
    call("Skill", { skill: "context" }),
    signal(),
  );
  messages = [{ role: "user", content: [result] }];
  await tools.beforeModelRequest!(signal());
  assert.deepEqual(original, []);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.content[0]!.type, "tool_result");
  assert.match(
    JSON.stringify(messages[1]),
    /Owned dynamic history instructions/,
  );
});
