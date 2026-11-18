import { dirname, join } from "node:path";
import type { LaunchConfiguration } from "./launch-configuration.js";
import { createLocalSkillRegistry, type AdmittedSkillDefinition, type LocalSkillRegistry, type SkillInvocationOptions, type LocalSkill } from "./skills.js";
import { createSkillRuntime, isPureLocalSkill, localSkillGrantRefusal, type SkillEffectRequest } from "./skill-runtime.js";
import { combineToolPolicy, matchingToolRule, toolRuleNameSchema, type ToolPolicy } from "./tool-policy.js";
import { createHookRegistry } from "./hooks.js";
import type { ToolHookRuntime } from "./tool-hook-runtime.js";
import type { PermissionMode } from "./types.js";
import { resolveModelFacts } from "./reasoning.js";
import { triBoolean } from "./env-settings.js";
import { matchesLegacyAvailableModels, resolveQueryModelOverride } from "./query-model-effort.js";
import { resolveDirectModelAlias } from "./direct-model-alias.js";
import { pluginCustomizationOnly } from "./plugin-policy.js";

/** Direct baked catalog before terminal fallbacks; account/provider tables remain separate. */
export function resolveDirectSkillModelAlias(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const disable1m = triBoolean(env.CLAUDE_CODE_DISABLE_1M_CONTEXT) === true;
  return resolveDirectModelAlias(model, { env, disable1m,
    // This CLI currently implements direct API-key launches. Served/account
    // defaults and plan-specific upgrade routing need their own host adapters.
    specialAlias: alias => resolveDirectModelAlias(alias === "opusplan" ? "sonnet" : "opus", { env, disable1m }),
  });
}

/** Ordinary local discovery: stop before home, at repository root, or at filesystem root. */
export function skillProjectDirectories(cwd: string, home: string, gitRoot: string | null): string[] {
  const result: string[] = [];
  for (let path = cwd; path !== home; path = dirname(path)) {
    result.push(path);
    if (path === gitRoot || path === dirname(path)) break;
  }
  return result;
}

/** Host policy for inline local skills; query overlays never mutate saved settings. */
export interface SessionSkillHostOptions {
  cwd: string; launch: LaunchConfiguration; policy: ToolPolicy | (() => ToolPolicy); interactive: boolean;
  sessionId(): string; mode(): PermissionMode; hooks: ToolHookRuntime;
  model?(): string;
  effortLevel?(): string | undefined;
  approve(description: string): Promise<boolean>;
  ignorePersistedTrust?: boolean;
  env?: NodeJS.ProcessEnv;
  onDiagnostic?(message: string): void;
  registerHooks?(request: NonNullable<SkillEffectRequest["sessionHooks"]>): { registered: boolean; reason?: string };
  pluginPrompts?: readonly AdmittedSkillDefinition[];
  /** Reuse an already admitted catalog without rescanning or registering plugin definitions again. */
  registry?: LocalSkillRegistry;
  processShellBlocks?: SkillInvocationOptions["processShellBlocks"];
  /** Foreground child source setter can publish command denies into the shared session frame. */
  publishCommandDenies?(rules: readonly string[]): void;
  validateEffects?(effects: SkillEffectRequest): boolean | string;
  /** Async source's ordinary permission setter is a no-op; default retains main behavior. */
  includeCommandDeniesInPolicy?: boolean;
}
export interface SkillPreloadRenderContext {
  sessionId: string;
  signal: AbortSignal;
  effortLevel?: string;
  processShellBlocks?: SkillInvocationOptions["processShellBlocks"];
  authorize?: SkillInvocationOptions["authorize"];
}
export async function createSessionSkillHost(options: SessionSkillHostOptions) {
  const env = options.env ?? process.env;
  const diagnostic = (message: string) => options.onDiagnostic?.(message);
  const basePolicy = () => typeof options.policy === "function" ? options.policy() : options.policy;
  const registry = options.registry ?? await createLocalSkillRegistry({
    cwd: options.cwd, userConfigDir: options.launch.userConfigDir,
    ...(options.launch.managedRoot === undefined ? {} : { managedRoot: options.launch.managedRoot }),
    projectDirectories: skillProjectDirectories(options.cwd, options.launch.importHome, options.launch.workspace.gitRoot),
    sources: { user: options.launch.snapshot.enabledSources.includes("userSettings") && !pluginCustomizationOnly(options.launch.snapshot.policy.strictPluginOnlyCustomization, "skills"), project: options.launch.snapshot.enabledSources.includes("projectSettings") && !pluginCustomizationOnly(options.launch.snapshot.policy.strictPluginOnlyCustomization, "skills") },
    managedOnly: options.launch.snapshot.effective.managedSkillsOnly === true,
    admitSource: location => location.source !== "projectSettings" || options.launch.workspace.currentWorkspaceTrusted || "Workspace skill source is not trusted",
    validateHooks: hooks => {
      // Validate without running commands. Session hook registration is an explicit separate admission.
      const parsed = createHookRegistry([{ source: "skill", hooks }]); void parsed.close(); return hooks;
    },
    normalizeModel: model => resolveDirectSkillModelAlias(model, env),
  });
  if (!options.registry) {
    registry.registerDefinitions(options.pluginPrompts ?? []);
    for (const issue of registry.diagnostics) diagnostic(`${issue.message} (${issue.path})`);
  }
  const runtime = createSkillRuntime({
    registry, sessionId: options.sessionId, hooks: options.hooks,
    ...(options.effortLevel ? { effortLevel: options.effortLevel } : {}),
    ...(options.processShellBlocks ? { processShellBlocks: options.processShellBlocks } : {}),
    enabled: () => registry.catalog({ invocation: "model" }).length > 0 && (basePolicy().tools?.some(name => String(name) === "Skill") ?? true),
    authorize: async ({ skill, input, invocation, hookPermission }) => {
      const parent = basePolicy();
      if (parent.tools !== undefined && !parent.tools.some(name => String(name) === "Skill")) return "Skill is excluded by --tools";
      const policy = queryPolicy();
      if (matchingToolRule(policy, "deny", "Skill", { input: { ...input, skill: skill.name } })) return `Skill ${skill.name} is denied by permission rules`;
      if (matchingToolRule(policy, "ask", "Skill", { input: { ...input, skill: skill.name } }) || hookPermission === "ask") return options.approve(`Load skill ${skill.name}?`);
      if (matchingToolRule(policy, "allow", "Skill", { input: { ...input, skill: skill.name } }) || invocation === "user" || isPureLocalSkill(skill)) return true;
      if (hookPermission === "allow" || options.mode() === "bypassPermissions") return true;
      return options.approve(`Load skill ${skill.name} and its declared tool permissions?`);
    },
    applyEffects: effects => {
      const admittedEffects = options.validateEffects?.(effects);
      if (admittedEffects === false || typeof admittedEffects === "string") throw new Error(typeof admittedEffects === "string" ? admittedEffects : "Skill effects require a host adapter");
      // Unsupported denies must never be silently dropped. Supported rules use the same dispatcher policy.
      combineToolPolicy(basePolicy(), effects.disallowedTools.map(rule => ({ rule, behavior: "deny" as const, source: "command" })));
      const refusal = localSkillGrantRefusal(effects.skill.source, {
        allowManagedPermissionRulesOnly: options.launch.snapshot.policy.allowManagedPermissionRulesOnly === true,
        ignorePersistedTrust: options.ignorePersistedTrust === true || triBoolean(env.CLAUDE_CODE_IGNORE_PERSISTED_TRUST) === true,
        interactive: options.interactive, restrictPersonalConfig: triBoolean(env.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG) === true,
      });
      const allowedTools = refusal ? [] : effects.allowedTools.filter(rule => {
        const valid = toolRuleNameSchema.safeParse(rule).success;
        if (!valid) diagnostic(`Skill ${effects.skill.name}: automatic grant ${rule} requires an unimplemented command/path rule`);
        return valid;
      });
      if (refusal && effects.allowedTools.length) diagnostic(`Skill ${effects.skill.name}: automatic grants withheld (${refusal})`);
      const warnings: string[] = [];
      const hooks = effects.sessionHooks === undefined ? undefined : options.registerHooks?.(effects.sessionHooks);
      if (hooks?.reason) warnings.push(hooks.reason);
      let model: string | undefined;
      if (effects.declaredModel !== undefined) {
        const available = options.launch.snapshot.policy.availableModels;
        const allowed = Array.isArray(available) ? available.filter((name): name is string => typeof name === "string") : undefined;
        const resolveAlias = (name: string) => resolveDirectSkillModelAlias(name, env);
        const admitted = matchesLegacyAvailableModels(resolveAlias(effects.declaredModel), allowed, { resolveAlias });
        if (!admitted) {
          warnings.push(`Skill model ${effects.declaredModel} was withheld by the available-model policy.`);
        } else if (effects.invocation === "user") model = effects.declaredModel;
        else {
          const selected = resolveQueryModelOverride({ declared: effects.declaredModel, current: options.model?.() ?? options.launch.model,
            resolveAlias, available: () => admitted, context: name => {
              const facts = resolveModelFacts(name, env);
              return { explicit1m: /\[1m\]$/i.test(name), nativeLong: facts.context.native_1m === true, believedLong: false,
                supports1m: facts.context.supports_1m_suffix === true };
            } });
          model = selected.model;
        }
      }
      if (effects.disallowedTools.length) options.publishCommandDenies?.(effects.disallowedTools);
      return { allowedTools, ...(model === undefined ? {} : { model }), ...(effects.declaredEffort === undefined ? {} : { effort: effects.declaredEffort }), warnings,
        ...(effects.sessionHooks === undefined ? {} : { hooksRegistered: hooks?.registered === true }) };
    },
    onDiagnostic: diagnostic,
  });
  function queryPolicy(): ToolPolicy {
    const frame = runtime.queryContext;
    const rules = [
      ...frame.layers.flatMap(layer => layer.kind === "allowed_tools" ? layer.allowedTools.map(rule => ({ rule, behavior: "allow" as const, source: "command" })) : []),
      ...(options.includeCommandDeniesInPolicy === false ? [] : frame.commandDisallowedTools.map(rule => ({ rule, behavior: "deny" as const, source: "command" }))),
    ];
    return combineToolPolicy(basePolicy(), rules);
  }
  async function renderPreload(name: string, context: SkillPreloadRenderContext): Promise<{ skill: Readonly<LocalSkill>; text: string }> {
    context.signal.throwIfAborted();
    if (!registry.catalog({ invocation: "model" }).some(skill => skill.name === name)) throw new Error(`Unknown or inactive preload skill: ${name}`);
    // Only body expansion: never use runtime.execute/invokeUser or apply invocation effects.
    const invocation = await registry.invoke(name, "", { invocation: "model", sessionId: context.sessionId, signal: context.signal,
      ...(context.effortLevel === undefined ? {} : { effortLevel: context.effortLevel }),
      ...(context.processShellBlocks === undefined ? {} : { processShellBlocks: context.processShellBlocks }),
      ...(context.authorize === undefined ? {} : { authorize: context.authorize }) });
    context.signal.throwIfAborted();
    return { skill: invocation.skill, text: invocation.text };
  }
  return { runtime, registry, renderPreload, policy: queryPolicy, has: (name: string) => registry.catalog().some(skill => skill.name === name),
    model: (fallback: string) => runtime.queryContext.layers.findLast(layer => layer.kind === "model")?.mainLoopModel ?? fallback,
  };
}
