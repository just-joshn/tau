import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createLocalAgentRegistry,
  type LocalAgentDefinition,
} from "../../src/agent-definitions.js";
import {
  createSubagentRuntime,
  foregroundSubagentReport,
  narrowerSubagentPermissionMode,
  resolveOrdinarySubagentPermissionMode,
  type SubagentRuntimeOptions,
  type SubagentParentContext,
  type SubagentChildRequest,
  type SubagentMaterialization,
  type SubagentPlan,
  type SubagentAsyncLaunch,
} from "../../src/subagent-runtime.js";
import {
  createBackgroundAgentRuntime,
  ordinaryLocalAgentLaunchMode,
} from "../../src/background-agent-runtime.js";
import { runAgent } from "../../src/agent.js";
import type {
  CompletionRequest,
  Message,
  Provider,
  ToolDefinition,
  ToolUse,
} from "../../src/types.js";

const signal = () => new AbortController().signal;
const definition = (
  patch: Partial<LocalAgentDefinition> = {},
): LocalAgentDefinition => ({
  agentType: "owned-reader",
  whenToUse: "Read an owned fixture",
  prompt: "OWNED_AGENT_SYSTEM_READER",
  source: "userSettings",
  tools: ["Read"],
  skills: [],
  model: "inherit",
  maxTurns: 3,
  ...patch,
});
const tool = (name: string): ToolDefinition => ({
  name,
  description: "owned fixture",
  input_schema: { type: "object" },
});
const input = (patch: Record<string, unknown> = {}) => ({
  description: "Owned foreground read",
  prompt: "OWNED_AGENT_CHILD_REQUEST",
  subagent_type: "owned-reader",
  run_in_background: false,
  ...patch,
});
const call = (value = input()): ToolUse => ({
  type: "tool_use",
  id: "owned-parent-call",
  name: "Agent",
  input: value,
});
const assistant = (
  text: string,
  input_tokens = 10,
  output_tokens = 3,
): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  usage: { input_tokens, output_tokens },
  model: "claude-sonnet-4-6",
});
function first<T extends object>(items: readonly T[]): T {
  const [item] = items;
  assert.ok(item);
  return item;
}
function asObject(value: unknown): object {
  assert.ok(typeof value === "object" && value !== null);
  return value;
}
function field(value: unknown, key: string): unknown {
  const object = asObject(value);
  assert.ok(key in object);
  return Reflect.get(object, key);
}
test("ordinary native permission selection preserves sticky parent modes and resolved source-policy gates", () => {
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "acceptEdits",
    }),
    "acceptEdits",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "acceptEdits",
      personalSourceRestricted: true,
    }),
    "default",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "acceptEdits",
      confinedEvaluation: true,
    }),
    "default",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "acceptEdits",
      guardNarrowOnly: true,
    }),
    "default",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "bypassPermissions",
    }),
    "default",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "auto",
    }),
    "default",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "auto",
      autoModeAvailable: true,
    }),
    "auto",
  );
  assert.equal(
    resolveOrdinarySubagentPermissionMode({
      parent: "default",
      declared: "plan",
      personalSourceRestricted: true,
    }),
    "plan",
  );
  for (const parent of [
    "acceptEdits",
    "bypassPermissions",
    "auto",
    "plan",
  ] as const)
    assert.equal(
      resolveOrdinarySubagentPermissionMode({ parent, declared: "default" }),
      parent,
    );
  assert.equal(
    narrowerSubagentPermissionMode("acceptEdits", "auto"),
    undefined,
  );
  assert.equal(narrowerSubagentPermissionMode("default", "dontAsk"), "default");
});
async function setup(
  overrides: Partial<SubagentRuntimeOptions> = {},
  definitions = [definition()],
  context: Partial<SubagentParentContext> = {},
) {
  const parent: SubagentParentContext = {
    sessionId: "owned-session",
    parentModel: "claude-sonnet-4-6",
    parentMode: "default",
    depth: 0,
    maxDepth: 3,
    availableTools: [tool("Read"), tool("Edit"), tool("Bash"), tool("Agent")],
    allowedModes: ["default"],
    foregroundAllowed: true,
    ...context,
  };
  const registry = await createLocalAgentRegistry({
    locations: [],
    definitions,
  });
  const executions: ToolUse[] = [],
    children: SubagentChildRequest[] = [];
  const options: SubagentRuntimeOptions = {
    registry,
    context: () => parent,
    authorize: () => true,
    admitChild: () => true,
    resolveModel: ({ definition, parent }) =>
      definition.model && definition.model !== "inherit"
        ? definition.model
        : parent.parentModel,
    resolvePermissionMode: ({ parent }) => parent.parentMode,
    authorizeChildTool: () => true,
    materialize: (plan) => ({
      system: plan.definition.prompt,
      enforcesParentPolicy: true,
      tools: {
        definitions: [...parent.availableTools],
        async execute(call) {
          executions.push(call);
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: "OWNED_FILE_CONTENT",
          };
        },
      },
    }),
    runChild: async (request) => {
      children.push(request);
      return {
        messages: [...request.messages, assistant("OWNED_AGENT_CHILD_FINAL")],
      };
    },
    createAgentId: () => "owned-agent-id",
    now: () => 1000,
    ...overrides,
  };
  return {
    options,
    parent,
    executions,
    children,
    runtime: createSubagentRuntime(options),
  };
}

test("foreground dispatch materializes an isolated fresh child and returns a structured text-array report", async () => {
  const f = await setup(),
    original = call(),
    snapshot = structuredClone(original);
  const result = await f.runtime.execute(original, signal());
  assert.equal(result.is_error, undefined);
  assert.deepEqual(original, snapshot);
  assert.equal(f.children.length, 1);
  const child = first(f.children);
  assert.equal(child.system, "OWNED_AGENT_SYSTEM_READER");
  assert.deepEqual(child.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "OWNED_AGENT_CHILD_REQUEST" }],
    },
  ]);
  assert.deepEqual(
    child.tools.definitions.map((t) => t.name),
    ["Read"],
  );
  assert.equal(child.plan.depth, 1);
  assert.equal(child.plan.model, f.parent.parentModel);
  assert.equal(child.plan.maxTurns, 3);
  assert.deepEqual(child.plan.budget, { ownership: "independent-query" });
  assert.ok(Object.isFrozen(child.plan));
  assert.ok(Array.isArray(result.apiContent));
  assert.equal(result.apiContent?.[0]?.type, "text");
  assert.match(result.content, /OWNED_AGENT_CHILD_FINAL/);
  assert.match(result.content, /subagent_tokens: 13/);
  assert.match(result.content, /tool_uses: 0/);
  assert.match(result.content, /no user authority/);
  assert.equal(field(result.hookResponse, "canContinueAgent"), false);
});

test("ordinary unsupported async/fork/isolation/resume/team paths fail before running a child", async () => {
  const f = await setup();
  for (const patch of [
    { run_in_background: undefined },
    { run_in_background: true },
    { isolation: "worktree" },
    { isolation: "remote" },
    { resume: "old" },
    { name: "teammate" },
    { team_name: "team" },
    { cwd: "/other" },
  ]) {
    const result = await f.runtime.execute(call(input(patch)), signal());
    assert.equal(result.is_error, true);
    assert.match(
      result.content,
      /unsupported|does not support|requires explicit/,
    );
  }
  assert.equal(f.children.length, 0);
  for (const patch of [
    { background: true as const },
    { isolation: "worktree" as const },
    { isolation: "remote" as const },
    { agentType: "fork" },
  ]) {
    const fixture = await setup({}, [definition(patch)]),
      requested = patch.agentType ?? "owned-reader";
    assert.equal(
      (
        await fixture.runtime.execute(
          call(input({ subagent_type: requested })),
          signal(),
        )
      ).is_error,
      true,
    );
    assert.equal(fixture.children.length, 0);
  }
  const forced = await setup({}, undefined, { foregroundAllowed: false });
  assert.match(
    (await forced.runtime.execute(call(), signal())).content,
    /host launch policy/,
  );
});

test("exact names win and normalized fallback refuses ambiguous or unavailable candidates", async () => {
  const f = await setup({}, [
    definition(),
    definition({ agentType: "Owned Reader" }),
  ]);
  assert.equal((await f.runtime.execute(call(), signal())).is_error, undefined);
  assert.match(
    (
      await f.runtime.execute(
        call(input({ subagent_type: "OWNED_READER" })),
        signal(),
      )
    ).content,
    /ambiguous/,
  );
  assert.match(
    (
      await f.runtime.execute(
        call(input({ subagent_type: "absent" })),
        signal(),
      )
    ).content,
    /not found/,
  );
  const single = await setup();
  assert.equal(
    (
      await single.runtime.execute(
        call(input({ subagent_type: "ＯＷＮＥＤ_READER" })),
        signal(),
      )
    ).is_error,
    undefined,
  );
  const limited = await setup({}, undefined, {
    allowedAgentTypes: ["owned-reader"],
  });
  assert.equal(
    (
      await limited.runtime.execute(
        call(input({ subagent_type: "OWNED_READER" })),
        signal(),
      )
    ).is_error,
    true,
  );
  const defaultAlias = await setup(
    {},
    [definition({ agentType: "General Purpose" })],
    { allowedAgentTypes: ["General Purpose"] },
  );
  assert.equal(
    (
      await defaultAlias.runtime.execute(
        call(input({ subagent_type: undefined })),
        signal(),
      )
    ).is_error,
    undefined,
  );
});

test("parent deny/ask and mode caps survive hook allow and child definition grants", async () => {
  let launched = 0;
  const denied = await setup({
    hooks: {
      async before() {
        return {
          permission: "allow",
          additionalContext: [],
          preventContinuation: false,
        };
      },
      async after(_c, result) {
        return result;
      },
    },
    authorize: () => "parent deny",
    runChild: async () => {
      launched++;
      return { messages: [] };
    },
  });
  const result = await denied.runtime.execute(call(), signal());
  assert.equal(result.permissionDenied, true);
  assert.equal(launched, 0);
  const capped = await setup({
    resolvePermissionMode: () => "bypassPermissions",
  });
  assert.match(
    (await capped.runtime.execute(call(), signal())).content,
    /parent cap/,
  );
  assert.equal(capped.children.length, 0);
  let checks = 0;
  const childFloor = await setup({
    authorizeChildTool: () => {
      checks++;
      return "parent ask was not approved";
    },
    runChild: async (request) => {
      const deniedRead = await request.tools.execute(
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: "/owned/file" },
        },
        request.signal,
      );
      const outside = await request.tools.execute(
        { type: "tool_use", id: "edit", name: "Edit", input: {} },
        request.signal,
      );
      assert.equal(deniedRead.permissionDenied, true);
      assert.equal(outside.permissionDenied, true);
      return {
        messages: [
          ...request.messages,
          assistant("Unable to read under the parent floor"),
        ],
      };
    },
  });
  assert.equal(
    (await childFloor.runtime.execute(call(), signal())).is_error,
    undefined,
  );
  assert.equal(checks, 1);
  assert.equal(childFloor.executions.length, 0);
});

test("depth caps include hook depth and remove recursive Agent aliases at the boundary", async () => {
  const unrestricted = definition();
  delete unrestricted.tools;
  const atBoundary = await setup({}, [unrestricted], {
    depth: 2,
    maxDepth: 3,
    availableTools: [tool("Read"), tool("Agent"), tool("Task")],
  });
  assert.equal(
    (await atBoundary.runtime.execute(call(), signal())).is_error,
    undefined,
  );
  assert.deepEqual(
    first(atBoundary.children).tools.definitions.map((t) => t.name),
    ["Read"],
  );
  const blocked = await setup({}, undefined, {
    depth: 1,
    hookDepth: 3,
    maxDepth: 3,
  });
  assert.match(
    (await blocked.runtime.execute(call(), signal())).content,
    /nesting limit reached/,
  );
  assert.equal(blocked.children.length, 0);
});

test("tool selection cannot widen parent/definition scope; zero intentional tools remain valid", async () => {
  const widening = await setup({ selectTools: () => ["Bash"] });
  assert.match(
    (await widening.runtime.execute(call(), signal())).content,
    /widen tool access/,
  );
  const missing = await setup({}, [definition({ tools: ["Unavailable"] })]);
  assert.match(
    (await missing.runtime.execute(call(), signal())).content,
    /zero available tools/,
  );
  const empty = await setup({}, [definition({ tools: [] })]);
  assert.equal(
    (await empty.runtime.execute(call(), signal())).is_error,
    undefined,
  );
  assert.deepEqual(first(empty.children).tools.definitions, []);
  const scoped = await setup({}, [definition({ tools: ["Bash(git status)"] })]);
  assert.match(
    (await scoped.runtime.execute(call(), signal())).content,
    /host scope resolver/,
  );
  const scopeHost = await setup({ selectTools: () => ["Bash"] }, [
    definition({ tools: ["Bash(git status)"] }),
  ]);
  assert.equal(
    (await scopeHost.runtime.execute(call(), signal())).is_error,
    undefined,
  );
});

test("model/mode/materialization receive passive metadata and preserve query/cost/compaction ownership", async () => {
  const resolutions: Parameters<SubagentRuntimeOptions["resolveModel"]>[0][] =
      [],
    policies: Parameters<SubagentRuntimeOptions["resolvePermissionMode"]>[0][] =
      [];
  const f = await setup(
    {
      resolveModel: (request) => {
        resolutions.push(request);
        return "host-resolved-model";
      },
      resolvePermissionMode: (request) => {
        policies.push(request);
        return "default";
      },
    },
    [
      definition({
        model: "declared-model",
        effort: 7,
        autoCompactWindow: 200000,
      }),
    ],
    { inheritedAutoCompactWindow: 150000, sharedSessionCostCapUsd: 2 },
  );
  Object.assign(f.parent, {
    attemptBudget: { count: 1 },
    maxTurns: 1,
    maxOutputTokens: 9,
    messages: [assistant("PARENT_PRIVATE_CONTEXT")],
  });
  assert.equal(
    (
      await f.runtime.execute(
        call(
          input({ model: "haiku", effort: "low", mode: "bypassPermissions" }),
        ),
        signal(),
      )
    ).is_error,
    undefined,
  );
  const resolution = resolutions.at(-1),
    policy = policies.at(-1);
  assert.ok(resolution && policy);
  assert.equal(resolution.input.model, "haiku");
  assert.equal(resolution.definition.model, "declared-model");
  assert.equal(policy.model, "host-resolved-model");
  const plan = first(f.children).plan;
  assert.equal(plan.effort, "low");
  assert.equal(plan.maxTurns, 3);
  assert.deepEqual(plan.compaction, {
    inherited: 150000,
    declaredCeiling: 200000,
  });
  assert.deepEqual(plan.budget, {
    ownership: "independent-query",
    sharedSessionCostCapUsd: 2,
  });
  for (const key of [
    "attemptBudget",
    "maxTurns",
    "maxOutputTokens",
    "messages",
  ])
    assert.equal(key in plan.parent, false);
  assert.equal(
    JSON.stringify(first(f.children).messages).includes(
      "PARENT_PRIVATE_CONTEXT",
    ),
    false,
  );
});

test("unhandled execution features and missing parent-floor enforcement fail explicitly", async () => {
  const required = await setup({}, [
    definition({ memory: "user", skills: ["owned-skill"] }),
  ]);
  assert.match(
    (await required.runtime.execute(call(), signal())).content,
    /memory|skills/,
  );
  assert.equal(required.children.length, 0);
  const unsafe = await setup({
    materialize: () => {
      const materialization: SubagentMaterialization = {
        system: "owned",
        enforcesParentPolicy: true,
        tools: {
          definitions: [],
          async execute() {
            throw new Error("never");
          },
        },
      };
      Reflect.deleteProperty(materialization, "enforcesParentPolicy");
      return materialization;
    },
  });
  assert.match(
    (await unsafe.runtime.execute(call(), signal())).content,
    /enforce parent/,
  );
});

test("SubagentStart feedback is child context and SubagentStop continuation must run inside the child loop", async () => {
  const events: string[] = [];
  const f = await setup({
    lifecycle: {
      async start() {
        events.push("start");
        return ["Owned SubagentStart feedback"];
      },
      async stop(_plan, event) {
        events.push("stop");
        event.messages.push(assistant("MUTATED_HOOK_COPY"));
        return { continue: false, additionalContext: [] };
      },
    },
    materialize: (plan) => ({
      system: plan.definition.prompt,
      enforcesParentPolicy: true,
      cleanup() {
        events.push("cleanup");
      },
      tools: {
        definitions: [],
        async execute() {
          throw new Error("unused");
        },
      },
    }),
    runChild: async (request) => {
      events.push("run");
      const feedback = request.messages.at(-1)?.content[0];
      assert.ok(feedback?.type === "text");
      assert.equal(feedback.text, "Owned SubagentStart feedback");
      const messages = [...request.messages, assistant("child result")];
      assert.ok(request.stopHook);
      await request.stopHook({
        messages,
        signal: request.signal,
        stopHookActive: false,
      });
      assert.equal(
        JSON.stringify(messages).includes("MUTATED_HOOK_COPY"),
        false,
      );
      return { messages };
    },
  });
  assert.equal((await f.runtime.execute(call(), signal())).is_error, undefined);
  assert.deepEqual(events, ["start", "run", "stop", "cleanup"]);
  const ignored = await setup({
    lifecycle: {
      async stop() {
        return {
          continue: true,
          additionalContext: ["owned required continuation"],
        };
      },
    },
  });
  assert.match(
    (await ignored.runtime.execute(call(), signal())).content,
    /did not process/,
  );
});

test("parent cancellation relays to the child and always cleans materialization", async () => {
  const controller = new AbortController();
  let cleanup = 0,
    interrupted = 0,
    entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await setup({
    materialize: () => ({
      system: "owned",
      enforcesParentPolicy: true,
      cleanup() {
        cleanup++;
      },
      tools: {
        definitions: [],
        async execute() {
          throw new Error("unused");
        },
      },
    }),
    lifecycle: {
      interrupted() {
        interrupted++;
      },
    },
    runChild: (request) =>
      new Promise((_resolve, reject) => {
        entered();
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("owned aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const pending = f.runtime.execute(call(), controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cleanup, 1);
  assert.equal(interrupted, 1);
});

test("report selection uses latest nonblank assistant text and last usage rather than accumulating child replies", async () => {
  const f = await setup();
  await f.runtime.execute(call(), signal());
  const plan = first(f.children).plan;
  const report = foregroundSubagentReport(
    [
      assistant("earlier", 100, 30),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call", name: "Read", input: {} }],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 2,
        },
      },
    ],
    plan,
    42,
  );
  assert.deepEqual(report.content, [{ type: "text", text: "earlier" }]);
  assert.equal(report.totalTokens, 15);
  assert.equal(report.totalToolUseCount, 1);
  const partial = foregroundSubagentReport(
    [assistant("partial")],
    plan,
    42,
    "max_turns",
  );
  const [partialText] = partial.content;
  assert.ok(partialText);
  assert.match(partialText.text, /partial/);
});

test("parent/child runAgent queries have independent turn/attempt accounting and isolated request history", async () => {
  let parentCalls = 0,
    childCalls = 0,
    globalInput = 0,
    globalOutput = 0;
  const budgets: CompletionRequest["attemptBudget"][] = [],
    childRequests: Pick<
      CompletionRequest,
      "system" | "messages" | "tools" | "maxTokens"
    >[] = [],
    parentRequests: Pick<
      CompletionRequest,
      "messages" | "tools" | "maxTokens"
    >[] = [];
  const f = await setup({
    runChild: async (request) => {
      const childProvider: Provider = {
        async complete(api) {
          childRequests.push(
            structuredClone({
              system: api.system,
              messages: api.messages,
              tools: api.tools,
              maxTokens: api.maxTokens,
            }),
          );
          budgets.push(api.attemptBudget);
          assert.ok(api.attemptBudget?.take());
          childCalls++;
          globalInput += 10;
          globalOutput += 3;
          return {
            content:
              childCalls === 1
                ? [
                    {
                      type: "tool_use",
                      id: "owned-child-read",
                      name: "Read",
                      input: { file_path: "/owned/file" },
                    },
                  ]
                : [{ type: "text", text: "OWNED_AGENT_CHILD_FINAL" }],
            stop_reason: childCalls === 1 ? "tool_use" : "end_turn",
            usage: { input_tokens: 10, output_tokens: 3 },
          };
        },
      };
      const { stopHook } = request;
      assert.ok(request.plan.maxTurns);
      const result = await runAgent({
        provider: childProvider,
        tools: request.tools,
        messages: request.messages,
        model: request.plan.model,
        system: request.system,
        maxTokens: 32000,
        maxTurns: request.plan.maxTurns,
        maxApiAttempts: 3,
        autoCompact: false,
        signal: request.signal,
        onEvent() {},
        ...(stopHook
          ? {
              stopHook: async (event) => {
                const result = await stopHook(event);
                return {
                  ...result,
                  additionalContext: [...result.additionalContext],
                };
              },
            }
          : {}),
      });
      assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 6 });
      return { messages: result.messages };
    },
  });
  const parentProvider: Provider = {
    async complete(api) {
      parentRequests.push(
        structuredClone({
          messages: api.messages,
          tools: api.tools,
          maxTokens: api.maxTokens,
        }),
      );
      budgets.push(api.attemptBudget);
      assert.ok(api.attemptBudget?.take());
      parentCalls++;
      globalInput += 10;
      globalOutput += 3;
      return {
        content:
          parentCalls === 1
            ? [call()]
            : [{ type: "text", text: "OWNED_PARENT_FINAL" }],
        stop_reason: parentCalls === 1 ? "tool_use" : "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      };
    },
  };
  const parentMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "PARENT_PRIVATE_CONTEXT" }],
    },
  ];
  const result = await runAgent({
    provider: parentProvider,
    tools: f.runtime,
    messages: parentMessages,
    model: f.parent.parentModel,
    system: "OWNED_PARENT_SYSTEM",
    maxTokens: 17,
    maxTurns: 2,
    maxApiAttempts: 2,
    autoCompact: false,
    signal: signal(),
    onEvent() {},
  });
  assert.equal(parentCalls, 2);
  assert.equal(childCalls, 2);
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 6 });
  assert.equal(globalInput, 40);
  assert.equal(globalOutput, 12);
  assert.notEqual(budgets[0], budgets[1]);
  assert.equal(budgets[0], budgets[3]);
  assert.equal(budgets[1], budgets[2]);
  assert.equal(parentRequests[0]?.maxTokens, 17);
  assert.equal(childRequests[0]?.maxTokens, 32000);
  assert.equal(childRequests[0]?.system, "OWNED_AGENT_SYSTEM_READER");
  assert.deepEqual(
    childRequests[0]?.tools.map((t) => t.name),
    ["Read"],
  );
  assert.equal(
    JSON.stringify(childRequests).includes("PARENT_PRIVATE_CONTEXT"),
    false,
  );
  const parentTools = parentMessages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_use");
  assert.equal(parentTools.length, 1);
  assert.equal(parentTools[0]?.name, "Agent");
  const parentResult = parentMessages[2]?.content[0];
  assert.ok(parentResult?.type === "tool_result");
  assert.match(parentResult.content, /subagent_tokens: 13/);
  assert.match(parentResult.content, /tool_uses: 1/);
});

const launchResult = (plan: Readonly<SubagentPlan>): SubagentAsyncLaunch => ({
  isAsync: true,
  status: "async_launched",
  agentId: plan.agentId,
  description: plan.input.description,
  resolvedModel: plan.model,
  prompt: plan.input.prompt,
  outputFile: `/owned/${plan.agentId}.json`,
  canReadOutputFile: true,
  canContinueAgent: false,
});
const launchMode = (
  value: Readonly<import("../../src/subagent-runtime.js").ForegroundAgentInput>,
  agent: Readonly<LocalAgentDefinition>,
  disabled = false,
) =>
  ordinaryLocalAgentLaunchMode({
    ...(value.run_in_background === undefined
      ? {}
      : { requestedBackground: value.run_in_background }),
    ...(agent.background === undefined
      ? {}
      : { definitionBackground: agent.background }),
    backgroundTasksDisabled: disabled,
    defaultAsync: true,
  });

test("background dispatch shares admitted planning once and never materializes or runs the foreground branch", async () => {
  const order: string[] = [];
  const admittedPlans: Readonly<SubagentPlan>[] = [];
  const original = call(input({ run_in_background: undefined })),
    before = structuredClone(original);
  const f = await setup({
    hooks: {
      async before(_call, _signal, validate) {
        order.push("pre");
        const replaced = await validate(
          input({ run_in_background: true, prompt: "OWNED_PRE_REPLACEMENT" }),
        );
        return {
          updatedInput: replaced,
          additionalContext: [],
          preventContinuation: false,
        };
      },
      async after(_call, result) {
        order.push("post");
        return result;
      },
    },
    authorize: (call) => {
      order.push("authorize");
      assert.equal(field(call.input, "prompt"), "OWNED_PRE_REPLACEMENT");
      return true;
    },
    resolveModel: () => {
      order.push("model");
      return "owned-child-model";
    },
    resolvePermissionMode: (request) => {
      order.push("mode");
      assert.equal(request.isAsync, true);
      return "default";
    },
    selectTools: (_definition, _parent, context) => {
      order.push("scope");
      assert.ok(context);
      assert.equal(context.isAsync, true);
      return ["Read"];
    },
    admitChild: (plan) => {
      order.push("admit");
      admittedPlans.push(plan);
      return true;
    },
    background: {
      resolveLaunchMode(value, agent) {
        order.push("resolve-launch");
        assert.ok(Object.isFrozen(value));
        return launchMode(value, agent);
      },
      async launch(plan) {
        order.push("launch");
        assert.equal(plan, admittedPlans.at(-1));
        assert.ok(Object.isFrozen(plan));
        return launchResult(plan);
      },
    },
    materialize() {
      throw new Error("foreground materialization must not run");
    },
    runChild() {
      throw new Error("foreground query must not run");
    },
    lifecycle: {
      async start() {
        throw new Error("foreground Start must not run");
      },
    },
  });
  const result = await f.runtime.execute(original, signal());
  assert.equal(result.is_error, undefined);
  assert.deepEqual(original, before);
  const required = first(f.runtime.definitions).input_schema.required;
  assert.ok(required);
  assert.equal(required.includes("run_in_background"), false);
  assert.deepEqual(order, [
    "pre",
    "authorize",
    "resolve-launch",
    "model",
    "mode",
    "scope",
    "admit",
    "launch",
    "post",
  ]);
  const admitted = admittedPlans.at(-1);
  assert.ok(admitted);
  assert.equal(admitted.isAsync, true);
  assert.deepEqual(admitted.selectedToolNames, ["Read"]);
  assert.equal(admitted.input.prompt, "OWNED_PRE_REPLACEMENT");
  assert.equal(field(result.hookResponse, "status"), "async_launched");
  assert.ok(Array.isArray(result.apiContent));
  assert.match(result.content, /task notification/);
  assert.equal(f.children.length, 0);
  assert.equal(field(result.effectiveToolInput, "run_in_background"), true);
});

test("host launch resolver handles omitted/true/definition background and disabled fallback without changing tool input", async () => {
  for (const { requested, declared, disabled, expected } of [
    { requested: undefined, declared: false, disabled: false, expected: true },
    { requested: true, declared: false, disabled: false, expected: true },
    { requested: false, declared: true, disabled: false, expected: true },
    { requested: true, declared: false, disabled: true, expected: false },
    { requested: false, declared: false, disabled: false, expected: false },
  ]) {
    let launched = 0;
    const f = await setup(
      {
        background: {
          resolveLaunchMode: (value, agent) =>
            launchMode(value, agent, disabled),
          async launch(plan) {
            launched++;
            return launchResult(plan);
          },
        },
      },
      [definition(declared ? { background: true } : {})],
    );
    const original = call(input({ run_in_background: requested })),
      before = structuredClone(original);
    const result = await f.runtime.execute(original, signal());
    assert.equal(result.is_error, undefined);
    assert.deepEqual(original, before);
    assert.equal(launched, expected ? 1 : 0);
    assert.equal(f.children.length, expected ? 0 : 1);
    if (!expected) {
      const child = first(f.children);
      assert.equal(child.plan.isAsync, false);
      assert.equal(child.plan.input.run_in_background, requested);
    }
  }
});

test("background planning preserves parent authorization, mode/depth/tool caps and host admission", async () => {
  let launches = 0;
  const background: NonNullable<SubagentRuntimeOptions["background"]> = {
    resolveLaunchMode: () => "background",
    async launch(plan) {
      launches++;
      return launchResult(plan);
    },
  };
  for (const overrides of [
    { authorize: () => "OWNED_PARENT_DENY" },
    { resolvePermissionMode: () => "bypassPermissions" as const },
    { selectTools: () => ["Bash"] },
    { admitChild: () => "OWNED_HOST_REFUSAL" },
  ]) {
    const f = await setup({ background, ...overrides });
    const result = await f.runtime.execute(
      call(input({ run_in_background: true })),
      signal(),
    );
    assert.equal(result.is_error, true);
    assert.equal(f.children.length, 0);
  }
  const deep = await setup({ background }, undefined, { depth: 3 });
  assert.match(
    (
      await deep.runtime.execute(
        call(input({ run_in_background: true })),
        signal(),
      )
    ).content,
    /nesting limit/,
  );
  const forced = await setup({ background }, undefined, {
    foregroundAllowed: false,
  });
  assert.match(
    (
      await forced.runtime.execute(
        call(input({ run_in_background: true })),
        signal(),
      )
    ).content,
    /host launch policy/,
  );
  assert.equal(launches, 0);
});

test("unsupported input and definition execution modes stay explicit even with a background adapter", async () => {
  let pre = 0,
    launched = 0;
  const background: NonNullable<SubagentRuntimeOptions["background"]> = {
    resolveLaunchMode: () => "background",
    async launch(plan) {
      launched++;
      return launchResult(plan);
    },
  };
  const f = await setup({
    background,
    hooks: {
      async before() {
        pre++;
        return { additionalContext: [], preventContinuation: false };
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  for (const patch of [
    { resume: "old" },
    { isolation: "remote" },
    { isolation: "worktree" },
    { team_name: "owned-team" },
    { name: "owned-name" },
    { cwd: "/other" },
  ]) {
    assert.equal(
      (
        await f.runtime.execute(
          call(input({ run_in_background: true, ...patch })),
          signal(),
        )
      ).inputRejected,
      true,
    );
  }
  assert.equal(pre, 0);
  for (const agent of [
    definition({ agentType: "fork" }),
    definition({ isolation: "worktree" }),
    definition({ isolation: "remote" }),
  ]) {
    const rejected = await setup({ background }, [agent]);
    assert.equal(
      (
        await rejected.runtime.execute(
          call(
            input({ subagent_type: agent.agentType, run_in_background: true }),
          ),
          signal(),
        )
      ).is_error,
      true,
    );
  }
  assert.equal(launched, 0);
});

test("PostToolUse validates both completed and async outputs while launch callback identity stays admitted", async () => {
  let post = 0;
  const background: NonNullable<SubagentRuntimeOptions["background"]> = {
    resolveLaunchMode: () => "background",
    async launch(plan) {
      return launchResult(plan);
    },
  };
  const f = await setup({
    background,
    hooks: {
      async before() {
        return { additionalContext: [], preventContinuation: false };
      },
      async after(_call, result, _signal, validate) {
        post++;
        assert.ok(validate);
        return validate(
          {
            ...asObject(result.hookResponse),
            outputFile: "/owned/post.json",
          },
          result,
        );
      },
    },
  });
  const result = await f.runtime.execute(
    call(input({ run_in_background: true })),
    signal(),
  );
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /post.json/);
  assert.equal(post, 1);
  const foreground = await setup({
    hooks: {
      async before() {
        return { additionalContext: [], preventContinuation: false };
      },
      async after(_call, result, _signal, validate) {
        assert.ok(validate);
        return validate(
          {
            ...asObject(result.hookResponse),
            content: [{ type: "text", text: "OWNED_FOREGROUND_POST" }],
          },
          result,
        );
      },
    },
  });
  const completed = await foreground.runtime.execute(call(), signal());
  assert.equal(completed.is_error, undefined);
  assert.match(completed.content, /OWNED_FOREGROUND_POST/);
  const invalid = await setup({
    background,
    hooks: {
      async before() {
        return { additionalContext: [], preventContinuation: false };
      },
      async after(_call, result, _signal, validate) {
        assert.ok(validate);
        return validate(
          { status: "async_launched", isAsync: "invalid" },
          result,
        );
      },
    },
  });
  assert.equal(
    (
      await invalid.runtime.execute(
        call(input({ run_in_background: true })),
        signal(),
      )
    ).is_error,
    true,
  );
  const identity = await setup({
    background: {
      ...background,
      async launch(plan) {
        return { ...launchResult(plan), agentId: "OTHER_AGENT" };
      },
    },
  });
  assert.match(
    (
      await identity.runtime.execute(
        call(input({ run_in_background: true })),
        signal(),
      )
    ).content,
    /changed admitted agent identity/,
  );
});

test("shared background callback returns before a separately owned scheduler child finishes", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let childStarted = false;
  const scheduler = createBackgroundAgentRuntime({
    sessionId: "owned-session",
    admit: () => true,
    materialize: () => ({
      system: "OWNED_BACKGROUND_SYSTEM",
      tools: {
        definitions: [],
        async execute() {
          throw new Error("unused");
        },
      },
      enforcesLiveParentPolicy: true,
      enforcesBackgroundToolScope: true,
      permissionPrompts: "avoid",
    }),
    authorizeTool: () => true,
    async runChild(request) {
      childStarted = true;
      await gate;
      return {
        messages: [...request.messages, assistant("OWNED_BACKGROUND_FINAL")],
      };
    },
    outputFile: (plan) => `/owned/${plan.agentId}.json`,
    canReadOutputFile: () => true,
    async persist() {},
    enqueueNotification() {},
    async cleanupTask() {
      return 0;
    },
    watchdog: { kind: "unsupported" },
  });
  const f = await setup({
    background: {
      resolveLaunchMode: (value) =>
        value.run_in_background === false ? "foreground" : "background",
      launch: (plan, admissionSignal) =>
        scheduler.launch(plan, { admissionSignal }),
    },
    materialize() {
      throw new Error("inline foreground materialization");
    },
    runChild() {
      throw new Error("inline foreground query");
    },
  });
  const result = await f.runtime.execute(
    call(input({ run_in_background: true })),
    signal(),
  );
  assert.equal(result.is_error, undefined);
  assert.equal(childStarted, true);
  assert.equal(scheduler.hasRunning, true);
  finish();
  await scheduler.settled();
  assert.equal(
    scheduler.get("owned-agent-id").result?.content[0]?.text,
    "OWNED_BACKGROUND_FINAL",
  );
});
