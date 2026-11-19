import { expect, test } from "bun:test";
import {
  routeSendMessage,
  validateSendMessage,
  type SendCaller,
  type SendDirectory,
} from "../../src/send-message.js";

const main: SendCaller = { kind: "main" };
const sub: SendCaller = { kind: "agent", agentId: "a1", name: "worker" };
const v = (
  to: string,
  message: string,
  caller: SendCaller = main,
  notify?: boolean,
) =>
  validateSendMessage(
    {
      to,
      message,
      ...(notify === undefined ? {} : { notify_when_idle: notify }),
    } as never,
    caller,
  );

test("validateSendMessage refuses malformed addresses", () => {
  expect(v("uds:", "hi")).toBe("address target must not be empty");
  expect(v("bridge:%20", "hi")).toBe("address target must not be empty");
  expect(v("  ", "hi")).toBe("to must not be empty");
  expect(v("/tmp/x.sock", "hi")).toContain("is not a local socket address");
  expect(v("uds:/tmp/x", "hi")).toContain("is not a local socket address");
  expect(v("C:\\pipe", "hi")).toContain("is not a local socket address");
  expect(v("\\\\.\\pipe\\x", "hi")).toContain("is not a local socket address");
  expect(v("uds:%E0%A4%A", "hi")).toBeUndefined();
  expect(v("did:plc:abc", "hi")).toBeUndefined();
  expect(v("bridge:peer", "hi")).toBeUndefined();
  expect(v("bob@team", "hi")).toContain("bare teammate name");
});

test("validateSendMessage handles empty messages, notify, and frames", () => {
  expect(v("bob", "  ")).toBe("message must not be empty");
  expect(v("bob", "  ", main, true)).toBeUndefined();
  expect(v("bob", "  ", sub, true)).toContain("");
  expect(v("bob", "  ", sub, true)).not.toBeUndefined();
  expect(v("bob", "x", sub, true)).toBeUndefined();
  expect(v("*", "x")).toContain("broadcast");
  expect(v("bob", '{"type":"shutdown_request"}')).toBeDefined();
  expect(v("bob", '{"type":"idle_notification"}')).toBeDefined();
  expect(v("bob", '{"type":"something-else"}')).toBeUndefined();
  expect(v("bob", '{"nope":1}')).toBeUndefined();
  expect(v("bob", "{bad json")).toBeUndefined();
});

function directory(
  caller: SendCaller,
  agents: { agentId: string; name: string; status: "running" | "stopped" }[],
  options: { listAgents?: boolean; deliver?: boolean } = {},
): SendDirectory & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    caller: () => caller,
    agents: () => agents,
    ...(options.listAgents === undefined
      ? {}
      : { listAgentsAvailable: () => options.listAgents === true }),
    deliverToMain: (t) => void sent.push(`main:${t}`),
    deliverToAgent: (id, t) => {
      sent.push(`${id}:${t}`);
      return options.deliver ?? true;
    },
  };
}

test("routeSendMessage covers main delivery, notify and empty text", () => {
  const d = directory(sub, []);
  expect(
    routeSendMessage(d, { to: "main", message: "" } as never),
  ).toMatchObject({ success: false });
  const plain = routeSendMessage(d, { to: "main", message: "hi" } as never);
  expect(plain.message).toBe(
    "Message queued for the main conversation's next turn.",
  );
  const notified = routeSendMessage(d, {
    to: "main",
    message: "hi",
    notify_when_idle: true,
  } as never);
  expect(notified.message).toContain("no idle subscription was made");
  expect(d.sent).toEqual(["main:hi", "main:hi"]);
});

test("routeSendMessage resolves by id, name and reports misses", () => {
  const agents = [
    { agentId: "a-1", name: "alpha", status: "running" as const },
    { agentId: "a-2", name: "alpha", status: "running" as const },
    { agentId: "a-3", name: "beta", status: "running" as const },
  ];
  const d = directory(main, agents, { listAgents: true });
  expect(
    routeSendMessage(d, { to: "a-2", message: "x" } as never).success,
  ).toBe(true);
  expect(
    routeSendMessage(d, { to: "alpha", message: "x" } as never).message,
  ).toContain("2 agents are named");
  const miss = routeSendMessage(d, { to: "ghost", message: "x" } as never);
  expect(miss.message).toContain("Use ListAgents");
  const d2 = directory(main, agents);
  expect(
    routeSendMessage(d2, { to: "ghost", message: "x" } as never).message,
  ).toContain("Check the spelling");
  const d3 = directory(main, agents, { listAgents: false });
  expect(
    routeSendMessage(d3, { to: "ghost", message: "x" } as never).message,
  ).toContain("Check the spelling");
  expect(
    routeSendMessage(d3, { to: "beta", message: " " } as never).message,
  ).toContain("Nothing was subscribed");
  const notified = routeSendMessage(d3, {
    to: "beta",
    message: "x",
    notify_when_idle: true,
  } as never);
  expect(notified.message).toContain("no idle subscription");
});

test("routeSendMessage reports stopped agents and failed delivery", () => {
  const d = directory(
    main,
    [
      { agentId: "s1", name: "old", status: "stopped" },
      { agentId: "r1", name: "live", status: "running" },
    ],
    { deliver: false },
  );
  expect(
    routeSendMessage(d, { to: "old", message: "x" } as never).message,
  ).toContain("was stopped");
  expect(
    routeSendMessage(d, { to: "live", message: "x" } as never).message,
  ).toContain("Failed to write");
  expect(
    routeSendMessage(directory(main, []), { to: "main", message: "x" } as never)
      .message,
  ).toContain("You are the main conversation");
});
