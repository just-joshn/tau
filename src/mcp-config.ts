import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface McpStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Hard per-call deadline; values below 1000 do not override the default. */
  timeout?: number;
  alwaysLoad?: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prototype-less dictionary so server names like `__proto__` stay plain keys. */
export function nullRecord<T>(): Record<string, T> {
  const record: Record<string, T> = {};
  Object.setPrototypeOf(record, null);
  return record;
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    object(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** Source QZ: only ${NAME} and ${NAME:-default}; an empty value is a set value. */
export function expandMcpConfigValue(
  value: string,
  env: NodeJS.ProcessEnv,
  onMissing?: (names: readonly string[]) => void,
): string {
  const missing = new Set<string>();
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (literal, name: string, fallback: string | undefined) => {
      const replacement = env[name] ?? fallback;
      if (replacement === undefined) {
        missing.add(name);
        return literal;
      }
      return replacement;
    },
  );
  if (missing.size) {
    if (onMissing) onMissing([...missing]);
    else
      throw new Error(
        `Missing environment variables: ${[...missing].join(", ")}`,
      );
  }
  return expanded;
}

export function parseMcpConfigs(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  expandVariables = true,
  onMissing?: (names: readonly string[]) => void,
): Record<string, McpStdioConfig> {
  if (!object(value) || !object(value.mcpServers))
    throw new Error("MCP config must contain an mcpServers object");
  const result = nullRecord<McpStdioConfig>();
  for (const [name, config] of Object.entries(value.mcpServers)) {
    if (!name || !object(config))
      throw new Error(`Invalid MCP server config: ${name}`);
    if (config.type !== undefined && config.type !== "stdio")
      throw new Error(
        `Unsupported MCP transport for ${name}: ${typeof config.type === "string" ? config.type : JSON.stringify(config.type)}; supported transport: stdio`,
      );
    if (typeof config.command !== "string" || !config.command)
      throw new Error(`MCP server ${name} requires a command`);
    if (
      config.args !== undefined &&
      (!Array.isArray(config.args) ||
        !config.args.every((arg) => typeof arg === "string"))
    )
      throw new Error(`MCP server ${name} args must be strings`);
    if (config.env !== undefined && !isStringRecord(config.env))
      throw new Error(`MCP server ${name} env must contain strings`);
    if (
      config.timeout !== undefined &&
      (typeof config.timeout !== "number" ||
        !Number.isSafeInteger(config.timeout) ||
        config.timeout <= 0)
    )
      throw new Error(`MCP server ${name} timeout must be a positive integer`);
    if (
      config.alwaysLoad !== undefined &&
      typeof config.alwaysLoad !== "boolean"
    )
      throw new Error(`MCP server ${name} alwaysLoad must be a boolean`);
    const expand = (value: string) =>
      expandVariables ? expandMcpConfigValue(value, env, onMissing) : value;
    const command = expand(config.command);
    if (!command)
      throw new Error(`MCP server ${name} command resolved to an empty string`);
    result[name] = {
      command,
      ...(config.type === "stdio" ? { type: "stdio" as const } : {}),
      ...(config.args !== undefined ? { args: config.args.map(expand) } : {}),
      ...(config.env !== undefined
        ? {
            env: Object.fromEntries(
              Object.entries(config.env).map(([key, item]) => [
                key,
                expand(item),
              ]),
            ),
          }
        : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      ...(config.alwaysLoad !== undefined
        ? { alwaysLoad: config.alwaysLoad }
        : {}),
    };
  }
  return result;
}

/** Explicit specs only: no personal or project Claude configuration is read. */
export async function loadMcpConfigs(
  specs: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (message: string) => void,
): Promise<Record<string, McpStdioConfig>> {
  const result = nullRecord<McpStdioConfig>();
  for (const spec of specs) {
    const text = spec.trimStart().startsWith("{")
      ? spec
      : await readFile(resolve(cwd, spec), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON in MCP config");
    }
    if (onWarning && object(parsed) && object(parsed.mcpServers)) {
      for (const [name, config] of Object.entries(parsed.mcpServers))
        try {
          Object.assign(
            result,
            parseMcpConfigs(
              { mcpServers: { [name]: config } },
              env,
              true,
              (names) =>
                onWarning(
                  `MCP server ${name}: missing environment variables ${names.join(", ")}`,
                ),
            ),
          );
        } catch (error) {
          onWarning(
            error instanceof Error
              ? error.message
              : `Invalid MCP server ${name}`,
          );
        }
    } else Object.assign(result, parseMcpConfigs(parsed, env));
  }
  return result;
}

export function sanitizeMcpName(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return value.startsWith("claude.ai ")
    ? name.replace(/_+/g, "_").replace(/^_|_$/g, "")
    : name;
}

export function qualifyMcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`;
}
