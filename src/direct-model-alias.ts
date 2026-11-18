import { modelFacts } from "./model-facts.js";

export const directModelFamilies = ["opus", "sonnet", "haiku", "fable"] as const;
export type DirectModelFamily = typeof directModelFamilies[number];
/** Baked first_party alias targets, separate from terminal fallbacks and latest-per-family. */
export const bakedDirectModelAliases: Readonly<Record<DirectModelFamily, string>> = Object.freeze({
  opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-2",
});
export interface DirectModelAliasOptions {
  env?: NodeJS.ProcessEnv;
  disable1m?: boolean;
  /** Source As() gate affects Fable's metadata suffix only. */
  authenticatedFirstParty?: boolean;
  /** Host-resolved served/provider/account family target; undefined uses the baked direct target. */
  familyTarget?(family: DirectModelFamily): string | undefined;
  /** best/account default and opusplan/query-mode behavior require explicit host resolution. */
  specialAlias?(alias: "best" | "opusplan"): string;
  /** Own-name native long context, not opt-in eligibility. Unknown custom models default false. */
  nativeLong?(model: string): boolean;
}
const isDirectModelFamily = (value: string): value is DirectModelFamily => directModelFamilies.some(family => family === value);
const strip1m = (value: string) => value.replace(/\[1m\]/gi, "");
const suffix = (value: string) => value.replace(/(\[1m\])+$/i, "") + "[1m]";

/** Ordinary direct H1 → jt/pY stages. Does not select a query mode, legacy remap or managed model override. */
export function resolveDirectModelAlias(model: string, options: DirectModelAliasOptions = {}): string {
  const env = options.env ?? process.env;
  const disabled = options.disable1m === true;
  const native = (value: string) => {
    const declared = options.nativeLong?.(value);
    if (declared !== undefined) return declared;
    const facts = modelFacts(value), key = value.toLowerCase();
    return facts.recognized && (key === facts.canonical || key === facts.wire.toLowerCase()) && facts.context.native_1m === true;
  };
  const normalizeNative = (value: string) => {
    const bare = strip1m(value);
    return !disabled && bare !== value && native(bare) ? bare : value;
  };
  const input = model.trim(), lower = input.toLowerCase(), hasBracket = lower.includes("[");
  const tagged = hasBracket && !disabled && /\[1m\]/i.test(lower);
  const name = hasBracket ? lower.replace(/\[1m\]$/i, "").trim() : lower;
  let selected: string;
  if (isDirectModelFamily(name)) {
    const family = name, configured = env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`];
    // The source tests definedness: an empty or whitespace override remains an override.
    selected = configured !== undefined ? normalizeNative(configured) : options.familyTarget?.(family) ?? bakedDirectModelAliases[family];
    if (tagged && (family !== "fable" || options.authenticatedFirstParty !== true && !/\[1m\]/i.test(selected))) selected = suffix(selected);
  } else if (name === "best" || name === "opusplan") {
    if (!options.specialAlias) throw new Error(`Model alias ${name} requires a host account/query-mode resolver`);
    selected = options.specialAlias(name);
    if (name === "opusplan" && tagged) selected = suffix(selected);
  } else selected = tagged ? input.replace(/(\[1m\])+$/i, "").trim() + "[1m]" : input;
  return selected.includes("[") ? normalizeNative(selected) : selected;
}

/** Direct XE/ qn projection without managed/provider remapping; unknown override bytes stay intact. */
export function directModelWireName(model: string): string {
  const plain = model.replace(/\[(1|2)m\]/gi, "");
  // Environment model ids are not recursively parsed as family aliases by XE.
  if (isDirectModelFamily(plain.toLowerCase())) return plain;
  const facts = modelFacts(plain);
  return plain === plain.trim() && facts.recognized ? facts.wire : plain;
}
