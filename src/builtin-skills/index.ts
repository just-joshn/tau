import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, isAbsolute, sep } from "node:path";
import type { AdmittedSkillDefinition, LocalSkill } from "../skills.js";
import type {
  BuiltinSkillGateContext,
  BuiltinSkillPromptContext,
  BuiltinSkillSpec,
} from "./types.js";
import { batchSkill } from "./batch.js";
import { claudeApiSkill } from "./claude-api.js";
import { codeReviewSkill } from "./code-review.js";
import { datavizSkill } from "./dataviz.js";
import { debugSkill } from "./debug.js";
import { deepResearchSkill } from "./deep-research.js";
import { doctorSkill } from "./doctor.js";
import { fewerPermissionPromptsSkill } from "./fewer-permission-prompts.js";
import { initSkill } from "./init.js";
import { keybindingsHelpSkill } from "./keybindings-help.js";
import { loopSkill } from "./loop.js";
import { pluginAuthoringSkill } from "./plugin-authoring.js";
import { runSkillGeneratorSkill } from "./run-skill-generator.js";
import { runSkill } from "./run.js";
import { securityReviewSkill } from "./security-review.js";
import { simplifySkill } from "./simplify.js";
import { updateConfigSkill } from "./update-config.js";
import { verifySkill } from "./verify.js";
import { workflowAuthoringSkill } from "./workflow-authoring.js";

export type { BuiltinSkillGateContext, BuiltinSkillSpec } from "./types.js";

/**
 * The original's command merge order (`yss`): bundled workflows, bundled skills
 * in `Lqe` registration order, built-in plugin skills, then built-in prompt
 * commands in their table order. Local skill directories come before all of them.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkillSpec[] = [
  deepResearchSkill,
  datavizSkill,
  updateConfigSkill,
  keybindingsHelpSkill,
  verifySkill,
  debugSkill,
  codeReviewSkill,
  simplifySkill,
  batchSkill,
  fewerPermissionPromptsSkill,
  doctorSkill,
  loopSkill,
  claudeApiSkill,
  workflowAuthoringSkill,
  runSkill,
  runSkillGeneratorSkill,
  pluginAuthoringSkill,
  initSkill,
  securityReviewSkill,
];

/** The built-in plugins the original's init lists, in its order. */
export const BUILTIN_PLUGINS = [
  "cc-plugin-agents-md",
  "cc-plugin-privacy",
  "cc-plugin-plugin-authoring",
] as const;

export function enabledBuiltinSkills(
  context: BuiltinSkillGateContext,
): BuiltinSkillSpec[] {
  return BUILTIN_SKILLS.filter((skill) => skill.enabled(context));
}

/** `<tmp>/claude-<uid>/bundled-skills/<version>/<random>`, the original's `Swn()`. */
export function bundledSkillsRoot(
  env: Readonly<Record<string, string | undefined>>,
  version: string,
): string {
  const base = env.CLAUDE_CODE_TMPDIR || "/tmp";
  let resolved = base;
  try {
    resolved = realpathSync(base);
  } catch {
    // Nothing is created until a skill with files runs; keep the configured spelling.
  }
  return join(
    resolved,
    `claude-${process.getuid?.() ?? 0}`,
    "bundled-skills",
    version,
    randomBytes(16).toString("hex"),
  );
}

async function writeSkillFiles(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = normalize(relative);
    if (isAbsolute(path) || path.split(sep).includes(".."))
      throw new Error("bundled file path escapes its extraction dir");
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

/** Registry rows for the enabled built-ins. Bodies render on invocation. */
export function builtinSkillDefinitions(options: {
  gate: BuiltinSkillGateContext;
  cwd: string;
  root: string;
}): AdmittedSkillDefinition[] {
  return enabledBuiltinSkills(options.gate).map((spec) => {
    const directory = join(options.root, spec.name);
    const info: LocalSkill = {
      name: spec.name,
      displayName: spec.name,
      description: spec.description,
      hasUserSpecifiedDescription: true,
      path: directory,
      canonicalPath: directory,
      baseDir: directory,
      source: spec.origin === "command" ? "builtinCommand" : "bundled",
      allowedTools: [...spec.allowedTools],
      disallowedTools: [...spec.disallowedTools],
      argumentNames: [],
      userInvocable: spec.userInvocable,
      disableModelInvocation:
        typeof spec.disableModelInvocation === "function"
          ? spec.disableModelInvocation(options.gate)
          : spec.disableModelInvocation,
      contentLength: 0,
      ...(spec.argumentHint === undefined
        ? {}
        : { argumentHint: spec.argumentHint }),
      ...(spec.whenToUse === undefined ? {} : { whenToUse: spec.whenToUse }),
      ...(spec.menuDescription === undefined
        ? {}
        : { menuDescription: spec.menuDescription }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.context === undefined ? {} : { context: spec.context }),
    };
    let written: Promise<boolean> | undefined;
    return {
      info,
      body: "",
      async render(args: string, context: { sessionId: string }) {
        const files = spec.files?.(options.gate) ?? {};
        const hasFiles = Object.keys(files).length > 0;
        let extracted = false;
        if (hasFiles) {
          written ??= writeSkillFiles(directory, files).then(
            () => true,
            () => false,
          );
          extracted = await written;
          // A failed extraction is retried on the next invocation, like the original.
          if (!extracted) written = undefined;
        }
        const prompt: BuiltinSkillPromptContext = {
          ...options.gate,
          args,
          sessionId: context.sessionId,
          cwd: options.cwd,
          ...(extracted ? { skillDir: directory } : {}),
        };
        const text = await spec.prompt(prompt);
        return extracted
          ? `Base directory for this skill: ${directory}\n\n${text}`
          : text;
      },
    };
  });
}
