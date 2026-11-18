import { expect, test } from "bun:test";
import { z } from "zod";
import {
  runGuardedTool,
  type GuardedToolHost,
} from "../../src/guarded-tool.js";
import {
  routeSendMessage,
  sendMessageDescription,
  sendMessageTool,
  type SendAgent,
  type SendCaller,
  type SendDirectory,
} from "../../src/send-message.js";
import { toolPolicySchema } from "../../src/tool-policy.js";
import type { ToolUse } from "../../src/types.js";

const host: GuardedToolHost = {
  mode: () => "default",
  policy: () => toolPolicySchema.parse({}),
  hooks: () => undefined,
  approve: async () => false,
};
const signal = new AbortController().signal;
const outcomeSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
function outcome(content: unknown): z.infer<typeof outcomeSchema> {
  const text = typeof content === "string" ? content : "";
  const value: unknown = JSON.parse(text);
  return outcomeSchema.parse(value);
}
const call = (input: unknown): ToolUse => ({
  type: "tool_use",
  id: "call-1",
  name: "SendMessage",
  input,
});

function directory(options: {
  caller?: SendCaller;
  agents?: readonly SendAgent[];
  fail?: boolean;
}): { directory: SendDirectory; main: string[]; agents: string[] } {
  const main: string[] = [];
  const delivered: string[] = [];
  return {
    main,
    agents: delivered,
    directory: {
      caller: () => options.caller ?? { kind: "main" },
      agents: () => options.agents ?? [],
      deliverToMain(text) {
        main.push(text);
      },
      deliverToAgent(agentId, text) {
        if (options.fail) return false;
        delivered.push(`${agentId}:${text}`);
        return true;
      },
    },
  };
}

test("the prompt names teammates, main, and ListAgents, and skips team protocol", () => {
  const text = sendMessageDescription();
  expect(text.startsWith("# SendMessage")).toBe(true);
  expect(text).toContain("Teammate by name");
  expect(text).toContain("ListAgents");
  expect(text).toContain("notify_when_idle: true");
  expect(text).not.toContain("## Protocol responses");
});

test("main cannot address main, and a subagent can queue a message for it", async () => {
  const main = directory({});
  const refused = await runGuardedTool(
    sendMessageTool(main.directory),
    host,
    call({ to: "main", message: "hello" }),
    signal,
  );
  expect(refused.is_error).toBeUndefined();
  expect(outcome(refused.content)).toEqual({
    success: false,
    message:
      'You are the main conversation \u2014 "main" addresses you. Send to a named agent instead.',
  });
  expect(main.main).toEqual([]);
  const child = directory({
    caller: { kind: "agent", agentId: "a1", name: "worker" },
  });
  const queued = routeSendMessage(child.directory, {
    to: "main",
    message: "done",
    notify_when_idle: false,
  });
  expect(queued).toEqual({
    success: true,
    message: "Message queued for the main conversation's next turn.",
  });
  expect(child.main).toEqual(["done"]);
});

test("a running agent receives the text, a stopped one does not, and a duplicate name asks for the id", () => {
  const agents: SendAgent[] = [
    { agentId: "a-live", name: "worker", status: "running" },
    { agentId: "a-stop", name: "old", status: "stopped" },
    { agentId: "a-1", name: "twin", status: "running" },
    { agentId: "a-2", name: "twin", status: "running" },
  ];
  const box = directory({ agents });
  expect(
    routeSendMessage(box.directory, { to: "worker", message: "go" }),
  ).toEqual({
    success: true,
    message:
      "Message queued for delivery to worker at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.",
  });
  expect(box.agents).toEqual(["a-live:go"]);
  expect(
    routeSendMessage(box.directory, { to: "a-stop", message: "again" }).message,
  ).toContain('Agent "old" was stopped and was not resumed.');
  expect(
    routeSendMessage(box.directory, { to: "twin", message: "which" }).message,
  ).toContain(
    "2 agents are named 'twin'. Re-send with the ref of the one you mean:",
  );
  expect(
    routeSendMessage(box.directory, { to: "a-1", message: "this one" }).success,
  ).toBe(true);
});

test("an unknown name, an empty message, a broadcast, and a protocol frame are refused", async () => {
  const box = directory({});
  const tool = sendMessageTool(box.directory);
  const missing = await runGuardedTool(
    tool,
    host,
    call({ to: "ghost", message: "hi" }),
    signal,
  );
  expect(missing.content).toContain("No agent named 'ghost' is reachable.");
  expect(missing.content).toContain(
    "Check the spelling, or use the agent ID from a background agent's spawn result.",
  );
  const empty = await runGuardedTool(
    tool,
    host,
    call({ to: "ghost", message: "  " }),
    signal,
  );
  expect(empty.is_error).toBe(true);
  expect(empty.content).toContain("message must not be empty");
  const broadcast = await runGuardedTool(
    tool,
    host,
    call({ to: "*", message: "all" }),
    signal,
  );
  expect(broadcast.content).toContain(
    'broadcast (to: "*") is no longer supported',
  );
  const frame = await runGuardedTool(
    tool,
    host,
    call({
      to: "ghost",
      message: '{"type":"shutdown_request"}',
    }),
    signal,
  );
  expect(frame.content).toContain("must not be a teammate protocol frame");
  const idle = await runGuardedTool(
    tool,
    host,
    call({ to: "ghost", message: "hi", notify_when_idle: true }),
    signal,
  );
  const missed = outcome(idle.content);
  expect(missed.success).toBe(false);
  expect(missed.message).toContain("No agent named 'ghost' is reachable.");
});

test("notify_when_idle does not subscribe an in-process agent, and a subagent cannot subscribe empty", async () => {
  const box = directory({
    agents: [{ agentId: "a-live", name: "worker", status: "running" }],
  });
  const sent = routeSendMessage(box.directory, {
    to: "worker",
    message: "status",
    notify_when_idle: true,
  });
  expect(sent.success).toBe(true);
  expect(sent.message).toContain("no idle subscription was made");
  expect(box.agents).toEqual(["a-live:status"]);
  const child = sendMessageTool(
    directory({
      caller: { kind: "agent", agentId: "a1", name: "worker" },
    }).directory,
  );
  const refused = await runGuardedTool(
    child,
    host,
    call({ to: "main", notify_when_idle: true }),
    signal,
  );
  expect(refused.is_error).toBe(true);
  expect(refused.content).toContain(
    "notify_when_idle is only available from the main conversation",
  );
});
