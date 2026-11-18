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
