import { join } from "node:path";
import { createLocalTaskStore, localTaskListIdentity } from "./task-store.js";
import {
  createTaskRuntime,
  type TaskLifecycleContext,
} from "./task-runtime.js";
import { matchingToolRule, type ToolPolicy } from "./tool-policy.js";
import type { ToolExecutor, ToolUse } from "./types.js";
import type { ToolHookRuntime } from "./tool-hook-runtime.js";

/** Local task storage and native allow, with host source-aware restrictions retained. */
export function createSessionTaskHost(options: {
  userConfigDir: string;
  sessionId: string;
  environmentListId?: string;
  enabled(): boolean;
  policy(): ToolPolicy;
  approve(description: string): Promise<boolean>;
  hooks: ToolHookRuntime;
  lifecycle(
    event: "TaskCreated" | "TaskCompleted",
    task: { taskId: string; subject: string; description: string },
    signal: AbortSignal,
  ): Promise<readonly string[]>;
  onDiagnostic?(message: string): void;
}) {
  const listId = localTaskListIdentity({
    sessionId: options.sessionId,
    ...(options.environmentListId === undefined
      ? {}
      : { environmentListId: options.environmentListId }),
  });
  const store = createLocalTaskStore({
    root: join(options.userConfigDir, "tasks"),
    listId,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  const available = (name: string) =>
    options.enabled() &&
    (options.policy().tools?.some((tool) => tool === name) ?? true) &&
    matchingToolRule(options.policy(), "deny", name) === undefined;
  const lifecycle =
    (event: "TaskCreated" | "TaskCompleted") =>
    async ({ task, signal }: TaskLifecycleContext) => ({
      blockingErrors: await options.lifecycle(
        event,
        {
          taskId: task.id,
          subject: task.subject,
          description: task.description,
        },
        signal,
      ),
    });
  const runtime = createTaskRuntime({
    store,
    context: () => ({ sessionId: options.sessionId, mode: "local" }),
    enabled: options.enabled,
    hooks: options.hooks,
    lifecycle: {
      created: lifecycle("TaskCreated"),
      completed: lifecycle("TaskCompleted"),
    },
    authorize: async (call, _context, hookPermission) => {
      if (!available(call.name))
        return `Task tool is disabled or denied: ${call.name}`;
      if (
        matchingToolRule(options.policy(), "ask", call.name) ||
        hookPermission === "ask"
      )
        return options.approve(`Use ${call.name} in task list ${listId}?`);
      return true;
    },
  });
  return {
    store,
    runtime,
    listId,
    wrap(base: ToolExecutor): ToolExecutor {
      return {
        ...base,
        get definitions() {
          return [
            ...base.definitions,
            ...runtime.definitions.filter((tool) => available(tool.name)),
          ];
        },
        execute(call: ToolUse, signal: AbortSignal) {
          return runtime.handles(call.name)
            ? runtime.execute(call, signal)
            : base.execute(call, signal);
        },
      };
    },
  };
}
