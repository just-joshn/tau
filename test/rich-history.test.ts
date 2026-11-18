import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SummaryPlanner } from "../src/compaction-plan.js";
import { newSession, SessionStore } from "../src/session.js";
import { projectMessages } from "../src/thinking-history.js";
import type { Message, ToolResult } from "../src/types.js";

const richResult = (): ToolResult => ({
  type: "tool_result", tool_use_id: "mcp-call", content: "terminal description",
  apiContent: [
    { type: "text", text: "model-visible resource" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" }, title: "Report" },
  ],
  mcpResult: { content: [{ type: "text", text: "raw" }], structuredContent: { count: 2 }, _meta: { local: "only" } },
});

test("rich MCP results survive save/resume while the API receives only projected content", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tau-rich-history-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await SessionStore.create(directory, join(directory, "state"));
  const session = newSession(directory, "claude-sonnet-4-5");
  const result = richResult();
  session.messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "mcp-call", name: "mcp__fixture__report", input: {} }] },
    { role: "user", content: [result] },
  ];
  await store.save(session);
  const loaded = await store.load(session.id);
  assert.deepEqual(loaded.messages, session.messages);
  const wire = projectMessages(loaded.messages);
  assert.deepEqual(wire[1]?.content, [{ type: "tool_result", tool_use_id: "mcp-call", content: result.apiContent }]);
  assert.equal(JSON.stringify(wire).includes("terminal description"), false);
  assert.equal(JSON.stringify(wire).includes("_meta"), false);
  assert.deepEqual(projectMessages([{ role: "user", content: [{ type: "tool_result", tool_use_id: "plain", content: "plain result" }] }])[0]?.content,
    [{ type: "tool_result", tool_use_id: "plain", content: "plain result" }]);
});

test("summary output omission removes rich payloads without mutating persisted MCP results", () => {
  const result = { ...richResult(), content: "large output ".repeat(400) };
  const rows: Message[] = [
    { role: "user", content: [{ type: "text", text: "task" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "mcp-call", name: "mcp__fixture__report", input: {} }] },
    { role: "user", content: [result] },
  ];
  const plan = new SummaryPlanner(rows, { keepNoRound: true, omitLargeToolResults: true }, { kind: "prompt", gap: 100 }).next();
  assert.ok(plan);
  assert.ok(plan.leftOutIds.has("mcp-call"));
  const wire = projectMessages(plan.toSummarize);
  assert.equal(JSON.stringify(wire).includes("aW1hZ2U="), false);
  assert.ok(JSON.stringify(wire).includes("Tool output omitted"));
  assert.equal(result.apiContent?.length, 3);
  assert.deepEqual(result.mcpResult, richResult().mcpResult);
});
