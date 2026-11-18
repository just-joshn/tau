import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { startMockProvider } from "../helpers/mock-provider.js";
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
  test("banner names model, workspace, session and mode; /help lists commands", async () => {
    const tau = startPty({
      env: { ANTHROPIC_API_KEY: "unused" },
      args: ["--model", "banner-model"],
    });
    const screen = await tau.expect(PROMPT);
    expect(screen).toContain(`tau · banner-model · ${tau.cwd}`);
    expect(screen).toMatch(/Session [0-9a-f-]{36} · permissions: default/);
    tau.write("/help\r");
    expect(await tau.expect("/SKILL [args]")).toContain(
      "/help · /exit · /clear · /compact · /model [ID]",
    );
    await exit(tau);
  });

  test("blank lines are ignored and unknown commands are reported", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await submit(tau, "   ");
    await submit(tau, "/nope");
    expect(await tau.expect("Unknown command. Use /help.")).toBeTruthy();
    await exit(tau);
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

describe("interrupts and end of input", () => {
  test("Ctrl-C cancels a running turn and the REPL keeps going", async () => {
    const provider = await startMockProvider([
      { kind: "hang" },
      said("after cancel"),
    ]);
    const tau = startPty({ provider });
    await submit(tau, "slow question");
    await until(() => provider.requests.length === 1);
    tau.write("\x03");
    await tau.expect("Cancelling…");
    await tau.expect("tau: Interrupted");
    await submit(tau, "again");
    await tau.expect("after cancel");
    await exit(tau);
  });

  test("Ctrl-C at an idle prompt ends the session cleanly", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await tau.expect(PROMPT);
    tau.write("\x03");
    expect(await tau.exited).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
  });

  test("Ctrl-D at an idle prompt ends the session cleanly", async () => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" } });
    await tau.expect(PROMPT);
    tau.write("\x04");
    expect(await tau.exited).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
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

describe("launch errors specific to a terminal", () => {
  test.each([
    [
      ["--output-format", "json"],
      "tau: Structured output requires --print or piped input",
    ],
    [
      ["--max-thinking-tokens", "2000"],
      "tau: --max-thinking-tokens requires print or piped mode",
    ],
  ])("%p is rejected in interactive mode", async (args, message) => {
    const tau = startPty({ env: { ANTHROPIC_API_KEY: "unused" }, args });
    await tau.expect(message);
    expect((await tau.exited).exitCode).toBe(1);
  });
});

describe("/compact", () => {
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
