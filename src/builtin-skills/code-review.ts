import type { BuiltinSkillSpec } from "./types.js";

export const codeReviewSkill: BuiltinSkillSpec = {
  name: "code-review",
  origin: "bundled",
  description:
    "Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model's recipe covers them) at the effort level given first, before any target (low|medium|high|xhigh|max: from few high-confidence findings to many, some uncertain); with no level given, it reuses the level you typed last. Pass --comment to post findings as inline PR comments, or --fix to apply them to the working tree after the review. Pass --max-findings <n> to report up to n findings, or --max-findings all for every finding. The choice stays until you pass --max-findings default.",
  whenToUse:
    "Use the max level only when the user, or instructions such as CLAUDE.md or a skill, explicitly ask for it, never on your own judgment: it is the costliest level and starts many reviewer subagents.",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
