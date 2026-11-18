import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadLocalPluginCatalog,
  type CatalogPlugin,
  type LocalPluginRoot,
} from "../src/plugin-catalog.js";
import {
  loadPluginComponentDefinitions,
  PLUGIN_DOCUMENT_MAX_BYTES,
  selectOrdinaryPluginPrecedence,
} from "../src/plugin-components.js";

const present = <T>(value: T | undefined): T =>
  value ?? assert.fail("missing value");

async function fixture(manifest: Record<string, unknown> = { name: "owned" }) {
  const workspace = await mkdtemp(join(tmpdir(), "tau-plugin-components-")),
    root = join(workspace, "plugin");
  await mkdir(root);
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const put = async (
    path: string,
    data: string | object = "Owned document",
  ) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof data === "string" ? data : JSON.stringify(data),
    );
  };
  await put(".claude-plugin/plugin.json", manifest);
  const declaration: LocalPluginRoot = {
    root,
    source: "owned@inline",
    scope: "session",
    provenance: { authored: "owned test fixture" },
  };
  const catalog = async () =>
    (await loadLocalPluginCatalog({ roots: [declaration] })).plugins;
  return { workspace, root, put, catalog, declaration };
}
const markdown = (fields: string, body = "Owned test body") =>
  `---\n${fields}\n---\n${body}`;

test("recursive plugin command namespaces and SKILL.md dominance preserve authored bodies without execution", async () => {
  const f = await fixture();
  await f.put("commands/outer/normal.md", "Owned regular");
  await f.put(
    "commands/outer/skill/SKILL.md",
    markdown(
      "name: display\ndescription: Owned skill",
      "Owned $ARGUMENTS ${CLAUDE_PLUGIN_ROOT}",
    ),
  );
  await f.put("commands/outer/skill/ignored.md", "Owned ignored markdown");
  await f.put("commands/outer/skill/deep/ignored.md", "Owned ignored child");
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
  });
  assert.deepEqual(
    result.prompts.map((d) => [d.info.name, d.isSkillMode, d.isSkillFile]),
    [
      ["owned:outer:normal", false, false],
      ["owned:outer:skill", false, true],
    ],
  );
  assert.equal(
    present(result.prompts[1]).body,
    "Owned $ARGUMENTS ${CLAUDE_PLUGIN_ROOT}",
  );
  assert.equal(
    present(result.prompts[1]).info.displayName,
    "owned:outer:display",
  );
  assert.deepEqual(present(result.prompts[1]).info.pluginSource.provenance, {
    authored: "owned test fixture",
  });
  assert.ok(Object.isFrozen(present(result.prompts[1]).info));
  assert.ok(Object.isFrozen(present(result.prompts[1]).frontmatter));
  assert.deepEqual(result.diagnostics, []);
});

test("manifest named source/inline command overrides win over frontmatter in the source order", async () => {
  const f = await fixture({
    name: "owned",
    commands: {
      named: {
        source: "./custom.md",
        description: "Manifest description",
        argumentHint: "[owned]",
        model: "sonnet",
        allowedTools: ["Read"],
      },
      inline: {
        content: markdown(
          "description: Body description\nallowed-tools: Bash",
          "Owned inline body",
        ),
        description: "Inline manifest description",
        allowedTools: ["Edit"],
      },
    },
  });
  await f.put(
    "custom.md",
    markdown(
      "description: Frontmatter description\nargument-hint: '[old]'\nmodel: haiku\nallowed-tools: Bash\ndisallowed-tools: Write",
      "Owned source body",
    ),
  );
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
    normalizeModel: (name) => "mapped-" + name,
  });
  assert.deepEqual(
    result.prompts.map((d) => [
      d.info.name,
      d.info.description,
      d.info.allowedTools,
    ]),
    [
      ["owned:named", "Manifest description", ["Read"]],
      ["owned:inline", "Inline manifest description", ["Edit"]],
    ],
  );
  assert.equal(present(result.prompts[0]).info.argumentHint, "[owned]");
  assert.equal(present(result.prompts[0]).info.model, "mapped-sonnet");
  assert.deepEqual(present(result.prompts[0]).info.disallowedTools, ["Write"]);
  assert.equal(present(result.prompts[1]).info.baseDir, f.root);
});

test("direct skill names use declared name while a skill container uses sanitized child directory identity", async () => {
  const f = await fixture({ name: "owned", skills: ["./direct"] });
  await f.put(
    "direct/SKILL.md",
    markdown(
      "name: 'owned:direct declared'\nuser-invocable: off\ndisable-model-invocation: 1",
      "Owned direct",
    ),
  );
  await f.put(
    "skills/child space/SKILL.md",
    markdown("name: frontmatter-display", "Owned child"),
  );
  await f.put(
    "skills/child space/deeper/SKILL.md",
    "Owned unscanned grandchild",
  );
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
  });
  assert.deepEqual(
    result.prompts.map((d) => d.info.name),
    ["owned:child-space", "owned:direct-declared"],
  );
  assert.equal(
    present(result.prompts[0]).info.displayName,
    "owned:frontmatter-display",
  );
  assert.equal(present(result.prompts[1]).info.userInvocable, false);
  assert.equal(present(result.prompts[1]).info.disableModelInvocation, true);
  assert.equal(result.prompts.length, 2);
});

test("plugin agent parsing preserves plugin namespace and metadata while ignoring stronger ordinary-agent fields", async () => {
  const f = await fixture();
  await f.put(
    "agents/group/a.md",
    markdown(
      "name: Named\ndescription: Owned plugin agent\ntools: Read\ndisallowedTools: Bash\nskills: owned:helper\nmodel: ' Opus '\neffort: high\nmaxTurns: 4\nautoCompactWindow: 150000\nmemory: project\nbackground: 'true'\nomitClaudeMd: true\nisolation: remote\npermissionMode: bypassPermissions\nhooks: {PreToolUse: []}\nmcpServers: [owned]\ninitialPrompt: ignored\nobserver: ignored\nexperimental: {cache-ttl: 1h}",
      "Owned agent body ${CLAUDE_PLUGIN_ROOT}",
    ),
  );
  await f.put("agents/unnamed.md", "Owned unnamed body");
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
    memoryEnabled: true,
    normalizeModel: () => "should-not-map-agent",
  });
  assert.deepEqual(
    result.agents.map((d) => d.agentType),
    ["owned:group:Named", "owned:unnamed"],
  );
  const a = present(result.agents[0]);
  assert.deepEqual(a.tools, ["Read", "Write", "Edit"]);
  assert.deepEqual(a.disallowedTools, ["Bash"]);
  assert.deepEqual(a.skills, ["owned:helper"]);
  assert.equal(a.model, "Opus");
  assert.equal(a.maxTurns, 4);
  assert.equal(a.autoCompactWindow, 150000);
  assert.equal(a.cacheTtl, "1h");
  assert.equal(a.background, true);
  assert.equal(a.omitClaudeMd, true);
  assert.equal(a.isolation, undefined);
  assert.equal(a.permissionMode, undefined);
  assert.equal(a.hooks, undefined);
  assert.equal(a.mcpServers, undefined);
  assert.equal(a.initialPrompt, undefined);
  assert.equal(a.prompt, "Owned agent body ${CLAUDE_PLUGIN_ROOT}");
  assert.equal(
    result.diagnostics.filter((d) => d.reason === "ignored-plugin-agent-field")
      .length,
    5,
  );
});

test("plugin agent optional leaf names coerce scalars and bound the leaf rather than the composed namespace", async () => {
  const f = await fixture();
  await f.put("agents/a.md", markdown("name: 42", "Owned scalar name"));
  await f.put(
    "agents/b.md",
    markdown("name: " + "b".repeat(256), "Owned maximum leaf"),
  );
  await f.put(
    "agents/c.md",
    markdown("name: " + "c".repeat(257), "Owned fallback leaf"),
  );
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
  });
  assert.deepEqual(
    result.agents.map((a) => a.agentType),
    ["owned:42", "owned:" + "b".repeat(256), "owned:c"],
  );
});

test("invalid skill hooks strip hooks and grants together while retaining body and declared denies", async () => {
  const f = await fixture();
  await f.put(
    "skills/a/SKILL.md",
    markdown(
      "allowed-tools: Write\ndisallowed-tools: Bash\nhooks: {PreToolUse: [{hooks: [{type: unknown}]}]}",
      "Owned surviving body",
    ),
  );
  const plugins = await f.catalog(),
    result = await loadPluginComponentDefinitions({
      plugins,
      validateHooks: () => {
        throw new Error("Owned invalid guard");
      },
    });
  assert.equal(present(result.prompts[0]).body, "Owned surviving body");
  assert.deepEqual(present(result.prompts[0]).info.allowedTools, []);
  assert.deepEqual(present(result.prompts[0]).info.disallowedTools, ["Bash"]);
  assert.equal(present(result.prompts[0]).info.hooks, undefined);
  const refused = await loadPluginComponentDefinitions({
    plugins,
    rejectInvalidHooks: true,
  });
  assert.deepEqual(refused.prompts, []);
});

test("legacy command hooks cannot gain skill hooks; guarded legacy hooks lose grants while SKILL commands validate", async () => {
  const f = await fixture();
  await f.put(
    "commands/legacy.md",
    markdown("allowed-tools: Read\nhooks: {Stop: []}", "Owned legacy"),
  );
  await f.put(
    "commands/guarded.md",
    markdown(
      "allowed-tools: Write\ndisallowedTools: Edit\nhooks: {PreToolUse: [{hooks: [{type: command, command: owned}]}]}",
      "Owned guarded",
    ),
  );
  await f.put(
    "commands/skill/SKILL.md",
    markdown("allowed-tools: Read\nhooks: {Stop: []}", "Owned skill command"),
  );
  let validations = 0;
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
    validateHooks: (value) => {
      validations++;
      return value;
    },
  });
  const legacy = present(
      result.prompts.find((d) => d.info.name === "owned:legacy"),
    ),
    guarded = present(
      result.prompts.find((d) => d.info.name === "owned:guarded"),
    ),
    skill = present(result.prompts.find((d) => d.info.name === "owned:skill"));
  assert.deepEqual(legacy.info.allowedTools, ["Read"]);
  assert.equal(legacy.info.hooks, undefined);
  assert.deepEqual(guarded.info.allowedTools, []);
  assert.deepEqual(guarded.info.disallowedTools, ["Edit"]);
  assert.deepEqual(skill.info.hooks, { Stop: [] });
  assert.equal(validations, 1);
});

test("descendant confinement excludes exterior links, recursive command links and reserved cache aliases", async () => {
  const f = await fixture();
  await f.put("commands/a.md", "Owned command");
  await f.put("skills/good/SKILL.md", "Owned skill");
  await f.put(".mcpb-cache/skill/SKILL.md", "Owned excluded cache");
  await f.put("commands/.MCPB-CACHE./bad.md", "Owned excluded cache command");
  const outside = join(f.workspace, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "SKILL.md"), "Owned exterior");
  await symlink(outside, join(f.root, "skills/outside"));
  await symlink(
    join(f.root, ".mcpb-cache/skill"),
    join(f.root, "skills/cache-alias"),
  );
  await symlink(join(f.root, "skills/good"), join(f.root, "commands/linked"));
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
  });
  assert.deepEqual(
    result.prompts.map((d) => d.info.name),
    ["owned:a", "owned:good"],
  );
  assert.equal(
    result.diagnostics.filter((d) => d.reason === "policy").length,
    2,
  );
});

test("post-catalog component swaps are refused before reading changed roots", async () => {
  const f = await fixture();
  await f.put("commands/a.md", "Owned before swap");
  const plugins = await f.catalog();
  const outside = join(f.workspace, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "a.md"), "Owned after swap");
  await rename(join(f.root, "commands"), join(f.root, "original-commands"));
  await symlink(outside, join(f.root, "commands"));
  const result = await loadPluginComponentDefinitions({ plugins });
  assert.deepEqual(result.prompts, []);
  assert.ok(result.diagnostics.some((d) => d.reason === "path-changed"));
});

test("ordinary admitted inline plugins override exact installed names and installed names override skills-dir", async () => {
  const f = await fixture();
  const base = present((await f.catalog())[0]);
  const installed: CatalogPlugin = {
      ...base,
      source: "owned@market",
      scope: "user",
    },
    skills: CatalogPlugin = {
      ...base,
      source: "owned@skills-dir",
      scope: "user",
    };
  assert.deepEqual(
    selectOrdinaryPluginPrecedence([installed, skills, base]).map(
      (p) => p.source,
    ),
    ["owned@inline"],
  );
  assert.deepEqual(
    selectOrdinaryPluginPrecedence([
      installed,
      skills,
      { ...base, enabled: false },
    ]).map((p) => p.source),
    ["owned@market"],
  );
  assert.deepEqual(
    selectOrdinaryPluginPrecedence([{ ...installed, name: "Owned" }, base]).map(
      (p) => p.source,
    ),
    ["owned@market", "owned@inline"],
  );
});

test("read bounds, malformed deny lists and host admission remain effective without executing source", async () => {
  const f = await fixture();
  await f.put("commands/large.md", "x".repeat(PLUGIN_DOCUMENT_MAX_BYTES + 1));
  await f.put(
    "commands/invalid.md",
    markdown("disallowed-tools: [Read, 1]", "Owned invalid deny"),
  );
  await f.put("commands/valid.md", "Owned host-rejected");
  const result = await loadPluginComponentDefinitions({
    plugins: await f.catalog(),
    admitDefinition: () => "Owned host refusal",
  });
  assert.deepEqual(result.prompts, []);
  assert.ok(result.diagnostics.some((d) => d.reason === "oversize"));
  assert.ok(result.diagnostics.some((d) => d.reason === "disallowed-tools"));
  assert.ok(result.diagnostics.some((d) => d.reason === "withheld"));
});

test("cancellation during host file policy rejects the registration snapshot", async () => {
  const f = await fixture();
  await f.put("commands/a.md", "Owned cancellation");
  const controller = new AbortController();
  await assert.rejects(
    loadPluginComponentDefinitions({
      plugins: await f.catalog(),
      signal: controller.signal,
      readPolicy: () => {
        controller.abort(new Error("Owned registration abort"));
        return true;
      },
    }),
    /Owned registration abort/,
  );
});
