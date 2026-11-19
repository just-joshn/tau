/**
 * CronCreate, CronDelete, and CronList (chunk-b7zts8xt, chunk-c93dfh89,
 * chunk-8a6symse, chunk-psw0db44, chunk-223am0ab).
 *
 * A job is one record. Session jobs live in the store. Durable jobs live in
 * `<project>/.claude/scheduled_tasks.json`. The file has a single writer,
 * this store, and it is replaced by rename.
 *
 * Pinned for a local session: scheduling is on, durable jobs are on, and the
 * self-hosted one-shot refusal (tengu_snug_crystal, default false) is absent.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import stringWidth from "string-width";
import { z } from "zod";
import {
  CRON_LIMITS,
  CRON_MAX_AGE_DAYS,
  MAX_CRON_JOBS,
  formatFireTime,
  humanSchedule,
  nextCronMillis,
  parseCron,
  roundToMinute,
  scheduledFireAt,
  type CronFireInput,
} from "./cron-schedule.js";
import { planIdleFires } from "./cron-idle.js";
import type { GuardedTool } from "./guarded-tool.js";
import { ToolValidationRefused } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const CRON_CREATE = "CronCreate";
export const CRON_DELETE = "CronDelete";
export const CRON_LIST = "CronList";
const TASKS_FILE = join(".claude", "scheduled_tasks.json");
const UNREADABLE =
  "The scheduled tasks file (.claude/scheduled_tasks.json) could not be read as a list of tasks, so nothing was removed from it. Check or repair that file, then try again.";

export function cronToolsEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return !env.CLAUDE_CODE_DISABLE_CRON?.trim();
}

const cronFieldDescription =
  'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).';
const recurringDescription = `true (default) = fire on every cron match until deleted or auto-expired after ${CRON_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`;
const durableDescription =
  "true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.";

export const cronCreateSchema = z.object({
  cron: z.string().describe(cronFieldDescription),
  prompt: z.string().describe("The prompt to enqueue at each fire time."),
  recurring: z.boolean().optional().describe(recurringDescription),
  durable: z.boolean().optional().describe(durableDescription),
});
export const cronDeleteSchema = z.object({
  id: z.string().describe("Job ID returned by CronCreate."),
});
export const cronListSchema = z.object({});
export type CronCreateInput = z.infer<typeof cronCreateSchema>;
export type CronDeleteInput = z.infer<typeof cronDeleteSchema>;
export type CronListInput = z.infer<typeof cronListSchema>;

/** M3s with durable scheduling on. This is the text the model sees. */
export function cronCreateDescription(): string {
  const percent = Math.round(CRON_LIMITS.recurringFrac * 100);
  const capMinutes = CRON_LIMITS.recurringCapMs / 60_000;
  const earlySeconds = CRON_LIMITS.oneShotMaxMs / 1000;
  return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local \u2014 no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests \u2014 fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" \u2192 cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" \u2192 cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` \u2014 which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" \u2192 "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" \u2192 "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." \u2192 pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late \u2014 the user will not notice, and the fleet will.

## Durability

By default (durable: false) the job lives only in this Claude session \u2014 nothing is written to disk, and the job is gone when Claude exits. Pass durable: true to write to .claude/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.

## Not for live watching

${CRON_CREATE} re-runs a prompt at fixed wall-clock intervals. To watch a log file, process, or command output and be notified the moment something changes, use the Monitor tool instead \u2014 Monitor streams events as they happen; cron polls on a schedule.

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). Durable jobs persist to .claude/scheduled_tasks.json and survive session restarts \u2014 on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. The scheduler shifts each job by a fixed per-job offset on top of whatever you pick: by default a recurring job runs up to ${percent}% of its period late (max ${capMinutes} min), and a one-shot job landing on :00 or :30 runs up to ${earlySeconds} s early. The result of this tool and of ${CRON_LIST} gives each job's actual next run time: when you tell the user when a job will run, give that time, not the minute in the cron expression. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${CRON_MAX_AGE_DAYS} days \u2014 they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${CRON_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to ${CRON_DELETE}.`;
}

export function cronDeleteDescription(): string {
  return `Cancel a cron job previously scheduled with ${CRON_CREATE}. Removes it from .claude/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`;
}
export function cronListDescription(): string {
  return `List all cron jobs scheduled via ${CRON_CREATE}, both durable (.claude/scheduled_tasks.json) and session-only.`;
}

function definition(
  name: string,
  description: string,
  schema: z.ZodType,
): ToolDefinition {
  return {
    name,
    description,
    input_schema: { ...z.toJSONSchema(schema), type: "object" },
  };
}

export interface CronJob extends CronFireInput {
  prompt: string;
  durable: boolean;
  agentId?: string;
  createdBySessionId?: string;
  createdByPid?: number;
  createdByProcStart?: string;
  createdInProject?: string;
  permanent?: true;
  plugin?: string;
  /** Absent on CronCreate jobs and on disk. Loop jobs are session-only. */
  kind?: "cron" | "loop";
  scheduledFor?: number;
  reason?: string;
}

export interface CronStoreOptions {
  projectDir: () => string;
  sessionId?: () => string;
  now?: () => number;
  newId?: () => string;
  callerAgentId?: () => string | undefined;
  procStart?: string;
}

const diskTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  lastFiredAt: z.unknown().optional(),
  recurring: z.unknown().optional(),
  permanent: z.unknown().optional(),
  createdBySessionId: z.unknown().optional(),
  createdByPid: z.unknown().optional(),
  createdByProcStart: z.unknown().optional(),
  createdInProject: z.unknown().optional(),
  plugin: z.unknown().optional(),
});
const diskFileSchema = z.object({ tasks: z.array(z.unknown()) });

type DiskRead =
  | { kind: "empty" }
  | { kind: "unreadable" }
  | { kind: "tasks"; tasks: CronJob[] };

function errno(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
function pluginOk(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && code < 32) return false;
  }
  return true;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function taskFromDisk(value: unknown): CronJob | undefined {
  const parsed = diskTaskSchema.safeParse(value);
  if (!parsed.success || parseCron(parsed.data.cron) === undefined)
    return undefined;
  const row = parsed.data;
  if (row.plugin !== undefined) {
    if (typeof row.plugin !== "string" || !pluginOk(row.plugin))
      return undefined;
  }
  const job: CronJob = {
    id: row.id,
    cron: row.cron,
    prompt: row.prompt,
    createdAt: row.createdAt,
    recurring: row.recurring === true,
    durable: true,
  };
  if (typeof row.lastFiredAt === "number") job.lastFiredAt = row.lastFiredAt;
  if (row.permanent === true) job.permanent = true;
  const sessionId = optionalString(row.createdBySessionId);
  if (sessionId !== undefined) job.createdBySessionId = sessionId;
  if (typeof row.createdByPid === "number") job.createdByPid = row.createdByPid;
  const procStart = optionalString(row.createdByProcStart);
  if (procStart !== undefined) job.createdByProcStart = procStart;
  const project = optionalString(row.createdInProject);
  if (project !== undefined) job.createdInProject = project;
  if (typeof row.plugin === "string") job.plugin = row.plugin;
  return job;
}

function diskRecord(job: CronJob): Record<string, unknown> {
  return {
    id: job.id,
    cron: job.cron,
    prompt: job.prompt,
    createdAt: job.createdAt,
    ...(job.lastFiredAt === undefined ? {} : { lastFiredAt: job.lastFiredAt }),
    ...(job.recurring ? { recurring: true } : {}),
    ...(job.permanent ? { permanent: true } : {}),
    ...(job.createdBySessionId === undefined
      ? {}
      : { createdBySessionId: job.createdBySessionId }),
    ...(job.createdByPid === undefined
      ? {}
      : { createdByPid: job.createdByPid }),
    ...(job.createdByProcStart === undefined
      ? {}
      : { createdByProcStart: job.createdByProcStart }),
    ...(job.createdInProject === undefined
      ? {}
      : { createdInProject: job.createdInProject }),
    ...(job.plugin === undefined ? {} : { plugin: job.plugin }),
  };
}

/** Ts(text, limit, true): the first line, then an ellipsis once it exceeds the width. */
export function clipPrompt(text: string, limit: number): string {
  const breakAt = text.indexOf("\n");
  const line = breakAt === -1 ? text : text.slice(0, breakAt);
  const fit = (value: string) => {
    if (stringWidth(value) <= limit) return value;
    if (limit <= 1) return "\u2026";
    let out = "";
    let width = 0;
    for (const char of value) {
      const next = stringWidth(char);
      if (width + next > limit - 1) break;
      out += char;
      width += next;
    }
    return `${out}\u2026`;
  };
  if (breakAt === -1) return stringWidth(line) <= limit ? line : fit(line);
  return stringWidth(line) + 1 > limit ? fit(line) : `${line}\u2026`;
}

function fireText(job: CronJob, now: number, clampToNow: boolean): string {
  const fire = scheduledFireAt(job);
  if (fire === undefined) return "";
  const shown = clampToNow ? Math.max(fire, now) : fire;
  return `, next run ${formatFireTime(roundToMinute(shown))}`;
}

export function formatCronCreateResult(job: CronJob): string {
  const persistence = job.durable
    ? "Persisted to .claude/scheduled_tasks.json"
    : "Session-only (not written to disk, dies when Claude exits)";
  const fire = scheduledFireAt(job);
  const next =
    fire === undefined
      ? ""
      : ` Next run: ${formatFireTime(roundToMinute(fire))}.`;
  const when = humanSchedule(job.cron);
  return job.recurring
    ? `Scheduled recurring job ${job.id} (${when}).${next} ${persistence}. Auto-expires after ${CRON_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
    : `Scheduled one-shot task ${job.id} (${when}).${next} ${persistence}. It will fire once then auto-delete.`;
}

export function formatCronList(jobs: readonly CronJob[], now: number): string {
  if (jobs.length === 0) return "No scheduled jobs.";
  return jobs
    .map((job) => {
      const kind = job.recurring ? " (recurring)" : " (one-shot)";
      const where = job.durable ? "" : " [session-only]";
      return `${job.id} \u2014 ${humanSchedule(job.cron)}${kind}${where}${fireText(job, now, true)}: ${clipPrompt(job.prompt, 80)}`;
    })
    .join("\n");
}

export class CronJobStore {
  #session: CronJob[] = [];
  #chain: Promise<void> = Promise.resolve();
  constructor(private readonly options: CronStoreOptions) {}

  async create(input: {
    cron: string;
    prompt: string;
    recurring: boolean;
    durable: boolean;
  }): Promise<{ ok: true; job: CronJob } | { ok: false; message: string }> {
    return this.#locked(async () => {
      const caller = this.options.callerAgentId?.();
      if (input.durable && caller !== undefined)
        return {
          ok: false,
          message:
            "durable crons are not supported for teammates (teammates do not persist across sessions)",
        };
      const existing = await this.#all();
      if (!existing.ok) {
        if (!input.durable) return this.#addSession(input, caller);
      } else if (existing.jobs.length >= MAX_CRON_JOBS)
        return {
          ok: false,
          message: `Too many scheduled jobs (max ${MAX_CRON_JOBS}). Cancel one first.`,
        };
      if (!input.durable) return this.#addSession(input, caller);
      const disk = await this.#readDisk();
      const tasks = disk.kind === "tasks" ? disk.tasks : [];
      if (tasks.length + this.#session.length >= MAX_CRON_JOBS)
        return {
          ok: false,
          message: `Too many scheduled jobs (max ${MAX_CRON_JOBS}). Cancel one first.`,
        };
      const job = this.#job(input, true, caller);
      const sessionId = this.options.sessionId?.();
      if (sessionId !== undefined) job.createdBySessionId = sessionId;
      job.createdByPid = process.pid;
      if (this.options.procStart !== undefined)
        job.createdByProcStart = this.options.procStart;
      job.createdInProject = this.options.projectDir();
      await this.#writeDisk([...tasks, job]);
      return { ok: true, job };
    });
  }

  async remove(
    id: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.#locked(() => this.#remove(id));
  }

  async find(
    id: string,
  ): Promise<
    { kind: "found"; job: CronJob } | { kind: "missing"; unreadable: boolean }
  > {
    return this.#locked(async () => {
      const session = this.#session.find((job) => job.id === id);
      const disk = await this.#readDisk();
      const stored =
        disk.kind === "tasks"
          ? disk.tasks.find((job) => job.id === id)
          : undefined;
      const job = session ?? stored;
      if (job === undefined)
        return { kind: "missing", unreadable: disk.kind === "unreadable" };
      return { kind: "found", job: { ...job } };
    });
  }

  /** Disk jobs that cannot be read count as zero, matching the original reader. */
  async size(): Promise<number> {
    return this.#locked(async () => {
      const all = await this.#all();
      return all.ok ? all.jobs.length : this.#session.length;
    });
  }

  /** One-shot kind:"loop" job. Replaces any loop job already in the session list. */
  async replaceLoop(input: {
    prompt: string;
    reason: string;
    scheduledFor: number;
    createdAt: number;
  }): Promise<void> {
    return this.#locked(async () => {
      this.#session = this.#session.filter((job) => job.kind !== "loop");
      const date = new Date(input.scheduledFor);
      this.#session.push({
        id: this.#id(),
        cron: `${date.getMinutes()} ${date.getHours()} * * *`,
        prompt: input.prompt,
        createdAt: input.createdAt,
        recurring: false,
        durable: false,
        kind: "loop",
        scheduledFor: input.scheduledFor,
        reason: input.reason,
      });
    });
  }

  /** Removes session loop jobs. Durable cron jobs stay. */
  async cancelLoops(): Promise<number> {
    return this.#locked(async () => {
      const before = this.#session.length;
      this.#session = this.#session.filter((job) => job.kind !== "loop");
      return before - this.#session.length;
    });
  }

  /**
   * Enqueues prompts for due jobs and updates the list.
   * Durable changes are written. An unreadable tasks file contributes nothing.
   */
  async fireDue(now: number): Promise<string[]> {
    return this.#locked(async () => {
      const disk = await this.#readDisk();
      const durable = disk.kind === "tasks" ? disk.tasks : [];
      const durablePlan = planIdleFires(durable, now);
      const sessionPlan = planIdleFires(this.#session, now);
      if (
        disk.kind === "tasks" &&
        durableChanged(durable, durablePlan.jobs)
      )
        await this.#writeDisk(durablePlan.jobs);
      this.#session = sessionPlan.jobs;
      return [...durablePlan.prompts, ...sessionPlan.prompts];
    });
  }

  async list(): Promise<CronJob[]> {
    return this.#locked(async () => {
      const all = await this.#all();
      const jobs = all.ok ? all.jobs : this.#session.map((job) => ({ ...job }));
      const caller = this.options.callerAgentId?.();
      return caller === undefined
        ? jobs
        : jobs.filter((job) => job.agentId === caller);
    });
  }

  async #addSession(
    input: {
      cron: string;
      prompt: string;
      recurring: boolean;
      durable: boolean;
    },
    caller: string | undefined,
  ): Promise<{ ok: true; job: CronJob } | { ok: false; message: string }> {
    if (this.#session.length >= MAX_CRON_JOBS)
      return {
        ok: false,
        message: `Too many scheduled jobs (max ${MAX_CRON_JOBS}). Cancel one first.`,
      };
    const disk = await this.#readDisk();
    const durableCount = disk.kind === "tasks" ? disk.tasks.length : 0;
    if (durableCount + this.#session.length >= MAX_CRON_JOBS)
      return {
        ok: false,
        message: `Too many scheduled jobs (max ${MAX_CRON_JOBS}). Cancel one first.`,
      };
    const job = this.#job(input, false, caller);
    this.#session.push(job);
    return { ok: true, job };
  }

  #job(
    input: {
      cron: string;
      prompt: string;
      recurring: boolean;
      durable: boolean;
    },
    durable: boolean,
    caller: string | undefined,
  ): CronJob {
    const job: CronJob = {
      id: this.#id(),
      cron: input.cron,
      prompt: input.prompt,
      createdAt: (this.options.now ?? Date.now)(),
      recurring: input.recurring,
      durable,
    };
    if (caller !== undefined) job.agentId = caller;
    return job;
  }

  async #remove(
    id: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const caller = this.options.callerAgentId?.();
    const session = this.#session.find((job) => job.id === id);
    const disk = await this.#readDisk();
    const stored =
      disk.kind === "tasks"
        ? disk.tasks.find((job) => job.id === id)
        : undefined;
    const job = session ?? stored;
    if (job === undefined)
      return {
        ok: false,
        message:
          disk.kind === "unreadable"
            ? UNREADABLE
            : `No scheduled job with id '${id}'`,
      };
    if (caller !== undefined && job.agentId !== caller)
      return {
        ok: false,
        message: `Cannot delete cron job '${id}': owned by another agent`,
      };
    const sessionOnly = session !== undefined && stored === undefined;
    this.#session = this.#session.filter((item) => item.id !== id);
    if (!sessionOnly && disk.kind === "tasks")
      await this.#writeDisk(disk.tasks.filter((item) => item.id !== id));
    return { ok: true };
  }

  async #all(): Promise<{ ok: true; jobs: CronJob[] } | { ok: false }> {
    const disk = await this.#readDisk();
    if (disk.kind === "unreadable") return { ok: false };
    const tasks = disk.kind === "tasks" ? disk.tasks : [];
    return {
      ok: true,
      jobs: [...tasks, ...this.#session.map((job) => ({ ...job }))],
    };
  }

  async #readDisk(): Promise<DiskRead> {
    const path = join(this.options.projectDir(), TASKS_FILE);
    let text: string;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { kind: "unreadable" };
      text = await readFile(path, "utf8");
    } catch (error) {
      if (errno(error) === "ENOENT") return { kind: "empty" };
      return { kind: "unreadable" };
    }
    if (text.trim() === "") return { kind: "empty" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "unreadable" };
    }
    const file = diskFileSchema.safeParse(parsed);
    if (!file.success) return { kind: "unreadable" };
    const tasks: CronJob[] = [];
    for (const value of file.data.tasks) {
      const job = taskFromDisk(value);
      if (job !== undefined) tasks.push(job);
    }
    return { kind: "tasks", tasks };
  }

  async #writeDisk(tasks: readonly CronJob[]): Promise<void> {
    const directory = join(this.options.projectDir(), ".claude");
    const path = join(directory, "scheduled_tasks.json");
    try {
      const parent = await lstat(directory);
      if (parent.isSymbolicLink())
        throw new Error("refusing to write scheduled tasks through a symlink");
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    try {
      const current = await lstat(path);
      if (current.isSymbolicLink())
        throw new Error("refusing to replace a symlinked scheduled tasks file");
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(
      temporary,
      `${JSON.stringify({ tasks: tasks.map(diskRecord) }, null, 2)}\n`,
    );
    await rename(temporary, path);
  }

  #id(): string {
    return (this.options.newId ?? (() => randomUUID().slice(0, 8)))();
  }

  async #locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function durableChanged(
  before: readonly CronJob[],
  after: readonly CronJob[],
): boolean {
  if (before.length !== after.length) return true;
  return after.some(
    (job, index) => job.lastFiredAt !== before[index]?.lastFiredAt,
  );
}

function refuse(message: string): never {
  throw new ToolValidationRefused(
    `<tool_use_error>${message}</tool_use_error>`,
  );
}

export interface CronTools {
  store: CronJobStore;
  create: GuardedTool<CronCreateInput>;
  remove: GuardedTool<CronDeleteInput>;
  list: GuardedTool<CronListInput>;
}

export function createCronTools(
  options: CronStoreOptions & { store?: CronJobStore },
): CronTools {
  const store = options.store ?? new CronJobStore(options);
  const now = () => (options.now ?? Date.now)();
  const create: GuardedTool<CronCreateInput> = {
    name: CRON_CREATE,
    definition: () =>
      definition(CRON_CREATE, cronCreateDescription(), cronCreateSchema),
    schema: () => cronCreateSchema,
    async validate(input) {
      if (parseCron(input.cron) === undefined)
        return `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`;
      if (nextCronMillis(input.cron, now()) === undefined)
        return `Cron expression '${input.cron}' does not match any calendar date in the next year.`;
      if ((input.durable ?? false) && options.callerAgentId?.() !== undefined)
        return "durable crons are not supported for teammates (teammates do not persist across sessions)";
      if ((await store.size()) >= MAX_CRON_JOBS)
        return `Too many scheduled jobs (max ${MAX_CRON_JOBS}). Cancel one first.`;
      return undefined;
    },
    async check() {
      return { behavior: "allow" };
    },
    async run(input) {
      const created = await store.create({
        cron: input.cron,
        prompt: input.prompt,
        recurring: input.recurring ?? true,
        durable: input.durable ?? false,
      });
      if (!created.ok) refuse(created.message);
      return formatCronCreateResult(created.job);
    },
  };
  const remove: GuardedTool<CronDeleteInput> = {
    name: CRON_DELETE,
    definition: () =>
      definition(CRON_DELETE, cronDeleteDescription(), cronDeleteSchema),
    schema: () => cronDeleteSchema,
    async validate(input) {
      const found = await store.find(input.id);
      if (found.kind === "missing")
        return found.unreadable
          ? UNREADABLE
          : `No scheduled job with id '${input.id}'`;
      const caller = options.callerAgentId?.();
      if (caller !== undefined && found.job.agentId !== caller)
        return `Cannot delete cron job '${input.id}': owned by another agent`;
      return undefined;
    },
    async check() {
      return { behavior: "allow" };
    },
    async run(input) {
      const removed = await store.remove(input.id);
      if (!removed.ok) refuse(removed.message);
      return `Cancelled job ${input.id}.`;
    },
  };
  const list: GuardedTool<CronListInput> = {
    name: CRON_LIST,
    definition: () =>
      definition(CRON_LIST, cronListDescription(), cronListSchema),
    schema: () => cronListSchema,
    async check() {
      return { behavior: "allow" };
    },
    async run() {
      return formatCronList(await store.list(), now());
    },
  };
  return { store, create, remove, list };
}
