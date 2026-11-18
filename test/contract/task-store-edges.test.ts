import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  createLocalTaskStore,
  type LocalTaskStoreOptions,
} from "../../src/task-store.js";

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "tau-task-store-edges-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const task = { subject: "Ship", description: "Ship it" };

test("the constructor rejects every invalid bound", async () => {
  const base = { root: await root(), listId: "list" };
  const cases: [Partial<LocalTaskStoreOptions>, RegExp][] = [
    [{ root: "relative" }, /root must be absolute/],
    [{ listId: "" }, /explicit nonempty list id/],
    [{ maxFileBytes: 0 }, /Invalid task file bound/],
    [{ maxFileBytes: 1.5 }, /Invalid task file bound/],
    [{ lock: { retries: -1 } }, /Invalid task lock retry bound/],
    [{ lock: { retries: 1.5 } }, /Invalid task lock retry bound/],
    [
      { lock: { staleMs: Number.POSITIVE_INFINITY } },
      /Invalid task lock interval/,
    ],
    [{ lock: { staleMs: 0 } }, /Invalid task lock interval/],
    [{ lock: { updateMs: -1 } }, /Invalid task lock interval/],
  ];
  for (const [overrides, message] of cases)
    assert.throws(
      () => createLocalTaskStore({ ...base, ...overrides }),
      message,
    );
});

test("a namespace symlinked to a real task directory is neither read nor written", async () => {
  const directory = await root();
  const real = createLocalTaskStore({ root: directory, listId: "real" });
  await real.create(task);
  await symlink(join(directory, "real"), join(directory, "linked"));
  const linked = createLocalTaskStore({ root: directory, listId: "linked" });
  assert.equal(await linked.get("1"), null);
  await assert.rejects(linked.create(task), /must be a directory/);
  assert.deepEqual(
    (await real.list()).map((entry) => entry.id),
    ["1"],
  );
});

test("a record that is valid JSON but not a task reads as missing", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  await store.create(task);
  await writeFile(join(directory, "list", "2.json"), '{"id":"2"}');
  assert.equal(await store.get("2"), null);
  assert.deepEqual(
    (await store.list()).map((entry) => entry.id),
    ["1"],
  );
});

test("allocation ignores non-numeric names and an unreadable high water mark", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  await mkdir(join(directory, "list"));
  await writeFile(join(directory, "list", ".highwatermark"), "garbage");
  await writeFile(join(directory, "list", "notes.json"), "{}");
  assert.equal((await store.create(task)).id, "1");
});

test("allocation refuses to pass the largest safe integer id", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  await mkdir(join(directory, "list"));
  await writeFile(
    join(directory, "list", ".highwatermark"),
    String(Number.MAX_SAFE_INTEGER),
  );
  await assert.rejects(store.create(task), /Task id space exhausted/);
  assert.deepEqual(
    (await readdir(join(directory, "list"))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );
});

test("updating a missing task returns null and writes nothing", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  assert.equal(await store.update("4", { status: "completed" }), null);
  assert.equal(await store.get("4"), null);
});

test("a repeated self dependency is recorded once", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  await store.create(task);
  assert.equal(await store.addDependency("1", "1"), true);
  assert.equal(await store.addDependency("1", "1"), true);
  const saved = await store.get("1");
  assert.deepEqual(saved?.blocks, ["1"]);
  assert.deepEqual(saved?.blockedBy, ["1"]);
});

test("deleting a lower or non-numeric id keeps the high water mark and leaves unrelated tasks alone", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  for (let index = 0; index < 3; index++) await store.create(task);
  await store.addDependency("1", "2");
  const third = await readFile(join(directory, "list", "3.json"), "utf8");
  assert.equal(await store.delete("2"), true);
  assert.equal(await store.delete("1"), true);
  assert.equal(await store.delete("missing"), false);
  assert.equal(
    await readFile(join(directory, "list", "3.json"), "utf8"),
    third,
  );
  assert.equal((await store.create(task)).id, "4");
});

test("deleting an entry that cannot be unlinked surfaces the error", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  await store.create(task);
  await mkdir(join(directory, "list", "5.json"));
  await assert.rejects(store.delete("5"), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.notEqual(error.code, "ENOENT");
    return true;
  });
});

test("a stale lease is reclaimed and a fresh one makes the store busy", async () => {
  const directory = await root();
  const lease = join(directory, "list", ".lock.lock");
  await mkdir(lease, { recursive: true });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(lease, old, old);
  const store = createLocalTaskStore({
    root: directory,
    listId: "list",
    lock: { retries: 1 },
  });
  assert.equal((await store.create(task)).id, "1");
  await assert.rejects(stat(lease), { code: "ENOENT" });
  await mkdir(lease);
  await assert.rejects(
    store.create(task, new AbortController().signal),
    /Task store lock is busy/,
  );
  assert.ok((await stat(lease)).isDirectory());
  assert.equal(await store.get("2"), null);
});

test("concurrent creates on one store allocate distinct ids", async () => {
  const directory = await root();
  const store = createLocalTaskStore({ root: directory, listId: "list" });
  const created = await Promise.all([
    store.create(task),
    store.create(task),
    store.create(task),
  ]);
  assert.deepEqual(created.map((entry) => entry.id).sort(), ["1", "2", "3"]);
});
