import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider } from "../helpers/mock-provider.js";
import { startPty } from "../helpers/pty.js";

const answer = () =>
  startMockProvider([
    {
      kind: "turn",
      content: [{ type: "text", text: "Saved?" }],
      stopReason: "end_turn",
    },
  ]);

function sessionFiles(state: string): string[] {
  const root = join(state, "sessions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".json"),
  );
}

test("a print run saves its session by default", async () => {
  const run = await runCli({ args: ["-p", "hello"], provider: await answer() });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(sessionFiles(join(run.root, "state")).length, 1);
});

test("--no-session-persistence answers the print run and writes no session", async () => {
  const provider = await answer();
  const run = await runCli({
    args: ["-p", "hello", "--no-session-persistence"],
    provider,
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout.trim(), "Saved?");
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(sessionFiles(join(run.root, "state")), []);
});

test("--no-session-persistence on an interactive terminal launch is refused before any request", async () => {
  const provider = await answer();
  const pty = startPty({ args: ["--no-session-persistence"], provider });
  await pty.expect("Error: --no-session-persistence only works with --print.");
  const exit = await pty.exited;
  assert.equal(exit.exitCode, 1);
  assert.equal(provider.requests.length, 0);
});
