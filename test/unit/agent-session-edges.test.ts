import assert from "node:assert/strict";
import { systemPromptText } from "../../src/system-prompt.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { createSessionAgentHost } from "../../src/agent-session.js";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";
import { parseToolPolicy } from "../../src/tool-policy.js";
import { createTools } from "../../src/tools.js";
import type { ToolHookRuntime } from "../../src/tool-hook-runtime.js";
import type {
  Completion,
  CompletionRequest,
  PermissionMode,
  Provider,
  ToolExecutor,
  ToolUse,
} from "../../src/types.js";

type HostOptions = Parameters<typeof createSessionAgentHost>[0];
const PARENT_MODEL = "claude-sonnet-4-6";

/** One agent file per entry: frontmatter fields plus a prompt body. */
async function fixture(setup: {
  agents: Record<string, string>;
  tools?: string;
  disallowedTools?: string[];
  env?: NodeJS.ProcessEnv;
  managed?: Record<string, unknown>;
}) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-agent-session-edges-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const user = join(cwd, "config"),
    managed = join(cwd, "managed");
  await mkdir(join(user, "agents"), { recursive: true });
  await mkdir(managed);
  for (const [name, body] of Object.entries(setup.agents))
    await writeFile(join(user, "agents", `${name}.md`), body);
  if (setup.managed)
    await writeFile(
      join(managed, "managed-settings.json"),
      JSON.stringify(setup.managed),
    );
  await writeFile(join(cwd, "notes.txt"), "NOTES_CONTENT");
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: user,
    TAU_MANAGED_ROOT: managed,
    ...(setup.env ?? {
      CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
      CLAUDE_CODE_FORK_SUBAGENT: "0",
    }),
  };
  const tools = setup.tools ?? "Agent,Read";
  const launch = await loadLaunchConfiguration(
    parseOptions(["--tools", tools]),
    { cwd, env, homeDirectory: cwd, nonInteractive: true },
  );
  const policy = parseToolPolicy({
    tools,
    disallowedTools: setup.disallowedTools ?? [],
  });
  const childModes: string[] = [];
  const diagnostics: string[] = [];
  const hooks: ToolHookRuntime = {
    before: async () => ({
      permission: "allow",
      additionalContext: [],
      preventContinuation: false,
    }),
    after: async (_call, result) => result,
  };
  const open = async (
    provider: Provider,
    overrides: Partial<HostOptions> & { parentMode?: PermissionMode } = {},
  ) => {
    const { parentMode: mode = "default", ...rest } = overrides;
    const host = await createSessionAgentHost({
      cwd,
      launch,
      provider,
      env,
      sessionId: () => "session-1",
      model: () => PARENT_MODEL,
      policy: () => policy,
      mode: () => mode,
      system: () => "PARENT_SYSTEM",
      approve: async () => false,
      hooks,
      childHooks: (plan) => {
        childModes.push(plan.permissionMode);
        return rest.hooks ?? hooks;
      },
      onDiagnostic: (message) => diagnostics.push(message),
      ...rest,
    });
    onTestFinished(() => host.close());
    return {
      host,
      tools: host.wrap(() =>
        createTools({ cwd, policy, mode, approve: async () => false }),
      ),
    };
  };
  return { cwd, open, childModes, diagnostics };
}

const agent = (fields: string, prompt: string) =>
  `---\n${fields}\n---\n${prompt}`;
const launchCall = (
  subagent_type: string,
  extra: Record<string, unknown> = {},
): ToolUse => ({
  type: "tool_use",
  id: `launch-${subagent_type}`,
  name: "Agent",
  input: {
    description: "Owned task",
    prompt: "Do the owned task",
    subagent_type,
    run_in_background: false,
    ...extra,
  },
});
const reply = (content: Completion["content"]): Completion => ({
  content,
  stop_reason: content.some((block) => block.type === "tool_use")
    ? "tool_use"
    : "end_turn",
  usage: { input_tokens: 10, output_tokens: 3 },
});
const text = (value: string) => reply([{ type: "text", text: value }]);
const use = (id: string, name: string, input: Record<string, unknown>) =>
  reply([{ type: "tool_use", id, name, input }]);
const toolResult = (request: CompletionRequest, id: string) => {
  const block = request.messages
    .flatMap((message) => message.content)
    .find((entry) => entry.type === "tool_result" && entry.tool_use_id === id);
  assert.ok(block?.type === "tool_result");
  return block;
};
const transcript = (request: CompletionRequest) =>
  JSON.stringify(request.messages);
const signal = () => new AbortController().signal;
const noProvider: Provider = {
  async complete() {
    throw new Error("the provider must not be called");
  },
};

test("a child agent launches a grandchild under the child's live permission mode", async () => {
  const f = await fixture({
    agents: {
      planner: agent(
        "name: planner\ndescription: Plans\ntools: Agent, Read\nmodel: inherit",
        "PLANNER_PROMPT",
      ),
      leaf: agent(
        "name: leaf\ndescription: Leaf work\ntools: Read\nmodel: inherit",
        "LEAF_PROMPT",
      ),
    },
    tools: "Task,Read",
  });
  const systems: string[] = [];
  const provider: Provider = {
    async complete(request) {
      const who = systemPromptText(request.system).includes("LEAF_PROMPT")
        ? "leaf"
        : "planner";
      systems.push(who);
      if (who === "leaf") {
        if (transcript(request).includes("NOTES_CONTENT"))
          return text("leaf read the notes");
        return use("leaf-read", "Read", { file_path: "notes.txt" });
      }
      if (systems.filter((entry) => entry === "planner").length === 1)
        return use("nested", "Agent", {
          description: "Leaf task",
          prompt: "Read the notes",
          subagent_type: "leaf",
          run_in_background: false,
        });
      assert.match(
        JSON.stringify(toolResult(request, "nested").content),
        /leaf read the notes/,
      );
      return text("planner done");
    },
  };
  const { tools } = await f.open(provider, { parentMode: "bypassPermissions" });
  const result = await tools.execute(launchCall("planner"), signal());
  assert.equal(result.is_error, undefined);
  assert.match(JSON.stringify(result.content), /planner done/);
  assert.deepEqual(systems, ["planner", "leaf", "leaf", "planner"]);
  assert.ok(f.childModes.length > 0);
  assert.ok(f.childModes.every((mode) => mode === "bypassPermissions"));
});

test("a child of a plan-mode parent stays in plan mode", async () => {
  const f = await fixture({
    agents: {
      reader: agent(
        "name: reader\ndescription: Reads\ntools: Read\nmodel: inherit",
        "READER",
      ),
    },
  });
  let requests = 0;
  const provider: Provider = {
    async complete() {
      requests++;
      return requests === 1
        ? use("read", "Read", { file_path: "notes.txt" })
        : text("read done");
    },
  };
  const { tools } = await f.open(provider, { parentMode: "plan" });
  const result = await tools.execute(launchCall("reader"), signal());
  assert.equal(result.is_error, undefined);
  assert.deepEqual(f.childModes, ["plan", "plan"]);
});

test("a child continues after a failed read when the host has no failure hook", async () => {
  const f = await fixture({
    agents: {
      reader: agent("name: reader\ndescription: Reads\ntools: Read", "READER"),
    },
  });
  let requests = 0;
  const provider: Provider = {
    async complete(request) {
      requests++;
      if (requests === 1)
        return use("absent", "Read", { file_path: "gone.txt" });
      if (requests === 2) {
        assert.equal(toolResult(request, "absent").is_error, true);
        return text("recovered");
      }
      throw new Error("unexpected request");
    },
  };
  const { tools } = await f.open(provider);
  const result = await tools.execute(launchCall("reader"), signal());
  assert.equal(result.is_error, undefined);
  assert.match(JSON.stringify(result.content), /recovered/);
  assert.equal(requests, 2);
});

test("unsupported child definitions fail the launch before any model request", async () => {
  const f = await fixture({
    agents: {
      quiet: agent(
        "name: quiet\ndescription: Never asks\ntools: Read\npermissionMode: dontAsk",
        "QUIET",
      ),
      scoped: agent(
        "name: scoped\ndescription: Scoped tools\ntools: Read, Bash(git *)",
        "SCOPED",
      ),
      compact: agent(
        "name: compact\ndescription: Own compaction\ntools: Read\nautoCompactWindow: 200000",
        "COMPACT",
      ),
    },
  });
  const { tools } = await f.open(noProvider);
  for (const [type, message] of [
    [
      "quiet",
      /Child permission mode dontAsk requires an unimplemented host adapter/,
    ],
    ["scoped", /Agent tool rules require a host scope resolver/],
    [
      "compact",
      /Subagent compaction ceiling requires an unimplemented host policy adapter/,
    ],
  ] as const) {
    const result = await tools.execute(launchCall(type), signal());
    assert.equal(result.is_error, true, type);
    assert.match(result.content, message);
  }
});

test("a denied agent type is refused whether named or reached as the default type", async () => {
  const f = await fixture({
    agents: {
      "general-purpose": agent(
        "name: general-purpose\ndescription: Default agent\ntools: Read",
        "GENERAL",
      ),
      reader: agent("name: reader\ndescription: Reads\ntools: Read", "READER"),
    },
    disallowedTools: ["Agent(general-purpose)"],
  });
  const { host, tools } = await f.open(noProvider);
  assert.deepEqual(
    (await host.catalog()).map((definition) => definition.agentType),
    ["reader"],
  );
  const named = await tools.execute(launchCall("general-purpose"), signal());
  assert.equal(named.is_error, true);
  assert.match(named.content, /excluded or denied by permission rules/);
  const defaulted = await tools.execute(
    {
      ...launchCall("general-purpose"),
      input: {
        description: "Owned task",
        prompt: "Do the owned task",
        run_in_background: false,
      },
    },
    signal(),
  );
  assert.equal(defaulted.is_error, true);
  assert.match(
    defaulted.content,
    /Resolved agent type is denied by permission rules/,
  );
});

test("a full shared concurrency pool refuses a new child", async () => {
  const f = await fixture({
    agents: {
      reader: agent("name: reader\ndescription: Reads\ntools: Read", "READER"),
    },
    env: {
      CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "1",
    },
  });
  const slots = new Set(["held-by-another-session"]);
  const { tools } = await f.open(noProvider, { concurrencySlots: slots });
  const result = await tools.execute(launchCall("reader"), signal());
  assert.equal(result.is_error, true);
  assert.match(result.content, /Concurrent agent limit reached \(1\)/);
  assert.deepEqual([...slots], ["held-by-another-session"]);
});

test("managed policy restricts child models and supplies managed instructions", async () => {
  const f = await fixture({
    agents: {
      big: agent(
        "name: big\ndescription: Big model\ntools: Read\nmodel: claude-opus-4-1",
        "BIG",
      ),
      reader: agent("name: reader\ndescription: Reads\ntools: Read", "READER"),
    },
    managed: {
      availableModels: [PARENT_MODEL],
      claudeMd: "MANAGED_RULE_TEXT",
      claudeMdExcludes: ["**/never-matches.md"],
    },
  });
  const seen: string[] = [];
  const provider: Provider = {
    async complete(request) {
      seen.push(transcript(request));
      return text("reader done");
    },
  };
  const { tools } = await f.open(provider);
  const refused = await tools.execute(launchCall("big"), signal());
  assert.equal(refused.is_error, true);
  assert.match(
    refused.content,
    /Subagent model claude-opus-4-1 requires an unavailable-model fallback adapter/,
  );
  const result = await tools.execute(launchCall("reader"), signal());
  assert.equal(result.is_error, undefined);
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", /MANAGED_RULE_TEXT/);
});

test("with no model setting anywhere a child inherits the parent model", async () => {
  const f = await fixture({
    agents: {
      reader: agent("name: reader\ndescription: Reads\ntools: Read", "READER"),
    },
    env: {},
  });
  const models: string[] = [];
  const provider: Provider = {
    async complete(request) {
      models.push(request.model);
      return text("done");
    },
  };
  const { tools } = await f.open(provider);
  const result = await tools.execute(launchCall("reader"), signal());
  assert.equal(result.is_error, undefined);
  assert.deepEqual(models, [PARENT_MODEL]);
});

test("child reads count tokens with the child model and failures reach the failure hook", async () => {
  const f = await fixture({
    agents: {
      reader: agent(
        "name: reader\ndescription: Reads\ntools: Read\nmodel: claude-haiku-4-5",
        "READER",
      ),
    },
  });
  // Large enough that its estimate asks the provider for an exact count.
  await writeFile(join(f.cwd, "large.txt"), "word ".repeat(10_000));
  const counted: string[] = [],
    failures: string[] = [];
  let requests = 0;
  const provider: Provider = {
    async countFileTokens(request) {
      counted.push(request.model);
      return 5;
    },
    async complete(request) {
      requests++;
      if (requests === 1)
        return use("present", "Read", { file_path: "large.txt" });
      if (requests === 2)
        return use("absent", "Read", { file_path: "gone.txt" });
      assert.equal(toolResult(request, "absent").is_error, true);
      return text("done");
    },
  };
  const { tools } = await f.open(provider, {
    hooks: {
      before: async () => ({
        permission: "allow",
        additionalContext: [],
        preventContinuation: false,
      }),
      after: async (_call, result) => result,
      failure: async (call) => {
        failures.push(call.name);
      },
    },
  });
  const result = await tools.execute(launchCall("reader"), signal());
  assert.equal(result.is_error, undefined);
  assert.ok(counted.length > 0);
  assert.ok(counted.every((model) => model === "claude-haiku-4-5"));
  assert.deepEqual(failures, ["Read"]);
});

test("a failing child query reports an archive failure without hiding the query error", async () => {
  for (const [thrown, expected] of [
    [new Error("disk full"), "Child archive failed: disk full"],
    ["not an error", "Child archive failed: unknown error"],
  ] as const) {
    const f = await fixture({
      agents: {
        reader: agent(
          "name: reader\ndescription: Reads\ntools: Read",
          "READER",
        ),
      },
    });
    const statuses: string[] = [];
    const provider: Provider = {
      async complete() {
        throw new Error("provider unavailable");
      },
    };
    const { tools } = await f.open(provider, {
      async saveChild(_plan, _messages, status) {
        statuses.push(status);
        // oxlint-disable-next-line typescript/only-throw-error -- a host may throw anything
        if (status === "interrupted") throw thrown;
      },
    });
    const result = await tools.execute(launchCall("reader"), signal());
    assert.equal(result.is_error, true);
    assert.match(result.content, /provider unavailable/);
    assert.equal(statuses.at(-1), "interrupted");
    assert.ok(f.diagnostics.includes(expected), expected);
  }
});

test("an invalid agent definition field is reported with its file path", async () => {
  const f = await fixture({
    agents: {
      odd: agent(
        "name: odd\ndescription: Odd\ntools: Read\npermissionMode: sometimes",
        "ODD",
      ),
    },
  });
  await f.open(noProvider);
  assert.ok(
    f.diagnostics.some(
      (message) =>
        message.includes("Invalid agent permissionMode") &&
        message.endsWith(`(${join(f.cwd, "config", "agents", "odd.md")})`),
    ),
    f.diagnostics.join("\n"),
  );
});

test("a definition that asks for background runs detached when the call does not say", async () => {
  const f = await fixture({
    agents: {
      watcher: agent(
        "name: watcher\ndescription: Watches\ntools: Read\nbackground: true",
        "WATCHER",
      ),
    },
  });
  const notifications: unknown[] = [];
  const provider: Provider = {
    async complete() {
      return text("watched");
    },
  };
  const { host, tools } = await f.open(provider, {
    background: {
      outputFile: () => join(f.cwd, "watcher.output"),
      persist: async () => {},
      enqueueNotification: (notification) => {
        notifications.push(notification);
      },
    },
  });
  const result = await tools.execute(
    {
      ...launchCall("watcher"),
      input: {
        description: "Owned task",
        prompt: "Do the owned task",
        subagent_type: "watcher",
      },
    },
    signal(),
  );
  assert.equal(result.is_error, undefined);
  assert.equal(
    z.object({ status: z.string() }).parse(result.hookResponse).status,
    "async_launched",
  );
  assert.ok(host.background);
  await host.background.settled();
  assert.equal(notifications.length, 1);
});

test("the wrapped parent executor tolerates a base without request or compaction hooks", async () => {
  const f = await fixture({
    agents: {
      reader: agent("name: reader\ndescription: Reads\ntools: Read", "READER"),
    },
  });
  const { host } = await f.open(noProvider);
  const base: ToolExecutor = {
    definitions: [],
    async execute(call) {
      return { type: "tool_result", tool_use_id: call.id, content: "base" };
    },
  };
  const wrapped = host.wrap(() => base);
  await wrapped.beforeModelRequest?.(signal());
  const plan = await wrapped.prepareCompaction?.({
    keptMessages: [],
    signal: signal(),
  });
  assert.deepEqual(plan?.messages, []);
  assert.equal(
    (
      await wrapped.execute(
        { type: "tool_use", id: "x", name: "Read", input: {} },
        signal(),
      )
    ).content,
    "base",
  );
});
