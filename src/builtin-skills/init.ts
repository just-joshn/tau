import type { BuiltinSkillSpec } from "./types.js";

export const initSkill: BuiltinSkillSpec = {
  name: "init",
  origin: "command",
  description: "Initialize a new CLAUDE.md file with codebase documentation",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
