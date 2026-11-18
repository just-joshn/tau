import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  PlanApprovalRejected,
  PlanInputRejected,
  type PlanApproval,
  type PlanExecution,
  type PlanFileManager,
  type PlanRuntime,
  type PlanToolPermission,
  type PreparedPlanCall,
} from "./plan-runtime.js";
import {
  appendFailureHookContext,
  appendPreHookContext,
  type PreToolHookResult,
  type ToolFailureHookResult,
  type ToolHookRuntime,
} from "./tool-hook-runtime.js";
import { ToolInputRejected, ToolPermissionDenied } from "./tool-policy.js";
import { unparsedToolInput } from "./tool-input.js";
import type { ToolExecutor, ToolResult, ToolUse } from "./types.js";

const planNames = new Set(["EnterPlanMode", "ExitPlanMode"]);
export interface PlanPolicyDecision {
  behavior: "allow" | "deny" | "ask";
  reason?: string;
}
export interface PlanSessionOptions {
  runtime: PlanRuntime;
  hooks?: ToolHookRuntime;
  available?(name: string): boolean;
  /** Full host deny/ask/trust/safety policy; a hook allow never substitutes for it. */
  authorize(context: {
    call: ToolUse;
    permission: PlanToolPermission;
    hookPermission?: PreToolHookResult["permission"];
    signal: AbortSignal;
  }): PlanPolicyDecision | Promise<PlanPolicyDecision>;
  /** User/UI or explicit headless approval bridge for remaining protected asks. */
  approve(context: {
    call: ToolUse;
    permission: PlanToolPermission;
    policy: PlanPolicyDecision;
    signal: AbortSignal;
  }): Promise<PlanApproval>;
  onExecution?(
    execution: PlanExecution,
    signal: AbortSignal,
  ): void | Promise<void>;
  beforeModelRequest?(
    runtime: PlanRuntime,
    signal: AbortSignal,
  ): void | Promise<void>;
  onDiagnostic?(message: string): void;
}

/** Adapter preserves ordinary executor lifecycle and keeps model tool input untouched. */
export function wrapPlanRuntime(
  base: ToolExecutor | (() => ToolExecutor),
  options: PlanSessionOptions,
): ToolExecutor {
  let readContext: Parameters<NonNullable<ToolExecutor["setReadContext"]>>[0];
  const tools = () => {
    const current = typeof base === "function" ? base() : base;
    current.setReadContext?.(readContext);
    return current;
  };
  const permitted = (name: string) => options.available?.(name) !== false;
  return {
    get definitions() {
      return [
        ...tools().definitions.filter((tool) => !planNames.has(tool.name)),
        ...options.runtime.definitions.filter((tool) => permitted(tool.name)),
      ];
    },
    async beforeModelRequest(signal) {
      await tools().beforeModelRequest?.(signal);
      signal.throwIfAborted();
      await options.beforeModelRequest?.(options.runtime, signal);
      signal.throwIfAborted();
    },
    setReadContext(context) {
      readContext = context;
      if (typeof base !== "function") base.setReadContext?.(context);
    },
    ...(tools().prepareCompaction
      ? {
          prepareCompaction: async (
            input: Parameters<
              NonNullable<ToolExecutor["prepareCompaction"]>
            >[0],
          ) => {
            const prepare = tools().prepareCompaction;
            if (!prepare)
              throw new Error(
                "Underlying tools no longer support file restoration",
              );
            return prepare(input);
          },
        }
      : {}),
    async execute(original, signal) {
      if (!planNames.has(original.name))
        return tools().execute(original, signal);
      let call = original,
        prepared: PreparedPlanCall | undefined,
        pre: PreToolHookResult | undefined;
      let invalid = false,
        inCall = false;
      try {
        signal.throwIfAborted();
        if (!permitted(original.name))
          throw new ToolPermissionDenied(
            `Plan tool is disabled or denied: ${original.name}`,
          );
        const unparsed = unparsedToolInput(original.input);
        if (unparsed)
          throw new ToolInputRejected(
            `input JSON failed to parse — ${unparsed.len} bytes`,
          );
        invalid = true;
        const initial = await options.runtime.prepare(original, signal);
        prepared = initial;
        call = initial.call;
        invalid = false;
        const replace = (value: unknown) =>
          options.runtime.replacePreparedInput(initial, value, "hook");
        const validateReplacement = async (value: unknown) => {
          const replacement = replace(value);
          signal.throwIfAborted();
          return replacement.input;
        };
        pre = await options.hooks?.before(call, signal, validateReplacement);
        signal.throwIfAborted();
        if (pre?.preventContinuation)
          return appendPreHookContext(
            {
              type: "tool_result",
              tool_use_id: original.id,
              is_error: true,
              content: pre.stopReason ?? "Plan operation stopped by a hook",
            },
            pre,
            call,
            pre.stopReason ?? "Continuation stopped by hook",
          );
        if (pre?.permission === "deny" || pre?.permission === "defer")
          throw new ToolPermissionDenied(
            pre.reason ??
              (pre.permission === "defer"
                ? "Deferred plan approval is not supported"
                : "Plan operation denied by a hook"),
          );
        if (pre?.updatedInput !== undefined) {
          const replacement = replace(pre.updatedInput);
          signal.throwIfAborted();
          prepared = replacement;
        }
        call = prepared.call;
        const permission = options.runtime.checkPermissions(prepared);
        const policy = await options.authorize({
          call,
          permission,
          signal,
          ...(pre?.permission === undefined
            ? {}
            : { hookPermission: pre.permission }),
        });
        signal.throwIfAborted();
        if (policy.behavior === "deny")
          throw new ToolPermissionDenied(
            policy.reason ?? "Plan operation denied by policy",
          );
        const interactionSatisfied =
          permission.tool === "ExitPlanMode" &&
          pre?.permission === "allow" &&
          pre.updatedInput !== undefined;
        if (
          (permission.behavior === "ask" && !interactionSatisfied) ||
          policy.behavior === "ask" ||
          pre?.permission === "ask"
        ) {
          const approval = await options.approve({
            call,
            permission: { ...permission, behavior: "ask" },
            policy,
            signal,
          });
          signal.throwIfAborted();
          if (!approval.approved)
            throw new PlanApprovalRejected(
              approval.reason ?? "Plan approval was declined",
            );
          if (approval.updatedInput !== undefined) {
            invalid = true;
            prepared = options.runtime.replacePreparedInput(
              prepared,
              approval.updatedInput,
              "approval",
            );
            call = prepared.call;
            invalid = false;
          }
        }
        inCall = true;
        const execution = await options.runtime.call(prepared, signal);
        signal.throwIfAborted();
        inCall = false;
        await options.onExecution?.(execution, signal);
        signal.throwIfAborted();
        const result = appendPreHookContext(
          { ...execution.result, effectiveToolInput: call.input },
          pre,
          call,
        );
        if (!options.hooks) return result;
        // Native rewrite admission depends on additional host/source context;
        // without that output-schema seam, preserve the actual approved result.
        try {
          return await options.hooks.after(call, result, signal);
        } catch (error) {
          signal.throwIfAborted();
          options.onDiagnostic?.(
            `PostToolUse failed for ${call.name}: ${error instanceof Error ? error.message : "hook dispatch failed"}`,
          );
          return result;
        }
      } catch (error) {
        signal.throwIfAborted();
        let failure: ToolFailureHookResult | void = undefined;
        if (inCall)
          try {
            failure = await options.hooks?.failure?.(call, error, signal);
          } catch {
            signal.throwIfAborted();
          }
        const result: ToolResult = {
          type: "tool_result",
          tool_use_id: original.id,
          is_error: true,
          content:
            error instanceof Error ? error.message : "Plan operation failed",
          ...(invalid ||
          (!inCall &&
            (error instanceof PlanInputRejected ||
              error instanceof ToolInputRejected ||
              error instanceof z.ZodError))
            ? { inputRejected: true }
            : {}),
          ...(error instanceof PlanApprovalRejected ||
          error instanceof ToolPermissionDenied
            ? { permissionDenied: true }
            : {}),
          ...(prepared ? { effectiveToolInput: call.input } : {}),
        };
        return appendFailureHookContext(
          appendPreHookContext(result, pre, call),
          failure,
        );
      }
    },
  };
}

export interface PlanExtraPathRequest {
  operation: string;
  requestedPath: string;
  signal?: AbortSignal;
}
export interface PlanWriteEligibilityRequest extends PlanExtraPathRequest {
  canonicalPath: string;
}

async function projectedRealPath(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(await realpath(existing), ...missing.reverse());
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** Narrow out-of-workspace path capability; never grants tool/policy permission. */
export function createPlanFileAccess(options: {
  cwd: string;
  files: PlanFileManager;
  sessionId(): string;
  /** Optional additional source-aware directory/ownership policy. */
  vetDirectory?(
    canonical: string,
    declared: string,
  ): boolean | Promise<boolean>;
}) {
  if (!isAbsolute(options.cwd))
    throw new Error("Plan file access requires an explicit absolute cwd");
  const pinnedDirectories = new Map<string, string>();
  const extraPathAdmission = async ({
    operation,
    requestedPath,
    signal,
  }: PlanExtraPathRequest): Promise<string | undefined> => {
    signal?.throwIfAborted();
    if (!["Read", "Write", "Edit"].includes(operation)) return;
    const session = options.sessionId(),
      requested = resolve(options.cwd, requestedPath);
    if (!options.files.isSessionPlanPath(session, requested)) return;
    const declared = dirname(options.files.path(session));
    try {
      const [directory, canonical] = await Promise.all([
        projectedRealPath(declared),
        projectedRealPath(requested),
      ]);
      signal?.throwIfAborted();
      if (
        session !== options.sessionId() ||
        dirname(canonical) !== directory ||
        !options.files.isSessionPlanPath(
          session,
          join(declared, basename(canonical)),
        )
      )
        return;
      const vetted = await options.vetDirectory?.(directory, declared);
      signal?.throwIfAborted();
      if (vetted === false) return;
      const pinned = pinnedDirectories.get(declared);
      if (pinned !== undefined && pinned !== directory) return;
      if (operation !== "Read") {
        try {
          const info = await lstat(requested);
          if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
            return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
      }
      signal?.throwIfAborted();
      if (session !== options.sessionId()) return;
      pinnedDirectories.set(declared, directory);
      return canonical;
    } catch (error) {
      signal?.throwIfAborted();
      return undefined;
    }
  };
  return {
    extraPathAdmission,
    /** Call after policy deny/ask checks; eligibility may precede ordinary sensitive/default holds. */
    async planWriteEligibility(
      request: PlanWriteEligibilityRequest,
    ): Promise<boolean> {
      if (request.operation !== "Write" && request.operation !== "Edit")
        return false;
      return (
        (await extraPathAdmission(request)) === resolve(request.canonicalPath)
      );
    },
  };
}
