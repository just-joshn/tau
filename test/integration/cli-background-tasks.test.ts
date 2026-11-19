import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider, turn } from "../helpers/mock-provider.js";
import { startPty, type PtySession } from "../helpers/pty.js";

setDefaultTimeout(30_000);

/** An empty input box at rest: no turn running and no dialog open. */
const IDLE = (screen: string) =>
  /\n❯\n─+\n {2}[⏸⏵]/.test(screen) && !screen.includes("esc to interrupt");

const AGENTS = {
  "agents/worker.md":
    "---\nname: worker\ndescription: Background worker\ntools: Read\n---\nWORKER_SYSTEM",
};
const ENV = {
  CLAUDE_CODE_FORK_SUBAGENT: "0",
  CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
};

const bodySchema = z.looseObject({
  system: z.unknown(),
  messages: z.array(z.looseObject({ content: z.unknown() })),
});
const toolResultSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

function toolResult(body: unknown, id: string) {
  for (const message of bodySchema.parse(body).messages)
    if (Array.isArray(message.content))
      for (const block of message.content) {
        const parsed = toolResultSchema.safeParse(block);
        if (parsed.success && parsed.data.tool_use_id === id)
          return parsed.data;
      }
  return undefined;
}

/** The background agent id from the Agent tool's launch result. */
function launchedId(body: unknown, id: string): string {
  const content = toolResult(body, id)?.content;
  const text = Array.isArray(content)
    ? z.object({ text: z.string() }).parse(content[0]).text
    : String(content);
  return z
    .object({ agentId: z.string() })
    .parse(JSON.parse(text.split("\n").at(-1) ?? "")).agentId;
}

const isWorker = (body: unknown) =>
  JSON.stringify(bodySchema.parse(body).system).includes("WORKER_SYSTEM");

const launch = {
  type: "tool_use" as const,
  id: "launch",
  name: "Agent",
  input: {
    description: "Background work",
    prompt: "work slowly",
    subagent_type: "worker",
    run_in_background: true,
  },
};

async function submit(tau: PtySession, line: string): Promise<void> {
  await tau.until(IDLE);
  tau.write(`${line}\r`);
}

describe("background agents in the REPL", () => {
  test("TaskStop under an ask rule asks at the terminal before stopping the agent", async () => {
    let parent = 0;
    const provider = await startMockProvider((body) => {
      if (isWorker(body)) return { kind: "hang" };
      parent++;
      if (parent === 1) return turn(launch);
      if (parent === 2)
        return turn({
          type: "tool_use",
          id: "stop",
          name: "TaskStop",
          input: { task_id: launchedId(body, "launch") },
        });
      return turn({ type: "text", text: "worker stopped" });
    });
    const tau = startPty({
      provider,
      env: ENV,
      configFiles: {
        ...AGENTS,
        "settings.json": JSON.stringify({ permissions: { ask: ["TaskStop"] } }),
      },
      args: ["--tools", "Agent,Read,TaskStop"],
    });
    await submit(tau, "start and stop a worker");
    const dialog = await tau.until("Do you want to proceed?");
    expect(dialog).toContain("   Stop this background task?");
    tau.write("1");
    await tau.until("⏺ worker stopped");
    await submit(tau, "/exit");
    expect((await tau.exited).exitCode).toBe(0);
    const stopped = provider.requests.findLast(
      ({ body }) => !isWorker(body),
    )?.body;
    expect(toolResult(stopped, "stop")?.is_error).toBeUndefined();
  });

  test("Ctrl-C while the turn waits for a background agent interrupts the wait", async () => {
    let parent = 0;
    const provider = await startMockProvider((body) => {
      if (isWorker(body)) return { kind: "hang" };
      parent++;
      return parent === 1
        ? turn(launch)
        : turn({ type: "text", text: "waiting on the worker" });
    });
    const tau = startPty({
      provider,
      env: ENV,
      configFiles: AGENTS,
      args: ["--tools", "Agent,Read"],
    });
    await submit(tau, "start a worker");
    await tau.until("⏺ waiting on the worker");
    tau.write("\x03");
    await tau.until("Interrupted · What should Claude do instead?");
    await submit(tau, "/exit");
    expect((await tau.exited).exitCode).toBe(0);
    expect(parent).toBe(2);
  });
});

describe("TaskStop", () => {
  test("an unknown task id is rejected and the model is told", async () => {
    const provider = await startMockProvider([
      {
        kind: "turn",
        content: [
          {
            type: "tool_use",
            id: "stop",
            name: "TaskStop",
            input: { task_id: "missing" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      },
    ]);
    const run = await runCli({
      provider,
      args: ["-p", "stop it", "--tools", "TaskStop"],
    });
    expect(run.exitCode).toBe(0);
    const rejected = toolResult(provider.requests[1]?.body, "stop");
    expect(rejected?.is_error).toBe(true);
    expect(String(rejected?.content)).toContain(
      "No task found with ID: missing",
    );
  });

  test("a subagent cannot stop a background agent it did not start; the parent can", async () => {
    const isStopper = (body: unknown) =>
      JSON.stringify(bodySchema.parse(body).system).includes("STOPPER_SYSTEM");
    let parent = 0,
      stopper = 0,
      workerId = "";
    const provider = await startMockProvider((body) => {
      if (isWorker(body)) return { kind: "hang" };
      if (isStopper(body))
        return ++stopper === 1
          ? turn({
              type: "tool_use",
              id: "child-stop",
              name: "TaskStop",
              input: { task_id: workerId },
            })
          : turn({ type: "text", text: "stopper done" });
      parent++;
      if (parent === 1) return turn(launch);
      if (parent === 2) {
        workerId = launchedId(body, "launch");
        return turn({
          type: "tool_use",
          id: "delegate",
          name: "Agent",
          input: {
            description: "Stop the worker",
            prompt: "stop it",
            subagent_type: "stopper",
            run_in_background: false,
          },
        });
      }
      if (parent === 3)
        return turn({
          type: "tool_use",
          id: "parent-stop",
          name: "TaskStop",
          input: { task_id: workerId },
        });
      return turn({ type: "text", text: "parent done" });
    });
    const run = await runCli({
      provider,
      env: ENV,
      files: {
        "../config/agents/worker.md": AGENTS["agents/worker.md"],
        "../config/agents/stopper.md":
          "---\nname: stopper\ndescription: Stops tasks\ntools: TaskStop\n---\nSTOPPER_SYSTEM",
      },
      args: ["-p", "go", "--tools", "Agent,Read,TaskStop"],
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("parent done");
    const refused = toolResult(
      provider.requests.findLast(({ body }) => isStopper(body))?.body,
      "child-stop",
    );
    expect(refused?.is_error).toBe(true);
    expect(String(refused?.content)).toContain(`can stop task ${workerId}`);
    const parentStop = toolResult(
      provider.requests.at(-1)?.body,
      "parent-stop",
    );
    expect(parentStop).toBeDefined();
    expect(parentStop?.is_error).toBeUndefined();
  });
});
