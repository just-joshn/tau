import assert from "node:assert/strict";
import { test } from "bun:test";
import type { CatalogPlugin } from "../../src/plugin-catalog.js";
import {
  managedLocalPluginAdmission,
  pluginCustomizationOnly,
  resolveLocalPluginDependencies,
} from "../../src/plugin-policy.js";

const plugin = (
  source: string,
  dependencies?: unknown,
  enabled = true,
): CatalogPlugin => ({
  name: source.split("@")[0] ?? source,
  source,
  scope: "session",
  root: `/plugins/${source}`,
  realRoot: `/plugins/${source}`,
  manifest: {
    name: source.split("@")[0] ?? source,
    ...(dependencies !== undefined && { dependencies }),
  },
  provenance: {},
  enabled,
  enableDecision: { enabled, source: "settings" },
  components: [
    { kind: "hooks", origin: "manifest", config: { PreToolUse: [] } },
  ],
});
const enabled = (plugins: readonly CatalogPlugin[]) =>
  resolveLocalPluginDependencies(plugins)
    .plugins.filter((entry) => entry.enabled)
    .map((entry) => entry.source);
const diagnostic = (plugins: readonly CatalogPlugin[]) => {
  const [first, ...rest] = resolveLocalPluginDependencies(plugins).diagnostics;
  assert.deepEqual(rest, []);
  return first;
};

test("INV-01 managed plugin-only customization locks every kind for true and only listed kinds for a list", () => {
  for (const kind of ["skills", "agents", "hooks", "mcp"] as const) {
    assert.equal(pluginCustomizationOnly(true, kind), true, kind);
    assert.equal(pluginCustomizationOnly(false, kind), false, kind);
    assert.equal(pluginCustomizationOnly(undefined, kind), false, kind);
  }
  assert.equal(pluginCustomizationOnly(["hooks"], "hooks"), true);
  assert.equal(pluginCustomizationOnly(["hooks"], "skills"), false);
  assert.equal(pluginCustomizationOnly("hooks", "hooks"), false);
});

test("INV-01 a builtin name lock covers its own alias group and no other builtin", () => {
  const builtinAliases = { design: ["figma"], review: ["critic"] };
  const lock = { "figma@builtin": false };
  assert.equal(
    managedLocalPluginAdmission("design", lock, { builtinAliases }).admitted,
    false,
  );
  assert.equal(
    managedLocalPluginAdmission("review", lock, { builtinAliases }).admitted,
    true,
  );
});

test("INV-01 managed lock refusals say whether the plugin is disabled or needs its marketplace copy", () => {
  assert.deepEqual(
    managedLocalPluginAdmission("deploy", { "deploy@market": false }),
    {
      admitted: false,
      matched: { name: "deploy", marketplace: "market", enabled: false },
      reason: "Managed settings disable plugin deploy",
    },
  );
  assert.deepEqual(
    managedLocalPluginAdmission("deploy", { "deploy@market": true }),
    {
      admitted: false,
      matched: { name: "deploy", marketplace: "market", enabled: true },
      reason:
        "Managed plugin deploy requires its attributed marketplace copy; an ordinary local directory cannot claim it",
    },
  );
});

test("INV-01 malformed dependency declarations withhold the plugin as unsupported", () => {
  for (const dependencies of [
    [null],
    [{ name: "bad name" }],
    [{ name: "dep", version: "1.0.0" }],
    [{ name: "dep", marketplace: 5 }],
  ]) {
    const result = resolveLocalPluginDependencies([
      plugin("a@market", dependencies),
      plugin("dep@market"),
    ]);
    assert.deepEqual(
      result.plugins
        .filter((entry) => entry.enabled)
        .map((entry) => entry.source),
      ["dep@market"],
      JSON.stringify(dependencies),
    );
    assert.deepEqual(
      result.diagnostics.map(({ reason, dependency }) => [reason, dependency]),
      [["unsupported", "manifest.dependencies"]],
      JSON.stringify(dependencies),
    );
  }
  assert.equal(diagnostic([plugin("a@market", "dep")])?.dependency, "dep");
});

test("INV-01 object dependencies resolve like strings and name what is missing", () => {
  assert.deepEqual(
    enabled([plugin("a@market", [{ name: "dep" }]), plugin("dep@market")]),
    ["a@market", "dep@market"],
  );
  assert.equal(
    diagnostic([plugin("a@inline", [{ name: "dep", marketplace: "market" }])])
      ?.message,
    "Plugin dependency dep@market is not available; plugin withheld before registration",
  );
  assert.equal(
    diagnostic([plugin("a@inline", [{ name: "dep" }])])?.message,
    "Plugin dependency dep is not available; plugin withheld before registration",
  );
});

test("INV-01 bare dependencies of local plugins resolve against any marketplace; installed ones inherit theirs", () => {
  for (const local of ["inline", "skills-dir", "synced"])
    assert.deepEqual(
      enabled([plugin(`a@${local}`, ["dep"]), plugin("dep@market")]),
      [`a@${local}`, "dep@market"],
    );
  assert.equal(
    diagnostic([plugin("a@market", ["dep"])])?.dependency,
    "dep@market",
  );
  assert.equal(diagnostic([plugin("a", ["dep"])])?.dependency, "dep");
});

test("INV-01 a demoted plugin records the dependency closure; an already disabled one keeps its decision", () => {
  const result = resolveLocalPluginDependencies([
    plugin("a@inline", ["b"]),
    plugin("b@inline", undefined, false),
  ]);
  assert.deepEqual(
    result.plugins.map(({ source, enableDecision }) => [
      source,
      enableDecision,
    ]),
    [
      ["a@inline", { enabled: false, source: "dependency-closure" }],
      ["b@inline", { enabled: false, source: "settings" }],
    ],
  );
  assert.deepEqual(
    result.diagnostics.map(({ reason, message }) => [reason, message]),
    [
      [
        "not-enabled",
        "Plugin dependency b is not enabled; plugin withheld before registration",
      ],
    ],
  );
});
