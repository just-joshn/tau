import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
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
  NativeSessionOwnership,
  NativeSessionOwnershipError,
  type NativeSessionOwnershipOptions,
} from "../src/native-session-ownership.js";
import { NativeSessionJournal } from "../src/native-session-journal.js";
import { recordNativeJsonResponse } from "../src/native-response-recording.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "tau-native-ownership-")),
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
    root,
    directory,
    path,
    options,
    acquire: (changes: Partial<NativeSessionOwnershipOptions> = {}) =>
      NativeSessionOwnership.acquire({ ...options, ...changes }, signal()),
  };
}
const missing = async (path: string) =>
  assert.rejects(
    lstat(path),
    (error) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
  );

test("ownership is lazy, serializes accepted transactions and drains before retiring its exact receipt", async () => {
  const f = await fixture(),
    owner = await f.acquire();
  await missing(f.path);
  assert.equal((await lstat(owner.lockPath)).mode & 0o777, 0o600);
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    events: string[] = [];
  const first = owner.withExclusiveOwnership(f.path, async () => {
    events.push("first-start");
    started.resolve();
    await release.promise;
    events.push("first-end");
    return "FIRST";
  });
  await started.promise;
  const second = owner.withExclusiveOwnership(f.path, async () => {
    events.push("second");
    return "SECOND";
  });
  const closing = owner.close();
  await assert.rejects(
    owner.withExclusiveOwnership(f.path, async () => "UNACCEPTED"),
    /closing/,
  );
  assert.deepEqual(events, ["first-start"]);
  release.resolve();
  assert.equal(await first, "FIRST");
  assert.equal(await second, "SECOND");
  await closing;
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
  await missing(owner.lockPath);
  await missing(f.path);
  assert.equal(owner.close(), closing);
  const reopened = await f.acquire();
  await reopened.close();
});

async function childAttempt(f: Awaited<ReturnType<typeof fixture>>) {
  const source = new URL("../src/native-session-ownership.ts", import.meta.url)
    .href;
  const code = `import {NativeSessionOwnership} from ${JSON.stringify(source)};
try {const owner=await NativeSessionOwnership.acquire({directory:process.argv[1],path:process.argv[2],admit:()=>true},new AbortController().signal);await owner.close();process.stdout.write('ACQUIRED');}
catch(error){if(error?.message!=='Session is already owned or requires explicit stale-lock recovery')throw error;process.stdout.write('REFUSED');}`;
  const child = spawn(
    process.execPath,
    ["--no-install", "-e", code, f.directory, f.path],
    {
      cwd: f.root,
      env: { HOME: f.root, PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const exit = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    assert.equal(exit, 0, stderr);
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

test("a second participating Bun process is excluded until the first owner releases", async () => {
  const f = await fixture(),
    owner = await f.acquire(),
    receipt = await readFile(owner.lockPath);
  assert.equal(await childAttempt(f), "REFUSED");
  assert.deepEqual(await readFile(owner.lockPath), receipt);
  await owner.close();
  assert.equal(await childAttempt(f), "ACQUIRED");
  await missing(owner.lockPath);
});

test("a journal holds real ownership across append, close and explicit cold reopen", async () => {
  const f = await fixture(),
    ownership = await f.acquire();
  let stamps = 0;
  const host = {
    stamp: () => ({
      uuid: `00000000-0000-0000-0000-${String(++stamps).padStart(12, "0")}`,
      timestamp: "2026-11-18T00:00:00Z",
    }),
  };
  const options = {
    path: f.path,
    context: {
      sessionId: SID,
      cwd: f.root,
      version: "2.1.326",
      userType: "external",
      sidechain: false,
    },
    initial: { kind: "fresh" } as const,
    admit: () => true,
    withExclusiveOwnership: ownership.withExclusiveOwnership,
  };
  const journal = await NativeSessionJournal.open(options, host, signal());
  await missing(f.path);
  await journal.recordUser(
    { role: "user", content: [{ type: "text", text: "ACTUAL_PROMPT" }] },
    "actual-prompt",
    signal(),
  );
  const content = [{ type: "text", text: "ACTUAL_FINAL" }];
  await journal.recordResponse(
    recordNativeJsonResponse(
      { host: journal.responseHost, requestedModel: MODEL },
      {
        type: "message",
        id: "actual-response",
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
  const prefix = await readFile(f.path);
  await assert.rejects(f.acquire(), /already owned/);
  await journal.close();
  await ownership.close();
  const next = await f.acquire(),
    reopened = await NativeSessionJournal.open(
      {
        ...options,
        initial: {
          kind: "owned-existing",
          cursorUuid: "00000000-0000-0000-0000-000000000002",
        },
        withExclusiveOwnership: next.withExclusiveOwnership,
      },
      host,
      signal(),
    );
  await reopened.close();
  await next.close();
  assert.deepEqual(await readFile(f.path), prefix);
  await missing(next.lockPath);
});

test("foreign existing lock leaves are refused without being consumed, removed or reclaimed", async () => {
  for (const kind of ["regular", "symlink", "hardlink"] as const) {
    const f = await fixture(),
      target = join(f.root, "foreign-receipt"),
      lock = `${f.path}.lock`;
    await writeFile(target, "FOREIGN_UNTRUSTED_RECEIPT");
    if (kind === "regular") await writeFile(lock, "UNKNOWN_OWNER");
    else if (kind === "symlink") await symlink(target, lock);
    else await link(target, lock);
    const before = await lstat(lock);
    await assert.rejects(f.acquire(), /already owned|stale-lock/);
    const after = await lstat(lock);
    assert.equal(after.ino, before.ino);
    assert.equal(after.nlink, before.nlink);
    assert.equal(await readFile(target, "utf8"), "FOREIGN_UNTRUSTED_RECEIPT");
    if (kind === "regular")
      assert.equal(await readFile(lock, "utf8"), "UNKNOWN_OWNER");
  }
});

test("a replaced receipt or directory cannot authorize work or have its new lock removed", async () => {
  for (const changed of ["receipt", "directory"] as const) {
    const f = await fixture(),
      owner = await f.acquire();
    if (changed === "receipt")
      await rename(owner.lockPath, join(f.root, "retired-receipt"));
    else {
      await rename(f.directory, join(f.root, "retired-directory"));
      await mkdir(f.directory, { mode: 0o700 });
    }
    await writeFile(owner.lockPath, "NEW_UNOWNED_RECEIPT", { mode: 0o600 });
    let called = false;
    await assert.rejects(
      owner.withExclusiveOwnership(f.path, async () => {
        called = true;
      }),
      /ownership.*changed/,
    );
    assert.equal(called, false);
    await assert.rejects(owner.close(), /ownership.*changed/);
    assert.equal(await readFile(owner.lockPath, "utf8"), "NEW_UNOWNED_RECEIPT");
  }
});

test("admission, cancellation, private-directory and path identity gates run before work", async () => {
  const f = await fixture();
  await assert.rejects(
    f.acquire({ admit: () => false }),
    /acquisition admission denied/,
  );
  await missing(`${f.path}.lock`);
  const aborted = new AbortController();
  aborted.abort(new Error("OWNED_ACQUIRE_ABORT"));
  await assert.rejects(
    NativeSessionOwnership.acquire(f.options, aborted.signal),
    /OWNED_ACQUIRE_ABORT/,
  );
  await chmod(f.directory, 0o755);
  await assert.rejects(f.acquire(), /private canonical/);
  await chmod(f.directory, 0o700);
  let allowAccess = false;
  const owner = await f.acquire({
    admit: (input) => input.stage !== "access" || allowAccess,
  });
  await assert.rejects(
    owner.withExclusiveOwnership(f.path, async () => "FORBIDDEN"),
    /access admission denied/,
  );
  allowAccess = true;
  await assert.rejects(
    owner.withExclusiveOwnership(
      join(f.directory, "other.jsonl"),
      async () => "FORBIDDEN",
    ),
    /another transcript/,
  );
  assert.equal(
    await owner.withExclusiveOwnership(f.path, async () => "ADMITTED"),
    "ADMITTED",
  );
  await owner.close();
});

test("recursive ownership and close fail promptly while ordinary transaction errors preserve their cause", async () => {
  const f = await fixture(),
    owner = await f.acquire(),
    failure = new Error("ACTUAL_WORK_FAILED");
  await owner.withExclusiveOwnership(f.path, async () => {
    await assert.rejects(
      owner.withExclusiveOwnership(f.path, async () => "NESTED"),
      /Recursive ownership/,
    );
    await assert.rejects(owner.close(), /inside its active transaction/);
  });
  await assert.rejects(
    owner.withExclusiveOwnership(f.path, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await owner.close();
  assert.ok(NativeSessionOwnershipError.prototype instanceof Error);
});
