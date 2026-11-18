import assert from "node:assert/strict";
import { test } from "bun:test";
import type {
  PreToolHookResult,
  ToolHookRuntime,
} from "../../src/tool-hook-runtime.js";
import {
  combineToolPolicy,
  parseToolPolicy,
  type ToolPolicy,
} from "../../src/tool-policy.js";
import type {
  PermissionMode,
  ToolExecutor,
  ToolResult,
} from "../../src/types.js";
import {
  createWebTools,
  webToolDefinitions,
  webToolPermission,
} from "../../src/web-tools.js";
import { UNPARSED_TOOL_INPUT } from "../../src/tool-input.js";

const fetchInput = { url: "https://example.com/a", prompt: "p" };
const base: ToolExecutor = {
  definitions: [
    { name: "Read", description: "r", input_schema: { type: "object" } },
  ],
  execute: async (call) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: "base",
  }),
};

function tools(
  options: {
    policy?: ToolPolicy;
    mode?: PermissionMode;
    approve?: (description: string) => Promise<boolean>;
    hooks?: ToolHookRuntime;
    page?: () => Response;
  } = {},
) {
  const prompts: string[] = [];
  const executor = createWebTools({
    mode: () => options.mode ?? "default",
    policy: () => options.policy ?? parseToolPolicy({}),
    hooks: () => options.hooks,
    approve: async (description) => {
      prompts.push(description);
      return (await options.approve?.(description)) ?? false;
    },
    fetch: {
      skipPreflight: () => true,
      applyPrompt: async () => "ANSWER",
      fetch: async () => (options.page ?? (() => new Response("page")))(),
    },
    search: {
      send: async () =>
        Response.json({
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "s",
              content: [{ title: "T", url: "https://t/" }],
            },
          ],
        }),
      model: () => "m",
      maxTokens: () => 10,
    },
  }).wrap(base);
  const run = (name: string, input: unknown) =>
    executor.execute(
      { type: "tool_use", id: "c1", name, input },
      new AbortController().signal,
    );
  return { executor, run, prompts };
}
const hook = (
  pre: Partial<PreToolHookResult>,
  events: string[] = [],
): ToolHookRuntime => ({
  before: async () => ({
    additionalContext: [],
    preventContinuation: false,
    ...pre,
  }),
  after: async (_call, result) => {
    events.push("after");
    return result;
  },
  failure: async () => {
    events.push("failure");
    return { additionalContext: ["failure context"] };
  },
});

test("definitions carry the original names and schemas and are advertised whenever enabled", () => {
  const [fetchTool, searchTool] = webToolDefinitions();
  assert.equal(fetchTool?.name, "WebFetch");
  assert.deepEqual(fetchTool?.input_schema.required, ["url", "prompt"]);
  assert.equal(searchTool?.name, "WebSearch");
  assert.deepEqual(Object.keys(searchTool?.input_schema.properties ?? {}), [
    "query",
    "allowed_domains",
    "blocked_domains",
  ]);
  assert.deepEqual(
    tools().executor.definitions.map((tool) => tool.name),
    ["Read", "WebFetch", "WebSearch"],
  );
  assert.deepEqual(
    tools({
      policy: parseToolPolicy({ tools: "Read,WebFetch" }),
    }).executor.definitions.map((tool) => tool.name),
    ["Read", "WebFetch"],
  );
});

test("permission follows domain rules, whole-tool rules and preapproved hosts", () => {
  const sourced = combineToolPolicy(parseToolPolicy({}), [
    {
      source: "userSettings",
      behavior: "allow",
      rule: "WebFetch(domain:*.example.com)",
    },
    {
      source: "userSettings",
      behavior: "deny",
      rule: "WebFetch(domain:bad.com)",
    },
    {
      source: "userSettings",
      behavior: "ask",
      rule: "WebFetch(domain:ask.com)",
    },
    { source: "userSettings", behavior: "allow", rule: "Read" },
  ]);
  const decide = (url: string, policy = sourced) =>
    webToolPermission("WebFetch", { url, prompt: "p" }, policy).behavior;
  assert.equal(decide("https://a.example.com/"), "allow");
  assert.equal(decide("https://bad.com/"), "deny");
  assert.equal(decide("https://ask.com/"), "ask");
  assert.equal(decide("https://docs.python.org/3/"), "allow");
  assert.equal(decide("https://other.com/"), "ask");
  assert.equal(
    decide(
      "https://other.com/",
      parseToolPolicy({ allowedTools: ["WebFetch"] }),
    ),
    "allow",
  );
  assert.equal(
    decide(
      "https://docs.python.org/",
      parseToolPolicy({ allowedTools: ["WebFetch"], disallowedTools: [] }),
    ),
    "allow",
  );
  const asked = {
    ...parseToolPolicy({}),
    askedTools: ["WebFetch", "WebSearch"],
  };
  assert.equal(decide("https://docs.python.org/", asked), "ask");
  assert.equal(
    webToolPermission("WebSearch", { query: "qq" }, asked).behavior,
    "ask",
  );
  assert.equal(
    webToolPermission(
      "WebSearch",
      { query: "qq" },
      parseToolPolicy({ allowedTools: ["WebSearch"] }),
    ).behavior,
    "allow",
  );
  assert.equal(
    webToolPermission("WebSearch", { query: "qq" }, parseToolPolicy({}))
      .behavior,
    "ask",
  );
});

test("calls run with allow rules or bypass mode and prompt otherwise", async () => {
  const allowed = tools({
    policy: parseToolPolicy({ allowedTools: ["WebFetch(domain:example.com)"] }),
  });
  assert.deepEqual(await allowed.run("WebFetch", fetchInput), {
    type: "tool_result",
    tool_use_id: "c1",
    content: "ANSWER",
  });
  assert.equal(allowed.prompts.length, 0);
  const bypass = tools({ mode: "bypassPermissions" });
  assert.equal(
    (await bypass.run("WebSearch", { query: "qq" })).content.startsWith(
      "Web search results",
    ),
    true,
  );
  const refused = tools();
  const denied = await refused.run("WebFetch", fetchInput);
  assert.equal(denied.is_error, true);
  assert.equal(denied.permissionDenied, true);
  assert.equal(
    denied.content,
    "Claude requested permissions to use WebFetch, but you haven't granted it yet.",
  );
  assert.deepEqual(refused.prompts, [
    "Claude wants to fetch content from example.com",
  ]);
  const search = tools({ approve: async () => true });
  assert.equal(
    (await search.run("WebSearch", { query: "qq" })).is_error,
    undefined,
  );
  assert.deepEqual(search.prompts, ["Claude wants to search the web for: qq"]);
  const throwing = tools({
    approve: async () => {
      throw new Error("no terminal");
    },
  });
  assert.equal(
    (await throwing.run("WebSearch", { query: "qq" })).permissionDenied,
    true,
  );
  const askedInBypass = tools({
    mode: "bypassPermissions",
    policy: {
      ...parseToolPolicy({}),
      askedTools: ["WebFetch(domain:example.com)"],
    },
  });
  assert.equal(
    (await askedInBypass.run("WebFetch", fetchInput)).permissionDenied,
    true,
  );
});

test("disabled tools, bad input and denied domains become error results", async () => {
  const deniedTool = tools({
    policy: parseToolPolicy({ disallowedTools: ["WebSearch"] }),
  });
  assert.match(
    (await deniedTool.run("WebSearch", { query: "qq" })).content,
    /Tool disabled or denied by policy: WebSearch/,
  );
  const unselected = tools({ policy: parseToolPolicy({ tools: "Read" }) });
  assert.equal(
    (await unselected.run("WebFetch", fetchInput)).permissionDenied,
    true,
  );
  const plain = tools({ mode: "bypassPermissions" });
  assert.equal((await plain.run("Read", {})).content, "base");
  assert.match(
    (
      await plain.run("WebFetch", {
        [UNPARSED_TOOL_INPUT]: { raw: "{", len: 1 },
      })
    ).content,
    /input JSON failed to parse — 1 bytes/,
  );
  assert.equal(
    (await plain.run("WebFetch", { url: "nope", prompt: "p" })).inputRejected,
    true,
  );
  assert.equal(
    (await plain.run("WebSearch", { query: "q" })).inputRejected,
    true,
  );
  assert.match(
    (
      await plain.run("WebSearch", {
        query: "qq",
        allowed_domains: ["a"],
        blocked_domains: ["b"],
      })
    ).content,
    /Cannot specify both/,
  );
  const domain = tools({
    mode: "bypassPermissions",
    policy: parseToolPolicy({
      disallowedTools: ["WebFetch(domain:example.com)"],
    }),
  });
  assert.equal(
    (await domain.run("WebFetch", fetchInput)).content,
    "WebFetch denied access to domain:example.com.",
  );
});

test("hooks can stop, deny, rewrite, approve, require asks and observe failures", async () => {
  const stop = await tools({
    hooks: hook({ preventContinuation: true, stopReason: "halt" }),
  }).run("WebFetch", fetchInput);
  assert.equal(stop.content, "halt");
  const stopDefault = await tools({
    hooks: hook({ preventContinuation: true }),
  }).run("WebFetch", fetchInput);
  assert.equal(stopDefault.content, "Tool call stopped by hook");
  const deny = await tools({ hooks: hook({ permission: "deny" }) }).run(
    "WebFetch",
    fetchInput,
  );
  assert.equal(deny.content, "Tool denied by hook");
  const defer = await tools({
    hooks: hook({ permission: "defer", reason: "later" }),
  }).run("WebFetch", fetchInput);
  assert.equal(defer.content, "later");
  const events: string[] = [];
  const rewritten = await tools({
    hooks: hook(
      {
        permission: "allow",
        updatedInput: { url: "https://example.com/b", prompt: "q" },
      },
      events,
    ),
  }).run("WebFetch", fetchInput);
  assert.equal(rewritten.content, "ANSWER");
  assert.deepEqual(rewritten.effectiveToolInput, {
    url: "https://example.com/b",
    prompt: "q",
  });
  assert.deepEqual(events, ["after"]);
  const askingHook = tools({
    mode: "bypassPermissions",
    hooks: hook({ permission: "ask" }),
  });
  assert.equal(
    (await askingHook.run("WebFetch", fetchInput)).permissionDenied,
    true,
  );
  const failures: string[] = [];
  const failed: ToolResult = await tools({
    mode: "bypassPermissions",
    hooks: hook({}, failures),
    page: () => {
      throw new Error("boom");
    },
  }).run("WebFetch", fetchInput);
  assert.equal(failed.is_error, true);
  assert.match(failed.content, /boom/);
  assert.deepEqual(failures, ["failure"]);
  const noFailureHook = await tools({
    mode: "bypassPermissions",
    hooks: {
      before: (...args) => hook({}).before(...args),
      after: (...args) => hook({}).after(...args),
    },
    page: () => {
      throw new Error("boom");
    },
  }).run("WebFetch", fetchInput);
  assert.match(noFailureHook.content, /boom/);
});

test("executing a non-web tool through the web executor is a programming error", async () => {
  const executor = createWebTools({
    mode: () => "default",
    policy: () => parseToolPolicy({}),
    hooks: () => undefined,
    approve: async () => false,
    fetch: { skipPreflight: () => true, applyPrompt: async () => "" },
    search: {
      send: async () => new Response(),
      model: () => "m",
      maxTokens: () => 1,
    },
  });
  await assert.rejects(
    executor.execute(
      { type: "tool_use", id: "x", name: "Read", input: {} },
      new AbortController().signal,
    ),
    /Not a web tool: Read/,
  );
});
