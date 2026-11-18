import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  openNativeSessionPersistence,
  type NativeSessionPersistenceOptions,
} from "../src/native-session-persistence.js";
import {
  decodeNativeSession,
  isNativeObject,
  serializeNativeSession,
} from "../src/native-session-codec.js";
import { importNativeSessionFile } from "../src/native-session-import.js";
import { projectMessages } from "../src/thinking-history.js";
import { createTools } from "../src/tools.js";
import type { Message } from "../src/types.js";
import type { NativeMessageIdentity } from "../src/native-session-writer.js";
import {
  createNativeAttachmentEvent,
  type NativePersistenceEvent,
} from "../src/native-persistence-events.js";

const SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  MODEL = "claude-sonnet-4-6";
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const identity = (
  n: number,
  stopReason?: "tool_use" | "end_turn",
): NativeMessageIdentity => ({
  uuid: id(n),
  timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  ...(stopReason ? { stopReason } : {}),
});
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const answer = (n: number): Message => ({
  role: "assistant",
  responseId: `owned-response-${n}`,
  responseModel: MODEL,
  usage: { input_tokens: 10, output_tokens: 3 },
  content: [{ type: "text", text: `OWNED_ANSWER_${n}` }],
});
const signal = () => new AbortController().signal;
function ownership(): NativeSessionPersistenceOptions["withExclusiveOwnership"] {
  let tail = Promise.resolve();
  return async (_path, work) => {
    const previous = tail,
      next = Promise.withResolvers<void>();
    tail = next.promise;
    await previous;
    try {
      return await work();
    } finally {
      next.resolve();
    }
  };
}
async function fixture(changes: Partial<NativeSessionPersistenceOptions> = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-persistence-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "owned.jsonl");
  const options: NativeSessionPersistenceOptions = {
    path,
    context: {
      sessionId: SID,
      cwd: root,
      version: "2.1.326",
      entrypoint: "cli",
      userType: "external",
      sidechain: false,
    },
    initial: { kind: "fresh" },
    withExclusiveOwnership: ownership(),
    admit: () => true,
    ...changes,
  };
  const open = (initial = options.initial) =>
    openNativeSessionPersistence({ ...options, initial }, signal());
  return { root, path, options, open };
}
const rows = (bytes: Uint8Array) =>
  decodeNativeSession(bytes, { parser: "source-line-fallback" }).lines.flatMap(
    (line) => (isNativeObject(line.value) ? [line.value] : []),
  );

test("one owner persists real Read work across separate model/tool batches, closes, and resumes exact model-visible history", async () => {
  const f = await fixture(),
    owner = await f.open();
  await writeFile(join(f.root, "note.txt"), "OWNED_READ_BYTES\n");
  const prompt = user("Read the owned note"),
    call: Message = {
      ...answer(2),
      content: [
        {
          type: "thinking",
          thinking: "OWNED_SIGNED_REASONING",
          signature: "owned-signature==",
        },
        {
          type: "tool_use",
          id: "owned-read",
          name: "Read",
          input: { file_path: join(f.root, "note.txt") },
        },
      ],
    };
  await owner.appendMessages(
    [prompt],
    [identity(1)],
    { promptId: "owned-prompt" },
    signal(),
  );
  const afterPrompt = await readFile(f.path);
  await owner.appendMessages([call], [identity(2, "tool_use")], {}, signal());
  const tools = createTools({
    cwd: f.root,
    mode: "default",
    approve: async () => false,
  });
  const result = await tools.execute(
    {
      type: "tool_use",
      id: "owned-read",
      name: "Read",
      input: { file_path: "note.txt" },
    },
    signal(),
  );
  assert.equal(result.is_error, undefined);
  const resultMessage: Message = { role: "user", content: [result] },
    final = answer(4);
  await owner.appendMessages(
    [resultMessage, final],
    [identity(3), identity(4, "end_turn")],
    {},
    signal(),
  );
  await owner.close();
  const bytes = await readFile(f.path),
    stored = rows(bytes);
  assert.deepEqual(bytes.subarray(0, afterPrompt.length), afterPrompt);
  const resultRow = stored.find((row) => row.uuid === id(3));
  assert.equal(resultRow?.parentUuid, id(2));
  assert.equal(resultRow?.sourceToolAssistantUUID, id(2));
  assert.equal(stored.at(-1)?.leafUuid, id(4));
  assert.equal(owner.state().cursorUuid, id(4));
  assert.equal(
    owner.state().sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.equal(imported.session.id, SID);
  assert.deepEqual(
    projectMessages(imported.session.messages),
    projectMessages([prompt, call, resultMessage, final]),
  );
  assert.deepEqual(await readFile(f.path), bytes);
});

test("cold reopen derives the real tool-parent ledger and appends a result without inventing an assistant UUID", async () => {
  const f = await fixture(),
    first = await f.open();
  const prompt = user("OWNED_PENDING_READ"),
    call: Message = {
      ...answer(2),
      content: [
        {
          type: "tool_use",
          id: "pending-read",
          name: "Read",
          input: { file_path: "note.txt" },
        },
      ],
    };
  await first.appendMessages(
    [prompt, call],
    [identity(1), identity(2, "tool_use")],
    {},
    signal(),
  );
  await first.close();
  const prefix = await readFile(f.path);
  const reopened = await f.open({ kind: "owned-existing", cursorUuid: id(2) });
  await reopened.appendMessages(
    [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "pending-read",
            content: "OWNED_RESULT",
          },
        ],
      },
      answer(4),
    ],
    [identity(3), identity(4, "end_turn")],
    {},
    signal(),
  );
  await reopened.close();
  const bytes = await readFile(f.path);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  assert.equal(
    rows(bytes).find((row) => row.uuid === id(3))?.sourceToolAssistantUUID,
    id(2),
  );
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.match(JSON.stringify(imported.session.messages), /OWNED_RESULT/);
});

test("source import is readonly, fresh ownership refuses adoption, and explicitly owned copies preserve their original prefix", async () => {
  const f = await fixture(),
    owner = await f.open();
  await owner.appendMessages(
    [user("OWNED_ORIGINAL"), answer(2)],
    [identity(1), identity(2, "end_turn")],
    {},
    signal(),
  );
  await owner.close();
  const original = await readFile(f.path),
    copy = join(f.root, "owned-copy.jsonl");
  await assert.rejects(f.open(), /cannot adopt/);
  await assert.rejects(
    f.open({ kind: "owned-existing", cursorUuid: id(99) }),
    /cursor/,
  );
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.equal(imported.session.id, SID);
  assert.deepEqual(await readFile(f.path), original);
  await copyFile(f.path, copy);
  const copied = await openNativeSessionPersistence(
    {
      ...f.options,
      path: copy,
      initial: { kind: "owned-existing", cursorUuid: id(2) },
    },
    signal(),
  );
  await copied.appendMessages(
    [user("OWNED_CONTINUED"), answer(4)],
    [identity(3), identity(4, "end_turn")],
    {},
    signal(),
  );
  await copied.close();
  assert.deepEqual(
    (await readFile(copy)).subarray(0, original.length),
    original,
  );
  assert.deepEqual(await readFile(f.path), original);
});

test("shared ownership serializes incremental batches and stale independent owners must reopen", async () => {
  const f = await fixture(),
    owner = await f.open();
  await owner.appendMessages([user("FIRST")], [identity(1)], {}, signal());
  const stale = await f.open({ kind: "owned-existing", cursorUuid: id(1) });
  const [second, third] = await Promise.all([
    owner.appendMessages([answer(2)], [identity(2, "end_turn")], {}, signal()),
    owner.appendMessages([user("THIRD")], [identity(3)], {}, signal()),
  ]);
  assert.equal(second.leafUuid, id(2));
  assert.equal(third.leafUuid, id(3));
  const before = await readFile(f.path);
  await assert.rejects(
    stale.appendMessages([user("STALE")], [identity(4)], {}, signal()),
    /changed outside/,
  );
  await assert.rejects(stale.close(), /changed outside/);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(
    rows(before).find((row) => row.uuid === id(3))?.parentUuid,
    id(2),
  );
  await owner.close();
});

test("failed admission and cancellation do not advance the owner; a deliberate retry can commit and close drains accepted work", async () => {
  let admitted = false;
  const f = await fixture({
      admit: ({ stage }) => stage === "open" || admitted,
    }),
    owner = await f.open();
  await assert.rejects(
    owner.appendMessages([user("RETRY")], [identity(1)], {}, signal()),
    /commit admission/,
  );
  assert.equal(owner.state().cursorUuid, null);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    owner.appendMessages([user("RETRY")], [identity(1)], {}, aborted.signal),
    /abort/i,
  );
  admitted = true;
  const saved = owner.appendMessages(
    [user("RETRY")],
    [identity(1)],
    {},
    signal(),
  );
  const closed = owner.close();
  await saved;
  await closed;
  assert.equal(owner.state().cursorUuid, id(1));
  await assert.rejects(
    owner.appendMessages([user("CLOSED")], [identity(2)], {}, signal()),
    /closing/,
  );
});

test("strict provenance rejects missing completion fields, unsupported metadata, duplicates, malformed and foreign files without writes", async () => {
  const f = await fixture(),
    owner = await f.open();
  await assert.rejects(
    owner.appendMessages([answer(1)], [identity(1)], {}, signal()),
    /stop metadata/,
  );
  await assert.rejects(
    owner.appendMessages(
      [{ ...user("CONTEXT"), instructionFiles: [] }],
      [identity(1)],
      {},
      signal(),
    ),
    /unsupported native/,
  );
  await assert.rejects(
    owner.appendMessages(
      [user("A"), user("B")],
      [identity(1), identity(1)],
      {},
      signal(),
    ),
    /new stable/,
  );
  await owner.appendMessages([user("COMMITTED")], [identity(1)], {}, signal());
  const before = await readFile(f.path);
  await assert.rejects(
    owner.appendMessages(
      [user("MODIFIED_REPLAY")],
      [identity(1)],
      {},
      signal(),
    ),
    /new stable/,
  );
  assert.deepEqual(await readFile(f.path), before);
  await assert.rejects(
    openNativeSessionPersistence(
      {
        ...f.options,
        context: { ...f.options.context, sessionId: id(99) },
        initial: { kind: "owned-existing", cursorUuid: id(1) },
      },
      signal(),
    ),
    /cursor|owner/,
  );
  await appendFile(f.path, "MALFORMED\n");
  await assert.rejects(
    f.open({ kind: "owned-existing", cursorUuid: id(1) }),
    /Malformed/,
  );
});

test("a hardlink, symlink, or advanced native fold cannot become the owning persistence destination", async () => {
  const f = await fixture(),
    owner = await f.open();
  await owner.appendMessages([user("OWNED")], [identity(1)], {}, signal());
  await owner.close();
  const prefix = await readFile(f.path),
    linked = join(f.root, "linked.jsonl"),
    symbolic = join(f.root, "symbolic.jsonl");
  await link(f.path, linked);
  await assert.rejects(
    f.open({ kind: "owned-existing", cursorUuid: id(1) }),
    /single-linked/,
  );
  await rm(linked);
  await symlink(f.path, symbolic);
  await assert.rejects(
    openNativeSessionPersistence(
      {
        ...f.options,
        path: symbolic,
        initial: { kind: "owned-existing", cursorUuid: id(1) },
      },
      signal(),
    ),
    /single-linked/,
  );
  await appendFile(
    f.path,
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      uuid: id(5),
      parentUuid: null,
      sessionId: SID,
    }) + "\n",
  );
  await assert.rejects(
    f.open({ kind: "owned-existing", cursorUuid: id(1) }),
    /compaction/,
  );
  assert.deepEqual((await readFile(f.path)).subarray(0, prefix.length), prefix);
});

test("a fresh owner does not silently adopt an empty file created after admission", async () => {
  const f = await fixture(),
    owner = await f.open();
  await writeFile(f.path, "");
  await assert.rejects(
    owner.appendMessages([user("MUST_NOT_ADOPT")], [identity(1)], {}, signal()),
    /changed outside/,
  );
  assert.equal(owner.state().cursorUuid, null);
  assert.equal((await readFile(f.path)).length, 0);
  await assert.rejects(owner.close(), /changed outside/);
});

const physicalAssistant = (
  n: number,
  response: string,
  index: number,
  content: NativePersistenceEvent["message"],
): NativePersistenceEvent => ({
  type: "assistant",
  uuid: id(n),
  timestamp: identity(n).timestamp,
  apiBlockIndex: index,
  requestedModel: MODEL,
  requestId: `request-${response}`,
  message: {
    id: response,
    type: "message",
    role: "assistant",
    model: MODEL,
    content,
    stop_reason: response === "physical-call" ? "tool_use" : "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  },
});
const physicalUser = (n: number, text: string): NativePersistenceEvent => ({
  type: "user",
  uuid: id(n),
  timestamp: identity(n).timestamp,
  message: { role: "user", content: [{ type: "text", text }] },
});
const attachment = (n: number, payload: unknown) =>
  createNativeAttachmentEvent(payload, {
    uuid: id(n),
    timestamp: identity(n).timestamp,
  });

test("owned document reads serialize with in-flight appends and return detached committed bytes", async () => {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    lock = ownership();
  let hold = false;
  const f = await fixture({
    withExclusiveOwnership: (path, work) =>
      lock(path, async () => {
        if (hold) {
          hold = false;
          started.resolve();
          await release.promise;
        }
        return work();
      }),
  });
  const owner = await f.open();
  assert.equal((await owner.readDocument(signal())).lines.length, 0);
  hold = true;
  const append = owner.appendEvents(
    [physicalUser(1, "COMMITTED")],
    {},
    signal(),
  );
  await started.promise;
  const projected = owner.readDocument(signal());
  release.resolve();
  await append;
  const document = await projected;
  assert.deepEqual(
    Buffer.from(serializeNativeSession(document)),
    await readFile(f.path),
  );
  const row = document.lines.find((line) => isNativeObject(line.value));
  assert.ok(row && isNativeObject(row.value));
  const value = row.value;
  assert.throws(() => Object.assign(value, { uuid: id(9) }), TypeError);
  const raw = row.rawBytes();
  raw.fill(0);
  const reread = await owner.readDocument(signal());
  assert.equal(rows(serializeNativeSession(reread))[0]?.uuid, id(1));
  await owner.close();
  await assert.rejects(owner.readDocument(signal()), /closing/);
});

test("owned projection reads recheck admission, abort and foreign-byte changes", async () => {
  let admitted = true;
  const f = await fixture({ admit: () => admitted }),
    owner = await f.open();
  await owner.appendEvents([physicalUser(1, "OWNED")], {}, signal());
  const bytes = await readFile(f.path);
  admitted = false;
  await assert.rejects(owner.readDocument(signal()), /admission denied/);
  admitted = true;
  const aborted = new AbortController();
  aborted.abort(new Error("OWNED_READ_ABORT"));
  await assert.rejects(owner.readDocument(aborted.signal), /OWNED_READ_ABORT/);
  await appendFile(f.path, "\n");
  await assert.rejects(owner.readDocument(signal()), /changed outside/);
  assert.deepEqual(
    await readFile(f.path),
    Buffer.concat([bytes, Buffer.from("\n")]),
  );
  await assert.rejects(owner.close(), /changed outside/);
});

test("owned projection cannot adopt a foreign empty file or forget a failed append", async () => {
  const f = await fixture(),
    owner = await f.open();
  await writeFile(f.path, "");
  await assert.rejects(owner.readDocument(signal()), /changed outside/);
  await rm(f.path);
  await owner.appendEvents([physicalUser(1, "OWNED")], {}, signal());
  await assert.rejects(
    owner.appendEvents([physicalUser(1, "DUPLICATE")], {}, signal()),
    /new stable message identities/,
  );
  assert.deepEqual(
    Buffer.from(serializeNativeSession(await owner.readDocument(signal()))),
    await readFile(f.path),
  );
  await assert.rejects(owner.close(), /new stable message identities/);
});

test("physical events persist split real-response rows, typed context and snapshot tails, reopen and reimport without flattening identities", async () => {
  const f = await fixture(),
    owner = await f.open();
  const instruction = attachment(2, {
    type: "instructions",
    files: [
      {
        path: join(f.root, "CLAUDE.md"),
        type: "Project",
        content: "OWNED_PHYSICAL_INSTRUCTION",
      },
    ],
  });
  const catalog = attachment(3, {
    type: "skill_listing",
    content: "- owned: physical",
    skillCount: 1,
    isInitial: true,
    names: ["owned"],
    digests: ["owned-digest"],
  });
  await owner.appendEvents(
    [physicalUser(1, "OWNED_PHYSICAL_REQUEST"), instruction, catalog],
    { promptId: "physical-prompt" },
    signal(),
  );
  await owner.appendEvents(
    [
      physicalAssistant(4, "physical-call", 0, [
        { type: "text", text: "OWNED_PHYSICAL_PRELUDE" },
      ]),
      physicalAssistant(5, "physical-call", 1, [
        {
          type: "tool_use",
          id: "physical-read",
          name: "Read",
          input: { file_path: "note.txt" },
        },
      ]),
    ],
    {},
    signal(),
  );
  const result: NativePersistenceEvent = {
    type: "user",
    uuid: id(6),
    timestamp: identity(6).timestamp,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "physical-read",
          content: "1\tOWNED_RAW_PHYSICAL_READ",
        },
      ],
    },
    sourceToolAssistantUUID: id(5),
    toolUseResult: {
      type: "text",
      file: {
        filePath: "note.txt",
        content: "OWNED_RAW_PHYSICAL_READ",
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
  const hook = attachment(7, {
    type: "hook_additional_context",
    hookName: "PostToolUse:Read",
    hookEvent: "PostToolUse",
    toolUseID: "physical-read",
    content: ["OWNED_PHYSICAL_HOOK"],
  });
  const final = physicalAssistant(8, "physical-final", 0, [
    { type: "text", text: "OWNED_PHYSICAL_FINAL" },
  ]);
  const snapshot = attachment(9, {
    type: "prompt_snapshot",
    systemPrompt: ["OWNED_EFFECTIVE_SYSTEM"],
    tools: [
      {
        name: "Read",
        description: "OWNED_ACTUAL_TOOL",
        schema: { name: "Read", input_schema: { type: "object" } },
      },
    ],
    reminderFold: false,
    echoWireToolInputs: false,
    contextRendering: "announced",
  });
  await owner.appendEvents([result, hook, final, snapshot], {}, signal());
  await owner.close();
  const prefix = await readFile(f.path),
    stored = rows(prefix);
  assert.equal(
    stored.find((row) => row.uuid === id(6))?.sourceToolAssistantUUID,
    id(5),
  );
  assert.equal(stored.find((row) => row.uuid === id(4))?.apiBlockIndex, 0);
  assert.equal(stored.find((row) => row.uuid === id(5))?.apiBlockIndex, 1);
  assert.equal(stored.at(-1)?.leafUuid, id(9));
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  const projection = projectMessages(imported.session.messages),
    serialized = JSON.stringify(projection);
  for (const text of [
    "OWNED_PHYSICAL_INSTRUCTION",
    "- owned: physical",
    "OWNED_RAW_PHYSICAL_READ",
    "OWNED_PHYSICAL_HOOK",
    "OWNED_PHYSICAL_FINAL",
  ])
    assert.ok(serialized.includes(text), text);
  assert.equal(serialized.split("OWNED_PHYSICAL_HOOK").length, 2);
  const projectedBlocks = projection.flatMap((message) => message.content);
  const readResult = projectedBlocks.find(
    (block) =>
      block.type === "tool_result" && block.tool_use_id === "physical-read",
  );
  assert.ok(readResult && readResult.type === "tool_result");
  assert.match(JSON.stringify(readResult.content), /OWNED_PHYSICAL_HOOK/);
  assert.equal(
    projectedBlocks.some(
      (block) =>
        block.type === "text" && block.text.includes("OWNED_PHYSICAL_HOOK"),
    ),
    false,
  );
  const reopened = await f.open({ kind: "owned-existing", cursorUuid: id(9) });
  await reopened.appendEvents(
    [
      physicalUser(10, "OWNED_NEXT_REQUEST"),
      physicalAssistant(11, "physical-next", 0, [
        { type: "text", text: "OWNED_NEXT_FINAL" },
      ]),
    ],
    {},
    signal(),
  );
  await reopened.close();
  const after = await readFile(f.path);
  assert.deepEqual(after.subarray(0, prefix.length), prefix);
  const continued = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.deepEqual(
    projectMessages(continued.session.messages).slice(0, projection.length),
    projection,
  );
});

test("physical events reject wrong fragment parents and unsupported result producers before changing the file", async () => {
  const f = await fixture(),
    owner = await f.open();
  await owner.appendEvents(
    [
      physicalUser(1, "REQUEST"),
      physicalAssistant(2, "physical-call", 0, [
        {
          type: "tool_use",
          id: "physical-read",
          name: "Read",
          input: { file_path: "note.txt" },
        },
      ]),
    ],
    {},
    signal(),
  );
  const before = await readFile(f.path);
  const bad = {
    type: "user",
    uuid: id(3),
    timestamp: identity(3).timestamp,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "physical-read", content: "NO" },
      ],
    },
    sourceToolAssistantUUID: id(1),
  };
  await assert.rejects(
    owner.appendEvents([bad], {}, signal()),
    /actual committed assistant fragment/,
  );
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(owner.state().cursorUuid, id(2));
  await assert.rejects(
    owner.appendEvents(
      [
        physicalAssistant(4, "physical-call", 1, [
          { type: "tool_use", id: "physical-read", name: "Read", input: {} },
        ]),
      ],
      {},
      signal(),
    ),
    /duplicated/,
  );
  assert.deepEqual(await readFile(f.path), before);
});

test("physical pre-hook placement keeps its assistant/result relationship through native context replay", async () => {
  const f = await fixture(),
    owner = await f.open();
  const pre = attachment(3, {
    type: "hook_additional_context",
    content: ["OWNED_PRE_PHYSICAL_CONTEXT"],
    hookName: "PreToolUse:Read",
    toolUseID: "pre-read",
    hookEvent: "PreToolUse",
  });
  const result: NativePersistenceEvent = {
    type: "user",
    uuid: id(4),
    timestamp: identity(4).timestamp,
    sourceToolAssistantUUID: id(2),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "pre-read",
          content: "OWNED_PRE_READ_RESULT",
        },
      ],
    },
  };
  await owner.appendEvents(
    [
      physicalUser(1, "PRE_REQUEST"),
      physicalAssistant(2, "physical-call", 0, [
        { type: "tool_use", id: "pre-read", name: "Read", input: {} },
      ]),
      pre,
      result,
      physicalAssistant(5, "pre-final", 0, [
        { type: "text", text: "PRE_FINAL" },
      ]),
    ],
    {},
    signal(),
  );
  await owner.close();
  const stored = rows(await readFile(f.path));
  assert.equal(stored.find((row) => row.uuid === id(3))?.parentUuid, id(2));
  assert.equal(stored.find((row) => row.uuid === id(4))?.parentUuid, id(2));
  const imported = await importNativeSessionFile({
    path: f.path,
    cwd: f.root,
    model: MODEL,
    signal: signal(),
    env: {},
  });
  assert.match(
    JSON.stringify(projectMessages(imported.session.messages)),
    /OWNED_PRE_PHYSICAL_CONTEXT/,
  );
});

test("fresh physical attachment-only materialization and failed/aborted event batches keep the cursor and parent ledger unchanged", async () => {
  let commitAdmitted = true;
  const f = await fixture({
      admit: ({ stage }) => stage === "open" || commitAdmitted,
    }),
    owner = await f.open();
  const snapshot = attachment(3, {
    type: "prompt_snapshot",
    systemPrompt: ["OWNED_SYSTEM"],
    reminderFold: false,
    echoWireToolInputs: false,
    contextRendering: "announced",
  });
  await assert.rejects(
    owner.appendEvents([snapshot], {}, signal()),
    /first conversation row/,
  );
  assert.equal(owner.state().cursorUuid, null);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  const events = [
    physicalUser(1, "OWNED_FIRST"),
    physicalAssistant(2, "physical-call", 0, [
      { type: "tool_use", id: "uncommitted-call", name: "Read", input: {} },
    ]),
    snapshot,
  ];
  commitAdmitted = false;
  await assert.rejects(
    owner.appendEvents(events, {}, signal()),
    /commit admission/,
  );
  assert.equal(owner.state().cursorUuid, null);
  await assert.rejects(
    owner.appendEvents(
      [
        {
          type: "user",
          uuid: id(4),
          timestamp: identity(4).timestamp,
          sourceToolAssistantUUID: id(2),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "uncommitted-call",
                content: "NO",
              },
            ],
          },
        },
      ],
      {},
      signal(),
    ),
    /actual committed assistant fragment/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    owner.appendEvents(events, {}, aborted.signal),
    /abort/i,
  );
  commitAdmitted = true;
  await owner.appendEvents(events, {}, signal());
  await owner.close();
  assert.equal(owner.state().cursorUuid, id(3));
  assert.equal(
    rows(await readFile(f.path)).filter((row) => row.type === "assistant")
      .length,
    1,
  );
});
