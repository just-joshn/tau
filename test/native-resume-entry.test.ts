import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeNativeSession,
  encodeNativeSessionRows,
  serializeNativeSession,
  type NativeJson,
} from "../src/native-session-codec.js";
import {
  foldOrdinaryNativeResume,
  matchNativeResumeTitle,
  nativeRestoredAgentIntent,
  nativeSessionAdoption,
  parseNativeResumeTarget,
  prepareNativePrintResume,
  selectNativeContinue,
  type NativeResumeCandidate,
  type NativeResumeEntryOptions,
} from "../src/native-resume-entry.js";

const ID = "11111111-1111-1111-1111-111111111111",
  OTHER = "22222222-2222-2222-2222-222222222222";
const candidate = (
  sessionId = ID,
  extra: Partial<NativeResumeCandidate> = {},
): NativeResumeCandidate => ({
  sessionId,
  transcriptPath: `/owned/native/${sessionId}.jsonl`,
  modifiedAtMs: 10,
  ...extra,
});
function rows(sessionId = ID): NativeJson[] {
  return [
    {
      type: "user",
      uuid: "u",
      parentUuid: null,
      sessionId,
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/owned/original",
      message: { role: "user", content: "OWNED REQUEST" },
    },
    {
      type: "assistant",
      uuid: "a",
      parentUuid: "u",
      sessionId,
      timestamp: "2026-01-01T00:00:01Z",
      cwd: "/owned/original",
      message: {
        role: "assistant",
        id: "response",
        model: "owned-model",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "OWNED FINAL" }],
      },
    },
  ];
}
const document = (values: readonly NativeJson[]) =>
  decodeNativeSession(encodeNativeSessionRows(values), {
    parser: "source-line-fallback",
  });
const signal = () => new AbortController().signal;
function options(
  changes: Partial<NativeResumeEntryOptions> = {},
): NativeResumeEntryOptions {
  return {
    workingDirectory: "/owned/current",
    newSessionId: () => OTHER,
    continueCandidates: async () => [],
    titleCandidates: async () => [],
    resolveSessionId: async (id) => `/owned/native/${id}.jsonl`,
    liveBackgroundSessionIds: async () => new Set(),
    admitTranscript: () => true,
    readTranscript: async () => encodeNativeSessionRows(rows()),
    recovery: {
      callIdToolResults: true,
      descendantOrder: "depth-first",
      timestampFallback: "reject",
    },
    ...changes,
  };
}

test("native print parser accepts the actual resume value grammar, including arbitrary .jsonl filenames", () => {
  assert.deepEqual(
    parseNativeResumeTarget(` ${ID} `, () => OTHER),
    { kind: "id", sessionId: ID },
  );
  assert.deepEqual(
    parseNativeResumeTarget(" ../arbitrary-name.JSONL ", () => OTHER),
    {
      kind: "file",
      path: "../arbitrary-name.JSONL",
      provisionalSessionId: OTHER,
    },
  );
  assert.equal(
    parseNativeResumeTarget("https://owned.invalid/x.jsonl", () => OTHER).kind,
    "file",
  );
  assert.equal(
    parseNativeResumeTarget("https://owned.invalid/session", () => OTHER).kind,
    "url",
  );
  assert.deepEqual(
    parseNativeResumeTarget(" Owned Title ", () => OTHER),
    { kind: "title", title: "Owned Title" },
  );
  assert.throws(() => parseNativeResumeTarget(true, () => OTHER), /--print/);
});

test("title matching is exact normalized case, custom-before-ai, deduplicated by session and newest hydrated modified date", () => {
  const selected = matchNativeResumeTitle(
    [
      candidate(ID, { customTitle: " Owned " }),
      candidate(ID, { customTitle: "OWNED", modifiedAtMs: 20 }),
      candidate(OTHER, { aiTitle: "owned", modifiedAtMs: 15 }),
      candidate("third", { customTitle: "", aiTitle: "owned" }),
      candidate("fourth", { customTitle: "owned suffix" }),
    ],
    " owned ",
  );
  assert.deepEqual(
    selected.map((item) => [item.sessionId, item.modifiedAtMs]),
    [
      [ID, 20],
      [OTHER, 15],
    ],
  );
});

test("continue preserves native supplied order and filters bookkeeping/superseded/archive/live candidates", () => {
  const list = [
    candidate("book", { bookkeepingOnly: true }),
    candidate("old", { superseded: true }),
    candidate("archived", { archived: true }),
    candidate(ID, { modifiedAtMs: 1 }),
    candidate(OTHER, { modifiedAtMs: 999 }),
  ];
  assert.deepEqual(selectNativeContinue(list, new Set(), false), {
    kind: "selected",
    candidate: list[3],
  });
  assert.equal(
    selectNativeContinue(list, new Set([ID]), false).kind,
    "selected",
  );
  const selected = selectNativeContinue(list, new Set([ID]), false);
  assert.ok(
    selected.kind === "selected" && selected.candidate.sessionId === OTHER,
  );
  assert.deepEqual(
    selectNativeContinue(
      [candidate(ID, { continuedInSessionId: OTHER }), candidate()],
      new Set([OTHER]),
      false,
    ),
    { kind: "held-by-background", sessionId: OTHER },
  );
  assert.equal(
    selectNativeContinue(
      [candidate(ID, { sessionKind: "background" })],
      undefined,
      false,
    ).kind,
    "none",
  );
  assert.equal(
    selectNativeContinue(
      [candidate(ID, { sessionKind: "background" })],
      undefined,
      true,
    ).kind,
    "selected",
  );
});

test("session identity adoption is distinct from file basename and explicit fork remains fresh", () => {
  assert.deepEqual(nativeSessionAdoption(ID, false), {
    adoptedSessionId: ID,
    effectiveFork: false,
  });
  assert.deepEqual(nativeSessionAdoption(ID, true), {
    adoptedSessionId: null,
    effectiveFork: true,
  });
  assert.deepEqual(
    nativeSessionAdoption("owned_registered", false, () => true),
    { adoptedSessionId: "owned_registered", effectiveFork: false },
  );
  for (const bad of ["CON", "../unsafe", "not-registered", ""])
    assert.equal(nativeSessionAdoption(bad, false).effectiveFork, true);
});

test("restored agent intent follows native stream/explicit/main-agent/host-mode precedence", () => {
  const input = {
    resumedAgentSetting: "owned-reader",
    mainThreadAgentType: undefined,
    blockedByHostMode: false,
    hasStreamingInput: false,
    explicitAgentFlag: "explicit",
  };
  assert.deepEqual(nativeRestoredAgentIntent(input), {
    attempt: true,
    loud: true,
  });
  assert.deepEqual(
    nativeRestoredAgentIntent({ ...input, hasStreamingInput: true }),
    { attempt: false, loud: false },
  );
  assert.deepEqual(
    nativeRestoredAgentIntent({
      ...input,
      hasStreamingInput: true,
      explicitAgentFlag: undefined,
    }),
    { attempt: true, loud: false },
  );
  assert.deepEqual(
    nativeRestoredAgentIntent({ ...input, mainThreadAgentType: "explicit" }),
    { attempt: false, loud: false },
  );
  assert.deepEqual(
    nativeRestoredAgentIntent({ ...input, blockedByHostMode: true }),
    { attempt: false, loud: false },
  );
});

test("ordinary fold applies only verified terminal checkpoints and preserves the original document bytes", () => {
  const doc = document([
      ...rows(),
      { type: "last-prompt", sessionId: ID, leafUuid: "a", explicit: true },
    ]),
    before = serializeNativeSession(doc);
  const folded = foldOrdinaryNativeResume(doc);
  assert.equal(folded.leafUuid, "a");
  assert.equal(folded.appliedCheckpoints, 1);
  assert.equal(folded.transcriptSessionId, ID);
  assert.equal(folded.documentForProjection.lines.length, 2);
  assert.equal(doc.lines.length, 3);
  assert.deepEqual(serializeNativeSession(doc), before);
  assert.equal(foldOrdinaryNativeResume(document(rows())).leafUuid, "a");
});

test("rewound/cleared/mismatched checkpoints and compaction require an explicit full fold adapter", () => {
  for (const checkpoint of [
    { leafUuid: "a", rewound: true },
    { leafUuid: null, explicit: true },
    { leafUuid: "u", explicit: true },
  ]) {
    assert.throws(
      () =>
        foldOrdinaryNativeResume(
          document([
            ...rows(),
            { type: "last-prompt", sessionId: ID, ...checkpoint },
          ]),
        ),
      /full fold adapter/,
    );
  }
  assert.throws(
    () =>
      foldOrdinaryNativeResume(
        document([
          {
            type: "system",
            uuid: "b",
            parentUuid: null,
            subtype: "compact_boundary",
            sessionId: ID,
          },
          ...rows(),
        ]),
      ),
    /full fold adapter/,
  );
});

test("real owned JSONL path resume loads the recovered chain and returns passive cwd/agent/storage identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-owned-native-resume-")),
    cwd = join(directory, "cwd");
  await mkdir(cwd);
  const path = join(directory, "arbitrary.JSONL"),
    content = [
      ...rows(),
      { type: "last-prompt", sessionId: ID, leafUuid: "a" },
      { type: "relocated", sessionId: ID, relocatedCwd: "/owned/relocated" },
      { type: "agent-setting", sessionId: ID, agentSetting: "owned-reader" },
    ];
  const bytes = encodeNativeSessionRows(content);
  await writeFile(path, bytes);
  const admitted: string[] = [];
  const result = await prepareNativePrintResume(
    { resume: "../arbitrary.JSONL" },
    options({
      workingDirectory: cwd,
      admitTranscript: (input) => {
        admitted.push(input.path);
        assert.equal(input.source, "file");
        return true;
      },
      readTranscript: (file) => readFile(file),
    }),
    signal(),
  );
  assert.equal(result?.kind, "resumed");
  assert.deepEqual(admitted, [path]);
  assert.equal(result?.adoptedSessionId, ID);
  assert.equal(result?.sessionProjectPath, "/owned/relocated");
  assert.equal(result?.agentSetting, "owned-reader");
  assert.equal(result?.storageProjectDirectory, directory);
  assert.equal(result?.appliedCheckpoints, 1);
  assert.equal(result?.messages[1]?.content[0]?.type, "text");
  assert.deepEqual(await readFile(path), bytes);
});

test("explicit UUID lookup retains requested adoption identity while preserving the actual row scope", async () => {
  const result = await prepareNativePrintResume(
    { resume: OTHER },
    options(),
    signal(),
  );
  assert.equal(result?.requestedSessionId, OTHER);
  assert.equal(result?.transcriptSessionId, ID);
  assert.equal(result?.adoptedSessionId, OTHER);
});

test("continue success precedes resume parsing; a miss falls through to actual title lookup", async () => {
  const success = await prepareNativePrintResume(
    { continue: true, resume: true },
    options({
      continueCandidates: async () => [candidate()],
      newSessionId: () => {
        throw new Error("Not reached");
      },
    }),
    signal(),
  );
  assert.equal(success?.source, "continue");
  const fallback = await prepareNativePrintResume(
    { continue: true, resume: "owned title" },
    options({
      titleCandidates: async () => [
        candidate(ID, { customTitle: "OWNED TITLE" }),
      ],
    }),
    signal(),
  );
  assert.equal(fallback?.source, "title");
  assert.equal(
    await prepareNativePrintResume({ continue: true }, options(), signal()),
    undefined,
  );
  let queries = 0;
  await assert.rejects(
    prepareNativePrintResume(
      { continue: true, resume: ID },
      options({
        liveBackgroundSessionIds: async () =>
          ++queries === 1 ? new Set() : new Set([ID]),
      }),
      signal(),
    ),
    /held by a background/,
  );
  assert.equal(queries, 2);
});

test("title ambiguity, live-session hold and denied files stop before transcript reading", async () => {
  let reads = 0;
  const readTranscript = async () => {
    reads++;
    return encodeNativeSessionRows(rows());
  };
  await assert.rejects(
    prepareNativePrintResume(
      { resume: "owned" },
      options({
        readTranscript,
        titleCandidates: async () => [
          candidate(ID, { customTitle: "owned" }),
          candidate(OTHER, { aiTitle: "owned" }),
        ],
      }),
      signal(),
    ),
    /ambiguous/,
  );
  await assert.rejects(
    prepareNativePrintResume(
      { resume: ID },
      options({
        readTranscript,
        liveBackgroundSessionIds: async () => new Set([ID]),
      }),
      signal(),
    ),
    /held by a background/,
  );
  await assert.rejects(
    prepareNativePrintResume(
      { resume: "owned.jsonl" },
      options({ readTranscript, admitTranscript: () => false }),
      signal(),
    ),
    /admission denied/,
  );
  await assert.rejects(
    prepareNativePrintResume(
      { resume: "https://owned.invalid/session" },
      options({ readTranscript }),
      signal(),
    ),
    /remote hydration/,
  );
  await assert.rejects(
    prepareNativePrintResume(
      { resume: ID, resumeSessionAt: "u" },
      options({ readTranscript }),
      signal(),
    ),
    /complete entry host/,
  );
  assert.equal(reads, 0);
});

test("an explicit advanced fold callback owns its transformed document and is invoked once", async () => {
  let calls = 0;
  const original = [
    ...rows(),
    { type: "last-prompt", sessionId: ID, leafUuid: "u", explicit: true },
  ];
  const result = await prepareNativePrintResume(
    { resume: "owned.jsonl" },
    options({
      readTranscript: async () => encodeNativeSessionRows(original),
      fold: () => {
        calls++;
        return {
          documentForProjection: document(rows()),
          transcriptSessionId: ID,
          leafUuid: "a",
          appliedCheckpoints: 1,
        };
      },
    }),
    signal(),
  );
  assert.equal(calls, 1);
  assert.equal(result?.originalDocument.lines.length, 3);
  assert.equal(result?.projection.nodes.length, 2);
});

test("fork bypasses native live hold but does not adopt old writer identity or run a provider", async () => {
  const result = await prepareNativePrintResume(
    { resume: ID, forkSession: true },
    options({ liveBackgroundSessionIds: async () => new Set([ID]) }),
    signal(),
  );
  assert.equal(result?.effectiveFork, true);
  assert.equal(result?.adoptedSessionId, null);
  assert.equal(result?.storageProjectDirectory, undefined);
});
