// The Bash tool through the real CLI against the loopback mock provider:
// the model-visible tool_result texts, cd persistence, timeouts, and a
// background command whose completion notification starts the next request.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../helpers/cli-harness.js";
import {
  startMockProvider,
  turn,
  type MockProvider,
} from "../helpers/mock-provider.js";

setDefaultTimeout(30_000);

const bodySchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
});
const blockSchema = z.looseObject({ type: z.string() });
const resultSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

const bash = (id: string, input: Record<string, unknown>) =>
  turn({ type: "tool_use", id, name: "Bash", input });

function blocks(body: unknown) {
  return bodySchema.parse(body).messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.map((block) => ({
          role: message.role,
          block: blockSchema.parse(block),
        }))
      : [],
  );
}
function results(provider: MockProvider) {
  return resultsOf(provider.requests.at(-1)?.body);
}
function resultsOf(body: unknown) {
  return Object.fromEntries(
    blocks(body).flatMap(({ block }) => {
      const parsed = resultSchema.safeParse(block);
      return parsed.success
        ? [
            [
              parsed.data.tool_use_id,
              {
                content: parsed.data.content,
                is_error: parsed.data.is_error ?? false,
              },
            ],
          ]
        : [];
    }),
  );
}
const PRINT = [
  "-p",
  "run the shell steps",
  "--allowed-tools",
  "Bash",
  "--output-format",
  "json",
];

test("cd persists, nonzero exits lead with the exit code, and a leading sleep times out", async () => {
  const provider = await startMockProvider([
    bash("s1", { command: "echo hi" }),
    bash("s2", { command: "cd sub && pwd" }),
    bash("s3", { command: "pwd" }),
    bash("s4", { command: "sh -c 'exit 3'" }),
    bash("s5", { command: "sleep 3", timeout: 200 }),
    bash("s6", { command: "cd / && pwd" }),
    bash("s7", { command: "printf ''" }),
    turn({ type: "text", text: "done" }),
  ]);
  const run = await runCli({
    args: PRINT,
    provider,
    files: { "sub/.keep": "" },
  });
  assert.equal(run.exitCode, 0, run.stderr);
  const sub = `${run.cwd}/sub`;
  assert.deepEqual(results(provider), {
    s1: { content: "hi", is_error: false },
    s2: { content: sub, is_error: false },
    s3: { content: sub, is_error: false },
    s4: { content: "Exit code 3", is_error: true },
    s5: {
      content: "Exit code 143\nCommand timed out after 0s",
      is_error: true,
    },
    s6: { content: `/\nShell cwd was reset to ${run.cwd}`, is_error: false },
    s7: { content: "(Bash completed with no output)", is_error: false },
  });
  const tools = bodySchema.parse(provider.requests[0]?.body).tools ?? [];
  const definition = z
    .looseObject({ description: z.string(), input_schema: z.unknown() })
    .parse(tools.find((tool) => tool.name === "Bash"));
  assert.match(
    definition.description,
    /^Executes a given bash command and returns its output\.\n\n`cd` carries to the next call only in the main session/,
  );
});

test("a background command's completion reaches the next request, and TaskStop stops another", async () => {
  let launched = "";
  const provider = await startMockProvider((body, index) => {
    if (index === 0)
      return bash("bg", {
        command: "sleep 2; echo bg",
        run_in_background: true,
        description: "Print bg after two seconds",
      });
    if (index === 1)
      return bash("long", { command: "sleep 30", run_in_background: true });
    if (index === 2) {
      const content = String(resultsOf(body).long?.content);
      launched = /ID: (b[0-9a-z]{8})\./.exec(content)?.[1] ?? "";
      return turn({
        type: "tool_use",
        id: "stop",
        name: "TaskStop",
        input: { task_id: launched },
      });
    }
    if (index === 3) return turn({ type: "text", text: "waiting" });
    return turn({ type: "text", text: "notified" });
  });
  const run = await runCli({
    args: PRINT.map((arg) => (arg === "Bash" ? "Bash,TaskStop" : arg)),
    provider,
    env: { ENABLE_TOOL_SEARCH: "false" },
  });
  assert.equal(
    run.exitCode,
    0,
    `${run.stderr}\n${provider.requests.length}\n${JSON.stringify(provider.requests.map((r) => resultsOf(r.body)))}`,
  );
  assert.equal(provider.requests.length, 5);
  const launch = results(provider).bg;
  const output = /Output is being written to: (\S+\.output)\./.exec(
    String(launch?.content),
  )?.[1];
  assert.ok(output, String(launch?.content));
  const id = /ID: (b[0-9a-z]{8})\./.exec(String(launch?.content))?.[1];
  assert.equal(
    launch?.content,
    `Command running in background with ID: ${id}. Output is being written to: ${output}. You will be notified when it completes. To check interim output, use Read on that file path.`,
  );
  assert.ok(output.startsWith(`${run.root}/tmp/claude-`));
  assert.deepEqual(results(provider).stop, {
    content: JSON.stringify({
      message: `Successfully stopped task: ${launched} (sleep 30)`,
      task_id: launched,
      task_type: "local_bash",
      command: "sleep 30",
    }),
    is_error: false,
  });
  const notifications = blocks(provider.requests[4]?.body).filter(
    ({ role, block }) =>
      role === "user" &&
      block.type === "text" &&
      String(block.text).includes("<task-notification>"),
  );
  assert.equal(notifications.length, 1);
  assert.match(
    String(notifications[0]?.block.text),
    new RegExp(
      `<task-notification>\\n<task-id>${id}</task-id>\\n<tool-use-id>bg</tool-use-id>\\n<output-file>${output}</output-file>\\n<status>completed</status>\\n<summary>Background command "Print bg after two seconds" completed \\(exit code 0\\)</summary>\\n</task-notification>\\n</system-reminder>$`,
    ),
  );
  assert.equal(await readFile(output, "utf8"), "bg\n\n[exited with code 0]\n");
});
