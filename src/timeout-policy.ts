import {
  integerSetting,
  positiveRawNumber,
  triBoolean,
} from "./env-settings.js";

export const MAX_TIMER_MS = 2147483647;
const MIN_CONFIG_MS = 10000;
const MAX_IDLE_MS = 1800000;

export interface TimeoutPolicy {
  requestMs: number;
  configuredRequestMs: number | undefined;
  nonStreamingMs: number;
  eventIdleMs: number;
  byteIdleMs: number;
  firstByteMs: number;
  byteWatchdog: boolean;
  eventWatchdog: boolean;
  firstHeaderWatchdog: boolean;
  timerSlackMs: number;
}

type RemoteConfig = {
  api_timeout_ms?: unknown;
  stream_idle_timeout_ms?: unknown;
};
type Features = {
  byteWatchdogDefaultOn?: boolean;
  byteStreamIdleMs?: number;
  streamTimerSlackMs?: number;
};
function remoteDuration(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CONFIG_MS &&
    value <= MAX_TIMER_MS
    ? value
    : undefined;
}
const clampIdle = (value: number) =>
  Math.min(MAX_IDLE_MS, Math.max(MIN_CONFIG_MS, value));

/** Recovered settings for the direct Messages provider; remote values/flags are supplied by its caller. */
export function resolveTimeoutPolicy(
  options: {
    env?: NodeJS.ProcessEnv;
    baseUrl?: string;
    remoteConfig?: RemoteConfig;
    features?: Features;
    assumesFirstPartyBaseUrl?: boolean;
  } = {},
): TimeoutPolicy {
  const env = options.env ?? process.env;
  const features = options.features ?? {};
  const base = options.baseUrl ?? env.ANTHROPIC_BASE_URL;
  let official = !base;
  if (base) {
    try {
      official = new URL(base).host === "api.anthropic.com";
    } catch {
      official = false;
    }
  }
  const assumed =
    triBoolean(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL) ??
    options.assumesFirstPartyBaseUrl ??
    false;
  const firstParty = assumed || official;
  const configuredRequestMs =
    integerSetting(env.API_TIMEOUT_MS) ??
    remoteDuration(options.remoteConfig?.api_timeout_ms);
  const requestMs =
    configuredRequestMs === undefined
      ? 600000
      : configuredRequestMs > 0
        ? configuredRequestMs
        : MAX_TIMER_MS;
  const streamSetting =
    positiveRawNumber(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS) ??
    (() => {
      const remote = remoteDuration(
        options.remoteConfig?.stream_idle_timeout_ms,
      );
      return remote === undefined ? undefined : Math.min(remote, MAX_IDLE_MS);
    })();
  const eventIdleMs = Math.max(streamSetting ?? 0, 300000);
  let byteIdleMs = positiveRawNumber(env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(byteIdleMs)) byteIdleMs = undefined;
  if (byteIdleMs === undefined) {
    byteIdleMs = eventIdleMs;
    if (streamSetting === undefined && firstParty) {
      const featureIdleMs = features.byteStreamIdleMs;
      byteIdleMs =
        featureIdleMs !== undefined &&
        Number.isFinite(featureIdleMs) &&
        featureIdleMs > 0
          ? featureIdleMs
          : 180000;
    }
  }
  const byteWatchdog =
    triBoolean(env.CLAUDE_ENABLE_BYTE_WATCHDOG) ??
    features.byteWatchdogDefaultOn ??
    true;
  const slack =
    integerSetting(env.CLAUDE_CODE_STREAM_TIMER_SLACK_MS, 0, 1000, true) ??
    features.streamTimerSlackMs ??
    0;
  return {
    requestMs,
    configuredRequestMs,
    nonStreamingMs:
      configuredRequestMs !== undefined && configuredRequestMs > 0
        ? Math.min(configuredRequestMs, MAX_TIMER_MS)
        : triBoolean(env.CLAUDE_CODE_REMOTE)
          ? 120000
          : 300000,
    eventIdleMs,
    byteIdleMs: clampIdle(byteIdleMs),
    firstByteMs: clampIdle(
      integerSetting(env.CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS, 1) ??
        clampIdle(byteIdleMs),
    ),
    byteWatchdog,
    eventWatchdog: triBoolean(env.CLAUDE_ENABLE_STREAM_WATCHDOG) ?? true,
    firstHeaderWatchdog: byteWatchdog && firstParty,
    timerSlackMs:
      Number.isInteger(slack) && slack >= 0 && slack <= 1000 ? slack : 0,
  };
}

/** No-response-header window: upload allowance plus distinct first/retry windows. */
export function firstHeaderWindow(
  policy: TimeoutPolicy,
  requestBytes: number,
  escalated: boolean,
): number | undefined {
  if (!policy.firstHeaderWatchdog) return;
  const configured = policy.configuredRequestMs ?? 600000;
  const limit = configured <= 0 ? Infinity : configured - 1000;
  if (limit < MIN_CONFIG_MS) return;
  const upload = Math.ceil(requestBytes / 32768) * 1000;
  const first = Math.min(policy.firstByteMs + upload, limit);
  return escalated
    ? Number.isFinite(limit)
      ? limit
      : Math.max(policy.firstByteMs + upload, 600000 + upload)
    : first;
}
