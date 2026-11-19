import { triBoolean } from "../env-settings.js";
import type { BuiltinSkillGateContext, BuiltinSkillSpec } from "./types.js";
import { WORKFLOW_AUTHORING_PARTS } from "./workflow-authoring-body.generated.js";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function setting(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The original's `CLAUDE_CODE_SUBAGENT_MODEL_FORCE || mCe() !== undefined`. */
function modelOverridden(env: BuiltinSkillGateContext["env"]): boolean {
  if (triBoolean(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) === true) return true;
  const model = setting(env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL);
  return model !== undefined && model.toLowerCase() !== "inherit";
}

/** The original's `B5t() !== undefined`: a valid CLAUDE_CODE_SUBAGENT_EFFORT. */
function subagentEffortConfigured(
  env: BuiltinSkillGateContext["env"],
): boolean {
  const effort = setting(env.CLAUDE_CODE_SUBAGENT_EFFORT)?.toLowerCase();
  if (effort === undefined) return false;
  return EFFORT_LEVELS.includes(effort === "med" ? "medium" : effort);
}

/** `EEs()`: the body ignores the skill's arguments. */
export function workflowAuthoringBody(
  env: BuiltinSkillGateContext["env"],
): string {
  const overridden = modelOverridden(env);
  const effort = subagentEffortConfigured(env);
  return WORKFLOW_AUTHORING_PARTS.map((part) => {
    if (typeof part === "string") return part;
    if ("unlessModelOverridden" in part)
      return overridden ? "" : part.unlessModelOverridden;
    return effort ? part.subagentEffort.configured : part.subagentEffort.unset;
  }).join("");
}

export const workflowAuthoringSkill: BuiltinSkillSpec = {
  name: "workflow-authoring",
  origin: "bundled",
  description:
    "Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.",
  menuDescription: "Load the reference for writing Workflow tool scripts",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  // `Rh()`: "tengu_workflows_enabled" defaults on and a logged-out session is not "pro".
  enabled: ({ env }) =>
    triBoolean(env.CLAUDE_CODE_DISABLE_WORKFLOWS) !== true &&
    triBoolean(env.CLAUDE_CODE_WORKFLOWS) !== false,
  prompt: ({ env }) => workflowAuthoringBody(env),
  unported: [
    "Workflow tool",
    "disableWorkflows/enableWorkflows settings and the allow_workflows org policy",
    "tengu_workflows_enabled fixed at its default (on)",
  ],
};
