import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  createBackgroundShells,
  type RunningShell,
} from "../../src/background-shells.js";
import { interpretExit } from "../../src/bash-tool.js";

/** A shell whose exit the test decides. */
function fakeShell(outputFile: string) {
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (finish = resolve));
  const shell: RunningShell = {
    outputFile,
    exited,
    kill: async () => {
      finish(143);
      return exited;
    },
  };
  return { shell, exit: (code: number) => finish(code) };
}
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "tau-shells-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const notifications: string[] = [],
    diagnostics: string[] = [];
  let clock = 1000;
  const shells = createBackgroundShells({
    interpret: interpretExit,
    enqueueNotification: (text) => notifications.push(text),
    now: () => clock++,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const file = async (name: string) => {
    const target = path.join(dir, name);
    await writeFile(target, "");
    return target;
  };
  return { dir, shells, notifications, diagnostics, file };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Polls instead of a fixed delay, which flakes when the suite runs in parallel. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 5000; waited += 20) await settle();
}

test("exit statuses, notes and escaped summaries reach the notification", async () => {
  const { shells, notifications, file } = await setup();
  const failed = fakeShell(await file("a.output"));
  shells.adopt(failed.shell, {
    id: "baaaaaaaa",
    command: "make",
    description: "Build <all> & test",
  });
  const quiet = fakeShell(await file("b.output"));
  let published = 0;
  const unsubscribe = shells.subscribe(() => published++);
  shells.adopt(quiet.shell, {
    id: "bbbbbbbbb",
    command: "grep x f",
    description: "grep x f",
    toolUseId: "toolu_2",
  });
  failed.exit(2);
  quiet.exit(1);
  await until(() => notifications.length >= 2);
  unsubscribe();
  assert.ok(published >= 2);
  assert.match(
    notifications[0] ?? "",
    /<task-id>baaaaaaaa<\/task-id>\n<output-file>[^<]+<\/output-file>\n<status>failed<\/status>\n<summary>Background command "Build &lt;all&gt; &amp; test" failed with exit code 2<\/summary>/,
  );
  assert.match(
    notifications[1] ?? "",
    /<tool-use-id>toolu_2<\/tool-use-id>[\s\S]*<summary>Background command "grep x f" completed \(exit code 1: No matches found\)<\/summary>/,
  );
  assert.deepEqual(
    shells.list().map((task) => [task.id, task.status, task.exitCode]),
    [
      ["baaaaaaaa", "failed", 2],
      ["bbbbbbbbb", "completed", 1],
    ],
  );
  assert.equal(shells.hasRunning, false);
});

test("a deadline names the session's longest timeout when it is below two hours", async () => {
  const { shells, notifications, file } = await setup();
  const running = fakeShell(await file("c.output"));
  shells.adopt(running.shell, {
    id: "bcccccccc",
    command: "serve",
    description: "serve",
    deadlineMs: 10,
    longestTimeoutMs: 3600000,
  });
  await until(() => notifications.length >= 1);
  assert.match(
    notifications[0] ?? "",
    /<note>[^<]*report that it was stopped\. The longest `timeout` allowed in this session is 3600000 ms \(60 minutes\)\.<\/note>/,
  );
  assert.equal(shells.get("bcccccccc")?.status, "killed");
  assert.equal(notifications.length, 1);
});

test("an exit before the deadline clears it, and close stops what still runs", async () => {
  const { shells, notifications, file } = await setup();
  const quick = fakeShell(await file("d.output"));
  shells.adopt(quick.shell, {
    id: "bdddddddd",
    command: "true",
    description: "true",
    deadlineMs: 30,
  });
  quick.exit(0);
  await until(() => notifications.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(notifications.length, 1);
  const slow = fakeShell(await file("e.output"));
  shells.adopt(slow.shell, { id: "beeeeeeee", command: "x", description: "x" });
  await shells.close();
  assert.equal(shells.get("beeeeeeee")?.status, "killed");
  assert.equal(
    await readFile(shells.get("beeeeeeee")?.outputFile ?? "", "utf8"),
    "\n[killed]\n",
  );
  assert.equal(notifications.length, 1);
});

test("a trailer that cannot be written is a diagnostic, not a failure", async () => {
  const { shells, notifications, diagnostics, dir } = await setup();
  const missing = fakeShell(path.join(dir, "gone", "f.output"));
  shells.adopt(missing.shell, {
    id: "bffffffff",
    command: "x",
    description: "x",
  });
  missing.exit(0);
  await until(() => notifications.length >= 1 && diagnostics.length >= 1);
  assert.equal(notifications.length, 1);
  assert.match(
    diagnostics[0] ?? "",
    /^Background shell bffffffff: output trailer failed/,
  );
});
