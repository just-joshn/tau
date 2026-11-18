import type { BuiltinSkillSpec } from "./types.js";
import { RUN_EXAMPLE_FILES, RUN_SKILL_BODY } from "./run-assets.generated.js";

export const runSkill: BuiltinSkillSpec = {
  name: "run",
  origin: "bundled",
  description:
    "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app (not just tests). First looks for a project skill that already covers launching the app; otherwise falls back to built-in patterns per project type (CLI, server, TUI, Electron, browser-driven, library).",
  menuDescription: "Launch this project’s app to see your change working",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  files: () => RUN_EXAMPLE_FILES,
  prompt: ({ args }) =>
    args ? `${RUN_SKILL_BODY}\n\n## User Request\n\n${args}` : RUN_SKILL_BODY,
  unported: [],
};
