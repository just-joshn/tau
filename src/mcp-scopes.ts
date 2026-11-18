import { dirname, join, parse, resolve } from "node:path";
import { nullRecord, sanitizeMcpName } from "./mcp-config.js";

export type McpSettingsSource =
  "userSettings" | "projectSettings" | "localSettings";
export type McpScope =
  "user" | "project" | "local" | "managed" | "enterprise" | "dynamic";
/** Already validated/expanded transport configuration. Selection does not dial or read files. */
export interface McpScopeConfig {
  type?: string;
  command?: string;
  args?: readonly string[];
  url?: string;
  headers?: Readonly<Record<string, string>>;
  expandedFromEnv?: boolean;
  pluginSource?: string;
}
/** Tit/w5s: mark enterprise env references before expansion; stdio env values do not count. */
export function enterpriseMcpConfigUsesEnvironment(
  config: McpScopeConfig,
): boolean {
  const hasReference = (value: string): boolean =>
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/.test(value);
  switch (config.type) {
    case undefined:
    case "stdio":
      return (
        (typeof config.command === "string" && hasReference(config.command)) ||
        (config.args ?? []).some(hasReference)
      );
    case "sse":
    case "http":
    case "ws":
      return (
        (typeof config.url === "string" && hasReference(config.url)) ||
        Object.values(config.headers ?? {}).some(hasReference)
      );
    default:
      return false;
  }
}
export interface McpScopeDocument<T extends McpScopeConfig = McpScopeConfig> {
  servers: Readonly<Record<string, T>>;
  path?: string;
}
export interface McpSelectedServer<T extends McpScopeConfig = McpScopeConfig> {
  config: T;
  scope: McpScope;
  path?: string;
}
export interface McpReadPlanOptions {
  cwd: string;
  globalConfigPath: string;
  managedRoot?: string;
  projectConfigRoot?: string;
  enabledSources?: readonly McpSettingsSource[];
  /** Caller supplies source-specific connector-download and excluded-directory decisions. */
  excludedProjectDirectories?: readonly string[];
  diskless?: boolean;
  localSettingsEnabled?: boolean;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** fe/Jl projections. Workspace identity is supplied after the caller's canonicalization. */
export function extractMcpGlobalScopeValues(
  global: unknown,
  workspaceKey: string,
): {
  user: unknown;
  local: unknown;
  disabledNames: string[];
  enabledNames: string[];
} {
  const config = object(global) ? global : {};
  const local =
    object(config.projects) && object(config.projects[workspaceKey])
      ? config.projects[workspaceKey]
      : {};
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  return {
    user: config.mcpServers,
    local: local.mcpServers,
    disabledNames: names(local.disabledMcpServers),
    enabledNames: names(local.enabledMcpServers),
  };
}

/** TIt: global mcpServers and projects[workspaceKey].mcpServers are not settings.json. */
export function planMcpScopeReads(options: McpReadPlanOptions): {
  globalConfigPath?: string;
  readUser: boolean;
  readLocal: boolean;
  projectFiles: string[];
  enterpriseFile?: string;
} {
  const enabled = new Set(
    options.enabledSources ?? [
      "userSettings",
      "projectSettings",
      "localSettings",
    ],
  );
  const readUser = enabled.has("userSettings");
  const readLocal =
    options.localSettingsEnabled ?? enabled.has("localSettings");
  const projectFiles: string[] = [];
  if (enabled.has("projectSettings") && !options.diskless) {
    const excluded = new Set(
      (options.excludedProjectDirectories ?? []).map((path) => resolve(path)),
    );
    for (
      let directory = resolve(options.projectConfigRoot ?? options.cwd);
      directory !== parse(directory).root;
      directory = dirname(directory)
    ) {
      if (!excluded.has(directory))
        projectFiles.push(join(directory, ".mcp.json"));
    }
    projectFiles.reverse();
  }
  return {
    ...(readUser || readLocal
      ? { globalConfigPath: resolve(options.globalConfigPath) }
      : {}),
    readUser,
    readLocal,
    projectFiles,
    ...(options.managedRoot
      ? {
          enterpriseFile: join(
            resolve(options.managedRoot),
            "managed-mcp.json",
          ),
        }
      : {}),
  };
}

export interface McpApprovalSettings {
  enabledMcpjsonServers?: readonly string[];
  disabledMcpjsonServers?: readonly string[];
  enableAllProjectMcpServers?: boolean;
}
export interface McpProjectApproval {
  workspaceTrusted: boolean;
  /** Effective settings, including repository values; rejection is checked here first. */
  settings?: McpApprovalSettings;
  /** hho: caller excludes untrusted project/local documents before supplying these. */
  visibleTrustedSettings?: readonly McpApprovalSettings[];
  sessionApprovedNames?: readonly string[];
  /** Source defaults to exact approval names; old feature-gated behavior is explicit. */
  legacyApprovalNames?: boolean;
  nonInteractive?: boolean;
  requireExplicitApproval?: boolean;
  bypassApproved?: boolean;
}
function legacyNameMatch(left: string, right: string): boolean {
  return (
    left === right ||
    (!left.startsWith("plugin:") &&
      !right.startsWith("plugin:") &&
      sanitizeMcpName(left) === sanitizeMcpName(right))
  );
}
/** sWt/cIt: rejection wins even in noninteractive/bypass sessions. */
export function projectMcpApproval(
  name: string,
  approval: McpProjectApproval,
  projectSettingsEnabled = true,
): "approved" | "pending" | "rejected" {
  const settings = approval.settings;
  if (
    settings?.disabledMcpjsonServers?.some((entry) =>
      legacyNameMatch(entry, name),
    )
  )
    return "rejected";
  const matches = (entry: string): boolean =>
    approval.legacyApprovalNames
      ? legacyNameMatch(entry, name)
      : entry === name;
  const admits = (value: McpApprovalSettings): boolean =>
    value.enableAllProjectMcpServers === true ||
    value.enabledMcpjsonServers?.some(matches) === true;
  const approved = approval.workspaceTrusted
    ? settings !== undefined && admits(settings)
    : approval.sessionApprovedNames?.some(matches) === true ||
      approval.visibleTrustedSettings?.some(admits) === true;
  if (approved) return "approved";
  if (
    !approval.requireExplicitApproval &&
    projectSettingsEnabled &&
    (approval.nonInteractive || approval.bypassApproved)
  )
    return "approved";
  return "pending";
}

export type McpServerRule =
  | { serverName: string }
  | { serverCommand: readonly string[] }
  | { serverUrl: string };
export interface McpPolicySettings {
  allowManagedMcpServersOnly?: boolean;
  allowedMcpServers?: readonly McpServerRule[];
  deniedMcpServers?: readonly McpServerRule[];
}
/** yIt/_It/UVe/SZe: administrator locks and durable denies outlive ordinary shadowing. */
export function selectMcpPolicyRules(
  effective: McpPolicySettings,
  policy: McpPolicySettings = {},
  adminTiers: readonly McpPolicySettings[] = [],
  durableTiers: readonly McpPolicySettings[] = adminTiers,
): {
  managedOnly: boolean;
  allowRules?: readonly McpServerRule[];
  denyRules: McpServerRule[];
} {
  const managedOnly =
    policy.allowManagedMcpServersOnly === true ||
    adminTiers.some((tier) => tier.allowManagedMcpServersOnly === true);
  const allowRules = managedOnly
    ? (policy.allowedMcpServers ??
      adminTiers.find((tier) => tier.allowedMcpServers !== undefined)
        ?.allowedMcpServers)
    : effective.allowedMcpServers;
  const unique = new Set<string>();
  const denyRules = [
    ...(effective.deniedMcpServers ?? []),
    ...durableTiers.flatMap((tier) => tier.deniedMcpServers ?? []),
  ].filter((rule) => {
    const key = JSON.stringify(rule);
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });
  return {
    managedOnly,
    ...(allowRules !== undefined ? { allowRules } : {}),
    denyRules,
  };
}
export interface McpPolicyVariants {
  /** Alternative representations; every variant in one group must be covered by allow rules. */
  allowCommandGroups?: readonly (readonly (readonly string[])[])[];
  denyCommands?: readonly (readonly string[])[];
  allowUrls?: readonly string[];
  denyUrls?: readonly string[];
}
function wildcard(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  const prefix = parts[0] ?? "",
    suffix = parts.at(-1) ?? "";
  if (
    !value.startsWith(prefix) ||
    !value.endsWith(suffix) ||
    value.length < prefix.length + suffix.length
  )
    return false;
  let position = prefix.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, position);
    if (found < 0 || found + part.length > value.length - suffix.length)
      return false;
    position = found + part.length;
  }
  return true;
}
function slashWildcard(pattern: string, value: string): boolean {
  const left = pattern.split("/"),
    right = value.split("/");
  return (
    left.length === right.length &&
    left.every((part, index) => wildcard(part, right[index] ?? ""))
  );
}
/** tvt: only * is a wildcard; a bare origin covers all paths, an origin ending / does not. */
export function matchesMcpServerUrl(actual: string, pattern: string): boolean {
  if (pattern === "*") return true;
  let target: URL;
  try {
    target = new URL(actual);
  } catch {
    return false;
  }
  let marker = "zzmcpwildcardzz";
  while ((actual + pattern).toLowerCase().includes(marker)) marker += "z";
  let punycodeMarker = "zzmcppunycodezz";
  while ((actual + pattern).toLowerCase().includes(punycodeMarker))
    punycodeMarker += "z";
  const encoded = pattern
    .replaceAll("*", marker)
    .replace(/[a-z0-9-]+/gi, (label) =>
      /^xn--/i.test(label) && label.includes(marker)
        ? punycodeMarker + label
        : label,
    );
  let expected: URL | undefined,
    anyPort = false;
  try {
    expected = new URL(encoded);
  } catch {
    const withPort = encoded.replace(new RegExp(`:${marker}(?=[/?#]|$)`), ":0");
    if (withPort !== encoded)
      try {
        expected = new URL(withPort);
        anyPort = true;
      } catch {
        /* fallback below */
      }
  }
  const protocols = new Set([
    "http:",
    "https:",
    "ws:",
    "wss:",
    "ftp:",
    "file:",
  ]);
  if (
    !expected ||
    (protocols.has(expected.protocol) &&
      expected.hostname
        .split(".")
        .some((part) => part.startsWith("xn--") && part.includes(marker)))
  ) {
    return slashWildcard(
      pattern,
      `${target.protocol}//${target.host}${target.pathname}${target.search}`,
    );
  }
  if (
    expected.protocol !== `${marker}:` &&
    expected.protocol !== target.protocol
  )
    return false;
  const decode = (value: string): string =>
    value.replaceAll(punycodeMarker, "").replaceAll(marker, "*");
  if (
    !wildcard(
      decode(expected.hostname).replace(/\.$/, "").toLowerCase(),
      target.hostname.replace(/\.$/, "").toLowerCase(),
    )
  )
    return false;
  if (!expected.port && expected.hostname.includes(marker)) anyPort = true;
  if (!anyPort && expected.port !== target.port) return false;
  if (
    (expected.pathname === "/" || expected.pathname === "") &&
    !expected.search &&
    !encoded.endsWith("/")
  )
    return true;
  return wildcard(
    decode(expected.pathname + expected.search),
    target.pathname + target.search,
  );
}
const sameCommand = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
function stdioCommand(config: McpScopeConfig): readonly string[] | undefined {
  return (config.type === undefined || config.type === "stdio") &&
    typeof config.command === "string"
    ? [config.command, ...(config.args ?? [])]
    : undefined;
}

/** sT/Fgo. Rules and variants must already use the caller's policy-safe environment expansion. */
export function mcpServerPolicyAllows(
  name: string,
  server: McpSelectedServer,
  allowed: readonly McpServerRule[] | undefined,
  denied: readonly McpServerRule[] = [],
  variants: McpPolicyVariants = {},
): boolean {
  const config = server.config,
    command = stdioCommand(config);
  const denyCommands = variants.denyCommands ?? (command ? [command] : []);
  const denyUrls =
    variants.denyUrls ?? (typeof config.url === "string" ? [config.url] : []);
  if (
    denied.some((rule) =>
      "serverName" in rule
        ? rule.serverName === name
        : "serverCommand" in rule
          ? denyCommands.some((value) => sameCommand(rule.serverCommand, value))
          : denyUrls.some((value) =>
              matchesMcpServerUrl(value, rule.serverUrl),
            ),
    )
  )
    return false;
  if (
    (server.scope === "managed" || server.scope === "enterprise") &&
    !config.expandedFromEnv &&
    !config.pluginSource
  )
    return true;
  if (allowed === undefined) return true;
  if (!allowed.length) return false;
  const commandRules = allowed.filter(
    (rule): rule is { serverCommand: readonly string[] } =>
      "serverCommand" in rule,
  );
  if (command && commandRules.length) {
    return (variants.allowCommandGroups ?? [[command]]).some(
      (group) =>
        group.length > 0 &&
        group.every((value) =>
          commandRules.some((rule) => sameCommand(rule.serverCommand, value)),
        ),
    );
  }
  const urlRules = allowed.filter(
    (rule): rule is { serverUrl: string } => "serverUrl" in rule,
  );
  if (typeof config.url === "string" && urlRules.length) {
    const urls = variants.allowUrls ?? [config.url];
    return (
      urls.length > 0 &&
      urls.every((value) =>
        urlRules.some((rule) => matchesMcpServerUrl(value, rule.serverUrl)),
      )
    );
  }
  return allowed.some(
    (rule) => "serverName" in rule && rule.serverName === name,
  );
}

export interface ResolveMcpScopesOptions<T extends McpScopeConfig> {
  user?: McpScopeDocument<T>;
  /** Outer directories first; nearer .mcp.json definitions win. */
  project?: readonly McpScopeDocument<T>[];
  local?: McpScopeDocument<T>;
  managed?: McpScopeDocument<T>;
  enterprise?: McpScopeDocument<T> & {
    present: boolean;
    valid: boolean;
    held?: boolean;
  };
  /** Repeated --mcp-config documents, in argument order. */
  explicit?: readonly McpScopeDocument<T>[];
  /** Qualified plugin servers are autodiscovery, preceding ordinary configured scopes. */
  plugins?: McpScopeDocument<T>;
  enabledSources?: readonly McpSettingsSource[];
  localSettingsEnabled?: boolean;
  strict?: boolean;
  autoDiscovery?: boolean;
  pluginOnly?: boolean;
  managedServersEnabled?: boolean;
  approval?: McpProjectApproval;
  disabledNames?: readonly string[];
  optInNames?: readonly string[];
  enabledNames?: readonly string[];
  allowRules?: readonly McpServerRule[];
  denyRules?: readonly McpServerRule[];
  policyVariants?: (
    name: string,
    server: McpSelectedServer<T>,
  ) => McpPolicyVariants;
  /** Internal SDK/desktop exemptions are host-owned, never inferred from operator JSON. */
  enterpriseExempt?: (name: string, config: T) => boolean;
}
export interface McpScopeResolution<T extends McpScopeConfig> {
  selected: Record<string, McpSelectedServer<T>>;
  connectable: Record<string, McpSelectedServer<T>>;
  pendingProjectNames: string[];
  rejectedProjectNames: string[];
  disabledNames: string[];
  policyBlockedNames: string[];
  droppedExplicitNames: string[];
  refusal?: string;
}

/** Ordinary startup qw→sO/Y0e→merge→connection gate. Plugin/host channels are separate. */
export function resolveMcpScopes<T extends McpScopeConfig>(
  options: ResolveMcpScopesOptions<T>,
): McpScopeResolution<T> {
  const selected = nullRecord<McpSelectedServer<T>>();
  const connectable = nullRecord<McpSelectedServer<T>>();
  const result: McpScopeResolution<T> = {
    selected,
    connectable,
    pendingProjectNames: [],
    rejectedProjectNames: [],
    disabledNames: [],
    policyBlockedNames: [],
    droppedExplicitNames: [],
  };
  const enabled = new Set(
    options.enabledSources ?? [
      "userSettings",
      "projectSettings",
      "localSettings",
    ],
  );
  const merge = (
    document: McpScopeDocument<T> | undefined,
    scope: McpScope,
    target = selected,
  ): void => {
    for (const [name, config] of Object.entries(document?.servers ?? {}))
      target[name] = {
        config,
        scope,
        ...(document?.path !== undefined ? { path: document.path } : {}),
      };
  };
  const dynamic = nullRecord<McpSelectedServer<T>>();
  for (const document of options.explicit ?? [])
    merge(document, "dynamic", dynamic);
  const enterprise = options.enterprise;
  if (enterprise?.present) {
    if (enterprise.valid && !enterprise.held) {
      if (options.strict) {
        result.refusal =
          "You cannot use --strict-mcp-config when an enterprise MCP config is present";
        return result;
      }
      if (
        Object.entries(dynamic).some(
          ([name, entry]) => !options.enterpriseExempt?.(name, entry.config),
        )
      ) {
        result.refusal =
          "You cannot dynamically configure MCP servers when an enterprise MCP config is present";
        return result;
      }
    } else
      for (const [name, entry] of Object.entries(dynamic))
        if (!options.enterpriseExempt?.(name, entry.config)) {
          delete dynamic[name];
          result.droppedExplicitNames.push(name);
        }
  }
  if (!options.strict && options.autoDiscovery !== false) {
    if (enterprise?.present) {
      if (options.managedServersEnabled !== false)
        merge(options.managed, "managed");
      if (enterprise.valid && !enterprise.held) merge(enterprise, "enterprise");
    } else {
      merge(options.plugins, "dynamic");
      if (!options.pluginOnly) {
        if (enabled.has("userSettings")) merge(options.user, "user");
        if (enabled.has("projectSettings")) {
          const project = nullRecord<McpSelectedServer<T>>();
          for (const document of options.project ?? [])
            merge(document, "project", project);
          for (const [name, entry] of Object.entries(project)) {
            const approval = projectMcpApproval(
              name,
              options.approval ?? { workspaceTrusted: false },
              true,
            );
            if (approval === "approved") selected[name] = entry;
            else if (
              !Object.hasOwn(selected, name) &&
              !(
                (options.localSettingsEnabled ??
                  enabled.has("localSettings")) &&
                Object.hasOwn(options.local?.servers ?? {}, name)
              ) &&
              !(
                options.managedServersEnabled !== false &&
                Object.hasOwn(options.managed?.servers ?? {}, name)
              )
            ) {
              (approval === "pending"
                ? result.pendingProjectNames
                : result.rejectedProjectNames
              ).push(name);
            }
          }
        }
        if (options.localSettingsEnabled ?? enabled.has("localSettings"))
          merge(options.local, "local");
      }
      if (options.managedServersEnabled !== false)
        merge(options.managed, "managed");
    }
  }
  // Original filters the configured map separately from dynamic before the final
  // spread. A blocked explicit definition therefore leaves a configured one intact.
  for (const [name, entry] of Object.entries(selected)) {
    if (
      !mcpServerPolicyAllows(
        name,
        entry,
        options.allowRules,
        options.denyRules,
        options.policyVariants?.(name, entry),
      )
    ) {
      delete selected[name];
      result.policyBlockedNames.push(name);
    }
  }
  for (const [name, entry] of Object.entries(dynamic)) {
    if (
      mcpServerPolicyAllows(
        name,
        entry,
        options.allowRules,
        options.denyRules,
        options.policyVariants?.(name, entry),
      )
    )
      selected[name] = entry;
    else if (!result.policyBlockedNames.includes(name))
      result.policyBlockedNames.push(name);
  }
  for (const [name, entry] of Object.entries(selected)) {
    if (
      options.optInNames?.includes(name)
        ? !options.enabledNames?.includes(name)
        : options.disabledNames?.includes(name)
    )
      result.disabledNames.push(name);
    else connectable[name] = entry;
  }
  return result;
}
