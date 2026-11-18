import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import {
  startMockProvider,
  turn,
  type ScriptedResponse,
} from "../helpers/mock-provider.js";

setDefaultTimeout(40_000);

const blockSchema = z.looseObject({
  type: z.string(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional(),
  is_error: z.boolean().optional(),
});
const bodySchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.union([z.string(), z.array(blockSchema)]),
    }),
  ),
});
type Body = z.infer<typeof bodySchema>;
const outcomeSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
const tasksSchema = z.object({
  tasks: z.array(
    z.looseObject({
      id: z.string(),
      cron: z.string(),
      prompt: z.string(),
      recurring: z.literal(true),
    }),
  ),
});

function blocks(body: Body) {
  return body.messages.flatMap((message) =>
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content,
  );
}
function resultText(body: Body, id: string) {
  const block = blocks(body).find(
    (candidate) =>
      candidate.type === "tool_result" && candidate.tool_use_id === id,
  );
  if (!block) return undefined;
  const content = block.content;
  const text =
    typeof content === "string"
      ? content
      : z
          .array(z.looseObject({ text: z.string().optional() }))
          .parse(content)
          .map((part) => part.text ?? "")
          .join("");
  const [own = ""] = text.split("\n\n<system-reminder>\n");
  return { text: own, isError: block.is_error === true };
}
function nth(bodies: readonly Body[], index: number): Body {
  const body = bodies.at(index);
  if (body === undefined) throw new Error(`no request ${index}`);
  return body;
}
function jsonValue(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}
const use = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): ScriptedResponse => turn({ type: "tool_use", id, name, input });

const NAMES = ["CronCreate", "CronDelete", "CronList", "SendMessage"];

test("cron and SendMessage load through ToolSearch, then schedule, list, cancel, and refuse", async () => {
  let jobId = "";
  const provider = await startMockProvider((body, index) => {
    const parsed = bodySchema.parse(body);
    if (jobId === "" && index >= 2) {
      jobId =
        /Scheduled recurring job ([0-9a-f]{8})/.exec(
          resultText(parsed, "create")?.text ?? "",
        )?.[1] ?? "";
    }
    const steps: ScriptedResponse[] = [
      use("search", "ToolSearch", {
        query: "select:CronCreate,CronDelete,CronList,SendMessage",
      }),
      use("create", "CronCreate", {
        cron: "7 * * * *",
        prompt: "ping the build",
      }),
      use("list", "CronList", {}),
      use("bad", "CronCreate", { cron: "not a cron", prompt: "nope" }),
      use("drop", "CronDelete", { id: jobId }),
      use("again", "CronDelete", { id: jobId }),
      use("main", "SendMessage", { to: "main", message: "hello" }),
      use("miss", "SendMessage", { to: "nobody", message: "hi" }),
      use("keep", "CronCreate", {
        cron: "*/5 * * * *",
        prompt: "keep this",
        durable: true,
      }),
    ];
    return steps[index] ?? turn({ type: "text", text: "done" });
  });
  const run = await runCli({
    args: [
      "-p",
      "schedule it",
      "--allowedTools",
      "CronCreate,CronDelete,CronList,SendMessage",
    ],
    provider,
  });
  expect(run.exitCode, run.stderr).toBe(0);
  const bodies = provider.requests.map(({ body }) => bodySchema.parse(body));
  const names = (index: number) =>
    nth(bodies, index).tools?.map((tool) => tool.name) ?? [];
  for (const name of NAMES) {
    expect(names(0)).not.toContain(name);
    expect(names(1)).toContain(name);
  }
  expect(jobId).toMatch(/^[0-9a-f]{8}$/);
  const created = resultText(nth(bodies, 2), "create");
  expect(created?.isError).toBe(false);
  expect(created?.text).toContain(
    `Scheduled recurring job ${jobId} (Every hour at :07).`,
  );
  expect(created?.text).toContain(
    "Session-only (not written to disk, dies when Claude exits)",
  );
  expect(created?.text).toContain("Auto-expires after 7 days");
  const listed = resultText(nth(bodies, 3), "list");
  expect(listed?.text).toContain(
    `${jobId} \u2014 Every hour at :07 (recurring) [session-only]`,
  );
  expect(listed?.text).toContain("ping the build");
  const bad = resultText(nth(bodies, 4), "bad");
  expect(bad?.isError).toBe(true);
  expect(bad?.text).toContain(
    "Invalid cron expression 'not a cron'. Expected 5 fields: M H DoM Mon DoW.",
  );
  expect(resultText(nth(bodies, 5), "drop")?.text).toBe(
    `Cancelled job ${jobId}.`,
  );
  const missing = resultText(nth(bodies, 6), "again");
  expect(missing?.isError).toBe(true);
  expect(missing?.text).toContain(`No scheduled job with id '${jobId}'`);
  const main = resultText(nth(bodies, 7), "main");
  expect(main?.isError).toBe(false);
  expect(outcomeSchema.parse(jsonValue(main?.text ?? ""))).toEqual({
    success: false,
    message:
      'You are the main conversation \u2014 "main" addresses you. Send to a named agent instead.',
  });
  const miss = resultText(nth(bodies, 8), "miss");
  expect(miss?.isError).toBe(false);
  expect(outcomeSchema.parse(jsonValue(miss?.text ?? "")).message).toContain(
    "No agent named 'nobody' is reachable.",
    "Use ListAgents to see everyone you can message.",
  );
  const kept = resultText(nth(bodies, 9), "keep");
  expect(kept?.isError).toBe(false);
  expect(kept?.text).toContain("Persisted to .claude/scheduled_tasks.json");
  const saved = jsonValue(
    readFileSync(join(run.cwd, ".claude", "scheduled_tasks.json"), "utf8"),
  );
  const tasks = tasksSchema.parse(saved);
  const task = tasks.tasks[0];
  expect(tasks.tasks).toHaveLength(1);
  expect(task).toMatchObject({
    cron: "*/5 * * * *",
    prompt: "keep this",
    recurring: true,
  });
  expect(task).not.toHaveProperty("durable");
  expect(JSON.stringify(saved)).not.toContain("ping the build");
});

test("CLAUDE_CODE_DISABLE_CRON removes the cron tools and leaves SendMessage", async () => {
  const provider = await startMockProvider([
    use("search", "ToolSearch", {
      query: "select:CronCreate,SendMessage",
    }),
    turn({ type: "text", text: "done" }),
  ]);
  const run = await runCli({
    args: ["-p", "schedule it"],
    env: { CLAUDE_CODE_DISABLE_CRON: "1" },
    provider,
  });
  expect(run.exitCode, run.stderr).toBe(0);
  const bodies = provider.requests.map(({ body }) => bodySchema.parse(body));
  const names = (index: number) =>
    nth(bodies, index).tools?.map((tool) => tool.name) ?? [];
  expect(resultText(nth(bodies, 1), "search")?.isError).toBe(false);
  expect(names(0)).not.toContain("SendMessage");
  expect(names(0)).not.toContain("CronCreate");
  expect(names(1)).toContain("SendMessage");
  expect(names(1)).not.toContain("CronCreate");
});
