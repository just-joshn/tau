import { isAbsolute } from "node:path";
import {
  foregroundSubagentReport,
  type ForegroundSubagentReport,
  type SubagentChildResult,
  type SubagentFeature,
  type SubagentPlan,
} from "./subagent-runtime.js";
import { toolCallForExecution } from "./tool-call-normalization.js";
import {
  messageSchema,
  type Message,
  type ToolExecutor,
  type ToolUse,
} from "./types.js";

type Plan = Readonly<SubagentPlan>;
export type BackgroundTaskStatus =
  "running" | "completed" | "failed" | "killed";
export type BackgroundKillCause = "parent" | "user" | "system";
export interface BackgroundAgentProgress {
  messages?: readonly Message[];
  model?: string;
  latestInputTokens?: number;
  cumulativeOutputTokens?: number;
  streamedTokenEstimate?: number;
  toolsInFlight?: number;
  /** A provider's emission-time usage stamps must not be overwritten from reconciled history. */
  usageSource?: "stream-stamped";
}
export interface BackgroundAgentUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}
export interface BackgroundTaskSnapshot {
  id: string;
  agentId: string;
  sessionId: string;
  type: "local_agent";
  status: BackgroundTaskStatus;
  toolUseId?: string;
  ownerAgentId?: string;
  parentAgentId?: string;
  spawnDepth: number;
  agentType: string;
  description: string;
  prompt: string;
  model: string;
  outputFile: string;
  isBackgrounded: true;
  startTime: number;
  endTime?: number;
  messages: readonly Message[];
  progress: {
    latestInputTokens: number;
    cumulativeOutputTokens: number;
    streamedTokenEstimate: number;
    toolsInFlight: number;
  };
  result?: ForegroundSubagentReport;
  usage?: BackgroundAgentUsage;
  outcome?: "completed" | "max_turns";
  error?: string;
  killedBy?: BackgroundKillCause;
  settled: boolean;
  notification: "none" | "pending" | "enqueued" | "failed";
  deliveryError?: string;
  persistenceError?: string;
  cleanupError?: string;
}
export interface BackgroundAgentCompletion {
  taskId: string;
  ownerAgentId?: string;
  parentAgentId?: string;
  description: string;
  toolUseId?: string;
  status: Exclude<BackgroundTaskStatus, "running">;
  outputFile: string;
  report?: ForegroundSubagentReport;
  usage?: BackgroundAgentUsage;
  error?: string;
  killedBy?: BackgroundKillCause;
  maxTurnsReached?: number;
  /** Preserve unfinished output for a host's source-aware partial-result projector. */
  partialMessages?: readonly Message[];
}
export interface BackgroundAgentMaterialization {
  system: string;
  tools: ToolExecutor;
  contextMessages?: readonly Message[];
  /** Executor reapplies live parent floors after its own hooks/rewrites. These are host attestations, never grants. */
  enforcesLiveParentPolicy: true;
  enforcesBackgroundToolScope: true;
  permissionPrompts: "avoid" | "host-routed";
  handledFeatures?: readonly SubagentFeature[];
  afterStart?(signal: AbortSignal): Promise<readonly Message[]>;
  cleanup?(): void | Promise<void>;
}
export interface BackgroundWatchdogHandle {
  progress(progress: Readonly<BackgroundAgentProgress>): void;
  dispose(): void;
}
export interface BackgroundAgentRuntimeOptions {
  sessionId: string;
  /** Receives only an already admitted plan; still checks current background admission before publication. */
  admit(
    plan: Plan,
    signal: AbortSignal,
  ): boolean | string | Promise<boolean | string>;
  materialize(request: {
    plan: Plan;
    isAsync: true;
    signal: AbortSignal;
  }): BackgroundAgentMaterialization | Promise<BackgroundAgentMaterialization>;
  authorizeTool(
    call: ToolUse,
    plan: Plan,
    signal: AbortSignal,
  ): boolean | string | Promise<boolean | string>;
  /** Adapter owns child-local Start/Stop hooks and independent query budgets, as in the foreground runner. */
  runChild(request: {
    plan: Plan;
    system: string;
    messages: Message[];
    tools: ToolExecutor;
    signal: AbortSignal;
    isAsync: true;
    permissionPrompts: BackgroundAgentMaterialization["permissionPrompts"];
    prepareAfterStart?(): Promise<void>;
    onProgress(progress: BackgroundAgentProgress): void;
  }): Promise<SubagentChildResult>;
  outputFile(plan: Plan): string;
  canReadOutputFile(plan: Plan): boolean;
  persist(snapshot: Readonly<BackgroundTaskSnapshot>): Promise<void>;
  enqueueNotification(
    notification: Readonly<BackgroundAgentCompletion>,
  ): void | Promise<void>;
  /** Await actual process/tool sweep, not the full child query. A live-loop stop handle remains until settlement. */
  cleanupTask(request: {
    task: Readonly<BackgroundTaskSnapshot>;
    reason: "stop" | "session-close";
  }): Promise<number | void>;
  watchdog:
    | { kind: "unsupported" }
    | {
        kind: "adapter";
        start(request: {
          taskId: string;
          signal: AbortSignal;
          onTimeout(message: string): void;
        }): BackgroundWatchdogHandle;
      };
  now?(): number;
  onDiagnostic?(message: string): void;
}
export interface BackgroundAgentLaunchResult {
  isAsync: true;
  status: "async_launched";
  agentId: string;
  description: string;
  resolvedModel: string;
  prompt: string;
  outputFile: string;
  canReadOutputFile: boolean;
  canContinueAgent: false;
}
/** To's ordinary local/custom-agent branch. The host resolves caller-specific default async admission. */
export function ordinaryLocalAgentLaunchMode(options: {
  requestedBackground?: boolean;
  definitionBackground?: boolean;
  backgroundTasksDisabled: boolean;
  defaultAsync: boolean;
}): "background" | "foreground" {
  return !options.backgroundTasksDisabled &&
    (options.requestedBackground === true ||
      options.definitionBackground === true ||
      (options.defaultAsync && options.requestedBackground !== false))
    ? "background"
    : "foreground";
}
export class BackgroundTaskError extends Error {
  constructor(
    message: string,
    readonly code:
      "not_found" | "not_running" | "not_owner" | "closed" | "duplicate",
  ) {
    super(message);
    this.name = "BackgroundTaskError";
  }
}
interface Task {
  plan: Plan;
  snapshot: BackgroundTaskSnapshot;
  controller: AbortController;
  materialized: BackgroundAgentMaterialization;
  settlement: Promise<void>;
  writes: Promise<void>;
  forcedFailure?: string;
  watchdog?: BackgroundWatchdogHandle;
  streamStamped?: true;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function immutable<T>(value: T): T {
  const clone = structuredClone(value),
    seen = new WeakSet<object>();
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}
const finiteCount = (value: number) => Number.isFinite(value) && value >= 0;

/** One-run ordinary local scheduler. It never discovers state, invokes a provider or grants tool permissions. */
export function createBackgroundAgentRuntime(
  options: BackgroundAgentRuntimeOptions,
) {
  const tasks = new Map<string, Task>(),
    launching = new Set<string>(),
    subscribers = new Set<() => void>();
  const admissions = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  const now = options.now ?? Date.now;
  let closed = false;
  const publish = (): void => {
    for (const callback of subscribers)
      try {
        callback();
      } catch (error) {
        options.onDiagnostic?.(
          `Background task subscriber failed: ${errorText(error)}`,
        );
      }
  };
  const snapshot = (task: Task) => immutable(task.snapshot);
  const find = (id: string): Task => {
    const task = tasks.get(id);
    if (!task)
      throw new BackgroundTaskError(
        `No task found with ID: ${id}`,
        "not_found",
      );
    return task;
  };
  const persist = (task: Task): Promise<void> => {
    const value = snapshot(task);
    task.writes = task.writes
      .then(() => options.persist(value))
      .catch((error) => {
        task.snapshot.persistenceError = errorText(error);
        options.onDiagnostic?.(
          `Background task ${task.snapshot.id} archive failed: ${errorText(error)}`,
        );
        publish();
      });
    return task.writes;
  };
  const updateProgress = (
    task: Task,
    progress: BackgroundAgentProgress,
  ): void => {
    if (task.snapshot.status !== "running" || task.snapshot.settled) return;
    if (progress.usageSource === "stream-stamped") task.streamStamped = true;
    for (const key of [
      "latestInputTokens",
      "cumulativeOutputTokens",
      "streamedTokenEstimate",
      "toolsInFlight",
    ] as const) {
      if (progress[key] !== undefined) {
        if (!finiteCount(progress[key]))
          throw new Error(`Invalid background progress ${key}`);
        task.snapshot.progress[key] = progress[key];
      }
    }
    if (progress.messages !== undefined)
      task.snapshot.messages = structuredClone(progress.messages);
    if (progress.model !== undefined) task.snapshot.model = progress.model;
    task.watchdog?.progress(immutable(progress));
    void persist(task);
    publish();
  };
  const notify = async (task: Task): Promise<void> => {
    const value = task.snapshot;
    if (value.notification !== "none" || value.status === "running") return;
    value.notification = "pending";
    publish();
    await persist(task);
    const notification: BackgroundAgentCompletion = {
      taskId: value.id,
      description: value.description,
      status: value.status,
      outputFile: value.outputFile,
      ...(value.toolUseId === undefined ? {} : { toolUseId: value.toolUseId }),
      ...(value.ownerAgentId === undefined
        ? {}
        : { ownerAgentId: value.ownerAgentId }),
      ...(value.parentAgentId === undefined
        ? {}
        : { parentAgentId: value.parentAgentId }),
      ...(value.result === undefined ? {} : { report: value.result }),
      ...(value.usage === undefined ? {} : { usage: value.usage }),
      ...(value.error === undefined ? {} : { error: value.error }),
      ...(value.killedBy === undefined ? {} : { killedBy: value.killedBy }),
      ...(value.status === "completed" || !value.messages.length
        ? {}
        : { partialMessages: value.messages }),
      ...(value.outcome !== "max_turns" || task.plan.maxTurns === undefined
        ? {}
        : { maxTurnsReached: task.plan.maxTurns }),
    };
    try {
      await options.enqueueNotification(immutable(notification));
      value.notification = "enqueued";
    } catch (error) {
      value.notification = "failed";
      value.deliveryError = errorText(error);
      options.onDiagnostic?.(
        `Background task ${value.id} notification failed: ${value.deliveryError}`,
      );
    }
    await persist(task);
    publish();
  };
  const run = async (task: Task): Promise<void> => {
    try {
      if (options.watchdog.kind === "adapter")
        task.watchdog = options.watchdog.start({
          taskId: task.snapshot.id,
          signal: task.controller.signal,
          onTimeout(message) {
            if (task.snapshot.status !== "running") return;
            task.forcedFailure = message;
            task.controller.abort(new Error(message));
          },
        });
      const materialized = task.materialized,
        allowed = new Set(
          materialized.tools.definitions
            .filter((tool) => task.plan.selectedToolNames.includes(tool.name))
            .map((tool) => tool.name),
        );
      const tools: ToolExecutor = {
        ...materialized.tools,
        get definitions() {
          return structuredClone(
            materialized.tools.definitions.filter((tool) =>
              allowed.has(tool.name),
            ),
          );
        },
        async execute(original, signal) {
          signal.throwIfAborted();
          task.controller.signal.throwIfAborted();
          const call = toolCallForExecution(original);
          if (!allowed.has(call.name))
            return {
              type: "tool_result",
              tool_use_id: call.id,
              content: `Child tool is outside the admitted background scope: ${call.name}`,
              is_error: true,
              permissionDenied: true,
            };
          const decision = await options.authorizeTool(
            toolCallForExecution(call),
            task.plan,
            task.controller.signal,
          );
          task.controller.signal.throwIfAborted();
          if (decision !== true)
            return {
              type: "tool_result",
              tool_use_id: call.id,
              content:
                typeof decision === "string"
                  ? decision
                  : "Parent policy denied the background tool",
              is_error: true,
              permissionDenied: true,
            };
          return materialized.tools.execute(
            toolCallForExecution(call),
            task.controller.signal,
          );
        },
      };
      const messages = structuredClone([...task.snapshot.messages]),
        afterStart = materialized.afterStart;
      let preparedAfterStart = false;
      const prepareAfterStart =
        afterStart &&
        (async () => {
          if (preparedAfterStart)
            throw new Error(
              "Background after-Start context was already prepared",
            );
          const values = await afterStart(task.controller.signal);
          task.controller.signal.throwIfAborted();
          const rows = values.map((value) =>
            messageSchema.parse(structuredClone(value)),
          );
          if (rows.some((value) => value.role !== "user"))
            throw new Error(
              "Fresh background after-Start context cannot inherit assistant history",
            );
          messages.push(...rows);
          preparedAfterStart = true;
        });
      task.controller.signal.throwIfAborted();
      const child = await options.runChild({
        plan: task.plan,
        system: materialized.system,
        messages,
        tools,
        signal: task.controller.signal,
        isAsync: true,
        permissionPrompts: materialized.permissionPrompts,
        ...(prepareAfterStart ? { prepareAfterStart } : {}),
        onProgress: (progress) => updateProgress(task, progress),
      });
      if (materialized.afterStart && !preparedAfterStart)
        throw new Error(
          "Background child host skipped after-Start context preparation",
        );
      task.snapshot.messages = structuredClone(child.messages);
      if (task.forcedFailure !== undefined) throw new Error(task.forcedFailure);
      if (task.snapshot.status === "running") {
        task.controller.signal.throwIfAborted();
        const report = foregroundSubagentReport(
          child.messages,
          task.plan,
          now() - task.snapshot.startTime,
          child.outcome,
          child.modelsUsed,
        );
        const progress = task.snapshot.progress;
        const metered = child.messages.flatMap((message) =>
          message.role === "assistant" && message.usage !== undefined
            ? [message.usage]
            : [],
        );
        const lastUsage = metered.at(-1);
        if (!task.streamStamped && lastUsage)
          progress.latestInputTokens =
            lastUsage.input_tokens +
            (lastUsage.cache_creation_input_tokens ?? 0) +
            (lastUsage.cache_read_input_tokens ?? 0);
        // Full returned histories provide the ordinary FNr fallback. A progress
        // adapter retains output totals across child compaction/history pruning.
        if (!task.streamStamped)
          progress.cumulativeOutputTokens = Math.max(
            progress.cumulativeOutputTokens,
            metered.reduce((sum, usage) => sum + usage.output_tokens, 0),
          );
        task.snapshot.result = report;
        task.snapshot.status = "completed";
        task.snapshot.outcome = child.outcome ?? "completed";
        task.snapshot.usage = {
          totalTokens: Math.max(
            report.totalTokens,
            progress.latestInputTokens +
              progress.cumulativeOutputTokens +
              progress.streamedTokenEstimate,
          ),
          toolUses: report.totalToolUseCount,
          durationMs: report.totalDurationMs,
        };
      }
    } catch (error) {
      if (task.snapshot.status !== "killed") {
        task.snapshot.status = "failed";
        task.snapshot.error = task.forcedFailure ?? errorText(error);
      }
    } finally {
      task.snapshot.endTime ??= now();
      try {
        task.watchdog?.dispose();
      } catch (error) {
        options.onDiagnostic?.(
          `Background watchdog cleanup failed: ${errorText(error)}`,
        );
      }
      try {
        await task.materialized.cleanup?.();
      } catch (error) {
        options.onDiagnostic?.(
          `Background task cleanup failed: ${errorText(error)}`,
        );
      }
      await persist(task);
      await notify(task);
      task.snapshot.settled = true;
      await persist(task);
      publish();
    }
  };
  const stop = async (
    id: string,
    request: {
      callerAgentId?: string;
      killedBy?: BackgroundKillCause;
      reason?: "stop" | "session-close";
    } = {},
  ) => {
    const task = find(id),
      value = task.snapshot;
    if (
      request.callerAgentId !== undefined &&
      request.callerAgentId !== value.agentId
    )
      throw new BackgroundTaskError(
        `The main session, the user or the agent itself can stop task ${id}; agent ${request.callerAgentId} cannot stop it.`,
        "not_owner",
      );
    if (value.status !== "running" && value.settled)
      throw new BackgroundTaskError(
        `Task ${id} is not running (status: ${value.status})`,
        "not_running",
      );
    const ended = value.status !== "running";
    if (!ended) {
      value.status = "killed";
      value.killedBy = request.killedBy ?? "parent";
      value.endTime = now();
    }
    task.controller.abort(
      new DOMException("Background task stopped", "AbortError"),
    );
    publish();
    void persist(task);
    let count: number | void;
    try {
      count = await options.cleanupTask({
        task: snapshot(task),
        reason: request.reason ?? "stop",
      });
    } catch (error) {
      value.cleanupError = errorText(error);
      options.onDiagnostic?.(
        `Background task ${id} process cleanup failed: ${value.cleanupError}`,
      );
      void persist(task);
      publish();
      throw error;
    }
    return {
      message: ended
        ? `Task ${id} had already ended (${value.status}) but its loop had not exited; re-signalled it and killed ${count ?? 0} process group(s). The record remains listed while the loop is still live.`
        : `Successfully stopped task: ${id} (${value.description})`,
      task_id: id,
      task_type: "local_agent" as const,
      command: value.description,
    };
  };
  return {
    limitations: [
      "One ordinary local run only; no resume, messaging, names, remote/team/worktree/forced-fork or native parked-child keepalive",
      "Persistence and notification projection are explicit host adapters; native JSONL, symlink/sidecar and peer discovery are not inferred",
      ...(options.watchdog.kind === "unsupported"
        ? [
            "Native progress-aware background watchdog is not implemented by this host",
          ]
        : []),
    ],
    async launch(
      inputPlan: Plan,
      request: {
        admissionSignal: AbortSignal;
        ownerAgentId?: string;
        parentAgentId?: string;
      },
    ): Promise<BackgroundAgentLaunchResult> {
      request.admissionSignal.throwIfAborted();
      if (closed)
        throw new BackgroundTaskError(
          "Background agent runtime is closed",
          "closed",
        );
      const plan = immutable(inputPlan),
        id = plan.agentId;
      if (plan.parent.sessionId !== options.sessionId)
        throw new Error("Background plan belongs to another session");
      if (
        plan.definition.agentType === "fork" ||
        plan.definition.isolation !== undefined ||
        plan.input.isolation !== undefined ||
        plan.input.name !== undefined ||
        plan.input.team_name !== undefined ||
        plan.input.mode !== undefined ||
        plan.definition.observer ||
        plan.definition.observerMessage ||
        plan.definition.observeSubagents !== undefined
      )
        throw new Error(
          "Ordinary background scheduler does not support fork, isolation, named/team, spawn-mode or observer execution",
        );
      if (tasks.has(id) || launching.has(id))
        throw new BackgroundTaskError(
          `Background agent ${id} is already registered`,
          "duplicate",
        );
      launching.add(id);
      const controller = new AbortController();
      let finishAdmission!: () => void;
      const admissionDone = new Promise<void>((resolve) => {
        finishAdmission = resolve;
      });
      const admissionSignal = AbortSignal.any([
        request.admissionSignal,
        controller.signal,
      ]);
      admissions.set(id, { controller, done: admissionDone });
      let materialized: BackgroundAgentMaterialization | undefined;
      let registered: BackgroundTaskSnapshot | undefined;
      try {
        const decision = await options.admit(plan, admissionSignal);
        admissionSignal.throwIfAborted();
        if (decision !== true)
          throw new Error(
            typeof decision === "string"
              ? decision
              : "Background agent admission denied",
          );
        materialized = await options.materialize({
          plan,
          isAsync: true,
          signal: admissionSignal,
        });
        admissionSignal.throwIfAborted();
        if (
          materialized.enforcesLiveParentPolicy !== true ||
          materialized.enforcesBackgroundToolScope !== true ||
          !["avoid", "host-routed"].includes(materialized.permissionPrompts)
        )
          throw new Error(
            "Background materialization requires live parent policy, background tool scope and explicit permission-prompt policy",
          );
        const required: SubagentFeature[] = [
          ...(plan.definition.hooks === undefined ? [] : ["hooks" as const]),
          ...(plan.definition.skills.length ? ["skills" as const] : []),
          ...(plan.definition.memory ? ["memory" as const] : []),
          ...(plan.definition.mcpServers?.length
            ? ["mcpServers" as const]
            : []),
          ...(plan.definition.omitClaudeMd ? ["omitClaudeMd" as const] : []),
        ];
        for (const feature of required)
          if (!materialized.handledFeatures?.includes(feature))
            throw new Error(
              `Background ${feature} requires an admitted host adapter`,
            );
        if (
          materialized.contextMessages?.some(
            (message) => message.role !== "user",
          )
        )
          throw new Error(
            "Fresh background agents cannot inherit assistant conversation context",
          );
        const outputFile = options.outputFile(plan);
        if (!isAbsolute(outputFile))
          throw new Error(
            "Background output path must be explicit and absolute",
          );
        const canReadOutputFile = options.canReadOutputFile(plan);
        const value: BackgroundTaskSnapshot = {
          id,
          agentId: id,
          sessionId: options.sessionId,
          type: "local_agent",
          status: "running",
          spawnDepth: plan.depth,
          ...(plan.toolUseId === undefined
            ? {}
            : { toolUseId: plan.toolUseId }),
          ...(request.ownerAgentId === undefined
            ? {}
            : { ownerAgentId: request.ownerAgentId }),
          ...(request.parentAgentId === undefined
            ? {}
            : { parentAgentId: request.parentAgentId }),
          agentType: plan.definition.agentType,
          description: plan.input.description,
          prompt: plan.input.prompt,
          model: plan.model,
          outputFile,
          isBackgrounded: true,
          startTime: now(),
          messages: [
            ...structuredClone(materialized.contextMessages ?? []),
            {
              role: "user",
              content: [{ type: "text", text: plan.input.prompt }],
            },
          ],
          progress: {
            latestInputTokens: 0,
            cumulativeOutputTokens: 0,
            streamedTokenEstimate: 0,
            toolsInFlight: 0,
          },
          settled: false,
          notification: "none",
        };
        await options.persist(immutable(value));
        registered = value;
        admissionSignal.throwIfAborted();
        if (closed)
          throw new BackgroundTaskError(
            "Background agent runtime closed during admission",
            "closed",
          );
        const task: Task = {
          plan,
          snapshot: value,
          controller: new AbortController(),
          materialized,
          settlement: Promise.resolve(),
          writes: Promise.resolve(),
        };
        tasks.set(id, task);
        materialized = undefined;
        task.settlement = Promise.resolve().then(() => run(task));
        publish();
        return {
          isAsync: true,
          status: "async_launched",
          agentId: id,
          description: value.description,
          resolvedModel: value.model,
          prompt: value.prompt,
          outputFile,
          canReadOutputFile,
          canContinueAgent: false,
        };
      } catch (error) {
        if (registered && !tasks.has(id)) {
          registered.status = "killed";
          registered.killedBy = closed ? "system" : "parent";
          registered.error = errorText(error);
          registered.endTime = now();
          registered.settled = true;
          try {
            await options.persist(immutable(registered));
          } catch (archiveError) {
            options.onDiagnostic?.(
              `Cancelled background registration archive failed: ${errorText(archiveError)}`,
            );
          }
        }
        try {
          await materialized?.cleanup?.();
        } catch (cleanupError) {
          options.onDiagnostic?.(
            `Failed background admission cleanup: ${errorText(cleanupError)}`,
          );
        }
        throw error;
      } finally {
        launching.delete(id);
        admissions.delete(id);
        finishAdmission();
      }
    },
    get(id: string): Readonly<BackgroundTaskSnapshot> {
      return snapshot(find(id));
    },
    list(): readonly Readonly<BackgroundTaskSnapshot>[] {
      return [...tasks.values()].map(snapshot);
    },
    get hasRunning(): boolean {
      return [...tasks.values()].some(
        (task) => task.snapshot.status === "running",
      );
    },
    get hasUnsettled(): boolean {
      return [...tasks.values()].some((task) => !task.snapshot.settled);
    },
    get hasPendingNotifications(): boolean {
      return [...tasks.values()].some(
        (task) => task.snapshot.notification === "pending",
      );
    },
    subscribe(callback: () => void): () => void {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    async settled(id?: string): Promise<void> {
      await Promise.all(
        id === undefined
          ? [...tasks.values()].map((task) => task.settlement)
          : [find(id).settlement],
      );
    },
    stop,
    async close(): Promise<void> {
      closed = true;
      const pending = [...admissions.values()];
      for (const admission of pending)
        admission.controller.abort(
          new DOMException(
            "Background session closed during admission",
            "AbortError",
          ),
        );
      await Promise.all(pending.map((admission) => admission.done));
      await Promise.allSettled(
        [...tasks.values()]
          .filter((task) => !task.snapshot.settled)
          .map((task) =>
            stop(task.snapshot.id, {
              killedBy: "system",
              reason: "session-close",
            }),
          ),
      );
      await Promise.all([...tasks.values()].map((task) => task.settlement));
    },
  };
}
