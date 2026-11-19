import { describe, expect, it } from "bun:test";
import {
  EMPTY_AGENT_LISTING,
  formatAgentListing,
  listAgentsTool,
} from "../../src/list-agents-tool.js";

const row = {
  agentId: "a1",
  agentType: "general-purpose",
  status: "running",
  startTime: 1000,
};

describe("ListAgents listing", () => {
  it("empty is the original empty listing", () => {
    expect(formatAgentListing([], 0)).toBe(EMPTY_AGENT_LISTING);
  });
  it("formats subagent rows", () => {
    expect(
      formatAgentListing([row, { ...row, agentId: "a2", name: "bob" }], 66000),
    ).toBe(
      "Subagents (2):\n  a1  \u00b7  general-purpose  \u00b7  running  \u00b7  started 1m ago\n  bob  \u00b7  general-purpose  \u00b7  running  \u00b7  started 1m ago",
    );
  });
  it("run lists the injected directory and is empty without one", async () => {
    const ctx = {
      type: "tool_use" as const,
      id: "t",
      name: "ListAgents",
      input: {},
    };
    const signal = new AbortController().signal;
    const tool = listAgentsTool({ agents: () => [row], now: () => 6000 });
    expect(await tool.run({}, ctx, signal)).toContain(
      "a1  \u00b7  general-purpose  \u00b7  running  \u00b7  started 5s ago",
    );
    expect(
      await listAgentsTool({ agents: () => [] }).run({}, ctx, signal),
    ).toBe(EMPTY_AGENT_LISTING);
  });
});
