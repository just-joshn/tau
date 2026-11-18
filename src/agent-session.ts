import {
  createLocalAgentRegistry,
  agentDefinitionLocations,
  type LocalAgentDefinition,
} from "./agent-definitions.js";
import {
  createSubagentRuntime,
  resolveOrdinarySubagentPermissionMode,
  type SubagentPlan,
  type SubagentParentContext,
  type SubagentRuntimeOptions,
} from "./subagent-runtime.js";
import {
  skillProjectDirectories,
  resolveDirectSkillModelAlias,
} from "./skill-session.js";
import {
  matchingToolRule,
  matchingAgentTypeDeny,
  inheritedReadDeny,
  type ToolPolicy,
} from "./tool-policy.js";
import { createTools } from "./tools.js";
import { ReadState } from "./read-state.js";
import { createInstructionCatalog } from "./instructions.js";
import { InstructionContext } from "./instruction-context.js";
import { runAgent } from "./agent.js";
import { defaultOutputTokens, resolveModelFacts } from "./reasoning.js";
import { matchesLegacyAvailableModels } from "./query-model-effort.js";
import type { LaunchConfiguration } from "./launch-configuration.js";
import type { ToolHookRuntime } from "./tool-hook-runtime.js";
import type {
  Message,
  PermissionMode,
  Provider,
  ToolDefinition,
  ToolExecutor,
} from "./types.js";
import { triBoolean } from "./env-settings.js";
import type { createSubagentLifecycle } from "./subagent-lifecycle.js";
import { pluginCustomizationOnly } from "./plugin-policy.js";
import {
  createBackgroundAgentRuntime,
  ordinaryLocalAgentLaunchMode,
  type BackgroundTaskSnapshot,
  type BackgroundAgentCompletion,
  type BackgroundAgentProgress,
} from "./background-agent-runtime.js";
import { createBackgroundProgressMeter } from "./background-progress.js";
import { ordinarySubagentConcurrencyLimit } from "./subagent-admission.js";
import type { createChildCapabilityTools } from "./child-capability-tools.js";
import type { createChildPlanHost } from "./child-plan-host.js";
import { selectableToolNameSchema } from "./tool-policy.js";
import { wrapCatalogTools } from "./catalog-session.js";
import type { createLaunchAgentMemoryHost } from "./agent-memory-launch.js";
import type { ScopedPermissionAccess } from "./scoped-permission-launch.js";
import {
  validateAgentDefinitionHooks,
  type createAgentDefinitionHookScope,
} from "./agent-definition-hooks.js";

/** Local agent host with live parent policy and an optional detached task lifetime owner. */
export async function createSessionAgentHost(options: {
  cwd: string;
  launch: LaunchConfiguration;
  provider: Provider;
  sessionId(): string;
  model(): string;
  mode(): PermissionMode;
  policy(): ToolPolicy;
  system(): string;
  hooks: ToolHookRuntime;
  childHooks(plan: Readonly<SubagentPlan>): ToolHookRuntime;
  approve(description: string): Promise<boolean>;
  externalTools?(
    base: ToolExecutor,
    mode: PermissionMode,
    policy: ToolPolicy,
    hooks: ToolHookRuntime,
    context?: { isAsync: boolean },
  ): ToolExecutor;
  taskTools?(
    base: ToolExecutor,
    plan: Readonly<SubagentPlan>,
    hooks: ToolHookRuntime,
  ): ToolExecutor;
  saveChild?(
    plan: Readonly<SubagentPlan>,
    messages: Message[],
    status: "running" | "completed" | "max_turns" | "interrupted",
  ): Promise<void>;
  pluginAgents?: readonly LocalAgentDefinition[];
  /** One process/session host may retain agents across clear/resume. */
  concurrencySlots?: Set<string>;
  builtinAgents?: readonly LocalAgentDefinition[];
  memory?: ReturnType<typeof createLaunchAgentMemoryHost>;
  definitionHooks?(
    plan: Readonly<SubagentPlan>,
  ): ReturnType<typeof createAgentDefinitionHookScope>;
  scopedPermissions?(
    policy: () => ToolPolicy,
    mode: () => PermissionMode,
  ): ScopedPermissionAccess;
  childCapabilities?(
    plan: Readonly<SubagentPlan>,
    context: {
      policy: () => ToolPolicy;
      mode: () => PermissionMode;
      hooks: ToolHookRuntime;
      signal: AbortSignal;
    },
  ): Promise<Awaited<ReturnType<typeof createChildCapabilityTools>>>;
  childPlan?(
    plan: Readonly<SubagentPlan>,
    context: {
      policy(): ToolPolicy;
      mode(): PermissionMode;
      hooks: ToolHookRuntime;
      signal: AbortSignal;
    },
  ): ReturnType<typeof createChildPlanHost>;
  background?: {
    outputFile(plan: Readonly<SubagentPlan>): string;
    persist(snapshot: Readonly<BackgroundTaskSnapshot>): Promise<void>;
    enqueueNotification(
      notification: Readonly<BackgroundAgentCompletion>,
    ): void | Promise<void>;
  };
  lifecycle?: ReturnType<typeof createSubagentLifecycle>;
  env?: NodeJS.ProcessEnv;
  onDiagnostic?(message: string): void;
}) {
  const env = options.env ?? process.env;
  const diagnostic = (message: string) => options.onDiagnostic?.(message);
  const registry = await createLocalAgentRegistry({
    ...options.memory?.registryOptions(),
    definitions: [
      ...(options.builtinAgents ?? []),
      ...(options.pluginAgents ?? []),
    ],
    locations: agentDefinitionLocations({
      userConfigDir: options.launch.userConfigDir,
      ...(options.launch.managedRoot === undefined
        ? {}
        : { managedRoot: options.launch.managedRoot }),
      projectDirectories: skillProjectDirectories(
        options.cwd,
        options.launch.importHome,
        options.launch.workspace.gitRoot,
      ),
    }),
    sources: {
      user:
        options.launch.snapshot.enabledSources.includes("userSettings") &&
        !pluginCustomizationOnly(
          options.launch.snapshot.policy.strictPluginOnlyCustomization,
          "agents",
        ),
      project:
        options.launch.snapshot.enabledSources.includes("projectSettings") &&
        !pluginCustomizationOnly(
          options.launch.snapshot.policy.strictPluginOnlyCustomization,
          "agents",
        ),
    },
    admitSource: (location) =>
      location.source !== "projectSettings" ||
      options.launch.workspace.currentWorkspaceTrusted ||
      "Workspace agent source is not trusted",
    validateHooks: (hooks) => {
      if (!options.definitionHooks)
        throw new Error("Agent-scoped hooks require their execution host");
      return validateAgentDefinitionHooks(hooks);
    },
    readPolicy: () => !inheritedReadDeny(options.policy()),
    eligible: (definition) =>
      definition.source !== "built-in" ||
      !definition.tools?.length ||
      definition.tools.includes("*") ||
      definition.tools.some(
        (tool) =>
          tool !== "WebFetch" &&
          !matchingToolRule(options.policy(), "deny", tool),
      ),
  });
  for (const issue of registry.diagnostics)
    diagnostic(issue.message + (issue.path ? ` (${issue.path})` : ""));
  const nativeModes = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ] as const;
  const allowedModes = (parent: PermissionMode) =>
    parent === "bypassPermissions"
      ? [...nativeModes]
      : parent === "acceptEdits"
        ? (["acceptEdits"] as const)
        : parent === "plan"
          ? (["plan"] as const)
          : (["default", "acceptEdits", "plan"] as const);
  const available = () => {
    const policy = options.policy();
    return (
      registry.activeDefinitions.length > 0 &&
      (policy.tools === undefined ||
        policy.tools.some((name) => name === "Agent" || name === "Task")) &&
      matchingToolRule(policy, "deny", "Agent") === undefined
    );
  };
  const depthValue = Number(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? 3);
  const maxDepth =
    Number.isSafeInteger(depthValue) && depthValue > 0 ? depthValue : 3;
  const availableModels = options.launch.snapshot.policy.availableModels;
  const modelAllowlist = Array.isArray(availableModels)
    ? availableModels.filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  const childHistories = new Map<string, { messages: Message[] }>();
  const capabilities = new Map<
    string,
    Awaited<ReturnType<typeof createChildCapabilityTools>>
  >();
  const startedChildren = new Set<string>();
  const heldSlots = options.concurrencySlots ?? new Set<string>(),
    ownedSlots = new Set<string>();
  const releaseSlot = (id: string) => {
    if (ownedSlots.delete(id)) heldSlots.delete(id);
  };
  const concurrencyLimit = () =>
    ordinarySubagentConcurrencyLimit(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS);
  // Retain permission lineage after a foreground parent returns while its background descendants remain alive.
  const activePlans = new Map<string, Readonly<SubagentPlan>>();
  const backgroundAdapters = new Map<string, SubagentRuntimeOptions>();
  const progressCallbacks = new Map<
    string,
    (progress: BackgroundAgentProgress) => void
  >();
  const pendingTools = new Map<string, Set<Promise<unknown>>>();
  const ownerSessionId = options.sessionId();
  const backgroundOptions = options.background;
  const background =
    backgroundOptions &&
    createBackgroundAgentRuntime({
      sessionId: ownerSessionId,
      admit: (plan, signal) => {
        signal.throwIfAborted();
        return (
          (available() &&
            !matchingToolRule(options.policy(), "deny", "Agent", {
              input: {
                ...plan.input,
                subagent_type: plan.definition.agentType,
              },
            })) ||
          "Background agent is no longer admitted by parent policy"
        );
      },
      materialize: async ({ plan, signal }) => {
        const adapter = backgroundAdapters.get(plan.agentId);
        if (!adapter)
          throw new Error("Background launch adapter is unavailable");
        const materialized = await adapter.materialize(plan, signal);
        return {
          ...materialized,
          enforcesLiveParentPolicy: true as const,
          enforcesBackgroundToolScope: true as const,
          permissionPrompts: "avoid" as const,
          cleanup: async () => {
            try {
              await materialized.cleanup?.();
            } finally {
              backgroundAdapters.delete(plan.agentId);
              progressCallbacks.delete(plan.agentId);
              pendingTools.delete(plan.agentId);
            }
          },
        };
      },
      authorizeTool: (call, plan, signal) =>
        backgroundAdapters
          .get(plan.agentId)
          ?.authorizeChildTool(call, plan, signal) ?? false,
      runChild: async (request) => {
        const adapter = backgroundAdapters.get(request.plan.agentId);
        if (!adapter) throw new Error("Background child runner is unavailable");
        progressCallbacks.set(request.plan.agentId, (progress) =>
          request.onProgress(progress),
        );
        const start = await adapter.lifecycle?.start?.(
          request.plan,
          request.signal,
          request.messages,
        );
        if (start?.length)
          request.messages.push({
            role: "user",
            contextPlacement: "subagent-start",
            content: start.map((text) => ({ type: "text", text })),
          });
        await request.prepareAfterStart?.();
        request.signal.throwIfAborted();
        const lifecycle = adapter.lifecycle,
          stop = lifecycle?.stop?.bind(lifecycle);
        return adapter.runChild({
          ...request,
          ...(stop ? { stopHook: (event) => stop(request.plan, event) } : {}),
        });
      },
      outputFile: (plan) => backgroundOptions.outputFile(plan),
      canReadOutputFile: (plan) =>
        plan.parent.availableTools.some((tool) => tool.name === "Read") &&
        !matchingToolRule(options.policy(), "deny", "Read"),
      persist: (snapshot) => backgroundOptions.persist(snapshot),
      enqueueNotification: (notification) =>
        backgroundOptions.enqueueNotification(notification),
      cleanupTask: async ({ task }) => {
        const pending = pendingTools.get(task.agentId);
        if (pending) await Promise.allSettled(pending);
        return 0;
      },
      watchdog: { kind: "unsupported" },
      onDiagnostic: diagnostic,
    });
  const resolveMode = (
    definition: Readonly<LocalAgentDefinition>,
    parent: SubagentParentContext["parentMode"],
  ): PermissionMode => {
    const mode = resolveOrdinarySubagentPermissionMode({
      parent,
      ...(definition.permissionMode === undefined
        ? {}
        : { declared: definition.permissionMode }),
      personalSourceRestricted:
        definition.source !== "policySettings" &&
        triBoolean(env.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG) === true,
      confinedEvaluation: triBoolean(env.CLAUDE_CODE_EVAL_CONFINED) === true,
      autoModeAvailable: false,
    });
    if (mode === "auto" || mode === "dontAsk")
      throw new Error(
        `Child permission mode ${mode} requires an unimplemented host adapter`,
      );
    return mode;
  };
  const liveMode = (plan: Readonly<SubagentPlan>): PermissionMode => {
    const parentId = plan.parent.parentAgentId,
      parent = parentId === undefined ? undefined : activePlans.get(parentId);
    if (parentId !== undefined && parent === undefined)
      throw new Error(
        "The parent agent permission context is no longer available",
      );
    return resolveMode(
      plan.definition,
      parent === undefined ? options.mode() : liveMode(parent),
    );
  };
  const livePlan = (plan: Readonly<SubagentPlan>) => ({
    ...plan,
    permissionMode: liveMode(plan),
  });
  const resolveModel = (
    parent: string,
    declared: string | undefined,
    call: string | undefined,
  ) => {
    if (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) {
      declared = undefined;
      call = undefined;
    }
    const selected =
      call || declared || env.CLAUDE_CODE_SUBAGENT_MODEL || "inherit";
    if (selected === "inherit") return parent;
    const simple = selected.toLowerCase();
    const model =
      Boolean(call || declared) &&
      ["opus", "sonnet", "haiku", "fable"].includes(simple) &&
      resolveModelFacts(parent).canonical.includes(`-${simple}-`)
        ? parent
        : resolveDirectSkillModelAlias(selected, env);
    if (
      !matchesLegacyAvailableModels(model, modelAllowlist, {
        resolveAlias: (value) => resolveDirectSkillModelAlias(value, env),
      })
    ) {
      // Family step-down requires the complete host catalog. This bounded host
      // refuses rather than selecting a model outside the admitted catalog.
      throw new Error(
        `Subagent model ${selected} requires an unavailable-model fallback adapter`,
      );
    }
    return model;
  };
  const makeRuntime = (
    base: () => ToolExecutor,
    inherited?: Readonly<SubagentPlan>,
    scope?: () => readonly ToolDefinition[],
  ): ReturnType<typeof createSubagentRuntime> => {
    const parentMode = () => (inherited ? liveMode(inherited) : options.mode());
    const hooks: ToolHookRuntime = inherited
      ? {
          before: (...args) =>
            options.childHooks(livePlan(inherited)).before(...args),
          after: (...args) =>
            options.childHooks(livePlan(inherited)).after(...args),
          failure: (...args) =>
            options.childHooks(livePlan(inherited)).failure?.(...args) ??
            Promise.resolve(),
        }
      : options.hooks;
    const lifecycle = options.lifecycle;
    const runtimeOptions: SubagentRuntimeOptions = {
      registry,
      hooks,
      enabled: () =>
        available() &&
        (!inherited ||
          inherited.selectedToolNames.includes("Agent") ||
          inherited.selectedToolNames.includes("Task")),
      context: (): SubagentParentContext => ({
        sessionId: options.sessionId(),
        parentModel: inherited
          ? (capabilities.get(inherited.agentId)?.contextModel() ??
            inherited.model)
          : options.model(),
        parentMode: parentMode(),
        ...(inherited ? { parentAgentId: inherited.agentId } : {}),
        depth: inherited?.depth ?? 0,
        maxDepth,
        availableTools: scope?.() ?? [
          ...base().definitions,
          ...runtime.definitions,
        ],
        allowedModes: allowedModes(parentMode()),
        foregroundAllowed: !["1", "true"].includes(
          env.CLAUDE_CODE_FORK_SUBAGENT ?? "",
        ),
        ...(inherited?.compaction.declaredCeiling
          ? { inheritedAutoCompactWindow: inherited.compaction.declaredCeiling }
          : {}),
      }),
      authorize: async (call, _context, hookPermission, signal) => {
        signal.throwIfAborted();
        const policy = options.policy();
        if (
          !available() ||
          matchingToolRule(policy, "deny", "Agent", { input: call.input })
        )
          return "Agent launch is excluded or denied by permission rules";
        if (
          matchingToolRule(policy, "ask", "Agent", { input: call.input }) ||
          hookPermission === "ask"
        )
          return inherited?.isAsync
            ? false
            : options.approve("Launch this agent?");
        return true;
      },
      admitChild: (plan) => {
        if (heldSlots.size >= concurrencyLimit())
          return `Concurrent agent limit reached (${concurrencyLimit()})`;
        if (
          matchingToolRule(options.policy(), "deny", "Agent", {
            input: { ...plan.input, subagent_type: plan.definition.agentType },
          })
        )
          return "Resolved agent type is denied by permission rules";
        if (
          !options.childCapabilities &&
          plan.selectedToolNames.some((name) =>
            [
              "Skill",
              "TaskCreate",
              "TaskGet",
              "TaskUpdate",
              "TaskList",
              "EnterPlanMode",
              "ExitPlanMode",
            ].includes(name),
          )
        )
          return "Child Skill/Task/Plan tool adapters are not yet implemented";
        return true;
      },
      ...(background
        ? {
            background: {
              resolveLaunchMode: (input, definition) =>
                ordinaryLocalAgentLaunchMode({
                  ...(input.run_in_background === undefined
                    ? {}
                    : { requestedBackground: input.run_in_background }),
                  ...(definition.background === undefined
                    ? {}
                    : { definitionBackground: definition.background }),
                  backgroundTasksDisabled:
                    Boolean(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) ||
                    triBoolean(env.CLAUDE_CODE_SIMPLE) === true,
                  defaultAsync: true,
                }),
              launch: async (plan, signal) => {
                backgroundAdapters.set(plan.agentId, runtimeOptions);
                try {
                  return await background.launch(plan, {
                    admissionSignal: signal,
                    ...(plan.parent.parentAgentId === undefined
                      ? {}
                      : {
                          ownerAgentId: plan.parent.parentAgentId,
                          parentAgentId: plan.parent.parentAgentId,
                        }),
                  });
                } catch (error) {
                  backgroundAdapters.delete(plan.agentId);
                  releaseSlot(plan.agentId);
                  throw error;
                }
              },
            },
          }
        : {}),
      selectTools: (definition, parent, context) => {
        const requested = definition.tools;
        if (
          [...(requested ?? []), ...(definition.disallowedTools ?? [])].some(
            (rule) => rule !== "*" && !/^[A-Za-z0-9_.:-]+$/.test(rule),
          )
        )
          throw new Error("Agent tool rules require a host scope resolver");
        return parent.availableTools
          .map((tool) => tool.name)
          .filter(
            (name) =>
              (requested === undefined ||
                requested.includes("*") ||
                requested.includes(name)) &&
              (!context?.isAsync ||
                [
                  "Read",
                  "Write",
                  "Edit",
                  "Glob",
                  "Grep",
                  "Bash",
                  "Agent",
                  "Task",
                  "TaskStop",
                  "Skill",
                ].includes(name) ||
                name.startsWith("mcp__")),
          );
      },
      resolveModel: ({ parent, definition, input }) =>
        resolveModel(parent.parentModel, definition.model, input.model),
      resolvePermissionMode: ({ parent, definition }) =>
        resolveMode(definition, parent.parentMode),
      authorizeChildTool: (call, plan) => {
        const policy = options.policy();
        if (matchingToolRule(policy, "deny", call.name, { input: call.input }))
          return `Parent permission rules deny ${call.name}`;
        return plan.selectedToolNames.includes(call.name);
      },
      lifecycle: {
        interrupted: (plan) => {
          releaseSlot(plan.agentId);
          if (!childHistories.has(plan.agentId))
            capabilities.delete(plan.agentId);
        },
        start: async (plan, signal, messages) => {
          startedChildren.add(plan.agentId);
          await options.saveChild?.(plan, [...(messages ?? [])], "running");
          signal.throwIfAborted();
          return options.lifecycle?.start(plan, signal) ?? [];
        },
        ...(lifecycle
          ? {
              stop: async (plan, event) => {
                await options.saveChild?.(plan, event.messages, "running");
                event.signal.throwIfAborted();
                return lifecycle.stop(livePlan(plan), event);
              },
            }
          : {}),
      },
      materialize: async (plan, signal) => {
        if (heldSlots.size >= concurrencyLimit())
          throw new Error(
            `Concurrent agent limit reached (${concurrencyLimit()})`,
          );
        heldSlots.add(plan.agentId);
        ownedSlots.add(plan.agentId);
        const readState = new ReadState();
        const basePolicy = (): ToolPolicy => {
          const parent = options.policy();
          return {
            ...parent,
            tools: plan.selectedToolNames.filter(
              (name): name is NonNullable<ToolPolicy["tools"]>[number] =>
                selectableToolNameSchema.safeParse(name).success &&
                (parent.tools === undefined ||
                  parent.tools.some(
                    (tool) =>
                      tool === name ||
                      (tool === "Task" && name === "Agent") ||
                      (tool === "Agent" && name === "Task"),
                  )),
            ),
          };
        };
        const policy = (): ToolPolicy =>
          capabilities.get(plan.agentId)?.policy() ?? basePolicy();
        const scopedPermissions = options.scopedPermissions?.(policy, () =>
          liveMode(plan),
        );
        // ca/getSystemPrompt resolves memory before SubagentStart, independently
        // of later passive skill preloads and the child's primary model.
        const memory = await options.memory?.prepare(plan.definition, signal);
        const policyKey = () => JSON.stringify([policy(), liveMode(plan)]);
        const childHooks: ToolHookRuntime = {
          before: async (...args) => {
            const key = policyKey(),
              result = await options.childHooks(livePlan(plan)).before(...args);
            if (policyKey() !== key)
              throw new Error(
                "Parent permissions changed while the child hook ran; retry this operation under the updated policy",
              );
            return result;
          },
          after: (...args) => options.childHooks(livePlan(plan)).after(...args),
          failure: (...args) =>
            options.childHooks(livePlan(plan)).failure?.(...args) ??
            Promise.resolve(),
        };
        const childCapabilities = await options.childCapabilities?.(plan, {
          policy: basePolicy,
          mode: () => liveMode(plan),
          hooks: childHooks,
          signal,
        });
        if (childCapabilities)
          capabilities.set(plan.agentId, childCapabilities);
        const childPlan = options.childPlan?.(plan, {
          policy,
          mode: () => liveMode(plan),
          hooks: childHooks,
          signal,
        });
        const instructions = new InstructionContext({
          cwd: options.cwd,
          ...(plan.definition.omitClaudeMd &&
          ["built-in", "policySettings"].includes(plan.definition.source)
            ? { omitInitial: true }
            : {}),
          catalog: createInstructionCatalog({
            cwd: options.cwd,
            userConfigDir: options.launch.userConfigDir,
            ...(options.launch.managedRoot === undefined
              ? {}
              : { managedRoot: options.launch.managedRoot }),
            importHome: options.launch.importHome,
            sources: {
              user: options.launch.snapshot.enabledSources.includes(
                "userSettings",
              ),
              project:
                options.launch.snapshot.enabledSources.includes(
                  "projectSettings",
                ),
              local:
                options.launch.snapshot.enabledSources.includes(
                  "localSettings",
                ),
            },
            ...(Array.isArray(
              options.launch.snapshot.effective.claudeMdExcludes,
            )
              ? {
                  excludePatterns:
                    options.launch.snapshot.effective.claudeMdExcludes.filter(
                      (value): value is string => typeof value === "string",
                    ),
                }
              : {}),
            ...(typeof options.launch.snapshot.policy.claudeMd === "string"
              ? {
                  managedInline: [
                    {
                      path: "[managed settings instructions]",
                      content: options.launch.snapshot.policy.claudeMd,
                    },
                  ],
                }
              : {}),
            readPolicy: (_path, _canonical, kind) =>
              kind === "Managed" ||
              kind === "User" ||
              !inheritedReadDeny(policy()),
            managedInstructionsOnly:
              options.launch.snapshot.effective.managedInstructionsOnly ===
              true,
          }),
          model: () => childCapabilities?.contextModel() ?? plan.model,
          contextWindow: () =>
            options.provider.contextWindowTokens?.(
              childCapabilities?.contextModel() ?? plan.model,
            ) ?? 200000,
          onDiagnostic: diagnostic,
        });
        const contexts: Message[] = [],
          initial: Message = { role: "user", content: [] };
        await instructions.announce(initial, contexts);
        signal.throwIfAborted();
        if (initial.content.length) contexts.push(initial);
        let cached: ToolExecutor | undefined, cachedKey: string | undefined;
        let readContext: Parameters<
          NonNullable<ToolExecutor["setReadContext"]>
        >[0];
        const tools = (): ToolExecutor => {
          const key = JSON.stringify([
            policyKey(),
            instructions.excludedPaths,
            childCapabilities?.contextModel(),
          ]);
          if (cached && key === cachedKey) return cached;
          const mode = liveMode(plan),
            current = policy(),
            planPath = childPlan?.location();
          const memoryAccess = options.memory?.fileAccess(policy, () =>
            liveMode(plan),
          );
          const builtins = createTools({
            cwd: options.cwd,
            mode,
            policy: current,
            readState,
            ...scopedPermissions,
            hooks: childHooks,
            restorationExcludedPaths: [
              ...instructions.excludedPaths,
              ...(planPath ? [planPath] : []),
            ],
            ...(childPlan ? childPlan.fileAccess : {}),
            ...(memoryAccess
              ? {
                  memoryFileAllowance: memoryAccess.memoryFileAllowance,
                  extraPathAdmission: async (request) =>
                    (await childPlan?.fileAccess.extraPathAdmission(request)) ??
                    (await memoryAccess.extraPathAdmission(request)),
                }
              : {}),
            sensitiveWritePaths: options.launch.snapshot.documents.flatMap(
              (document) =>
                document.path === undefined ? [] : [document.path],
            ),
            onFileToolCall: ({ name, path }) => {
              if (
                name === "Write" ||
                triBoolean(env.CLAUDE_CODE_SIMPLE) !== true
              )
                childCapabilities?.skillHost.runtime.activateForPaths(
                  [path],
                  options.launch.workspace.gitRoot ?? options.cwd,
                );
            },
            approve: plan.isAsync
              ? async () => false
              : (description) => options.approve(description),
            readTokenCounter: (text, signal) =>
              options.provider.countFileTokens?.({
                model: childCapabilities?.contextModel() ?? plan.model,
                text,
                signal,
              }) ?? Promise.resolve(undefined),
          });
          const external =
            options.externalTools?.(builtins, mode, current, childHooks, {
              isAsync: plan.isAsync === true,
            }) ?? builtins;
          cached = options.taskTools?.(external, plan, childHooks) ?? external;
          cached.setReadContext?.(readContext);
          cachedKey = key;
          return cached;
        };
        // Nested agents receive this narrowed executor as their parent scope.
        let completeChildTools: ToolExecutor | undefined;
        const nested = makeRuntime(
          tools,
          plan,
          () =>
            completeChildTools?.definitions ?? [
              ...tools().definitions,
              ...nested.definitions,
            ],
        );
        const wrapped: ToolExecutor = {
          get definitions() {
            return [...tools().definitions, ...nested.definitions];
          },
          execute: (call, childSignal) =>
            nested.handles(call.name)
              ? nested.execute(call, childSignal)
              : tools().execute(call, childSignal),
          beforeModelRequest: (signal) =>
            tools().beforeModelRequest?.(signal) ?? Promise.resolve(),
          setReadContext: (context) => {
            readContext = context;
            tools().setReadContext?.(context);
          },
          prepareCompaction: (request) =>
            tools().prepareCompaction?.(request) ??
            Promise.resolve({ messages: [], commit() {} }),
        };
        // Per-file instruction discovery needs the child's actual mutable history.
        const history = { messages: contexts };
        childHistories.set(plan.agentId, history);
        activePlans.set(plan.agentId, plan);
        const capabilitiesOnly =
          childCapabilities?.wrap(wrapped, () => history.messages) ?? wrapped;
        const withCapabilities =
          childPlan?.wrap(capabilitiesOnly) ?? capabilitiesOnly;
        completeChildTools = withCapabilities;
        let announcedPlan: string | undefined;
        const withPlanNotice: ToolExecutor = {
          ...withCapabilities,
          get definitions() {
            return withCapabilities.definitions;
          },
          beforeModelRequest: async (signal) => {
            await withCapabilities.beforeModelRequest?.(signal);
            signal.throwIfAborted();
            const location = childPlan?.location();
            if (!location) {
              announcedPlan = undefined;
              return;
            }
            if (location !== announcedPlan) {
              history.messages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Planning mode is active. Agent plan file: ${location}\nPrepare the plan in this file, then request ExitPlanMode approval.`,
                  },
                ],
              });
              announcedPlan = location;
            }
          },
        };
        const hasDefinitionHooks =
          plan.definition.hooks !== undefined &&
          Object.keys(validateAgentDefinitionHooks(plan.definition.hooks))
            .length > 0;
        const definitionHooks = hasDefinitionHooks
          ? options.definitionHooks?.(plan)
          : undefined;
        return {
          system: `${options.system()}\n\n${plan.definition.prompt}${memory?.systemPrompt ? `\n\n${memory.systemPrompt}` : ""}`,
          contextMessages: contexts,
          enforcesParentPolicy: true as const,
          handledFeatures: [
            ...(memory?.handledFeatures ?? []),
            ...(options.definitionHooks && plan.definition.hooks !== undefined
              ? ["hooks" as const]
              : []),
            ...(childCapabilities && plan.definition.skills.length
              ? ["skills" as const]
              : []),
            ...(plan.definition.omitClaudeMd &&
            ["built-in", "policySettings"].includes(plan.definition.source)
              ? ["omitClaudeMd" as const]
              : []),
          ],
          afterStart: async (signal: AbortSignal) => {
            await definitionHooks?.afterStart(signal);
            signal.throwIfAborted();
            return childCapabilities
              ? (
                  await childCapabilities.renderPreloads(
                    plan.definition.skills,
                    signal,
                  )
                ).messages
              : [];
          },
          tools: {
            ...withCapabilities,
            get definitions() {
              return withCapabilities.definitions;
            },
            execute: (call, childSignal) => {
              const operation = instructions
                .wrap(withCapabilities, history.messages, readState)
                .execute(call, childSignal);
              if (["TaskStop", "KillShell", "KillBash"].includes(call.name))
                return operation;
              const pending =
                pendingTools.get(plan.agentId) ?? new Set<Promise<unknown>>();
              pendingTools.set(plan.agentId, pending);
              pending.add(operation);
              void operation.then(
                () => pending.delete(operation),
                () => pending.delete(operation),
              );
              return operation;
            },
            beforeModelRequest: async (signal) => {
              await wrapCatalogTools(
                instructions.wrap(withPlanNotice, history.messages, readState),
                history.messages,
                {
                  agents: async () =>
                    (await registry.catalog()).filter(
                      (definition) =>
                        !matchingAgentTypeDeny(
                          options.policy(),
                          definition.agentType,
                        ),
                    ),
                  skills: () =>
                    childCapabilities?.skillHost.runtime.catalog("model") ?? [],
                  skillBudget: {
                    contextTokens:
                      options.provider.contextWindowTokens?.(plan.model) ??
                      200000,
                  },
                },
              ).beforeModelRequest?.(signal);
            },
          },
          cleanup: async () => {
            try {
              if (startedChildren.has(plan.agentId))
                await options.lifecycle?.teardown(plan);
            } finally {
              childCapabilities?.flushContext(history.messages);
              definitionHooks?.cleanup();
              options.lifecycle?.cleanup(plan);
              startedChildren.delete(plan.agentId);
              childHistories.delete(plan.agentId);
              capabilities.delete(plan.agentId);
              releaseSlot(plan.agentId);
            }
          },
        };
      },
      runChild: async (request) => {
        const history = childHistories.get(request.plan.agentId);
        if (history) history.messages = request.messages;
        if (
          request.plan.compaction.inherited !== undefined ||
          request.plan.compaction.declaredCeiling !== undefined
        )
          throw new Error(
            "Subagent compaction ceiling requires an unimplemented host policy adapter",
          );
        const maxTurns = request.plan.maxTurns ?? 1000;
        const progressMeter = createBackgroundProgressMeter({
          intervalMs: () =>
            request.plan.isAsync && heldSlots.size > 20 ? 5000 : 500,
        });
        let progressKey = "";
        try {
          await options.saveChild?.(request.plan, request.messages, "running");
          request.signal.throwIfAborted();
          const stopHook = request.stopHook;
          await runAgent({
            provider: options.provider,
            tools: request.tools,
            model: request.plan.model,
            system: request.system,
            messages: request.messages,
            maxTokens: defaultOutputTokens(request.plan.model),
            useModelTokenDefaults: true,
            maxTurns,
            queryEffort: () =>
              capabilities.get(request.plan.agentId)?.queryEffort() ??
              request.plan.effort,
            ...(stopHook
              ? {
                  stopHook: async (event) => {
                    const result = await stopHook(event);
                    return {
                      ...result,
                      additionalContext: [...result.additionalContext],
                    };
                  },
                }
              : {}),
            signal: request.signal,
            onEvent: (event) => {
              if (event.type === "warning") diagnostic(event.message);
              if (event.type === "tool_result")
                options.lifecycle?.resetContinuationCount(request.plan);
              const progress = progressCallbacks.get(request.plan.agentId);
              if (progress) {
                const metered = request.messages.flatMap((message) =>
                  message.role === "assistant" && message.usage
                    ? [{ usage: message.usage }]
                    : [],
                );
                const last = metered.at(-1)?.usage;
                progress({
                  messages: request.messages,
                  ...(progressMeter.observed
                    ? progressMeter.snapshot()
                    : {
                        ...(last
                          ? {
                              latestInputTokens:
                                last.input_tokens +
                                (last.cache_creation_input_tokens ?? 0) +
                                (last.cache_read_input_tokens ?? 0),
                            }
                          : {}),
                        cumulativeOutputTokens: metered.reduce(
                          (sum, message) => sum + message.usage.output_tokens,
                          0,
                        ),
                      }),
                });
              }
            },
            ...(request.plan.isAsync
              ? {
                  onStreamProgress: (event) => {
                    progressMeter.accept(event);
                    const snapshot = progressMeter.snapshot(),
                      key = JSON.stringify(snapshot);
                    if (key !== progressKey) {
                      progressKey = key;
                      progressCallbacks.get(request.plan.agentId)?.(snapshot);
                    }
                  },
                }
              : {}),
          });
          options.lifecycle?.finishQuery(request.plan);
          await options.saveChild?.(
            request.plan,
            request.messages,
            "completed",
          );
          return { messages: request.messages, normalQueryExit: true as const };
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "Agent reached maxTurns before completing"
          ) {
            options.lifecycle?.finishQuery(request.plan);
            await options.saveChild?.(
              request.plan,
              request.messages,
              "max_turns",
            );
            return {
              messages: request.messages,
              outcome: "max_turns" as const,
              normalQueryExit: true as const,
            };
          }
          try {
            await options.saveChild?.(
              request.plan,
              request.messages,
              "interrupted",
            );
          } catch (archiveError) {
            diagnostic(
              `Child archive failed: ${archiveError instanceof Error ? archiveError.message : "unknown error"}`,
            );
          }
          throw error;
        }
      },
    };
    const runtime = createSubagentRuntime(runtimeOptions);
    return runtime;
  };
  return {
    registry,
    available,
    background,
    close: async () => {
      await background?.close();
      activePlans.clear();
      for (const id of ownedSlots) releaseSlot(id);
    },
    catalog: async () =>
      (await registry.catalog()).filter(
        (definition) =>
          !matchingAgentTypeDeny(options.policy(), definition.agentType),
      ),
    wrap(
      base: () => ToolExecutor,
      scope?: () => readonly ToolDefinition[],
    ): ToolExecutor {
      const runtime = makeRuntime(base, undefined, scope);
      return {
        get definitions() {
          return [...base().definitions, ...runtime.definitions];
        },
        execute: (call, signal) =>
          runtime.handles(call.name)
            ? runtime.execute(call, signal)
            : base().execute(call, signal),
        beforeModelRequest: (signal) =>
          base().beforeModelRequest?.(signal) ?? Promise.resolve(),
        setReadContext: (context) => base().setReadContext?.(context),
        prepareCompaction: (request) =>
          base().prepareCompaction?.(request) ??
          Promise.resolve({ messages: [], commit() {} }),
      };
    },
  };
}
