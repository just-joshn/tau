import assert from "node:assert/strict";
import test from "node:test";
import {
  markThinkingStripped,
  planThinkingStrip,
  projectMessages,
} from "../src/thinking-history.js";
import type { Message } from "../src/types.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string) => ({
  type: "tool_use" as const,
  id,
  name: "Write",
  input: { file_path: "relative.txt", content: id },
});
const result = (id: string) => ({
  type: "tool_result" as const,
  tool_use_id: id,
  content: `output ${id}`,
});
const thinking = (signature: string) => ({
  type: "thinking" as const,
  thinking: "retained original",
  signature,
});

test("wire projection retains response identity until same-response merge and removes local hook data", () => {
  const rows: Message[] = [
    { role: "user", content: [text("task")] },
    {
      role: "assistant",
      responseId: "shared",
      content: [thinking("signed"), call("one")],
    },
    {
      role: "user",
      content: [
        {
          ...result("one"),
          effectiveToolInput: {
            file_path: "/rewritten.txt",
            content: "rewrite",
          },
          hookResponse: { raw: true },
        },
        text("pre hook one"),
        text("post hook one"),
      ],
    },
    { role: "assistant", responseId: "shared", content: [call("two")] },
    { role: "user", content: [{ ...result("two"), is_error: true }] },
  ];
  const original = structuredClone(rows);
  assert.deepEqual(projectMessages(rows), [
    { role: "user", content: [text("task")] },
    {
      role: "assistant",
      content: [thinking("signed"), call("one"), call("two")],
    },
    {
      role: "user",
      content: [
        result("one"),
        { ...result("two"), is_error: true },
        text("pre hook one"),
        text("post hook one"),
      ],
    },
  ]);
  assert.deepEqual(rows, original);
});

test("distinct and missing response identities keep real tool rounds separate through projection", () => {
  for (const identities of [
    ["first", "second"],
    [undefined, undefined],
  ]) {
    const rows: Message[] = [
      {
        role: "assistant",
        ...(identities[0] === undefined ? {} : { responseId: identities[0] }),
        content: [call("one")],
      },
      { role: "user", content: [result("one")] },
      {
        role: "assistant",
        ...(identities[1] === undefined ? {} : { responseId: identities[1] }),
        content: [call("two")],
      },
      { role: "user", content: [result("two")] },
    ];
    assert.deepEqual(
      projectMessages(rows).map((row) => row.role),
      ["assistant", "user", "assistant", "user"],
    );
  }
});

test("prefix repair maps a signature in a coalesced wire response back to its durable row", () => {
  const rows: Message[] = [
    { role: "user", content: [text("task")] },
    {
      role: "assistant",
      responseId: "shared",
      content: [thinking("first"), call("one")],
    },
    { role: "user", content: [result("one")] },
    {
      role: "assistant",
      responseId: "shared",
      content: [thinking("second"), text("reply")],
    },
    { role: "user", content: [text("next")] },
  ];
  const wire = projectMessages(rows);
  assert.deepEqual(wire[1]?.content, [
    thinking("first"),
    call("one"),
    thinking("second"),
    text("reply"),
  ]);
  const strip = planThinkingStrip(rows, wire, "block=messages.1.content.2", 1);
  assert.deepEqual(strip, {
    scope: "partial",
    from: { messageIndex: 3, thinkingIndex: 0 },
  });
  const repaired = projectMessages(markThinkingStripped(rows, strip));
  assert.deepEqual(repaired[1]?.content, [
    thinking("first"),
    text("reply"),
    call("one"),
  ]);
  assert.deepEqual(rows[3]?.content, [thinking("second"), text("reply")]);
});

test("active compaction boundary excludes archived rows before response coalescing", () => {
  const rows: Message[] = [
    { role: "assistant", responseId: "same", content: [call("archived")] },
    { role: "user", content: [result("archived")] },
    {
      role: "user",
      content: [text("summary")],
      contextBoundary: { reason: "manual", beforeTokens: 100, afterTokens: 10 },
    },
    { role: "user", content: [text("next")] },
    { role: "assistant", responseId: "same", content: [call("active")] },
    { role: "user", content: [result("active")] },
  ];
  assert.deepEqual(projectMessages(rows), [
    { role: "user", content: [text("summary\n"), text("next")] },
    { role: "assistant", content: [call("active")] },
    { role: "user", content: [result("active")] },
  ]);
});
