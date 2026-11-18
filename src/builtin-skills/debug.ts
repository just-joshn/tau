import type { BuiltinSkillSpec } from "./types.js";

export const debugSkill: BuiltinSkillSpec = {
  name: "debug",
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
