import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AGENT_DEFINITION_MAX_BYTES, agentDefinitionLocations, createLocalAgentRegistry, type AgentDefinitionLocation, type LocalAgentDefinition } from "../src/agent-definitions.js";

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-agent-definitions-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const locations = agentDefinitionLocations({ managedRoot: join(root, "managed"), userConfigDir: join(root, "user"),
    projectDirectories: [join(root, "project", "nested"), join(root, "project")], additionalDirectories: [join(root, "additional")] });
  const put = async (directory: string, file: string, fields: string, body = "Owned independently written instructions.") => {
    const path = join(directory, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `---\n${fields}\n---\n${body}\n`); return path;
  };
  const location = (source: AgentDefinitionLocation["source"], additional = false, nested = false) => locations.find(l => l.source === source && !!l.fromAdditionalDirectory === additional && (source !== "projectSettings" || l.directory.includes("nested") === nested))!;
  return { root, locations, put, location };
}
const supplied = (source: LocalAgentDefinition["source"], name = "review"): LocalAgentDefinition => ({ source, agentType: name, whenToUse: "Owned fixture", prompt: source + " owned prompt", skills: [] });

test("local agent precedence keeps complete definitions and exposes progressive metadata without prompt bodies", async t => {
  const f = await fixture(t);
  for (const [index, l] of f.locations.entries()) await f.put(l.directory, "review.md", "name: review\ndescription: Own review", `owned body ${index}`);
  const registry = await createLocalAgentRegistry({ locations: f.locations, definitions: [supplied("built-in"), supplied("plugin"), supplied("flagSettings")] });
  assert.equal(registry.allDefinitions.length, 8);
  assert.equal((await registry.resolve("review"))!.source, "policySettings");
  assert.equal(await registry.prompt("review"), "owned body 0");
  const catalog = await registry.catalog(); assert.equal(catalog.length, 1); assert.equal("prompt" in catalog[0]!, false);
  const withoutPolicy = await createLocalAgentRegistry({ locations: f.locations, sources: { policy: false }, definitions: [supplied("built-in"), supplied("plugin"), supplied("flagSettings")] });
  assert.equal((await withoutPolicy.resolve("review"))!.source, "flagSettings");
  const local = await createLocalAgentRegistry({ locations: [...f.locations].reverse(), sources: { policy: false } });
  assert.equal((await local.resolve("review"))!.baseDir, f.location("projectSettings", false, true).directory);
});

test("required identity uses literal agent names, exact case and NFKC namespace guard without invented filename aliases", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  for (const [index, name] of ["-bad", "plugin:name", "wide：colon", "a".repeat(257)].entries()) await f.put(location.directory, `bad${index}.md`, `name: ${name}\ndescription: invalid`);
  await f.put(location.directory, "filename.md", 'name: Review\ndescription: "Review\\\\ncarefully"', "  Owned prompt.  ");
  await f.put(location.directory, "lower.md", "name: review\ndescription: lowercase");
  await f.put(location.directory, "missing.md", "name: missing");
  const registry = await createLocalAgentRegistry({ locations: [location] });
  assert.equal(registry.activeDefinitions.length, 2);
  assert.equal(await registry.resolve("filename"), undefined); assert.equal(await registry.resolve("REVIEW"), undefined);
  assert.equal((await registry.resolve("Review"))!.whenToUse, "Review\ncarefully");
  assert.equal(await registry.prompt("Review"), "Owned prompt.");
  assert.equal(registry.diagnostics.filter(d => d.reason === "name").length, 4);
});

test("frontmatter retains declared runtime metadata, input-mode normalization and ignores unsupported fields", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  await f.put(location.directory, "metadata.md", `name: metadata\ndescription: Own metadata\nmodel: " INHERIT "\neffort: 17\npermissionMode: manual\nmaxTurns: "12suffix"\nautoCompactWindow: "100_000"\nexperimental:\n  cache-ttl: 1h\nskills: "owned-first, owned-second"\nbackground: "true"\nomitClaudeMd: true\nmemory: local\nisolation: remote\ncolor: purple\ninitialPrompt: "  own first message  "\nobserver: " own-observer "\nobserverMessage: "  owned observer body "\nobserveSubagents: "false"\ncontext: fork\ndisable-model-invocation: true`);
  const registry = await createLocalAgentRegistry({ locations: [location] }), agent = (await registry.resolve("metadata"))!;
  assert.equal(agent.model, "inherit"); assert.equal(agent.permissionMode, "default"); assert.equal(agent.effort, 17);
  assert.equal(agent.maxTurns, 12); assert.equal(agent.autoCompactWindow, 100000); assert.equal(agent.cacheTtl, "1h");
  assert.deepEqual(agent.skills, ["owned-first", "owned-second"]); assert.equal(agent.memory, "local"); assert.equal(agent.isolation, "remote");
  assert.equal(agent.background, true); assert.equal(agent.omitClaudeMd, true); assert.equal(agent.observeSubagents, false);
  assert.equal(agent.observer, "own-observer"); assert.equal(agent.initialPrompt, "  own first message  ");
  assert.equal("context" in agent, false); assert.equal("disableModelInvocation" in agent, false);
  const catalog = (await registry.catalog())[0]!; assert.equal("initialPrompt" in catalog, false); assert.equal("observerMessage" in catalog, false);
  assert.ok(Object.isFrozen(agent)); assert.ok(Object.isFrozen(agent.skills));
});

test("tools preserve parenthesized grammar and wildcard inheritance; memory tool extension requires host feature admission", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  await f.put(location.directory, "bounded.md", 'name: bounded\ndescription: bounded\ntools: "Read, Bash(git log:*), Write"\ndisallowedTools: "Bash(rm *) Edit"\nmemory: user');
  await f.put(location.directory, "inherit.md", 'name: inherited\ndescription: inherited\ntools: [Read, "*"]\ndisallowedTools: ["*"]');
  await f.put(location.directory, "empty.md", 'name: empty\ndescription: empty\ntools: null\nmemory: project');
  const off = await createLocalAgentRegistry({ locations: [location] });
  assert.deepEqual((await off.resolve("bounded"))!.tools, ["Read", "Bash(git log:*)", "Write"]);
  assert.deepEqual((await off.resolve("bounded"))!.disallowedTools, ["Bash(rm *)", "Edit"]);
  assert.equal((await off.resolve("inherited"))!.tools, undefined); assert.equal((await off.resolve("inherited"))!.disallowedTools, undefined);
  assert.deepEqual((await off.resolve("empty"))!.tools, []);
  const on = await createLocalAgentRegistry({ locations: [location], memoryEnabled: true });
  assert.deepEqual((await on.resolve("empty"))!.tools, ["Write", "Edit", "Read"]);
  assert.deepEqual((await on.resolve("bounded"))!.tools, ["Read", "Bash(git log:*)", "Write", "Edit"]);
  let calls = 0;
  assert.equal(await on.prompt("empty", { memoryContext: agent => { calls++; assert.equal(agent.memory, "project"); return "Owned memory policy"; } }), "Owned independently written instructions.\n\nOwned memory policy");
  await off.prompt("empty", { memoryContext: () => { throw new Error("must not read memory"); } }); assert.equal(calls, 1);
});

test("eligibility applies after winner selection and source trust prevents loading before parse", async t => {
  const f = await fixture(t), user = f.location("userSettings"), project = f.location("projectSettings");
  await f.put(user.directory, "chosen.md", "name: chosen\ndescription: own user", "user prompt");
  await f.put(project.directory, "chosen.md", "name: chosen\ndescription: own project", "project prompt");
  const offered = await createLocalAgentRegistry({ locations: [user, project], eligible: (agent, context) => agent.source !== "projectSettings" || context === "admitted" });
  assert.equal(await offered.resolve("chosen"), undefined); assert.deepEqual(await offered.catalog(), []);
  assert.equal(await offered.prompt("chosen", { context: "admitted" }), "project prompt");
  const trusted = await createLocalAgentRegistry({ locations: [user, project], admitSource: location => location.source !== "projectSettings" || "owned trust restriction" });
  assert.equal(await trusted.prompt("chosen"), "user prompt"); assert.equal(trusted.diagnostics[0]!.reason, "source");
});

test("recursive scans dedupe hardlinks, stop directory cycles and preserve canonical path metadata", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  const path = await f.put(location.directory, "a.md", "name: linked\ndescription: owned linked");
  await link(path, join(location.directory, "b.md")); await symlink(location.directory, join(location.directory, "cycle"));
  await f.put(location.directory, "nested/other.md", "name: nested\ndescription: owned nested");
  await f.put(location.directory, "IGNORE.MD", "name: upper\ndescription: not ordinary lowercase scan");
  const registry = await createLocalAgentRegistry({ locations: [location] });
  assert.equal(registry.activeDefinitions.length, 2); assert.equal((await registry.resolve("linked"))!.canonicalPath, path);
  assert.equal(registry.diagnostics.filter(d => d.reason === "duplicate-file").length, 1);
});

test("additional canonical roots already present in ordinary project sources retain ordinary provenance", async t => {
  const f = await fixture(t), project = f.location("projectSettings");
  await f.put(project.directory, "owned.md", "name: owned\ndescription: owned");
  const alias = join(f.root, "project-alias"); await symlink(project.directory, alias);
  const registry = await createLocalAgentRegistry({ locations: [{ directory: alias, source: "projectSettings", fromAdditionalDirectory: true }, project] });
  assert.equal(registry.allDefinitions.length, 1); assert.equal((await registry.resolve("owned"))!.fromAdditionalDirectory, undefined);
});

test("bounded reads, external link policy and explicit admission protect the registry resource boundary", async t => {
  const f = await fixture(t), location = f.location("userSettings"), outside = join(f.root, "outside");
  const external = await f.put(outside, "external.md", "name: external\ndescription: owned external");
  await mkdir(location.directory, { recursive: true }); await symlink(external, join(location.directory, "external.md"));
  await f.put(location.directory, "large.md", "name: large\ndescription: large", "x".repeat(AGENT_DEFINITION_MAX_BYTES));
  const bounded = await createLocalAgentRegistry({ locations: [location] }); assert.equal(bounded.activeDefinitions.length, 0);
  assert.ok(bounded.diagnostics.some(d => d.reason === "policy")); assert.ok(bounded.diagnostics.some(d => d.reason === "oversize"));
  const admitted = await createLocalAgentRegistry({ locations: [location], allowExternalLinks: true, readPolicy: (_path, canonical) => canonical !== external || "fixture callback denies" });
  assert.equal(await admitted.resolve("external"), undefined);
  const allowed = await createLocalAgentRegistry({ locations: [location], allowExternalLinks: true }); assert.equal((await allowed.resolve("external"))!.canonicalPath, external);
  await assert.rejects(createLocalAgentRegistry({ locations: [{ directory: "relative", source: "userSettings" }] }), /absolute/);
});

test("malformed hooks or misplaced guards withhold an agent; inline MCP stays a host validation seam", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  await f.put(location.directory, "guard.md", "name: guard\ndescription: guard\nPreToolUse: [{hooks: []}]");
  await f.put(location.directory, "hooks.md", "name: hooks\ndescription: hooks\nhooks: {Stop: []}\nmcpServers: [owned-name, {owned-inline: {type: stdio, command: owned-fixture}}, 12]");
  const noHost = await createLocalAgentRegistry({ locations: [location] }); assert.equal(noHost.activeDefinitions.length, 0);
  let hooks = 0, servers = 0;
  const admitted = await createLocalAgentRegistry({ locations: [location], validateHooks(value) { hooks++; return value; }, validateInlineMcp(value) { servers++; return value; } });
  assert.equal(admitted.activeDefinitions.length, 1); assert.equal(hooks, 1); assert.equal(servers, 1);
  const catalog = (await admitted.catalog())[0]!; assert.equal(catalog.hasHooks, true); assert.equal(catalog.mcpServerCount, 2);
  assert.equal("hooks" in catalog, false); assert.equal("mcpServers" in catalog, false);
  assert.ok(admitted.diagnostics.some(d => d.reason === "mcpServers"));
});

test("invalid optional scalars are ignored without erasing valid declaration data", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  await f.put(location.directory, "invalid.md", 'name: invalid\ndescription: valid\nmodel: " sonnet "\neffort: nonsense\npermissionMode: imaginary\nmaxTurns: 0\nautoCompactWindow: 99999\nmemory: elsewhere\nisolation: fork\nbackground: yes\ncolor: invented');
  const registry = await createLocalAgentRegistry({ locations: [location] }), definition = (await registry.resolve("invalid"))!;
  assert.equal(definition.model, "sonnet");
  for (const key of ["effort", "permissionMode", "maxTurns", "autoCompactWindow", "memory", "isolation", "background", "color"]) assert.equal(key in definition, false);
  assert.ok(registry.diagnostics.length >= 6);
  await f.put(location.directory, "array-memory.md", 'name: array-memory\ndescription: valid\nmemory: [user]\ntools: []');
  const arrays = await createLocalAgentRegistry({ locations: [location], memoryEnabled: true });
  assert.equal((await arrays.resolve("array-memory"))!.memory, undefined); assert.deepEqual((await arrays.resolve("array-memory"))!.tools, []);
});

test("numeric scalar repairs preserve scientific/grouped forms and source integer fallback", async t => {
  const f = await fixture(t), location = f.location("userSettings");
  await f.put(location.directory, "scientific.md", 'name: scientific\ndescription: scientific\nmaxTurns: "0.5e1"\nautoCompactWindow: "1e6"');
  await f.put(location.directory, "grouped.md", 'name: grouped\ndescription: grouped\nmaxTurns: "1_000"\nautoCompactWindow: "100,000"');
  await f.put(location.directory, "prefix.md", 'name: prefix\ndescription: prefix\nmaxTurns: "1__2"\nautoCompactWindow: "100001suffix"');
  const registry = await createLocalAgentRegistry({ locations: [location] });
  assert.equal((await registry.resolve("scientific"))!.maxTurns, 5); assert.equal((await registry.resolve("scientific"))!.autoCompactWindow, 1000000);
  assert.equal((await registry.resolve("grouped"))!.maxTurns, 1000); assert.equal((await registry.resolve("grouped"))!.autoCompactWindow, 100000);
  assert.equal((await registry.resolve("prefix"))!.maxTurns, 1); assert.equal((await registry.resolve("prefix"))!.autoCompactWindow, 100001);
});
