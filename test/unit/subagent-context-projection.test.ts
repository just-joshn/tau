import { test } from "bun:test";
import assert from "node:assert/strict";
import { projectMessages } from "../../src/thinking-history.js";
import { messageSchema, type Message } from "../../src/types.js";

test("Start attachment projects before delegation/preloads while retained lifecycle order and wire metadata remain independent", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "DELEGATION" }] },
    {
      role: "user",
      contextPlacement: "subagent-start",
      content: [{ type: "text", text: "START" }],
    },
    { role: "user", content: [{ type: "text", text: "PRELOAD_A" }] },
    { role: "user", content: [{ type: "text", text: "PRELOAD_B" }] },
  ];
  const original = structuredClone(messages);
  const wire = projectMessages(messages);
  assert.deepEqual(messages, original);
  assert.deepEqual(wire, [
    {
      role: "user",
      content: ["START\n", "DELEGATION\n", "PRELOAD_A\n", "PRELOAD_B"].map(
        (text) => ({ type: "text", text }),
      ),
    },
  ]);
  assert.equal(
    messageSchema.parse(messages[1]).contextPlacement,
    "subagent-start",
  );
});

test("Start placement cannot move across an earlier assistant or tool result, and survives save/reload", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "FIRST" }] },
    {
      role: "assistant",
      responseId: "response",
      content: [{ type: "tool_use", id: "read", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "read", content: "RESULT" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "NEXT" }] },
    {
      role: "user",
      contextPlacement: "subagent-start",
      content: [{ type: "text", text: "START" }],
    },
  ];
  const restored = messageSchema
    .array()
    .parse(JSON.parse(JSON.stringify(messages)));
  const wire = projectMessages(restored);
  assert.deepEqual(wire[0], {
    role: "user",
    content: [{ type: "text", text: "FIRST" }],
  });
  assert.deepEqual(wire[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "read", content: "RESULT" },
      { type: "text", text: "START\n" },
      { type: "text", text: "NEXT" },
    ],
  });
});
