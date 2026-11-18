import type { BuiltinSkillSpec } from "./types.js";

export const securityReviewSkill: BuiltinSkillSpec = {
  name: "security-review",
  origin: "command",
  description:
    "Complete a security review of the pending changes on the current branch",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
