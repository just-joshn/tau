const alwaysTerminal = new Set([
  "org_spend_cap_reached",
  "org_level_disabled_until",
]);
const terminalWithoutSubscription = new Set([
  ...alwaysTerminal,
  "out_of_credits",
  "org_level_disabled",
  "org_service_level_disabled",
]);

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode?: string,
    readonly context?: ContextRejection,
  ) {
    super(`Messages API HTTP error ${status}`);
    this.name = "ProviderHttpError";
  }
}

export function apiErrorInfo(body: unknown): {
  message: string;
  code?: string;
  type?: string;
} {
  const error = object(object(body)?.error);
  const code = object(error?.details)?.error_code;
  return {
    message: typeof error?.message === "string" ? error.message : "",
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof error?.type === "string" ? { type: error.type } : {}),
  };
}

export function resumePrefillRefused(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 408, 409, 429, 451].includes(error.status) &&
    ![
      "dlp_request_denied",
      "claude_code_version_too_old",
      "safety_monitor_blocked",
    ].includes(error.errorCode ?? "")
  );
}

export function betaHeaderRejected(message: string, header: string): boolean {
  if (message.includes(header) && /anthropic[-_]beta/.test(message))
    return true;
  return capabilityRejected(message, `beta_header:${header}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

/** Decisions only: raw upstream error strings are never returned to the caller. */
export function terminalHttpFailure(
  status: number,
  headers: Headers,
  body: unknown,
): boolean {
  const error = object(object(body)?.error);
  const code = object(error?.details)?.error_code;
  if (
    code === "dlp_request_denied" ||
    (status === 400 && error?.type === "policy_blocked")
  )
    return true;
  if (status !== 429) return false;
  const message = typeof error?.message === "string" ? error.message : "";
  const reason = headers.get(
    "anthropic-ratelimit-unified-overage-disabled-reason",
  );
  const requiresCredits =
    code === "credits_required" ||
    /usage credits are required|extra usage is required/i.test(message);
  if (
    requiresCredits &&
    reason !== "fetch_error" &&
    reason !== "org_level_disabled_until"
  )
    return true;
  if (message.includes("service_spend_limit_reached")) return true;
  const subscription = Boolean(
    headers.get("anthropic-ratelimit-unified-representative-claim") ||
    headers.get("anthropic-ratelimit-unified-overage-status"),
  );
  if (
    reason &&
    (alwaysTerminal.has(reason) ||
      (!subscription && terminalWithoutSubscription.has(reason)))
  )
    return true;
  const embeddedReason = message.includes("exceeded_limit")
    ? /\\?"overageDisabledReason\\?":\s*\\?"([a-z_]+)\\?"/.exec(message)?.[1]
    : undefined;
  return (
    embeddedReason !== undefined &&
    terminalWithoutSubscription.has(embeddedReason)
  );
}

/** Bounded best-effort metadata inspection; malformed/slow bodies provide no metadata. */
export async function readErrorMetadata(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const media =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  if (
    !response.body ||
    (media !== "application/json" &&
      !/^application\/[\w.+-]+\+json$/.test(media))
  )
    return;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 65536) return;
  const body: ReadableStream<Uint8Array> = response.body,
    reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, 1000);
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (expired) return;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) return;
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    signal.throwIfAborted();
    return;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
import { capabilityRejected, type ContextRejection } from "./context-error.js";
