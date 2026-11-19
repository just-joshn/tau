import type { BuiltinSkillSpec } from "./types.js";

export const keybindingsHelpSkill: BuiltinSkillSpec = {
  name: "keybindings-help",
  origin: "bundled",
  description:
    'Use when the user wants to customize keyboard shortcuts, rebind keys, add chord bindings, or modify ~/.claude/keybindings.json. Examples: "rebind ctrl+s", "add a chord shortcut", "change the submit key", "customize keybindings".',
  allowedTools: [],
  disallowedTools: [],
  userInvocable: false,
  disableModelInvocation: false,
  enabled: () => true,
  prompt: () => "",
  unported: ["body not yet ported"],
};
