import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createPluginMcpDocument,
  suppressDuplicatePluginMcpServers,
} from "../src/plugin-mcp.js";
import type { CatalogPlugin, PluginComponent } from "../src/plugin-catalog.js";
import { mcpServerPolicyAllows } from "../src/mcp-scopes.js";

const present = <T>(value: T | undefined): T =>
  value ?? assert.fail("missing value");

const plugin = (
  components: PluginComponent[],
  manifest: Record<string, unknown> = {},
): CatalogPlugin => ({
  name: "owned",
  source: "owned@inline",
  root: "/owned/plugin",
  realRoot: "/owned/plugin",
  scope: "session",
  manifest: { name: "owned", ...manifest },
  provenance: {},
  enabled: true,
  enableDecision: { enabled: true, source: "owned" },
  components,
});
const component = (
  config: Record<string, unknown>,
  path?: string,
): PluginComponent => ({
  kind: "mcp",
  origin: path ? "default" : "manifest",
  config,
  ...(path && { path, realPath: path }),
});
const data = () => "/owned/data/owned-inline";

test("plugin MCP default file, additional file and inline sources merge in order before qualification", async () => {
  const p = plugin([
    component(
      {
        mcpServers: {
          shared: { command: "default" },
          base: { command: "base" },
        },
      },
      "/owned/plugin/.mcp.json",
    ),
    component({ shared: { command: "file" } }, "/owned/plugin/extra.json"),
    component({ shared: { command: "inline", args: ["owned"] } }),
  ]);
  const result = await createPluginMcpDocument({
    plugins: [p],
    env: {},
    pluginDataDirectory: data,
  });
  assert.deepEqual(Object.keys(result.document.servers), [
    "plugin:owned:shared",
    "plugin:owned:base",
  ]);
  const shared = present(result.document.servers["plugin:owned:shared"]);
  assert.equal(shared.command, "inline");
  assert.deepEqual(shared.args, ["owned"]);
  assert.equal(shared.scope, "dynamic");
  assert.equal(shared.pluginSource, "owned@inline");
  assert.equal(shared.pluginPath, "/owned/plugin");
  assert.deepEqual(shared.env, {
    CLAUDE_PLUGIN_ROOT: "/owned/plugin",
    CLAUDE_PLUGIN_DATA: "/owned/data/owned-inline",
  });
  assert.deepEqual(result.diagnostics, []);
});

test("plugin substitutions precede explicit env expansion while reserved authored env overrides remain literal", async () => {
  const p = plugin([
    component({
      server: {
        command: "${CLAUDE_PLUGIN_ROOT}/owned",
        args: [
          "${CLAUDE_PLUGIN_DATA}",
          "${CLAUDE_PROJECT_DIR}",
          "${ARG:-fallback}",
        ],
        env: {
          CLAUDE_PLUGIN_ROOT: "${OVERRIDE}",
          CLAUDE_PLUGIN_DATA: "literal-data",
          OWNED: "${CLAUDE_PLUGIN_ROOT}:${VALUE}",
        },
      },
    }),
  ]);
  const result = await createPluginMcpDocument({
    plugins: [p],
    env: { VALUE: "provided" },
    pluginDataDirectory: data,
    projectDirectory: "/owned/project",
  });
  const server = present(result.document.servers["plugin:owned:server"]);
  assert.equal(server.command, "/owned/plugin/owned");
  assert.deepEqual(server.args, [
    "/owned/data/owned-inline",
    "/owned/project",
    "fallback",
  ]);
  assert.deepEqual(server.env, {
    CLAUDE_PLUGIN_ROOT: "${OVERRIDE}",
    CLAUDE_PLUGIN_DATA: "literal-data",
    OWNED: "/owned/plugin:provided",
  });
  assert.deepEqual(server.configuredCommand, {
    command: "${CLAUDE_PLUGIN_ROOT}/owned",
    args: [
      "${CLAUDE_PLUGIN_DATA}",
      "${CLAUDE_PROJECT_DIR}",
      "${ARG:-fallback}",
    ],
  });
  assert.ok(Object.isFrozen(server));
  assert.ok(
    Object.isFrozen(
      present(result.origins["plugin:owned:server"]).authoredConfig,
    ),
  );
});

test("source narrowing runs before data/context access and disabled plugins produce no server declarations", async () => {
  const p = plugin([component({ owned: { command: "owned" } })]);
  let directories = 0,
    admissions = 0;
  const result = await createPluginMcpDocument({
    plugins: [p, { ...p, enabled: false }],
    env: {},
    pluginDataDirectory: () => {
      directories++;
      return data();
    },
    admitServer: (declaration) => {
      admissions++;
      assert.equal(declaration.qualifiedName, "plugin:owned:owned");
      assert.deepEqual(declaration.authoredConfig, { command: "owned" });
      return "Owned source narrowing";
    },
  });
  assert.deepEqual(Object.keys(result.document.servers), []);
  assert.equal(admissions, 1);
  assert.equal(directories, 0);
  assert.equal(present(result.diagnostics[0]).reason, "withheld");
});

test("native skip flags distinguish basename exceptions from full-ID stdio exceptions and project skills-dir provenance", async () => {
  const p = plugin([component({ server: { command: "owned" } })]);
  const run = (env: NodeJS.ProcessEnv, value = p) =>
    createPluginMcpDocument({
      plugins: [value],
      env,
      pluginDataDirectory: data,
    });
  assert.deepEqual(
    Object.keys(
      (await run({ CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "true" })).document
        .servers,
    ),
    [],
  );
  assert.equal(
    Object.keys(
      (
        await run({
          CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "1",
          CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT: "OWNED",
        })
      ).document.servers,
    ).length,
    1,
  );
  assert.deepEqual(
    Object.keys(
      (
        await run({
          CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS: "on",
          CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT: "owned",
        })
      ).document.servers,
    ),
    [],
  );
  assert.equal(
    Object.keys(
      (
        await run({
          CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS: "yes",
          CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT: "OWNED@INLINE",
        })
      ).document.servers,
    ).length,
    1,
  );
  assert.deepEqual(
    Object.keys(
      (
        await run(
          {
            CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS: "true",
            CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT: "owned@skills-dir",
          },
          { ...p, scope: "project", source: "owned@skills-dir" },
        )
      ).document.servers,
    ),
    [],
  );
  assert.equal(
    Object.keys(
      (
        await run({
          CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "false",
          CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS: "0",
        })
      ).document.servers,
    ).length,
    1,
  );
});

test("unhandled privileged fields, user config and remote transports withhold the selected server without reviving defaults", async () => {
  for (const raw of [
    { command: "owned", scope: "managed" },
    { command: "owned", role: "trusted" },
    { command: "owned", bareElicitationCapability: true },
    { type: "sdk", command: "owned" },
    { type: "http", url: "https://example.invalid/owned" },
  ]) {
    const p = plugin([
      component({ server: { command: "default" } }, "/owned/plugin/.mcp.json"),
      component({ server: raw }),
    ]);
    const result = await createPluginMcpDocument({
      plugins: [p],
      env: {},
      pluginDataDirectory: data,
    });
    assert.equal(result.document.servers["plugin:owned:server"], undefined);
    assert.ok(result.diagnostics.some((d) => d.reason === "unsupported"));
  }
  for (const manifest of [{ userConfig: {} }, { channels: [] }]) {
    const result = await createPluginMcpDocument({
      plugins: [
        plugin([component({ server: { command: "owned" } })], manifest),
      ],
      env: {},
      pluginDataDirectory: data,
    });
    assert.deepEqual(Object.keys(result.document.servers), []);
  }
});

test("invalid later file entries are diagnosed before merging and do not erase a previously valid server", async () => {
  const p = plugin([
    component({ server: { command: "valid" } }, "/owned/plugin/.mcp.json"),
    component({ server: { command: 1 } }, "/owned/plugin/extra.json"),
  ]);
  const result = await createPluginMcpDocument({
    plugins: [p],
    env: {},
    pluginDataDirectory: data,
  });
  assert.equal(
    present(result.document.servers["plugin:owned:server"]).command,
    "valid",
  );
  assert.equal(present(result.diagnostics[0]).reason, "schema");
});

test("data/project/user_config placeholders require explicit host context and missing ordinary env remains diagnostic", async () => {
  for (const raw of [
    { command: "${CLAUDE_PLUGIN_DATA}/owned" },
    { command: "${CLAUDE_PROJECT_DIR}/owned" },
    { command: "${user_config.secret}" },
  ]) {
    const result = await createPluginMcpDocument({
      plugins: [plugin([component({ server: raw })])],
      env: {},
    });
    assert.deepEqual(Object.keys(result.document.servers), []);
    assert.ok(result.diagnostics.some((d) => d.reason === "withheld"));
  }
  const result = await createPluginMcpDocument({
    plugins: [
      plugin([
        component({ server: { command: "owned", args: ["${NOT_PROVIDED}"] } }),
      ]),
    ],
    env: {},
  });
  assert.deepEqual(
    present(result.document.servers["plugin:owned:server"]).args,
    ["${NOT_PROVIDED}"],
  );
  assert.ok(result.diagnostics.some((d) => d.reason === "environment"));
  assert.ok(
    result.diagnostics.some((d) => d.reason === "plugin-data-unavailable"),
  );
});

test("plugin provenance prevents managed allowlist bypass and names are qualified before policy", async () => {
  const result = await createPluginMcpDocument({
    plugins: [plugin([component({ server: { command: "owned" } })])],
    env: {},
    pluginDataDirectory: data,
  });
  const config = present(result.document.servers["plugin:owned:server"]);
  assert.equal(
    mcpServerPolicyAllows(
      "plugin:owned:server",
      { scope: "managed", config },
      [],
    ),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows("plugin:owned:server", { scope: "dynamic", config }, [
      { serverName: "server" },
    ]),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows("plugin:owned:server", { scope: "dynamic", config }, [
      { serverName: "plugin:owned:server" },
    ]),
    true,
  );
  assert.equal(
    mcpServerPolicyAllows(
      "plugin:owned:server",
      { scope: "dynamic", config },
      undefined,
      [{ serverCommand: ["owned"] }],
    ),
    false,
  );
});

test("stdio duplicate suppression ignores env against admitted manual servers and ignores only injected env between plugins", async () => {
  const first = (
    await createPluginMcpDocument({
      plugins: [
        plugin([
          component({
            first: { command: "owned", args: ["a"], env: { VALUE: "one" } },
            second: { command: "owned", args: ["a"], env: { VALUE: "one" } },
            third: { command: "owned", args: ["a"], env: { VALUE: "two" } },
          }),
        ]),
      ],
      env: {},
      pluginDataDirectory: data,
    })
  ).document.servers;
  const together = suppressDuplicatePluginMcpServers(first, {});
  assert.deepEqual(Object.keys(together.servers), [
    "plugin:owned:first",
    "plugin:owned:third",
  ]);
  assert.deepEqual(together.suppressed, [
    { name: "plugin:owned:second", duplicateOf: "plugin:owned:first" },
  ]);
  const manual = suppressDuplicatePluginMcpServers(first, {
    manual: { command: "owned", args: ["a"] },
  });
  assert.deepEqual(Object.keys(manual.servers), []);
  assert.equal(manual.suppressed.length, 3);
});

test("cancellation after async server admission rejects without returning a partial plugin document", async () => {
  const controller = new AbortController();
  await assert.rejects(
    createPluginMcpDocument({
      plugins: [plugin([component({ server: { command: "owned" } })])],
      env: {},
      pluginDataDirectory: data,
      signal: controller.signal,
      admitServer: async () => {
        controller.abort(new Error("Owned MCP abort"));
        return true;
      },
    }),
    /Owned MCP abort/,
  );
});
