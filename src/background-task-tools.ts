import { z } from "zod";
import { BackgroundTaskError } from "./background-agent-runtime.js";
import {
  appendFailureHookContext,
  appendPreHookContext,
  type PreToolHookResult,
  type ToolHookRuntime,
} from "./tool-hook-runtime.js";
import {
  matchesPermissionArgument,
  ToolInputRejected,
  ToolPermissionDenied,
  type ToolPolicy,
} from "./tool-policy.js";
import { unparsedToolInput } from "./tool-input.js";
import type { ToolDefinition, ToolExecutor, ToolUse } from "./types.js";

export const taskStopToolNames = ["TaskStop", "KillShell", "KillBash"] as const;
export const taskStopInputSchema = z
  .strictObject({
    task_id: z.string().optional(),
    shell_id: z.string().optional(),
  })
  .refine(
    (input) => Boolean(input.task_id ?? input.shell_id),
    "Missing required parameter: task_id",
  );
export const taskStopOutputSchema = z.object({
  message: z.string(),
  task_id: z.string(),
  task_type: z.string(),
  command: z.string().optional(),
});
export type TaskStopInput = z.infer<typeof taskStopInputSchema>;
export type TaskStopOutput = z.infer<typeof taskStopOutputSchema>;
export interface BackgroundTaskToolView {
  id: string;
  type: string;
  status: string;
  agentId?: string;
  description?: string;
  settled?: boolean;
}
export interface BackgroundTaskToolContext {
  callerAgentId?: string;
}
export interface BackgroundTaskToolsOptions {
  get(
    id: string,
  ):
    | BackgroundTaskToolView
    | undefined
    | Promise<BackgroundTaskToolView | undefined>;
  /** Already scoped local registry view; not a model ListAgents or peer-discovery operation. */
  list():
    | readonly BackgroundTaskToolView[]
    | Promise<readonly BackgroundTaskToolView[]>;
  /** Host atomically enforces main-or-self ownership and task-type/live-loop admission. */
  stop(
    id: string,
    request: {
      callerAgentId?: string;
      killedBy: "parent";
      signal: AbortSignal;
    },
  ): TaskStopOutput | Promise<TaskStopOutput>;
  context(): BackgroundTaskToolContext;
  enabled(): boolean;
  policy(): ToolPolicy;
  /** Always called, including hook allow. An explicit policy ask is passed as hookPermission:'ask'. */
  authorize(
    call: ToolUse,
    context: Readonly<BackgroundTaskToolContext>,
    hookPermission: PreToolHookResult["permission"],
    signal: AbortSignal,
  ): boolean | string | Promise<boolean | string>;
  hooks?: ToolHookRuntime;
  onDiagnostic?(message: string): void;
}
/** The schema refine guarantees a non-empty id; this restates it for the type checker with the schema's own message. */
const taskIdOf = (input: TaskStopInput): string =>
  input.task_id ??
  input.shell_id ??
  (() => {
    throw new ToolInputRejected("Missing required parameter: task_id");
  })();
const canonical = (name: string): "TaskStop" | undefined =>
  taskStopToolNames.some((tool) => tool === name) ? "TaskStop" : undefined;
function matchesRule(
  rule: string,
  behavior: "allow" | "deny" | "ask",
  input?: unknown,
): boolean {
  for (const name of taskStopToolNames) {
    if (rule === name) return true;
    if (!rule.startsWith(`${name}(`) || !rule.endsWith(")")) continue;
    let escapes = 0;
    for (
      let index = rule.length - 2;
      index >= 0 && rule[index] === "\\";
      index--
    )
      escapes++;
    if (escapes % 2) continue;
    const body = rule
      .slice(name.length + 1, -1)
      .replaceAll("\\(", "(")
      .replaceAll("\\)", ")")
      .replaceAll("\\\\", "\\");
    if (body === "" || body === "*") return true;
    if (behavior === "allow" || input === null || typeof input !== "object")
      continue;
    const colon = body.indexOf(":"),
      key = body.slice(0, colon).trim(),
      pattern = body.slice(colon + 1).trim();
    if (colon <= 0 || !key || !pattern || !Object.hasOwn(input, key)) continue;
    const value: unknown = Reflect.get(input, key);
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      typeof value !== "bigint"
    )
      continue;
    if (matchesPermissionArgument(pattern, String(value).trim())) return true;
  }
  return false;
}
function rule(
  options: BackgroundTaskToolsOptions,
  behavior: "allow" | "deny" | "ask",
  input?: unknown,
): boolean {
  const policy = options.policy();
  const direct =
    behavior === "allow"
      ? policy.allowedTools
      : behavior === "deny"
        ? policy.disallowedTools
        : (policy.askedTools ?? []);
  return (
    direct.some((value) => matchesRule(value, behavior, input)) ||
    (policy.sourcedRules ?? []).some(
      (value) =>
        value.behavior === behavior && matchesRule(value.rule, behavior, input),
    )
  );
}
function available(options: BackgroundTaskToolsOptions): boolean {
  const policy = options.policy();
  return (
    options.enabled() &&
    (policy.tools === undefined ||
      policy.tools.some((name) => canonical(name) !== undefined)) &&
    !rule(options, "deny")
  );
}
/** Native WX short-output identity, surrogate-safe head/tail bounds, and provenance marker retention. */
export function projectTaskStopText(text: string): string {
  if (text.length <= 1000) return text;
  let head = text.slice(0, 500),
    tail = text.slice(-300);
  const last = head.charCodeAt(head.length - 1),
    first = tail.charCodeAt(0);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  const projected = `${head}\n\n... [${text.length - head.length - tail.length} characters truncated] ...\n\n${tail}`;
  const missing = [
    "<artifact-content-authored-by-others/>",
    "<remote-control-device-report/>",
  ].filter((marker) => text.includes(marker) && !projected.includes(marker));
  return missing.length ? `${projected}\n${missing.join("\n")}` : projected;
}
function format(data: TaskStopOutput): string {
  return JSON.stringify({
    ...data,
    message: projectTaskStopText(data.message),
    ...(data.command === undefined
      ? {}
      : { command: projectTaskStopText(data.command) }),
  });
}
/** Ordinary registered local tasks only. Names, remote commands, peers and observer kill semantics remain host features. */
export function createBackgroundTaskTools(
  options: BackgroundTaskToolsOptions,
): ToolExecutor & {
  handles(name: string): boolean;
  wrap(base: ToolExecutor): ToolExecutor;
} {
  async function validate(
    value: unknown,
    signal: AbortSignal,
  ): Promise<TaskStopInput> {
    let input: TaskStopInput;
    try {
      input = taskStopInputSchema.parse(value);
    } catch (error) {
      throw new ToolInputRejected(
        error instanceof Error ? error.message : "TaskStop input rejected",
      );
    }
    const id = taskIdOf(input);
    let task: BackgroundTaskToolView | undefined;
    try {
      task = await options.get(id);
    } catch (error) {
      if (!(error instanceof BackgroundTaskError && error.code === "not_found"))
        throw error;
    }
    signal.throwIfAborted();
    if (!task) {
      const tasks = await options.list();
      signal.throwIfAborted();
      const caller = options.context().callerAgentId;
      const running = tasks
        .filter(
          (item) =>
            item.status === "running" &&
            (caller === undefined || item.agentId === caller),
        )
        .map((item) => item.id);
      throw new ToolInputRejected(
        `No task found with ID: ${id}${running.length ? `. Running local tasks: ${running.join(", ")}` : ""}`,
      );
    }
    if (
      task.status !== "running" &&
      !(task.type === "local_agent" && task.settled === false)
    )
      throw new ToolInputRejected(
        `Task ${id} is not running (status: ${task.status})`,
      );
    return input;
  }
  const runtime: ToolExecutor & {
    handles(name: string): boolean;
    wrap(base: ToolExecutor): ToolExecutor;
  } = {
    get definitions(): ToolDefinition[] {
      return available(options)
        ? [
            {
              name: "TaskStop",
              description:
                "Stop a registered background task by task_id. shell_id is a deprecated input alias. Task ownership is checked when stopping.",
              input_schema: {
                ...z.toJSONSchema(taskStopInputSchema, { io: "input" }),
                type: "object",
              },
            },
          ]
        : [];
    },
    handles(name) {
      return canonical(name) !== undefined;
    },
    async execute(original, signal) {
      let call: ToolUse = {
          ...original,
          name: canonical(original.name) ?? original.name,
        },
        pre: PreToolHookResult | undefined,
        started = false;
      try {
        signal.throwIfAborted();
        if (!runtime.handles(original.name) || !available(options))
          throw new ToolPermissionDenied(
            "TaskStop is disabled or denied by policy",
          );
        const unparsed = unparsedToolInput(call.input);
        if (unparsed)
          throw new ToolInputRejected(
            `input JSON failed to parse — ${unparsed.len} bytes`,
          );
        let input = await validate(call.input, signal);
        call = { ...call, input };
        const actor = options.context().callerAgentId;
        if (actor !== undefined && typeof actor !== "string")
          throw new Error("TaskStop caller identity must be a string");
        const context = Object.freeze(
          actor === undefined ? {} : { callerAgentId: actor },
        );
        pre = await options.hooks?.before(call, signal, (input) =>
          validate(input, signal),
        );
        signal.throwIfAborted();
        if (pre?.preventContinuation)
          return appendPreHookContext(
            {
              type: "tool_result",
              tool_use_id: original.id,
              content: pre.stopReason ?? "TaskStop stopped by hook",
              is_error: true,
            },
            pre,
            call,
            pre.stopReason ?? "Continuation stopped by hook",
          );
        if (pre?.permission === "deny" || pre?.permission === "defer")
          throw new ToolPermissionDenied(
            pre.reason ?? "TaskStop denied by hook",
          );
        if (pre?.updatedInput !== undefined) {
          input = await validate(pre.updatedInput, signal);
          call = { ...call, input };
        }
        if (!available(options) || rule(options, "deny", call.input))
          throw new ToolPermissionDenied(
            "TaskStop is disabled or denied by policy",
          );
        const permission = rule(options, "ask", call.input)
          ? "ask"
          : pre?.permission;
        const approved = await options.authorize(
          call,
          context,
          permission,
          signal,
        );
        signal.throwIfAborted();
        if (approved !== true)
          throw new ToolPermissionDenied(
            typeof approved === "string"
              ? approved
              : "TaskStop denied by host policy",
          );
        if (!available(options) || rule(options, "deny", call.input))
          throw new ToolPermissionDenied(
            "TaskStop is disabled or denied by policy",
          );
        started = true;
        const data = taskStopOutputSchema.parse(
          await options.stop(taskIdOf(input), {
            ...context,
            killedBy: "parent",
            signal,
          }),
        );
        signal.throwIfAborted();
        started = false;
        let result = appendPreHookContext(
          {
            type: "tool_result",
            tool_use_id: original.id,
            content: format(data),
            hookResponse: data,
            ...(pre?.updatedInput === undefined
              ? {}
              : { effectiveToolInput: call.input }),
          },
          pre,
          call,
        );
        if (options.hooks)
          result = await options.hooks.after(
            call,
            result,
            signal,
            (replacement) => {
              const updated = taskStopOutputSchema.parse(replacement);
              return {
                ...result,
                content: format(updated),
                hookResponse: updated,
              };
            },
          );
        return result;
      } catch (error) {
        signal.throwIfAborted();
        let result = appendPreHookContext(
          {
            type: "tool_result",
            tool_use_id: original.id,
            is_error: true,
            content: error instanceof Error ? error.message : "TaskStop failed",
            ...(error instanceof ToolPermissionDenied
              ? { permissionDenied: true }
              : {}),
            ...(error instanceof ToolInputRejected
              ? { inputRejected: true }
              : {}),
            ...(pre?.updatedInput === undefined
              ? {}
              : { effectiveToolInput: call.input }),
          },
          pre,
          call,
        );
        if (started && options.hooks?.failure) {
          try {
            result = appendFailureHookContext(
              result,
              await options.hooks.failure(call, error, signal),
            );
          } catch (hookError) {
            signal.throwIfAborted();
            options.onDiagnostic?.(
              `TaskStop failure hook failed: ${hookError instanceof Error ? hookError.message : "unknown error"}`,
            );
          }
        }
        return result;
      }
    },
    wrap(base) {
      return {
        ...base,
        get definitions() {
          return [...base.definitions, ...runtime.definitions];
        },
        execute(call, signal) {
          return runtime.handles(call.name)
            ? runtime.execute(call, signal)
            : base.execute(call, signal);
        },
      };
    },
  };
  return runtime;
}
