import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isPluginCacheDescendant, loadLocalPluginCatalog, resolveLocalPluginEnabled, type LocalPluginRoot } from "../src/plugin-catalog.js";

async function fixture(t: test.TestContext, manifest?: unknown) {
  const workspace = await mkdtemp(join(tmpdir(), "tau-plugin-catalog-")), root = join(workspace, "plugin");
  await mkdir(root);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const put = async (path: string, data: string | object = "owned") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof data === "string" ? data : JSON.stringify(data));
  };
  if (manifest !== undefined) await put(".claude-plugin/plugin.json", JSON.stringify(manifest));
  const declaration: LocalPluginRoot = { root, source: "owned@inline", scope: "session", provenance: { supplied: "owned fixture" } };
  return { root, workspace, put, declaration };
}
const guard = { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "printf owned" }] }] };

test("catalog refuses lexical and symlinked MCP extraction cache components using source segment folding", async t => {
  const f = await fixture(t, { name: "owned", commands: ["./.MCPB-CACHE. /hidden.md", "./commands/link.md", "./safe.md"] });
  await f.put(".MCPB-CACHE. /hidden.md"); await f.put(".mcpb-cache/target.md"); await f.put("safe.md");
  await mkdir(join(f.root, "commands")); await symlink(join(f.root, ".mcpb-cache/target.md"), join(f.root, "commands/link.md"));
  const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
  assert.deepEqual(result.plugins[0]!.components.map(component => component.path), [join(f.root, "safe.md")]);
  assert.equal(result.diagnostics.filter(issue => issue.code === "path-escape").length, 2);
  assert.equal(isPluginCacheDescendant(f.root, join(f.root, ".mcpb-\u200dcache", "file.md")), true);
  assert.equal(isPluginCacheDescendant(join(f.root, ".mcpb-cache"), join(f.root, ".mcpb-cache", "file.md")), false);
  assert.equal(isPluginCacheDescendant(f.root, join(f.root, ".mcpb-cache-extra", "file.md")), false);
});

test("explicit roots support manifestless directory and root skill fallback without searching other roots", async t => {
  const f = await fixture(t); await f.put("SKILL.md", "Owned fixture instructions");
  const result = await loadLocalPluginCatalog({ roots: [{ ...f.declaration, fallbackName: "owned" }] });
  assert.equal(result.plugins.length, 1); const p = result.plugins[0]!;
  assert.equal(p.name, "owned"); assert.equal(p.manifestPath, undefined); assert.equal(p.source, "owned@inline");
  assert.deepEqual(p.provenance, { supplied: "owned fixture" });
  assert.deepEqual(p.components.map(c => [c.kind, c.origin, c.path]), [["skills", "root-skill", f.root]]);
  assert.deepEqual(result.diagnostics, []);
});

test("manifest declarations replace commands/agents defaults while skills are supplemental", async t => {
  const f = await fixture(t, { name: "owned", commands: "./custom.md", agents: ["./alternate.md"], skills: ["./extra", "./skills"] });
  await f.put("commands/default.md"); await f.put("agents/default.md"); await f.put("custom.md"); await f.put("alternate.md");
  await f.put("skills/a/SKILL.md"); await f.put("extra/SKILL.md");
  const { plugins, diagnostics } = await loadLocalPluginCatalog({ roots: [f.declaration] });
  assert.deepEqual(plugins[0]!.components.map(c => [c.kind, c.path]), [
    ["commands", join(f.root, "custom.md")], ["agents", join(f.root, "alternate.md")], ["skills", join(f.root, "skills")], ["skills", join(f.root, "extra")],
  ]); assert.deepEqual(diagnostics, []);
});

test("inline named commands preserve metadata and source names; no vendor content is loaded", async t => {
  const f = await fixture(t, { name: "owned", commands: { inline: { content: "Owned command", allowedTools: ["Read"] }, source: { source: "./a.md", description: "Owned metadata" } } });
  await f.put("a.md", "Owned file");
  const p = (await loadLocalPluginCatalog({ roots: [f.declaration] })).plugins[0]!;
  assert.deepEqual(p.components.map(c => [c.commandName, c.metadata]), [["inline", { content: "Owned command", allowedTools: ["Read"] }], ["source", { source: "./a.md", description: "Owned metadata" }]]);
  assert.equal(p.components[0]!.path, undefined);
});

test("default hooks/MCP/LSP precede additive paths and inline declarations; hook file aliases dedupe", async t => {
  const f = await fixture(t, { name: "owned", hooks: ["./hooks/hooks.json", "./alias.json", "./extra-hooks.json", { Stop: [] }],
    mcpServers: ["./extra-mcp.json", { extra: { command: "owned-server" } }], lspServers: ["./extra-lsp.json", { extra: { command: "owned-lsp" } }] });
  await f.put("hooks/hooks.json", { hooks: guard }); await symlink(join(f.root, "hooks/hooks.json"), join(f.root, "alias.json"));
  await f.put("extra-hooks.json", { hooks: { Stop: [] } });
  await f.put(".mcp.json", { mcpServers: { owned: { command: "owned-default" } } }); await f.put("extra-mcp.json", { custom: { command: "owned-extra" } });
  await f.put(".lsp.json", { owned: { command: "owned-default", extensionToLanguage: { ".x": "x" } } }); await f.put("extra-lsp.json", { custom: { command: "owned-extra" } });
  const result = await loadLocalPluginCatalog({ roots: [f.declaration] }), components = result.plugins[0]!.components;
  for (const kind of ["hooks", "mcp", "lsp"]) assert.deepEqual(components.filter(c => c.kind === kind).map(c => c.origin), ["default", "manifest", "manifest"]);
  assert.deepEqual(components.find(c => c.kind === "hooks")!.config, guard);
  assert.equal(result.diagnostics.length, 0);
});

test("enable precedence is host ordered and preserves scope/provenance and disabled metadata", async t => {
  const f = await fixture(t, { name: "owned", defaultEnabled: false }); await f.put("skills/a/SKILL.md");
  const root = { ...f.declaration, scope: "project" as const, projectPath: f.workspace };
  const layers = [{ source: "policySettings", managed: true, enabledPlugins: { "OWNED@inline": false } }, { source: "localSettings", enabledPlugins: { "owned@inline": true } }];
  const disabled = (await loadLocalPluginCatalog({ roots: [root], enableLayers: layers })).plugins[0]!;
  assert.equal(disabled.enabled, false); assert.deepEqual(disabled.components, []); assert.equal(disabled.projectPath, f.workspace);
  assert.deepEqual(disabled.enableDecision, { enabled: false, source: "policySettings", key: "OWNED@inline", managed: true });
  const enabled = (await loadLocalPluginCatalog({ roots: [root], enableLayers: layers.toReversed() })).plugins[0]!;
  assert.equal(enabled.enabled, true); assert.equal(enabled.components.length, 1);
  assert.equal(resolveLocalPluginEnabled(f.declaration, { defaultEnabled: false }).enabled, false);
});

test("ordinary marketplace settings stay exact; folded inline collisions deny and synced follows inline deny", () => {
  const base: LocalPluginRoot = { root: "/owned", source: "Owned@market", scope: "user" };
  assert.equal(resolveLocalPluginEnabled(base, {}, [{ source: "user", enabledPlugins: { "owned@market": false } }]).enabled, true);
  assert.equal(resolveLocalPluginEnabled({ ...base, source: "Owned@inline" }, {}, [{ source: "user", enabledPlugins: { "owned@inline": true, "Owned@inline": false } }]).enabled, false);
  assert.equal(resolveLocalPluginEnabled({ ...base, source: "Owned@synced" }, {}, [{ source: "user", enabledPlugins: { "owned@inline": false } }]).enabled, false);
});

test("manifest schema and namespace failures reject plugins with no admitted components", async t => {
  const f = await fixture(t); await f.put("skills/a/SKILL.md");
  for (const manifest of [{ name: "owned@bad" }, { name: "bad\u200fname" }, { name: "owned", skills: "skills" }, { name: "owned", agents: "./agents" },
    { name: "owned", commands: { a: { source: "./a.md", content: "ambiguous" } } }, { name: "owned", PreToolUse: guard.PreToolUse }]) {
    await f.put(".claude-plugin/plugin.json", manifest);
    const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
    assert.deepEqual(result.plugins, [], JSON.stringify(manifest)); assert.equal(result.diagnostics.length, 1);
  }
  await f.put(".claude-plugin/plugin.json", "{invalid");
  assert.deepEqual((await loadLocalPluginCatalog({ roots: [f.declaration] })).plugins, []);
});

test("lexical traversal, component symlink and manifest symlink escapes are refused", async t => {
  const f = await fixture(t, { name: "owned", commands: ["./../outside.md", "./escape.md", "./okay.md"] });
  await writeFile(join(f.workspace, "outside.md"), "Owned exterior"); await symlink(join(f.workspace, "outside.md"), join(f.root, "escape.md")); await f.put("okay.md");
  const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
  assert.deepEqual(result.plugins[0]!.components.map(c => c.path), [join(f.root, "okay.md")]);
  assert.equal(result.diagnostics.filter(d => d.code === "path-escape").length, 2);
  await rm(join(f.root, ".claude-plugin/plugin.json"));
  await writeFile(join(f.workspace, "external.json"), JSON.stringify({ name: "exterior" }));
  await symlink(join(f.workspace, "external.json"), join(f.root, ".claude-plugin/plugin.json"));
  assert.deepEqual((await loadLocalPluginCatalog({ roots: [f.declaration] })).plugins, []);
});

test("invalid or host rejected protected guards reject the whole plugin transaction", async t => {
  const f = await fixture(t, { name: "owned" }); await f.put("commands/a.md");
  for (const hooks of [{ PreToolUse: { hooks: [] } }, { PreToolUse: [{ hooks: [{ type: "unknown" }] }] }, { PreToolUse: [{ hooks: [{ type: "command" }] }] },
    { matcher: "Write", hooks: [{ type: "command", command: "printf owned" }] }, { Unknown: guard.PreToolUse }]) {
    await f.put("hooks/hooks.json", { hooks });
    const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
    assert.deepEqual(result.plugins, []); assert.ok(result.diagnostics.some(d => d.code === "plugin-rejected"));
  }
  await f.put("hooks/hooks.json", { hooks: guard });
  const result = await loadLocalPluginCatalog({ roots: [f.declaration], admitComponent: component => component.kind !== "hooks" });
  assert.deepEqual(result.plugins, []);
});

test("duplicate additional hook files diagnose once while preserving group source order", async t => {
  const f = await fixture(t, { name: "owned", hooks: ["./extra.json", "./extra.json", { Stop: [{ hooks: [{ type: "command", command: "printf later" }] }] }] });
  await f.put("extra.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "printf earlier" }] }] } });
  const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
  assert.equal(result.plugins[0]!.components.length, 2);
  assert.equal(result.diagnostics.filter(d => d.code === "duplicate-hooks").length, 1);
  assert.deepEqual(result.plugins[0]!.components.map(c => c.config?.Stop), [
    [{ hooks: [{ type: "command", command: "printf earlier" }] }], [{ hooks: [{ type: "command", command: "printf later" }] }],
  ]);
});

test("host policy gates complete plugins and individual components without performing lifecycle actions", async t => {
  const priorOwned = process.env.OWNED;
  const f = await fixture(t, { name: "owned", settings: { env: { OWNED: "untouched" } }, dependencies: ["missing@owned"], hooks: { Stop: [] } });
  await f.put("commands/a.md"); await f.put("skills/a/SKILL.md");
  let components = 0;
  const rejected = await loadLocalPluginCatalog({ roots: [f.declaration], admitPlugin: () => "Workspace trust pending", admitComponent: () => { components++; return true; } });
  assert.deepEqual(rejected.plugins, []); assert.equal(components, 0);
  const allowed = await loadLocalPluginCatalog({ roots: [f.declaration], admitComponent: c => c.kind !== "commands", validateComponent: c => { if (c.kind === "skills") throw new Error("Owned host schema failure"); } });
  assert.deepEqual(allowed.plugins[0]!.components.map(c => c.kind), ["hooks"]);
  assert.equal(allowed.plugins[0]!.manifest.settings !== undefined, true);
  assert.equal(allowed.diagnostics.filter(d => d.code === "unsupported").length, 2);
  assert.equal(process.env.OWNED, priorOwned);
});

test("module hooks and local/remote MCP bundles are explicit unsupported locations and never executed", async t => {
  const f = await fixture(t, { name: "owned", mcpServers: ["./owned.mcpb", "https://example.invalid/owned.mcpb"] });
  await f.put("owned.mcpb", "Owned fake archive"); await f.put("hooks/hooks.json", { modules: ["./owned.js"] });
  const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
  assert.deepEqual(result.plugins[0]!.components, []); assert.equal(result.diagnostics.filter(d => d.code === "unsupported").length, 3);
});

test("missing declared components report diagnostics, project scope is explicit, and cancellation rejects", async t => {
  const f = await fixture(t, { name: "owned", commands: "./missing.md", skills: "./skill-file" }); await f.put("skill-file");
  const result = await loadLocalPluginCatalog({ roots: [f.declaration] });
  assert.equal(result.plugins.length, 1); assert.equal(result.diagnostics.length, 2);
  assert.deepEqual((await loadLocalPluginCatalog({ roots: [{ ...f.declaration, scope: "project" }] })).plugins, []);
  const controller = new AbortController(); controller.abort(new Error("Owned cancellation"));
  await assert.rejects(loadLocalPluginCatalog({ roots: [f.declaration], signal: controller.signal }), /Owned cancellation/);
  const duringAdmission = new AbortController();
  await assert.rejects(loadLocalPluginCatalog({ roots: [f.declaration], signal: duringAdmission.signal, admitPlugin: async () => { duringAdmission.abort(new Error("Owned host cancellation")); return true; } }), /Owned host cancellation/);
});

test("skills-dir provenance suppresses recursive root skill fallback and explicit root duplication", async t => {
  const f = await fixture(t, { name: "owned" }); await f.put("SKILL.md", "Owned top-level skill");
  const declaration = { ...f.declaration, source: "owned@skills-dir" };
  assert.deepEqual((await loadLocalPluginCatalog({ roots: [declaration] })).plugins[0]!.components, []);
  await f.put(".claude-plugin/plugin.json", { name: "owned", skills: "." });
  assert.deepEqual((await loadLocalPluginCatalog({ roots: [declaration] })).plugins[0]!.components, []);
});
