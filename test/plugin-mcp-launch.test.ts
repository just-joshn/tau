import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLaunchConfiguration } from "../src/launch-configuration.js";
import { loadLaunchMcp } from "../src/mcp-launch.js";
import { parseOptions } from "../src/options.js";
import type { CatalogPlugin } from "../src/plugin-catalog.js";

async function fixture(t: any) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-plugin-mcp-launch-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    user = join(root, "config"),
    managed = join(root, "managed"),
    pluginRoot = join(root, "plugin");
  for (const path of [cwd, user, managed, pluginRoot]) await mkdir(path);
  const env = {
    CLAUDE_CONFIG_DIR: user,
    TAU_MANAGED_ROOT: managed,
    OWNED_VALUE: "expanded-owned",
  };
  const command = {
    command: process.execPath,
    args: [join(pluginRoot, "owned-never-executed.cjs")],
    env: { VALUE: "${OWNED_VALUE}" },
  };
  const plugin: CatalogPlugin = {
    name: "owned",
    source: "owned@inline",
    scope: "session",
    root: pluginRoot,
    realRoot: pluginRoot,
    manifest: { name: "owned" },
    provenance: {},
    enabled: true,
    enableDecision: { enabled: true, source: "owned" },
    components: [
      { kind: "mcp", origin: "manifest", config: { probe: command } },
    ],
  };
  const data = join(user, "plugins", "data", "owned-inline");
  const load = async (args: string[] = [], strict = false) => {
    const launch = await loadLaunchConfiguration(parseOptions(args), {
      cwd,
      env,
      homeDirectory: root,
      nonInteractive: true,
    });
    const diagnostics: string[] = [];
    const result = await loadLaunchMcp({
      cwd,
      launch,
      env,
      specs: [],
      strict,
      plugins: [plugin],
      nonInteractive: true,
      bypassPermissions: false,
      signal: new AbortController().signal,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    return { ...result, diagnostics };
  };
  return {
    root,
    cwd,
    user,
    managed,
    pluginRoot,
    env,
    command,
    plugin,
    data,
    load,
  };
}

test("plugin MCP is qualified autodiscovery independent of ordinary settings sources", async (t) => {
  const f = await fixture(t),
    loaded = await f.load(["--setting-sources", ""]);
  assert.deepEqual(Object.keys(loaded.configs), ["plugin:owned:probe"]);
  const server = loaded.resolution.selected["plugin:owned:probe"]!;
  assert.equal(server.scope, "dynamic");
  assert.equal(server.config.pluginSource, "owned@inline");
  assert.equal(
    loaded.configs["plugin:owned:probe"]!.env!.CLAUDE_PLUGIN_ROOT,
    f.pluginRoot,
  );
  assert.equal(
    loaded.configs["plugin:owned:probe"]!.env!.CLAUDE_PLUGIN_DATA,
    f.data,
  );
  assert.equal(
    loaded.configs["plugin:owned:probe"]!.env!.VALUE,
    "expanded-owned",
  );
  assert.ok((await stat(f.data)).isDirectory());
});

test("strict and enterprise MCP gates exclude plugins before data-directory side effects", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys((await f.load([], true)).configs), []);
  await assert.rejects(stat(f.data), { code: "ENOENT" });
  await writeFile(join(f.managed, "managed-mcp.json"), "{broken");
  assert.deepEqual(Object.keys((await f.load()).configs), []);
  await assert.rejects(stat(f.data), { code: "ENOENT" });
});

test("plugin MCP retains server policy rather than claiming a managed exemption", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.managed, "managed-settings.json"),
    JSON.stringify({ allowedMcpServers: [] }),
  );
  const denied = await f.load();
  assert.deepEqual(Object.keys(denied.configs), []);
  assert.deepEqual(denied.resolution.policyBlockedNames, [
    "plugin:owned:probe",
  ]);
  await writeFile(
    join(f.managed, "managed-settings.json"),
    JSON.stringify({
      allowedMcpServers: [{ serverName: "plugin:owned:probe" }],
    }),
  );
  assert.deepEqual(Object.keys((await f.load()).configs), [
    "plugin:owned:probe",
  ]);
});

test("only an enabled policy-admitted manual MCP server suppresses a duplicate plugin endpoint", async (t) => {
  const f = await fixture(t),
    global = join(f.user, ".claude.json");
  await writeFile(
    global,
    JSON.stringify({
      mcpServers: { manual: f.command },
      projects: { [f.cwd]: {} },
    }),
  );
  const manual = await f.load();
  assert.deepEqual(Object.keys(manual.configs), ["manual"]);
  assert.ok(
    manual.diagnostics.some((message) => message.includes("duplicates manual")),
  );
  await writeFile(
    global,
    JSON.stringify({
      mcpServers: { manual: f.command },
      projects: { [f.cwd]: { disabledMcpServers: ["manual"] } },
    }),
  );
  assert.deepEqual(Object.keys((await f.load()).configs), [
    "plugin:owned:probe",
  ]);
  await writeFile(
    global,
    JSON.stringify({
      mcpServers: { manual: f.command },
      projects: { [f.cwd]: {} },
    }),
  );
  await writeFile(
    join(f.managed, "managed-settings.json"),
    JSON.stringify({
      allowedMcpServers: [{ serverName: "plugin:owned:probe" }],
    }),
  );
  assert.deepEqual(Object.keys((await f.load()).configs), [
    "plugin:owned:probe",
  ]);
});

test("plugin-only MCP customization retains plugin and managed sources while withholding ordinary scopes", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.user, ".claude.json"),
    JSON.stringify({
      mcpServers: { manual: { command: process.execPath, args: ["manual"] } },
    }),
  );
  await writeFile(
    join(f.cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: { project: { command: process.execPath, args: ["project"] } },
    }),
  );
  await writeFile(
    join(f.managed, "managed-settings.json"),
    JSON.stringify({
      strictPluginOnlyCustomization: ["mcp"],
      managedMcpServers: {
        managed: { command: process.execPath, args: ["managed"] },
      },
    }),
  );
  assert.deepEqual(Object.keys((await f.load()).configs), [
    "plugin:owned:probe",
    "managed",
  ]);
});
