import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  PlanInputRejected,
  PlanRuntime,
  type PlanActor,
  type PlanApproval,
  type PlanExecution,
  type PlanFileManager,
  type PlanPermissionMode,
  type PlanPermissionState,
  type PlanSaveResult,
  type PlanToolPermission,
  type PlanTransition,
} from "./plan-runtime.js";
import {
  createPlanFileAccess,
  wrapPlanRuntime,
  type PlanPolicyDecision,
  type PlanExtraPathRequest,
  type PlanWriteEligibilityRequest,
} from "./plan-session.js";
import { matchingToolRule, type ToolPolicy } from "./tool-policy.js";
import type {
  ToolHookRuntime,
  PreToolHookResult,
} from "./tool-hook-runtime.js";
import type { ToolExecutor, ToolUse } from "./types.js";

export interface ChildPlanFileContext {
  sessionId: string;
  agentId: string;
  canonicalPath: string;
}
export interface ChildPlanAuthorizationContext {
  sessionId: string;
  agentId: string;
  isAsync: boolean;
  call: ToolUse;
  permission: PlanToolPermission;
  hookPermission?: PreToolHookResult["permission"];
  signal: AbortSignal;
}
export interface ChildPlanHostOptions {
  cwd: string;
  sessionId(): string;
  actor: PlanActor & { agentId: string };
  isAsync: boolean;
  /** This adapter intentionally refuses Doc/diskless sessions. */
  fileBacked: boolean;
  files: PlanFileManager;
  permissions(): PlanPermissionState;
  /** Actual shared session setter; ordinary async child source does not invoke it. */
  setSessionPermissions(
    update: (state: PlanPermissionState) => PlanPermissionState,
  ): void;
  storage: {
    read(
      path: string,
      signal: AbortSignal,
      context: ChildPlanFileContext,
    ): Promise<string | null>;
    save(
      path: string,
      text: string,
      signal: AbortSignal,
      context: ChildPlanFileContext,
    ): Promise<PlanSaveResult>;
  };
  /** Host attests the selected tool pool/feature source. Transient mode visibility is handled separately. */
  enabled(name: "EnterPlanMode" | "ExitPlanMode"): boolean;
  policy(): ToolPolicy;
  canRequestApproval(): boolean;
  /** Mandatory full policy/trust/safety/interaction arbitration; receives actual child identity. */
  authorize(
    context: ChildPlanAuthorizationContext,
  ): PlanPolicyDecision | Promise<PlanPolicyDecision>;
  /** Actual UI or configured bridge. Async prompt avoidance belongs in these explicit host decisions. */
  approve(
    context: ChildPlanAuthorizationContext & { policy: PlanPolicyDecision },
  ): Promise<PlanApproval>;
  hooks: ToolHookRuntime;
  /** Explicit admitted directory policy, including default plans roots outside cwd. */
  vetDirectory(canonical: string, declared: string): boolean | Promise<boolean>;
  canRestoreMode?(
    mode: PlanPermissionMode,
    state: PlanPermissionState,
  ): boolean | { allowed: boolean; reason?: string };
  prepareTransition?(
    state: PlanPermissionState,
    transition: PlanTransition,
  ): PlanPermissionState;
  onExecution?(
    execution: PlanExecution,
    context: { agentId: string; sessionId: string; isAsync: boolean },
    signal: AbortSignal,
  ): void | Promise<void>;
  onDiagnostic?(message: string): void;
}
const enterInput = z.strictObject({});
const planNames = new Set(["EnterPlanMode", "ExitPlanMode"]);

/** Ordinary file-backed nonteammate child plan host. No model input can designate another file. */
export function createChildPlanHost(options: ChildPlanHostOptions) {
  if (!isAbsolute(options.cwd))
    throw new Error("Child plan workspace must be absolute");
  const actor = structuredClone(options.actor),
    sessionId = options.sessionId();
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.agentId))
    throw new Error(
      "Child plan host needs a session and admitted agent identity",
    );
  if (
    !options.fileBacked ||
    actor.builtInFork ||
    actor.teammate !== undefined ||
    options.permissions().planDoc != null
  )
    throw new Error(
      "Child plan adapter supports only ordinary file-backed nonteammate agents; fork and Doc plans need separate adapters",
    );
  const identity = () => {
    if (options.sessionId() !== sessionId)
      throw new PlanInputRejected(
        "The child plan belongs to a different active session",
      );
    if (options.permissions().planDoc != null)
      throw new PlanInputRejected(
        "Doc plans require a separate child approval adapter",
      );
  };
  const permissions = () => {
    identity();
    return options.permissions();
  };
  const admittedFiles = createPlanFileAccess({
    cwd: options.cwd,
    files: options.files,
    sessionId: () => sessionId,
    vetDirectory: options.vetDirectory,
  });
  const fileAccess = {
    async extraPathAdmission(request: PlanExtraPathRequest) {
      identity();
      const admitted = await admittedFiles.extraPathAdmission(request);
      identity();
      return admitted;
    },
    async planWriteEligibility(request: PlanWriteEligibilityRequest) {
      identity();
      const admitted = await admittedFiles.planWriteEligibility(request);
      identity();
      return admitted;
    },
  };
  const admitFile = async (
    path: string,
    operation: "Read" | "Write",
    signal: AbortSignal,
  ): Promise<ChildPlanFileContext> => {
    identity();
    signal.throwIfAborted();
    if (resolve(path) !== resolve(options.files.path(sessionId, actor.agentId)))
      throw new PlanInputRejected(
        "Child plan storage requested a different actor's target",
      );
    const canonicalPath = await fileAccess.extraPathAdmission({
      operation,
      requestedPath: path,
      signal,
    });
    identity();
    signal.throwIfAborted();
    if (!canonicalPath)
      throw new PlanInputRejected(
        "The designated child plan file failed directory or link admission",
      );
    return { sessionId, agentId: actor.agentId, canonicalPath };
  };
  const available = (name: string): boolean => {
    if (
      !planNames.has(name) ||
      options.sessionId() !== sessionId ||
      options.permissions().planDoc != null
    )
      return false;
    const policy = options.policy();
    return (
      options.enabled(name as "EnterPlanMode" | "ExitPlanMode") &&
      (policy.tools === undefined ||
        policy.tools.some((tool) => tool === name)) &&
      !matchingToolRule(policy, "deny", name)
    );
  };
  const currentDenial = (call: ToolUse): string | undefined => {
    identity();
    if (!available(call.name))
      return "Child plan tool is excluded or denied by current parent policy";
    if (
      matchingToolRule(options.policy(), "deny", call.name, {
        input: call.input,
      })
    )
      return "Current parent policy denies the child plan operation";
    return undefined;
  };
  const runtime = new PlanRuntime({
    sessionId: () => {
      identity();
      return sessionId;
    },
    actor: () => actor,
    permissions,
    files: options.files,
    fileBacked: true,
    setPermissions(update) {
      identity();
      if (options.isAsync || options.permissions().mode !== "plan") return;
      options.setSessionPermissions((state) => {
        identity();
        return update(state);
      });
    },
    storage: {
      async read(path, signal) {
        const context = await admitFile(path, "Read", signal),
          text = await options.storage.read(path, signal, context);
        identity();
        signal.throwIfAborted();
        if (text !== null && typeof text !== "string")
          throw new Error("Child plan storage returned invalid text");
        return text;
      },
      async save(path, text, signal) {
        const context = await admitFile(path, "Write", signal),
          result = await options.storage.save(path, text, signal, context);
        identity();
        signal.throwIfAborted();
        if (
          result.savedPath !== undefined &&
          (!isAbsolute(result.savedPath) ||
            ![resolve(path), resolve(context.canonicalPath)].includes(
              resolve(result.savedPath),
            ))
        )
          return {
            notice:
              result.notice ??
              "Approved child plan text was retained in the conversation; storage returned an unsupported alternate target",
          };
        return {
          ...result,
          ...(result.savedPath === undefined ? {} : { savedPath: path }),
        };
      },
    },
    canRequestApproval: options.canRequestApproval,
    approve: async () => {
      throw new Error(
        "Child plan approval must use the full host permission pipeline",
      );
    },
    ...(options.canRestoreMode
      ? { canRestoreMode: options.canRestoreMode }
      : {}),
    ...(options.prepareTransition
      ? { prepareTransition: options.prepareTransition }
      : {}),
  });
  function wrap(base: ToolExecutor | (() => ToolExecutor)): ToolExecutor {
    const wrapped = wrapPlanRuntime(base, {
      runtime,
      hooks: options.hooks,
      available,
      authorize: async (context) => {
        const denial = currentDenial(context.call);
        if (denial) return { behavior: "deny", reason: denial };
        const result = await options.authorize({
          ...context,
          sessionId,
          agentId: actor.agentId,
          isAsync: options.isAsync,
        });
        context.signal.throwIfAborted();
        const changed = currentDenial(context.call);
        if (changed) return { behavior: "deny", reason: changed };
        if (!["allow", "ask", "deny"].includes(result.behavior))
          throw new Error("Invalid child plan authorization decision");
        if (result.behavior === "deny") return result;
        if (
          matchingToolRule(options.policy(), "ask", context.call.name, {
            input: context.call.input,
          })
        )
          return { behavior: "ask", reason: "Explicit parent plan ask" };
        return result;
      },
      approve: async (context) => {
        identity();
        if (!options.canRequestApproval())
          return {
            approved: false,
            reason:
              "No child plan approval UI or configured bridge is available",
          };
        const approval = await options.approve({
          ...context,
          sessionId,
          agentId: actor.agentId,
          isAsync: options.isAsync,
        });
        context.signal.throwIfAborted();
        identity();
        if (typeof approval.approved !== "boolean")
          throw new Error("Invalid child plan approval decision");
        const candidate = {
            ...context.call,
            input: approval.updatedInput ?? context.call.input,
          },
          denial = currentDenial(candidate);
        if (denial) return { approved: false, reason: denial };
        return approval;
      },
      ...(options.onExecution
        ? {
            onExecution: (execution, signal) =>
              options.onExecution!(
                execution,
                { sessionId, agentId: actor.agentId, isAsync: options.isAsync },
                signal,
              ),
          }
        : {}),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
    return {
      ...wrapped,
      get definitions() {
        return wrapped.definitions
          .filter((tool) => tool.name !== "EnterPlanMode" || !options.isAsync)
          .filter(
            (tool) =>
              tool.name !== "ExitPlanMode" || permissions().mode === "plan",
          );
      },
      async execute(call, signal) {
        if (call.name === "EnterPlanMode") {
          signal.throwIfAborted();
          if (!available(call.name))
            return {
              type: "tool_result",
              tool_use_id: call.id,
              content: "Child plan entry tool is excluded or denied",
              is_error: true,
              permissionDenied: true,
            };
          const parsed = enterInput.safeParse(call.input);
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: parsed.success
              ? "Only the main session can enter plan mode."
              : parsed.error.message,
            is_error: true,
            inputRejected: true,
          };
        }
        return wrapped.execute(call, signal);
      },
    };
  }
  return {
    runtime,
    fileAccess,
    wrap,
    sessionId,
    agentId: actor.agentId,
    location: (seed?: string) => runtime.planLocation(seed),
    limitations: [
      "Ordinary file-backed child only; team, Doc and built-in fork metadata require separate adapters",
      "Approval UI/bridge, live parent policy, storage safety and shared permission transformations are explicit host capabilities",
      "Async ordinary permission setter is a no-op; this host does not synthesize approval or a private child mode transition",
    ],
  };
}
