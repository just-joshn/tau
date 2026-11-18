import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSkillRegistry,
  parseSkillText,
  parseSkillToolList,
  SKILL_MAX_BYTES,
  type SkillRegistryOptions,
} from "../../src/skills.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-skills-")),
    user = join(root, "user"),
    project = join(root, "project"),
    parent = join(root, "parent"),
    managed = join(root, "managed");
  await Promise.all(
    [user, project, parent, managed].map((path) => mkdir(path)),
  );
  const options: SkillRegistryOptions = {
    cwd: project,
    userConfigDir: user,
    managedRoot: managed,
    projectDirectories: [project, parent],
    sources: { user: true, project: true },
  };
  async function skill(
    location: "user" | "project" | "parent" | "managed",
    name: string,
    text: string,
  ) {
    const directory = join(
      { user, project, parent, managed }[location],
      ...(location === "user" ? ["skills"] : [".claude", "skills"]),
      name,
    );
    await mkdir(directory, { recursive: true });
    const path = join(directory, "SKILL.md");
    await writeFile(path, text);
    return { directory, path };
  }
  return {
    root,
    user,
    project,
    parent,
    managed,
    options,
    skill,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("local discovery exposes metadata and invocation lazily renders body without reading resources", async () => {
  const f = await fixture();
  try {
    const item = await f.skill(
      "project",
      "review",
      "---\nname: Review display\ndescription: Inspect changes\nallowed-tools: Read, Bash(git diff:*)\nmodel: inherit\neffort: med\nargument-hint: '[branch]'\n---\nInspect $ARGUMENTS using templates/detail.md\n",
    );
    await writeFile(
      join(item.directory, "templates.txt"),
      "support resource must stay unopened",
    );
    const reads: string[] = [],
      registry = await createLocalSkillRegistry({
        ...f.options,
        readPolicy: (path) => {
          reads.push(path);
          return true;
        },
      });
    const [info] = registry.catalog();
    assert.equal(info?.name, "review");
    assert.equal(info.displayName, "Review display");
    assert.equal(info.description, "Inspect changes");
    assert.equal(info.model, "inherit");
    assert.equal(info.effort, "medium");
    assert.deepEqual(info.allowedTools, ["Read", "Bash(git diff:*)"]);
    assert.equal("body" in info, false);
    const invoked = await registry.invoke("review", "main", {
      invocation: "model",
      sessionId: "dummy",
    });
    assert.match(invoked.text, /^Base directory for this skill: /);
    assert.match(invoked.text, /Inspect main using templates\/detail.md/);
    assert.equal(
      reads.some((path) => path.endsWith("templates.txt")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("managed, user, and nearest project ordering retains the first command of a name", async () => {
  const f = await fixture();
  try {
    for (const scope of ["managed", "user", "project", "parent"] as const)
      await f.skill(scope, "same", scope);
    let registry = await createLocalSkillRegistry(f.options);
    assert.equal(registry.catalog()[0]?.source, "policySettings");
    assert.match(
      (
        await registry.invoke("same", undefined, {
          invocation: "user",
          sessionId: "dummy",
        })
      ).text,
      /managed$/,
    );
    const { managedRoot: _managedRoot, ...withoutManaged } = f.options;
    registry = await createLocalSkillRegistry(withoutManaged);
    assert.equal(registry.catalog()[0]?.source, "userSettings");
    registry = await createLocalSkillRegistry({
      cwd: f.project,
      projectDirectories: [f.project, f.parent],
      sources: { user: false, project: true },
    });
    assert.match(
      (
        await registry.invoke("same", undefined, {
          invocation: "user",
          sessionId: "dummy",
        })
      ).text,
      /project$/,
    );
  } finally {
    await f.close();
  }
});

test("source gating, managed-only and explicit source admission do not read withheld directories", async () => {
  const f = await fixture();
  try {
    await f.skill("managed", "policy", "policy");
    await f.skill("user", "personal", "user");
    await f.skill("project", "workspace", "project");
    const reads: string[] = [],
      registry = await createLocalSkillRegistry({
        ...f.options,
        sources: { user: false, project: true },
        admitSource: ({ source }) =>
          source === "projectSettings" ? "untrusted fixture" : true,
        readPolicy: (path) => {
          reads.push(path);
          return true;
        },
      });
    assert.deepEqual(
      registry.catalog().map((item) => item.name),
      ["policy"],
    );
    assert.equal(
      reads.some(
        (path) => path.includes("personal") || path.includes("workspace"),
      ),
      false,
    );
    assert.deepEqual(
      (await createLocalSkillRegistry({ ...f.options, managedOnly: true }))
        .catalog()
        .map((item) => item.name),
      ["policy"],
    );
  } finally {
    await f.close();
  }
});

test("canonical-file dedupe, reserved synced directory and regular/capped reads are enforced", async () => {
  const f = await fixture();
  try {
    const item = await f.skill("user", "linked", "body");
    await mkdir(join(f.project, ".claude", "skills"), { recursive: true });
    await symlink(
      item.directory,
      join(f.project, ".claude", "skills", "alias"),
    );
    await f.skill("project", "synced", "reserved");
    await f.skill("project", "oversized", "x".repeat(SKILL_MAX_BYTES + 1));
    const registry = await createLocalSkillRegistry(f.options);
    assert.deepEqual(
      registry.catalog().map((info) => info.name),
      ["linked"],
    );
    assert.equal(
      registry.diagnostics.some((issue) => issue.reason === "oversize"),
      true,
    );
  } finally {
    await f.close();
  }
});

test("frontmatter fallback quotes source-like lossy scalar syntax and malformed YAML loses only metadata", () => {
  const recovered = parseSkillText(
    "---\ndescription: review: carefully\n---\nbody",
  );
  assert.equal(recovered.fields.description, "review: carefully");
  assert.equal(recovered.content, "body");
  const invalid = parseSkillText(
    "---\nallowed-tools: [unterminated\nother: [still broken\n---\nbody",
  );
  // The source's scalar-quoting recovery may admit this as literal strings.
  assert.equal(invalid.content, "body");
  const broken = parseSkillText("---\n[one,\n---\nbody");
  assert.deepEqual(broken.fields, {});
  assert.equal(broken.content, "body");
  assert.equal(typeof broken.parseError, "string");
  assert.equal(
    parseSkillText("---\nuser_invocable: false\n---\nx").fields[
      "user-invocable"
    ],
    undefined,
  );
});

test("literal name is the directory, description falls back to first nonblank body line", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "directory-name",
      "---\nname: display-only\ndescription: [invalid]\n---\n\n# First heading\nrest",
    );
    const registry = await createLocalSkillRegistry(f.options),
      [info] = registry.catalog();
    assert.ok(info);
    assert.equal(info.name, "directory-name");
    assert.equal(info.displayName, "display-only");
    assert.equal(info.description, "First heading");
    assert.equal(info.hasUserSpecifiedDescription, false);
    await assert.rejects(
      registry.invoke("display-only", "", {
        invocation: "user",
        sessionId: "dummy",
      }),
      /Unknown/,
    );
  } finally {
    await f.close();
  }
});

test("user/model catalog flags are separate and disable-model-invocation rejects automatic invocation", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "manual",
      "---\ndisable-model-invocation: yes\n---\nmanual",
    );
    await f.skill(
      "project",
      "automatic",
      "---\nuser-invocable: false\n---\nautomatic",
    );
    const registry = await createLocalSkillRegistry(f.options);
    assert.deepEqual(
      registry.catalog({ invocation: "user" }).map((info) => info.name),
      ["manual"],
    );
    assert.deepEqual(
      registry.catalog({ invocation: "model" }).map((info) => info.name),
      ["automatic"],
    );
    await assert.rejects(
      registry.invoke("manual", undefined, {
        invocation: "model",
        sessionId: "dummy",
      }),
      /explicit user/,
    );
    assert.match(
      (
        await registry.invoke("manual", undefined, {
          invocation: "user",
          sessionId: "dummy",
        })
      ).text,
      /manual$/,
    );
    // Source user-invocable hides discovery; evt does not prohibit a direct explicit name.
    assert.match(
      (
        await registry.invoke("automatic", undefined, {
          invocation: "user",
          sessionId: "dummy",
        })
      ).text,
      /automatic$/,
    );
  } finally {
    await f.close();
  }
});

test("positional/named arguments, literal dollar escaping and no-placeholder append follow source order", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "args",
      "---\narguments: [first, second]\n---\n$first|$second|$0|$ARGUMENTS[1]|$ARGUMENTS|\\$ARGUMENTS|$ARGUMENTS[8]|$9",
    );
    await f.skill("project", "append", "just body");
    const registry = await createLocalSkillRegistry(f.options),
      output = await registry.invoke("args", '"one two" three', {
        invocation: "user",
        sessionId: "dummy",
      });
    assert.match(
      output.text,
      /one two\|three\|one two\|three\|"one two" three\|\$ARGUMENTS\|\$ARGUMENTS\[8\]\|\$9$/,
    );
    assert.match(
      (
        await registry.invoke("append", "extra words", {
          invocation: "user",
          sessionId: "dummy",
        })
      ).text,
      /just body\n\nARGUMENTS: extra words$/,
    );
    assert.match(
      (
        await registry.invoke("args", "$ARGUMENTS", {
          invocation: "user",
          sessionId: "dummy",
          argumentTokens: ["literal"],
        })
      ).text,
      /\|\$ARGUMENTS\|\$ARGUMENTS\|/,
    );
  } finally {
    await f.close();
  }
});

test("substitutions expose explicit skill/project/session/effort context and tool grants", async () => {
  const f = await fixture();
  try {
    const item = await f.skill(
      "project",
      "variables",
      "---\nallowed-tools: ['Read(${CLAUDE_SKILL_DIR}/**)', 'Bash(cd ${CLAUDE_PROJECT_DIR}:*)']\neffort: 17tail\nmodel: sonnet\ncontext: fork\nagent: Explore\nbackground: on\n---\n${CLAUDE_SKILL_DIR}|${CLAUDE_PROJECT_DIR}|${CLAUDE_SESSION_ID}|${CLAUDE_EFFORT}",
    );
    const registry = await createLocalSkillRegistry({
      ...f.options,
      normalizeModel: (name) => `resolved:${name}`,
    });
    await assert.rejects(
      registry.invoke("variables", undefined, {
        invocation: "user",
        sessionId: "dummy-session",
      }),
      /resolved effortLevel/,
    );
    const result = await registry.invoke("variables", undefined, {
      invocation: "user",
      sessionId: "dummy-session",
      effortLevel: "high",
    });
    assert.match(result.text, /dummy-session\|high$/);
    assert.equal(result.allowedTools[0], `Read(${item.directory}/**)`);
    assert.equal(result.model, "resolved:sonnet");
    assert.equal(result.effort, 17);
    assert.equal(result.context, "fork");
    assert.equal(result.agent, "Explore");
    assert.equal(result.background, true);
  } finally {
    await f.close();
  }
});

test("conditional paths activate on matched project-relative files and stay out of ordinary catalog beforehand", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "conditional",
      "---\npaths: ['src/**/*.{ts,tsx}', '!src/generated/*.ts']\n---\nconditional",
    );
    await f.skill(
      "project",
      "unconditional",
      "---\npaths: '**'\n---\nunconditional",
    );
    const registry = await createLocalSkillRegistry(f.options);
    assert.deepEqual(
      registry.catalog().map((info) => info.name),
      ["unconditional"],
    );
    assert.equal(registry.catalog({ includeConditional: true }).length, 2);
    assert.deepEqual(
      registry.activateForPaths([
        "src/generated/a.ts",
        "../src/a.ts",
        "other.md",
      ]),
      [],
    );
    assert.deepEqual(
      registry.activateForPaths([join(f.project, "src", "a.ts")]),
      ["conditional"],
    );
    assert.equal(registry.catalog().length, 2);
    assert.deepEqual(registry.activateForPaths(["src/a.ts"]), []);
  } finally {
    await f.close();
  }
});

test("hook guards require validation and failure withholds both hooks and automatic grants", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "hooked",
      "---\nallowed-tools: Read\nhooks: {Stop: []}\n---\nbody",
    );
    await f.skill(
      "project",
      "misplaced",
      "---\nallowed-tools: Write\nPreToolUse: [{hooks: [{type: command, command: 'true'}]}]\n---\nbody",
    );
    let registry = await createLocalSkillRegistry(f.options);
    assert.equal(
      registry
        .catalog()
        .every(
          (info) => info.allowedTools.length === 0 && info.hooks === undefined,
        ),
      true,
    );
    registry = await createLocalSkillRegistry({
      ...f.options,
      validateHooks: (hooks) => hooks,
    });
    assert.deepEqual(
      registry.catalog().find((info) => info.name === "hooked")?.allowedTools,
      ["Read"],
    );
    assert.deepEqual(
      registry.catalog().find((info) => info.name === "misplaced")
        ?.allowedTools,
      [],
    );
  } finally {
    await f.close();
  }
});

test("empty top-level hook arrays and metadata guards do not suppress grants, but misnested guards do", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "empty",
      "---\nallowed-tools: Read\nPreToolUse: []\nmetadata: {PermissionRequest: [{hooks: [{type: command, command: 'true'}]}]}\n---\nbody",
    );
    await f.skill(
      "project",
      "nested",
      "---\nallowed-tools: Write\nexperimental: {PreToolUse: [{hooks: [{type: command, command: 'true'}]}]}\n---\nbody",
    );
    const registry = await createLocalSkillRegistry(f.options);
    assert.deepEqual(
      registry.catalog().find((info) => info.name === "empty")?.allowedTools,
      ["Read"],
    );
    assert.deepEqual(
      registry.catalog().find((info) => info.name === "nested")?.allowedTools,
      [],
    );
  } finally {
    await f.close();
  }
});

test("shell blocks require an explicit handler and argument interpolation escapes shell markers", async () => {
  const f = await fixture();
  try {
    await f.skill(
      "project",
      "shell",
      "Current: !`fixture-command`\n$ARGUMENTS",
    );
    const registry = await createLocalSkillRegistry(f.options);
    await assert.rejects(
      registry.invoke("shell", "!`injected`", {
        invocation: "user",
        sessionId: "dummy",
      }),
      /caller-authorized/,
    );
    let calls = 0;
    const result = await registry.invoke("shell", "!`injected`", {
      invocation: "user",
      sessionId: "dummy",
      processShellBlocks: async (text) => {
        calls++;
        assert.match(text, /! `injected`/);
        return text.replace("!`fixture-command`", "fixture-output");
      },
    });
    assert.equal(calls, 1);
    assert.match(result.text, /fixture-output/);
  } finally {
    await f.close();
  }
});

test("permission refusal, cancellation and expansion cap prevent invocation from producing usable context", async () => {
  const f = await fixture();
  try {
    await f.skill("project", "bounded", "$ARGUMENTS $ARGUMENTS $ARGUMENTS");
    const registry = await createLocalSkillRegistry(f.options);
    await assert.rejects(
      registry.invoke("bounded", "x", {
        invocation: "model",
        sessionId: "dummy",
        authorize: () => "fixture deny",
      }),
      /fixture deny/,
    );
    const signal = AbortSignal.abort();
    await assert.rejects(
      registry.invoke("bounded", "x", {
        invocation: "user",
        sessionId: "dummy",
        signal,
      }),
    );
    await assert.rejects(
      registry.invoke("bounded", "x".repeat(1_500_000), {
        invocation: "user",
        sessionId: "dummy",
      }),
      /4,000,000/,
    );
  } finally {
    await f.close();
  }
});

test("caller-admitted nested directories can progressively extend a registry without rescan duplication", async () => {
  const f = await fixture();
  try {
    const registry = await createLocalSkillRegistry(f.options),
      nested = join(f.project, "nested");
    await mkdir(join(nested, ".claude", "skills", "late"), { recursive: true });
    await writeFile(
      join(nested, ".claude", "skills", "late", "SKILL.md"),
      "late body",
    );
    await registry.discover([
      {
        directory: join(nested, ".claude", "skills"),
        source: "projectSettings",
      },
    ]);
    await registry.discover([
      {
        directory: join(nested, ".claude", "skills"),
        source: "projectSettings",
      },
    ]);
    assert.deepEqual(
      registry.catalog().map((info) => info.name),
      ["late"],
    );
    assert.match(
      (
        await registry.invoke("late", undefined, {
          invocation: "model",
          sessionId: "dummy",
        })
      ).text,
      /late body$/,
    );
  } finally {
    await f.close();
  }
});

test("tool-list parsing keeps command spaces/commas inside parentheses and wildcard dominates", () => {
  assert.deepEqual(
    parseSkillToolList(["Read, Bash(git log --format=a,b:*) Write", null]),
    ["Read", "Bash(git log --format=a,b:*)", "Write"],
  );
  assert.deepEqual(parseSkillToolList("Read * Write"), ["*"]);
});
