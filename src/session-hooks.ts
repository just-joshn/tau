import {
  createToolHookRuntime,
  type HookCommonInput,
} from "./tool-hook-runtime.js";
import type { HookBatchResult, HookResult, HookRunOptions } from "./hooks.js";
import type { Message, ToolExecutor } from "./types.js";
import type { HookRegistryLike } from "./composite-hooks.js";
import { sanitizeHookAttachmentText } from "./hook-attachment-projection.js";
import {
  AsyncHookOwner,
  renderAsyncHookResponse,
  type AsyncHookOwnerOptions,
} from "./async-hooks.js";

/** Session lifecycle/context delivery around the validated tool-hook runtime. */
export function createSessionHookHost(options: {
  registry: HookRegistryLike;
  context: () => HookCommonInput;
  runOptions(): Omit<HookRunOptions, "signal" | "validateUpdatedInput">;
  onDiagnostic?: (message: string) => void;
  /** Owner of `async`/`asyncRewake` commands; without it they stay plain background hooks. */
  asyncHooks?: AsyncHookOwnerOptions;
}) {
  const pending: string[] = [];
  const asyncHooks = options.asyncHooks
    ? new AsyncHookOwner(options.asyncHooks)
    : undefined;
  const runOptions = () => ({
    ...options.runOptions(),
    ...(asyncHooks ? { onAsyncHook: asyncHooks.admit.bind(asyncHooks) } : {}),
  });
  let closed = false,
    pendingStop: string | undefined;
  const report = (result: HookResult) => {
    if (result.asyncOwned) return;
    if (result.systemMessage) options.onDiagnostic?.(result.systemMessage);
    if (result.status === "error" || result.status === "blocking")
      options.onDiagnostic?.(
        `${result.event}: ${result.reason ?? result.error ?? "hook failed"}`,
      );
  };
  const receiveStart = (result: HookResult) => {
    if (closed || result.asyncOwned) return;
    report(result);
    if (result.preventContinuation)
      pendingStop =
        result.stopReason ?? "SessionStart hook stopped continuation";
    if (result.status !== "success") return;
    if (result.additionalContext) pending.push(result.additionalContext);
    if (result.initialUserMessage) pending.push(result.initialUserMessage);
    const plain = result.stdout.trim();
    if (!result.suppressOutput && plain && !plain.startsWith("{"))
      pending.push(plain);
    if (
      result.watchPaths?.length ||
      result.reloadSkills ||
      result.sessionTitle !== undefined
    ) {
      options.onDiagnostic?.(
        "SessionStart requested watch, skill reload or title metadata that this host does not yet apply",
      );
    }
  };
  const onBatch = (_event: string, batch: HookBatchResult) => {
    for (const result of batch.results) report(result);
  };
  const runtime = createToolHookRuntime({
    registry: options.registry,
    context: options.context,
    runOptions: () => ({
      ...runOptions(),
      onBackgroundResult: async (result) => {
        if (result.event === "SessionStart") receiveStart(result);
        else report(result);
      },
    }),
    onBatch,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  return {
    runtime,
    async task(
      event: "TaskCreated" | "TaskCompleted",
      task: { taskId: string; subject: string; description?: string },
      signal: AbortSignal,
    ): Promise<string[]> {
      const batch = await options.registry.run(
        {
          ...options.context(),
          hook_event_name: event,
          task_id: task.taskId,
          task_subject: task.subject,
          ...(task.description === undefined
            ? {}
            : { task_description: task.description }),
        },
        { ...runOptions(), signal },
      );
      signal.throwIfAborted();
      onBatch(event, batch);
      if (batch.cancelled)
        throw new DOMException("Task hook cancelled", "AbortError");
      // The task consumers use blocking feedback; unrelated continuation fields
      // never turn an internal metadata update into an agent Stop transition.
      return batch.results
        .filter((result) => result.status === "blocking")
        .map((result) => {
          const command = options.registry
            .list(event)
            .find((entry) => entry.id === result.id)?.hook;
          const label = [result.command, ...(command?.args ?? [])].join(" ");
          return `${event} hook feedback:\n${sanitizeHookAttachmentText(`[${label}]: ${result.reason ?? result.error ?? (result.stderr.trim() || "Blocked by hook")}`)}`;
        });
    },
    get hasToolHooks() {
      return (
        ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const
      ).some((event) => options.registry.list(event).length > 0);
    },
    async start(
      source: "startup" | "resume" | "clear" | "compact" | "fork",
      signal: AbortSignal,
    ) {
      const batch = await options.registry.run(
        { ...options.context(), hook_event_name: "SessionStart", source },
        {
          ...runOptions(),
          signal,
          onBackgroundResult: async (result) => {
            receiveStart(result);
          },
        },
      );
      signal.throwIfAborted();
      for (const result of batch.results) receiveStart(result);
      if (batch.cancelled)
        throw new DOMException("SessionStart hook cancelled", "AbortError");
      if (pendingStop) throw new Error(pendingStop);
    },
    wrap(tools: ToolExecutor, messages: Message[]): ToolExecutor {
      return {
        ...tools,
        get definitions() {
          return tools.definitions;
        },
        async beforeModelRequest(signal) {
          await tools.beforeModelRequest?.(signal);
          signal.throwIfAborted();
          if (pendingStop) throw new Error(pendingStop);
          if (pending.length)
            messages.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Session hook context:\n${pending.splice(0).join("\n\n")}`,
                },
              ],
            });
          const texts = (asyncHooks?.collect() ?? []).flatMap(
            renderAsyncHookResponse,
          );
          if (texts.length)
            messages.push({
              role: "user",
              content: texts.map((text) => ({ type: "text", text })),
            });
        },
      };
    },
    /** Source `Y$s`, run after a print result. */
    settleRewakes: (timeoutMs?: number) =>
      asyncHooks?.settleRewakes(timeoutMs) ?? Promise.resolve(),
    async close() {
      closed = true;
      asyncHooks?.close();
      await options.registry.close();
    },
  };
}
