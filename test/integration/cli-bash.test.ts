// The Bash tool through the real CLI against the loopback mock provider:
// the model-visible tool_result texts, cd persistence, timeouts, and a
// background command whose completion notification starts the next request.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
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
  const moved = (to: string, from: string) =>
    `\n\n<system-reminder>\n# Environment update\n - Primary working directory: ${to} (was ${from})\n</system-reminder>`;
  assert.deepEqual(results(provider), {
    s1: { content: "hi", is_error: false },
    s2: { content: sub + moved(sub, run.cwd), is_error: false },
    s3: { content: sub, is_error: false },
    s4: { content: "Exit code 3", is_error: true },
    s5: {
      content: "Exit code 143\nCommand timed out after 0s",
      is_error: true,
    },
    s6: {
      content: `/\nShell cwd was reset to ${run.cwd}${moved(run.cwd, sub)}`,
      is_error: false,
    },
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
    if (index === 3) {
      const file = /Output is being written to: (\S+\.output)\./.exec(
        String(resultsOf(body).bg?.content),
      )?.[1];
      return turn({
        type: "tool_use",
        id: "read",
        name: "Read",
        input: { file_path: file ?? "" },
      });
    }
    if (index === 4) return turn({ type: "text", text: "waiting" });
    return turn({ type: "text", text: "notified" });
  });
  const run = await runCli({
    args: PRINT.map((arg) => (arg === "Bash" ? "Bash,TaskStop,Read" : arg)),
    provider,
    env: { ENABLE_TOOL_SEARCH: "false" },
  });
  assert.equal(
    run.exitCode,
    0,
    `${run.stderr}\n${provider.requests.length}\n${JSON.stringify(provider.requests.map((r) => resultsOf(r.body)))}`,
  );
  assert.equal(provider.requests.length, 6);
  // Read may open a live task output file outside the workspace.
  assert.equal(results(provider).read?.is_error, false);
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
  const notifications = blocks(provider.requests[5]?.body).filter(
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

const SHELLS = ["/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));
// `files` are keyed relative to the workspace; the harness HOME is its sibling.
const rcFiles = (text: string) => ({
  "../home/.bashrc": text,
  "../home/.zshrc": text,
});
const shellEnv = (shell: string) => ({
  SHELL: shell,
  CLAUDE_CODE_SHELL: shell,
});

for (const shell of SHELLS)
  test(`${shell}: rc aliases and functions reach foreground and background commands`, async () => {
    const provider = await startMockProvider([
      bash("alias", { command: "greet" }),
      bash("function", { command: "shout fg" }),
      bash("empty", { command: "printf ''" }),
      bash("bg", { command: "shout bg > bg.txt", run_in_background: true }),
      turn({ type: "text", text: "waiting" }),
      turn({ type: "text", text: "done" }),
    ]);
    const run = await runCli({
      args: PRINT,
      provider,
      env: shellEnv(shell),
      files: rcFiles(
        `alias greet='echo hello from rc'\nshout() { echo "SHOUT:$1"; }\n`,
      ),
    });
    assert.equal(run.exitCode, 0, run.stderr);
    const seen = resultsOf(provider.requests[4]?.body);
    assert.deepEqual(
      [seen.alias, seen.function, seen.empty],
      [
        { content: "hello from rc", is_error: false },
        { content: "SHOUT:fg", is_error: false },
        { content: "(Bash completed with no output)", is_error: false },
      ],
    );
    assert.equal(await readFile(`${run.cwd}/bg.txt`, "utf8"), "SHOUT:bg\n");
    // The snapshot is deleted when the CLI exits.
    assert.deepEqual(readdirSync(`${run.root}/config/shell-snapshots`), []);
  });

test("a broken rc file keeps what ran before the error", async () => {
  const provider = await startMockProvider([
    bash("alias", { command: "greet" }),
    turn({ type: "text", text: "done" }),
  ]);
  const run = await runCli({
    args: PRINT,
    provider,
    env: shellEnv("/bin/bash"),
    files: rcFiles("alias greet='echo still here'\nif then fi\n"),
  });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(results(provider).alias, {
    content: "still here",
    is_error: false,
  });
});

test("an rc file that exits fails the snapshot, so commands run in a login shell", async () => {
  const provider = await startMockProvider([
    bash("alias", { command: "greet" }),
    bash("echo", { command: "echo ok" }),
    turn({ type: "text", text: "done" }),
  ]);
  const run = await runCli({
    args: PRINT,
    provider,
    env: shellEnv("/bin/bash"),
    files: rcFiles("alias greet='echo never'\nexit 3\n"),
  });
  assert.equal(run.exitCode, 0, run.stderr);
  const seen = results(provider);
  assert.equal(seen.alias?.is_error, true);
  assert.match(String(seen.alias?.content), /^Exit code 127\n/);
  // A login shell may print its own startup noise before the output.
  assert.equal(seen.echo?.is_error, false);
  assert.match(String(seen.echo?.content), /(^|\n)ok$/);
  assert.deepEqual(readdirSync(`${run.root}/config/shell-snapshots`), []);
});

test("the tenth model turn without the task tools folds the task reminder into its result", async () => {
  const steps = Array.from({ length: 11 }, (_, index) =>
    bash(`t${index + 1}`, { command: "true" }),
  );
  const provider = await startMockProvider([
    ...steps,
    turn({ type: "text", text: "done" }),
  ]);
  const run = await runCli({
    args: [...PRINT, "--model", "claude-sonnet-4-5-20250929"],
    provider,
  });
  assert.equal(run.exitCode, 0, run.stderr);
  const silent = "(Bash completed with no output)";
  const tokens =
    "\n\n<system-reminder>\n<total_tokens>14999986 tokens left</total_tokens>\n</system-reminder>";
  const contents = Object.fromEntries(
    Object.entries(results(provider)).map(([id, { content }]) => [id, content]),
  );
  assert.deepEqual(contents, {
    ...Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [
        `t${index + 1}`,
        silent + tokens,
      ]),
    ),
    t10: `${silent}\n\n<system-reminder>\nThe task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n\n</system-reminder>${tokens}`,
  });
});
