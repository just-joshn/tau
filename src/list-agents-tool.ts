/**
 * ListAgents (chunk-j4kfygwr.js ListAgentsTool). The listing follows
 * `listAgentsForModel` (chunk-2hynnqcd.js) for in-process subagents; cloud,
 * Remote Control, and local-session peers are not ported.
 */
import { z } from "zod";
import { LIST_AGENTS_DESCRIPTION } from "./eager-catalog-text.js";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const LIST_AGENTS_TOOL = "ListAgents";
export const LIST_AGENTS_SEARCH_HINT = "list agents you can SendMessage to";
export const EMPTY_AGENT_LISTING = "No reachable agents.";

const unavailable = "Not available in this build; leave unset.";
const listAgentsSchema = z
  .object({
    channel: z.string().max(256).optional().describe(unavailable),
    q: z.string().max(256).optional().describe(unavailable),
  })
  .strict();
export type ListAgentsInput = z.infer<typeof listAgentsSchema>;

export function listAgentsDefinition(): ToolDefinition {
  return {
    name: LIST_AGENTS_TOOL,
    description: LIST_AGENTS_DESCRIPTION,
    input_schema: {
      ...z.toJSONSchema(listAgentsSchema, { io: "input" }),
      type: "object",
    },
  };
}

export interface ListAgentRow {
  agentId: string;
  name?: string;
  agentType: string;
  status: string;
  startTime: number;
}
export interface ListAgentsDirectory {
  agents(): readonly ListAgentRow[];
  now?(): number;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const MAX_ROWS = 100;

/** Pure formatter: peer rows to the `listing` string. */
export function formatAgentListing(
  rows: readonly ListAgentRow[],
  now: number,
): string {
  if (rows.length === 0) return EMPTY_AGENT_LISTING;
  const lines = rows
    .slice(0, MAX_ROWS)
    .map(
      (r) =>
        `  ${[r.name ?? r.agentId, r.agentType, r.status, `started ${ago(now - r.startTime)} ago`].join("  \u00b7  ")}`,
    );
  if (rows.length > MAX_ROWS)
    lines.push(`  (\u2026 ${rows.length - MAX_ROWS} more not shown)`);
  return `Subagents (${rows.length}):\n${lines.join("\n")}`;
}

export function listAgentsTool(
  directory?: ListAgentsDirectory,
): GuardedTool<ListAgentsInput> {
  return {
    name: LIST_AGENTS_TOOL,
    definition: listAgentsDefinition,
    schema: () => listAgentsSchema,
    async check() {
      return { behavior: "allow" };
    },
    async run() {
      return formatAgentListing(
        directory?.agents() ?? [],
        directory?.now?.() ?? Date.now(),
      );
    },
  };
}
