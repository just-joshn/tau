import type { BuiltinSkillSpec } from "./types.js";

export const workflowAuthoringSkill: BuiltinSkillSpec = {
  name: "workflow-authoring",
  origin: "bundled",
  description:
    "Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
