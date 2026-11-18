/**
 * Cron expressions for CronCreate and CronList (chunk-psw0db44 Vee, l_n,
 * fL, c_n, qee, L9n, B3s, WCt, e4t). Local time. Five fields: M H DoM Mon DoW.
 */

export const CRON_LIMITS = Object.freeze({
  recurringFrac: 0.5,
  recurringCapMs: 1_800_000,
  oneShotMaxMs: 90_000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 604_800_000,
  cacheLeadMs: 15_000,
  frequentMs: 300_000,
});
export const CRON_MAX_AGE_DAYS = CRON_LIMITS.recurringMaxAgeMs / 86_400_000;
export const MAX_CRON_JOBS = 50;
const SEARCH_MINUTES = 527_040;
const FIELD_LIMITS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const CACHE_CRON = /^\*\/\d+ \* \* \* \*$/;

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(
  text: string,
  limits: { min: number; max: number },
): number[] | undefined {
  const values = new Set<number>();
  const dow = limits.min === 0 && limits.max === 6;
  for (const part of text.split(",")) {
    const star = /^\*(?:\/(\d+))?$/.exec(part);
    if (star) {
      const step = star[1] === undefined ? 1 : Number.parseInt(star[1], 10);
      if (step < 1) return undefined;
      for (let value = limits.min; value <= limits.max; value += step)
        values.add(value);
      continue;
    }
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    if (range) {
      const startText = range[1];
      const endText = range[2];
      if (startText === undefined || endText === undefined) return undefined;
      const start = Number.parseInt(startText, 10);
      const end = Number.parseInt(endText, 10);
      const step = range[3] === undefined ? 1 : Number.parseInt(range[3], 10);
      const ceiling = dow ? 7 : limits.max;
      if (start > end || step < 1 || start < limits.min || end > ceiling)
        return undefined;
      for (let value = start; value <= end; value += step)
        values.add(dow && value === 7 ? 0 : value);
      continue;
    }
    if (!/^\d+$/.test(part)) return undefined;
    let value = Number.parseInt(part, 10);
    if (dow && value === 7) value = 0;
    if (value < limits.min || value > limits.max) return undefined;
    values.add(value);
  }
  if (values.size === 0) return undefined;
  return [...values].sort((left, right) => left - right);
}

/** Vee. Undefined when the expression is not five legal fields. */
export function parseCron(expression: string): CronFields | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const fields = parts.map((part, index) => {
    const limits = FIELD_LIMITS[index];
    return limits === undefined ? undefined : parseField(part, limits);
  });
  const minute = fields[0];
  const hour = fields[1];
  const dayOfMonth = fields[2];
  const month = fields[3];
  const dayOfWeek = fields[4];
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  )
    return undefined;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function inGap(date: Date): boolean {
  const copy = new Date(date.getTime());
  copy.setMinutes(copy.getMinutes());
  return copy.getTime() !== date.getTime();
}

/** l_n / c_n. The first match strictly after `after`, or undefined within a year. */
export function nextCronMillis(
  expression: string,
  after: number,
  oneShot = false,
): number | undefined {
  const fields = parseCron(expression);
  if (fields === undefined) return undefined;
  const minutes = new Set(fields.minute);
  const hours = new Set(fields.hour);
  const days = new Set(fields.dayOfMonth);
  const months = new Set(fields.month);
  const weekdays = new Set(fields.dayOfWeek);
  const anyDay = fields.dayOfMonth.length === 31;
  const anyWeekday = fields.dayOfWeek.length === 7;
  const dayOk = (date: Date) => {
    if (anyDay && anyWeekday) return true;
    if (anyDay) return weekdays.has(date.getDay());
    if (anyWeekday) return days.has(date.getDate());
    return days.has(date.getDate()) || weekdays.has(date.getDay());
  };
  const cursor = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  if (Number.isNaN(cursor.getTime())) return undefined;
  for (let step = 0; step < SEARCH_MINUTES; step++) {
    if (inGap(cursor)) {
      if (
        oneShot &&
        months.has(cursor.getMonth() + 1) &&
        dayOk(cursor) &&
        hours.has(cursor.getHours()) &&
        minutes.has(cursor.getMinutes())
      )
        return cursor.getTime();
      cursor.setTime(cursor.getTime() + 60_000);
      continue;
    }
    if (!months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayOk(cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(cursor.getHours()) || !minutes.has(cursor.getMinutes())) {
      if (oneShot) cursor.setTime(cursor.getTime() + 60_000);
      else if (!hours.has(cursor.getHours()))
        cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      else cursor.setMinutes(cursor.getMinutes() + 1);
      continue;
    }
    return cursor.getTime();
  }
  return undefined;
}

function clock(minute: number, hour: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** fL. Falls back to the expression when no canned phrase matches. */
export function humanSchedule(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const minute = parts[0];
  const hour = parts[1];
  const day = parts[2];
  const month = parts[3];
  const weekday = parts[4];
  if (
    minute === undefined ||
    hour === undefined ||
    day === undefined ||
    month === undefined ||
    weekday === undefined
  )
    return expression;
  if (hour === "*" && day === "*" && month === "*" && weekday === "*") {
    if (minute === "*") return "Every minute";
    const step = /^\*\/(\d+)$/.exec(minute);
    const every = step?.[1];
    if (every !== undefined) {
      const count = Number.parseInt(every, 10);
      return count === 1 ? "Every minute" : `Every ${count} minutes`;
    }
  }
  if (
    /^\d+$/.test(minute) &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    const value = Number.parseInt(minute, 10);
    if (value === 0) return "Every hour";
    return `Every hour at :${value.toString().padStart(2, "0")}`;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (
    /^\d+$/.test(minute) &&
    hourStep &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    const countText = hourStep[1];
    if (countText === undefined) return expression;
    const count = Number.parseInt(countText, 10);
    const at = Number.parseInt(minute, 10);
    const suffix = at === 0 ? "" : ` at :${at.toString().padStart(2, "0")}`;
    return count === 1
      ? `Every hour${suffix}`
      : `Every ${count} hours${suffix}`;
  }
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return expression;
  const atMinute = Number.parseInt(minute, 10);
  const atHour = Number.parseInt(hour, 10);
  const when = clock(atMinute, atHour);
  if (day === "*" && month === "*" && weekday === "*")
    return `Every day at ${when}`;
  if (day === "*" && month === "*" && /^\d$/.test(weekday)) {
    const name = WEEKDAYS[Number.parseInt(weekday, 10) % 7];
    if (name !== undefined) return `Every ${name} at ${when}`;
  }
  if (day === "*" && month === "*" && weekday === "1-5")
    return `Weekdays at ${when}`;
  return expression;
}

function jitterUnit(id: string): number {
  const value = Number.parseInt(id.slice(0, 8), 16) / 4_294_967_296;
  return Number.isFinite(value) ? value : 0;
}

export interface CronFireInput {
  id: string;
  cron: string;
  createdAt: number;
  recurring: boolean;
  lastFiredAt?: number;
}

/** WCt. Recurring jobs jitter forward. A one-shot on :00 or :30 fires early. */
export function scheduledFireAt(
  job: CronFireInput,
  limits: typeof CRON_LIMITS = CRON_LIMITS,
): number | undefined {
  if (!job.recurring) return oneShotFire(job, limits);
  const after = job.lastFiredAt ?? job.createdAt;
  const first = nextCronMillis(job.cron, after);
  if (first === undefined) return undefined;
  const second = nextCronMillis(job.cron, first);
  if (second === undefined) return first;
  const period = second - first;
  if (
    CACHE_CRON.test(job.cron) &&
    limits.cacheLeadMs > 0 &&
    limits.cacheLeadMs < period &&
    period >= limits.frequentMs &&
    period - limits.cacheLeadMs < limits.frequentMs
  )
    return after + period - limits.cacheLeadMs;
  const delay = Math.min(
    jitterUnit(job.id) * limits.recurringFrac * period,
    limits.recurringCapMs,
  );
  return first + delay;
}

function oneShotFire(
  job: CronFireInput,
  limits: typeof CRON_LIMITS,
): number | undefined {
  const at = nextCronMillis(job.cron, job.createdAt, true);
  if (at === undefined) return undefined;
  if (new Date(at).getMinutes() % limits.oneShotMinuteMod !== 0) return at;
  const early =
    limits.oneShotFloorMs +
    jitterUnit(job.id) * (limits.oneShotMaxMs - limits.oneShotFloorMs);
  return Math.max(at - early, job.createdAt);
}

/** e4t. The minute the result text names. */
export function roundToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}

/** Iqe, without a year, in local time. */
export function formatFireTime(ms: number): string {
  return new Date(ms)
    .toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(/,? at |, (?=\d{1,2}:)/, " ")
    .replace(/[ \u202f]([AP]M)/i, (_match, suffix: string) =>
      suffix.toLowerCase(),
    );
}
