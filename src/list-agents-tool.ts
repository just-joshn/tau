/**
 * ListAgents (chunk-j4kfygwr.js ListAgentsTool). Peer discovery across
 * local sessions, cloud, and Remote Control is not ported, so a call
 * returns the original empty listing.
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

export function listAgentsTool(): GuardedTool<ListAgentsInput> {
  return {
    name: LIST_AGENTS_TOOL,
    definition: listAgentsDefinition,
    schema: () => listAgentsSchema,
    async check() {
      return { behavior: "allow" };
    },
    async run() {
      return EMPTY_AGENT_LISTING;
    },
  };
}
