import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { createCronTools, cronToolsEnabled } from "../../src/cron-tools.js";
import {
  runGuardedTool,
  type GuardedToolHost,
} from "../../src/guarded-tool.js";
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
  const root = await mkdtemp(join(tmpdir(), "tau-cron-"));
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

test("scheduling stays on unless CLAUDE_CODE_DISABLE_CRON is set", () => {
  expect(cronToolsEnabled({})).toBe(true);
  expect(cronToolsEnabled({ CLAUDE_CODE_DISABLE_CRON: "1" })).toBe(false);
  expect(cronToolsEnabled({ CLAUDE_CODE_DISABLE_CRON: "0" })).toBe(false);
});

test("a session job is listed and cancelled without a tasks file", async () => {
  const dir = await project();
  try {
    const tools = createCronTools({
      projectDir: () => dir.root,
      now: () => new Date(2026, 10, 18, 14, 0, 30).getTime(),
      newId: () => "abc12345",
    });
    const created = await runGuardedTool(
      tools.create,
      host,
      call("CronCreate", {
        cron: "15 15 * * *",
        prompt: "check the deploy",
        recurring: false,
      }),
      signal,
    );
    expect(created.is_error).toBeUndefined();
    expect(created.content).toMatch(
      /^Scheduled one-shot task abc12345 \(Every day at .+\)\. Next run: .+ Session-only \(not written to disk, dies when Claude exits\)\. It will fire once then auto-delete\.$/,
    );
    let wroteFile = false;
    try {
      await readFile(join(dir.root, ".claude", "scheduled_tasks.json"), "utf8");
      wroteFile = true;
    } catch {
      wroteFile = false;
    }
    expect(wroteFile).toBe(false);
    const listed = await runGuardedTool(
      tools.list,
      host,
      call("CronList", {}),
      signal,
    );
    expect(listed.content).toMatch(
      /^abc12345 \u2014 Every day at .+ \(one-shot\) \[session-only\], next run .+: check the deploy$/,
    );
    const removed = await runGuardedTool(
      tools.remove,
      host,
      call("CronDelete", { id: "abc12345" }),
      signal,
    );
    expect(removed.content).toBe("Cancelled job abc12345.");
    const empty = await runGuardedTool(
      tools.list,
      host,
      call("CronList", {}),
      signal,
    );
    expect(empty.content).toBe("No scheduled jobs.");
  } finally {
    await dir.close();
  }
});

test("a durable job survives a new store and a second delete says it is gone", async () => {
  const dir = await project();
  try {
    const first = createCronTools({
      projectDir: () => dir.root,
      sessionId: () => "session-1",
      now: () => new Date(2026, 10, 18, 14, 0, 30).getTime(),
      newId: () => "dur12345",
      procStart: "2026-11-18T22:00:00.000Z",
    });
    const created = await runGuardedTool(
      first.create,
      host,
      call("CronCreate", {
        cron: "*/5 * * * *",
        prompt: "ping\nstill pinging",
        durable: true,
      }),
      signal,
    );
    expect(created.content).toContain(
      "Persisted to .claude/scheduled_tasks.json",
    );
    expect(created.content).toContain("Auto-expires after 7 days");
    const file: unknown = JSON.parse(
      await readFile(join(dir.root, ".claude", "scheduled_tasks.json"), "utf8"),
    );
    const saved = z
      .object({
        tasks: z.array(
          z.looseObject({
            id: z.string(),
            cron: z.string(),
            prompt: z.string(),
            recurring: z.literal(true).optional(),
            createdBySessionId: z.string(),
            createdByProcStart: z.string(),
            createdInProject: z.string(),
          }),
        ),
      })
      .parse(file);
    expect(saved.tasks[0]).toMatchObject({
      id: "dur12345",
      cron: "*/5 * * * *",
      prompt: "ping\nstill pinging",
      recurring: true,
      createdBySessionId: "session-1",
      createdByProcStart: "2026-11-18T22:00:00.000Z",
      createdInProject: dir.root,
    });
    expect(saved.tasks[0]).not.toHaveProperty("durable");
    const second = createCronTools({ projectDir: () => dir.root });
    const listed = await runGuardedTool(
      second.list,
      host,
      call("CronList", {}),
      signal,
    );
    expect(listed.content).toContain(
      "dur12345 \u2014 Every 5 minutes (recurring)",
    );
    expect(listed.content).toContain("ping\u2026");
    expect(listed.content).not.toContain("[session-only]");
    const removed = await runGuardedTool(
      second.remove,
      host,
      call("CronDelete", { id: "dur12345" }),
      signal,
    );
    expect(removed.content).toBe("Cancelled job dur12345.");
    const again = await runGuardedTool(
      second.remove,
      host,
      call("CronDelete", { id: "dur12345" }),
      signal,
    );
    expect(again.is_error).toBe(true);
    expect(again.content).toContain("No scheduled job with id 'dur12345'");
  } finally {
    await dir.close();
  }
});

test("invalid cron, an impossible date, and a corrupt tasks file are refused", async () => {
  const dir = await project();
  try {
    const tools = createCronTools({ projectDir: () => dir.root });
    const bad = await runGuardedTool(
      tools.create,
      host,
      call("CronCreate", { cron: "60 * * * *", prompt: "nope" }),
      signal,
    );
    expect(bad.is_error).toBe(true);
    expect(bad.content).toContain(
      "Invalid cron expression '60 * * * *'. Expected 5 fields: M H DoM Mon DoW.",
    );
    const impossible = await runGuardedTool(
      tools.create,
      host,
      call("CronCreate", { cron: "* * 31 2 *", prompt: "never" }),
      signal,
    );
    expect(impossible.content).toContain(
      "does not match any calendar date in the next year",
    );
    await mkdir(join(dir.root, ".claude"));
    await writeFile(
      join(dir.root, ".claude", "scheduled_tasks.json"),
      "{not json",
    );
    const missing = await runGuardedTool(
      tools.remove,
      host,
      call("CronDelete", { id: "missing1" }),
      signal,
    );
    expect(missing.content).toContain("could not be read as a list of tasks");
  } finally {
    await dir.close();
  }
});

test("default permission allows the call when the user would deny a prompt", async () => {
  const dir = await project();
  try {
    const tools = createCronTools({
      projectDir: () => dir.root,
      newId: () => "allow1234",
    });
    const created = await runGuardedTool(
      tools.create,
      { ...host, approve: async () => false },
      call("CronCreate", { cron: "* * * * *", prompt: "tick" }),
      signal,
    );
    expect(created.is_error).toBeUndefined();
    expect(created.content).toContain("Scheduled recurring job allow1234");
  } finally {
    await dir.close();
  }
});
