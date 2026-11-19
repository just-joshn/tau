import { integerSetting, triBoolean } from "./env-settings.js";
import { resolvedModelName, resolveModelFacts } from "./reasoning.js";

export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
export interface ContextPolicy {
  sdkBetas?: string[];
  context1mRefused?: boolean;
  longContextCreditsBlocked?: boolean;
  authenticatedFirstParty?: boolean;
  sonnetContextWindow?: string;
  intermediateWindows?: Record<string, unknown>;
  runtime?: { maxInputTokens?: number; contextWindow?: number };
}
export interface ContextWindow {
  window: number;
  withoutOptIn: number;
  source: string;
  beta: boolean;
  native: boolean;
  recognized: boolean;
}

export function contextWindow(
  model: string,
  policy: ContextPolicy = {},
  env: NodeJS.ProcessEnv = process.env,
): ContextWindow {
  const facts = resolveModelFacts(model, env),
    data = facts.context;
  const requested = resolvedModelName(model, env);
  const disabled = triBoolean(env.CLAUDE_CODE_DISABLE_1M_CONTEXT) === true;
  const configured = integerSetting(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 1);
  const explicit =
    triBoolean(env.DISABLE_COMPACT) === true ? configured : undefined;
  const suffix = !disabled && /\[1m\]/i.test(requested);
  const native =
    !disabled &&
    (data.native_1m === true || facts.canonical === "claude-mythos-preview");
  const runtimeValue =
    policy.runtime?.maxInputTokens ?? policy.runtime?.contextWindow;
  const declared =
    typeof runtimeValue === "number" &&
    Number.isInteger(runtimeValue) &&
    runtimeValue >= 100000 &&
    runtimeValue <= 10000000
      ? runtimeValue
      : undefined;
  let sonnet: number | undefined;
  if (
    !disabled &&
    !suffix &&
    !policy.context1mRefused &&
    facts.canonical === "claude-sonnet-4-6" &&
    typeof policy.sonnetContextWindow === "string"
  ) {
    const parsed = Number.parseInt(policy.sonnetContextWindow, 10);
    if (Number.isFinite(parsed) && parsed > 200000 && parsed <= 1000000)
      sonnet = parsed;
  }
  const historical =
    facts.canonical.includes("claude-3-") ||
    [
      "claude-opus-4-0",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-haiku-4-5",
    ].includes(facts.canonical);
  const betaSupport =
    !disabled &&
    !historical &&
    (data.supports_1m_beta === true || declared === undefined);
  const requestedBetas = [
    ...(policy.sdkBetas ?? []),
    ...(env.ANTHROPIC_BETAS?.split(",").map((value) => value.trim()) ?? []),
  ];
  const optIn =
    !policy.context1mRefused &&
    (suffix || (betaSupport && requestedBetas.includes(LONG_CONTEXT_BETA)));
  const cap =
    data.maximum_window === undefined ? Infinity : (data.window ?? Infinity);
  let withoutOptIn: number, source: string;
  if (declared !== undefined) {
    withoutOptIn =
      sonnet ?? Math.min(declared, cap, disabled ? 200000 : Infinity);
    source = "runtime";
  } else if (native) {
    withoutOptIn = data.window ?? 1000000;
    source = "native";
  } else if (sonnet !== undefined) {
    withoutOptIn = sonnet;
    source = "clientdata";
  } else if (facts.recognized || facts.canonical === "claude-mythos-preview") {
    withoutOptIn = 200000;
    source = "catalog";
  } else {
    withoutOptIn = configured ?? (disabled ? 200000 : 1000000);
    source = configured === undefined ? "unknown" : "environment";
  }
  let window = withoutOptIn;
  const intermediate = policy.intermediateWindows?.[facts.canonical];
  if (optIn) {
    window = Math.max(
      withoutOptIn,
      data.maximum_window ?? data.window ?? 0,
      1000000,
    );
    source = "opt-in";
  } else if (
    policy.authenticatedFirstParty &&
    !disabled &&
    !policy.longContextCreditsBlocked &&
    sonnet === undefined &&
    ["claude-opus-4-6", "claude-sonnet-4-6"].includes(facts.canonical) &&
    typeof intermediate === "number" &&
    Number.isInteger(intermediate) &&
    intermediate < 1000000 &&
    Math.min(intermediate, declared ?? intermediate) > 200000
  ) {
    window = Math.min(intermediate, declared ?? intermediate);
    source = "intermediate";
  } else if (sonnet === undefined) window = Math.min(window, cap);
  if (policy.longContextCreditsBlocked && window > 200000) {
    window = 200000;
    source = "credits";
  }
  if (explicit !== undefined) {
    window = explicit;
    source = "compact-disabled-override";
  }
  const explicitBeta = requestedBetas.includes(LONG_CONTEXT_BETA);
  const beta =
    !policy.context1mRefused &&
    (explicitBeta || (!native && (suffix || sonnet !== undefined)));
  return {
    window,
    withoutOptIn,
    source,
    beta,
    native,
    recognized:
      facts.recognized ||
      declared !== undefined ||
      facts.canonical === "claude-mythos-preview",
  };
}
