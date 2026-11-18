import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PlanFileManager,
  PlanRuntime,
  selectPlanDirectory,
  type PlanApproval,
  type PlanPermissionMode,
  type PlanPermissionState,
} from "./plan-runtime.js";
import { createPlanFileAccess, wrapPlanRuntime } from "./plan-session.js";
import { matchingToolRule, type ToolPolicy } from "./tool-policy.js";
import { readFileSnapshot } from "./file-snapshot.js";
import { writeAtomic } from "./write.js";
import type {
  Message,
  PermissionMode,
  ToolExecutor,
  ToolUse,
} from "./types.js";
import type { ToolHookRuntime } from "./tool-hook-runtime.js";

const isCliPermissionMode = (
  mode: PlanPermissionMode,
): mode is PermissionMode =>
  mode === "default" ||
  mode === "acceptEdits" ||
  mode === "plan" ||
  mode === "bypassPermissions";

export interface SavedPlanState {
  active: boolean;
  slug?: string | undefined;
  prePlanMode?: PermissionMode | undefined;
  bypassAvailable?: boolean | undefined;
}

/** Ordinary local CLI host. Original transcript/Doc/team bridges are separate. */
export function createLaunchPlanHost(options: {
  cwd: string;
  userConfigDir: string;
  configuredDirectory?: string;
  sessionId(): string;
  saved(): SavedPlanState | undefined;
  save(state: SavedPlanState): void;
  mode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  policy(): ToolPolicy;
  canRequestApproval(): boolean;
  approve(description: string): Promise<boolean>;
  hooks: ToolHookRuntime;
  requestApproval?(call: ToolUse, signal: AbortSignal): Promise<PlanApproval>;
  hasTaskTool?(): boolean;
  onDiagnostic?(message: string): void;
}) {
  if (options.mode() === "plan" && options.saved()?.active !== true)
    options.save({ ...options.saved(), active: true });
  else if (options.mode() !== "plan" && options.saved()?.active)
    options.save({ ...options.saved(), active: false });
  const directory = selectPlanDirectory({
    projectRoot: options.cwd,
    defaultDirectory: join(options.userConfigDir, "plans"),
    ...(options.configuredDirectory === undefined
      ? {}
      : { configuredDirectory: options.configuredDirectory }),
    vet: (candidate) =>
      !candidate
        .split(/[\\/]/)
        .some(
          (part) =>
            part === ".git" || part === "node_modules" || part === ".tau",
        ),
  });
  const files = new PlanFileManager({
    directory,
    // The original private naming word lists are not incorporated.
    createSlug: ({ sessionId }) => `plan-${sessionId}`,
    onSlug: (_id, slug) =>
      options.save({
        ...options.saved(),
        active: options.mode() === "plan",
        slug,
      }),
  });
  const savedSlug = options.saved()?.slug;
  if (savedSlug) files.restore(options.sessionId(), savedSlug);
  const access = createPlanFileAccess({
    cwd: options.cwd,
    files,
    sessionId: options.sessionId,
    vetDirectory: (canonical) =>
      !canonical
        .split(/[\\/]/)
        .some(
          (part) =>
            part === ".git" || part === "node_modules" || part === ".tau",
        ),
  });
  const permissions = (): PlanPermissionState => {
    const saved = options.saved();
    return {
      mode: options.mode(),
      ...(saved?.prePlanMode === undefined
        ? {}
        : { prePlanMode: saved.prePlanMode }),
      isBypassPermissionsModeAvailable:
        options.mode() === "bypassPermissions" ||
        saved?.bypassAvailable === true,
    };
  };
  const storage = {
    async read(path: string, signal: AbortSignal): Promise<string | null> {
      const allowed = await access.extraPathAdmission({
        operation: "Read",
        requestedPath: path,
        signal,
      });
      if (!allowed) throw new Error("The designated plan path is unavailable");
      const bytes = await readFileSnapshot(allowed, signal, {
        maximum: 1_000_000,
      });
      return bytes === null ? null : bytes.toString("utf8");
    },
    async save(path: string, text: string, signal: AbortSignal) {
      const allowed = await access.extraPathAdmission({
        operation: "Write",
        requestedPath: path,
        signal,
      });
      if (!allowed) throw new Error("The designated plan path is unavailable");
      const previous = await readFileSnapshot(allowed, signal, {
        maximum: 1_000_000,
      });
      await mkdir(dirname(allowed), { recursive: true, mode: 0o700 });
      await writeAtomic(allowed, text, async () => {
        signal.throwIfAborted();
        if (
          (await access.extraPathAdmission({
            operation: "Write",
            requestedPath: path,
            signal,
          })) !== allowed
        )
          throw new Error("Plan path changed before save");
        const current = await readFileSnapshot(allowed, signal, {
          expected: previous,
        });
        if (
          previous === null
            ? current !== null
            : current === null || !current.equals(previous)
        )
          throw new Error("Plan changed before approval was saved");
      });
      return { savedPath: allowed };
    },
  };
  const runtime = new PlanRuntime({
    sessionId: options.sessionId,
    files,
    storage,
    permissions,
    setPermissions: (update) => {
      const state = update(permissions());
      if (!isCliPermissionMode(state.mode))
        throw new Error(`Unsupported CLI plan permission mode: ${state.mode}`);
      options.setMode(state.mode);
      const slug = files.peekSlug(options.sessionId()) ?? options.saved()?.slug;
      options.save({
        active: state.mode === "plan",
        ...(slug === undefined ? {} : { slug }),
        ...(state.prePlanMode === undefined ||
        !isCliPermissionMode(state.prePlanMode)
          ? {}
          : { prePlanMode: state.prePlanMode }),
        ...(state.isBypassPermissionsModeAvailable === undefined
          ? {}
          : { bypassAvailable: state.isBypassPermissionsModeAvailable }),
      });
    },
    canRequestApproval: options.canRequestApproval,
    approve: async (request) => ({
      approved: await options.approve(
        `${request.plan ? `Plan:\n${request.plan}\n\n` : ""}Approve ${request.tool}?`,
      ),
    }),
    ...(options.hasTaskTool ? { hasTaskTool: options.hasTaskTool } : {}),
  });
  let announced: string | undefined;
  const available = (name: string) => {
    const tools = options.policy().tools;
    return (
      runtime.definitions.some((tool) => tool.name === name) &&
      (tools === undefined || tools.some((tool) => tool === name)) &&
      !matchingToolRule(options.policy(), "deny", name)
    );
  };
  return {
    runtime,
    files,
    access,
    location: () => runtime.planLocation(),
    wrap(
      base: ToolExecutor | (() => ToolExecutor),
      messages: Message[],
    ): ToolExecutor {
      return wrapPlanRuntime(base, {
        runtime,
        hooks: options.hooks,
        available,
        authorize: ({ call, hookPermission }) =>
          !available(call.name)
            ? { behavior: "deny", reason: "Plan tool is disabled or denied" }
            : matchingToolRule(options.policy(), "ask", call.name) ||
                hookPermission === "ask"
              ? { behavior: "ask" }
              : { behavior: "allow" },
        approve: async ({ call, permission, signal }) =>
          options.requestApproval
            ? options.requestApproval(call, signal)
            : {
                approved: await options.approve(
                  `${permission.plan ? `Plan:\n${permission.plan}\n\n` : ""}Approve ${permission.tool}?`,
                ),
              },
        beforeModelRequest: async (_runtime, signal) => {
          signal.throwIfAborted();
          const location = runtime.planLocation();
          if (!location) {
            announced = undefined;
            return;
          }
          if (announced !== location) {
            messages.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Planning mode is active. Session plan file: ${location}\nUse Read before changing an existing plan; prepare the plan in this file, then request ExitPlanMode approval when available.`,
                },
              ],
            });
            announced = location;
          }
        },
        onExecution: (execution) => {
          for (const notice of execution.notices)
            options.onDiagnostic?.(notice);
        },
        ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      });
    },
  };
}
