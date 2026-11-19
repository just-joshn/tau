import {
  createHookRegistry,
  HOOK_EVENTS,
  type CommandHook,
  type HookBatchResult,
  type HookEvent,
  type HookInput,
  type HookOrigin,
  type HookRegistryOptions,
  type PreparedHookDispatch,
} from "./hooks.js";
import type { LocalAgentDefinition } from "./agent-definitions.js";
import type { HookRegistryLike } from "./composite-hooks.js";

interface DefinitionHookGroup {
  matcher?: string;
  hooks: CommandHook[];
}
export type ValidatedAgentDefinitionHooks = Partial<
  Record<HookEvent, DefinitionHookGroup[]>
>;
const nativeEventOrder: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
];
const hookKeys = new Set([
  "type",
  "command",
  "args",
  "shell",
  "timeout",
  "onFailure",
  "once",
  "async",
  "asyncRewake",
  "if",
  "statusMessage",
]);
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
      Object.getOwnPropertyDescriptor(value, key)?.set === undefined,
  );
}
function knownEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.some((event) => event === value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Supported command subset only. Unsupported guards/transports/events withhold the definition. */
export function validateAgentDefinitionHooks(
  input: unknown,
  options: Pick<HookRegistryOptions, "matchesCondition"> = {},
): Readonly<ValidatedAgentDefinitionHooks> {
  if (!record(input))
    throw new Error("Agent hooks must be a plain event object");
  for (const [event, groups] of Object.entries(input)) {
    if (!knownEvent(event))
      throw new Error(`Unsupported agent hook event: ${event}`);
    if (!Array.isArray(groups))
      throw new Error("Agent hook groups must be arrays");
    for (const group of groups) {
      if (
        !record(group) ||
        Object.keys(group).some(
          (key) => key !== "matcher" && key !== "hooks",
        ) ||
        !Array.isArray(group.hooks)
      )
        throw new Error("Unsupported agent hook matcher/guard fields");
      for (const hook of group.hooks) {
        if (
          !record(hook) ||
          Object.keys(hook).some((key) => !hookKeys.has(key))
        )
          throw new Error("Unsupported agent hook command/guard fields");
        if (hook.asyncRewake === true)
          throw new Error(
            "asyncRewake agent hooks need a child wake owner, which is not implemented",
          );
      }
    }
  }
  const parsed = createHookRegistry(
    [{ source: "agent-definition-validation", hooks: input }],
    options,
  );
  const result: ValidatedAgentDefinitionHooks = {};
  for (const item of parsed.list()) {
    const groups = result[item.event] ?? [];
    let group = groups.find((value) => value.matcher === item.matcher);
    if (!group) {
      group = {
        hooks: [],
        ...(item.matcher === undefined ? {} : { matcher: item.matcher }),
      };
      groups.push(group);
    }
    group.hooks.push(structuredClone(item.hook));
    result[item.event] = groups;
  }
  void parsed.close(); // No execution occurred; no owned child processes exist.
  return freeze(result);
}
const trustedSources = new Set([
  "plugin",
  "policySettings",
  "built-in",
  "builtin",
  "bundled",
]);
/** Native _je's resolved trust branch; canonical origin-folder resolution stays host-owned. */
export function agentDefinitionHookOriginTrusted(
  definition: Pick<LocalAgentDefinition, "source" | "baseDir">,
  facts: {
    workingDirectoryTrusted: boolean;
    definitionFolderTrusted?: boolean;
  },
): boolean {
  if (
    trustedSources.has(definition.source) ||
    definition.source === "userSettings" ||
    definition.source === "flagSettings"
  )
    return true;
  return definition.baseDir
    ? facts.definitionFolderTrusted === true
    : facts.workingDirectoryTrusted;
}
export interface AgentDefinitionHookRegistration {
  event: HookEvent;
  matcher: string;
  declaration: Readonly<CommandHook>;
  /** Native i5i has no skill once-removal callback. Core execution must not burn once at selection. */
  execution: Readonly<CommandHook>;
}
export interface AgentDefinitionHookProvenance {
  personal: boolean;
  checkout: boolean;
  /** Explicitly resolved plugin/source execution origin; never inferred from agent baseDir. */
  origin?: Omit<HookOrigin, "source" | "managed">;
}
export interface AgentDefinitionHookLease {
  registry: HookRegistryLike;
  /** Remove only registrations owned by this lease. Never cancel already detached executions here. */
  clearRegistration(): void;
  /** Explicit owner teardown, allowed to cancel only this lease's processes. */
  close(): Promise<void>;
}
export interface AgentDefinitionHookScopeOptions {
  agentId: string;
  ownerSessionId: string;
  definition: Readonly<LocalAgentDefinition>;
  policy(): {
    disabled: boolean;
    managedOnly: boolean;
    strictPluginOnly: boolean;
  };
  admitDefinition(
    definition: Readonly<LocalAgentDefinition>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  admitOrigin(
    definition: Readonly<LocalAgentDefinition>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  provenance(
    definition: Readonly<LocalAgentDefinition>,
  ): AgentDefinitionHookProvenance;
  /** Current command-execution/trust policy; this is never authority to loosen a tool permission floor. */
  admitExecution(context: {
    definition: Readonly<LocalAgentDefinition>;
    agentId: string;
    input: Readonly<HookInput>;
    provenance: Readonly<AgentDefinitionHookProvenance>;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  registryOptions?: Pick<HookRegistryOptions, "matchesCondition">;
  defaultShell?: "bash" | "powershell";
  /** Optional unified child-session store. Required for exact dedupe/replacement with same-scope skills.
   * It must implement native add identity and no skill quota/once-success semantics for these entries. */
  register?(request: {
    agentId: string;
    ownerSessionId: string;
    definition: Readonly<LocalAgentDefinition>;
    provenance: Readonly<AgentDefinitionHookProvenance>;
    entries: readonly AgentDefinitionHookRegistration[];
  }): AgentDefinitionHookLease | Promise<AgentDefinitionHookLease>;
}
export interface AgentDefinitionHookAdmission {
  registered: boolean;
  count: number;
  refusal?: "empty" | "disabled" | "policy" | "origin";
}
function emptyBatch(): HookBatchResult {
  return {
    results: [],
    background: [],
    additionalContext: [],
    systemMessages: [],
    blockingErrors: [],
    preventContinuation: false,
    cancelled: false,
    watchPaths: [],
    reloadSkills: false,
  };
}
function emptyPrepared(): PreparedHookDispatch {
  return {
    candidates: Object.freeze([]),
    runSelected: async (ids) => {
      if (ids.size) throw new Error("Unknown empty-scope hook candidate");
      return emptyBatch();
    },
    close: async () => {},
  };
}
function defaultLease(
  entries: readonly AgentDefinitionHookRegistration[],
  scope: string,
  provenance: AgentDefinitionHookProvenance,
  options: AgentDefinitionHookScopeOptions["registryOptions"],
): AgentDefinitionHookLease {
  const registry = createHookRegistry(
    entries.map((entry) => ({
      ...(provenance.origin?.path === undefined
        ? {}
        : { path: provenance.origin.path }),
      ...(provenance.origin?.projectRoot === undefined
        ? {}
        : { projectRoot: provenance.origin.projectRoot }),
      ...(provenance.origin?.pluginRoot === undefined
        ? {}
        : { pluginRoot: provenance.origin.pluginRoot }),
      ...(provenance.origin?.pluginData === undefined
        ? {}
        : { pluginData: provenance.origin.pluginData }),
      source: `agent-definition:${scope}`,
      hooks: {
        [entry.event]: [{ matcher: entry.matcher, hooks: [entry.execution] }],
      },
    })),
    options,
  );
  const declarations = entries.map((entry) => entry.declaration);
  let cleared = false;
  return {
    registry: {
      list(event) {
        if (cleared) return [];
        return registry
          .list()
          .map((entry, index) => ({
            ...entry,
            hook: structuredClone(declarations[index] ?? entry.hook),
          }))
          .filter((entry) => event === undefined || entry.event === event);
      },
      async prepareDispatch(input, runOptions) {
        if (cleared) return emptyPrepared();
        const prepared = await registry.prepareDispatch(input, runOptions);
        const listed = registry.list();
        return {
          ...prepared,
          candidates: Object.freeze(
            prepared.candidates.map((entry) =>
              freeze({
                ...entry,
                hook: structuredClone(
                  declarations[
                    listed.findIndex((value) => value.id === entry.id)
                  ] ?? entry.hook,
                ),
              }),
            ),
          ),
        };
      },
      run: (input, runOptions) =>
        cleared
          ? Promise.resolve(emptyBatch())
          : registry.run(input, runOptions),
      close: () => registry.close(),
    },
    clearRegistration() {
      cleared = true;
    },
    close: () => registry.close(),
  };
}
/** Child-owned query registry. Start dispatch borrows the root session registry before afterStart. */
export function createAgentDefinitionHookScope(
  options: AgentDefinitionHookScopeOptions,
) {
  if (!options.agentId || !options.ownerSessionId)
    throw new Error("Explicit hook child and owner identities required");
  const definition = freeze(structuredClone(options.definition));
  const hooks =
    definition.hooks === undefined
      ? {}
      : validateAgentDefinitionHooks(definition.hooks, options.registryOptions);
  let lease: AgentDefinitionHookLease | undefined,
    provenance: Readonly<AgentDefinitionHookProvenance> | undefined;
  let phase: "pending" | "registering" | "active" | "retired" | "closed" =
    "pending";
  const pending = new Set<Promise<unknown>>();
  const scopeClosed = () => phase === "closed";
  const prepareDispatch = async (
    input: HookInput,
    runOptions: import("./hooks.js").HookRunOptions,
  ): Promise<PreparedHookDispatch> => {
    const capturedInput = structuredClone(input);
    if (phase === "closed")
      throw new Error("Agent definition hook scope is closed");
    if (capturedInput.session_id !== options.ownerSessionId)
      throw new Error("Agent hook belongs to a different owning session");
    // GDo has no toolUseContext and resolves the root session scope, including nested ordinary starts.
    if (
      capturedInput.hook_event_name === "SubagentStart" ||
      capturedInput.hook_event_name === "SessionStart"
    )
      return emptyPrepared();
    if (
      capturedInput.agent_id !== undefined &&
      capturedInput.agent_id !== options.agentId
    )
      throw new Error("Agent hook belongs to a different child");
    runOptions.signal.throwIfAborted();
    const policy = options.policy();
    if (
      phase !== "active" ||
      !lease ||
      !provenance ||
      policy.disabled ||
      policy.managedOnly ||
      (policy.strictPluginOnly && !trustedSources.has(definition.source))
    )
      return emptyPrepared();
    if (
      !(await options.admitExecution({
        definition,
        agentId: options.agentId,
        input: freeze(structuredClone(capturedInput)),
        provenance,
        signal: runOptions.signal,
      }))
    )
      return emptyPrepared();
    runOptions.signal.throwIfAborted();
    if (phase !== "active") return emptyPrepared();
    const current = options.policy();
    if (
      current.disabled ||
      current.managedOnly ||
      (current.strictPluginOnly && !trustedSources.has(definition.source))
    )
      return emptyPrepared();
    const prepare = lease.registry.prepareDispatch;
    if (!prepare)
      throw new Error(
        "Agent hook backend does not support immutable dispatch preparation",
      );
    const prepared = await prepare.call(
      lease.registry,
      capturedInput,
      runOptions,
    );
    return {
      candidates: prepared.candidates,
      async runSelected(ids) {
        runOptions.signal.throwIfAborted();
        const policy = options.policy();
        if (
          phase !== "active" ||
          !provenance ||
          policy.disabled ||
          policy.managedOnly ||
          (policy.strictPluginOnly && !trustedSources.has(definition.source))
        )
          return emptyBatch();
        if (
          !(await options.admitExecution({
            definition,
            agentId: options.agentId,
            input: freeze(structuredClone(capturedInput)),
            provenance,
            signal: runOptions.signal,
          }))
        )
          return emptyBatch();
        runOptions.signal.throwIfAborted();
        if (phase !== "active") return emptyBatch();
        const batch = await prepared.runSelected(ids);
        for (const task of batch.background) {
          pending.add(task.completion);
          void task.completion
            .finally(() => pending.delete(task.completion))
            .catch(() => {});
        }
        return batch;
      },
      close: () => prepared.close(),
    };
  };
  const queryRegistry: HookRegistryLike = {
    list(event) {
      return phase === "active" ? (lease?.registry.list(event) ?? []) : [];
    },
    prepareDispatch,
    async run(input, runOptions) {
      const prepared = await prepareDispatch(input, runOptions);
      try {
        return await prepared.runSelected(
          new Set(prepared.candidates.map((entry) => entry.id)),
        );
      } finally {
        await prepared.close();
      }
    },
    async close() {
      if (phase === "closed") return;
      phase = "closed";
      lease?.clearRegistration();
      await lease?.close();
      await Promise.allSettled(pending);
    },
  };
  return Object.freeze({
    agentId: options.agentId,
    ownerSessionId: options.ownerSessionId,
    registry: queryRegistry,
    declaration: hooks,
    async afterStart(
      signal: AbortSignal,
    ): Promise<AgentDefinitionHookAdmission> {
      if (phase !== "pending")
        throw new Error(
          "Agent hooks must register exactly once after SubagentStart",
        );
      phase = "registering";
      try {
        signal.throwIfAborted();
        if (!(await options.admitDefinition(definition, signal)))
          throw new Error("Agent definition hook admission denied");
        signal.throwIfAborted();
        const policy = options.policy();
        let refusal: AgentDefinitionHookAdmission["refusal"];
        if (policy.disabled) refusal = "disabled";
        else if (
          policy.strictPluginOnly &&
          !trustedSources.has(definition.source)
        )
          refusal = "policy";
        else if (!(await options.admitOrigin(definition, signal)))
          refusal = "origin";
        signal.throwIfAborted();
        if (phase !== "registering")
          throw new Error(
            "Agent hook scope retired while registration awaited",
          );
        const entries: AgentDefinitionHookRegistration[] = [];
        if (!refusal)
          for (const event of nativeEventOrder)
            for (const group of hooks[event] ?? [])
              for (const hook of group.hooks) {
                const registeredEvent =
                  event === "Stop" ? "SubagentStop" : event;
                const matcher = group.matcher ?? "";
                const key = (value: Readonly<CommandHook>) =>
                  JSON.stringify([
                    value.command,
                    value.args ?? null,
                    value.shell ?? options.defaultShell ?? "bash",
                    value.if ?? "",
                  ]);
                const entry = freeze({
                  event: registeredEvent,
                  matcher,
                  declaration: structuredClone(hook),
                  execution: {
                    ...structuredClone(hook),
                    once: false,
                    ...(hook.shell === undefined &&
                    options.defaultShell !== undefined
                      ? { shell: options.defaultShell }
                      : {}),
                  },
                });
                const existing = entries.findIndex(
                  (value) =>
                    value.event === registeredEvent &&
                    value.matcher === matcher &&
                    key(value.declaration) === key(hook),
                );
                if (existing >= 0) entries[existing] = entry;
                else entries.push(entry);
              }
        if (!refusal && !entries.length) refusal = "empty";
        if (refusal) {
          phase = "active";
          return Object.freeze({ registered: false, count: 0, refusal });
        }
        provenance = freeze(structuredClone(options.provenance(definition)));
        const request = {
          agentId: options.agentId,
          ownerSessionId: options.ownerSessionId,
          definition,
          provenance,
          entries: freeze(entries),
        };
        const acquired = options.register
          ? await options.register(request)
          : defaultLease(
              entries,
              options.agentId,
              provenance,
              options.registryOptions,
            );
        if (signal.aborted || phase !== "registering") {
          acquired.clearRegistration(); // Registration retirement never cancels detached commands.
          lease = acquired;
          if (scopeClosed()) await acquired.close();
          signal.throwIfAborted();
          throw new Error("Agent hook scope retired during registration");
        }
        lease = acquired;
        phase = "active";
        return Object.freeze({ registered: true, count: entries.length });
      } catch (error) {
        if (phase === "registering") phase = "retired";
        throw error;
      }
    },
    cleanup() {
      if (phase !== "closed") phase = "retired";
      lease?.clearRegistration();
    },
    close: () => queryRegistry.close(),
    hasRunning: () => pending.size > 0,
    settle: async () => {
      await Promise.allSettled(pending);
    },
  });
}
