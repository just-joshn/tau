import type { BuiltinSkillSpec } from "./types.js";

export const doctorSkill: BuiltinSkillSpec = {
  name: "doctor",
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
