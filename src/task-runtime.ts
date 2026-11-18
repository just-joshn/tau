import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { LocalTaskStore, mergeTaskMetadata, taskStatusSchema, type LocalTask } from "./task-store.js";
import { appendFailureHookContext, appendPreHookContext, type PreToolHookResult, type ToolHookRuntime } from "./tool-hook-runtime.js";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolUse } from "./types.js";

export const taskToolNames = ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList"] as const;
export type TaskToolName = typeof taskToolNames[number];
const ordinaryTaskModels = new Set([
  "claude-3-opus", "claude-3-sonnet", "claude-3-haiku", "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-7-sonnet",
  "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7",
  "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5",
]);
/** Typed environment values and the host's canonical main-loop identity, not an alias or raw dated model id.
 * Special Tc/sPi host modes belong to their host adapter; this is the ordinary API-key branch. */
export function nativeTasksEnabled(options: { enabled?: boolean; todoTools?: boolean; canonicalModel?: string }): boolean {
  return options.enabled !== false && (options.canonicalModel === undefined || options.canonicalModel.includes("application-inference-profile") || ordinaryTaskModels.has(options.canonicalModel) || options.todoTools === true);
}
const metadata = z.record(z.string(), z.unknown());
export const taskCreateInputSchema = z.strictObject({ subject: z.string(), description: z.string(), activeForm: z.string().optional(), metadata: metadata.optional() });
export const taskGetInputSchema = z.strictObject({ taskId: z.string() });
export const taskUpdateInputSchema = z.strictObject({ taskId: z.string(), subject: z.string().optional(), description: z.string().optional(), activeForm: z.string().optional(), owner: z.string().optional(),
  status: taskStatusSchema.or(z.literal("deleted")).optional(), addBlocks: z.array(z.string()).optional(), addBlockedBy: z.array(z.string()).optional(), metadata: metadata.optional() });
export const taskListInputSchema = z.strictObject({});
const taskCreateOptionalDescriptionSchema = taskCreateInputSchema.extend({ description: z.string().optional() });
type TaskCall =
  | { name: "TaskCreate"; input: z.infer<typeof taskCreateOptionalDescriptionSchema> }
  | { name: "TaskGet"; input: z.infer<typeof taskGetInputSchema> }
  | { name: "TaskUpdate"; input: z.infer<typeof taskUpdateInputSchema> }
  | { name: "TaskList"; input: z.infer<typeof taskListInputSchema> };
const publicTaskSchema = z.object({ id: z.string(), subject: z.string(), description: z.string(), status: taskStatusSchema, blocks: z.array(z.string()), blockedBy: z.array(z.string()) });
const createOutput = z.object({ task: z.object({ id: z.string(), subject: z.string(), description: z.string().optional() }) });
const getOutput = z.object({ task: publicTaskSchema.nullable() });
const updateOutput = z.object({ success: z.boolean(), taskId: z.string(), updatedFields: z.array(z.string()), error: z.string().optional(), statusChange: z.object({ from: z.string(), to: z.string() }).optional() });
const listOutput = z.object({ tasks: z.array(z.object({ id: z.string(), subject: z.string(), status: taskStatusSchema, owner: z.string().optional(), blockedBy: z.array(z.string()) })) });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Source-like repair is bounded to task shapes; it never turns an Agent batch into tasks. */
export function coerceTaskCreateInput(value: unknown): unknown {
  if (!object(value) || "tasks" in value || "todos" in value) return value;
  let input = { ...value };
  if (("prompt" in input || "subagent_type" in input) && !(nonblank(input.subject) && nonblank(input.description))) return value;
  if (!("subject" in input) && !("description" in input) && "task" in input) {
    const task = input.task;
    if (nonblank(task)) { delete input.task; input.description = task; }
    else if (object(task) && !("tasks" in task || "todos" in task) && (!("prompt" in task || "subagent_type" in task) || nonblank(task.subject) && nonblank(task.description))) { delete input.task; input = { ...input, ...task }; }
    else return value;
  }
  for (const [aliases, key] of [[ ["title", "name"], "subject" ], [ ["content"], "description" ], [ ["active_form"], "activeForm" ]] as const) {
    for (const alias of aliases) if (alias in input && !(key in input) && nonblank(input[alias])) { input[key] = input[alias]; delete input[alias]; }
  }
  if (nonblank(input.subject) && !("description" in input)) input.description = input.subject;
  else if (nonblank(input.description) && !("subject" in input)) {
    const description = stripVTControlCharacters(input.description).trim(), chars = Array.from(description);
    let title = chars.slice(0, 80).join(""); const space = title.lastIndexOf(" "); if (chars.length > 80 && space > 40) title = title.slice(0, space);
    input.subject = title.trim();
  }
  if (nonblank(input.subject) && nonblank(input.description)) {
    input = Object.fromEntries(Object.entries(input).filter(([key]) => ["subject", "description", "activeForm", "metadata"].includes(key)));
    if (typeof input.activeForm !== "string") delete input.activeForm;
    if (!object(input.metadata)) delete input.metadata;
  }
  return input;
}
export function coerceTaskUpdateInput(value: unknown): unknown {
  if (!object(value)) return value;
  const input = { ...value };
  for (const alias of ["id", "task_id"]) if (alias in input && !("taskId" in input) && nonblank(input[alias])) { input.taskId = input[alias]; delete input[alias]; }
  if ("active_form" in input && !("activeForm" in input) && nonblank(input.active_form)) { input.activeForm = input.active_form; delete input.active_form; }
  return input;
}
export interface TaskRuntimeContext { sessionId: string; actor?: string; mode?: "local" }
export interface TaskLifecycleContext { task: LocalTask; listId: string; context: TaskRuntimeContext; signal: AbortSignal }
export interface TaskLifecycleDecision { blockingErrors?: readonly string[] }
export interface TaskRuntimeOptions {
  store: LocalTaskStore;
  context(): TaskRuntimeContext;
  /** Native default is allow, but the host still arbitrates explicit deny/ask/mode. */
  authorize(call: ToolUse, context: TaskRuntimeContext, hookPermission: PreToolHookResult["permission"], signal: AbortSignal): boolean | string | Promise<boolean | string>;
  validateMutation?(context: TaskRuntimeContext): boolean | string;
  hooks?: ToolHookRuntime;
  lifecycle?: { created?(context: TaskLifecycleContext): Promise<TaskLifecycleDecision | void>; completed?(context: TaskLifecycleContext): Promise<TaskLifecycleDecision | void> };
  createShape?: "off" | "no_description" | "subject_only";
  enabled?(): boolean;
}

/** Local task CRUD only. Team assignment delivery, claims and subagent work are not synthesized. */
export class TaskRuntime implements ToolExecutor {
  constructor(private readonly options: TaskRuntimeOptions) {}
  handles(name: string): name is TaskToolName { return taskToolNames.some(tool => tool === name); }
  private createSchema() { return this.options.createShape && this.options.createShape !== "off" ? taskCreateOptionalDescriptionSchema : taskCreateInputSchema; }
  private schema(name: TaskToolName) {
    if (name === "TaskCreate") return this.createSchema();
    return name === "TaskGet" ? taskGetInputSchema : name === "TaskUpdate" ? taskUpdateInputSchema : taskListInputSchema;
  }
  get definitions(): ToolDefinition[] {
    if (this.options.enabled?.() === false) return [];
    const descriptions: Record<TaskToolName, string> = { TaskCreate: "Add one task to the current local task list.", TaskGet: "Read the description, status and dependencies of one task.", TaskUpdate: "Change task details, metadata, status, owner or dependency links.", TaskList: "List local task summaries and unresolved visible blockers." };
    return taskToolNames.map(name => ({ name, description: descriptions[name], input_schema: { ...z.toJSONSchema(this.schema(name)), type: "object" as const } }));
  }
  private validate(name: TaskToolName, value: unknown, context: TaskRuntimeContext): TaskCall {
    if (context.mode !== undefined && context.mode !== "local") throw new Error("Task runtime supports ordinary local context only");
    const checkMutation = () => {
      const decision = this.options.validateMutation?.(context);
      if (decision === false || typeof decision === "string") throw new Error(typeof decision === "string" ? decision : "Task list mutation is unavailable in this context");
    };
    switch (name) {
      case "TaskCreate": {
        const input: z.infer<typeof taskCreateOptionalDescriptionSchema> = this.createSchema().parse(coerceTaskCreateInput(value)); checkMutation();
        if (input.description === undefined && !input.subject.trim()) throw new Error("Task subject is blank");
        return { name, input };
      }
      case "TaskGet": return { name, input: taskGetInputSchema.parse(value) };
      case "TaskUpdate": { const input = taskUpdateInputSchema.parse(coerceTaskUpdateInput(value)); checkMutation(); return { name, input }; }
      case "TaskList": return { name, input: taskListInputSchema.parse(value) };
      default: { const _exhaustive: never = name; return _exhaustive; }
    }
  }
  private format(name: TaskToolName, data: unknown): string {
    if (name === "TaskCreate") { const { task } = createOutput.parse(data); return `Task #${task.id} created successfully: ${task.subject}`; }
    if (name === "TaskGet") { const { task } = getOutput.parse(data); if (!task) return "Task not found"; return [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`, ...(task.blockedBy.length ? [`Blocked by: ${task.blockedBy.map(id => "#" + id).join(", ")}`] : []), ...(task.blocks.length ? [`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`] : [])].join("\n"); }
    if (name === "TaskUpdate") { const result = updateOutput.parse(data); return result.success ? `Updated task #${result.taskId} ${result.updatedFields.join(", ")}` : result.error ?? `Task #${result.taskId} not found`; }
    const { tasks } = listOutput.parse(data); return tasks.length ? tasks.map(task => `#${task.id} [${task.status}] ${task.subject}${task.owner ? " (" + task.owner + ")" : ""}${task.blockedBy.length ? " [blocked by " + task.blockedBy.map(id => "#" + id).join(", ") + "]" : ""}`).join("\n") : "No tasks found";
  }
  private async run(validated: TaskCall, context: TaskRuntimeContext, signal: AbortSignal): Promise<unknown> {
    const store = this.options.store;
    if (validated.name === "TaskCreate") {
      const parsed = validated.input, description = parsed.description ?? parsed.subject;
      const task = await store.create({ subject: parsed.subject, description, ...(parsed.activeForm === undefined ? {} : { activeForm: parsed.activeForm }), ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }) }, signal);
      const result = await this.options.lifecycle?.created?.({ task: structuredClone(task), listId: store.listId, context, signal });
      if (result?.blockingErrors?.length) { await store.delete(task.id); throw new Error(result.blockingErrors.join("\n")); }
      return { task: { id: task.id, subject: task.subject, description: task.description } };
    }
    if (validated.name === "TaskGet") {
      const task = await store.get(validated.input.taskId);
      return { task: task ? publicTaskSchema.parse(task) : null };
    }
    if (validated.name === "TaskList") {
      const tasks = (await store.list()).filter(task => !task.metadata?._internal), completed = new Set(tasks.filter(task => task.status === "completed").map(task => task.id));
      return { tasks: tasks.map(task => ({ id: task.id, subject: task.subject, status: task.status, ...(task.owner === undefined ? {} : { owner: task.owner }), blockedBy: task.blockedBy.filter(id => !completed.has(id)) })) };
    }
    const parsed = validated.input, task = await store.get(parsed.taskId);
    if (!task) return { success: false, taskId: parsed.taskId, updatedFields: [], error: "Task not found" };
    if (parsed.status === "deleted") {
      const deleted = await store.delete(parsed.taskId, signal); return { success: deleted, taskId: parsed.taskId, updatedFields: deleted ? ["deleted"] : [], ...(!deleted ? { error: "Failed to delete task" } : { statusChange: { from: task.status, to: "deleted" } }) };
    }
    const patch: Partial<LocalTask> = {}, updatedFields: string[] = [];
    for (const key of ["subject", "description", "activeForm", "owner"] as const) if (parsed[key] !== undefined && parsed[key] !== task[key]) { patch[key] = parsed[key]; updatedFields.push(key); }
    if (parsed.metadata !== undefined) { patch.metadata = mergeTaskMetadata(task.metadata, parsed.metadata); updatedFields.push("metadata"); }
    if (parsed.status !== undefined && parsed.status !== task.status) {
      if (parsed.status === "completed") {
        const result = await this.options.lifecycle?.completed?.({ task: structuredClone(task), listId: store.listId, context, signal });
        if (result?.blockingErrors?.length) return { success: false, taskId: parsed.taskId, updatedFields: [], error: result.blockingErrors.join("\n") };
      }
      patch.status = parsed.status; updatedFields.push("status");
    }
    if (Object.keys(patch).length) await store.update(parsed.taskId, patch, signal);
    const blocks = parsed.addBlocks?.filter(id => !task.blocks.includes(id)) ?? [];
    for (const id of blocks) await store.addDependency(parsed.taskId, id, signal);
    if (blocks.length) updatedFields.push("blocks");
    const blockedBy = parsed.addBlockedBy?.filter(id => !task.blockedBy.includes(id)) ?? [];
    for (const id of blockedBy) await store.addDependency(id, parsed.taskId, signal);
    if (blockedBy.length) updatedFields.push("blockedBy");
    return { success: true, taskId: parsed.taskId, updatedFields, ...(patch.status === undefined ? {} : { statusChange: { from: task.status, to: patch.status } }) };
  }
  async execute(original: ToolUse, signal: AbortSignal): Promise<ToolResult> {
    let call = original, pre: PreToolHookResult | undefined, started = false, invalid = true;
    try {
      signal.throwIfAborted();
      if (!this.handles(call.name) || this.options.enabled?.() === false) throw new Error("Task tool is unavailable");
      const name = call.name, context = this.options.context();
      let validated = this.validate(name, call.input, context); call = { ...call, input: validated.input }; invalid = false;
      pre = await this.options.hooks?.before(call, signal, async value => { try { return this.validate(name, value, context).input; } catch (error) { invalid = true; throw error; } }); signal.throwIfAborted();
      if (pre?.updatedInput !== undefined) { invalid = true; validated = this.validate(name, pre.updatedInput, context); call = { ...call, input: validated.input }; invalid = false; }
      if (pre?.permission === "deny" || pre?.permission === "defer" || pre?.preventContinuation) return appendPreHookContext({ type: "tool_result", tool_use_id: original.id, is_error: true, permissionDenied: true, content: pre.reason ?? pre.stopReason ?? "Task operation blocked by a hook" }, pre, call, pre.preventContinuation ? pre.stopReason ?? "Task continuation stopped" : undefined);
      const allowed = await this.options.authorize(call, context, pre?.permission, signal); signal.throwIfAborted();
      if (allowed !== true) return appendPreHookContext({ type: "tool_result", tool_use_id: original.id, is_error: true, permissionDenied: true, content: typeof allowed === "string" ? allowed : "Task operation denied" }, pre, call);
      started = true;
      const data = await this.run(validated, context, signal); signal.throwIfAborted();
      let result = appendPreHookContext({ type: "tool_result", tool_use_id: original.id, content: this.format(name, data), effectiveToolInput: call.input, hookResponse: data }, pre, call);
      if (this.options.hooks) result = await this.options.hooks.after(call, result, signal, candidate => ({ ...result, content: this.format(name, candidate), hookResponse: ({ TaskCreate: createOutput, TaskGet: getOutput, TaskUpdate: updateOutput, TaskList: listOutput }[name]).parse(candidate) }));
      return result;
    } catch (error) {
      signal.throwIfAborted();
      let result: ToolResult = { type: "tool_result", tool_use_id: original.id, is_error: true, content: error instanceof Error ? error.message : "Task operation failed", ...(invalid ? { inputRejected: true } : {}) };
      if (started) result = appendFailureHookContext(result, await this.options.hooks?.failure?.(call, error, signal));
      return appendPreHookContext(result, pre, call);
    }
  }
}
export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime { return new TaskRuntime(options); }
