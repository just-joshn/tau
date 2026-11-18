import type { AgentEvent, CompletionRequest, Message, Provider, ToolExecutor, ToolResult, Usage } from "./types.js";
import { ApiAttemptBudget, ApiAttemptBudgetExhausted } from "./attempt-ledger.js";
import { canResumeThinking, markThinkingStripped } from "./thinking-history.js";
import { ProviderHttpError, resumePrefillRefused } from "./http-error.js";
import { defaultOutputTokens, modelBytesPerToken, resolveModelFacts, supportsInterleavedThinking } from "./reasoning.js";
import { ModelContextRoom } from "./context-room.js";
import { contextWindow } from "./context-window.js";
import { estimateContextTokens } from "./context-usage.js";
import { autoCompactEnabled, compactContext, compactionStatus, contextExchangeCount, freshCompactionState, largerCompactionModel, type CompactionState } from "./compaction.js";
import { canOmitToolResults, type CompactionPolicy } from "./compaction-plan.js";
import type { ContextRejection } from "./context-error.js";
import { activeContextStart } from "./context-usage.js";
import type { AgentStopHookResult } from "./tool-hook-runtime.js";
import { toolCallForExecution } from "./tool-call-normalization.js";
import type { QueryEffort } from "./query-model-effort.js";

// Independent continuation instruction; the original bundled prompt is not incorporated.
const continueResponse = (): Message => ({ role: "user", content: [{ type: "text", text: "Continue the response from the point where it was cut off. Finish the answer without repeating completed work." }] });

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Agent interrupted", "AbortError");
}

export async function runAgent(options: {
  provider: Provider;
  tools: ToolExecutor;
  messages: Message[];
  model: string;
  system: string;
  maxTokens: number;
  useModelTokenDefaults?: boolean;
  /** Read after tool/context updates for each model round. */
  queryEffort?: () => QueryEffort | undefined;
  maxTurns: number;
  maxApiAttempts?: number;
  thinkingResumption?: boolean;
  contextWindowTokens?: number;
  autoCompact?: boolean;
  autoCompactWindow?: number | string;
  compactionState?: CompactionState;
  compactionPolicy?: CompactionPolicy;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onStreamProgress?: CompletionRequest["onStreamProgress"];
  stopHook?: (context: { messages: Message[]; signal: AbortSignal; stopHookActive: boolean }) => Promise<AgentStopHookResult>;
}): Promise<{ messages: Message[]; usage: Usage; turns: number }> {
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) throw new Error("maxTurns must be a positive integer");
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw new Error("maxTokens must be a positive integer");
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const attemptBudget = options.maxApiAttempts === undefined ? undefined : new ApiAttemptBudget(options.maxApiAttempts);
  let outputContinuations = 0, resumeIncompleteThinking = false;
  let stopHookActive = false;
  let reactiveCompactionAttempted = false;
  let deeperReactiveAvailable = false, lastTransitionReactive = false;
  const compaction = options.compactionState ?? freshCompactionState();
  const onUsage = (event: Extract<AgentEvent, { type: "usage" }>) => {
    usage.input_tokens += event.usage.input_tokens; usage.output_tokens += event.usage.output_tokens; options.onEvent(event);
  };
  if (options.contextWindowTokens !== undefined && (!Number.isSafeInteger(options.contextWindowTokens) || options.contextWindowTokens < 1)) throw new Error("contextWindowTokens must be a positive integer");
  const effectiveMaxOutput = () => Math.min(options.useModelTokenDefaults ? defaultOutputTokens(options.model) : options.maxTokens,
    resolveModelFacts(options.model).upperOutput, process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ? defaultOutputTokens(options.model) : Infinity,
    options.provider.outputTokenLimit?.(options.model) ?? Infinity);
  const compact = (reason: "automatic" | "reactive", model = options.model, attemptLimit?: number,
    recovery: { inputError?: ContextRejection; deeperReactivePass?: boolean; planning?: CompactionPolicy } = {}) => compactContext({ provider: options.provider, state: compaction, reason, ...recovery,
    ...(options.tools.prepareCompaction ? { prepareCompaction: options.tools.prepareCompaction, restorationModel: options.model } : {}),
    ...(attemptLimit === undefined ? {} : { attemptLimit }), request: {
    model, system: options.system, messages: options.messages, tools: options.tools.definitions, maxTokens: options.maxTokens, signal: options.signal,
    ...(options.useModelTokenDefaults ? { useModelTokenDefaults: true } : {}), ...(attemptBudget ? { attemptBudget } : {}),
  }, onEvent: event => event.type === "usage" ? onUsage(event) : options.onEvent(event) });
  for (let turns = 1; turns <= options.maxTurns; turns++) {
    abortIfNeeded(options.signal);
    await options.tools.beforeModelRequest?.(options.signal);
    abortIfNeeded(options.signal);
    const apiWindow = options.contextWindowTokens ?? options.provider.contextWindowTokens?.(options.model) ?? contextWindow(options.model).window;
    const maxOutput = effectiveMaxOutput();
    const policy = { ...(options.autoCompact === undefined ? {} : { enabled: options.autoCompact }), ...(options.autoCompactWindow === undefined ? {} : { window: options.autoCompactWindow }),
      context: options.provider.contextWindow?.(options.model) ?? contextWindow(options.model) };
    const sizing = compactionStatus(estimateContextTokens(options.messages), apiWindow, maxOutput, options.model, policy);
    const largerModel = () => largerCompactionModel({ provider: options.provider, messages: options.messages, state: compaction, model: options.model, apiWindow, maxOutput,
      ...(options.autoCompactWindow === undefined ? {} : { window: options.autoCompactWindow }) });
    const preferred = sizing.enabled ? largerModel() : undefined;
    const rapidRefill = compaction.compacted && compaction.turnCounter < 3;
    const planning = { ...options.compactionPolicy, allowLastResort: sizing.level === "blocked", keepNoRound: sizing.level !== "blocked" && rapidRefill,
      summarizeKeptRounds: options.compactionPolicy?.summarizeKeptRounds === true && rapidRefill && sizing.level === "blocked" };
    let compacted = preferred ? await compact("automatic", preferred, 1, { planning: { ...planning, allowLastResort: true } }) : false;
    if (sizing.enabled && !sizing.deferToServer && (sizing.level === "compact" || sizing.level === "blocked")) {
      if (!compacted) compacted = await compact("automatic", options.model, undefined, { planning });
      const remaining = compactionStatus(estimateContextTokens(options.messages), apiWindow, effectiveMaxOutput(), options.model, policy);
      if (remaining.level === "blocked") {
        if (attemptBudget?.remaining === 0) throw new ApiAttemptBudgetExhausted();
        throw new Error("Context is full and compaction could not make enough room");
      }
    }
    if (compacted) resumeIncompleteThinking = false;
    if (!sizing.enabled && sizing.level === "blocked") throw new Error("Context is full and automatic compaction is disabled");
    let completion: Awaited<ReturnType<Provider["complete"]>>;
    const queryEffort = options.queryEffort?.();
    try { completion = await options.provider.complete({
      model: options.model,
      system: options.system,
      messages: options.messages,
      tools: options.tools.definitions,
      maxTokens: options.maxTokens,
      ...(options.useModelTokenDefaults ? { useModelTokenDefaults: true } : {}),
      ...(queryEffort === undefined ? {} : { queryEffort }),
      ...(resumeIncompleteThinking ? { resumeIncompleteThinking: true } : {}),
      signal: options.signal,
      onText: (text) => options.onEvent({ type: "text", text }),
      ...(options.onStreamProgress === undefined ? {} : { onStreamProgress: options.onStreamProgress }),
      onTextReset: (text) => options.onEvent({ type: "text_reset", text }),
      onThinkingStrip: (strip) => {
        const marked = markThinkingStripped(options.messages, strip);
        if (marked !== options.messages) for (const [index, message] of marked.entries()) options.messages[index] = message;
        options.onEvent({ type: "thinking_stripped", strip });
      },
      ...(attemptBudget ? { attemptBudget } : {}),
    }); } catch (error) {
      abortIfNeeded(options.signal);
      const deeper = reactiveCompactionAttempted && deeperReactiveAvailable && lastTransitionReactive;
      if (error instanceof ProviderHttpError && error.context && (!reactiveCompactionAttempted || deeper) &&
          autoCompactEnabled(options.autoCompact) && contextExchangeCount(options.messages) >= 2) {
        reactiveCompactionAttempted = true;
        if (deeper) deeperReactiveAvailable = false;
        const preferred = largerModel();
        const recovery = { inputError: error.context, deeperReactivePass: deeper, planning: { ...options.compactionPolicy, allowLastResort: true } };
        const compacted = preferred ? await compact("reactive", preferred, 1, recovery) : false;
        if (compacted || await compact("reactive", options.model, undefined, recovery)) {
          if (!deeper) deeperReactiveAvailable = contextExchangeCount(options.messages) >= 3 ||
            canOmitToolResults(options.messages.slice(activeContextStart(options.messages)), error.context.gap, options.compactionPolicy);
          lastTransitionReactive = true; resumeIncompleteThinking = false; turns--; continue;
        }
      }
      if (!resumeIncompleteThinking || !resumePrefillRefused(error)) throw error;
      options.messages.push(continueResponse());
      resumeIncompleteThinking = false;
      lastTransitionReactive = false;
      turns--;
      continue;
    }
    usage.input_tokens += completion.usage.input_tokens;
    lastTransitionReactive = false;
    usage.output_tokens += completion.usage.output_tokens;
    compaction.turnCounter++;
    options.onEvent({ type: "usage", usage: completion.usage });
    abortIfNeeded(options.signal);
    const assistant: Message = { role: "assistant", content: completion.content,
      ...(completion.partial ? { partial: completion.partial } : {}), ...(completion.model ? { model: completion.model } : {}),
      ...(completion.responseModel === undefined ? {} : { responseModel: completion.responseModel }),
      ...(completion.responseId === undefined ? {} : { responseId: completion.responseId }),
      requestedModel: completion.model ?? options.model,
      ...(completion.resumable === undefined ? {} : { resumable: completion.resumable }),
      usage: completion.usage,
      ...(completion.contextClearedInputTokens === undefined ? {} : { contextClearedInputTokens: completion.contextClearedInputTokens }),
      ...(resumeIncompleteThinking ? { resumedFromIncompleteThinking: true } : {}) };
    const calls = completion.content.filter((block) => block.type === "tool_use");
    const readModel = completion.model ?? options.model, readHistory = options.messages.slice();
    const readWindow = options.contextWindowTokens ?? options.provider.contextWindowTokens?.(readModel) ?? contextWindow(readModel).window;
    const roomSizing = () => compactionStatus(0, readWindow, defaultOutputTokens(readModel), readModel, {
      ...(options.autoCompact === undefined ? {} : { enabled: options.autoCompact }),
      ...(autoCompactEnabled(options.autoCompact) && options.autoCompactWindow !== undefined ? { window: options.autoCompactWindow } : {}),
      context: options.provider.contextWindow?.(readModel) ?? contextWindow(readModel),
    });
    const room = new ModelContextRoom(() => roomSizing().threshold, readWindow - Math.min(defaultOutputTokens(readModel), 20000),
      () => estimateContextTokens(readHistory, modelBytesPerToken(readModel)));
    const results: ToolResult[] = calls.map((call) => ({
      type: "tool_result", tool_use_id: call.id, content: "Tool execution interrupted before completion", is_error: true,
    }));
    options.messages.push(assistant);
    try {
      const countFileTokens = options.provider.countFileTokens?.bind(options.provider);
      if (calls.length) options.tools.setReadContext?.({ room, parentUsage: completion.usage, bytesPerToken: modelBytesPerToken(readModel),
        ...(countFileTokens ? { countTokens: (text, signal) => countFileTokens({ model: readModel, text, signal }) } : {}) });
      options.onEvent({ type: "assistant", message: assistant });
      if (completion.partial) options.onEvent({ type: "warning", message: "Response interrupted. The retained response may be incomplete." });
      if (completion.stop_reason === "max_tokens" && !calls.length) {
        if (outputContinuations >= 3) throw new Error("Agent response reached max_tokens after three continuation attempts");
        outputContinuations++;
        const model = completion.model ?? options.model;
        const window = options.contextWindowTokens ?? options.provider.contextWindowTokens?.(model) ?? contextWindow(model).window;
        resumeIncompleteThinking = (options.thinkingResumption ?? options.provider.thinkingResumption) === true && resolveModelFacts(model).canonical === resolveModelFacts(options.model).canonical && supportsInterleavedThinking(model) && canResumeThinking(completion, model, window);
        if (!resumeIncompleteThinking) options.messages.push(continueResponse());
        continue;
      }
      resumeIncompleteThinking = false;
      if (completion.stop_reason === "tool_use" || completion.stop_reason === "max_tokens" && calls.length > 0) {
        if (!calls.length) throw new Error("Provider stopped for tool_use without a tool call");
        for (const [index, call] of calls.entries()) {
          abortIfNeeded(options.signal);
          options.onEvent({ type: "tool_start", tool: call });
          abortIfNeeded(options.signal);
          let result: ToolResult;
          try {
            result = await options.tools.execute(toolCallForExecution(call), options.signal);
          } catch {
            abortIfNeeded(options.signal);
            result = { type: "tool_result", tool_use_id: call.id, content: "Tool execution failed", is_error: true };
          }
          if (result.tool_use_id !== call.id) throw new Error("Tool executor returned a mismatched tool result");
          results[index] = result;
          options.onEvent({ type: "tool_result", result });
          abortIfNeeded(options.signal);
          if (result.hookStop) {
            for (const pending of results.slice(index + 1)) pending.content = "Tool execution skipped because a hook stopped continuation";
            options.onEvent({ type: "warning", message: result.hookStop.reason });
            return { messages: options.messages, usage, turns };
          }
        }
      } else if (calls.length || !["end_turn", "stop_sequence", "refusal"].includes(completion.stop_reason)) {
        throw new Error("Provider returned an unsupported stop reason");
      } else {
        abortIfNeeded(options.signal);
        if (options.stopHook) {
          const decision = await options.stopHook({ messages: options.messages, signal: options.signal, stopHookActive });
          abortIfNeeded(options.signal);
          if (decision.reason && decision.preventContinuation) options.onEvent({ type: "warning", message: decision.reason });
          if (decision.continue && !decision.preventContinuation) {
            const feedback = decision.additionalContext?.filter(Boolean).join("\n\n") || "A Stop hook requested additional work before ending this turn.";
            options.messages.push({ role: "user", content: [{ type: "text", text: feedback }] });
            stopHookActive = true;
            continue;
          }
        }
        return { messages: options.messages, usage, turns };
      }
    } finally {
      options.tools.setReadContext?.(undefined);
      // Every committed tool call needs a result, including unstarted calls after interruption.
      if (results.length) options.messages.push({ role: "user", content: [
        ...results, ...results.flatMap(result => (result.hookContext ?? []).map(text => ({ type: "text" as const, text }))),
      ] });
    }
  }
  throw new Error("Agent reached maxTurns before completing");
}
