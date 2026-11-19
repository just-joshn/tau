import type { CatalogPlugin } from "./plugin-catalog.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fold = (value: string) => value.normalize("NFC").toLowerCase();
export function pluginCustomizationOnly(
  value: unknown,
  kind: "skills" | "agents" | "hooks" | "mcp",
): boolean {
  return value === true || (Array.isArray(value) && value.includes(kind));
}
export interface ManagedPluginLock {
  name: string;
  marketplace: string;
  enabled: boolean;
}
export interface ManagedLocalPluginAdmission {
  admitted: boolean;
  reason?: string;
  matched?: ManagedPluginLock;
}

/** Native bare --plugin-dir copies have no marketplace attribution with which to satisfy a managed name lock. */
export function managedLocalPluginAdmission(
  name: string,
  policyEnabledPlugins: unknown,
  options: {
    builtinAliases?: Readonly<Record<string, readonly string[]>>;
  } = {},
): ManagedLocalPluginAdmission {
  if (!record(policyEnabledPlugins)) return { admitted: true };
  const matches: ManagedPluginLock[] = [];
  for (const [key, enabled] of Object.entries(policyEnabledPlugins)) {
    if (typeof enabled !== "boolean" || !key.includes("@")) continue;
    const [declared = "", statedMarketplace = ""] = key.split("@");
    if (!declared) continue;
    const marketplace =
      `${declared}@${statedMarketplace}` === key ? statedMarketplace : "";
    const names = new Set([declared]);
    if (fold(marketplace) === "builtin") {
      for (const [canonical, aliases] of Object.entries(
        options.builtinAliases ?? {},
      )) {
        if (
          [canonical, ...aliases].some(
            (alias) => fold(alias) === fold(declared),
          )
        )
          for (const alias of [canonical, ...aliases]) names.add(alias);
      }
    }
    if ([...names].some((candidate) => fold(candidate) === fold(name)))
      matches.push({ name: declared, marketplace, enabled });
  }
  const matched = matches.find((entry) => !entry.enabled) ?? matches[0];
  if (!matched) return { admitted: true };
  return {
    admitted: false,
    matched,
    reason: matched.enabled
      ? `Managed plugin ${matched.name} requires its attributed marketplace copy; an ordinary local directory cannot claim it`
      : `Managed settings disable plugin ${matched.name}`,
  };
}

export interface PluginDependencyDiagnostic {
  source: string;
  dependency: string;
  reason: "not-found" | "not-enabled" | "unsupported";
  message: string;
}
export interface PluginDependencyResult {
  plugins: readonly CatalogPlugin[];
  diagnostics: readonly PluginDependencyDiagnostic[];
}
interface Dependency {
  name: string;
  marketplace?: string;
  stated: string;
}
const part = /^[A-Za-z0-9][-A-Za-z0-9._]*$/;
function parseDependency(value: unknown): Dependency | undefined {
  if (typeof value === "string") {
    // Version constraints require the native constraint map/semver implementation; never discard them.
    const [name = "", marketplace, extra] = value.split("@");
    if (
      !part.test(name) ||
      extra !== undefined ||
      (marketplace !== undefined && !part.test(marketplace))
    )
      return;
    return {
      name,
      ...(marketplace !== undefined && { marketplace }),
      stated: value,
    };
  }
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !part.test(value.name) ||
    Object.hasOwn(value, "version")
  )
    return;
  if (
    value.marketplace !== undefined &&
    (typeof value.marketplace !== "string" || !part.test(value.marketplace))
  )
    return;
  return {
    name: value.name,
    ...(typeof value.marketplace === "string" && {
      marketplace: value.marketplace,
    }),
    stated: value.marketplace
      ? `${value.name}@${value.marketplace}`
      : value.name,
  };
}
const marketplaceOf = (source: string): string | undefined =>
  source.includes("@") ? source.split("@")[1] : undefined;
const sourceName = (source: string): string => source.split("@")[0] ?? "";

/** Pure fixed-point admission. It never fetches or installs a dependency or mutates catalog records. */
export function resolveLocalPluginDependencies(
  plugins: readonly CatalogPlugin[],
  options: {
    /** Host-owned builtin aliases can canonicalize plugin IDs without reading native personal state. */
    canonicalizeSource?: (source: string) => string;
  } = {},
): PluginDependencyResult {
  const canonical = options.canonicalizeSource ?? ((source: string) => source),
    diagnostics: PluginDependencyDiagnostic[] = [];
  const all = new Set(plugins.map((plugin) => canonical(plugin.source))),
    active = new Set(
      plugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => canonical(plugin.source)),
    );
  const dependencies = new Map<CatalogPlugin, Dependency[]>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const raw = plugin.manifest.dependencies;
    if (raw === undefined) {
      dependencies.set(plugin, []);
      continue;
    }
    const entries = Array.isArray(raw) ? raw : [raw],
      parsed = entries.map(parseDependency);
    if (!Array.isArray(raw) || parsed.some((value) => value === undefined)) {
      active.delete(canonical(plugin.source));
      diagnostics.push({
        source: plugin.source,
        dependency: typeof raw === "string" ? raw : "manifest.dependencies",
        reason: "unsupported",
        message:
          "Plugin dependencies contain an invalid or unsupported version constraint; plugin withheld before registration",
      });
    } else
      dependencies.set(
        plugin,
        parsed.filter((value): value is Dependency => value !== undefined),
      );
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of plugins) {
      const identity = canonical(plugin.source);
      if (!active.has(identity)) continue;
      for (const dependency of dependencies.get(plugin) ?? []) {
        const ownMarketplace = marketplaceOf(plugin.source),
          inherited =
            ownMarketplace &&
            !["inline", "skills-dir", "synced"].includes(ownMarketplace)
              ? ownMarketplace
              : undefined;
        const marketplace = dependency.marketplace ?? inherited;
        const target = canonical(
            marketplace ? `${dependency.name}@${marketplace}` : dependency.name,
          ),
          inline = canonical(`${dependency.name}@inline`);
        const present = (set: Set<string>) =>
          marketplace
            ? set.has(target) || set.has(inline)
            : [...set].some((source) => sourceName(source) === dependency.name);
        if (present(active)) continue;
        active.delete(identity);
        changed = true;
        const reason = present(all) ? "not-enabled" : "not-found";
        diagnostics.push({
          source: plugin.source,
          dependency: marketplace
            ? `${dependency.name}@${marketplace}`
            : dependency.name,
          reason,
          message: `Plugin dependency ${dependency.stated} is ${reason === "not-enabled" ? "not enabled" : "not available"}; plugin withheld before registration`,
        });
        break;
      }
    }
  }
  return {
    plugins: plugins.map((plugin) =>
      plugin.enabled && active.has(canonical(plugin.source))
        ? plugin
        : {
            ...plugin,
            enabled: false,
            components: [],
            enableDecision: plugin.enabled
              ? { enabled: false, source: "dependency-closure" }
              : plugin.enableDecision,
          },
    ),
    diagnostics,
  };
}
