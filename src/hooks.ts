import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionStart",
  "TaskCreated",
  "TaskCompleted",
  "SubagentStart",
  "SubagentStop",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000;
export interface HookInput {
  hook_event_name: HookEvent;
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  stop_hook_active?: boolean;
  source?: string;
  effort?: { level: string };
  [key: string]: unknown;
}
export interface HookOrigin {
  source: string;
  path?: string;
  projectRoot?: string;
  pluginRoot?: string;
  pluginData?: string;
  managed?: boolean;
}
export interface HookSource extends HookOrigin {
  hooks: unknown;
}
const commandSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  shell: z.enum(["bash", "powershell"]).optional(),
  timeout: z.number().positive().finite().optional(),
  onFailure: z.enum(["continue", "block"]).optional(),
  once: z.boolean().optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
  if: z.string().optional(),
  statusMessage: z.string().optional(),
});
export type CommandHook = z.infer<typeof commandSchema>;
interface RegisteredHook {
  id: string;
  event: HookEvent;
  matcher?: string;
  hook: CommandHook;
  origin: HookOrigin;
}
const groupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(commandSchema),
});
const preOutput = z.object({
  hookEventName: z.literal("PreToolUse"),
  permissionDecision: z.enum(["allow", "deny", "ask", "defer"]).optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  additionalContext: z.string().optional(),
});
const postOutput = z.object({
  hookEventName: z.literal("PostToolUse"),
  additionalContext: z.string().optional(),
  updatedToolOutput: z.unknown().optional(),
  updatedMCPToolOutput: z.unknown().optional(),
});
const failureOutput = z.object({
  hookEventName: z.literal("PostToolUseFailure"),
  additionalContext: z.string().optional(),
});
const stopOutput = z.object({
  hookEventName: z.literal("Stop"),
  additionalContext: z.string().optional(),
});
const startOutput = z.object({
  hookEventName: z.literal("SessionStart"),
  additionalContext: z.string().optional(),
  initialUserMessage: z.string().optional(),
  sessionTitle: z.string().optional(),
  watchPaths: z.array(z.string()).optional(),
  reloadSkills: z.boolean().optional(),
});
const subagentStartOutput = z.object({
  hookEventName: z.literal("SubagentStart"),
  additionalContext: z.string().optional(),
});
const subagentStopOutput = z.object({
  hookEventName: z.literal("SubagentStop"),
  additionalContext: z.string().optional(),
});
const outputSchema = z.object({
  continue: z.boolean().optional(),
  suppressOutput: z.boolean().optional(),
  stopReason: z.string().optional(),
  decision: z.enum(["approve", "block"]).optional(),
  reason: z.string().optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: z
    .discriminatedUnion("hookEventName", [
      preOutput,
      postOutput,
      failureOutput,
      stopOutput,
      startOutput,
      subagentStartOutput,
      subagentStopOutput,
    ])
    .optional(),
});
export type HookPermission = "allow" | "deny" | "ask" | "defer";
export interface HookResult {
  id: string;
  event: HookEvent;
  origin: HookOrigin;
  command: string;
  status: "success" | "blocking" | "error" | "cancelled";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut?: boolean;
  outputExceeded?: boolean;
  error?: string;
  permission?: HookPermission;
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
  systemMessage?: string;
  preventContinuation?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  updatedToolOutput?: unknown;
  updatedMCPToolOutput?: unknown;
  initialUserMessage?: string;
  sessionTitle?: string;
  watchPaths?: string[];
  reloadSkills?: boolean;
}
export interface BackgroundHook {
  id: string;
  completion: Promise<HookResult>;
  cancel(): void;
}
export interface HookBatchResult {
  results: HookResult[];
  background: BackgroundHook[];
  permission?: HookPermission;
  reason?: string;
  updatedInput?: unknown;
  updatedToolOutput?: unknown;
  updatedMCPToolOutput?: unknown;
  additionalContext: string[];
  systemMessages: string[];
  blockingErrors: string[];
  preventContinuation: boolean;
  stopReason?: string;
  cancelled: boolean;
  initialUserMessage?: string;
  sessionTitle?: string;
  watchPaths: string[];
  reloadSkills: boolean;
}
export interface HookRunOptions {
  /** Caller-supplied roots/environment; no personal configuration or process env is read. */
  cwd: string;
  projectDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  defaultTimeoutMs?: number;
  /** Optional tau resource bound, not a claim about the original capture budget. Exceeding it never yields a verdict. */
  maxOutputBytes?: number;
  shellPath?: string;
  powerShellPath?: string;
  envFile?: string;
  attended?: boolean;
  validateUpdatedInput?: (
    input: Record<string, unknown>,
    context: { input: HookInput; origin: HookOrigin },
  ) => unknown | Promise<unknown>;
  forceSyncExecution?: boolean;
  onBackgroundResult?: (result: HookResult) => void | Promise<void>;
}
export interface HookRegistryOptions {
  disabled?: boolean;
  managedOnly?: boolean;
  matchesCondition?: (condition: string, input: HookInput) => boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function matcherValue(input: HookInput): string | undefined {
  if (
    input.hook_event_name === "PreToolUse" ||
    input.hook_event_name === "PostToolUse" ||
    input.hook_event_name === "PostToolUseFailure"
  )
    return input.tool_name;
  if (input.hook_event_name === "SessionStart") return input.source;
  if (
    input.hook_event_name === "SubagentStart" ||
    input.hook_event_name === "SubagentStop"
  )
    return typeof input.agent_type === "string" ? input.agent_type : undefined;
  return undefined; // Stop has no matcher query in the source.
}
function matches(matcher: string | undefined, input: HookInput): boolean {
  const value = matcherValue(input);
  if (value === undefined || !matcher || matcher === "*" || matcher === ".*")
    return true;
  if (
    (input.hook_event_name === "SubagentStart" ||
      input.hook_event_name === "SubagentStop") &&
    /^[a-zA-Z0-9_|]+$/.test(matcher)
  )
    return matcher.split("|").includes(value);
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}
function failureBlocks(
  hook: CommandHook,
  event: HookEvent,
  background: boolean,
): boolean {
  return (
    !background &&
    event !== "Stop" &&
    event !== "SubagentStop" &&
    hook.onFailure === "block"
  );
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
function expand(value: string, origin: HookOrigin, projectDir: string): string {
  let result = value.replaceAll("${CLAUDE_PROJECT_DIR}", projectDir);
  for (const [name, path] of [
    ["CLAUDE_PLUGIN_ROOT", origin.pluginRoot],
    ["CLAUDE_PLUGIN_DATA", origin.pluginData],
  ] as const) {
    if (!result.includes(`\${${name}}`)) continue;
    if (path === undefined)
      throw new Error(`${name} is unavailable for this hook source`);
    result = result.replaceAll(`\${${name}}`, path);
  }
  return result;
}

/** Explicit registry for command-hook workflows. It never reads configuration files itself. */
export class HookRegistry {
  private readonly hooks: RegisteredHook[] = [];
  private readonly used = new Set<string>();
  private readonly stopping = new AbortController();
  private readonly running = new Set<BackgroundHook>();
  readonly limitations = [
    "Command hooks only; prompt/agent/http/function/script/MCP hook types are not executed",
    "Ordinary regex matching only; remote/tool-family aliases and policy trust gates belong to the caller",
    "No inherited environment, plugin discovery, environment-file replay, or native shell selection is inferred",
    "Batch permission reduction uses deny-before-ask; advanced host/server/race arbitration is not reconstructed",
  ] as const;
  constructor(
    sources: readonly HookSource[],
    private readonly options: HookRegistryOptions = {},
  ) {
    let next = 0;
    for (const { hooks, ...origin } of sources) {
      if (hooks === undefined || hooks === null) continue;
      if (!object(hooks))
        throw new Error(`Invalid hooks object from ${origin.source}`);
      for (const event of HOOK_EVENTS) {
        if (hooks[event] === undefined) continue;
        const groups = z.array(groupSchema).parse(hooks[event]);
        for (const group of groups)
          for (const hook of group.hooks) {
            if (hook.if && !options.matchesCondition)
              throw new Error(
                `Hook condition requires a source-aware matchesCondition callback: ${hook.if}`,
              );
            if (hook.asyncRewake)
              throw new Error(
                "asyncRewake hooks require a wake/continuation scheduler and are not implemented",
              );
            this.hooks.push({
              id: `hook-${next++}`,
              event,
              hook,
              origin,
              ...(group.matcher !== undefined
                ? { matcher: group.matcher }
                : {}),
            });
          }
      }
    }
  }
  list(event?: HookEvent): ReadonlyArray<{
    id: string;
    event: HookEvent;
    origin: HookOrigin;
    matcher?: string;
    hook: CommandHook;
  }> {
    return this.hooks.filter(
      (entry) => event === undefined || entry.event === event,
    );
  }
  async close(): Promise<void> {
    this.stopping.abort(new Error("Hook registry closed"));
    await Promise.allSettled([...this.running].map((task) => task.completion));
  }
  async run(
    input: HookInput,
    options: HookRunOptions,
  ): Promise<HookBatchResult> {
    if (!HOOK_EVENTS.includes(input.hook_event_name))
      throw new Error("Unsupported hook event");
    for (const field of ["session_id", "transcript_path", "cwd"] as const)
      if (typeof input[field] !== "string")
        throw new Error(`Hook input requires ${field}`);
    if (
      input.hook_event_name === "PreToolUse" ||
      input.hook_event_name === "PostToolUse" ||
      input.hook_event_name === "PostToolUseFailure"
    ) {
      if (
        typeof input.tool_name !== "string" ||
        typeof input.tool_use_id !== "string" ||
        !Object.hasOwn(input, "tool_input")
      )
        throw new Error(
          "Tool hook input requires tool_name, tool_use_id and tool_input",
        );
      if (
        input.hook_event_name === "PostToolUse" &&
        !Object.hasOwn(input, "tool_response")
      )
        throw new Error("PostToolUse input requires tool_response");
    }
    if (input.hook_event_name === "PostToolUseFailure") {
      if (typeof input.error !== "string")
        throw new Error("PostToolUseFailure input requires error text");
      if (
        input.is_interrupt !== undefined &&
        typeof input.is_interrupt !== "boolean"
      )
        throw new Error("PostToolUseFailure is_interrupt must be boolean");
      if (
        input.duration_ms !== undefined &&
        (typeof input.duration_ms !== "number" ||
          !Number.isFinite(input.duration_ms))
      )
        throw new Error("PostToolUseFailure duration_ms must be finite");
    }
    if (
      input.hook_event_name === "Stop" &&
      typeof input.stop_hook_active !== "boolean"
    )
      throw new Error("Stop input requires stop_hook_active");
    if (
      input.hook_event_name === "SubagentStart" ||
      input.hook_event_name === "SubagentStop"
    ) {
      if (
        typeof input.agent_id !== "string" ||
        typeof input.agent_type !== "string"
      )
        throw new Error("Subagent hook input requires agent_id and agent_type");
      if (
        input.hook_event_name === "SubagentStop" &&
        (typeof input.stop_hook_active !== "boolean" ||
          typeof input.agent_transcript_path !== "string")
      )
        throw new Error(
          "SubagentStop requires stop_hook_active and agent_transcript_path",
        );
    }
    if (
      input.hook_event_name === "SessionStart" &&
      typeof input.source !== "string"
    )
      throw new Error("SessionStart input requires source");
    if (
      input.hook_event_name === "TaskCreated" ||
      input.hook_event_name === "TaskCompleted"
    ) {
      if (
        typeof input.task_id !== "string" ||
        typeof input.task_subject !== "string"
      )
        throw new Error("Task hook input requires task_id and task_subject");
      for (const field of [
        "task_description",
        "teammate_name",
        "team_name",
      ] as const) {
        if (input[field] !== undefined && typeof input[field] !== "string")
          throw new Error(`Task hook ${field} must be a string`);
      }
    }
    if (!isAbsolute(options.cwd) || !isAbsolute(options.projectDir))
      throw new Error("Hook cwd/projectDir must be explicit absolute paths");
    if (
      options.defaultTimeoutMs !== undefined &&
      (!Number.isFinite(options.defaultTimeoutMs) ||
        options.defaultTimeoutMs <= 0)
    )
      throw new Error("Hook timeout must be positive and finite");
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes <= 0)
    )
      throw new Error("Hook output bound must be a positive safe integer");
    const batch = emptyBatch();
    if (this.options.disabled) return batch;
    if (options.signal.aborted || this.stopping.signal.aborted) {
      batch.cancelled = true;
      return batch;
    }
    const serialized = JSON.stringify(input) + "\n";
    const selected = new Map<string, RegisteredHook>();
    for (const entry of this.hooks) {
      if (
        entry.event !== input.hook_event_name ||
        this.used.has(entry.id) ||
        (this.options.managedOnly &&
          entry.origin.source !== "policySettings" &&
          entry.origin.managed !== true) ||
        !matches(entry.matcher, input)
      )
        continue;
      if (
        entry.hook.if &&
        !this.options.matchesCondition?.(entry.hook.if, input)
      )
        continue;
      const key = JSON.stringify([
        entry.origin.source,
        entry.hook.shell ?? "bash",
        entry.hook.command,
        entry.hook.args ?? null,
        entry.hook.if ?? "",
      ]);
      selected.set(key, entry); // Same command identity runs once per source, even under overlapping matchers.
    }
    const sync: Promise<HookResult>[] = [];
    for (const entry of selected.values()) {
      if (entry.hook.once)
        for (const candidate of this.hooks) {
          if (
            candidate.event === entry.event &&
            candidate.origin.source === entry.origin.source &&
            candidate.hook.command === entry.hook.command &&
            (candidate.hook.shell ?? "bash") === (entry.hook.shell ?? "bash") &&
            JSON.stringify(candidate.hook.args ?? null) ===
              JSON.stringify(entry.hook.args ?? null) &&
            (candidate.hook.if ?? "") === (entry.hook.if ?? "")
          )
            this.used.add(candidate.id);
        }
      const background =
        !options.forceSyncExecution &&
        (entry.hook.async === true ||
          (input.hook_event_name === "SessionStart" &&
            entry.origin.source === "projectSettings" &&
            (input.source === "startup" || input.source === "resume")));
      const controller = new AbortController();
      const signal = AbortSignal.any([
        options.signal,
        this.stopping.signal,
        controller.signal,
      ]);
      const promise = this.execute(
        entry,
        input,
        serialized,
        { ...options, signal },
        background,
      );
      if (!background) {
        sync.push(promise);
        continue;
      }
      const task: BackgroundHook = {
        id: entry.id,
        completion: promise,
        cancel: () => controller.abort(new Error("Background hook cancelled")),
      };
      this.running.add(task);
      batch.background.push(task);
      void promise
        .then(async (result) => {
          try {
            await options.onBackgroundResult?.(result);
          } finally {
            this.running.delete(task);
          }
        })
        .catch(() => this.running.delete(task));
    }
    batch.results = await Promise.all(sync);
    // Keep raw per-hook outcomes for consumers that implement the full host arbitration pipeline.
    const rank: Record<HookPermission, number> = {
      allow: 1,
      defer: 2,
      ask: 3,
      deny: 4,
    };
    for (const result of batch.results) {
      if (result.status === "cancelled") batch.cancelled = true;
      if (result.status === "blocking")
        batch.blockingErrors.push(
          result.reason ??
            result.error ??
            (result.stderr.trim() || "Blocked by hook"),
        );
      if (
        result.permission !== undefined &&
        (batch.permission === undefined ||
          rank[result.permission] >= rank[batch.permission])
      ) {
        batch.permission = result.permission;
        if (result.reason !== undefined) batch.reason = result.reason;
      }
      if (result.updatedInput !== undefined && result.status === "success")
        batch.updatedInput = result.updatedInput;
      if (result.updatedToolOutput !== undefined)
        batch.updatedToolOutput = result.updatedToolOutput;
      if (result.updatedMCPToolOutput !== undefined)
        batch.updatedMCPToolOutput = result.updatedMCPToolOutput;
      if (result.additionalContext)
        batch.additionalContext.push(result.additionalContext);
      if (result.systemMessage) batch.systemMessages.push(result.systemMessage);
      if (result.preventContinuation) batch.preventContinuation = true;
      if (result.stopReason) batch.stopReason = result.stopReason;
      if (result.initialUserMessage !== undefined)
        batch.initialUserMessage = result.initialUserMessage;
      if (result.sessionTitle !== undefined)
        batch.sessionTitle = result.sessionTitle;
      if (result.watchPaths) batch.watchPaths.push(...result.watchPaths);
      if (result.reloadSkills) batch.reloadSkills = true;
    }
    if (input.hook_event_name === "PreToolUse" && batch.blockingErrors.length)
      batch.permission = "deny";
    return batch;
  }
  private async execute(
    entry: RegisteredHook,
    input: HookInput,
    serialized: string,
    options: HookRunOptions,
    background: boolean,
  ): Promise<HookResult> {
    const started = Date.now(),
      { hook, origin } = entry;
    const base = {
      id: entry.id,
      event: entry.event,
      origin,
      command: hook.command,
    };
    let captured: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut?: boolean;
      cancelled?: boolean;
      outputExceeded?: boolean;
      error?: string;
    };
    try {
      const env: NodeJS.ProcessEnv = {
        ...options.env,
        CLAUDE_PROJECT_DIR: options.projectDir,
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: input.session_id,
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_SESSION_ATTENDED: options.attended ? "1" : "0",
        CLAUDE_PID: String(process.pid),
        ...(input.effort ? { CLAUDE_EFFORT: input.effort.level } : {}),
        ...(origin.pluginRoot !== undefined
          ? { CLAUDE_PLUGIN_ROOT: origin.pluginRoot }
          : {}),
        ...(origin.pluginData !== undefined
          ? { CLAUDE_PLUGIN_DATA: origin.pluginData }
          : {}),
        ...(options.envFile !== undefined &&
        input.hook_event_name === "SessionStart"
          ? { CLAUDE_ENV_FILE: options.envFile }
          : {}),
      };
      let command: string, args: string[];
      if (hook.args !== undefined) {
        command = expand(hook.command, origin, options.projectDir);
        args = hook.args.map((arg) => expand(arg, origin, options.projectDir));
      } else if (hook.shell === "powershell") {
        if (!options.powerShellPath)
          throw new Error(
            "PowerShell hook requires an explicit PowerShell executable",
          );
        command = options.powerShellPath;
        args = ["-NoProfile", "-NonInteractive", "-Command", hook.command];
      } else {
        command = options.shellPath ?? "/bin/sh";
        args = ["-c", hook.command];
      }
      captured = await executeCommand(
        command,
        args,
        {
          cwd: resolve(options.cwd),
          env,
          signal: options.signal,
          timeoutMs:
            hook.timeout === undefined
              ? (options.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
              : hook.timeout * 1000,
          ...(options.maxOutputBytes !== undefined
            ? { maxOutputBytes: options.maxOutputBytes }
            : {}),
        },
        serialized,
      );
    } catch (error) {
      captured = {
        stdout: "",
        stderr: "",
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const result: HookResult = {
      ...base,
      status: "success",
      stdout: captured.stdout,
      stderr: captured.stderr,
      exitCode: captured.exitCode,
      durationMs: Date.now() - started,
      ...(captured.timedOut ? { timedOut: true } : {}),
      ...(captured.outputExceeded ? { outputExceeded: true } : {}),
    };
    if (captured.cancelled) {
      result.status = "cancelled";
      return result;
    }
    const failed =
      captured.error !== undefined ||
      captured.timedOut ||
      captured.outputExceeded ||
      (captured.exitCode !== 0 && captured.exitCode !== 2);
    if (failed) {
      result.status = failureBlocks(hook, entry.event, background)
        ? "blocking"
        : "error";
      result.error =
        captured.error ??
        (captured.timedOut
          ? "Hook timed out"
          : captured.outputExceeded
            ? "Hook output exceeded its configured bound"
            : `Hook exited ${captured.exitCode}`);
      if (result.status === "blocking") result.reason = result.error;
      return result;
    }
    if (captured.exitCode === 2) {
      if (
        ["Stop", "SubagentStop", "TaskCompleted"].includes(entry.event) &&
        !captured.stdout.trim() &&
        /no such file|can't open/i.test(captured.stderr)
      ) {
        result.status = "error";
        result.error = captured.stderr.trim();
        return result;
      }
      result.status = "blocking";
      result.reason = captured.stderr.trim() || "Blocked by hook";
      if (entry.event === "PreToolUse") result.permission = "deny";
      return result;
    }
    const trimmed = captured.stdout.trim();
    if (!trimmed.startsWith("{")) return result;
    let output: z.infer<typeof outputSchema>;
    try {
      // Malformed or multi-document captures never grant permission or rewrite input.
      output = outputSchema.parse(JSON.parse(trimmed.replace(/^\uFEFF/, "")));
      const specific = output.hookSpecificOutput;
      if (specific && specific.hookEventName !== entry.event) {
        if (output.decision === "block")
          delete output.hookSpecificOutput; // Source fPo keeps a legacy block even when its specific payload is for another event.
        else
          throw new Error(
            `Hook output names ${specific.hookEventName}, expected ${entry.event}`,
          );
      }
    } catch (error) {
      result.status = failureBlocks(hook, entry.event, background)
        ? "blocking"
        : "error";
      result.error = error instanceof Error ? error.message : String(error);
      if (result.status === "blocking") result.reason = result.error;
      return result;
    }
    if (output.continue === false) result.preventContinuation = true;
    if (output.stopReason !== undefined) result.stopReason = output.stopReason;
    if (output.suppressOutput !== undefined)
      result.suppressOutput = output.suppressOutput;
    if (output.systemMessage !== undefined)
      result.systemMessage = output.systemMessage;
    if (output.decision === "block") {
      result.status = "blocking";
      result.reason = output.reason ?? "Blocked by hook";
      if (entry.event === "PreToolUse") result.permission = "deny";
    } else if (output.decision === "approve" && entry.event === "PreToolUse")
      result.permission = "allow";
    const specific = output.hookSpecificOutput;
    if (specific?.additionalContext !== undefined)
      result.additionalContext = specific.additionalContext;
    if (specific?.hookEventName === "PreToolUse") {
      if (specific.permissionDecision !== undefined)
        result.permission = specific.permissionDecision;
      if (specific.permissionDecisionReason !== undefined)
        result.reason = specific.permissionDecisionReason;
      if (specific.permissionDecision === "deny") result.status = "blocking";
      if (
        specific.updatedInput !== undefined &&
        specific.permissionDecision !== "deny" &&
        specific.permissionDecision !== "defer"
      ) {
        try {
          if (!options.validateUpdatedInput)
            throw new Error(
              "Updated tool input requires a validation callback",
            );
          const validated = await options.validateUpdatedInput(
            specific.updatedInput,
            { input, origin },
          );
          if (!object(validated))
            throw new Error(
              "Updated-input validator must return the validated input object",
            );
          result.updatedInput = validated;
        } catch (error) {
          result.status = "blocking";
          result.permission = "deny";
          result.reason =
            error instanceof Error ? error.message : String(error);
        }
      }
    } else if (specific?.hookEventName === "PostToolUse") {
      if (Object.hasOwn(specific, "updatedToolOutput"))
        result.updatedToolOutput = specific.updatedToolOutput;
      if (Object.hasOwn(specific, "updatedMCPToolOutput"))
        result.updatedMCPToolOutput = specific.updatedMCPToolOutput;
    } else if (specific?.hookEventName === "SessionStart") {
      if (specific.initialUserMessage !== undefined)
        result.initialUserMessage = specific.initialUserMessage;
      if (specific.sessionTitle !== undefined)
        result.sessionTitle = specific.sessionTitle;
      if (specific.watchPaths !== undefined)
        result.watchPaths = specific.watchPaths;
      if (specific.reloadSkills !== undefined)
        result.reloadSkills = specific.reloadSkills;
    }
    return result;
  }
}

interface ExecuteOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
}
function executeCommand(
  command: string,
  args: string[],
  options: ExecuteOptions,
  input: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  outputExceeded?: boolean;
  error?: string;
}> {
  if (options.signal.aborted)
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      cancelled: true,
    });
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      timedOut = false,
      cancelled = false,
      outputExceeded = false,
      finished = false,
      error: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const stop = () => {
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 50);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const capture = (list: Buffer[]) => (chunk: Buffer) => {
      const capacity =
        options.maxOutputBytes === undefined
          ? chunk.length
          : Math.max(0, options.maxOutputBytes - size);
      if (chunk.length > capacity) {
        outputExceeded = true;
        stop();
      }
      const part = chunk.subarray(0, capacity);
      if (part.length) list.push(part);
      size += part.length;
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.stdin.on("error", () => {
      /* A hook may finish without reading its entire input. */
    });
    child.on("error", (failure) => {
      error = failure.message;
    });
    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal.removeEventListener("abort", abort);
      kill("SIGKILL");
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(outputExceeded ? { outputExceeded: true } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    });
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdin.end(input, "utf8");
    if (options.signal.aborted) abort();
  });
}
export function createHookRegistry(
  sources: readonly HookSource[],
  options?: HookRegistryOptions,
): HookRegistry {
  return new HookRegistry(sources, options);
}
