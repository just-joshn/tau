import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider, turn } from "../helpers/mock-provider.js";
import { startPty, type PtySession } from "../helpers/pty.js";

setDefaultTimeout(30_000);

/** An empty input box at rest: no turn running and no dialog open. */
const IDLE = (screen: string) =>
  /\n❯\n─+\n {2}[⏸⏵]/.test(screen) && !screen.includes("esc to interrupt");

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

/** Waits for an idle prompt, then types a line and Enter. */
async function submit(tau: PtySession, line: string): Promise<void> {
  await tau.until(IDLE);
  tau.write(`${line}\r`);
}

/** The session id the Status pane shows; closes the pane again. */
async function sessionId(tau: PtySession): Promise<string> {
  await submit(tau, "/status");
  const screen = await tau.until(/Session ID: +[0-9a-f-]{36}/);
  tau.write("\x1b");
  const id = /Session ID: +([0-9a-f-]{36})/.exec(screen)?.[1];
  if (id === undefined) throw new Error(`no session id in:\n${screen}`);
  await tau.until(IDLE);
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

describe("interactive screen", () => {
  test("the welcome header names product, model, billing and workspace", async () => {
    const tau = startPty({
      env: { ANTHROPIC_API_KEY: "unused" },
      args: ["--model", "claude-sonnet-4-5-20250929"],
    });
    // The first frame, read from the output stream: later startup notices
    // may scroll the header off the screen.
    await tau.expect(
      ` ▐▛███▛█   tau v0.1.0▝▜██████▀  Sonnet 4.5 · API Usage Billing ▝▝   ▝▝   ${tau.cwd.slice(0, 40)}`,
    );
    const screen = await tau.until(IDLE);
    expect(screen).toContain("  ⏸ manual mode on · ? for shortcuts");
    tau.write("/exit\r");
    expect((await tau.exited).exitCode).toBe(0);
  });

  test("blank lines send nothing", async () => {
    const provider = await startMockProvider([]);
    const tau = startPty({ provider });
    await submit(tau, "   ");
    await submit(tau, "");
    await exit(tau);
    expect(provider.requests).toHaveLength(0);
  });

  test("a line of text runs a turn and shows the prompt, reply and completion", async () => {
    const provider = await startMockProvider([said("streamed reply")]);
    const tau = startPty({ provider });
    await submit(tau, "hello there");
    const screen = await tau.until(/^✻ \S+ for \d+s · done /m);
    expect(screen).toContain("❯ hello there");
    expect(screen.match(/⏺ streamed reply/g)).toHaveLength(1);
    await exit(tau);
    const sent = body(provider.requests[0]).messages.at(-1);
    expect(JSON.stringify(sent)).toContain("hello there");
    expect(provider.unexpected).toBe(0);
  });

  test("/model NAME switches the next request's model; /model alone opens the picker", async () => {
    const provider = await startMockProvider([said("ok")]);
    const tau = startPty({ provider });
    await submit(tau, "/model other-model");
    await tau.until("Set model to other-model");
    await submit(tau, "/model");
    const picker = await tau.until("Select model");
    expect(picker).toMatch(/❯ \d\. other-model ✔ +other-model/);
    expect(picker).toContain("2. Opus                   Opus 5.5");
    tau.write("\x1b");
    await tau.until("Kept model as other-model");
    await submit(tau, "go");
    await tau.until("⏺ ok");
    await exit(tau);
    expect(body(provider.requests[0]).model).toBe("other-model");
  });

  test("the picker sets the highlighted model", async () => {
    const provider = await startMockProvider([said("ok")]);
    const tau = startPty({ provider });
    await submit(tau, "/model");
    await tau.until("Select model");
    tau.write("4");
    await tau.until("Set model to Sonnet 5.5");
    await submit(tau, "go");
    await tau.until("⏺ ok");
    await exit(tau);
    expect(body(provider.requests[0]).model).toBe("claude-sonnet-5-5");
  });

  test("/permissions reports, rejects invalid modes and changes the mode line", async () => {
    const provider = await startMockProvider([said("planned")]);
    const tau = startPty({ provider });
    await submit(tau, "/permissions");
    await tau.until("Permissions: default");
    await submit(tau, "/permissions sideways");
    await tau.until("Invalid permission mode");
    await submit(tau, "/permissions plan");
    await tau.until("Permissions: plan");
    await tau.until("⏸ plan mode on (shift+tab to cycle)");
    await submit(tau, "think");
    await tau.until("⏺ planned");
    await exit(tau);
  });

  test("shift+tab cycles manual → accept edits → plan → manual", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await tau.until(IDLE);
    tau.write("\x1b[Z");
    await tau.until("⏵⏵ accept edits on (shift+tab to cycle)");
    tau.write("\x1b[Z");
    await tau.until("⏸ plan mode on (shift+tab to cycle)");
    tau.write("\x1b[Z");
    await tau.until("⏸ manual mode on · ? for shortcuts");
    tau.write("\x1b[Z");
    await submit(tau, "/permissions");
    await tau.until("Permissions: acceptEdits");
    await exit(tau);
  });

  test("/permissions bypassPermissions asks first and keeps the mode when declined", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await submit(tau, "/permissions bypassPermissions");
    const dialog = await tau.until("Do you want to proceed?");
    expect(dialog).toContain(
      "   Disable all approval prompts? Shell commands are NOT sandboxed.",
    );
    tau.write("2");
    await submit(tau, "/permissions");
    await tau.until("Permissions: default");
    await submit(tau, "/permissions bypassPermissions");
    await tau.until("Do you want to proceed?");
    tau.write("1");
    await tau.until("Permissions: bypassPermissions");
    await tau.until("⏵⏵ bypass permissions on");
    await exit(tau);
  });

  test("/status shows the session and model; its Usage tab the accumulated tokens", async () => {
    const provider = await startMockProvider([
      { ...said("counted"), usage: { input_tokens: 11, output_tokens: 7 } },
    ]);
    const tau = startPty({ provider, args: ["--model", "status-model"] });
    await submit(tau, "count");
    await tau.until("⏺ counted");
    await submit(tau, "/status");
    const status = await tau.until("Settings");
    expect(status).toMatch(/\n {3}Session ID: +[0-9a-f-]{36}\n/);
    expect(status).toMatch(/\n {3}Model: +status-model\n/);
    expect(status).toMatch(/\n {3}Session kind: +interactive\n/);
    tau.write("\t");
    const usage = await tau.until("Input tokens:");
    expect(usage).toMatch(/Messages: +2\n/);
    expect(usage).toMatch(/Input tokens: +11\n/);
    expect(usage).toMatch(/Output tokens: +7\n/);
    tau.write("\x1b");
    await exit(tau);
  });

  test("/save writes the session file and /quit ends the session", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    const id = await sessionId(tau);
    await submit(tau, "/save");
    await tau.until(`Saved ${id}`);
    const [partition] = readdirSync(join(tau.state, "sessions"));
    expect(
      existsSync(join(tau.state, "sessions", partition ?? "", `${id}.json`)),
    ).toBe(true);
    await submit(tau, "/quit");
    expect((await tau.exited).exitCode).toBe(0);
  });

  test("leaving prints the command that resumes the session", async () => {
    const provider = await startMockProvider([said("noted")]);
    const tau = startPty({ provider });
    await submit(tau, "remember this");
    await tau.until("⏺ noted");
    const id = await sessionId(tau);
    await submit(tau, "/exit");
    expect((await tau.exited).exitCode).toBe(0);
    expect(tau.screen()).toMatch(
      new RegExp(
        `(Goodbye!|See ya!|Bye!|Catch you later!)\\n\\nResume this session with:\\ntau --resume ${id}\\n*$`,
      ),
    );
  });
});

describe("session commands", () => {
  test("/clear starts a new session whose requests omit the earlier history", async () => {
    const provider = await startMockProvider([
      said("first answer"),
      said("second answer"),
    ]);
    const tau = startPty({ provider });
    const before = await sessionId(tau);
    await submit(tau, "remember apples");
    await tau.until("⏺ first answer");
    await submit(tau, "/clear");
    const cleared = await tau.until(/New session [0-9a-f-]{36}/);
    expect(cleared).not.toContain("remember apples");
    expect(await sessionId(tau)).not.toBe(before);
    await submit(tau, "what fruit?");
    await tau.until("⏺ second answer");
    await exit(tau);
    const second = JSON.stringify(body(provider.requests[1]).messages);
    expect(second).toContain("what fruit?");
    expect(second).not.toContain("remember apples");
  });

  test("/resume reloads an earlier session's history and rejects unknown ids", async () => {
    const provider = await startMockProvider([said("noted"), said("recalled")]);
    const tau = startPty({ provider });
    const original = await sessionId(tau);
    await submit(tau, "remember pears");
    await tau.until("⏺ noted");
    await submit(tau, "/clear");
    await tau.until("New session");
    await submit(tau, "/resume 00000000-0000-4000-8000-000000000000");
    await tau.until(
      /\/resume 00000000-0000-4000-8000-000000000000\n {2}⎿\s+\S/,
    );
    await submit(tau, `/resume ${original}`);
    await tau.until(`Resumed ${original}`);
    await submit(tau, "what fruit?");
    await tau.until("⏺ recalled");
    await exit(tau);
    const resumed = JSON.stringify(body(provider.requests[1]).messages);
    expect(resumed).toContain("remember pears");
    expect(resumed).toContain("what fruit?");
  });

  test("a prompt given on the command line runs as the first turn", async () => {
    const provider = await startMockProvider([said("answered at launch")]);
    const tau = startPty({ provider, args: ["launch question"] });
    const screen = await tau.until("⏺ answered at launch");
    expect(screen).toContain("❯ launch question");
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
    await tau.until("No local skills available.");
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
    await tau.until("/greet Greets someone warmly");
    await submit(tau, "/greet Ada");
    await tau.until("⏺ skill ran");
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

  test("1 (Yes) in the permission dialog runs the tool", async () => {
    const provider = await startMockProvider([
      bash("echo approved > note.txt"),
      said("wrote it"),
    ]);
    const tau = startPty({ provider });
    await submit(tau, "write a note");
    const dialog = await tau.until("Esc to cancel");
    expect(dialog).toContain("\n Bash command\n");
    expect(dialog).toContain(
      "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend",
    );
    tau.write("1");
    const done = await tau.until("⏺ wrote it");
    expect(done).toContain("⏺ Bash(echo approved > note.txt)");
    await exit(tau);
    expect(await Bun.file(join(tau.cwd, "note.txt")).text()).toBe("approved\n");
  });

  test("Esc refuses, ends the turn, and the model sees the original's refusal", async () => {
    const provider = await startMockProvider([
      bash("echo nope > note.txt"),
      said("understood"),
    ]);
    const tau = startPty({ provider });
    await submit(tau, "write a note");
    await tau.until("Esc to cancel");
    tau.write("\x1b");
    const refused = await tau.until(IDLE);
    expect(refused).toMatch(
      /⏺ Bash\(echo nope > note\.txt\)\n {2}⎿\s+Rejected/,
    );
    expect(refused).not.toContain("Interrupted");
    expect(provider.requests).toHaveLength(1);
    await submit(tau, "why?");
    await tau.until("⏺ understood");
    await exit(tau);
    expect(existsSync(join(tau.cwd, "note.txt"))).toBe(false);
    expect(JSON.stringify(body(provider.requests[1]).messages)).toContain(
      "The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    );
  });
});

describe("file edit permission dialog", () => {
  const tool = (name: string, input: Record<string, unknown>, id: string) =>
    turn({ type: "tool_use", id, name, input });
  /** Read then Edit a.txt for each step, each ending its own turn. */
  const edits = (...steps: [string, string][]) =>
    steps.flatMap(([from, to], index) => [
      tool("Read", { file_path: "a.txt" }, `read_${index}`),
      tool(
        "Edit",
        { file_path: "a.txt", old_string: from, new_string: to },
        `edit_${index}`,
      ),
      said(`edited ${index}`),
    ]);
  const OPTIONS = [
    " Do you want to make this edit to a.txt?",
    " ❯ 1. Yes",
    "   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this",
    "      session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  const contents = (tau: PtySession) => Bun.file(join(tau.cwd, "a.txt")).text();

  test("shows the original's header, diff, question and options; Yes applies once", async () => {
    const provider = await startMockProvider(
      edits(["alpha", "beta"], ["beta", "gamma"]),
    );
    const tau = startPty({ provider, files: { "a.txt": "alpha\n" } });
    await submit(tau, "first");
    const dialog = await tau.until(OPTIONS);
    expect(dialog).toMatch(
      /\n {2}Read 1 file\n\n⏺ Update\(a\.txt\)\n\n─{100}\n Edit file\n a\.txt\n╌{100}\n 1 -alpha\n 1 \+beta\n╌{100}\n/,
    );
    tau.write("1");
    const applied = await tau.until("⏺ edited 0");
    expect(applied).toContain(
      "⏺ Update(a.txt)\n  ⎿ \u00a0Added 1 line, removed 1 line\n      1 -alpha\n      1 +beta",
    );
    expect(await contents(tau)).toBe("beta\n");
    await submit(tau, "second");
    await tau.until(" 1 -beta\n 1 +gamma");
    tau.write("\r");
    await tau.until("⏺ edited 1");
    await exit(tau);
    expect(await contents(tau)).toBe("gamma\n");
  });

  test("Yes, and switch to accept edits stops asking for the session", async () => {
    const provider = await startMockProvider(
      edits(["alpha", "beta"], ["beta", "gamma"]),
    );
    const tau = startPty({ provider, files: { "a.txt": "alpha\n" } });
    await submit(tau, "first");
    await tau.until(OPTIONS);
    tau.write("2");
    await tau.until("⏵⏵ accept edits on (shift+tab to cycle)");
    await tau.until("⏺ edited 0");
    await submit(tau, "second");
    const screen = await tau.until("⏺ edited 1");
    expect(screen).not.toContain("Do you want to make this edit");
    await submit(tau, "/permissions");
    await tau.until("Permissions: acceptEdits");
    await exit(tau);
    expect(await contents(tau)).toBe("gamma\n");
  });

  test("Tab sends feedback with the refusal and the turn continues", async () => {
    const provider = await startMockProvider([
      ...edits(["alpha", "beta"]).slice(0, 2),
      said("will use gamma"),
    ]);
    const tau = startPty({ provider, files: { "a.txt": "alpha\n" } });
    await submit(tau, "first");
    await tau.until(OPTIONS);
    tau.write("\t");
    await tau.until("   3. No, and tell Claude what to do differently");
    tau.write("use gamma\r");
    const screen = await tau.until("⏺ will use gamma");
    expect(screen).toContain("⎿ \u00a0Rejected update to a.txt");
    await exit(tau);
    expect(await contents(tau)).toBe("alpha\n");
    expect(JSON.stringify(body(provider.requests[2]).messages)).toContain(
      "NOT written to the file). To tell you how to proceed, the user said:\\nuse gamma",
    );
  });
});

describe("slash commands", () => {
  test("typing / suggests commands above the input box", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await tau.until(IDLE);
    tau.write("/he");
    const screen = await tau.until("❯ /help");
    expect(screen).toMatch(
      /\n {2}❯ \/help +Show help and available commands\n/,
    );
    expect(screen).toMatch(/\n─{100}\n❯\u00a0\/he\n─{100}\n/);
    tau.write("\x15");
    await exit(tau);
  });

  test("/help opens the tabbed help with the built-in registry", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await submit(tau, "/help");
    const general = await tau.until("Shortcuts");
    expect(general).toContain(
      "   Help  General   Commands   Custom commands\n",
    );
    expect(general).toContain(
      "   Claude understands your codebase, makes edits with your permission, and runs commands — right\n   from your terminal.",
    );
    expect(general).toContain("shift+tab to cycle modes");
    tau.write("\x1b[C");
    const commands = await tau.until("Browse default commands:");
    for (const line of [
      "   /clear                      Start a new session with empty context;",
      "   /compact                    Free up context by summarizing the conversation so far",
      "   /exit                       Exit the CLI",
      "   /help                       Show help and available commands",
      "   /resume                     Resume a previous session",
    ])
      expect(commands).toContain(line);
    tau.write("\x1b[C");
    await tau.until("No custom commands yet");
    tau.write("\x1b");
    await submit(tau, "/reset");
    await tau.until(/New session [0-9a-f-]{36}/);
    await submit(tau, "/nope");
    await tau.until("Unknown command: /nope");
    await submit(tau, "/exit");
    expect((await tau.exited).exitCode).toBe(0);
    expect(tau.screen()).toMatch(/Goodbye!|See ya!|Bye!|Catch you later!/);
  });

  test("Ctrl-C at the prompt asks for a second press before exiting", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await tau.until(IDLE);
    tau.write("draft");
    await tau.until("❯\u00a0draft");
    tau.write("\x03");
    // Like the original, the first press clears the typed input.
    const armed = await tau.until("Press Ctrl-C again to exit");
    expect(armed).toMatch(/\n❯\n─{100}\n {2}Press Ctrl-C again to exit$/);
    await tau.until("? for shortcuts");
    tau.write("\x03");
    await tau.until("Press Ctrl-C again to exit");
    tau.write("\x03");
    expect((await tau.exited).exitCode).toBe(0);
  });
});

describe("/compact", () => {
  test("the summary request carries no tools when --tools is empty", async () => {
    const provider = await startMockProvider([
      said("answer"),
      said("<summary>Short.</summary>"),
    ]);
    const tau = startPty({ provider, args: ["--tools", ""] });
    await submit(tau, "a question");
    await tau.until("⏺ answer");
    await submit(tau, "/compact");
    await tau.until("Conversation context compacted.");
    await exit(tau);
    expect(body(provider.requests[1]).tools ?? []).toEqual([]);
  });

  test("an empty conversation is preserved without a request", async () => {
    const provider = await startMockProvider([]);
    const tau = startPty({ provider });
    await submit(tau, "/compact");
    await tau.until(
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
    await tau.until("⏺ long answer");
    await submit(tau, "/compact");
    await tau.until("Conversation context compacted.");
    await submit(tau, "next");
    await tau.until("⏺ continuing");
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
    await tau.until("⏺ original answer");
    await submit(tau, "/compact");
    const screen = await tau.until("API attempt budget exhausted");
    expect(screen).toMatch(/❯ \/compact\n {2}⎿\s+API attempt budget exhausted/);
    expect(screen).not.toContain("Conversation context compacted.");
    await submit(tau, "next");
    await tau.until("⏺ still here");
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
    await tau.until("⏺ answer");
    await submit(tau, "/compact");
    await until(() => provider.requests.length === 2);
    tau.write("\x03");
    await tau.until(/❯ \/compact\n {2}⎿\s+Interrupted/);
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
    await tau.until("⏺ final answer");
    const screen = await tau.until(IDLE);
    expect(screen).not.toContain("abandoned draft");
    tau.write("/exit\r");
    expect((await tau.exited).exitCode).toBe(0);
    expect(provider.requests.length).toBe(2);
  });

  test(
    "Ctrl-C during a turn interrupts it and the next prompt still works",
    async () => {
      // Match INV-11: wait until the hang is live, interrupt, return to IDLE,
      // then assert the script still has the second answer for the next turn.
      let firstRequest!: () => void;
      const requested = new Promise<void>((resolve) => {
        firstRequest = resolve;
      });
      const provider = await startMockProvider((_body, index) => {
        if (index > 0) return said("second answer");
        firstRequest();
        return { kind: "hang" };
      });
      const tau = startPty({ provider });
      await submit(tau, "first question");
      await requested;
      await tau.until("esc to interrupt");
      tau.write("\x03");
      await tau.until(/⎿\s+Interrupted · What should Claude do instead\?/);
      await tau.until(IDLE);
      expect(provider.requests.length).toBe(1);
      await submit(tau, "second question");
      await tau.until("⏺ second answer");
      await exit(tau);
      expect(provider.requests.length).toBe(2);
    },
    { timeout: 45_000 },
  );

  test("a context rejection compacts the conversation and reports the token change", async () => {
    const provider = await startMockProvider([
      said("original answer"),
      tooLong,
      said("<summary>Earlier facts</summary>"),
      said("done after compaction"),
    ]);
    const tau = startPty({ provider, env: { CLAUDE_CODE_MAX_RETRIES: "0" } });
    await submit(tau, "first");
    await tau.until("⏺ original answer");
    await submit(tau, "second");
    const screen = await tau.until("⏺ done after compaction");
    expect(screen).toContain("Compacting conversation context...");
    expect(screen).toMatch(
      /Context compacted \(\d+ → \d+ estimated tokens\)\./,
    );
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
    await tau.until("⏺ original answer");
    await submit(tau, "second");
    await tau.until(
      "Context compaction failed; original conversation preserved.",
    );
    await tau.until(/preserved\.\n\n {2}⎿\s+Messages API HTTP error 400/);
    await exit(tau);
  });
});

describe("session persistence", () => {
  test.skipIf(process.getuid?.() === 0)(
    "a turn whose session cannot be saved reports the save failure after any turn error",
    async () => {
      const badTurn = {
        kind: "error" as const,
        status: 400,
        body: {
          type: "error",
          error: { type: "invalid_request_error", message: "bad turn" },
        },
      };
      // On a custom endpoint an unexplained 400 is resent once without thinking.display.
      const provider = await startMockProvider([
        said("unsaved answer"),
        badTurn,
        badTurn,
      ]);
      const tau = startPty({ provider, args: ["--max-retries", "0"] });
      await tau.until(IDLE);
      const sessions = join(tau.state, "sessions");
      const [partition] = readdirSync(sessions);
      const directory = join(sessions, partition ?? "");
      chmodSync(directory, 0o500);
      await submit(tau, "question");
      await tau.until("⏺ unsaved answer");
      await tau.until(/⎿\s+Session save failed: /);
      await submit(tau, "again");
      await tau.until(/⎿\s+Messages API HTTP error 400; Session save failed: /);
      chmodSync(directory, 0o700);
      await exit(tau);
    },
  );

  test("resuming a session that was planning restores plan mode", async () => {
    const provider = await startMockProvider([said("planned")]);
    const tau = startPty({ provider, args: ["--permission-mode", "plan"] });
    const planning = await sessionId(tau);
    await submit(tau, "make a plan");
    await tau.until("⏺ planned");
    await submit(tau, "/clear");
    await tau.until("New session");
    await submit(tau, "/permissions default");
    await tau.until("Permissions: default");
    await submit(tau, `/resume ${planning}`);
    await tau.until(`Resumed ${planning}`);
    await submit(tau, "/permissions");
    await tau.until("Permissions: plan");
    await submit(tau, "/permissions acceptEdits");
    await tau.until("Permissions: acceptEdits");
    await submit(tau, "/clear");
    await tau.until("New session");
    await submit(tau, `/resume ${planning}`);
    await tau.until(`Resumed ${planning}`);
    await submit(tau, "/permissions");
    await tau.until(
      /Resumed [^\n]+\n\n❯ \/permissions\n {2}⎿\s+Permissions: acceptEdits/,
    );
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
    await tau.until("⏺ typed");
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
    const dialog = await tau.until("Do you want to proceed?");
    expect(dialog).toContain("   Connect project MCP server marker from");
    tau.write("2");
    await exit(tau);
    expect(existsSync(join(tau.cwd, "server-started.txt"))).toBe(false);
  });

  test("an approved project MCP server is started", async () => {
    const tau = startPty({
      env: { ANTHROPIC_API_KEY: "unused" },
      files: project,
    });
    await tau.until("Do you want to proceed?");
    tau.write("1");
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
    await tau.until(
      /Approve ExitPlanMode for planner\?[\s\S]*Do you want to proceed\?/,
    );
    tau.write("1");
    await tau.until("⏺ parent done");
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
    const dialog = await tau.until("Do you want to proceed?");
    expect(dialog).toContain(
      "   Plan:\n   # Child plan\n   - step one\n\n\n   Approve ExitPlanMode for planner?",
    );
    tau.write("1");
    await tau.until("⏺ parent done");
    await exit(tau);
  });
});
