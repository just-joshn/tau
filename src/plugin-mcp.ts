import { isAbsolute } from "node:path";
import {
  expandMcpConfigValue,
  nullRecord,
  parseMcpConfigs,
  type McpStdioConfig,
} from "./mcp-config.js";
import type { CatalogPlugin, PluginComponent } from "./plugin-catalog.js";
import type { McpScopeDocument } from "./mcp-scopes.js";

export interface PluginMcpStdioConfig extends McpStdioConfig {
  scope: "dynamic";
  pluginSource: string;
  pluginPath: string;
  configuredCommand?: { command: string; args: readonly string[] };
}
export interface PluginMcpServerDeclaration {
  qualifiedName: string;
  serverName: string;
  pluginName: string;
  pluginSource: string;
  pluginPath: string;
  pluginScope: CatalogPlugin["scope"];
  componentPath?: string;
  /** Unexpanded source data for host component-offer/narrowing decisions. */
  authoredConfig: Readonly<Record<string, unknown>>;
}
export interface PluginMcpDiagnostic {
  pluginSource: string;
  serverName?: string;
  path?: string;
  reason: string;
  message: string;
}
export interface PluginMcpDocument {
  document: McpScopeDocument<PluginMcpStdioConfig>;
  origins: Readonly<Record<string, PluginMcpServerDeclaration>>;
  diagnostics: readonly PluginMcpDiagnostic[];
}
export interface PluginMcpOptions {
  plugins: readonly CatalogPlugin[];
  /** Explicit host environment; this helper never consults process.env. */
  env: NodeJS.ProcessEnv;
  pluginDataDirectory?: (plugin: Readonly<CatalogPlugin>) => string | undefined;
  projectDirectory?: string;
  /** Native plugin MCP narrowing is applied before configuration/substitution. */
  admitServer?: (
    declaration: Readonly<PluginMcpServerDeclaration>,
  ) => boolean | string | Promise<boolean | string>;
  signal?: AbortSignal;
  /** The host resolves builtin canonical namespace aliases; local plugins use their manifest name. */
  namespaceName?: (plugin: Readonly<CatalogPlugin>) => string;
}

/** Source l3s, bounded to stdio. Manuals must pass scope/policy and connection-enable gates (no disabled/pending/rejected rows). */
export function suppressDuplicatePluginMcpServers(
  plugins: Readonly<Record<string, PluginMcpStdioConfig>>,
  manual: Readonly<
    Record<
      string,
      {
        type?: string;
        command?: string;
        args?: readonly string[];
        configError?: unknown;
      }
    >
  >,
): {
  servers: Readonly<Record<string, PluginMcpStdioConfig>>;
  suppressed: readonly { name: string; duplicateOf: string }[];
} {
  const servers = nullRecord<PluginMcpStdioConfig>(),
    suppressed: { name: string; duplicateOf: string }[] = [];
  const manualKeys = new Map<string, string>(),
    pluginKeys = new Map<string, string>();
  const argv = (config: {
    type?: string;
    command?: string;
    args?: readonly string[];
    configError?: unknown;
  }): string | undefined =>
    config.configError ||
    (config.type !== undefined && config.type !== "stdio") ||
    typeof config.command !== "string"
      ? undefined
      : JSON.stringify([config.command, ...(config.args ?? [])]);
  for (const [name, config] of Object.entries(manual)) {
    const key = argv(config);
    if (key !== undefined && !manualKeys.has(key)) manualKeys.set(key, name);
  }
  for (const [name, config] of Object.entries(plugins)) {
    const key = argv(config);
    if (key === undefined) {
      servers[name] = config;
      continue;
    }
    const env = Object.fromEntries(
      Object.entries(config.env ?? {})
        .filter(([key]) => !reservedEnv.has(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const full =
        key + (Object.keys(env).length ? ":" + JSON.stringify(env) : ""),
      previous = manualKeys.get(key) ?? pluginKeys.get(full);
    if (previous !== undefined)
      suppressed.push({ name, duplicateOf: previous });
    else {
      servers[name] = config;
      pluginKeys.set(full, name);
    }
  }
  return { servers, suppressed };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const knownFields = new Set([
  "type",
  "command",
  "args",
  "env",
  "timeout",
  "alwaysLoad",
]);
const reservedEnv = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"]);
const enabledFlag = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Produce an autodiscovered plugin document, never an explicit --mcp-config document. No server is started. */
export async function createPluginMcpDocument(
  options: PluginMcpOptions,
): Promise<PluginMcpDocument> {
  const servers = nullRecord<PluginMcpStdioConfig>(),
    origins = nullRecord<PluginMcpServerDeclaration>();
  const diagnostics: PluginMcpDiagnostic[] = [],
    check = () => options.signal?.throwIfAborted();
  for (const plugin of options.plugins) {
    check();
    if (!plugin.enabled) continue;
    const issue = (
      reason: string,
      message: string,
      name?: string,
      path?: string,
    ) =>
      diagnostics.push({
        pluginSource: plugin.source,
        reason,
        message,
        ...(name !== undefined && { serverName: name }),
        ...(path !== undefined && { path }),
      });
    const projectSkill =
        plugin.scope === "project" && plugin.source.endsWith("@skills-dir"),
      exceptions = (
        options.env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT ?? ""
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const same = (left: string, right: string) =>
      left.toLowerCase() === right.toLowerCase();
    const exempt = exceptions.some((value) =>
      value.includes("@")
        ? same(value, plugin.source)
        : !projectSkill && same(value, plugin.name),
    );
    const fullExempt =
      !projectSkill &&
      exceptions.some(
        (value) => value.includes("@") && same(value, plugin.source),
      );
    if (
      enabledFlag(options.env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS) &&
      !exempt
    ) {
      issue(
        "environment-gate",
        "CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS suppresses plugin MCP discovery",
      );
      continue;
    }
    if (
      enabledFlag(options.env.CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS) &&
      !fullExempt
    ) {
      issue(
        "environment-gate",
        "CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS suppresses the stdio plugin adapter",
      );
      continue;
    }
    const choices = new Map<
      string,
      {
        raw: Record<string, unknown>;
        component: PluginComponent;
        unsupported?: string;
      }
    >();
    for (const component of plugin.components) {
      check();
      if (component.kind !== "mcp" || !component.config) continue;
      const config =
        component.path !== undefined && component.config.mcpServers
          ? component.config.mcpServers
          : component.config;
      if (!record(config)) {
        issue(
          "schema",
          "MCP source must contain a server map",
          undefined,
          component.path,
        );
        continue;
      }
      for (const [name, raw] of Object.entries(config)) {
        if (!name || !record(raw)) {
          issue(
            "schema",
            "MCP server declaration must be a named object",
            name,
            component.path,
          );
          continue;
        }
        if (raw.type !== undefined && raw.type !== "stdio") {
          choices.set(name, {
            raw,
            component,
            unsupported: `Transport ${typeof raw.type === "string" ? raw.type : JSON.stringify(raw.type)} is not implemented by the local plugin stdio adapter`,
          });
          continue;
        }
        try {
          // Validate each file entry before the later sources merge, as native Rhe does.
          parseMcpConfigs({ mcpServers: { [name]: raw } }, {}, false);
          const extra = Object.keys(raw).filter((key) => !knownFields.has(key));
          choices.set(name, {
            raw,
            component,
            ...(extra.length && {
              unsupported: `Unsupported plugin MCP fields: ${extra.join(", ")}`,
            }),
          });
        } catch (error) {
          issue(
            "schema",
            error instanceof Error
              ? error.message
              : "Invalid MCP configuration",
            name,
            component.path,
          );
        }
      }
    }
    for (const [name, choice] of choices) {
      check();
      const qualifiedName = `plugin:${options.namespaceName?.(plugin) ?? plugin.name}:${name}`;
      // A later unsupported definition must not revive a different earlier endpoint.
      delete servers[qualifiedName];
      delete origins[qualifiedName];
      if (choice.unsupported) {
        issue("unsupported", choice.unsupported, name, choice.component.path);
        continue;
      }
      const declaration = freeze(
        structuredClone({
          qualifiedName,
          serverName: name,
          pluginName: plugin.name,
          pluginSource: plugin.source,
          pluginPath: plugin.root,
          pluginScope: plugin.scope,
          ...(choice.component.path !== undefined && {
            componentPath: choice.component.path,
          }),
          authoredConfig: choice.raw,
        } satisfies PluginMcpServerDeclaration),
      );
      const admitted = await options.admitServer?.(declaration);
      check();
      if (admitted === false || typeof admitted === "string") {
        issue(
          "withheld",
          typeof admitted === "string"
            ? admitted
            : "Host withheld plugin MCP source",
          name,
          choice.component.path,
        );
        continue;
      }
      if (
        plugin.manifest.userConfig !== undefined ||
        plugin.manifest.channels !== undefined
      ) {
        issue(
          "unsupported",
          "Plugin MCP userConfig/channel configuration needs a host credential and channel adapter",
          name,
          choice.component.path,
        );
        continue;
      }
      try {
        const raw = choice.raw,
          rawArgs: readonly unknown[] = Array.isArray(raw.args) ? raw.args : [],
          values = [
            raw.command,
            ...rawArgs,
            ...Object.values(record(raw.env) ? raw.env : {}),
          ];
        if (
          values.some(
            (value) =>
              typeof value === "string" && /\$\{user_config\./.test(value),
          )
        )
          throw new Error(
            "Plugin MCP user_config substitution requires an explicit host adapter",
          );
        const data = options.pluginDataDirectory?.(plugin);
        if (data !== undefined && !isAbsolute(data))
          throw new Error("Plugin data directory must be absolute");
        const needsData = values.some(
          (value) =>
            typeof value === "string" &&
            value.includes("${CLAUDE_PLUGIN_DATA}"),
        );
        if (data === undefined && needsData)
          throw new Error(
            "CLAUDE_PLUGIN_DATA requires an explicit host data directory",
          );
        if (data === undefined)
          issue(
            "plugin-data-unavailable",
            "No host data directory supplied; CLAUDE_PLUGIN_DATA is not injected",
            name,
            choice.component.path,
          );
        const expand = (value: string): string => {
          let expanded = value.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin.root);
          if (data !== undefined)
            expanded = expanded.replaceAll("${CLAUDE_PLUGIN_DATA}", data);
          if (expanded.includes("${CLAUDE_PROJECT_DIR}")) {
            if (options.projectDirectory === undefined)
              throw new Error(
                "CLAUDE_PROJECT_DIR requires an explicit host project directory",
              );
            expanded = expanded.replaceAll(
              "${CLAUDE_PROJECT_DIR}",
              options.projectDirectory,
            );
          }
          return expandMcpConfigValue(expanded, options.env, (names) =>
            issue(
              "environment",
              `Plugin MCP references missing environment variables: ${names.join(", ")}`,
              name,
              choice.component.path,
            ),
          );
        };
        const parsed = parseMcpConfigs(
          { mcpServers: { [name]: raw } },
          {},
          false,
        )[name];
        if (!parsed)
          throw new Error(
            `Plugin MCP server ${name} produced no parsed configuration`,
          );
        const command = expand(parsed.command),
          args = (parsed.args ?? []).map(expand);
        const env: Record<string, string> = {
          CLAUDE_PLUGIN_ROOT: plugin.root,
          ...(data !== undefined && { CLAUDE_PLUGIN_DATA: data }),
          ...parsed.env,
        };
        // Native G6s permits authored overrides and deliberately leaves these two env values unexpanded.
        for (const [key, value] of Object.entries(env))
          if (!reservedEnv.has(key)) env[key] = expand(value);
        const config: PluginMcpStdioConfig = {
          ...parsed,
          command,
          args,
          env,
          scope: "dynamic",
          pluginSource: plugin.source,
          pluginPath: plugin.root,
          ...(command !== parsed.command ||
          args.some((arg, index) => arg !== parsed.args?.[index])
            ? {
                configuredCommand: {
                  command: parsed.command,
                  args: [...(parsed.args ?? [])],
                },
              }
            : {}),
        };
        if (!config.command)
          throw new Error("Plugin MCP command expanded to an empty string");
        check();
        servers[qualifiedName] = freeze(config);
        origins[qualifiedName] = declaration;
      } catch (error) {
        check();
        issue(
          "withheld",
          error instanceof Error
            ? error.message
            : "Plugin MCP substitution failed",
          name,
          choice.component.path,
        );
      }
    }
  }
  check();
  return { document: { servers }, origins, diagnostics };
}
