import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  loadLaunchConfiguration,
  type LaunchConfiguration,
} from "../../src/launch-configuration.js";
import {
  loadLaunchMcp,
  mcpReadFailureImpliesPresence,
} from "../../src/mcp-launch.js";
import { parseOptions } from "../../src/options.js";
import type { CatalogPlugin } from "../../src/plugin-catalog.js";

const node = { command: process.execPath, args: ["--version"] };

async function fixture(env: Record<string, string> = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-mcp-launch-edges-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const user = join(root, "config"),
    cwd = join(root, "work"),
    managed = join(root, "managed");
  for (const directory of [user, cwd]) await mkdir(directory);
  const fullEnv = {
    CLAUDE_CONFIG_DIR: user,
    TAU_MANAGED_ROOT: managed,
    ...env,
  };
  const json = (path: string, value: unknown) =>
    writeFile(path, JSON.stringify(value));
  const launch = (nonInteractive = true) =>
    loadLaunchConfiguration(parseOptions([]), {
      cwd,
      env: fullEnv,
      homeDirectory: root,
      nonInteractive,
      workspaceTrustAccepted: true,
    });
  const load = async (
    extra: {
      launch?: LaunchConfiguration;
      nonInteractive?: boolean;
      approveProject?: (name: string, path?: string) => Promise<boolean>;
      plugins?: readonly CatalogPlugin[];
    } = {},
  ) => {
    const nonInteractive = extra.nonInteractive ?? true;
    const diagnostics: string[] = [];
    const result = await loadLaunchMcp({
      cwd,
      launch: extra.launch ?? (await launch(nonInteractive)),
      env: fullEnv,
      specs: [],
      strict: false,
      nonInteractive,
      bypassPermissions: false,
      signal: new AbortController().signal,
      ...(extra.approveProject ? { approveProject: extra.approveProject } : {}),
      ...(extra.plugins ? { plugins: extra.plugins } : {}),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    return { ...result, diagnostics };
  };
  return { root, user, cwd, managed, json, launch, load };
}

test("a read failure that is not an error object is treated as a present file", () => {
  assert.equal(mcpReadFailureImpliesPresence("boom", "darwin"), true);
  assert.equal(mcpReadFailureImpliesPresence(null, "linux"), true);
});

test("managed policy servers keep URLs literal; remote and unknown transports are never launched", async () => {
  const f = await fixture({ TOKEN: "secret" });
  await mkdir(f.managed);
  await f.json(join(f.managed, "managed-settings.json"), {
    managedMcpServers: {
      remote: { type: "http", url: "https://host/${TOKEN}" },
      typed: { type: "stdio", ...node },
      odd: { type: "grpc", url: "x" },
      broken: 5,
    },
  });
  const loaded = await f.load();
  assert.deepEqual(Object.keys(loaded.configs), ["typed"]);
  assert.equal(loaded.configs.typed?.type, "stdio");
  assert.deepEqual(loaded.resolution.selected.remote?.config, {
    type: "http",
    url: "https://host/${TOKEN}",
  });
  assert.equal(loaded.resolution.selected.odd, undefined);
  for (const message of [
    "Unsupported MCP transport for remote: http; supported transport: stdio",
    "managed policy: invalid or unknown transport for MCP server odd",
    "managed policy: invalid MCP server broken",
  ])
    assert.ok(loaded.diagnostics.includes(message), message);
});

test("user-scope remote URLs expand variables and report unresolved ones", async () => {
  const f = await fixture({ HOST: "https://h" });
  await f.json(join(f.user, ".claude.json"), {
    mcpServers: {
      web: { type: "sse", url: "${HOST}/sse" },
      ws: { type: "ws", url: "${MISSING_HOST}/ws" },
    },
  });
  const loaded = await f.load();
  assert.equal(loaded.resolution.selected.web?.config.url, "https://h/sse");
  assert.equal(loaded.resolution.selected.ws?.config.url, "${MISSING_HOST}/ws");
  assert.ok(
    loaded.diagnostics.some((message) =>
      message.endsWith(
        "MCP server ws has unresolved environment variables MISSING_HOST",
      ),
    ),
  );
  assert.deepEqual(Object.keys(loaded.configs), []);
});

test("project files: blank is empty, non-objects and missing mcpServers are diagnosed", async () => {
  const f = await fixture();
  const file = join(f.cwd, ".mcp.json");
  await writeFile(file, "  \n");
  const blank = await f.load();
  assert.deepEqual(Object.keys(blank.configs), []);
  assert.deepEqual(blank.diagnostics, []);

  await writeFile(file, "[]");
  assert.deepEqual((await f.load()).diagnostics, [
    `${file}: invalid MCP configuration JSON/object`,
  ]);

  await f.json(file, { servers: {} });
  assert.deepEqual((await f.load()).diagnostics, [
    `${file}: missing mcpServers object`,
  ]);
});

test("a project file with a non-object server entry skips only that entry", async () => {
  const f = await fixture();
  const file = join(f.cwd, ".mcp.json");
  await f.json(file, { mcpServers: { bad: [], good: node } });
  const loaded = await f.load();
  assert.deepEqual(Object.keys(loaded.configs), ["good"]);
  assert.ok(loaded.diagnostics.includes(`${file}: invalid MCP server bad`));
});

test("an enterprise file that is not a regular file is present and exclusive", async () => {
  const f = await fixture();
  await f.json(join(f.user, ".claude.json"), { mcpServers: { user: node } });
  const enterprise = join(f.managed, "managed-mcp.json");
  await mkdir(enterprise, { recursive: true });
  const loaded = await f.load();
  assert.deepEqual(Object.keys(loaded.configs), []);
  assert.ok(
    loaded.diagnostics.includes(
      `${enterprise}: MCP configuration could not be read (special-file)`,
    ),
  );
});

test("a dangling enterprise symlink counts as absent", async () => {
  const f = await fixture();
  await f.json(join(f.user, ".claude.json"), { mcpServers: { user: node } });
  await mkdir(f.managed);
  await symlink(
    join(f.managed, "nowhere.json"),
    join(f.managed, "managed-mcp.json"),
  );
  const loaded = await f.load();
  assert.deepEqual(Object.keys(loaded.configs), ["user"]);
  assert.deepEqual(loaded.diagnostics, []);
});

test("an enterprise path whose metadata cannot be probed is present and exclusive", async () => {
  const f = await fixture();
  await f.json(join(f.user, ".claude.json"), { mcpServers: { user: node } });
  // A self-referencing managed root makes lstat fail with ELOOP, not ENOENT.
  await symlink(f.managed, f.managed);
  const loaded = await f.load();
  assert.deepEqual(Object.keys(loaded.configs), []);
  assert.deepEqual(loaded.diagnostics, [
    `${join(f.managed, "managed-mcp.json")}: MCP configuration metadata could not be read`,
  ]);
});

test("an enterprise document without an mcpServers object is diagnosed and still exclusive", async () => {
  const f = await fixture();
  await f.json(join(f.user, ".claude.json"), { mcpServers: { user: node } });
  await mkdir(f.managed);
  const enterprise = join(f.managed, "managed-mcp.json");
  await f.json(enterprise, {});
  const missing = await f.load();
  assert.deepEqual(Object.keys(missing.configs), []);
  assert.deepEqual(missing.diagnostics, [
    `${enterprise}: missing mcpServers object`,
  ]);
  await f.json(enterprise, { mcpServers: [] });
  const array = await f.load();
  assert.deepEqual(Object.keys(array.configs), []);
  assert.deepEqual(array.diagnostics, [
    `${enterprise}: missing mcpServers object`,
    `${enterprise}: mcpServers must be an object`,
  ]);
});

test("a launch without a managed root never consults an enterprise file", async () => {
  const f = await fixture();
  await f.json(join(f.user, ".claude.json"), { mcpServers: { user: node } });
  await mkdir(f.managed);
  await f.json(join(f.managed, "managed-mcp.json"), {
    mcpServers: { enterprise: node },
  });
  const { managedRoot, ...launch } = await f.launch();
  assert.equal(managedRoot, f.managed);
  const loaded = await f.load({ launch });
  assert.deepEqual(Object.keys(loaded.configs), ["user"]);
});

test("argv allow rules suppress the name fallback for stdio servers; malformed rules match nothing", async () => {
  const f = await fixture();
  await mkdir(f.managed);
  await f.json(join(f.managed, "managed-settings.json"), {
    allowedMcpServers: [
      5,
      { serverName: "named" },
      { serverUrl: "https://ok" },
      { serverCommand: [process.execPath, "allowed"] },
      { serverCommand: [1] },
    ],
    deniedMcpServers: [{ serverName: "denied" }],
  });
  await f.json(join(f.user, ".claude.json"), {
    mcpServers: {
      named: node,
      denied: node,
      byCommand: { command: process.execPath, args: ["allowed"] },
      other: { command: process.execPath, args: ["other"] },
      url: { type: "http", url: "https://ok" },
    },
  });
  const loaded = await f.load();
  assert.deepEqual(Object.keys(loaded.configs), ["byCommand"]);
  assert.ok(loaded.resolution.selected.url);
  assert.deepEqual(loaded.resolution.policyBlockedNames.sort(), [
    "denied",
    "named",
    "other",
  ]);
});

test("a server policy list that is not an array is diagnosed", async () => {
  const f = await fixture();
  await f.json(join(f.user, ".claude.json"), { mcpServers: { user: node } });
  const launch = await f.launch();
  launch.snapshot.effective.deniedMcpServers = "everything";
  const loaded = await f.load({ launch });
  assert.ok(
    loaded.diagnostics.includes("Invalid deniedMcpServers MCP policy list"),
  );
  assert.deepEqual(Object.keys(loaded.configs), ["user"]);
});

test("interactive launches connect only the project servers the host approves", async () => {
  const f = await fixture();
  const file = join(f.cwd, ".mcp.json");
  await f.json(file, { mcpServers: { yes: node, no: node } });
  const asked: [string, string | undefined][] = [];
  const loaded = await f.load({
    nonInteractive: false,
    approveProject: async (name, path) => {
      asked.push([name, path]);
      return name === "yes";
    },
  });
  assert.deepEqual(
    asked.sort(([a], [b]) => a.localeCompare(b)),
    [
      ["no", file],
      ["yes", file],
    ],
  );
  assert.deepEqual(Object.keys(loaded.configs), ["yes"]);
  assert.ok(loaded.diagnostics.includes("MCP server no: pending"));
});

test("plugin data directories follow a relative plugin cache override", async () => {
  const f = await fixture({ CLAUDE_CODE_PLUGIN_CACHE_DIR: "cache" });
  const pluginRoot = join(f.root, "plugin");
  await mkdir(pluginRoot);
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
    components: [{ kind: "mcp", origin: "manifest", config: { probe: node } }],
  };
  const loaded = await f.load({ plugins: [plugin] });
  const data = join(f.cwd, "cache", "data", "owned-inline");
  assert.equal(
    loaded.configs["plugin:owned:probe"]?.env?.CLAUDE_PLUGIN_DATA,
    data,
  );
  assert.ok((await stat(data)).isDirectory());
});
