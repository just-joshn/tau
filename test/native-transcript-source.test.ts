import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeTranscriptSourceError,
  readNativeTranscriptSource,
  recheckNativeTranscriptSource,
} from "../src/native-transcript-source.js";

const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-native-source-")),
    ),
    directory = join(root, "source");
  await mkdir(directory);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(directory, "explicit.jsonl");
  return { root, directory, path };
}

test("explicit readonly source capture preserves raw bytes, exact stat identity and stable recheck receipt", async () => {
  const f = await fixture(),
    bytes = Buffer.from('\ufeff{"owned":"RAW"}\r\n\n{"unterminated":true}');
  await writeFile(f.path, bytes, { mode: 0o400 });
  const before = await lstat(f.path, { bigint: true });
  const captured = await readNativeTranscriptSource({
    path: f.path,
    signal: signal(),
    admitOpened: (identity) => {
      assert.ok(
        Object.isFrozen(identity) &&
          Object.isFrozen(identity.file) &&
          Object.isFrozen(identity.parent),
      );
      assert.equal(identity.file.inode, String(before.ino));
      assert.equal(identity.file.modifiedNs, String(before.mtimeNs));
      return true;
    },
  });
  assert.deepEqual(captured.bytes, bytes);
  assert.equal(
    captured.receipt.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    (await recheckNativeTranscriptSource(captured.receipt, signal())).receipt,
    captured.receipt,
  );
  captured.bytes.fill(0);
  assert.deepEqual(await readFile(f.path), bytes);
  assert.equal((await lstat(f.path, { bigint: true })).ctimeNs, before.ctimeNs);
});

test("replacement file or parent during identity admission fails before consuming new content", async () => {
  for (const changed of ["leaf", "parent"] as const) {
    const f = await fixture();
    await writeFile(f.path, "ORIGINAL_ADMITTED_BYTES");
    await assert.rejects(
      readNativeTranscriptSource({
        path: f.path,
        signal: signal(),
        admitOpened: async () => {
          if (changed === "leaf")
            await rename(f.path, join(f.root, "retired-original"));
          else {
            await rename(f.directory, join(f.root, "retired-parent"));
            await mkdir(f.directory);
          }
          await writeFile(f.path, "NEW_UNADMITTED_BYTES");
          return true;
        },
      }),
      (error) =>
        error instanceof NativeTranscriptSourceError &&
        error.observation?.stage === "before-content" &&
        error.observation.contentRead === false,
    );
    assert.equal(await readFile(f.path, "utf8"), "NEW_UNADMITTED_BYTES");
  }
});

test("a same-byte replacement inode cannot silently satisfy an earlier source receipt", async () => {
  const f = await fixture();
  await writeFile(f.path, "ACTUAL_SOURCE_BYTES");
  const captured = await readNativeTranscriptSource({
    path: f.path,
    signal: signal(),
  });
  await rename(f.path, join(f.root, "retired-inode"));
  await writeFile(f.path, "ACTUAL_SOURCE_BYTES");
  await assert.rejects(
    recheckNativeTranscriptSource(captured.receipt, signal()),
    (error) =>
      error instanceof NativeTranscriptSourceError &&
      error.observation?.contentRead === false,
  );
  assert.equal(await readFile(f.path, "utf8"), "ACTUAL_SOURCE_BYTES");
});

test("readonly hardlinks are allowed while symlinks, directories, oversized and unadmitted sources are refused", async () => {
  const f = await fixture();
  await writeFile(f.path, "RAW_SOURCE");
  const hardlink = join(f.directory, "hardlink.jsonl"),
    symbolic = join(f.directory, "symlink.jsonl");
  await link(f.path, hardlink);
  await symlink(f.path, symbolic);
  const linked = await readNativeTranscriptSource({
    path: hardlink,
    signal: signal(),
  });
  assert.equal(linked.receipt.file.links, "2");
  assert.equal(linked.bytes.toString(), "RAW_SOURCE");
  for (const path of [symbolic, f.directory])
    await assert.rejects(
      readNativeTranscriptSource({ path, signal: signal() }),
      /regular file/,
    );
  await assert.rejects(
    readNativeTranscriptSource({ path: f.path, signal: signal(), maxBytes: 2 }),
    /byte bound/,
  );
  await assert.rejects(
    readNativeTranscriptSource({
      path: f.path,
      signal: signal(),
      admitOpened: () => false,
    }),
    (error) =>
      error instanceof NativeTranscriptSourceError &&
      error.observation?.contentRead === false,
  );
  assert.equal(await readFile(f.path, "utf8"), "RAW_SOURCE");
});

test("source cancellation and malformed paths/bounds fail without altering the explicit file", async () => {
  const f = await fixture();
  await writeFile(f.path, "UNCHANGED");
  const controller = new AbortController(),
    reason = new Error("ACTUAL_SOURCE_ABORT");
  await assert.rejects(
    readNativeTranscriptSource({
      path: f.path,
      signal: controller.signal,
      admitOpened: () => {
        controller.abort(reason);
        return true;
      },
    }),
    (error) => error === reason,
  );
  await assert.rejects(
    readNativeTranscriptSource({ path: "relative.jsonl", signal: signal() }),
    /absolute/,
  );
  await assert.rejects(
    readNativeTranscriptSource({ path: f.path, signal: signal(), maxBytes: 0 }),
    /byte bound/,
  );
  assert.equal(await readFile(f.path, "utf8"), "UNCHANGED");
});
