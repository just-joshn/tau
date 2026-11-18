import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import { parseOptions } from "../src/options.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { newSession, SessionStore } from "../src/session.js";

const archiveFileSchema = z.object({
  messages: z.unknown(),
  status: z.string(),
});

test("session roundtrip, latest, permissions and project isolation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tau-session-"));
  onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const cwd = await realpath(temp);
  const home = join(cwd, "home");
  const store = await SessionStore.create(cwd, home);
  await assert.rejects(store.latest(), /No saved sessions/);
  const first = newSession(cwd, "test-model");
  first.messages.push({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  await store.save(first);
  const loaded = await store.load(first.id);
  assert.deepEqual(loaded.messages, first.messages);
  assert.equal((await store.latest()).id, first.id);
  const project = (await readdir(join(home, "sessions")))[0];
  assert.ok(project);
  const file = join(home, "sessions", project, `${first.id}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(store.load("../../etc/passwd"));
  await writeFile(file, "{}");
  await assert.rejects(store.load(first.id));
  await store.save(first);
  const other = join(cwd, "other");
  await mkdir(other);
  const otherStore = await SessionStore.create(other, home);
  await assert.rejects(otherStore.load(first.id));
  await assert.rejects(otherStore.save(first), /another working directory/);
  assert.ok((await readFile(file, "utf8")).includes("hello"));
  first.messages.push({
    role: "user",
    content: [{ type: "text", text: "x".repeat(32 * 1024 * 1024) }],
  });
  await assert.rejects(
    store.save(first),
    /previous saved session was preserved/,
  );
  assert.deepEqual((await store.load(first.id)).messages, loaded.messages);
});

test("child archives preserve isolated history without replacing latest parent session", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tau-subagent-archive-"));
  onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const cwd = await realpath(temp),
    store = await SessionStore.create(cwd, join(cwd, "state")),
    parent = newSession(cwd, "parent");
  await store.save(parent);
  const archive = {
    version: 1 as const,
    parentSessionId: parent.id,
    agentId: "agent-owned",
    agentType: "reader",
    cwd,
    model: "child",
    updatedAt: new Date().toISOString(),
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "isolated task" }],
      },
    ],
    status: "running" as const,
  };
  await store.saveSubagent(archive);
  const path = store.subagentPathFor(parent.id, archive.agentId);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const saved = archiveFileSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  assert.deepEqual(saved.messages, archive.messages);
  assert.equal((await store.latest()).id, parent.id);
  assert.deepEqual((await store.load(parent.id)).messages, []);
  await store.saveSubagent({ ...archive, status: "completed" });
  assert.equal(
    archiveFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).status,
    "completed",
  );
  assert.throws(() => store.subagentPathFor(parent.id, "../../parent"));
  await assert.rejects(
    store.saveSubagent({ ...archive, cwd: join(cwd, "other") }),
    /another working directory/,
  );
  await assert.rejects(
    store.saveSubagent({
      ...archive,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "x".repeat(32 * 1024 * 1024) }],
        },
      ],
    }),
    /previous archive was preserved/,
  );
  assert.equal(
    archiveFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).status,
    "completed",
  );
});

test("project instructions bounded and external symlinks refused", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tau-prompt-"));
  onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const cwd = join(temp, "project");
  await mkdir(cwd);
  assert.match(await buildSystemPrompt(cwd), /independent coding assistant/);
  await writeFile(join(cwd, "CLAUDE.md"), "Use tabs.");
  assert.match(
    await buildSystemPrompt(cwd, "replacement", "appendix"),
    /^replacement[\s\S]*Use tabs.[\s\S]*appendix$/,
  );
  await writeFile(join(cwd, "CLAUDE.md"), "x".repeat(65537));
  await assert.rejects(buildSystemPrompt(cwd), /64 KiB/);
  await rm(join(cwd, "CLAUDE.md"));
  await writeFile(join(temp, "outside"), "private");
  await symlink(join(temp, "outside"), join(cwd, "CLAUDE.md"));
  await assert.rejects(buildSystemPrompt(cwd), /outside/);
});

test("CLI options fail closed on invalid modes and conflicting settings", () => {
  assert.equal(parseOptions(["-p", "hello", "world"]).prompt, "hello world");
  assert.equal(
    parseOptions(["--dangerously-skip-permissions"]).mode,
    "bypassPermissions",
  );
  for (const args of [
    ["--permission-mode", "yes"],
    ["--max-turns", "0"],
    ["--max-tokens", "NaN"],
    ["--resume", "id", "--continue"],
    ["--unknown"],
    ["--dangerously-skip-permissions", "--permission-mode", "plan"],
  ]) {
    assert.throws(() => parseOptions(args));
  }
});

test("reasoning signatures, redacted blocks and partial/fallback metadata survive session roundtrip", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tau-reasoning-session-"));
  onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const cwd = await realpath(temp),
    store = await SessionStore.create(cwd, join(cwd, "state"));
  const session = newSession(cwd, "primary");
  session.messages.push({
    role: "assistant",
    model: "fallback",
    partial: { cause: "truncated" },
    content: [
      {
        type: "thinking",
        thinking: "reason",
        signature: "opaque-signed-value",
      },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Retained" },
    ],
  });
  await store.save(session);
  assert.deepEqual((await store.load(session.id)).messages, session.messages);
  const bad = structuredClone(session);
  const content = bad.messages[0]?.content;
  assert.ok(Array.isArray(content));
  Reflect.set(content[0] ?? assert.fail("missing block"), "signature", 42);
  await assert.rejects(store.save(bad));
  assert.deepEqual((await store.load(session.id)).messages, session.messages);
});
