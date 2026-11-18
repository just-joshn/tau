import { integerSetting, triBoolean } from "./env-settings.js";
import { modelFacts, type ModelFacts } from "./model-facts.js";

export type ThinkingMode = "enabled" | "adaptive" | "disabled";
export interface ThinkingOptions {
  mode?: ThinkingMode;
  maxThinkingTokens?: number;
  alwaysThinkingEnabled?: boolean;
  mechanical?: boolean;
}
export type ThinkingRequest = { type: "adaptive" } | { type: "enabled"; budget_tokens: number } | { type: "disabled" };
const overrides = ["FABLE", "OPUS", "SONNET", "HAIKU"] as const;
const isOverride = (value: string): value is typeof overrides[number] => overrides.some(override => override === value);

export function resolvedModelName(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = model.trim(), tagged = /\[1m\]$/i.test(value);
  const alias = value.replace(/\[1m\]$/i, "").trim().toUpperCase();
  const replacement = isOverride(alias) ? env[`ANTHROPIC_DEFAULT_${alias}_MODEL`]?.trim() : undefined;
  if (!replacement) return value;
  return tagged ? replacement.replace(/(?:\[1m\])+$/i, "") + "[1m]" : replacement;
}

export function resolveModelFacts(model: string, env: NodeJS.ProcessEnv = process.env): ModelFacts {
  model = resolvedModelName(model, env);
  const facts = modelFacts(model);
  const entries = overrides.map(family => [env[`ANTHROPIC_DEFAULT_${family}_MODEL`], env[`ANTHROPIC_DEFAULT_${family}_MODEL_SUPPORTED_CAPABILITIES`]]);
  entries.push([env.ANTHROPIC_CUSTOM_MODEL_OPTION, env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES]);
  for (const [name, capabilities] of entries) {
    if (!name?.trim() || capabilities === undefined || ![model.toLowerCase(), facts.canonical, facts.wire.toLowerCase()].includes(name.trim().toLowerCase())) continue;
    const list = capabilities.toLowerCase().split(",").map(value => value.trim());
    return { ...facts, supportsThinking: list.includes("thinking"), adaptive: list.includes("adaptive_thinking") };
  }
  return facts;
}

export function supportsInterleavedThinking(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const facts = resolveModelFacts(model, env);
  for (const family of [...overrides, "CUSTOM"] as const) {
    const name = family === "CUSTOM" ? env.ANTHROPIC_CUSTOM_MODEL_OPTION : env[`ANTHROPIC_DEFAULT_${family}_MODEL`];
    const caps = family === "CUSTOM" ? env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES : env[`ANTHROPIC_DEFAULT_${family}_MODEL_SUPPORTED_CAPABILITIES`];
    if (name?.trim() && caps !== undefined && [model.toLowerCase(), facts.canonical, facts.wire.toLowerCase()].includes(name.trim().toLowerCase())) return caps.toLowerCase().split(",").some(value => value.trim() === "interleaved_thinking");
  }
  return !facts.canonical.includes("claude-3-");
}

export function defaultOutputTokens(model: string, env: NodeJS.ProcessEnv = process.env): number {
  const facts = resolveModelFacts(model, env), configured = integerSetting(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 1);
  return configured === undefined ? facts.defaultOutput : Math.min(configured, facts.upperOutput);
}

const fourBytesPerToken = new Set(["claude-3-opus", "claude-3-sonnet", "claude-3-haiku", "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-7-sonnet",
  "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6", "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5"]);
export function modelBytesPerToken(model?: string): number {
  return model === undefined ? 4 : fourBytesPerToken.has(resolveModelFacts(model).canonical.replace(/[._]/g, "-").replace(/-\d{8}$/, "")) ? 4 : 3;
}

export function usesAssumedOutputLimit(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveModelFacts(model, env).assumed && integerSetting(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 1) === undefined;
}

export function thinkingRequest(model: string, maxTokens: number, options: ThinkingOptions = {}, env: NodeJS.ProcessEnv = process.env): ThinkingRequest | undefined {
  const facts = resolveModelFacts(model, env);
  if (triBoolean(env.CLAUDE_CODE_DISABLE_THINKING) === true || !facts.supportsThinking) return;
  let enabled = options.alwaysThinkingEnabled !== false;
  let budget: number | undefined;
  if (options.mode !== undefined) enabled = options.mode !== "disabled";
  else {
    const raw = env.MAX_THINKING_TOKENS;
    const selected = raw ? integerSetting(raw) : options.maxThinkingTokens;
    if (selected !== undefined) { enabled = selected > 0; if (enabled) budget = selected; }
    else if (raw) enabled = false;
  }
  if (!enabled && facts.alwaysOn && !options.mechanical) enabled = true;
  if (!enabled) return facts.rejectsDisabled ? undefined : { type: "disabled" };
  const suppressAdaptive = triBoolean(env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) === true && (facts.canonical.includes("opus-4-6") || facts.canonical.includes("sonnet-4-6"));
  if (facts.adaptive && !suppressAdaptive) return { type: "adaptive" };
  return { type: "enabled", budget_tokens: Math.max(1024, Math.min(maxTokens - 1, usesAssumedOutputLimit(model, env) ? 31999 : Infinity, budget ?? facts.upperOutput - 1)) };
}
