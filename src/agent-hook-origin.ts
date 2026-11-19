import { basename, dirname } from "node:path";

export interface AgentHookOriginDefinition {
  source: string;
  baseDir?: string;
}
export interface AgentHookOriginContext {
  persistedTrustEnabled: boolean;
  /** Missing means unknown; an empty list is a known absence of trusted records. */
  trustedProjectKeys?: readonly string[];
  /** Native wg requires every explicit workspace root, and at least one root. */
  workspaceRoots?: readonly string[];
}
export interface AgentHookOriginOptions {
  context(): AgentHookOriginContext;
  /** Native rz/M identity resolution; no realpath, cwd or ancestor fallback is inferred here. */
  resolveProjectIdentity(
    folder: string,
    signal: AbortSignal,
  ): { projectKey: string | null } | Promise<{ projectKey: string | null }>;
  /** Native Yxi launch restriction, separate from personal-config/customization policy. */
  restrictedProjectKey(key: string): boolean;
}
export interface AgentHookOriginDecision {
  trusted: boolean;
  branch: "source" | "definition-folder" | "workspace";
  keys: readonly string[];
  reason:
    | "trusted-source"
    | "persisted-trust-disabled"
    | "empty-workspace"
    | "restricted-key"
    | "missing-record"
    | "persisted-record";
}
export class AgentHookOriginUnsupportedError extends Error {
  readonly code = "AGENT_HOOK_ORIGIN_UNSUPPORTED";
  constructor(message: string) {
    super(message);
    this.name = "AgentHookOriginUnsupportedError";
  }
}
const trustedSources = new Set([
  "plugin",
  "policySettings",
  "built-in",
  "builtin",
  "bundled",
  "userSettings",
  "flagSettings",
]);

/** Native B: strip exactly the case-sensitive .claude/agents directory suffix. */
export function agentHookOriginFolder(baseDir: string): string {
  const parent = dirname(baseDir);
  return basename(baseDir) === "agents" && basename(parent) === ".claude"
    ? dirname(parent)
    : baseDir;
}

/** Native _je/M/Cme/wg: exact persisted origins, never current/ancestor acceptance. */
export function createAgentHookOriginResolver(options: AgentHookOriginOptions) {
  // M caches identity per raw baseDir and host. Trust decisions remain live.
  const identities = new Map<string, string>();
  function decision(
    trusted: boolean,
    branch: AgentHookOriginDecision["branch"],
    keys: readonly string[],
    reason: AgentHookOriginDecision["reason"],
  ): Readonly<AgentHookOriginDecision> {
    return Object.freeze({
      trusted,
      branch,
      keys: Object.freeze([...keys]),
      reason,
    });
  }
  function requireKeys(context: AgentHookOriginContext): readonly string[] {
    if (context.trustedProjectKeys === undefined)
      throw new AgentHookOriginUnsupportedError(
        "Exact persisted project trust records are unavailable",
      );
    return context.trustedProjectKeys;
  }
  async function projectKey(
    folder: string,
    signal: AbortSignal,
    cacheKey?: string,
  ): Promise<string> {
    signal.throwIfAborted();
    if (cacheKey !== undefined) {
      const cached = identities.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    const identity = await options.resolveProjectIdentity(folder, signal);
    signal.throwIfAborted();
    if (identity.projectKey === null || identity.projectKey.length === 0)
      throw new AgentHookOriginUnsupportedError(
        `Native project identity is unavailable for agent hook origin: ${folder}`,
      );
    if (cacheKey !== undefined) {
      // Async host adapters do not share caller signals or overwrite an identity
      // already admitted by a concurrent successful resolution.
      const cached = identities.get(cacheKey);
      if (cached !== undefined) return cached;
      identities.set(cacheKey, identity.projectKey);
    }
    return identity.projectKey;
  }
  async function inspect(
    definition: Readonly<AgentHookOriginDefinition>,
    signal: AbortSignal,
  ): Promise<Readonly<AgentHookOriginDecision>> {
    signal.throwIfAborted();
    if (trustedSources.has(definition.source))
      return decision(true, "source", [], "trusted-source");
    const baseDir = definition.baseDir;
    const branch = baseDir ? "definition-folder" : "workspace";
    const initial = options.context();
    if (!initial.persistedTrustEnabled)
      return decision(false, branch, [], "persisted-trust-disabled");
    requireKeys(initial);
    let roots: readonly string[] | undefined;
    let keys: string[];
    function held(
      resolvedKeys: readonly string[],
    ): Readonly<AgentHookOriginDecision> | undefined {
      signal.throwIfAborted();
      const current = options.context();
      if (!current.persistedTrustEnabled)
        return decision(
          false,
          branch,
          resolvedKeys,
          "persisted-trust-disabled",
        );
      if (
        roots !== undefined &&
        (current.workspaceRoots === undefined ||
          roots.length !== current.workspaceRoots.length ||
          roots.some((root, index) => root !== current.workspaceRoots?.[index]))
      )
        throw new AgentHookOriginUnsupportedError(
          "Workspace roots changed while resolving agent hook origin",
        );
      const trusted = new Set(requireKeys(current));
      for (const key of resolvedKeys) {
        if (options.restrictedProjectKey(key))
          return decision(false, branch, resolvedKeys, "restricted-key");
        if (!trusted.has(key))
          return decision(false, branch, resolvedKeys, "missing-record");
      }
      return undefined;
    }
    if (baseDir) {
      keys = [
        await projectKey(agentHookOriginFolder(baseDir), signal, baseDir),
      ];
    } else {
      if (initial.workspaceRoots === undefined)
        throw new AgentHookOriginUnsupportedError(
          "Native workspace roots for agent hook origin are unavailable",
        );
      roots = [...initial.workspaceRoots];
      if (roots.length === 0)
        return decision(false, branch, [], "empty-workspace");
      // Native wg's identities are not M's per-definition cache.
      keys = [];
      for (const root of roots) {
        keys.push(await projectKey(root, signal));
        const refusal = held(keys);
        if (refusal) return refusal;
      }
    }
    const refusal = held(keys);
    if (refusal) return refusal;
    signal.throwIfAborted();
    return decision(true, branch, keys, "persisted-record");
  }
  return Object.freeze({
    inspect,
    async trusted(
      definition: Readonly<AgentHookOriginDefinition>,
      signal: AbortSignal,
    ): Promise<boolean> {
      return (await inspect(definition, signal)).trusted;
    },
  });
}
