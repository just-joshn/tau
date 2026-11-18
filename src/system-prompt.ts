import { createHash } from "node:crypto";
import { triBoolean } from "./env-settings.js";
import { modelFacts } from "./model-facts.js";
import {
  ACT_DONT_REDERIVE,
  ACTIONS_SECTION,
  CONTEXT_MANAGEMENT,
  DOING_TASKS_HELP,
  DOING_TASKS_ITEMS,
  HELP_COMMAND,
  PARALLEL_TOOL_CALLS,
  PRONOUNS,
  SECURITY_POLICY,
  SURFACES,
  SYSTEM_ITEMS,
  TEXT_OUTPUT_SECTION,
  TONE_ITEMS,
  URL_POLICY,
} from "./system-prompt-text.js";

export const CLAUDE_CODE_VERSION = "2.1.326";
export type PromptEnv = Readonly<Record<string, string | undefined>>;

/** Baked catalog subset: display_name, knowledge_cutoff, total_tokens_reminder capability. */
const MODELS: Readonly<
  Record<string, readonly [string, string | null, boolean]>
> = {
  "claude-3-5-haiku": ["Haiku 3.5", null, true],
  "claude-haiku-4-5": ["Haiku 4.5", "February 2025", true],
  "claude-haiku-5-5": ["Haiku 5.5", "June 2026", true],
  "claude-3-5-sonnet": ["Sonnet 3.5", null, true],
  "claude-3-7-sonnet": ["Sonnet 3.7", null, true],
  "claude-sonnet-4-0": ["Sonnet 4", "January 2025", true],
  "claude-sonnet-4-5": ["Sonnet 4.5", "January 2025", true],
  "claude-sonnet-4-6": ["Sonnet 4.6", "August 2025", true],
  "claude-sonnet-5": ["Sonnet 5", "January 2026", true],
  "claude-sonnet-5-5": ["Sonnet 5.5", "June 2026", false],
  "claude-opus-4-0": ["Opus 4", "January 2025", true],
  "claude-opus-4-1": ["Opus 4.1", "January 2025", true],
  "claude-opus-4-5": ["Opus 4.5", "May 2025", true],
  "claude-opus-4-6": ["Opus 4.6", "May 2025", true],
  "claude-opus-4-7": ["Opus 4.7", "January 2026", true],
  "claude-opus-4-8": ["Opus 4.8", "January 2026", true],
  "claude-opus-5": ["Opus 5", "May 2026", true],
  "claude-opus-5-5": ["Opus 5.5", "June 2026", false],
  "claude-fable-5": ["Fable 5", "January 2026", true],
  "claude-fable-5-1": ["Fable 5.1", "June 2026", true],
  "claude-fable-5-2": ["Fable 5.2", "June 2026", false],
  "claude-mythos-5": ["Mythos 5", "January 2026", true],
  "claude-mythos-5-1": ["Mythos 5.1", "June 2026", true],
  "claude-mythos-5-2": ["Mythos 5.2", "June 2026", false],
};
const LATEST_PER_FAMILY = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

export interface PromptModel {
  id: string;
  displayName: string | undefined;
  knowledgeCutoff: string | null;
  totalTokensReminder: boolean;
}
export function promptModel(model: string): PromptModel {
  const id = modelFacts(model).canonical,
    entry = MODELS[id];
  return {
    id,
    displayName: entry?.[0],
    knowledgeCutoff: entry?.[1] ?? null,
    totalTokensReminder: entry?.[2] ?? false,
  };
}

/** Facts every gate reads; nothing here is inferred from rendered text. */
export interface PromptContext {
  model: string;
  tools: ReadonlySet<string>;
  hasSkills: boolean;
  interactive: boolean;
  env: PromptEnv;
}
interface PromptSection {
  id: string;
  render(context: PromptContext): string | null;
}

type Bullet = string | readonly string[];
const bullets = (items: readonly Bullet[]): string[] =>
  items.flatMap((item) =>
    typeof item === "string"
      ? [` - ${item}`]
      : item.map((nested) => `  - ${nested}`),
  );
const section = (heading: string, items: readonly Bullet[]): string =>
  [heading, ...bullets(items)].join("\n");
const disabled = (value: string | undefined) => triBoolean(value) === false;

function usingTools({ tools }: PromptContext): string {
  const shell = tools.has("Bash") ? "Bash" : "PowerShell",
    tasks = ["TaskCreate", "TodoWrite"].find((name) => tools.has(name));
  return section("# Using your tools", [
    `Prefer dedicated tools over ${shell} when one fits (Read, Edit, Write, Glob, Grep) \u2014 reserve ${shell} for shell-only operations.`,
    ...(tasks
      ? [
          `Use ${tasks} to plan and track work. Mark each task completed as soon as it's done; don't batch.`,
        ]
      : []),
    PARALLEL_TOOL_CALLS,
  ]);
}

function sessionGuidance({
  tools,
  hasSkills,
  interactive,
  env,
}: PromptContext): string | null {
  const agent = tools.has("Agent"),
    items = [
      interactive
        ? "If you need the user to run a shell command themselves (e.g., an interactive login like `gcloud auth login`), suggest they type `! <command>` in the prompt — the `!` prefix runs the command in this session so its output lands directly in the conversation."
        : null,
      // tau has no inherited-context fork subagent, so the original's non-fork steer applies.
      agent
        ? "Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself."
        : null,
      agent && !triBoolean(env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS)
        ? "For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore. Otherwise use the Glob or Grep directly."
        : null,
      hasSkills && tools.has("Skill")
        ? "When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section \u2014 don't guess."
        : null,
    ].filter((item) => item !== null);
  return items.length ? section("# Session-specific guidance", items) : null;
}

function environment(): string {
  const models = LATEST_PER_FAMILY.map(
    (id) => `${MODELS[id]?.[0] ?? id}: '${id}'`,
  ).join(", ");
  return section("# Environment", [
    `The most recent Claude models are the Claude 5 family. Model IDs \u2014 ${models}. When building AI applications, default to the latest and most capable Claude models.`,
    SURFACES,
    "Fast mode for Claude Code gives faster output on this session's model if it supports fast mode, and otherwise switches the session to Claude Opus. It can be toggled with /fast.",
  ]);
}

const TOTAL_TOKENS_MODES = [
  "off",
  "infinite",
  "fixed",
  "countdown",
  "padded-countdown",
] as const;
/** Returns null when the reminder is off; `used` counts this session's API tokens. */
export function totalTokensText(
  { model, env }: Pick<PromptContext, "model" | "env">,
  used: number,
): string | null {
  if (
    triBoolean(env.CLAUDE_CODE_DISABLE_ATTACHMENTS) ||
    triBoolean(env.CLAUDE_CODE_SIMPLE)
  )
    return null;
  const configured = env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER;
  const mode =
    TOTAL_TOKENS_MODES.find((value) => value === configured) ??
    (promptModel(model).totalTokensReminder ? "padded-countdown" : "off");
  if (mode === "off") return null;
  const budget = Number(env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET);
  const remaining = (budget > 0 ? budget : 15_000_000) - used;
  return `<total_tokens>${mode === "infinite" ? "Infinite" : mode === "fixed" ? 5_000_000 : Math.max(0, remaining)} tokens left</total_tokens>`;
}

/** Ordered like the original's shared then session sections; memory is not ported. */
export const SYSTEM_PROMPT_SECTIONS: readonly PromptSection[] = [
  {
    id: "intro",
    render: () =>
      `\nYou are an agent working with the user toward their goals, using your own judgment along the way. Use the instructions below and the tools available to you to assist the user.\n\n${SECURITY_POLICY}\n${URL_POLICY}`,
  },
  {
    id: "system",
    render: () => section("# System", Object.values(SYSTEM_ITEMS)),
  },
  {
    id: "doing_tasks",
    render: () =>
      section("# Doing tasks", [
        ...DOING_TASKS_ITEMS,
        DOING_TASKS_HELP,
        [
          HELP_COMMAND,
          "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
        ],
      ]),
  },
  { id: "actions", render: () => ACTIONS_SECTION },
  { id: "tools", render: usingTools },
  { id: "tone", render: () => section("# Tone and style", TONE_ITEMS) },
  { id: "communication", render: () => TEXT_OUTPUT_SECTION },
  { id: "pronouns", render: () => PRONOUNS },
  { id: "session_guidance", render: sessionGuidance },
  { id: "env_info_simple", render: environment },
  { id: "context_management", render: () => CONTEXT_MANAGEMENT },
  {
    id: "act_dont_rederive",
    render: ({ env }) =>
      disabled(env.CLAUDE_CODE_ACT_DONT_REDERIVE) ? null : ACT_DONT_REDERIVE,
  },
  { id: "total_tokens", render: (context) => totalTokensText(context, 0) },
];

export function renderSystemPrompt(
  context: PromptContext,
  options: {
    replacement?: string | undefined;
    append?: string | undefined;
  } = {},
): string {
  const sections =
    options.replacement === undefined
      ? SYSTEM_PROMPT_SECTIONS.map((entry) => entry.render(context))
      : [options.replacement];
  return [...sections, options.append]
    .filter((text): text is string => typeof text === "string" && text !== "")
    .join("\n\n");
}

export const CLI_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const SDK_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
export const AGENT_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export function identityLine(options: {
  interactive: boolean;
  appendSystemPrompt: boolean;
}): string {
  if (options.interactive) return CLI_IDENTITY;
  return options.appendSystemPrompt ? SDK_IDENTITY : AGENT_IDENTITY;
}

export function promptEntrypoint(env: PromptEnv, interactive: boolean): string {
  const configured = env.CLAUDE_CODE_ENTRYPOINT;
  if (configured === "local_agent") return "local-agent";
  if (configured === "cli" && !interactive) return "sdk-cli";
  if (configured) return configured;
  if (triBoolean(env.CLAUDE_CODE_ACTION)) return "claude-code-github-action";
  return interactive ? "cli" : "sdk-cli";
}

/** Three characters at fixed offsets of the first prompt, salted with the version. */
export function promptFingerprint(firstPrompt: string): string {
  const sample = [4, 7, 20].map((index) => firstPrompt[index] || "0").join("");
  return createHash("sha256")
    .update(`59cf53e54c78${sample}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

export function billingHeader(
  firstPrompt: string,
  entrypoint: string,
  env: PromptEnv,
): string | null {
  if (disabled(env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return null;
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${promptFingerprint(firstPrompt)}; cc_entrypoint=${entrypoint};`;
}

export interface SystemTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}
export type SystemPrompt = string | readonly SystemTextBlock[];

/** Without a global cache boundary: header uncached, identity and body cached. */
export function systemPromptBlocks(parts: {
  header: string | null;
  identity: string;
  body: string;
}): SystemTextBlock[] {
  const cached = (text: string): SystemTextBlock => ({
    type: "text",
    text,
    cache_control: { type: "ephemeral" },
  });
  return [
    ...(parts.header ? [{ type: "text" as const, text: parts.header }] : []),
    cached(parts.identity),
    ...(parts.body ? [cached(parts.body)] : []),
  ];
}

export function systemPromptText(system: SystemPrompt): string {
  return typeof system === "string"
    ? system
    : system.map((block) => block.text).join("\n\n");
}
