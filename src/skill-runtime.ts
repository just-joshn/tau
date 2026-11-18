import { z } from "zod";
import type { LocalSkill, LocalSkillRegistry, SkillEffort, SkillInvocation, SkillInvocationOptions, SkillSource } from "./skills.js";
import { appendHookContext, appendPreHookContext, type ToolHookRuntime } from "./tool-hook-runtime.js";
import { hookAttachmentSchema, type Message, ToolDefinition, ToolExecutor, ToolResult, ToolUse } from "./types.js";

export const skillToolInputSchema = z.object({ skill: z.string(), args: z.string().optional() });
export type SkillToolInput = z.infer<typeof skillToolInputSchema>;
/** Hook metadata that skill execution attaches to the errors it throws. */
const skillFailureSchema = z.object({ permissionDenied: z.boolean().optional(), hookStop: z.string().optional(), hookContext: z.array(z.string()).optional(), hookAttachments: z.array(hookAttachmentSchema).optional() });

/** Ordinary local command construction has only these non-whitelisted effects. */
export function isPureLocalSkill(skill: Pick<LocalSkill, "allowedTools" | "disallowedTools" | "hooks">): boolean {
  const hooks = skill.hooks;
  const hooksEmpty = hooks === undefined || hooks === null || (Array.isArray(hooks) ? hooks.length === 0 :
    typeof hooks === "object" && Object.keys(hooks).length === 0);
  return skill.allowedTools.length === 0 && skill.disallowedTools.length === 0 && hooksEmpty;
}
export interface LocalSkillGrantPolicy {
  allowManagedPermissionRulesOnly?: boolean;
  /** Source pre(): noninteractive AND flag/env asks to ignore persisted trust. */
  ignorePersistedTrust?: boolean;
  interactive?: boolean;
  restrictPersonalConfig?: boolean;
}
export type LocalSkillGrantRefusal = "managed_rules_only" | "untrusted_folder" | "personal_config";
/** Source ber/I gate only. This is not Skill authorization or hook admission. */
export function localSkillGrantRefusal(source: SkillSource, policy: LocalSkillGrantPolicy): LocalSkillGrantRefusal | undefined {
  if (policy.allowManagedPermissionRulesOnly && source !== "policySettings") return "managed_rules_only";
  if (source === "projectSettings" && policy.ignorePersistedTrust && policy.interactive !== true) return "untrusted_folder";
  if ((source === "userSettings" || source === "plugin") && policy.restrictPersonalConfig) return "personal_config";
  return undefined;
}

export interface ParsedSkillPermissionRule { content?: string }
/** Exact Skill spelling; empty/(*) content is a whole-tool rule in source xr. */
export function parseSkillPermissionRule(rule: string): ParsedSkillPermissionRule | undefined {
  if (rule === "Skill") return {};
  if (!rule.startsWith("Skill(") || !rule.endsWith(")")) return undefined;
  let escapes = 0;
  for (let index = rule.length - 2; index >= 0 && rule[index] === "\\"; index--) escapes++;
  if (escapes % 2) return undefined;
  const body = rule.slice(6, -1);
  if (body === "" || body === "*") return {};
  return { content: body.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\") };
}
function primitiveSkillPattern(pattern: string, value: string): boolean {
  const pieces = pattern.split("*");
  if (pieces.length === 1) return pattern === value;
  const [start = "", ...middle] = pieces, end = middle.pop() ?? "", boundary = value.length - end.length;
  if (boundary < start.length || !value.startsWith(start) || !value.endsWith(end)) return false;
  let cursor = start.length;
  for (const piece of middle.filter(Boolean)) {
    const index = value.indexOf(piece, cursor);
    if (index < 0 || index + piece.length > boundary) return false;
    cursor = index + piece.length;
  }
  return true;
}
/**
 * Ordinary local names only: no synced-name namespace, packaging or alias rules.
 * Legacy suffix :* / space-* means raw name prefix, never skill arguments.
 * Ask content uses the generic primitive form skill:pattern, unlike allow/deny.
 */
export function matchesLocalSkillPermissionRule(rule: string, name: string, behavior: "allow" | "deny" | "ask"): boolean {
  const parsed = parseSkillPermissionRule(rule);
  if (!parsed) return false;
  if (parsed.content === undefined) return true;
  const content = parsed.content;
  const primitive = /^\s*skill\s*:(.*)$/s.exec(content)?.[1];
  if (behavior !== "allow" && primitive !== undefined && primitiveSkillPattern(primitive.trim(), name)) return true;
  if (behavior === "ask") return false;
  const legacy = content.replace(/^\//, "");
  return legacy === name || ((legacy.endsWith(":*") || legacy.endsWith(" *")) && name.startsWith(legacy.slice(0, -2)));
}
export type SkillContextLayer =
  | { kind: "allowed_tools"; allowedTools: readonly string[] }
  | { kind: "model"; mainLoopModel: string }
  | { kind: "effort"; effort: SkillEffort };
export interface SkillQueryContext {
  /** Query-frame overlays. They are never persisted as session settings. */
  layers: readonly SkillContextLayer[];
  /** Inline command denies union during this query, then reset at the next user query. */
  commandDisallowedTools: readonly string[];
  activeSkill?: string;
}
export interface SkillEffectRequest {
  invocation: "model" | "user";
  sessionId: string;
  skill: Readonly<LocalSkill>;
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  declaredModel?: string;
  declaredEffort?: SkillEffort;
  /** Session hook registration is separate from temporary query overlays. */
  sessionHooks?: { sessionId: string; skillName: string; source: string; path: string; skillRoot: string; hooks: unknown };
}
export interface SkillEffectAdmission {
  /** Explicit result of the caller's skill grant/trust/managed-policy arbitration. */
  allowedTools: readonly string[];
  /** Already resolved through model availability/permission/long-context policy. */
  model?: string;
  effort?: SkillEffort;
  hooksRegistered?: boolean;
  warnings?: readonly string[];
}
export interface SkillExecution {
  result: ToolResult;
  newMessages: Message[];
  invocation: SkillInvocation;
  effects: SkillEffectRequest;
  admitted: SkillEffectAdmission;
}
export interface SkillAuthorization {
  skill: Readonly<LocalSkill>; input: SkillToolInput; invocation: "model" | "user";
  signal: AbortSignal; hookPermission?: "allow" | "deny" | "ask" | "defer";
}
export interface SkillRuntimeOptions {
  registry: LocalSkillRegistry;
  sessionId(): string;
  /** Required: this callback retains existing deny/ask/safety and skill policy. */
  authorize(context: SkillAuthorization): boolean | string | Promise<boolean | string>;
  /** Required: do not turn unfiltered metadata into unconditional tool grants. */
  applyEffects(effects: SkillEffectRequest, context: SkillQueryContext): SkillEffectAdmission | Promise<SkillEffectAdmission>;
  effortLevel?(): string | undefined;
  processShellBlocks?: SkillInvocationOptions["processShellBlocks"];
  argumentTokens?: (args: string, skill: Readonly<LocalSkill>) => readonly string[];
  /** Actual current-turn user consent, never a model-supplied input property. */
  userAuthorizedThisTurn?(skill: Readonly<LocalSkill>): boolean;
  hooks?: ToolHookRuntime;
  enabled?(): boolean;
  onDiagnostic?(message: string): void;
}

const inlineOutputSchema = z.object({ success: z.boolean(), commandName: z.string(), allowedTools: z.array(z.string()).optional(), model: z.string().optional(), status: z.literal("inline").optional() });
const pathException = /^(?:Read|Edit)\((?:\.\/)?!/;
const normalizedName = (value: string): string => value.trim().replace(/^\//, "");
const summary = (name: string) => `Skill instructions loaded: ${name}`;
function cloneContext(context: SkillQueryContext): SkillQueryContext {
  return { layers: context.layers.map(layer => layer.kind === "allowed_tools" ? { ...layer, allowedTools: [...layer.allowedTools] } : { ...layer }),
    commandDisallowedTools: [...context.commandDisallowedTools], ...(context.activeSkill === undefined ? {} : { activeSkill: context.activeSkill }) };
}

/** Ordinary inline Skill dispatch, with explicit host policy and effect seams. */
export class SkillRuntime {
  private context: SkillQueryContext = { layers: [], commandDisallowedTools: [] };
  private readonly pending: Message[] = [];
  constructor(private readonly options: SkillRuntimeOptions) {}

  get queryContext(): SkillQueryContext { return cloneContext(this.context); }
  /** Foreground children share the parent's current command bucket; ordinary resetQuery clears it. */
  appendCommandDenies(rules: readonly string[]): void { this.context.commandDisallowedTools = [...new Set([...this.context.commandDisallowedTools, ...rules])]; }
  get definitions(): ToolDefinition[] {
    if (this.options.enabled?.() === false) return [];
    return [{ name: "Skill", description: "Load a skill's instructions for the current task. Select an exact invocation name from the available skills listed in the conversation and supply optional arguments.",
      input_schema: { type: "object", properties: { skill: { type: "string" }, args: { type: "string" } }, required: ["skill"] } }];
  }
  catalog(invocation: "model" | "user" = "user") { return this.options.registry.catalog({ invocation }); }
  activateForPaths(paths: readonly string[], root?: string): readonly string[] {
    return this.options.registry.activateForPaths(paths, root);
  }
  /** Call after committed tool results, including when a hook stops the query. */
  flushContext(messages: Message[]): void { messages.push(...this.pending.splice(0)); }
  /** Caller starts a fresh frame at each ordinary user query/clear/resume. */
  resetQuery(messages?: Message[]): void {
    if (messages) this.flushContext(messages);
    if (this.pending.length) throw new Error("Commit pending skill context before resetting its query frame");
    this.context = { layers: [], commandDisallowedTools: [] };
  }
  private validate(input: unknown, invocation: "model" | "user"): { input: SkillToolInput; skill: Readonly<LocalSkill> } {
    const parsed = skillToolInputSchema.parse(input), name = normalizedName(parsed.skill);
    if (!name) throw new Error("Skill invocation requires a nonempty name");
    const skill = this.options.registry.catalog().find(value => value.name === name);
    if (!skill) throw new Error(`Unknown or inactive skill: ${name}`);
    if (invocation === "model" && skill.disableModelInvocation && !this.options.userAuthorizedThisTurn?.(skill)) throw new Error(`Skill ${name} requires explicit user invocation`);
    // LBr selects fork only from context; agent/background alone are declarations
    // for a fork, not permission to manufacture a child or silently downgrade one.
    if (skill.context === "fork") throw new Error(`Skill ${name} requires forked execution; this inline runtime cannot execute its agent or background mode`);
    return { input: parsed, skill };
  }
  async invokeUser(name: string, args: string | undefined, signal: AbortSignal): Promise<SkillExecution> {
    return this.invoke({ type: "tool_use", name: "Skill", id: "user-skill", input: { skill: name, ...(args === undefined ? {} : { args }) } }, signal, "user");
  }
  async execute(call: ToolUse, signal: AbortSignal): Promise<SkillExecution> {
    if (call.name !== "Skill") throw new Error("Skill runtime received another tool");
    if (this.options.enabled?.() === false) throw new Error("Skill tool is disabled");
    return this.invoke(call, signal, "model");
  }
  private async invoke(originalCall: ToolUse, signal: AbortSignal, invocationKind: "model" | "user"): Promise<SkillExecution> {
    signal.throwIfAborted();
    let selected = this.validate(originalCall.input, invocationKind), call = { ...originalCall, input: selected.input };
    const pre = invocationKind === "model" ? await this.options.hooks?.before(call, signal, async value => this.validate(value, invocationKind).input) : undefined;
    signal.throwIfAborted();
    if (pre?.preventContinuation || pre?.permission === "deny" || pre?.permission === "defer") {
      const message = pre.reason ?? pre.stopReason ?? (pre.permission === "defer" ? "Skill execution deferred by a hook; deferred approval is not supported" : "Skill execution blocked by a hook");
      throw Object.assign(new Error(message), { permissionDenied: true,
        ...(pre.additionalContext.length ? { hookAttachments: [{ phase: "pre", event: "PreToolUse", toolName: call.name, content: [...pre.additionalContext] }] } : {}),
        ...(pre.preventContinuation ? { hookStop: pre.stopReason ?? message } : {}) });
    }
    if (pre?.updatedInput !== undefined) { selected = this.validate(pre.updatedInput, invocationKind); call = { ...call, input: selected.input }; }
    const authorized = await this.options.authorize({ ...selected, invocation: invocationKind, signal,
      ...(pre?.permission === undefined ? {} : { hookPermission: pre.permission }) });
    signal.throwIfAborted();
    if (authorized !== true) {
      throw Object.assign(new Error(typeof authorized === "string" ? authorized : "Skill execution blocked by permission rules"), { permissionDenied: true,
        ...(pre?.additionalContext.length ? { hookAttachments: [{ phase: "pre", event: "PreToolUse", toolName: call.name, content: [...pre.additionalContext] }] } : {}) });
    }
    const userConfirmed = invocationKind === "user" || this.options.userAuthorizedThisTurn?.(selected.skill) === true;
    const args = selected.input.args;
    const effortLevel = this.options.effortLevel?.();
    let invocation: SkillInvocation;
    try { invocation = await this.options.registry.invoke(selected.skill.name, args, { invocation: userConfirmed ? "user" : "model", sessionId: this.options.sessionId(), signal,
      ...(effortLevel === undefined ? {} : { effortLevel }),
      ...(args === undefined || this.options.argumentTokens === undefined ? {} : { argumentTokens: this.options.argumentTokens(args, selected.skill) }),
      ...(this.options.processShellBlocks === undefined ? {} : { processShellBlocks: this.options.processShellBlocks }) });
    } catch (error) {
      if (invocationKind === "model" && !signal.aborted) {
        const feedback = await this.options.hooks?.failure?.(call, error, signal);
        if (feedback?.additionalContext.length || feedback?.attachments?.length || pre?.additionalContext.length) {
          const retained = error instanceof Error ? error : new Error(String(error));
          Object.assign(retained, { hookContext: feedback?.additionalContext ?? [], hookAttachments: [
            ...pre?.additionalContext.length ? [{ phase: "pre" as const, event: "PreToolUse" as const, toolName: call.name, content: [...pre.additionalContext] }] : [],
            ...feedback?.attachments ?? [],
          ] });
          throw retained;
        }
      }
      throw error;
    }
    signal.throwIfAborted();
    const effect: SkillEffectRequest = { invocation: invocationKind, sessionId: this.options.sessionId(), skill: invocation.skill,
      allowedTools: [...invocation.allowedTools], disallowedTools: invocationKind === "model" ? invocation.disallowedTools.filter(rule => !pathException.test(rule)) : [...invocation.disallowedTools],
      ...(invocation.model === undefined || invocation.model === "inherit" ? {} : { declaredModel: invocation.model }),
      ...(invocation.effort === undefined ? {} : { declaredEffort: invocation.effort }),
      ...(invocation.hooks === undefined ? {} : { sessionHooks: { sessionId: this.options.sessionId(), skillName: invocation.skill.name,
        source: invocation.skill.source, path: invocation.skill.path, skillRoot: invocation.skill.pluginRoot ?? invocation.skill.baseDir, hooks: invocation.hooks } }) };
    const admitted = await this.options.applyEffects(effect, this.queryContext);
    signal.throwIfAborted();
    if (!Array.isArray(admitted.allowedTools) || !admitted.allowedTools.every(value => typeof value === "string")) throw new Error("Skill effect admission must return an explicit allowedTools list");
    const hooksWithheld = effect.sessionHooks !== undefined && admitted.hooksRegistered !== true;
    const allowed = hooksWithheld ? [] : [...admitted.allowedTools];
    const layers: SkillContextLayer[] = [];
    if (allowed.length) layers.push({ kind: "allowed_tools", allowedTools: allowed });
    if (admitted.model !== undefined && admitted.model !== "inherit") {
      if (!admitted.model.trim()) throw new Error("Skill effect admission returned an empty model");
      layers.push({ kind: "model", mainLoopModel: admitted.model });
    }
    if (admitted.effort !== undefined) layers.push({ kind: "effort", effort: admitted.effort });
    this.context = { layers: [...this.context.layers, ...layers], commandDisallowedTools: [...new Set([...this.context.commandDisallowedTools, ...effect.disallowedTools])], activeSkill: invocation.skill.name };
    const warnings = [...admitted.warnings ?? [], ...hooksWithheld ? ["Skill hooks were withheld; automatic tool grants were withheld with them."] : []];
    for (const warning of warnings) this.options.onDiagnostic?.(warning);
    const newMessages: Message[] = [{ role: "user", content: [{ type: "text", text: invocation.text }, ...warnings.map(text => ({ type: "text" as const, text }))] }];
    const data = { success: true, commandName: invocation.skill.name, ...(allowed.length ? { allowedTools: allowed } : {}),
      ...(admitted.model === undefined || admitted.model === "inherit" ? {} : { model: admitted.model }) };
    let result: ToolResult = appendPreHookContext({ type: "tool_result", tool_use_id: originalCall.id, content: summary(data.commandName), effectiveToolInput: selected.input, hookResponse: data }, pre, call);
    if (invocationKind === "model" && this.options.hooks) result = await this.options.hooks.after(call, result, signal, candidate => {
      const parsed = inlineOutputSchema.parse(candidate);
      return { ...result, content: summary(parsed.commandName), hookResponse: parsed };
    });
    return { result, newMessages, invocation, effects: effect, admitted: { ...admitted, allowedTools: allowed } };
  }
  /** A factory lets later calls use the newly admitted frame without mutating captured policies. */
  wrap(base: ToolExecutor | (() => ToolExecutor), messages: Message[]): ToolExecutor {
    const tools = () => typeof base === "function" ? base() : base;
    const thisRuntime = this;
    const initial = tools();
    return {
      get definitions() { return [...tools().definitions, ...thisRuntime.definitions]; },
      async beforeModelRequest(signal) { await tools().beforeModelRequest?.(signal); signal.throwIfAborted(); thisRuntime.flushContext(messages); },
      setReadContext(context) { tools().setReadContext?.(context); },
      ...(initial.prepareCompaction ? { prepareCompaction: async (options: Parameters<NonNullable<ToolExecutor["prepareCompaction"]>>[0]) => {
        thisRuntime.flushContext(messages);
        const prepare = tools().prepareCompaction;
        if (!prepare) throw new Error("Underlying tools do not support file restoration");
        return prepare(options);
      } } : {}),
      execute: async (call, signal) => {
        if (call.name !== "Skill") return tools().execute(call, signal);
        try {
          const execution = await this.execute(call, signal);
          this.pending.push(...execution.newMessages);
          return execution.result;
        } catch (error) {
          signal.throwIfAborted();
          const parsedFailure = skillFailureSchema.safeParse(error), failure = parsedFailure.success ? parsedFailure.data : {};
          const result: ToolResult = { type: "tool_result", tool_use_id: call.id, is_error: true,
            content: error instanceof Error ? error.message : "Skill invocation failed",
            ...(failure.permissionDenied ? { permissionDenied: true } : {}),
            ...(failure.hookAttachments?.length ? { hookAttachments: failure.hookAttachments } : {}) };
          return appendHookContext(result, failure.hookContext ?? [], failure.hookStop);
        }
      },
    };
  }
}

export function createSkillRuntime(options: SkillRuntimeOptions): SkillRuntime { return new SkillRuntime(options); }
