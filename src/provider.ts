import { z } from "zod";
import { captureNativePreparedRequest } from "./native-request-capture.js";
import { prepareNativePromptForTransport } from "./native-prompt-transport.js";
import type { NativePromptRequestPlan } from "./native-prompt-request.js";
import {
  NativeResponseRecordingError,
  recordNativeJsonResponse,
} from "./native-response-recording.js";
import { setTimeout as wait } from "node:timers/promises";
import {
  assistantBlockSchema,
  type Completion,
  type CompletionRequest,
  type Provider,
} from "./types.js";
import {
  MessageStream,
  StreamFailure,
  StreamOutputLimit,
  streamEventSchema,
  protocolError,
  parseJson,
  mergeUsage,
} from "./message-stream.js";
import {
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  resolveRetryConfiguration,
  retryableStatus,
  retryDelay,
} from "./retry.js";
import { RequestAttemptLedger } from "./attempt-ledger.js";
import {
  apiErrorInfo,
  betaHeaderRejected,
  ProviderHttpError,
  readErrorMetadata,
  resumePrefillRefused,
  terminalHttpFailure,
} from "./http-error.js";
import {
  StreamSuspendedError,
  TransportDeadline,
  TransportTimeoutError,
  systemClock,
  type Clock,
} from "./deadline.js";
import { resolveTimeoutPolicy, type TimeoutPolicy } from "./timeout-policy.js";
import { triBoolean } from "./env-settings.js";
import {
  defaultOutputTokens,
  resolveModelFacts,
  supportsInterleavedThinking,
  thinkingRequest,
  type ThinkingOptions,
} from "./reasoning.js";
import { decideRecovery, type RecoveryPolicy } from "./recovery.js";
import {
  markThinkingStripped,
  planThinkingStrip,
  projectMessages,
  type ThinkingStrip,
} from "./thinking-history.js";
import {
  contextWindow,
  LONG_CONTEXT_BETA,
  type ContextPolicy,
} from "./context-window.js";
import { clearedInputTokens } from "./context-usage.js";
import { OutputLimitRepair } from "./output-limit.js";
import { contextRejection } from "./context-error.js";
import {
  RequestFeatures,
  resetRequestFeatureLatches,
  type DisplayOptions,
  type DisplayProbe,
} from "./request-features.js";
import { systemPromptText } from "./system-prompt.js";
import {
  queryEffortOutputConfig,
  resolveQueryEffort,
  type QueryEffortCapabilities,
  type QueryEffortSelection,
} from "./query-model-effort.js";
import {
  normalizeAssistantToolBlocks,
  pureToolCallNormalizationBinding,
} from "./tool-call-normalization.js";

function normalizeCommittedToolBlocks(
  content: Completion["content"],
  request: CompletionRequest,
): Completion["content"] {
  const known = new Set(request.tools.map((tool) => tool.name));
  return normalizeAssistantToolBlocks(content, {
    resolveTool: (name) =>
      known.has(name) ? pureToolCallNormalizationBinding(name) : undefined,
  });
}

const tokenCount = z.number().int().nonnegative();
const jsonMessageSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string().optional(),
  id: z.string().optional(),
  resumable: z.unknown().optional(),
  context_management: z.unknown().optional(),
  content: z.array(assistantBlockSchema),
  stop_reason: z.string().min(1),
  usage: z.object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    cache_creation_input_tokens: tokenCount.nullable().optional(),
    cache_read_input_tokens: tokenCount.nullable().optional(),
    iterations: z.array(z.unknown()).optional(),
    cache_creation: z
      .object({
        ephemeral_1h_input_tokens: tokenCount.optional(),
        ephemeral_5m_input_tokens: tokenCount.optional(),
      })
      .nullable()
      .optional(),
  }),
});
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// The recovered SDK gates on the wire label before parsing data. An absent SSE
// event is not promoted to "message", and a label does not replace body.type.
const SSE_DATA_EVENTS = new Set([
  "completion",
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message",
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.tool_result",
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
  "agent.custom_tool_use",
  "agent.thread_context_compacted",
  "session.status_running",
  "session.status_idle",
  "session.status_rescheduled",
  "session.status_terminated",
  "session.error",
  "session.deleted",
  "session.updated",
  "span.model_request_start",
  "span.model_request_end",
  "span.outcome_evaluation_start",
  "span.outcome_evaluation_ongoing",
  "span.outcome_evaluation_end",
  "user.define_outcome",
  "agent.thread_message_received",
  "agent.thread_message_sent",
  "agent.session_thread_message_received",
  "agent.session_thread_message_sent",
  "session.thread_created",
  "session.thread_status_created",
  "session.thread_status_running",
  "session.thread_status_idle",
  "session.thread_status_rescheduled",
  "session.thread_status_terminated",
  "event_start",
  "event_delta",
  "system.message",
]);
const MESSAGE_EVENT_TYPES = new Set([
  "ping",
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);
function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
}
class ModelFallback extends Error {}
export class ModelUnavailableError extends Error {
  constructor() {
    super("Selected model is unavailable");
    this.name = "ModelUnavailableError";
  }
}
function withoutCacheControl<T extends object>(value: T): T {
  const rest = { ...value };
  Reflect.deleteProperty(rest, "cache_control");
  return rest;
}
const RESUMPTION_BETA = "thinking-resumption-2026-07-17";
export const QUERY_EFFORT_BETA = "effort-2025-11-24";
let resumptionHeaderRefused = false;
const contextRefusedModels = new Set<string>();
const effortRefusedModels = new Set<string>();
/** Returns the beta refusal latches to a fresh process's state. */
export function resetProviderProcessLatches(): void {
  resumptionHeaderRefused = false;
  contextRefusedModels.clear();
  effortRefusedModels.clear();
  resetRequestFeatureLatches();
}
type ContextRetry = {
  suppress: boolean;
  mode: "idle" | "retrying" | "guessing" | "spent" | "unproven";
};

export interface ProviderQueryEffortPolicy {
  /** Actual request model, including fallback. Undefined leaves undeclared requests untouched. */
  capabilities(model: string): QueryEffortCapabilities | undefined;
  selection?(
    request: Readonly<CompletionRequest>,
  ): Omit<QueryEffortSelection, "capabilities" | "turnEffort">;
  /** Explicit extra-body output config, before ordinary effort insertion. */
  outputConfig?(
    request: Readonly<CompletionRequest>,
  ): Readonly<Record<string, unknown>> | undefined;
}
function effortUnsupported(message: string, code?: string): boolean {
  const lower = message.toLowerCase();
  return (
    code === "effort_unsupported" ||
    (lower.includes("effort parameter") && lower.includes("not support")) ||
    (lower.includes("output_config") &&
      lower.includes("effort") &&
      lower.includes("extra inputs are not permitted")) ||
    betaHeaderRejected(message, QUERY_EFFORT_BETA)
  );
}

export class AnthropicProvider implements Provider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly maxRetries: number;
  private readonly allowNonStreamingFallback: boolean;
  private readonly timeoutPolicy: TimeoutPolicy;
  private readonly clock: Clock;
  private readonly fallbackModels: string[];
  private readonly thinkingOptions: ThinkingOptions;
  private readonly recoveryOptions: Partial<Omit<RecoveryPolicy, "maxRetries">>;
  private readonly enableThinkingResumption: boolean;
  private readonly contextPolicy: ContextPolicy;
  private readonly learnedOutputLimits = new Map<string, number>();
  private readonly modelAvailable: ((model: string) => boolean) | undefined;
  private readonly queryEffortPolicy: ProviderQueryEffortPolicy | undefined;
  private readonly features: RequestFeatures;
  private contextFacts(model: string) {
    return contextWindow(model, {
      ...this.contextPolicy,
      context1mRefused:
        this.contextPolicy.context1mRefused === true ||
        contextRefusedModels.has(resolveModelFacts(model).wire.toLowerCase()),
    });
  }
  contextWindowTokens(model: string): number {
    return this.contextFacts(model).window;
  }
  contextWindow(model: string) {
    return this.contextFacts(model);
  }
  outputTokenLimit(model: string): number {
    return (
      this.learnedOutputLimits.get(
        resolveModelFacts(model).wire.toLowerCase(),
      ) ?? Infinity
    );
  }
  resetRequestLimits(): void {
    this.learnedOutputLimits.clear();
  }
  canUseModel(model: string): boolean {
    return this.modelAvailable?.(model) ?? true;
  }
  get thinkingResumption(): boolean {
    return (
      this.enableThinkingResumption &&
      !resumptionHeaderRefused &&
      triBoolean(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) !== true
    );
  }

  /** A side query whose body the caller owns, such as a server-tool request; no retries or recovery. */
  postMessages(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    return fetch(`${this.endpoint}?beta=true`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": this.apiKey,
      },
    });
  }

  /** Auxiliary direct-provider count request; independent of completion admission/recovery. */
  async countFileTokens(request: {
    model: string;
    text: string;
    signal: AbortSignal;
  }): Promise<number | undefined> {
    if (!this.canUseModel(request.model)) return;
    const body = JSON.stringify({
      model: resolveModelFacts(request.model).wire,
      messages: [{ role: "user", content: request.text }],
      tools: [],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      request.signal.throwIfAborted();
      const deadline = new TransportDeadline(
        request.signal,
        this.timeoutPolicy,
        this.clock,
        false,
        Buffer.byteLength(body),
        false,
      );
      let response: Response | undefined;
      let retry = false;
      try {
        try {
          response = await fetch(`${this.endpoint}/count_tokens?beta=true`, {
            method: "POST",
            body,
            signal: deadline.signal,
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "x-api-key": this.apiKey,
              "anthropic-beta": "token-counting-2024-11-01",
            },
          });
          deadline.headersReceived();
        } catch {
          request.signal.throwIfAborted();
          retry = true;
        }
        if (response) {
          if (!response.ok) {
            retry = retryableStatus(response.status, response.headers);
            await response.body?.cancel().catch(() => {});
          } else if (
            response.body &&
            response.headers
              .get("content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase() === "application/json"
          ) {
            const body: ReadableStream<Uint8Array> = response.body,
              reader = body.getReader(),
              chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              for (;;) {
                deadline.check();
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 65536) return;
                chunks.push(chunk.value);
              }
              deadline.check();
              const parsed = z
                .object({ input_tokens: tokenCount })
                .safeParse(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      Buffer.concat(chunks),
                    ),
                  ),
                );
              return parsed.success ? parsed.data.input_tokens : undefined;
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          } else await response.body?.cancel().catch(() => {});
        }
      } catch {
        request.signal.throwIfAborted();
        return;
      } finally {
        deadline.close();
      }
      if (!retry || attempt === 1) return;
      // SDK count calls use downward jitter. Keep tau's existing 60-second retry wait ceiling.
      const headers = response?.headers;
      const hint = headers?.get("retry-after-ms"),
        seconds = headers?.get("retry-after");
      let delay = hint ? Number.parseFloat(hint) : NaN;
      if (!(delay > 0) && seconds)
        delay = Number.isNaN(Number.parseFloat(seconds))
          ? Date.parse(seconds) - Date.now()
          : Number.parseFloat(seconds) * 1000;
      if (!Number.isFinite(delay) || delay <= 0 || delay > 2147483647)
        delay = 500 * (1 - Math.random() * 0.25);
      await wait(Math.min(MAX_RETRY_DELAY_MS, delay), undefined, {
        signal: request.signal,
      });
    }
  }

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    maxRetries?: number;
    allowNonStreamingFallback?: boolean;
    timeoutPolicy?: TimeoutPolicy;
    clock?: Clock;
    recoveryPolicy?: Partial<Omit<RecoveryPolicy, "maxRetries">>;
    fallbackModel?: string;
    thinking?: ThinkingOptions;
    thinkingResumption?: boolean;
    /** The session's thinking display; absent, requests carry no `thinking.display`. */
    thinkingDisplay?: DisplayOptions;
    contextPolicy?: ContextPolicy;
    modelAvailable?: (model: string) => boolean;
    queryEffortPolicy?: ProviderQueryEffortPolicy;
  }) {
    this.apiKey = options.apiKey;
    this.thinkingOptions = options.thinking ?? {};
    this.contextPolicy = options.contextPolicy ?? {};
    this.modelAvailable = options.modelAvailable;
    this.queryEffortPolicy = options.queryEffortPolicy;
    this.features = new RequestFeatures(options.thinkingDisplay);
    this.enableThinkingResumption =
      options.thinkingResumption ??
      triBoolean(process.env.TAU_THINKING_RESUMPTION) === true;
    this.fallbackModels = [
      ...new Set(
        options.fallbackModel
          ?.split(",")
          .map((model) => model.trim())
          .filter(Boolean) ?? [],
      ),
    ];
    if (options.fallbackModel !== undefined && this.fallbackModels.length === 0)
      throw new Error("Invalid fallback model");
    this.allowNonStreamingFallback =
      (options.allowNonStreamingFallback ?? true) &&
      triBoolean(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) !==
        true;
    const retries = resolveRetryConfiguration();
    this.recoveryOptions = {
      persistent: retries.watchdog,
      persistentCapacityOnly: retries.capacityOnly,
      ...options.recoveryPolicy,
      hasFallbackModel: this.fallbackModels.length > 0,
    };
    this.maxRetries = options.maxRetries ?? retries.maxRetries;
    const broad =
      this.recoveryOptions.persistent === true &&
      this.recoveryOptions.persistentCapacityOnly !== true;
    if (
      !Number.isSafeInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      (!broad && this.maxRetries > MAX_RETRIES)
    )
      throw new Error(
        `maxRetries must be an integer from 0 to ${MAX_RETRIES} unless the persistent watchdog is enabled`,
      );
    let base: URL;
    try {
      base = new URL(options.baseUrl ?? "https://api.anthropic.com");
    } catch {
      throw new Error("Invalid Messages API base URL");
    }
    if (
      !["https:", "http:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error("Invalid Messages API base URL");
    }
    this.endpoint = `${base.href.replace(/\/$/, "")}/v1/messages`;
    this.timeoutPolicy =
      options.timeoutPolicy ?? resolveTimeoutPolicy({ baseUrl: base.href });
    this.clock = options.clock ?? systemClock;
  }

  private async response(
    request: CompletionRequest,
    ledger: RequestAttemptLedger,
    streaming: boolean,
    prefixRepairs: { count: number },
    contextRetry: ContextRetry,
    outputRepair: OutputLimitRepair,
    display: { probe: DisplayProbe },
  ): Promise<{
    response: Response;
    streaming: boolean;
    deadline: TransportDeadline;
    startedAt: number;
    noteBegun: () => void;
  }> {
    const facts = resolveModelFacts(request.model);
    const requestedMax = Math.min(
      request.useModelTokenDefaults
        ? defaultOutputTokens(request.model)
        : request.maxTokens,
      facts.upperOutput,
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ? defaultOutputTokens(request.model)
        : Infinity,
    );
    let maxTokens = Math.min(requestedMax, outputRepair.limit);
    let thinking = thinkingRequest(request.model, maxTokens, {
      ...this.thinkingOptions,
      ...request.thinking,
    });
    const effortPolicy = this.queryEffortPolicy;
    const effortCapabilities = effortPolicy?.capabilities(request.model);
    const existingOutputConfig = effortPolicy?.outputConfig?.(request);
    if (
      !effortCapabilities &&
      (request.queryEffort !== undefined ||
        (existingOutputConfig && Object.hasOwn(existingOutputConfig, "effort")))
    )
      throw new Error(
        "Query effort requires an explicit model capability policy",
      );
    const effortSelection = effortCapabilities
      ? (effortPolicy?.selection?.(request) ?? {})
      : {};
    const environment =
      effortSelection.environment ?? process.env.CLAUDE_CODE_EFFORT_LEVEL;
    const effort = effortCapabilities
      ? resolveQueryEffort({
          ...effortSelection,
          capabilities: effortCapabilities,
          ...(environment === undefined ? {} : { environment }),
          ...(request.queryEffort === undefined
            ? {}
            : { turnEffort: request.queryEffort }),
        })
      : undefined;
    const effortModel = facts.wire.toLowerCase();
    const projection = () =>
      effortCapabilities
        ? queryEffortOutputConfig({
            capabilities: effortCapabilities,
            ...(effort === undefined ? {} : { effort }),
            ...(existingOutputConfig === undefined
              ? {}
              : { existing: existingOutputConfig }),
            thinkingDisabled: thinking?.type === "disabled",
            mechanicallyDisabled:
              (request.thinking?.mechanical ??
                this.thinkingOptions.mechanical) === true,
            effortRefused: effortRefusedModels.has(effortModel),
          })
        : { outputConfig: { ...existingOutputConfig }, needsEffortBeta: false };
    let projectedEffort = projection();
    let plan = this.features.plan(request.model, thinking, display.probe);
    const firstPartyHost = new URL(this.endpoint).host === "api.anthropic.com";
    let messages = request.messages;
    let wire = projectMessages(messages, request.resumeIncompleteThinking);
    let nativePrompt: NativePromptRequestPlan | undefined;
    const serialize = () =>
      JSON.stringify({
        model: facts.wire,
        system:
          nativePrompt?.system ??
          (request.disablePromptCaching && typeof request.system !== "string"
            ? request.system.map(withoutCacheControl)
            : request.system),
        messages: request.disablePromptCaching
          ? wire.map((row) => ({
              ...row,
              content: row.content.map(withoutCacheControl),
            }))
          : wire,
        tools: request.disablePromptCaching
          ? (nativePrompt?.tools ?? request.tools).map(withoutCacheControl)
          : (nativePrompt?.tools ?? request.tools),
        max_tokens: maxTokens,
        thinking: plan.thinking,
        ...(plan.contextManagement
          ? { context_management: plan.contextManagement }
          : {}),
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
        stream: streaming,
        ...(Object.keys(projectedEffort.outputConfig).length
          ? { output_config: projectedEffort.outputConfig }
          : {}),
      });
    let body = serialize();
    let phaseRetries = 0;
    for (;;) {
      abortIfNeeded(request.signal);
      maxTokens = Math.min(requestedMax, outputRepair.limit);
      thinking = thinkingRequest(request.model, maxTokens, {
        ...this.thinkingOptions,
        ...request.thinking,
      });
      projectedEffort = projection();
      plan = this.features.plan(request.model, thinking, display.probe);
      nativePrompt =
        request.nativePromptPreparation === undefined
          ? undefined
          : await prepareNativePromptForTransport(
              request.nativePromptPreparation,
              {
                requestedModel: request.model,
                wireModel: facts.wire,
                transport: streaming ? "stream" : "json",
                currentSystem: systemPromptText(request.system),
                currentTools: request.tools,
                disablePromptCaching: request.disablePromptCaching === true,
              },
              request.signal,
            );
      body = serialize();
      const resumptionBeta =
        this.thinkingResumption && supportsInterleavedThinking(request.model);
      const contextBeta =
        !contextRetry.suppress && this.contextFacts(request.model).beta;
      const betas = [
        resumptionBeta ? RESUMPTION_BETA : "",
        contextBeta ? LONG_CONTEXT_BETA : "",
        ...plan.betas,
        projectedEffort.needsEffortBeta ? QUERY_EFFORT_BETA : "",
      ].filter(Boolean);
      if (request.resumeIncompleteThinking && !resumptionBeta)
        throw new ProviderHttpError(400, "thinking_resumption_unavailable");
      if (request.nativeRequestPrepared)
        await captureNativePreparedRequest(
          request.nativeRequestPrepared,
          body,
          request.model,
          request.signal,
        );
      ledger.takeAttempt();
      const startedAt = this.clock.monotonicNow();
      const deadline = new TransportDeadline(
        request.signal,
        this.timeoutPolicy,
        this.clock,
        streaming,
        Buffer.byteLength(body),
        ledger.noResponse.escalated,
      );
      let response: Response;
      try {
        response = await fetch(`${this.endpoint}?beta=true`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": this.apiKey,
            ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
          },
          body,
          signal: deadline.signal,
          redirect: "manual",
        });
        deadline.headersReceived();
      } catch {
        const failure = deadline.failure;
        deadline.close();
        abortIfNeeded(request.signal);
        const noResponseHeader =
          failure instanceof TransportTimeoutError &&
          failure.stage === "first-header";
        if (
          !ledger.retry(
            {
              kind: "noResponse",
              suspended: failure instanceof StreamSuspendedError,
              networkDown: false,
              turnedAwayOverloaded: false,
            },
            noResponseHeader,
          )
        )
          throw failure ?? new Error("Messages API request failed");
        await wait(retryDelay(++phaseRetries), undefined, {
          signal: request.signal,
        });
        continue;
      }
      if (response.ok)
        return {
          response,
          streaming,
          deadline,
          startedAt,
          noteBegun: () => {
            outputRepair.onReplyBegun();
            this.features.settle(display.probe);
            if (
              contextRetry.mode === "retrying" ||
              contextRetry.mode === "guessing"
            ) {
              contextRefusedModels.add(
                resolveModelFacts(request.model).wire.toLowerCase(),
              );
              contextRetry.mode = "spent";
            }
          },
        };
      try {
        const possibleFallback =
          streaming &&
          this.allowNonStreamingFallback &&
          response.status === 404 &&
          response.headers.get("x-should-retry") !== "false";
        let terminal = terminalHttpFailure(
          response.status,
          response.headers,
          undefined,
        );
        let metadata: unknown;
        if (
          !terminal &&
          ([400, 402, 413, 422, 429].includes(response.status) ||
            request.resumeIncompleteThinking ||
            possibleFallback ||
            ((ledger.retriesLeft > 0 || ledger.recovery.policy.persistent) &&
              retryableStatus(response.status, response.headers)))
        ) {
          metadata = await readErrorMetadata(response, deadline.signal);
          terminal = terminalHttpFailure(
            response.status,
            response.headers,
            metadata,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        deadline.check();
        const info = apiErrorInfo(metadata);
        if (
          !terminal &&
          response.status === 400 &&
          !effortRefusedModels.has(effortModel) &&
          (projectedEffort.needsEffortBeta ||
            Object.hasOwn(projectedEffort.outputConfig, "effort")) &&
          effortUnsupported(info.message, info.code)
        ) {
          effortRefusedModels.add(effortModel);
          continue;
        }
        if (
          !terminal &&
          response.status === 400 &&
          this.features.refusedBeta(request.model, info.message, plan)
        )
          continue;
        if (!terminal && response.status === 400) {
          const explicit =
            info.message.includes(LONG_CONTEXT_BETA) ||
            info.message.includes("long context beta");
          const guessed =
            !explicit && info.message.includes("invalid beta flag");
          if (contextRetry.mode !== "idle" && contextRetry.mode !== "spent")
            contextRetry.mode =
              contextRetry.mode === "guessing" && guessed
                ? "spent"
                : "unproven";
          else if (
            contextRetry.mode === "idle" &&
            contextBeta &&
            (explicit || guessed)
          ) {
            contextRetry.suppress = true;
            contextRetry.mode = explicit ? "retrying" : "guessing";
            continue;
          }
        }
        if (
          !terminal &&
          response.status === 400 &&
          resumptionBeta &&
          betaHeaderRejected(info.message, RESUMPTION_BETA)
        ) {
          resumptionHeaderRefused = true;
          if (request.resumeIncompleteThinking)
            throw new ProviderHttpError(response.status, info.code);
          continue;
        }
        if (
          !terminal &&
          response.status === 400 &&
          !request.resumeIncompleteThinking &&
          /not created in this conversation|bound to a different conversation/i.test(
            info.message,
          )
        ) {
          const strip = planThinkingStrip(
            messages,
            wire,
            response.headers.get("anthropic-thinking-prefix-mismatch"),
            ++prefixRepairs.count,
          );
          if (strip) {
            messages = markThinkingStripped(messages, strip);
            request.onThinkingStrip?.(strip);
            abortIfNeeded(request.signal);
            wire = projectMessages(messages);
            body = serialize();
            continue;
          }
        }
        if (!terminal && outputRepair.onError(response.status, info, maxTokens))
          continue;
        if (
          !terminal &&
          (response.status === 400 || response.status === 422) &&
          info.type !== "billing_error" &&
          !contextRejection(response.status, info.message)
        ) {
          const resend = display.probe === "idle";
          display.probe = this.features.probeAfterRefusal(
            display.probe,
            plan,
            firstPartyHost,
          );
          if (resend && display.probe === "withoutField") continue;
        }
        const httpError = new ProviderHttpError(
          response.status,
          info.code,
          terminal
            ? undefined
            : contextRejection(response.status, info.message),
        );
        if (request.resumeIncompleteThinking && resumePrefillRefused(httpError))
          throw httpError;
        if (!terminal && possibleFallback && ledger.fallback()) {
          streaming = false;
          phaseRetries = 0;
          body = serialize();
          continue;
        }
        const standardRetry =
          [408, 409, 429].includes(response.status) || response.status >= 500;
        const failure =
          response.headers.get("x-should-retry") === "true" && !standardRetry
            ? undefined
            : {
                kind: "httpError" as const,
                status: response.status,
                fallbackModelCouldHelp: false,
              };
        if (
          !terminal &&
          failure &&
          failure.status === 529 &&
          decideRecovery(
            failure,
            ledger.recovery.counts(),
            ledger.recovery.policy,
          ).decision === "useFallbackModel"
        )
          throw new ModelFallback("Messages API model fallback");
        if (
          terminal ||
          !retryableStatus(response.status, response.headers) ||
          !ledger.retry(failure)
        ) {
          throw httpError;
        }
        const delay = retryDelay(++phaseRetries, response.headers);
        if (delay > MAX_RETRY_DELAY_MS)
          throw new Error(
            `Messages API retry delay exceeds ${MAX_RETRY_DELAY_MS} ms (HTTP ${response.status})`,
          );
        deadline.close();
        await wait(delay, undefined, { signal: request.signal });
      } finally {
        deadline.close();
      }
    }
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    abortIfNeeded(request.signal);
    const seenModels = new Set<string>();
    const models = [
      request.model,
      ...(triBoolean(process.env.CLAUDE_CODE_NO_MODEL_FALLBACK) === true
        ? []
        : this.fallbackModels),
    ].filter((model) => {
      const wire = resolveModelFacts(model).wire.toLowerCase();
      if (seenModels.has(wire)) return false;
      seenModels.add(wire);
      return true;
    });
    let modelIndex = 0;
    let ledger = new RequestAttemptLedger(
      this.maxRetries,
      request.attemptBudget,
      { ...this.recoveryOptions, hasFallbackModel: models.length > 1 },
    );
    let streaming = true,
      model = request.model,
      changedModel = false;
    let prefixRepairs = { count: 0 };
    let contextRetry: ContextRetry = { suppress: false, mode: "idle" };
    const display: { probe: DisplayProbe } = { probe: "idle" };
    const outputRepairFor = (name: string) =>
      new OutputLimitRepair(
        name,
        resolveModelFacts(name).wire.toLowerCase(),
        this.learnedOutputLimits,
      );
    let outputRepair = outputRepairFor(model);
    let messages = request.messages;
    const thinkingStrip = (strip: ThinkingStrip) => {
      messages = markThinkingStripped(messages, strip);
      request.onThinkingStrip?.(strip);
    };
    const advanceModel = () => {
      const next = models[modelIndex + 1];
      if (next === undefined) return false;
      model = next;
      modelIndex++;
      changedModel = true;
      streaming = true;
      ledger = new RequestAttemptLedger(
        this.maxRetries,
        request.attemptBudget,
        {
          ...this.recoveryOptions,
          hasFallbackModel: modelIndex + 1 < models.length,
        },
      );
      prefixRepairs = { count: 0 };
      contextRetry = { suppress: false, mode: "idle" };
      outputRepair = outputRepairFor(model);
      return true;
    };
    const reset = (stream: MessageStream, replacement: string) => {
      if (stream.visibleText !== replacement)
        request.onTextReset?.(replacement);
      abortIfNeeded(request.signal);
    };
    for (;;) {
      abortIfNeeded(request.signal);
      if (!this.canUseModel(model)) {
        if (!advanceModel()) throw new ModelUnavailableError();
        continue;
      }
      let accepted: Awaited<ReturnType<AnthropicProvider["response"]>>;
      try {
        accepted = await this.response(
          { ...request, model, messages, onThinkingStrip: thinkingStrip },
          ledger,
          streaming,
          prefixRepairs,
          contextRetry,
          outputRepair,
          display,
        );
      } catch (error) {
        if (!(error instanceof ModelFallback)) throw error;
        abortIfNeeded(request.signal);
        if (!advanceModel()) throw error;
        continue;
      }
      const { response, deadline, startedAt } = accepted;
      const nativeRequestId = response.headers.get("request-id");
      streaming = accepted.streaming;
      const stream = new MessageStream(
        request.onText,
        request.onStreamProgress,
        request.nativeRecording === undefined
          ? undefined
          : {
              host: request.nativeRecording,
              requestedModel: request.model,
              ...(nativeRequestId === null
                ? {}
                : { requestId: nativeRequestId }),
              normalizeContent: (content) =>
                normalizeCommittedToolBlocks(
                  z.array(assistantBlockSchema).parse(content),
                  request,
                ),
            },
      );
      try {
        const completion = streaming
          ? await this.streamCompletion(
              response,
              request,
              deadline,
              stream,
              accepted.noteBegun,
            )
          : await this.jsonCompletion(response, request, deadline);
        if (!streaming) accepted.noteBegun();
        if (streaming) reset(stream, stream.retainedText);
        return { ...completion, ...(changedModel ? { model } : {}) };
      } catch (error) {
        abortIfNeeded(request.signal);
        const failure = deadline.failure ?? error;
        deadline.close();
        if (error instanceof NativeResponseRecordingError) throw error;
        if (failure instanceof NativeResponseRecordingError) throw failure;
        if (streaming && failure instanceof StreamOutputLimit) {
          reset(stream, stream.retainedText);
          return {
            ...stream.outputLimited(),
            ...(changedModel ? { model } : {}),
          };
        }
        if (!streaming) {
          if (
            (failure instanceof TransportTimeoutError ||
              failure instanceof StreamSuspendedError ||
              (failure instanceof StreamFailure &&
                failure.causeCode === "connectionLost")) &&
            ledger.retry({
              kind: "noResponse",
              suspended: failure instanceof StreamSuspendedError,
              networkDown: false,
              turnedAwayOverloaded: false,
            })
          ) {
            await wait(
              retryDelay(Math.max(1, ledger.recovery.counts().retries)),
              undefined,
              { signal: request.signal },
            );
            continue;
          }
          throw failure;
        }
        const cause =
          failure instanceof StreamSuspendedError
            ? "suspended"
            : failure instanceof TransportTimeoutError
              ? "stalled"
              : failure instanceof StreamFailure
                ? failure.causeCode
                : undefined;
        if (cause === undefined) throw failure;
        const state = stream.failure(
          cause,
          this.clock.monotonicNow() - startedAt >=
            this.timeoutPolicy.nonStreamingMs,
        );
        if (state === undefined) {
          reset(stream, stream.retainedText);
          return { ...stream.completion(), ...(changedModel ? { model } : {}) };
        }
        const decision = ledger.recovery.onStreamFailed(
          state,
          this.allowNonStreamingFallback &&
            !(
              cause === "stalled" &&
              triBoolean(process.env.CLAUDE_CODE_REMOTE) === true
            ),
        );
        if (decision === "keepPartial") {
          reset(stream, stream.retainedText);
          return {
            ...stream.partial(cause),
            ...(changedModel ? { model } : {}),
          };
        }
        if (decision === "fail") throw failure;
        stream.abandonProgress();
        if (decision === "useFallbackModel") {
          reset(stream, "");
          if (!advanceModel()) throw failure;
          continue;
        }
        reset(stream, "");
        if (decision === "retryWithoutStreaming") {
          streaming = false;
          continue;
        }
        const counts = ledger.recovery.counts();
        const delay =
          cause === "stalled"
            ? 0
            : state.progress === "thinkingOnly" &&
                !["serverError", "timedOut", "overloaded"].includes(cause)
              ? 100 * counts.afterThinkingOnly
              : retryDelay(
                  Math.max(
                    1,
                    cause === "overloaded"
                      ? counts.overloaded
                      : state.progress === "thinkingOnly"
                        ? counts.afterThinkingOnly
                        : counts.retries,
                  ),
                );
        if (delay) await wait(delay, undefined, { signal: request.signal });
      } finally {
        deadline.close();
      }
    }
  }

  private async streamCompletion(
    response: Response,
    request: CompletionRequest,
    deadline: TransportDeadline,
    stream: MessageStream,
    noteBegun: () => void,
  ): Promise<Completion> {
    if (
      !response.body ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "text/event-stream"
    ) {
      await response.body?.cancel();
      throw new StreamFailure(
        "malformed",
        "Messages API response is not an event stream",
      );
    }
    deadline.beginStream();
    const body: ReadableStream<Uint8Array> = response.body,
      reader = body.getReader();
    // Match the SDK's replacement decoding. Keep BOMs here so its per-line
    // stripping rule also applies beyond the first line of the response.
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let buffer = "";
    let data: string[] = [];
    let eventName = "";
    let eventBytes = 0;
    let responseBytes = 0;
    const line = (value: string): void => {
      eventBytes += Buffer.byteLength(value, "utf8") + 1;
      if (eventBytes > MAX_EVENT_BYTES)
        throw new Error("Messages API event exceeds size limit");
      if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
      if (value === "") {
        if (eventName === "error") {
          // Error records take the SDK error path even when their JSON body has
          // an unrelated type or cannot be parsed. Never dispatch them as output.
          let raw: unknown;
          try {
            raw = JSON.parse(data.join("\n"));
          } catch {
            /* SDK keeps the raw error string. */
          }
          const info = apiErrorInfo(raw);
          const error =
            raw && typeof raw === "object" && "error" in raw
              ? raw.error
              : undefined;
          const details =
            error && typeof error === "object" && "details" in error
              ? error.details
              : undefined;
          stream.accept({
            type: "error",
            error: {
              type: info.type ?? "error",
              message: info.message,
              ...(details !== undefined ? { details } : {}),
            },
          });
        } else if (SSE_DATA_EVENTS.has(eventName)) {
          const body = parseJson(data.join("\n"));
          // The caller's first body.type read throws only for null. Non-null
          // primitives and arrays pass through its unknown-event progress path.
          if (body === null)
            throw new StreamFailure(
              "unknown",
              "Messages API stream protocol received a null event",
            );
          const type =
            typeof body === "object" && "type" in body ? body.type : undefined;
          if (typeof type === "string" && MESSAGE_EVENT_TYPES.has(type)) {
            const parsed = streamEventSchema.safeParse(body);
            if (!parsed.success) throw protocolError();
            deadline.eventReceived(parsed.data.type === "ping");
            stream.accept(parsed.data, body);
            if (parsed.data.type === "message_start") noteBegun();
            if (request.onStreamEvent) {
              const closed =
                parsed.data.type === "content_block_stop"
                  ? stream.content.at(-1)
                  : undefined;
              request.onStreamEvent(
                parsed.data,
                body,
                closed && normalizeCommittedToolBlocks([closed], request).at(0),
              );
            }
          } else {
            // The caller switches on the body type and still records progress
            // for a value it does not handle. Do not hide malformed known types.
            deadline.eventReceived(false);
            stream.noteUnknownEvent();
          }
        }
        // Ping, unknown, empty and missing wire labels are ignored. Their bytes
        // still feed the independent, bounded heartbeat bridge in the deadline.
        data = [];
        eventName = "";
        eventBytes = 0;
      } else if (!value.startsWith(":")) {
        const colon = value.indexOf(":");
        const field = colon < 0 ? value : value.slice(0, colon);
        const raw = colon < 0 ? "" : value.slice(colon + 1);
        const content = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "data") data.push(content);
        if (field === "event") eventName = content;
      }
    };
    const drainLines = (): void => {
      let consumed = 0;
      for (let index = 0; index < buffer.length; index++) {
        const character = buffer.charCodeAt(index);
        if (character !== 10 && character !== 13) continue;
        // A CR at the end of a chunk can be the first half of a CRLF.
        if (character === 13 && index + 1 === buffer.length) break;
        line(buffer.slice(consumed, index));
        if (character === 13 && buffer.charCodeAt(index + 1) === 10) index++;
        consumed = index + 1;
      }
      buffer = buffer.slice(consumed);
    };
    try {
      while (!stream.stopped) {
        deadline.check();
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          deadline.check();
          throw new StreamFailure(
            "connectionLost",
            "Messages API stream read failed",
          );
        }
        if (chunk.done) break;
        deadline.byteReceived();
        responseBytes += chunk.value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES)
          throw new Error("Messages API response exceeds size limit");
        buffer += decoder.decode(chunk.value, { stream: true });
        drainLines();
        if (eventBytes + Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES)
          throw new Error("Messages API event exceeds size limit");
      }
      deadline.check();
      buffer += decoder.decode();
      if (buffer) {
        // The SDK parses remaining logical lines, but does not synthesize a
        // blank record delimiter. An unfinished event is discarded at EOF.
        for (const value of buffer.replace(/\r$/, "").split(/\r\n|[\n\r]/))
          line(value);
      }
      if (stream.lacksResponseEnvelope)
        throw new StreamFailure(
          "unknown",
          "Messages API stream protocol ended without a response",
        );
      const completion = stream.completion();
      return {
        ...completion,
        content: normalizeCommittedToolBlocks(completion.content, request),
      };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async jsonCompletion(
    response: Response,
    request: CompletionRequest,
    deadline: TransportDeadline,
  ): Promise<Completion> {
    if (
      !response.body ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Messages API fallback response is not JSON");
    }
    const body: ReadableStream<Uint8Array> = response.body,
      reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        deadline.check();
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          deadline.check();
          throw new StreamFailure(
            "connectionLost",
            "Messages API fallback read failed",
          );
        }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES)
          throw new Error("Messages API response exceeds size limit");
        chunks.push(chunk.value);
      }
      deadline.check();
      let data: unknown;
      try {
        data = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        throw protocolError();
      }
      const parsed = jsonMessageSchema.safeParse(data);
      if (!parsed.success) throw protocolError();
      const message = parsed.data;
      message.content = normalizeCommittedToolBlocks(message.content, request);
      const toolIds = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id);
      if (new Set(toolIds).size !== toolIds.length) throw protocolError();
      for (const block of message.content) {
        deadline.check();
        if (block.type === "text" && block.text) request.onText(block.text);
      }
      deadline.check();
      const usage = mergeUsage(
        { input_tokens: 0, output_tokens: 0 },
        message.usage,
      );
      request.onStreamProgress?.({
        type: "assistant",
        ...(message.id === undefined ? {} : { responseId: message.id }),
        usage: structuredClone(usage),
      });
      const nativeRequestId = response.headers.get("request-id");
      return {
        content: message.content,
        stop_reason: message.stop_reason,
        usage,
        ...(request.nativeRecording === undefined
          ? {}
          : {
              nativeResponse: recordNativeJsonResponse(
                {
                  host: request.nativeRecording,
                  requestedModel: request.model,
                  ...(nativeRequestId === null
                    ? {}
                    : { requestId: nativeRequestId }),
                },
                data,
                message.content,
              ),
            }),
        ...(message.id === undefined ? {} : { responseId: message.id }),
        ...(message.model === undefined
          ? {}
          : { responseModel: message.model }),
        ...(typeof message.resumable === "boolean"
          ? { resumable: message.resumable }
          : {}),
        ...(message.context_management == null
          ? {}
          : {
              contextClearedInputTokens: clearedInputTokens(
                message.context_management,
              ),
            }),
      };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
