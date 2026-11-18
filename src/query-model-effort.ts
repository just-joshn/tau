import { modelFacts } from "./model-facts.js";

/** Deterministic query overlays reconstructed from the pinned CLI consumers. */
export const queryEffortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
export type QueryEffortLevel = typeof queryEffortLevels[number];
export type QueryEffort = QueryEffortLevel | number;
export function isQueryEffortLevel(value: unknown): value is QueryEffortLevel { return queryEffortLevels.some(level => level === value); }
export function parseQueryEffort(value: unknown): QueryEffort | undefined {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const raw = String(value).toLowerCase(), named = raw === "med" ? "medium" : raw;
  if (isQueryEffortLevel(named)) return named;
  const number = Number.parseInt(raw, 10);
  return Number.isInteger(number) ? number : undefined;
}
export function environmentQueryEffort(value: string | undefined): QueryEffort | null | undefined {
  return value?.toLowerCase() === "auto" || value?.toLowerCase() === "unset" ? null : parseQueryEffort(value);
}
/** Source CL/BM label used by skill variables; numeric/absent effort displays high. */
export function queryEffortLabel(value: QueryEffort | undefined): QueryEffortLevel { return typeof value === "string" ? value : "high"; }
const rank = (effort: QueryEffortLevel) => queryEffortLevels.indexOf(effort);
export function minimumQueryEffortCap(caps: readonly (QueryEffortLevel | null | undefined)[]): QueryEffortLevel | undefined {
  return caps.filter((value): value is QueryEffortLevel => value !== undefined && value !== null && value !== "max").sort((a, b) => rank(a) - rank(b))[0];
}
export interface QueryEffortCapabilities { supported: boolean; max: boolean; xhigh: boolean; capsWhenThinkingDisabled?: boolean }
/** Pinned ordinary first-party fallback facts, excluding account/env capability overrides. */
export function firstPartyQueryEffortFacts(model: string): { capabilities: QueryEffortCapabilities; defaults: { catalog: QueryEffortLevel } } | undefined {
  // Account aliases and custom/provider identities require host resolution first.
  if (!model.trim().toLowerCase().startsWith("claude-")) return;
  const facts = modelFacts(model);
  if (!facts.recognized) return;
  const canonical = facts.canonical;
  const supported = !canonical.includes("claude-3-") && !["claude-opus-4-0", "claude-opus-4-1", "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-haiku-4-5"].includes(canonical);
  const max = supported && canonical !== "claude-opus-4-5";
  const xhigh = max && canonical !== "claude-opus-4-6" && canonical !== "claude-sonnet-4-6";
  const catalog = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-mythos-5-2"].includes(canonical) ? "medium" : canonical === "claude-opus-4-7" ? "xhigh" : "high";
  return { capabilities: { supported, max, xhigh, capsWhenThinkingDisabled: canonical === "claude-opus-5" }, defaults: { catalog } };
}
export function normalizeQueryEffort(value: QueryEffort, capabilities: QueryEffortCapabilities, cap?: QueryEffortLevel): QueryEffort {
  if (typeof value === "number") return value;
  let result = cap !== undefined && rank(value) > rank(cap) ? cap : value;
  if (result === "max" && !capabilities.max || result === "xhigh" && !capabilities.xhigh) result = "high";
  return result;
}
export interface QueryEffortSelection {
  capabilities: QueryEffortCapabilities;
  hookEffort?: QueryEffort;
  environment?: string;
  turnEffort?: QueryEffort;
  sessionEffort?: QueryEffort;
  /** Presence of a settings cap also converts numeric effort to high before clamping. */
  settingsCap?: QueryEffortLevel;
  serverCap?: QueryEffortLevel;
  learnedCap?: QueryEffortLevel;
  defaults?: { carried?: QueryEffort; firstParty?: QueryEffort; runtime?: QueryEffort; release?: QueryEffort; capability?: QueryEffort; catalog?: QueryEffort };
}
/** Hook > environment > query layer > session/settings > model default, then caps. */
export function resolveQueryEffort(options: QueryEffortSelection): QueryEffort | undefined {
  if (!options.capabilities.supported) return;
  const cap = minimumQueryEffortCap([options.settingsCap, options.serverCap]);
  const normalize = (effort: QueryEffort) => normalizeQueryEffort(typeof effort === "number" && options.settingsCap !== undefined && options.settingsCap !== "max" ? "high" : effort, options.capabilities, cap);
  let value: QueryEffort;
  if (options.hookEffort !== undefined) value = normalize(options.hookEffort);
  else {
    const env = environmentQueryEffort(options.environment);
    if (env === null && (options.settingsCap === undefined || options.settingsCap === "max")) return;
    const d = options.defaults ?? {};
    const fallback = (d.runtime === undefined ? d.carried : undefined) ?? d.firstParty ?? d.runtime ?? d.release ?? d.capability ?? d.catalog ?? "high";
    value = normalize(env ?? (env === null ? fallback : undefined) ?? options.turnEffort ?? options.sessionEffort ?? fallback);
  }
  const learned = options.learnedCap === "xhigh" && !options.capabilities.xhigh ? "high" : options.learnedCap;
  return typeof value === "string" && learned !== undefined && rank(value) > rank(learned) ? learned : value;
}

export interface QueryEffortSettingsLayer {
  source: string;
  effortLevel?: unknown;
  modelSettings?: Readonly<Record<string, { effortLevel?: unknown; maxEffortLevel?: unknown } | undefined>>;
  maxEffortLevel?: unknown;
}
export interface QueryEffortSettingsTable { default?: QueryEffortLevel; legacyUserEffort?: QueryEffortLevel; byModel: Record<string, QueryEffortLevel | undefined> }
const legacyUserEffortModels = new Set(["claude-3-5-haiku", "claude-3-5-sonnet", "claude-3-7-sonnet", "claude-haiku-4-5", "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1"]);
/** Source xoi: unknown/custom non-model identities retain the legacy fallback. */
export function legacyUserQueryEffortApplies(canonicalModel: string, isParsedModelIdentity: (model: string) => boolean): boolean {
  return legacyUserEffortModels.has(canonicalModel) || !isParsedModelIdentity(canonicalModel);
}
/** Known pinned first-party IDs only; migration pins still belong to host state. */
export function firstPartyLegacyUserEffortApplies(model: string): boolean | undefined {
  if (!model.trim().toLowerCase().startsWith("claude-")) return;
  const facts = modelFacts(model);
  return facts.recognized ? legacyUserEffortModels.has(facts.canonical) : undefined;
}
const settingsLevel = (value: unknown): QueryEffortLevel | undefined => value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
/** Admitted layers in increasing precedence; identity resolution belongs to the host. */
export function buildQueryEffortSettings(layers: readonly QueryEffortSettingsLayer[], identity: (model: string) => string): QueryEffortSettingsTable {
  let legacy: QueryEffortLevel | undefined, defaultLevel: QueryEffortLevel | undefined, hasDefault = false;
  const perLayer = layers.map(layer => {
    if (layer.source === "userSettings") legacy = settingsLevel(layer.effortLevel);
    else if (Object.hasOwn(layer, "effortLevel")) { hasDefault = true; defaultLevel = settingsLevel(layer.effortLevel); }
    const mapped = new Map<string, QueryEffortLevel | undefined>();
    for (const [name, settings] of Object.entries(layer.modelSettings ?? {})) {
      if (settings?.effortLevel === undefined) continue;
      const key = identity(name);
      if (key === name || !mapped.has(key)) mapped.set(key, settingsLevel(settings.effortLevel));
    }
    return { layer, mapped };
  });
  const byModel: Record<string, QueryEffortLevel | undefined> = {};
  Object.setPrototypeOf(byModel, null);
  const keys = new Set(perLayer.flatMap(({ mapped }) => [...mapped.keys()]));
  for (const key of keys) for (const { layer, mapped } of [...perLayer].reverse()) {
    if (mapped.has(key)) { byModel[key] = mapped.get(key); break; }
    if (layer.source !== "userSettings" && Object.hasOwn(layer, "effortLevel")) { byModel[key] = settingsLevel(layer.effortLevel); break; }
  }
  return { ...(defaultLevel === undefined ? {} : { default: defaultLevel }), ...(!hasDefault && legacy !== undefined ? { legacyUserEffort: legacy } : {}), byModel };
}
export function queryEffortSettingsCap(layers: readonly QueryEffortSettingsLayer[], model: string, identity: (model: string) => string): QueryEffortLevel | undefined {
  const key = identity(model);
  return minimumQueryEffortCap(layers.map(layer => {
    const matching = Object.entries(layer.modelSettings ?? {}).filter(([name]) => identity(name) === key).map(([, settings]) => settings?.maxEffortLevel).filter(isQueryEffortLevel);
    return matching.length ? [...matching].sort((a, b) => rank(a) - rank(b))[0] : (isQueryEffortLevel(layer.maxEffortLevel) ? layer.maxEffortLevel : undefined);
  }));
}
export type SessionQueryEffort = { kind: "level"; value: QueryEffort } | { kind: "inherit" | "default" };
export function sessionQueryEffort(options: { session?: SessionQueryEffort; table?: QueryEffortSettingsTable; model: string; pickedModel?: string; identity(model: string): string; holdSettingsDefault?: boolean; legacyUserApplies?: boolean }): QueryEffort | undefined {
  let session = options.session ?? { kind: "inherit" };
  if (session.kind === "level" && options.pickedModel !== undefined && options.identity(options.model) !== options.identity(options.pickedModel)) session = { kind: "inherit" };
  if (session.kind === "level") return session.value;
  if (session.kind === "default" || options.holdSettingsDefault || !options.table) return;
  const key = options.identity(options.model), table = options.table;
  if (Object.hasOwn(table.byModel, key)) return table.byModel[key];
  return table.default ?? (options.legacyUserApplies === false ? undefined : table.legacyUserEffort);
}

export function queryEffortOutputConfig(options: { effort?: QueryEffort; capabilities: QueryEffortCapabilities; existing?: Readonly<Record<string, unknown>>; thinkingDisabled?: boolean; mechanicallyDisabled?: boolean; effortRefused?: boolean }): { outputConfig: Record<string, unknown>; needsEffortBeta: boolean } {
  const outputConfig = { ...options.existing };
  let needsEffortBeta = false;
  if (!options.capabilities.supported) delete outputConfig.effort;
  else if (!Object.hasOwn(outputConfig, "effort")) {
    if (options.effort === undefined) needsEffortBeta = true;
    else if (typeof options.effort === "string") { outputConfig.effort = options.effort; needsEffortBeta = true; }
  }
  if (options.effortRefused) { delete outputConfig.effort; needsEffortBeta = false; }
  if (options.thinkingDisabled && (options.mechanicallyDisabled || options.capabilities.capsWhenThinkingDisabled) && isQueryEffortLevel(outputConfig.effort) && rank(outputConfig.effort) > rank("high")) outputConfig.effort = "high";
  return { outputConfig, needsEffortBeta };
}

export interface QueryModelContext { explicit1m: boolean; nativeLong: boolean; believedLong: boolean; supports1m: boolean }
export interface QueryRequestModelFrame { readonly primaryModel: string; readonly chainModel?: string }
/** Capture once after user slash expansion and before the query's first request. */
export function captureQueryRequestModel(primaryModel: string, chainModel?: string): QueryRequestModelFrame {
  return Object.freeze({ primaryModel, ...(chainModel === undefined ? {} : { chainModel }) });
}
/** Inline Skill metadata does not rewrite this scheduler snapshot. */
export function selectQueryRequestModel(frame: QueryRequestModelFrame, latches: { refusalOverride?: string; consentOverride?: string; liveSwitchOverride?: string; chainModel?: string } = {}): string {
  return latches.refusalOverride ?? latches.consentOverride ?? latches.liveSwitchOverride ?? latches.chainModel ?? frame.chainModel ?? frame.primaryModel;
}
export interface QueryModelOverrideOptions {
  declared?: string; current: string;
  resolveAlias(model: string): string;
  context(model: string): QueryModelContext;
  available(resolvedModel: string): boolean;
  /** Source Fk accepts the ordinary current-default model before bo. */
  isCurrentDefault?(resolvedModel: string): boolean;
  /** Source JGe automatic-mode/fast-mode arbitration, applied before Qor. */
  automaticModeAdmits?(resolvedModel: string): boolean;
}
export function resolveQueryModelOverride(options: QueryModelOverrideOptions): { model?: string; resolvedModel?: string; refusal?: "automatic_mode" | "available_models" } {
  if (options.declared === undefined || options.declared === "inherit") return {};
  const declared = options.declared, resolvedModel = options.resolveAlias(declared);
  if (options.automaticModeAdmits?.(resolvedModel) === false) return { resolvedModel, refusal: "automatic_mode" };
  if (!options.isCurrentDefault?.(resolvedModel) && !options.available(resolvedModel)) return { model: options.current, resolvedModel, refusal: "available_models" };
  const current = options.context(options.current), target = options.context(declared);
  if (target.explicit1m || !(current.explicit1m || current.nativeLong || current.believedLong)) return { model: declared, resolvedModel };
  const resolved = options.context(resolvedModel);
  if (resolved.nativeLong || resolved.believedLong) return { model: resolvedModel, resolvedModel };
  return { model: (current.explicit1m || current.nativeLong) && resolved.supports1m ? declared + "[1m]" : declared, resolvedModel };
}

/** Plain first-party legacy availableModels matching after alias resolution.
 * Exact-mode, deniedModels, entitlements and provider-specific identities belong
 * to the host's full model-admission callback, not to this bounded helper.
 */
export function matchesLegacyAvailableModels(model: string, allowlist: readonly string[] | undefined, options: { resolveAlias(model: string): string; overrides?: Readonly<Record<string, string>> }): boolean {
  if (allowlist === undefined) return true;
  const clean = (value: string) => value.trim().toLowerCase().replace(/\[1m\]$/i, "");
  const aliases = new Set(["sonnet", "opus", "haiku", "fable", "best", "opusplan"]), families = new Set(["sonnet", "opus", "haiku", "fable"]);
  const entries = allowlist.map(clean);
  let candidate = clean(model);
  for (const [identity, wire] of Object.entries(options.overrides ?? {})) if (clean(wire) === candidate) { candidate = clean(identity); break; }
  if (entries.includes(candidate) && !families.has(candidate)) return true;
  const boundaryPrefix = (value: string, prefix: string) => value === prefix || value.startsWith(prefix + "-");
  for (const entry of entries) {
    if (families.has(entry)) {
      const narrowed = entries.some(other => !families.has(other) && (() => { const at = other.indexOf(entry); return at >= 0 && (at + entry.length === other.length || other[at + entry.length] === "-"); })());
      if (!narrowed && candidate.split(/[^a-z0-9]+/).includes(entry)) return true;
    } else if (aliases.has(entry)) { if (clean(options.resolveAlias(entry)) === candidate) return true; }
    else if (entry && (boundaryPrefix(candidate, entry) || !entry.startsWith("claude-") && boundaryPrefix(candidate, "claude-" + entry))) return true;
  }
  return false;
}
