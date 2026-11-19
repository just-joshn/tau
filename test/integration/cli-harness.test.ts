import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { test } from "bun:test";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider } from "../helpers/mock-provider.js";
import { SENTINEL_PREFIX } from "../helpers/sentinels.js";

test("help exits 0 with usage on stdout and nothing on stderr", async () => {
  const run = await runCli({ args: ["--help"] });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /^Usage: tau/m);
  assert.equal(run.stderr, "");
});

test("a scripted one-turn print run returns the text after exactly one request", async () => {
  const provider = await startMockProvider([
    {
      kind: "turn",
      content: [{ type: "text", text: "Scripted answer." }],
      stopReason: "end_turn",
    },
  ]);
  const run = await runCli({ args: ["-p", "hello"], provider });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stdout.trim(), "Scripted answer.");
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.unexpected, 0);
  assert.equal(provider.requests[0]?.path, "/v1/messages?beta=true");
  assert.ok(
    String(provider.requests[0]?.headers["x-api-key"]).startsWith(
      SENTINEL_PREFIX,
    ),
  );
  assert.ok(!(run.stdout + run.stderr).includes(SENTINEL_PREFIX));
});

test("the mock provider answers requests beyond its script with 500", async () => {
  const provider = await startMockProvider([]);
  const response = await fetch(`${provider.url}/v1/messages`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 500);
  assert.equal(provider.unexpected, 1);
});

test("the deadline kills the whole process group of a hung run", async () => {
  const provider = await startMockProvider([{ kind: "hang" }]);
  let child: ChildProcess | undefined;
  const run = await runCli({
    args: ["-p", "hello"],
    provider,
    // Long enough for the child to reach the provider on a loaded runner
    // under coverage, where its startup alone has taken over 1.5 s.
    deadlineMs: 4000,
    onSpawn: (spawned) => {
      child = spawned;
    },
  });
  assert.equal(run.timedOut, true);
  assert.equal(run.signal, "SIGKILL");
  assert.ok(run.elapsedMs < 10_000, `took ${run.elapsedMs}ms`);
  assert.equal(provider.requests.length, 1);
  const pid = child?.pid;
  assert.ok(pid !== undefined);
  if (process.platform !== "win32")
    assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
}, 15_000);
