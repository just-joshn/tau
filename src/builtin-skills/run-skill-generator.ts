import type { BuiltinSkillSpec } from "./types.js";

export const runSkillGeneratorSkill: BuiltinSkillSpec = {
  name: "run-skill-generator",
  origin: "bundled",
  description: "",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: true,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
