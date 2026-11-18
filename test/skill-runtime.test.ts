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
import test from "node:test";
import {
  createLocalSkillRegistry,
  type SkillRegistryOptions,
} from "../src/skills.js";
import {
  createSkillRuntime,
  isPureLocalSkill,
  localSkillGrantRefusal,
  matchesLocalSkillPermissionRule,
  parseSkillPermissionRule,
  type SkillEffectRequest,
  type SkillRuntimeOptions,
} from "../src/skill-runtime.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import { runAgent } from "../src/agent.js";
import { newSession, SessionStore } from "../src/session.js";
import { projectMessages } from "../src/thinking-history.js";
import type { Message, Provider, ToolExecutor, ToolUse } from "../src/types.js";

const signal = () => new AbortController().signal;
const call = (skill: string, args?: string): ToolUse => ({
  type: "tool_use",
  id: "skill-call",
  name: "Skill",
  input: { skill, ...(args === undefined ? {} : { args }) },
});
const emptyTools: ToolExecutor = {
  definitions: [],
  async execute() {
    throw new Error("Unexpected tool");
  },
};
const pre = () => ({
  additionalContext: [] as string[],
  preventContinuation: false,
});
async function fixture(t: any) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-skill-runtime-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  async function skill(name: string, body: string) {
    const directory = join(root, ".claude", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), body);
    return directory;
  }
  const registry = (options: Partial<SkillRegistryOptions> = {}) =>
    createLocalSkillRegistry({
      cwd: root,
      projectDirectories: [root],
      sources: { user: false, project: true },
      ...options,
    });
  async function runtime(options: Partial<SkillRuntimeOptions> = {}) {
    return createSkillRuntime({
      registry: await registry(),
      sessionId: () => "owned-session",
      authorize: () => true,
      applyEffects: (e) => ({
        allowedTools: e.allowedTools,
        ...(e.declaredModel ? { model: e.declaredModel } : {}),
        ...(e.declaredEffort ? { effort: e.declaredEffort } : {}),
      }),
      ...options,
    });
  }
  return { root, skill, registry, runtime };
}

test("tool inventory remains metadata only; explicit user and consent paths preserve invocation flags", async (t) => {
  const f = await fixture(t);
  const dir = await f.skill(
    "manual",
    "---\ndescription: Manual operation\ndisable-model-invocation: true\nuser-invocable: false\n---\nSECRET_INSTRUCTIONS $ARGUMENTS",
  );
  await f.skill(
    "offered",
    "---\ndescription: Offered summary\nargument-hint: '[branch]'\n---\nBODY_ONLY",
  );
  await writeFile(join(dir, "support.txt"), "NEVER_EAGER");
  const reads: string[] = [],
    registry = await f.registry({
      readPolicy: (path) => {
        reads.push(path);
        return true;
      },
    });
  const runtime = await f.runtime({ registry });
  assert.match(
    runtime.definitions[0]!.description,
    /available skills listed in the conversation/,
  );
  assert.deepEqual(
    runtime
      .catalog("model")
      .map((skill) => `${skill.name}: ${skill.description}`),
    ["offered: Offered summary"],
  );
  assert.doesNotMatch(
    runtime.definitions[0]!.description,
    /SECRET_INSTRUCTIONS|BODY_ONLY|manual:|NEVER_EAGER/,
  );
  assert.deepEqual(
    runtime.catalog().map((s) => s.name),
    ["offered"],
  );
  await assert.rejects(
    runtime.execute(call("manual"), signal()),
    /explicit user/,
  );
  const invoked = await runtime.invokeUser(" /manual ", "argument", signal());
  assert.match(
    invoked.newMessages[0]!.content[0]!.type === "text"
      ? invoked.newMessages[0]!.content[0]!.text
      : "",
    /SECRET_INSTRUCTIONS argument/,
  );
  assert.equal(invoked.effects.invocation, "user");
  const consent = await f.runtime({
    registry,
    userAuthorizedThisTurn: () => true,
  });
  assert.equal(
    (await consent.execute(call("manual"), signal())).result.is_error,
    undefined,
  );
  assert.equal(
    reads.some((path) => path.endsWith("support.txt")),
    false,
  );
});

test("real agent commits tool results before skill instructions and subsequent builtins use only current query grants", async (t) => {
  const f = await fixture(t);
  await f.skill(
    "write",
    "---\ndescription: Write owned artifact\nallowed-tools: Write\ndisallowed-tools: Bash\nmodel: sonnet\neffort: high\n---\nWrite $ARGUMENTS. Full skill instruction context.",
  );
  const effects: SkillEffectRequest[] = [],
    runtime = await f.runtime({
      applyEffects: (e) => {
        effects.push(e);
        return {
          allowedTools: e.allowedTools,
          model: "resolved-sonnet",
          effort: "high",
        };
      },
    });
  const session = newSession(f.root, "test"),
    messages = session.messages;
  messages.push({
    role: "user",
    content: [{ type: "text", text: "Create owned artifact" }],
  });
  const readState = new ReadState();
  const makeTools = () =>
    createTools({
      cwd: f.root,
      readState,
      mode: "default",
      approve: async () => false,
      policy: {
        allowedTools: runtime.queryContext.layers.flatMap((l) =>
          l.kind === "allowed_tools" ? [...l.allowedTools] : [],
        ),
        disallowedTools: [...runtime.queryContext.commandDisallowedTools],
      },
    });
  const tools = runtime.wrap(makeTools, messages),
    snapshots: Message[][] = [];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      snapshots.push(structuredClone(request.messages));
      round++;
      const content =
        round === 1
          ? [call("write", "new.txt")]
          : round === 2
            ? [
                {
                  type: "tool_use" as const,
                  id: "write-call",
                  name: "Write",
                  input: { file_path: "new.txt", content: "owned\n" },
                },
              ]
            : round === 3
              ? [
                  {
                    type: "tool_use" as const,
                    id: "bash-call",
                    name: "Bash",
                    input: { command: "touch forbidden" },
                  },
                ]
              : [{ type: "text" as const, text: "done" }];
      return {
        content,
        stop_reason: round < 4 ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  await runAgent({
    provider,
    tools,
    messages,
    model: "test",
    system: "owned",
    maxTokens: 100,
    maxTurns: 5,
    autoCompact: false,
    signal: signal(),
    onEvent() {},
  });
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "owned\n");
  await assert.rejects(readFile(join(f.root, "forbidden")), { code: "ENOENT" });
  const next = snapshots[1]!,
    resultIndex = next.findIndex((m) =>
      m.content.some(
        (b) => b.type === "tool_result" && b.tool_use_id === "skill-call",
      ),
    );
  const instructionIndex = next.findIndex((m) =>
    m.content.some(
      (b) => b.type === "text" && /Full skill instruction context/.test(b.text),
    ),
  );
  assert.ok(resultIndex >= 0 && instructionIndex > resultIndex);
  assert.equal(effects[0]!.skill.source, "projectSettings");
  assert.deepEqual(runtime.queryContext.layers, [
    { kind: "allowed_tools", allowedTools: ["Write"] },
    { kind: "model", mainLoopModel: "resolved-sonnet" },
    { kind: "effort", effort: "high" },
  ]);
  const store = await SessionStore.create(f.root, join(f.root, "session-home"));
  await store.save(session);
  const loaded = await store.load(session.id);
  assert.deepEqual(loaded.messages, messages);
  assert.equal(
    JSON.stringify(projectMessages(loaded.messages)).includes("hookResponse"),
    false,
  );
  runtime.resetQuery(messages);
  assert.deepEqual(runtime.queryContext, {
    layers: [],
    commandDisallowedTools: [],
  });
  assert.equal(
    (
      await tools.execute(
        {
          type: "tool_use",
          id: "fresh",
          name: "Write",
          input: { file_path: "fresh", content: "denied" },
        },
        signal(),
      )
    ).permissionDenied,
    true,
  );
  assert.match(
    JSON.stringify(loaded.messages),
    /Full skill instruction context/,
  );
});

test("source eligibility and fork validation precede hooks, authorization, shell substitution and effects", async (t) => {
  const f = await fixture(t);
  await f.skill(
    "fork",
    "---\ncontext: fork\nagent: Explore\nbackground: true\n---\n!`must-not-run`",
  );
  await f.skill("conditional", "---\npaths: 'src/**'\n---\nconditional body");
  const events: string[] = [],
    hooks: ToolHookRuntime = {
      async before() {
        events.push("pre");
        return pre();
      },
      async after(_c, r) {
        events.push("post");
        return r;
      },
    };
  const runtime = await f.runtime({
    hooks,
    authorize: () => {
      events.push("authorize");
      return true;
    },
    applyEffects: () => {
      events.push("effects");
      return { allowedTools: [] };
    },
    processShellBlocks: async (text) => {
      events.push("shell");
      return text;
    },
  });
  for (const tool of [
    call("fork"),
    call("conditional"),
    call("unknown"),
    { ...call("fork"), input: { skill: 1 } },
  ])
    await assert.rejects(runtime.execute(tool, signal()));
  assert.deepEqual(events, []);
  assert.deepEqual(runtime.activateForPaths(["src/owned.ts"]), ["conditional"]);
  assert.equal(
    (await runtime.execute(call("conditional"), signal())).invocation.skill
      .name,
    "conditional",
  );
  assert.deepEqual(events, ["pre", "authorize", "effects", "post"]);
});

test("hook allow cannot bypass host refusal; invalid replacements cannot grant effects or execute shell blocks", async (t) => {
  const f = await fixture(t);
  await f.skill("shell", "!`owned-substitution`");
  let effects = 0,
    shells = 0,
    posts = 0,
    invalid = false;
  const hooks: ToolHookRuntime = {
    async before(_call, _signal, validate) {
      return {
        ...pre(),
        additionalContext: ["owned permission context"],
        permission: "allow",
        ...(invalid
          ? { updatedInput: await validate({ skill: "absent" }) }
          : {}),
      };
    },
    async after(_c, r) {
      posts++;
      return r;
    },
  };
  const runtime = await f.runtime({
    hooks,
    authorize: (context) => {
      assert.equal(context.hookPermission, "allow");
      return "explicit Skill ask refused";
    },
    applyEffects: () => {
      effects++;
      return { allowedTools: ["Bash"] };
    },
    processShellBlocks: async (text) => {
      shells++;
      return text;
    },
  });
  const wrapped = runtime.wrap(emptyTools, []);
  const denied = await wrapped.execute(call("shell"), signal());
  assert.equal(denied.permissionDenied, true);
  assert.deepEqual(denied.hookAttachments, [
    {
      phase: "pre",
      event: "PreToolUse",
      toolName: "Skill",
      content: ["owned permission context"],
    },
  ]);
  invalid = true;
  assert.equal((await wrapped.execute(call("shell"), signal())).is_error, true);
  assert.deepEqual(
    { effects, shells, posts },
    { effects: 0, shells: 0, posts: 0 },
  );
  assert.deepEqual(runtime.queryContext, {
    layers: [],
    commandDisallowedTools: [],
  });
});

test("session hooks register separately; withheld registration also withholds grants while temporary denies reset", async (t) => {
  const f = await fixture(t);
  await f.skill(
    "hooked",
    "---\nallowed-tools: Read\ndisallowed-tools: [Bash, 'Read(!secret)', 'Edit(./!secret)']\nhooks: {Stop: []}\n---\nbody",
  );
  const registry = await f.registry({ validateHooks: (h) => h }),
    registrations: string[] = [],
    warnings: string[] = [];
  let register = false;
  const runtime = await f.runtime({
    registry,
    onDiagnostic: (text) => warnings.push(text),
    applyEffects: (effect) => {
      assert.equal(effect.sessionHooks!.sessionId, "owned-session");
      assert.equal(
        effect.sessionHooks!.skillRoot,
        join(f.root, ".claude", "skills", "hooked"),
      );
      if (register) registrations.push(effect.sessionHooks!.skillName);
      return { allowedTools: effect.allowedTools, hooksRegistered: register };
    },
  });
  assert.deepEqual(
    (await runtime.execute(call("hooked"), signal())).admitted.allowedTools,
    [],
  );
  assert.deepEqual(runtime.queryContext.commandDisallowedTools, ["Bash"]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(runtime.queryContext.layers, []);
  register = true;
  await runtime.execute(call("hooked"), signal());
  assert.deepEqual(runtime.queryContext.layers, [
    { kind: "allowed_tools", allowedTools: ["Read"] },
  ]);
  runtime.resetQuery();
  assert.deepEqual(registrations, ["hooked"]);
  assert.deepEqual(runtime.queryContext.commandDisallowedTools, []);
});

test("validated hook rewrite retains original assistant input and post output cannot grant tools", async (t) => {
  const f = await fixture(t);
  await f.skill("first", "first");
  await f.skill(
    "second",
    "---\nmodel: inherit\nagent: Explore\nbackground: true\n---\nsecond $ARGUMENTS",
  );
  const hooks: ToolHookRuntime = {
    async before(_c, _s, validate) {
      return {
        ...pre(),
        updatedInput: await validate({ skill: "second", args: "rewritten" }),
        additionalContext: ["pre context"],
      };
    },
    async after(_c, result, _s, validate) {
      assert.deepEqual(result.hookResponse, {
        success: true,
        commandName: "second",
      });
      return validate!(
        { success: true, commandName: "second", allowedTools: ["Bash"] },
        result,
      );
    },
  };
  const runtime = await f.runtime({ hooks });
  const original = call("first"),
    output = await runtime.execute(original, signal());
  assert.deepEqual(original.input, { skill: "first" });
  assert.deepEqual(output.result.effectiveToolInput, {
    skill: "second",
    args: "rewritten",
  });
  assert.equal(output.invocation.agent, "Explore");
  assert.equal(output.invocation.background, true);
  assert.match(JSON.stringify(output.newMessages), /second rewritten/);
  assert.deepEqual(runtime.queryContext.layers, []);
  assert.equal(output.effects.declaredModel, undefined);
  assert.equal(
    JSON.stringify(
      projectMessages([
        { role: "assistant", content: [original] },
        { role: "user", content: [output.result] },
      ]),
    ).includes("effectiveToolInput"),
    false,
  );
});

test("hook stop is local, user context flush follows committed result, and reset refuses lost pending instructions", async (t) => {
  const f = await fixture(t);
  await f.skill("owned", "owned instructions");
  const hooks: ToolHookRuntime = {
    async before() {
      return {
        ...pre(),
        preventContinuation: true,
        stopReason: "halt",
        additionalContext: ["stop feedback"],
      };
    },
    async after(_c, r) {
      return r;
    },
  };
  const blocked = await f.runtime({ hooks }),
    messages: Message[] = [],
    wrapped = blocked.wrap(emptyTools, messages);
  const result = await wrapped.execute(call("owned"), signal());
  assert.deepEqual(result.hookStop, { reason: "halt" });
  assert.deepEqual(result.hookAttachments, [
    {
      phase: "pre",
      event: "PreToolUse",
      toolName: "Skill",
      content: ["stop feedback"],
    },
  ]);
  assert.equal(messages.length, 0);
  assert.deepEqual(blocked.queryContext.layers, []);
  const runtime = await f.runtime(),
    normal = runtime.wrap(emptyTools, messages);
  const success = await normal.execute(call("owned"), signal());
  assert.equal(messages.length, 0);
  assert.throws(() => runtime.resetQuery(), /pending skill context/);
  messages.push({ role: "user", content: [success] });
  runtime.resetQuery(messages);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.content[0]!.type, "tool_result");
  assert.match(JSON.stringify(messages[1]), /owned instructions/);
  assert.equal(normal.prepareCompaction, undefined);
});

test("render failure reaches failure adapter, cancellation and disabled tool cannot create effects", async (t) => {
  const f = await fixture(t);
  await f.skill("shell", "!`owned`");
  const events: string[] = [],
    hooks: ToolHookRuntime = {
      async before() {
        events.push("pre");
        return pre();
      },
      async after(_c, r) {
        events.push("post");
        return r;
      },
      async failure() {
        events.push("failure");
      },
    };
  const runtime = await f.runtime({
    hooks,
    applyEffects: () => {
      events.push("effects");
      return { allowedTools: [] };
    },
  });
  assert.equal(
    (await runtime.wrap(emptyTools, []).execute(call("shell"), signal()))
      .is_error,
    true,
  );
  assert.deepEqual(events, ["pre", "failure"]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(runtime.execute(call("shell"), aborted.signal), {
    name: "AbortError",
  });
  const disabled = await f.runtime({ enabled: () => false });
  assert.deepEqual(disabled.definitions, []);
  await assert.rejects(disabled.execute(call("shell"), signal()), /disabled/);
  assert.deepEqual(events, ["pre", "failure"]);
});

test("ordinary grant source arbitration preserves managed, noninteractive persisted-trust and personal-config gates", () => {
  assert.equal(localSkillGrantRefusal("projectSettings", {}), undefined);
  assert.equal(localSkillGrantRefusal("userSettings", {}), undefined);
  assert.equal(
    localSkillGrantRefusal("policySettings", {
      allowManagedPermissionRulesOnly: true,
      ignorePersistedTrust: true,
      restrictPersonalConfig: true,
    }),
    undefined,
  );
  assert.equal(
    localSkillGrantRefusal("projectSettings", {
      allowManagedPermissionRulesOnly: true,
      ignorePersistedTrust: true,
    }),
    "managed_rules_only",
  );
  assert.equal(
    localSkillGrantRefusal("projectSettings", { ignorePersistedTrust: true }),
    "untrusted_folder",
  );
  assert.equal(
    localSkillGrantRefusal("projectSettings", {
      ignorePersistedTrust: true,
      interactive: true,
    }),
    undefined,
  );
  assert.equal(
    localSkillGrantRefusal("userSettings", { ignorePersistedTrust: true }),
    undefined,
  );
  assert.equal(
    localSkillGrantRefusal("userSettings", { restrictPersonalConfig: true }),
    "personal_config",
  );
  assert.equal(
    localSkillGrantRefusal("projectSettings", { restrictPersonalConfig: true }),
    undefined,
  );
  assert.equal(
    isPureLocalSkill({ allowedTools: [], disallowedTools: [] }),
    true,
  );
  assert.equal(
    isPureLocalSkill({ allowedTools: ["Read"], disallowedTools: [] }),
    false,
  );
  assert.equal(
    isPureLocalSkill({ allowedTools: [], disallowedTools: ["Bash"] }),
    false,
  );
  assert.equal(
    isPureLocalSkill({ allowedTools: [], disallowedTools: [], hooks: {} }),
    true,
  );
  assert.equal(
    isPureLocalSkill({
      allowedTools: [],
      disallowedTools: [],
      hooks: { Stop: [] },
    }),
    false,
  );
});

test("ordinary Skill rule matching separates raw name prefixes, primitive ask/deny globs and whole tool rules", () => {
  for (const rule of ["Skill", "Skill()", "Skill(*)"])
    for (const behavior of ["allow", "deny", "ask"] as const)
      assert.equal(
        matchesLocalSkillPermissionRule(rule, "anything", behavior),
        true,
      );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(review)", "review", "allow"),
    true,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(review)", "review", "deny"),
    true,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(review)", "review", "ask"),
    false,
  );
  for (const name of ["review", "review-more", "review:sub"])
    for (const suffix of [":*", " *"])
      assert.equal(
        matchesLocalSkillPermissionRule(
          `Skill(/review${suffix})`,
          name,
          "allow",
        ),
        true,
      );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(review:*)", "prefix-review", "deny"),
    false,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(rev*)", "review", "allow"),
    false,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(skill:rev*)", "review", "ask"),
    true,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(skill:rev*)", "review", "deny"),
    true,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(skill:rev*)", "review", "allow"),
    false,
  );
  assert.equal(
    matchesLocalSkillPermissionRule("Skill(skill:rev?)", "review", "deny"),
    false,
  );
  assert.deepEqual(parseSkillPermissionRule("Skill(a\\(b\\))"), {
    content: "a(b)",
  });
  assert.equal(parseSkillPermissionRule("Skill(a\\)"), undefined);
  assert.equal(parseSkillPermissionRule("Bash"), undefined);
});
