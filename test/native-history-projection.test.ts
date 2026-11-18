import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  isNativeObject,
  serializeNativeSession,
  type NativeJson,
} from "../src/native-session-codec.js";
import {
  NativeHistoryProjectionError,
  projectNativeHistory,
  reconstructNativeHistory,
  type NativeHistoryOptions,
} from "../src/native-history-projection.js";
import { projectMessages } from "../src/thinking-history.js";

const scope = { kind: "main", sessionId: "owned-session" } as const;
const options = (leafUuid: string): NativeHistoryOptions => ({
  leafUuid,
  scope,
  recovery: {
    callIdToolResults: true,
    descendantOrder: "depth-first",
    timestampFallback: "reject",
  },
});
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string) => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: `/owned/${id}` },
});
const result = (id: string) => ({
  type: "tool_result",
  tool_use_id: id,
  content: `owned result ${id}`,
});
function row(
  uuid: string,
  parentUuid: string | null,
  type: string,
  content: NativeJson,
  extra: Record<string, NativeJson> = {},
): NativeJson {
  const { nativeMessage, ...rest } = extra;
  return {
    uuid,
    parentUuid,
    type,
    sessionId: scope.sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: type,
      ...(type === "assistant"
        ? {
            id: `response-${uuid}`,
            model: "owned-model",
            stop_reason: "end_turn",
          }
        : {}),
      content,
      ...(isNativeObject(nativeMessage) ? nativeMessage : {}),
    },
    ...rest,
  };
}
const document = (rows: readonly NativeJson[]) =>
  decodeNativeSession(encodeNativeSessionRows(rows), {
    parser: "source-line-fallback",
  });
function expectCode(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (error) =>
      error instanceof NativeHistoryProjectionError && error.code === code,
  );
}

test("explicit chain projection retains owned JSON bytes, detached messages, response identity and signed thinking", () => {
  const doc = document([
    row("u", null, "user", "owned request"),
    row("a", "u", "assistant", [
      {
        type: "thinking",
        thinking: "owned private reasoning",
        signature: "opaque-signature==",
      },
      { type: "redacted_thinking", data: "opaque-data==" },
      text("owned final"),
    ]),
  ]);
  const before = serializeNativeSession(doc),
    projected = projectNativeHistory(doc, options("a"));
  assert.deepEqual(
    projected.nodes.map((node) => node.uuid),
    ["u", "a"],
  );
  assert.deepEqual(projected.messageSources, [["u"], ["a"]]);
  assert.equal(projected.messages[1]?.responseId, "response-a");
  assert.deepEqual(projectMessages(projected.messages)[1]?.content, [
    {
      type: "thinking",
      thinking: "owned private reasoning",
      signature: "opaque-signature==",
    },
    { type: "redacted_thinking", data: "opaque-data==" },
    text("owned final"),
  ]);
  const toolInput = projected.messages[1]?.content[0];
  assert.ok(toolInput);
  if (toolInput.type === "thinking") toolInput.signature = "changed";
  assert.deepEqual(serializeNativeSession(doc), before);
});

test("Esr restores parallel assistant fragments/results with insertion order and keeps reasoning visible", () => {
  const doc = document([
    row("u", null, "user", "owned request"),
    row(
      "think",
      "u",
      "assistant",
      [{ type: "thinking", thinking: "owned", signature: "sig" }],
      { nativeMessage: { id: "shared" } },
    ),
    row("left", "think", "assistant", [call("left")], {
      nativeMessage: { id: "shared", stop_reason: "tool_use" },
    }),
    row("right", "think", "assistant", [call("right")], {
      nativeMessage: { id: "shared", stop_reason: "tool_use" },
    }),
    row("rl", "left", "user", [result("left")]),
    row("rr", "right", "user", [result("right")]),
    row("done", "rr", "assistant", [text("done")]),
  ]);
  const projected = projectNativeHistory(doc, options("done"));
  assert.deepEqual(
    projected.nodes.map((node) => node.uuid),
    ["u", "think", "left", "right", "rl", "rr", "done"],
  );
  assert.deepEqual(projected.messageSources, [
    ["u"],
    ["think", "left", "right"],
    ["rl"],
    ["rr"],
    ["done"],
  ]);
  assert.deepEqual(
    projectMessages(projected.messages).map((message) =>
      message.content.map((block) => block.type),
    ),
    [
      ["text"],
      ["thinking", "tool_use", "tool_use"],
      ["tool_result", "tool_result"],
      ["text"],
    ],
  );
  assert.equal(
    projected.diagnostics.filter(
      (item) => item.code === "assistant-fragment-recovered",
    ).length,
    1,
  );
});

test("call-ID recovery reconnects a misplaced result after its final response fragment and is host gated", () => {
  const doc = document([
    row("u", null, "user", "request"),
    row("a1", "u", "assistant", [call("c1")], {
      nativeMessage: { id: "shared", stop_reason: "tool_use" },
    }),
    row("orphan", "u", "user", [result("c1")], {
      sourceToolAssistantUUID: "a1",
    }),
    row("a2", "a1", "assistant", [call("c2")], {
      nativeMessage: { id: "shared", stop_reason: "tool_use" },
    }),
    row("r2", "a2", "user", [result("c2")]),
    row("done", "r2", "assistant", [text("done")]),
  ]);
  const projected = projectNativeHistory(doc, options("done"));
  assert.deepEqual(
    projected.nodes.map((node) => node.uuid),
    ["u", "a1", "a2", "orphan", "r2", "done"],
  );
  assert.ok(
    projected.diagnostics.some(
      (item) =>
        item.code === "tool-result-reconnected" && item.uuid === "orphan",
    ),
  );
  const disabled = options("done");
  disabled.recovery.callIdToolResults = false;
  expectCode(() => projectNativeHistory(doc, disabled), "unresolved-tool-use");
});

test("raw leaves never choose a newer unrelated branch and an explicit UUID remains mandatory", () => {
  const doc = document([
    row("u", null, "user", "request"),
    row("wanted", "u", "assistant", [text("selected")]),
    row("newer", "u", "assistant", [text("other branch")], {
      timestamp: "2027-01-01T00:00:00Z",
    }),
  ]);
  const projected = projectNativeHistory(doc, options("wanted"));
  assert.deepEqual(
    projected.nodes.map((node) => node.uuid),
    ["u", "wanted"],
  );
  assert.throws(() => projectNativeHistory(doc, options("")), TypeError);
  expectCode(
    () => projectNativeHistory(doc, options("missing")),
    "missing-leaf",
  );
});

test("timestamp repair is explicit, bounded, same raw side, and reports changed parent ownership", () => {
  const doc = document([
    row("u", null, "user", "request"),
    row("a", "missing", "assistant", [text("done")], {
      timestamp: "2026-01-01T00:00:04Z",
    }),
  ]);
  expectCode(() => projectNativeHistory(doc, options("a")), "missing-parent");
  const repaired = options("a");
  repaired.recovery.timestampFallback = "source-5s";
  assert.deepEqual(
    projectNativeHistory(doc, repaired).nodes.map((node) => node.uuid),
    ["u", "a"],
  );
  assert.equal(
    projectNativeHistory(doc, repaired).diagnostics[0]?.code,
    "timestamp-parent-recovered",
  );
  const tooOld = document([
    row("u", null, "user", "request"),
    row("a", "missing", "assistant", [text("done")], {
      timestamp: "2026-01-01T00:00:06Z",
    }),
  ]);
  expectCode(
    () => projectNativeHistory(tooOld, repaired),
    "unrecoverable-parent",
  );
});

test("scope rejects side-agent contamination and supports an explicitly selected isolated agent chain", () => {
  const agent = { isSidechain: true, agentId: "owned-agent" };
  const doc = document([
    row("u", null, "user", "main"),
    row("a", "u", "assistant", [text("main")]),
    row("cu", null, "user", "child", agent),
    row("ca", "cu", "assistant", [text("child")], agent),
  ]);
  assert.deepEqual(
    projectNativeHistory(doc, options("a")).nodes.map((node) => node.uuid),
    ["u", "a"],
  );
  expectCode(() => projectNativeHistory(doc, options("ca")), "scope-mismatch");
  const child = options("ca");
  child.scope = {
    kind: "agent",
    sessionId: scope.sessionId,
    agentId: "owned-agent",
  };
  assert.deepEqual(
    projectNativeHistory(doc, child).nodes.map((node) => node.uuid),
    ["cu", "ca"],
  );
  const collision = document([
    row("u", null, "user", "main"),
    row("a", "u", "assistant", [text("main")], {
      nativeMessage: { id: "collision" },
    }),
    row("ca", null, "assistant", [text("child")], {
      ...agent,
      nativeMessage: { id: "collision" },
    }),
  ]);
  expectCode(
    () => projectNativeHistory(collision, options("a")),
    "response-id-crosses-scope",
  );
});

test("context descendants follow selected native traversal profile but cannot silently become user text", () => {
  const doc = document([
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [text("done")]),
    row("x", "a", "attachment", []),
    row("y", "a", "system", [], { subtype: "owned-context" }),
    row("z", "x", "attachment", []),
  ]);
  assert.deepEqual(
    reconstructNativeHistory(indexNativeSession(doc), options("a")).nodes.map(
      (node) => node.uuid,
    ),
    ["u", "a", "x", "z", "y"],
  );
  const breadth = options("a");
  breadth.recovery.descendantOrder = "breadth-first";
  assert.deepEqual(
    reconstructNativeHistory(indexNativeSession(doc), breadth).nodes.map(
      (node) => node.uuid,
    ),
    ["u", "a", "x", "y", "z"],
  );
  expectCode(
    () => projectNativeHistory(doc, options("a")),
    "unsupported-context-row",
  );
});

test("advanced native resume transforms fail explicitly with source rows retained", () => {
  const base: [NativeJson, NativeJson] = [
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [text("done")]),
  ];
  for (const type of [
    "last-prompt",
    "content-replacement",
    "fork-context-ref",
    "observer-ref",
  ]) {
    const doc = document([...base, { type, sessionId: scope.sessionId }]);
    expectCode(
      () => projectNativeHistory(doc, options("a")),
      `unsupported-${type}`,
    );
    assert.equal(doc.lines.length, 3);
  }
  expectCode(
    () =>
      projectNativeHistory(
        document([
          row("b", null, "system", [], { subtype: "compact_boundary" }),
          row("a", "b", "assistant", [text("done")]),
        ]),
        options("a"),
      ),
    "unsupported-compaction",
  );
  expectCode(
    () =>
      projectNativeHistory(
        document([
          row("u", null, "user", "request", { sentAsUuid: "migrated" }),
          base[1],
        ]),
        options("a"),
      ),
    "unsupported-user-identity-migration",
  );
  for (const extra of [
    { isMeta: true },
    { origin: { kind: "task-notification" } },
    { sourceToolUseID: "source" },
    { retractedMessageUuids: ["u"] },
  ]) {
    expectCode(
      () =>
        projectNativeHistory(
          document([row("u", null, "user", "request", extra), base[1]]),
          options("a"),
        ),
      "unsupported-resume-row-transform",
    );
  }
});

test("tool results preserve image/document API arrays while local text is a separate summary", () => {
  const api = [
    text("owned text"),
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    },
    {
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: "owned document",
      },
    },
  ];
  const doc = document([
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [call("c")], {
      nativeMessage: { stop_reason: "tool_use" },
    }),
    row("r", "a", "user", [
      { type: "tool_result", tool_use_id: "c", content: api, is_error: false },
    ]),
    row("done", "r", "assistant", [text("done")]),
  ]);
  const projected = projectNativeHistory(doc, options("done"));
  assert.deepEqual(projectMessages(projected.messages)[2]?.content, [
    { type: "tool_result", tool_use_id: "c", content: api, is_error: false },
  ]);
});

test("orphan, duplicate and unfinished tool protocols cannot be presented as executable history", () => {
  expectCode(
    () =>
      projectNativeHistory(
        document([
          row("r", null, "user", [result("missing")]),
          row("a", "r", "assistant", [text("done")]),
        ]),
        options("a"),
      ),
    "orphan-tool-result",
  );
  expectCode(
    () =>
      projectNativeHistory(
        document([
          row("u", null, "user", "request"),
          row("a", "u", "assistant", [call("c")]),
        ]),
        options("a"),
      ),
    "unresolved-tool-use",
  );
  expectCode(
    () =>
      projectNativeHistory(
        document([row("u", null, "user", "request")]),
        options("u"),
      ),
    "unsupported-incomplete-turn",
  );
  const doc = document([
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [call("c")], {
      nativeMessage: { stop_reason: "tool_use" },
    }),
    row("r", "a", "user", [result("c"), result("c")]),
    row("done", "r", "assistant", [text("done")]),
  ]);
  expectCode(
    () => projectNativeHistory(doc, options("done")),
    "duplicate-tool-result",
  );
});

test("unsupported provider blocks/fields and malformed signed thinking are rejected without mutation", () => {
  for (const block of [
    { type: "thinking", thinking: "owned", signature: 7 },
    { type: "server_tool_use", id: "x", name: "web_search", input: {} },
    {
      type: "text",
      text: "owned",
      citations: [{ url: "https://owned.invalid" }],
    },
  ]) {
    const doc = document([
        row("u", null, "user", "request"),
        row("a", "u", "assistant", [block]),
      ]),
      before = serializeNativeSession(doc);
    assert.throws(
      () => projectNativeHistory(doc, options("a")),
      NativeHistoryProjectionError,
    );
    assert.deepEqual(serializeNativeSession(doc), before);
  }
});

test("ambiguous call identity, cross-human response reuse and orphan reasoning have explicit errors", () => {
  const duplicate = document([
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [call("same"), call("same")]),
    row("r", "a", "user", [result("same")]),
    row("done", "r", "assistant", [text("done")]),
  ]);
  expectCode(
    () => projectNativeHistory(duplicate, options("done")),
    "duplicate-tool-use-id",
  );
  const reused = document([
    row("u", null, "user", "first"),
    row("a", "u", "assistant", [text("first reply")], {
      nativeMessage: { id: "same" },
    }),
    row("u2", "a", "user", "second"),
    row("b", "u2", "assistant", [text("second reply")], {
      nativeMessage: { id: "same" },
    }),
  ]);
  expectCode(
    () => projectNativeHistory(reused, options("b")),
    "response-crosses-human-boundary",
  );
  expectCode(
    () =>
      projectNativeHistory(
        document([
          row("u", null, "user", "request"),
          row("a", "u", "assistant", [
            { type: "thinking", thinking: "owned", signature: "sig" },
          ]),
        ]),
        options("a"),
      ),
    "unsupported-orphan-thinking",
  );
  expectCode(
    () =>
      projectNativeHistory(
        document([
          row("u", null, "user", "request"),
          row("a", "u", "assistant", [
            { type: "thinking", thinking: "owned", signature: "" },
            text("done"),
          ]),
        ]),
        options("a"),
      ),
    "unsupported-unsigned-thinking",
  );
});

test("codec last-wins UUID indexing remains explicit and a parent cycle is never guessed away", () => {
  const doc = document([
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [text("old")]),
    row("a", "u", "assistant", [text("updated")]),
  ]);
  assert.deepEqual(
    projectNativeHistory(doc, options("a")).messages[1]?.content,
    [text("updated")],
  );
  const cyclic = document([
    row("u", "a", "user", "request"),
    row("a", "u", "assistant", [text("done")]),
  ]);
  expectCode(() => projectNativeHistory(cyclic, options("a")), "parent-cycle");
  const scopeLeak = document([
    row("u", null, "user", "request", { isSidechain: true, agentId: "other" }),
    row("a", "u", "assistant", [text("done")]),
  ]);
  expectCode(
    () => projectNativeHistory(scopeLeak, options("a")),
    "cross-scope-parent-chain",
  );
});

test("unsupported nested result fields cannot disappear through schema projection", () => {
  const doc = document([
    row("u", null, "user", "request"),
    row("a", "u", "assistant", [call("c")], {
      nativeMessage: { stop_reason: "tool_use" },
    }),
    row("r", "a", "user", [
      {
        type: "tool_result",
        tool_use_id: "c",
        content: [{ type: "text", text: "owned", citations: [] }],
      },
    ]),
    row("done", "r", "assistant", [text("done")]),
  ]);
  expectCode(
    () => projectNativeHistory(doc, options("done")),
    "unsupported-tool-result-content",
  );
});
