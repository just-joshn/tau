/**
 * One call of a self-contained built-in tool, in the original's order: schema
 * parse, validateInput, PreToolUse hooks, checkPermissions plus whole-tool
 * rules and mode, then call and PostToolUse. Monitor and the worktree tools
 * share it.
 */
import { z } from "zod";
import {
  appendFailureHookContext,
  appendPreHookContext,
  type PreToolHookResult,
  type ToolHookRuntime,
} from "./tool-hook-runtime.js";
import { unparsedToolInput } from "./tool-input.js";
import {
  matchingToolRule,
  permissionDeniedMarkers,
  ToolInputRejected,
  ToolPermissionDenied,
  type ToolPolicy,
} from "./tool-policy.js";
import type {
  PermissionMode,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  ToolUse,
} from "./types.js";

/** checkPermissions: what the tool itself asks for before rules and mode apply. */
export type ToolCheck =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; prompt: string };

/** validateInput's refusal: the model sees it inside <tool_use_error>. */
export class ToolValidationRefused extends Error {}

export interface GuardedTool<Input> {
  name: string;
  definition(): ToolDefinition;
  schema(): z.ZodType<Input>;
  validate?(input: Input): Promise<string | undefined>;
  check(input: Input): Promise<ToolCheck>;
  run(input: Input, call: ToolUse, signal: AbortSignal): Promise<string>;
}

export interface GuardedToolHost {
  mode(): PermissionMode;
  policy(): ToolPolicy;
  hooks(): ToolHookRuntime | undefined;
  approve(prompt: string): Promise<boolean>;
}

export function guardedToolEnabled(host: GuardedToolHost, name: string) {
  const policy = host.policy();
  return (
    (policy.tools === undefined ||
      policy.tools.some((tool) => tool === name)) &&
    matchingToolRule(policy, "deny", name) === undefined
  );
}

function parse<Input>(tool: GuardedTool<Input>, value: unknown): Input {
  const parsed = tool.schema().safeParse(value);
  if (!parsed.success)
    throw new ToolInputRejected(
      `<tool_use_error>InputValidationError: ${parsed.error.issues.map((issue) => issue.message).join("; ")}</tool_use_error>`,
    );
  return parsed.data;
}
async function validated<Input>(
  tool: GuardedTool<Input>,
  value: unknown,
): Promise<Input> {
  const input = parse(tool, value);
  const refusal = await tool.validate?.(input);
  if (refusal !== undefined)
    throw new ToolValidationRefused(
      `<tool_use_error>${refusal}</tool_use_error>`,
    );
  return input;
}

async function authorize<Input>(
  tool: GuardedTool<Input>,
  host: GuardedToolHost,
  input: Input,
  pre: PreToolHookResult | undefined,
): Promise<void> {
  const check = await tool.check(input);
  if (check.behavior === "deny") throw new ToolPermissionDenied(check.message);
  const policy = host.policy();
  const askRule = matchingToolRule(policy, "ask", tool.name) !== undefined;
  const granted =
    pre?.permission !== "ask" &&
    !askRule &&
    (check.behavior === "allow" ||
      pre?.permission === "allow" ||
      matchingToolRule(policy, "allow", tool.name) !== undefined ||
      host.mode() === "bypassPermissions");
  if (granted) return;
  const prompt =
    check.behavior === "ask"
      ? check.prompt
      : `Claude wants to use ${tool.name}. Allow?`;
  if (!(await host.approve(prompt).catch(() => false)))
    throw new ToolPermissionDenied(
      `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
      "pre-ask",
    );
}

export async function runGuardedTool<Input>(
  tool: GuardedTool<Input>,
  host: GuardedToolHost,
  original: ToolUse,
  signal: AbortSignal,
): Promise<ToolResult> {
  const hooks = host.hooks();
  let call: ToolUse = original,
    pre: PreToolHookResult | undefined,
    started = false;
  try {
    signal.throwIfAborted();
    if (!guardedToolEnabled(host, tool.name))
      throw new ToolPermissionDenied(
        `Tool disabled or denied by policy: ${tool.name}`,
      );
    const unparsed = unparsedToolInput(call.input);
    if (unparsed)
      throw new ToolInputRejected(
        `input JSON failed to parse — ${unparsed.len} bytes`,
      );
    let input = await validated(tool, call.input);
    call = { ...call, input };
    pre = await hooks?.before(call, signal, async (value) =>
      parse(tool, value),
    );
    signal.throwIfAborted();
    if (pre?.preventContinuation)
      return appendPreHookContext(
        {
          type: "tool_result",
          tool_use_id: original.id,
          content: pre.stopReason ?? "Tool call stopped by hook",
          is_error: true,
        },
        pre,
        call,
        pre.stopReason ?? "Continuation stopped by hook",
      );
    if (pre?.permission === "deny" || pre?.permission === "defer")
      throw new ToolPermissionDenied(pre.reason ?? "Tool denied by hook");
    if (pre?.updatedInput !== undefined) {
      input = await validated(tool, pre.updatedInput);
      call = { ...call, input };
    }
    await authorize(tool, host, input, pre);
    signal.throwIfAborted();
    started = true;
    const content = await tool.run(input, call, signal);
    started = false;
    const result = appendPreHookContext(
      {
        type: "tool_result",
        tool_use_id: original.id,
        content,
        ...(pre?.updatedInput === undefined
          ? {}
          : { effectiveToolInput: call.input }),
      },
      pre,
      call,
    );
    return hooks ? await hooks.after(call, result, signal) : result;
  } catch (error) {
    signal.throwIfAborted();
    const result = appendPreHookContext(
      {
        type: "tool_result",
        tool_use_id: original.id,
        is_error: true,
        content: error instanceof Error ? error.message : `${tool.name} failed`,
        ...permissionDeniedMarkers(error),
        ...(error instanceof ToolInputRejected ? { inputRejected: true } : {}),
        ...(pre?.updatedInput === undefined
          ? {}
          : { effectiveToolInput: call.input }),
      },
      pre,
      call,
    );
    return started && hooks?.failure
      ? appendFailureHookContext(
          result,
          await hooks.failure(call, error, signal),
        )
      : result;
  }
}

/** A guarded tool bound to its host, with its input type erased for routing. */
export interface GuardedToolRunner {
  name: string;
  definition(): ToolDefinition;
  execute(call: ToolUse, signal: AbortSignal): Promise<ToolResult>;
}
export function bindGuardedTool<Input>(
  tool: GuardedTool<Input>,
  host: GuardedToolHost,
): GuardedToolRunner {
  return {
    name: tool.name,
    definition: () => tool.definition(),
    execute: (call, signal) => runGuardedTool(tool, host, call, signal),
  };
}

/** Advertises the enabled tools after the base executor's and routes their calls. */
export function wrapGuardedTools(
  base: ToolExecutor,
  runners: readonly GuardedToolRunner[],
  host: GuardedToolHost,
): ToolExecutor {
  return {
    ...base,
    get definitions() {
      return [
        ...base.definitions,
        ...runners
          .filter((runner) => guardedToolEnabled(host, runner.name))
          .map((runner) => runner.definition()),
      ];
    },
    execute(call, signal) {
      const runner = runners.find((candidate) => candidate.name === call.name);
      return runner ? runner.execute(call, signal) : base.execute(call, signal);
    },
  };
}
