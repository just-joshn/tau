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

const work = { workingDirectory: "/w", isGitRepo: true, isWorktree: false };
const moved = (text: string) =>
  `<system-reminder>\n# Environment update\n${text}\n</system-reminder>`;

test("a moved shell folds one environment update, then nothing until it moves again", () => {
  const sub = { ...work, workingDirectory: "/w/s<b>", isGitRepo: false };
  const facts = {
    ...sonnet,
    env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" },
  };
  const owed = roundAttachments(
    { ...facts, environment: { start: work, now: sub } },
    [prompt, call("a"), result("a")],
  );
  assert.deepEqual(owed.flatMap(renderAttachment), [
    moved(
      " - Primary working directory: /w/s&lt;b&gt; (was /w)\n - Is a git repository: false (was true)",
    ),
  ]);
  const told = [prompt, call("a"), result("a"), ...owed.map(attachmentMessage)];
  assert.deepEqual(
    roundAttachments(
      { ...facts, environment: { start: work, now: sub } },
      told,
    ),
    [],
  );
  assert.deepEqual(
    roundAttachments(
      { ...facts, environment: { start: work, now: work } },
      told,
    ).flatMap(renderAttachment),
    [
      moved(
        " - Primary working directory: /w (was /w/s&lt;b&gt;)\n - Is a git repository: true (was false)",
      ),
    ],
  );
  assert.deepEqual(
    renderAttachment({
      type: "environment",
      snapshot: { ...work, isWorktree: true },
      changes: [{ field: "isWorktree" }],
    })[0]?.split("\n")[2],
    " - This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT `cd` to the original repository root.",
  );
});

test("the task reminder waits ten non-thinking assistant blocks after task use or the last reminder", () => {
  const facts = {
    ...sonnet,
    env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" },
    tasks: [{ id: "1", status: "pending" as const, subject: "Ship it" }],
  };
  const thinking: Message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "t", signature: "s" }],
  };
  const turns = (count: number) =>
    Array.from({ length: count }, (_, index) => [
      call(`c${index}`),
      thinking,
      result(`c${index}`),
    ]).flat();
  assert.deepEqual(roundAttachments(facts, [prompt, ...turns(9)]), []);
  const due = [prompt, ...turns(10)];
  const [reminder] = roundAttachments(facts, due);
  assert.deepEqual(reminder && renderAttachment(reminder), [
    "<system-reminder>\nThe task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n\n\nHere are the existing tasks:\n\n#1. [pending] Ship it\n</system-reminder>",
  ]);
  const reminded = [...due, ...(reminder ? [attachmentMessage(reminder)] : [])];
  assert.deepEqual(roundAttachments(facts, [...reminded, ...turns(9)]), []);
  assert.equal(roundAttachments(facts, [...reminded, ...turns(10)]).length, 1);
  const managed: Message = {
    role: "assistant",
    content: [{ type: "tool_use", id: "u", name: "TaskUpdate", input: {} }],
  };
  assert.deepEqual(
    roundAttachments(facts, [...due, managed, result("u"), ...turns(9)]),
    [],
  );
  const { tasks: _offered, ...untracked } = facts;
  assert.deepEqual(roundAttachments(untracked, due), []);
  assert.deepEqual(
    roundAttachments(
      {
        ...facts,
        env: { ...facts.env, CLAUDE_CODE_TODO_REMINDER_MODE: "off" },
      },
      due,
    ),
    [],
  );
});
