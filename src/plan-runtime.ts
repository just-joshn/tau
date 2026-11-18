import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolResult, ToolUse } from "./types.js";

export type PlanPermissionMode =
  "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk";
export interface PlanPermissionState {
  mode: PlanPermissionMode;
  prePlanMode?: PlanPermissionMode;
  planEnteredBy?: "model";
  isBypassPermissionsModeAvailable?: boolean;
  planDoc?: unknown;
  [key: string]: unknown;
}
export interface PlanActor {
  agentId?: string;
  builtInFork?: boolean;
  teammate?: { requiresApproval: boolean; taskAvailable: boolean };
}
export interface PlanSaveResult {
  savedPath?: string;
  notice?: string;
}
export interface PlanStorage {
  /** Fresh effective text, or null for absent/unavailable storage under the host's read policy. */
  read(path: string, signal: AbortSignal): Promise<string | null>;
  /** Return the actual saved path, or a notice without a path if persistence failed. */
  save(
    path: string,
    text: string,
    signal: AbortSignal,
  ): Promise<PlanSaveResult>;
}
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reservedSlug = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
export function validPlanSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 100 &&
    slugPattern.test(value) &&
    !reservedSlug.test(value)
  );
}
/** Candidate selection only; the host verifies real-path/symlink/hard-link containment. */
export function selectPlanDirectory(options: {
  projectRoot: string;
  defaultDirectory: string;
  configuredDirectory?: string;
  vet(candidate: string, projectRoot: string): boolean;
}): string {
  if (!isAbsolute(options.projectRoot) || !isAbsolute(options.defaultDirectory))
    throw new Error("Plan roots must be explicit absolute paths");
  if (!options.configuredDirectory) return resolve(options.defaultDirectory);
  if (sep !== "\\" && options.configuredDirectory.includes("\\"))
    return resolve(options.defaultDirectory);
  const candidate = resolve(options.projectRoot, options.configuredDirectory),
    rel = relative(options.projectRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return resolve(options.defaultDirectory);
  try {
    return options.vet(candidate, options.projectRoot)
      ? candidate
      : resolve(options.defaultDirectory);
  } catch {
    return resolve(options.defaultDirectory);
  }
}

/** Explicit session slug/path state; no home, settings, transcript or disk discovery. */
export class PlanFileManager {
  private readonly slugs = new Map<string, string>();
  private readonly reserved = new Set<string>();
  private readonly directories = new Map<string, string>();
  readonly directory: string;
  constructor(
    private readonly options: {
      directory: string;
      /** Host supplies its naming policy; the original private word lists are not copied. */
      createSlug(context: {
        sessionId: string;
        seed?: string;
        attempt: number;
      }): string;
      knownNames?: readonly string[];
      onSlug?(sessionId: string, slug: string): void;
    },
  ) {
    if (!isAbsolute(options.directory))
      throw new Error("Plans directory must be absolute");
    this.directory = resolve(options.directory);
    for (const name of options.knownNames ?? []) this.reserved.add(name);
  }
  peekSlug(sessionId: string): string | undefined {
    return this.slugs.get(sessionId);
  }
  restore(sessionId: string, slug: unknown): boolean {
    if (!sessionId || !validPlanSlug(slug)) return false;
    this.slugs.set(sessionId, slug);
    this.reserved.add(`${slug}.md`);
    this.options.onSlug?.(sessionId, slug);
    return true;
  }
  path(sessionId: string, agentId?: string, seed?: string): string {
    if (!sessionId) throw new Error("Plan paths require a session id");
    if (agentId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(agentId))
      throw new Error("Invalid agent id for a plan filename");
    let slug = this.slugs.get(sessionId);
    if (!slug) {
      // Source makes ten attempts against the primed listing, then keeps the last candidate.
      for (let attempt = 0; attempt < 10; attempt++) {
        slug = this.options.createSlug({
          sessionId,
          attempt,
          ...(seed === undefined ? {} : { seed }),
        });
        if (!validPlanSlug(slug))
          throw new Error("Plan slug factory returned an invalid slug");
        if (!this.reserved.has(`${slug}.md`)) break;
      }
      this.restore(sessionId, slug);
    }
    return join(
      this.directories.get(sessionId) ?? this.directory,
      agentId ? `${slug}-agent-${agentId}.md` : `${slug}.md`,
    );
  }
  /** A storage fallback may change the designated directory and slug together. */
  adoptSavedPath(sessionId: string, path: string): void {
    if (
      !isAbsolute(path) ||
      !path.endsWith(".md") ||
      !validPlanSlug(basename(path, ".md"))
    )
      throw new Error("Storage returned an invalid designated plan path");
    this.restore(sessionId, basename(path, ".md"));
    this.directories.set(sessionId, resolve(dirname(path)));
  }
  isSessionPlanPath(sessionId: string, path: string): boolean {
    const slug = this.slugs.get(sessionId);
    if (!slug || !isAbsolute(path)) return false;
    const candidate = resolve(path),
      directory = this.directories.get(sessionId) ?? this.directory;
    if (dirname(candidate) !== directory) return false;
    const name = basename(candidate);
    return (
      name === `${slug}.md` ||
      (name.startsWith(`${slug}-agent-`) && name.endsWith(".md"))
    );
  }
  clear(sessionId: string): void {
    this.slugs.delete(sessionId);
    this.directories.delete(sessionId);
  }
}

export interface PlanToolPermission {
  behavior: "allow" | "ask";
  tool: "EnterPlanMode" | "ExitPlanMode";
  plan: string | null;
  filePath?: string;
  personOnly?: boolean;
}
export interface PlanApproval {
  approved: boolean;
  updatedInput?: unknown;
  reason?: string;
}
export interface PlanTransition {
  from: PlanPermissionMode;
  to: PlanPermissionMode;
  reason: "enter_plan_mode" | "exit_plan_mode";
}
export interface PlanExecution {
  result: ToolResult;
  data: Record<string, unknown>;
  transition?: PlanTransition;
  notices: string[];
}
export interface PreparedPlanCall {
  call: ToolUse;
  sessionId: string;
  actor: PlanActor;
  input: Record<string, unknown>;
}
const enterSchema = z.object({}).strict();
const exitSchema = z
  .object({
    allowedPrompts: z
      .array(z.object({ tool: z.literal("Bash"), prompt: z.string() }))
      .optional(),
  })
  .passthrough();
export class PlanInputRejected extends Error {
  readonly inputRejected = true;
  constructor(message: string) {
    super(message);
    this.name = "PlanInputRejected";
  }
}
export class PlanApprovalRejected extends Error {
  readonly permissionDenied = true;
  constructor(message: string) {
    super(message);
    this.name = "PlanApprovalRejected";
  }
}

/** Local file-backed plan tools with explicit approval, state and storage seams. */
export class PlanRuntime {
  private readonly prepared = new WeakSet<PreparedPlanCall>();
  constructor(
    private readonly options: {
      sessionId(): string;
      actor?(): PlanActor;
      permissions(): PlanPermissionState;
      setPermissions(
        update: (state: PlanPermissionState) => PlanPermissionState,
      ): void;
      files: PlanFileManager;
      storage: PlanStorage;
      /** Interactive UI or an explicit headless permission-prompt bridge. */
      canRequestApproval(): boolean;
      approve(
        request: PlanToolPermission,
        signal: AbortSignal,
      ): Promise<PlanApproval>;
      /** Diskless/Doc plan sessions have different schemas and are explicitly unsupported here. */
      fileBacked?: boolean;
      enterRequiresApproval?: boolean;
      denyInsteadOfPrompting?: boolean;
      canRestoreMode?(
        mode: PlanPermissionMode,
        state: PlanPermissionState,
      ): boolean | { allowed: boolean; reason?: string };
      prepareTransition?(
        state: PlanPermissionState,
        transition: PlanTransition,
      ): PlanPermissionState;
      submitLeaderPlan?(
        request: {
          sessionId: string;
          agentId?: string;
          filePath: string;
          plan: string;
        },
        signal: AbortSignal,
      ): Promise<{ requestId: string }>;
      hasTaskTool?(): boolean;
    },
  ) {}
  get definitions(): ToolDefinition[] {
    if (
      this.options.fileBacked === false ||
      this.options.denyInsteadOfPrompting ||
      !this.options.canRequestApproval()
    )
      return [];
    return [
      {
        name: "EnterPlanMode",
        description: "Enter planning mode for the current session.",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "ExitPlanMode",
        description:
          "Request approval of the current plan and leave planning mode.",
        input_schema: {
          type: "object",
          properties: {
            allowedPrompts: {
              type: "array",
              description: "Deprecated; ignored.",
              items: {
                type: "object",
                properties: {
                  tool: { enum: ["Bash"] },
                  prompt: { type: "string" },
                },
                required: ["tool", "prompt"],
              },
            },
          },
          additionalProperties: true,
        },
      },
    ];
  }
  planLocation(seed?: string): string | undefined {
    if (
      this.options.permissions().mode !== "plan" ||
      this.options.fileBacked === false
    )
      return undefined;
    return this.options.files.path(
      this.options.sessionId(),
      this.options.actor?.().agentId,
      seed,
    );
  }
  /** Eligibility only: callers still apply denies/asks, validation, read-state and link safety. */
  isSessionPlanPath(path: string): boolean {
    return (
      this.options.fileBacked !== false &&
      this.options.files.isSessionPlanPath(this.options.sessionId(), path)
    );
  }
  async prepare(call: ToolUse, signal: AbortSignal): Promise<PreparedPlanCall> {
    signal.throwIfAborted();
    if (!this.definitions.some((tool) => tool.name === call.name))
      throw new PlanInputRejected(
        "The requested plan tool is unavailable in this session",
      );
    const sessionId = this.options.sessionId(),
      actor = structuredClone(this.options.actor?.() ?? {});
    let input: Record<string, unknown>;
    if (call.name === "EnterPlanMode") {
      input = enterSchema.parse(call.input);
    } else if (call.name === "ExitPlanMode") {
      input = exitSchema.parse(call.input);
      // Local model-supplied approval text/path is replaced by the designated file.
      const { plan: _plan, planFilePath: _path, ...ordinary } = input;
      input = ordinary;
      const path = this.options.files.path(sessionId, actor.agentId),
        plan = await this.options.storage.read(path, signal);
      if (plan !== null) input = { ...input, plan, planFilePath: path };
    } else throw new PlanInputRejected("Unknown plan tool");
    this.validateContext(call.name, actor);
    signal.throwIfAborted();
    if (sessionId !== this.options.sessionId())
      throw new PlanInputRejected(
        "The active session changed while preparing the plan tool",
      );
    const prepared = { call: { ...call, input }, sessionId, actor, input };
    this.prepared.add(prepared);
    return prepared;
  }
  /** Full trusted replacement: hooks revalidate the context; an answering UI may already have changed mode. */
  replacePreparedInput(
    prepared: PreparedPlanCall,
    value: unknown,
    source: "hook" | "approval" = "hook",
  ): PreparedPlanCall {
    this.assertPrepared(prepared);
    const input =
      prepared.call.name === "EnterPlanMode"
        ? enterSchema.parse(value)
        : exitSchema.parse(value);
    if (source === "hook")
      this.validateContext(prepared.call.name, prepared.actor);
    const replacement = {
      ...prepared,
      input,
      call: { ...prepared.call, input },
    };
    this.prepared.add(replacement);
    return replacement;
  }
  checkPermissions(prepared: PreparedPlanCall): PlanToolPermission {
    this.assertPrepared(prepared);
    const entering = prepared.call.name === "EnterPlanMode";
    const promptOnEntry =
      entering &&
      this.options.enterRequiresApproval &&
      !["auto", "plan"].includes(this.options.permissions().mode);
    return {
      behavior: entering
        ? promptOnEntry
          ? "ask"
          : "allow"
        : prepared.actor.teammate
          ? "allow"
          : "ask",
      tool: entering ? "EnterPlanMode" : "ExitPlanMode",
      plan:
        typeof prepared.input.plan === "string" ? prepared.input.plan : null,
      ...(typeof prepared.input.planFilePath === "string"
        ? { filePath: prepared.input.planFilePath }
        : {}),
      ...(promptOnEntry ? { personOnly: true } : {}),
    };
  }
  async execute(call: ToolUse, signal: AbortSignal): Promise<PlanExecution> {
    let prepared = await this.prepare(call, signal);
    const permission = this.checkPermissions(prepared);
    if (permission.behavior === "ask") {
      const approval = await this.options.approve(permission, signal);
      signal.throwIfAborted();
      if (!approval.approved)
        throw new PlanApprovalRejected(
          approval.reason ??
            "Plan approval was declined; planning remains active",
        );
      if (approval.updatedInput !== undefined) {
        prepared = this.replacePreparedInput(
          prepared,
          approval.updatedInput,
          "approval",
        );
      }
    }
    return this.call(prepared, signal);
  }
  /** Host dispatchers call only after their full permission/hook pipeline approved it. */
  async call(
    prepared: PreparedPlanCall,
    signal: AbortSignal,
  ): Promise<PlanExecution> {
    this.assertPrepared(prepared);
    signal.throwIfAborted();
    if (prepared.call.name === "EnterPlanMode") {
      let transition: PlanTransition | undefined;
      this.options.setPermissions((state) => {
        if (state.mode === "plan") return state;
        transition = {
          from: state.mode,
          to: "plan",
          reason: "enter_plan_mode",
        };
        const effects =
          this.options.prepareTransition?.(state, transition) ?? state;
        const { planDoc: _doc, planEnteredBy: _entered, ...rest } = effects;
        return {
          ...rest,
          mode: "plan",
          prePlanMode: state.mode,
          ...(state.mode === "auto" ? { planEnteredBy: "model" as const } : {}),
        };
      });
      const data = { message: "Plan mode is active." };
      return {
        data,
        result: {
          type: "tool_result",
          tool_use_id: prepared.call.id,
          content: "Plan mode is active.",
          hookResponse: data,
        },
        notices: [],
        ...(transition ? { transition } : {}),
      };
    }
    let path = this.options.files.path(
      prepared.sessionId,
      prepared.actor.agentId,
    );
    const supplied =
      typeof prepared.input.plan === "string" ? prepared.input.plan : undefined;
    const plan = supplied ?? (await this.options.storage.read(path, signal)),
      notices: string[] = [];
    signal.throwIfAborted();
    this.assertPrepared(prepared);
    let savedPath: string | undefined = path;
    if (supplied !== undefined) {
      let saved: PlanSaveResult;
      try {
        saved = await this.options.storage.save(path, supplied, signal);
      } catch (error) {
        signal.throwIfAborted();
        saved = {
          notice:
            error instanceof Error
              ? error.message
              : "The approved plan could not be saved",
        };
      }
      signal.throwIfAborted();
      this.assertPrepared(prepared);
      savedPath = saved.savedPath;
      if (saved.notice) notices.push(saved.notice);
      if (savedPath && savedPath !== path && !prepared.actor.agentId) {
        this.options.files.adoptSavedPath(prepared.sessionId, savedPath);
        path = savedPath;
      }
    }
    const teammate = prepared.actor.teammate;
    if (
      teammate &&
      this.options.permissions().mode === "plan" &&
      !teammate.taskAvailable
    )
      throw new PlanInputRejected(
        "The teammate's task is unavailable; the leader must approve its plan",
      );
    if (teammate?.requiresApproval) {
      if (!plan)
        throw new PlanInputRejected(
          "Write a plan file before submitting it to the team leader",
        );
      if (!this.options.submitLeaderPlan)
        throw new PlanInputRejected(
          "Team plan approval requires a leader inbox adapter",
        );
      const pending = await this.options.submitLeaderPlan(
        {
          sessionId: prepared.sessionId,
          filePath: path,
          plan,
          ...(prepared.actor.agentId === undefined
            ? {}
            : { agentId: prepared.actor.agentId }),
        },
        signal,
      );
      signal.throwIfAborted();
      this.assertPrepared(prepared);
      const data = {
        plan,
        isAgent: true,
        filePath: path,
        awaitingLeaderApproval: true,
        requestId: pending.requestId,
      };
      return {
        data,
        notices,
        result: {
          type: "tool_result",
          tool_use_id: prepared.call.id,
          content: "Plan submitted to the team leader; approval is pending.",
          hookResponse: data,
        },
      };
    }
    let transition: PlanTransition | undefined;
    if (!teammate)
      this.options.setPermissions((state) => {
        if (state.mode !== "plan") return state;
        let target = state.prePlanMode ?? "default";
        if (target === "plan") target = "default";
        const verdict =
          this.options.canRestoreMode?.(target, state) ??
          (target === "auto"
            ? false
            : target !== "bypassPermissions" ||
              state.isBypassPermissionsModeAvailable === true);
        if (
          verdict === false ||
          (typeof verdict === "object" && !verdict.allowed)
        ) {
          notices.push(
            typeof verdict === "object" && verdict.reason
              ? verdict.reason
              : `Restoring ${target} is unavailable; using default permissions`,
          );
          target = "default";
        }
        transition = { from: "plan", to: target, reason: "exit_plan_mode" };
        const effects =
          this.options.prepareTransition?.(state, transition) ?? state;
        const {
          prePlanMode: _prior,
          planEnteredBy: _entered,
          ...rest
        } = effects;
        return { ...rest, mode: target };
      });
    const data = {
      plan,
      isAgent: prepared.actor.agentId !== undefined,
      ...(savedPath === undefined ? {} : { filePath: savedPath }),
      ...(this.options.hasTaskTool?.() ? { hasTaskTool: true } : {}),
      ...(supplied === undefined ? {} : { planWasEdited: true }),
    };
    const content = plan?.trim()
      ? `Plan approved.\n\n${plan}`
      : "Leaving plan mode was approved.";
    return {
      data,
      notices,
      ...(transition ? { transition } : {}),
      result: {
        type: "tool_result",
        tool_use_id: prepared.call.id,
        content: data.isAgent
          ? "Plan approval completed for this agent."
          : content,
        hookResponse: data,
      },
    };
  }
  private assertPrepared(prepared: PreparedPlanCall): void {
    if (
      !this.prepared.has(prepared) ||
      prepared.sessionId !== this.options.sessionId()
    )
      throw new PlanInputRejected(
        "The prepared plan call does not belong to the active session",
      );
  }
  private validateContext(name: string, actor: PlanActor): void {
    if (name === "EnterPlanMode" && actor.agentId)
      throw new PlanInputRejected("Only the main session can enter plan mode");
    if (name === "ExitPlanMode") {
      if (
        actor.builtInFork &&
        (actor.teammate || this.options.permissions().mode === "plan")
      )
        throw new PlanInputRejected(
          "A fork must report its plan to the session that created it",
        );
      if (!actor.teammate && this.options.permissions().mode !== "plan")
        throw new PlanInputRejected(
          "Enter plan mode before requesting plan approval",
        );
    }
  }
}
