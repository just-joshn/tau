import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  projectHookAttachmentHistory,
  projectHookAttachments,
  renderHookAdditionalContext,
  sanitizeHookAttachmentText,
} from "../src/hook-attachment-projection.js";
import type {
  HookAttachmentRow,
  HookProjectionRow,
} from "../src/hook-attachment-projection.js";
import type { ApiToolContent, WireBlock } from "../src/types.js";

const text = (value: string): WireBlock => ({ type: "text", text: value });
const call = (id: string): WireBlock => ({
  type: "tool_use",
  id,
  name: "Write",
  input: { file_path: "relative.txt", content: id },
});
const result = (id: string, content = `output ${id}`): WireBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content,
});
const assistant = (
  id = "one",
  responseId = `response-${id}`,
): HookProjectionRow => ({
  type: "message",
  message: { role: "assistant", responseId, content: [call(id)] },
});
const user = (...content: WireBlock[]): HookProjectionRow => ({
  type: "message",
  message: { role: "user", content },
});
const attachment = (
  phase: HookAttachmentRow["phase"],
  toolUseId = "one",
  content: readonly string[] = [phase],
): HookAttachmentRow => ({
  type: "hook_attachment",
  phase,
  event:
    phase === "pre"
      ? "PreToolUse"
      : phase === "post"
        ? "PostToolUse"
        : "PostToolUseFailure",
  toolName: "Write",
  toolUseId,
  content,
});
const reminder = (
  phase: HookAttachmentRow["phase"],
  content: readonly string[] = [phase],
): string =>
  `<system-reminder>\n${phase === "pre" ? "PreToolUse" : phase === "post" ? "PostToolUse" : "PostToolUseFailure"}:Write hook additional context: ${content.join("\n")}\n</system-reminder>`;

test("a Post-only attachment folds into the preceding completed result, as in unique-ID Skill baseline", () => {
  const rows = [assistant(), user(result("one")), attachment("post")];
  const projection = projectHookAttachmentHistory(rows);
  assert.deepEqual(projection.messages, [
    { role: "assistant", content: [call("one")] },
    {
      role: "user",
      content: [result("one", `output one\n\n${reminder("post")}`)],
    },
  ]);
  assert.deepEqual(projection.placements, [
    {
      sourceIndex: 2,
      event: "PostToolUse",
      phase: "post",
      originToolUseId: "one",
      channel: "tool_result",
      targetToolUseId: "one",
    },
  ]);
});

test("Pre-only context is emitted before the result and remains sibling text", () => {
  assert.deepEqual(
    projectHookAttachments([
      assistant(),
      attachment("pre"),
      user(result("one")),
    ]),
    [
      { role: "assistant", content: [call("one")] },
      { role: "user", content: [result("one"), text(reminder("pre"))] },
    ],
  );
});

test("Pre text prevents later Post folding, explaining the settings-hook baseline", () => {
  const projection = projectHookAttachmentHistory([
    assistant(),
    attachment("pre"),
    user(result("one")),
    attachment("post"),
  ]);
  assert.deepEqual(projection.messages[1], {
    role: "user",
    content: [result("one"), text(reminder("pre")), text(reminder("post"))],
  });
  assert.deepEqual(
    projection.placements.map((item) => item.channel),
    ["user_text", "user_text"],
  );
});

test("placement follows actual transcript phase, never event name", () => {
  const postBeforeResult = {
    ...attachment("pre"),
    event: "PostToolUse" as const,
  };
  const preAfterResult = {
    ...attachment("post"),
    event: "PreToolUse" as const,
  };
  assert.equal(
    projectHookAttachmentHistory([
      assistant(),
      postBeforeResult,
      user(result("one")),
    ]).placements[0]?.channel,
    "user_text",
  );
  assert.equal(
    projectHookAttachmentHistory([
      assistant(),
      user(result("one")),
      preAfterResult,
    ]).placements[0]?.channel,
    "tool_result",
  );
});

test("shared response identities can host next Pre context on the prior result", () => {
  const projection = projectHookAttachmentHistory([
    assistant("one", "shared"),
    user(result("one")),
    assistant("two", "shared"),
    attachment("pre", "two"),
    user(result("two")),
    attachment("post", "two"),
  ]);
  assert.deepEqual(projection.messages, [
    { role: "assistant", content: [call("one"), call("two")] },
    {
      role: "user",
      content: [
        result("one", `output one\n\n${reminder("pre")}`),
        result("two", `output two\n\n${reminder("post")}`),
      ],
    },
  ]);
  assert.equal(projection.placements[0]?.originToolUseId, "two");
  assert.equal(projection.placements[0]?.targetToolUseId, "one");
});

test("distinct response IDs preserve Pre context beside its current result", () => {
  const projection = projectHookAttachmentHistory([
    assistant("one"),
    user(result("one")),
    assistant("two"),
    attachment("pre", "two"),
    user(result("two")),
  ]);
  assert.equal(projection.messages.length, 4);
  assert.deepEqual(projection.messages[3]?.content, [
    result("two"),
    text(reminder("pre")),
  ]);
});

test("multiple Post attachments append in emission order with complete provenance", () => {
  const first = {
    ...attachment("post", "one", ["first", "line two"]),
    source: "session",
    uuid: "attachment-one",
  };
  const second = {
    ...attachment("post", "one", ["second"]),
    source: "settings",
    uuid: "attachment-two",
  };
  const projection = projectHookAttachmentHistory([
    assistant(),
    user(result("one")),
    first,
    second,
  ]);
  assert.deepEqual(projection.messages[1]?.content, [
    result(
      "one",
      `output one\n\n${reminder("post", first.content)}\n\n${reminder("post", second.content)}`,
    ),
  ]);
  assert.deepEqual(
    projection.placements.map((item) => [item.source, item.uuid]),
    [
      ["session", "attachment-one"],
      ["settings", "attachment-two"],
    ],
  );
});

test("ordinary sibling text and unclassified reminder text remain barriers", () => {
  for (const barrier of [
    "accepted user feedback",
    "<system-reminder>\nunknown reminder\n</system-reminder>",
  ]) {
    assert.deepEqual(
      projectHookAttachments([
        assistant(),
        user(result("one"), text(barrier)),
        attachment("post"),
      ])[1]?.content,
      [result("one"), text(barrier), text(reminder("post"))],
    );
  }
});

test("explicitly source-classified protected suffixes allow xGo to reach the preceding result", () => {
  const projection = projectHookAttachmentHistory([
    assistant(),
    {
      type: "message",
      message: {
        role: "user",
        content: [result("one"), text("protected source notice")],
      },
      protectedSuffixTextIndices: [1],
    },
    attachment("post"),
  ]);
  assert.deepEqual(projection.messages[1]?.content, [
    result("one", `output one\n\n${reminder("post")}`),
    text("protected source notice"),
  ]);
});

test("reserved synthetic carriers and explicit protected results never take hook content", () => {
  for (const id of [
    "poll_owned",
    "gettask_owned",
    "projectread_owned",
    "toolu_pdfread_owned",
    "voicecallrecord_owned",
  ]) {
    const projection = projectHookAttachmentHistory([
      assistant(id),
      user(result(id)),
      attachment("post", id),
    ]);
    assert.equal(projection.placements[0]?.channel, "user_text");
    assert.deepEqual(projection.messages[1]?.content, [
      result(id),
      text(reminder("post")),
    ]);
  }
  const projection = projectHookAttachmentHistory([
    assistant(),
    {
      type: "message",
      message: { role: "user", content: [result("one")] },
      preventFoldResultIds: ["one"],
    },
    attachment("post"),
  ]);
  assert.equal(projection.placements[0]?.channel, "user_text");
});

test("failure context folds after an error result without erasing its error status", () => {
  const projection = projectHookAttachments([
    assistant(),
    user({
      type: "tool_result",
      tool_use_id: "one",
      content: " failed ",
      is_error: true,
    }),
    attachment("failure"),
  ]);
  assert.deepEqual(projection[1]?.content, [
    {
      type: "tool_result",
      tool_use_id: "one",
      content: `failed\n\n${reminder("failure")}`,
      is_error: true,
    },
  ]);
});

test("rich gate-off results keep the source one-newline seam and separate context text", () => {
  const image: ApiToolContent = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aQ==" },
  };
  const projection = projectHookAttachments([
    assistant(),
    user({
      type: "tool_result",
      tool_use_id: "one",
      content: [image, { type: "text", text: " original " }],
    }),
    attachment("post"),
  ]);
  assert.deepEqual(projection[1]?.content, [
    {
      type: "tool_result",
      tool_use_id: "one",
      content: [
        image,
        { type: "text", text: " original \n" },
        text(reminder("post")),
      ],
    },
  ]);
});

test("explicit reminderFold gate changes final sibling placement; default remains separate", () => {
  const rows = [
    assistant(),
    attachment("pre"),
    user(result("one")),
    attachment("post"),
  ];
  const projection = projectHookAttachmentHistory(rows, { reminderFold: true });
  assert.deepEqual(projection.messages[1]?.content, [
    result("one", `output one\n\n${reminder("pre")}\n\n${reminder("post")}`),
  ]);
  assert.ok(
    projection.placements.every(
      (item) =>
        item.channel === "tool_result" && item.targetToolUseId === "one",
    ),
  );
});

test("RPi retains attachment order across text turns and removes virtual rows", () => {
  const projection = projectHookAttachmentHistory([
    assistant(),
    user(result("one")),
    {
      type: "message",
      virtual: true,
      message: { role: "assistant", content: [text("virtual")] },
    },
    attachment("post"),
    user(text("next task")),
  ]);
  assert.equal(JSON.stringify(projection.messages).includes("virtual"), false);
  assert.deepEqual(projection.messages[1]?.content, [
    result("one", `output one\n\n${reminder("post")}`),
    text("next task"),
  ]);
});

test("empty user rows do not create merge barriers or take attachment ownership", () => {
  const projection = projectHookAttachmentHistory([
    assistant("one", "shared"),
    user(result("one")),
    user(),
    assistant("two", "shared"),
    attachment("pre", "two"),
    user(result("two")),
  ]);
  assert.equal(projection.messages.length, 2);
  assert.equal(projection.placements[0]?.targetToolUseId, "one");
});

test("rendering sanitizes nested wrappers, partial closing prefixes and Unicode without dropping content", () => {
  assert.equal(
    sanitizeHookAttachmentText("</ SYSTEM-REMINDER >🙂<system-reminder>tail</"),
    "&lt;/ SYSTEM-REMINDER >🙂&lt;system-reminder>tail&lt;/",
  );
  const value = renderHookAdditionalContext(
    attachment("post", "one", ["first", "</system-reminder>", "< /", "终"]),
  );
  assert.equal(
    value,
    reminder("post", ["first", "&lt;/system-reminder>", "< /", "终"]),
  );
  assert.deepEqual(projectHookAttachments([attachment("pre", "one", [])]), []);
  assert.equal(
    projectHookAttachments([attachment("pre", "one", [""])])[0]?.content[0]
      ?.type,
    "text",
  );
});

test("projection does not change durable rows, arrays, input values or signed blocks", () => {
  const signed: WireBlock = {
    type: "thinking",
    thinking: "reason",
    signature: "signed",
  };
  const rows: HookProjectionRow[] = [
    {
      type: "message",
      message: {
        role: "assistant",
        responseId: "shared",
        content: [signed, call("one")],
      },
    },
    attachment("pre"),
    user(result("one")),
    attachment("post"),
  ];
  const original = structuredClone(rows);
  projectHookAttachmentHistory(rows);
  assert.deepEqual(rows, original);
});
