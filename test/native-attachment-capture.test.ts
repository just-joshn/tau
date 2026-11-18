import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildCatalogAttachments } from "../src/catalog-projection.js";
import {
  captureNativeCatalogAttachments,
  captureNativeToolHookResult,
  type NativeAttachmentCaptureHost,
  type NativeAttachmentCaptureResult,
  type NativeHookCaptureFacts,
} from "../src/native-attachment-capture.js";
import { renderHookAdditionalContext } from "../src/hook-attachment-projection.js";
import type { Message, ToolUse } from "../src/types.js";

const call: ToolUse = {
  type: "tool_use",
  id: "owned-read",
  name: "Read",
  input: { file_path: "/owned/a" },
};
const message: Message = {
  role: "user",
  content: [{ type: "text", text: "OWNED PROMPT" }],
};
function owner() {
  const records: NativeAttachmentCaptureResult[] = [];
  let stamps = 0;
  const host: NativeAttachmentCaptureHost = {
    stamp: () => ({
      uuid: `11111111-1111-1111-1111-${String(++stamps).padStart(12, "0")}`,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    capture: (record) => {
      records.push(record);
    },
  };
  return { host, records, stamps: () => stamps };
}
function facts(): NativeHookCaptureFacts {
  return {
    source: "tool-hook",
    phase: "post",
    event: "PostToolUse",
    toolName: "Read",
    toolUseID: call.id,
    toolInput: call.input,
    execution: "sync",
    transport: "command",
    commandHook: { type: "command", command: "owned-command" },
    outcome: {
      id: "owned-hook",
      event: "PostToolUse",
      origin: { source: "owned-settings" },
      command: "owned-command",
      status: "success",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 3,
      additionalContext: "RAW </system-reminder> CONTEXT",
    },
  };
}
test("catalog capture snapshots the complete structured production before callbacks and creates separate canonical rows", async () => {
  const f = owner();
  const projection = buildCatalogAttachments({
    agents: [{ agentType: "reader", whenToUse: "Read" }],
    skills: [{ name: "owned", description: "Owned" }],
    history: [],
    hasAgentTool: true,
    hasSkillTool: true,
  });
  f.host.capture = (record, delivery) => {
    assert.equal(delivery.kind, "catalog");
    assert.deepEqual(message.content, [{ type: "text", text: "OWNED PROMPT" }]);
    f.records.push(record);
    projection.attachments.splice(1);
    projection.blocks.splice(1);
  };
  await captureNativeCatalogAttachments(f.host, projection, {
    kind: "catalog",
    message,
    createdMessage: false,
  });
  assert.equal(f.stamps(), 2);
  assert.deepEqual(
    f.records.map((row) => row.status === "captured" && row.attachment.type),
    ["agent_listing_delta", "skill_listing"],
  );
  for (const row of f.records) {
    assert.equal(row.status, "captured");
    if (row.status !== "captured") assert.fail("not captured");
    assert.equal(row.event.renderedRole, "system");
    assert.ok(Object.isFrozen(row.attachment));
    assert.ok(Object.isFrozen(row.facts));
  }
  assert.match(
    JSON.stringify(f.records[0]),
    /Available agent types for the Agent tool/,
  );
  assert.match(JSON.stringify(f.records[1]), /following skills are available/);
});

test("a real hook outcome retains raw content and exact identity while canonical rendering neutralizes reminder closure", async () => {
  const f = owner(),
    input = facts();
  f.host.capture = (row) => {
    f.records.push(row);
    input.outcome = {
      ...input.outcome,
      additionalContext: "MUTATED AFTER CREATION",
    };
  };
  await captureNativeToolHookResult(f.host, input, {
    kind: "tool-hook",
    phase: "post",
    call,
  });
  const row = f.records[0];
  assert.ok(
    row?.status === "captured" &&
      row.attachment.type === "hook_additional_context",
  );
  assert.deepEqual(row.attachment.content, ["RAW </system-reminder> CONTEXT"]);
  assert.equal(row.attachment.toolUseID, "owned-read");
  assert.equal(row.attachment.hookName, "PostToolUse:Read");
  assert.deepEqual(row.event.rendered, [
    {
      content: renderHookAdditionalContext({
        type: "hook_attachment",
        event: "PostToolUse",
        phase: "post",
        toolName: "Read",
        content: row.attachment.content,
      }),
    },
  ]);
  assert.equal(row.event.renderedRole, "system");
  assert.ok(Object.isFrozen(row.facts));
});

test("unknown phases/transports, pending background, native persistence bounds and source stop paths never mint attachments", async () => {
  for (const mutate of [
    (input: NativeHookCaptureFacts) => {
      input.event = "Stop";
    },
    (input: NativeHookCaptureFacts) => {
      input.transport = "unknown";
    },
    (input: NativeHookCaptureFacts) => {
      input.execution = "background";
    },
    (input: NativeHookCaptureFacts) => {
      input.outcome = {
        ...input.outcome,
        additionalContext: "x".repeat(10001),
      };
    },
    (input: NativeHookCaptureFacts) => {
      input.outcome = { ...input.outcome, preventContinuation: true };
    },
    (input: NativeHookCaptureFacts) => {
      input.outcome = { ...input.outcome, status: "blocking" };
    },
  ]) {
    const f = owner(),
      input = facts();
    mutate(input);
    await captureNativeToolHookResult(f.host, input, {
      kind: "tool-hook",
      phase: "post",
      call,
    });
    assert.equal(f.records[0]?.status, "unsupported");
    assert.equal(f.stamps(), 0);
  }
  const f = owner(),
    input = facts();
  input.outcome = { ...input.outcome, additionalContext: "x".repeat(10000) };
  await captureNativeToolHookResult(f.host, input, {
    kind: "tool-hook",
    phase: "post",
    call,
  });
  assert.equal(f.records[0]?.status, "captured");
});
