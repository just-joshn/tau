// Cancellation (INV-11) and concurrent-run isolation (INV-14) of the real CLI.
// Signals go to the CLI's whole process group, as a terminal's Ctrl-C does.
import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCli, type CliRun } from "../helpers/cli-harness.js";
import { startMockProvider } from "../helpers/mock-provider.js";
import { sentinel } from "../helpers/sentinels.js";

const posixOnly = process.platform === "win32";

const resultSchema = z.object({
  type: z.literal("result"),
  session_id: z.uuid(),
  result: z.string(),
  is_error: z.boolean(),
  error: z.string().optional(),
});

const answer = (text: string) => ({
  kind: "turn" as const,
  content: [{ type: "text" as const, text }],
  stopReason: "end_turn" as const,
});

async function waitFor(
  what: string,
  ready: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the CLI and sends SIGINT to its process group once `ready` holds.
 * Returns the run and how long the CLI took to exit after the first signal.
 */
async function interruptWhen(
  start: (onSpawn: (child: ChildProcess) => void) => Promise<CliRun>,
  ready: () => boolean,
  signals = 1,
): Promise<{ run: CliRun; exitMs: number }> {
  let pid: number | undefined;
  const running = start((child) => {
    pid = child.pid;
  });
  await waitFor("the interrupt point", ready);
  assert.ok(pid !== undefined);
  const sent = performance.now();
  for (let count = 0; count < signals; count++) process.kill(-pid, "SIGINT");
  const run = await running;
  return { run, exitMs: performance.now() - sent };
}

/** A directory a Bash tool or hook writes pids into, reaped after the test. */
function pidDirectory(): {
  dir: string;
  pid: (name: string) => number | undefined;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tau-pids-")));
  const pid = (name: string) => {
    const path = join(dir, name);
    if (!existsSync(path)) return undefined;
    const value = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  onTestFinished(() => {
    for (const name of readdirSync(dir)) {
      const leftover = pid(name);
      if (leftover !== undefined && alive(leftover))
        process.kill(leftover, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, pid };
}

/** Backgrounds a child that backgrounds a long sleep, recording both pids. */
const PROCESS_TREE =
  `sh -c 'sleep 300 & echo $! > "$PID_DIR/grandchild.pid"; wait' & ` +
  `echo $! > "$PID_DIR/child.pid"; wait`;

function sessionFiles(stateRoot: string): string[] {
  const sessions = join(stateRoot, "sessions");
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test.skipIf(posixOnly)(
  "INV-11 SIGINT during a hung stream exits 1 promptly with no further requests",
  async () => {
    const provider = await startMockProvider([{ kind: "hang" }]);
    const { run, exitMs } = await interruptWhen(
      (onSpawn) => runCli({ args: ["-p", "wait for me"], provider, onSpawn }),
      () => provider.requests.length === 1,
    );
    assert.equal(run.timedOut, false);
    assert.equal(run.exitCode, 1, run.stderr);
    assert.ok(exitMs < 2_000, `exited ${exitMs}ms after SIGINT`);
    assert.equal(run.stdout, "\n");
    assert.equal(run.stderr, "\nCancelling…\ntau: Interrupted\n");
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.unexpected, 0);

    // The interrupted session is saved whole and nothing temporary remains.
    const state = join(run.root, "state");
    const files = sessionFiles(state);
    assert.equal(files.length, 1, files.join("\n"));
    assert.ok(files[0]?.endsWith(".json"));
    assert.ok(readFileSync(files[0] ?? "", "utf8").includes("wait for me"));
    assert.deepEqual(readdirSync(join(run.root, "tmp")), []);
  },
);

test.skipIf(posixOnly)(
  "INV-11 repeated SIGINT still yields one JSON result and exit 1",
  async () => {
    const provider = await startMockProvider([{ kind: "hang" }]);
    const { run, exitMs } = await interruptWhen(
      (onSpawn) =>
        runCli({
          args: ["-p", "hi", "--output-format", "json"],
          provider,
          onSpawn,
        }),
      () => provider.requests.length === 1,
      3,
    );
    assert.equal(run.exitCode, 1, run.stderr);
    assert.ok(exitMs < 2_000, `exited ${exitMs}ms after SIGINT`);
    assert.equal(run.stdout.trimEnd().split("\n").length, 1);
    const result = resultSchema.parse(JSON.parse(run.stdout));
    assert.equal(result.is_error, true);
    assert.equal(result.error, "Interrupted");
    assert.match(run.stderr, /^(\nCancelling…\n)+$/);
    assert.equal(provider.requests.length, 1);
  },
);

test.skipIf(posixOnly)(
  "INV-11 SIGINT during a Bash tool reaps its child and grandchild and asks nothing more",
  async () => {
    const pids = pidDirectory();
    const provider = await startMockProvider([
      {
        kind: "turn",
        content: [
          {
            type: "tool_use",
            id: "bash_1",
            name: "Bash",
            input: { command: PROCESS_TREE },
          },
        ],
        stopReason: "tool_use",
      },
      // A request after cancellation would be recorded here.
      { kind: "hang" },
    ]);
    const treeRunning = () => {
      const child = pids.pid("child.pid");
      const grandchild = pids.pid("grandchild.pid");
      return (
        child !== undefined &&
        grandchild !== undefined &&
        alive(child) &&
        alive(grandchild)
      );
    };
    const { run, exitMs } = await interruptWhen(
      (onSpawn) =>
        runCli({
          args: ["-p", "run it", "--allowed-tools", "Bash"],
          provider,
          env: { PID_DIR: pids.dir },
          onSpawn,
        }),
      treeRunning,
    );
    assert.equal(run.exitCode, 1, run.stderr);
    assert.ok(exitMs < 2_000, `exited ${exitMs}ms after SIGINT`);
    assert.match(
      run.stderr,
      /\[tool error\] Bash aborted\ntau: Interrupted\n$/,
    );
    assert.equal(provider.requests.length, 1);

    const child = pids.pid("child.pid");
    const grandchild = pids.pid("grandchild.pid");
    assert.ok(child !== undefined && grandchild !== undefined);
    await waitFor(
      "the Bash process tree to exit",
      () => !alive(child) && !alive(grandchild),
      3_000,
    );
  },
);

test.skipIf(posixOnly)(
  "INV-11 SIGINT during a SessionStart hook reaps the hook and sends no request",
  async () => {
    const pids = pidDirectory();
    const settings = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "/bin/sh",
                args: [
                  "-c",
                  'sleep 300 & echo $! > "$PID_DIR/hook-child.pid"; wait',
                ],
              },
            ],
          },
        ],
      },
    });
    const provider = await startMockProvider([answer("must not be requested")]);
    const hookRunning = () => {
      const hookChild = pids.pid("hook-child.pid");
      return hookChild !== undefined && alive(hookChild);
    };
    const { run, exitMs } = await interruptWhen(
      (onSpawn) =>
        runCli({
          args: ["-p", "hi", "--settings", settings],
          provider,
          env: { PID_DIR: pids.dir },
          onSpawn,
        }),
      hookRunning,
    );
    assert.equal(run.exitCode, 1, run.stderr);
    assert.ok(exitMs < 2_000, `exited ${exitMs}ms after SIGINT`);
    assert.equal(run.stdout, "");
    // Pinned: this path reports the AbortError text, not "Interrupted".
    assert.equal(
      run.stderr,
      "\nCancelling…\ntau: The operation was aborted.\n",
    );
    assert.equal(provider.requests.length, 0);
    const hookChild = pids.pid("hook-child.pid");
    assert.ok(hookChild !== undefined);
    await waitFor("the hook process to exit", () => !alive(hookChild), 3_000);
  },
);

interface Marks {
  prompt: string;
  file: string;
  answer: string;
  key: string;
}

function marksFor(index: number): Marks {
  return {
    prompt: sentinel(`PROMPT_${index}`),
    file: sentinel(`FILE_${index}`),
    answer: sentinel(`ANSWER_${index}`),
    key: sentinel(`API_KEY_${index}`),
  };
}

/** A Read of the run's own workspace file, then an answer naming its marks. */
function scriptFor(marks: Marks) {
  return [
    {
      kind: "turn" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "read_own",
          name: "Read",
          input: { file_path: "own.txt" },
        },
      ],
      stopReason: "tool_use" as const,
    },
    answer(`answer ${marks.answer}`),
  ];
}

function assertOnlyOwn(
  label: string,
  text: string,
  own: Marks,
  all: readonly Marks[],
): void {
  for (const other of all) {
    if (other === own) continue;
    for (const mark of [other.prompt, other.file, other.answer, other.key])
      assert.ok(!text.includes(mark), `${label} holds another run's ${mark}`);
  }
  assert.ok(!text.includes(own.key), `${label} holds its API key`);
}

test("INV-14 eight concurrent sessions with separate homes keep outputs, requests and session files apart", async () => {
  const all = Array.from({ length: 8 }, (_, index) => marksFor(index));
  const runs = await Promise.all(
    all.map(async (marks) => {
      const provider = await startMockProvider(scriptFor(marks));
      const run = await runCli({
        args: ["-p", `task ${marks.prompt}`, "--output-format", "json"],
        provider,
        env: { ANTHROPIC_API_KEY: marks.key },
        files: { "own.txt": `${marks.file}\n` },
        deadlineMs: 30_000,
      });
      return { own: marks, provider, run };
    }),
  );
  for (const [index, { own, provider, run }] of runs.entries()) {
    assert.equal(run.exitCode, 0, run.stderr);
    const result = resultSchema.parse(JSON.parse(run.stdout));
    assert.equal(result.result, `answer ${own.answer}`);
    assertOnlyOwn(`run ${index} output`, run.stdout + run.stderr, own, all);

    assert.equal(provider.requests.length, 2);
    assert.equal(provider.unexpected, 0);
    for (const request of provider.requests) {
      assert.equal(request.headers["x-api-key"], own.key);
      const body = JSON.stringify(request.body);
      assert.ok(body.includes(own.prompt));
      assertOnlyOwn(`provider ${index} request`, body, own, all);
    }
    assert.ok(JSON.stringify(provider.requests[1]?.body).includes(own.file));

    const files = sessionFiles(join(run.root, "state"));
    assert.equal(files.length, 1, files.join("\n"));
    const session = readFileSync(files[0] ?? "", "utf8");
    assert.ok(files[0]?.endsWith(`${result.session_id}.json`));
    for (const mark of [own.prompt, own.file, own.answer])
      assert.ok(session.includes(mark), `session ${index} lacks ${mark}`);
    assertOnlyOwn(`session ${index}`, session, own, all);
  }
}, 60_000);

test("INV-14 concurrent sessions in one project and TAU_HOME get separate session files", async () => {
  const shared = realpathSync(mkdtempSync(join(tmpdir(), "tau-shared-")));
  onTestFinished(() => rmSync(shared, { recursive: true, force: true }));
  const all = Array.from({ length: 4 }, (_, index) => marksFor(index));
  const runs = await Promise.all(
    all.map(async (marks) => {
      const provider = await startMockProvider([
        answer(`answer ${marks.answer}`),
      ]);
      const run = await runCli({
        args: [
          "-p",
          `task ${marks.prompt}`,
          "--output-format",
          "json",
          "--cwd",
          shared,
        ],
        provider,
        env: { ANTHROPIC_API_KEY: marks.key, TAU_HOME: join(shared, ".tau") },
        deadlineMs: 30_000,
      });
      return { own: marks, run };
    }),
  );
  const files = sessionFiles(join(shared, ".tau"));
  assert.equal(files.length, all.length, files.join("\n"));
  for (const [index, { own, run }] of runs.entries()) {
    assert.equal(run.exitCode, 0, run.stderr);
    const { session_id: id } = resultSchema.parse(JSON.parse(run.stdout));
    const file = files.find((path) => path.endsWith(`${id}.json`));
    assert.ok(file !== undefined, `no session file for run ${index}`);
    const session = readFileSync(file, "utf8");
    assert.ok(session.includes(own.prompt) && session.includes(own.answer));
    assertOnlyOwn(`session ${index}`, session, own, all);
  }
}, 60_000);
