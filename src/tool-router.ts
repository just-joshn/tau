import {
  matchingToolRule,
  ToolInputRejected,
  ToolPermissionDenied,
  permissionDeniedMarkers,
  toolPolicySchema,
  type ToolPolicy,
} from "./tool-policy.js";
import { unparsedToolInput } from "./tool-input.js";
import type {
  ApiToolContent,
  PermissionMode,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
  ToolUse,
} from "./types.js";
import {
  appendPreHookContext,
  appendFailureHookContext,
  type PreToolHookResult,
  type ToolFailureHookResult,
  type ToolHookRuntime,
} from "./tool-hook-runtime.js";
import { parseMcpCallResult, projectMcpResult } from "./mcp-content.js";

/** External discovery stays independent of the built-in launch selection. */
export interface ExternalToolRegistry {
  readonly definitions: ToolDefinition[];
  lookup(name: string):
    | {
        serverName: string;
        isReadOnly: boolean;
        requiresUserInteraction: boolean;
      }
    | undefined;
  refreshTools?(): Promise<void>;
  /** The host's input validator; used again for a hook's complete replacement. */
  validateInput?(name: string, input: unknown): unknown;
  callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{
    raw: unknown;
    projection: { text: string; blocks?: ApiToolContent[]; isError?: boolean };
  }>;
}

export function routeExternalTools(
  builtins: ToolExecutor,
  external: ExternalToolRegistry,
  options: {
    mode: PermissionMode;
    policy?: ToolPolicy;
    hooks?: ToolHookRuntime;
    hookOutputDirectory?: string;
    approve(description: string): Promise<boolean>;
  },
): ToolExecutor {
  const policy = toolPolicySchema.parse(options.policy ?? {});
  const match = (
    behavior: "allow" | "deny" | "ask",
    name: string,
    input?: unknown,
  ) => {
    const serverName = external.lookup(name)?.serverName;
    return serverName === undefined
      ? undefined
      : matchingToolRule(policy, behavior, name, {
          serverName,
          ...(input !== undefined ? { input } : {}),
        });
  };
  const denied = (name: string, input?: unknown) =>
    match("deny", name, input) !== undefined;
  return {
    ...builtins,
    async beforeModelRequest(signal) {
      signal.throwIfAborted();
      await builtins.beforeModelRequest?.(signal);
      await external.refreshTools?.();
      signal.throwIfAborted();
    },
    get definitions() {
      return [
        ...builtins.definitions,
        ...external.definitions.filter((tool) => !denied(tool.name)),
      ];
    },
    async execute(call, signal) {
      const metadata = external.lookup(call.name);
      if (!metadata) return builtins.execute(call, signal);
      let effectiveCall: ToolUse = call;
      let pre: PreToolHookResult | undefined;
      let inCall = false;
      try {
        signal.throwIfAborted();
        if (denied(call.name))
          throw new ToolPermissionDenied(
            `Tool disabled or denied by policy: ${call.name}`,
          );
        const unparsed = unparsedToolInput(call.input);
        if (unparsed)
          throw new ToolInputRejected(
            `input JSON failed to parse — ${unparsed.len} bytes`,
          );
        const validate = async (input: unknown): Promise<unknown> => {
          if (
            input === null ||
            typeof input !== "object" ||
            Array.isArray(input)
          )
            throw new ToolInputRejected("MCP tool arguments must be an object");
          try {
            return external.validateInput
              ? await external.validateInput(call.name, input)
              : input;
          } catch (error) {
            if (
              error instanceof ToolPermissionDenied ||
              error instanceof ToolInputRejected
            )
              throw error;
            throw new ToolInputRejected(
              error instanceof Error
                ? error.message
                : "MCP input validation failed",
            );
          }
        };
        effectiveCall = { ...call, input: await validate(call.input) };
        if (options.hooks) {
          pre = await options.hooks.before(effectiveCall, signal, validate);
          signal.throwIfAborted();
          if (pre.preventContinuation)
            return appendPreHookContext(
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: pre.stopReason ?? "Tool call stopped by hook",
                is_error: true,
              },
              pre,
              effectiveCall,
              pre.stopReason ?? "Continuation stopped by hook",
            );
          if (pre.permission === "deny" || pre.permission === "defer")
            throw new ToolPermissionDenied(
              pre.reason ??
                (pre.permission === "defer"
                  ? "Hook requested deferred approval; this runner cannot resume deferred tool calls"
                  : "Tool denied by hook"),
            );
          if (pre.updatedInput !== undefined)
            effectiveCall = {
              ...call,
              input: await validate(pre.updatedInput),
            };
        }
        if (denied(call.name, effectiveCall.input))
          throw new ToolPermissionDenied(
            `Tool disabled or denied by policy: ${call.name}`,
          );
        // MCP annotations describe the server's tool; readOnlyHint is not preapproval.
        // Required interaction precedes mode bypass and exact whole-tool allows.
        const preapproved =
          !metadata.requiresUserInteraction &&
          pre?.permission !== "ask" &&
          match("ask", call.name, effectiveCall.input) === undefined &&
          (options.mode === "bypassPermissions" ||
            (pre?.permission === "allow" &&
              (options.mode !== "plan" || metadata.isReadOnly)) ||
            (match("allow", call.name, effectiveCall.input) !== undefined &&
              (options.mode !== "plan" || metadata.isReadOnly)));
        if (!preapproved) {
          let approved: boolean;
          try {
            approved = await options.approve(
              `MCP tool ${call.name}\n${JSON.stringify(effectiveCall.input)}`,
            );
          } catch (error) {
            throw new ToolPermissionDenied(
              error instanceof Error
                ? error.message
                : "Permission approval did not complete",
              "pre-ask",
            );
          }
          if (signal.aborted)
            throw new ToolPermissionDenied("Permission approval aborted");
          if (!approved)
            throw new ToolPermissionDenied("Permission denied", "pre-ask");
        }
        inCall = true;
        const result = await external.callTool(
          call.name,
          effectiveCall.input,
          signal,
        );
        signal.throwIfAborted();
        const mapped: ToolResult = {
          type: "tool_result",
          tool_use_id: call.id,
          content: result.projection.text,
          ...(pre?.updatedInput === undefined
            ? {}
            : { effectiveToolInput: effectiveCall.input }),
          ...(result.projection.blocks === undefined
            ? {}
            : { apiContent: result.projection.blocks }),
          ...(result.projection.isError === undefined
            ? {}
            : { is_error: result.projection.isError }),
          mcpResult: result.raw,
        };
        if (result.projection.isError) {
          inCall = false;
          const failure = await options.hooks?.failure?.(
            effectiveCall,
            result.projection.text,
            signal,
          );
          return appendFailureHookContext(
            appendPreHookContext(mapped, pre, effectiveCall),
            failure,
          );
        }
        inCall = false;
        const annotated = appendPreHookContext(mapped, pre, effectiveCall);
        return options.hooks
          ? await options.hooks.after(
              effectiveCall,
              annotated,
              signal,
              async (candidate) => {
                const parsed = parseMcpCallResult(candidate);
                const projection = await projectMcpResult(parsed, {
                  serverName: metadata.serverName,
                  ...(options.hookOutputDirectory === undefined
                    ? {}
                    : { outputDirectory: options.hookOutputDirectory }),
                });
                return appendPreHookContext(
                  {
                    ...mapped,
                    content: projection.text,
                    apiContent: projection.blocks,
                    ...(projection.isError === undefined
                      ? { is_error: undefined }
                      : { is_error: projection.isError }),
                  },
                  pre,
                  effectiveCall,
                );
              },
            )
          : annotated;
      } catch (error) {
        let failure: ToolFailureHookResult | void = undefined;
        if (inCall && options.hooks?.failure)
          try {
            failure = await options.hooks.failure(effectiveCall, error, signal);
          } catch {
            signal.throwIfAborted();
          }
        return appendFailureHookContext(
          appendPreHookContext(
            {
              type: "tool_result",
              tool_use_id: call.id,
              content:
                error instanceof Error ? error.message : "MCP tool failed",
              is_error: true,
              ...(pre?.updatedInput === undefined
                ? {}
                : { effectiveToolInput: effectiveCall.input }),
              ...permissionDeniedMarkers(error),
              ...(error instanceof ToolInputRejected
                ? { inputRejected: true }
                : {}),
            },
            pre,
            effectiveCall,
          ),
          failure,
        );
      }
    },
  };
}
