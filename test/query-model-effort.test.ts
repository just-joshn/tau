import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQueryEffortSettings,
  captureQueryRequestModel,
  environmentQueryEffort,
  firstPartyLegacyUserEffortApplies,
  legacyUserQueryEffortApplies,
  matchesLegacyAvailableModels,
  minimumQueryEffortCap,
  normalizeQueryEffort,
  parseQueryEffort,
  queryEffortLabel,
  queryEffortOutputConfig,
  queryEffortSettingsCap,
  resolveQueryEffort,
  resolveQueryModelOverride,
  selectQueryRequestModel,
  sessionQueryEffort,
  type QueryEffortCapabilities,
  type QueryModelContext,
} from "../src/query-model-effort.js";

const all: QueryEffortCapabilities = {
  supported: true,
  xhigh: true,
  max: true,
};
const aliases: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-5-5",
  best: "claude-opus-5-5",
  opusplan: "claude-sonnet-4-6",
};
const identity = (name: string) =>
  (aliases[name.toLowerCase()] ?? name).replace(/\[1m\]$/i, "").toLowerCase();
test("effort frontmatter parsing preserves source named/numeric and environment auto distinctions", () => {
  assert.equal(parseQueryEffort("MED"), "medium");
  assert.equal(parseQueryEffort("17tail"), 17);
  assert.equal(parseQueryEffort(-2), -2);
  assert.equal(parseQueryEffort(" high "), undefined);
  assert.equal(parseQueryEffort(1.5), 1);
  assert.equal(parseQueryEffort("1.5"), 1);
  assert.equal(environmentQueryEffort("UNSET"), null);
  assert.equal(environmentQueryEffort("auto"), null);
  assert.equal(environmentQueryEffort(" auto "), undefined);
  assert.equal(environmentQueryEffort("bad"), undefined);
  assert.equal(queryEffortLabel(17), "high");
  assert.equal(queryEffortLabel(undefined), "high");
  assert.equal(queryEffortLabel("medium"), "medium");
});
test("request effort follows hooks/env/query/session/default precedence and auto suppresses inherited levels", () => {
  const selected = {
    capabilities: all,
    sessionEffort: "low" as const,
    turnEffort: "high" as const,
    defaults: { catalog: "medium" as const },
  };
  assert.equal(resolveQueryEffort(selected), "high");
  assert.equal(
    resolveQueryEffort({ ...selected, environment: "xhigh" }),
    "xhigh",
  );
  assert.equal(
    resolveQueryEffort({
      ...selected,
      environment: "max",
      hookEffort: "medium",
    }),
    "medium",
  );
  assert.equal(
    resolveQueryEffort({ ...selected, environment: "auto" }),
    undefined,
  );
  assert.equal(
    resolveQueryEffort({
      ...selected,
      environment: "auto",
      settingsCap: "high",
    }),
    "medium",
  );
  assert.equal(
    resolveQueryEffort({ ...selected, environment: "broken" }),
    "high",
  );
  assert.equal(
    resolveQueryEffort({
      ...selected,
      capabilities: { ...all, supported: false },
      hookEffort: "max",
    }),
    undefined,
  );
});
test("settings/server capability and learned caps compose, with numeric conversion only for settings caps", () => {
  assert.equal(
    minimumQueryEffortCap(["max", "xhigh", "medium", "high"]),
    "medium",
  );
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      turnEffort: "max",
      settingsCap: "xhigh",
      serverCap: "medium",
    }),
    "medium",
  );
  assert.equal(
    resolveQueryEffort({
      capabilities: { ...all, xhigh: false },
      turnEffort: "xhigh",
    }),
    "high",
  );
  assert.equal(normalizeQueryEffort("max", { ...all, max: false }), "high");
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      turnEffort: 99,
      settingsCap: "medium",
    }),
    "medium",
  );
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      turnEffort: 99,
      serverCap: "medium",
    }),
    99,
  );
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      environment: "max",
      hookEffort: "high",
      learnedCap: "low",
    }),
    "low",
  );
});
test("carried and runtime/model defaults follow source fallback order", () => {
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      defaults: { carried: "medium", firstParty: "high", catalog: "low" },
    }),
    "medium",
  );
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      defaults: { carried: "medium", firstParty: "low", runtime: "max" },
    }),
    "low",
  );
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      defaults: { carried: "medium", runtime: "max", release: "high" },
    }),
    "max",
  );
  assert.equal(resolveQueryEffort({ capabilities: all }), "high");
});
test("admitted settings table resolves per-model precedence and an explicit later global level", () => {
  const table = buildQueryEffortSettings(
    [
      {
        source: "userSettings",
        effortLevel: "high",
        modelSettings: { sonnet: { effortLevel: "low" } },
      },
      {
        source: "projectSettings",
        effortLevel: "medium",
        modelSettings: { sonnet: { effortLevel: "xhigh" } },
      },
      { source: "policySettings", effortLevel: "low" },
    ],
    identity,
  );
  assert.equal(table.default, "low");
  assert.equal(table.legacyUserEffort, undefined);
  assert.equal(table.byModel[identity("sonnet")], "low");
  assert.equal(sessionQueryEffort({ table, model: "sonnet", identity }), "low");
  const canonical = buildQueryEffortSettings(
    [
      {
        source: "userSettings",
        modelSettings: {
          sonnet: { effortLevel: "low" },
          "claude-sonnet-4-6": { effortLevel: "high" },
        },
      },
    ],
    identity,
  );
  assert.equal(canonical.byModel[identity("sonnet")], "high");
  const invalid = buildQueryEffortSettings(
    [
      { source: "userSettings", effortLevel: "high" },
      { source: "projectSettings", effortLevel: "invalid" },
    ],
    identity,
  );
  assert.equal(invalid.legacyUserEffort, undefined);
  assert.equal(invalid.default, undefined);
});
test("a model switch clears explicit session effort while query overlays can still select effort", () => {
  const table = buildQueryEffortSettings(
    [{ source: "projectSettings", effortLevel: "medium" }],
    identity,
  );
  const session = { kind: "level" as const, value: "max" as const };
  assert.equal(
    sessionQueryEffort({
      session,
      table,
      model: "sonnet",
      pickedModel: "claude-sonnet-4-6",
      identity,
    }),
    "max",
  );
  const selected = sessionQueryEffort({
    session,
    table,
    model: "opus",
    pickedModel: "sonnet",
    identity,
  });
  assert.equal(selected, "medium");
  assert.equal(
    resolveQueryEffort({
      capabilities: all,
      sessionEffort: selected,
      turnEffort: "high",
    }),
    "high",
  );
  assert.equal(
    sessionQueryEffort({
      table,
      model: "sonnet",
      identity,
      holdSettingsDefault: true,
    }),
    undefined,
  );
  const legacy = buildQueryEffortSettings(
    [{ source: "userSettings", effortLevel: "low" }],
    identity,
  );
  assert.equal(
    sessionQueryEffort({
      table: legacy,
      model: "sonnet",
      identity,
      legacyUserApplies: false,
    }),
    undefined,
  );
});
test("per-source model cap overrides its global cap and caps then intersect across sources", () => {
  const layers = [
    {
      source: "projectSettings",
      maxEffortLevel: "low",
      modelSettings: { sonnet: { maxEffortLevel: "max" } },
    },
    { source: "policySettings", maxEffortLevel: "high" },
  ];
  assert.equal(queryEffortSettingsCap(layers, "sonnet", identity), "high");
  assert.equal(queryEffortSettingsCap(layers, "opus", identity), "low");
});

test("legacy user effort uses its exact model migration set and explicit host identity parsing", () => {
  assert.equal(firstPartyLegacyUserEffortApplies("claude-opus-4-7"), true);
  assert.equal(firstPartyLegacyUserEffortApplies("claude-sonnet-5"), true);
  assert.equal(firstPartyLegacyUserEffortApplies("claude-opus-5-5"), false);
  assert.equal(firstPartyLegacyUserEffortApplies("claude-fable-5-2"), false);
  assert.equal(firstPartyLegacyUserEffortApplies("custom-model"), undefined);
  assert.equal(
    legacyUserQueryEffortApplies("custom-model", () => false),
    true,
  );
  assert.equal(
    legacyUserQueryEffortApplies("claude-opus-99", () => true),
    false,
  );
});
test("wire projection emits named effort, preserves explicit extra body and respects disabled thinking and refusal", () => {
  assert.deepEqual(
    queryEffortOutputConfig({ effort: "xhigh", capabilities: all }),
    { outputConfig: { effort: "xhigh" }, needsEffortBeta: true },
  );
  assert.deepEqual(queryEffortOutputConfig({ effort: 17, capabilities: all }), {
    outputConfig: {},
    needsEffortBeta: false,
  });
  assert.deepEqual(queryEffortOutputConfig({ capabilities: all }), {
    outputConfig: {},
    needsEffortBeta: true,
  });
  const existing = { effort: "max", format: { type: "json_schema" } };
  assert.deepEqual(
    queryEffortOutputConfig({ effort: "low", capabilities: all, existing })
      .outputConfig,
    existing,
  );
  assert.equal(
    queryEffortOutputConfig({
      effort: "max",
      capabilities: all,
      thinkingDisabled: true,
      mechanicallyDisabled: true,
    }).outputConfig.effort,
    "high",
  );
  assert.equal(
    queryEffortOutputConfig({
      effort: "xhigh",
      capabilities: { ...all, capsWhenThinkingDisabled: true },
      thinkingDisabled: true,
    }).outputConfig.effort,
    "high",
  );
  assert.equal(
    queryEffortOutputConfig({
      effort: "max",
      capabilities: all,
      thinkingDisabled: true,
    }).outputConfig.effort,
    "max",
  );
  assert.equal(
    queryEffortOutputConfig({
      capabilities: { ...all, supported: false },
      existing,
    }).outputConfig.effort,
    undefined,
  );
  assert.equal(
    queryEffortOutputConfig({
      effort: "max",
      capabilities: all,
      effortRefused: true,
    }).outputConfig.effort,
    undefined,
  );
  assert.equal(existing.effort, "max");
});
test("legacy availableModels uses boundary prefixes/families, narrowing and reverse model overrides", () => {
  const options = { resolveAlias: identity };
  assert.equal(
    matchesLegacyAvailableModels("claude-sonnet-4-6", undefined, options),
    true,
  );
  assert.equal(
    matchesLegacyAvailableModels("claude-sonnet-4-6", [], options),
    false,
  );
  assert.equal(
    matchesLegacyAvailableModels("claude-sonnet-4-6", ["sonnet"], options),
    true,
  );
  assert.equal(
    matchesLegacyAvailableModels(
      "claude-sonnet-4-6",
      ["sonnet", "claude-sonnet-4-5"],
      options,
    ),
    false,
  );
  assert.equal(
    matchesLegacyAvailableModels(
      "claude-sonnet-4-5-20250929",
      ["sonnet-4-5"],
      options,
    ),
    true,
  );
  assert.equal(
    matchesLegacyAvailableModels("claude-sonnet-4-50", ["sonnet-4-5"], options),
    false,
  );
  assert.equal(
    matchesLegacyAvailableModels("claude-sonnet-4-6", ["son*"], options),
    false,
  );
  assert.equal(
    matchesLegacyAvailableModels("private-id", ["sonnet-4-5"], {
      ...options,
      overrides: { "claude-sonnet-4-5": "private-id" },
    }),
    true,
  );
  assert.equal(
    matchesLegacyAvailableModels("claude-opus-5-5", ["best"], options),
    true,
  );
});
test("model overlay preserves declaration, respects admission, carries opt-in context and resolves native context", () => {
  const context = (model: string): QueryModelContext => ({
    explicit1m: /\[1m\]/i.test(model),
    nativeLong: identity(model) === "claude-opus-5-5",
    believedLong: false,
    supports1m: identity(model) === "claude-sonnet-4-6",
  });
  const base = {
    declared: "sonnet",
    current: "claude-opus-5-5",
    resolveAlias: identity,
    context,
    available: () => true,
  };
  assert.equal(resolveQueryModelOverride(base).model, "sonnet[1m]");
  assert.equal(
    resolveQueryModelOverride({
      ...base,
      declared: "opus",
      current: "sonnet[1m]",
    }).model,
    "claude-opus-5-5",
  );
  assert.equal(
    resolveQueryModelOverride({ ...base, declared: "sonnet[1m]" }).model,
    "sonnet[1m]",
  );
  assert.deepEqual(
    resolveQueryModelOverride({ ...base, declared: "inherit" }),
    {},
  );
  assert.equal(
    resolveQueryModelOverride({ ...base, available: () => false }).refusal,
    "available_models",
  );
  assert.equal(
    resolveQueryModelOverride({ ...base, available: () => false }).model,
    base.current,
  );
  assert.equal(
    resolveQueryModelOverride({
      ...base,
      available: () => false,
      isCurrentDefault: () => true,
    }).refusal,
    undefined,
  );
  assert.equal(
    resolveQueryModelOverride({ ...base, automaticModeAdmits: () => false })
      .model,
    undefined,
  );
});

test("query entry captures API model while later skill context and effort remain distinct", () => {
  let contextModel = "sonnet";
  const frame = captureQueryRequestModel(contextModel);
  contextModel = "haiku";
  const laterRequest = {
    model: selectQueryRequestModel(frame),
    output_config: queryEffortOutputConfig({
      effort: resolveQueryEffort({ capabilities: all, turnEffort: "low" })!,
      capabilities: all,
    }).outputConfig,
  };
  assert.equal(contextModel, "haiku");
  assert.equal(laterRequest.model, "sonnet");
  assert.equal(laterRequest.output_config.effort, "low");
  assert.equal(
    selectQueryRequestModel(captureQueryRequestModel(contextModel)),
    "haiku",
  );
  assert.equal(
    selectQueryRequestModel(frame, {
      chainModel: "fallback",
      liveSwitchOverride: "live",
      consentOverride: "consent",
      refusalOverride: "refusal",
    }),
    "refusal",
  );
  assert.equal(
    selectQueryRequestModel(frame, {
      chainModel: "fallback",
      liveSwitchOverride: "live",
      consentOverride: "consent",
    }),
    "consent",
  );
  assert.equal(
    selectQueryRequestModel(frame, {
      chainModel: "fallback",
      liveSwitchOverride: "live",
    }),
    "live",
  );
  assert.equal(
    selectQueryRequestModel(frame, { chainModel: "fallback" }),
    "fallback",
  );
  assert.equal(Object.isFrozen(frame), true);
});
