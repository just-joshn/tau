import { AgentMaxTurnsError } from "./agent.js";
import { resolveModelFacts } from "./reasoning.js";
import type {
  AgentEvent,
  ApiToolContent,
  AssistantBlock,
  Message,
  PermissionMode,
  ToolUse,
  Usage,
} from "./types.js";

/**
 * Print-mode SDK messages, the --output-format json/stream-json protocol.
 * Shapes follow the original's SDK schemas (chunk-bprgtdg6.js) and builders:
 * init u$t (chunk-xfksw6er.js), assistant/user fV (chunk-cr640x0r.js),
 * result Zne and its variants (chunk-q67vgc7s.js).
 */
export type SdkMessage =
  | SdkSystemInit
  | SdkSystemStatus
  | SdkCompactBoundary
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkStreamEvent
  | SdkResult;

interface Envelope {
  session_id: string;
  uuid: string;
}

export interface SdkSystemInit extends Envelope {
  type: "system";
  subtype: "init";
  cwd: string;
  tools: string[];
  mcp_servers: SdkMcpServer[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  apiKeySource: "ANTHROPIC_API_KEY";
  claude_code_version: string;
  output_style: "default";
  agents: string[];
  skills: string[];
  plugins: SdkPlugin[];
}
export interface SdkMcpServer {
  name: string;
  status: "connected" | "failed";
}
export interface SdkPlugin {
  name: string;
  path: string;
  source: string;
}

/** Announces each model request; on the wire only with partial messages. */
export interface SdkSystemStatus extends Envelope {
  type: "system";
  subtype: "status";
  status: "requesting";
}

/** Marks completed context compaction (SDK schema r6, chunk-bprgtdg6.js). */
export interface SdkCompactBoundary extends Envelope {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens?: number;
  };
}

export interface SdkApiAssistantMessage {
  id: string | null;
  type: "message";
  role: "assistant";
  model: string;
  content: [AssistantBlock];
  stop_reason: string | null;
  stop_sequence: null;
  usage: Usage;
  context_management: null;
}
export interface SdkAssistantMessage extends Envelope {
  type: "assistant";
  message: SdkApiAssistantMessage;
  parent_tool_use_id: null;
  timestamp: string;
}

export interface SdkToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ApiToolContent[];
  is_error?: true;
}
export interface SdkUserMessage extends Envelope {
  type: "user";
  message: { role: "user"; content: [SdkToolResultBlock] };
  parent_tool_use_id: null;
  timestamp: string;
  tool_use_result: string;
}

export interface SdkStreamEvent extends Envelope {
  type: "stream_event";
  /** The SSE event exactly as the Messages API sent it. */
  event: unknown;
  parent_tool_use_id: null;
  ttft_ms?: number;
  api_message_id?: string;
}

export interface SdkUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  output_tokens_details: { thinking_tokens: number };
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  service_tier: "standard";
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  inference_geo: "";
  iterations: unknown[];
  speed: "standard";
  fallback_credit: null;
}
export interface SdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
  thinkingTokens: number;
  cacheCreationEphemeral5mInputTokens: number;
  cacheCreationEphemeral1hInputTokens: number;
  canonicalModel: string;
  provider: "firstParty";
  costBasis: "list";
}
export interface SdkPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
}

interface SdkResultCommon extends Envelope {
  type: "result";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: SdkUsage;
  modelUsage: Record<string, SdkModelUsage>;
  /** Tracked only for stream-json output (jRi, chunk-xt4nsgp1.js). */
  model_usage_since_last_result?: Record<string, SdkModelUsage>;
  permission_denials: SdkPermissionDenial[];
  terminal_reason?: "completed" | "max_turns";
  result_index: number;
}
export type SdkResult =
  | (SdkResultCommon & {
      subtype: "success";
      api_error_status: number | null;
      result: string;
      ttft_ms?: number;
    })
  | (SdkResultCommon & {
      subtype: "error_max_turns" | "error_during_execution";
      errors: string[];
    });

/** How a query ended, decided from its thrown error (if any) and final text. */
export type SdkQueryOutcome =
  | { kind: "completed"; result: string }
  | { kind: "max_turns"; maxTurns: number }
  | { kind: "failed"; message: string };

export function sdkQueryOutcome(
  failure: { error: unknown; message: string } | undefined,
  answer: string,
): SdkQueryOutcome {
  if (failure === undefined) return { kind: "completed", result: answer };
  if (failure.error instanceof AgentMaxTurnsError)
    return { kind: "max_turns", maxTurns: failure.error.maxTurns };
  return { kind: "failed", message: failure.message };
}

export interface SdkInitFacts {
  cwd: string;
  tools: readonly string[];
  mcpServers: readonly SdkMcpServer[];
  model: string;
  permissionMode: PermissionMode;
  slashCommands: readonly string[];
  agents: readonly string[];
  skills: readonly string[];
  plugins: readonly SdkPlugin[];
}

export interface SdkSessionOptions {
  version: string;
  includePartialMessages: boolean;
  usageSinceLastResult: boolean;
  limits: (model: string) => { contextWindow: number; maxOutputTokens: number };
  now?: () => number;
  uuid?: () => string;
}

/** The original reports its Agent tool under the legacy name (IFn, chunk-xfksw6er.js). */
const sdkToolName = (name: string) => (name === "Agent" ? "Task" : name);

/**
 * Per-million-token list prices, [input, output, 5m cache write, cache read],
 * from the original's baked model catalog pricing tiers (chunk-9vmv3a50.js).
 */
const PRICING_TIERS = {
  tier_2_10: [2, 10, 2.5, 0.2],
  tier_2_10_cache_read_0_10: [2, 10, 2.5, 0.1],
  tier_3_15: [3, 15, 3.75, 0.3],
  tier_5_25: [5, 25, 6.25, 0.5],
  tier_15_75: [15, 75, 18.75, 1.5],
  tier_10_50: [10, 50, 12.5, 1],
  tier_10_50_cache_read_0_25: [10, 50, 12.5, 0.25],
  tier_4_20_cache_read_0_20: [4, 20, 5, 0.2],
  tier_8_40_cache_read_0_20: [8, 40, 10, 0.2],
  haiku_35: [0.8, 4, 1, 0.08],
  haiku_45: [1, 5, 1.25, 0.1],
  haiku_55: [0.1, 0.5, 0.125, 0.01],
} as const satisfies Record<string, readonly [number, number, number, number]>;
const MODEL_PRICING: Record<string, keyof typeof PRICING_TIERS> = {
  "claude-3-5-haiku": "haiku_35",
  "claude-haiku-4-5": "haiku_45",
  "claude-haiku-5-5": "haiku_55",
  "claude-3-5-sonnet": "tier_3_15",
  "claude-3-7-sonnet": "tier_3_15",
  "claude-sonnet-4-0": "tier_3_15",
  "claude-sonnet-4-5": "tier_3_15",
  "claude-sonnet-4-6": "tier_3_15",
  "claude-sonnet-5": "tier_2_10",
  "claude-sonnet-5-5": "tier_2_10_cache_read_0_10",
  "claude-opus-4-0": "tier_15_75",
  "claude-opus-4-1": "tier_15_75",
  "claude-opus-4-5": "tier_5_25",
  "claude-opus-4-6": "tier_5_25",
  "claude-opus-4-7": "tier_5_25",
  "claude-opus-4-8": "tier_5_25",
  "claude-opus-5": "tier_5_25",
  "claude-opus-5-5": "tier_4_20_cache_read_0_20",
  "claude-fable-5": "tier_10_50",
  "claude-fable-5-1": "tier_10_50_cache_read_0_25",
  "claude-fable-5-2": "tier_8_40_cache_read_0_20",
  "claude-mythos-5": "tier_10_50",
  "claude-mythos-5-1": "tier_10_50_cache_read_0_25",
  "claude-mythos-5-2": "tier_8_40_cache_read_0_20",
};

/** vYt's per-response cost, in its evaluation order; unknown models use the default tier. */
export function responseCostUsd(canonicalModel: string, usage: Usage): number {
  const [input, output, cacheWrite, cacheRead] =
    PRICING_TIERS[MODEL_PRICING[canonicalModel] ?? "tier_5_25"];
  return (
    (usage.input_tokens / 1e6) * input +
    (usage.output_tokens / 1e6) * output +
    ((usage.cache_read_input_tokens ?? 0) / 1e6) * cacheRead +
    ((usage.cache_creation_input_tokens ?? 0) / 1e6) * cacheWrite
  );
}

function sdkUsage(usage: Usage): SdkUsage {
  return {
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens,
    output_tokens_details: { thinking_tokens: 0 },
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

class ModelUsageLedger {
  readonly entries = new Map<string, SdkModelUsage>();
  constructor(private readonly limits: SdkSessionOptions["limits"]) {}
  add(model: string, usage: Usage, cost: number): void {
    const canonicalModel = resolveModelFacts(model).canonical;
    const entry = this.entries.get(model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      ...this.limits(model),
      thinkingTokens: 0,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0,
      canonicalModel,
      provider: "firstParty" as const,
      costBasis: "list" as const,
    };
    entry.inputTokens += usage.input_tokens;
    entry.outputTokens += usage.output_tokens;
    entry.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
    entry.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    entry.costUSD += cost;
    this.entries.set(model, entry);
  }
  snapshot(): Record<string, SdkModelUsage> {
    return Object.fromEntries(
      [...this.entries].map(([model, entry]) => [model, { ...entry }]),
    );
  }
}

/** Session-wide totals the original reports cumulatively on every result. */
export class SdkSession {
  readonly #options: Required<SdkSessionOptions>;
  readonly #modelUsage: ModelUsageLedger;
  #totalCost = 0;
  #apiMs = 0;
  #results = 0;
  constructor(options: SdkSessionOptions) {
    this.#options = {
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      ...options,
    };
    this.#modelUsage = new ModelUsageLedger(options.limits);
  }

  init(sessionId: string, facts: SdkInitFacts): SdkSystemInit {
    return {
      type: "system",
      subtype: "init",
      cwd: facts.cwd,
      session_id: sessionId,
      tools: facts.tools.map(sdkToolName),
      mcp_servers: facts.mcpServers.map((server) => ({ ...server })),
      model: facts.model,
      permissionMode: facts.permissionMode,
      slash_commands: [...facts.slashCommands],
      apiKeySource: "ANTHROPIC_API_KEY",
      claude_code_version: this.#options.version,
      output_style: "default",
      agents: [...facts.agents],
      skills: [...facts.skills],
      plugins: facts.plugins.map((plugin) => ({ ...plugin })),
      uuid: this.#options.uuid(),
    };
  }

  /** Starts the reducer for one query; its result closes it. */
  query(sessionId: string, model: string): SdkQuery {
    return new SdkQuery({
      sessionId,
      model,
      options: this.#options,
      record: (usage, cost) => {
        this.#modelUsage.add(model, usage, cost);
        this.#totalCost += cost;
      },
      apiTime: (ms) => (this.#apiMs += ms),
      totals: () => ({
        total_cost_usd: this.#totalCost,
        duration_api_ms: this.#apiMs,
        modelUsage: this.#modelUsage.snapshot(),
        result_index: this.#results++,
      }),
    });
  }
}

type SdkQueryTotals = Pick<
  SdkResultCommon,
  "total_cost_usd" | "duration_api_ms" | "modelUsage" | "result_index"
>;
interface SdkQueryContext {
  sessionId: string;
  model: string;
  options: Required<SdkSessionOptions>;
  record(usage: Usage, cost: number): void;
  apiTime(ms: number): void;
  totals(): SdkQueryTotals;
}

interface ResponseStart {
  id: string | undefined;
  model: string | undefined;
  usage: Usage;
  emitted: number;
}

export class SdkQuery {
  readonly #context: SdkQueryContext;
  readonly #session: string;
  readonly #model: string;
  readonly #options: Required<SdkSessionOptions>;
  readonly #started: number;
  readonly #usage: Usage = { input_tokens: 0, output_tokens: 0 };
  readonly #sinceLast: ModelUsageLedger;
  readonly #calls = new Map<string, ToolUse>();
  readonly #denials: SdkPermissionDenial[] = [];
  #rounds = 0;
  #stopReason: string | null = null;
  #requestAt: number | undefined;
  #firstContentAt: number | undefined;
  #response: ResponseStart | undefined;
  /** Set when the model request itself failed; the query then ends as an API error. */
  #apiErrorStatus: number | null | undefined;

  constructor(context: SdkQueryContext) {
    this.#context = context;
    this.#session = context.sessionId;
    this.#model = context.model;
    this.#options = context.options;
    this.#started = context.options.now();
    this.#sinceLast = new ModelUsageLedger(context.options.limits);
  }

  /** Folds one agent event into the turn and returns the messages it produces. */
  accept(event: AgentEvent): SdkMessage[] {
    switch (event.type) {
      case "model_request":
        this.#requestAt = this.#options.now();
        return this.#options.includePartialMessages
          ? [
              {
                type: "system",
                subtype: "status",
                status: "requesting",
                session_id: this.#session,
                uuid: this.#options.uuid(),
              },
            ]
          : [];
      case "stream_event":
        return this.#streamEvent(event);
      case "usage": {
        const cost = responseCostUsd(
          resolveModelFacts(this.#model).canonical,
          event.usage,
        );
        this.#usage.input_tokens += event.usage.input_tokens;
        this.#usage.output_tokens += event.usage.output_tokens;
        this.#usage.cache_read_input_tokens =
          (this.#usage.cache_read_input_tokens ?? 0) +
          (event.usage.cache_read_input_tokens ?? 0);
        this.#usage.cache_creation_input_tokens =
          (this.#usage.cache_creation_input_tokens ?? 0) +
          (event.usage.cache_creation_input_tokens ?? 0);
        this.#sinceLast.add(this.#model, event.usage, cost);
        this.#context.record(event.usage, cost);
        return [];
      }
      case "assistant":
        return this.#assistant(event.message, event.stopReason);
      case "api_error":
        this.#apiErrorStatus = event.status;
        return [];
      case "tool_start":
        this.#calls.set(event.tool.id, event.tool);
        return [];
      case "tool_result": {
        const { result } = event;
        const call = this.#calls.get(result.tool_use_id);
        if (
          result.permissionDenied &&
          call &&
          !this.#denials.some((entry) => entry.tool_use_id === call.id)
        )
          this.#denials.push({
            tool_name: sdkToolName(call.name),
            tool_use_id: call.id,
            tool_input: call.input,
          });
        return [
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: result.tool_use_id,
                  content: result.apiContent ?? result.content,
                  ...(result.is_error ? { is_error: true as const } : {}),
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: this.#session,
            uuid: this.#options.uuid(),
            timestamp: this.#timestamp(),
            tool_use_result: result.is_error
              ? `Error: ${unwrapToolError(result.content)}`
              : result.content,
          },
        ];
      }
      case "compaction":
        return event.stage === "complete"
          ? [
              {
                type: "system",
                subtype: "compact_boundary",
                session_id: this.#session,
                uuid: this.#options.uuid(),
                compact_metadata: {
                  trigger: event.reason === "manual" ? "manual" : "auto",
                  pre_tokens: event.beforeTokens ?? 0,
                  ...(event.afterTokens === undefined
                    ? {}
                    : { post_tokens: event.afterTokens }),
                },
              },
            ]
          : [];
      case "text":
      case "text_reset":
      case "warning":
      case "thinking_stripped":
        return [];
      default: {
        const exhaustive: never = event;
        throw new Error(`Unknown event: ${String(exhaustive)}`);
      }
    }
  }

  /** The closing result; the original's Zne plus its success or error variant. */
  finish(outcome: SdkQueryOutcome): SdkResult {
    const totals = this.#context.totals();
    const common: Omit<SdkResultCommon, "is_error" | "num_turns"> = {
      type: "result",
      duration_ms: Math.max(0, Math.round(this.#options.now() - this.#started)),
      duration_api_ms: totals.duration_api_ms,
      stop_reason: this.#stopReason,
      session_id: this.#session,
      total_cost_usd: totals.total_cost_usd,
      usage: sdkUsage(this.#usage),
      modelUsage: totals.modelUsage,
      ...(this.#options.usageSinceLastResult
        ? { model_usage_since_last_result: this.#sinceLast.snapshot() }
        : {}),
      permission_denials: this.#denials.map((denial) => ({ ...denial })),
      result_index: totals.result_index,
      uuid: this.#options.uuid(),
    };
    switch (outcome.kind) {
      case "completed":
        return {
          ...common,
          terminal_reason: "completed",
          subtype: "success",
          is_error: false,
          num_turns: this.#rounds,
          api_error_status: null,
          result: outcome.result,
          ...(this.#firstContentAt === undefined
            ? {}
            : {
                ttft_ms: Math.max(
                  0,
                  Math.round(this.#firstContentAt - this.#started),
                ),
              }),
        };
      case "max_turns":
        return {
          ...common,
          terminal_reason: "max_turns",
          subtype: "error_max_turns",
          is_error: true,
          num_turns: outcome.maxTurns + 1,
          errors: [`Reached maximum number of turns (${outcome.maxTurns})`],
        };
      case "failed":
        // The original turns a failed model request into an error reply: a
        // success result flagged is_error, carrying the API status.
        if (this.#apiErrorStatus !== undefined)
          return {
            ...common,
            subtype: "success",
            is_error: true,
            num_turns: this.#rounds,
            api_error_status: this.#apiErrorStatus,
            result: outcome.message,
          };
        return {
          ...common,
          subtype: "error_during_execution",
          is_error: true,
          num_turns: this.#rounds,
          errors: [outcome.message],
        };
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unknown outcome: ${String(exhaustive)}`);
      }
    }
  }

  #streamEvent(
    event: Extract<AgentEvent, { type: "stream_event" }>,
  ): SdkMessage[] {
    const now = this.#options.now();
    const parsed = event.event;
    if (parsed.type === "message_start")
      this.#response = {
        id: parsed.message.id,
        model: parsed.message.model,
        usage: responseUsage(parsed.message.usage),
        emitted: 0,
      };
    if (
      (parsed.type === "content_block_start" ||
        parsed.type === "content_block_delta") &&
      this.#firstContentAt === undefined
    )
      this.#firstContentAt = now;
    const out: SdkMessage[] = [];
    if (parsed.type === "content_block_stop" && event.block && this.#response) {
      out.push(this.#assistantBlock(event.block, this.#response, null));
      this.#response.emitted++;
    }
    if (this.#options.includePartialMessages) {
      const id = this.#response?.id;
      out.push({
        type: "stream_event",
        event: event.raw,
        session_id: this.#session,
        parent_tool_use_id: null,
        uuid: this.#options.uuid(),
        ...(parsed.type === "message_start" && this.#requestAt !== undefined
          ? { ttft_ms: Math.max(0, Math.round(now - this.#requestAt)) }
          : {}),
        ...(id ? { api_message_id: id } : {}),
      });
    }
    return out;
  }

  #assistant(message: Message, stopReason: string): SdkMessage[] {
    this.#rounds++;
    this.#stopReason = stopReason;
    if (this.#requestAt !== undefined)
      this.#context.apiTime(Math.max(0, this.#options.now() - this.#requestAt));
    const streamed = this.#response;
    this.#response = undefined;
    const response: ResponseStart = {
      id: message.responseId,
      model: message.responseModel ?? message.model,
      usage: responseUsage(
        message.usage ?? { input_tokens: 0, output_tokens: 0 },
      ),
      emitted: 0,
    };
    // Streamed blocks were emitted as they closed; a JSON fallback response emits here.
    return message.content
      .slice(streamed?.emitted ?? 0)
      .flatMap((block) =>
        block.type === "tool_result"
          ? []
          : [this.#assistantBlock(block, response, stopReason)],
      );
  }

  #assistantBlock(
    block: AssistantBlock,
    response: ResponseStart,
    stopReason: string | null,
  ): SdkAssistantMessage {
    return {
      type: "assistant",
      message: {
        id: response.id ?? null,
        type: "message",
        role: "assistant",
        model: response.model ?? this.#model,
        content: [block],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: response.usage,
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: this.#session,
      uuid: this.#options.uuid(),
      timestamp: this.#timestamp(),
    };
  }

  #timestamp(): string {
    return new Date(this.#options.now()).toISOString();
  }
}

function responseUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null | undefined;
  cache_read_input_tokens?: number | null | undefined;
}): Usage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(usage.cache_creation_input_tokens == null
      ? {}
      : { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
    ...(usage.cache_read_input_tokens == null
      ? {}
      : { cache_read_input_tokens: usage.cache_read_input_tokens }),
  };
}

function unwrapToolError(content: string): string {
  const match = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(content);
  return match?.[1] ?? content;
}
