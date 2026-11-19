import type { BuiltinSkillSpec } from "./types.js";

export const simplifySkill: BuiltinSkillSpec = {
  name: "simplify",
  origin: "bundled",
  description:
    "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
