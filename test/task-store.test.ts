import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createLocalTaskStore,
  localTaskListIdentity,
  mergeTaskMetadata,
  sanitizeTaskIdentity,
} from "../src/task-store.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "tau-task-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("explicit scoped store persists independent numeric tasks and high water prevents reuse after deletion", async (t) => {
  const root = await fixture(t),
    store = createLocalTaskStore({ root, listId: "owned" });
  const first = await store.create({ subject: "first", description: "owned" }),
    second = await store.create({ subject: "second", description: "owned" });
  assert.equal(first.id, "1");
  assert.equal(second.id, "2");
  assert.equal(first.status, "pending");
  assert.equal(first.owner, undefined);
  await store.addDependency("1", "2");
  await store.delete("1");
  assert.deepEqual((await store.get("2"))!.blockedBy, []);
  await store.delete("2");
  const reopened = createLocalTaskStore({ root, listId: "owned" });
  assert.equal(
    (await reopened.create({ subject: "next", description: "owned" })).id,
    "3",
  );
  assert.equal(
    (await readFile(join(store.directory, ".highwatermark"), "utf8")).trim(),
    "2",
  );
  assert.deepEqual(
    await createLocalTaskStore({ root, listId: "other" }).list(),
    [],
  );
});
test("reciprocal dependencies allow cycles and self edges, retain completed links and ignore missing targets", async (t) => {
  const root = await fixture(t),
    store = createLocalTaskStore({ root, listId: "owned" });
  await store.create({ subject: "one", description: "owned" });
  await store.create({ subject: "two", description: "owned" });
  assert.equal(await store.addDependency("1", "missing"), false);
  await store.addDependency("1", "2");
  await store.addDependency("2", "1");
  await store.addDependency("1", "1");
  await store.addDependency("1", "2");
  assert.deepEqual((await store.get("1"))!.blocks, ["2", "1"]);
  assert.deepEqual((await store.get("1"))!.blockedBy, ["2", "1"]);
  await store.update("1", { status: "completed" });
  assert.deepEqual((await store.get("2"))!.blockedBy, ["1"]);
  await store.update("1", { status: "pending" });
  assert.equal((await store.get("1"))!.status, "pending");
});
test("separate process writers coordinate allocation and leave regular JSON records", async (t) => {
  const root = await fixture(t),
    module = new URL("../src/task-store.js", import.meta.url).href;
  const script = `import {createLocalTaskStore} from ${JSON.stringify(module)};const store=createLocalTaskStore({root:${JSON.stringify(root)},listId:'shared'});for(let i=0;i<8;i++)await store.create({subject:'owned',description:'worker'});`;
  await Promise.all(
    [1, 2, 3].map(() =>
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        script,
      ]),
    ),
  );
  const tasks = await createLocalTaskStore({ root, listId: "shared" }).list();
  assert.equal(tasks.length, 24);
  assert.deepEqual(
    tasks.map((task) => Number(task.id)),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
});
test("malformed, oversized and symlink task files stay unreadable while allocation scans numeric prefixes", async (t) => {
  const root = await fixture(t),
    store = createLocalTaskStore({ root, listId: "owned", maxFileBytes: 512 });
  await mkdir(store.directory);
  await writeFile(join(store.directory, "1.json"), "{broken");
  await writeFile(join(store.directory, "8-bad.json"), "x".repeat(600));
  const outside = join(root, "outside.json");
  await writeFile(
    outside,
    JSON.stringify({
      id: "7",
      subject: "outside",
      description: "owned",
      status: "pending",
      blocks: [],
      blockedBy: [],
    }),
  );
  await symlink(outside, join(store.directory, "7.json"));
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get("../../outside"), null);
  const task = await store.create({
    subject: "after corrupt",
    description: "owned",
  });
  assert.equal(task.id, "9");
  await assert.rejects(
    store.update("9", { description: "x".repeat(1000) }),
    /bound/,
  );
  assert.equal((await store.get("9"))!.description, "owned");
  assert.equal(JSON.parse(await readFile(outside, "utf8")).subject, "outside");
});
test("identity and metadata merging keep explicit scope and shallow null deletion", () => {
  assert.equal(sanitizeTaskIdentity("a/../b:💡"), "a----b---");
  assert.equal(
    localTaskListIdentity({
      environmentListId: "env",
      sessionListId: "session-list",
      sessionId: "session",
    }),
    "env",
  );
  assert.equal(
    localTaskListIdentity({ ownTaskListId: "own", sessionId: "session" }),
    "own",
  );
  assert.equal(localTaskListIdentity({ sessionId: "session" }), "session");
  const merged = mergeTaskMetadata(
    { keep: 1, remove: 2, nested: { before: true } },
    JSON.parse(
      '{"remove":null,"nested":{"after":true},"__proto__":{"polluted":true}}',
    ),
  );
  assert.equal(merged.remove, undefined);
  assert.deepEqual(merged.nested, { after: true });
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
  assert.equal(({} as any).polluted, undefined);
  assert.throws(
    () => createLocalTaskStore({ root: "relative", listId: "id" }),
    /absolute/,
  );
});
