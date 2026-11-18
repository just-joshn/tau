import { lstat, mkdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
  readBoundedConfigurationText,
  SETTINGS_MAX_BYTES,
  type JsonValue,
  type SettingsRecord,
} from "./configuration.js";
import type { LaunchConfiguration } from "./launch-configuration.js";
import {
  expandMcpConfigValue,
  loadMcpConfigs,
  nullRecord,
  parseMcpConfigs,
  type McpStdioConfig,
} from "./mcp-config.js";
import {
  createPluginMcpDocument,
  suppressDuplicatePluginMcpServers,
  type PluginMcpStdioConfig,
} from "./plugin-mcp.js";
import type { CatalogPlugin } from "./plugin-catalog.js";
import { pluginCustomizationOnly } from "./plugin-policy.js";
import {
  enterpriseMcpConfigUsesEnvironment,
  extractMcpGlobalScopeValues,
  planMcpScopeReads,
  resolveMcpScopes,
  selectMcpPolicyRules,
  type McpApprovalSettings,
  type McpPolicySettings,
  type McpScopeConfig,
  type McpScopeDocument,
  type McpSettingsSource,
  type McpServerRule,
} from "./mcp-scopes.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type Server = McpScopeConfig & {
  env?: Record<string, string>;
  timeout?: number;
  alwaysLoad?: boolean;
  configuredCommand?: { command: string; args: readonly string[] };
};

const isStdioServer = (config: Server): config is Server & McpStdioConfig =>
  (config.type === undefined || config.type === "stdio") &&
  typeof config.command === "string";
const isPluginServer = (
  config: Server,
): config is Server & PluginMcpStdioConfig =>
  typeof config.command === "string" &&
  typeof config.pluginSource === "string" &&
  "scope" in config &&
  config.scope === "dynamic" &&
  "pluginPath" in config &&
  typeof config.pluginPath === "string";

/** Ipn distinguishes an inaccessible ancestor probe from a deployed unreadable file. */
export function mcpReadFailureImpliesPresence(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!object(error)) return true;
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
  return !(
    platform !== "win32" &&
    error.code === "EACCES" &&
    ["stat", "statx", "lstat"].includes(String(error.syscall))
  );
}

/** Local launch adapter. Selection preserves origins before any child is started. */
export async function loadLaunchMcp(options: {
  cwd: string;
  launch: LaunchConfiguration;
  specs: readonly string[];
  strict: boolean;
  nonInteractive: boolean;
  bypassPermissions: boolean;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  approveProject?(name: string, path?: string): Promise<boolean>;
  onDiagnostic?(message: string): void;
  plugins?: readonly CatalogPlugin[];
}) {
  const env = options.env ?? process.env,
    snapshot = options.launch.snapshot;
  const warn = (message: string) => options.onDiagnostic?.(message);
  const enabledSources = snapshot.enabledSources.filter(
    (source): source is McpSettingsSource =>
      ["userSettings", "projectSettings", "localSettings"].includes(source),
  );
  const plan = planMcpScopeReads({
    cwd: options.cwd,
    globalConfigPath: options.launch.globalConfigPath,
    ...(options.launch.managedRoot === undefined
      ? {}
      : { managedRoot: options.launch.managedRoot }),
    enabledSources,
  });
  async function read(
    path: string,
    blankProject = false,
  ): Promise<{
    present: boolean;
    valid: boolean;
    value: Record<string, unknown> | undefined;
  }> {
    options.signal.throwIfAborted();
    // The source's regular-file gate starts with lstat. realpath's error code
    // cannot substitute for this probe when deciding enterprise exclusivity.
    try {
      await lstat(path);
    } catch (error) {
      const present = mcpReadFailureImpliesPresence(error);
      if (present)
        warn(`${path}: MCP configuration metadata could not be read`);
      return { present, valid: false, value: undefined };
    }
    const result = await readBoundedConfigurationText(path, SETTINGS_MAX_BYTES);
    options.signal.throwIfAborted();
    if (result.status !== "loaded") {
      if (result.status !== "absent")
        warn(`${path}: MCP configuration could not be read (${result.reason})`);
      return {
        present: result.status !== "absent",
        valid: false,
        value: undefined,
      };
    }
    if (blankProject && result.text.trim() === "")
      return { present: true, valid: true, value: { mcpServers: {} } };
    try {
      const value: unknown = JSON.parse(result.text.replace(/^\uFEFF/, ""));
      if (!object(value)) throw new Error("MCP document must be an object");
      return { present: true, valid: true, value };
    } catch {
      warn(`${path}: invalid MCP configuration JSON/object`);
      return { present: true, valid: false, value: undefined };
    }
  }
  function servers(
    value: unknown,
    origin: string,
    expandVariables = true,
    enterprise = false,
  ): Record<string, Server> {
    const result = nullRecord<Server>();
    if (value === undefined) return result;
    if (!object(value)) {
      warn(`${origin}: mcpServers must be an object`);
      return result;
    }
    for (const [name, raw] of Object.entries(value)) {
      if (!name || !object(raw)) {
        warn(`${origin}: invalid MCP server ${name}`);
        continue;
      }
      try {
        if (raw.type === undefined || raw.type === "stdio") {
          const parsed = parseMcpConfigs(
            { mcpServers: { [name]: raw } },
            env,
            expandVariables,
            (names) =>
              warn(
                `${origin}: MCP server ${name} has unresolved environment variables ${names.join(", ")}`,
              ),
          )[name];
          if (!parsed) throw new Error(`MCP server ${name} was not parsed`);
          result[name] = parsed;
        } else if (
          typeof raw.type === "string" &&
          ["http", "sse", "ws"].includes(raw.type) &&
          typeof raw.url === "string"
        ) {
          // Preserve these through precedence/policy, then explicitly diagnose
          // unsupported connections. A lower stdio definition must not revive.
          result[name] = {
            type: raw.type,
            url: expandVariables
              ? expandMcpConfigValue(raw.url, env, (names) =>
                  warn(
                    `${origin}: MCP server ${name} has unresolved environment variables ${names.join(", ")}`,
                  ),
                )
              : raw.url,
          };
        } else {
          warn(
            `${origin}: invalid or unknown transport for MCP server ${name}`,
          );
          continue;
        }
        if (enterprise && enterpriseMcpConfigUsesEnvironment(raw))
          result[name].expandedFromEnv = true;
      } catch {
        warn(`${origin}: invalid MCP server ${name}`);
      }
    }
    return result;
  }
  function approval(value: SettingsRecord): McpApprovalSettings {
    const names = (field: string) =>
      Array.isArray(value[field])
        ? value[field].filter(
            (item): item is string => typeof item === "string",
          )
        : [];
    return {
      enabledMcpjsonServers: names("enabledMcpjsonServers"),
      disabledMcpjsonServers: names("disabledMcpjsonServers"),
      enableAllProjectMcpServers: value.enableAllProjectMcpServers === true,
    };
  }
  function policy(value: SettingsRecord): McpPolicySettings {
    const rules = (key: string, list: JsonValue): McpServerRule[] => {
      if (!Array.isArray(list)) {
        warn(`Invalid ${key} MCP policy list`);
        return [];
      }
      return list.flatMap((rule): McpServerRule[] => {
        if (!object(rule)) return [];
        if (typeof rule.serverName === "string")
          return [{ serverName: rule.serverName }];
        if (typeof rule.serverUrl === "string")
          return [{ serverUrl: rule.serverUrl }];
        if (
          Array.isArray(rule.serverCommand) &&
          rule.serverCommand.every((item) => typeof item === "string")
        )
          return [{ serverCommand: rule.serverCommand }];
        return [];
      });
    };
    return {
      allowManagedMcpServersOnly: value.allowManagedMcpServersOnly === true,
      ...(value.allowedMcpServers === undefined
        ? {}
        : {
            allowedMcpServers: rules(
              "allowedMcpServers",
              value.allowedMcpServers,
            ),
          }),
      ...(value.deniedMcpServers === undefined
        ? {}
        : {
            deniedMcpServers: rules("deniedMcpServers", value.deniedMcpServers),
          }),
    };
  }
  const enterpriseRead =
    plan.enterpriseFile === undefined
      ? undefined
      : { path: plan.enterpriseFile, ...(await read(plan.enterpriseFile)) };
  const enterpriseValid =
    enterpriseRead?.valid === true && object(enterpriseRead.value?.mcpServers);
  if (enterpriseRead?.present && enterpriseRead.valid && !enterpriseValid)
    warn(`${enterpriseRead.path}: missing mcpServers object`);
  const enterprise =
    enterpriseRead === undefined
      ? undefined
      : {
          present: enterpriseRead.present,
          valid: enterpriseValid,
          servers: servers(
            enterpriseRead.value?.mcpServers,
            enterpriseRead.path,
            true,
            true,
          ),
          path: enterpriseRead.path,
        };
  let pluginDocument: McpScopeDocument<PluginMcpStdioConfig> | undefined;
  if (!options.strict && !enterprise?.present && options.plugins?.length) {
    const dataDirectories = new Set<string>();
    const pluginRoot =
      env.CLAUDE_CODE_PLUGIN_CACHE_DIR === undefined
        ? join(options.launch.userConfigDir, "plugins")
        : resolvePath(options.cwd, env.CLAUDE_CODE_PLUGIN_CACHE_DIR);
    const result = await createPluginMcpDocument({
      plugins: options.plugins,
      env,
      projectDirectory: options.cwd,
      signal: options.signal,
      pluginDataDirectory: (plugin) => {
        const path = join(
          pluginRoot,
          "data",
          plugin.source.replace(/[^a-zA-Z0-9\-_]/g, "-"),
        );
        dataDirectories.add(path);
        return path;
      },
    });
    for (const issue of result.diagnostics)
      warn(`${issue.pluginSource}: ${issue.message}`);
    for (const path of dataDirectories) {
      options.signal.throwIfAborted();
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    pluginDocument = result.document;
  }
  const explicit = await loadMcpConfigs(options.specs, options.cwd, env, warn);
  options.signal.throwIfAborted();
  // Jl's connection enable/disable state applies to explicit and enterprise
  // names too; strict/source gates suppress discovery, not that state lookup.
  const global = await read(options.launch.globalConfigPath);
  const globalValues = extractMcpGlobalScopeValues(
    global?.value,
    options.launch.workspace.projectKey ?? options.cwd,
  );
  const project: McpScopeDocument<Server>[] = [];
  if (!options.strict && !enterprise?.present)
    for (const path of plan.projectFiles) {
      const document = await read(path, true);
      if (document.valid && object(document.value?.mcpServers))
        project.push({
          servers: servers(document.value.mcpServers, path),
          path,
        });
      else if (document.present && document.valid)
        warn(`${path}: missing mcpServers object`);
    }
  const tiers = snapshot.documents.flatMap((document) =>
    document.source === "policySettings" && document.effective !== undefined
      ? [policy(document.effective)]
      : [],
  );
  const rules = selectMcpPolicyRules(
    policy(snapshot.effective),
    policy(snapshot.policy),
    tiers,
  );
  const sessionApprovedNames: string[] = [];
  const user = {
    servers: plan.readUser
      ? servers(globalValues.user, options.launch.globalConfigPath)
      : {},
  };
  const local = {
    servers: plan.readLocal
      ? servers(globalValues.local, options.launch.globalConfigPath)
      : {},
  };
  const managed = {
    servers: servers(
      snapshot.policy.managedMcpServers,
      "managed policy",
      false,
    ),
  };
  const resolve = () =>
    resolveMcpScopes({
      enabledSources,
      strict: options.strict,
      user,
      local,
      project,
      managed,
      ...(pluginDocument === undefined ? {} : { plugins: pluginDocument }),
      pluginOnly: pluginCustomizationOnly(
        snapshot.policy.strictPluginOnlyCustomization,
        "mcp",
      ),
      ...(enterprise === undefined ? {} : { enterprise }),
      explicit: [{ servers: explicit }],
      disabledNames: globalValues.disabledNames,
      enabledNames: globalValues.enabledNames,
      optInNames: ["computer-use"],
      ...rules,
      approval: {
        workspaceTrusted: options.launch.workspace.persistedWorkspaceTrusted,
        settings: approval(snapshot.effective),
        sessionApprovedNames,
        visibleTrustedSettings: snapshot.documents.flatMap((document) =>
          document.effective !== undefined &&
          (document.source !== "projectSettings" ||
            options.launch.workspace.projectEqualsUserSettings) &&
          (document.source !== "localSettings" ||
            options.launch.workspace.localMcpApprovalTrusted)
            ? [approval(document.effective)]
            : [],
        ),
        nonInteractive: options.nonInteractive,
        bypassApproved: options.bypassPermissions,
      },
    });
  let resolution = resolve();
  if (resolution.refusal) throw new Error(resolution.refusal);
  for (const name of resolution.pendingProjectNames) {
    options.signal.throwIfAborted();
    if (
      await options.approveProject?.(
        name,
        project.findLast((document) => Object.hasOwn(document.servers, name))
          ?.path,
      )
    )
      sessionApprovedNames.push(name);
  }
  if (sessionApprovedNames.length) resolution = resolve();
  const pluginServers = Object.fromEntries(
    Object.entries(resolution.selected).flatMap(
      ([name, selected]): [string, PluginMcpStdioConfig][] =>
        isPluginServer(selected.config) ? [[name, selected.config]] : [],
    ),
  );
  const manualServers = Object.fromEntries(
    Object.entries(resolution.connectable)
      .filter(([, selected]) => selected.config.pluginSource === undefined)
      .map(([name, selected]) => [name, selected.config]),
  );
  const deduplicated = suppressDuplicatePluginMcpServers(
    pluginServers,
    manualServers,
  );
  for (const entry of deduplicated.suppressed) {
    delete resolution.selected[entry.name];
    delete resolution.connectable[entry.name];
    warn(`MCP server ${entry.name}: duplicates ${entry.duplicateOf}`);
  }
  for (const [status, names] of Object.entries({
    pending: resolution.pendingProjectNames,
    rejected: resolution.rejectedProjectNames,
    disabled: resolution.disabledNames,
    "blocked by server policy": resolution.policyBlockedNames,
    "excluded by enterprise policy": resolution.droppedExplicitNames,
  })) {
    for (const name of names) warn(`MCP server ${name}: ${status}`);
  }
  const configs = nullRecord<McpStdioConfig>();
  for (const [name, selected] of Object.entries(resolution.connectable)) {
    const config = selected.config;
    if (!isStdioServer(config)) {
      if (config.type !== undefined && config.type !== "stdio")
        warn(
          `Unsupported MCP transport for ${name}: ${config.type}; supported transport: stdio`,
        );
      continue;
    }
    configs[name] = config;
  }
  return { configs, resolution };
}
