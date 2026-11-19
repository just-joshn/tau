import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, test } from "bun:test";
import { claudeApiSkill } from "../../src/builtin-skills/claude-api.js";
import { datavizSkill } from "../../src/builtin-skills/dataviz.js";
import {
  builtinSkillDefinitions,
  bundledSkillsRoot,
  enabledBuiltinSkills,
} from "../../src/builtin-skills/index.js";
import { pluginAuthoringSkill } from "../../src/builtin-skills/plugin-authoring.js";
import { runSkillGeneratorSkill } from "../../src/builtin-skills/run-skill-generator.js";
import { runSkill } from "../../src/builtin-skills/run.js";
import type {
  BuiltinSkillGateContext,
  BuiltinSkillPromptContext,
  BuiltinSkillSpec,
} from "../../src/builtin-skills/types.js";
import { verifySkill } from "../../src/builtin-skills/verify.js";
import {
  workflowAuthoringBody,
  workflowAuthoringSkill,
} from "../../src/builtin-skills/workflow-authoring.js";

const gate: BuiltinSkillGateContext = {
  env: {},
  interactive: false,
  platform: "darwin",
};

function directory(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function skillRender(
  listed: ReturnType<typeof builtinSkillDefinitions>,
  name: string,
) {
  const render = listed.find(
    (definition) => definition.info.name === name,
  )?.render;
  if (render === undefined) throw new Error(`${name} was not registered`);
  return render;
}

function promptContext(
  overrides: Partial<BuiltinSkillPromptContext> = {},
): BuiltinSkillPromptContext {
  return {
    ...gate,
    args: "",
    sessionId: "session",
    cwd: overrides.cwd ?? directory("tau-builtin-cwd-"),
    ...overrides,
  };
}

function renderClaude(
  args: string,
  options: { cwd?: string; skillDir?: string; file?: string } = {},
) {
  const cwd = options.cwd ?? directory("tau-claude-cwd-");
  if (options.file !== undefined) writeFileSync(join(cwd, options.file), "");
  return claudeApiSkill.prompt(
    promptContext({
      args,
      cwd,
      ...(options.skillDir === undefined ? {} : { skillDir: options.skillDir }),
    }),
  );
}

async function requestSection(skill: BuiltinSkillSpec, args: string) {
  const bare = await skill.prompt(promptContext({ args: "" }));
  const asked = await skill.prompt(promptContext({ args }));
  expect(bare).not.toContain("## User Request");
  expect(asked).toBe(`${bare}\n\n## User Request\n\n${args}`);
  expect(bare.length).toBeGreaterThan(0);
}

test("claude-api stays enabled unless the disable flag is a truthy word", () => {
  const enabled = (value: string | undefined) =>
    claudeApiSkill.enabled({
      ...gate,
      env:
        value === undefined
          ? {}
          : { CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: value },
    });
  expect(enabled(undefined)).toBe(true);
  expect(enabled("false")).toBe(true);
  expect(enabled("TRUE")).toBe(true);
  for (const value of ["1", "true", "yes", "on"])
    expect(enabled(value)).toBe(false);
});

test("claude-api inlines live sources and withholds security guidance when its files were not saved", async () => {
  const text = await renderClaude("");
  expect(text).toContain("## Reference Files Unavailable");
  expect(text).toContain('<doc path="shared/live-sources.md">');
  expect(text).toContain("which are not on disk this session");
  expect(text).toContain("## Onboarding From a URL Unavailable");
  expect(text).toContain(
    "No project language was auto-detected. If the request is to compare a Managed Agents deployment with the published security guide, none is needed: see Security Comparison Unavailable above. Otherwise, ask the user which language they are using (see Language Detection above) before writing code.",
  );
  expect(text).not.toContain("cannot check the `ant` commands");
  expect(text).not.toContain("from the base directory before anything else");
});

test("claude-api skips the language question for prompt-audit and the security command", async () => {
  const audit = await renderClaude("prompt-audit src");
  const secure = await renderClaude("managed-agents-secure");
  const migrate = await renderClaude("Migrate the client");
  for (const text of [audit, secure]) {
    expect(text).not.toContain("No project language was auto-detected.");
    expect(text).not.toContain("Ask the user which language");
  }
  expect(secure).toContain("which are not on disk this session");
  expect(audit).not.toContain("which are not on disk this session");
  expect(migrate).not.toContain("which are not on disk this session");
  expect(migrate).toContain(
    "No project language was auto-detected. Ask the user which language they are using (see Language Detection above) before writing code.",
  );
  expect(migrate).not.toContain(
    "If the request is to compare a Managed Agents deployment",
  );
  expect(migrate).toContain("## Onboarding From a URL Unavailable");
});

test("claude-api quotes onboard requests, urls, and requests that break across lines", async () => {
  const onboard = await renderClaude("managed-agents-onboard cookbook");
  const link = await renderClaude("migrate https://docs.example/agent");
  const lines = await renderClaude("migrate first\nsecond");
  const plain = await renderClaude("how do streams work");
  expect(onboard).toContain(
    "## User Request\n\n> managed-agents-onboard cookbook",
  );
  expect(link).toContain(
    "## User Request\n\n> migrate https://docs.example/agent",
  );
  expect(lines).toContain("## User Request\n\n> migrate first\n> second");
  expect(plain.endsWith("## User Request\n\nhow do streams work")).toBe(true);
  expect(plain).not.toContain("> how do streams work");
});

test("claude-api inlines a detected readme without the on-disk note when the files were not saved", async () => {
  const missing = await renderClaude("", { file: "app.py" });
  const saved = await renderClaude("", {
    file: "app.py",
    skillDir: "/session/claude-api",
  });
  expect(missing).toContain("## Detected Language: python");
  expect(missing).toContain('<doc path="python/claude-api/README.md">');
  expect(missing).not.toContain(
    "Read the other referenced files from the base directory on demand.",
  );
  expect(saved).toContain(
    "Read the other referenced files from the base directory on demand.",
  );
  expect(saved).toContain("cannot check the `ant` commands");
  expect(saved).not.toContain("## Reference Files Unavailable");
});

test("a user request is appended only when a built-in skill was given arguments", async () => {
  await requestSection(datavizSkill, "a bar chart of sales");
  await requestSection(runSkill, "start the app");
  await requestSection(verifySkill, "try the change");
  await requestSection(runSkillGeneratorSkill, "write the run skill");
  expect(datavizSkill.enabled(gate)).toBe(true);
  expect(runSkill.enabled(gate)).toBe(true);
  expect(verifySkill.enabled(gate)).toBe(true);
  expect(runSkillGeneratorSkill.enabled(gate)).toBe(true);
  expect(Object.keys(datavizSkill.files?.(gate) ?? {})).toContain(
    "references/palette.md",
  );
  expect(Object.keys(runSkillGeneratorSkill.files?.(gate) ?? {})).toContain(
    "template.md",
  );
  expect(runSkill.disableModelInvocation).toBe(false);
  expect(verifySkill.disableModelInvocation).toBe(true);
});

test("bundled skills root uses the given temp dir, /tmp, or uid 0 when getuid is absent", () => {
  const custom = directory("tau-skills-tmp-");
  const rooted = bundledSkillsRoot({ CLAUDE_CODE_TMPDIR: custom }, "4.5.6");
  expect(rooted.startsWith(`${realpathSync(custom)}${sep}`)).toBe(true);
  expect(rooted).toContain(`${sep}bundled-skills${sep}4.5.6${sep}`);
  expect(rooted).toContain(`${sep}claude-${process.getuid?.()}${sep}`);

  const fallback = bundledSkillsRoot({}, "1.0.0");
  expect(fallback.startsWith(`${realpathSync("/tmp")}${sep}`)).toBe(true);

  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  delete process.getuid;
  try {
    const anonymous = bundledSkillsRoot(
      { CLAUDE_CODE_TMPDIR: custom },
      "1.2.3",
    );
    expect(anonymous).toContain(
      `${sep}claude-0${sep}bundled-skills${sep}1.2.3${sep}`,
    );
  } finally {
    if (descriptor !== undefined)
      Object.defineProperty(process, "getuid", descriptor);
  }
});

test("registry rows keep command source, hints, and menu copy, and a file-less skill has no base directory", async () => {
  const root = directory("tau-builtin-root-");
  const listed = builtinSkillDefinitions({
    gate,
    cwd: directory("tau-work-"),
    root,
  });
  const info = Object.fromEntries(
    listed.map((definition) => [definition.info.name, definition.info]),
  );
  expect(info.init?.source).toBe("builtinCommand");
  expect(info["security-review"]?.source).toBe("builtinCommand");
  expect(info.dataviz?.source).toBe("bundled");
  expect(info.doctor?.argumentHint).toBe("[prompt-audit [<path>]]");
  expect(info.debug?.argumentHint).toBeUndefined();
  expect(info["code-review"]?.whenToUse).toContain("reviewer subagents");
  expect(info.dataviz?.whenToUse).toBeUndefined();
  expect(info.dataviz?.menuDescription).toBe(
    "Chart and dashboard design guidance",
  );
  expect(info.init?.menuDescription).toBeUndefined();
  expect(info.debug?.model).toBeUndefined();
  expect(info.debug?.context).toBeUndefined();
  expect(info.dataviz?.disableModelInvocation).toBe(false);
  expect(info.verify?.disableModelInvocation).toBe(true);

  expect(
    await skillRender(listed, "debug")("anything", { sessionId: "session" }),
  ).toBe("");
  expect(existsSync(join(root, "debug"))).toBe(false);
});

test("a failed skill extraction omits the base directory and the next render tries again", async () => {
  const parent = directory("tau-extract-");
  const root = join(parent, "root");
  writeFileSync(root, "blocked");
  const listed = builtinSkillDefinitions({
    gate,
    cwd: directory("tau-extract-work-"),
    root,
  });
  const render = skillRender(listed, "dataviz");
  const blocked = await render("plot it", { sessionId: "session" });
  expect(blocked.startsWith("Base directory for this skill:")).toBe(false);
  expect(blocked).toContain("## User Request\n\nplot it");

  rmSync(root);
  mkdirSync(root);
  const saved = await render("", { sessionId: "session" });
  const directoryLine = /^Base directory for this skill: (.+)\n/.exec(saved);
  expect(directoryLine?.[1]).toBe(join(root, "dataviz"));
  expect(
    readFileSync(join(root, "dataviz", "references/palette.md"), "utf8").length,
  ).toBeGreaterThan(0);
  expect(saved).not.toContain("## User Request");
});

test("plugin-authoring describes cloud, terminal, and hosted sessions", async () => {
  const surfaces = [
    {
      env: {},
      interactive: true,
      includes: "is drawn in a terminal",
      excludes: "cloud container",
    },
    {
      env: {},
      interactive: false,
      includes: "draws in no terminal of its own",
      excludes: "cloud container",
    },
    {
      env: { CLAUDE_CODE_ENTRYPOINT: "cli" },
      interactive: true,
      includes: "is drawn in a terminal",
      excludes: "cloud container",
    },
    {
      env: { CLAUDE_CODE_ENTRYPOINT: "claude-in-slack" },
      interactive: false,
      includes: "cloud container",
      excludes: "is drawn in a terminal",
    },
    {
      env: { CLAUDE_CODE_ENTRYPOINT: "remote" },
      interactive: true,
      includes: "cloud container",
      excludes: "is drawn in a terminal",
    },
  ];
  for (const surface of surfaces) {
    const text = await pluginAuthoringSkill.prompt(
      promptContext({
        env: surface.env,
        interactive: surface.interactive,
        sessionId: "abc",
        skillDir: "/skills/plugin-authoring",
      }),
    );
    expect(text).toContain(surface.includes);
    expect(text).not.toContain(surface.excludes);
    expect(text).toContain(
      "git pushes a mod only to a remote the person already has",
    );
    expect(text).toContain("/skills/plugin-authoring");
    expect(text).toContain(`${homedir()}/.claude/dev-mods/abc`);
    expect(text).not.toContain("could not write this skill's folder");
    expect(text).not.toContain("## User Request");
  }

  const configured = await pluginAuthoringSkill.prompt(
    promptContext({
      env: { CLAUDE_CONFIG_DIR: "/cfg" },
      sessionId: "abc",
      args: "  ",
    }),
  );
  expect(configured).toContain("/cfg/dev-mods/abc");
  expect(configured).toContain(
    "could not write this skill's folder, ${CLAUDE_SKILL_DIR},",
  );
  expect(configured).not.toContain("## User Request");

  const asked = await pluginAuthoringSkill.prompt(
    promptContext({
      env: { CLAUDE_CONFIG_DIR: "/cfg" },
      skillDir: "/skills/plugin-authoring",
      args: "draw a pane",
    }),
  );
  expect(asked).toContain("## User Request\n\ndraw a pane");
  expect(asked).not.toContain("could not write this skill's folder");
  expect(Object.keys(pluginAuthoringSkill.files?.(gate) ?? {})).toContain(
    "examples/pane.tsx",
  );
});

test("plugin-authoring and workflow authoring drop out of the catalog when their gates are off", () => {
  const names = (env: Record<string, string | undefined>) =>
    enabledBuiltinSkills({ ...gate, env }).map((skill) => skill.name);
  expect(names({})).toContain("plugin-authoring");
  expect(names({})).toContain("workflow-authoring");
  expect(names({ CLAUDE_CODE_ENTRYPOINT: "local-agent" })).not.toContain(
    "plugin-authoring",
  );
  expect(names({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toContain(
    "plugin-authoring",
  );
  expect(names({ CLAUDE_CODE_DISABLE_WORKFLOWS: "yes" })).not.toContain(
    "workflow-authoring",
  );
  expect(names({ CLAUDE_CODE_WORKFLOWS: "off" })).not.toContain(
    "workflow-authoring",
  );
  expect(
    names({
      CLAUDE_CODE_DISABLE_WORKFLOWS: "false",
      CLAUDE_CODE_WORKFLOWS: "true",
    }),
  ).toContain("workflow-authoring");
});

test("workflow authoring keeps model guidance and the session effort unless a subagent override is set", () => {
  const open = workflowAuthoringBody({});
  expect(open).toContain("Add `model` to a phase entry");
  expect(open).toContain("opts.model overrides the model");
  expect(open).toContain("inherit the session effort");
  expect(open).not.toContain("use the configured subagent default");

  const blank = workflowAuthoringBody({
    CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: "   ",
  });
  expect(blank).toContain("Add `model` to a phase entry");

  const inherited = workflowAuthoringBody({
    CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: "Inherit",
  });
  expect(inherited).toContain("opts.model overrides the model");

  for (const env of [
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "on" },
    { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: " Opus " },
  ]) {
    const text = workflowAuthoringBody(env);
    expect(text).not.toContain("Add `model` to a phase entry");
    expect(text).not.toContain("opts.model overrides the model");
  }

  for (const effort of ["HIGH", "med"]) {
    const text = workflowAuthoringBody({
      CLAUDE_CODE_SUBAGENT_EFFORT: effort,
    });
    expect(text).toContain("use the configured subagent default");
    expect(text).not.toContain("inherit the session effort");
  }
  expect(
    workflowAuthoringBody({ CLAUDE_CODE_SUBAGENT_EFFORT: "turbo" }),
  ).toContain("inherit the session effort");
  expect(
    workflowAuthoringSkill.prompt(promptContext({ args: "ignored" })),
  ).toBe(workflowAuthoringSkill.prompt(promptContext()));
});
