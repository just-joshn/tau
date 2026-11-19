import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGIN_AUTHORING_FILES } from "./plugin-authoring-files.js";
import {
  CLOUD_SURFACE,
  EXISTING_REMOTES_ONLY,
  FILES_MISSING_AFTER,
  FILES_MISSING_BEFORE,
  HOSTED_SURFACE,
  MENU_DESCRIPTION,
  SKILL_BODY,
  SKILL_DESCRIPTION,
  TERMINAL_SURFACE,
} from "./plugin-authoring-text.js";
import type { BuiltinSkillGateContext, BuiltinSkillSpec } from "./types.js";

/** Entrypoints besides `remote*` the original treats as a cloud session (`det()`). */
const CLOUD_ENTRYPOINTS = new Set([
  "claude_in_slack",
  "claude-in-slack",
  "claude-in-teams",
]);

/**
 * `sessionSurfaceOf` (`qe`) for a session with no organization library tool and no
 * file hand-over tool, before any policy fetch: `allow_plugin_publish` misses its
 * cache and is denied, so the repository-sharing paragraph is always appended and
 * no share offer follows.
 */
function sessionSurface(context: BuiltinSkillGateContext): string {
  const entrypoint = context.env.CLAUDE_CODE_ENTRYPOINT;
  if (
    entrypoint !== undefined &&
    (CLOUD_ENTRYPOINTS.has(entrypoint) || entrypoint.startsWith("remote"))
  )
    return CLOUD_SURFACE + EXISTING_REMOTES_ONLY;
  return (
    (context.interactive ? TERMINAL_SURFACE : HOSTED_SURFACE) +
    EXISTING_REMOTES_ONLY
  );
}

/** `${CLAUDE_DEV_MODS_DIR}`: `<config dir>/dev-mods/<session id>`. */
function devModsDirectory(
  env: BuiltinSkillGateContext["env"],
  sessionId: string,
): string {
  const configDirectory = (
    env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  ).normalize("NFC");
  return join(configDirectory, "dev-mods", sessionId);
}

export const pluginAuthoringSkill: BuiltinSkillSpec = {
  name: "plugin-authoring",
  origin: "plugin",
  plugin: "cc-plugin-plugin-authoring",
  description: SKILL_DESCRIPTION,
  menuDescription: MENU_DESCRIPTION,
  allowedTools: [],
  disallowedTools: [],
  userInvocable: true,
  disableModelInvocation: false,
  // The plugin is not registered for the local-agent entrypoint; its isAvailable is
  // hooks modules on (tengu_plugin_hooks_modules, default true).
  enabled: (context) => context.env.CLAUDE_CODE_ENTRYPOINT !== "local-agent",
  files: () => PLUGIN_AUTHORING_FILES,
  prompt(context) {
    const skillDirectory = context.skillDir ?? "${CLAUDE_SKILL_DIR}";
    const surface = sessionSurface(context);
    const devMods = devModsDirectory(context.env, context.sessionId);
    const body = SKILL_BODY.replaceAll(
      "${CLAUDE_SKILL_DIR}",
      () => skillDirectory,
    )
      .replaceAll("${CLAUDE_SESSION_SURFACE}", () => surface)
      .replaceAll("${CLAUDE_DEV_MODS_DIR}", () => devMods)
      .replace(/\r\n/g, "\n")
      .trim();
    const note =
      context.skillDir === undefined
        ? FILES_MISSING_BEFORE + skillDirectory + FILES_MISSING_AFTER
        : "";
    return context.args.trim() === ""
      ? note + body
      : `${note}${body}\n\n## User Request\n\n${context.args}`;
  },
  unported: [
    "types/claude-code.d.ts declares no built-in tool inputs or results (needs the session's tool list)",
    "scan_secrets MCP tool and the hooks module that registers it",
    "SendUserFile hand-over secret check",
    "dev mods folder watch and hot reload that loading the skill starts",
    "organization library publishing and claude.ai sharing branches (policy fetch, plan, tools)",
  ],
};
