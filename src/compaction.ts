import { integerSetting, triBoolean } from "./env-settings.js";
import { systemPromptText } from "./system-prompt.js";
import { resolveModelFacts } from "./reasoning.js";
import {
  activeContextStart,
  contextUsage,
  estimateContextTokens,
  estimateMessageTokens,
} from "./context-usage.js";
import type {
  AgentEvent,
  CompletionRequest,
  Message,
  PrepareCompaction,
  Provider,
} from "./types.js";
import {
  ApiAttemptBudget,
  ApiAttemptBudgetExhausted,
} from "./attempt-ledger.js";
import { contextWindow, type ContextWindow } from "./context-window.js";
import {
  exchangeGroups,
  splitPendingInput,
  SummaryPlanner,
  truncateSummaryHead,
  type CompactionPolicy,
  type SummaryPlan,
} from "./compaction-plan.js";
import type { ContextRejection } from "./context-error.js";
import { ProviderHttpError } from "./http-error.js";
import {
  InvalidSummary,
  readSummary,
  summaryInstruction,
} from "./summary-response.js";
import { completeFullSummary } from "./summary-dispatch.js";

export interface CompactionState {
  compacted: boolean;
  turnCounter: number;
  consecutiveFailures: number;
  consecutiveRapidRefills: number;
}
export const freshCompactionState = (): CompactionState => ({
  compacted: false,
  turnCounter: 0,
  consecutiveFailures: 0,
  consecutiveRapidRefills: 0,
});
export function autoCompactEnabled(
  setting?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    triBoolean(env.DISABLE_COMPACT) !== true &&
    triBoolean(env.DISABLE_AUTO_COMPACT) !== true &&
    setting !== false
  );
}
export function compactWindowSetting(
  value: string,
  bareThousands = false,
): number | undefined {
  const raw = value.trim(),
    suffix = raw.slice(-1).toLowerCase();
  let tokens =
    suffix === "m" || suffix === "k"
      ? Number.parseFloat(raw) * (suffix === "m" ? 1000000 : 1000)
      : integerSetting(raw);
  if (tokens === undefined || Number.isNaN(tokens) || tokens < 1) return;
  if (
    bareThousands &&
    suffix !== "m" &&
    suffix !== "k" &&
    tokens >= 100 &&
    tokens <= 1000
  )
    tokens *= 1000;
  return Math.max(100000, Math.min(1000000, Math.round(tokens)));
}
export function compactionStatus(
  tokens: number,
  apiWindow: number,
  maxOutput: number,
  model: string,
  options: {
    enabled?: boolean;
    window?: number | string;
    context?: ContextWindow;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const enabled = autoCompactEnabled(options.enabled, env);
  const configured =
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined
      ? undefined
      : compactWindowSetting(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const setting =
    typeof options.window === "string"
      ? compactWindowSetting(options.window, true)
      : options.window;
  if (
    setting !== undefined &&
    (!Number.isSafeInteger(setting) || setting < 100000 || setting > 1000000)
  )
    throw new Error(
      "autoCompactWindow must be an integer from100000 to1000000, or a token-size string",
    );
  const facts = resolveModelFacts(model, env),
    context = options.context ?? contextWindow(model, {}, env);
  const special =
    facts.canonical === "claude-sonnet-5" &&
    ["remote_cowork", "local-agent"].includes(env.CLAUDE_CODE_ENTRYPOINT ?? "")
      ? 500000
      : apiWindow;
  const source =
    configured !== undefined
      ? "env"
      : setting !== undefined
        ? "settings"
        : special !== apiWindow ||
            apiWindow < context.withoutOptIn ||
            context.native ||
            (triBoolean(env.CLAUDE_CODE_DISABLE_1M_CONTEXT) === true &&
              (facts.context.native_1m || context.withoutOptIn > 200000))
          ? "model-default"
          : !context.recognized &&
              triBoolean(
                env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT,
              ) !== true
            ? "unknown-model"
            : "auto";
  const window = Math.min(apiWindow, configured ?? setting ?? special);
  const reserve = Math.min(maxOutput, 20000),
    effective = window - reserve;
  const percent = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
    ? Number.parseFloat(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
    : NaN;
  const threshold =
    Number.isFinite(percent) && percent > 0 && percent <= 100
      ? Math.min(Math.floor((effective * percent) / 100), effective - 13000)
      : effective - 13000;
  const override = integerSetting(env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE, 1);
  const blocking = override ?? apiWindow - reserve - 3000;
  const basis = enabled ? threshold : effective;
  const level =
    tokens >= blocking
      ? "blocked"
      : enabled && tokens >= threshold
        ? "compact"
        : tokens >= basis - 20000
          ? "warn"
          : "ok";
  // The direct API route defers default-window estimates to a server-confirmed rejection.
  return {
    level,
    window,
    effective,
    threshold,
    blocking,
    pctLeft: Math.max(0, Math.round(((basis - tokens) / basis) * 100)),
    enabled,
    source,
    deferToServer: enabled && source === "auto",
  } as const;
}

/** Distinct assistant replies start exchange groups; thinking resumption stays in its group. */
export function contextExchangeCount(messages: Message[]): number {
  return exchangeGroups(messages.slice(activeContextStart(messages))).length;
}

export function largerCompactionModel(options: {
  provider: Provider;
  messages: Message[];
  state: CompactionState;
  model: string;
  apiWindow: number;
  maxOutput: number;
  window?: number | string;
}): string | undefined {
  if (
    options.state.consecutiveFailures > 0 ||
    triBoolean(process.env.CLAUDE_CODE_NO_MODEL_FALLBACK) === true
  )
    return;
  const active = options.messages.slice(activeContextStart(options.messages));
  const latest = active.findLast(
    (message) =>
      message.role === "assistant" &&
      message.usage &&
      !message.contextUsageDiscarded,
  );
  const candidate = latest?.requestedModel;
  if (
    !candidate ||
    !active.some((message) => {
      if (
        message.role !== "assistant" ||
        !message.usage ||
        message.contextUsageDiscarded
      )
        return false;
      const usage = contextUsage(message.usage);
      return (
        usage.input_tokens +
          usage.cache_creation_input_tokens +
          usage.cache_read_input_tokens >
        0
      );
    })
  )
    return;
  const context =
    options.provider.contextWindow?.(candidate) ?? contextWindow(candidate);
  if (
    !context.recognized ||
    context.window <= options.apiWindow ||
    options.provider.canUseModel?.(candidate) === false
  )
    return;
  return compactionStatus(
    estimateContextTokens(options.messages),
    options.apiWindow,
    options.maxOutput,
    options.model,
    options.window === undefined ? {} : { window: options.window },
  ).level === "blocked"
    ? candidate
    : undefined;
}

function tailStart(messages: Message[], start: number): number {
  const last = messages.at(-1);
  if (last?.role !== "user") return messages.length;
  const results = last.content.filter((block) => block.type === "tool_result");
  if (!results.length) return messages.length - 1;
  const prior = messages.at(-2);
  const ids =
    prior?.role === "assistant"
      ? prior.content
          .filter((block) => block.type === "tool_use")
          .map((block) => block.id)
      : [];
  if (ids.length && results.every((block) => ids.includes(block.tool_use_id)))
    return Math.max(start, messages.length - 2);
  throw new Error("Cannot compact an unpaired tool-result tail");
}

export async function compactContext(options: {
  provider: Provider;
  request: Omit<CompletionRequest, "onText">;
  state: CompactionState;
  onEvent: (event: AgentEvent) => void;
  reason?: "automatic" | "manual" | "reactive";
  /** A child allowance also spends the caller's parent allowance. Exhausting only this child is a summary failure. */
  attemptLimit?: number;
  planning?: CompactionPolicy;
  inputError?: ContextRejection;
  deeperReactivePass?: boolean;
  prepareCompaction?: PrepareCompaction;
  /** Read context keeps the main model when the summary forks to a larger model. */
  restorationModel?: string;
}): Promise<boolean> {
  const { request, state } = options,
    messages = request.messages,
    start = activeContextStart(messages);
  request.signal.throwIfAborted();
  if (request.attemptBudget?.remaining === 0)
    throw new ApiAttemptBudgetExhausted();
  const manual = options.reason === "manual";
  if (messages.length <= start) return false;
  if (!manual) tailStart(messages, start);
  const planner = new SummaryPlanner(
    messages.slice(start),
    options.planning,
    options.inputError,
    Math.round(systemPromptText(request.system).length / 4),
    estimateMessageTokens(summaryInstruction()),
  );
  let plan: SummaryPlan | undefined = manual
    ? {
        toSummarize: messages.slice(start),
        toKeep: [],
        mode: "all",
        groupsPreserved: 0,
        totalGroups: contextExchangeCount(messages),
        headTruncations: 0,
        omissionPasses: 0,
        leftOutIds: new Set(),
      }
    : planner.next();
  if (!plan) return false;
  const rapid = manual
    ? 0
    : options.deeperReactivePass
      ? state.consecutiveRapidRefills
      : state.compacted && state.turnCounter < 3
        ? state.consecutiveRapidRefills + 1
        : 0;
  if (!manual && (state.consecutiveFailures >= 3 || rapid >= 3)) {
    options.onEvent({
      type: "compaction",
      stage: "skipped",
      reason:
        state.consecutiveFailures >= 3 ? "failure_breaker" : "rapid_refill",
    });
    return false;
  }
  const before = estimateContextTokens(messages);
  options.onEvent({ type: "compaction", stage: "start", beforeTokens: before });
  request.signal.throwIfAborted();
  let committed = false;
  const attemptBudget =
    options.attemptLimit === undefined
      ? request.attemptBudget
      : (request.attemptBudget?.child(options.attemptLimit) ??
        new ApiAttemptBudget(options.attemptLimit));
  let formatRepairs = 0,
    secondary = false,
    openingRescued = false,
    observerFailed = false,
    freshRequests = 0;
  type Candidate = ReturnType<typeof readSummary>;
  let salvage: { candidate: Candidate; plan: SummaryPlan } | undefined;
  const observeCompletion = (completion: import("./types.js").Completion) => {
    try {
      options.onEvent({ type: "usage", usage: completion.usage });
    } catch (error) {
      observerFailed = true;
      throw error;
    }
  };
  const fetchSummary = async (
    current: SummaryPlan,
    repair = false,
    budget = attemptBudget,
  ) => {
    const summaryRequest = {
      ...request,
      ...(budget ? { attemptBudget: budget } : {}),
      messages: [...current.toSummarize, summaryInstruction(repair)],
      resumeIncompleteThinking: false,
      onText: () => {},
      onTextReset: () => {},
      onThinkingStrip: () => {},
    };
    const completion = manual
      ? await completeFullSummary({
          provider: options.provider,
          request: summaryRequest,
          ...(options.planning?.cachePrefix === undefined
            ? {}
            : { cachePrefix: options.planning.cachePrefix }),
          ...(options.planning?.freshTools === undefined
            ? {}
            : { freshTools: options.planning.freshTools }),
          onCompletion: observeCompletion,
          onFreshRequest: () => {
            freshRequests++;
          },
        })
      : await options.provider.complete(summaryRequest);
    request.signal.throwIfAborted();
    if (!manual) observeCompletion(completion);
    return readSummary(completion);
  };
  const getSummary = async (current: SummaryPlan): Promise<Candidate> => {
    const first = await fetchSummary(current);
    if (first.shape !== "none") return first;
    if (
      !manual &&
      options.planning?.retryMissingSummary !== false &&
      attemptBudget?.remaining !== 0
    ) {
      formatRepairs++;
      const repairBudget =
        options.attemptLimit === undefined
          ? (attemptBudget?.child(1) ?? new ApiAttemptBudget(1))
          : attemptBudget;
      try {
        const repaired = await fetchSummary(current, true, repairBudget);
        if (repaired.shape !== "none") return repaired;
      } catch (error) {
        request.signal.throwIfAborted();
        if (observerFailed) throw error;
      }
    }
    if (options.attemptLimit !== undefined) throw new InvalidSummary();
    return first;
  };
  try {
    for (;;) {
      let candidate: Candidate;
      try {
        if (salvage && attemptBudget?.remaining === 0) {
          candidate = salvage.candidate;
          plan = salvage.plan;
          secondary = false;
        } else candidate = await getSummary(plan);
      } catch (error) {
        request.signal.throwIfAborted();
        if (observerFailed) throw error;
        if (salvage) {
          candidate = salvage.candidate;
          plan = salvage.plan;
          secondary = false;
        } else if (
          plan.openingOnly &&
          !(error instanceof ApiAttemptBudgetExhausted) &&
          !(error instanceof ProviderHttpError && error.context)
        ) {
          planner.discardOpening();
          const next = planner.next();
          if (next) {
            plan = next;
            continue;
          }
          throw error;
        } else if (
          error instanceof ProviderHttpError &&
          error.context &&
          manual &&
          plan.headTruncations < 3
        ) {
          const reduced = truncateSummaryHead(
            plan.toSummarize,
            error.context.gap,
          );
          if (reduced) {
            plan = {
              ...plan,
              toSummarize: reduced,
              headTruncations: plan.headTruncations + 1,
            };
            continue;
          }
          throw error;
        } else if (
          !manual &&
          error instanceof ProviderHttpError &&
          error.context &&
          planner.reject(plan, error.context)
        ) {
          const next = planner.next();
          if (next) {
            plan = next;
            continue;
          }
          throw error;
        } else throw error;
      }
      request.signal.throwIfAborted();
      if (salvage && candidate.shape !== "closed") {
        candidate = salvage.candidate;
        plan = salvage.plan;
        secondary = false;
      }
      if (plan.openingOnly && candidate.shape !== "closed") {
        planner.discardOpening();
        const next = planner.next();
        if (!next) throw new InvalidSummary();
        plan = next;
        continue;
      }
      openingRescued ||= plan.openingOnly === true;
      if (
        !salvage &&
        !manual &&
        options.planning?.summarizeKeptRounds === true &&
        plan.mode === "round" &&
        candidate.shape === "closed"
      ) {
        const tail = splitPendingInput(plan.toKeep);
        if (tail.toSummarize.some((row) => row.role === "assistant")) {
          salvage = { candidate, plan };
          secondary = true;
          plan = {
            ...plan,
            toSummarize: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Conversation summary for continuation:\n\n${candidate.text}`,
                  },
                ],
              },
              ...tail.toSummarize,
            ],
            toKeep: tail.toKeep,
            mode: "all",
            groupsPreserved: 0,
            headTruncations: 0,
            omissionPasses: 0,
            leftOutIds: new Set(),
          };
          continue;
        }
      }
      const metadata = {
        groupsPreserved: plan.groupsPreserved,
        totalGroups: plan.totalGroups,
        headTruncations: plan.headTruncations,
        omissionPasses: plan.omissionPasses,
        omittedToolResults: plan.leftOutIds.size,
        formatRepairs,
        secondarySummary: secondary,
        openingRescue: openingRescued,
        freshRequests,
        summaryModel: candidate.completion.model ?? request.model,
      };
      const boundary = {
        role: "user",
        content: [
          {
            type: "text",
            text: `Conversation summary for continuation:\n\n${candidate.text}`,
          },
        ],
        contextBoundary: {
          beforeTokens: before,
          afterTokens: 0,
          reason: options.reason ?? "automatic",
          ...metadata,
        },
      } satisfies Message;
      const [firstKept] = plan.toKeep,
        keep = firstKept ? messages.indexOf(firstKept, start) : messages.length;
      if (keep < start) throw new Error("Invalid retained context boundary");
      const tail = plan.toKeep.map((message) =>
        message.role === "assistant" && message.usage
          ? { ...message, contextUsageDiscarded: true }
          : message,
      );
      const countFileTokens = options.provider.countFileTokens?.bind(
        options.provider,
      );
      const restored = await options.prepareCompaction?.({
        keptMessages: tail,
        signal: request.signal,
        ...(countFileTokens
          ? {
              countTokens: (text: string) =>
                countFileTokens({
                  model: options.restorationModel ?? request.model,
                  text,
                  signal: request.signal,
                }),
            }
          : {}),
      });
      const next = [...tail, ...(restored?.messages ?? [])];
      const after =
        estimateMessageTokens(boundary) +
        next.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
      boundary.contextBoundary.afterTokens = after;
      request.signal.throwIfAborted();
      // Commit only after a complete summary and final cancellation check. The old prefix remains archived.
      restored?.commit();
      messages.length = keep;
      messages.push(boundary);
      for (const message of next) messages.push(message);
      Object.assign(state, {
        compacted: true,
        turnCounter: 0,
        consecutiveFailures: 0,
        consecutiveRapidRefills: rapid,
      });
      committed = true;
      options.provider.resetRequestLimits?.();
      options.onEvent({
        type: "compaction",
        stage: "complete",
        beforeTokens: before,
        afterTokens: after,
        ...metadata,
      });
      return true;
    }
  } catch (error) {
    if (committed) throw error;
    request.signal.throwIfAborted();
    if (
      error instanceof ApiAttemptBudgetExhausted &&
      (options.attemptLimit === undefined ||
        request.attemptBudget?.remaining === 0)
    )
      throw error;
    state.consecutiveFailures++;
    options.onEvent({
      type: "compaction",
      stage: "failed",
      reason: "summary_failed",
    });
    return false;
  }
}
