/** Factual first-party IDs/limits/capabilities from the pinned installed model catalog; no target code. */
export interface ModelContextFacts {
  window?: number;
  maximum_window?: number;
  native_1m?: boolean;
  supports_1m_beta?: boolean;
  supports_1m_suffix?: boolean;
  clamp_long_context_without_beta?: boolean;
}
const models: Record<
  string,
  readonly [
    wire: string,
    defaultOutput: number,
    upperOutput: number,
    adaptive: boolean,
    rejectsDisabled: boolean,
    context?: ModelContextFacts,
  ]
> = {
  "claude-3-5-haiku": [
    "claude-3-5-haiku-20241022",
    8192,
    8192,
    false,
    false,
    {},
  ],
  "claude-haiku-4-5": [
    "claude-haiku-4-5-20251001",
    32000,
    64000,
    false,
    false,
    { window: 200000, supports_1m_suffix: true },
  ],
  "claude-haiku-5-5": [
    "claude-haiku-5-5",
    128000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-3-5-sonnet": [
    "claude-3-5-sonnet-20241022",
    8192,
    8192,
    false,
    false,
    {},
  ],
  "claude-3-7-sonnet": [
    "claude-3-7-sonnet-20250219",
    32000,
    64000,
    false,
    false,
    {},
  ],
  "claude-sonnet-4-0": [
    "claude-sonnet-4-20250514",
    32000,
    64000,
    false,
    false,
    {
      window: 200000,
      maximum_window: 1000000,
      supports_1m_beta: true,
      clamp_long_context_without_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-sonnet-4-5": [
    "claude-sonnet-4-5-20250929",
    32000,
    64000,
    false,
    false,
    {
      window: 200000,
      maximum_window: 1000000,
      supports_1m_beta: true,
      clamp_long_context_without_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-sonnet-4-6": [
    "claude-sonnet-4-6",
    32000,
    128000,
    true,
    false,
    {
      window: 200000,
      maximum_window: 1000000,
      supports_1m_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-sonnet-5": [
    "claude-sonnet-5",
    64000,
    128000,
    true,
    false,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-sonnet-5-5": [
    "claude-sonnet-5-5",
    128000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-opus-4-0": [
    "claude-opus-4-20250514",
    32000,
    32000,
    false,
    false,
    { window: 200000, supports_1m_suffix: true },
  ],
  "claude-opus-4-1": [
    "claude-opus-4-1-20250805",
    32000,
    32000,
    false,
    false,
    { window: 200000, supports_1m_suffix: true },
  ],
  "claude-opus-4-5": [
    "claude-opus-4-5-20251101",
    32000,
    64000,
    false,
    false,
    { window: 200000, supports_1m_suffix: true },
  ],
  "claude-opus-4-6": [
    "claude-opus-4-6",
    64000,
    128000,
    true,
    false,
    {
      window: 200000,
      maximum_window: 1000000,
      supports_1m_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-opus-4-7": [
    "claude-opus-4-7",
    64000,
    128000,
    true,
    false,
    {
      window: 1000000,
      native_1m: true,
      supports_1m_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-opus-4-8": [
    "claude-opus-4-8",
    64000,
    128000,
    true,
    false,
    {
      window: 1000000,
      native_1m: true,
      supports_1m_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-opus-5": [
    "claude-opus-5",
    64000,
    128000,
    true,
    false,
    {
      window: 1000000,
      native_1m: true,
      supports_1m_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-opus-5-5": [
    "claude-opus-5-5",
    128000,
    128000,
    true,
    true,
    {
      window: 1000000,
      native_1m: true,
      supports_1m_beta: true,
      supports_1m_suffix: true,
    },
  ],
  "claude-fable-5": [
    "claude-fable-5",
    64000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-fable-5-1": [
    "claude-fable-5-1",
    64000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-fable-5-2": [
    "claude-fable-5-2",
    128000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-mythos-5": [
    "claude-mythos-5",
    64000,
    128000,
    false,
    false,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-mythos-5-1": [
    "claude-mythos-5-1",
    64000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
  "claude-mythos-5-2": [
    "claude-mythos-5-2",
    128000,
    128000,
    true,
    true,
    { window: 1000000, native_1m: true, supports_1m_beta: true },
  ],
};
const aliases: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
};
export interface ModelFacts {
  canonical: string;
  wire: string;
  defaultOutput: number;
  upperOutput: number;
  adaptive: boolean;
  supportsThinking: boolean;
  rejectsDisabled: boolean;
  alwaysOn: boolean;
  assumed: boolean;
  context: ModelContextFacts;
  recognized: boolean;
}
export function modelFacts(model: string): ModelFacts {
  const raw = model.trim().replace(/\[(?:1|2)m\]/gi, "");
  const key = raw.toLowerCase();
  const canonical =
    aliases[key] ??
    Object.keys(models).find((id) => id === key || models[id]?.[0] === key) ??
    key;
  const facts = models[canonical];
  if (facts)
    return {
      canonical,
      wire: facts[0],
      defaultOutput: facts[1],
      upperOutput: facts[2],
      adaptive: canonical === "claude-mythos-5" || facts[3],
      supportsThinking: !canonical.includes("claude-3-"),
      rejectsDisabled: facts[4],
      alwaysOn: facts[4],
      assumed: false,
      context: facts[5] ?? {},
      recognized: true,
    };
  const legacy =
    canonical === "claude-3-opus" || canonical === "claude-3-haiku"
      ? 4096
      : canonical === "claude-3-sonnet"
        ? 8192
        : undefined;
  return {
    canonical,
    wire: raw,
    defaultOutput: legacy ?? 32000,
    upperOutput: legacy ?? 128000,
    adaptive: !canonical.includes("claude-3-"),
    supportsThinking: !canonical.includes("claude-3-"),
    rejectsDisabled: !canonical.includes("claude-3-"),
    alwaysOn: false,
    assumed: legacy === undefined,
    context: {},
    recognized: legacy !== undefined,
  };
}
