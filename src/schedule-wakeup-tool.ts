/**
 * ScheduleWakeup (chunk-fkkma3m4.js call, chunk-46yvn24a.js clamp and M).
 * shouldDefer is false. The book records the chain. When a job list is
 * attached, schedule inserts one session loop job and stop removes them.
 * The idle tick enqueues a due loop job.
 */
import { z } from "zod";
import { SCHEDULE_WAKEUP_DESCRIPTION } from "./eager-catalog-text.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const SCHEDULE_WAKEUP_TOOL = "ScheduleWakeup";
export const SCHEDULE_WAKEUP_SEARCH_HINT =
  "self-pace the dynamic /loop: pick a delay before the next tick, or stop/end/cancel the dynamic loop with stop:true (a fixed-interval /loop is a recurring cron \u2014 cancel it with CronDelete)";

const MIN_SECONDS = 60;
const MAX_SECONDS = 3600;
const MINUTE_MS = 60_000;
const CACHE_TTL_MS = 300_000;
const CACHE_LEAD_MS = 15_000;
const CACHE_WINDOW_MS = 3_600_000;
const RECENT_ANCHOR_MS = 600_000;
const CHAIN_GAP_MS = 3_600_000;
const MAX_CHAIN_AGE_MS = 604_800_000;

export const WAKEUP_DELAY_REASON_REQUIRED =
  "`delaySeconds` and `reason` are required when `stop` is not true.";
export const WAKEUP_PROMPT_REQUIRED =
  "`prompt` is required when `stop` is not true.";
export const WAKEUP_PLUGIN_BLOCKED =
  "A plugin started or resumed this subagent, or the one that spawned it, and that plugin is not known in this session. It cannot schedule work: nothing would hold that work after a Stop.";
const STOP_TAIL =
  "If you armed a Monitor for this loop, TaskStop it now. Then write the loop's outcome for the user as ordinary visible response text \u2014 and end the turn.";
const AGED_OUT_TAIL =
  "Then write the loop's outcome for the user as ordinary visible response text \u2014 and end the turn.";
const SCHEDULE_TAIL =
  "If you owe the user a status update this tick, write it now as ordinary response text; then end the turn \u2014 the harness re-invokes you when the wakeup fires or a task-notification arrives.";

export class ScheduleWakeupInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleWakeupInputError";
  }
}

const scheduleWakeupSchema = z
  .object({
    delaySeconds: z
      .number()
      .optional()
      .describe(
        "Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless `stop` is true.",
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific. Required unless `stop` is true.",
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        "The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead (the dynamic-pacing variant, not the CronCreate-mode `<<autonomous-loop>>`). Required unless `stop` is true.",
      ),
    stop: z
      .boolean()
      .optional()
      .describe(
        "Set to true to end the dynamic loop immediately instead of scheduling another wakeup. When true, all other fields are ignored and no further wakeups fire.",
      ),
    noop: z
      .boolean()
      .optional()
      .describe(
        "true = nothing changed (you checked and there is nothing to report). false = something happened worth keeping (edited a file, posted a message, advanced state, surfaced a finding). Consecutive noop:true ticks are collapsed in the user's terminal view and tracked as a streak. Required unless `stop` is true.",
      ),
  })
  .strict();
export type ScheduleWakeupInput = z.infer<typeof scheduleWakeupSchema>;

export interface WakeupChain {
  startedAt: number;
  lastScheduledFor: number;
  agedOut: boolean;
}
export interface PendingWakeup {
  prompt: string;
  reason: string;
  scheduledFor: number;
}
export interface WakeupBook {
  chains: ReadonlyMap<string, WakeupChain>;
  pending: readonly PendingWakeup[];
}
export function emptyWakeupBook(): WakeupBook {
  return { chains: new Map(), pending: [] };
}

export interface ClampedWakeup {
  clampedDelaySeconds: number;
  wasClamped: boolean;
  scheduledFor: number;
}

/** Minute alignment from chunk-46yvn24a.js T(), with the default 15s cache lead. */
export function clampWakeupDelay(
  delaySeconds: number,
  now: number,
  cacheAnchor = now,
): ClampedWakeup {
  let rounded: number;
  if (Number.isNaN(delaySeconds)) rounded = MIN_SECONDS;
  else if (delaySeconds === Number.POSITIVE_INFINITY) rounded = MAX_SECONDS;
  else if (delaySeconds === Number.NEGATIVE_INFINITY) rounded = MIN_SECONDS;
  else rounded = Math.round(delaySeconds);
  const clampedDelaySeconds = Math.max(
    MIN_SECONDS,
    Math.min(MAX_SECONDS, rounded),
  );
  const wasClamped =
    !Number.isFinite(delaySeconds) || rounded !== clampedDelaySeconds;
  let scheduledFor =
    Math.ceil((now + clampedDelaySeconds * 1000) / MINUTE_MS) * MINUTE_MS;
  if (clampedDelaySeconds * 1000 <= CACHE_TTL_MS) {
    const limit = CACHE_TTL_MS - CACHE_LEAD_MS;
    while (
      scheduledFor - now > limit &&
      scheduledFor - MINUTE_MS >= now + MIN_SECONDS * 1000
    )
      scheduledFor -= MINUTE_MS;
  }
  const base =
    now - cacheAnchor <= RECENT_ANCHOR_MS ? Math.min(now, cacheAnchor) : now;
  const deadline = base + CACHE_WINDOW_MS - CACHE_LEAD_MS;
  while (
    scheduledFor > deadline &&
    scheduledFor - MINUTE_MS >= now + MIN_SECONDS * 1000
  )
    scheduledFor -= MINUTE_MS;
  return { clampedDelaySeconds, wasClamped, scheduledFor };
}

export function scheduleWakeupStopText(cancelled: number): string {
  if (cancelled === 0)
    return `Loop stopped \u2014 any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call \u2014 cancel it with CronDelete. ${STOP_TAIL}`;
  return `Loop stopped \u2014 cancelled ${cancelled} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${STOP_TAIL}`;
}

export const WAKEUP_AGED_OUT_TEXT = `Wakeup not scheduled. The loop reached its maximum duration \u2014 the loop has ended; do not re-issue. ${AGED_OUT_TAIL}`;

export function scheduleWakeupScheduledText(
  outcome: ClampedWakeup & { now: number },
): string {
  const clock = new Date(outcome.scheduledFor).toTimeString().slice(0, 8);
  const seconds = Math.max(
    0,
    Math.round((outcome.scheduledFor - outcome.now) / 1000),
  );
  const clamped = outcome.wasClamped
    ? ` (clamped to ${outcome.clampedDelaySeconds}s from your requested value)`
    : "";
  return `Next wakeup scheduled for ${clock} (in ${seconds}s)${clamped}. ${SCHEDULE_TAIL}`;
}

export function stopWakeups(book: WakeupBook): {
  book: WakeupBook;
  cancelled: number;
} {
  return { cancelled: book.pending.length, book: emptyWakeupBook() };
}

export type ScheduledWakeup =
  | { kind: "scheduled"; book: WakeupBook; clamped: ClampedWakeup }
  | { kind: "aged_out"; book: WakeupBook };

export function scheduleWakeup(
  book: WakeupBook,
  input: { delaySeconds: number; reason: string; prompt: string },
  now: number,
  cacheAnchor = now,
): ScheduledWakeup {
  const previous = book.chains.get(input.prompt);
  const gap =
    previous !== undefined && now > previous.lastScheduledFor + CHAIN_GAP_MS;
  const startedAt = previous === undefined || gap ? now : previous.startedAt;
  if (now - startedAt >= MAX_CHAIN_AGE_MS) {
    const chains = new Map(book.chains);
    if (previous?.agedOut !== true)
      chains.set(input.prompt, {
        startedAt,
        lastScheduledFor: now - (CHAIN_GAP_MS - MIN_SECONDS * 1000),
        agedOut: true,
      });
    return { kind: "aged_out", book: { chains, pending: book.pending } };
  }
  const clamped = clampWakeupDelay(input.delaySeconds, now, cacheAnchor);
  const chains = new Map(book.chains);
  chains.set(input.prompt, {
    startedAt,
    lastScheduledFor: clamped.scheduledFor,
    agedOut: false,
  });
  return {
    kind: "scheduled",
    clamped,
    book: {
      chains,
      pending: [
        {
          prompt: input.prompt,
          reason: input.reason,
          scheduledFor: clamped.scheduledFor,
        },
      ],
    },
  };
}

export function scheduleWakeupDefinition(): ToolDefinition {
  return {
    name: SCHEDULE_WAKEUP_TOOL,
    description: SCHEDULE_WAKEUP_DESCRIPTION,
    input_schema: {
      ...z.toJSONSchema(scheduleWakeupSchema, { io: "input" }),
      type: "object",
    },
  };
}

export interface LoopJobs {
  replaceLoop(input: {
    prompt: string;
    reason: string;
    scheduledFor: number;
    createdAt: number;
  }): Promise<void>;
  cancelLoops(): Promise<number>;
}

export interface ScheduleWakeupOptions {
  now?: () => number;
  cacheAnchor?: () => number;
  /** Unnamed plugin owner. Scheduling is refused. stop still runs. */
  pluginBlocksSchedule?: boolean;
  initial?: WakeupBook;
  /** Same session list CronCreate uses. */
  jobs?: LoopJobs;
}

function loopCreatedAt(
  now: number,
  delaySeconds: number,
  scheduledFor: number,
): number {
  const raw = now + delaySeconds * 1000;
  return raw < scheduledFor ? raw : scheduledFor - 1;
}

export function scheduleWakeupTool(
  options: ScheduleWakeupOptions = {},
): GuardedTool<ScheduleWakeupInput> {
  let book = options.initial ?? emptyWakeupBook();
  const now = () => options.now?.() ?? Date.now();
  return {
    name: SCHEDULE_WAKEUP_TOOL,
    definition: scheduleWakeupDefinition,
    schema: () => scheduleWakeupSchema,
    async check() {
      return { behavior: "allow" };
    },
    async run(input) {
      if (input.stop !== true && options.pluginBlocksSchedule === true)
        throw new ScheduleWakeupInputError(WAKEUP_PLUGIN_BLOCKED);
      if (input.stop === true) {
        const cancelled = options.jobs
          ? await options.jobs.cancelLoops()
          : book.pending.length;
        book = emptyWakeupBook();
        return scheduleWakeupStopText(cancelled);
      }
      if (input.delaySeconds === undefined || input.reason === undefined)
        throw new ScheduleWakeupInputError(WAKEUP_DELAY_REASON_REQUIRED);
      if (input.prompt === undefined)
        throw new ScheduleWakeupInputError(WAKEUP_PROMPT_REQUIRED);
      const at = now();
      const step = scheduleWakeup(
        book,
        {
          delaySeconds: input.delaySeconds,
          reason: input.reason,
          prompt: input.prompt,
        },
        at,
        options.cacheAnchor?.() ?? at,
      );
      if (options.jobs) {
        if (step.kind === "aged_out") await options.jobs.cancelLoops();
        else
          await options.jobs.replaceLoop({
            prompt: input.prompt,
            reason: input.reason,
            scheduledFor: step.clamped.scheduledFor,
            createdAt: loopCreatedAt(
              at,
              step.clamped.clampedDelaySeconds,
              step.clamped.scheduledFor,
            ),
          });
      }
      book = step.book;
      if (step.kind === "aged_out") return WAKEUP_AGED_OUT_TEXT;
      return scheduleWakeupScheduledText({ ...step.clamped, now: at });
    },
  };
}
