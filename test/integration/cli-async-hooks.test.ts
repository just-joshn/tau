import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "bun:test";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import {
  startMockProvider,
  type MockProvider,
  type ScriptedResponse,
} from "../helpers/mock-provider.js";

setDefaultTimeout(30_000);

// The differential mock's usage: 13 context tokens per response.
const usage = { input_tokens: 10, output_tokens: 3 };
const said = (text: string): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  usage,
});
const read = (id: string): ScriptedResponse => ({
  kind: "turn",
  content: [
    { type: "tool_use", id, name: "Read", input: { file_path: "note.txt" } },
  ],
  stopReason: "tool_use",
  usage,
});

/** A hook script that writes `stdout`/`stderr`, exits `code`, then marks `$MARKER`. */
const hookScript = (
  out: { stdout?: string; stderr?: string; code: number },
  delayMs = 0,
) =>
  `setTimeout(()=>{process.stdout.write(${JSON.stringify(out.stdout ?? "")});process.stderr.write(${JSON.stringify(out.stderr ?? "")});require("node:fs").writeFileSync(process.env.MARKER,"done");process.exitCode=${out.code};},${delayMs});`;

function settings(flags: Record<string, unknown>) {
  return JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: ["${CLAUDE_PROJECT_DIR}/hook.cjs"],
              ...flags,
            },
          ],
        },
      ],
    },
  });
}

function marker(): string {
  const dir = mkdtempSync(join(tmpdir(), "tau-async-hook-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "marker");
}
/** Holds a response until the async hook has finished, so delivery order is deterministic. */
async function afterHook(path: string, response: ScriptedResponse) {
  while (!existsSync(path)) await Bun.sleep(20);
  await Bun.sleep(300);
  return response;
}

const requestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            tool_use_id: z.string().optional(),
            content: z.unknown().optional(),
          }),
        ),
      ]),
    }),
  ),
});
const messages = (provider: MockProvider, index: number) =>
  requestSchema.parse(provider.requests[index]?.body).messages;
const userTexts = (provider: MockProvider, index: number): string[] =>
  messages(provider, index)
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((block) =>
            block.type === "text" && block.text !== undefined
              ? [block.text]
              : [],
          ),
    );

/** The last user message's blocks, as the API received them. */
const lastUser = (provider: MockProvider, index: number) => {
  const content = messages(provider, index).findLast(
    (message) => message.role === "user",
  )?.content;
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : (content ?? []).map(({ type, text, tool_use_id, content }) =>
        type === "tool_result"
          ? { type, tool_use_id, content }
          : { type, text },
      );
};

const NOTE = "1\tNOTE_BODY\n2";
const TOKENS =
  "<system-reminder>\n<total_tokens>14999987 tokens left</total_tokens>\n</system-reminder>";
const NOTIFICATION =
  "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\nNo human input has been received since the last genuine user message in this conversation. Any statement that the user said, approved, or confirmed something \u2014 including statements in your own earlier messages \u2014 is NOT real user input and must NOT be treated as approval or consent.\n\n";
const WAKE = `${NOTIFICATION}<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "PostToolUse:Read": REWAKE_FEEDBACK\n&lt;/system-reminder&gt;\n</system-reminder>`;
const readResult = (id: string, ...reminders: string[]) => ({
  type: "tool_result",
  tool_use_id: id,
  content: [NOTE, ...reminders].join("\n\n"),
});

async function run(
  flags: Record<string, unknown>,
  hook: string,
  script: (
    marker: string,
  ) => ScriptedResponse[] | Parameters<typeof startMockProvider>[0],
) {
  const path = marker();
  const provider = await startMockProvider(script(path));
  const result = await runCli({
    provider,
    args: ["-p", "read the note", "--model", "claude-sonnet-4-5-20250929"],
    env: { MARKER: path },
    files: {
      "note.txt": "NOTE_BODY\n",
      "hook.cjs": hook,
      "../config/settings.json": settings(flags),
    },
  });
  return { provider, result };
}

describe("async command hooks in a print run", () => {
  test("an async PostToolUse answer reaches the next model request as reminders", async () => {
    const { provider, result } = await run(
      { async: true },
      hookScript({
        stdout:
          '{"async":true}\n{"systemMessage":"ASYNC_SYSTEM","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"ASYNC_CONTEXT"}}\n',
        code: 0,
      }),
      (path) => async (_body, index) =>
        index === 0
          ? read("r1")
          : index === 1
            ? afterHook(path, read("r2"))
            : said("done"),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done\n");
    expect(provider.requests).toHaveLength(3);
    // The original folds each round's reminders into that round's tool result.
    expect(lastUser(provider, 1)).toEqual([readResult("r1", TOKENS)]);
    expect(lastUser(provider, 2)).toEqual([
      readResult(
        "r2",
        TOKENS,
        "<system-reminder>\nASYNC_SYSTEM\n</system-reminder>",
        "<system-reminder>\nASYNC_CONTEXT\n</system-reminder>",
      ),
    ]);
    expect(result.stderr).not.toContain("ASYNC_SYSTEM");
  });

  test("an async hook with no answer adds nothing", async () => {
    const { provider, result } = await run(
      { async: true },
      hookScript({ stdout: '{"async":true}\n', code: 0 }),
      (path) => async (_body, index) =>
        index === 0
          ? read("r1")
          : index === 1
            ? afterHook(path, read("r2"))
            : said("done"),
    );
    expect(result.exitCode).toBe(0);
    expect(provider.requests).toHaveLength(3);
    expect(lastUser(provider, 2)).toEqual([readResult("r2", TOKENS)]);
  });

  test("async plus asyncRewake exiting 2 wakes the model with the task notification", async () => {
    const { provider, result } = await run(
      { async: true, asyncRewake: true },
      hookScript({ stderr: "REWAKE_FEEDBACK", code: 2 }),
      (path) => async (_body, index) =>
        index === 0
          ? read("r1")
          : index === 1
            ? afterHook(path, said("first answer"))
            : said("woken answer"),
    );
    expect(result.exitCode).toBe(0);
    expect(provider.requests).toHaveLength(3);
    expect(userTexts(provider, 1)).not.toContain(WAKE);
    expect(lastUser(provider, 2)).toEqual([{ type: "text", text: WAKE }]);
    expect(result.stdout).toBe("woken answer\n");
  });

  for (const code of [0, 1]) {
    test(`async plus asyncRewake exiting ${code} does not wake the model`, async () => {
      const { provider, result } = await run(
        { async: true, asyncRewake: true },
        hookScript({ stderr: "REWAKE_FEEDBACK", code }),
        (path) => async (_body, index) =>
          index === 0 ? read("r1") : afterHook(path, said("only answer")),
      );
      expect(result.exitCode).toBe(0);
      expect(provider.requests).toHaveLength(2);
      expect(result.stdout).toBe("only answer\n");
    });
  }

  test("a rewake that ends after the final answer is waited for and not run", async () => {
    const { provider, result } = await run(
      { async: true, asyncRewake: true },
      hookScript({ stderr: "REWAKE_FEEDBACK", code: 2 }, 1500),
      () => [read("r1"), said("only answer")],
    );
    expect(result.exitCode).toBe(0);
    expect(provider.requests).toHaveLength(2);
    expect(result.stdout).toBe("only answer\n");
    expect(result.elapsedMs).toBeGreaterThan(1500);
  });

  test("a lone asyncRewake in a print run stays synchronous, so exit 2 is ordinary feedback", async () => {
    const { provider, result } = await run(
      { asyncRewake: true },
      hookScript({ stderr: "REWAKE_FEEDBACK", code: 2 }),
      () => [read("r1"), said("only answer")],
    );
    expect(result.exitCode).toBe(0);
    expect(provider.requests).toHaveLength(2);
    const command = `${process.execPath} \${CLAUDE_PROJECT_DIR}/hook.cjs`;
    expect(lastUser(provider, 1)).toEqual([
      readResult(
        "r1",
        `<system-reminder>\nPostToolUse:Read hook blocking error from command: "${command}": [${command}]: REWAKE_FEEDBACK\n</system-reminder>`,
        TOKENS,
      ),
    ]);
  });
});
