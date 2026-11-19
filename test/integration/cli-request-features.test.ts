// The compiled CLI's request fields the original gates by output mode:
// context_management with its beta, and thinking.display.
import assert from "node:assert/strict";
import { setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import { startMockProvider, turn } from "../helpers/mock-provider.js";

setDefaultTimeout(30_000);

const body = z.looseObject({
  thinking: z.unknown(),
  context_management: z.unknown().optional(),
});
const MODEL = ["--model", "claude-sonnet-4-5-20250929"];

for (const [mode, args, display, betas] of [
  [
    "json",
    ["-p", "hi", "--output-format", "json"],
    "omitted",
    "context-management-2025-06-27",
  ],
  [
    "stream-json",
    ["-p", "hi", "--output-format", "stream-json", "--verbose"],
    "updates",
    "context-management-2025-06-27,thinking-display-updates-2026-08-18",
  ],
] as const)
  test(`${mode} print sends context management and the ${display} display`, async () => {
    const provider = await startMockProvider([
      turn({ type: "text", text: "done" }),
    ]);
    const run = await runCli({ args: [...args, ...MODEL], provider });
    assert.equal(run.exitCode, 0, run.stderr);
    const [request] = provider.requests;
    const sent = body.parse(request?.body);
    assert.deepEqual(sent.thinking, {
      type: "enabled",
      budget_tokens: 31999,
      display,
    });
    assert.deepEqual(sent.context_management, {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    });
    assert.equal(request?.headers["anthropic-beta"], betas);
  });
