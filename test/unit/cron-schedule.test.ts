import { expect, test } from "bun:test";
import {
  CRON_LIMITS,
  formatFireTime,
  humanSchedule,
  nextCronMillis,
  parseCron,
  roundToMinute,
  scheduledFireAt,
} from "../../src/cron-schedule.js";

const at = (hour: number, minute: number, second = 0) =>
  new Date(2026, 10, 18, hour, minute, second).getTime();

test("parses five fields, Sunday as 7, and rejects a field that cannot match", () => {
  expect(parseCron("*/5 * * * *")?.minute).toEqual([
    0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
  ]);
  expect(parseCron("0 0 * * 7")?.dayOfWeek).toEqual([0]);
  expect(parseCron("0 0 * * 1-5")?.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  expect(parseCron("* * *")).toBeUndefined();
  expect(parseCron("60 * * * *")).toBeUndefined();
  expect(parseCron("*/0 * * * *")).toBeUndefined();
});

test("names the canned schedules and leaves an odd expression as written", () => {
  expect(humanSchedule("* * * * *")).toBe("Every minute");
  expect(humanSchedule("*/5 * * * *")).toBe("Every 5 minutes");
  expect(humanSchedule("0 * * * *")).toBe("Every hour");
  expect(humanSchedule("7 * * * *")).toBe("Every hour at :07");
  expect(humanSchedule("0 */2 * * *")).toBe("Every 2 hours");
  expect(humanSchedule("30 14 * * 1")).toBe(
    `Every Monday at ${new Date(2000, 0, 1, 14, 30).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
  );
  expect(humanSchedule("30 14 * * 1-5")).toMatch(/^Weekdays at /);
  expect(humanSchedule("30 14 28 2 *")).toBe("30 14 28 2 *");
});

test("the next match is the following minute that fits, and Feb 31 never fits", () => {
  const next = nextCronMillis("15 15 * * *", at(14, 0, 30));
  expect(next).toBe(at(15, 15));
  expect(nextCronMillis("* * 31 2 *", at(14, 0))).toBeUndefined();
});

test("a */5 job fires 15s before a 5 minute period, and a zero id adds no jitter", () => {
  const createdAt = at(14, 0, 30);
  expect(
    scheduledFireAt({
      id: "abcdef12",
      cron: "*/5 * * * *",
      createdAt,
      recurring: true,
    }),
  ).toBe(createdAt + 300_000 - CRON_LIMITS.cacheLeadMs);
  const hourly = scheduledFireAt({
    id: "00000000",
    cron: "7 * * * *",
    createdAt,
    recurring: true,
  });
  expect(hourly).toBe(at(14, 7));
});

test("a one-shot off the half hour is exact, and the result minute is rounded", () => {
  const createdAt = at(14, 0, 30);
  const fire = scheduledFireAt({
    id: "00000000",
    cron: "15 15 18 11 *",
    createdAt,
    recurring: false,
  });
  expect(fire).toBe(at(15, 15));
  expect(roundToMinute(at(15, 15, 20))).toBe(at(15, 15));
  expect(formatFireTime(at(15, 15))).toBe(
    new Date(at(15, 15))
      .toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
      .replace(/,? at |, (?=\d{1,2}:)/, " ")
      .replace(/[ \u202f]([AP]M)/i, (_match, suffix: string) =>
        suffix.toLowerCase(),
      ),
  );
});
