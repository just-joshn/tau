import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  type NativeJson,
  type NativeObject,
} from "../src/native-session-codec.js";
import { projectNativeToolContext } from "../src/native-tool-context.js";
import {
  parseNativeTriBoolean,
  nativeFirstPartyBaseUrl,
  classifyNativeContextText,
  createNativeContextClassifiers,
  hasNativeReminderId,
  isNativeCompleteReminderSequence,
  isNativeDirectEventReminder,
  isNativeProtectedContextText,
  requireOrdinaryNativeContextProjection,
  resolveNativeContextProjectionFlags,
  type NativeContextConstants,
  type NativeContextProjectionFacts,
} from "../src/native-context-classifiers.js";

const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fp = (text: string) => ({ units: text.length, sha256: hash(text) });
const constants: NativeContextConstants = {
  backgroundEqualities: [fp(wrap("OWNED BACKGROUND"))],
  announcementBodyPrefixes: [fp("OWNED ANNOUNCE ")],
  coordinatorBodyPrefix: fp("OWNED COORDINATOR <cited prefix "),
  coordinatorAnswerBodyPrefix: fp("OWNED ANSWER "),
  isolationEqualities: [fp(wrap("OWNED ISOLATION"))],
  voiceHeaderBodyPrefix: fp("OWNED VOICE\n"),
  voiceRecordWrappedPrefix: fp(wrap("OWNED VOICE RECORD")),
  firstLineBodyPrefix: fp("OWNED FIRST LINE "),
  lowDiskBodyPrefix: fp("OWNED LOW DISK "),
  systemFileBodyPrefixes: [fp("OWNED FILE NOTES ")],
};
function row(
  uuid: string,
  type: string,
  fields: NativeObject,
  parentUuid: string | null = null,
): NativeObject {
  return {
    type: "attachment",
    uuid,
    parentUuid,
    sessionId: "owned",
    attachment: { type, ...fields },
  };
}
const nodes = (rows: readonly NativeJson[]) => [
  ...indexNativeSession(
    decodeNativeSession(encodeNativeSessionRows(rows), {
      parser: "source-line-fallback",
    }),
  ).nodes.values(),
];
const facts = (
  extra: Partial<NativeContextProjectionFacts> = {},
): NativeContextProjectionFacts => ({
  replayFeature: true,
  explicitEchoWireToolInputs: undefined,
  humbleHammockEnv: undefined,
  tetherLiveOptIn: false,
  sessionEchoWireToolInputs: undefined,
  liveEchoWireToolInputs: false,
  liveEchoFlagSource: "fallback",
  stellarDriftEnv: undefined,
  firstPartyBaseUrl: true,
  liveApiBlockOrder: false,
  bareFork: false,
  querySource: "sdk",
  liveContextRendering: "announced",
  queryPhase: "ordinary-completed-new-query",
  ...extra,
});
const classify = (text: string, systemTurns = false) =>
  classifyNativeContextText(text, systemTurns, constants);

test("announcement guards require exact plain reminder prefix and prefix bytes", () => {
  assert.equal(classify(wrap("OWNED ANNOUNCE body")), "beside-reorderable");
  assert.equal(classify(wrap(" OWNED ANNOUNCE body")), "ordinary");
  assert.equal(classify("OWNED ANNOUNCE body"), "ordinary");
  assert.equal(
    classify(
      '<system-reminder id="0123456789abcdef">\nOWNED ANNOUNCE body\n</system-reminder>',
    ),
    "ordinary",
  );
});
test("background and isolation guards are trimEnd equality, not broad prefixes", () => {
  for (const body of ["OWNED BACKGROUND", "OWNED ISOLATION"]) {
    assert.equal(classify(wrap(body) + "\n  "), "beside-reorderable");
    assert.equal(classify(wrap(body) + "AFTER"), "ordinary");
    assert.equal(classify(" " + wrap(body)), "ordinary");
  }
});
test("coordinator prefix ignores citations inside its own header but excludes later cited entries", () => {
  assert.equal(
    classify(wrap("OWNED COORDINATOR <cited prefix BODY")),
    "beside-reorderable",
  );
  assert.equal(
    classify(
      wrap('OWNED COORDINATOR <cited prefix BODY <cited author="user">'),
    ),
    "ordinary",
  );
  assert.equal(
    classify(wrap("OWNED COORDINATOR <cited prefix BODY <cited")),
    "beside-reorderable",
  );
});
test("coordinator answer is recognized after first newline under plain or valid ID opening", () => {
  assert.equal(classify(wrap("OWNED ANSWER BODY")), "beside-reorderable");
  assert.equal(
    classify('<system-reminder id="0123456789abcdef">\nOWNED ANSWER BODY'),
    "beside-reorderable",
  );
  assert.equal(
    classify('<system-reminder id="NOTHEX">\nOWNED ANSWER BODY'),
    "ordinary",
  );
  assert.equal(classify("prefix\nOWNED ANSWER BODY"), "ordinary");
});
test("voice header has an immediate newline and record guard includes its complete wrapped prefix", () => {
  assert.equal(classify(wrap("OWNED VOICE\nBODY")), "beside-reorderable");
  assert.equal(classify(wrap("OWNED VOICE BODY")), "ordinary");
  assert.equal(
    classify(wrap("OWNED VOICE RECORD") + "AFTER"),
    "beside-reorderable",
  );
  assert.equal(classify(wrap("OWNED VOICE RECORD CHANGED")), "ordinary");
});
test("first-line note is nonreorderable only when XTe does not establish complete reminder sequence", () => {
  assert.equal(classify("<system-reminder>\nOWNED FIRST LINE BODY"), "beside");
  assert.equal(classify(wrap("OWNED FIRST LINE BODY")), "beside-reorderable");
  assert.equal(classify(wrap("OWNED FIRST LINE BODY") + "\nOUTSIDE"), "beside");
  assert.equal(
    classify(wrap("OWNED FIRST LINE BODY") + "\n" + wrap("ANOTHER")),
    "beside-reorderable",
  );
});
test("low-disk and system-only file note guards preserve native feature split", () => {
  assert.equal(classify(wrap("OWNED LOW DISK 10 bytes")), "beside-reorderable");
  assert.equal(classify(wrap("OWNED FILE NOTES BODY")), "ordinary");
  assert.equal(
    classify(wrap("OWNED FILE NOTES BODY"), true),
    "beside-reorderable",
  );
});
test("ID reminder grammar is lowercase 16..32 hex followed by literal LF", () => {
  for (const id of ["0123456789abcdef", "a".repeat(32)])
    assert.equal(
      hasNativeReminderId(`<system-reminder id="${id}">\nBODY`),
      true,
    );
  for (const id of [
    "a".repeat(15),
    "a".repeat(33),
    "ABCDEF0123456789",
    "with-space ",
  ])
    assert.equal(
      hasNativeReminderId(`<system-reminder id="${id}">\nBODY`),
      false,
    );
  assert.equal(
    hasNativeReminderId('<system-reminder id="0123456789abcdef">\r\nBODY'),
    false,
  );
  const plain = '<system-reminder id="0123456789abcdef">\nORDINARY';
  assert.equal(classify(plain), "ordinary");
  assert.equal(classify(plain, true), "beside-reorderable");
});
test("XTe accepts only complete plain sequences, without nested plain openings or outside text", () => {
  assert.equal(
    isNativeCompleteReminderSequence(
      wrap("BODY") + "\n\t" + wrap("SECOND") + " \n",
    ),
    true,
  );
  for (const text of [
    "",
    " ",
    " " + wrap("BODY"),
    wrap("BODY") + "OUTSIDE",
    "<system-reminder>\nNO CLOSE",
    wrap(wrap("NESTED")),
    '<system-reminder id="0123456789abcdef">\nBODY\n</system-reminder>',
  ])
    assert.equal(isNativeCompleteReminderSequence(text), false);
});
test("direct event reminder is distinct from DBt and from raw unwrapped event text", () => {
  const text = wrap('<event nonce="owned">BODY</event>');
  assert.equal(isNativeDirectEventReminder(text), true);
  assert.equal(classify(text), "direct-event");
  assert.equal(classify('<event nonce="owned">BODY</event>'), "ordinary");
});
test("shipped fingerprints recognize ordinary short protocol guards without generated guidance", () => {
  assert.equal(
    classifyNativeContextText(wrap("## Proactivity: owned"), false),
    "beside-reorderable",
  );
  assert.equal(
    classifyNativeContextText(wrap("Disk space is low: owned"), false),
    "beside-reorderable",
  );
  assert.equal(
    isNativeProtectedContextText(wrap("OWNED ORDINARY MODEL"), false),
    false,
  );
});
test("factory supplies concrete result and full text classifiers with explicit feature facts", () => {
  const classifier = createNativeContextClassifiers({
    systemTurns: false,
    pollEventsEnabled: true,
    constants,
  });
  assert.equal(
    classifier.result({
      result: {
        type: "tool_result",
        tool_use_id: "gettask_owned",
        content: "BODY",
      },
      owner: undefined,
    }),
    "beside",
  );
  assert.equal(
    classifier.text({
      text: wrap("OWNED FIRST LINE BODY"),
      phase: "incoming",
      uuid: "owned",
      nativeType: "owned",
      source: "recorded-rendered",
    }),
    "beside-reorderable",
  );
  const malformed = Object.defineProperty(
    { systemTurns: false, pollEventsEnabled: true },
    "systemTurns",
    { value: undefined },
  );
  assert.throws(
    () => createNativeContextClassifiers(malformed),
    /unsupported-native-classifier-feature-facts/,
  );
});
test("explicit echo-wire override wins over saved and forced values", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: true,
    }),
  ]);
  const flags = resolveNativeContextProjectionFlags(
    saved,
    facts({ explicitEchoWireToolInputs: false, humbleHammockEnv: true }),
  );
  assert.equal(flags.echoWireToolInputs, false);
  assert.equal(flags.echoWireSource, "explicit");
  assert.deepEqual(flags.cacheUpdates, {});
});
test("saved echo false wins over an existing true session cache, without overwriting that cache", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: false,
    }),
  ]);
  const flags = resolveNativeContextProjectionFlags(
    saved,
    facts({ sessionEchoWireToolInputs: true }),
  );
  assert.equal(flags.echoWireToolInputs, false);
  assert.equal(flags.echoWireSource, "saved-snapshot");
  assert.deepEqual(flags.cacheUpdates, {});
});
test("force and tether precedence are explicit and proposed saved cache pins are passive", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: true,
    }),
  ]);
  const forced = resolveNativeContextProjectionFlags(
    saved,
    facts({ humbleHammockEnv: false, tetherLiveOptIn: true }),
  );
  assert.equal(forced.echoWireToolInputs, false);
  assert.equal(forced.echoWireSource, "forced");
  assert.deepEqual(forced.cacheUpdates, {});
  const factsObject = facts();
  const before = structuredClone(factsObject);
  const pinned = resolveNativeContextProjectionFlags(saved, factsObject);
  assert.deepEqual(pinned.cacheUpdates, { echoWireToolInputs: true });
  assert.deepEqual(factsObject, before);
});
test("missing/disabled saved echo falls through to session cache or actual live flag", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: false,
    }),
  ]);
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ replayFeature: false, sessionEchoWireToolInputs: true }),
    ).echoWireToolInputs,
    true,
  );
  const configured = resolveNativeContextProjectionFlags(
    [],
    facts({ liveEchoWireToolInputs: true, liveEchoFlagSource: "configured" }),
  );
  assert.deepEqual(configured.cacheUpdates, { echoWireToolInputs: true });
  assert.deepEqual(
    resolveNativeContextProjectionFlags(
      [],
      facts({ liveEchoWireToolInputs: true }),
    ).cacheUpdates,
    {},
  );
});
test("invalid last snapshot suppresses earlier flags; malformed optional values fall back", () => {
  const saved = nodes([
    row("p1", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: true,
      contextRendering: "inline",
    }),
    row("p2", "prompt_snapshot", {
      systemPrompt: "INVALID",
      echoWireToolInputs: true,
    }),
  ]);
  const flags = resolveNativeContextProjectionFlags(saved, facts());
  assert.equal(flags.echoWireToolInputs, false);
  assert.equal(flags.contextRendering, "announced");
  assert.equal(flags.snapshotUuid, "p2");
  const malformed = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: "bad",
      contextRendering: "bad",
    }),
  ]);
  assert.equal(
    resolveNativeContextProjectionFlags(
      malformed,
      facts({ liveEchoWireToolInputs: true }),
    ).echoWireToolInputs,
    true,
  );
});
test("API block order comes from Lx, independently of snapshot echo-wire metadata", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: false,
      echoApiBlockOrder: true,
    }),
  ]);
  assert.equal(
    resolveNativeContextProjectionFlags(saved, facts()).echoApiBlockOrder,
    false,
  );
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ stellarDriftEnv: true, firstPartyBaseUrl: false }),
    ).echoApiBlockOrder,
    true,
  );
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ stellarDriftEnv: false, tetherLiveOptIn: true }),
    ).echoApiBlockOrder,
    false,
  );
  assert.equal(
    resolveNativeContextProjectionFlags(saved, facts({ tetherLiveOptIn: true }))
      .echoApiBlockOrder,
    true,
  );
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ firstPartyBaseUrl: false, liveApiBlockOrder: true }),
    ).echoApiBlockOrder,
    false,
  );
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ liveApiBlockOrder: true }),
    ).echoApiBlockOrder,
    true,
  );
});
test("context rendering uses saved mode then last valid partial session context then actual live outcome", () => {
  const saved = nodes([
    row("s", "session_context", { context: {} }),
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      contextRendering: "inline",
    }),
  ]);
  assert.equal(
    resolveNativeContextProjectionFlags(saved, facts()).contextRendering,
    "inline",
  );
  const inferred = resolveNativeContextProjectionFlags(
    nodes([row("s", "session_context", { context: {} })]),
    facts({ liveContextRendering: "inline" }),
  );
  assert.equal(inferred.contextRendering, "announced");
  assert.equal(inferred.contextRenderingSource, "session-context");
  const invalidLast = nodes([
    row("s1", "session_context", { context: {} }),
    row("s2", "session_context", { context: { unknown: "invalid" } }),
  ]);
  assert.equal(
    resolveNativeContextProjectionFlags(
      invalidLast,
      facts({ liveContextRendering: "inline" }),
    ).contextRendering,
    "inline",
  );
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ replayFeature: false, liveContextRendering: undefined }),
    ).contextRendering,
    undefined,
  );
});
test("bare fork return precedes rendering replay except for resume-cache-warm", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      contextRendering: "announced",
    }),
  ]);
  const bare = resolveNativeContextProjectionFlags(
    saved,
    facts({ bareFork: true }),
  );
  assert.equal(bare.contextRendering, undefined);
  assert.equal(bare.contextRenderingSource, "bare-fork");
  assert.equal(
    resolveNativeContextProjectionFlags(
      saved,
      facts({ bareFork: true, querySource: "resume_cache_warm" }),
    ).contextRendering,
    "announced",
  );
});
test("render point invalidates system-prompt replay but does not clear direct HA/W_o saved flags", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      echoWireToolInputs: false,
      contextRendering: "announced",
    }),
    row("point", "prompt_render_point", { cause: "set_model_system_prompt" }),
  ]);
  const flags = resolveNativeContextProjectionFlags(saved, facts());
  assert.equal(flags.contextRenderingSource, "saved-snapshot");
  assert.equal(flags.echoWireSource, "saved-snapshot");
  assert.equal(flags.promptRenderPointAfterSnapshot, true);
  assert.throws(
    () => requireOrdinaryNativeContextProjection(flags),
    /unsupported-native-prompt-render-point/,
  );
});
test("ordinary completed new-query reasoning profile is false; interrupted/recovery profiles are explicit", () => {
  const saved = nodes([
    row("p", "prompt_snapshot", {
      systemPrompt: ["OWNED"],
      preserveTrailingThinking: true,
    }),
  ]);
  assert.equal(
    resolveNativeContextProjectionFlags(saved, facts())
      .preserveTrailingThinking,
    false,
  );
  for (const queryPhase of ["interrupted-resume", "in-query-recovery"]) {
    if (
      queryPhase !== "interrupted-resume" &&
      queryPhase !== "in-query-recovery"
    )
      continue;
    assert.throws(
      () => resolveNativeContextProjectionFlags(saved, facts({ queryPhase })),
      /unsupported-thinking-resume-profile/,
    );
  }
});
test("binding guard withholds unimplemented wire echo and inline rendering profiles", () => {
  assert.doesNotThrow(() =>
    requireOrdinaryNativeContextProjection(
      resolveNativeContextProjectionFlags([], facts()),
    ),
  );
  assert.throws(
    () =>
      requireOrdinaryNativeContextProjection(
        resolveNativeContextProjectionFlags(
          [],
          facts({ humbleHammockEnv: true }),
        ),
      ),
    /unsupported-native-wire-input-echo/,
  );
  assert.throws(
    () =>
      requireOrdinaryNativeContextProjection(
        resolveNativeContextProjectionFlags(
          [],
          facts({ liveContextRendering: "inline" }),
        ),
      ),
    /unsupported-native-context-rendering-profile/,
  );
  const invalid = Object.defineProperty(facts(), "replayFeature", {
    value: undefined,
  });
  assert.throws(
    () => resolveNativeContextProjectionFlags([], invalid),
    /unsupported-native-projection-feature-facts/,
  );
});
const capturedPath = new URL(
  "../artifacts/differential-pass/background-agents/original-gated-background.json",
  import.meta.url,
);
test.skipIf(!existsSync(capturedPath))(
  "full default classifiers preserve the owned CHILD Read/context result hash",
  async () => {
    const capture: unknown = JSON.parse(readFileSync(capturedPath, "utf8"));
    const get = (value: unknown, key: string): unknown =>
      typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined;
    const raw = get(get(capture, "output_snapshot"), "raw_text");
    if (typeof raw !== "string") throw new Error("Unexpected owned fixture");
    assert.equal(
      hash(raw),
      "de5cbf2ddb398ed00ec08b230c22a944cc8df07b102b04bcb3c9cbdb6b816b88",
    );
    const output = await projectNativeToolContext(
      decodeNativeSession(Buffer.from(raw), { parser: "source-line-fallback" }),
      {
        selection: {
          leafUuid: "f76a3fbc-00bd-48d8-925d-fc940ebd0997",
          scope: {
            kind: "agent",
            sessionId: "dd3777c6-3c5a-4a1b-bef0-d2afcea6fd01",
            agentId: "a6c5c3ffcfe95d1a1",
          },
          recovery: {
            callIdToolResults: true,
            descendantOrder: "depth-first",
            timestampFallback: "reject",
          },
        },
        host: {
          systemTurns: false,
          reminderFold: false,
          withoutAttachmentHooks: true,
          admit: () => true,
        },
        classifiers: createNativeContextClassifiers({
          systemTurns: false,
          pollEventsEnabled: false,
        }),
        echoApiBlockOrder: false,
        preserveTrailingThinking: false,
        signal: new AbortController().signal,
      },
    );
    let result: string | undefined;
    for (const message of output.messages)
      for (const block of message.content)
        if (
          block.type === "tool_result" &&
          block.tool_use_id === "owned-background-child-1"
        )
          result = block.content;
    const requests = get(capture, "requests");
    if (!Array.isArray(requests)) throw new Error("Missing owned requests");
    const messages = get(get(requests[3], "body"), "messages");
    if (!Array.isArray(messages)) throw new Error("Missing owned messages");
    const blocks = get(messages[2], "content");
    if (!Array.isArray(blocks)) throw new Error("Missing owned result");
    const expected = get(blocks[0], "content");
    if (typeof expected !== "string" || result === undefined)
      throw new Error("Missing owned result strings");
    assert.equal(hash(result), hash(expected));
  },
);

test("native triBool distinguishes explicit false from absent or unrecognized input", () => {
  for (const value of ["1", "TRUE", " yes ", "on"])
    assert.equal(parseNativeTriBoolean(value), true);
  for (const value of ["0", "FALSE", " no ", "off"])
    assert.equal(parseNativeTriBoolean(value), false);
  for (const value of [undefined, "", "2", "enabled", "undefined"])
    assert.equal(parseNativeTriBoolean(value), undefined);
});
test("first-party API predicate uses canonical provider and explicit cache/environment assumptions", () => {
  const base = {
    provider: "firstParty",
    baseUrl: undefined,
    assumeEnv: undefined,
    assumeCache: false,
  };
  assert.equal(nativeFirstPartyBaseUrl(base), true);
  assert.equal(
    nativeFirstPartyBaseUrl({
      ...base,
      baseUrl: "https://api.anthropic.com/v1",
    }),
    true,
  );
  assert.equal(
    nativeFirstPartyBaseUrl({ ...base, baseUrl: "http://127.0.0.1:1" }),
    false,
  );
  assert.equal(
    nativeFirstPartyBaseUrl({
      ...base,
      baseUrl: "https://api.anthropic.com:444",
    }),
    false,
  );
  assert.equal(
    nativeFirstPartyBaseUrl({
      ...base,
      baseUrl: "https://api.anthropic.com.evil.invalid",
    }),
    false,
  );
  assert.equal(
    nativeFirstPartyBaseUrl({ ...base, provider: "gateway" }),
    false,
  );
  assert.equal(
    nativeFirstPartyBaseUrl({
      ...base,
      baseUrl: "http://127.0.0.1:1",
      assumeCache: true,
    }),
    true,
  );
  assert.equal(
    nativeFirstPartyBaseUrl({
      ...base,
      baseUrl: "http://127.0.0.1:1",
      assumeCache: true,
      assumeEnv: false,
    }),
    false,
  );
});
