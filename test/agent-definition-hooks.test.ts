import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDefinitionHookOriginTrusted,
  createAgentDefinitionHookScope,
  validateAgentDefinitionHooks,
  type AgentDefinitionHookScopeOptions,
} from "../src/agent-definition-hooks.js";
import {
  createHookRegistry,
  type CommandHook,
  type HookInput,
  type HookRunOptions,
} from "../src/hooks.js";
import { composeHookRegistries } from "../src/composite-hooks.js";
import { createToolHookRuntime } from "../src/tool-hook-runtime.js";
import { createTools } from "../src/tools.js";
import type { LocalAgentDefinition } from "../src/agent-definitions.js";

const signal = () => new AbortController().signal;
const definition = (hooks: unknown): LocalAgentDefinition => ({
  agentType: "owned-agent",
  source: "userSettings",
  prompt: "OWNED AGENT",
  whenToUse: "Owned fixture",
  skills: [],
  hooks,
});
function hook(value: unknown, extra: Partial<CommandHook> = {}): CommandHook {
  return {
    type: "command",
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`,
    ],
    ...extra,
  };
}
function options(
  hooks: unknown,
  changes: Partial<AgentDefinitionHookScopeOptions> = {},
): AgentDefinitionHookScopeOptions {
  return {
    agentId: "owned-child",
    ownerSessionId: "owned-session",
    definition: definition(hooks),
    policy: () => ({
      disabled: false,
      managedOnly: false,
      strictPluginOnly: false,
    }),
    admitDefinition: () => true,
    admitOrigin: () => true,
    provenance: () => ({ personal: false, checkout: false }),
    admitExecution: () => true,
    ...changes,
  };
}
const input = (
  event: HookInput["hook_event_name"],
  patch: Partial<HookInput> = {},
): HookInput => ({
  hook_event_name: event,
  session_id: "owned-session",
  transcript_path: "/owned/parent.jsonl",
  cwd: "/owned",
  agent_id: "owned-child",
  agent_type: "owned-agent",
  tool_use_id: "owned-tool",
  tool_input: {},
  stop_hook_active: false,
  agent_transcript_path: "/owned/child.jsonl",
  ...patch,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-owned-agent-hooks-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const run: HookRunOptions = {
    cwd: directory,
    projectDir: directory,
    env: {},
    signal: signal(),
    defaultTimeoutMs: 3000,
  };
  return { directory, run };
}

test("definition validator preserves supported metadata and rejects unknown guards/transports/events without execution", () => {
  const once = hook({}, { once: true, async: true });
  const parsed = validateAgentDefinitionHooks({
    PreToolUse: [{ matcher: "Read", hooks: [once] }],
  });
  assert.equal(parsed.PreToolUse?.[0]?.hooks[0]?.once, true);
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(
    () => validateAgentDefinitionHooks({ PermissionRequest: [] }),
    /Unsupported agent hook event/,
  );
  assert.throws(
    () =>
      validateAgentDefinitionHooks({
        PreToolUse: [{ matcher: "Read", guard: {}, hooks: [once] }],
      }),
    /guard/,
  );
  assert.throws(() =>
    validateAgentDefinitionHooks({
      PreToolUse: [{ hooks: [{ type: "prompt", prompt: "OWNED" }] }],
    }),
  );
  assert.throws(
    () =>
      validateAgentDefinitionHooks({
        PreToolUse: [{ hooks: [{ ...once, guard: true }] }],
      }),
    /guard/,
  );
  assert.throws(
    () =>
      validateAgentDefinitionHooks({
        PreToolUse: [{ hooks: [hook({}, { asyncRewake: true })] }],
      }),
    /wake/,
  );
  assert.throws(
    () =>
      validateAgentDefinitionHooks({
        PreToolUse: [{ hooks: [hook({}, { if: "owned-condition" })] }],
      }),
    /condition/,
  );
  assert.equal(
    validateAgentDefinitionHooks(
      { PreToolUse: [{ hooks: [hook({}, { if: "owned-condition" })] }] },
      { matchesCondition: () => true },
    ).PreToolUse?.length,
    1,
  );
});

test("resolved origin trust uses actual definition folder independently of the current workspace", () => {
  const def = definition({});
  assert.equal(
    agentDefinitionHookOriginTrusted(
      { ...def, source: "plugin" },
      { workingDirectoryTrusted: false },
    ),
    true,
  );
  assert.equal(
    agentDefinitionHookOriginTrusted(def, { workingDirectoryTrusted: false }),
    true,
  );
  const project = {
    ...def,
    source: "projectSettings",
    baseDir: "/owned/additional/.claude/agents",
  } satisfies LocalAgentDefinition;
  assert.equal(
    agentDefinitionHookOriginTrusted(project, {
      workingDirectoryTrusted: true,
    }),
    false,
  );
  assert.equal(
    agentDefinitionHookOriginTrusted(project, {
      workingDirectoryTrusted: false,
      definitionFolderTrusted: true,
    }),
    true,
  );
  const noFolder = {
    ...def,
    source: "projectSettings",
  } satisfies LocalAgentDefinition;
  assert.equal(
    agentDefinitionHookOriginTrusted(noFolder, {
      workingDirectoryTrusted: true,
    }),
    true,
  );
});

test("definition hooks are absent before Start and declared Stop maps to typed SubagentStop afterward", async () => {
  const { run } = await fixture(),
    scope = createAgentDefinitionHookScope(
      options({
        SubagentStart: [
          {
            matcher: "owned-agent",
            hooks: [
              hook({
                hookSpecificOutput: {
                  hookEventName: "SubagentStart",
                  additionalContext: "SHOULD NOT SELF-START",
                },
              }),
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              hook({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: "OWNED PRE",
                },
              }),
            ],
          },
        ],
        Stop: [
          {
            matcher: "^owned-agent$",
            hooks: [
              hook({
                hookSpecificOutput: {
                  hookEventName: "SubagentStop",
                  additionalContext: "OWNED STOP",
                },
              }),
            ],
          },
        ],
      }),
    );
  onTestFinished(() => scope.close());
  assert.equal(scope.registry.list().length, 0);
  assert.equal(
    (await scope.registry.run(input("SubagentStart"), run)).results.length,
    0,
  );
  assert.equal((await scope.afterStart(signal())).registered, true);
  assert.equal(scope.registry.list("Stop").length, 0);
  assert.equal(scope.registry.list("SubagentStop").length, 1);
  assert.deepEqual(
    (await scope.registry.run(input("PreToolUse", { tool_name: "Read" }), run))
      .additionalContext,
    ["OWNED PRE"],
  );
  assert.deepEqual(
    (await scope.registry.run(input("SubagentStop"), run)).additionalContext,
    ["OWNED STOP"],
  );
  assert.equal(
    (
      await scope.registry.run(
        input("SubagentStart", { agent_id: "owned-grandchild" }),
        run,
      )
    ).results.length,
    0,
  );
  await assert.rejects(scope.afterStart(signal()), /exactly once/);
});

test("agent once declaration remains metadata and does not acquire skill-success one-shot semantics", async () => {
  const { run } = await fixture(),
    scope = createAgentDefinitionHookScope(
      options({
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              hook(
                {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    additionalContext: "OWNED REPEATED",
                  },
                },
                { once: true },
              ),
            ],
          },
        ],
      }),
    );
  onTestFinished(() => scope.close());
  await scope.afterStart(signal());
  assert.equal(scope.declaration.PreToolUse?.[0]?.hooks[0]?.once, true);
  assert.equal(scope.registry.list("PreToolUse")[0]?.hook.once, true);
  for (let count = 0; count < 2; count++)
    assert.deepEqual(
      (
        await scope.registry.run(
          input("PreToolUse", { tool_name: "Read" }),
          run,
        )
      ).additionalContext,
      ["OWNED REPEATED"],
    );
});

test("mapping and command identity replace same-matcher entries in place without skill quotas", async () => {
  const { run } = await fixture(),
    command = hook({
      hookSpecificOutput: {
        hookEventName: "SubagentStop",
        additionalContext: "OWNED REPLACED",
      },
    });
  const scope = createAgentDefinitionHookScope(
    options({
      Stop: [{ hooks: [{ ...command, timeout: 1 }] }],
      SubagentStop: [{ hooks: [{ ...command, timeout: 2 }] }],
    }),
  );
  onTestFinished(() => scope.close());
  assert.equal((await scope.afterStart(signal())).count, 1);
  assert.equal(scope.registry.list()[0]?.hook.timeout, 2);
  assert.equal(
    (await scope.registry.run(input("SubagentStop"), run)).results.length,
    1,
  );
});

test("origin/policy failures skip registration while revoked definition admission fails explicitly", async () => {
  const hooks = { PreToolUse: [{ hooks: [hook({})] }] };
  for (const change of [
    { admitOrigin: () => false },
    {
      policy: () => ({
        disabled: true,
        managedOnly: false,
        strictPluginOnly: false,
      }),
    },
    {
      policy: () => ({
        disabled: false,
        managedOnly: false,
        strictPluginOnly: true,
      }),
    },
  ]) {
    const scope = createAgentDefinitionHookScope(options(hooks, change));
    const admission = await scope.afterStart(signal());
    assert.equal(admission.registered, false);
    assert.equal(scope.registry.list().length, 0);
    await scope.close();
  }
  const denied = createAgentDefinitionHookScope(
    options(hooks, { admitDefinition: () => false }),
  );
  await assert.rejects(denied.afterStart(signal()), /admission denied/);
  await denied.close();
});

test("managed/disabled live dispatch policy leaves borrowed settings registry alive and scoped cleanup local", async () => {
  const { run } = await fixture(),
    state = { disabled: false, managedOnly: false, strictPluginOnly: false };
  const scope = createAgentDefinitionHookScope(
    options(
      {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              hook({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: "OWNED CHILD",
                },
              }),
            ],
          },
        ],
      },
      { policy: () => state },
    ),
  );
  const inherited = createHookRegistry([
    {
      source: "policySettings",
      hooks: {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              hook({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: "OWNED SETTING",
                },
              }),
            ],
          },
        ],
      },
    },
  ]);
  onTestFinished(() => inherited.close());
  onTestFinished(() => scope.close());
  await scope.afterStart(signal());
  const combined = composeHookRegistries(inherited, scope.registry),
    call = input("PreToolUse", { tool_name: "Read" });
  assert.deepEqual(
    new Set((await combined.run(call, run)).additionalContext),
    new Set(["OWNED SETTING", "OWNED CHILD"]),
  );
  state.managedOnly = true;
  assert.deepEqual((await combined.run(call, run)).additionalContext, [
    "OWNED SETTING",
  ]);
  state.managedOnly = false;
  state.disabled = true;
  assert.deepEqual((await scope.registry.run(call, run)).additionalContext, []);
  scope.cleanup();
  assert.equal(scope.registry.list().length, 0);
  await scope.close();
  assert.deepEqual((await inherited.run(call, run)).additionalContext, [
    "OWNED SETTING",
  ]);
});

test("unified registration seam receives exact scope and original metadata without owning inherited registries", async () => {
  const { run } = await fixture();
  let cleared = 0,
    closed = 0,
    registered = false;
  const leaseRegistry = createHookRegistry([]);
  const scope = createAgentDefinitionHookScope(
    options(
      { Stop: [{ hooks: [hook({}, { once: true })] }] },
      {
        provenance: () => ({ personal: true, checkout: true }),
        register: (request) => {
          registered = true;
          assert.equal(request.agentId, "owned-child");
          assert.equal(request.ownerSessionId, "owned-session");
          assert.equal(request.provenance.personal, true);
          assert.equal(request.entries[0]?.event, "SubagentStop");
          assert.equal(request.entries[0]?.declaration.once, true);
          assert.equal(request.entries[0]?.execution.once, false);
          return {
            registry: leaseRegistry,
            clearRegistration: () => {
              cleared++;
            },
            close: async () => {
              closed++;
              await leaseRegistry.close();
            },
          };
        },
      },
    ),
  );
  await scope.afterStart(signal());
  assert.equal(registered, true);
  await assert.rejects(
    scope.registry.run(input("PreToolUse", { session_id: "other" }), run),
    /owning session/,
  );
  await assert.rejects(
    scope.registry.run(input("PreToolUse", { agent_id: "other" }), run),
    /different child/,
  );
  scope.cleanup();
  assert.equal(cleared, 1);
  assert.equal(closed, 0);
  await scope.close();
  assert.equal(closed, 1);
});

test("hook allow/rewrite retains ordinary parent plan floor and committed input ownership", async () => {
  const { directory, run } = await fixture();
  const scope = createAgentDefinitionHookScope(
    options({
      PreToolUse: [
        {
          matcher: "Write",
          hooks: [
            hook({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: {
                  file_path: "changed.md",
                  content: "OWNED REWRITTEN",
                },
              },
            }),
          ],
        },
      ],
    }),
  );
  onTestFinished(() => scope.close());
  await scope.afterStart(signal());
  const runtime = createToolHookRuntime({
    registry: scope.registry,
    context: () => ({
      session_id: "owned-session",
      transcript_path: "/owned/parent.jsonl",
      cwd: directory,
      agent_id: "owned-child",
      agent_type: "owned-agent",
    }),
    runOptions: () => run,
  });
  const tools = createTools({
    cwd: directory,
    mode: "plan",
    hooks: runtime,
    approve: async () => {
      throw new Error("No fake approval");
    },
  });
  const original = {
    type: "tool_use",
    id: "owned-write",
    name: "Write",
    input: { file_path: "original.md", content: "OWNED ORIGINAL" },
  } satisfies Parameters<typeof tools.execute>[0];
  const result = await tools.execute(original, signal());
  assert.equal(result.is_error, true);
  assert.deepEqual(original.input, {
    file_path: "original.md",
    content: "OWNED ORIGINAL",
  });
  await assert.rejects(readFile(join(directory, "original.md")));
  await assert.rejects(readFile(join(directory, "changed.md")));
});

test("registration cleanup keeps detached hook settlement alive, explicit close owns cancellation", async () => {
  const { directory, run } = await fixture(),
    log = join(directory, "owned-async.txt");
  const command: CommandHook = {
    type: "command",
    command: process.execPath,
    args: [
      "-e",
      `setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(log)},"OWNED ASYNC SETTLED");process.stdout.write("{}");},30)`,
    ],
    async: true,
    once: true,
  };
  const scope = createAgentDefinitionHookScope(
    options({ PreToolUse: [{ matcher: "Read", hooks: [command] }] }),
  );
  onTestFinished(() => scope.close());
  await scope.afterStart(signal());
  const result = await scope.registry.run(
    input("PreToolUse", { tool_name: "Read" }),
    run,
  );
  assert.equal(result.background.length, 1);
  assert.equal(scope.hasRunning(), true);
  scope.cleanup();
  assert.equal(scope.registry.list().length, 0);
  await scope.settle();
  assert.equal(await readFile(log, "utf8"), "OWNED ASYNC SETTLED");
  assert.equal(scope.hasRunning(), false);
  const completion = await result.background[0]?.completion;
  assert.equal(completion?.status, "success");
});

test("aborted or retired async registration never leaves an active scope or leaks its owned lease", async () => {
  const entered = Promise.withResolvers<void>(),
    ready =
      Promise.withResolvers<
        Awaited<
          ReturnType<NonNullable<AgentDefinitionHookScopeOptions["register"]>>
        >
      >();
  let removed = 0,
    closed = 0;
  const registry = createHookRegistry([]);
  const scope = createAgentDefinitionHookScope(
    options(
      { Stop: [{ hooks: [hook({})] }] },
      {
        register: () => {
          entered.resolve();
          return ready.promise;
        },
      },
    ),
  );
  const registration = scope.afterStart(signal());
  await entered.promise;
  await scope.close();
  ready.resolve({
    registry,
    clearRegistration: () => {
      removed++;
    },
    close: async () => {
      closed++;
      await registry.close();
    },
  });
  await assert.rejects(registration, /retired/);
  assert.equal(scope.registry.list().length, 0);
  assert.equal(removed, 1);
  assert.equal(closed, 1);
});

test("explicit scope teardown cancels only its detached owned command", async () => {
  const { directory, run } = await fixture(),
    log = join(directory, "owned-cancelled.txt");
  const scope = createAgentDefinitionHookScope(
    options({
      PreToolUse: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [
                "-e",
                `setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(log)},"SHOULD NOT COMPLETE");process.stdout.write("{}");},500)`,
              ],
              async: true,
            },
          ],
        },
      ],
    }),
  );
  await scope.afterStart(signal());
  const batch = await scope.registry.run(
    input("PreToolUse", { tool_name: "Read" }),
    run,
  );
  assert.equal(batch.background.length, 1);
  await scope.close();
  assert.equal((await batch.background[0]?.completion)?.status, "cancelled");
  assert.equal(scope.hasRunning(), false);
  await assert.rejects(readFile(log));
});
