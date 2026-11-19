import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { CRON_LIMITS } from "../../src/cron-schedule.js";
import {
  AUTONOMOUS_LOOP,
  AUTONOMOUS_LOOP_DYNAMIC,
  createIdlePromptSource,
  planIdleFires,
  resolveIdlePrompt,
  type IdleJob,
} from "../../src/cron-idle.js";
import { CronJobStore, createCronTools } from "../../src/cron-tools.js";
import {
  runGuardedTool,
  type GuardedToolHost,
} from "../../src/guarded-tool.js";
import { scheduleWakeupTool } from "../../src/schedule-wakeup-tool.js";
import { toolPolicySchema } from "../../src/tool-policy.js";
import type { ToolUse } from "../../src/types.js";

const host: GuardedToolHost = {
  mode: () => "default",
  policy: () => toolPolicySchema.parse({}),
  hooks: () => undefined,
  approve: async () => false,
};
const signal = new AbortController().signal;

async function project() {
  const root = await mkdtemp(join(tmpdir(), "tau-idle-"));
  return {
    root,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function call(name: string, input: unknown): ToolUse {
  return { type: "tool_use", id: "call-1", name, input };
}

function loopJob(scheduledFor: number, prompt: string): IdleJob {
  const date = new Date(scheduledFor);
  return {
    id: "loop0001",
    cron: `${date.getMinutes()} ${date.getHours()} * * *`,
    prompt,
    createdAt: scheduledFor - 1,
    recurring: false,
    kind: "loop",
    scheduledFor,
  };
}

test("a loop job waits until scheduledFor, including a :00 minute", () => {
  const scheduledFor = new Date(2026, 10, 18, 16, 0, 0).getTime();
  const job = loopJob(scheduledFor, "check the run");
  const early = planIdleFires([job], scheduledFor - 30_000);
  expect(early.prompts).toEqual([]);
  expect(early.jobs.map((item) => item.id)).toEqual(["loop0001"]);
  const due = planIdleFires(early.jobs, scheduledFor);
  expect(due.prompts).toEqual(["check the run"]);
  expect(due.jobs).toEqual([]);
  expect(planIdleFires(due.jobs, scheduledFor).prompts).toEqual([]);
});

test("autonomous sentinels resolve to tick text and other prompts stay", () => {
  const dynamic = resolveIdlePrompt(AUTONOMOUS_LOOP_DYNAMIC);
  expect(dynamic).not.toBe(AUTONOMOUS_LOOP_DYNAMIC);
  expect(dynamic).toContain("# Autonomous loop tick (dynamic pacing)");
  expect(dynamic).toContain("`<<autonomous-loop-dynamic>>`");
  expect(dynamic).toContain("ScheduleWakeup");
  const cron = resolveIdlePrompt(AUTONOMOUS_LOOP);
  expect(cron).toContain("# Autonomous loop tick");
  expect(cron).not.toContain("dynamic pacing");
  expect(cron).toContain("do not call ScheduleWakeup");
  expect(resolveIdlePrompt("/loop check the run")).toBe("/loop check the run");
  const fired = planIdleFires([loopJob(1_000, AUTONOMOUS_LOOP_DYNAMIC)], 1_000);
  expect(fired.prompts).toEqual([dynamic]);
});

test("a one-shot cron is removed and a recurring cron moves forward", () => {
  const createdAt = new Date(2026, 10, 18, 14, 0, 0).getTime();
  const fireAt = new Date(2026, 10, 18, 15, 15, 0).getTime();
  const base: IdleJob = {
    id: "00000000",
    cron: "15 15 * * *",
    prompt: "check the deploy",
    createdAt,
    recurring: false,
  };
  const once = planIdleFires([base], fireAt - 1);
  expect(once.prompts).toEqual([]);
  const fired = planIdleFires(once.jobs, fireAt);
  expect(fired.prompts).toEqual(["check the deploy"]);
  expect(fired.jobs).toEqual([]);

  const recurring = planIdleFires([{ ...base, recurring: true }], fireAt);
  expect(recurring.prompts).toEqual(["check the deploy"]);
  expect(recurring.jobs.map((job) => job.lastFiredAt)).toEqual([fireAt]);
  expect(planIdleFires(recurring.jobs, fireAt).prompts).toEqual([]);
});

test("a recurring job is deleted on its final fire after 7 days", () => {
  const createdAt = new Date(2026, 10, 11, 14, 0, 0).getTime();
  const now = createdAt + CRON_LIMITS.recurringMaxAgeMs;
  const job: IdleJob = {
    id: "00000000",
    cron: "15 15 * * *",
    prompt: "still going",
    createdAt,
    recurring: true,
  };
  const aged = planIdleFires([job], now);
  expect(aged.prompts).toEqual(["still going"]);
  expect(aged.jobs).toEqual([]);
  const kept = planIdleFires([{ ...job, permanent: true }], now);
  expect(kept.jobs).toHaveLength(1);
  expect(kept.jobs[0]?.lastFiredAt).toBe(now);
});

test("ScheduleWakeup inserts one loop job and stop removes it", async () => {
  const dir = await project();
  try {
    const now = new Date(2026, 10, 18, 15, 0, 0).getTime();
    let n = 0;
    const store = new CronJobStore({
      projectDir: () => dir.root,
      now: () => now,
      newId: () => `job${n++}`,
    });
    const tool = scheduleWakeupTool({ now: () => now, jobs: store });
    const scheduled = await runGuardedTool(
      tool,
      host,
      call("ScheduleWakeup", {
        delaySeconds: 60,
        reason: "watching CI",
        prompt: AUTONOMOUS_LOOP_DYNAMIC,
        noop: false,
      }),
      signal,
    );
    expect(scheduled.is_error).toBeUndefined();
    const again = await runGuardedTool(
      tool,
      host,
      call("ScheduleWakeup", {
        delaySeconds: 120,
        reason: "still watching CI",
        prompt: "/loop check the run",
        noop: true,
      }),
      signal,
    );
    expect(again.is_error).toBeUndefined();
    const jobs = await store.list();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.kind).toBe("loop");
    expect(job?.durable).toBe(false);
    expect(job?.recurring).toBe(false);
    expect(job?.prompt).toBe("/loop check the run");
    expect(job?.reason).toBe("still watching CI");
    expect(job?.scheduledFor).toBe(now + 120_000);
    expect(job?.cron).toBe("2 15 * * *");
    const stopped = await runGuardedTool(
      tool,
      host,
      call("ScheduleWakeup", { stop: true }),
      signal,
    );
    expect(stopped.content).toContain("cancelled 1 pending wakeup");
    expect(await store.list()).toEqual([]);
    expect(await store.fireDue(now + 3_600_000)).toEqual([]);

    await store.replaceLoop({
      prompt: "still armed",
      reason: "watching CI",
      scheduledFor: now + 60_000,
      createdAt: now,
    });
    const aged = await runGuardedTool(
      scheduleWakeupTool({
        now: () => now,
        jobs: store,
        initial: {
          chains: new Map([
            [
              "old",
              {
                startedAt: now - 8 * 24 * 60 * 60 * 1000,
                lastScheduledFor: now - 1000,
                agedOut: false,
              },
            ],
          ]),
          pending: [],
        },
      }),
      host,
      call("ScheduleWakeup", {
        delaySeconds: 120,
        reason: "still here",
        prompt: "old",
        noop: true,
      }),
      signal,
    );
    expect(aged.content).toContain("Wakeup not scheduled");
    expect(await store.list()).toEqual([]);
  } finally {
    await dir.close();
  }
});

test("a scheduled wakeup enqueues its prompt after the delay while idle", async () => {
  const dir = await project();
  try {
    let now = new Date(2026, 10, 18, 15, 0, 0).getTime();
    const store = new CronJobStore({
      projectDir: () => dir.root,
      now: () => now,
      newId: () => "wake0001",
    });
    const tool = scheduleWakeupTool({ now: () => now, jobs: store });
    await runGuardedTool(
      tool,
      host,
      call("ScheduleWakeup", {
        delaySeconds: 60,
        reason: "watching CI",
        prompt: AUTONOMOUS_LOOP_DYNAMIC,
        noop: false,
      }),
      signal,
    );
    const due = (await store.list())[0]?.scheduledFor;
    expect(due).toBe(now + 60_000);
    const polls: number[] = [];
    const read = createIdlePromptSource({
      nextUser: () => new Promise(() => {}),
      poll: async () => {
        polls.push(now);
        return store.fireDue(now);
      },
      wait: async (ms) => {
        now += ms;
      },
      intervalMs: 1000,
    });
    const prompt = await read();
    expect(polls.at(-1)).toBeGreaterThanOrEqual(due ?? 0);
    expect(polls.at(-2)).toBeLessThan(due ?? 0);
    expect(prompt).toContain("# Autonomous loop tick (dynamic pacing)");
    expect(prompt).not.toBe(AUTONOMOUS_LOOP_DYNAMIC);
    expect(await store.list()).toEqual([]);
    expect(await store.fireDue(now)).toEqual([]);
  } finally {
    await dir.close();
  }
});

test("a waiting user prompt is returned before a due wakeup is polled", async () => {
  let polls = 0;
  let userReads = 0;
  const read = createIdlePromptSource({
    nextUser: () => {
      userReads += 1;
      return userReads === 1
        ? Promise.resolve("ship it")
        : new Promise(() => {});
    },
    poll: async () => {
      polls += 1;
      return ["too soon"];
    },
    wait: async () => {
      throw new Error("idle wait ran");
    },
  });
  expect(await read()).toBe("ship it");
  expect(polls).toBe(0);
  expect(await read()).toBe("too soon");
  expect(polls).toBe(1);
});

test("a due one-shot durable job is enqueued and removed from disk", async () => {
  const dir = await project();
  try {
    const createdAt = new Date(2026, 10, 18, 14, 0, 0).getTime();
    const fireAt = new Date(2026, 10, 18, 15, 15, 0).getTime();
    const store = new CronJobStore({
      projectDir: () => dir.root,
      now: () => createdAt,
      newId: () => "disk0001",
    });
    const tools = createCronTools({
      projectDir: () => dir.root,
      now: () => createdAt,
      newId: () => "disk0001",
      store,
    });
    const created = await runGuardedTool(
      tools.create,
      host,
      call("CronCreate", {
        cron: "15 15 * * *",
        prompt: "check the deploy",
        recurring: false,
        durable: true,
      }),
      signal,
    );
    expect(created.is_error).toBeUndefined();
    expect(await store.fireDue(fireAt - 1)).toEqual([]);
    expect(await store.fireDue(fireAt)).toEqual(["check the deploy"]);
    const text = await readFile(
      join(dir.root, ".claude", "scheduled_tasks.json"),
      "utf8",
    );
    expect(JSON.parse(text)).toEqual({ tasks: [] });
    expect(await store.fireDue(fireAt)).toEqual([]);
  } finally {
    await dir.close();
  }
});

test("two due prompts are delivered one idle at a time", async () => {
  const reads: string[] = [];
  const read = createIdlePromptSource({
    nextUser: () => new Promise(() => {}),
    poll: async () => {
      if (reads.length > 0) return [];
      reads.push("polled");
      return ["first", "second"];
    },
    wait: async () => {
      throw new Error("idle wait ran");
    },
  });
  expect(await read()).toBe("first");
  expect(await read()).toBe("second");
});
