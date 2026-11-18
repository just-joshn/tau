import assert from "node:assert/strict";
import test from "node:test";
import { appendProjectedToolResultContent, normalizeHistoryMessages, orderAssistantBlocks } from "../src/history-normalization.js";
import type { HistoryProjectionMessage } from "../src/history-normalization.js";
import type { ApiToolContent, WireBlock } from "../src/types.js";

const text = (value: string): WireBlock => ({ type: "text", text: value });
const call = (id: string): WireBlock => ({ type: "tool_use", id, name: "Write", input: { file_path: "relative.txt", content: id } });
const result = (id: string, error = false): WireBlock => ({ type: "tool_result", tool_use_id: id, content: `output ${id}`, ...(error ? { is_error: true } : {}) });
const assistant = (responseId: string, ...content: WireBlock[]): HistoryProjectionMessage => ({ role: "assistant", responseId, content });
const user = (...content: WireBlock[]): HistoryProjectionMessage => ({ role: "user", content });
const thinking: WireBlock = { type: "thinking", thinking: "signed", signature: "signature" };
const redacted: WireBlock = { type: "redacted_thinking", data: "opaque" };

test("reused response identities coalesce tool calls and result rows, regardless of result errors", () => {
  for (const error of [false, true]) {
    const rows = [user(text("task")), ...Array.from({ length: 5 }, (_, index) => [assistant("same-response", call(`${index}`)), user(result(`${index}`, error))]).flat()];
    const wire = normalizeHistoryMessages(rows);
    assert.equal(wire.length, 3);
    assert.deepEqual(wire[1]?.content, Array.from({ length: 5 }, (_, index) => call(`${index}`)));
    assert.deepEqual(wire[2]?.content, Array.from({ length: 5 }, (_, index) => result(`${index}`, error)));
  }
});

test("distinct or absent response identities never imply a shared response", () => {
  for (const missing of [false, true]) {
    const rows: HistoryProjectionMessage[] = [user(text("task"))];
    for (let index = 0; index < 5; index++) rows.push(missing ? { role: "assistant", content: [call(`${index}`)] } : assistant(`response-${index}`, call(`${index}`)), user(result(`${index}`, true)));
    assert.deepEqual(normalizeHistoryMessages(rows), rows.map(({ role, content }) => ({ role, content })));
  }
});

test("a genuine intervening user turn clears response merge candidates", () => {
  const rows = [assistant("same", text("first")), user(text("next task")), assistant("same", text("second"))];
  assert.equal(normalizeHistoryMessages(rows).length, 3);
});

test("candidate scan sees consecutive users after their source-defined result-first merge", () => {
  const rows = [assistant("same", call("one")), user(result("one")), user(text("interleaved user text")), assistant("same", call("two")), user(result("two"))];
  const wire = normalizeHistoryMessages(rows);
  assert.equal(wire.length, 2);
  assert.deepEqual(wire[0]?.content, [call("one"), call("two")]);
  assert.deepEqual(wire[1]?.content, [result("one"), result("two"), text("interleaved user text")]);
});

test("project document result carriers clear candidate scan even with ordinary results", () => {
  const wire = normalizeHistoryMessages([assistant("same", call("one")), user(result("one"), result("projectread_owned")), assistant("same", text("second"))]);
  assert.equal(wire.length, 3);
});

test("active-context slicing prevents coalescing across compaction boundaries", () => {
  const rows = [assistant("same", call("old")), user(result("old")), user(text("summary")), assistant("same", call("new")), user(result("new"))];
  assert.deepEqual(normalizeHistoryMessages(rows, { startIndex: 2 }), [user(text("summary")), { role: "assistant", content: [call("new")] }, user(result("new"))]);
});

test("assistant tools move after prose while signed thinking chains retain exact block order", () => {
  assert.deepEqual(orderAssistantBlocks([call("one"), text("prose"), call("two")]), [text("prose"), call("one"), call("two")]);
  assert.deepEqual(orderAssistantBlocks([thinking, call("one"), redacted]), [thinking, call("one"), redacted]);
});

test("same-response merge preserves signed reasoning, input values, IDs and durable source", () => {
  const rows = [assistant("same", thinking, call("one")), user(result("one")), assistant("same", text("finished"))];
  const before = structuredClone(rows);
  for (const row of rows) { Object.freeze(row.content); Object.freeze(row); }
  const wire = normalizeHistoryMessages(rows);
  assert.deepEqual(rows, before);
  assert.deepEqual(wire[0]?.content, [thinking, text("finished"), call("one")]);
  assert.equal(JSON.stringify(wire).includes("responseId"), false);
  assert.equal(wire[0]?.content[0], thinking);
});

test("same-response merge removes whitespace except empty text and thinking separators", () => {
  const wire = normalizeHistoryMessages([assistant("same", thinking, text(" ")), assistant("same", redacted, text(" \t"), text(""), text("end"))]);
  assert.deepEqual(wire[0]?.content, [thinking, text(" "), redacted, text(""), text("end")]);
});

test("all-thinking merge retains whitespace when no nonthinking block survives", () => {
  const wire = normalizeHistoryMessages([assistant("same", text(" "), thinking), assistant("same", redacted)]);
  assert.deepEqual(wire[0]?.content, [text(" "), thinking, redacted]);
});

test("API index order uses stable per-block indices and omits local indexing fields", () => {
  const rows = [{ ...assistant("same", call("one"), thinking), apiBlockIndex: 2, apiBlockIndices: [4, 2] }, { ...assistant("same", text("prose")), apiBlockIndex: 3 }];
  assert.deepEqual(normalizeHistoryMessages(rows, { echoApiBlockOrder: true }), [{ role: "assistant", content: [thinking, text("prose"), call("one")] }]);
  assert.deepEqual(normalizeHistoryMessages([{ ...assistant("same", call("one"), text("text")), apiBlockIndex: 0 }], { echoApiBlockOrder: true })[0]?.content, [call("one"), text("text")]);
});

test("adjacent user rows keep all results first and retain text-row newline seams", () => {
  const wire = normalizeHistoryMessages([user(result("one"), text("pre")), user(text("post"), result("two")), user(text("end"))]);
  assert.deepEqual(wire, [user(result("one"), result("two"), text("pre\n"), text("post\n"), text("end"))]);
});

test("hook sibling context stays in source order without guessed ownership", () => {
  const wire = normalizeHistoryMessages([assistant("same", call("one")), user(result("one"), text("pre hook one"), text("post hook one")), assistant("same", call("two")), user(result("two"), text("pre hook two"))]);
  assert.deepEqual(wire[1]?.content, [result("one"), result("two"), text("pre hook one"), text("post hook one"), text("pre hook two")]);
});

test("explicit tool-result content append trims and joins text without changing the original", () => {
  const original = { type: "tool_result" as const, tool_use_id: "one", content: " output \n", is_error: true };
  const additions: ApiToolContent[] = [{ type: "text", text: " context " }, { type: "text", text: "  " }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aQ==" } }];
  assert.deepEqual(appendProjectedToolResultContent(original, additions), { ...original, content: "output\n\ncontext" });
  assert.equal(original.content, " output \n");
  assert.equal(additions.length, 3);
});

test("rich append preserves media order and merges only neighboring text blocks", () => {
  const image: ApiToolContent = { type: "image", source: { type: "base64", media_type: "image/png", data: "aQ==" } };
  const original = { type: "tool_result" as const, tool_use_id: "one", content: [{ type: "text" as const, text: " first " }, image, { type: "text" as const, text: " tail " }] };
  const wire = appendProjectedToolResultContent(original, [{ type: "text", text: " context " }]);
  assert.deepEqual(wire.content, [{ type: "text", text: "first" }, image, { type: "text", text: "tail\n\ncontext" }]);
  assert.equal(original.content[2]?.type === "text" && original.content[2].text, " tail ");
});
