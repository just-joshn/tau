import type { BuiltinSkillSpec } from "./types.js";

export const fewerPermissionPromptsSkill: BuiltinSkillSpec = {
  name: "fewer-permission-prompts",
  origin: "bundled",
  description:
    "Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts.",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
