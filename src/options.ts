import { parseArgs } from "node:util";
import { z } from "zod";
import { parseToolPolicy, toolRuleNameSchema } from "./tool-policy.js";
import { MAX_RETRIES, resolveRetryConfiguration } from "./retry.js";
import { MAX_API_ATTEMPTS } from "./attempt-ledger.js";
import { triBoolean } from "./env-settings.js";
import { defaultOutputTokens } from "./reasoning.js";

export const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);
const positiveInteger = z.coerce.number().int().positive().max(1_000_000);
export function parseOptions(args: string[]) {
  const { values, positionals, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      tools: { type: "string", multiple: true },
      allowedTools: { type: "string", multiple: true },
      "allowed-tools": { type: "string", multiple: true },
      disallowedTools: { type: "string", multiple: true },
      "disallowed-tools": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      print: { type: "boolean", short: "p" },
      model: { type: "string" },
      cwd: { type: "string" },
      resume: { type: "string", short: "r" },
      continue: { type: "boolean", short: "c" },
      "permission-mode": { type: "string" },
      "dangerously-skip-permissions": { type: "boolean" },
      "ignore-persisted-trust": { type: "boolean" },
      "permission-prompt-tool": { type: "string" },
      "permission-prompts": { type: "string" },
      "output-format": { type: "string" },
      "input-format": { type: "string" },
      verbose: { type: "boolean" },
      "include-partial-messages": { type: "boolean" },
      "session-id": { type: "string" },
      "max-turns": { type: "string" },
      "max-tokens": { type: "string" },
      "max-retries": { type: "string" },
      "max-api-attempts": { type: "string" },
      "allow-nonstream-fallback": { type: "boolean" },
      "no-nonstream-fallback": { type: "boolean" },
      "fallback-model": { type: "string" },
      thinking: { type: "string" },
      "max-thinking-tokens": { type: "string" },
      "system-prompt": { type: "string" },
      "append-system-prompt": { type: "string" },
      "system-prompt-snapshot": { type: "string" },
      "mcp-config": { type: "string", multiple: true },
      "plugin-dir": { type: "string", multiple: true },
      "strict-mcp-config": { type: "boolean" },
      settings: { type: "string" },
      "setting-sources": { type: "string" },
      "managed-settings": { type: "string" },
    },
  });
  if ((values.tools?.length ?? 0) > 1)
    throw new Error("--tools may only be specified once");
  const policyFlags = new Set([
    "tools",
    "allowedTools",
    "allowed-tools",
    "disallowedTools",
    "disallowed-tools",
  ]);
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    if (
      token.kind === "option" &&
      policyFlags.has(token.name) &&
      next?.kind === "positional" &&
      (toolRuleNameSchema.safeParse(next.value).success ||
        /^(?:(?:Read|Write|Edit|Glob|Grep|Bash)[,(]|[*(])/.test(next.value))
    ) {
      throw new Error(
        `Unsupported unquoted variadic tool list after --${token.name}; quote comma/space lists, and use -- before an ambiguous prompt`,
      );
    }
  }
  const toolPolicy = parseToolPolicy({
    tools: values.tools?.[0],
    allowedTools: [
      ...(values.allowedTools ?? []),
      ...(values["allowed-tools"] ?? []),
    ],
    disallowedTools: [
      ...(values.disallowedTools ?? []),
      ...(values["disallowed-tools"] ?? []),
    ],
  });
  if (values.resume && values.continue)
    throw new Error("Use either --resume or --continue, not both");
  if (values["allow-nonstream-fallback"] && values["no-nonstream-fallback"])
    throw new Error("Conflicting nonstream fallback options");
  if (
    values["dangerously-skip-permissions"] &&
    values["permission-mode"] &&
    values["permission-mode"] !== "bypassPermissions"
  ) {
    throw new Error("Conflicting permission options");
  }
  // Direct API-key launches choose the shipped Opus family when no explicit,
  // environment or settings selection exists. Subscription/host defaults have
  // a separate account-dependent ladder and are not resolved here.
  const model = z
    .string()
    .min(1)
    .parse(
      values.model ??
        (process.env.ANTHROPIC_MODEL || undefined) ??
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
        "claude-opus-5-5",
    );
  return {
    toolPolicy,
    ignorePersistedTrust: values["ignore-persisted-trust"] ?? false,
    permissionPromptTool:
      values["permission-prompt-tool"] === undefined
        ? undefined
        : z
            .string()
            .regex(
              /^mcp__[^\s]+__[^\s]+$/,
              "Use a qualified MCP tool for permission prompting",
            )
            .parse(values["permission-prompt-tool"]),
    permissionPrompts:
      values["permission-prompts"] === undefined
        ? undefined
        : z.literal("host").parse(values["permission-prompts"]),
    settings: values.settings,
    settingSources: values["setting-sources"],
    managedSettings: values["managed-settings"],
    mcpConfig: values["mcp-config"] ?? [],
    strictMcpConfig: values["strict-mcp-config"] ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    print: values.print ?? false,
    model,
    cwd: values.cwd ?? process.cwd(),
    resume: values.resume,
    continue: values.continue ?? false,
    mode: permissionModeSchema.parse(
      values["dangerously-skip-permissions"]
        ? "bypassPermissions"
        : (values["permission-mode"] ?? "default"),
    ),
    format: z
      .enum(["text", "json", "stream-json"])
      .parse(values["output-format"] ?? "text"),
    inputFormat: values["input-format"] ?? "text",
    verbose: values.verbose ?? false,
    includePartialMessages: values["include-partial-messages"] ?? false,
    sessionId: values["session-id"],
    maxTurns: positiveInteger.parse(values["max-turns"] ?? 25),
    maxTokens: positiveInteger.parse(
      values["max-tokens"] ?? defaultOutputTokens(model),
    ),
    pluginDirectories: values["plugin-dir"] ?? [],
    maxTokensExplicit: values["max-tokens"] !== undefined,
    thinking:
      values.thinking === undefined
        ? undefined
        : z.enum(["enabled", "adaptive", "disabled"]).parse(values.thinking),
    maxThinkingTokens:
      values["max-thinking-tokens"] === undefined
        ? undefined
        : z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .parse(values["max-thinking-tokens"]),
    maxRetries:
      values["max-retries"] === undefined
        ? resolveRetryConfiguration().maxRetries
        : z.coerce
            .number()
            .int()
            .min(0)
            .max(MAX_RETRIES)
            .parse(values["max-retries"]),
    maxApiAttempts:
      values["max-api-attempts"] === undefined
        ? undefined
        : z.coerce
            .number()
            .int()
            .min(0)
            .max(MAX_API_ATTEMPTS)
            .parse(values["max-api-attempts"]),
    allowNonStreamingFallback:
      !values["no-nonstream-fallback"] &&
      triBoolean(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) !==
        true,
    fallbackModel:
      values["fallback-model"] === undefined
        ? undefined
        : z.string().min(1).parse(values["fallback-model"]),
    systemPrompt: values["system-prompt"],
    appendSystemPrompt: values["append-system-prompt"],
    systemPromptSnapshot:
      values["system-prompt-snapshot"] === undefined
        ? undefined
        : z.enum(["on", "off"]).parse(values["system-prompt-snapshot"]) ===
          "on",
    prompt: positionals.join(" "),
    modelExplicit: values.model !== undefined,
    modeExplicit:
      values["permission-mode"] !== undefined ||
      values["dangerously-skip-permissions"] === true,
  };
}
export type Options = ReturnType<typeof parseOptions>;

/**
 * Print-protocol flag combinations the original rejects before any work, with
 * its exact messages (main action, chunk-97e8zgw1.js: input format checks,
 * --include-partial-messages, --session-id via tl and Et).
 */
export function printProtocolFlagError(
  options: Options,
  interactive: boolean,
): string | undefined {
  const { inputFormat, format } = options;
  if (inputFormat !== "text" && inputFormat !== "stream-json")
    return `Error: Unknown input format "${inputFormat}".`;
  if (inputFormat === "stream-json" && format !== "stream-json")
    return "Error: --input-format=stream-json requires output-format=stream-json.";
  if (inputFormat === "stream-json" && interactive)
    return "Error: --input-format=stream-json requires --print.";
  if (
    options.includePartialMessages &&
    (interactive || format !== "stream-json")
  )
    return "Error: --include-partial-messages requires --print and --output-format=stream-json.";
  if (options.sessionId === undefined) return;
  if (options.resume || options.continue)
    return "Error: --session-id with --continue or --resume also needs --fork-session.";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options.sessionId,
    )
  )
    return "Error: Invalid session ID. Must be a valid UUID.";
}
export const help = `tau — independent TypeScript coding agent

Usage: tau [options] [prompt]
       echo 'explain this project' | tau -p

  -p, --print                       Run once, then exit (also used for piped input)
      --model NAME                  Model ID (or ANTHROPIC_MODEL)
      --cwd PATH                    Project directory
  -r, --resume UUID_OR_FILE         Resume a tau session or ordinary native .jsonl file
  -c, --continue                    Resume most recently saved session
      --permission-mode MODE        default | acceptEdits | plan | bypassPermissions
      --dangerously-skip-permissions  Explicitly approve all tools; shell is NOT sandboxed
      --tools LIST                  Read Write Edit Glob Grep Bash Skill Agent; '' none, default all
                                    TaskCreate TaskGet TaskUpdate TaskList when enabled
                                    EnterPlanMode ExitPlanMode with interactive approval
      --ignore-persisted-trust       Withhold project skill grants in noninteractive mode
      --permission-prompt-tool NAME MCP tool for headless plan approval (hidden from model tools)
      --permission-prompts host     Use host permission prompts
      --allowedTools LIST           Preapprove exact names (alias: --allowed-tools)
      --disallowedTools LIST        Deny exact names (alias: --disallowed-tools); deny wins
                                    Quote lists and scoped file/Bash rules
                                    MCP: mcp__server or mcp__server__tool (suffix supports *)
      --mcp-config JSON_OR_PATH     Explicit stdio MCP servers; repeat to merge configs
      --plugin-dir PATH            Load an explicit local plugin directory; repeat to add
      --strict-mcp-config           Skip ordinary MCP autodiscovery; use explicit configs
      --settings JSON_OR_PATH       Additional settings document (overrides ordinary sources)
      --setting-sources LIST        user,project,local; empty disables all three
      --managed-settings JSON       Explicit parent managed settings document
      --output-format FORMAT        text | json | stream-json (noninteractive only)
      --verbose                     Required for stream-json print output; json prints every message
      --include-partial-messages    Add stream_event messages (print + stream-json output)
      --input-format FORMAT         text | stream-json (newline-delimited user messages on stdin)
      --session-id UUID             Start a new session with this ID
      --max-turns N                 Maximum model rounds per prompt (default 25)
      --max-tokens N                Maximum output tokens per call (model/catalog default)
      --thinking MODE               enabled | adaptive | disabled (model capability selects wire form)
      --max-thinking-tokens N       Legacy numeric thinking budget; print mode only
      --max-retries N               Ordinary request retries, 0–15 (default 10; environment override)
      --max-api-attempts N          Shared HTTP dispatch allowance per prompt (default unlimited)
      --no-nonstream-fallback       Disable JSON fallback after a supported streaming failure
      --allow-nonstream-fallback    Explicitly allow JSON fallback (enabled by default)
      --fallback-model MODELS       Ordered comma-separated fallback models; primary resets each turn
      --system-prompt TEXT          Replace default instructions
      --append-system-prompt TEXT   Append instructions
      --system-prompt-snapshot MODE on | off; retain launch system instructions on resume
  -h, --help                        Show help
  -v, --version                     Show version

Set ANTHROPIC_API_KEY to use the Messages API. ANTHROPIC_BASE_URL optionally
selects a trusted compatible server. Credentials are never read from ~/.claude.
In print mode, approval-required tools are denied (unless explicitly preapproved).
Sessions: TAU_HOME/sessions (default ~/.tau/sessions). Project CLAUDE.md is sent
as context. /help lists interactive commands.
`;
