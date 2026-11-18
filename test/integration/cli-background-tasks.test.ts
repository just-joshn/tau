import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider } from "../helpers/mock-provider.js";
import { startPty, type PtySession } from "../helpers/pty.js";
import { startSseServer, turn } from "../helpers/sse-server.js";

setDefaultTimeout(30_000);

const PROMPT = "tau> ";

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

/** A worker request that is never answered; teardown closes its socket. */
function stall(): Promise<never> {
  return new Promise(() => {});
}

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
  await tau.expect(PROMPT);
  tau.write(`${line}\r`);
}

describe("background agents in the REPL", () => {
  test("TaskStop under an ask rule asks at the terminal before stopping the agent", async () => {
    let parent = 0;
    const provider = await startSseServer(async (body) => {
      if (isWorker(body)) return stall();
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
    await tau.expect("Stop this background task?\nAllow once? [y/N] ");
    tau.write("y\r");
    await tau.expect("worker stopped");
    await submit(tau, "/exit");
    expect((await tau.exited).exitCode).toBe(0);
    const stopped = provider.bodies.findLast((body) => !isWorker(body));
    expect(toolResult(stopped, "stop")?.is_error).toBeUndefined();
  });

  test("Ctrl-C while the turn waits for a background agent interrupts the wait", async () => {
    let parent = 0;
    const provider = await startSseServer(async (body) => {
      if (isWorker(body)) return stall();
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
    await tau.expect("waiting on the worker");
    tau.write("\x03");
    await tau.expect("tau: Interrupted");
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
});
