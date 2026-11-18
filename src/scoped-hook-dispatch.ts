import {
  type CommandHook,
  type HookInput,
  type HookRegistry,
  type HookResult,
  type HookRunOptions,
} from "./hooks.js";
import {
  composeHookRegistries,
  type HookRegistryLike,
} from "./composite-hooks.js";

export interface NativeCommandHookOrigin {
  /** Native goal marker is host provenance, not inferred from a command string. */
  namespace: "hook" | "goal";
  pluginRoot?: string;
  skillRoot?: string;
  /** Ordinary direct settings often lack this native field despite the port's origin.source label. */
  settingsSource?: string;
}
/** MAe/sBt both return false before source/plugin classification when CS is false. */
export function ordinaryDirectAgentDefinitionHookProvenance(facts: {
  personalConfigRestricted: boolean;
}): Readonly<{
  personal: false;
  checkout: false;
  nativeOrigin: Readonly<NativeCommandHookOrigin>;
}> {
  if (facts.personalConfigRestricted)
    throw new Error(
      "Restricted personal hook provenance requires its native host adapter",
    );
  return Object.freeze({
    personal: false,
    checkout: false,
    nativeOrigin: Object.freeze({ namespace: "hook" }),
  });
}
export interface MatchedScopedCommandHook {
  backendId: string;
  id: string;
  hook: Readonly<CommandHook>;
  nativeOrigin: Readonly<NativeCommandHookOrigin>;
}
/** Native gW(hC) for an already-admitted, already-matched command candidate. */
export function nativeCommandHookReductionKey(
  candidate: Pick<MatchedScopedCommandHook, "hook" | "nativeOrigin">,
  defaultShell: "bash" | "powershell",
): string {
  const { hook, nativeOrigin: origin } = candidate;
  const command = `command\0${hook.shell ?? defaultShell}\0${hook.command}\0${JSON.stringify(hook.args ?? null)}\0${hook.if ?? ""}`;
  return `${origin.namespace}${origin.pluginRoot ?? origin.skillRoot ?? origin.settingsSource ?? ""}\0${command}`;
}
/** Source tZ ordinary branch: last value wins; first key insertion position survives.
 * Source restricted-personal reduction uses additional admitted settings identity and is not guessed here. */
export function reduceMatchedOrdinaryCommandHooks<
  T extends MatchedScopedCommandHook,
>(
  candidates: readonly T[],
  context: {
    defaultShell: "bash" | "powershell";
    personalConfigRestricted: boolean;
  },
): readonly T[] {
  if (context.personalConfigRestricted)
    throw new Error(
      "Personal-configuration hook reduction requires its native provenance adapter",
    );
  const seenIds = new Set<string>(),
    selected = new Map<string, T>();
  for (const candidate of candidates) {
    if (candidate.nativeOrigin.namespace === "goal")
      throw new Error("Goal hook arbitration requires its native host adapter");
    const id = JSON.stringify([candidate.backendId, candidate.id]);
    if (!candidate.backendId || !candidate.id || seenIds.has(id))
      throw new Error("Ambiguous scoped hook candidate identity");
    seenIds.add(id);
    selected.set(
      nativeCommandHookReductionKey(candidate, context.defaultShell),
      candidate,
    );
  }
  return Object.freeze([...selected.values()]);
}
export type ListedScopedHook = ReturnType<HookRegistry["list"]>[number];
export interface ScopedHookSelectionBackend {
  id: string;
  /** Borrowed persistent registry; must expose immutable prepared selection. */
  registry: HookRegistryLike;
  /** Native origin is separate from the port's human-readable origin.source. */
  nativeOrigin(
    candidate: import("./hooks.js").HookDispatchCandidate,
  ): NativeCommandHookOrigin;
  /** Explicit OWNED teardown only; never a borrowed settings registry close. */
  closeOwned?(): Promise<void>;
}
function scopedId(backend: string, id: string): string {
  return JSON.stringify([backend, id]);
}
function projectResult(backend: string, result: HookResult): HookResult {
  return { ...result, id: scopedId(backend, result.id) };
}
export function createReducedScopedHookRegistry(options: {
  ownerSessionId: string;
  defaultShell: "bash" | "powershell";
  personalConfigRestricted: boolean;
  /** Native order: ordinary settings then actual selected session scope; do not insert unrelated root hooks. */
  backends(): readonly ScopedHookSelectionBackend[];
}): HookRegistryLike {
  if (!options.ownerSessionId)
    throw new Error("Explicit owning hook session required");
  if (options.personalConfigRestricted)
    throw new Error(
      "Personal-configuration hook reduction requires its native provenance adapter",
    );
  let closed = false;
  const owned = new Map<HookRegistryLike, () => Promise<void>>();
  const snapshots = new Set<import("./hooks.js").PreparedHookDispatch>();
  const current = () => {
    const backends = options.backends(),
      seen = new Set<string>();
    for (const backend of backends) {
      if (!backend.id || seen.has(backend.id))
        throw new Error("Duplicate scoped hook backend identity");
      seen.add(backend.id);
      if (backend.closeOwned && !owned.has(backend.registry))
        owned.set(backend.registry, async () => backend.closeOwned?.());
    }
    return backends;
  };
  const prepareDispatch = async (
    input: HookInput,
    runOptions: HookRunOptions,
  ): Promise<import("./hooks.js").PreparedHookDispatch> => {
    if (closed) throw new Error("Scoped hook dispatcher is closed");
    if (input.session_id !== options.ownerSessionId)
      throw new Error("Scoped hook dispatcher belongs to a different session");
    runOptions.signal.throwIfAborted();
    const backends = current();
    const preparations = await Promise.allSettled(
      backends.map(async (backend) => {
        const registry = backend.registry;
        if (!registry.prepareDispatch)
          throw new Error("Hook backend lacks immutable prepared dispatch");
        const prepared = await registry.prepareDispatch(input, {
          ...runOptions,
          onBackgroundResult: async (result) =>
            runOptions.onBackgroundResult?.(projectResult(backend.id, result)),
        });
        return { backend, prepared };
      }),
    );
    const ready = preparations.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = preparations.find(
      (result) => result.status === "rejected",
    );
    if (rejected || closed || runOptions.signal.aborted) {
      await Promise.allSettled(ready.map((value) => value.prepared.close()));
      runOptions.signal.throwIfAborted();
      if (rejected?.status === "rejected") throw rejected.reason;
      throw new Error("Scoped hook dispatcher closed during selection");
    }
    let candidates: Array<
      import("./hooks.js").HookDispatchCandidate & {
        backendId: string;
        nativeOrigin: NativeCommandHookOrigin;
        prepared: import("./hooks.js").PreparedHookDispatch;
      }
    >;
    let winners: readonly (typeof candidates)[number][];
    try {
      candidates = ready.flatMap(({ backend, prepared }) =>
        prepared.candidates.map((candidate) => ({
          ...candidate,
          backendId: backend.id,
          nativeOrigin: backend.nativeOrigin(candidate),
          prepared,
        })),
      );
      winners = reduceMatchedOrdinaryCommandHooks(candidates, options);
    } catch (error) {
      await Promise.allSettled(ready.map((value) => value.prepared.close()));
      throw error;
    }
    const listed = Object.freeze(
      winners.map((entry) =>
        Object.freeze({
          id: scopedId(entry.backendId, entry.id),
          event: entry.event,
          hook: entry.hook,
          origin: entry.origin,
          ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
        }),
      ),
    );
    const identities = new Set(listed.map((entry) => entry.id)),
      consumed = new Set<string>();
    let retired = false;
    const snapshot: import("./hooks.js").PreparedHookDispatch = {
      candidates: listed,
      async runSelected(ids) {
        if (retired || closed)
          throw new Error("Scoped hook dispatch snapshot is retired");
        for (const id of ids)
          if (!identities.has(id) || consumed.has(id))
            throw new Error(
              "Unknown or consumed scoped hook dispatch candidate",
            );
        for (const id of ids) consumed.add(id);
        const delegated: HookRegistryLike[] = winners
          .filter((entry) => ids.has(scopedId(entry.backendId, entry.id)))
          .map((entry) => ({
            list: () => [{ ...entry, id: scopedId(entry.backendId, entry.id) }],
            async run() {
              const batch = await entry.prepared.runSelected(
                new Set([entry.id]),
              );
              return {
                ...batch,
                results: batch.results.map((result) =>
                  projectResult(entry.backendId, result),
                ),
                background: batch.background.map((task) => ({
                  id: scopedId(entry.backendId, task.id),
                  cancel: task.cancel,
                  completion: task.completion.then((result) =>
                    projectResult(entry.backendId, result),
                  ),
                })),
              };
            },
            close: async () => {},
          }));
        return composeHookRegistries(...delegated).run(input, runOptions);
      },
      async close() {
        retired = true;
        snapshots.delete(snapshot);
        await Promise.allSettled(ready.map((value) => value.prepared.close()));
      },
    };
    snapshots.add(snapshot);
    return snapshot;
  };
  return {
    list(event) {
      return closed
        ? []
        : current().flatMap((backend) =>
            backend.registry.list(event).map((entry) => ({
              ...entry,
              id: scopedId(backend.id, entry.id),
            })),
          );
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
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        [...snapshots].map((snapshot) => snapshot.close()),
      );
      await Promise.allSettled([...owned.values()].map((close) => close()));
    },
  };
}
