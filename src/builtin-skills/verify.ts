import type { BuiltinSkillSpec } from "./types.js";
import {
  VERIFY_SKILL_BODY,
  VERIFY_SKILL_FILES,
} from "./verify-assets.generated.js";

export const verifySkill: BuiltinSkillSpec = {
  name: "verify",
  origin: "bundled",
  description:
    "Verify that a code change actually does what it's supposed to by exercising it end-to-end and observing behavior — drive the affected flow, not just tests or typecheck. Run before committing nontrivial changes; bootstraps this repo's project verify skill if none exists yet. Don't invoke it on a diff that only touches tests, docs, or other code with no runtime surface to drive (a change to product source always has one) — there's nothing to observe.",
  menuDescription: "Try your change and report if it works",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  // The original hides it from the model unless "tengu_opal_circuit" (default false) is on.
  disableModelInvocation: true,
  enabled: () => true,
  files: () => VERIFY_SKILL_FILES,
  prompt: ({ args }) =>
    args
      ? `${VERIFY_SKILL_BODY}\n\n## User Request\n\n${args}`
      : VERIFY_SKILL_BODY,
  unported: [
    "tengu_opal_circuit rollout gate fixed at its default (model invocation disabled)",
  ],
};
