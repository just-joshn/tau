import { integerSetting, triBoolean } from "./env-settings.js";

/** Application defaults; active request retries are owned above the SDK. */
export const DEFAULT_MAX_RETRIES = 10;
export const MAX_RETRIES = 15;
export const MAX_RETRY_DELAY_MS = 60000;

export function resolveRetryConfiguration(env: NodeJS.ProcessEnv = process.env): { maxRetries: number; watchdog: boolean; capacityOnly: boolean } {
  const watchdog = triBoolean(env.CLAUDE_CODE_RETRY_WATCHDOG) === true;
  const capacityOnly = watchdog && env.CLAUDE_CODE_RETRY_WATCHDOG_SCOPE === "capacity";
  const broad = watchdog && !capacityOnly;
  const configured = integerSetting(env.CLAUDE_CODE_MAX_RETRIES, 0);
  return { maxRetries: configured === undefined ? broad ? 300 : DEFAULT_MAX_RETRIES : broad ? configured : Math.min(configured, MAX_RETRIES), watchdog, capacityOnly };
}

export function retryableStatus(status: number, headers: Headers): boolean {
  if (status < 400 || status > 599) return false;
  const hint = headers.get("x-should-retry");
  if (hint === "false") return false;
  return hint === "true" || status === 408 || status === 409 || status === 429 || status >= 500;
}

function serverDelay(headers: Headers, now: number): number | undefined {
  const milliseconds = headers.get("retry-after-ms")?.trim();
  if (milliseconds && Number.isFinite(Number(milliseconds)) && Number(milliseconds) > 0) return Number(milliseconds);
  const after = headers.get("retry-after")?.trim();
  if (!after) return;
  const numeric = Number(after);
  // Numeric but negative/nonfinite values must not accidentally be interpreted as dates.
  if (!Number.isNaN(numeric)) return Number.isFinite(numeric) && numeric > 0 ? numeric * 1000 : undefined;
  const date = Date.parse(after);
  return Number.isFinite(date) && date > now ? date - now : undefined;
}

/** attempt=1 is the first retry, after the original request fails. */
export function retryDelay(attempt: number, headers = new Headers(), random = Math.random, now = Date.now()): number {
  const backoff = Math.round(Math.min(32000, 500 * 2 ** (attempt - 1)) * (1 + random() * 0.25));
  const server = serverDelay(headers, now);
  return server === undefined ? backoff : Math.max(backoff, Math.round(server * (1 + random() * 0.25)));
}
