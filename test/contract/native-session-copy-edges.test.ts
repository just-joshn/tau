import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { copyNativeSessionToOwnedFile } from "../../src/native-session-copy.js";
import { NativeSessionJournal } from "../../src/native-session-journal.js";
import { NativeSessionOwnership } from "../../src/native-session-ownership.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import { recordNativeJsonResponse } from "../../src/native-response-recording.js";

const SID = "55555555-5555-5555-5555-555555555555",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;

async function fixture(sourceTail?: object) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-native-copy-edges-")),
    ),
    sourceDirectory = join(root, "source"),
    directory = join(root, "owned"),
    cwd = join(root, "current");
  for (const path of [sourceDirectory, directory, cwd])
    await mkdir(path, { mode: 0o700 });
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(sourceDirectory, "export.jsonl"),
    path = join(directory, `${SID}.jsonl`);
  let stamps = 0;
  const source = await NativeSessionJournal.open(
    {
      path: sourcePath,
      context: {
        sessionId: SID,
        cwd: sourceDirectory,
        version: "2.1.325",
        userType: "external",
        sidechain: false,
      },
      initial: { kind: "fresh" },
      withExclusiveOwnership: async (_path, work) => work(),
      admit: () => true,
    },
    {
      stamp: () => ({
        uuid: `50000000-0000-0000-0000-${String(++stamps).padStart(12, "0")}`,
        timestamp: "2026-11-18T00:00:00Z",
      }),
    },
    signal(),
  );
  await source.recordUser(
    { role: "user", content: [{ type: "text", text: "EDGE_PROMPT" }] },
    "edge-prompt-id",
    signal(),
  );
  const reply = [{ type: "text", text: "EDGE_REPLY" }];
  await source.recordResponse(
    recordNativeJsonResponse(
      { host: source.responseHost, requestedModel: MODEL },
      {
        type: "message",
        id: "edge-response",
        role: "assistant",
        model: MODEL,
        content: reply,
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      },
      reply,
    ),
    signal(),
  );
  await source.close();
  if (sourceTail)
    await appendFile(sourcePath, `${JSON.stringify(sourceTail)}\n`);
  const original = await readFile(sourcePath),
    imported = await importNativeSessionFile({
      path: sourcePath,
      cwd,
      model: MODEL,
      env: {},
      signal: signal(),
    });
  const ownership = await NativeSessionOwnership.acquire(
    { directory, path, admit: () => true },
    signal(),
  );
  onTestFinished(() => ownership.close().catch(() => {}));
  const copy = (
    overrides: Partial<Parameters<typeof copyNativeSessionToOwnedFile>[0]> = {},
  ) =>
    copyNativeSessionToOwnedFile({
      imported,
      path,
      ownership,
      signal: signal(),
      admit: () => true,
      ...overrides,
    });
  const staging = async () =>
    (await readdir(directory))
      .filter((name) => name.endsWith(".tmp"))
      .map((name) => join(directory, name));
  return {
    directory,
    path,
    sourcePath,
    original,
    imported,
    copy,
    staging,
  };
}
const absent = (path: string) =>
  assert.rejects(
    lstat(path),
    (error) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
  );

test("a forked or non-file import is refused before touching the destination", async () => {
  const f = await fixture();
  for (const native of [
    { ...f.imported.native, effectiveFork: true },
    { ...f.imported.native, transcriptPath: join(f.directory, "other.jsonl") },
  ])
    await assert.rejects(
      f.copy({ imported: { ...f.imported, native } }),
      /actual admitted main file and native identity/,
    );
  await absent(f.path);
});

test("the destination must be an absolute, normalized session filename distinct from the source", async () => {
  const f = await fixture();
  for (const path of [
    `${SID}.jsonl`,
    `${f.directory}/./${SID}.jsonl`,
    join(f.directory, "renamed.jsonl"),
  ])
    await assert.rejects(
      f.copy({ path }),
      /distinct admitted native session filename/,
    );
  await assert.rejects(
    f.copy({
      imported: {
        ...f.imported,
        native: { ...f.imported.native, transcriptPath: f.path },
        sourceReceipt: { ...f.imported.sourceReceipt, path: f.path },
      },
    }),
    /distinct admitted native session filename/,
  );
  await absent(f.path);
});

test("an import whose document no longer hashes to its receipt is refused", async () => {
  const f = await fixture();
  await assert.rejects(
    f.copy({
      imported: {
        ...f.imported,
        sourceReceipt: { ...f.imported.sourceReceipt, sha256: "0".repeat(64) },
      },
    }),
    /differs from its actual source receipt/,
  );
  await absent(f.path);
});

test("staging that disappears before a refused publication needs no cleanup", async () => {
  const f = await fixture();
  await assert.rejects(
    f.copy({
      admit: async ({ stage }) => {
        if (stage === "source") return true;
        for (const path of await f.staging()) await unlink(path);
        return false;
      },
    }),
    (error) =>
      !(error instanceof AggregateError) &&
      error instanceof Error &&
      /publish admission denied/.test(error.message),
  );
  await absent(f.path);
});

test("replaced staging is left for review and reported with the original failure", async () => {
  const f = await fixture();
  let replaced = "";
  await assert.rejects(
    f.copy({
      admit: async ({ stage }) => {
        if (stage === "source") return true;
        const [path] = await f.staging();
        assert.ok(path);
        replaced = path;
        await unlink(path);
        await writeFile(path, "FOREIGN_STAGING");
        return false;
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /publish admission denied/);
      assert.match(String(error.errors[1]), /staging-cleanup: .*identity/);
      return true;
    },
  );
  assert.equal(await readFile(replaced, "utf8"), "FOREIGN_STAGING");
  await absent(f.path);
});

test("a source whose resume point is an explicit checkpoint is not copied", async () => {
  const f = await fixture({
    type: "last-prompt",
    sessionId: SID,
    leafUuid: "50000000-0000-0000-0000-000000000002",
    explicit: true,
  });
  await assert.rejects(f.copy(), /admitted ordinary checkpoint owner/);
  await absent(f.path);
});
