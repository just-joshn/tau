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
  it("uses the most-significant hour and day units", () => {
    expect(formatAgentListing([row], 1000 + 3_600_000)).toContain(
      "started 1h ago",
    );
    expect(formatAgentListing([row], 1000 + 86_400_000)).toContain(
      "started 1d ago",
    );
  });
  it("caps the printed rows at 100", () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      ...row,
      agentId: `a${i}`,
    }));
    const listing = formatAgentListing(rows, 1000);
    expect(listing.startsWith("Subagents (101):")).toBe(true);
    expect(listing).toContain("(\u2026 1 more not shown)");
    expect(listing.split("\n")).toHaveLength(102); // title + 100 rows + more
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
