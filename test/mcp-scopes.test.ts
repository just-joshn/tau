import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enterpriseMcpConfigUsesEnvironment,
  extractMcpGlobalScopeValues,
  matchesMcpServerUrl,
  mcpServerPolicyAllows,
  planMcpScopeReads,
  projectMcpApproval,
  resolveMcpScopes,
  selectMcpPolicyRules,
  type McpScopeConfig,
  type McpSelectedServer,
} from "../src/mcp-scopes.js";

const server = (command: string): McpScopeConfig => ({ command, args: [] });
const document = (command: string) => ({
  servers: { shared: server(command) },
});
const ordinary = {
  user: document("user"),
  project: [document("outer"), document("inner")],
  local: document("local"),
  managed: document("managed"),
  approval: {
    workspaceTrusted: true,
    settings: { enableAllProjectMcpServers: true },
  },
};
test("MCP read plan includes ancestor project files outer-first, excludes filesystem root, and keeps enterprise separate", () => {
  assert.deepEqual(
    planMcpScopeReads({
      cwd: "/fixture/work/repo",
      globalConfigPath: "/fixture/state.json",
      managedRoot: "/fixture/admin",
      excludedProjectDirectories: ["/fixture/work"],
    }),
    {
      globalConfigPath: "/fixture/state.json",
      readUser: true,
      readLocal: true,
      projectFiles: ["/fixture/.mcp.json", "/fixture/work/repo/.mcp.json"],
      enterpriseFile: "/fixture/admin/managed-mcp.json",
    },
  );
  assert.deepEqual(
    planMcpScopeReads({
      cwd: "/fixture/work/repo",
      projectConfigRoot: "/fixture/work",
      globalConfigPath: "/fixture/state.json",
      enabledSources: ["projectSettings"],
    }).projectFiles,
    ["/fixture/.mcp.json", "/fixture/work/.mcp.json"],
  );
});
test("scope read plan respects settings source selection and diskless project mode", () => {
  assert.deepEqual(
    planMcpScopeReads({
      cwd: "/fixture/work",
      globalConfigPath: "/fixture/state.json",
      enabledSources: [],
    }),
    { readUser: false, readLocal: false, projectFiles: [] },
  );
  const result = planMcpScopeReads({
    cwd: "/fixture/work",
    globalConfigPath: "/fixture/state.json",
    enabledSources: [],
    localSettingsEnabled: true,
    diskless: true,
  });
  assert.equal(result.readLocal, true);
  assert.deepEqual(result.projectFiles, []);
});
test("global user and workspace-local MCP values are independent of settings documents", () => {
  const user = { sample: server("user") },
    local = { sample: server("local") };
  assert.deepEqual(
    extractMcpGlobalScopeValues(
      {
        mcpServers: user,
        projects: {
          "/fixture/work": {
            mcpServers: local,
            disabledMcpServers: ["sample", 4],
            enabledMcpServers: ["opt-in"],
          },
        },
      },
      "/fixture/work",
    ),
    { user, local, disabledNames: ["sample"], enabledNames: ["opt-in"] },
  );
  assert.deepEqual(extractMcpGlobalScopeValues(null, "/fixture/work"), {
    user: undefined,
    local: undefined,
    disabledNames: [],
    enabledNames: [],
  });
});
test("ordinary precedence and explicit argument order preserve transport data and source origin", () => {
  const resolved = resolveMcpScopes({
    ...ordinary,
    explicit: [
      { ...document("first"), path: "/fixture/first.json" },
      { ...document("last"), path: "/fixture/last.json" },
    ],
  });
  assert.deepEqual(resolved.selected.shared, {
    config: server("last"),
    scope: "dynamic",
    path: "/fixture/last.json",
  });
  assert.equal(
    resolveMcpScopes(ordinary).selected.shared?.config.command,
    "managed",
  );
  const { managed: _managed, ...withoutManaged } = ordinary;
  assert.equal(
    resolveMcpScopes(withoutManaged).selected.shared?.config.command,
    "local",
  );
  const project = resolveMcpScopes({
    project: [
      { ...document("outer"), path: "/fixture/.mcp.json" },
      { ...document("inner"), path: "/fixture/repo/.mcp.json" },
    ],
    approval: ordinary.approval,
  });
  assert.deepEqual(project.selected.shared, {
    config: server("inner"),
    scope: "project",
    path: "/fixture/repo/.mcp.json",
  });
});
test("unapproved project definitions do not shadow user values or create duplicate pending rows", () => {
  const result = resolveMcpScopes({
    user: document("user"),
    project: [
      { servers: { shared: server("pending"), lonely: server("pending") } },
    ],
  });
  assert.equal(result.selected.shared?.config.command, "user");
  assert.deepEqual(result.pendingProjectNames, ["lonely"]);
  assert.equal(result.selected.lonely, undefined);
});
test("project rejection uses normalized comparison, while approvals default to exact names", () => {
  assert.equal(
    projectMcpApproval("foo bar", {
      workspaceTrusted: true,
      settings: { enabledMcpjsonServers: ["foo_bar"] },
    }),
    "pending",
  );
  assert.equal(
    projectMcpApproval("foo bar", {
      workspaceTrusted: true,
      legacyApprovalNames: true,
      settings: { enabledMcpjsonServers: ["foo_bar"] },
    }),
    "approved",
  );
  assert.equal(
    projectMcpApproval("foo bar", {
      workspaceTrusted: true,
      nonInteractive: true,
      settings: {
        disabledMcpjsonServers: ["foo_bar"],
        enableAllProjectMcpServers: true,
      },
    }),
    "rejected",
  );
  assert.equal(
    projectMcpApproval("plugin:foo bar", {
      workspaceTrusted: true,
      settings: { disabledMcpjsonServers: ["plugin:foo_bar"] },
    }),
    "pending",
  );
});
test("untrusted projects rely on caller-filtered trusted documents/session approvals", () => {
  assert.equal(
    projectMcpApproval("sample", {
      workspaceTrusted: false,
      settings: { enableAllProjectMcpServers: true },
    }),
    "pending",
  );
  assert.equal(
    projectMcpApproval("sample", {
      workspaceTrusted: false,
      visibleTrustedSettings: [{ enabledMcpjsonServers: ["sample"] }],
    }),
    "approved",
  );
  assert.equal(
    projectMcpApproval("sample", {
      workspaceTrusted: false,
      sessionApprovedNames: ["sample"],
    }),
    "approved",
  );
  assert.equal(
    projectMcpApproval("sample", {
      workspaceTrusted: false,
      nonInteractive: true,
    }),
    "approved",
  );
  assert.equal(
    projectMcpApproval("sample", {
      workspaceTrusted: false,
      nonInteractive: true,
      requireExplicitApproval: true,
    }),
    "pending",
  );
  assert.equal(
    projectMcpApproval(
      "sample",
      { workspaceTrusted: false, bypassApproved: true },
      false,
    ),
    "pending",
  );
});
test("strict and discovery/source gates leave explicit configuration available", () => {
  for (const gate of [{ strict: true }, { autoDiscovery: false }]) {
    const result = resolveMcpScopes({
      ...ordinary,
      ...gate,
      explicit: [{ servers: { extra: server("explicit") } }],
    });
    assert.deepEqual(Object.keys(result.connectable), ["extra"]);
  }
  assert.deepEqual(
    Object.keys(
      resolveMcpScopes({ ...ordinary, pluginOnly: true }).connectable,
    ),
    ["shared"],
  );
  assert.equal(
    resolveMcpScopes({ ...ordinary, pluginOnly: true }).selected.shared?.scope,
    "managed",
  );
  const result = resolveMcpScopes({
    user: document("user"),
    project: [document("project")],
    local: document("local"),
    enabledSources: ["userSettings"],
  });
  assert.equal(result.selected.shared?.scope, "user");
});
test("enterprise presence excludes ordinary scopes, and enterprise overrides managed settings", () => {
  const result = resolveMcpScopes({
    ...ordinary,
    enterprise: { present: true, valid: true, ...document("enterprise") },
  });
  assert.equal(result.selected.shared?.scope, "enterprise");
  const empty = resolveMcpScopes({
    user: document("user"),
    enterprise: { present: true, valid: true, servers: {} },
  });
  assert.deepEqual(Object.keys(empty.selected), []);
});
test("valid enterprise file refuses strict/ordinary explicit; missing enterprise file does neither", () => {
  const enterprise = { present: true, valid: true, servers: {} };
  assert.match(
    resolveMcpScopes({ enterprise, strict: true }).refusal!,
    /strict-mcp-config/,
  );
  assert.match(
    resolveMcpScopes({ enterprise, explicit: [document("dynamic")] }).refusal!,
    /dynamically configure/,
  );
  assert.equal(
    resolveMcpScopes({
      enterprise: { ...enterprise, present: false },
      strict: true,
      explicit: [document("dynamic")],
    }).selected.shared?.scope,
    "dynamic",
  );
});
test("malformed or held enterprise configuration remains exclusive and drops explicit ordinary servers", () => {
  for (const status of [{ valid: false }, { valid: true, held: true }]) {
    const result = resolveMcpScopes({
      ...ordinary,
      enterprise: { ...document("enterprise"), present: true, ...status },
      explicit: [document("dynamic")],
      strict: false,
    });
    assert.equal(result.refusal, undefined);
    assert.deepEqual(result.droppedExplicitNames, ["shared"]);
    assert.equal(result.selected.shared?.scope, "managed");
  }
  const result = resolveMcpScopes({
    enterprise: { servers: {}, present: true, valid: false },
    strict: true,
    explicit: [document("dynamic")],
  });
  assert.deepEqual(Object.keys(result.connectable), []);
  assert.equal(result.refusal, undefined);
});
test("enterprise exemption comes only from the host, and persistent disabled names affect explicit servers", () => {
  const result = resolveMcpScopes({
    enterprise: { present: true, valid: true, servers: {} },
    explicit: [document("host")],
    enterpriseExempt: (name) => name === "shared",
    disabledNames: ["shared"],
  });
  assert.equal(result.selected.shared?.scope, "dynamic");
  assert.deepEqual(result.disabledNames, ["shared"]);
  assert.deepEqual(Object.keys(result.connectable), []);
  assert.deepEqual(
    resolveMcpScopes({
      explicit: [document("host")],
      optInNames: ["shared"],
      enabledNames: [],
    }).disabledNames,
    ["shared"],
  );
});
test("managed definitions bypass allowlists, but deny rules and expanded-env definitions do not", () => {
  const managed: McpSelectedServer = {
    config: server("managed"),
    scope: "managed",
  };
  assert.equal(mcpServerPolicyAllows("sample", managed, []), true);
  assert.equal(
    mcpServerPolicyAllows("sample", managed, [], [{ serverName: "sample" }]),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows(
      "sample",
      { ...managed, config: { ...managed.config, expandedFromEnv: true } },
      [],
    ),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows(
      "sample",
      { ...managed, config: { ...managed.config, pluginSource: "fixture" } },
      [],
    ),
    false,
  );
});
test("enterprise environment origin detects command/args/url/headers before expansion but ignores stdio env", () => {
  assert.equal(
    enterpriseMcpConfigUsesEnvironment({ command: "${BIN:-node}", args: [] }),
    true,
  );
  assert.equal(
    enterpriseMcpConfigUsesEnvironment({
      command: "node",
      args: ["${SERVER}"],
    }),
    true,
  );
  assert.equal(
    enterpriseMcpConfigUsesEnvironment({
      command: "node",
      args: ["$SERVER", "${1INVALID}"],
      env: { TOKEN: "${TOKEN}" },
    } as McpScopeConfig),
    false,
  );
  assert.equal(
    enterpriseMcpConfigUsesEnvironment({
      type: "http",
      url: "https://fixture.invalid",
      headers: { Authorization: "Bearer ${TOKEN}" },
    }),
    true,
  );
  assert.equal(
    enterpriseMcpConfigUsesEnvironment({ type: "ws", url: "${ENDPOINT}" }),
    true,
  );
  assert.equal(
    enterpriseMcpConfigUsesEnvironment({ type: "sdk", url: "${ENDPOINT}" }),
    false,
  );
});
test("policy rules use effective allowlist unless an administrator lock selects the authoritative list", () => {
  const effective = { allowedMcpServers: [{ serverName: "repo" }] },
    policy = { allowedMcpServers: [{ serverName: "admin" }] };
  assert.deepEqual(selectMcpPolicyRules(effective, policy).allowRules, [
    { serverName: "repo" },
  ]);
  assert.deepEqual(
    selectMcpPolicyRules(effective, policy, [
      { allowManagedMcpServersOnly: true },
    ]).allowRules,
    [{ serverName: "admin" }],
  );
  assert.deepEqual(
    selectMcpPolicyRules(effective, {}, [
      { allowManagedMcpServersOnly: true, allowedMcpServers: [] },
    ]).allowRules,
    [],
  );
  assert.equal(
    selectMcpPolicyRules(effective, { allowManagedMcpServersOnly: true })
      .allowRules,
    undefined,
  );
});
test("durable administrator denies are unioned with effective restrictions even when allowlists are unlocked", () => {
  const deny = { serverName: "admin-denied" };
  const result = selectMcpPolicyRules(
    { deniedMcpServers: [{ serverName: "repo-denied" }, deny] },
    {},
    [],
    [{ deniedMcpServers: [deny, { serverCommand: ["forbidden"] }] }],
  );
  assert.deepEqual(result.denyRules, [
    { serverName: "repo-denied" },
    deny,
    { serverCommand: ["forbidden"] },
  ]);
});
test("typed command allow rules suppress name fallback and compare complete argv literally", () => {
  const item: McpSelectedServer = {
    scope: "user",
    config: { command: "node", args: ["server.js", "--fixture"] },
  };
  assert.equal(
    mcpServerPolicyAllows("sample", item, [
      { serverName: "sample" },
      { serverCommand: ["other"] },
    ]),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows("sample", item, [
      { serverCommand: ["node", "server.js", "--fixture"] },
    ]),
    true,
  );
  assert.equal(
    mcpServerPolicyAllows("sample", item, [{ serverCommand: ["node", "*"] }]),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows("sample", item, undefined, [
      { serverCommand: ["node", "server.js"] },
    ]),
    true,
  );
});
test("allow expansion groups require all variants, denial matches any configured/expanded variant", () => {
  const item: McpSelectedServer = { scope: "user", config: server("expanded") };
  const variants = {
    allowCommandGroups: [[["configured"], ["expanded"]]],
    denyCommands: [["configured"], ["expanded"]],
  };
  assert.equal(
    mcpServerPolicyAllows(
      "sample",
      item,
      [{ serverCommand: ["expanded"] }],
      [],
      variants,
    ),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows(
      "sample",
      item,
      [{ serverCommand: ["expanded"] }, { serverCommand: ["configured"] }],
      [],
      variants,
    ),
    true,
  );
  assert.equal(
    mcpServerPolicyAllows(
      "sample",
      item,
      undefined,
      [{ serverCommand: ["configured"] }],
      variants,
    ),
    false,
  );
});
test("policy filtering occurs after configured precedence and before final explicit overlay", () => {
  const blockedConfigured = resolveMcpScopes({
    user: document("allowed"),
    local: document("blocked"),
    allowRules: [{ serverCommand: ["allowed"] }],
  });
  assert.equal(blockedConfigured.selected.shared, undefined);
  const blockedExplicit = resolveMcpScopes({
    user: document("allowed"),
    explicit: [document("blocked")],
    allowRules: [{ serverCommand: ["allowed"] }],
  });
  assert.equal(blockedExplicit.selected.shared?.config.command, "allowed");
  assert.deepEqual(blockedExplicit.policyBlockedNames, ["shared"]);
});
test("URL matcher handles hostname wildcards, ports, trailing dots, paths, query and literal question marks", () => {
  const cases: Array<[string, string, boolean]> = [
    ["https://api.fixture.invalid/v1?q=1", "https://api.fixture.invalid", true],
    ["https://api.fixture.invalid/v1", "https://api.fixture.invalid/", false],
    ["https://api.fixture.invalid:8443/v1", "https://*.fixture.invalid", true],
    [
      "https://api.fixture.invalid:8443/v1",
      "https://api.fixture.invalid",
      false,
    ],
    [
      "https://api.fixture.invalid:8443/v1",
      "https://api.fixture.invalid:*/*",
      true,
    ],
    ["http://API.fixture.invalid./v1", "*://api.fixture.invalid/*", true],
    [
      "https://api.fixture.invalid/v1?q=1",
      "https://api.fixture.invalid/v*?q=*",
      true,
    ],
    [
      "https://api.fixture.invalid/v1xq=1",
      "https://api.fixture.invalid/v*?q=*",
      false,
    ],
    [
      "https://api.fixture.invalid/v1",
      "https://other.fixture.invalid/*",
      false,
    ],
    ["not a URL", "*", true],
    ["not a URL", "https://*", false],
  ];
  for (const [actual, pattern, expected] of cases)
    assert.equal(
      matchesMcpServerUrl(actual, pattern),
      expected,
      `${actual} / ${pattern}`,
    );
});
test("URL allow rule variants must all match; unrelated command rules do not suppress URL name fallback", () => {
  const item: McpSelectedServer = {
    scope: "user",
    config: { type: "http", url: "https://api.fixture.invalid/v1" },
  };
  assert.equal(
    mcpServerPolicyAllows("sample", item, [
      { serverName: "sample" },
      { serverCommand: ["node"] },
    ]),
    true,
  );
  assert.equal(
    mcpServerPolicyAllows("sample", item, [
      { serverName: "sample" },
      { serverUrl: "https://other.invalid" },
    ]),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows(
      "sample",
      item,
      [{ serverUrl: "https://api.fixture.invalid" }],
      [],
      { allowUrls: [item.config.url!, "https://other.invalid"] },
    ),
    false,
  );
  assert.equal(
    mcpServerPolicyAllows("sample", item, undefined, [
      { serverUrl: "https://*.fixture.invalid" },
    ]),
    false,
  );
});
