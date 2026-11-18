import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeSessionOwnership,
  NativeSessionOwnershipError,
  type NativeSessionOwnershipOptions,
} from "../../src/native-session-ownership.js";

const SID = "77777777-7777-7777-7777-777777777777";
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-native-ownership-edges-")),
    ),
    directory = join(root, "owned");
  await mkdir(directory, { mode: 0o700 });
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(directory, `${SID}.jsonl`);
  const options: NativeSessionOwnershipOptions = {
    directory,
    path,
    admit: () => true,
  };
  return {
    directory,
    path,
    lockPath: `${path}.lock`,
    acquire: (changes: Partial<NativeSessionOwnershipOptions> = {}) =>
      NativeSessionOwnership.acquire({ ...options, ...changes }, signal()),
  };
}
const missing = (path: string) =>
  assert.rejects(
    lstat(path),
    (error) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
  );

test("ownership needs a canonical directory and a native session filename inside it", async () => {
  const f = await fixture();
  for (const changes of [
    { directory: "owned" },
    { path: join(f.directory, "not-a-session.jsonl") },
    { path: join(f.directory, "nested", `${SID}.jsonl`) },
    { path: `${f.directory}/./${SID}.jsonl` },
  ])
    await assert.rejects(
      f.acquire(changes),
      (error) =>
        error instanceof NativeSessionOwnershipError &&
        /canonical directory and native session filename/.test(error.message),
    );
  await missing(f.lockPath);
});

test("a lock receipt that fails its own verification is removed so the session stays acquirable", async () => {
  const f = await fixture();
  // A restrictive umask creates the receipt read-only, which is not the private 0600 receipt.
  const previous = process.umask(0o277);
  try {
    await assert.rejects(f.acquire(), /Session ownership receipt changed/);
  } finally {
    process.umask(previous);
  }
  await missing(f.lockPath);
  const owner = await f.acquire();
  await owner.close();
  await missing(f.lockPath);
});

test("verifying a transaction outside one is refused", async () => {
  const f = await fixture(),
    owner = await f.acquire();
  await assert.rejects(
    owner.verifyTransaction(f.path),
    /active transaction for this transcript is required/,
  );
  await owner.withExclusiveOwnership(f.path, () =>
    owner.verifyTransaction(f.path),
  );
  await owner.close();
});

test("a refused release keeps the receipt so the session is still owned", async () => {
  const f = await fixture(),
    owner = await f.acquire({ admit: (input) => input.stage !== "release" });
  await assert.rejects(owner.close(), /release admission denied/);
  await lstat(f.lockPath);
  await assert.rejects(f.acquire(), /already owned/);
});
