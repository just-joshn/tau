/**
 * Idle firing for cron jobs and ScheduleWakeup loop jobs.
 *
 * The session job list is the only schedule. A loop job is due at
 * scheduledFor. A cron job is due at its cron fire time. Firing removes a
 * loop job and a one-shot, and stamps lastFiredAt on a recurring job.
 */
import { CRON_LIMITS, scheduledFireAt } from "./cron-schedule.js";

export const AUTONOMOUS_LOOP = "<<autonomous-loop>>";
export const AUTONOMOUS_LOOP_DYNAMIC = "<<autonomous-loop-dynamic>>";
export const IDLE_POLL_MS = 1000;

const DYNAMIC_TICK = [
  "# Autonomous loop tick (dynamic pacing)",
  "",
  "Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.",
  "",
  "You scheduled this tick via the ScheduleWakeup tool (not a recurring cron). To keep the loop alive, call ScheduleWakeup again this turn with `prompt` set to the literal sentinel `<<autonomous-loop-dynamic>>` and `noop` set to `true` if this tick changed nothing (or `false` if it did) \u2014 otherwise the loop ends after this tick.",
  "",
  "If a Monitor is armed (check TaskList), keep `delaySeconds` at 1200\u20131800s \u2014 the Monitor is the wake signal and this is only the fallback heartbeat. If you were woken by a `<task-notification>`, handle the event before deciding whether to re-arm. After re-arming, write a brief status update for this tick. This must be ordinary visible response text \u2014 the user cannot see your thinking/reasoning, so an update written only there is invisible to them. Make it the last thing in the turn, then end the turn. To stop the loop, call ScheduleWakeup with `stop: true` and TaskStop the monitor (use TaskList to find its task ID if no longer in context).",
].join("\n");

const CRON_TICK = [
  "# Autonomous loop tick",
  "",
  "Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically \u2014 do not call ScheduleWakeup from this tick.",
].join("\n");

export interface IdleJob {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring: boolean;
  permanent?: true;
  lastFiredAt?: number;
  kind?: "cron" | "loop";
  scheduledFor?: number;
}

export function idleFireAt(job: IdleJob): number | undefined {
  const kind = job.kind ?? "cron";
  switch (kind) {
    case "loop":
      return job.scheduledFor;
    case "cron":
      return scheduledFireAt(job);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Tick text for the two autonomous sentinels. Any other prompt is unchanged. */
export function resolveIdlePrompt(prompt: string): string {
  if (prompt === AUTONOMOUS_LOOP_DYNAMIC) return DYNAMIC_TICK;
  if (prompt === AUTONOMOUS_LOOP) return CRON_TICK;
  return prompt;
}

export function planIdleFires<T extends IdleJob>(
  jobs: readonly T[],
  now: number,
): { prompts: string[]; jobs: T[] } {
  const prompts: string[] = [];
  const next: T[] = [];
  for (const job of jobs) {
    const at = idleFireAt(job);
    if (at === undefined || now < at) {
      next.push(job);
      continue;
    }
    prompts.push(resolveIdlePrompt(job.prompt));
    const kind = job.kind ?? "cron";
    if (kind === "loop" || !job.recurring) continue;
    if (
      job.permanent !== true &&
      now - job.createdAt >= CRON_LIMITS.recurringMaxAgeMs
    )
      continue;
    next.push({ ...job, lastFiredAt: now });
  }
  return { prompts, jobs: next };
}

/**
 * One prompt at a time while the caller is idle.
 * A submission already waiting wins over a job that becomes due on the same wait.
 * Prompts already taken from the job list stay queued until the next call.
 */
export function createIdlePromptSource(input: {
  nextUser: () => Promise<string | undefined>;
  poll: () => Promise<readonly string[]>;
  wait: (ms: number) => Promise<void>;
  intervalMs?: number;
}): () => Promise<string | undefined> {
  const queued: string[] = [];
  let pending: Promise<void> | undefined;
  let userReady = false;
  let userText: string | undefined;

  const armUser = () => {
    if (pending !== undefined) return;
    userReady = false;
    pending = input.nextUser().then((text) => {
      userReady = true;
      userText = text;
    });
  };
  const takeUser = (): string | undefined => {
    pending = undefined;
    userReady = false;
    const text = userText;
    userText = undefined;
    return text;
  };

  return async () => {
    if (queued.length > 0) return queued.shift();
    armUser();
    const interval = input.intervalMs ?? IDLE_POLL_MS;
    while (!userReady && queued.length === 0) {
      await Promise.resolve();
      if (userReady) break;
      for (const prompt of await input.poll()) queued.push(prompt);
      if (userReady || queued.length > 0) break;
      await Promise.race([pending, input.wait(interval)]);
    }
    if (userReady) return takeUser();
    return queued.shift();
  };
}
