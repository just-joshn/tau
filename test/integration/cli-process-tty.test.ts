// The CLI on a real pseudo-terminal: TTY-only option checks, interactive
// Ctrl-C (INV-11) and REPL exit paths. Bun's PTY is POSIX-only, so these are
// feature-gated rather than assumed portable.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { startMockProvider, turn } from "../helpers/mock-provider.js";
import { startPty } from "../helpers/pty.js";

const PROMPT = "tau> ";

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
      const tty = startPty({ args, provider });
      assert.equal((await tty.exited).exitCode, 1);
      assert.ok(tty.text().endsWith(`tau: ${message}\n`), tty.text());
    }
    assert.equal(provider.requests.length, 0);
  },
);

test.skipIf(posixOnly)(
  "INV-11 interactive Ctrl-C cancels the hung turn, sends nothing until the next prompt and keeps the session usable",
  async () => {
    let firstRequest!: () => void;
    const requested = new Promise<void>((resolve) => {
      firstRequest = resolve;
    });
    const provider = await startMockProvider((_body, index) => {
      if (index > 0) return turn({ type: "text", text: "second answer" });
      firstRequest();
      return { kind: "hang" };
    });
    const tty = startPty({ provider });
    await tty.expect(PROMPT);
    tty.write("first question\r");
    await requested;
    tty.write("\u0003");
    await tty.expect("Cancelling…\n\ntau: Interrupted\n");
    await tty.expect(PROMPT);
    assert.equal(provider.requests.length, 1);

    tty.write("second question\r");
    await tty.expect("second answer");
    await tty.expect(PROMPT);
    tty.write("/exit\r");
    assert.equal((await tty.exited).exitCode, 0);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.unexpected, 0);
  },
);

test.skipIf(posixOnly)(
  "Ctrl-C twice or Ctrl-D at an idle interactive prompt exits 0 without a request",
  async () => {
    const provider = await startMockProvider([]);
    for (const keys of ["\u0003\u0003", "\u0004"]) {
      const tty = startPty({ provider });
      await tty.expect(PROMPT);
      tty.write(keys);
      assert.equal((await tty.exited).exitCode, 0);
    }
    assert.equal(provider.requests.length, 0);
  },
);

test.skipIf(posixOnly)(
  "interactive /help lists the commands and an unknown command is reported, not sent",
  async () => {
    const provider = await startMockProvider([]);
    const tty = startPty({ provider });
    await tty.expect(PROMPT);
    tty.write("/help\r");
    await tty.expect("Show help and available commands");
    await tty.expect(PROMPT);
    tty.write("/no-such-command\r");
    await tty.expect("Unknown command: /no-such-command");
    await tty.expect(PROMPT);
    tty.write("/exit\r");
    assert.equal((await tty.exited).exitCode, 0);
    assert.equal(provider.requests.length, 0);
  },
);
