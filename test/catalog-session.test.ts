import test from "node:test";
import assert from "node:assert/strict";
import { wrapCatalogTools } from "../src/catalog-session.js";
import { messageSchema, type Message, type ToolExecutor } from "../src/types.js";
import { matchingAgentTypeDeny, type ToolPolicy } from "../src/tool-policy.js";

test("catalogs follow the retained user history, refresh after compaction and survive persistence", async () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "owned task" }] }];
  const base: ToolExecutor = { definitions: ["Agent", "Skill"].map(name => ({ name, description: "static", input_schema: { type: "object" } })),
    execute: async call => ({ type: "tool_result", tool_use_id: call.id, content: "done" }) };
  let skills = [{ name: "owned", description: "First" }], agents = [{ agentType: "reader", whenToUse: "Read" }];
  const wrapper = wrapCatalogTools(base, messages, { agents: () => agents, skills: () => skills });
  const signal = new AbortController().signal;
  await wrapper.beforeModelRequest!(signal);
  assert.equal(messages.length, 1); assert.equal(messages[0]!.content.length, 3);
  assert.match((messages[0]!.content[1] as { text: string }).text, /reader/);
  assert.match((messages[0]!.content[2] as { text: string }).text, /owned/);
  assert.deepEqual(messages[0]!.catalogAttachments?.map(record => record.type), ["agent_listing_delta", "skill_listing"]);
  assert.deepEqual(messageSchema.parse(JSON.parse(JSON.stringify(messages[0]))), messages[0]);
  await wrapper.beforeModelRequest!(signal); assert.equal(messages[0]!.content.length, 3);
  messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: [{ type: "text", text: "next" }] });
  skills = [{ name: "owned", description: "Changed" }]; agents = [];
  await wrapper.beforeModelRequest!(signal);
  assert.equal(messages.at(-1)!.catalogAttachments?.length, 2);
  const removal = messages.at(-1)!.catalogAttachments?.[0];
  assert.deepEqual(removal?.type === "agent_listing_delta" && removal.removedTypes, ["reader"]);
  messages.push({ role: "user", content: [{ type: "text", text: "summary" }], contextBoundary: { beforeTokens: 100, afterTokens: 20, reason: "manual" } });
  await wrapper.beforeModelRequest!(signal);
  assert.equal(messages.at(-1)!.catalogAttachments?.[0]?.isInitial, true);
  assert.deepEqual(base.definitions.map(tool => tool.description), ["static", "static"]);
});

test("catalog scanning follows underlying context flush and adds siblings outside tool_result", async () => {
  const messages: Message[] = [];
  const base: ToolExecutor = { definitions: [{ name: "Skill", description: "static", input_schema: { type: "object" } }],
    execute: async call => ({ type: "tool_result", tool_use_id: call.id, content: "done" }),
    beforeModelRequest: async () => { messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "owned", content: "result" }] }); } };
  await wrapCatalogTools(base, messages, { agents: () => [], skills: () => [{ name: "owned", description: "Owned" }] }).beforeModelRequest!(new AbortController().signal);
  assert.deepEqual(messages[0]!.content[0], { type: "tool_result", tool_use_id: "owned", content: "result" });
  assert.equal(messages[0]!.content[1]?.type, "text");
});

test("Agent catalog filters exact named denies while generic argument denial stays a launch check", () => {
  const policy: ToolPolicy = { allowedTools: [], disallowedTools: ["Agent(subagent_type:reader*)", "Task(reader)"],
    sourcedRules: [{ source: "policySettings", behavior: "deny", rule: "Agent(writer)" }] };
  assert.equal(matchingAgentTypeDeny(policy, "reader-other"), undefined);
  assert.equal(matchingAgentTypeDeny(policy, "reader")?.rule, "Task(reader)");
  assert.equal(matchingAgentTypeDeny(policy, "writer")?.source, "policySettings");
});
