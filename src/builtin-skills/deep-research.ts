import type { BuiltinSkillSpec } from "./types.js";

export const deepResearchSkill: BuiltinSkillSpec = {
  name: "deep-research",
  origin: "workflow",
  description: "",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: true,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
