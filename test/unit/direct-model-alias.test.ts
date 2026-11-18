import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  bakedDirectModelAliases,
  directModelWireName,
  resolveDirectModelAlias,
} from "../../src/direct-model-alias.js";
import { modelFacts } from "../../src/model-facts.js";
import { contextWindow } from "../../src/context-window.js";
import { thinkingRequest } from "../../src/reasoning.js";
import { firstPartyQueryEffortFacts } from "../../src/query-model-effort.js";

test("direct aliases use baked catalog targets before historical terminal fallbacks", () => {
  for (const [alias, target] of Object.entries(bakedDirectModelAliases))
    assert.equal(
      resolveDirectModelAlias(` ${alias.toUpperCase()} `, { env: {} }),
      target,
    );
  assert.equal(
    resolveDirectModelAlias("sonnet", {
      env: {},
      familyTarget: () => "claude-sonnet-4-6",
    }),
    "claude-sonnet-4-6",
  );
  assert.equal(
    resolveDirectModelAlias("haiku", {
      env: {},
      familyTarget: () => undefined,
    }),
    "claude-haiku-5-5",
  );
});
test("three isolated original alias controls retain wire/output/reasoning/effort and native context facts", () => {
  for (const [alias, wire] of [
    ["sonnet", "claude-sonnet-5-5"],
    ["haiku", "claude-haiku-5-5"],
    ["sonnet[1m]", "claude-sonnet-5-5"],
  ] as const) {
    const model = resolveDirectModelAlias(alias, { env: {} });
    assert.equal(directModelWireName(model), wire);
    assert.equal(modelFacts(model).defaultOutput, 128000);
    assert.deepEqual(thinkingRequest(model, 128000, {}, {}), {
      type: "adaptive",
    });
    assert.equal(firstPartyQueryEffortFacts(model)?.defaults.catalog, "medium");
    assert.equal(contextWindow(model, {}, {}).window, 1000000);
    assert.equal(contextWindow(model, {}, {}).beta, false);
  }
});
test("defined environment overrides precede host targets without trimming or truthiness fallback", () => {
  for (const value of ["", " ", " custom-wire ", "claude-haiku-4-5-20251001"]) {
    const resolved = resolveDirectModelAlias("haiku", {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: value },
      familyTarget() {
        throw new Error("unexpected host lookup");
      },
    });
    assert.equal(resolved, value);
    assert.equal(directModelWireName(resolved), value);
  }
  assert.equal(
    resolveDirectModelAlias("sonnet", {
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "haiku" },
    }),
    "haiku",
  );
  assert.equal(
    directModelWireName(
      resolveDirectModelAlias("sonnet", {
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "haiku" },
      }),
    ),
    "haiku",
  );
});
test("metadata suffix normalizes native long targets and preserves old-model opt-in independently of wire projection", () => {
  assert.equal(
    resolveDirectModelAlias("sonnet[1m]", { env: {} }),
    "claude-sonnet-5-5",
  );
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6" };
  assert.equal(
    resolveDirectModelAlias("sonnet[1m]", { env }),
    "claude-sonnet-4-6[1m]",
  );
  assert.equal(
    directModelWireName(resolveDirectModelAlias("sonnet[1m]", { env })),
    "claude-sonnet-4-6",
  );
  assert.equal(
    resolveDirectModelAlias("sonnet[1m]", { env, disable1m: true }),
    "claude-sonnet-4-6",
  );
  assert.equal(
    resolveDirectModelAlias("custom[1m][1m]", { env: {} }),
    "custom[1m]",
  );
  assert.equal(
    resolveDirectModelAlias("custom[1m]", { env: {}, nativeLong: () => true }),
    "custom",
  );
  assert.equal(
    directModelWireName("claude-haiku-4-5[1m]"),
    "claude-haiku-4-5-20251001",
  );
});
test("Fable metadata and special account/query aliases retain explicit host boundaries", () => {
  const env = { ANTHROPIC_DEFAULT_FABLE_MODEL: "custom" };
  assert.equal(resolveDirectModelAlias("fable[1m]", { env }), "custom[1m]");
  assert.equal(
    resolveDirectModelAlias("fable[1m]", {
      env,
      authenticatedFirstParty: true,
    }),
    "custom",
  );
  for (const model of ["best", "opusplan"])
    assert.throws(
      () => resolveDirectModelAlias(model, { env: {} }),
      /requires a host/,
    );
  assert.equal(
    resolveDirectModelAlias("opusplan[1m]", {
      env: {},
      specialAlias: () => "claude-sonnet-4-6",
    }),
    "claude-sonnet-4-6[1m]",
  );
  assert.equal(
    resolveDirectModelAlias("best", {
      env: {},
      specialAlias: () => "account-model",
    }),
    "account-model",
  );
  assert.equal(
    resolveDirectModelAlias("claude-opus-4-20250514", { env: {} }),
    "claude-opus-4-20250514",
  );
});
