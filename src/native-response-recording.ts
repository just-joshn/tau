import { z } from "zod";
import type { NativeJson, NativeObject } from "./native-session-codec.js";

export interface NativeResponseIdentity {
  uuid: string;
  timestamp: string;
}
export interface NativeResponseRecordingHost {
  /** Called exactly at a real closed stream block, or at the actual complete JSON reply. */
  stamp(
    event: Readonly<{
      transport: "stream" | "json";
      apiBlockIndex: number;
      requestedModel: string;
      responseId: string;
      responseModel: string;
      requestId?: string;
    }>,
  ): NativeResponseIdentity;
}
export interface NativeResponseRow extends NativeObject {
  readonly type: "assistant";
  readonly uuid: string;
  readonly timestamp: string;
  readonly apiBlockIndex: number;
  readonly requestedModel: string;
  readonly message: NativeObject;
}
export type NativeResponseRecording =
  | {
      readonly status: "complete";
      readonly transport: "stream" | "json";
      readonly rows: readonly NativeResponseRow[];
    }
  | { readonly status: "unsupported"; readonly reason: string };
export class NativeResponseRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeResponseRecordingError";
  }
}
const fail = (message: string): never => {
  throw new NativeResponseRecordingError(message);
};
function array(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
function object(value: NativeJson | undefined): value is NativeObject {
  return value !== null && typeof value === "object" && !array(value);
}

/** Detached, finite, descriptor-only JSON. Iterative traversal also handles deeply nested tool input. */
export function snapshotNativeResponseJson(input: unknown): NativeJson {
  const active = new Set<object>();
  type Frame = {
    source: object;
    target: NativeJson[] | Record<string, NativeJson>;
    entries: [string, unknown][];
    index: number;
  };
  const frames: Frame[] = [];
  const make = (value: unknown): NativeJson => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || active.has(value))
      return fail("Native response requires finite, acyclic plain JSON");
    const isArray = array(value),
      prototype: unknown = Object.getPrototypeOf(value);
    if (
      isArray
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return fail("Native response requires plain JSON objects");
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
      return fail("Native response cannot contain symbols");
    const entries: [string, unknown][] = [];
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (isArray && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor))
        return fail("Native response cannot contain accessors or hidden data");
      const field: unknown = descriptor.value;
      if (field === undefined && !isArray) continue;
      entries.push([key, field]);
    }
    if (
      isArray &&
      (entries.length !== value.length ||
        entries.some(([key], index) => key !== String(index)))
    )
      return fail("Native response cannot contain sparse or decorated arrays");
    const target: NativeJson[] | Record<string, NativeJson> = isArray ? [] : {};
    active.add(value);
    frames.push({ source: value, target, entries, index: 0 });
    return target;
  };
  const result = make(input);
  while (frames.length) {
    const frame = frames.at(-1);
    if (!frame) break;
    const entry = frame.entries[frame.index++];
    if (!entry) {
      Object.freeze(frame.target);
      active.delete(frame.source);
      frames.pop();
      continue;
    }
    const [key, value] = entry;
    Object.defineProperty(frame.target, key, {
      value: make(value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}
function record(value: unknown, label: string): NativeObject {
  const saved = snapshotNativeResponseJson(value);
  return object(saved)
    ? saved
    : fail(`${label} requires an actual JSON object`);
}
function nonempty(value: NativeJson | undefined, label: string): string {
  return typeof value === "string" && value.length > 0
    ? value
    : fail(`Native response is missing ${label}`);
}
function number(value: NativeJson | undefined): number | undefined {
  if (value === null || value === undefined) return;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail("Native usage field is not a finite number");
}
function nested(value: NativeJson | undefined): NativeObject {
  if (value === null || value === undefined) return {};
  return object(value) ? value : fail("Native usage detail is not an object");
}
export interface NativeResponseUsage extends NativeObject {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  output_tokens_details: { thinking_tokens: number };
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  service_tier: NativeJson;
  inference_geo: NativeJson;
  iterations: NativeJson;
  speed: NativeJson;
  fallback_credit: NativeJson;
}
/** Actual $g/NTe usage state, not synthetic N1o/Pa assistant defaults. */
export function initialNativeResponseUsage(): NativeResponseUsage {
  return {
    output_tokens_details: { thinking_tokens: 0 },
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: "",
    iterations: [],
    speed: "standard",
    fallback_credit: null,
  };
}
export function mergeNativeResponseUsage(
  previous: NativeResponseUsage,
  input: NativeJson | undefined,
): NativeResponseUsage {
  if (input === null || input === undefined) return { ...previous };
  const update = nested(input),
    creation = nested(update.cache_creation);
  const hour = number(creation.ephemeral_1h_input_tokens),
    five = number(creation.ephemeral_5m_input_tokens);
  const created = (hour ?? 0) + (five ?? 0);
  const inputTokens = number(update.input_tokens),
    creationTokens = number(update.cache_creation_input_tokens),
    readTokens = number(update.cache_read_input_tokens);
  const thinking = nested(update.output_tokens_details),
    server = nested(update.server_tool_use);
  return {
    input_tokens:
      inputTokens !== undefined && inputTokens > 0
        ? inputTokens
        : previous.input_tokens,
    cache_creation_input_tokens:
      creationTokens !== undefined && creationTokens > 0
        ? creationTokens
        : created > 0
          ? created
          : previous.cache_creation_input_tokens,
    cache_read_input_tokens:
      readTokens !== undefined && readTokens > 0
        ? readTokens
        : previous.cache_read_input_tokens,
    output_tokens: number(update.output_tokens) ?? previous.output_tokens,
    output_tokens_details: {
      thinking_tokens:
        number(thinking.thinking_tokens) ??
        previous.output_tokens_details.thinking_tokens,
    },
    server_tool_use: {
      web_search_requests:
        number(server.web_search_requests) ??
        previous.server_tool_use.web_search_requests,
      web_fetch_requests:
        number(server.web_fetch_requests) ??
        previous.server_tool_use.web_fetch_requests,
    },
    service_tier: update.service_tier ?? previous.service_tier,
    cache_creation:
      created > 0
        ? {
            ephemeral_1h_input_tokens:
              hour ?? previous.cache_creation.ephemeral_1h_input_tokens,
            ephemeral_5m_input_tokens:
              five ?? previous.cache_creation.ephemeral_5m_input_tokens,
          }
        : { ...previous.cache_creation },
    inference_geo: update.inference_geo ?? previous.inference_geo,
    iterations: update.iterations ?? previous.iterations,
    speed: update.speed ?? previous.speed,
    fallback_credit: update.fallback_credit ?? previous.fallback_credit,
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(input: unknown): NativeResponseIdentity {
  const value = record(input, "Native identity");
  if (
    Object.keys(value).some((key) => key !== "uuid" && key !== "timestamp") ||
    typeof value.uuid !== "string" ||
    !uuid.test(value.uuid) ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp))
  )
    return fail("Native recording host returned an invalid stable identity");
  return { uuid: value.uuid, timestamp: value.timestamp };
}
function sdkMessage(input: unknown): NativeObject {
  const value = record(input, "Native SDK message");
  if (
    value.type !== "message" ||
    value.role !== "assistant" ||
    !array(value.content) ||
    !object(value.usage)
  )
    return fail("Native recording requires an actual SDK assistant message");
  nonempty(value.id, "SDK response ID");
  nonempty(value.model, "SDK model");
  return value;
}
export const nativeResponseRecordingSchema = z
  .unknown()
  .transform((input, context): NativeResponseRecording => {
    try {
      const value = record(input, "Native response carrier");
      if (value.status === "unsupported") {
        if (
          Object.keys(value).some((key) => key !== "status" && key !== "reason")
        )
          return fail("Unexpected unsupported response metadata");
        return Object.freeze({
          status: "unsupported",
          reason: nonempty(value.reason, "recording failure reason"),
        });
      }
      if (
        value.status !== "complete" ||
        (value.transport !== "stream" && value.transport !== "json") ||
        !array(value.rows) ||
        !value.rows.length ||
        Object.keys(value).some(
          (key) => !["status", "transport", "rows"].includes(key),
        )
      )
        return fail("Invalid completed native response carrier");
      const ids = new Set<string>();
      const rows: NativeResponseRow[] = value.rows.map((raw) => {
        const row = record(raw, "Native response row"),
          stamp = identity({ uuid: row.uuid, timestamp: row.timestamp });
        if (
          row.type !== "assistant" ||
          typeof row.apiBlockIndex !== "number" ||
          !Number.isSafeInteger(row.apiBlockIndex) ||
          row.apiBlockIndex < 0 ||
          Object.keys(row).some(
            (key) =>
              ![
                "type",
                "uuid",
                "timestamp",
                "apiBlockIndex",
                "requestedModel",
                "requestId",
                "message",
              ].includes(key),
          ) ||
          ids.has(stamp.uuid)
        )
          return fail("Invalid or duplicated native response row");
        ids.add(stamp.uuid);
        const message = sdkMessage(row.message);
        nonempty(message.stop_reason, "actual final stop reason");
        return Object.freeze({
          ...stamp,
          type: "assistant",
          apiBlockIndex: row.apiBlockIndex,
          requestedModel: nonempty(row.requestedModel, "requested model"),
          ...(row.requestId === undefined
            ? {}
            : {
                requestId:
                  typeof row.requestId === "string"
                    ? row.requestId
                    : fail(
                        "Native request ID must be the actual header string",
                      ),
              }),
          message,
        });
      });
      if (
        value.transport === "json" &&
        (rows.length !== 1 || rows[0]?.apiBlockIndex !== 0)
      )
        return fail(
          "JSON reply requires exactly one genuine row at index zero",
        );
      return Object.freeze({
        status: "complete",
        transport: value.transport,
        rows: Object.freeze(rows),
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof NativeResponseRecordingError
            ? error.message
            : "Invalid native response recording",
      });
      return z.NEVER;
    }
  });
export interface NativeResponseRecordingContext {
  host: NativeResponseRecordingHost;
  requestedModel: string;
  requestId?: string;
  normalizeContent?(content: readonly NativeJson[]): readonly unknown[];
}
function completedRecording(input: unknown): NativeResponseRecording {
  const result = nativeResponseRecordingSchema.safeParse(input);
  if (!result.success)
    return fail(
      result.error.issues[0]?.message ?? "Invalid finalized native response",
    );
  return result.data;
}
function stamp(
  context: NativeResponseRecordingContext,
  message: NativeObject,
  transport: "stream" | "json",
  apiBlockIndex: number,
): NativeResponseIdentity {
  try {
    return identity(
      context.host.stamp(
        Object.freeze({
          transport,
          apiBlockIndex,
          requestedModel: context.requestedModel,
          responseId: nonempty(message.id, "response ID"),
          responseModel: nonempty(message.model, "response model"),
          ...(context.requestId === undefined
            ? {}
            : { requestId: context.requestId }),
        }),
      ),
    );
  } catch (error) {
    if (error instanceof NativeResponseRecordingError) throw error;
    return fail("Native response identity host failed");
  }
}
function unsupportedContext(value: NativeJson | undefined): void {
  if (value !== undefined && value !== null)
    fail(
      "Native context-management recording requires its actual projection host",
    );
}
export function unsupportedNativeResponse(
  reason: string,
): NativeResponseRecording {
  return Object.freeze({ status: "unsupported", reason });
}

/** One generation attempt. No abandoned/retried stream can donate rows to another attempt. */
export class NativeStreamResponseRecording {
  private header: NativeObject | undefined;
  private usage = initialNativeResponseUsage();
  private stopReason: string | null = null;
  private readonly rows: NativeResponseRow[] = [];
  constructor(private readonly context: NativeResponseRecordingContext) {
    if (!context.requestedModel)
      fail("Native response requires its actual requested model");
  }
  start(source: unknown): void {
    const event = record(source, "Native stream start");
    if (event.type !== "message_start")
      fail("Native recording requires its real start event");
    if (this.header) fail("Native stream response already started");
    this.header = sdkMessage(event.message);
    unsupportedContext(this.header.context_management);
    this.usage = mergeNativeResponseUsage(this.usage, this.header.usage);
  }
  closeBlock(apiBlockIndex: number, block: unknown): void {
    if (!this.header)
      return fail("Native block is missing its real SDK message");
    const normalized = this.context.normalizeContent?.([
      snapshotNativeResponseJson(block),
    ]) ?? [snapshotNativeResponseJson(block)];
    const content = snapshotNativeResponseJson(normalized);
    const saved = stamp(this.context, this.header, "stream", apiBlockIndex);
    if (this.rows.some((row) => row.uuid === saved.uuid))
      fail("Native response host reused a block identity");
    this.rows.push({
      ...saved,
      type: "assistant",
      apiBlockIndex,
      requestedModel: this.context.requestedModel,
      ...(this.context.requestId === undefined
        ? {}
        : { requestId: this.context.requestId }),
      message: { ...this.header, content },
    });
  }
  delta(source: unknown): void {
    const event = record(source, "Native message delta"),
      delta = nested(event.delta);
    if (event.type !== "message_delta")
      fail("Native recording requires its real delta event");
    unsupportedContext(event.context_management);
    this.usage = mergeNativeResponseUsage(this.usage, event.usage);
    const actualStop =
      typeof delta.stop_reason === "string" ? delta.stop_reason : null;
    if (actualStop !== null) this.stopReason = actualStop;
    let details = delta.stop_details ?? null;
    // The native delta consumer removes the private credit token before recording stop details.
    if (object(details) && Object.hasOwn(details, "fallback_credit_token"))
      details = Object.fromEntries(
        Object.entries(details).filter(
          ([key]) => key !== "fallback_credit_token",
        ),
      );
    const resumable =
      typeof delta.resumable === "boolean"
        ? delta.resumable
        : typeof event.resumable === "boolean"
          ? event.resumable
          : undefined;
    for (let index = 0; index < this.rows.length; index++) {
      const row = this.rows[index];
      if (!row) continue;
      this.rows[index] = {
        ...row,
        message: {
          ...row.message,
          usage: this.usage,
          stop_reason: this.stopReason,
          ...(actualStop !== null || this.stopReason === null
            ? { stop_details: details }
            : {}),
          ...(resumable === undefined ? {} : { resumable }),
        },
      };
    }
  }
  completed(): NativeResponseRecording {
    if (!this.stopReason || !this.rows.length)
      return unsupportedNativeResponse(
        "The stream has no finalized native assistant rows",
      );
    return completedRecording({
      status: "complete",
      transport: "stream",
      rows: this.rows,
    });
  }
}
export function recordNativeJsonResponse(
  context: NativeResponseRecordingContext,
  source: unknown,
  normalizedContent: unknown,
): NativeResponseRecording {
  const message = sdkMessage(source);
  unsupportedContext(message.context_management);
  nonempty(message.stop_reason, "actual JSON stop reason");
  const content = snapshotNativeResponseJson(normalizedContent);
  const saved = stamp(context, message, "json", 0);
  return completedRecording({
    status: "complete",
    transport: "json",
    rows: [
      {
        ...saved,
        type: "assistant",
        apiBlockIndex: 0,
        requestedModel: context.requestedModel,
        ...(context.requestId === undefined
          ? {}
          : { requestId: context.requestId }),
        message: {
          ...message,
          content,
          usage: mergeNativeResponseUsage(
            initialNativeResponseUsage(),
            message.usage,
          ),
        },
      },
    ],
  });
}
