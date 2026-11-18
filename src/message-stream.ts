import { z } from "zod";
import {
  assistantBlockSchema,
  type Completion,
  type CompletionRequest,
  type Usage,
} from "./types.js";
import { classifyStreamFailure, type StreamFailureCause } from "./recovery.js";
import { normalizeToolInput, normalizeToolName } from "./tool-input.js";
import { clearedInputTokens } from "./context-usage.js";
import {
  NativeStreamResponseRecording,
  unsupportedNativeResponse,
  type NativeResponseRecordingContext,
} from "./native-response-recording.js";

const count = z.number().int().nonnegative();
const cacheUsage = {
  cache_creation_input_tokens: count.nullable().optional(),
  cache_read_input_tokens: count.nullable().optional(),
  cache_creation: z
    .object({
      ephemeral_1h_input_tokens: count.optional(),
      ephemeral_5m_input_tokens: count.optional(),
    })
    .nullable()
    .optional(),
  iterations: z.array(z.unknown()).optional(),
};
export function mergeUsage(
  previous: Usage,
  update: {
    input_tokens?: number | null | undefined;
    output_tokens?: number | null | undefined;
    cache_creation_input_tokens?: number | null | undefined;
    cache_read_input_tokens?: number | null | undefined;
    cache_creation?:
      | {
          ephemeral_1h_input_tokens?: number | undefined;
          ephemeral_5m_input_tokens?: number | undefined;
        }
      | null
      | undefined;
    iterations?: unknown[] | undefined;
  },
): Usage {
  const result = {
    ...previous,
    input_tokens:
      update.input_tokens != null && update.input_tokens > 0
        ? update.input_tokens
        : previous.input_tokens,
    output_tokens: update.output_tokens ?? previous.output_tokens,
  };
  const created =
    (update.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
    (update.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  const cacheCreation = update.cache_creation_input_tokens ?? 0,
    cacheRead = update.cache_read_input_tokens ?? 0;
  if (
    created > 0 ||
    update.cache_creation_input_tokens != null ||
    previous.cache_creation_input_tokens !== undefined
  )
    result.cache_creation_input_tokens =
      cacheCreation > 0
        ? cacheCreation
        : created > 0
          ? created
          : (previous.cache_creation_input_tokens ?? 0);
  if (
    update.cache_read_input_tokens != null ||
    previous.cache_read_input_tokens !== undefined
  )
    result.cache_read_input_tokens =
      cacheRead > 0 ? cacheRead : (previous.cache_read_input_tokens ?? 0);
  if (update.iterations !== undefined) result.iterations = update.iterations;
  return result;
}
export const streamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      type: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  }),
  z.object({
    type: z.literal("message_start"),
    message: z.object({
      role: z.literal("assistant"),
      model: z.string().optional(),
      id: z.string().optional(),
      content: z.array(assistantBlockSchema).length(0),
      usage: z.object({
        input_tokens: count,
        output_tokens: count,
        ...cacheUsage,
      }),
    }),
  }),
  z.object({
    type: z.literal("content_block_start"),
    index: count,
    content_block: assistantBlockSchema,
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: count,
    delta: z.discriminatedUnion("type", [
      z.object({ type: z.literal("text_delta"), text: z.string() }),
      z.object({
        type: z.literal("input_json_delta"),
        partial_json: z.string(),
      }),
      z.object({
        type: z.literal("thinking_delta"),
        thinking: z.unknown().optional(),
        estimated_tokens: z.number().nullable().optional(),
      }),
      z.object({ type: z.literal("signature_delta"), signature: z.string() }),
    ]),
  }),
  z.object({ type: z.literal("content_block_stop"), index: count }),
  z.object({
    type: z.literal("message_delta"),
    resumable: z.unknown().optional(),
    context_management: z.unknown().optional(),
    delta: z.object({
      stop_reason: z.string().min(1).nullable().optional(),
      resumable: z.unknown().optional(),
    }),
    usage: z.object({
      input_tokens: count.nullable().optional(),
      output_tokens: count.nullable().optional(),
      ...cacheUsage,
    }),
  }),
  z.object({ type: z.literal("message_stop") }),
]);
type Event = z.infer<typeof streamEventSchema>;
type OpenBlock = z.infer<typeof assistantBlockSchema> & { json?: string };

export class StreamFailure extends Error {
  constructor(
    readonly causeCode: StreamFailureCause,
    message: string,
  ) {
    super(message);
    this.name = "StreamFailure";
  }
}
export class StreamOutputLimit extends Error {
  constructor() {
    super("Messages API tool call reached the output limit");
    this.name = "StreamOutputLimit";
  }
}
export const protocolError = () =>
  new StreamFailure("malformed", "Invalid Messages API stream protocol");
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw protocolError();
  }
}

/** Attempt-local parser state. Only closed, validated blocks can enter retained history. */
export class MessageStream {
  readonly content: Completion["content"] = [];
  usage: Usage = { input_tokens: 0, output_tokens: 0 };
  stopped = false;
  private started = false;
  private finalized = false;
  private stopReason = "";
  private blocks = new Map<number, OpenBlock>();
  private closed = new WeakSet<OpenBlock>();
  private lastOpen: number | undefined;
  private terminal = false;
  private readonly toolIds = new Set<string>();
  private anyEvent = false;
  private outputStarted = false;
  private progressEnded = false;
  private responseModel: string | undefined;
  private responseId: string | undefined;
  private resumable: boolean | undefined;
  private clearedTokens: number | undefined;
  private readonly nativeRecording: NativeStreamResponseRecording | undefined;
  visibleText = "";
  constructor(
    private readonly onText: CompletionRequest["onText"],
    private readonly onProgress?: CompletionRequest["onStreamProgress"],
    nativeRecording?: NativeResponseRecordingContext,
  ) {
    this.nativeRecording =
      nativeRecording === undefined
        ? undefined
        : new NativeStreamResponseRecording(nativeRecording);
  }
  private finishProgress(): void {
    if (this.started && !this.progressEnded) {
      this.progressEnded = true;
      this.onProgress?.({ type: "response_end" });
    }
  }
  /** Provider recovery Bh normalizes a begun abandoned stream's stop; it is not a transport-finally hook. */
  abandonProgress(): void {
    this.finishProgress();
  }
  private text(value: string): void {
    this.visibleText += value;
    if (value) this.onText(value);
  }
  get retainedText(): string {
    return this.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  get coherent(): boolean {
    return this.finalized && this.terminal && this.lastOpen === undefined;
  }
  get lacksResponseEnvelope(): boolean {
    return (
      !this.started ||
      (this.lastOpen === undefined &&
        this.content.length === 0 &&
        !this.finalized)
    );
  }
  /** Recognized labels may carry future types, arrays or boxed primitive values. */
  noteUnknownEvent(): void {
    if (this.stopped) throw protocolError();
    this.anyEvent = true;
  }
  failure(cause: StreamFailureCause, outlastedNonStreamingTimeout: boolean) {
    return classifyStreamFailure({
      cause,
      anyBlockFinished: this.content.length > 0,
      anyOutputShown: this.outputStarted,
      anyEvent: this.anyEvent,
      stopReasonReceived: this.finalized,
      outlastedNonStreamingTimeout,
      complete: this.coherent,
    });
  }
  accept(event: Event, recordingSource: unknown = event): void {
    if (this.stopped) throw protocolError();
    if (event.type === "ping") return;
    if (event.type === "error") {
      const type = event.error.type;
      const details = event.error.details;
      const code =
        details && typeof details === "object" && "error_code" in details
          ? details.error_code
          : undefined;
      if (code === "tool_use_block_cut_off") throw new StreamOutputLimit();
      const filter =
        !["overloaded_error", "rate_limit_error"].includes(type) &&
        event.error.message.includes(
          "Output blocked by content filtering policy",
        );
      const cause: StreamFailureCause =
        code === "dlp_request_denied"
          ? "denied"
          : filter
            ? "outputFiltered"
            : type === "overloaded_error"
              ? "overloaded"
              : type === "timeout_error"
                ? "timedOut"
                : type === "api_error"
                  ? "serverError"
                  : "badRequest";
      throw new StreamFailure(cause, "Messages API returned a streaming error");
    }
    if (event.type === "message_start") {
      if (this.started) throw protocolError();
      this.started = true;
      this.anyEvent = true;
      this.usage = mergeUsage(this.usage, event.message.usage);
      this.responseModel = event.message.model;
      this.responseId = event.message.id;
      this.nativeRecording?.start(recordingSource);
      this.onProgress?.({ type: "response_start" });
      return;
    }
    if (!this.started) throw protocolError();
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        const previous = this.blocks.get(event.index);
        if (
          previous &&
          this.closed.has(previous) &&
          previous.type === "tool_use" &&
          block.type === "tool_use" &&
          previous.id === block.id
        )
          throw protocolError();
        let opened: OpenBlock;
        if (block.type === "tool_use") {
          if (this.toolIds.has(block.id)) throw protocolError();
          opened = {
            ...block,
            name: normalizeToolName(block.name),
            input: "",
            json: "",
          };
        } else if (block.type === "thinking")
          opened = { ...block, thinking: "", signature: "" };
        else if (block.type === "text") opened = { ...block, text: "" };
        else opened = { ...block };
        this.blocks.set(event.index, opened);
        this.lastOpen = event.index;
        this.terminal = false;
        if (block.type === "text" || block.type === "tool_use")
          this.outputStarted = true;
        this.onProgress?.({ type: "block_start" });
        break;
      }
      case "content_block_delta": {
        const block = this.blocks.get(event.index),
          delta = event.delta;
        if (!block || this.closed.has(block)) throw protocolError();
        this.terminal = false;
        if (delta.type === "text_delta" && block.type === "text") {
          block.text += delta.text;
          this.text(delta.text);
          this.onProgress?.({ type: "length", chars: delta.text.length });
        } else if (
          delta.type === "input_json_delta" &&
          block.type === "tool_use"
        ) {
          block.json = (block.json ?? "") + delta.partial_json;
          this.onProgress?.({
            type: "length",
            chars: delta.partial_json.length,
          });
        } else if (
          delta.type === "signature_delta" &&
          block.type === "thinking"
        )
          block.signature = delta.signature;
        else if (
          delta.type === "thinking_delta" &&
          block.type === "redacted_thinking"
        ) {
          /* Source ignores these deltas for redacted blocks. */
        } else if (
          delta.type === "thinking_delta" &&
          block.type === "thinking" &&
          typeof delta.thinking === "string"
        )
          block.thinking += delta.thinking;
        else throw protocolError();
        if (delta.type === "thinking_delta") {
          const tokens =
            delta.estimated_tokens ??
            (typeof delta.thinking === "string" && delta.thinking.length
              ? Math.ceil(delta.thinking.length / 4)
              : undefined);
          if (tokens !== undefined)
            this.onProgress?.({
              type: "thinking_progress",
              estimatedTokensDelta: tokens,
            });
        } else if (delta.type === "signature_delta")
          this.onProgress?.({
            type: "thinking_signature",
            chars: Math.round(delta.signature.length * 0.75),
          });
        break;
      }
      case "content_block_stop": {
        const block = this.blocks.get(event.index);
        if (!block || this.closed.has(block)) throw protocolError();
        this.terminal = false;
        switch (block.type) {
          case "tool_use": {
            const parsed = normalizeToolInput(block.json ?? "");
            this.toolIds.add(block.id);
            this.content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: parsed,
            });
            break;
          }
          case "text":
            this.content.push({ type: "text", text: block.text });
            break;
          case "thinking":
            this.content.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            });
            break;
          case "redacted_thinking":
            this.content.push({ type: "redacted_thinking", data: block.data });
            break;
        }
        this.closed.add(block);
        this.nativeRecording?.closeBlock(event.index, this.content.at(-1));
        this.lastOpen = undefined;
        this.onProgress?.({
          type: "assistant",
          ...(this.responseId === undefined
            ? {}
            : { responseId: this.responseId }),
          usage: structuredClone(this.usage),
        });
        break;
      }
      case "message_delta":
        this.nativeRecording?.delta(recordingSource);
        if (event.context_management != null)
          this.clearedTokens = clearedInputTokens(event.context_management);
        if (typeof event.delta.resumable === "boolean")
          this.resumable = event.delta.resumable;
        else if (typeof event.resumable === "boolean")
          this.resumable = event.resumable;
        if (event.delta.stop_reason) {
          this.finalized = true;
          this.terminal = true;
          this.stopReason = event.delta.stop_reason;
        }
        this.usage = mergeUsage(this.usage, event.usage);
        break;
      case "message_stop":
        if (!this.coherent) throw protocolError();
        this.stopped = true;
        this.finishProgress();
        break;
    }
    this.anyEvent = true;
  }
  completion(): Completion {
    if (!this.stopped && !this.coherent)
      throw new StreamFailure(
        "truncated",
        "Messages API stream ended before message_stop",
      );
    this.finishProgress();
    return {
      content: this.content,
      stop_reason: this.stopReason,
      usage: this.usage,
      ...(this.responseId === undefined ? {} : { responseId: this.responseId }),
      ...(this.nativeRecording === undefined
        ? {}
        : { nativeResponse: this.nativeRecording.completed() }),
      ...(this.responseModel === undefined
        ? {}
        : { responseModel: this.responseModel }),
      ...(this.resumable === undefined ? {} : { resumable: this.resumable }),
      ...(this.clearedTokens === undefined
        ? {}
        : { contextClearedInputTokens: this.clearedTokens }),
    };
  }
  partial(cause: StreamFailureCause): Completion {
    this.finishProgress();
    return {
      content: this.content,
      stop_reason: this.content.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn",
      usage: this.usage,
      partial: { cause },
      ...(this.nativeRecording === undefined
        ? {}
        : {
            nativeResponse: unsupportedNativeResponse(
              `Partial stream requires its native recovery adapter: ${cause}`,
            ),
          }),
    };
  }
  outputLimited(): Completion {
    this.finishProgress();
    return {
      content: this.content,
      stop_reason: "max_tokens",
      usage: this.usage,
      resumable: false,
      ...(this.nativeRecording === undefined
        ? {}
        : {
            nativeResponse: unsupportedNativeResponse(
              "Output-limit recovery requires its native provenance adapter",
            ),
          }),
      ...(this.responseId === undefined ? {} : { responseId: this.responseId }),
      ...(this.responseModel === undefined
        ? {}
        : { responseModel: this.responseModel }),
    };
  }
}
