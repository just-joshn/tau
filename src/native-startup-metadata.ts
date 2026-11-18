import type {
  NativeLifecycleCaptureHost,
  NativeLifecycleStartCompletion,
} from "./native-lifecycle-hooks.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";

type StartSource = NativeLifecycleStartCompletion["source"];
export interface NativeStartupRootState {
  pendingInitialUserMessage: string | undefined;
  pendingHookSessionTitle: string | undefined;
  startSource: "startup" | "resume" | "fork" | undefined;
  hasDispatched: boolean;
  hooksDispatched: number;
  pluginsCovered: readonly (readonly [string, string])[];
  pluginsSucceeded: readonly string[];
}
export interface NativeStartupDispatchFacts {
  sessionId: string;
  source: StartSource;
  newPluginsOnly:
    { presence: "absent" } | { presence: "supplied"; enabled: boolean };
  agentContext: "absent" | "supplied";
  resumedMessages:
    { presence: "absent" } | { presence: "supplied"; length: number };
  envFileSessionId:
    { presence: "absent" } | { presence: "supplied"; value: string };
}
export interface NativeStartupMetadataUnsupported {
  branch: string;
  reason: string;
  facts: unknown;
}
export interface NativeStartupMetadataHost {
  /** Actual B6/v9 and Ass/B9 owners, called only at their source branch. */
  reloadSkills(): void;
  invalidateEnvironment(): void;
  watchPaths(paths: readonly string[], mode: "replace" | "add"): void;
  unsupported(fact: NativeStartupMetadataUnsupported): void | Promise<void>;
  title: {
    teamOwned(): NativePromptFact<boolean>;
    current(): NativePromptFact<string | undefined>;
    collisionYield(
      normalized: string,
      currentNormalized: string | undefined,
    ): NativePromptFact<string | undefined>;
    setTitle(normalized: string): void;
    setAgentName(normalized: string): void;
    sourcePathMatches(sessionId: string): NativePromptFact<boolean>;
    persistenceSkipped(): NativePromptFact<boolean>;
    reappend(sessionId: string): Promise<void>;
    writeFailure(error: unknown): void;
  };
}
export interface NativeStartupInputOwner {
  /** Explicit root/session/input binding; queue internals remain with the actual input owner. */
  root: object;
  sessionId: string;
  prependOwnedUserMessage(
    text: string,
    sentBy: "process",
  ): { status: "enqueued" | "probe-discarded" | "retired" };
}
export type NativeStartupTitleOutcome =
  | {
      status:
        "absent" | "team-owned" | "empty" | "collision-yielded" | "unsupported";
    }
  | {
      status:
        | "unchanged"
        | "cached"
        | "cached-unmaterialized"
        | "cached-persistence-skipped"
        | "reappended"
        | "write-failed";
      title: string;
    };
export class NativeStartupMetadataError extends Error {
  constructor(cause: unknown) {
    super("Native startup metadata owner failed", { cause });
    this.name = "NativeStartupMetadataError";
  }
}
function immutable<T>(value: T): T {
  snapshotNativeResponseJson(value);
  const copy = structuredClone(value),
    queue: object[] = copy !== null && typeof copy === "object" ? [copy] : [];
  for (const entry of queue) {
    const children: unknown[] = Object.values(entry);
    for (const child of children)
      if (child !== null && typeof child === "object") queue.push(child);
    Object.freeze(entry);
  }
  return copy;
}
function validateState(state: NativeStartupRootState): void {
  if (
    (state.pendingInitialUserMessage !== undefined &&
      typeof state.pendingInitialUserMessage !== "string") ||
    (state.pendingHookSessionTitle !== undefined &&
      typeof state.pendingHookSessionTitle !== "string") ||
    (state.startSource !== undefined &&
      !["startup", "resume", "fork"].includes(state.startSource)) ||
    typeof state.hasDispatched !== "boolean" ||
    !Number.isSafeInteger(state.hooksDispatched) ||
    state.hooksDispatched < 0 ||
    state.pluginsCovered.some(
      (v) =>
        v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string",
    ) ||
    new Set(state.pluginsCovered.map((v) => v[0])).size !==
      state.pluginsCovered.length ||
    state.pluginsSucceeded.some((v) => typeof v !== "string")
  )
    throw new Error("Invalid actual startup root state");
}
/** Exact source Ma/Un/rJ normalization, independent of collision/team/current-title hosts. */
// oxlint-disable-next-line no-control-regex -- Exact source rJ C0/C1 matcher.
const titleControls = /[\x00-\x1f\x7f-\x9f]/g;
export function normalizeNativeHookTitle(raw: string): string {
  return Array.from(
    raw
      .trim()
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
      .replace(titleControls, ""),
  )
    .slice(0, 200)
    .join("")
    .trim();
}
/** EUn root lifetime and metadata slots; it never creates a native row or opens a transcript. */
export class NativeStartupMetadataOwner {
  readonly #root: object;
  readonly #host: NativeStartupMetadataHost;
  #state: NativeStartupRootState;
  #sessionId: string;
  #generation = 0;
  #closed = false;
  #failure: NativeStartupMetadataError | undefined;
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #jobErrors: unknown[] = [];
  #closing: Promise<void> | undefined;
  readonly #leases = new Set<{ retire(): void }>();
  constructor(options: {
    root: object;
    sessionId: string;
    initial:
      | { kind: "actual-new-root" }
      | { kind: "actual-root-state"; state: NativeStartupRootState };
    host: NativeStartupMetadataHost;
  }) {
    if (!options.root || typeof options.root !== "object" || !options.sessionId)
      throw new Error("Actual startup root/session capability is required");
    this.#root = options.root;
    this.#sessionId = options.sessionId;
    this.#state =
      options.initial.kind === "actual-new-root"
        ? {
            pendingInitialUserMessage: undefined,
            pendingHookSessionTitle: undefined,
            startSource: undefined,
            hasDispatched: false,
            hooksDispatched: 0,
            pluginsCovered: [],
            pluginsSucceeded: [],
          }
        : immutable(options.initial.state);
    validateState(this.#state);
    const host = options.host,
      title = host.title;
    this.#host = {
      reloadSkills: host.reloadSkills.bind(host),
      invalidateEnvironment: host.invalidateEnvironment.bind(host),
      watchPaths: host.watchPaths.bind(host),
      unsupported: host.unsupported.bind(host),
      title: {
        teamOwned: title.teamOwned.bind(title),
        current: title.current.bind(title),
        collisionYield: title.collisionYield.bind(title),
        setTitle: title.setTitle.bind(title),
        setAgentName: title.setAgentName.bind(title),
        sourcePathMatches: title.sourcePathMatches.bind(title),
        persistenceSkipped: title.persistenceSkipped.bind(title),
        reappend: title.reappend.bind(title),
        writeFailure: title.writeFailure.bind(title),
      },
    };
  }
  #guard(root: object) {
    if (root !== this.#root) throw new Error("Foreign startup root capability");
    if (this.#closed) throw new Error("Startup metadata owner is closed");
    if (this.#failure) throw this.#failure;
  }
  #effect<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      this.#failure =
        error instanceof NativeStartupMetadataError
          ? error
          : new NativeStartupMetadataError(error);
      throw this.#failure;
    }
  }
  snapshot(root: object): Readonly<NativeStartupRootState> {
    this.#guard(root);
    return immutable(this.#state);
  }
  transition(root: object, sessionId: string): void {
    this.#guard(root);
    if (!sessionId)
      throw new Error("Missing actual session transition identity");
    this.#sessionId = sessionId;
  }
  /** Source mD invalidation is independent of changing the session UUID. */
  clearLate(root: object, abortActualOverdue?: () => void): void {
    this.#guard(root);
    this.#effect(() => abortActualOverdue?.());
    this.#generation++;
  }
  skipped(root: object, source: StartSource): void {
    this.#guard(root);
    if (["startup", "resume", "fork"].includes(source))
      this.#state = {
        ...this.#state,
        startSource:
          source === "startup"
            ? "startup"
            : source === "resume"
              ? "resume"
              : "fork",
      };
  }
  begin(root: object, facts: NativeStartupDispatchFacts) {
    this.#guard(root);
    facts = immutable(facts);
    if (
      facts.sessionId !== this.#sessionId ||
      !["startup", "resume", "clear", "compact", "fork"].includes(
        facts.source,
      ) ||
      !["absent", "supplied"].includes(facts.newPluginsOnly.presence) ||
      (facts.newPluginsOnly.presence === "supplied" &&
        typeof facts.newPluginsOnly.enabled !== "boolean") ||
      !["absent", "supplied"].includes(facts.agentContext) ||
      !["absent", "supplied"].includes(facts.resumedMessages.presence) ||
      !["absent", "supplied"].includes(facts.envFileSessionId.presence) ||
      (facts.envFileSessionId.presence === "supplied" &&
        typeof facts.envFileSessionId.value !== "string") ||
      (facts.resumedMessages.presence === "supplied" &&
        (!Number.isSafeInteger(facts.resumedMessages.length) ||
          facts.resumedMessages.length < 0))
    )
      throw new Error("Invalid actual startup dispatch facts");
    const launcherFirst =
      !this.#state.hasDispatched &&
      (facts.source === "startup" ||
        (facts.source === "resume" &&
          facts.resumedMessages.presence === "supplied" &&
          facts.resumedMessages.length === 0)) &&
      facts.agentContext === "absent" &&
      facts.newPluginsOnly.presence === "absent";
    this.#state = { ...this.#state, hasDispatched: true };
    const generation = this.#generation;
    let retired = false,
      completed = false,
      ready = false,
      overtaken = false,
      lateInitial: string | undefined;
    const check = () => {
      this.#guard(root);
      if (retired) throw new Error("Startup dispatch lease is retired");
    };
    const retire = () => {
      retired = true;
      this.#leases.delete(lease);
    };
    const capture: NonNullable<NativeLifecycleCaptureHost["startMetadata"]> = (
      value,
    ) => {
      check();
      if (!ready)
        throw new Error(
          "Startup dispatch has not reached its actual ready phase",
        );
      value = immutable(value);
      if (
        Object.keys(value).some(
          (k) => !["initialUserMessage", "lateInitialUserMessage"].includes(k),
        )
      )
        throw new Error(
          "Startup metadata needs its unconditional completion boundary",
        );
      if (
        (value.initialUserMessage !== undefined &&
          typeof value.initialUserMessage !== "string") ||
        (value.lateInitialUserMessage !== undefined &&
          typeof value.lateInitialUserMessage !== "string") ||
        (value.initialUserMessage !== undefined &&
          value.lateInitialUserMessage !== undefined)
      )
        throw new Error("Invalid actual startup input slot update");
      const text = value.lateInitialUserMessage ?? value.initialUserMessage;
      if (
        !text ||
        (facts.newPluginsOnly.presence === "supplied" &&
          facts.newPluginsOnly.enabled)
      )
        return;
      if (value.lateInitialUserMessage !== undefined && !overtaken)
        throw new Error("Late startup input lacks actual takeover owner");
      if (overtaken) lateInitial = text;
      else this.#state = { ...this.#state, pendingInitialUserMessage: text };
    };
    const completion = async (value: NativeLifecycleStartCompletion) => {
      check();
      if (!ready)
        throw new Error(
          "Startup dispatch has not reached its actual ready phase",
        );
      value = immutable(value);
      if (completed)
        throw new Error("Startup dispatch completion already applied");
      if (
        value.source !== facts.source ||
        value.newPluginsOnly !==
          (facts.newPluginsOnly.presence === "supplied" &&
            facts.newPluginsOnly.enabled) ||
        value.overtaken !== overtaken ||
        !["completed", "control-stream-closed"].includes(value.end.kind)
      )
        throw new Error("Foreign or abnormal startup completion");
      if (
        typeof value.reloadSkills !== "boolean" ||
        (value.sessionTitle !== undefined &&
          typeof value.sessionTitle !== "string") ||
        !Array.isArray(value.watchPaths) ||
        value.watchPaths.some((v) => typeof v !== "string")
      )
        throw new Error("Invalid actual startup completion metadata");
      completed = true;
      this.#effect(() => {
        if (value.reloadSkills) this.#host.reloadSkills();
        this.#state = {
          ...this.#state,
          pendingHookSessionTitle:
            !value.newPluginsOnly &&
            ["startup", "resume", "fork"].includes(value.source)
              ? value.sessionTitle
              : undefined,
        };
        if (
          value.newPluginsOnly ||
          facts.envFileSessionId.presence === "supplied"
        )
          this.#host.invalidateEnvironment();
        if (value.watchPaths.length)
          this.#host.watchPaths(
            value.watchPaths,
            value.newPluginsOnly || value.overtaken ? "add" : "replace",
          );
      });
    };
    const lease = {
      launcherFirst,
      /** Source U_e sets startSource after actual plugin load, before draining hooks. */
      dispatchReady: () => {
        check();
        if (ready) throw new Error("Startup dispatch ready phase repeated");
        ready = true;
        if (["startup", "resume", "fork"].includes(facts.source)) {
          const source = facts.source;
          this.#state = {
            ...this.#state,
            startSource:
              source === "startup"
                ? "startup"
                : source === "resume"
                  ? "resume"
                  : "fork",
          };
        }
      },
      lifecycleHost: { startMetadata: capture, startCompletion: completion },
      /** Must be called at actual zla takeover, independently of queue or rendering. */
      overtake() {
        check();
        if (overtaken) throw new Error("Startup already overtaken");
        overtaken = true;
      },
      takeLateInput: (queue: NativeStartupInputOwner) => {
        check();
        if (generation !== this.#generation)
          return { status: "stale" as const };
        if (queue.root !== root || queue.sessionId !== this.#sessionId)
          throw new Error("Late startup input belongs to another owner");
        const text = lateInitial;
        lateInitial = undefined;
        return text
          ? this.#effect(() => queue.prependOwnedUserMessage(text, "process"))
          : { status: "absent" as const };
      },
      retire,
    };
    this.#leases.add(lease);
    return lease;
  }
  /** Actual onMatched facts; no plugin origin/name normalization is inferred here. */
  matched(
    root: object,
    facts: {
      source: StartSource;
      count: number;
      covered: readonly (readonly [string, string])[];
      succeededStandIns: readonly string[];
    },
  ): void {
    this.#guard(root);
    facts = immutable(facts);
    if (!Number.isSafeInteger(facts.count) || facts.count < 0)
      throw new Error("Invalid matched hook count");
    const covered = new Map(this.#state.pluginsCovered),
      succeeded = new Set(this.#state.pluginsSucceeded);
    if (facts.source !== "compact") {
      for (const [id, name] of facts.covered) covered.set(id, name);
      for (const id of facts.succeededStandIns) succeeded.add(id);
    }
    this.#state = {
      ...this.#state,
      hooksDispatched: this.#state.hooksDispatched + facts.count,
      pluginsCovered: [...covered],
      pluginsSucceeded: [...succeeded],
    };
  }
  takeInitialInput(root: object, queue: NativeStartupInputOwner) {
    this.#guard(root);
    if (queue.root !== root || queue.sessionId !== this.#sessionId)
      throw new Error("Startup input belongs to another owner");
    const text = this.#state.pendingInitialUserMessage;
    this.#state = { ...this.#state, pendingInitialUserMessage: undefined };
    return text
      ? this.#effect(() => queue.prependOwnedUserMessage(text, "process"))
      : { status: "absent" as const };
  }
  takeHookTitle(
    root: object,
    mode: "fresh-cache" | "resume-reappend",
  ): Promise<NativeStartupTitleOutcome> {
    this.#guard(root);
    const text = this.#state.pendingHookSessionTitle;
    this.#state = { ...this.#state, pendingHookSessionTitle: undefined };
    const sessionId = this.#sessionId;
    const task = this.#applyTitle(text, mode, sessionId);
    this.#jobs.add(task);
    void task.then(
      () => {
        this.#jobs.delete(task);
      },
      (error: unknown) => {
        this.#jobs.delete(task);
        const ownedError =
          error instanceof NativeStartupMetadataError
            ? error
            : new NativeStartupMetadataError(error);
        this.#failure ??= ownedError;
        this.#jobErrors.push(ownedError);
      },
    );
    return task;
  }
  async #applyTitle(
    text: string | undefined,
    mode: "fresh-cache" | "resume-reappend",
    sessionId: string,
  ): Promise<NativeStartupTitleOutcome> {
    if (!text) return { status: "absent" };
    const unknown = async (
      branch: string,
      fact: unknown,
    ): Promise<NativeStartupTitleOutcome> => {
      await this.#host.unsupported({
        branch,
        reason: "Actual title source fact is unavailable",
        facts: fact,
      });
      return { status: "unsupported" };
    };
    const host = this.#host.title,
      team = this.#effect(() => host.teamOwned());
    if (team.status !== "known") return unknown("title-team", team);
    if (team.value) return { status: "team-owned" };
    const name = normalizeNativeHookTitle(text);
    if (!name) return { status: "empty" };
    const current = this.#effect(() => host.current());
    if (current.status !== "known") return unknown("title-current", current);
    const old = current.value
      ? normalizeNativeHookTitle(current.value)
      : undefined;
    if (name === old) return { status: "unchanged", title: name };
    const collision = this.#effect(() =>
      host.collisionYield(name, old || undefined),
    );
    if (collision.status !== "known")
      return unknown("title-collision", collision);
    if (collision.value !== undefined) return { status: "collision-yielded" };
    this.#effect(() => {
      host.setTitle(name);
      host.setAgentName(name);
    });
    if (mode === "fresh-cache") return { status: "cached", title: name };
    const matches = this.#effect(() => host.sourcePathMatches(sessionId));
    if (matches.status !== "known")
      return unknown("title-source-path", matches);
    if (!matches.value) return { status: "cached-unmaterialized", title: name };
    const skip = this.#effect(() => host.persistenceSkipped());
    if (skip.status !== "known") return unknown("title-persistence", skip);
    if (skip.value)
      return { status: "cached-persistence-skipped", title: name };
    try {
      await host.reappend(sessionId);
      return { status: "reappended", title: name };
    } catch (error) {
      this.#effect(() => host.writeFailure(error));
      return { status: "write-failed", title: name };
    }
  }
  close(root: object): Promise<void> {
    if (root !== this.#root)
      return Promise.reject(new Error("Foreign startup root capability"));
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const lease of this.#leases) lease.retire();
    this.#closing = Promise.allSettled(this.#jobs).then((settled) => {
      const failures = settled.flatMap((entry): unknown[] =>
        entry.status === "rejected" ? [entry.reason] : [],
      );
      const errors = [
        ...new Set([
          ...this.#jobErrors,
          ...failures,
          ...(this.#failure ? [this.#failure] : []),
        ]),
      ];
      if (errors.length)
        throw new NativeStartupMetadataError(
          new AggregateError(errors, "Startup metadata jobs failed"),
        );
    });
    return this.#closing;
  }
}
