import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import {
  appendFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createNativeSessionWriter,
  envelopeNativeWriterEntries,
  planNativeMessageEntries,
  type NativeMessageIdentity,
  type NativeSessionWriterOptions,
  type NativeWriterContext,
  type NativeWriterEntry,
} from "../src/native-session-writer.js";
import {
  decodeNativeSession,
  foldSupportedNativeMetadata,
  isNativeObject,
} from "../src/native-session-codec.js";
import { prepareNativePrintResume } from "../src/native-resume-entry.js";
import { projectMessages } from "../src/thinking-history.js";
import type { Message } from "../src/types.js";
import { createNativeAttachmentEvent } from "../src/native-persistence-events.js";

const SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const id = (value: number) =>
  `${String(value).padStart(8, "0")}-1111-1111-1111-111111111111`;
const time = (value: number) =>
  `2026-01-01T00:00:${String(value).padStart(2, "0")}Z`;
const ctx: NativeWriterContext = {
  sessionId: SID,
  cwd: "/owned/work",
  version: "2.1.326",
  entrypoint: "cli",
  userType: "external",
  sidechain: false,
};
const signal = () => new AbortController().signal;
function ownership(): NativeSessionWriterOptions["withExclusiveOwnership"] {
  let tail = Promise.resolve();
  return async (_path, work) => {
    const previous = tail;
    const next = Promise.withResolvers<void>();
    tail = next.promise;
    await previous;
    try {
      return await work();
    } finally {
      next.resolve();
    }
  };
}
async function fixture(changes: Partial<NativeSessionWriterOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tau-owned-native-writer-")),
    path = join(
      directory,
      changes.context?.sidechain
        ? `agent-${changes.context.agentId}.jsonl`
        : "owned.jsonl",
    );
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const options: NativeSessionWriterOptions = {
    path,
    context: ctx,
    withExclusiveOwnership: ownership(),
    admit: () => true,
    ...changes,
  };
  return {
    directory,
    path,
    options,
    writer: createNativeSessionWriter(options),
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function history(): {
  messages: Message[];
  identities: NativeMessageIdentity[];
} {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "OWNED REQUEST" }] },
    {
      role: "assistant",
      responseId: "msg-owned-call",
      responseModel: "claude-sonnet-4-6",
      requestedModel: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 3 },
      content: [
        {
          type: "thinking",
          thinking: "Owned signed reasoning",
          signature: "opaque-signature==",
        },
        {
          type: "tool_use",
          id: "call-owned",
          name: "Read",
          input: { file_path: "/owned/file.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-owned",
          content: "LOCAL SUMMARY",
          apiContent: [{ type: "text", text: "MODEL VISIBLE ORIGINAL" }],
          is_error: false,
        },
      ],
    },
    {
      role: "assistant",
      responseId: "msg-owned-final",
      responseModel: "claude-sonnet-4-6",
      usage: { input_tokens: 12, output_tokens: 4 },
      content: [{ type: "text", text: "OWNED FINAL" }],
    },
  ];
  return {
    messages,
    identities: messages.map((message, index): NativeMessageIdentity => ({
      uuid: id(index + 1),
      timestamp: time(index),
      ...(message.role === "assistant"
        ? { stopReason: index === 1 ? "tool_use" : "end_turn" }
        : {}),
    })),
  };
}
const entry = (value: number): NativeWriterEntry => ({
  type: "user",
  uuid: id(value),
  timestamp: time(value),
  message: {
    role: "user",
    content: [{ type: "text", text: `OWNED ${value}` }],
  },
});

test("completed model-visible history exports explicit native envelopes and resumes through source entry/Esr", async () => {
  const { path, writer } = await fixture(),
    { messages, identities } = history(),
    entries = planNativeMessageEntries(messages, identities);
  const result = await writer.appendEntries(
    entries,
    {
      parentUuid: null,
      promptId: "owned-prompt",
      gitBranch: "owned-branch",
      checkpoint: true,
      metadata: [{ type: "custom-title", value: "OWNED TITLE" }],
    },
    signal(),
  );
  assert.equal(result.changed, true);
  assert.equal(result.appended, 4);
  assert.equal(result.metadataAppended, 2);
  assert.equal(result.leafUuid, id(4));
  const bytes = await readFile(path),
    document = decodeNativeSession(bytes, { parser: "source-line-fallback" });
  const rows = document.lines.map((line) => line.value).filter(isNativeObject);
  assert.deepEqual(
    rows.slice(0, 4).map((row) => row.parentUuid),
    [null, id(1), id(2), id(3)],
  );
  assert.equal(rows[2]?.sourceToolAssistantUUID, id(2));
  assert.equal(rows[1]?.madeBy, "other");
  assert.equal(rows[1]?.requestedModel, "claude-sonnet-4-6");
  for (const row of rows.slice(0, 4)) {
    assert.equal(row.sessionId, SID);
    assert.equal(row.version, "2.1.326");
    assert.equal(row.cwd, ctx.cwd);
    assert.equal(row.isSidechain, false);
  }
  assert.equal(rows[0]?.promptId, "owned-prompt");
  assert.equal(rows[1]?.promptId, undefined);
  assert.equal(
    foldSupportedNativeMetadata(document)
      .valuesByTypeAndSession.get("custom-title")
      ?.get(SID),
    "OWNED TITLE",
  );
  const restored = await prepareNativePrintResume(
    { resume: path },
    {
      workingDirectory: "/owned",
      newSessionId: () => id(99),
      continueCandidates: async () => [],
      titleCandidates: async () => [],
      resolveSessionId: async () => undefined,
      liveBackgroundSessionIds: async () => new Set(),
      admitTranscript: () => true,
      readTranscript: (file) => readFile(file),
      recovery: {
        callIdToolResults: true,
        descendantOrder: "depth-first",
        timestampFallback: "reject",
      },
    },
    signal(),
  );
  assert.equal(restored?.adoptedSessionId, SID);
  assert.deepEqual(
    projectMessages(required(restored).messages),
    projectMessages(messages),
  );
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(path), bytes);
});

test("stable replay deduplicates main rows without replacing the file or sealing a no-op tail", async () => {
  const { path, writer } = await fixture(),
    { messages, identities } = history(),
    entries = planNativeMessageEntries(messages, identities);
  await writer.appendEntries(entries, { parentUuid: null }, signal());
  const before = await lstat(path),
    bytes = await readFile(path);
  const replay = await writer.appendEntries(
    entries,
    { parentUuid: null },
    signal(),
  );
  assert.equal(replay.changed, false);
  assert.equal(replay.skipped, 4);
  assert.equal((await lstat(path)).ino, before.ino);
  assert.deepEqual(await readFile(path), bytes);
});

test("append preserves unknown/malformed bytes and seals an unterminated tail before valid records", async () => {
  const { path, writer } = await fixture(),
    prefix = Buffer.from(
      '\uFEFF{"type":"future-passive","opaque":{"owned":true}}\nMALFORMED-OWNED-TAIL',
    );
  await writeFile(path, prefix);
  const result = await writer.appendEntries(
    [entry(1)],
    { parentUuid: null },
    signal(),
  );
  const bytes = await readFile(path);
  assert.equal(result.sealedTornTail, true);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  assert.equal(bytes[prefix.length], 10);
  const document = decodeNativeSession(bytes, {
    parser: "source-line-fallback",
  });
  assert.equal(document.lines[1]?.kind, "invalid");
  assert.equal(document.lines[2]?.kind, "record");
});

test("sourceToolAssistantUUID uses known main parents and progress does not advance the chain", () => {
  const progress: NativeWriterEntry = {
    type: "progress",
    uuid: id(8),
    timestamp: time(8),
    data: { type: "owned-progress" },
  };
  const inputs: NativeWriterEntry[] = [
    progress,
    { ...entry(2), sourceToolAssistantUUID: id(9) },
    { ...entry(3), sourceToolAssistantUUID: id(1) },
  ];
  const prepared = envelopeNativeWriterEntries(
    inputs,
    ctx,
    { parentUuid: id(1) },
    new Set([id(1)]),
  );
  assert.deepEqual(
    prepared.rows.map((row) => row.parentUuid),
    [id(1), id(1), id(1)],
  );
  assert.equal(prepared.leafUuid, id(3));
  assert.throws(
    () =>
      envelopeNativeWriterEntries(
        [entry(1)],
        ctx,
        { parentUuid: id(1) },
        new Set([id(1)]),
      ),
    /self-referential/,
  );
});

test("progress dedup distinguishes live cache from a cold writer and first-row materialization", async () => {
  const { writer, path, options } = await fixture(),
    progress: NativeWriterEntry = {
      type: "progress",
      uuid: id(8),
      timestamp: time(8),
      data: { type: "owned-progress" },
    };
  await assert.rejects(
    writer.appendEntries([progress], { parentUuid: null }, signal()),
    /deferred materialization/,
  );
  await writer.appendEntries(
    [entry(1), progress],
    { parentUuid: null },
    signal(),
  );
  assert.equal(
    (await writer.appendEntries([progress], { parentUuid: id(1) }, signal()))
      .skipped,
    1,
  );
  assert.equal(
    (
      await createNativeSessionWriter(options).appendEntries(
        [progress],
        { parentUuid: id(1) },
        signal(),
      )
    ).appended,
    1,
  );
  const rows = decodeNativeSession(await readFile(path), {
    parser: "source-line-fallback",
  })
    .lines.map((line) => line.value)
    .filter(isNativeObject);
  assert.equal(rows.filter((row) => row.uuid === id(8)).length, 2);
});

test("version/request provenance follows BJt/NJt/DVs rather than stamping every imported row", () => {
  const assistant = required(
    planNativeMessageEntries(history().messages.slice(3), [
      required(history().identities[3]),
    ])[0],
  );
  const fresh = required(
    envelopeNativeWriterEntries(
      [assistant],
      ctx,
      { parentUuid: null },
      new Set(),
    ).rows[0],
  );
  assert.equal(fresh.version, ctx.version);
  assert.equal(fresh.madeBy, "other");
  const imported = { ...assistant, sessionId: id(7), requestSessionId: id(8) };
  const old = required(
    envelopeNativeWriterEntries(
      [imported],
      ctx,
      { parentUuid: null },
      new Set(),
    ).rows[0],
  );
  assert.equal(Object.hasOwn(old, "version"), false);
  assert.equal(old.requestSessionId, id(8));
  assert.equal(old.madeBy, undefined);
  assert.equal(old.sessionId, SID);
  const versioned = required(
    envelopeNativeWriterEntries(
      [{ ...imported, version: "owned-old-version" }],
      ctx,
      { parentUuid: null },
      new Set(),
    ).rows[0],
  );
  assert.equal(versioned.version, "owned-old-version");
});

test("isolated agent transcript retains sidechain duplicates but refuses main metadata routing", async () => {
  const context = { ...ctx, sidechain: true, agentId: "a0123456789abcdef" },
    { writer, path } = await fixture({ context });
  const progress: NativeWriterEntry = {
    type: "progress",
    uuid: id(8),
    timestamp: time(8),
    data: { type: "owned-progress" },
  };
  await writer.appendEntries(
    [entry(1), progress],
    { parentUuid: null },
    signal(),
  );
  const repeat = await writer.appendEntries(
    [progress],
    { parentUuid: id(1) },
    signal(),
  );
  assert.equal(repeat.appended, 1);
  assert.equal(repeat.skipped, 0);
  const rows = decodeNativeSession(await readFile(path), {
    parser: "source-line-fallback",
  })
    .lines.map((line) => line.value)
    .filter(isNativeObject);
  assert.equal(rows.filter((row) => row.uuid === id(8)).length, 2);
  assert.ok(
    rows.every(
      (row) => row.isSidechain === true && row.agentId === context.agentId,
    ),
  );
  await assert.rejects(
    writer.appendEntries([], { parentUuid: id(1), checkpoint: true }, signal()),
    /metadata cannot be routed/,
  );
});

test("unsupported local metadata needs an explicit source projection and real assistant metadata is mandatory", () => {
  const { messages, identities } = history();
  assert.throws(
    () =>
      planNativeMessageEntries(
        [{ ...required(messages[0]), instructionFiles: [] }],
        [required(identities[0])],
      ),
    /unsupported native/,
  );
  assert.throws(
    () =>
      planNativeMessageEntries(
        [
          {
            ...required(messages[2]),
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-owned",
                content: "x",
                hookContext: ["OWNED HOOK"],
              },
            ],
          },
        ],
        [required(identities[2])],
      ),
    /unsupported native/,
  );
  assert.throws(
    () =>
      planNativeMessageEntries(
        [required(messages[3])],
        [{ uuid: id(4), timestamp: time(4) }],
      ),
    /stop metadata/,
  );
  assert.throws(
    () =>
      planNativeMessageEntries(
        [{ role: "assistant", content: [{ type: "text", text: "owned" }] }],
        [{ uuid: id(4), timestamp: time(4), stopReason: "end_turn" }],
      ),
    /response\/model\/usage/,
  );
  const mapped = planNativeMessageEntries(
    [{ ...required(messages[0]), instructionFiles: [] }],
    [required(identities[0])],
    { projectUnsupportedMessage: () => [entry(1)] },
  );
  assert.equal(mapped.length, 1);
});

test("explicit prior tool-parent ledger supports a new result batch without inventing response ownership", () => {
  const { messages, identities } = history();
  assert.throws(
    () => planNativeMessageEntries(messages.slice(2), identities.slice(2)),
    /ownership is missing/,
  );
  const result = planNativeMessageEntries(
    messages.slice(2),
    identities.slice(2),
    { knownToolParents: new Map([["call-owned", id(2)]]) },
  );
  assert.equal(result[0]?.sourceToolAssistantUUID, id(2));
});

test("ordinary typed attachments preserve native envelopes and can own the real prompt-snapshot checkpoint tail", async () => {
  const f = await fixture();
  const snapshot = createNativeAttachmentEvent(
    {
      type: "prompt_snapshot",
      systemPrompt: ["OWNED_EFFECTIVE_SYSTEM"],
      reminderFold: false,
      echoWireToolInputs: false,
      contextRendering: "announced",
    },
    { uuid: id(8), timestamp: time(8) },
  );
  await assert.rejects(
    f.writer.appendEntries(
      [snapshot],
      { parentUuid: null, checkpoint: true },
      signal(),
    ),
    /first conversation row/,
  );
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  const instructions = createNativeAttachmentEvent(
    {
      type: "instructions",
      files: [
        {
          path: "/owned/CLAUDE.md",
          type: "Project",
          content: "OWNED_INSTRUCTION",
        },
      ],
    },
    { uuid: id(7), timestamp: time(7) },
  );
  const { messages, identities } = history();
  const entries = planNativeMessageEntries(
    messages.slice(3),
    identities.slice(3),
  );
  const committed = await f.writer.appendEntries(
    [entry(1), instructions, ...entries, snapshot],
    { parentUuid: null, checkpoint: true },
    signal(),
  );
  assert.equal(committed.leafUuid, id(8));
  const stored = decodeNativeSession(await readFile(f.path), {
    parser: "source-line-fallback",
  })
    .lines.map((line) => line.value)
    .filter(isNativeObject);
  assert.equal(stored.find((row) => row.uuid === id(7))?.parentUuid, id(1));
  assert.equal(stored.find((row) => row.uuid === id(4))?.parentUuid, id(7));
  assert.equal(stored.find((row) => row.uuid === id(8))?.parentUuid, id(4));
  assert.equal(stored.at(-1)?.leafUuid, id(8));
  assert.deepEqual(
    stored.find((row) => row.uuid === id(7))?.rendered,
    instructions.rendered,
  );
  await assert.rejects(
    f.writer.appendEntries(
      [
        {
          ...instructions,
          uuid: id(9),
          rendered: [{ content: "MUST_NOT_FAKE_NATIVE_RENDERING" }],
        },
      ],
      { parentUuid: id(8) },
      signal(),
    ),
    /recorded rendering/,
  );
});

test("known actual Read result metadata is preserved while guessed decisions/effective input stay unsupported", async () => {
  const f = await fixture(),
    { messages, identities } = history();
  const entries = planNativeMessageEntries(
    messages.slice(0, 2),
    identities.slice(0, 2),
  );
  const result: NativeWriterEntry = {
    type: "user",
    uuid: id(3),
    timestamp: time(3),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-owned",
          content: "MODEL_VISIBLE_READ",
        },
      ],
    },
    sourceToolAssistantUUID: id(2),
    toolUseResult: {
      type: "text",
      file: {
        filePath: "note.txt",
        content: "RAW_READ",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    },
    permissionDecision: {
      decision: "accept",
      source: "config",
      reasonType: "mode",
    },
  };
  await f.writer.appendEntries(
    [...entries, result],
    { parentUuid: null, checkpoint: true },
    signal(),
  );
  const before = await readFile(f.path),
    stored = decodeNativeSession(before, { parser: "source-line-fallback" })
      .lines.map((line) => line.value)
      .filter(isNativeObject)
      .find((row) => row.uuid === id(3));
  assert.deepEqual(stored?.toolUseResult, result.toolUseResult);
  assert.deepEqual(stored?.permissionDecision, result.permissionDecision);
  await assert.rejects(
    f.writer.appendEntries(
      [
        {
          ...result,
          uuid: id(4),
          effectiveToolInput: { file_path: "MUST_NOT_INVENT_NATIVE_FIELD" },
        },
      ],
      { parentUuid: id(3) },
      signal(),
    ),
    /Unsupported/,
  );
  await assert.rejects(
    f.writer.appendEntries(
      [
        {
          ...result,
          uuid: id(4),
          permissionDecision: {
            decision: "accept",
            source: "GUESSED",
            reasonType: "mode",
          },
        },
      ],
      { parentUuid: id(3) },
      signal(),
    ),
  );
  assert.deepEqual(await readFile(f.path), before);
});

test("concurrent append batches use required host ownership and preserve both explicit chains", async () => {
  const { writer, path } = await fixture();
  await Promise.all([
    writer.appendEntries([entry(1)], { parentUuid: null }, signal()),
    writer.appendEntries([entry(2)], { parentUuid: id(1) }, signal()),
  ]);
  const rows = decodeNativeSession(await readFile(path), {
    parser: "source-line-fallback",
  })
    .lines.map((line) => line.value)
    .filter(isNativeObject);
  assert.deepEqual(
    rows.map((row) => row.uuid),
    [id(1), id(2)],
  );
  assert.equal(rows[1]?.parentUuid, id(1));
});

test("a noncooperating mutation at commit is detected without overwriting its new bytes", async () => {
  const { directory, path, options } = await fixture();
  await writeFile(path, "OWNED PREFIX\n");
  let raced = false;
  const writer = createNativeSessionWriter({
    ...options,
    admit: async (input) => {
      if (input.stage === "commit" && !raced) {
        raced = true;
        await appendFile(path, "OWNED CONCURRENT APPEND\n");
      }
      return true;
    },
  });
  await assert.rejects(
    writer.appendEntries([entry(1)], { parentUuid: null }, signal()),
    /changed before atomic commit/,
  );
  assert.equal(
    await readFile(path, "utf8"),
    "OWNED PREFIX\nOWNED CONCURRENT APPEND\n",
  );
  assert.deepEqual(await readdir(directory), ["owned.jsonl"]);
});

test("policy denial, cancellation, linked targets, owner mismatch and size bounds leave data unchanged", async () => {
  const { directory, path, options } = await fixture();
  const denied = createNativeSessionWriter({ ...options, admit: () => false });
  await assert.rejects(
    denied.appendEntries([entry(1)], { parentUuid: null }, signal()),
    /admission denied/,
  );
  assert.deepEqual(await readdir(directory), []);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    createNativeSessionWriter(options).appendEntries(
      [entry(1)],
      { parentUuid: null },
      abort.signal,
    ),
  );
  assert.deepEqual(await readdir(directory), []);
  await writeFile(path, "OWNED TARGET\n");
  const alias = join(directory, "linked.jsonl");
  await symlink(path, alias);
  await assert.rejects(
    createNativeSessionWriter({ ...options, path: alias }).appendEntries(
      [entry(1)],
      { parentUuid: null },
      signal(),
    ),
    /regular non-linked/,
  );
  const hard = join(directory, "hard.jsonl");
  await link(path, hard);
  await assert.rejects(
    createNativeSessionWriter(options).appendEntries(
      [entry(1)],
      { parentUuid: null },
      signal(),
    ),
    /regular non-linked/,
  );
  assert.equal(await readFile(path, "utf8"), "OWNED TARGET\n");
  const small = await fixture({ maxFileBytes: 10 });
  await assert.rejects(
    small.writer.appendEntries([entry(1)], { parentUuid: null }, signal()),
    /host writer bound/,
  );
  assert.deepEqual(await readdir(small.directory), []);
  const shortLine = await fixture({ maxLineBytes: 10 });
  await assert.rejects(
    shortLine.writer.appendEntries([entry(1)], { parentUuid: null }, signal()),
    /host writer line bound/,
  );
  assert.deepEqual(await readdir(shortLine.directory), []);
  const foreign = await fixture();
  await foreign.writer.appendEntries(
    [entry(1)],
    { parentUuid: null },
    signal(),
  );
  await assert.rejects(
    createNativeSessionWriter({
      ...foreign.options,
      context: { ...ctx, sessionId: id(99) },
    }).appendEntries([entry(2)], { parentUuid: id(1) }, signal()),
    /owner does not match/,
  );
});

test("advanced compaction/rewind state and invalid source JSON are refused before replacing owned files", async () => {
  const { writer, path } = await fixture();
  const bytes = Buffer.from(
    JSON.stringify({
      type: "last-prompt",
      sessionId: SID,
      leafUuid: null,
      explicit: true,
    }) + "\n",
  );
  await writeFile(path, bytes);
  await assert.rejects(
    writer.appendEntries([entry(1)], { parentUuid: null }, signal()),
    /source adapter/,
  );
  assert.deepEqual(await readFile(path), bytes);
  assert.throws(
    () =>
      envelopeNativeWriterEntries(
        [{ ...entry(1), parentUuid: null }],
        ctx,
        { parentUuid: null },
        new Set(),
      ),
    /pre-enveloped/,
  );
  const block = {
    type: "text",
    text: "owned",
    get surprise(): never {
      throw new Error("Accessor must not run");
    },
  } satisfies Message["content"][number] & { readonly surprise: never };
  assert.throws(
    () =>
      planNativeMessageEntries(
        [{ role: "user", content: [block] }],
        [{ uuid: id(1), timestamp: time(1) }],
      ),
    /accessor/,
  );
});
