// The CLI on a real pseudo-terminal: TTY-only option checks, interactive
// Ctrl-C (INV-11) and REPL exit paths. Bun's PTY is POSIX-only, so these are
// feature-gated rather than assumed portable.
import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockProvider } from "../helpers/mock-provider.js";
import { sentinel } from "../helpers/sentinels.js";

const entrypoint = resolve(import.meta.dir, "../../src/cli.ts");
const PROMPT = "tau> ";

interface TtySession {
  /** Everything the terminal has shown so far. */
  screen(): string;
  /** Typed input, as a user would. */
  type(text: string): void;
  /** Waits until `ready` holds for the screen, failing after `ms`. */
  waitFor(
    what: string,
    ready: (screen: string) => boolean,
    ms?: number,
  ): Promise<void>;
  /** How many `tau> ` prompts have been shown. */
  prompts(): number;
  exited: Promise<number>;
}

/** Runs the CLI on a PTY in a fresh temporary root with a whitelisted environment. */
function startTty(args: readonly string[], providerUrl: string): TtySession {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tau-tty-")));
  const dirs = {
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    config: join(root, "config"),
    state: join(root, "state"),
    managed: join(root, "managed"),
    tmp: join(root, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    TAU_HOME: dirs.state,
    TAU_MANAGED_ROOT: dirs.managed,
    TMPDIR: dirs.tmp,
    TERM: "xterm-256color",
    ANTHROPIC_BASE_URL: providerUrl,
    ANTHROPIC_API_KEY: sentinel("API_KEY"),
  };
  // Carry the coverage preload into the child, as the pipe harness does.
  for (const key of ["BUN_OPTIONS", "TAU_COVERAGE_DIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  let screen = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, entrypoint, ...args], {
    cwd: dirs.cwd,
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data: (_terminal, data) => {
        screen += decoder.decode(data, { stream: true });
      },
    },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
  onTestFinished(() => {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    child.terminal?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    screen: () => screen,
    type: (text) => {
      child.terminal?.write(text);
    },
    async waitFor(what, ready, ms = 10_000) {
      const end = Date.now() + ms;
      while (!ready(screen)) {
        if (Date.now() > end)
          throw new Error(`timed out waiting for ${what}; screen:\n${screen}`);
        await Bun.sleep(20);
      }
    },
    prompts: () => screen.split(PROMPT).length - 1,
    exited: child.exited.finally(() => clearTimeout(deadline)),
  };
}

const posixOnly = process.platform === "win32";

test.skipIf(posixOnly)(
  "on a TTY without --print, structured output and thinking budgets are usage errors",
  async () => {
    const provider = await startMockProvider([]);
    for (const [args, message] of [
      [
        ["--output-format", "json"],
        "Structured output requires --print or piped input",
      ],
      [
        ["--max-thinking-tokens", "1024"],
        "--max-thinking-tokens requires print or piped mode",
      ],
    ] as const) {
      const tty = startTty(args, provider.url);
      assert.equal(await tty.exited, 1);
      assert.ok(tty.screen().endsWith(`tau: ${message}\r\n`), tty.screen());
    }
    assert.equal(provider.requests.length, 0);
  },
);

test.skipIf(posixOnly)(
  "INV-11 interactive Ctrl-C cancels the hung turn, sends nothing until the next prompt and keeps the session usable",
  async () => {
    const provider = await startMockProvider([
      { kind: "hang" },
      {
        kind: "turn",
        content: [{ type: "text", text: "second answer" }],
        stopReason: "end_turn",
      },
    ]);
    const tty = startTty([], provider.url);
    await tty.waitFor("the first prompt", () => tty.prompts() === 1);
    tty.type("first question\r");
    await tty.waitFor(
      "the first request",
      () => provider.requests.length === 1,
    );
    tty.type("\u0003");
    await tty.waitFor("the prompt after cancelling", () => tty.prompts() === 2);
    assert.ok(tty.screen().includes("Cancelling…\r\n\r\ntau: Interrupted\r\n"));
    assert.equal(provider.requests.length, 1);

    tty.type("second question\r");
    await tty.waitFor("the second answer", (screen) =>
      screen.includes("second answer"),
    );
    await tty.waitFor("the third prompt", () => tty.prompts() === 3);
    tty.type("/exit\r");
    assert.equal(await tty.exited, 0);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.unexpected, 0);
  },
);

test.skipIf(posixOnly)(
  "Ctrl-C or Ctrl-D at an idle interactive prompt exits 0 without a request",
  async () => {
    const provider = await startMockProvider([]);
    for (const key of ["\u0003", "\u0004"]) {
      const tty = startTty([], provider.url);
      await tty.waitFor("the prompt", () => tty.prompts() === 1);
      tty.type(key);
      assert.equal(await tty.exited, 0);
    }
    assert.equal(provider.requests.length, 0);
  },
);

test.skipIf(posixOnly)(
  "interactive /help lists the commands and an unknown command is reported, not sent",
  async () => {
    const provider = await startMockProvider([]);
    const tty = startTty([], provider.url);
    await tty.waitFor("the prompt", () => tty.prompts() === 1);
    tty.type("/help\r");
    await tty.waitFor("the help line", (screen) =>
      screen.includes("/help · /exit"),
    );
    tty.type("/no-such-command\r");
    await tty.waitFor("the unknown-command notice", (screen) =>
      screen.includes("Unknown command. Use /help."),
    );
    await tty.waitFor("the next prompt", () => tty.prompts() === 3);
    tty.type("/exit\r");
    assert.equal(await tty.exited, 0);
    assert.equal(provider.requests.length, 0);
  },
);
