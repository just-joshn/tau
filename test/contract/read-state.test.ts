import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, onTestFinished } from "bun:test";
import { createTools } from "../../src/tools.js";
import { ReadState } from "../../src/read-state.js";
import { writeAtomic } from "../../src/write.js";
import type { PermissionMode } from "../../src/types.js";

async function fixture(
  mode: PermissionMode = "bypassPermissions",
  approve: () => Promise<boolean> = async () => true,
) {
  const cwd = await realpath(
    await mkdtemp(path.join(tmpdir(), "tau-read-state-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "a");
  await writeFile(file, "one\ntwo\n");
  const tools = createTools({ cwd, mode, approve });
  const run = (name: string, input: Record<string, unknown>) =>
    tools.execute(
      { type: "tool_use", id: "test", name, input },
      new AbortController().signal,
    );
  const read = (input = {}) => run("Read", { file_path: "a", ...input });
  const edit = () =>
    run("Edit", { file_path: "a", old_string: "one", new_string: "ONE" });
  const write = () => run("Write", { file_path: "a", content: "replacement" });
  return { cwd, file, tools, run, read, edit, write };
}

test("existing files require a complete Read in every write-capable permission mode", async () => {
  for (const mode of [
    "default",
    "acceptEdits",
    "bypassPermissions",
  ] satisfies PermissionMode[]) {
    const f = await fixture(mode);
    for (const result of [await f.edit(), await f.write()]) {
      assert.equal(result.is_error, true);
      assert.match(result.content, /Read.*before/i);
    }
    assert.equal(await readFile(f.file, "utf8"), "one\ntwo\n");
    assert.deepEqual(await readdir(f.cwd), ["a"]);
  }
});

test("complete Reads allow edits, writes, and consecutive changes made by tau", async () => {
  const f = await fixture();
  assert.equal((await f.read()).is_error, undefined);
  assert.equal((await f.edit()).content, "File edited");
  assert.equal((await f.write()).content, "File written");
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "a",
        old_string: "replacement",
        new_string: "done",
      })
    ).content,
    "File edited",
  );
  assert.equal(await readFile(f.file, "utf8"), "done");
  assert.equal(
    (await f.run("Write", { file_path: "new/nested", content: "created" }))
      .content,
    "File written",
  );
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "new/nested",
        old_string: "created",
        new_string: "edited",
      })
    ).content,
    "File edited",
  );
});

test("partial and concatenated paginated Reads never authorize overwrites", async () => {
  const f = await fixture();
  for (const input of [
    { limit: 1 },
    { offset: 2 },
    { offset: 3, limit: 1 },
    { limit: 3 },
  ]) {
    assert.equal((await f.read(input)).is_error, undefined);
    assert.equal((await f.edit()).is_error, true);
    assert.equal((await f.write()).is_error, true);
  }
  assert.equal((await f.read({ limit: 4 })).is_error, undefined);
  assert.equal((await f.edit()).content, "File edited");
});

test("offset zero and empty complete Reads authorize a write", async () => {
  const f = await fixture();
  await f.read({ offset: 0 });
  assert.equal((await f.edit()).content, "File edited");
  await writeFile(f.file, "");
  assert.equal((await f.read()).content, "[empty file]");
  assert.equal((await f.write()).content, "File written");
});

test("token-truncated Read does not authorize writes, while complete numbered output can exceed 64KiB", async () => {
  const f = await fixture();
  await writeFile(f.file, "x".repeat(100004));
  assert.match((await f.read()).content, /truncated by token limit/);
  assert.equal((await f.write()).is_error, true);
  await writeFile(f.file, "a\n".repeat(15000));
  const result = await f.read();
  assert.doesNotMatch(result.content, /truncated/);
  assert.ok(Buffer.byteLength(result.content) > 65536);
  assert.equal((await f.write()).content, "File written");
});

test("a partial Read supersedes a previously complete Read", async () => {
  const f = await fixture();
  await f.read();
  await f.read({ limit: 1 });
  assert.equal((await f.write()).is_error, true);
  await f.read();
  assert.equal((await f.write()).content, "File written");
});

test("external changes are rejected even if the replacement still applies", async () => {
  const f = await fixture();
  await f.read();
  await writeFile(f.file, "one\nexternal\n");
  assert.match((await f.edit()).content, /changed.*Read|Read.*again/i);
  assert.equal((await f.write()).is_error, true);
  assert.equal(await readFile(f.file, "utf8"), "one\nexternal\n");
  await f.read();
  assert.equal((await f.edit()).content, "File edited");
});

test("content comparison catches changes with restored or older mtime", async () => {
  const f = await fixture();
  await f.read();
  const info = await stat(f.file);
  await writeFile(f.file, "one\nexternal\n");
  await utimes(f.file, info.atime, new Date(info.mtimeMs - 10000));
  assert.equal((await f.edit()).is_error, true);
  assert.equal((await f.write()).is_error, true);
});

test("mtime-only changes and normalized BOM/CRLF equality allow changes", async () => {
  const f = await fixture();
  await f.read();
  await utimes(f.file, new Date(), new Date(Date.now() + 60000));
  assert.equal((await f.edit()).content, "File edited");
  await f.read();
  await writeFile(f.file, "\uFEFFONE\r\ntwo\r\n");
  assert.equal((await f.write()).content, "File written");
});

test("approval-time modification or creation is checked after the prompt", async () => {
  let mutate = async () => {};
  const f = await fixture("default", async () => {
    await mutate();
    return true;
  });
  await f.read();
  mutate = async () => {
    await writeFile(f.file, "one\nexternal\n");
  };
  assert.equal((await f.edit()).is_error, true);
  assert.equal((await f.write()).is_error, true);
  assert.equal(await readFile(f.file, "utf8"), "one\nexternal\n");
  mutate = async () => {
    await writeFile(path.join(f.cwd, "new"), "external");
  };
  assert.equal(
    (await f.run("Write", { file_path: "new", content: "clobber" })).is_error,
    true,
  );
  assert.equal(await readFile(path.join(f.cwd, "new"), "utf8"), "external");
});

test("failed, binary, and invalid-UTF8 Reads cannot authorize writes", async () => {
  const f = await fixture();
  for (const data of [
    Buffer.from([0]),
    Buffer.from([255]),
    Buffer.from("%PDF-binary"),
  ]) {
    await writeFile(f.file, data);
    assert.equal((await f.read()).is_error, true);
    assert.equal((await f.write()).is_error, true);
    assert.deepEqual(await readFile(f.file), data);
  }
});

test("path spellings share a canonical baseline but distinct files do not", async () => {
  const f = await fixture();
  await f.run("Read", { file_path: f.file });
  assert.equal(
    (
      await f.run("Edit", {
        file_path: "./a",
        old_string: "one",
        new_string: "ONE",
      })
    ).content,
    "File edited",
  );
  await writeFile(path.join(f.cwd, "b"), "ONE\ntwo\n");
  assert.equal(
    (await f.run("Write", { file_path: "b", content: "unread" })).is_error,
    true,
  );
});

test("invalid UTF8 cannot match a cached real replacement character", async () => {
  const f = await fixture();
  await writeFile(f.file, "\uFFFD");
  await f.read();
  await writeFile(f.file, Buffer.from([255]));
  assert.equal((await f.write()).is_error, true);
  assert.deepEqual(await readFile(f.file), Buffer.from([255]));
});

test("shared read state survives new tool executors and fresh state requires rereading", async () => {
  const f = await fixture();
  const readState = new ReadState();
  const executor = (state = readState) =>
    createTools({
      cwd: f.cwd,
      mode: "acceptEdits",
      readState: state,
      approve: async () => false,
    });
  const run = (
    tools: ReturnType<typeof createTools>,
    name: string,
    input: Record<string, unknown>,
  ) =>
    tools.execute(
      { type: "tool_use", id: "x", name, input },
      new AbortController().signal,
    );
  await run(executor(), "Read", { file_path: "a" });
  assert.equal(
    (
      await run(executor(), "Edit", {
        file_path: "a",
        old_string: "one",
        new_string: "ONE",
      })
    ).content,
    "File edited",
  );
  assert.equal(
    (
      await run(executor(new ReadState()), "Write", {
        file_path: "a",
        content: "no",
      })
    ).is_error,
    true,
  );
});

test("the atomic writer discards its temp file when the final recheck rejects", async () => {
  const f = await fixture();
  await assert.rejects(
    writeAtomic(f.file, "proposal", async () => {
      await writeFile(f.file, "external");
      throw new Error("changed");
    }),
    /changed/,
  );
  assert.equal(await readFile(f.file, "utf8"), "external");
  assert.deepEqual(await readdir(f.cwd), ["a"]);
});
