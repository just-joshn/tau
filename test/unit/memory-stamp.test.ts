import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import {
  memoryNameSlug,
  stampNewMemoryContent,
} from "../../src/memory-stamp.js";
import { createTools } from "../../src/tools.js";
import { ReadState } from "../../src/read-state.js";

const TOPIC = `---
name: user-role
description: the user's role
metadata:
  type: user
---

TAU_AUTO_MEMORY_TOPIC_BODY
`;

const STAMPED = `---
name: user-role
description: "the user's role"
metadata:
  node_type: memory
  type: user
  originSessionId: 52bebf2f-8bcb-433e-a335-a81aedbf9848
  modified: 2026-11-18T22:43:41.729Z
---

TAU_AUTO_MEMORY_TOPIC_BODY
`;

const SESSION_ID = "52bebf2f-8bcb-433e-a335-a81aedbf9848";
const MODIFIED = "2026-11-18T22:43:41.729Z";

test("a new memory file gets node_type, originSessionId and modified", () => {
  const stamped = stampNewMemoryContent({
    content: TOPIC,
    sessionId: SESSION_ID,
    modified: MODIFIED,
  });
  assert.equal(stamped, STAMPED);
});

test("MEMORY.md index lines without frontmatter are unchanged", () => {
  const index = "- [User role](user_role.md) — TAU_AUTO_MEMORY_INDEX_LINE\n";
  assert.equal(
    stampNewMemoryContent({ content: index, sessionId: "x" }),
    index,
  );
});

test("an already-stamped file is left alone", () => {
  const once = stampNewMemoryContent({
    content: TOPIC,
    sessionId: "first",
    modified: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(
    stampNewMemoryContent({
      content: once,
      sessionId: "second",
      modified: "2026-02-02T00:00:00.000Z",
    }),
    once,
  );
});

test("memory names are kebab-slugged", () => {
  assert.equal(memoryNameSlug("User Role"), "user-role");
  assert.equal(memoryNameSlug("user-role"), "user-role");
});

function memoryRewrite(memory: string) {
  const root = memory.endsWith(path.sep) ? memory : memory + path.sep;
  return (request: {
    path: string;
    content: string;
    previous: string | null;
  }) => {
    if (request.previous !== null) return request.content;
    if (!request.path.endsWith(".md") || !request.path.startsWith(root))
      return request.content;
    return stampNewMemoryContent({
      content: request.content,
      sessionId: SESSION_ID,
      modified: MODIFIED,
    });
  };
}

async function memoryEditor() {
  const base = await mkdtemp(path.join(os.tmpdir(), "tau-memory-stamp-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  await mkdir(root, { recursive: true });
  const cwd = await realpath(root);
  const memory = path.join(cwd, "memory");
  await mkdir(memory, { recursive: true });
  const tools = createTools({
    cwd,
    mode: "bypassPermissions",
    readState: new ReadState(),
    approve: async () => true,
    rewriteMemoryContent: memoryRewrite(memory),
  });
  const run = (name: string, input: Record<string, unknown>) =>
    tools.execute(
      { type: "tool_use", id: "test", name, input },
      new AbortController().signal,
    );
  return { memory, run };
}

test("Edit stamps a new auto-memory file when Write would", async () => {
  const { memory, run } = await memoryEditor();
  const created = await run("Edit", {
    file_path: "memory/user-role.md",
    old_string: "",
    new_string: TOPIC,
  });
  assert.equal(created.is_error, undefined);
  assert.equal(created.content, "File edited");
  assert.equal(
    await readFile(path.join(memory, "user-role.md"), "utf8"),
    STAMPED,
  );

  const outside = await run("Edit", {
    file_path: "notes.md",
    old_string: "",
    new_string: TOPIC,
  });
  assert.equal(outside.is_error, undefined);
  assert.equal(
    await readFile(path.join(memory, "..", "notes.md"), "utf8"),
    TOPIC,
  );

  const index =
    "- [User role](user_role.md) \u2014 TAU_AUTO_MEMORY_INDEX_LINE\n";
  const memoryIndex = await run("Edit", {
    file_path: "memory/MEMORY.md",
    old_string: "",
    new_string: index,
  });
  assert.equal(memoryIndex.is_error, undefined);
  assert.equal(await readFile(path.join(memory, "MEMORY.md"), "utf8"), index);
});

test("Edit of an existing auto-memory file stays unstamped when Write would", async () => {
  const { memory, run } = await memoryEditor();
  const file = path.join(memory, "user-role.md");
  await writeFile(file, TOPIC);
  assert.equal(
    (await run("Read", { file_path: "memory/user-role.md" })).is_error,
    undefined,
  );
  const edited = await run("Edit", {
    file_path: "memory/user-role.md",
    old_string: "TAU_AUTO_MEMORY_TOPIC_BODY",
    new_string: "UPDATED_BODY",
  });
  assert.equal(edited.is_error, undefined);
  const text = await readFile(file, "utf8");
  assert.match(text, /UPDATED_BODY/);
  assert.doesNotMatch(text, /originSessionId/);
});

test("Write still stamps a new auto-memory file", async () => {
  const { memory, run } = await memoryEditor();
  const written = await run("Write", {
    file_path: "memory/user-role.md",
    content: TOPIC,
  });
  assert.equal(written.is_error, undefined);
  assert.equal(
    await readFile(path.join(memory, "user-role.md"), "utf8"),
    STAMPED,
  );
});
