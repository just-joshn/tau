import type {
  HookBatchResult,
  HookInput,
  HookPermission,
  HookRunOptions,
} from "./hooks.js";
import type { HookAttachment, Message, ToolResult, ToolUse } from "./types.js";
import type { HookRegistryLike } from "./composite-hooks.js";
import { captureNativePersistenceJson } from "./native-persistence-events.js";
import {
  captureNativeToolHookResult,
  captureUnsupportedNativeHookBatch,
  type NativeAttachmentCaptureHost,
  type NativeAttachmentDelivery,
} from "./native-attachment-capture.js";

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
export interface ToolFailureHookResult {
  attachments: HookAttachment[];
}
export interface ToolFailureHookContext {
  durationMs?: number;
  isInterrupt?: boolean;
}
export type ToolOutputValidator = (
  candidate: unknown,
  original: ToolResult,
) => ToolResult | Promise<ToolResult>;
export type HookCommonInput = Pick<
  HookInput,
  "session_id" | "transcript_path" | "cwd"
> &
  Partial<Pick<HookInput, "permission_mode" | "effort">> &
  Record<string, unknown>;
export interface ToolHookRuntime {
  before(
    call: ToolUse,
    signal: AbortSignal,
    validateUpdatedInput: (input: unknown) => Promise<unknown>,
  ): Promise<PreToolHookResult>;
  after(
    call: ToolUse,
    result: ToolResult,
    signal: AbortSignal,
    validateOutput?: ToolOutputValidator,
  ): Promise<ToolResult>;
  failure?(
    call: ToolUse,
    error: unknown,
    signal: AbortSignal,
    context?: ToolFailureHookContext,
  ): Promise<void | ToolFailureHookResult>;
  stop?(context: {
    messages: Message[];
    signal: AbortSignal;
    stopHookActive: boolean;
  }): Promise<AgentStopHookResult>;
}

/** Queue hook attachments, in hook order, for projection around the result. */
export function appendHookAttachments(
  result: ToolResult,
  attachments: readonly HookAttachment[],
  stopReason?: string,
): ToolResult {
  return {
    ...result,
    ...(attachments.length
      ? {
          hookAttachments: [...(result.hookAttachments ?? []), ...attachments],
        }
      : {}),
    ...(stopReason === undefined ? {} : { hookStop: { reason: stopReason } }),
  };
}
/** Source `hook_additional_context`, named `${event}:${toolName}`. */
export function additionalContextAttachments(
  phase: HookAttachment["phase"],
  hookName: string,
  content: readonly string[],
): HookAttachment[] {
  const kept = content.filter(Boolean);
  return kept.length
    ? [{ phase, type: "hook_additional_context", hookName, content: kept }]
    : [];
}
/** Source `GGn`/`Sfn`: each blocking hook's error, then the batch's additional context. */
function batchAttachments(
  phase: HookAttachment["phase"],
  hookName: string,
  batch: HookBatchResult,
): HookAttachment[] {
  const blocking: HookAttachment[] = batch.results.flatMap((result) =>
    result.status === "blocking" && result.blockingError
      ? [
          {
            phase,
            type: "hook_blocking_error",
            hookName,
            ...result.blockingError,
          },
        ]
      : [],
  );
  return [
    ...blocking,
    ...additionalContextAttachments(phase, hookName, batch.additionalContext),
  ];
}
export function appendPreHookContext(
  result: ToolResult,
  pre: PreToolHookResult | undefined,
  call: ToolUse,
  stopReason?: string,
): ToolResult {
  return appendHookAttachments(
    result,
    additionalContextAttachments(
      "pre",
      `PreToolUse:${call.name}`,
      pre?.additionalContext ?? [],
    ),
    stopReason,
  );
}
export function appendFailureHookContext(
  result: ToolResult,
  failure: ToolFailureHookResult | void,
): ToolResult {
  return appendHookAttachments(result, failure?.attachments ?? []);
}

/** Adapts the explicit command registry to validated tool and agent seams. */
export function createToolHookRuntime(options: {
  registry: HookRegistryLike;
  context(): HookCommonInput;
  runOptions(): Omit<HookRunOptions, "signal" | "validateUpdatedInput">;
  onBatch?(
    event: HookInput["hook_event_name"],
    batch: HookBatchResult,
  ): void | Promise<void>;
  onDiagnostic?(message: string): void;
  nativeCapture?: NativeAttachmentCaptureHost;
  onToolFailure?(
    call: ToolUse,
    error: unknown,
    signal: AbortSignal,
  ): void | Promise<void>;
}): ToolHookRuntime {
  const run = async (
    input: HookInput,
    signal: AbortSignal,
    validateUpdatedInput?: (input: unknown) => Promise<unknown>,
    delivery?: Extract<NativeAttachmentDelivery, { kind: "tool-hook" }>,
  ) => {
    const runOptions = options.runOptions();
    const nativeCapture = options.nativeCapture;
    const observed = new Set<HookBatchResult["results"][number]>();
    const identity = {
      event: input.hook_event_name,
      toolName: input.tool_name ?? "",
      toolUseID: input.tool_use_id ?? "",
      toolInput:
        options.nativeCapture && delivery
          ? captureNativePersistenceJson(input.tool_input)
          : input.tool_input,
    };
    const batch = await options.registry.run(input, {
      ...runOptions,
      signal,
      ...(nativeCapture && delivery
        ? {
            onResult: async (result, context) => {
              observed.add(result);
              // Invocation snapshots the outcome and stamps synchronously before its
              // first sink await, ahead of any existing observer's possible mutation.
              const capture = captureNativeToolHookResult(
                nativeCapture,
                {
                  source: "tool-hook",
                  phase: delivery.phase,
                  ...identity,
                  execution: context.background ? "background" : "sync",
                  outcome: result,
                  transport: "command",
                  commandHook: context.hook,
                },
                delivery,
              );
              let previous: void | Promise<void>;
              try {
                previous = runOptions.onResult?.(result, context);
              } catch (error) {
                previous = Promise.reject(error);
              }
              const completed = await Promise.allSettled([capture, previous]);
              const errors = completed.flatMap((item): unknown[] =>
                item.status === "rejected" ? [item.reason] : [],
              );
              if (errors.length)
                throw new AggregateError(
                  errors,
                  "Hook attachment capture failed",
                );
            },
          }
        : {}),
      ...(validateUpdatedInput
        ? { validateUpdatedInput: (input) => validateUpdatedInput(input) }
        : {}),
    });
    signal.throwIfAborted();
    if (batch.cancelled)
      throw new DOMException("Hook execution cancelled", "AbortError");
    if (nativeCapture && delivery) {
      const unobservedResults = batch.results.filter(
        (result) => !observed.has(result),
      );
      if (
        batch.background.length ||
        unobservedResults.length ||
        (batch.additionalContext.length && !batch.results.length)
      )
        await captureUnsupportedNativeHookBatch(
          nativeCapture,
          {
            source: "tool-hook-batch",
            phase: delivery.phase,
            ...identity,
            backgroundIDs: batch.background.map((task) => task.id),
            unobservedResults,
            aggregateAdditionalContext: [...batch.additionalContext],
          },
          delivery,
        );
    }
    await options.onBatch?.(input.hook_event_name, batch);
    return batch;
  };
  return {
    async before(call, signal, validateUpdatedInput) {
      const batch = await run(
        {
          ...options.context(),
          hook_event_name: "PreToolUse",
          tool_name: call.name,
          tool_input: call.input,
          tool_use_id: call.id,
        },
        signal,
        validateUpdatedInput,
        { kind: "tool-hook", phase: "pre", call },
      );
      return {
        ...(batch.permission === undefined
          ? {}
          : { permission: batch.permission }),
        ...(batch.reason === undefined && !batch.blockingErrors.length
          ? {}
          : { reason: batch.reason ?? batch.blockingErrors.join("\n") }),
        ...(batch.updatedInput === undefined
          ? {}
          : { updatedInput: batch.updatedInput }),
        additionalContext: batch.additionalContext,
        preventContinuation: batch.preventContinuation,
        ...(batch.stopReason === undefined
          ? {}
          : { stopReason: batch.stopReason }),
      };
    },
    async after(call, original, signal, validateOutput) {
      const batch = await run(
        {
          ...options.context(),
          hook_event_name: "PostToolUse",
          tool_name: call.name,
          tool_input: call.input,
          tool_use_id: call.id,
          tool_response:
            original.hookResponse ?? original.mcpResult ?? original.content,
        },
        signal,
        undefined,
        { kind: "tool-hook", phase: "post", call, result: original },
      );
      let result = original;
      const candidate = batch.updatedMCPToolOutput ?? batch.updatedToolOutput;
      if (candidate !== undefined) {
        if (!validateOutput)
          options.onDiagnostic?.(
            `Ignored hook output rewrite for ${call.name}: no output-schema validator is available`,
          );
        else
          try {
            const validated = await validateOutput(candidate, original);
            if (
              validated.type !== "tool_result" ||
              validated.tool_use_id !== original.tool_use_id
            )
              throw new Error("Hook rewrite changed tool result identity");
            result = { ...validated, hookRewrittenOutput: candidate };
          } catch (error) {
            options.onDiagnostic?.(
              `Ignored invalid hook output rewrite for ${call.name}: ${error instanceof Error ? error.message : "validation failed"}`,
            );
          }
      }
      // Post-hook blocks become feedback after an already completed side effect.
      return appendHookAttachments(
        result,
        batchAttachments("post", `PostToolUse:${call.name}`, batch),
        batch.preventContinuation
          ? (batch.stopReason ?? "Continuation stopped by hook")
          : undefined,
      );
    },
    async failure(call, error, signal, context) {
      const batch = await run(
        {
          ...options.context(),
          hook_event_name: "PostToolUseFailure",
          tool_name: call.name,
          tool_input: call.input,
          tool_use_id: call.id,
          error: error instanceof Error ? error.message : String(error),
          is_interrupt: context?.isInterrupt ?? false,
          ...(context?.durationMs === undefined
            ? {}
            : { duration_ms: context.durationMs }),
        },
        signal,
        undefined,
        { kind: "tool-hook", phase: "failure", call, error },
      );
      await options.onToolFailure?.(call, error, signal);
      // Sfn consumes failure blocks/context as attachments after the failed result.
      // It does not apply output rewrites, permission verdicts or continuation flags.
      return {
        attachments: batchAttachments(
          "failure",
          `PostToolUseFailure:${call.name}`,
          batch,
        ),
      };
    },
    async stop({ messages, signal, stopHookActive }) {
      const lastAssistant = messages.findLast(
        (message) => message.role === "assistant",
      );
      const lastAssistantText =
        lastAssistant?.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n") ?? "";
      const batch = await run(
        {
          ...options.context(),
          hook_event_name: "Stop",
          stop_hook_active: stopHookActive,
          last_assistant_message: lastAssistantText,
        },
        signal,
      );
      return {
        continue: !batch.preventContinuation && batch.blockingErrors.length > 0,
        additionalContext: [
          ...batch.blockingErrors,
          ...batch.additionalContext,
        ],
        preventContinuation: batch.preventContinuation,
        ...(batch.stopReason === undefined ? {} : { reason: batch.stopReason }),
      };
    },
  };
}
