import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  NativeSessionLifetime,
  type NativeSessionLifetimeOptions,
} from "../src/native-session-lifetime.js";
import { recordNativeJsonResponse } from "../src/native-response-recording.js";

const SID = "11111111-1111-1111-1111-111111111111";
const signal = () => new AbortController().signal;
const prompt = (text = "OWNED_PROMPT") => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-lifetime-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `${SID}.jsonl`);
  let stamps = 0;
  const options: NativeSessionLifetimeOptions = {
    ownership: { directory: root, path, admit: () => true },
    persistence: {
      context: {
        sessionId: SID,
        cwd: root,
        version: "2.1.326",
        userType: "external",
        sidechain: false,
      },
      admit: () => true,
    },
    initial: { kind: "fresh" },
    host: {
      stamp: () => ({
        uuid: `00000000-1111-1111-1111-${String(++stamps).padStart(12, "0")}`,
        timestamp: "2026-11-18T01:00:00.000Z",
      }),
    },
  };
  return {
    root,
    path,
    options,
    open: () => NativeSessionLifetime.open(options, signal()),
  };
}
async function turn(lifetime: NativeSessionLifetime) {
  await lifetime.journal.recordUser(prompt(), "actual-prompt-id", signal());
  const content = [{ type: "text", text: "ACTUAL_FINAL" }];
  await lifetime.journal.recordResponse(
    recordNativeJsonResponse(
      {
        requestedModel: "claude-sonnet-4-6",
        host: lifetime.journal.responseHost,
      },
      {
        id: "actual-api-response",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      content,
    ),
    signal(),
  );
}

test("save drains accepted producer work, verifies bytes and cold reopens only its exact binding", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let gated = true;
  f.options.persistence.admit = async ({ stage }) => {
    if (gated && stage === "commit") {
      entered.resolve();
      await release.promise;
      gated = false;
    }
    return true;
  };
  const lifetime = await f.open();
  const recorded = lifetime.journal.recordUser(
    prompt(),
    "actual-prompt-id",
    signal(),
  );
  await entered.promise;
  let saved = false;
  const saving = lifetime.save(signal()).then((receipt) => {
    saved = true;
    return receipt;
  });
  await Promise.resolve();
  assert.equal(saved, false);
  release.resolve();
  await recorded;
  const pendingBinding = await saving;
  assert.equal(
    pendingBinding.cursorUuid,
    "00000000-1111-1111-1111-000000000001",
  );
  await turn(lifetime);
  const binding = await lifetime.save(signal()),
    prefix = await readFile(f.path);
  assert.equal(binding.byteLength, prefix.length);
  assert.equal(
    binding.sha256,
    createHash("sha256").update(prefix).digest("hex"),
  );
  assert.ok(Object.isFrozen(binding));
  await assert.rejects(f.open(), /already owned/);
  await lifetime.close(signal());
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
  const resumed = await NativeSessionLifetime.open(
    { ...f.options, initial: { kind: "owned-existing", binding } },
    signal(),
  );
  await resumed.journal.recordUser(
    prompt("CONTINUATION"),
    "actual-next-prompt",
    signal(),
  );
  const next = await resumed.save(signal());
  assert.notEqual(next.sha256, binding.sha256);
  assert.deepEqual((await readFile(f.path)).subarray(0, prefix.length), prefix);
  await resumed.close(signal());
});

test("a stale same-cursor binding cannot adopt modified transcript bytes and failed open releases its own lock", async () => {
  const f = await fixture(),
    lifetime = await f.open();
  await turn(lifetime);
  const binding = await lifetime.save(signal());
  await lifetime.close(signal());
  const bytes = await readFile(f.path, "utf8");
  await writeFile(f.path, bytes.replace("ACTUAL_FINAL", "ALTERED_TEXT"));
  await assert.rejects(
    NativeSessionLifetime.open(
      { ...f.options, initial: { kind: "owned-existing", binding } },
      signal(),
    ),
    /differs from its persisted binding/,
  );
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
  assert.match(await readFile(f.path, "utf8"), /ALTERED_TEXT/);
});

test("save detects foreign changes and shutdown still releases ownership without claiming success", async () => {
  const f = await fixture(),
    lifetime = await f.open();
  await turn(lifetime);
  await appendFile(f.path, "\n");
  await assert.rejects(
    lifetime.save(signal()),
    /Native session journal failed/,
  );
  await assert.rejects(
    lifetime.close(signal()),
    /Native session journal failed/,
  );
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
});

test("shutdown checks the actual file even without an explicit save", async () => {
  const f = await fixture(),
    lifetime = await f.open();
  await turn(lifetime);
  await appendFile(f.path, "\n");
  await assert.rejects(lifetime.close(signal()), /changed outside/);
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
});

test("shutdown seals new producers and is idempotent", async () => {
  const f = await fixture(),
    lifetime = await f.open();
  await turn(lifetime);
  const closing = lifetime.close(signal());
  assert.equal(lifetime.close(signal()), closing);
  await assert.rejects(lifetime.save(signal()), /closing/);
  await assert.rejects(
    lifetime.journal.recordUser(prompt(), "too-late", signal()),
    /closing/,
  );
  await closing;
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
});

test("journal and ownership shutdown failures are both retained; unknown receipts remain untouched", async () => {
  const f = await fixture(),
    lifetime = await f.open();
  await turn(lifetime);
  await lifetime.journal
    .recordResponse(
      { status: "unsupported", reason: "actual-partial-response" },
      signal(),
    )
    .catch(() => {});
  await writeFile(`${f.path}.lock`, "FOREIGN_RECEIPT");
  await assert.rejects(lifetime.close(signal()), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(
      String(error.errors[0]),
      /journal failed|Unsupported native response/,
    );
    assert.match(String(error.errors[1]), /receipt changed/);
    return true;
  });
  assert.equal(await readFile(`${f.path}.lock`, "utf8"), "FOREIGN_RECEIPT");
});

test("query cancellation keeps its reason while a separate shutdown signal drains and releases ownership", async () => {
  const f = await fixture(),
    lifetime = await f.open();
  const cancelled = new AbortController(),
    reason = new Error("ACTUAL_QUERY_CANCELLED");
  cancelled.abort(reason);
  await assert.rejects(
    lifetime.journal.recordUser(prompt(), "cancelled-prompt", cancelled.signal),
    (error: unknown) => error instanceof Error && error.cause === reason,
  );
  await assert.rejects(lifetime.save(signal()));
  await assert.rejects(lifetime.close(signal()));
  await assert.rejects(lstat(f.path), { code: "ENOENT" });
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
});

test("failed writer setup releases the acquisition and invalid binding is rejected before acquisition", async () => {
  const f = await fixture();
  await assert.rejects(
    NativeSessionLifetime.open(
      {
        ...f.options,
        persistence: {
          ...f.options.persistence,
          context: { ...f.options.persistence.context, sidechain: true },
        },
      },
      signal(),
    ),
    /ordinary main-session owner/,
  );
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
  await assert.rejects(
    NativeSessionLifetime.open(
      {
        ...f.options,
        initial: {
          kind: "owned-existing",
          binding: {
            path: f.path,
            sessionId: SID,
            cursorUuid: null,
            byteLength: 0,
            sha256: "0".repeat(64),
          },
        },
      },
      signal(),
    ),
    /exact saved binding/,
  );
  await assert.rejects(lstat(`${f.path}.lock`), { code: "ENOENT" });
  const lifetime = await f.open();
  await lifetime.close(signal());
});
