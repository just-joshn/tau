import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLaunchConfiguration, resolveGlobalConfigPath } from "../src/launch-configuration.js";
import { loadLaunchMcp, mcpReadFailureImpliesPresence } from "../src/mcp-launch.js";
import { parseOptions } from "../src/options.js";

test("enterprise presence distinguishes unsearchable Unix ancestors from deployed read failures", () => {
  for (const syscall of ["stat", "statx", "lstat"]) {
    assert.equal(mcpReadFailureImpliesPresence({ code: "EACCES", syscall }, "darwin"), false);
    assert.equal(mcpReadFailureImpliesPresence({ code: "EACCES", syscall }, "win32"), true);
  }
  assert.equal(mcpReadFailureImpliesPresence({ code: "EACCES", syscall: "open" }, "darwin"), true);
  assert.equal(mcpReadFailureImpliesPresence({ code: "EPERM", syscall: "lstat" }, "darwin"), true);
  assert.equal(mcpReadFailureImpliesPresence({ code: "ENOENT", syscall: "open" }), false);
});

test("global MCP config lookup honors the config-directory override and legacy metadata selection", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-global-config-path-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, "config"), cwd = join(root, "work"), managed = join(root, "managed");
  for (const directory of [user, cwd, managed]) await mkdir(directory);
  const normal = join(user, ".claude.json"), legacy = join(user, ".config.json");
  const launch = () => loadLaunchConfiguration(parseOptions([]), { cwd, homeDirectory: root, env: { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed } });
  assert.equal((await launch()).globalConfigPath, normal);
  await writeFile(legacy, "");
  assert.equal((await launch()).globalConfigPath, legacy);
  await writeFile(normal, '{"mcpServers":{}}');
  assert.equal((await launch()).globalConfigPath, normal);
  await writeFile(legacy, '{"mcpServers":{"legacy":{}}}');
  assert.equal((await launch()).globalConfigPath, legacy);
  await writeFile(legacy, ""); await chmod(legacy, 0o400);
  assert.equal(await resolveGlobalConfigPath(user, normal), normal);
});

test("MCP file loading keeps malformed enterprise presence exclusive, refuses dynamic/strict, and validates siblings independently", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-mcp-launch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, "config"), cwd = join(root, "work"), managed = join(root, "managed");
  for (const directory of [user, cwd, managed]) await mkdir(directory);
  const command = { command: process.execPath, args: ["--version"] };
  await writeFile(join(user, ".claude.json"), JSON.stringify({ mcpServers: { user: command } }));
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: command } }));
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed, FIXTURE_NODE: process.execPath };
  const launch = await loadLaunchConfiguration(parseOptions([]), { cwd, env, homeDirectory: root });
  const diagnostics: string[] = [];
  const load = (specs: string[] = [], strict = false) => loadLaunchMcp({ cwd, launch, env, specs, strict,
    nonInteractive: true, bypassPermissions: false, signal: new AbortController().signal, onDiagnostic: message => diagnostics.push(message) });
  await writeFile(join(managed, "managed-mcp.json"), "{broken");
  const blocked = await load([JSON.stringify({ mcpServers: { dynamic: command } })]);
  assert.deepEqual(Object.keys(blocked.configs), []);
  assert.deepEqual(blocked.resolution.droppedExplicitNames, ["dynamic"]);
  await writeFile(join(managed, "managed-mcp.json"), JSON.stringify({ mcpServers: { good: command,
    invalid: { command: 42 }, expanded: { command: "${FIXTURE_NODE}", args: ["--version"] } } }));
  await assert.rejects(load([], true), /strict-mcp-config/);
  await assert.rejects(load([JSON.stringify({ mcpServers: { dynamic: command } })]), /dynamically configure/);
  const valid = await load();
  assert.deepEqual(Object.keys(valid.configs).sort(), ["expanded", "good"]);
  assert.equal(valid.resolution.selected.expanded?.config.expandedFromEnv, true);
  assert.ok(diagnostics.some(message => message.includes("invalid MCP server invalid")));
  // Environment-derived enterprise definitions do not acquire the unconditional
  // managed allowlist bypass; plain authored enterprise definitions retain it.
  launch.snapshot.effective.allowedMcpServers = [];
  const restricted = await load();
  assert.deepEqual(Object.keys(restricted.configs), ["good"]);
  assert.deepEqual(restricted.resolution.policyBlockedNames, ["expanded"]);
});

test("unresolved MCP variables retain higher-scope definitions and explicit invalid siblings do not drop valid servers", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-mcp-unresolved-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, "config"), cwd = join(root, "work"), managed = join(root, "managed");
  for (const directory of [user, cwd, managed]) await mkdir(directory);
  await writeFile(join(user, ".claude.json"), JSON.stringify({ mcpServers: { fixture: { command: "lower-user" } } }));
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "${OWNED_UNSET}", args: ["${OTHER_UNSET:-fallback}"] } } }));
  const env = { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed };
  const launch = await loadLaunchConfiguration(parseOptions([]), { cwd, env, homeDirectory: root, nonInteractive: true });
  const diagnostics: string[] = [];
  const load = (specs: string[]) => loadLaunchMcp({ cwd, launch, env, specs, strict: false, nonInteractive: true,
    bypassPermissions: false, signal: new AbortController().signal, onDiagnostic: message => diagnostics.push(message) });
  const project = await load([]);
  assert.equal(project.configs.fixture?.command, "${OWNED_UNSET}");
  assert.deepEqual(project.configs.fixture?.args, ["fallback"]);
  assert.equal(project.resolution.selected.fixture?.scope, "project");
  const dynamic = await load([JSON.stringify({ mcpServers: { valid: { command: "${OWNED_UNSET}" }, invalid: { command: 42 } } })]);
  assert.equal(dynamic.configs.valid?.command, "${OWNED_UNSET}");
  assert.equal(dynamic.resolution.selected.valid?.scope, "dynamic");
  assert.equal(dynamic.configs.invalid, undefined);
  assert.ok(diagnostics.some(message => message.includes("OWNED_UNSET")));
  assert.ok(diagnostics.some(message => message.includes("invalid")));
});
