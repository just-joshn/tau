import { expect, setDefaultTimeout, test } from "bun:test";
import { realpathSync } from "node:fs";
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
  const [own = "", ...reminders] = text.split("\n\n<system-reminder>\n");
  return { text: own, isError: block.is_error === true, reminders };
}
function nth(bodies: readonly Body[], index: number): Body {
  const body = bodies.at(index);
  if (body === undefined) throw new Error(`no request ${index}`);
  return body;
}
const allText = (body: Body) =>
  blocks(body)
    .map((block) => block.text ?? "")
    .join("\n");

const use = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): ScriptedResponse => turn({ type: "tool_use", id, name, input });

test("Monitor loads through ToolSearch and streams stdout lines as notifications on later requests", async () => {
  const script: ScriptedResponse[] = [
    use("search", "ToolSearch", { query: "select:Monitor" }),
    use("watch", "Monitor", {
      description: "count lines",
      command: "for i in 1 2 3; do echo line$i; sleep 0.4; done",
    }),
  ];
  const provider = await startMockProvider(
    (_body, index) =>
      script[index] ?? turn({ type: "text", text: `idle ${index}` }),
  );
  const run = await runCli({
    args: ["-p", "watch it", "--allowedTools", "Monitor"],
    provider,
  });
  expect(run.exitCode).toBe(0);
  const bodies = provider.requests.map(({ body }) => bodySchema.parse(body));
  expect(bodies[0]?.tools?.map((tool) => tool.name)).not.toContain("Monitor");
  expect(bodies[1]?.tools?.map((tool) => tool.name)).toContain("Monitor");
  const started = resultText(nth(bodies, 2), "watch");
  expect(started?.isError).toBe(false);
  expect(started?.text).toMatch(
    /^Monitor started \(task b[0-9a-z]{8}, expires in 5m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch\)\. You will be notified on each event\./,
  );
  const taskId = /task (b[0-9a-z]{8})/.exec(started?.text ?? "")?.[1];
  const later = bodies.slice(3).map(allText).join("\n");
  for (const line of ["line1", "line2", "line3"])
    expect(later).toContain(`<event>${line}</event>`);
  expect(later).toContain(
    `<task-id>${taskId}</task-id>\n<summary>Monitor event: "count lines"</summary>\n<event>line1</event>`,
  );
  expect(later).toContain(
    `<status>completed</status>\n<summary>Monitor "count lines" stream ended</summary>`,
  );
});

test("an unbounded monitor gets one expiry notice at its deadline, and TaskStop ends another silently", async () => {
  let stopTarget = "";
  const script: ScriptedResponse[] = [
    use("search", "ToolSearch", { query: "select:Monitor,TaskStop" }),
    use("expiring", "Monitor", {
      description: "ready then quiet",
      command: "echo ready; sleep 30",
      timeout_ms: 1500,
    }),
    use("stopped", "Monitor", {
      description: "to stop",
      command: "sleep 30",
    }),
  ];
  const provider = await startMockProvider((body, index) => {
    const parsed = bodySchema.parse(body);
    if (index === 3) {
      stopTarget =
        /task (b[0-9a-z]{8})/.exec(
          resultText(parsed, "stopped")?.text ?? "",
        )?.[1] ?? "";
      return use("stop", "TaskStop", { task_id: stopTarget });
    }
    return script[index] ?? turn({ type: "text", text: `idle ${index}` });
  });
  const run = await runCli({
    args: ["-p", "watch it", "--allowedTools", "Monitor,TaskStop"],
    provider,
  });
  expect(run.exitCode).toBe(0);
  const bodies = provider.requests.map(({ body }) => bodySchema.parse(body));
  const all = bodies.map(allText).join("\n");
  expect(all).toContain("<event>ready</event>");
  expect(all).toContain(
    "<event>[Monitor expired after 1s with 1 event delivered. Re-arm it if you still need the watch.]</event>",
  );
  expect(all).not.toContain(`Monitor "ready then quiet" stream ended`);
  expect(resultText(nth(bodies, -1), "stop")?.text).toContain(
    `"task_id":"${stopTarget}"`,
  );
  expect(all).not.toContain('Monitor event: "to stop"');
  expect(all).not.toContain('<summary>Monitor "to stop"');
});

test("a Monitor call without an allow rule is refused in print mode and starts nothing", async () => {
  const provider = await startMockProvider([
    use("search", "ToolSearch", { query: "select:Monitor" }),
    use("watch", "Monitor", {
      description: "marker",
      command: "touch monitor-ran.txt",
    }),
    turn({ type: "text", text: "done" }),
  ]);
  const run = await runCli({ args: ["-p", "watch it"], provider });
  expect(run.exitCode).toBe(0);
  const result = resultText(
    bodySchema.parse(provider.requests[2]?.body),
    "watch",
  );
  expect(result?.isError).toBe(true);
  expect(await Bun.file(join(run.cwd, "monitor-ran.txt")).exists()).toBe(false);
});

test("EnterWorktree moves Bash into a new worktree; ExitWorktree refuses dirty removal, keeps, and refuses to remove an entered one", async () => {
  const script: ScriptedResponse[] = [
    use("init", "Bash", {
      command:
        "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git rev-parse HEAD",
    }),
    use("search", "ToolSearch", {
      query: "select:EnterWorktree,ExitWorktree",
    }),
    use("enter", "EnterWorktree", { name: "feature/x" }),
    use("pwd", "Bash", { command: "pwd && git branch --show-current" }),
    use("dirty", "Bash", { command: "echo hi > new.txt" }),
    use("remove", "ExitWorktree", { action: "remove" }),
    use("keep", "ExitWorktree", { action: "keep" }),
    use("back", "Bash", { command: "pwd && git worktree list --porcelain" }),
    use("again", "ExitWorktree", { action: "keep" }),
    use("reenter", "EnterWorktree", { path: ".claude/worktrees/feature+x" }),
    use("notmine", "ExitWorktree", { action: "remove" }),
    use("leave", "ExitWorktree", { action: "keep", discard_changes: true }),
  ];
  const provider = await startMockProvider(
    (_body, index) =>
      script[index] ?? turn({ type: "text", text: `done ${index}` }),
  );
  const run = await runCli({
    args: ["-p", "use a worktree", "--permission-mode", "bypassPermissions"],
    provider,
  });
  expect(run.exitCode).toBe(0);
  const last = bodySchema.parse(provider.requests.at(-1)?.body);
  const text = (id: string) => resultText(last, id);
  const workspace = realpathSync(run.cwd);
  const worktree = join(workspace, ".claude", "worktrees", "feature+x");
  expect(text("enter")?.text).toBe(
    `Created worktree at “${worktree}” on branch “worktree-feature+x”. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
  );
  expect(text("enter")?.reminders.join("")).toContain(
    `# Environment update\n - Primary working directory: ${worktree} (was ${workspace})\n - This is a git worktree`,
  );
  expect(text("pwd")?.text).toBe(`${worktree}\nworktree-feature+x`);
  expect(text("remove")).toMatchObject({
    text: `<tool_use_error>Worktree has 1 uncommitted file. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.</tool_use_error>`,
    isError: true,
  });
  expect(text("keep")).toMatchObject({
    text: `Exited worktree. Your work is preserved at “${worktree}” on branch “worktree-feature+x”. Session is now back in “${workspace}”.`,
    isError: false,
  });
  expect(text("back")?.text).toStartWith(`${workspace}\nworktree ${workspace}`);
  expect(text("back")?.text).toContain(`worktree ${worktree}`);
  expect(text("again")?.text).toStartWith(
    "<tool_use_error>No-op: there is no active EnterWorktree session to exit.",
  );
  expect(text("reenter")).toMatchObject({
    text: `Entered worktree at “${worktree}” on branch “worktree-feature+x”. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
    isError: false,
  });
  expect(text("notmine")?.text).toStartWith(
    `<tool_use_error>This session is not the owner of the worktree at “${worktree}”`,
  );
  expect(text("leave")?.isError).toBe(false);
  expect(await Bun.file(join(worktree, "new.txt")).text()).toBe("hi\n");
});

test("ExitWorktree remove deletes a clean worktree and its branch", async () => {
  const script: ScriptedResponse[] = [
    use("init", "Bash", {
      command:
        "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
    }),
    use("search", "ToolSearch", {
      query: "select:EnterWorktree,ExitWorktree",
    }),
    use("enter", "EnterWorktree", { name: "tidy" }),
    use("remove", "ExitWorktree", { action: "remove" }),
    use("after", "Bash", {
      command: "pwd; git branch --list 'worktree-*'; ls .claude/worktrees",
    }),
  ];
  const provider = await startMockProvider(
    (_body, index) =>
      script[index] ?? turn({ type: "text", text: `done ${index}` }),
  );
  const run = await runCli({
    args: ["-p", "use a worktree", "--permission-mode", "bypassPermissions"],
    provider,
  });
  expect(run.exitCode).toBe(0);
  const last = bodySchema.parse(provider.requests.at(-1)?.body);
  const workspace = realpathSync(run.cwd);
  const worktree = join(workspace, ".claude", "worktrees", "tidy");
  expect(resultText(last, "remove")).toMatchObject({
    text: `Exited and removed worktree at “${worktree}”. Session is now back in “${workspace}”.`,
    isError: false,
  });
  expect(resultText(last, "after")?.text).toBe(workspace);
});
