import assert from "node:assert/strict";
import {
  chmod,
  lstat,
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
import {
  copyNativeSessionToOwnedFile,
  NativeSessionCopyCommittedError,
} from "../../src/native-session-copy.js";
import { NativeSessionJournal } from "../../src/native-session-journal.js";
import { NativeSessionOwnership } from "../../src/native-session-ownership.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import { recordNativeJsonResponse } from "../../src/native-response-recording.js";
import { createNativeAttachmentEvent } from "../../src/native-persistence-events.js";
import {
  composeNativeLaunchEnvelope,
  nativeMainWriterContext,
} from "../../src/native-storage-paths.js";
import { projectMessages } from "../../src/thinking-history.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
async function fixture(passiveTail = false) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-native-copy-")),
    ),
    sourceDirectory = join(root, "source"),
    directory = join(root, "owned"),
    cwd = join(root, "current");
  for (const path of [sourceDirectory, directory, cwd])
    await mkdir(path, { mode: 0o700 });
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(sourceDirectory, "arbitrary-export-name.jsonl"),
    path = join(directory, `${SID}.jsonl`);
  let stamps = 0;
  const host = {
    stamp: () => ({
      uuid: `10000000-0000-0000-0000-${String(++stamps).padStart(12, "0")}`,
      timestamp: "2026-11-18T00:00:00Z",
    }),
  };
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
    host,
    signal(),
  );
  await source.recordUser(
    {
      role: "user",
      content: [{ type: "text", text: "AUTHORED_SOURCE_PROMPT" }],
    },
    "actual-source-prompt-id",
    signal(),
  );
  const reply = [{ type: "text", text: "AUTHORED_SOURCE_REPLY" }];
  await source.recordResponse(
    recordNativeJsonResponse(
      { host: source.responseHost, requestedModel: MODEL },
      {
        type: "message",
        id: "authored-source-response",
        role: "assistant",
        model: MODEL,
        content: reply,
        usage: { input_tokens: 10, output_tokens: 3 },
        stop_reason: "end_turn",
      },
      reply,
    ),
    signal(),
  );
  if (passiveTail) {
    const attachment = {
      type: "prompt_snapshot" as const,
      systemPrompt: ["AUTHORED_EFFECTIVE_SYSTEM"],
      reminderFold: false,
      echoWireToolInputs: false,
      contextRendering: "announced" as const,
    };
    const stamp = source.stampAttachment();
    await source.capturePromptSnapshot(
      {
        record: { type: "attachment", ...stamp, attachment },
        serialization: {
          status: "supported",
          event: createNativeAttachmentEvent(attachment, stamp),
        },
      },
      signal(),
    );
  }
  await source.close();
  await chmod(sourcePath, 0o400);
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
  const context = nativeMainWriterContext(
    composeNativeLaunchEnvelope({
      sessionId: SID,
      sessionIdAdmission: "ordinary",
      currentCwd: cwd,
      environment: {},
    }),
  );
  return {
    root,
    directory,
    cwd,
    path,
    sourcePath,
    original,
    imported,
    ownership,
    host,
    context,
  };
}
const absent = async (path: string) =>
  assert.rejects(
    lstat(path),
    (error) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
  );

test("an admitted external transcript is copied byte-exactly to its native SID basename, resumed and continued under actual ownership", async () => {
  const f = await fixture(),
    copied = await copyNativeSessionToOwnedFile({
      imported: f.imported,
      path: f.path,
      ownership: f.ownership,
      signal: signal(),
      admit: () => true,
    });
  assert.equal(copied.sessionId, SID);
  assert.equal(copied.cancelledAfterCommit, false);
  assert.equal(copied.stagingPath, null);
  assert.equal(copied.destination?.file.links, "1");
  assert.notEqual(copied.destination?.file.inode, copied.source.file.inode);
  assert.deepEqual(await readFile(f.path), f.original);
  const journal = await NativeSessionJournal.open(
    {
      path: f.path,
      context: f.context,
      initial: { kind: "owned-existing", cursorUuid: copied.cursorUuid },
      withExclusiveOwnership: f.ownership.withExclusiveOwnership,
      admit: () => true,
    },
    f.host,
    signal(),
  );
  await journal.recordUser(
    { role: "user", content: [{ type: "text", text: "NEW_CURRENT_PROMPT" }] },
    "current-prompt-id",
    signal(),
  );
  const content = [{ type: "text", text: "NEW_CURRENT_REPLY" }];
  await journal.recordResponse(
    recordNativeJsonResponse(
      { host: journal.responseHost, requestedModel: MODEL },
      {
        type: "message",
        id: "current-response",
        role: "assistant",
        model: MODEL,
        content,
        usage: { input_tokens: 10, output_tokens: 3 },
        stop_reason: "end_turn",
      },
      content,
    ),
    signal(),
  );
  await journal.close();
  await f.ownership.close();
  const final = await readFile(f.path);
  assert.deepEqual(final.subarray(0, f.original.length), f.original);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.equal((await lstat(f.sourcePath)).mode & 0o777, 0o400);
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.cwd,
    model: MODEL,
    env: {},
    signal: signal(),
  });
  assert.equal(imported.session.id, SID);
  assert.deepEqual(
    projectMessages(imported.session.messages).slice(0, 2),
    projectMessages(f.imported.session.messages),
  );
  assert.match(final.toString(), /"version":"2.1.325"/);
  assert.match(final.toString(), /"version":"2.1.326"/);
  assert.equal(
    (await readdir(f.directory)).some(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    ),
    false,
  );
});

test("copy retains a passive snapshot checkpoint cursor instead of guessing the last conversational leaf", async () => {
  const f = await fixture(true),
    copied = await copyNativeSessionToOwnedFile({
      imported: f.imported,
      path: f.path,
      ownership: f.ownership,
      signal: signal(),
      admit: () => true,
    });
  assert.notEqual(copied.cursorUuid, f.imported.native.projection.leafUuid);
  const reopened = await NativeSessionJournal.open(
    {
      path: f.path,
      context: f.context,
      initial: { kind: "owned-existing", cursorUuid: copied.cursorUuid },
      withExclusiveOwnership: f.ownership.withExclusiveOwnership,
      admit: () => true,
    },
    f.host,
    signal(),
  );
  await reopened.close();
  await f.ownership.close();
  assert.deepEqual(await readFile(f.path), f.original);
});

test("an ordinary source with no saved checkpoint opens at its validated actual tail without inventing metadata", async () => {
  const f = await fixture();
  const withoutCheckpoint =
    f.original
      .toString()
      .split("\n")
      .filter((line) => {
        if (!line) return false;
        const row: unknown = JSON.parse(line);
        return (
          row === null ||
          typeof row !== "object" ||
          !("type" in row) ||
          row.type !== "last-prompt"
        );
      })
      .join("\n") + "\n";
  await chmod(f.sourcePath, 0o600);
  await writeFile(f.sourcePath, withoutCheckpoint);
  await chmod(f.sourcePath, 0o400);
  const imported = await importNativeSessionFile({
    path: f.sourcePath,
    cwd: f.cwd,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.equal(imported.native.appliedCheckpoints, 0);
  const copied = await copyNativeSessionToOwnedFile({
    imported,
    path: f.path,
    ownership: f.ownership,
    signal: signal(),
    admit: () => true,
  });
  assert.equal(copied.cursorUuid, imported.native.projection.leafUuid);
  assert.equal(await readFile(f.path, "utf8"), withoutCheckpoint);
  const reopened = await NativeSessionJournal.open(
    {
      path: f.path,
      context: f.context,
      initial: { kind: "owned-existing", cursorUuid: copied.cursorUuid },
      withExclusiveOwnership: f.ownership.withExclusiveOwnership,
      admit: () => true,
    },
    f.host,
    signal(),
  );
  await reopened.close();
  await f.ownership.close();
  assert.equal(await readFile(f.path, "utf8"), withoutCheckpoint);
});

test("copy checks the actual document's native owner rather than trusting a mismatched result wrapper", async () => {
  const f = await fixture(),
    other = "22222222-2222-2222-2222-222222222222";
  const imported = {
    ...f.imported,
    native: {
      ...f.imported.native,
      adoptedSessionId: other,
      transcriptSessionId: other,
    },
  };
  await assert.rejects(
    copyNativeSessionToOwnedFile({
      imported,
      path: join(f.directory, `${other}.jsonl`),
      ownership: f.ownership,
      signal: signal(),
      admit: () => true,
    }),
    /actual document owner/,
  );
  await absent(f.path);
  await absent(join(f.directory, `${other}.jsonl`));
  await f.ownership.close();
});

test("existing native destinations and changed source receipts cannot be overwritten or silently adopted", async () => {
  for (const changed of ["destination", "source"] as const) {
    const f = await fixture();
    if (changed === "destination")
      await writeFile(f.path, "EXISTING_DESTINATION");
    else {
      await chmod(f.sourcePath, 0o600);
      await writeFile(f.sourcePath, "CHANGED_SOURCE");
    }
    await assert.rejects(
      copyNativeSessionToOwnedFile({
        imported: f.imported,
        path: f.path,
        ownership: f.ownership,
        signal: signal(),
        admit: () => true,
      }),
      /already exists|no longer matches/,
    );
    if (changed === "destination")
      assert.equal(await readFile(f.path, "utf8"), "EXISTING_DESTINATION");
    else await absent(f.path);
    await f.ownership.close();
    assert.equal(
      (await readdir(f.directory)).some((name) => name.endsWith(".tmp")),
      false,
    );
  }
});

test("publish admission races, refusal and cancellation retire only staging and never overwrite another destination", async () => {
  for (const action of ["race", "deny", "abort", "change-source"] as const) {
    const f = await fixture(),
      controller = new AbortController(),
      reason = new Error("ACTUAL_COPY_ABORT");
    await assert.rejects(
      copyNativeSessionToOwnedFile({
        imported: f.imported,
        path: f.path,
        ownership: f.ownership,
        signal: controller.signal,
        admit: async (input) => {
          if (input.stage !== "publish") return true;
          if (action === "race")
            await writeFile(f.path, "RACING_UNOWNED_DESTINATION", {
              flag: "wx",
            });
          if (action === "abort") controller.abort(reason);
          if (action === "change-source") {
            await chmod(f.sourcePath, 0o600);
            await writeFile(f.sourcePath, "NEW_SOURCE");
          }
          return action !== "deny";
        },
      }),
      (error) =>
        action === "abort"
          ? error === reason
          : error instanceof Error &&
            !(error instanceof NativeSessionCopyCommittedError),
    );
    if (action === "race")
      assert.equal(
        await readFile(f.path, "utf8"),
        "RACING_UNOWNED_DESTINATION",
      );
    else await absent(f.path);
    await f.ownership.close();
    assert.equal(
      (await readdir(f.directory)).some((name) => name.endsWith(".tmp")),
      false,
    );
  }
});

test("postpublication binding failure reports an exact committed copy and never rolls it back", async () => {
  const f = await fixture(),
    cause = new Error("ACTUAL_BINDING_FAILED");
  await assert.rejects(
    copyNativeSessionToOwnedFile({
      imported: f.imported,
      path: f.path,
      ownership: f.ownership,
      signal: signal(),
      admit: () => true,
      onCommitted: () => {
        throw cause;
      },
    }),
    (error) =>
      error instanceof NativeSessionCopyCommittedError &&
      error.committed &&
      error.cause === cause &&
      error.receipt.sha256 === f.imported.sourceReceipt.sha256 &&
      error.receipt.destination?.file.links === "1",
  );
  assert.deepEqual(await readFile(f.path), f.original);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  await f.ownership.close();
});

test("abort after actual publication remains committed and a binding cannot replace the new file unnoticed", async () => {
  for (const action of ["abort", "replace"] as const) {
    const f = await fixture(),
      controller = new AbortController();
    const copy = copyNativeSessionToOwnedFile({
      imported: f.imported,
      path: f.path,
      ownership: f.ownership,
      signal: controller.signal,
      admit: () => true,
      onCommitted: async () => {
        if (action === "abort")
          controller.abort(new Error("ABORT_AFTER_COMMIT"));
        else await writeFile(f.path, "UNEXPECTED_POSTPUBLICATION_WRITE");
      },
    });
    if (action === "abort") {
      const committed = await copy;
      assert.equal(committed.cancelledAfterCommit, true);
      assert.deepEqual(await readFile(f.path), f.original);
    } else
      await assert.rejects(
        copy,
        (error) =>
          error instanceof NativeSessionCopyCommittedError && error.committed,
      );
    assert.deepEqual(await readFile(f.sourcePath), f.original);
    await f.ownership.close();
  }
});
