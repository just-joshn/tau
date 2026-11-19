import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AGENT_IDENTITY,
  billingHeader,
  CLI_IDENTITY,
  identityLine,
  promptEntrypoint,
  promptFingerprint,
  promptModel,
  renderSystemPrompt,
  SDK_IDENTITY,
  systemPromptBlocks,
  systemPromptText,
  totalTokensText,
  type PromptContext,
} from "../../src/system-prompt.js";
import { resolveAutoMemoryStore } from "../../src/auto-memory.js";

const context = (overrides: Partial<PromptContext> = {}): PromptContext => ({
  model: "claude-sonnet-4-5-20250929",
  tools: new Set([
    "Agent",
    "Bash",
    "Edit",
    "Read",
    "Skill",
    "Write",
    "TaskCreate",
  ]),
  hasSkills: true,
  interactive: false,
  env: {},
  ...overrides,
});
const sections = (body: string) => {
  const [intro = "", ...rest] = body.split("\n\n# ");
  return new Map([
    ["intro", intro],
    ...rest.map((chunk): [string, string] => [
      chunk.slice(0, chunk.indexOf("\n")),
      `# ${chunk}`,
    ]),
  ]);
};
const sha = (text: string | undefined) =>
  createHash("sha256")
    .update(text ?? "")
    .digest("hex");

test("sections shared with the pinned original's print-mode request are byte-identical", () => {
  const body = sections(renderSystemPrompt(context()));
  // SHA-256 of each section as the pinned 2.1.326 sent it (workflow oracle, text scenario).
  const pinned: Record<string, string> = {
    intro: "0b0f3e1bea382eae5a6442004129c9892814958ccbdd0bf473796c3950ec353c",
    System: "1a96391fb2f48605a9f70fb652ecd800ab66208e1de516ee3319780b08901f51",
    "Doing tasks":
      "fa85380f060862ddace44215d68515ede19b4c39bbb4b333df4f3016c9194808",
    "Executing actions with care":
      "f801973827e0e515ec183088837e212c94d23cb8f5d68d7128d28d235611165c",
    "Using your tools":
      "66a62382745d1ae026ac3e5d33fe35c5ca515435c1b3e738a46a163d3bff1fed",
    "Tone and style":
      "657ab1c8b980b41a5eb6e6c55c7de414ed8ba69396f45a403bd562f4a5ea3038",
    "Session-specific guidance":
      "2096ac34f3bf27bb68cf7217475054f9b169fa212e722db614f127fb89b93099",
    "Text output (does not apply to tool calls)":
      "d741f97cb47aee81682c9ae1637afbd6956f217ea28149cf250c5c71bc6726d8",
    Environment:
      "6d75b23a27edf3791d44cdec28376ca946224a918e85596c58ed1f2dd4601e6f",
    "Context management":
      "2dadb5244a2bab0e0702cd520083dcfca56d908af169cd3f0bddc1ed511ead6d",
  };
  for (const [heading, hash] of Object.entries(pinned))
    assert.equal(sha(body.get(heading)), hash, heading);
  assert.deepEqual(
    [...body.keys()],
    [
      "intro",
      "System",
      "Doing tasks",
      "Executing actions with care",
      "Using your tools",
      "Tone and style",
      "Text output (does not apply to tool calls)",
      "Session-specific guidance",
      "Environment",
      "Context management",
    ],
  );
});

test("the auto memory section matches the pinned original between session guidance and environment", () => {
  const directory =
    "/private/tmp/tau-differential-kmi858e8/config/projects/-private-tmp-tau-differential-kmi858e8-work/memory/";
  const store = resolveAutoMemoryStore({
    enabled: true,
    env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: directory },
    configDirectory: "/unused",
    home: "/unused",
    cwd: "/unused",
    canonicalGitRoot: null,
    settings: {},
    projectSettingsAdmitted: true,
  });
  const body = sections(renderSystemPrompt(context({ autoMemory: store })));
  assert.equal(
    sha(body.get("auto memory")),
    "b23d6f14beae9ff9fbdd189e5520160e80176c17883056cc4d542f2662b2b55b",
  );
  const order = [...body.keys()];
  assert.equal(
    order.indexOf("auto memory"),
    order.indexOf("Session-specific guidance") + 1,
  );
  assert.equal(order.indexOf("Environment"), order.indexOf("auto memory") + 1);
  assert.equal(
    renderSystemPrompt(context({ autoMemory: { ...store, enabled: false } })),
    renderSystemPrompt(context()),
  );
});

test("tool, skill and interactivity facts gate their lines", () => {
  const full = renderSystemPrompt(context({ interactive: true }));
  assert.match(
    full,
    /Prefer dedicated tools over Bash when one fits \(Read, Edit, Write\)/,
  );
  assert.doesNotMatch(full, /Glob, Grep/);
  assert.match(full, /Use TaskCreate to plan and track work/);
  assert.match(full, /suggest they type `! <command>`/);
  assert.match(full, /runs in the background/);
  assert.doesNotMatch(full, /subagent_type=Explore/);
  assert.match(full, /invoke it via Skill/);
  const nudged = renderSystemPrompt(
    context({
      interactive: true,
      env: { CLAUDE_CODE_FORK_SUBAGENT: "false" },
    }),
  );
  assert.match(nudged, /Use the Agent tool with specialized agents/);
  assert.match(nudged, /should not be used excessively/);
  assert.match(nudged, /subagent_type=Explore/);
  assert.doesNotMatch(nudged, /subagent_type: "fork"/);
  const bare = renderSystemPrompt(
    context({
      tools: new Set(["TodoWrite"]),
      hasSkills: false,
      env: { CLAUDE_CODE_ACT_DONT_REDERIVE: "0" },
    }),
  );
  assert.match(bare, /Prefer dedicated tools over PowerShell/);
  assert.match(bare, /\(Read, Edit, Write, Glob, Grep\)/);
  assert.match(bare, /Use TodoWrite to plan/);
  assert.doesNotMatch(bare, /Session-specific guidance/);
  assert.doesNotMatch(bare, /When you have enough information to act/);
  const noExplore = renderSystemPrompt(
    context({
      env: {
        CLAUDE_CODE_FORK_SUBAGENT: "0",
        CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1",
      },
    }),
  );
  assert.match(noExplore, /Use the Agent tool with specialized agents/);
  assert.doesNotMatch(noExplore, /subagent_type=Explore/);
  const listed = renderSystemPrompt(context({ hasEmbeddedSearch: false }));
  assert.match(listed, /\(Read, Edit, Write, Glob, Grep\)/);
  const localAgent = renderSystemPrompt(
    context({ env: { CLAUDE_CODE_ENTRYPOINT: "local-agent" } }),
  );
  assert.match(localAgent, /\(Read, Edit, Write, Glob, Grep\)/);
  assert.doesNotMatch(
    renderSystemPrompt(context({ tools: new Set(["Bash"]) })),
    /TaskCreate|TodoWrite/,
  );
  assert.doesNotMatch(
    renderSystemPrompt(context({ isFork: true })),
    /subagent_type: "fork"|subagent_type=Explore/,
  );
});

test("--system-prompt replaces the sections and --append-system-prompt follows them", () => {
  assert.equal(
    renderSystemPrompt(context(), { replacement: "OWN", append: "MORE" }),
    "OWN\n\nMORE",
  );
  assert.match(
    renderSystemPrompt(context(), { append: "MORE" }),
    /tokens left<\/total_tokens>\n\nMORE$/,
  );
});

test("total_tokens follows model capability, env mode and budget", () => {
  const sonnet = { model: "claude-sonnet-4-5", env: {} };
  assert.equal(
    totalTokensText(sonnet, 13),
    "<total_tokens>14999987 tokens left</total_tokens>",
  );
  assert.equal(totalTokensText({ model: "claude-opus-5-5", env: {} }, 0), null);
  assert.equal(totalTokensText({ model: "unknown-model", env: {} }, 0), null);
  const env = (values: Record<string, string>) => ({ ...sonnet, env: values });
  assert.equal(totalTokensText(env({ CLAUDE_CODE_SIMPLE: "1" }), 0), null);
  assert.equal(
    totalTokensText(env({ CLAUDE_CODE_DISABLE_ATTACHMENTS: "true" }), 0),
    null,
  );
  assert.equal(
    totalTokensText(env({ CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" }), 0),
    null,
  );
  assert.match(
    totalTokensText(
      {
        model: "claude-opus-5-5",
        env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "infinite" },
      },
      0,
    ) ?? "",
    /Infinite tokens left/,
  );
  assert.match(
    totalTokensText(env({ CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "fixed" }), 9) ??
      "",
    /5000000 tokens left/,
  );
  assert.match(
    totalTokensText(
      env({
        CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "countdown",
        CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET: "100",
      }),
      150,
    ) ?? "",
    /<total_tokens>0 tokens left/,
  );
});

test("identity line, entrypoint and billing header match the original's rules", () => {
  assert.equal(
    identityLine({ interactive: true, appendSystemPrompt: true }),
    CLI_IDENTITY,
  );
  assert.equal(
    identityLine({ interactive: false, appendSystemPrompt: true }),
    SDK_IDENTITY,
  );
  assert.equal(
    identityLine({ interactive: false, appendSystemPrompt: false }),
    AGENT_IDENTITY,
  );
  assert.equal(promptEntrypoint({}, false), "sdk-cli");
  assert.equal(promptEntrypoint({}, true), "cli");
  assert.equal(
    promptEntrypoint({ CLAUDE_CODE_ENTRYPOINT: "cli" }, false),
    "sdk-cli",
  );
  assert.equal(
    promptEntrypoint({ CLAUDE_CODE_ENTRYPOINT: "local_agent" }, true),
    "local-agent",
  );
  assert.equal(
    promptEntrypoint({ CLAUDE_CODE_ENTRYPOINT: "mcp" }, false),
    "mcp",
  );
  assert.equal(
    promptEntrypoint({ CLAUDE_CODE_ACTION: "true" }, false),
    "claude-code-github-action",
  );
  // The oracle prompt TAU_DIFFERENTIAL_TEXT produced cc_version=2.1.326.8df.
  assert.equal(promptFingerprint("TAU_DIFFERENTIAL_TEXT"), "8df");
  assert.equal(promptFingerprint(""), promptFingerprint("0".repeat(30)));
  assert.equal(
    billingHeader("TAU_DIFFERENTIAL_TEXT", "sdk-cli", {}),
    "x-anthropic-billing-header: cc_version=2.1.326.8df; cc_entrypoint=sdk-cli;",
  );
  assert.equal(
    billingHeader("x", "cli", { CLAUDE_CODE_ATTRIBUTION_HEADER: "false" }),
    null,
  );
});

test("system blocks cache identity and body but not the header", () => {
  const blocks = systemPromptBlocks({ header: "H", identity: "I", body: "B" });
  assert.deepEqual(blocks, [
    { type: "text", text: "H" },
    { type: "text", text: "I", cache_control: { type: "ephemeral" } },
    { type: "text", text: "B", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(
    systemPromptBlocks({ header: null, identity: "I", body: "" }),
    [{ type: "text", text: "I", cache_control: { type: "ephemeral" } }],
  );
  assert.equal(systemPromptText(blocks), "H\n\nI\n\nB");
  assert.equal(systemPromptText("plain"), "plain");
});

test("the model catalog resolves dated ids and leaves unknown models unnamed", () => {
  const sonnet = promptModel("claude-sonnet-4-5-20250929");
  assert.deepEqual(
    [
      sonnet.id,
      sonnet.displayName,
      sonnet.knowledgeCutoff,
      sonnet.totalTokensReminder,
    ],
    ["claude-sonnet-4-5", "Sonnet 4.5", "January 2025", true],
  );
  const unknown = promptModel("vendor-model");
  assert.deepEqual(
    [unknown.displayName, unknown.knowledgeCutoff, unknown.totalTokensReminder],
    [undefined, null, false],
  );
});
