import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import type { BackgroundTaskSnapshot } from "../../src/background-agent-runtime.js";
import { newSession, SessionStore } from "../../src/session.js";

async function store() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-session-")));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const home = join(cwd, "home");
  return { cwd, home, store: await SessionStore.create(cwd, home) };
}
async function sessionDirectory(home: string) {
  const [project] = await readdir(join(home, "sessions"));
  assert.ok(project);
  return join(home, "sessions", project);
}
const snapshot = (
  sessionId: string,
  messages: BackgroundTaskSnapshot["messages"],
): BackgroundTaskSnapshot => ({
  id: "task-1",
  agentId: "agent-1",
  sessionId,
  type: "local_agent",
  status: "running",
  spawnDepth: 1,
  agentType: "owned",
  description: "Owned task",
  prompt: "Do it",
  model: "test-model",
  outputFile: "/tmp/agent-1.output",
  isBackgrounded: true,
  startTime: 1,
  settled: false,
  notification: "none",
  messages,
  progress: {
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    streamedTokenEstimate: 0,
    toolsInFlight: 0,
  },
});

test("a background task without messages writes an empty output file and an oversized one preserves both files", async () => {
  const { store: sessions } = await store();
  const parent = randomUUID();
  await sessions.saveBackgroundTask(snapshot(parent, []));
  const output = sessions.backgroundOutputPathFor(parent, "agent-1"),
    task = output.replace(/\.output$/, ".task.json");
  assert.equal(await readFile(output, "utf8"), "");
  const saved = await readFile(task, "utf8");
  await assert.rejects(
    sessions.saveBackgroundTask(
      snapshot(parent, [
        {
          role: "user",
          content: [{ type: "text", text: "x".repeat(32 * 1024 * 1024) }],
        },
      ]),
    ),
    /exceeds 32 MiB; previous files preserved/,
  );
  assert.equal(await readFile(output, "utf8"), "");
  assert.equal(await readFile(task, "utf8"), saved);
});

test("loading refuses a session path that is a directory", async () => {
  const { cwd, home, store: sessions } = await store();
  await sessions.save(newSession(cwd, "test-model"));
  const id = randomUUID();
  await mkdir(join(await sessionDirectory(home), `${id}.json`));
  await assert.rejects(sessions.load(id), /regular file under 32 MiB/);
});

test("loading refuses a file whose session id differs from its name", async () => {
  const { cwd, home, store: sessions } = await store();
  const session = newSession(cwd, "test-model");
  await sessions.save(session);
  const renamed = randomUUID();
  await writeFile(
    join(await sessionDirectory(home), `${renamed}.json`),
    await readFile(sessions.pathFor(session.id), "utf8"),
  );
  assert.equal((await sessions.load(session.id)).id, session.id);
  await assert.rejects(
    sessions.load(renamed),
    /identity or working directory mismatch/,
  );
});

test("latest reports no sessions once every saved session is gone", async () => {
  const { cwd, store: sessions } = await store();
  const session = newSession(cwd, "test-model");
  await sessions.save(session);
  await rm(sessions.pathFor(session.id));
  await assert.rejects(sessions.latest(), /No saved sessions/);
});

test("latest surfaces a session directory that cannot be listed", async () => {
  const { cwd, home, store: sessions } = await store();
  await sessions.save(newSession(cwd, "test-model"));
  const directory = await sessionDirectory(home);
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  await assert.rejects(sessions.latest(), { code: "ENOTDIR" });
});
