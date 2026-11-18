import { test } from "bun:test";
import assert from "node:assert/strict";
import { wrapCatalogTools } from "../../src/catalog-session.js";
import {
  messageSchema,
  type Message,
  type ToolExecutor,
} from "../../src/types.js";
import {
  matchingAgentTypeDeny,
  type ToolPolicy,
} from "../../src/tool-policy.js";

function textOf(block: Message["content"][number] | undefined): string {
  assert.ok(block?.type === "text");
  return block.text;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) assert.fail(`no item at index ${String(index)}`);
  return item;
}

test("catalogs follow the retained user history, refresh after compaction and survive persistence", async () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "owned task" }] },
  ];
  const base: ToolExecutor = {
    definitions: ["Agent", "Skill"].map((name) => ({
      name,
      description: "static",
      input_schema: { type: "object" },
    })),
    execute: async (call) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: "done",
    }),
  };
  let skills = [{ name: "owned", description: "First" }],
    agents = [{ agentType: "reader", whenToUse: "Read" }];
  const wrapper = wrapCatalogTools(base, messages, {
    agents: () => agents,
    skills: () => skills,
  });
  const signal = new AbortController().signal;
  if (!wrapper.beforeModelRequest) assert.fail("missing beforeModelRequest");
  await wrapper.beforeModelRequest(signal);
  assert.equal(messages.length, 1);
  assert.equal(at(messages, 0).content.length, 3);
  assert.match(textOf(at(messages, 0).content[1]), /reader/);
  assert.match(textOf(at(messages, 0).content[2]), /owned/);
  assert.deepEqual(
    at(messages, 0).catalogAttachments?.map((record) => record.type),
    ["agent_listing_delta", "skill_listing"],
  );
  assert.deepEqual(
    messageSchema.parse(JSON.parse(JSON.stringify(messages[0]))),
    messages[0],
  );
  await wrapper.beforeModelRequest(signal);
  assert.equal(at(messages, 0).content.length, 3);
  messages.push(
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  );
  skills = [{ name: "owned", description: "Changed" }];
  agents = [];
  await wrapper.beforeModelRequest(signal);
  assert.equal(at(messages, -1).catalogAttachments?.length, 2);
  const removal = at(messages, -1).catalogAttachments?.[0];
  assert.deepEqual(
    removal?.type === "agent_listing_delta" && removal.removedTypes,
    ["reader"],
  );
  messages.push({
    role: "user",
    content: [{ type: "text", text: "summary" }],
    contextBoundary: { beforeTokens: 100, afterTokens: 20, reason: "manual" },
  });
  await wrapper.beforeModelRequest(signal);
  assert.equal(at(messages, -1).catalogAttachments?.[0]?.isInitial, true);
  assert.deepEqual(
    base.definitions.map((tool) => tool.description),
    ["static", "static"],
  );
});

test("catalog scanning follows underlying context flush and adds siblings outside tool_result", async () => {
  const messages: Message[] = [];
  const base: ToolExecutor = {
    definitions: [
      {
        name: "Skill",
        description: "static",
        input_schema: { type: "object" },
      },
    ],
    execute: async (call) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: "done",
    }),
    beforeModelRequest: async () => {
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "owned", content: "result" },
        ],
      });
    },
  };
  const wrapped = wrapCatalogTools(base, messages, {
    agents: () => [],
    skills: () => [{ name: "owned", description: "Owned" }],
  });
  if (!wrapped.beforeModelRequest) assert.fail("missing beforeModelRequest");
  await wrapped.beforeModelRequest(new AbortController().signal);
  assert.deepEqual(at(messages, 0).content[0], {
    type: "tool_result",
    tool_use_id: "owned",
    content: "result",
  });
  assert.equal(at(messages, 0).content[1]?.type, "text");
});

test("Agent catalog filters exact named denies while generic argument denial stays a launch check", () => {
  const policy: ToolPolicy = {
    allowedTools: [],
    disallowedTools: ["Agent(subagent_type:reader*)", "Task(reader)"],
    sourcedRules: [
      { source: "policySettings", behavior: "deny", rule: "Agent(writer)" },
    ],
  };
  assert.equal(matchingAgentTypeDeny(policy, "reader-other"), undefined);
  assert.equal(matchingAgentTypeDeny(policy, "reader")?.rule, "Task(reader)");
  assert.equal(
    matchingAgentTypeDeny(policy, "writer")?.source,
    "policySettings",
  );
});

test("native catalog creation precedes display mutation and retains real row placement without API metadata leakage", async () => {
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "text", text: "owned" }] },
  ];
  const records: import("../../src/native-attachment-capture.js").NativeAttachmentCaptureResult[] =
    [];
  let stamp = 0,
    target: Message | undefined;
  const base: ToolExecutor = {
    definitions: ["Agent", "Skill"].map((name) => ({
      name,
      description: "owned",
      input_schema: { type: "object" },
    })),
    execute: async (call) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: "owned",
    }),
  };
  const tools = wrapCatalogTools(base, messages, {
    agents: () => [{ agentType: "reader", whenToUse: "Read" }],
    skills: () => [{ name: "owned", description: "Owned" }],
    nativeCapture: {
      stamp: () => ({
        uuid: `22222222-2222-2222-2222-${String(++stamp).padStart(12, "0")}`,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      capture: (row, delivery) => {
        assert.equal(delivery.kind, "catalog");
        if (delivery.kind !== "catalog") assert.fail("wrong delivery");
        assert.equal(delivery.createdMessage, true);
        assert.equal(messages.length, 1);
        assert.deepEqual(delivery.message.content, []);
        target = delivery.message;
        records.push(row);
      },
    },
  });
  await tools.beforeModelRequest?.(new AbortController().signal);
  assert.equal(messages[1], target);
  assert.equal(target?.catalogAttachments?.length, 2);
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(target ?? {}).sort(), [
    "catalogAttachments",
    "content",
    "role",
  ]);
  await tools.beforeModelRequest?.(new AbortController().signal);
  assert.equal(records.length, 2);
  assert.equal(stamp, 2);
});

test("catalog sink failure leaves existing display and attachment history untouched", async () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "owned" }] },
  ];
  const before = structuredClone(messages);
  const tools = wrapCatalogTools(
    {
      definitions: [
        {
          name: "Skill",
          description: "owned",
          input_schema: { type: "object" },
        },
      ],
      execute: async (call) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: "owned",
      }),
    },
    messages,
    {
      agents: () => [],
      skills: () => [{ name: "owned", description: "Owned" }],
      nativeCapture: {
        stamp: () => ({
          uuid: "33333333-3333-3333-3333-333333333333",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        capture: () => {
          throw new Error("owner rejected catalog");
        },
      },
    },
  );
  await assert.rejects(
    tools.beforeModelRequest?.(new AbortController().signal) ??
      Promise.reject(new Error("missing seam")),
    /owner rejected catalog/,
  );
  assert.deepEqual(messages, before);
});
