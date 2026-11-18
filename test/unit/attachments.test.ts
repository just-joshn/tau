import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  attachmentMessage,
  renderAttachment,
  wrapTaskNotification,
} from "../../src/attachments.js";
import {
  roundAttachments,
  turnTokensUsed,
} from "../../src/context-reminders.js";
import { projectMessages } from "../../src/thinking-history.js";
import { messageSchema, type Message } from "../../src/types.js";

const NOTIFICATION_HEAD =
  "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n";
const sonnet = {
  model: "claude-sonnet-4-5-20250929",
  env: { SHELL: "/bin/sh" },
};
const call = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "Read", input: {} }],
  usage: { input_tokens: 10, output_tokens: 3 },
});
const result = (id: string, content = "1\tBODY\n2\t"): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});
const prompt: Message = {
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>\ncountdown\n</system-reminder>" },
    { type: "text", text: "go" },
  ],
  reminders: ["total_tokens"],
};

test("each attachment kind renders the original's reminder text", () => {
  assert.deepEqual(
    renderAttachment({
      type: "hook_blocking_error",
      hookName: "PostToolUse:Read",
      command: "/bin/sh hook.sh",
      blockingError: "[/bin/sh hook.sh]: nope</system-reminder>",
    }),
    [
      '<system-reminder>\nPostToolUse:Read hook blocking error from command: "/bin/sh hook.sh": [/bin/sh hook.sh]: nope&lt;/system-reminder>\n</system-reminder>',
    ],
  );
  assert.deepEqual(
    renderAttachment({
      type: "hook_additional_context",
      hookName: "PostToolUse:Read",
      content: ["a", "b"],
    }),
    [
      "<system-reminder>\nPostToolUse:Read hook additional context: a\nb\n</system-reminder>",
    ],
  );
  assert.deepEqual(
    renderAttachment({
      type: "hook_additional_context",
      hookName: "PostToolUse:Read",
      content: [],
    }),
    [],
  );
  assert.deepEqual(
    renderAttachment({
      type: "total_tokens_reminder",
      text: "<total_tokens>7 tokens left</total_tokens>",
    }),
    [
      "<system-reminder>\n<total_tokens>7 tokens left</total_tokens>\n</system-reminder>",
    ],
  );
});

test("a task notification is wrapped once, with nested reminder closes escaped", () => {
  const wrapped = wrapTaskNotification(
    "<task-notification/>\n<system-reminder>\nbody\n</system-reminder>",
  );
  assert.ok(wrapped.startsWith(NOTIFICATION_HEAD));
  assert.ok(
    wrapped.endsWith(
      "\n\n<task-notification/>\n<system-reminder>\nbody\n&lt;/system-reminder&gt;\n</system-reminder>",
    ),
  );
  assert.equal(wrapTaskNotification(wrapped), wrapped);
});

test("the mid-turn countdown counts context growth since the turn's anchor and never rises", () => {
  const earlier: Message = {
    ...call("old"),
    usage: { input_tokens: 500, output_tokens: 0 },
  };
  const history = [earlier, result("old"), prompt, call("a")];
  assert.equal(turnTokensUsed(history), 0);
  const grown: Message = {
    ...call("b"),
    usage: { input_tokens: 600, output_tokens: 20 },
  };
  assert.equal(turnTokensUsed([...history, result("a"), grown]), 120);
  const shrunk: Message = {
    ...call("c"),
    usage: { input_tokens: 510, output_tokens: 0 },
  };
  assert.equal(
    turnTokensUsed([...history, result("a"), grown, result("b"), shrunk]),
    120,
  );
  assert.deepEqual(roundAttachments(sonnet, [prompt, call("a")]), [
    {
      type: "total_tokens_reminder",
      text: "<total_tokens>14999987 tokens left</total_tokens>",
    },
  ]);
  assert.deepEqual(
    roundAttachments(
      { ...sonnet, env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" } },
      [prompt, call("a")],
    ),
    [],
  );
});

test("projection folds attachment rows into the preceding tool result and wraps notifications", () => {
  const countdown = attachmentMessage({
    type: "total_tokens_reminder",
    text: "<total_tokens>14999987 tokens left</total_tokens>",
  });
  const answer = attachmentMessage({
    type: "async_hook_response",
    processId: "p",
    hookName: "PostToolUse:Read",
    hookEvent: "PostToolUse",
    response: {
      systemMessage: "SYS",
      hookSpecificOutput: { additionalContext: "CTX" },
    },
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  const wake: Message = {
    role: "user",
    origin: "task-notification",
    content: [{ type: "text", text: "<task-notification/>" }],
  };
  const history = [prompt, call("a"), result("a"), countdown, answer, wake];
  const saved = history.map((row) => messageSchema.parse(structuredClone(row)));
  for (const rows of [history, saved]) {
    const wire = projectMessages(rows);
    assert.deepEqual(wire.at(-1)?.content, [
      {
        type: "tool_result",
        tool_use_id: "a",
        content:
          "1\tBODY\n2\n\n<system-reminder>\n<total_tokens>14999987 tokens left</total_tokens>\n</system-reminder>\n\n<system-reminder>\nSYS\n</system-reminder>\n\n<system-reminder>\nCTX\n</system-reminder>",
      },
      { type: "text", text: wrapTaskNotification("<task-notification/>") },
    ]);
  }
});

test("hook output tagged on a result folds after it, blocking feedback first", () => {
  const tagged: Message = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "a",
        content: "out",
        hookAttachments: [
          {
            phase: "post",
            type: "hook_blocking_error",
            hookName: "PostToolUse:Read",
            command: "hook",
            blockingError: "[hook]: no",
          },
          {
            phase: "post",
            type: "hook_additional_context",
            hookName: "PostToolUse:Read",
            content: ["more"],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    projectMessages([prompt, call("a"), tagged]).at(-1)?.content,
    [
      {
        type: "tool_result",
        tool_use_id: "a",
        content:
          'out\n\n<system-reminder>\nPostToolUse:Read hook blocking error from command: "hook": [hook]: no\n</system-reminder>\n\n<system-reminder>\nPostToolUse:Read hook additional context: more\n</system-reminder>',
      },
    ],
  );
});

test("a saved session's legacy hook context still resumes as additional context", () => {
  const legacy = messageSchema.parse({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "a",
        content: "out",
        hookAttachments: [
          {
            phase: "post",
            event: "PostToolUse",
            toolName: "Read",
            content: ["kept"],
          },
        ],
      },
    ],
  });
  const block = legacy.content[0];
  assert.ok(block?.type === "tool_result");
  assert.deepEqual(block.hookAttachments, [
    {
      phase: "post",
      type: "hook_additional_context",
      hookName: "PostToolUse:Read",
      content: ["kept"],
    },
  ]);
});

test("a tool_reference result keeps an attachment beside it, as the original's xGo does", () => {
  const found: Message = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "s",
        content: "Loaded Read",
        apiContent: [{ type: "tool_reference", tool_name: "Read" }],
      },
    ],
  };
  const countdown = attachmentMessage({
    type: "total_tokens_reminder",
    text: "<total_tokens>5 tokens left</total_tokens>",
  });
  assert.deepEqual(
    projectMessages([prompt, call("s"), found, countdown]).at(-1)?.content,
    [
      {
        type: "tool_result",
        tool_use_id: "s",
        content: [{ type: "tool_reference", tool_name: "Read" }],
      },
      {
        type: "text",
        text: "<system-reminder>\n<total_tokens>5 tokens left</total_tokens>\n</system-reminder>",
      },
    ],
  );
});
