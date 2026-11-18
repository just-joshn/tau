import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, onTestFinished } from "bun:test";
import { z } from "zod";
import { createHookRegistry } from "../src/hooks.js";
import { createSessionHookHost } from "../src/session-hooks.js";

const hookRow = z.object({
  hook_event_name: z.string(),
  task_id: z.string(),
  task_subject: z.string(),
  task_description: z.string().optional(),
});

test("task lifecycle hooks deliver task fields and consume blocking feedback without Stop flags", async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-task-hook-host-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "hook.cjs"),
    log = join(cwd, "events.jsonl");
  await writeFile(
    script,
    String.raw`let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const i=JSON.parse(raw);require('node:fs').appendFileSync(process.argv[2],JSON.stringify(i)+'\n');if(i.hook_event_name==='TaskCompleted'){process.stderr.write('owned completion hold');process.exitCode=2;}else process.stdout.write(JSON.stringify({continue:false,stopReason:'not task blocking feedback'}));});`,
  );
  const command = {
    type: "command",
    command: process.execPath,
    args: [script, log],
  };
  const registry = createHookRegistry([
    {
      source: "userSettings",
      hooks: {
        TaskCreated: [{ hooks: [command] }],
        TaskCompleted: [{ hooks: [command] }],
      },
    },
  ]);
  const host = createSessionHookHost({
    registry,
    context: () => ({
      session_id: "owned-session",
      cwd,
      transcript_path: join(cwd, "owned.json"),
    }),
    runOptions: () => ({ cwd, projectDir: cwd, env: {} }),
  });
  onTestFinished(() => host.close());
  assert.equal(host.hasToolHooks, false);
  assert.deepEqual(
    await host.task(
      "TaskCreated",
      { taskId: "1", subject: "owned", description: "description" },
      new AbortController().signal,
    ),
    [],
  );
  const held = await host.task(
    "TaskCompleted",
    { taskId: "1", subject: "owned" },
    new AbortController().signal,
  );
  assert.equal(held.length, 1);
  const [heldText] = held;
  assert.ok(heldText);
  assert.match(heldText, /owned completion hold/);
  assert.ok(heldText.includes(`[${process.execPath} ${script} ${log}]:`));
  const rows = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => hookRow.parse(JSON.parse(line)));
  assert.deepEqual(
    rows.map((row) => [row.hook_event_name, row.task_id, row.task_subject]),
    [
      ["TaskCreated", "1", "owned"],
      ["TaskCompleted", "1", "owned"],
    ],
  );
  const [first, second] = rows;
  assert.ok(first && second);
  assert.equal(first.task_description, "description");
  assert.equal(Object.hasOwn(second, "task_description"), false);
  await assert.rejects(
    registry.run(
      {
        hook_event_name: "TaskCreated",
        session_id: "owned",
        cwd,
        transcript_path: "owned",
      },
      { cwd, projectDir: cwd, env: {}, signal: new AbortController().signal },
    ),
    /task_id and task_subject/,
  );
});
