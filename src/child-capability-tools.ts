import { z } from "zod";
import type { LaunchConfiguration } from "./launch-configuration.js";
import { createSessionSkillHost, type SessionSkillHostOptions } from "./skill-session.js";
import type { LocalSkill, LocalSkillRegistry, SkillEffort } from "./skills.js";
import { createTaskRuntime, taskToolNames, type TaskLifecycleContext, type TaskLifecycleDecision } from "./task-runtime.js";
import type { LocalTaskStore } from "./task-store.js";
import { matchingToolRule, selectableToolNameSchema, type ToolPolicy } from "./tool-policy.js";
import type { ToolHookRuntime } from "./tool-hook-runtime.js";
import type { SkillEffectRequest } from "./skill-runtime.js";
import type { Message, PermissionMode, ToolExecutor, ToolResult, ToolUse } from "./types.js";

export type ChildPreloadSkill = Readonly<LocalSkill> & { readonly aliases?: readonly string[] };
export interface ChildPreloadRenderer {
  (skill: ChildPreloadSkill, request: { requestedName: string; signal: AbortSignal }): Promise<{ skill: Readonly<LocalSkill>; text: string }>;
}
/** Passive source preload path: metadata lookup and body rendering, never Skill invocation effects. */
export async function preloadDeclaredChildSkills(options: {
  names: readonly string[]; agentType: string; catalog: readonly ChildPreloadSkill[];
  render: ChildPreloadRenderer; signal: AbortSignal; onDiagnostic?(message: string): void;
}): Promise<{ messages: Message[]; preloaded: string[]; warnings: string[] }> {
  options.signal.throwIfAborted();
  const unique = [...new Set(options.names)], warnings: string[] = [];
  const warn = (message: string) => { warnings.push(message); options.onDiagnostic?.(message); };
  if (unique.length > 32) warn("Only the first 32 unique declared agent skills will be preloaded");
  const catalog = options.catalog.filter(skill => !skill.disableModelInvocation);
  const lookup = (name: string, entries = catalog) => entries.find(skill => skill.name === name) ??
    entries.find(skill => skill.displayName === name || skill.aliases?.includes(name));
  const plugin = catalog.filter(skill => skill.source === "plugin"), [namespace = ""] = options.agentType.split(":", 1);
  const selected: { requestedName: string; skill: ChildPreloadSkill }[] = [];
  for (const name of unique.slice(0, 32)) {
    const skill = lookup(name) ?? lookup(`${namespace}:${name}`, plugin) ?? plugin.find(skill => skill.name.endsWith(`:${name}`));
    if (!skill) { warn(`Declared agent skill ${name} is unavailable in the admitted model catalog`); continue; }
    selected.push({ requestedName: name, skill });
  }
  const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal]);
  const rendered = await Promise.all(selected.map(async ({ requestedName, skill }) => {
    try {
      const value = await options.render(skill, { requestedName, signal }); signal.throwIfAborted();
      if (value.skill.name !== skill.name || value.skill.canonicalPath !== skill.canonicalPath || typeof value.text !== "string")
        throw new Error("Preload renderer changed the admitted skill identity or returned invalid text");
      return { skill, text: value.text };
    } catch (error) { controller.abort(error); throw error; }
  }));
  options.signal.throwIfAborted();
  return { messages: rendered.map(({ skill, text }) => ({ role: "user", content: [{ type: "text", text: `Loaded agent skill: ${skill.name}\n\n${text}` }] })),
    preloaded: rendered.map(value => value.skill.name), warnings };
}
export interface ChildCapabilityToolsOptions {
  cwd: string; launch: LaunchConfiguration; agentId: string; agentType: string; isAsync: boolean;
  sessionId(): string; selectedToolNames: readonly string[]; policy(): ToolPolicy; mode(): PermissionMode;
  /** Snapshots captured once for this child's primary query. Skill changes tool-context model only. */
  model(): string; effort?(): SkillEffort | undefined;
  effortLevel?(context: { model: string; effort: SkillEffort | undefined }): string | undefined;
  hooks: ToolHookRuntime; interactive: boolean; approve(description: string): Promise<boolean>;
  registry?: LocalSkillRegistry;
  env?: NodeJS.ProcessEnv; ignorePersistedTrust?: boolean;
  processShellBlocks?: SessionSkillHostOptions["processShellBlocks"];
  /** Registration key remains sessionId from the effect; invoking actor does not re-key or merge registry snapshots. */
  registerSkillHooks?(request: NonNullable<SkillEffectRequest["sessionHooks"]>, actor: { agentId: string }): { registered: boolean; reason?: string };
  /** Required for a foreground invocation that actually declares command denies. Async source setter is a no-op. */
  publishSessionCommandDenies?(rules: readonly string[], actor: { agentId: string }): void;
  declaredSkills?: readonly string[];
  /** Parent render context belongs here, not the initialized child Skill runtime. */
  preloadRender?: ChildPreloadRenderer;
  tasks?: {
    store: LocalTaskStore;
    enabled(): boolean;
    lifecycle: {
      created(context: TaskLifecycleContext): Promise<TaskLifecycleDecision | void>;
      completed(context: TaskLifecycleContext): Promise<TaskLifecycleDecision | void>;
    };
    validateMutation?(context: { sessionId: string; actor?: string; mode?: "local" }): boolean | string;
  };
  signal: AbortSignal;
  onDiagnostic?(message: string): void;
}
const canonical = (name: string) => name === "Task" ? "Agent" : name === "KillShell" || name === "KillBash" ? "TaskStop" : name;
const noArgs = z.strictObject({});
const failed = (call: ToolUse, content: string, kind: "inputRejected" | "permissionDenied"): ToolResult =>
  ({ type: "tool_result", tool_use_id: call.id, content, is_error: true, [kind]: true });

/** Real ordinary child composition. Live parent floors and selected tool scope remain mandatory. */
export async function createChildCapabilityTools(options: ChildCapabilityToolsOptions) {
  options.signal.throwIfAborted();
  if (!options.agentId || !options.agentType) throw new Error("Child capability tools require explicit actor identities");
  const sessionId = options.sessionId(), primaryModel = options.model(), initialEffort = options.effort?.(), selected = new Set(options.selectedToolNames.map(canonical));
  if (!sessionId || !primaryModel.trim()) throw new Error("Child capability tools require a session and primary model snapshot");
  const inScope = (name: string): boolean => {
    const normalized = canonical(name), parent = options.policy();
    if (!selected.has(normalized)) return false;
    // CLI --tools narrows known ordinary tools; external-tool admission remains in the underlying router.
    return !selectableToolNameSchema.safeParse(normalized).success || parent.tools === undefined || parent.tools.some(tool => canonical(tool) === normalized);
  };
  const basePolicy = (): ToolPolicy => {
    const parent = options.policy();
    const tools = options.selectedToolNames.filter((name): name is NonNullable<ToolPolicy["tools"]>[number] =>
      selectableToolNameSchema.safeParse(name).success && inScope(name));
    return { ...parent, tools };
  };
  const effortLevel = options.effortLevel, registerSkillHooks = options.registerSkillHooks;
  let skillHost: Awaited<ReturnType<typeof createSessionSkillHost>> | undefined;
  const contextModel = () => skillHost?.model(primaryModel) ?? primaryModel;
  const queryEffort = (): SkillEffort | undefined => skillHost?.runtime.queryContext.layers.findLast(layer => layer.kind === "effort")?.effort ?? initialEffort;
  skillHost = await createSessionSkillHost({ cwd: options.cwd, launch: options.launch, policy: basePolicy,
    interactive: options.interactive && !options.isAsync, sessionId: () => sessionId, mode: options.mode,
    hooks: options.hooks, model: contextModel,
    ...(effortLevel ? { effortLevel: () => effortLevel({ model: contextModel(), effort: queryEffort() }) } : {}),
    approve: options.isAsync ? async () => false : options.approve,
    ...(options.registry ? { registry: options.registry } : {}), ...(options.env ? { env: options.env } : {}),
    ...(options.ignorePersistedTrust === undefined ? {} : { ignorePersistedTrust: options.ignorePersistedTrust }),
    ...(options.processShellBlocks ? { processShellBlocks: options.processShellBlocks } : {}),
    ...(registerSkillHooks ? { registerHooks: request => registerSkillHooks(request, { agentId: options.agentId }) } : {}),
    includeCommandDeniesInPolicy: !options.isAsync,
    validateEffects: effects => options.isAsync || !effects.disallowedTools.length || options.publishSessionCommandDenies !== undefined || "Foreground child Skill command denies require a shared session permission adapter",
    publishCommandDenies: rules => {
      if (options.isAsync || !rules.length) return;
      if (!options.publishSessionCommandDenies) throw new Error("Foreground child Skill command denies require a shared session permission adapter");
      options.publishSessionCommandDenies(rules, { agentId: options.agentId });
    },
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  options.signal.throwIfAborted();
  const skills = skillHost;
  const policy = (): ToolPolicy => skills.policy();
  const taskOptions = options.tasks;
  const tasks = !options.isAsync && taskOptions ? createTaskRuntime({ store: taskOptions.store,
    context: () => ({ sessionId, actor: options.agentId, mode: "local" }),
    enabled: () => taskOptions.enabled(), hooks: options.hooks, lifecycle: taskOptions.lifecycle,
    ...(taskOptions.validateMutation ? { validateMutation: taskOptions.validateMutation } : {}),
    authorize: async (call, _context, hookPermission, signal) => {
      signal.throwIfAborted();
      if (!inScope(call.name) || !taskOptions.enabled() || matchingToolRule(policy(), "deny", call.name, { input: call.input })) return "Child task tool is excluded or denied";
      if (matchingToolRule(policy(), "ask", call.name, { input: call.input }) || hookPermission === "ask") {
        const approved = await options.approve(`Use ${call.name} in the shared task list?`); signal.throwIfAborted();
        if (!approved) return false;
        if (!inScope(call.name) || matchingToolRule(policy(), "deny", call.name, { input: call.input })) return "Parent task policy changed during approval";
      }
      return true;
    },
  }) : undefined;
  const renderPreloads = async (names: readonly string[], signal: AbortSignal, renderer = options.preloadRender) => {
    if (!names.length) { const empty: Awaited<ReturnType<typeof preloadDeclaredChildSkills>> = { messages: [], preloaded: [], warnings: [] }; return empty; }
    if (!renderer) throw new Error("Declared child skills require an explicit parent-context preload renderer");
    return preloadDeclaredChildSkills({ names, agentType: options.agentType, catalog: skills.registry.catalog({ invocation: "model" }), render: renderer, signal,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}) });
  };
  const preload = await renderPreloads(options.declaredSkills ?? [], options.signal);
  function wrap(base: ToolExecutor | (() => ToolExecutor), messages: Message[] | (() => Message[])): ToolExecutor {
    const underlying = () => typeof base === "function" ? base() : base;
    const composedBase = (): ToolExecutor => {
      const current = underlying();
      return { ...current, get definitions() {
        const entry = !options.isAsync && inScope("EnterPlanMode") ? [{ name: "EnterPlanMode", description: "Plan entry belongs to the main session.",
          input_schema: { type: "object" as const, properties: {}, additionalProperties: false } }] : [];
        return [...current.definitions.filter(tool => !["Skill", "EnterPlanMode", "ExitPlanMode", ...taskToolNames].includes(tool.name)),
          ...(tasks?.definitions ?? []), ...entry];
      }, execute(call, signal) { return tasks?.handles(call.name) ? tasks.execute(call, signal) : current.execute(call, signal); } };
    };
    const currentWrapped = () => skills.runtime.wrap(composedBase, typeof messages === "function" ? messages() : messages);
    const initial = currentWrapped();
    return { get definitions() { return currentWrapped().definitions.filter(tool => inScope(tool.name) && !matchingToolRule(policy(), "deny", canonical(tool.name))); },
      beforeModelRequest: signal => currentWrapped().beforeModelRequest?.(signal) ?? Promise.resolve(),
      setReadContext: context => currentWrapped().setReadContext?.(context),
      ...(initial.prepareCompaction ? { prepareCompaction: (request: Parameters<NonNullable<ToolExecutor["prepareCompaction"]>>[0]) => currentWrapped().prepareCompaction?.(request) ?? Promise.resolve({ messages: [], commit() {} }) } : {}),
      async execute(call, signal) {
        signal.throwIfAborted();
        if (!inScope(call.name) || matchingToolRule(policy(), "deny", canonical(call.name), { input: call.input })) return failed(call, "Child tool is outside the current parent policy or declared scope", "permissionDenied");
        if (call.name === "EnterPlanMode") {
          const parsed = noArgs.safeParse(call.input);
          return failed(call, parsed.success ? "Only the main session can enter plan mode." : parsed.error.message, "inputRejected");
        }
        if (call.name === "ExitPlanMode") return failed(call, "Child ExitPlanMode requires an actor-aware plan-file and approval adapter", "inputRejected");
        if (taskToolNames.some(name => name === call.name) && !tasks) return failed(call,
          options.isAsync ? "Task CRUD is unavailable to an ordinary background child" : "Child task tool requires a shared-list host adapter", "permissionDenied");
        return currentWrapped().execute(call, signal);
      } };
  }
  return { skillHost: skills, taskRuntime: tasks, tools: { wrap }, wrap, policy, queryEffort, sessionId, primaryModel, contextModel,
    flushContext: (messages: Message[]) => skills.runtime.flushContext(messages),
    handledFeatures: (options.declaredSkills?.length ? ["skills" as const] : []),
    preloadMessages: preload.messages, preloadedSkills: preload.preloaded, preloadWarnings: preload.warnings,
    renderPreloads,
    /** No active hooks are composed here; caller owns correct global/child/session dispatch keys. */
    limitations: ["Primary query model stays fixed at entry; contextModel reports Skill tool-context overlays",
      "ExitPlanMode needs a separate full actor-plan adapter; ordinary async task CRUD is withheld",
      "Native forked Skill, served/team task identity and duplicate-body/continuation preload recovery are not implemented"],
  };
}
