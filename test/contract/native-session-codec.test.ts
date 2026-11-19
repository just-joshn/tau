import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  appendNativeSessionRows,
  decodeNativeSession,
  encodeNativeSessionRows,
  foldSupportedNativeMetadata,
  indexNativeSession,
  isNativeArray,
  isNativeObject,
  serializeNativeSession,
  traceNativeParentChain,
  type NativeJson,
} from "../../src/native-session-codec.js";
const decode = (input: string | Uint8Array) =>
  decodeNativeSession(typeof input === "string" ? Buffer.from(input) : input, {
    parser: "source-line-fallback",
  });
const row = (
  uuid: string,
  parentUuid: string | null,
  type = "assistant",
  extra = {},
) => ({ type, uuid, parentUuid, ...extra });
// Method-shorthand types are bivariant, so deliberately invalid inputs can reach the runtime checks.
const looseDecode: {
  decode(input: Uint8Array, options: { parser: string }): unknown;
} = { decode: decodeNativeSession };
const looseEncode: { encode(rows: readonly unknown[]): Uint8Array } = {
  encode: encodeNativeSessionRows,
};
const at = <T>(items: readonly T[], index: number): T => present(items[index]);
const present = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined);
  return value;
};
const authored = (rows: NativeJson[]) => decode(encodeNativeSessionRows(rows));

test("lossless bytes survive BOM, CRLF, malformed middle and tail, unknown metadata and invalid UTF8", () => {
  const input = Buffer.concat([
    Buffer.from('\ufeff{"type":"future","payload":"é"}\r\n\n{bad}\n{"text":"'),
    Buffer.from([255]),
    Buffer.from('"}\n{unfinished'),
  ]);
  const doc = decode(input);
  assert.deepEqual(Buffer.from(serializeNativeSession(doc)), input);
  assert.deepEqual(
    doc.lines.map((line) => line.kind),
    ["record", "blank", "invalid", "record", "invalid"],
  );
  assert.equal(at(doc.lines, 0).start, 0);
  assert.equal(
    at(doc.lines, 0).end,
    Buffer.byteLength('\ufeff{"type":"future","payload":"é"}\r\n'),
  );
  assert.equal(doc.lines.at(-1)?.end, input.length);
  assert.equal(doc.tailTerminated, false);
  assert.deepEqual(
    doc.diagnostics.map((item) => item.code),
    ["invalid-json-line", "invalid-json-line", "unterminated-tail"],
  );
});
test("raw byte copies and decoded values cannot mutate serialized history", () => {
  const input = Buffer.from(
    '{"message":{"content":[{"type":"thinking","thinking":"owned","signature":"opaque-signature"}]}}\n',
  );
  const doc = decode(input);
  input.fill(0);
  at(doc.lines, 0).rawBytes().fill(0);
  const output = serializeNativeSession(doc);
  output.fill(0);
  assert.match(
    Buffer.from(serializeNativeSession(doc)).toString(),
    /opaque-signature/,
  );
  const value = at(doc.lines, 0).value;
  assert.ok(isNativeObject(value) && isNativeObject(value.message));
  const content = value.message.content;
  assert.ok(isNativeArray(content));
  assert.throws(() => {
    Array.prototype.push.call(content, "mutation");
  }, TypeError);
});
test("fallback interprets primitives, whitespace and valid unterminated JSON but not leading NUL", () => {
  const doc = decode(' null \n42\n\0{"type":"user"}\n{"valid":true}');
  assert.deepEqual(
    doc.lines.map((line) => line.kind),
    ["record", "record", "invalid", "record"],
  );
  assert.equal(at(doc.lines, 0).value, null);
  assert.deepEqual(at(doc.lines, 3).value, { valid: true });
  assert.equal(doc.tailTerminated, false);
});
test("append seals the original tail with LF and never repairs or discards its bytes", () => {
  const bad = decode("{broken");
  assert.equal(
    Buffer.from(appendNativeSessionRows(bad, [{ type: "new" }])).toString(),
    '{broken\n{"type":"new"}\n',
  );
  assert.equal(
    Buffer.from(appendNativeSessionRows(bad, [])).toString(),
    "{broken",
  );
  assert.equal(
    Buffer.from(appendNativeSessionRows(decode('{"a":1}'), [null])).toString(),
    '{"a":1}\nnull\n',
  );
  assert.equal(
    Buffer.from(appendNativeSessionRows(decode(""), [true])).toString(),
    "true\n",
  );
});
test("resource bounds reject whole decode rather than publishing partial graph", () => {
  for (const options of [
    { maxBytes: 2 },
    { maxLineBytes: 2 },
    { maxLines: 1 },
  ]) {
    assert.throws(
      () =>
        decodeNativeSession(Buffer.from("123\n456\n"), {
          parser: "source-line-fallback",
          ...options,
        }),
      RangeError,
    );
  }
  assert.throws(
    () =>
      decodeNativeSession(Buffer.from(""), {
        parser: "source-line-fallback",
        maxBytes: 0,
      }),
    RangeError,
  );
  assert.throws(
    () => looseDecode.decode(Buffer.from(""), { parser: "bun" }),
    TypeError,
  );
});
test("index has UUID last-wins, ambiguous branches and separate sidechain leaves; progress is not a transcript node", () => {
  const doc = authored([
    row("u", null, "user"),
    row("a", "u", "assistant", { timestamp: "later" }),
    row("b", "u", "assistant", { timestamp: "earlier" }),
    row("child", null, "assistant", { isSidechain: true }),
    row("a", "u", "assistant", { replacement: true }),
    row("progress", "b", "progress"),
    row("attached", "b", "attachment"),
  ]);
  const index = indexNativeSession(doc);
  assert.deepEqual(index.rawLeafUuids, ["a", "child", "b"]);
  assert.deepEqual(index.rawMainLeafUuids, ["a", "b"]);
  assert.equal(present(index.nodes.get("a")).row.replacement, true);
  assert.equal(index.nodes.has("progress"), false);
  assert.equal(at(index.diagnostics, 0).code, "duplicate-uuid-last-wins");
  assert.deepEqual(
    traceNativeParentChain(index, "b").nodes.map((node) => node.uuid),
    ["u", "b"],
  );
});
test("explicit chain reports missing parents and cycles without timestamp repair", () => {
  const index = indexNativeSession(
    authored([
      row("old", null, "user", { timestamp: "2026-01-01T00:00:00Z" }),
      row("missing", "absent", "assistant", {
        timestamp: "2026-01-01T00:00:00.001Z",
      }),
      row("x", "y"),
      row("y", "x"),
    ]),
  );
  const missing = traceNativeParentChain(index, "missing");
  assert.equal(missing.complete, false);
  assert.deepEqual(
    missing.nodes.map((node) => node.uuid),
    ["missing"],
  );
  assert.equal(at(missing.diagnostics, 0).code, "missing-parent");
  assert.equal(
    at(traceNativeParentChain(index, "x").diagnostics, 0).code,
    "parent-cycle",
  );
  assert.equal(
    at(traceNativeParentChain(index, "unknown").diagnostics, 0).code,
    "missing-leaf",
  );
});
test("raw chain does not pretend to perform sibling assistant/tool-result resume recovery", () => {
  const doc = authored([
    row("u", null, "user"),
    row("a1", "u", "assistant", {
      message: {
        id: "api-id",
        content: [{ type: "thinking", signature: "signed", thinking: "owned" }],
      },
    }),
    row("a2", "u", "assistant", {
      message: {
        id: "api-id",
        content: [{ type: "tool_use", id: "call", name: "Read", input: {} }],
      },
    }),
    row("result", "a2", "user", {
      sourceToolAssistantUUID: "a2",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call", content: "owned" },
        ],
      },
    }),
  ]);
  const chain = traceNativeParentChain(indexNativeSession(doc), "result");
  assert.deepEqual(
    chain.nodes.map((node) => node.uuid),
    ["u", "a2", "result"],
  );
  assert.match(
    Buffer.from(serializeNativeSession(doc)).toString(),
    /"signature":"signed"/,
  );
});
test("supported metadata fold is ordered, session-scoped, and preserves unsupported checkpoint semantics", () => {
  const doc = authored([
    { type: "custom-title", sessionId: "s", customTitle: "one" },
    { type: "custom-title", sessionId: "t", customTitle: "other" },
    { type: "custom-title", sessionId: "s", customTitle: "two" },
    { type: "summary", leafUuid: "leaf", summary: "summary" },
    {
      type: "last-prompt",
      sessionId: "s",
      leafUuid: null,
      explicit: true,
      rewound: true,
      cutUuid: "x",
    },
    { type: "file-history-snapshot", messageId: "m", version: 1 },
    { type: "file-history-snapshot", messageId: "m", version: 2 },
    { type: "file-history-delta", messageId: "m", n: 1 },
    { type: "file-history-delta", messageId: "m", n: 2 },
    { type: "attribution-snapshot", messageId: "first" },
    { type: "attribution-snapshot", messageId: "last" },
    { type: "history-suppression", sessionId: "s" },
    { type: "future", untouched: [1] },
    row("leaf", null, "user"),
  ]);
  const metadata = foldSupportedNativeMetadata(doc);
  assert.equal(
    present(metadata.valuesByTypeAndSession.get("custom-title")).get("s"),
    "two",
  );
  assert.equal(
    present(metadata.valuesByTypeAndSession.get("custom-title")).get("t"),
    "other",
  );
  assert.equal(metadata.summariesByLeaf.get("leaf"), "summary");
  assert.equal(present(metadata.fileSnapshotsByMessage.get("m")).version, 2);
  assert.deepEqual(
    present(metadata.fileDeltasByMessage.get("m")).map((row) => row.n),
    [1, 2],
  );
  assert.equal(present(metadata.attributionSnapshot).messageId, "last");
  assert.equal(metadata.historySuppressedSessions.has("s"), true);
  assert.equal(at(metadata.checkpoints, 0).leafUuid, null);
  assert.equal(metadata.records.length, 13);
  // An explicit empty checkpoint is deliberately NOT applied by the raw graph view.
  assert.deepEqual(indexNativeSession(doc).rawLeafUuids, ["leaf"]);
});
test("fresh encoding is compact LF JSON and rejects unsafe values before calling methods", () => {
  assert.equal(
    Buffer.from(encodeNativeSessionRows([{ x: "é" }, null])).toString(),
    '{"x":"é"}\nnull\n',
  );
  let invoked = false;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  const method = {
    toJSON() {
      invoked = true;
      return {};
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse: unknown[] = [];
  sparse.length = 2;
  for (const value of [
    getter,
    method,
    cycle,
    NaN,
    undefined,
    sparse,
    Object.create({ inherited: 1 }),
  ]) {
    assert.throws(() => looseEncode.encode([value]), TypeError);
  }
  assert.equal(invoked, false);
});
