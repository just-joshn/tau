import type { BuiltinSkillSpec } from "./types.js";
import { RUN_EXAMPLE_FILES } from "./run-assets.generated.js";
import {
  RUN_SKILL_GENERATOR_BODY,
  RUN_SKILL_GENERATOR_TEMPLATE,
} from "./run-skill-generator-assets.generated.js";

export const runSkillGeneratorSkill: BuiltinSkillSpec = {
  name: "run-skill-generator",
  origin: "bundled",
  description:
    "Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks to set up the project, get it running, write run instructions, or verify build/run steps work from a clean environment.",
  menuDescription: "Create a skill that knows how to run this project’s app",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: true,
  enabled: () => true,
  files: () => ({
    "template.md": RUN_SKILL_GENERATOR_TEMPLATE,
    ...RUN_EXAMPLE_FILES,
  }),
  prompt: ({ args }) =>
    args
      ? `${RUN_SKILL_GENERATOR_BODY}\n\n## User Request\n\n${args}`
      : RUN_SKILL_GENERATOR_BODY,
  unported: [],
};
