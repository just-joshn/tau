import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  createHookRegistry,
  HOOK_EVENTS,
  type CommandHook,
  type HookEvent,
  type HookInput,
  type HookRegistry,
  type HookRegistryOptions,
  type HookResult,
  type PreparedHookDispatch,
  type HookSource,
} from "./hooks.js";

export const SKILL_HOOK_COUNT_LIMIT = 1024;
export const SKILL_HOOK_MATCHER_CHARACTER_LIMIT = 16384;
const refusalCacheLimit = 64;
export type SkillHookRefusal =
  | "disabled"
  | "managed_only"
  | "policy"
  | "guard"
  | "invalid"
  | "unsupported"
  | "characters"
  | "count"
  | "matcher";
export interface SkillHookRequest {
  sessionId: string;
  skillName: string;
  source: string;
  path: string;
  skillRoot?: string;
  hooks: unknown;
  /** Plugin repository/bundled provenance bucket; local skills use their source. */
  sourceKey?: string;
  personal?: boolean;
  checkout?: boolean;
}
export interface SkillHookAdmission {
  registered: boolean;
  count: number;
  registrationIds: string[];
  refusal?: SkillHookRefusal;
  reason?: string;
}
interface Entry {
  id: string;
  hook: CommandHook;
  removeOnSuccess: boolean;
  path: string;
  skillName: string;
}
interface Group {
  event: HookEvent;
  matcher: string;
  skillRoot?: string;
  personal: boolean;
  checkout: boolean;
  entries: Entry[];
}
interface Draw {
  hooks: number;
  characters: number;
  texts: Map<string, SkillHookRefusal | undefined>;
  refusals: number;
}
interface State {
  groups: Group[];
  draws: Map<string, Draw>;
}
export type HookRegistryApi = Pick<
  HookRegistry,
  "list" | "run" | "close" | "prepareDispatch"
>;
type ListedHook = ReturnType<HookRegistry["list"]>[number];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const isHookEvent = (value: string): value is HookEvent =>
  HOOK_EVENTS.some((event) => event === value);
function identity(hook: CommandHook, shell: "bash" | "powershell"): string {
  return JSON.stringify([
    hook.command,
    hook.args ?? null,
    hook.shell ?? shell,
    hook.if ?? "",
  ]);
}
function matchQuery(input: HookInput): string {
  return ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(
    input.hook_event_name,
  )
    ? (input.tool_name ?? "")
    : input.hook_event_name === "SessionStart"
      ? (input.source ?? "")
      : input.hook_event_name === "SubagentStart" ||
          input.hook_event_name === "SubagentStop"
        ? typeof input.agent_type === "string"
          ? input.agent_type
          : ""
        : "";
}

/** Session registration only: validation and admission never execute a command. */
export class SessionSkillHookRegistry {
  private readonly sessions = new Map<string, State>();
  private nextId = 0;
  constructor(
    private readonly options: {
      disabled?: boolean;
      managedOnly?: boolean;
      strictPluginOnly?: boolean;
      defaultShell?: "bash" | "powershell";
      matchesCondition?: HookRegistryOptions["matchesCondition"];
      /** Frontmatter guard/trust/server admission remains the caller's decision. */
      admit?(
        request: Readonly<SkillHookRequest>,
      ): true | { refusal: "guard" | "policy"; reason: string };
      testsSkillMatchers?(hooks: unknown): boolean;
    } = {},
  ) {}
  register(request: SkillHookRequest): SkillHookAdmission {
    const refused = (
      refusal: SkillHookRefusal,
      reason: string,
    ): SkillHookAdmission => ({
      registered: false,
      count: 0,
      registrationIds: [],
      refusal,
      reason,
    });
    if (this.options.disabled)
      return refused("disabled", "All hooks are disabled");
    // Source qM omits session hooks entirely in managed-only dispatch.
    if (this.options.managedOnly)
      return refused(
        "managed_only",
        "Managed-only hook dispatch excludes session skill hooks",
      );
    if (
      this.options.strictPluginOnly &&
      !["plugin", "policySettings", "built-in", "builtin", "bundled"].includes(
        request.source,
      )
    )
      return refused(
        "policy",
        "Skill hooks are excluded by the customization policy",
      );
    const admission = this.options.admit?.(request);
    if (admission && admission !== true)
      return refused(admission.refusal, admission.reason);
    if (
      !request.sessionId ||
      !request.skillName ||
      !isAbsolute(request.path) ||
      (request.skillRoot !== undefined && !isAbsolute(request.skillRoot))
    )
      return refused(
        "invalid",
        "Explicit session, skill name and absolute source paths are required",
      );
    if (!object(request.hooks))
      return refused("invalid", "Skill hooks must be an event object");
    if (Object.keys(request.hooks).some((event) => !isHookEvent(event)))
      return refused(
        "unsupported",
        "This skill declares a hook event that the command registry cannot execute",
      );
    let parsed: ReadonlyArray<ListedHook>;
    try {
      const registry = createHookRegistry(
        [{ source: "skill-validation", hooks: request.hooks }],
        this.options.matchesCondition
          ? { matchesCondition: this.options.matchesCondition }
          : {},
      );
      parsed = registry.list();
      void registry.close();
    } catch (error) {
      return refused(
        "invalid",
        error instanceof Error ? error.message : "Invalid skill hooks",
      );
    }
    let count = 0,
      characters = 0;
    // Unknown/misplaced guard keys must not disappear in a stripping command schema.
    for (const groups of Object.values(request.hooks)) {
      if (!Array.isArray(groups))
        return refused("invalid", "Skill hook groups must be arrays");
      for (const group of groups) {
        if (
          !object(group) ||
          Object.keys(group).some((key) => !["matcher", "hooks"].includes(key))
        )
          return refused("invalid", "Unsupported skill hook group fields");
        if (!Array.isArray(group.hooks))
          return refused("invalid", "Skill hook entries must be arrays");
        const entries = Math.max(1, group.hooks.length);
        count += entries;
        characters +=
          (typeof group.matcher === "string" ? group.matcher.length : 0) *
          entries;
        for (const hook of group.hooks) {
          if (
            !object(hook) ||
            Object.keys(hook).some(
              (key) =>
                ![
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
                ].includes(key),
            )
          )
            return refused("invalid", "Unsupported skill hook command fields");
          if (hook.once === true && hook.async === true)
            return refused(
              "unsupported",
              "Asynchronous one-shot skill hooks require source background-start outcome handling",
            );
        }
      }
    }
    const serialized = JSON.stringify(request.hooks);
    const cacheKey = JSON.stringify([
      request.skillName,
      createHash("sha256").update(serialized).digest("hex"),
    ]);
    const state = this.sessions.get(request.sessionId) ?? {
      groups: [],
      draws: new Map<string, Draw>(),
    };
    const bucket = request.sourceKey ?? request.source;
    const draw = state.draws.get(bucket) ?? {
      hooks: 0,
      characters: 0,
      texts: new Map<string, SkillHookRefusal | undefined>(),
      refusals: 0,
    };
    let refusal: SkillHookRefusal | undefined;
    if (draw.texts.has(cacheKey)) refusal = draw.texts.get(cacheKey);
    else {
      if (draw.characters + characters > SKILL_HOOK_MATCHER_CHARACTER_LIMIT)
        refusal = "characters";
      else if (draw.hooks + count > SKILL_HOOK_COUNT_LIMIT) refusal = "count";
      else {
        try {
          if (this.options.testsSkillMatchers?.(request.hooks) === false)
            refusal = "matcher";
        } catch {
          refusal = "matcher";
        }
      }
      if (!refusal || draw.refusals < refusalCacheLimit) {
        draw.texts.set(cacheKey, refusal);
        if (refusal) draw.refusals++;
        else {
          draw.hooks += count;
          draw.characters += characters;
        }
      }
    }
    // Failed matcher/bounds admissions retain their bounded draw cache, but no entries.
    state.draws.set(bucket, draw);
    this.sessions.set(request.sessionId, state);
    if (refusal)
      return refused(
        refusal,
        `Skill hooks do not fit the session ${refusal} policy`,
      );
    const registrationIds: string[] = [],
      shell = this.options.defaultShell ?? "bash";
    for (const item of parsed) {
      const matcher = item.matcher || "",
        personal = request.personal === true,
        checkout = request.checkout === true;
      let group = state.groups.find(
        (value) =>
          value.event === item.event &&
          value.matcher === matcher &&
          value.skillRoot === request.skillRoot &&
          value.personal === personal &&
          value.checkout === checkout,
      );
      if (!group) {
        group = {
          event: item.event,
          matcher,
          personal,
          checkout,
          entries: [],
          ...(request.skillRoot === undefined
            ? {}
            : { skillRoot: request.skillRoot }),
        };
        state.groups.push(group);
      }
      const found = group.entries.find(
        (value) => identity(value.hook, shell) === identity(item.hook, shell),
      );
      if (found) {
        found.hook = structuredClone(item.hook); // Existing position and initial success callback survive replacement.
        registrationIds.push(found.id);
      } else {
        const entry: Entry = {
          id: `skill-hook-${this.nextId++}`,
          hook: structuredClone(item.hook),
          removeOnSuccess: item.hook.once === true,
          path: request.path,
          skillName: request.skillName,
        };
        group.entries.push(entry);
        registrationIds.push(entry.id);
      }
    }
    return { registered: true, count: parsed.length, registrationIds };
  }
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
  remove(
    sessionId: string,
    event: HookEvent,
    hook: CommandHook,
    skillRoot?: string,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const key = identity(hook, this.options.defaultShell ?? "bash");
    for (const group of state.groups)
      if (group.event === event && group.skillRoot === skillRoot)
        group.entries = group.entries.filter(
          (entry) =>
            identity(entry.hook, this.options.defaultShell ?? "bash") !== key,
        );
    state.groups = state.groups.filter((group) => group.entries.length > 0);
  }
  removeRoots(roots: ReadonlySet<string>): number {
    let count = 0;
    for (const state of this.sessions.values())
      state.groups = state.groups.filter((group) => {
        if (group.skillRoot !== undefined && roots.has(group.skillRoot)) {
          count += group.entries.length;
          return false;
        }
        return true;
      });
    return count;
  }
  /** Removal does not refund the source's lifetime draw; clear resets it. */
  usage(
    sessionId: string,
    sourceKey: string,
  ): Readonly<{ hooks: number; characters: number }> {
    const draw = this.sessions.get(sessionId)?.draws.get(sourceKey);
    return { hooks: draw?.hooks ?? 0, characters: draw?.characters ?? 0 };
  }
  snapshot(sessionId: string) {
    const groups = structuredClone(this.sessions.get(sessionId)?.groups ?? []);
    const bySource = new Map<string, Group[]>(),
      sources: HookSource[] = [],
      entries: Entry[] = [];
    for (const group of groups) {
      const [firstEntry] = group.entries;
      if (!firstEntry) continue;
      const source = `skill:${JSON.stringify(group.skillRoot ?? null)}`;
      const sourceGroups = bySource.get(source) ?? [];
      sourceGroups.push(group);
      bySource.set(source, sourceGroups);
      // Root is the source's command/data substitution origin, not a plugin id/data dir.
      sources.push({
        source,
        path: firstEntry.path,
        ...(group.skillRoot === undefined
          ? {}
          : { pluginRoot: group.skillRoot }),
        hooks: {
          [group.event]: [
            {
              matcher: group.matcher,
              hooks: group.entries.map((entry) => ({
                ...structuredClone(entry.hook),
                once: false,
              })),
            },
          ],
        },
      });
    }
    const parsed = createHookRegistry(
      sources,
      this.options.matchesCondition
        ? { matchesCondition: this.options.matchesCondition }
        : {},
    );
    const listed = parsed.list();
    void parsed.close();
    // Registry enumeration follows source/group order, with one supported event per source object.
    for (const group of groups) entries.push(...group.entries);
    const stableIds = new Map(
      listed.map((entry, index) => [entry.id, entries[index]?.id ?? entry.id]),
    );
    const stableResult = (result: HookResult): HookResult => ({
      ...result,
      id: stableIds.get(result.id) ?? result.id,
    });
    const observe = (input: HookInput, result: HookResult) => {
      if (result.status !== "success") return;
      const registered = listed.find(
        (value) =>
          value.id === result.id || stableIds.get(value.id) === result.id,
      );
      if (!registered) return;
      const rootGroups = bySource.get(registered.origin.source) ?? [],
        query = matchQuery(input);
      // Match the source getEntry lookup; a regex match alone does not prove callback admission.
      const root = rootGroups[0]?.skillRoot;
      const group = this.sessions
        .get(sessionId)
        ?.groups.find(
          (value) =>
            value.event === registered.event &&
            value.skillRoot === root &&
            (value.matcher === query || query === "") &&
            value.entries.some(
              (entry) =>
                identity(entry.hook, this.options.defaultShell ?? "bash") ===
                identity(registered.hook, this.options.defaultShell ?? "bash"),
            ),
        );
      const entry = group?.entries.find(
        (value) =>
          identity(value.hook, this.options.defaultShell ?? "bash") ===
          identity(registered.hook, this.options.defaultShell ?? "bash"),
      );
      if (entry?.removeOnSuccess)
        this.remove(sessionId, registered.event, entry.hook, group?.skillRoot);
    };
    return {
      sources,
      list: () =>
        listed.map((entry, index) => ({
          ...entry,
          hook: structuredClone(entries[index]?.hook ?? entry.hook),
          id: stableIds.get(entry.id) ?? entry.id,
        })),
      stableId: (id: string) => stableIds.get(id) ?? id,
      stableResult,
      observe,
      createRegistry: () =>
        createHookRegistry(
          sources,
          this.options.matchesCondition
            ? { matchesCondition: this.options.matchesCondition }
            : {},
        ),
    };
  }
}

/** Dynamic skill side only; keep the ordinary settings registry persistent beside it. */
export function createSkillHookExecutionRegistry(
  store: SessionSkillHookRegistry,
  sessionId: string | (() => string),
  registryOptions: { ownerSessionId?: string | (() => string) } = {},
): HookRegistryApi {
  const active = new Set<HookRegistry>();
  let closed = false;
  const current = () =>
    typeof sessionId === "string" ? sessionId : sessionId();
  const prepareDispatch: HookRegistryApi["prepareDispatch"] = async (
    input,
    options,
  ) => {
    if (closed) throw new Error("Skill hook execution registry is closed");
    const scopeId = current();
    const owner =
      registryOptions.ownerSessionId === undefined
        ? scopeId
        : typeof registryOptions.ownerSessionId === "string"
          ? registryOptions.ownerSessionId
          : registryOptions.ownerSessionId();
    if (input.session_id !== owner)
      throw new Error("Skill hook input belongs to a different session");
    const capturedInput = structuredClone(input);
    const snapshot = store.snapshot(scopeId),
      registry = snapshot.createRegistry();
    active.add(registry);
    const pending = new Set<Promise<unknown>>(),
      observed = new Set<string>();
    let retired = false;
    const observe = (result: HookResult) => {
      if (result.status !== "success" || observed.has(result.id)) return;
      observed.add(result.id);
      snapshot.observe(capturedInput, result);
    };
    const release = async () => {
      if (!retired || pending.size) return;
      active.delete(registry);
      await registry.close();
    };
    let prepared: PreparedHookDispatch;
    try {
      prepared = await registry.prepareDispatch(input, {
        ...options,
        onBackgroundResult: async (result) => {
          observe(result);
          await options.onBackgroundResult?.(snapshot.stableResult(result));
        },
      });
    } catch (error) {
      active.delete(registry);
      await registry.close();
      throw error;
    }
    const original = snapshot.list(),
      rawIds = new Map(
        prepared.candidates.map((entry) => [
          snapshot.stableId(entry.id),
          entry.id,
        ]),
      );
    return {
      candidates: Object.freeze(
        prepared.candidates.map((entry) =>
          immutable({
            ...entry,
            id: snapshot.stableId(entry.id),
            hook: structuredClone(
              original.find((item) => item.id === snapshot.stableId(entry.id))
                ?.hook ?? entry.hook,
            ),
          }),
        ),
      ),
      async runSelected(ids) {
        if (retired) throw new Error("Skill hook dispatch snapshot is retired");
        const selected = new Set<string>();
        for (const id of ids) {
          const raw = rawIds.get(id);
          if (raw === undefined)
            throw new Error("Unknown skill hook dispatch candidate");
          selected.add(raw);
        }
        const batch = await prepared.runSelected(selected);
        for (const result of batch.results) observe(result);
        const background = batch.background.map((task) => {
          const completion = task.completion.then((result) => {
            observe(result);
            return snapshot.stableResult(result);
          });
          pending.add(completion);
          void completion
            .finally(async () => {
              pending.delete(completion);
              await release();
            })
            .catch(() => {});
          return {
            id: snapshot.stableId(task.id),
            cancel: task.cancel,
            completion,
          };
        });
        return {
          ...batch,
          results: batch.results.map(snapshot.stableResult),
          background,
        };
      },
      async close() {
        retired = true;
        await prepared.close();
        await release();
      },
    };
  };
  return {
    list(event) {
      return store
        .snapshot(current())
        .list()
        .filter((entry) => event === undefined || entry.event === event);
    },
    prepareDispatch,
    async run(input, options) {
      if (closed) throw new Error("Skill hook execution registry is closed");
      const scopeId = current(),
        owner =
          registryOptions.ownerSessionId === undefined
            ? scopeId
            : typeof registryOptions.ownerSessionId === "string"
              ? registryOptions.ownerSessionId
              : registryOptions.ownerSessionId();
      if (input.session_id !== owner)
        throw new Error("Skill hook input belongs to a different session");
      const capturedInput = structuredClone(input),
        snapshot = store.snapshot(scopeId),
        registry = snapshot.createRegistry();
      active.add(registry);
      try {
        const batch = await registry.run(input, {
          ...options,
          onBackgroundResult: async (result) => {
            snapshot.observe(capturedInput, result);
            await options.onBackgroundResult?.(snapshot.stableResult(result));
          },
        });
        for (const result of batch.results)
          snapshot.observe(capturedInput, result);
        const background = batch.background.map((task) => ({
          id: snapshot.stableId(task.id),
          cancel: task.cancel,
          completion: task.completion.then((result) => {
            snapshot.observe(capturedInput, result);
            return snapshot.stableResult(result);
          }),
        }));
        if (background.length)
          void Promise.allSettled(
            background.map((task) => task.completion),
          ).finally(async () => {
            active.delete(registry);
            await registry.close();
          });
        else {
          active.delete(registry);
          await registry.close();
        }
        return {
          ...batch,
          results: batch.results.map(snapshot.stableResult),
          background,
        };
      } catch (error) {
        active.delete(registry);
        await registry.close();
        throw error;
      }
    },
    async close() {
      closed = true;
      await Promise.all([...active].map((registry) => registry.close()));
      active.clear();
    },
  };
}
