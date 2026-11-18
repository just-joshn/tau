import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  FORK_BOILERPLATE_TAG,
  FORK_PARENT_CALL_TEXT,
  FORK_STARTED_TEXT,
  FORK_SUBAGENT_TYPE,
  buildForkDirective,
  buildForkMessages,
  hasForkDirective,
  isForkBackgroundDefault,
  isForkSubagentEnabled,
  resolveForkSubagentGate,
} from "../../src/fork-subagent.js";
import type { Message } from "../../src/types.js";

test("fork gate is disabled, env, or the ordinary default", () => {
  assert.equal(resolveForkSubagentGate({}), "default");
  assert.equal(isForkSubagentEnabled({}), true);
  assert.equal(
    resolveForkSubagentGate({ CLAUDE_CODE_FORK_SUBAGENT: "true" }),
    "env",
  );
  for (const value of ["0", "false", "no", "off"])
    assert.equal(
      resolveForkSubagentGate({ CLAUDE_CODE_FORK_SUBAGENT: value }),
      "disabled",
    );
  assert.equal(
    resolveForkSubagentGate(
      { CLAUDE_CODE_FORK_SUBAGENT: "1" },
      { forkSubagentDisabled: true },
    ),
    "disabled",
  );
  assert.equal(
    resolveForkSubagentGate(
      { CLAUDE_CODE_FORK_SUBAGENT: "yes" },
      {
        coordinator: true,
      },
    ),
    "disabled",
  );
  assert.equal(
    isForkSubagentEnabled({ CLAUDE_CODE_FORK_SUBAGENT: "0" }),
    false,
  );
  assert.equal(FORK_SUBAGENT_TYPE, "fork");
});

test("background default follows the env gate or an interactive ordinary gate", () => {
  assert.equal(isForkBackgroundDefault({}), false);
  assert.equal(isForkBackgroundDefault({}, { interactive: true }), true);
  assert.equal(
    isForkBackgroundDefault({ CLAUDE_CODE_FORK_SUBAGENT: "true" }),
    true,
  );
  assert.equal(
    isForkBackgroundDefault(
      { CLAUDE_CODE_FORK_SUBAGENT: "false" },
      { interactive: true },
    ),
    false,
  );
});

test("the directive is the worker-fork boilerplate plus the prompt", () => {
  const text = buildForkDirective("OWNED_DIRECTIVE");
  assert.ok(text.startsWith(`<${FORK_BOILERPLATE_TAG}>\n`));
  assert.match(text, /You are a worker fork\./);
  assert.match(text, /Do NOT spawn subagents with the Agent tool/);
  assert.ok(text.endsWith("Your directive: OWNED_DIRECTIVE"));
  assert.equal(
    text.includes(`</${FORK_BOILERPLATE_TAG}>\n\nYour directive: `),
    true,
  );
});

test("fork messages clone the parent and close only the trailing assistant tool calls", () => {
  const parent: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "PARENT_PRIVATE" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-1",
          name: "Read",
          input: { file_path: "a" },
        },
        {
          type: "tool_use",
          id: "fork-1",
          name: "Agent",
          input: { subagent_type: "fork" },
        },
      ],
    },
  ];
  const messages = buildForkMessages(parent, "DO_THE_WORK", "fork-1");
  assert.equal(parent.length, 2);
  assert.equal(parent[1]?.content.length, 2);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], parent[0]);
  assert.notEqual(messages[0], parent[0]);
  assert.notEqual(messages[1], parent[1]);
  const closer = messages[2];
  assert.ok(closer);
  assert.equal(closer.role, "user");
  assert.deepEqual(
    closer.content.filter((block) => block.type === "tool_result"),
    [
      {
        type: "tool_result",
        tool_use_id: "read-1",
        content: FORK_PARENT_CALL_TEXT,
      },
      {
        type: "tool_result",
        tool_use_id: "fork-1",
        content: FORK_STARTED_TEXT,
      },
    ],
  );
  const directive = closer.content.find((block) => block.type === "text");
  assert.ok(directive && directive.type === "text");
  assert.match(directive.text, /Your directive: DO_THE_WORK/);
  assert.equal(hasForkDirective(messages), true);
  assert.equal(hasForkDirective(parent), false);

  const agentOnly = buildForkMessages(
    [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "only-agent", name: "Agent", input: {} },
        ],
      },
    ],
    "ONE",
    "ignored",
  );
  const agentResult = agentOnly.at(-1)?.content[0];
  assert.ok(agentResult?.type === "tool_result");
  assert.equal(agentResult.tool_use_id, "only-agent");
  assert.equal(agentResult.content, FORK_STARTED_TEXT);

  const readOnly = buildForkMessages(
    [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "only-read", name: "Read", input: {} },
        ],
      },
    ],
    "ONE",
    "ignored",
  );
  const readResult = readOnly.at(-1)?.content[0];
  assert.ok(readResult?.type === "tool_result");
  assert.match(readResult.content, /that fork is you/);
  assert.notEqual(readResult.content, FORK_STARTED_TEXT);
  assert.notEqual(readResult.content, FORK_PARENT_CALL_TEXT);

  const bare = buildForkMessages(
    [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    "PLAIN",
    "missing",
  );
  assert.equal(bare.at(-1)?.content[0]?.type, "text");
  assert.equal(
    bare.at(-1)?.content.some((block) => block.type === "tool_result"),
    false,
  );
});
