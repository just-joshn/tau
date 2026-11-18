import type { HookBatchResult, HookInput, HookPermission, HookRegistry, HookRunOptions } from "./hooks.js";
import type { HookAttachmentMetadata, Message, ToolResult, ToolUse } from "./types.js";
import type { HookRegistryLike } from "./composite-hooks.js";

export interface PreToolHookResult {
  permission?: HookPermission;
  reason?: string;
  updatedInput?: unknown;
  additionalContext: string[];
  preventContinuation: boolean;
  stopReason?: string;
}
export interface AgentStopHookResult {
  continue: boolean;
  additionalContext?: string[];
  preventContinuation?: boolean;
  reason?: string;
}
export interface ToolFailureHookResult { additionalContext: string[]; attachments?: HookAttachmentMetadata[] }
export interface ToolFailureHookContext { durationMs?: number; isInterrupt?: boolean }
export type ToolOutputValidator = (candidate: unknown, original: ToolResult) => ToolResult | Promise<ToolResult>;
export type HookCommonInput = Pick<HookInput, "session_id" | "transcript_path" | "cwd"> &
  Partial<Pick<HookInput, "permission_mode" | "effort">> & Record<string, unknown>;
export interface ToolHookRuntime {
  before(call: ToolUse, signal: AbortSignal, validateUpdatedInput: (input: unknown) => Promise<unknown>): Promise<PreToolHookResult>;
  after(call: ToolUse, result: ToolResult, signal: AbortSignal, validateOutput?: ToolOutputValidator): Promise<ToolResult>;
  failure?(call: ToolUse, error: unknown, signal: AbortSignal, context?: ToolFailureHookContext): Promise<void | ToolFailureHookResult>;
  stop?(context: { messages: Message[]; signal: AbortSignal; stopHookActive: boolean }): Promise<AgentStopHookResult>;
}

/** Queue hook attachments for the host to commit outside the tool payload. */
export function appendHookContext(result: ToolResult, context: readonly string[], stopReason?: string, tag?: Omit<HookAttachmentMetadata, "content">): ToolResult {
  const additions = context.filter(Boolean);
  return { ...result,
    ...(additions.length ? tag ? { hookAttachments: [...result.hookAttachments ?? [], { ...tag, content: additions }] }
      : { hookContext: [...result.hookContext ?? [], ...additions] } : {}),
    ...(stopReason === undefined ? {} : { hookStop: { reason: stopReason } }),
  };
}
export function appendPreHookContext(result: ToolResult, pre: PreToolHookResult | undefined, call: ToolUse, stopReason?: string): ToolResult {
  return appendHookContext(result, pre?.additionalContext ?? [], stopReason, { phase: "pre", event: "PreToolUse", toolName: call.name });
}
export function appendFailureHookContext(result: ToolResult, failure: ToolFailureHookResult | void): ToolResult {
  const annotated = failure?.attachments?.length ? { ...result, hookAttachments: [...result.hookAttachments ?? [], ...failure.attachments] } : result;
  return appendHookContext(annotated, failure?.additionalContext ?? []);
}

/** Adapts the explicit command registry to validated tool and agent seams. */
export function createToolHookRuntime(options: {
  registry: HookRegistryLike;
  context(): HookCommonInput;
  runOptions(): Omit<HookRunOptions, "signal" | "validateUpdatedInput">;
  onBatch?(event: HookInput["hook_event_name"], batch: HookBatchResult): void | Promise<void>;
  onDiagnostic?(message: string): void;
  onToolFailure?(call: ToolUse, error: unknown, signal: AbortSignal): void | Promise<void>;
}): ToolHookRuntime {
  const run = async (input: HookInput, signal: AbortSignal, validateUpdatedInput?: (input: unknown) => Promise<unknown>) => {
    const batch = await options.registry.run(input, { ...options.runOptions(), signal,
      ...(validateUpdatedInput ? { validateUpdatedInput: input => validateUpdatedInput(input) } : {}) });
    signal.throwIfAborted();
    if (batch.cancelled) throw new DOMException("Hook execution cancelled", "AbortError");
    await options.onBatch?.(input.hook_event_name, batch);
    return batch;
  };
  return {
    async before(call, signal, validateUpdatedInput) {
      const batch = await run({ ...options.context(), hook_event_name: "PreToolUse", tool_name: call.name,
        tool_input: call.input, tool_use_id: call.id }, signal, validateUpdatedInput);
      return { ...(batch.permission === undefined ? {} : { permission: batch.permission }),
        ...(batch.reason === undefined && !batch.blockingErrors.length ? {} : { reason: batch.reason ?? batch.blockingErrors.join("\n") }),
        ...(batch.updatedInput === undefined ? {} : { updatedInput: batch.updatedInput }), additionalContext: batch.additionalContext,
        preventContinuation: batch.preventContinuation, ...(batch.stopReason === undefined ? {} : { stopReason: batch.stopReason }) };
    },
    async after(call, original, signal, validateOutput) {
      const batch = await run({ ...options.context(), hook_event_name: "PostToolUse", tool_name: call.name,
        tool_input: call.input, tool_use_id: call.id, tool_response: original.hookResponse ?? original.mcpResult ?? original.content }, signal);
      let result = original;
      const candidate = batch.updatedMCPToolOutput ?? batch.updatedToolOutput;
      if (candidate !== undefined) {
        if (!validateOutput) options.onDiagnostic?.(`Ignored hook output rewrite for ${call.name}: no output-schema validator is available`);
        else try {
          const validated = await validateOutput(candidate, original);
          if (validated.type !== "tool_result" || validated.tool_use_id !== original.tool_use_id) throw new Error("Hook rewrite changed tool result identity");
          result = { ...validated, hookRewrittenOutput: candidate };
        } catch (error) { options.onDiagnostic?.(`Ignored invalid hook output rewrite for ${call.name}: ${error instanceof Error ? error.message : "validation failed"}`); }
      }
      // Post-hook blocks become feedback after an already completed side effect.
      const annotated = appendHookContext(result, batch.additionalContext,
        batch.preventContinuation ? batch.stopReason ?? "Continuation stopped by hook" : undefined,
        { phase: "post", event: "PostToolUse", toolName: call.name });
      return appendHookContext(annotated, batch.blockingErrors);
    },
    async failure(call, error, signal, context) {
      const batch = await run({ ...options.context(), hook_event_name: "PostToolUseFailure", tool_name: call.name,
        tool_input: call.input, tool_use_id: call.id, error: error instanceof Error ? error.message : String(error),
        is_interrupt: context?.isInterrupt ?? false,
        ...(context?.durationMs === undefined ? {} : { duration_ms: context.durationMs }) }, signal);
      await options.onToolFailure?.(call, error, signal);
      // Sfn consumes failure blocks/context as attachments after the failed result.
      // It does not apply output rewrites, permission verdicts or continuation flags.
      return { additionalContext: [...batch.blockingErrors], ...(batch.additionalContext.length ? { attachments: [
        { phase: "failure", event: "PostToolUseFailure", toolName: call.name, content: [...batch.additionalContext] },
      ] } : {}) };
    },
    async stop({ messages, signal, stopHookActive }) {
      const lastAssistant = messages.findLast(message => message.role === "assistant");
      const lastAssistantText = lastAssistant?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
      const batch = await run({ ...options.context(), hook_event_name: "Stop", stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText }, signal);
      return { continue: !batch.preventContinuation && batch.blockingErrors.length > 0,
        additionalContext: [...batch.blockingErrors, ...batch.additionalContext], preventContinuation: batch.preventContinuation,
        ...(batch.stopReason === undefined ? {} : { reason: batch.stopReason }) };
    },
  };
}
