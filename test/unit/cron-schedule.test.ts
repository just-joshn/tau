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

test("a stepped range, a Sunday range, and a field that is not a number are parsed or refused", () => {
  expect(parseCron("0-30/10 * * * *")?.minute).toEqual([0, 10, 20, 30]);
  expect(parseCron("0 0 * * 5-7")?.dayOfWeek).toEqual([0, 5, 6]);
  expect(parseCron("10-1 * * * *")).toBeUndefined();
  expect(parseCron("nope * * * *")).toBeUndefined();
});

test("the next Monday, the 15th, or neither when the expression cannot be searched", () => {
  const sundayNoon = new Date(2026, 10, 15, 12, 0).getTime();
  expect(nextCronMillis("0 0 * * 1", sundayNoon)).toBe(
    new Date(2026, 10, 16, 0, 0).getTime(),
  );
  expect(
    nextCronMillis("0 12 15 * 1", new Date(2026, 10, 14, 12, 0).getTime()),
  ).toBe(new Date(2026, 10, 15, 12, 0).getTime());
  expect(nextCronMillis("0 12 15 * 1", sundayNoon)).toBe(
    new Date(2026, 10, 16, 12, 0).getTime(),
  );
  expect(nextCronMillis("nope", sundayNoon)).toBeUndefined();
  expect(nextCronMillis("0 0 * * *", Number.NaN)).toBeUndefined();
});

test("canned phrases cover a one-minute step, an hourly step, and every day", () => {
  const at230 = new Date(2000, 0, 1, 14, 30).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  expect(humanSchedule("not five")).toBe("not five");
  expect(humanSchedule("*/1 * * * *")).toBe("Every minute");
  expect(humanSchedule("30 */2 * * *")).toBe("Every 2 hours at :30");
  expect(humanSchedule("15 */1 * * *")).toBe("Every hour at :15");
  expect(humanSchedule("*/5 9 * * *")).toBe("*/5 9 * * *");
  expect(humanSchedule("30 14 * * *")).toBe(`Every day at ${at230}`);
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

test("a half-hour one-shot fires early, a bad id does not jitter, and a leap day has no second hit", () => {
  const createdAt = at(14, 0, 30);
  expect(
    scheduledFireAt({
      id: "80000000",
      cron: "0 15 18 11 *",
      createdAt,
      recurring: false,
    }),
  ).toBe(at(15, 0) - 45_000);
  expect(
    scheduledFireAt({
      id: "zzzzzzzz",
      cron: "7 * * * *",
      createdAt,
      recurring: true,
    }),
  ).toBe(at(14, 7));
  expect(
    scheduledFireAt({
      id: "00000000",
      cron: "nope",
      createdAt,
      recurring: true,
    }),
  ).toBeUndefined();
  expect(
    scheduledFireAt({
      id: "00000000",
      cron: "* * 31 2 *",
      createdAt,
      recurring: false,
    }),
  ).toBeUndefined();
  const leap = new Date(2028, 1, 29, 0, 0).getTime();
  expect(
    scheduledFireAt({
      id: "00000000",
      cron: "0 0 29 2 *",
      createdAt: new Date(2028, 1, 1, 0, 0).getTime(),
      recurring: true,
    }),
  ).toBe(leap);
});
