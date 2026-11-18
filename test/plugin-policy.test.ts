import test from "node:test";
import assert from "node:assert/strict";
import {
  managedLocalPluginAdmission,
  resolveLocalPluginDependencies,
} from "../src/plugin-policy.js";
import type { CatalogPlugin } from "../src/plugin-catalog.js";

const plugin = (
  source: string,
  dependencies?: unknown,
  enabled = true,
): CatalogPlugin => ({
  name: source.split("@")[0]!,
  source,
  scope: "session",
  root: "/owned/" + source,
  realRoot: "/owned/" + source,
  manifest: {
    name: source.split("@")[0]!,
    ...(dependencies !== undefined && { dependencies }),
  },
  provenance: {},
  enabled,
  enableDecision: { enabled, source: "owned" },
  components: [
    { kind: "hooks", origin: "manifest", config: { PreToolUse: [] } },
  ],
});

test("managed name locks apply across local marketplace identity, NFC/case and true/false values", () => {
  for (const enabled of [true, false]) {
    const decision = managedLocalPluginAdmission("Owned", {
      "owned@market": enabled,
    });
    assert.equal(decision.admitted, false);
    assert.equal(decision.matched?.enabled, enabled);
  }
  assert.equal(
    managedLocalPluginAdmission("café", { "CAFE\u0301@market": true }).admitted,
    false,
  );
  assert.equal(
    managedLocalPluginAdmission("owned", {
      "owned@market": true,
      "Owned@elsewhere": false,
    }).matched?.enabled,
    false,
  );
});

test("bare/nonboolean policy records do not invent locks, while malformed qualified keys retain native name locking", () => {
  assert.equal(
    managedLocalPluginAdmission("owned", {
      owned: false,
      "other@market": true,
      "owned@ignored": "false",
    }).admitted,
    true,
  );
  const result = managedLocalPluginAdmission("owned", {
    "owned@market@extra": true,
  });
  assert.equal(result.admitted, false);
  assert.equal(result.matched?.marketplace, "");
  assert.equal(managedLocalPluginAdmission("owned", undefined).admitted, true);
});

test("builtin alias name locks require explicit host alias metadata and do not bleed into ordinary marketplaces", () => {
  const builtinAliases = { canonical: ["old-name", "alias"] };
  assert.equal(
    managedLocalPluginAdmission(
      "alias",
      { "old-name@builtin": true },
      { builtinAliases },
    ).admitted,
    false,
  );
  assert.equal(
    managedLocalPluginAdmission(
      "canonical",
      { "old-name@builtin": false },
      { builtinAliases },
    ).admitted,
    false,
  );
  assert.equal(
    managedLocalPluginAdmission(
      "alias",
      { "old-name@market": false },
      { builtinAliases },
    ).admitted,
    true,
  );
});

test("dependency closure demotes missing and transitive dependents before hooks and leaves input records intact", () => {
  const a = plugin("a@inline", ["b"]),
    b = plugin("b@inline", ["missing"]),
    independent = plugin("independent@inline");
  const result = resolveLocalPluginDependencies([a, b, independent]);
  assert.deepEqual(
    result.plugins.map((p) => [p.source, p.enabled, p.components.length]),
    [
      ["a@inline", false, 0],
      ["b@inline", false, 0],
      ["independent@inline", true, 1],
    ],
  );
  assert.equal(a.enabled, true);
  assert.equal(b.components.length, 1);
  assert.equal(
    result.diagnostics.find((d) => d.source === "b@inline")?.reason,
    "not-found",
  );
  assert.equal(
    result.diagnostics.find((d) => d.source === "a@inline")?.reason,
    "not-enabled",
  );
});

test("fully enabled cycles and unqualified local dependencies work without install or source widening", () => {
  const result = resolveLocalPluginDependencies([
    plugin("a@inline", ["b"]),
    plugin("b@inline", ["a"]),
  ]);
  assert.deepEqual(
    result.plugins.map((p) => p.enabled),
    [true, true],
  );
  assert.deepEqual(result.diagnostics, []);
  const disabled = resolveLocalPluginDependencies([
    plugin("a@inline", ["b"]),
    plugin("b@inline", undefined, false),
  ]);
  assert.deepEqual(
    disabled.plugins.map((p) => p.enabled),
    [false, false],
  );
  assert.ok(disabled.plugins.every((p) => !p.components.length));
  const duplicate = resolveLocalPluginDependencies([
    plugin("a@inline"),
    plugin("a@inline", undefined, false),
  ]);
  assert.equal(duplicate.plugins[0]!.components.length, 1);
  assert.equal(duplicate.plugins[1]!.components.length, 0);
});

test("qualified dependencies accept inline overrides; ordinary installed bare names inherit their marketplace", () => {
  assert.deepEqual(
    resolveLocalPluginDependencies([
      plugin("a@market", ["b@elsewhere"]),
      plugin("b@inline"),
    ]).plugins.map((p) => p.enabled),
    [true, true],
  );
  assert.equal(
    resolveLocalPluginDependencies([
      plugin("a@market", ["b"]),
      plugin("b@other"),
    ]).plugins[0]!.enabled,
    false,
  );
  assert.equal(
    resolveLocalPluginDependencies([
      plugin("a@market", [{ name: "b", marketplace: "other" }]),
      plugin("b@other"),
    ]).plugins[0]!.enabled,
    true,
  );
});

test("unsupported constraints and malformed declarations withhold plugin and its dependent", () => {
  for (const dependencies of [
    ["b@^1"],
    ["b@market@^1"],
    [{ name: "b", version: "1" }],
    [false],
    "b",
    { name: "b" },
  ]) {
    const result = resolveLocalPluginDependencies([
      plugin("a@inline", dependencies),
      plugin("b@inline"),
      plugin("c@inline", ["a"]),
    ]);
    assert.equal(result.plugins[0]!.enabled, false);
    assert.equal(result.plugins[2]!.enabled, false);
    assert.equal(result.diagnostics[0]!.reason, "unsupported");
  }
});

test("host canonical builtin ID mapping is explicit and applied to dependency identities", () => {
  const result = resolveLocalPluginDependencies(
    [plugin("a@inline", ["old@builtin"]), plugin("canonical@builtin")],
    {
      canonicalizeSource: (source) =>
        source === "old@builtin" ? "canonical@builtin" : source,
    },
  );
  assert.deepEqual(
    result.plugins.map((p) => p.enabled),
    [true, true],
  );
});
