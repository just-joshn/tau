/** What a built-in skill's gate may read. GrowthBook flags resolve to their shipped defaults. */
export interface BuiltinSkillGateContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Print and SDK sessions are non-interactive (the original's `ge()`). */
  readonly interactive: boolean;
  readonly platform: NodeJS.Platform;
}

export interface BuiltinSkillPromptContext extends BuiltinSkillGateContext {
  /** Raw arguments, "" when none were given. */
  readonly args: string;
  readonly sessionId: string;
  readonly cwd: string;
  /** The directory the skill's files were written to; set only when it has files. */
  readonly skillDir?: string;
}

/**
 * One row of the original's built-in skill registry (`registerBundledSkill`,
 * built-in plugin skills, bundled workflows and built-in prompt commands).
 */
export interface BuiltinSkillSpec {
  readonly name: string;
  /**
   * "bundled": `wd()` registration. "workflow": a bundled Workflow script.
   * "plugin": a skill of a built-in plugin. "command": a built-in prompt command.
   */
  readonly origin: "bundled" | "workflow" | "plugin" | "command";
  /** The built-in plugin that ships a "plugin" skill. */
  readonly plugin?: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly menuDescription?: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly model?: string;
  /** The original runs it in a forked subagent ("fork") or inline (absent). */
  readonly context?: "fork";
  readonly userInvocable: boolean;
  readonly disableModelInvocation:
    boolean | ((context: BuiltinSkillGateContext) => boolean);
  readonly enabled: (context: BuiltinSkillGateContext) => boolean;
  /** Files written next to the body, keyed by path relative to the skill directory. */
  readonly files?: (
    context: BuiltinSkillGateContext,
  ) => Readonly<Record<string, string>>;
  /** The rendered body, without the "Base directory for this skill" line. */
  readonly prompt: (
    context: BuiltinSkillPromptContext,
  ) => string | Promise<string>;
  /** Tools, services or state the body names that tau lacks. */
  readonly unported: readonly string[];
}
