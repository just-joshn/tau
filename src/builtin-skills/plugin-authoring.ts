import type { BuiltinSkillSpec } from "./types.js";

export const pluginAuthoringSkill: BuiltinSkillSpec = {
  name: "plugin-authoring",
  origin: "plugin",
  plugin: "cc-plugin-plugin-authoring",
  description:
    "Make a mod: a change to Claude's own interface or behaviour, such as a theme, a panel or pane that stays beside the chat and updates, a band, status line, toast, slash command, or hook on tool calls. Use to make, change or debug a mod or its hooks module.",
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
