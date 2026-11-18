import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  createLocalSkillRegistry,
  LocalSkillRegistry,
  type LocalSkill,
  type SkillRegistryOptions,
} from "../../src/skills.js";

async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-skills-edges-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const skills = join(project, ".claude", "skills");
  await mkdir(skills, { recursive: true });
  const options: SkillRegistryOptions = {
    cwd: project,
    projectDirectories: [project],
    sources: { user: true, project: true },
  };
  const skill = async (name: string, text: string, directory = skills) => {
    await mkdir(join(directory, name), { recursive: true });
    const path = join(directory, name, "SKILL.md");
    await writeFile(path, text);
    return path;
  };
  return { root, project, skills, options, skill };
}

const frontmatter = (fields: string, body = "body") =>
  `---\n${fields}\n---\n${body}`;

async function single(
  fields: string,
  body = "body",
  extra: Partial<SkillRegistryOptions> = {},
) {
  const { options, skill } = await workspace();
  await skill("probe", frontmatter(fields, body));
  const registry = await createLocalSkillRegistry({ ...options, ...extra });
  const [info] = registry.catalog({ includeConditional: true });
  assert.ok(info);
  return { info, registry };
}

test("boolean frontmatter accepts yes/no style words and numbers; unknown words are false", async () => {
  const words = await single(
    "user-invocable: 'off'\ndisable-model-invocation: 1\nbackground: 'Yes'",
  );
  assert.equal(words.info.userInvocable, false);
  assert.equal(words.info.disableModelInvocation, true);
  assert.equal(words.info.background, true);
  const unknown = await single(
    "user-invocable: maybe\ndisable-model-invocation: [true]\nbackground: maybe",
  );
  assert.equal(unknown.info.userInvocable, false);
  assert.equal(unknown.info.disableModelInvocation, false);
  assert.equal(unknown.info.background, undefined);
});

test("string metadata fields stringify scalars and serialize structured values", async () => {
  const { info } = await single(
    "version: 2\nagent: true\nargument-hint: [branch, mode]\nwhen_to_use: null\nshell: PowerShell",
  );
  assert.equal(info.version, "2");
  assert.equal(info.agent, "true");
  assert.equal(info.argumentHint, '["branch","mode"]');
  assert.equal(info.whenToUse, undefined);
  assert.equal(info.shell, "powershell");
  assert.equal((await single("shell: zsh")).info.shell, undefined);
});

test("effort accepts named levels, integers and integer-prefixed text, and diagnoses the rest", async () => {
  const cases: Array<[string, LocalSkill["effort"], boolean]> = [
    ["effort: MED", "medium", false],
    ["effort: 3", 3, false],
    ["effort: '7 levels'", 7, false],
    ["effort: true", undefined, true],
    ["effort: {level: high}", undefined, true],
    ["effort: 2.5", 2, false],
  ];
  for (const [fields, expected, diagnosed] of cases) {
    const { info, registry } = await single(fields);
    assert.equal(info.effort, expected, fields);
    assert.equal(
      registry.diagnostics.some((issue) => issue.reason === "effort"),
      diagnosed,
      fields,
    );
  }
});

test("descriptions come from scalar frontmatter or the first body line, capped at 100 characters", async () => {
  const numeric = await single("description: 42");
  assert.equal(numeric.info.description, "42");
  assert.equal(numeric.info.hasUserSpecifiedDescription, true);
  const blank = await single("description: '   '", "\n\n# Heading text\nmore");
  assert.equal(blank.info.description, "Heading text");
  assert.equal(blank.info.hasUserSpecifiedDescription, false);
  const long = await single("name: x", "y".repeat(150));
  assert.equal(long.info.description, `${"y".repeat(97)}...`);
  const empty = await single("name: x", "");
  assert.equal(empty.info.description, "Skill");
});

test("list frontmatter keeps only usable string entries", async () => {
  const { info } = await single(
    "allowed-tools: [Read, 3, 'Bash(ls -la, pwd)']\ndisallowedTools: Write Edit\narguments: [first, 2, '', second]",
  );
  assert.deepEqual(info.allowedTools, ["Read", "Bash(ls -la, pwd)"]);
  assert.deepEqual(info.disallowedTools, ["Write", "Edit"]);
  assert.deepEqual(info.argumentNames, ["first", "second"]);
  const none = await single("allowed-tools: {Read: true}\narguments: 5");
  assert.deepEqual(none.info.allowedTools, []);
  assert.deepEqual(none.info.argumentNames, []);
});

test("an overlong display name falls back to the directory name", async () => {
  const { info } = await single(`name: ${"n".repeat(257)}`);
  assert.equal(info.displayName, "probe");
});

test("model frontmatter keeps inherit, trims and normalizes other names, and ignores non-strings", async () => {
  const normalizeModel = (name: string) => `normalized:${name}`;
  assert.equal(
    (await single("model: '  INHERIT '", "body", { normalizeModel })).info
      .model,
    "inherit",
  );
  assert.equal(
    (await single("model: ' sonnet '", "body", { normalizeModel })).info.model,
    "normalized:sonnet",
  );
  assert.equal((await single("model: ' sonnet '")).info.model, "sonnet");
  assert.equal((await single("model: 5")).info.model, undefined);
});

test("path patterns split lists and braces, drop trailing /**, and treat only-** as unconditional", async () => {
  assert.deepEqual(
    (await single("paths: ['src/**', 'docs/{a,b}.md, lib/*.ts']")).info.paths,
    ["src", "docs/a.md", "docs/b.md", "lib/*.ts"],
  );
  assert.equal((await single("paths: '**'")).info.paths, undefined);
  assert.equal((await single("paths: 5")).info.paths, undefined);
  // Expansions beyond 1000 results keep the original pattern instead.
  const huge = `{${Array.from({ length: 40 }, (_, index) => `a${index}`).join(",")}}`;
  const pattern = `${huge}/${huge}`;
  assert.deepEqual((await single(`paths: '${pattern}'`)).info.paths, [pattern]);
});

test("conditional skills appear in the catalog only when explicitly requested before activation", async () => {
  const { registry } = await single("paths: src/**");
  assert.deepEqual(registry.catalog(), []);
  assert.deepEqual(
    registry.catalog({ includeConditional: true }).map((skill) => skill.name),
    ["probe"],
  );
});

test("matcher-shaped hook entries anywhere outside hooks withhold grants; empty or typeless ones do not", async () => {
  const withheld = [
    "extra: [{matcher: Bash, hooks: {type: command, command: 'true'}}]",
    "extra: {hooks: {type: command, command: 'true'}}",
    "extra: {hooks: [{type: command, command: 'true'}]}",
    "PermissionRequest: [{hooks: []}]",
  ];
  for (const fields of withheld) {
    const { info, registry } = await single(`allowed-tools: Read\n${fields}`);
    assert.deepEqual(info.allowedTools, [], fields);
    assert.ok(
      registry.diagnostics.some((issue) => issue.reason === "unloadable-guard"),
      fields,
    );
  }
  const kept = [
    "extra: {hooks: []}",
    "extra: {hooks: {note: 1}}",
    "PreToolUse: null",
    "extra: {Stop: [{hooks: [{type: command, command: 'true'}]}]}",
    "a: {b: {c: {d: {e: {PreToolUse: [{hooks: [{type: command}]}]}}}}}",
    "Stop: {hooks: [{type: command, extra: {PreToolUse: [1]}}]}",
  ];
  for (const fields of kept) {
    const { info } = await single(`allowed-tools: Read\n${fields}`);
    assert.deepEqual(info.allowedTools, ["Read"], fields);
  }
});

test("a hook validator that returns a non-object withholds hooks and grants", async () => {
  const { info, registry } = await single(
    "allowed-tools: Read\nhooks: {Stop: []}",
    "body",
    { validateHooks: () => "not hooks" },
  );
  assert.deepEqual(info.allowedTools, []);
  assert.equal(info.hooks, undefined);
  assert.match(
    registry.diagnostics.map((issue) => issue.message).join("\n"),
    /validated hooks object/,
  );
});

test("source and skill admission callbacks can withhold with a reason", async () => {
  const { options, skill, skills } = await workspace();
  await skill("kept", "body");
  await skill("blocked", "body");
  const sourceWithheld = await createLocalSkillRegistry({
    ...options,
    admitSource: () => "project skills disabled",
  });
  assert.deepEqual(sourceWithheld.catalog(), []);
  assert.deepEqual(sourceWithheld.diagnostics, [
    {
      path: skills,
      source: "projectSettings",
      reason: "withheld-source",
      message: "project skills disabled",
    },
  ]);
  const skillWithheld = await createLocalSkillRegistry({
    ...options,
    admitSkill: (info) => (info.name === "blocked" ? "not allowed" : true),
  });
  assert.deepEqual(
    skillWithheld.catalog().map((info) => info.name),
    ["kept"],
  );
  assert.deepEqual(
    skillWithheld.diagnostics.map((issue) => [issue.reason, issue.message]),
    [["withheld-skill", "not allowed"]],
  );
});

test("unreadable skill directories and files are diagnosed, while a missing or non-directory root is silent", async () => {
  const { root, options, skill } = await workspace();
  const path = await skill("locked-file", "body");
  await chmod(path, 0o000);
  const lockedRoot = join(root, "locked-root");
  await mkdir(join(lockedRoot, ".claude", "skills"), { recursive: true });
  await chmod(join(lockedRoot, ".claude", "skills"), 0o000);
  const fileRoot = join(root, "file-root");
  await mkdir(join(fileRoot, ".claude"), { recursive: true });
  await writeFile(join(fileRoot, ".claude", "skills"), "");
  const registry = await createLocalSkillRegistry({
    ...options,
    additionalDirectories: [lockedRoot, fileRoot, join(root, "missing")],
  }).finally(async () => {
    await chmod(path, 0o600);
    await chmod(join(lockedRoot, ".claude", "skills"), 0o700);
  });
  assert.deepEqual(registry.catalog(), []);
  assert.deepEqual(
    registry.diagnostics.map((issue) => [issue.path, issue.reason]),
    [
      [path, "read-error"],
      [join(lockedRoot, ".claude", "skills"), "read-directory"],
    ],
  );
});

test("directory names must be offered, by default or by the caller's policy", async () => {
  const { options, skill, skills } = await workspace();
  await skill("two  spaces", "body");
  await skill("ok", "body");
  await skill("custom-reject", "body");
  const registry = await createLocalSkillRegistry(options);
  assert.deepEqual(
    registry.catalog().map((info) => info.name),
    ["custom-reject", "ok"],
  );
  assert.deepEqual(registry.diagnostics, [
    {
      path: join(skills, "two  spaces"),
      source: "projectSettings",
      reason: "invalid-name",
      message: "Skill directory name is not offered",
    },
  ]);
  const custom = await createLocalSkillRegistry({
    ...options,
    isOfferedName: (name) => name !== "custom-reject",
  });
  assert.deepEqual(
    custom.catalog().map((info) => info.name),
    ["ok", "two  spaces"],
  );
});

function definition(root: string, overrides: Partial<LocalSkill> = {}) {
  const baseDir = join(root, "plugin", "skills", "host");
  const info: LocalSkill = {
    name: "host",
    displayName: "host",
    description: "host skill",
    hasUserSpecifiedDescription: true,
    path: join(baseDir, "SKILL.md"),
    canonicalPath: join(baseDir, "SKILL.md"),
    baseDir,
    source: "plugin",
    allowedTools: [],
    disallowedTools: [],
    argumentNames: [],
    userInvocable: true,
    disableModelInvocation: false,
    contentLength: 0,
    ...overrides,
  };
  return info;
}

test("registered host definitions render plugin roots and may omit the base-directory preamble", async () => {
  const { root, project } = await workspace();
  const registry = new LocalSkillRegistry({
    cwd: project,
    sources: { user: true, project: true },
  });
  const pluginRoot = join(root, "plugin");
  assert.equal(
    registry.registerDefinitions([
      {
        info: definition(root, { pluginRoot }),
        body: "Run ${CLAUDE_PLUGIN_ROOT}/bin/tool",
        isSkillMode: false,
      },
    ]),
    1,
  );
  const invoked = await registry.invoke("host", undefined, {
    invocation: "user",
    sessionId: "s",
  });
  assert.equal(invoked.text, `Run ${pluginRoot}/bin/tool`);
});

test("managed-only registries withhold host definitions and invalid definitions are refused", async () => {
  const { root, project } = await workspace();
  const managed = new LocalSkillRegistry({
    cwd: project,
    sources: { user: true, project: true },
    managedOnly: true,
  });
  assert.equal(
    managed.registerDefinitions([{ info: definition(root), body: "x" }]),
    0,
  );
  assert.deepEqual(
    managed.diagnostics.map((issue) => issue.reason),
    ["withheld-source"],
  );
  const open = new LocalSkillRegistry({
    cwd: project,
    sources: { user: true, project: true },
  });
  assert.throws(
    () =>
      open.registerDefinitions([
        { info: definition(root, { name: "" }), body: "x" },
      ]),
    /Invalid admitted skill definition/,
  );
  assert.throws(
    () =>
      open.registerDefinitions([
        { info: definition(root, { baseDir: "relative/dir" }), body: "x" },
      ]),
    /Skill root must be absolute: relative\/dir/,
  );
  assert.throws(
    () =>
      new LocalSkillRegistry({
        cwd: "relative",
        sources: { user: true, project: true },
      }),
    /Skill root must be absolute/,
  );
});

test("unknown skills cannot be invoked", async () => {
  const { registry } = await single("name: x");
  await assert.rejects(
    registry.invoke("absent", undefined, {
      invocation: "user",
      sessionId: "s",
    }),
    /Unknown or inactive skill: absent/,
  );
});

test("ordinary argument tokens honor escapes and fall back to whitespace splitting when unbalanced", async () => {
  const { registry } = await single("arguments: [a, b]", "[$a][$b]");
  const render = async (args: string) =>
    (
      await registry.invoke("probe", args, {
        invocation: "user",
        sessionId: "s",
      })
    ).text;
  assert.match(await render("one\\ two three"), /\[one two\]\[three\]$/);
  assert.match(await render("'it''s' x"), /\[its\]\[x\]$/);
  assert.match(await render("trailing\\"), /\[trailing\\\]\[\]$/);
  assert.match(await render('"open quote'), /\["open\]\[quote\]$/);
  assert.match(await render("'a\\b' c"), /\[a\\b\]\[c\]$/);
});

test("discovery skips stray files and SKILL.md-less directories, and loads a skill with broken frontmatter", async () => {
  const { options, skill, skills } = await workspace();
  await writeFile(join(skills, "README.md"), "not a skill");
  await mkdir(join(skills, "empty"));
  const broken = await skill("broken", "---\n{name: broken\n---\nStill usable");
  const registry = await createLocalSkillRegistry(options);
  assert.deepEqual(
    registry.catalog().map((info) => [info.name, info.description]),
    [["broken", "Still usable"]],
  );
  assert.deepEqual(
    registry.diagnostics.map((issue) => [issue.path, issue.reason]),
    [[broken, "frontmatter"]],
  );
});
