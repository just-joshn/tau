import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider, turn } from "../helpers/mock-provider.js";
import { startPty, type PtySession } from "../helpers/pty.js";

setDefaultTimeout(30_000);

const PROMPT = "tau> ";

const requestBody = z.looseObject({
  model: z.string(),
  system: z.unknown(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
});

function body(request: { body: unknown } | undefined) {
  return requestBody.parse(request?.body);
}

function said(text: string) {
  return {
    kind: "turn" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "end_turn" as const,
  };
}

/** Submits a line at the REPL prompt. */
async function submit(tau: PtySession, line: string): Promise<void> {
  await tau.expect(PROMPT);
  tau.write(`${line}\r`);
}

/** The id of the session the banner or a /clear or /resume line names. */
function sessionId(screen: string): string {
  const ids = [
    ...screen.matchAll(/(?:Session|New session|Resumed) ([0-9a-f-]{36})/g),
  ];
  const id = ids.at(-1)?.[1];
  if (id === undefined) throw new Error(`no session id in:\n${screen}`);
  return id;
}

async function until(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

async function exit(tau: PtySession): Promise<void> {
  await submit(tau, "/exit");
  expect(await tau.exited).toEqual({
    exitCode: 0,
    signal: null,
    timedOut: false,
  });
}

describe("interactive REPL", () => {
  test("banner names model, workspace, session and mode", async () => {
    const tau = startPty({
      env: { ANTHROPIC_API_KEY: "unused" },
      args: ["--model", "banner-model"],
    });
    const screen = await tau.expect(PROMPT);
    expect(screen).toContain(`tau · banner-model · ${tau.cwd}`);
    expect(screen).toMatch(/Session [0-9a-f-]{36} · permissions: default/);
    tau.write("/exit\r");
    expect((await tau.exited).exitCode).toBe(0);
  });

  test("blank lines send nothing and re-prompt", async () => {
    const provider = await startMockProvider([]);
    const tau = startPty({ provider });
    await submit(tau, "   ");
    await submit(tau, "");
    await exit(tau);
    expect(provider.requests).toHaveLength(0);
  });

  test("a line of text runs a turn and streams the reply to the terminal", async () => {
    const provider = await startMockProvider([said("streamed reply")]);
    const tau = startPty({ provider });
    await submit(tau, "hello there");
    const screen = await tau.expect("streamed reply");
    expect(screen.match(/streamed reply/g)).toHaveLength(1);
    await exit(tau);
    const sent = body(provider.requests[0]).messages.at(-1);
    expect(JSON.stringify(sent)).toContain("hello there");
    expect(provider.unexpected).toBe(0);
  });

  test("/model switches the model used by the next request and /model alone reports it", async () => {
    const provider = await startMockProvider([said("ok")]);
    const tau = startPty({ provider });
    await submit(tau, "/model other-model");
    await tau.expect("Model: other-model");
    await submit(tau, "/model");
    await tau.expect("Model: other-model");
    await submit(tau, "go");
    await tau.expect("ok");
    await exit(tau);
    expect(body(provider.requests[0]).model).toBe("other-model");
  });

  test("/permissions reports, rejects invalid modes and changes the mode the model is told", async () => {
    const provider = await startMockProvider([said("planned")]);
    const tau = startPty({ provider });
    await submit(tau, "/permissions");
    await tau.expect("Permissions: default");
    await submit(tau, "/permissions sideways");
    await tau.expect("Invalid permission mode");
    await submit(tau, "/permissions plan");
    await tau.expect("Permissions: plan");
    await submit(tau, "think");
    await tau.expect("planned");
    await exit(tau);
    expect(JSON.stringify(body(provider.requests[0]).system)).toContain(
      "Permission mode: plan.",
    );
  });

  test("/permissions bypassPermissions asks first and keeps the mode when declined", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await submit(tau, "/permissions bypassPermissions");
    await tau.expect(
      "Disable all approval prompts? Shell commands are NOT sandboxed.\nAllow once? [y/N] ",
    );
    tau.write("n\r");
    await submit(tau, "/permissions");
    await tau.expect("Permissions: default");
    await submit(tau, "/permissions bypassPermissions");
    await tau.expect("Allow once? [y/N] ");
    tau.write("yes\r");
    await tau.expect("Permissions: bypassPermissions");
    await exit(tau);
  });

  test("/status reports session, model, mode and accumulated usage", async () => {
    const provider = await startMockProvider([
      { ...said("counted"), usage: { input_tokens: 11, output_tokens: 7 } },
    ]);
    const tau = startPty({ provider, args: ["--model", "status-model"] });
    const banner = await tau.expect(PROMPT);
    const sessionId = /Session ([0-9a-f-]{36})/.exec(banner)?.[1];
    tau.write("count\r");
    await tau.expect("counted");
    await submit(tau, "/status");
    const screen = await tau.expect(/"usage": \{[^}]*\}/);
    const status = z
      .looseObject({
        session_id: z.string(),
        model: z.string(),
        permissions: z.string(),
        messages: z.number(),
        usage: z.object({
          input_tokens: z.number(),
          output_tokens: z.number(),
        }),
      })
      .parse(
        JSON.parse(
          /\{\n[\s\S]*\n\}/.exec(
            screen.slice(screen.lastIndexOf("/status")),
          )?.[0] ?? "",
        ),
      );
    expect(status).toMatchObject({
      session_id: sessionId,
      model: "status-model",
      permissions: "default",
      messages: 2,
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    await exit(tau);
  });

  test("/save writes the session file and /quit ends the session", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    const banner = await tau.expect(PROMPT);
    const sessionId = /Session ([0-9a-f-]{36})/.exec(banner)?.[1] ?? "";
    tau.write("/save\r");
    await tau.expect(`Saved ${sessionId}`);
    const [partition] = readdirSync(join(tau.state, "sessions"));
    expect(
      existsSync(
        join(tau.state, "sessions", partition ?? "", `${sessionId}.json`),
      ),
    ).toBe(true);
    await submit(tau, "/quit");
    expect((await tau.exited).exitCode).toBe(0);
  });
});

describe("session commands", () => {
  test("/clear starts a new session whose requests omit the earlier history", async () => {
    const provider = await startMockProvider([
      said("first answer"),
      said("second answer"),
    ]);
    const tau = startPty({ provider });
    const before = sessionId(await tau.expect(PROMPT));
    tau.write("remember apples\r");
    await tau.expect("first answer");
    await submit(tau, "/clear");
    const after = sessionId(await tau.expect(/New session [0-9a-f-]{36}/));
    expect(after).not.toBe(before);
    await submit(tau, "what fruit?");
    await tau.expect("second answer");
    await exit(tau);
    const second = JSON.stringify(body(provider.requests[1]).messages);
    expect(second).toContain("what fruit?");
    expect(second).not.toContain("remember apples");
  });

  test("/resume reloads an earlier session's history and rejects unknown ids", async () => {
    const provider = await startMockProvider([said("noted"), said("recalled")]);
    const tau = startPty({ provider });
    const original = sessionId(await tau.expect(PROMPT));
    tau.write("remember pears\r");
    await tau.expect("noted");
    await submit(tau, "/clear");
    await tau.expect("New session");
    await submit(tau, "/resume 00000000-0000-4000-8000-000000000000");
    await tau.expect(/tau: .+/);
    await submit(tau, `/resume ${original}`);
    await tau.expect(`Resumed ${original}`);
    await submit(tau, "what fruit?");
    await tau.expect("recalled");
    await exit(tau);
    const resumed = JSON.stringify(body(provider.requests[1]).messages);
    expect(resumed).toContain("remember pears");
    expect(resumed).toContain("what fruit?");
  });

  test("a prompt given on the command line runs before the first REPL prompt", async () => {
    const provider = await startMockProvider([said("answered at launch")]);
    const tau = startPty({ provider, args: ["launch question"] });
    const screen = await tau.expect("answered at launch");
    expect(screen).not.toContain(PROMPT);
    await exit(tau);
    expect(JSON.stringify(body(provider.requests[0]).messages)).toContain(
      "launch question",
    );
  });
});

describe("skills", () => {
  test("/skills says when there are none", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await submit(tau, "/skills");
    await tau.expect("No local skills available.");
    await exit(tau);
  });

  test("/skills lists user skills and /NAME args runs the skill as a turn", async () => {
    const provider = await startMockProvider([said("skill ran")]);
    const tau = startPty({
      provider,
      configFiles: {
        "skills/greet/SKILL.md":
          "---\ndescription: Greets someone warmly\n---\nGreet $ARGUMENTS with enthusiasm.\n",
      },
    });
    await submit(tau, "/skills");
    await tau.expect("/greet Greets someone warmly");
    await submit(tau, "/greet Ada");
    await tau.expect("skill ran");
    await exit(tau);
    expect(JSON.stringify(body(provider.requests[0]).messages)).toContain(
      "Greet Ada with enthusiasm.",
    );
  });
});

describe("tool approval prompts", () => {
  const bash = (command: string) => ({
    kind: "turn" as const,
    content: [
      {
        type: "tool_use" as const,
        id: "toolu_1",
        name: "Bash",
        input: { command },
      },
    ],
    stopReason: "tool_use" as const,
  });

  test("answering y runs the tool", async () => {
    const provider = await startMockProvider([
      bash("echo approved > note.txt"),
      said("wrote it"),
    ]);
    const tau = startPty({ provider });
    await submit(tau, "write a note");
    await tau.expect("Allow once? [y/N] ");
    tau.write("y\r");
    await tau.expect("wrote it");
    await exit(tau);
    expect(await Bun.file(join(tau.cwd, "note.txt")).text()).toBe("approved\n");
  });

  test("answering anything else denies the tool and the model sees the denial", async () => {
    const provider = await startMockProvider([
      bash("echo nope > note.txt"),
      said("understood"),
    ]);
    const tau = startPty({ provider });
    await submit(tau, "write a note");
    await tau.expect("Allow once? [y/N] ");
    tau.write("\r");
    await tau.expect("[tool error] Permission denied");
    await tau.expect("understood");
    await exit(tau);
    expect(existsSync(join(tau.cwd, "note.txt"))).toBe(false);
    expect(JSON.stringify(body(provider.requests[1]).messages)).toContain(
      "Permission denied",
    );
  });
});

describe("/compact", () => {
  test("the summary request says no tools are available when --tools is empty", async () => {
    const provider = await startMockProvider([
      said("answer"),
      said("<summary>Short.</summary>"),
    ]);
    const tau = startPty({ provider, args: ["--tools", ""] });
    await submit(tau, "a question");
    await tau.expect("answer");
    await submit(tau, "/compact");
    await tau.expect("Conversation context compacted.");
    await exit(tau);
    expect(JSON.stringify(body(provider.requests[1]).system)).toContain(
      "Available tools for this session: none.",
    );
  });

  test("an empty conversation is preserved without a request", async () => {
    const provider = await startMockProvider([]);
    const tau = startPty({ provider });
    await submit(tau, "/compact");
    await tau.expect(
      "Conversation context was preserved; compaction did not complete.",
    );
    await exit(tau);
    expect(provider.requests).toHaveLength(0);
  });

  test("summarises the conversation with the configured output limit", async () => {
    const provider = await startMockProvider([
      said("long answer"),
      said("<summary>The user asked a question.</summary>"),
      said("continuing"),
    ]);
    const tau = startPty({
      provider,
      args: ["--max-tokens", "1500", "--max-api-attempts", "3"],
    });
    await submit(tau, "a question");
    await tau.expect("long answer");
    await submit(tau, "/compact");
    await tau.expect("Compacting conversation context...");
    await tau.expect("Conversation context compacted.");
    await submit(tau, "next");
    await tau.expect("continuing");
    await exit(tau);
    const summary = z
      .looseObject({ max_tokens: z.number() })
      .parse(provider.requests[1]?.body);
    expect(summary.max_tokens).toBe(1500);
    const after = JSON.stringify(body(provider.requests[2]).messages);
    expect(after).toContain("The user asked a question.");
    expect(after).not.toContain("long answer");
  });

  test("a summary that exhausts --max-api-attempts is reported and the conversation is kept", async () => {
    const provider = await startMockProvider([
      said("original answer"),
      {
        kind: "error",
        status: 400,
        body: {
          type: "error",
          error: { type: "invalid_request_error", message: "summary refused" },
        },
      },
      said("still here"),
    ]);
    const tau = startPty({
      provider,
      args: ["--max-retries", "0", "--max-api-attempts", "1"],
    });
    await submit(tau, "a question");
    await tau.expect("original answer");
    await submit(tau, "/compact");
    const screen = await tau.expect("tau: API attempt budget exhausted");
    expect(screen).not.toContain("Conversation context compacted.");
    await submit(tau, "next");
    await tau.expect("still here");
    await exit(tau);
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(body(provider.requests[2]).messages)).toContain(
      "original answer",
    );
  });

  test("Ctrl-C interrupts compaction", async () => {
    const provider = await startMockProvider([
      said("answer"),
      { kind: "hang" },
    ]);
    const tau = startPty({ provider });
    await submit(tau, "a question");
    await tau.expect("answer");
    await submit(tau, "/compact");
    await until(() => provider.requests.length === 2);
    tau.write("\x03");
    await tau.expect("tau: Interrupted");
    await exit(tau);
  });
});

const tooLong = {
  kind: "error" as const,
  status: 400,
  body: {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 210000 tokens > 200000",
    },
  },
};

describe("turn display", () => {
  test("a retried stream erases its abandoned text from the screen", async () => {
    const provider = await startMockProvider([
      {
        kind: "truncate",
        events: 2,
        content: [{ type: "text", text: "abandoned draft" }],
      },
      turn({ type: "text", text: "final answer" }),
    ]);
    const tau = startPty({ provider });
    await submit(tau, "question");
    await tau.expect("final answer");
    await tau.expect(PROMPT);
    expect(tau.text()).toContain("abandoned draft");
    expect(tau.screen()).not.toContain("abandoned draft");
    expect(tau.screen()).toContain("final answer");
    tau.write("/exit\r");
    expect((await tau.exited).exitCode).toBe(0);
    expect(provider.requests.length).toBe(2);
  });

  test("a context rejection compacts the conversation and reports the token change", async () => {
    const provider = await startMockProvider([
      said("original answer"),
      tooLong,
      said("<summary>Earlier facts</summary>"),
      said("done after compaction"),
    ]);
    const tau = startPty({ provider, env: { CLAUDE_CODE_MAX_RETRIES: "0" } });
    await submit(tau, "first");
    await tau.expect("original answer");
    await submit(tau, "second");
    await tau.expect("Compacting conversation context...");
    await tau.expect(/Context compacted \(\d+ → \d+ estimated tokens\)\./);
    await tau.expect("done after compaction");
    await exit(tau);
    expect(JSON.stringify(body(provider.requests[3]).messages)).toContain(
      "Earlier facts",
    );
  });

  test("a failed reactive compaction says the original conversation was kept", async () => {
    const provider = await startMockProvider([
      said("original answer"),
      tooLong,
      tooLong,
    ]);
    const tau = startPty({ provider, env: { CLAUDE_CODE_MAX_RETRIES: "0" } });
    await submit(tau, "first");
    await tau.expect("original answer");
    await submit(tau, "second");
    await tau.expect(
      "Context compaction failed; original conversation preserved.",
    );
    await tau.expect(/tau: [^\n]+/);
    await exit(tau);
  });
});

describe("session persistence", () => {
  test.skipIf(process.getuid?.() === 0)(
    "a turn whose session cannot be saved reports the save failure after any turn error",
    async () => {
      const provider = await startMockProvider([
        said("unsaved answer"),
        {
          kind: "error",
          status: 400,
          body: {
            type: "error",
            error: { type: "invalid_request_error", message: "bad turn" },
          },
        },
      ]);
      const tau = startPty({ provider, args: ["--max-retries", "0"] });
      await tau.expect(PROMPT);
      const sessions = join(tau.state, "sessions");
      const [partition] = readdirSync(sessions);
      const directory = join(sessions, partition ?? "");
      chmodSync(directory, 0o500);
      tau.write("question\r");
      await tau.expect("unsaved answer");
      await tau.expect(/\ntau: Session save failed: [^\n]+/);
      await submit(tau, "again");
      await tau.expect(/\ntau: [^\n]+; Session save failed: [^\n]+/);
      chmodSync(directory, 0o700);
      await exit(tau);
    },
  );

  test("resuming a session that was planning restores plan mode", async () => {
    const provider = await startMockProvider([said("planned")]);
    const tau = startPty({ provider, args: ["--permission-mode", "plan"] });
    const planning = sessionId(await tau.expect(PROMPT));
    tau.write("make a plan\r");
    await tau.expect("planned");
    await submit(tau, "/clear");
    await tau.expect("New session");
    await submit(tau, "/permissions default");
    await tau.expect("Permissions: default");
    await submit(tau, `/resume ${planning}`);
    await tau.expect(`Resumed ${planning}`);
    await submit(tau, "/permissions");
    await tau.expect("Permissions: plan");
    await submit(tau, "/permissions acceptEdits");
    await tau.expect("Permissions: acceptEdits");
    await submit(tau, "/clear");
    await tau.expect("New session");
    await submit(tau, `/resume ${planning}`);
    await tau.expect(`Resumed ${planning}`);
    await submit(tau, "/permissions");
    await tau.expect("Permissions: acceptEdits");
    await exit(tau);
  });
});

describe("workspace trust", () => {
  const settings = {
    ".claude/settings.json": JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('hook-ran.txt','ran')",
                ],
              },
            ],
          },
        ],
      },
    }),
  };

  test("project hooks run in print mode but not in an untrusted interactive workspace", async () => {
    const provider = await startMockProvider([said("printed")]);
    const printed = await runCli({
      provider,
      files: settings,
      args: ["-p", "hello"],
    });
    expect(printed.exitCode).toBe(0);
    expect(existsSync(join(printed.cwd, "hook-ran.txt"))).toBe(true);

    const tau = startPty({
      provider: await startMockProvider([said("typed")]),
      files: settings,
    });
    await submit(tau, "hello");
    await tau.expect("typed");
    await exit(tau);
    expect(existsSync(join(tau.cwd, "hook-ran.txt"))).toBe(false);
  });
});

describe("approvals that start outside a turn", () => {
  const project = {
    ".mcp.json": JSON.stringify({
      mcpServers: {
        marker: {
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync('server-started.txt','yes')",
          ],
        },
      },
    }),
  };

  test("a declined project MCP server is never started", async () => {
    const tau = startPty({
      env: { ANTHROPIC_API_KEY: "unused" },
      files: project,
    });
    await tau.expect(
      `Connect project MCP server marker from ${join(tau.cwd, ".mcp.json")}?\nAllow once? [y/N] `,
    );
    tau.write("n\r");
    await exit(tau);
    expect(existsSync(join(tau.cwd, "server-started.txt"))).toBe(false);
  });

  test("an approved project MCP server is started", async () => {
    const tau = startPty({
      env: { ANTHROPIC_API_KEY: "unused" },
      files: project,
    });
    await tau.expect("Allow once? [y/N] ");
    tau.write("y\r");
    await exit(tau);
    expect(existsSync(join(tau.cwd, "server-started.txt"))).toBe(true);
  });

  test("a subagent leaving plan mode asks at the terminal", async () => {
    const provider = await startMockProvider([
      {
        kind: "turn",
        content: [
          {
            type: "tool_use",
            id: "agent-1",
            name: "Agent",
            input: {
              description: "Plan it",
              prompt: "make a plan",
              subagent_type: "planner",
              run_in_background: false,
            },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "turn",
        content: [
          {
            type: "tool_use",
            id: "child-exit",
            name: "ExitPlanMode",
            input: { plan: "# Child plan" },
          },
        ],
        stopReason: "tool_use",
      },
      said("child done"),
      said("parent done"),
    ]);
    const tau = startPty({
      provider,
      env: {
        CLAUDE_CODE_FORK_SUBAGENT: "0",
        CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
      },
      configFiles: {
        "agents/planner.md":
          "---\nname: planner\ndescription: Plans work\ntools: ExitPlanMode, Read\npermissionMode: plan\n---\nPLANNER_SYSTEM",
      },
      args: ["--tools", "Agent,ExitPlanMode,Read"],
    });
    await submit(tau, "delegate");
    await tau.expect(
      /Approve ExitPlanMode for planner\?\nAllow once\? \[y\/N\] /,
    );
    tau.write("y\r");
    await tau.expect("parent done");
    await exit(tau);
    expect(JSON.stringify(body(provider.requests[2]).messages)).toContain(
      "Plan approval completed for this agent.",
    );
  });
});

describe("subagent plan text", () => {
  test("the approval prompt shows the plan the subagent wrote", async () => {
    const system = (body: unknown) =>
      JSON.stringify(z.looseObject({ system: z.unknown() }).parse(body).system);
    let child = 0;
    const provider = await startMockProvider((received) => {
      if (!system(received).includes("PLANNER_SYSTEM"))
        return child === 0
          ? turn({
              type: "tool_use",
              id: "agent-1",
              name: "Agent",
              input: {
                description: "Plan it",
                prompt: "make a plan",
                subagent_type: "planner",
                run_in_background: false,
              },
            })
          : turn({ type: "text", text: "parent done" });
      child++;
      const planFile = /Agent plan file: ([^\s"\\]+)/.exec(
        JSON.stringify(received),
      )?.[1];
      if (child === 1)
        return turn({
          type: "tool_use",
          id: "write-plan",
          name: "Write",
          input: { file_path: planFile, content: "# Child plan\n- step one\n" },
        });
      if (child === 2)
        return turn({
          type: "tool_use",
          id: "child-exit",
          name: "ExitPlanMode",
          input: {},
        });
      return turn({ type: "text", text: "child done" });
    });
    const tau = startPty({
      provider,
      env: {
        CLAUDE_CODE_FORK_SUBAGENT: "0",
        CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
      },
      configFiles: {
        "agents/planner.md":
          "---\nname: planner\ndescription: Plans work\ntools: ExitPlanMode, Write, Read\npermissionMode: plan\n---\nPLANNER_SYSTEM",
      },
      args: ["--tools", "Agent,ExitPlanMode,Write,Read"],
    });
    await submit(tau, "delegate");
    await tau.expect(
      "Plan:\n# Child plan\n- step one\n\n\nApprove ExitPlanMode for planner?\nAllow once? [y/N] ",
    );
    tau.write("y\r");
    await tau.expect("parent done");
    await exit(tau);
  });
});
