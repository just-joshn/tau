import type { HookRegistryLike } from "./composite-hooks.js";
import type { HookBatchResult, HookInput, HookResult, HookRunOptions } from "./hooks.js";
import { sanitizeHookAttachmentText } from "./hook-attachment-projection.js";
import type { SubagentPlan, SubagentStopDecision, SubagentStopEvent } from "./subagent-runtime.js";
import type { HookCommonInput } from "./tool-hook-runtime.js";

type Plan = Readonly<SubagentPlan>;
export interface SubagentLifecycleOptions {
  /** Start uses the owning-session registry; the new child's hooks register afterward. */
  registryForStart(): HookRegistryLike;
  registryForStop(plan: Plan): HookRegistryLike;
  /** Common transcript_path always identifies the owning session, including for a child. */
  context(plan?: Plan): HookCommonInput;
  childTranscriptPath(plan: Plan): string;
  runOptions(): Omit<HookRunOptions, "signal" | "validateUpdatedInput">;
  /** Source CLAUDE_CODE_STOP_HOOK_BLOCK_CAP defaults to 8; <=0 disables its cap. */
  stopBlockCap?: number;
  onDiagnostic?(message: string): void;
}
interface State { observedStop: boolean; finishedNormally: boolean; continuationCount: number; teardown?: Promise<void> }

export function renderSubagentHookAdditionalContext(event: "SubagentStart" | "SubagentStop", content: readonly string[]): string {
  return `<system-reminder>\n${sanitizeHookAttachmentText(`${event} hook additional context: ${content.join("\n")}`)}\n</system-reminder>`;
}

/** Event consumers around the existing registry; no hook admission, child execution or registry ownership. */
export function createSubagentLifecycle(options: SubagentLifecycleOptions) {
  const states = new Map<string, State>();
  const cap = options.stopBlockCap ?? 8;
  if (!Number.isFinite(cap)) throw new Error("Subagent Stop block cap must be finite");
  const stateFor = (plan: Plan): State => {
    let state = states.get(plan.agentId);
    if (!state) { state = { observedStop: false, finishedNormally: false, continuationCount: 0 }; states.set(plan.agentId, state); }
    return state;
  };
  const report = (result: HookResult): void => {
    if (result.systemMessage) options.onDiagnostic?.(result.systemMessage);
    if (result.status === "blocking" || result.status === "error") options.onDiagnostic?.(`${result.event}: ${result.reason ?? result.error ?? (result.stderr.trim() || "hook failed")}`);
  };
  const runOptions = (signal: AbortSignal): HookRunOptions => {
    const supplied = options.runOptions(), background = supplied.onBackgroundResult;
    return { ...supplied, signal, onBackgroundResult: async result => {
      // Detached results do not retroactively change this lifecycle decision.
      report(result); await background?.(result);
    } };
  };
  const startInput = (plan: Plan): HookInput => {
    const common = options.context();
    // GDo calls Nm without toolUseContext/mode: whitelist the corresponding base fields.
    return { session_id: common.session_id, transcript_path: common.transcript_path, cwd: common.cwd,
      ...(common.prompt_id === undefined ? {} : { prompt_id: common.prompt_id }),
      ...(common.scratchpad_dir === undefined ? {} : { scratchpad_dir: common.scratchpad_dir }),
      hook_event_name: "SubagentStart", agent_id: plan.agentId, agent_type: plan.definition.agentType };
  };
  const stopInput = (plan: Plan, event?: SubagentStopEvent): HookInput => {
    const common = options.context(plan);
    const last = event?.messages.findLast(message => message.role === "assistant");
    const lastText = last?.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
    // The fallback B0e call supplies no mode. Effort still comes from child context.
    return { session_id: common.session_id, transcript_path: common.transcript_path, cwd: common.cwd,
      ...(common.prompt_id === undefined ? {} : { prompt_id: common.prompt_id }),
      ...(common.scratchpad_dir === undefined ? {} : { scratchpad_dir: common.scratchpad_dir }),
      ...(common.effort === undefined ? {} : { effort: { ...common.effort } }),
      ...(event && common.permission_mode !== undefined ? { permission_mode: common.permission_mode } : {}),
      hook_event_name: "SubagentStop", agent_id: plan.agentId, agent_type: plan.definition.agentType,
      agent_transcript_path: options.childTranscriptPath(plan), stop_hook_active: event?.stopHookActive ?? false,
      ...(lastText ? { last_assistant_message: lastText } : {}),
      // Host can provide real projections; an ordinary foreground host has neither feature.
      background_tasks: structuredClone(common.background_tasks ?? []), session_crons: structuredClone(common.session_crons ?? []) };
  };
  const blockingText = (registry: HookRegistryLike, result: HookResult): string => {
    const reason = result.reason ?? result.error ?? (result.stderr || "Blocked by hook");
    if (result.exitCode !== 2) return sanitizeHookAttachmentText(reason);
    const hook = registry.list(result.event).find(entry => entry.id === result.id)?.hook;
    const command = [result.command, ...hook?.args ?? []].join(" ");
    return sanitizeHookAttachmentText(`[${command}]: ${result.stderr || "No stderr output"}`);
  };
  const feedback = (registry: HookRegistryLike, batch: HookBatchResult): string[] => {
    const blocks = batch.results.filter(result => result.status === "blocking");
    const result = blocks.map(block => `Stop hook feedback:\n${blockingText(registry, block)}`);
    if (!blocks.length) result.push(...batch.blockingErrors.map(block => `Stop hook feedback:\n${sanitizeHookAttachmentText(block)}`));
    if (batch.additionalContext.length) result.push(renderSubagentHookAdditionalContext("SubagentStop", batch.additionalContext));
    return result;
  };
  return {
    async start(plan: Plan, signal: AbortSignal): Promise<readonly string[]> {
      signal.throwIfAborted(); stateFor(plan);
      const batch = await options.registryForStart().run(startInput(plan), runOptions(signal));
      signal.throwIfAborted();
      for (const result of batch.results) report(result);
      if (batch.cancelled) options.onDiagnostic?.("SubagentStart hooks cancelled; retaining completed sibling context");
      // Q6t Start errors remain transcript/UI attachments; their model projection is empty.
      // Neither plain stdout, systemMessage, block nor continue:false is child instruction text.
      return batch.additionalContext.length ? [renderSubagentHookAdditionalContext("SubagentStart", batch.additionalContext)] : [];
    },
    async stop(plan: Plan, event: SubagentStopEvent): Promise<SubagentStopDecision> {
      event.signal.throwIfAborted();
      const state = stateFor(plan), registry = options.registryForStop(plan);
      if (!event.stopHookActive) state.continuationCount = 0;
      const batch = await registry.run(stopInput(plan, event), runOptions(event.signal));
      if (batch.results.length || batch.background.length) state.observedStop = true;
      event.signal.throwIfAborted();
      for (const result of batch.results) report(result);
      if (batch.cancelled) options.onDiagnostic?.("SubagentStop hooks cancelled; retaining completed sibling feedback");
      if (batch.preventContinuation) return { continue: false, additionalContext: [], preventContinuation: true,
        reason: batch.stopReason || "Stop hook prevented continuation" };
      const additionalContext = feedback(registry, batch);
      if (!additionalContext.length) return { continue: false, additionalContext: [] };
      state.continuationCount++;
      if (cap > 0 && state.continuationCount > cap) {
        options.onDiagnostic?.(`Subagent Stop hooks requested ${state.continuationCount} consecutive continuations; ending the query at CLAUDE_CODE_STOP_HOOK_BLOCK_CAP.`);
        return { continue: false, additionalContext: [] };
      }
      return { continue: true, additionalContext };
    },
    /** Native ordinary tool turns reset this count, while stop_hook_active remains true. */
    resetContinuationCount(plan: Plan): void { stateFor(plan).continuationCount = 0; },
    /** UD sets io=true after an ordinary query-loop exit, including max_turns, before its abort check. */
    finishQuery(plan: Plan): void { stateFor(plan).finishedNormally = true; },
    async teardown(plan: Plan): Promise<void> {
      const state = stateFor(plan);
      if (state.observedStop || state.finishedNormally) return;
      if (state.teardown) return state.teardown;
      state.teardown = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("SubagentStop cleanup timed out", "TimeoutError")), 5_000);
        try {
          const batch = await options.registryForStop(plan).run(stopInput(plan), { ...runOptions(controller.signal), defaultTimeoutMs: 5_000 });
          if (batch.results.length || batch.background.length) state.observedStop = true;
          // Teardown drains results only: no feedback delivery or continuation.
        } catch (error) { options.onDiagnostic?.(`[runAgent] SubagentStop on interrupted query failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally { clearTimeout(timer); }
      })();
      return state.teardown;
    },
    /** Caller clears/closes its owned scoped registry after teardown, never the shared session registry. */
    cleanup(plan: Plan): void { states.delete(plan.agentId); },
  };
}
