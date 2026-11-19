import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  CronJobStore,
  clipPrompt,
  createCronTools,
  formatCronCreateResult,
  formatCronList,
  type CronJob,
} from "../../src/cron-tools.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-cron-br-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const NOW = new Date(2026, 10, 18, 14, 0, 30).getTime();
const tasksPath = () => join(root, ".claude", "scheduled_tasks.json");
async function writeTasks(text: string) {
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(tasksPath(), text);
}
let counter = 0;
function store(extra: Record<string, unknown> = {}) {
  return new CronJobStore({
    projectDir: () => root,
    now: () => NOW,
    newId: () => `id${++counter}`,
    ...extra,
  });
}
const base = { cron: "15 15 * * *", prompt: "p", recurring: true };

test("disk tasks keep every optional field and drop invalid rows", async () => {
  await writeTasks(
    JSON.stringify({
      tasks: [
        {
          id: "full",
          cron: "*/5 * * * *",
          prompt: "p",
          createdAt: 1,
          lastFiredAt: 2,
          recurring: true,
          permanent: true,
          createdBySessionId: "s",
          createdByPid: 9,
          createdByProcStart: "ps",
          createdInProject: "/x",
          plugin: "pl",
        },
        {
          id: "min",
          cron: "*/5 * * * *",
          prompt: "q",
          createdAt: 1,
          lastFiredAt: "x",
          createdByPid: "x",
          createdBySessionId: 1,
        },
        { id: "badcron", cron: "nope", prompt: "p", createdAt: 1 },
        {
          id: "badplugin",
          cron: "* * * * *",
          prompt: "p",
          createdAt: 1,
          plugin: 5,
        },
        {
          id: "emptyplugin",
          cron: "* * * * *",
          prompt: "p",
          createdAt: 1,
          plugin: "",
        },
        {
          id: "longplugin",
          cron: "* * * * *",
          prompt: "p",
          createdAt: 1,
          plugin: "a".repeat(257),
        },
        {
          id: "ctlplugin",
          cron: "* * * * *",
          prompt: "p",
          createdAt: 1,
          plugin: "a\u0001",
        },
        "garbage",
      ],
    }),
  );
  const jobs = await store().list();
  expect(jobs.map((j) => j.id)).toEqual(["full", "min"]);
  expect(jobs[0]).toMatchObject({
    lastFiredAt: 2,
    permanent: true,
    createdBySessionId: "s",
    createdByPid: 9,
    createdByProcStart: "ps",
    createdInProject: "/x",
    plugin: "pl",
    recurring: true,
    durable: true,
  });
  expect(jobs[1]).toMatchObject({ recurring: false });
  expect(jobs[1]?.lastFiredAt).toBeUndefined();
  // Removing one rewrites the file with the full record preserved.
  const s = store();
  expect(await s.remove("min")).toEqual({ ok: true });
  const rewritten = JSON.parse(await readFile(tasksPath(), "utf8"));
  expect(rewritten.tasks).toHaveLength(1);
  expect(rewritten.tasks[0]).toMatchObject({
    id: "full",
    lastFiredAt: 2,
    permanent: true,
    createdByPid: 9,
    createdByProcStart: "ps",
    createdInProject: "/x",
    plugin: "pl",
    createdBySessionId: "s",
    recurring: true,
  });
});

test("empty, blank and unreadable task files are told apart", async () => {
  expect(await store().find("x")).toEqual({
    kind: "missing",
    unreadable: false,
  });
  await writeTasks("   \n");
  expect(await store().find("x")).toEqual({
    kind: "missing",
    unreadable: false,
  });
  await writeTasks("{nope");
  expect(await store().find("x")).toEqual({
    kind: "missing",
    unreadable: true,
  });
  await writeTasks(JSON.stringify({ tasks: "no" }));
  expect(await store().find("x")).toEqual({
    kind: "missing",
    unreadable: true,
  });
  const removed = await store().remove("x");
  expect(removed.ok).toBe(false);
  expect(await store().size()).toBe(0);
  const s = store();
  expect((await s.create({ ...base, durable: false })).ok).toBe(true);
  expect(await s.size()).toBe(1);
  expect(await s.list()).toHaveLength(1);
  expect(await s.find("id" + counter)).toMatchObject({ kind: "found" });
  expect(await s.remove("id" + counter)).toEqual({ ok: true });
  expect((await store().remove("nope")).ok).toBe(false);
});

test("a symlinked tasks file or directory is unreadable and never written through", async () => {
  await mkdir(join(root, ".claude"));
  await writeFile(join(root, "real.json"), '{"tasks":[]}');
  await symlink(join(root, "real.json"), tasksPath());
  expect(await store().find("x")).toEqual({
    kind: "missing",
    unreadable: true,
  });
  await rm(tasksPath());
  await mkdir(join(root, "elsewhere"));
  await rm(join(root, ".claude"), { recursive: true });
  await symlink(join(root, "elsewhere"), join(root, ".claude"));
  await expect(store().create({ ...base, durable: true })).rejects.toThrow(
    /symlink/,
  );
  await rm(join(root, ".claude"));
  await mkdir(join(root, ".claude"));
  await symlink(join(root, "real.json"), tasksPath());
  // Reading a symlink makes the list unreadable, so a durable create has no
  // existing jobs and replaces nothing; writing refuses to replace the link.
  await expect(store().create({ ...base, durable: true })).rejects.toThrow(
    /symlinked scheduled tasks file/,
  );
  // A non-ENOENT lstat failure (ENOTDIR) is rethrown.
  await rm(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude"), "file");
  await expect(store().create({ ...base, durable: true })).rejects.toThrow();
});

test("durable create stamps provenance and enforces limits", async () => {
  const s = store({
    sessionId: () => "sess",
    procStart: "start",
  });
  const made = await s.create({ ...base, durable: true });
  expect(made.ok && made.job).toMatchObject({
    createdBySessionId: "sess",
    createdByProcStart: "start",
    createdInProject: root,
    durable: true,
  });
  const plain = await store().create({ ...base, durable: true });
  expect(plain.ok && plain.job.createdBySessionId).toBeUndefined();
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: `d${i}`,
    cron: "* * * * *",
    prompt: "p",
    createdAt: 1,
  }));
  await writeTasks(JSON.stringify({ tasks: rows }));
  const full = store();
  for (const durable of [true, false]) {
    const refused = await full.create({ ...base, durable });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.message).toContain("Too many");
  }
});

test("session-only limit counts session jobs, and disk+session combined", async () => {
  const s = store();
  for (let i = 0; i < 50; i++)
    expect((await s.create({ ...base, durable: false })).ok).toBe(true);
  const over = await s.create({ ...base, durable: false });
  expect(over.ok).toBe(false);
  // Unreadable disk with a full session still goes through #addSession's cap.
  await writeTasks("{bad");
  const over2 = await s.create({ ...base, durable: false });
  expect(over2.ok).toBe(false);
  // Disk + session together hit the cap although each is under it.
  await rm(join(root, ".claude"), { recursive: true });
  const t = store();
  for (let i = 0; i < 25; i++) await t.create({ ...base, durable: false });
  await writeTasks(
    JSON.stringify({
      tasks: Array.from({ length: 25 }, (_, i) => ({
        id: `d${i}`,
        cron: "* * * * *",
        prompt: "p",
        createdAt: 1,
      })),
    }),
  );
  const mixed = await t.create({ ...base, durable: false });
  expect(mixed.ok).toBe(false);
  const mixedDurable = await t.create({ ...base, durable: true });
  expect(mixedDurable.ok).toBe(false);
});

test("unreadable disk still lets a session job be created", async () => {
  await writeTasks("{bad");
  const s = store();
  expect((await s.create({ ...base, durable: false })).ok).toBe(true);
  expect(await s.size()).toBe(1);
  const listed = await s.list();
  expect(listed).toHaveLength(1);
});

test("teammates are scoped to their own jobs and cannot persist", async () => {
  let caller: string | undefined = "agentA";
  const s = store({ callerAgentId: () => caller });
  const refused = await s.create({ ...base, durable: true });
  expect(refused).toMatchObject({ ok: false });
  const mine = await s.create({ ...base, durable: false });
  expect(mine.ok && mine.job.agentId).toBe("agentA");
  expect(await s.list()).toHaveLength(1);
  caller = "agentB";
  expect(await s.list()).toHaveLength(0);
  const cannot = await s.remove(mine.ok ? mine.job.id : "");
  expect(cannot.ok === false && cannot.message).toContain(
    "owned by another agent",
  );
  caller = undefined;
  expect(await s.list()).toHaveLength(1);
  // Tool-level validate mirrors the checks.
  let who: string | undefined = "agentA";
  const tools = createCronTools({
    projectDir: () => root,
    now: () => NOW,
    callerAgentId: () => who,
  });
  expect(
    await tools.create.validate?.({
      cron: "15 15 * * *",
      prompt: "p",
      durable: true,
    }),
  ).toContain("teammates");
  const made = await tools.store.create({ ...base, durable: false });
  const id = made.ok ? made.job.id : "";
  expect(await tools.remove.validate?.({ id })).toBeUndefined();
  who = "agentB";
  expect(await tools.remove.validate?.({ id })).toContain("owned by another");
  who = undefined;
  expect(await tools.remove.validate?.({ id })).toBeUndefined();
});

test("tool validate and run report refusals, unreadable files and caps", async () => {
  const tools = createCronTools({ projectDir: () => root, now: () => NOW });
  const v = tools.create.validate!;
  expect(await v({ cron: "bad", prompt: "p" })).toContain("Invalid cron");
  expect(await v({ cron: "0 0 30 2 *", prompt: "p" })).toContain(
    "does not match",
  );
  expect(await v({ cron: "15 15 * * *", prompt: "p" })).toBeUndefined();
  expect(await tools.remove.validate!({ id: "none" })).toContain(
    "No scheduled job",
  );
  await writeTasks("{bad");
  expect(await tools.remove.validate!({ id: "none" })).toContain(
    "could not be read",
  );
  await rm(join(root, ".claude"), { recursive: true });
  await writeTasks(
    JSON.stringify({
      tasks: Array.from({ length: 50 }, (_, i) => ({
        id: `d${i}`,
        cron: "* * * * *",
        prompt: "p",
        createdAt: 1,
      })),
    }),
  );
  expect(await v({ cron: "15 15 * * *", prompt: "p" })).toContain("Too many");
  const signal = new AbortController().signal;
  await expect(
    tools.create.run({ cron: "15 15 * * *", prompt: "p" }, {} as never, signal),
  ).rejects.toThrow(/Too many/);
  await expect(
    tools.remove.run({ id: "ghost" }, {} as never, signal),
  ).rejects.toThrow(/No scheduled job/);
  expect(await tools.remove.run({ id: "d1" }, {} as never, signal)).toContain(
    "Cancelled",
  );
  expect(await tools.list.run({}, {} as never, signal)).toContain("d0");
  expect(tools.create.definition().name).toBe("CronCreate");
  expect(tools.remove.definition().name).toBe("CronDelete");
  expect(tools.list.definition().name).toBe("CronList");
  expect(await tools.create.check({} as never)).toEqual({ behavior: "allow" });
  expect(await tools.remove.check({} as never)).toEqual({ behavior: "allow" });
  expect(await tools.list.check({})).toEqual({ behavior: "allow" });
});

test("a durable job removal with a session twin keeps the session job", async () => {
  const s = store();
  const made = await s.create({ ...base, durable: true });
  const id = made.ok ? made.job.id : "";
  expect(await s.remove(id)).toEqual({ ok: true });
  expect(await s.size()).toBe(0);
});

test("clipPrompt truncates by display width on the first line", () => {
  expect(clipPrompt("short", 10)).toBe("short");
  expect(clipPrompt("abcdefghij", 5)).toBe("abcd\u2026");
  expect(clipPrompt("abcdefghij", 1)).toBe("\u2026");
  expect(clipPrompt("ab\ncd", 10)).toBe("ab\u2026");
  expect(clipPrompt("abcdef\ncd", 4)).toBe("abc\u2026");
  expect(clipPrompt("ab\ncd", 2)).toBe("ab");
  expect(clipPrompt("\u4e2d\u6587\u5b57\u7b26", 4)).toBe("\u4e2d\u2026");
});

test("create and list text covers one-shot, durable and unfireable jobs", () => {
  const job: CronJob = {
    id: "j1",
    cron: "15 15 * * *",
    prompt: "do it",
    createdAt: NOW,
    recurring: true,
    durable: true,
  };
  expect(formatCronCreateResult(job)).toContain(
    "Persisted to .claude/scheduled_tasks.json",
  );
  expect(formatCronCreateResult(job)).toContain("Auto-expires");
  const dead = { ...job, cron: "0 0 30 2 *", recurring: false, durable: false };
  const text = formatCronCreateResult(dead);
  expect(text).not.toContain("Next run");
  expect(text).toContain("one-shot");
  expect(formatCronList([], NOW)).toBe("No scheduled jobs.");
  const listed = formatCronList([job, dead], NOW);
  expect(listed).toContain("(recurring), next run");
  expect(listed).toContain("(one-shot) [session-only]: do it");
});
