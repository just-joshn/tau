#!/usr/bin/env bun
import { admitSessionPersistence, isInteractiveLaunch } from "./launch-mode.js";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { terminalText as safe, replaceProvisional } from "./terminal.js";
import { runAgent } from "./agent.js";
import {
  help,
  parseOptions,
  permissionModeSchema,
  printProtocolFlagError,
} from "./options.js";
import {
  billingHeader,
  identityLine,
  promptEntrypoint,
  renderSystemPrompt,
  systemPromptBlocks,
} from "./system-prompt.js";
import {
  attributionTexts,
  firstPromptText,
  gitFacts,
  localDate,
  prependReminders,
  roundAttachments,
  turnStartReminders,
} from "./context-reminders.js";
import { release, type as osType } from "node:os";
import { AnthropicProvider } from "./provider.js";
import { newSession, SessionStore } from "./session.js";
import { importNativeSessionFile } from "./native-session-import.js";
import { createLaunchAgentMemoryHost } from "./agent-memory-launch.js";
import { createLaunchScopedPermissionHost } from "./scoped-permission-launch.js";
import { createTools } from "./tools.js";
import { describedShell } from "./bash-shell.js";
import { ReadState } from "./read-state.js";
import { defaultOutputTokens, resolveModelFacts } from "./reasoning.js";
import { compactContext, freshCompactionState } from "./compaction.js";
import { ApiAttemptBudget } from "./attempt-ledger.js";
import { McpManager } from "./mcp.js";
import { loadLaunchMcp } from "./mcp-launch.js";
import { routeExternalTools } from "./tool-router.js";
import { loadLaunchConfiguration } from "./launch-configuration.js";
import {
  combineToolPolicy,
  inheritedReadDeny,
  matchingToolRule,
} from "./tool-policy.js";
import { createInstructionCatalog } from "./instructions.js";
import { InstructionContext } from "./instruction-context.js";
import { createHookRegistry, type HookSource } from "./hooks.js";
import { createAgentDefinitionHookScope } from "./agent-definition-hooks.js";
import { createAgentHookOriginResolver } from "./agent-hook-origin.js";
import { resolveWorkspaceProjectIdentity } from "./workspace-configuration.js";
import {
  createReducedScopedHookRegistry,
  ordinaryDirectAgentDefinitionHookProvenance,
} from "./scoped-hook-dispatch.js";
import { createSessionHookHost } from "./session-hooks.js";
import {
  createSessionSkillHost,
  resolveDirectSkillModelAlias,
} from "./skill-session.js";
import {
  SessionSkillHookRegistry,
  createSkillHookExecutionRegistry,
} from "./skill-hook-registry.js";
import { createSessionTaskHost } from "./task-session.js";
import { createSessionAgentHost } from "./agent-session.js";
import { wrapCatalogTools } from "./catalog-session.js";
import { TOOL_SEARCH, toolSearchEnabled } from "./tool-search.js";
import { formatBackgroundNotification } from "./background-notifications.js";
import { createBackgroundTaskTools } from "./background-task-tools.js";
import { createWebTools } from "./web-tools.js";
import { webFetchModel } from "./web-fetch.js";
import { resolveDirectModelAlias } from "./direct-model-alias.js";
import { createChildCapabilityTools } from "./child-capability-tools.js";
import { createChildPlanHost } from "./child-plan-host.js";
import {
  builtinAgentProfile,
  createBuiltinAgentCatalog,
  createExplorePlanAvailability,
} from "./builtin-agent-definitions.js";
import { loadLaunchPlugins } from "./plugin-launch.js";
import { createSubagentLifecycle } from "./subagent-lifecycle.js";
import { pluginCustomizationOnly } from "./plugin-policy.js";
import { createToolHookRuntime } from "./tool-hook-runtime.js";
import { nativeTasksEnabled } from "./task-runtime.js";
import { triBoolean } from "./env-settings.js";
import { createLaunchPlanHost } from "./plan-launch.js";
import { createMcpPermissionPrompt } from "./permission-prompt.js";
import {
  buildQueryEffortSettings,
  firstPartyQueryEffortFacts,
  queryEffortSettingsCap,
  sessionQueryEffort,
  resolveQueryEffort,
  firstPartyLegacyUserEffortApplies,
  queryEffortLabel,
  type QueryEffortSettingsLayer,
} from "./query-model-effort.js";
import type { AgentEvent } from "./types.js";
import {
  SdkSession,
  sdkQueryOutcome,
  type SdkMessage,
  type SdkQuery,
} from "./sdk-messages.js";
import { SdkInputFatal, sdkUserTurns, type SdkUserTurn } from "./sdk-input.js";
import { createBackgroundShells } from "./background-shells.js";
import { createShellHost, interpretExit } from "./bash-tool.js";

const TAU_VERSION = "0.1.0";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Piped input exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    stdout.write(help);
    return;
  }
  if (options.version) {
    stdout.write(`tau ${TAU_VERSION}\n`);
    return;
  }
  const persistence = admitSessionPersistence(
    options.noSessionPersistence,
    isInteractiveLaunch(process.argv.slice(2), Boolean(stdout.isTTY)),
  );
  if (!persistence.ok) {
    stderr.write(`${persistence.error}\n`);
    process.exitCode = 1;
    return;
  }
  const cwd = await realpath(options.cwd);
  const interactive = !options.print && Boolean(stdin.isTTY && stdout.isTTY);
  const flagError = printProtocolFlagError(options, interactive);
  if (flagError) {
    stderr.write(`${flagError}\n`);
    process.exitCode = 1;
    return;
  }
  const streamInput = options.inputFormat === "stream-json";
  const launch = await loadLaunchConfiguration(options, {
    cwd,
    nonInteractive: !interactive,
  });
  const policy = combineToolPolicy(
    options.toolPolicy,
    launch.snapshot.permissionRules,
  );
  const plugins = await loadLaunchPlugins({
    cwd,
    directories: options.pluginDirectories,
    launch,
    onDiagnostic: (message) => stderr.write(`Plugins: ${safe(message)}\n`),
  });
  for (const diagnostic of launch.snapshot.diagnostics)
    stderr.write(
      `Settings: ${safe(diagnostic.message)}${diagnostic.path ? ` (${safe(diagnostic.path)})` : ""}\n`,
    );
  if (interactive && options.format !== "text")
    throw new Error("Structured output requires --print or piped input");
  if (interactive && options.maxThinkingTokens !== undefined)
    throw new Error("--max-thinking-tokens requires print or piped mode");
  const prompt = streamInput
    ? ""
    : [options.prompt, !stdin.isTTY ? await readStdin() : ""]
        .filter(Boolean)
        .join("\n\n")
        .trim();
  if (!interactive && !prompt && !streamInput)
    throw new Error("Provide a prompt with -p or on stdin");
  if (!interactive && options.format === "stream-json" && !options.verbose) {
    stderr.write(
      "Error: When using --print, --output-format=stream-json requires --verbose\n",
    );
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error(
      "Set ANTHROPIC_API_KEY; tau does not use Claude Code credentials",
    );
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const effortLayers: QueryEffortSettingsLayer[] =
    launch.snapshot.documents.flatMap((document) =>
      document.effective === undefined
        ? []
        : [{ source: document.source, ...document.effective }],
    );
  const modelIdentity = (model: string) =>
    resolveModelFacts(resolveDirectSkillModelAlias(model)).canonical;
  const effortTable = buildQueryEffortSettings(effortLayers, modelIdentity);
  const effortFacts = (model: string) =>
    firstPartyQueryEffortFacts(resolveModelFacts(model).wire);
  const effortSelection = (model: string) => {
    const facts = effortFacts(model),
      cap = queryEffortSettingsCap(effortLayers, model, modelIdentity);
    const selected = sessionQueryEffort({
      table: effortTable,
      model,
      identity: modelIdentity,
      legacyUserApplies:
        firstPartyLegacyUserEffortApplies(resolveModelFacts(model).wire) ??
        false,
    });
    return {
      ...(facts ? { defaults: facts.defaults } : {}),
      ...(cap === undefined ? {} : { settingsCap: cap }),
      ...(selected === undefined ? {} : { sessionEffort: selected }),
    };
  };
  const provider = new AnthropicProvider({
    apiKey,
    maxRetries: options.maxRetries,
    allowNonStreamingFallback: options.allowNonStreamingFallback,
    ...(baseUrl ? { baseUrl } : {}),
    ...(launch.fallbackModel ? { fallbackModel: launch.fallbackModel } : {}),
    queryEffortPolicy: {
      capabilities: (model) => effortFacts(model)?.capabilities,
      selection: (request) => effortSelection(request.model),
    },
    thinking: {
      ...(options.thinking ? { mode: options.thinking } : {}),
      ...(options.maxThinkingTokens === undefined
        ? {}
        : { maxThinkingTokens: options.maxThinkingTokens }),
    },
  });
  const store = await SessionStore.create(cwd, undefined, {
    persist: !persistence.sessionPersistenceDisabled,
  });
  if (options.sessionId !== undefined && (await store.has(options.sessionId))) {
    stderr.write(`Error: Session ID ${options.sessionId} is already in use.\n`);
    process.exitCode = 1;
    return;
  }
  let session = options.resume
    ? options.resume.trim().toLowerCase().endsWith(".jsonl")
      ? (
          await importNativeSessionFile({
            path: options.resume,
            cwd,
            model: launch.model,
            signal: new AbortController().signal,
          })
        ).session
      : await store.load(options.resume)
    : options.continue
      ? await store.latest()
      : newSession(cwd, launch.model, options.sessionId);
  if (options.modelExplicit) session.model = options.model;
  let queryModelForTools = session.model;
  let mode =
    !options.modeExplicit && session.planState?.active
      ? ("plan" as const)
      : launch.mode;
  let readState = new ReadState();
  let promptBody = "";
  const system = () =>
    options.systemPromptSnapshot === false
      ? promptBody
      : (session.systemPrompt ?? promptBody);
  /** Renders the body for this query's tools, then the request's system blocks. */
  const requestSystem = (
    tools: import("./types.js").ToolExecutor,
    model: string,
  ) => {
    const skills = skillHost?.runtime.catalog("model") ?? [];
    promptBody = renderSystemPrompt(
      {
        model,
        tools: new Set([
          ...tools.definitions.map((tool) => tool.name),
          ...(tools.deferredToolNames?.() ?? []),
        ]),
        hasSkills: skills.length > 0,
        interactive,
        env: process.env,
      },
      {
        replacement: options.systemPrompt,
        append: options.appendSystemPrompt,
      },
    );
    if (options.systemPromptSnapshot !== false)
      session.systemPrompt ??= promptBody;
    return systemPromptBlocks({
      header: billingHeader(
        firstPromptText(session.messages),
        promptEntrypoint(process.env, interactive),
        process.env,
      ),
      identity: identityLine({
        interactive,
        appendSystemPrompt: options.appendSystemPrompt !== undefined,
      }),
      body: system(),
    });
  };
  const turnReminders = async () =>
    turnStartReminders(
      {
        cwd,
        git: await gitFacts(cwd),
        platform: process.platform,
        bashShell: describedShell(process.env) ?? "/bin/sh",
        osVersion: `${osType()} ${release()}`,
        model: currentModel(),
        date: localDate(new Date()),
        attribution: attributionTexts(
          currentModel(),
          launch.snapshot.effective,
        ),
        env: process.env,
      },
      session.messages,
    );
  const terminal = interactive
    ? createInterface({ input: stdin, output: stdout })
    : undefined;
  let active: AbortController | undefined;
  let mcp: McpManager | undefined;
  let mcpServerNames: string[] = [];
  let permissionPrompt:
    ReturnType<typeof createMcpPermissionPrompt> | undefined;
  let closing = false;
  const interrupt = () => {
    if (active) {
      active.abort();
      stderr.write("\nCancelling…\n");
    } else {
      closing = true;
      terminal?.close();
    }
  };
  process.on("SIGINT", interrupt);
  terminal?.on("SIGINT", interrupt);
  terminal?.on("close", () => {
    closing = true;
    active?.abort();
  });
  const approve = async (description: string): Promise<boolean> => {
    if (!terminal || closing || active?.signal.aborted) return false;
    const answer = await terminal.question(
      `\n${safe(description)}\nAllow once? [y/N] `,
      active ? { signal: active.signal } : {},
    );
    return /^(y|yes)$/i.test(answer.trim());
  };
  const createHookHost = () => {
    const hookSessionId = session.id;
    const personalConfigRestricted =
      triBoolean(process.env.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG) === true;
    const hookProvenance = () =>
      ordinaryDirectAgentDefinitionHookProvenance({ personalConfigRestricted });
    const sources: HookSource[] = launch.snapshot.documents.flatMap(
      (document) => {
        if (
          document.source !== "policySettings" &&
          pluginCustomizationOnly(
            launch.snapshot.policy.strictPluginOnlyCustomization,
            "hooks",
          )
        )
          return [];
        if (
          document.effective?.hooks === undefined ||
          ((document.source === "projectSettings" ||
            document.source === "localSettings") &&
            !launch.workspace.currentWorkspaceTrusted)
        )
          return [];
        return [
          {
            source: document.source,
            hooks: document.effective.hooks,
            managed: document.source === "policySettings",
            ...(document.path === undefined ? {} : { path: document.path }),
          },
        ];
      },
    );
    const settings = {
      disabled: launch.snapshot.effective.disableAllHooks === true,
      managedOnly: launch.snapshot.policy.allowManagedHooksOnly === true,
      strictPluginOnly: pluginCustomizationOnly(
        launch.snapshot.policy.strictPluginOnlyCustomization,
        "hooks",
      ),
    };
    const base = createHookRegistry([...sources, ...plugins.hookSources], {
        ...settings,
        consumeOnce: false,
      }),
      skillHooks = new SessionSkillHookRegistry(settings);
    // Sessions without hooks retain their existing restricted permission mode.
    // Executing actual restricted hooks requires the native arbitration adapter.
    if (
      personalConfigRestricted &&
      !settings.disabled &&
      base
        .list()
        .some(
          (entry) =>
            !settings.managedOnly ||
            entry.origin.managed === true ||
            entry.origin.source === "policySettings",
        )
    )
      hookProvenance();
    const rootSkills = createSkillHookExecutionRegistry(
      skillHooks,
      () => hookSessionId,
    );
    const settingsBackend = {
      id: "settings",
      registry: base,
      nativeOrigin: (entry: import("./hooks.js").HookDispatchCandidate) => ({
        namespace: "hook" as const,
        ...(entry.origin.pluginRoot === undefined
          ? {}
          : { pluginRoot: entry.origin.pluginRoot }),
      }),
    };
    const skillOrigin = (
      entry: import("./hooks.js").HookDispatchCandidate,
    ) => ({
      namespace: "hook" as const,
      ...(entry.origin.pluginRoot === undefined
        ? {}
        : { skillRoot: entry.origin.pluginRoot }),
    });
    const registry = createReducedScopedHookRegistry({
      ownerSessionId: hookSessionId,
      defaultShell: "bash",
      personalConfigRestricted: false,
      backends: () => [
        settingsBackend,
        { id: "root-skill", registry: rootSkills, nativeOrigin: skillOrigin },
      ],
    });
    const definitionScopes = new Map<
      string,
      ReturnType<typeof createAgentDefinitionHookScope>
    >();
    const childSkills = new Map<
      string,
      ReturnType<typeof createSkillHookExecutionRegistry>
    >();
    const childDispatchers = new Map<
      string,
      ReturnType<typeof createReducedScopedHookRegistry>
    >();
    const originResolver = createAgentHookOriginResolver({
      context: () => ({
        persistedTrustEnabled: !options.ignorePersistedTrust,
        ...(launch.trustedProjectKeys === undefined
          ? {}
          : { trustedProjectKeys: launch.trustedProjectKeys }),
        workspaceRoots: [cwd],
      }),
      resolveProjectIdentity: (folder, signal) => {
        signal.throwIfAborted();
        const identity = resolveWorkspaceProjectIdentity(folder);
        signal.throwIfAborted();
        return identity;
      },
      // This ordinary local host has no workspace restriction state or added
      // restricted roots (native Qpr=null and its separate root map is empty).
      restrictedProjectKey: () => false,
    });
    const definitionTrusted = (
      definition: Readonly<
        import("./agent-definitions.js").LocalAgentDefinition
      >,
      signal: AbortSignal,
    ) => originResolver.trusted(definition, signal);
    const definitionScope = (
      plan: Readonly<import("./subagent-runtime.js").SubagentPlan>,
      owningPolicy: () => import("./tool-policy.js").ToolPolicy,
    ) => {
      const existing = definitionScopes.get(plan.agentId);
      if (existing) return existing;
      const scope = createAgentDefinitionHookScope({
        agentId: plan.agentId,
        ownerSessionId: hookSessionId,
        definition: plan.definition,
        policy: () => settings,
        admitDefinition: (_definition, signal) => {
          signal.throwIfAborted();
          return !inheritedReadDeny(owningPolicy());
        },
        admitOrigin: (definition, signal) => {
          signal.throwIfAborted();
          // Managed-only command policy excludes session frontmatter, including
          // policy-source definitions; no restricted execution facts are needed.
          return !settings.managedOnly && definitionTrusted(definition, signal);
        },
        provenance: () => {
          const provenance = hookProvenance();
          return {
            personal: provenance.personal,
            checkout: provenance.checkout,
          };
        },
        admitExecution: ({ definition, signal }) => {
          signal.throwIfAborted();
          return definitionTrusted(definition, signal);
        },
        defaultShell: "bash",
      });
      definitionScopes.set(plan.agentId, scope);
      return scope;
    };
    const childRegistry = (
      plan: Readonly<import("./subagent-runtime.js").SubagentPlan>,
    ) => {
      const cached = childDispatchers.get(plan.agentId);
      if (cached) return cached;
      const skills = createSkillHookExecutionRegistry(
        skillHooks,
        () => plan.agentId,
        {
          ownerSessionId: () => hookSessionId,
        },
      );
      childSkills.set(plan.agentId, skills);
      const dispatcher = createReducedScopedHookRegistry({
        ownerSessionId: hookSessionId,
        defaultShell: "bash",
        personalConfigRestricted: false,
        backends: () => {
          const scope = definitionScopes.get(plan.agentId);
          return [
            settingsBackend,
            { id: "child-skill", registry: skills, nativeOrigin: skillOrigin },
            ...(scope
              ? [
                  {
                    id: "definition",
                    registry: scope.registry,
                    nativeOrigin: () => ({ namespace: "hook" as const }),
                  },
                ]
              : []),
          ];
        },
      });
      childDispatchers.set(plan.agentId, dispatcher);
      return dispatcher;
    };
    const childContext = (
      plan: Readonly<import("./subagent-runtime.js").SubagentPlan>,
    ) => {
      const facts = effortFacts(plan.model),
        effort =
          facts &&
          resolveQueryEffort({
            ...effortSelection(plan.model),
            capabilities: facts.capabilities,
            ...(process.env.CLAUDE_CODE_EFFORT_LEVEL === undefined
              ? {}
              : { environment: process.env.CLAUDE_CODE_EFFORT_LEVEL }),
            ...(plan.effort === undefined ? {} : { turnEffort: plan.effort }),
          });
      return {
        session_id: hookSessionId,
        transcript_path: store.pathFor(hookSessionId),
        cwd,
        permission_mode: plan.permissionMode,
        agent_id: plan.agentId,
        agent_type: plan.definition.agentType,
        ...(typeof effort === "string" ? { effort: { level: effort } } : {}),
      };
    };
    const stopCap = Number.parseInt(
      process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "8",
      10,
    );
    const agentLifecycle = createSubagentLifecycle({
      registryForStart: () => registry,
      registryForStop: childRegistry,
      context: (plan) =>
        plan
          ? childContext(plan)
          : {
              session_id: hookSessionId,
              transcript_path: store.pathFor(hookSessionId),
              cwd,
            },
      childTranscriptPath: (plan) =>
        store.subagentPathFor(plan.parent.sessionId, plan.agentId),
      stopBlockCap: Number.isFinite(stopCap) ? stopCap : 8,
      runOptions: () => ({
        cwd,
        projectDir: cwd,
        env: process.env,
        maxOutputBytes: 16 * 1024 * 1024,
        attended: interactive,
      }),
      onDiagnostic: (message) => stderr.write(`Hooks: ${safe(message)}\n`),
    });
    let revision = 0;
    const host = createSessionHookHost({
      registry,
      context: () => ({
        session_id: hookSessionId,
        transcript_path: store.pathFor(hookSessionId),
        cwd,
        permission_mode: mode,
      }),
      runOptions: () => ({
        cwd,
        projectDir: cwd,
        env: process.env,
        maxOutputBytes: 16 * 1024 * 1024,
        attended: interactive,
        // Source lY `zs`: interactive or streaming input. Print runs keep a lone asyncRewake synchronous.
        asyncRewakeBackgrounds: interactive || streamInput,
      }),
      onDiagnostic: (message) => stderr.write(`Hooks: ${safe(message)}\n`),
      asyncHooks: {
        enqueueWake: (wake) =>
          notifications.push({ sessionId: hookSessionId, text: wake.value }),
        homeDir: homedir(),
        posixShell: (hook) =>
          hook.shell !== "powershell" && !process.env.CLAUDE_CODE_SHELL_PREFIX,
      },
    });
    return {
      ...host,
      async close() {
        await host.close();
        await Promise.allSettled(
          [...childDispatchers.values()].map((value) => value.close()),
        );
        await Promise.allSettled([
          base.close(),
          rootSkills.close(),
          ...[...childSkills.values()].map((value) => value.close()),
          ...[...definitionScopes.values()].map((value) => value.close()),
        ]);
      },
      definitionScope,
      agentLifecycle,
      get hasToolHooks() {
        return host.hasToolHooks;
      },
      get revision() {
        return revision;
      },
      childTask: (
        plan: Readonly<import("./subagent-runtime.js").SubagentPlan>,
        event: "TaskCreated" | "TaskCompleted",
        task: { taskId: string; subject: string; description: string },
        signal: AbortSignal,
      ) =>
        createSessionHookHost({
          registry: childRegistry(plan),
          context: () => childContext(plan),
          runOptions: () => ({
            cwd,
            projectDir: cwd,
            env: process.env,
            maxOutputBytes: 16 * 1024 * 1024,
            attended: interactive && !plan.isAsync,
          }),
          onDiagnostic: (message) => stderr.write(`Hooks: ${safe(message)}\n`),
        }).task(event, task, signal),
      childRuntime: (
        plan: Readonly<import("./subagent-runtime.js").SubagentPlan>,
      ) =>
        createToolHookRuntime({
          registry: childRegistry(plan),
          context: () => childContext(plan),
          runOptions: () => ({
            cwd,
            projectDir: cwd,
            env: process.env,
            maxOutputBytes: 16 * 1024 * 1024,
            attended: interactive,
          }),
          onDiagnostic: (message) => stderr.write(`Hooks: ${safe(message)}\n`),
        }),
      registerSkillHooks: (
        request: import("./skill-hook-registry.js").SkillHookRequest,
      ) => {
        if (settings.disabled || settings.managedOnly)
          return skillHooks.register(request);
        const provenance = hookProvenance();
        const result = skillHooks.register({
          ...request,
          personal: provenance.personal,
          checkout: provenance.checkout,
        });
        if (result.registered) revision++;
        return result;
      },
    };
  };
  let hookHost: ReturnType<typeof createHookHost> | undefined;
  let skillHost: Awaited<ReturnType<typeof createSessionSkillHost>> | undefined;
  let taskHost: ReturnType<typeof createSessionTaskHost> | undefined;
  let agentHost: Awaited<ReturnType<typeof createSessionAgentHost>> | undefined;
  const agentHosts: Awaited<ReturnType<typeof createSessionAgentHost>>[] = [];
  const agentConcurrencySlots = new Set<string>();
  const retiredHookHosts: ReturnType<typeof createHookHost>[] = [];
  const notifications: { sessionId: string; text: string }[] = [];
  const notificationSessions = new Map<string, string>();
  const commitNotifications = () => {
    const ready = notifications
      .splice(0)
      .filter((entry) => entry.sessionId === session.id);
    for (const entry of ready)
      session.messages.push({
        role: "user",
        origin: "task-notification",
        content: [{ type: "text", text: entry.text }],
      });
    return ready.length;
  };
  const shells = createBackgroundShells({
    interpret: interpretExit,
    enqueueNotification: (text) =>
      notifications.push({ sessionId: session.id, text }),
    onDiagnostic: (message) => stderr.write(`Tasks: ${safe(message)}\n`),
  });
  const shellHost = createShellHost({
    startCwd: cwd,
    sessionId: () => session.id,
    session: {
      nonInteractive: !interactive,
      singleShot: !interactive && !streamInput,
    },
    shells,
  });
  const hasBackgroundWork = () =>
    shells.hasRunning ||
    agentHosts.some(
      (host) =>
        host.background?.hasUnsettled ||
        host.background?.hasPendingNotifications,
    );
  const waitForBackground = (signal: AbortSignal) =>
    new Promise<void>((resolveWait, reject) => {
      const unsubscribers: (() => void)[] = [];
      const finish = () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        signal.removeEventListener("abort", abort);
        resolveWait();
      };
      const abort = () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        reject(signal.reason ?? new Error("Interrupted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      unsubscribers.push(shells.subscribe(finish));
      for (const host of agentHosts)
        if (host.background)
          unsubscribers.push(host.background.subscribe(finish));
      if (signal.aborted) abort();
      else if (notifications.length || !hasBackgroundWork()) finish();
    });
  const taskStopTools = (
    plan?: Readonly<import("./subagent-runtime.js").SubagentPlan>,
    hooks?: import("./tool-hook-runtime.js").ToolHookRuntime,
  ) =>
    createBackgroundTaskTools({
      get: (id) =>
        shells.get(id) ??
        agentHosts
          .flatMap((host) => host.background?.list() ?? [])
          .find((task) => task.id === id),
      list: () => [
        ...shells.list(),
        ...agentHosts.flatMap((host) => host.background?.list() ?? []),
      ],
      stop: async (id, request) => {
        request.signal.throwIfAborted();
        if (shells.get(id)) return shells.stop(id);
        const owner = agentHosts.find((host) =>
          host.background?.list().some((task) => task.id === id),
        );
        if (!owner?.background) throw new Error(`No task found with ID: ${id}`);
        return owner.background.stop(id, {
          ...(request.callerAgentId === undefined
            ? {}
            : { callerAgentId: request.callerAgentId }),
          killedBy: request.killedBy,
        });
      },
      context: () =>
        plan === undefined ? {} : { callerAgentId: plan.agentId },
      enabled: () => true,
      policy: () => {
        const current = skillHost?.policy() ?? policy;
        return plan === undefined
          ? current
          : {
              ...current,
              tools: plan.selectedToolNames.filter(
                (name): name is NonNullable<typeof current.tools>[number] =>
                  name === "TaskStop" &&
                  (current.tools === undefined ||
                    current.tools.some((tool) =>
                      ["TaskStop", "KillShell", "KillBash"].includes(tool),
                    )),
              ),
            };
      },
      authorize: async (_call, _context, permission) =>
        permission !== "ask" ||
        (!plan?.isAsync && (await approve("Stop this background task?"))),
      hooks: hooks ?? {
        before: (...args) => activeHooks().runtime.before(...args),
        after: (...args) => activeHooks().runtime.after(...args),
        failure: (...args) =>
          activeHooks().runtime.failure?.(...args) ?? Promise.resolve(),
      },
      onDiagnostic: (message) => stderr.write(`Tasks: ${safe(message)}\n`),
    });
  let planHost: ReturnType<typeof createLaunchPlanHost> | undefined;
  const activeHooks = () => {
    if (!hookHost) throw new Error("Session hooks are not initialized");
    return hookHost;
  };
  const currentModel = () => skillHost?.model(session.model) ?? session.model;
  const currentQueryEffort = () =>
    skillHost?.runtime.queryContext.layers.findLast(
      (layer) => layer.kind === "effort",
    )?.effort;
  const currentEffortDisplay = () => {
    const model = currentModel(),
      facts = effortFacts(model),
      turnEffort = currentQueryEffort();
    const effort =
      facts &&
      resolveQueryEffort({
        ...effortSelection(model),
        capabilities: facts.capabilities,
        ...(process.env.CLAUDE_CODE_EFFORT_LEVEL === undefined
          ? {}
          : { environment: process.env.CLAUDE_CODE_EFFORT_LEVEL }),
        ...(turnEffort === undefined ? {} : { turnEffort }),
      });
    return queryEffortLabel(effort || undefined);
  };
  const createSkills = () =>
    createSessionSkillHost({
      cwd,
      launch,
      policy,
      interactive,
      sessionId: () => session.id,
      mode: () => mode,
      model: currentModel,
      pluginPrompts: plugins.prompts,
      effortLevel: currentEffortDisplay,
      approve,
      ignorePersistedTrust: options.ignorePersistedTrust,
      hooks: {
        before: (...args) => activeHooks().runtime.before(...args),
        after: (...args) => activeHooks().runtime.after(...args),
        failure: (...args) =>
          activeHooks().runtime.failure?.(...args) ?? Promise.resolve(),
      },
      registerHooks: (request) =>
        activeHooks().registerSkillHooks({
          ...request,
          personal: request.source !== "policySettings",
        }),
      onDiagnostic: (message) => stderr.write(`Skills: ${safe(message)}\n`),
    });
  const createTasks = () =>
    createSessionTaskHost({
      userConfigDir: launch.userConfigDir,
      sessionId: session.id,
      ...(process.env.CLAUDE_CODE_TASK_LIST_ID === undefined
        ? {}
        : { environmentListId: process.env.CLAUDE_CODE_TASK_LIST_ID }),
      enabled: () => {
        const tasks = triBoolean(process.env.CLAUDE_CODE_ENABLE_TASKS),
          todoTools = triBoolean(process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS);
        return nativeTasksEnabled({
          canonicalModel: resolveModelFacts(queryModelForTools).canonical,
          ...(tasks === undefined ? {} : { enabled: tasks }),
          ...(todoTools === undefined ? {} : { todoTools }),
        });
      },
      policy: () => skillHost?.policy() ?? policy,
      approve,
      hooks: {
        before: (...args) => activeHooks().runtime.before(...args),
        after: (...args) => activeHooks().runtime.after(...args),
        failure: (...args) =>
          activeHooks().runtime.failure?.(...args) ?? Promise.resolve(),
      },
      lifecycle: (event, task, signal) =>
        activeHooks().task(event, task, signal),
      onDiagnostic: (message) => stderr.write(`Tasks: ${safe(message)}\n`),
    });
  const visibleMcp = () => {
    const manager = mcp;
    return (
      manager && {
        get definitions() {
          return manager.definitions.filter(
            (tool) => tool.name !== options.permissionPromptTool,
          );
        },
        lookup: (name: string) =>
          name === options.permissionPromptTool
            ? undefined
            : manager.lookup(name),
        refreshTools: () => manager.refreshTools(),
        callTool: (name: string, input: unknown, signal: AbortSignal) =>
          manager.callTool(name, input, signal),
      }
    );
  };
  const explorePlanEnabled = createExplorePlanAvailability(
    () => process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS,
  );
  const memoryHost = createLaunchAgentMemoryHost({
    cwd,
    launch,
    model: currentModel,
  });
  const permissionOwners = new Map<
    string,
    ReturnType<typeof createLaunchScopedPermissionHost>
  >();
  const scopedPermissions = (
    owner: string,
    policy: () => import("./tool-policy.js").ToolPolicy,
    mode: () => import("./types.js").PermissionMode,
  ) => {
    let host = permissionOwners.get(owner);
    if (!host) {
      host = createLaunchScopedPermissionHost({ cwd, launch });
      permissionOwners.set(owner, host);
    }
    return host.scope({ policy, mode });
  };
  const createAgents = async () => {
    const owningHooks = activeHooks(),
      ownerSessionId = session.id,
      owningSkills = skillHost,
      owningTasks = taskHost,
      owningPlans = planHost;
    if (!owningSkills || !owningTasks || !owningPlans)
      throw new Error(
        "Session Skill and task hosts must precede agent initialization",
      );
    notificationSessions.set(ownerSessionId, ownerSessionId);
    const builtin = await createBuiltinAgentCatalog({
      profile: builtinAgentProfile({
        headless: !interactive,
        disableBuiltinAgents:
          process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS,
        coordinator: false,
      }),
      promptContext: "subagent",
      safeMode: triBoolean(process.env.CLAUDE_CODE_SAFE_MODE) === true,
      agentViewDisabled:
        Boolean(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW) ||
        launch.snapshot.effective.disableAgentView === true,
      explorePlanEnabled: explorePlanEnabled(),
      entrypoint:
        process.env.CLAUDE_CODE_ENTRYPOINT ?? (interactive ? "cli" : "sdk-cli"),
      guideToolMode: "native-search",
      webFetch: { enabled: false },
      deniedAgentTypes: [],
      isToolDenied: () => false,
      isToolEnabled: () => false,
    });
    const host = await createSessionAgentHost({
      cwd,
      launch,
      provider,
      sessionId: () => ownerSessionId,
      model: currentModel,
      builtinAgents: builtin.definitions,
      memory: memoryHost,
      scopedPermissions: (policy, mode) =>
        scopedPermissions(ownerSessionId, policy, mode),
      definitionHooks: (plan) =>
        owningHooks.definitionScope(plan, () => owningSkills.policy()),
      concurrencySlots: agentConcurrencySlots,
      background: {
        outputFile: (plan) =>
          store.backgroundOutputPathFor(plan.parent.sessionId, plan.agentId),
        persist: (snapshot) => store.saveBackgroundTask(snapshot),
        enqueueNotification: (notification) => {
          notifications.push({
            sessionId:
              notificationSessions.get(ownerSessionId) ?? ownerSessionId,
            text: formatBackgroundNotification(notification),
          });
        },
      },
      pluginAgents: plugins.agents,
      childPlan: (plan, context) =>
        createChildPlanHost({
          cwd,
          sessionId: () => plan.parent.sessionId,
          actor: { agentId: plan.agentId },
          isAsync: plan.isAsync === true,
          fileBacked: true,
          files: owningPlans.files,
          permissions: () => ({
            ...owningPlans.permissions(),
            mode: context.mode(),
          }),
          setSessionPermissions: (update) => owningPlans.setPermissions(update),
          storage: owningPlans.storage,
          enabled: (name) => plan.selectedToolNames.includes(name),
          policy: () => context.policy(),
          hooks: context.hooks,
          canRequestApproval: () =>
            !closing &&
            ((!plan.isAsync && Boolean(terminal)) ||
              options.permissionPromptTool !== undefined),
          authorize: ({ call, hookPermission }) =>
            matchingToolRule(context.policy(), "ask", call.name, {
              input: call.input,
            }) || hookPermission === "ask"
              ? { behavior: "ask" }
              : { behavior: "allow" },
          approve: async ({ call, permission, signal }) => {
            signal.throwIfAborted();
            if (options.permissionPromptTool !== undefined) {
              if (!permissionPrompt)
                return {
                  approved: false,
                  reason:
                    "The configured MCP permission prompt tool is unavailable",
                };
              const result = await permissionPrompt.request(call, signal);
              if (result.interrupt)
                active?.abort(
                  new Error(
                    result.reason ?? "Permission prompt requested interruption",
                  ),
                );
              return result;
            }
            return {
              approved:
                !plan.isAsync &&
                (await approve(
                  `${permission.plan ? `Plan:\n${permission.plan}\n\n` : ""}Approve ${permission.tool} for ${plan.definition.agentType}?`,
                )),
            };
          },
          vetDirectory: (canonical) =>
            !canonical
              .split(/[\\/]/)
              .some(
                (part) =>
                  part === ".git" || part === "node_modules" || part === ".tau",
              ),
          onDiagnostic: (message) => stderr.write(`Plans: ${safe(message)}\n`),
        }),
      childCapabilities: (plan, context) =>
        createChildCapabilityTools({
          cwd,
          launch,
          agentId: plan.agentId,
          agentType: plan.definition.agentType,
          isAsync: plan.isAsync === true,
          sessionId: () => plan.parent.sessionId,
          selectedToolNames: plan.selectedToolNames,
          policy: context.policy,
          mode: context.mode,
          model: () => plan.model,
          effort: () => plan.effort,
          hooks: context.hooks,
          interactive,
          approve,
          registry: owningSkills.registry,
          env: process.env,
          signal: context.signal,
          ignorePersistedTrust: options.ignorePersistedTrust,
          effortLevel: ({ model, effort: turnEffort }) => {
            const facts = effortFacts(model);
            if (!facts) return undefined;
            const effort = resolveQueryEffort({
              ...effortSelection(model),
              capabilities: facts.capabilities,
              ...(process.env.CLAUDE_CODE_EFFORT_LEVEL === undefined
                ? {}
                : { environment: process.env.CLAUDE_CODE_EFFORT_LEVEL }),
              ...(turnEffort === undefined ? {} : { turnEffort }),
            });
            return queryEffortLabel(effort || undefined);
          },
          registerSkillHooks: (request) =>
            owningHooks.registerSkillHooks({
              ...request,
              personal: request.source !== "policySettings",
            }),
          publishSessionCommandDenies: (rules) => {
            combineToolPolicy(
              owningSkills.policy(),
              rules.map((rule) => ({
                rule,
                behavior: "deny" as const,
                source: "command",
              })),
            );
            owningSkills.runtime.appendCommandDenies(rules);
          },
          preloadRender: (skill, request) =>
            owningSkills.renderPreload(skill.name, {
              sessionId: plan.parent.sessionId,
              signal: request.signal,
              effortLevel: currentEffortDisplay(),
            }),
          tasks: {
            store: owningTasks.store,
            enabled: () =>
              plan.selectedToolNames.some((name) =>
                ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList"].includes(
                  name,
                ),
              ),
            lifecycle: {
              created: async ({ task, signal }) => ({
                blockingErrors: await owningHooks.childTask(
                  { ...plan, permissionMode: context.mode() },
                  "TaskCreated",
                  {
                    taskId: task.id,
                    subject: task.subject,
                    description: task.description,
                  },
                  signal,
                ),
              }),
              completed: async ({ task, signal }) => ({
                blockingErrors: await owningHooks.childTask(
                  { ...plan, permissionMode: context.mode() },
                  "TaskCompleted",
                  {
                    taskId: task.id,
                    subject: task.subject,
                    description: task.description,
                  },
                  signal,
                ),
              }),
            },
          },
          onDiagnostic: (message) => stderr.write(`Agents: ${safe(message)}\n`),
        }),
      lifecycle: {
        start: (...args) => owningHooks.agentLifecycle.start(...args),
        stop: (...args) => owningHooks.agentLifecycle.stop(...args),
        teardown: (...args) => owningHooks.agentLifecycle.teardown(...args),
        cleanup: (...args) => owningHooks.agentLifecycle.cleanup(...args),
        finishQuery: (...args) =>
          owningHooks.agentLifecycle.finishQuery(...args),
        resetContinuationCount: (...args) =>
          owningHooks.agentLifecycle.resetContinuationCount(...args),
      },
      mode: () => mode,
      policy: () => skillHost?.policy() ?? policy,
      system,
      approve,
      hooks: {
        before: (...args) => owningHooks.runtime.before(...args),
        after: (...args) => owningHooks.runtime.after(...args),
        failure: (...args) =>
          owningHooks.runtime.failure?.(...args) ?? Promise.resolve(),
      },
      childHooks: (plan) => owningHooks.childRuntime(plan),
      externalTools: (base, mode, policy, hooks, context) => {
        const external = visibleMcp();
        return external
          ? routeExternalTools(base, external, {
              mode,
              policy,
              hooks,
              approve: context?.isAsync ? async () => false : approve,
            })
          : base;
      },
      taskTools: (base, plan, hooks) => taskStopTools(plan, hooks).wrap(base),
      saveChild: (plan, messages, status) =>
        store.saveSubagent({
          version: 1,
          parentSessionId: plan.parent.sessionId,
          agentId: plan.agentId,
          agentType: plan.definition.agentType,
          cwd,
          model: plan.model,
          updatedAt: new Date().toISOString(),
          messages,
          status,
        }),
      onDiagnostic: (message) => stderr.write(`Agents: ${safe(message)}\n`),
    });
    agentHosts.push(host);
    return host;
  };
  const createPlans = () => {
    const owningSession = session;
    return createLaunchPlanHost({
      cwd,
      userConfigDir: launch.userConfigDir,
      ...(typeof launch.snapshot.effective.plansDirectory === "string"
        ? { configuredDirectory: launch.snapshot.effective.plansDirectory }
        : {}),
      sessionId: () => owningSession.id,
      saved: () => owningSession.planState,
      save: (state) => {
        owningSession.planState = state;
      },
      mode: () => mode,
      setMode: (next) => {
        mode = next;
      },
      policy: () => skillHost?.policy() ?? policy,
      canRequestApproval: () =>
        !closing &&
        (Boolean(terminal) || options.permissionPromptTool !== undefined),
      approve,
      ...(options.permissionPromptTool === undefined
        ? {}
        : {
            requestApproval: async (
              call: import("./types.js").ToolUse,
              signal: AbortSignal,
            ) => {
              if (!permissionPrompt)
                return {
                  approved: false,
                  reason:
                    "The configured MCP permission prompt tool is not available",
                };
              const reply = await permissionPrompt.request(call, signal);
              if (reply.interrupt)
                active?.abort(
                  new Error(
                    reply.reason ?? "Permission prompt requested interruption",
                  ),
                );
              if (reply.updatedPermissions?.length)
                stderr.write(
                  "Permissions: approval metadata updates are not yet applied by this CLI.\n",
                );
              return reply;
            },
          }),
      hooks: {
        before: (...args) => activeHooks().runtime.before(...args),
        after: (...args) => activeHooks().runtime.after(...args),
        failure: (...args) =>
          activeHooks().runtime.failure?.(...args) ?? Promise.resolve(),
      },
      // This legacy result field refers to the subagent Agent tool, not Task CRUD.
      hasTaskTool: () => agentHost?.available() ?? false,
      onDiagnostic: (message) => stderr.write(`Plans: ${safe(message)}\n`),
    });
  };
  const createInstructions = () =>
    new InstructionContext({
      cwd,
      catalog: createInstructionCatalog({
        cwd,
        userConfigDir: launch.userConfigDir,
        ...(launch.managedRoot === undefined
          ? {}
          : { managedRoot: launch.managedRoot }),
        importHome: launch.importHome,
        sources: {
          user: launch.snapshot.enabledSources.includes("userSettings"),
          project: launch.snapshot.enabledSources.includes("projectSettings"),
          local: launch.snapshot.enabledSources.includes("localSettings"),
        },
        ...(typeof launch.snapshot.effective.claudeMdExcludes === "object" &&
        Array.isArray(launch.snapshot.effective.claudeMdExcludes)
          ? {
              excludePatterns:
                launch.snapshot.effective.claudeMdExcludes.filter(
                  (value): value is string => typeof value === "string",
                ),
            }
          : {}),
        managedInstructionsOnly:
          launch.snapshot.effective.managedInstructionsOnly === true,
        ...(typeof launch.snapshot.policy.claudeMd === "string"
          ? {
              managedInline: [
                {
                  path: "[managed settings instructions]",
                  content: launch.snapshot.policy.claudeMd,
                },
              ],
            }
          : {}),
        readPolicy: (_path, _canonical, kind) =>
          kind === "Managed" || kind === "User" || !inheritedReadDeny(policy),
        approveExternalImport: ({ path, parent }) =>
          approve(`Load instruction import ${path} from ${parent}?`),
      }),
      model: currentModel,
      contextWindow: () => provider.contextWindowTokens(currentModel()),
      onDiagnostic: (message) =>
        stderr.write(`Instructions: ${safe(message)}\n`),
    });
  let instructions = createInstructions();
  const webTools = createWebTools({
    mode: () => mode,
    policy: () => skillHost?.policy() ?? policy,
    hooks: () =>
      activeHooks().hasToolHooks ? activeHooks().runtime : undefined,
    approve,
    fetch: {
      skipPreflight: () =>
        launch.snapshot.effective.skipWebFetchPreflight === true,
      applyPrompt: async (userPrompt, signal) => {
        const model = webFetchModel(
          currentModel(),
          process.env,
          resolveDirectModelAlias("haiku"),
        );
        const completion = await provider.complete({
          model,
          system: "",
          messages: [
            { role: "user", content: [{ type: "text", text: userPrompt }] },
          ],
          tools: [],
          maxTokens: defaultOutputTokens(model),
          thinking: { mode: "disabled", mechanical: true },
          disablePromptCaching: true,
          temperature: 1,
          signal,
          onText: () => {},
        });
        return completion.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
      },
    },
    search: {
      send: (body, signal) => provider.postMessages(body, signal),
      model: currentModel,
      maxTokens: defaultOutputTokens,
    },
  });
  const createSessionTools = async () => {
    await mcp?.refreshTools();
    let cached: import("./types.js").ToolExecutor | undefined,
      cachedPolicy: string | undefined;
    const base = () => {
      const currentPolicy = skillHost?.policy() ?? policy;
      const key = JSON.stringify([currentPolicy, activeHooks().revision, mode]);
      if (cached && cachedPolicy === key) return cached;
      const planPath = planHost?.location();
      const memoryAccess = memoryHost.fileAccess(
        () => currentPolicy,
        () => mode,
      );
      const builtins = createTools({
        cwd,
        mode,
        policy: currentPolicy,
        readState,
        ...scopedPermissions(
          session.id,
          () => skillHost?.policy() ?? policy,
          () => mode,
        ),
        restorationExcludedPaths: [
          ...instructions.excludedPaths,
          ...(planPath ? [planPath] : []),
        ],
        ...(planHost ? planHost.access : {}),
        memoryFileAllowance: memoryAccess.memoryFileAllowance,
        extraPathAdmission: async (request) => {
          const planned = await planHost?.access.extraPathAdmission(request);
          if (planned !== undefined) return planned;
          const memory = await memoryAccess.extraPathAdmission(request);
          if (memory !== undefined) return memory;
          if (request.operation !== "Read") return undefined;
          const path = resolve(request.requestedPath);
          return shells.list().some((task) => task.outputFile === path) ||
            agentHosts.some((host) =>
              host.background?.list().some((task) => task.outputFile === path),
            )
            ? path
            : undefined;
        },
        onFileToolCall: ({ name, path }) => {
          if (
            name === "Write" ||
            triBoolean(process.env.CLAUDE_CODE_SIMPLE) !== true
          )
            skillHost?.runtime.activateForPaths(
              [path],
              launch.workspace.gitRoot ?? cwd,
            );
        },
        sensitiveWritePaths: launch.snapshot.documents.flatMap((document) =>
          document.path === undefined ? [] : [document.path],
        ),
        ...(activeHooks().hasToolHooks ? { hooks: activeHooks().runtime } : {}),
        readTokenCounter: (text, signal) =>
          provider.countFileTokens({ model: currentModel(), text, signal }),
        approve,
        shell: shellHost,
      });
      const external = visibleMcp();
      const combined = external
        ? routeExternalTools(builtins, external, {
            mode,
            policy: currentPolicy,
            approve,
            ...(activeHooks().hasToolHooks
              ? { hooks: activeHooks().runtime }
              : {}),
          })
        : builtins;
      cachedPolicy = key;
      return (cached = activeHooks().wrap(
        instructions.wrap(
          taskStopTools().wrap(
            webTools.wrap(taskHost?.wrap(combined) ?? combined),
          ),
          session.messages,
          readState,
        ),
        session.messages,
      ));
    };
    let completeTools: import("./types.js").ToolExecutor | undefined;
    const agentTools = agentHost
      ? agentHost.wrap(
          base,
          () => completeTools?.definitions ?? base().definitions,
        )
      : undefined;
    const withAgents = () => agentTools ?? base();
    const wrapped = skillHost
      ? skillHost.runtime.wrap(withAgents, session.messages)
      : withAgents();
    const planned = planHost
      ? planHost.wrap(wrapped, session.messages)
      : wrapped;
    completeTools = planned;
    const notified = {
      ...planned,
      get definitions() {
        return planned.definitions;
      },
      beforeModelRequest: async (signal: AbortSignal) => {
        await planned.beforeModelRequest?.(signal);
        signal.throwIfAborted();
        commitNotifications();
      },
    };
    return wrapCatalogTools(notified, session.messages, {
      agents: () => agentHost?.catalog() ?? [],
      skills: () => skillHost?.runtime.catalog("model") ?? [],
      skillBudget: {
        contextTokens: provider.contextWindowTokens(currentModel()),
      },
      toolSearch: {
        enabled: () => {
          const current = skillHost?.policy() ?? policy;
          return (
            toolSearchEnabled(process.env, queryModelForTools) &&
            (current.tools === undefined ||
              current.tools.includes(TOOL_SEARCH)) &&
            matchingToolRule(current, "deny", TOOL_SEARCH) === undefined
          );
        },
        alwaysLoad: (name) => mcp?.lookup(name)?.alwaysLoad === true,
      },
    });
  };
  const sdk =
    options.format === "text"
      ? undefined
      : new SdkSession({
          version: TAU_VERSION,
          includePartialMessages: options.includePartialMessages,
          usageSinceLastResult: options.format === "stream-json",
          limits: (model) => ({
            contextWindow: provider.contextWindowTokens(model),
            maxOutputTokens: defaultOutputTokens(model),
          }),
        });
  const sdkTranscript: SdkMessage[] = [];
  const emit = (messages: readonly SdkMessage[]) => {
    for (const message of messages)
      if (options.format === "stream-json")
        stdout.write(JSON.stringify(message) + "\n");
      else if (options.verbose) sdkTranscript.push(message);
  };
  const turn = async (
    input: string | SdkUserTurn["content"],
  ): Promise<void> => {
    active = new AbortController();
    const turnSignal = active.signal;
    const historyStart = session.messages.length;
    let text = "";
    let committedText = "";
    let provisionalText = "";
    let failure: string | undefined, failureError: unknown;
    // Each query (the prompt's, then one per drained notification) ends in its own result.
    let sdkQuery: SdkQuery | undefined,
      queryStart = historyStart;
    const finalText = (start: number) => {
      const last = session.messages
        .slice(start)
        .findLast((message) => message.role === "assistant")
        ?.content.at(-1);
      return last?.type === "text" ? last.text : "";
    };
    const onEvent = (event: AgentEvent) => {
      if (sdkQuery) emit(sdkQuery.accept(event));
      switch (event.type) {
        case "usage":
          session.usage.input_tokens += event.usage.input_tokens;
          session.usage.output_tokens += event.usage.output_tokens;
          break;
        case "text":
          text += event.text;
          provisionalText += event.text;
          if (options.format === "text" && interactive)
            stdout.write(safe(event.text));
          break;
        case "text_reset":
          text = committedText + event.text;
          if (options.format === "text" && provisionalText !== event.text) {
            if (interactive) {
              stdout.write(
                replaceProvisional(
                  provisionalText,
                  event.text,
                  stdout.columns ?? 80,
                ),
              );
            }
          }
          provisionalText = event.text;
          break;
        case "assistant":
          committedText = text;
          provisionalText = "";
          break;
        case "warning":
          stderr.write(`\n${safe(event.message)}\n`);
          break;
        case "thinking_stripped":
        case "model_request":
        case "stream_event":
        case "api_error":
          break;
        case "compaction":
          if (options.format === "text") {
            if (event.stage === "start")
              stderr.write("\nCompacting conversation context...\n");
            else if (event.stage === "complete")
              stderr.write(
                `Context compacted (${event.beforeTokens} → ${event.afterTokens} estimated tokens).\n`,
              );
            else if (event.stage === "failed")
              stderr.write(
                "Context compaction failed; original conversation preserved.\n",
              );
          }
          break;
        case "tool_start":
          if (options.format === "text")
            stderr.write(
              `\n[${safe(event.tool.name)}] ${safe(JSON.stringify(event.tool.input)).slice(0, 500)}\n`,
            );
          break;
        case "tool_result":
          if (options.format === "text")
            stderr.write(
              `${event.result.is_error ? "[tool error] " : ""}${safe(event.result.content).slice(0, 1200)}\n`,
            );
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(`Unknown event: ${String(exhaustive)}`);
        }
      }
    };
    try {
      skillHost?.runtime.resetQuery(session.messages);
      const userMessage: import("./types.js").Message = {
        role: "user",
        content:
          typeof input === "string" ? [{ type: "text", text: input }] : input,
      };
      await instructions.announce(userMessage, session.messages);
      prependReminders(userMessage, await turnReminders());
      turnSignal.throwIfAborted();
      session.messages.push(userMessage);
      const command =
        typeof input === "string"
          ? /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input)
          : null;
      const commandName = command?.[1];
      if (command && commandName !== undefined && skillHost?.has(commandName)) {
        const execution = await skillHost.runtime.invokeUser(
          commandName,
          command[2],
          turnSignal,
        );
        session.messages.push(...execution.newMessages);
      }
      // The original scheduler selects its primary model at query entry.
      // Inline Skill layers update tool context without rerouting later API rounds.
      const queryModel = currentModel();
      queryModelForTools = queryModel;
      const tools = await createSessionTools();
      if (sdk) {
        const skills =
          skillHost?.runtime.catalog().map((skill) => skill.name) ?? [];
        const connected = new Set(mcp?.connectedServers);
        emit([
          sdk.init(session.id, {
            cwd,
            tools: tools.definitions.map((tool) => tool.name),
            mcpServers: mcpServerNames.map((name) => ({
              name,
              status: connected.has(name) ? "connected" : "failed",
            })),
            model: queryModel,
            permissionMode: mode,
            slashCommands: skills,
            agents:
              (await agentHost?.catalog())?.map(
                (definition) => definition.agentType,
              ) ?? [],
            skills,
            plugins: plugins.plugins.map((plugin) => ({
              name: plugin.name,
              path: plugin.root,
              source: plugin.source,
            })),
          }),
        ]);
      }
      const runQuery = async (fresh = false) => {
        const model = fresh ? currentModel() : queryModel;
        queryModelForTools = model;
        if (sdkQuery)
          emit([
            sdkQuery.finish({
              kind: "completed",
              result: finalText(queryStart),
            }),
          ]);
        sdkQuery = sdk?.query(session.id, model);
        queryStart = session.messages.length;
        await runAgent({
          provider,
          tools,
          messages: session.messages,
          model,
          system: requestSystem(tools, model),
          maxTokens: options.maxTokensExplicit
            ? options.maxTokens
            : defaultOutputTokens(model),
          maxTurns: options.maxTurns,
          queryEffort: currentQueryEffort,
          useModelTokenDefaults: !options.maxTokensExplicit,
          compactionState: (session.compaction ??= freshCompactionState()),
          ...(options.maxApiAttempts === undefined
            ? {}
            : { maxApiAttempts: options.maxApiAttempts }),
          signal: turnSignal,
          onEvent,
          streamEvents: sdk !== undefined,
          roundAttachments: (messages) =>
            roundAttachments({ model, env: process.env }, messages),
          stopHook: (context) => {
            const { runtime } = activeHooks();
            if (!runtime.stop)
              throw new Error(
                "Session hooks do not provide a Stop hook runner",
              );
            return runtime.stop(context);
          },
        });
      };
      await runQuery();
      // Terminal output is held until child settlement and notification queries have drained.
      while (
        hasBackgroundWork() ||
        notifications.some((entry) => entry.sessionId === session.id)
      ) {
        turnSignal.throwIfAborted();
        if (!commitNotifications()) {
          await waitForBackground(turnSignal);
          continue;
        }
        skillHost?.runtime.resetQuery(session.messages);
        await runQuery(true);
      }
    } catch (error) {
      failureError = error;
      failure = turnSignal.aborted ? "Interrupted" : errorMessage(error);
    } finally {
      skillHost?.runtime.flushContext(session.messages);
      active = undefined;
      try {
        await store.save(session);
      } catch (error) {
        const saveError = `Session save failed: ${errorMessage(error)}`;
        failure = failure ? `${failure}; ${saveError}` : saveError;
      }
    }
    const answer = failure === undefined ? finalText(historyStart) : text;
    if (sdk) {
      const result = (sdkQuery ?? sdk.query(session.id, currentModel())).finish(
        sdkQueryOutcome(
          failure === undefined
            ? undefined
            : { error: failureError, message: failure },
          answer,
        ),
      );
      if (options.format === "stream-json") emit([result]);
      else
        stdout.write(
          JSON.stringify(
            options.verbose ? sdkTranscript.splice(0).concat(result) : result,
          ) + "\n",
        );
    } else {
      if (!interactive) stdout.write(safe(answer));
      stdout.write("\n");
      if (failure) stderr.write(`tau: ${safe(failure)}\n`);
    }
    if (failure && !interactive) process.exitCode = 1;
  };
  const compactManually = async (): Promise<void> => {
    active = new AbortController();
    try {
      queryModelForTools = currentModel();
      const tools = await createSessionTools();
      const compacted = await compactContext({
        provider,
        state: (session.compaction ??= freshCompactionState()),
        reason: "manual",
        ...(tools.prepareCompaction
          ? { prepareCompaction: tools.prepareCompaction }
          : {}),
        request: {
          model: session.model,
          system: requestSystem(tools, session.model),
          messages: session.messages,
          tools: tools.definitions,
          signal: active.signal,
          maxTokens: options.maxTokensExplicit
            ? options.maxTokens
            : defaultOutputTokens(session.model),
          useModelTokenDefaults: !options.maxTokensExplicit,
          ...(options.maxApiAttempts === undefined
            ? {}
            : { attemptBudget: new ApiAttemptBudget(options.maxApiAttempts) }),
        },
        onEvent: (event) => {
          if (event.type === "usage") {
            session.usage.input_tokens += event.usage.input_tokens;
            session.usage.output_tokens += event.usage.output_tokens;
          } else if (event.type === "compaction" && event.stage === "start")
            stderr.write("Compacting conversation context...\n");
        },
      });
      stdout.write(
        compacted
          ? "Conversation context compacted.\n"
          : "Conversation context was preserved; compaction did not complete.\n",
      );
    } catch (error) {
      stderr.write(
        `tau: ${active.signal.aborted ? "Interrupted" : safe(errorMessage(error))}\n`,
      );
    } finally {
      active = undefined;
      try {
        await store.save(session);
      } catch (error) {
        stderr.write(`tau: ${safe(errorMessage(error))}\n`);
      }
    }
  };
  try {
    hookHost = createHookHost();
    skillHost = await createSkills();
    taskHost = createTasks();
    planHost = createPlans();
    agentHost = await createAgents();
    active = new AbortController();
    try {
      const { configs } = await loadLaunchMcp({
        cwd,
        launch,
        specs: options.mcpConfig,
        strict: options.strictMcpConfig,
        plugins: plugins.plugins,
        nonInteractive: !interactive,
        bypassPermissions: mode === "bypassPermissions",
        signal: active.signal,
        approveProject: (name, source) =>
          approve(
            `Connect project MCP server ${name}${source ? ` from ${source}` : ""}?`,
          ),
        onDiagnostic: (message) => stderr.write(`MCP: ${safe(message)}\n`),
      });
      mcpServerNames = Object.keys(configs);
      if (mcpServerNames.length) {
        mcp = await McpManager.connect(configs, {
          cwd,
          signal: active.signal,
          onWarning: (message) => stderr.write(`MCP: ${safe(message)}\n`),
        });
      }
      if (options.permissionPromptTool && mcp)
        permissionPrompt = createMcpPermissionPrompt({
          toolName: options.permissionPromptTool,
          registry: mcp,
          onDiagnostic: (message) =>
            stderr.write(`Permissions: ${safe(message)}\n`),
        });
      await store.save(session);
      await activeHooks().start(
        options.resume || options.continue ? "resume" : "startup",
        active.signal,
      );
    } finally {
      active = undefined;
    }
    if (interactive) {
      stdout.write(
        `tau · ${safe(session.model)} · ${safe(cwd)}\nSession ${session.id} · permissions: ${mode}\n/help for commands; Ctrl-C cancels a turn.\n`,
      );
    }
    if (mode === "bypassPermissions" || policy.allowedTools.includes("Bash")) {
      stderr.write(
        "WARNING: tools are explicitly preapproved; availability and deny rules still apply. Shell commands are NOT sandboxed.\n",
      );
    }
    if (prompt) await turn(prompt);
    if (streamInput) {
      stdin.setEncoding("utf8");
      try {
        for await (const next of sdkUserTurns(stdin)) await turn(next.content);
      } catch (error) {
        if (!(error instanceof SdkInputFatal)) throw error;
        stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    }
    if (!terminal) await activeHooks().settleRewakes();
    while (terminal && !closing) {
      let input: string;
      try {
        input = (await terminal.question("\ntau> ")).trim();
      } catch (error) {
        if (closing) break;
        throw error;
      }
      if (!input) continue;
      if (!input.startsWith("/")) {
        await turn(input);
        continue;
      }
      const [command, ...rest] = input.split(/\s+/);
      const value = rest.join(" ");
      switch (command) {
        case "/exit":
        case "/quit":
          closing = true;
          break;
        case "/help":
          stdout.write(
            "/help · /exit · /clear · /compact · /model [ID] · /permissions [MODE] · /status · /save · /resume UUID · /skills · /SKILL [args]\n",
          );
          break;
        case "/skills":
          stdout.write(
            (skillHost?.runtime
              .catalog()
              .map((skill) => `/${skill.name} ${skill.description}`)
              .join("\n") || "No local skills available.") + "\n",
          );
          break;
        case "/compact":
          await compactManually();
          break;
        case "/clear":
          await store.save(session);
          retiredHookHosts.push(activeHooks());
          session = newSession(cwd, session.model);
          notifications.length = 0;
          for (const owner of notificationSessions.keys())
            notificationSessions.set(owner, session.id);
          hookHost = createHookHost();
          skillHost = await createSkills();
          taskHost = createTasks();
          planHost = createPlans();
          agentHost = await createAgents();
          readState = new ReadState();
          instructions = createInstructions();
          provider.resetRequestLimits();
          active = new AbortController();
          try {
            await store.save(session);
            await activeHooks().start("clear", active.signal);
          } finally {
            active = undefined;
          }
          stdout.write(`New session ${session.id}\n`);
          break;
        case "/model":
          if (value) session.model = value;
          stdout.write(`Model: ${safe(session.model)}\n`);
          break;
        case "/permissions": {
          if (value) {
            const parsed = permissionModeSchema.safeParse(value);
            if (!parsed.success) {
              stderr.write("Invalid permission mode\n");
              break;
            }
            if (
              parsed.data === "bypassPermissions" &&
              !(await approve(
                "Disable all approval prompts? Shell commands are NOT sandboxed.",
              ))
            )
              break;
            mode = parsed.data;
            if (session.planState)
              session.planState = {
                ...session.planState,
                active: mode === "plan",
              };
          }
          stdout.write(`Permissions: ${mode}\n`);
          break;
        }
        case "/status":
          stdout.write(
            JSON.stringify(
              {
                session_id: session.id,
                model: session.model,
                permissions: mode,
                tool_policy: policy,
                messages: session.messages.length,
                usage: session.usage,
              },
              null,
              2,
            ) + "\n",
          );
          break;
        case "/save":
          await store.save(session);
          stdout.write(`Saved ${session.id}\n`);
          break;
        case "/resume":
          try {
            const loaded = await store.load(value);
            await store.save(session);
            retiredHookHosts.push(activeHooks());
            session = loaded;
            notifications.length = 0;
            for (const owner of notificationSessions.keys())
              notificationSessions.set(owner, session.id);
            hookHost = createHookHost();
            skillHost = await createSkills();
            taskHost = createTasks();
            if (session.planState?.active) mode = "plan";
            planHost = createPlans();
            agentHost = await createAgents();
            readState = new ReadState();
            instructions = createInstructions();
            provider.resetRequestLimits();
            active = new AbortController();
            try {
              await activeHooks().start("resume", active.signal);
            } finally {
              active = undefined;
            }
            stdout.write(`Resumed ${session.id}\n`);
          } catch (error) {
            stderr.write(`tau: ${safe(errorMessage(error))}\n`);
          }
          break;
        default:
          if (command && skillHost?.has(command.slice(1))) await turn(input);
          else stderr.write("Unknown command. Use /help.\n");
      }
    }
  } finally {
    terminal?.close();
    process.removeListener("SIGINT", interrupt);
    await shells.close();
    await Promise.all(agentHosts.map((host) => host.close()));
    await Promise.all(retiredHookHosts.map((host) => host.close()));
    await hookHost?.close();
    await mcp?.close();
  }
}

stdout.on("error", (error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPIPE"
  )
    process.exit(0);
  else throw error;
});
main().catch((error) => {
  stderr.write(`tau: ${safe(errorMessage(error))}\n`);
  process.exitCode = 1;
});
