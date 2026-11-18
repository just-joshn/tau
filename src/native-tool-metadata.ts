import { AsyncLocalStorage } from "node:async_hooks";
import {
  NativePermissionDependencyError,
  readNativePermissionFact,
  type NativePermissionFact as Fact,
  type NativePermissionScope as Scope,
  type NativePermissionProvenance as Provenance,
  type NativePermissionRule,
} from "./native-permission-outcome.js";
export type NativeToolPermissionRule = NativePermissionRule & {
  ruleBehavior: "allow" | "deny" | "ask";
};
type Rule = NativeToolPermissionRule;
export interface NativeToolMetadata {
  name: string;
  mcpInfo?:
    | {
        serverName: string;
        toolName: string;
        nameKey?: string | undefined;
        denyKey?: string | undefined;
        standardKey?: { key: string } | undefined;
      }
    | undefined;
  aliasSkillToolNames?: readonly string[] | undefined;
  packagingAliasSkillToolNames?: readonly string[] | undefined;
  familyParentToolName?: string | undefined;
}
export interface NativeToolAliasPolicy {
  toolAliases?: Readonly<Record<string, string>> | undefined;
}
export interface NativeToolRegistryRead {
  active: boolean;
  tools: ReadonlyMap<string, { serverId: string; toolPart: string }>;
  servers: ReadonlyMap<string, { standardKey?: { key: string } }>;
  sessionKeyById: ReadonlyMap<string, string>;
  otherDenyOrAskNames: ReadonlyMap<string, readonly string[]>;
}
export interface NativeToolMetadataHost {
  registry?: (scope: Scope) => Fact<NativeToolRegistryRead>;
  inheritedGosling?: (fallback: true, scope: Scope) => Fact<boolean>;
  rp?: (scope: Scope) => Fact<boolean>;
  snappyLighthouse?: (fallback: false, scope: Scope) => Fact<unknown>;
  convertedSkillsPluginConfig?: (
    scope: Scope,
  ) => Fact<{ convertedSkillsAsPlugins?: unknown } | undefined>;
  disklessLaunch?: (scope: Scope) => Fact<boolean>;
  warn?: (message: string, level: "warn", scope: Scope) => Fact<void>;
}
interface McpName {
  serverName: string;
  toolName: string | undefined;
}
interface PreparedRule {
  matchesGlob: ((text: string) => boolean) | undefined;
  coversMcpTool: (name: McpName | null) => boolean;
}
interface PreparedTool {
  name: string;
  mcpInfo: () => McpName | null;
  aliasSources: () => string[];
  mcpServerRuleNames: () => string[];
  otherDenyOrAskReads: () => PreparedTool[];
}
function need<T>(value: T | undefined, dependency: string): T {
  if (value === undefined)
    throw new NativePermissionDependencyError(
      dependency,
      "Required native named-tool fact is unavailable",
    );
  return value;
}
/** Native In deliberately preserves underscores/hyphens and has the claude.ai special case. */
export function nativeMcpNamePart(value: string): string {
  let result = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (value.startsWith("claude.ai "))
    result = result.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return result;
}
function parseMcpName(value: string): McpName | null {
  const [kind, server, ...tool] = value.split("__");
  if (kind !== "mcp" || !server) return null;
  return {
    serverName: server,
    toolName: tool.length > 0 ? tool.join("__") : undefined,
  };
}
function serverPrefix(value: string): string {
  return `mcp__${nativeMcpNamePart(value)}__`;
}
function canonicalToolName(tool: NativeToolMetadata): string {
  return tool.mcpInfo
    ? `${serverPrefix(tool.mcpInfo.serverName)}${nativeMcpNamePart(tool.mcpInfo.toolName)}`
    : tool.name;
}
/** Literal '*' only; question marks, brackets, escapes and newlines retain source string semantics. */
function compileStar(pattern: string): (text: string) => boolean {
  const pieces = pattern.split("*"),
    head = pieces[0] ?? "";
  if (pieces.length === 1) return (text) => head === text;
  const tail = pieces.at(-1) ?? "";
  let middle: string[] | undefined;
  const searches: ((text: string, from: number, limit: number) => number)[] =
    [];
  return (text) => {
    const limit = text.length - tail.length;
    if (limit < head.length || !text.startsWith(head) || !text.endsWith(tail))
      return false;
    middle ??= pieces.slice(1, -1).filter((value) => value !== "");
    let from = head.length;
    for (const [index, piece] of middle.entries()) {
      const at = (searches[index] ??= compileLiteralSearch(piece))(
        text,
        from,
        limit,
      );
      if (at === -1) return false;
      from = at + piece.length;
    }
    return true;
  };
}
function compileLiteralSearch(
  needle: string,
): (text: string, from: number, limit: number) => number {
  if (!needle.includes(needle.charAt(0), 1))
    return (text, from, limit) => {
      const at = text.indexOf(needle, from);
      return at + needle.length > limit ? -1 : at;
    };
  const table = new Int32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index++) {
    while (
      matched > 0 &&
      needle.charCodeAt(index) !== needle.charCodeAt(matched)
    )
      matched = table[matched - 1] ?? 0;
    if (needle.charCodeAt(index) === needle.charCodeAt(matched)) matched++;
    table[index] = matched;
  }
  return (text, from, limit) => {
    for (let index = from, matched = 0; index < limit; index++) {
      while (
        matched > 0 &&
        text.charCodeAt(index) !== needle.charCodeAt(matched)
      )
        matched = table[matched - 1] ?? 0;
      if (text.charCodeAt(index) === needle.charCodeAt(matched)) matched++;
      if (matched === needle.length) return index - needle.length + 1;
    }
    return -1;
  };
}
export function createNativeToolMetadataMatcher(host: NativeToolMetadataHost) {
  const warnings = new Set<string>();
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    provenance: Provenance[];
  }>();
  const frame = () => need(frames.getStore(), "toolMetadata.scope");
  const use = <T>(receipt: Fact<T>) =>
    readNativePermissionFact(receipt, frame().scope, frame().provenance);
  const registry = () =>
    use(need(host.registry, "toolMetadata.registry")(frame().scope));
  function hhe(
    name: string,
    aliases: NativeToolAliasPolicy["toolAliases"],
  ): string[] {
    const alias =
      aliases && Object.hasOwn(aliases, name) ? aliases[name] : undefined;
    return alias !== undefined && alias !== name ? [name, alias] : [name];
  }
  function vQ(
    name: string,
    aliases: NativeToolAliasPolicy["toolAliases"],
  ): string[] {
    if (!aliases) return [];
    const result: string[] = [];
    for (const [key, value] of Object.entries(aliases))
      if (value === name) result.push(key);
    return result;
  }
  function V(rule: Rule): PreparedRule {
    const name = rule.ruleValue.toolName;
    let glob: ((text: string) => boolean) | undefined,
      covers: ((name: McpName | null) => boolean) | undefined;
    const lower = name.startsWith("mcp__plugin_*_");
    return {
      matchesGlob: name.includes("*")
        ? (text) =>
            (glob ??= compileStar(lower ? name.toLowerCase() : name))(
              lower ? text.toLowerCase() : text,
            )
        : undefined,
      coversMcpTool: (metadata) => (covers ??= sOn(name))(metadata),
    };
  }
  function sOn(name: string): (tool: McpName | null) => boolean {
    const rule = parseMcpName(name);
    if (rule === null) return () => false;
    const server = rule.toolName === undefined || rule.toolName === "*";
    const pattern =
      rule.toolName !== undefined && rule.toolName.includes("*")
        ? rule.toolName
        : undefined;
    let match: ((text: string) => boolean) | undefined;
    return (tool) =>
      tool !== null &&
      rule.serverName === tool.serverName &&
      (server ||
        (tool.toolName !== undefined &&
          pattern !== undefined &&
          (match ??= compileStar(pattern))(tool.toolName)));
  }
  function normalizedServerName(name: string): string {
    return (
      parseMcpName(`${serverPrefix(name)}x`)?.serverName ??
      nativeMcpNamePart(name)
    );
  }
  function serverRuleNames(tool: NativeToolMetadata): string[] {
    if (tool.mcpInfo) {
      const name = tool.mcpInfo.serverName;
      return [
        `mcp__${nativeMcpNamePart(name)}`,
        `mcp__${normalizedServerName(name)}`,
      ];
    }
    const result: string[] = [];
    if (!tool.name.startsWith("mcp__")) return result;
    for (
      let at = tool.name.indexOf("__", 5);
      at !== -1;
      at = tool.name.indexOf("__", at + 1)
    )
      result.push(tool.name.slice(0, at));
    return result;
  }
  function alternateDenyOrAskNames(tool: NativeToolMetadata): string[] {
    const nameKey =
      tool.mcpInfo?.nameKey !== undefined &&
      use(
        need(host.inheritedGosling, "features.inheritedGosling")(
          true,
          frame().scope,
        ),
      )
        ? tool.mcpInfo.nameKey
        : undefined;
    if (
      !tool.mcpInfo ||
      (tool.mcpInfo.denyKey === undefined &&
        nameKey === undefined &&
        !registry().active)
    )
      return [];
    const name = canonicalToolName(tool);
    const known = registry().otherDenyOrAskNames.get(name) ?? [];
    const prefix = serverPrefix(tool.mcpInfo.serverName);
    const toolPart = name.slice(prefix.length);
    const candidates = [
      tool.mcpInfo.standardKey?.key,
      tool.mcpInfo.denyKey,
      nameKey,
    ].flatMap((key) => (key === undefined ? [] : [`mcp__${key}__${toolPart}`]));
    return [...new Set([...known, ...candidates])].filter(
      (value) => value !== name,
    );
  }
  function w(
    tool: NativeToolMetadata,
    aliases: NativeToolAliasPolicy["toolAliases"],
  ): PreparedTool {
    const name = canonicalToolName(tool);
    let parsed: McpName | null | undefined,
      alias: string[] | undefined,
      serverNames: string[] | undefined,
      other: PreparedTool[] | undefined;
    return {
      name,
      mcpInfo: () =>
        parsed === undefined ? (parsed = parseMcpName(name)) : parsed,
      aliasSources: () => (alias ??= vQ(name, aliases)),
      mcpServerRuleNames: () => (serverNames ??= serverRuleNames(tool)),
      otherDenyOrAskReads: () =>
        (other ??= alternateDenyOrAskNames(tool).map((value) =>
          w({ name: value }, aliases),
        )),
    };
  }
  function nOn(name: string): string | undefined {
    if (!/-a[0-9a-f]{8}(?:__|$)/.test(name) || !registry().active)
      return undefined;
    if (!name.startsWith("mcp__")) return undefined;
    const rest = name.slice(5),
      at = rest.indexOf("__"),
      server = at === -1 ? rest : rest.slice(0, at);
    const result = `mcp__${/^(.*[^_])-a[0-9a-f]{8}$/.exec(server)?.[1] ?? server}${at === -1 ? "" : rest.slice(at)}`;
    return result === name ? undefined : result;
  }
  function fLt(
    rule: string,
    name: string,
  ): { rule: string; row: string } | undefined {
    const normalized = nOn(rule);
    if (normalized === undefined) return undefined;
    const { tools, servers, sessionKeyById } = registry();
    const tool = tools.get(name),
      standard =
        tool === undefined
          ? undefined
          : servers.get(tool.serverId)?.standardKey?.key;
    return tool === undefined ||
      standard === undefined ||
      sessionKeyById.get(tool.serverId) !== standard
      ? undefined
      : { rule: normalized, row: `mcp__${standard}__${tool.toolPart}` };
  }
  function safePackagingAlias(strict: boolean): boolean {
    if (use(need(host.rp, "features.rp")(frame().scope))) return true;
    if (strict) return false;
    const switched =
      use(
        need(host.snappyLighthouse, "features.snappyLighthouse")(
          false,
          frame().scope,
        ),
      ) === true;
    if (!(
      switched ||
      use(
        need(
          host.convertedSkillsPluginConfig,
          "settings.convertedSkillsPluginConfig",
        )(frame().scope),
      )?.convertedSkillsAsPlugins === true
    ))
      return false;
    return !use(
      need(host.disklessLaunch, "runtime.disklessLaunch")(frame().scope),
    );
  }
  function warnAmbiguous(
    rule: Rule["ruleValue"],
    tool: NativeToolMetadata,
  ): void {
    const name = rule.toolName;
    if (warnings.has(name)) return;
    warnings.add(name);
    const message = tool.mcpInfo
      ? `Allow rule "${name}" does not allow the tools named "${serverPrefix(tool.mcpInfo.serverName)}<tool>": they belong to another MCP server than the rule names. To allow them, use "${serverPrefix(tool.mcpInfo.serverName)}*".`
      : `Allow rule "${name}" does not allow "${tool.name}": the name reads as more than one MCP server's. To allow it, use the tool's full name.`;
    use(
      need(host.warn, "toolMetadata.ambiguousAllowWarning")(
        message,
        "warn",
        frame().scope,
      ),
    );
  }
  function allowsExactServer(
    ruleName: string,
    tool: NativeToolMetadata,
  ): boolean {
    return (
      tool.mcpInfo
        ? [`mcp__${nativeMcpNamePart(tool.mcpInfo.serverName)}`]
        : serverRuleNames(tool)
    ).every((name) => ruleName === name || ruleName.startsWith(`${name}__`));
  }
  function N(
    tool: NativeToolMetadata,
    rule: Rule,
    options: {
      proxyExpansion?: boolean;
      globMatching?: boolean;
      toolAliases?: NativeToolAliasPolicy["toolAliases"];
    } = {},
    preparedRule = V(rule),
    preparedTool = w(tool, options.toolAliases),
  ): boolean {
    const {
      proxyExpansion = false,
      globMatching = false,
      toolAliases,
    } = options;
    if (rule.ruleBehavior !== "allow" && tool.mcpInfo !== undefined) {
      const nested = { proxyExpansion, globMatching, toolAliases };
      if (
        preparedTool
          .otherDenyOrAskReads()
          .some((value) =>
            N({ name: value.name }, rule, nested, preparedRule, value),
          )
      )
        return true;
      const standard = fLt(rule.ruleValue.toolName, preparedTool.name);
      if (
        standard !== undefined &&
        N(
          { name: standard.row },
          {
            ...rule,
            ruleValue: { ...rule.ruleValue, toolName: standard.rule },
          },
          nested,
        )
      )
        return true;
    }
    const name = preparedTool.name;
    if (rule.ruleValue.toolName === name) return true;
    const parent =
      "familyParentToolName" in tool ? tool.familyParentToolName : undefined;
    if (
      parent !== undefined &&
      tool.mcpInfo === undefined &&
      rule.ruleValue.toolName === parent
    )
      return true;
    if (
      proxyExpansion &&
      hhe(rule.ruleValue.toolName, toolAliases).includes(name)
    )
      return true;
    const glob = preparedRule.matchesGlob;
    if (
      globMatching &&
      glob !== undefined &&
      (glob(name) || (proxyExpansion && preparedTool.aliasSources().some(glob)))
    )
      return true;
    const covers = preparedRule.coversMcpTool(preparedTool.mcpInfo());
    if (rule.ruleBehavior === "allow") {
      if (!covers) return false;
      if (allowsExactServer(rule.ruleValue.toolName, tool)) return true;
      warnAmbiguous(rule.ruleValue, tool);
      return false;
    }
    return (
      covers ||
      (rule.source !== "mcpServerPolicy" &&
        rule.ruleValue.toolName.startsWith("mcp__") &&
        preparedTool.mcpServerRuleNames().includes(rule.ruleValue.toolName))
    );
  }
  function nh(
    policy: NativeToolAliasPolicy,
    tool: NativeToolMetadata,
    rule: Rule,
    prepared = V(rule),
    metadata?: PreparedTool,
    strict = false,
  ): boolean {
    const options = {
      proxyExpansion:
        rule.source !== "cliArg" && rule.source !== "toolsNarrowing",
      globMatching: true,
      toolAliases: policy.toolAliases,
    };
    if (N(tool, rule, options, prepared, metadata)) return true;
    if (
      ("aliasSkillToolNames" in tool
        ? tool.aliasSkillToolNames
        : undefined
      )?.some((name) => N({ name }, rule, options, prepared))
    )
      return true;
    const packaging =
      "packagingAliasSkillToolNames" in tool
        ? tool.packagingAliasSkillToolNames
        : undefined;
    if (
      packaging === undefined ||
      (rule.ruleValue.toolName.includes("*") && !safePackagingAlias(strict))
    )
      return false;
    return packaging.some((name) => N({ name }, rule, options, prepared));
  }
  function evaluate<T>(scope: Scope, run: () => T) {
    const provenance: Provenance[] = [];
    return frames.run({ scope, provenance }, () => ({
      result: run(),
      provenance,
    }));
  }
  function matches(
    scope: Scope,
    policy: Fact<NativeToolAliasPolicy>,
    tool: Fact<NativeToolMetadata>,
    rule: Rule,
    strict = false,
  ) {
    return evaluate(scope, () =>
      nh(use(policy), use(tool), rule, undefined, undefined, strict),
    );
  }
  /** Exact core Zl callsite construction; not a general registry metadata lookup. */
  function matchesSourceConstructedReadEditBash(
    scope: Scope,
    policy: Fact<NativeToolAliasPolicy>,
    name: "Bash" | "Read" | "Edit",
    rule: Rule,
  ) {
    return evaluate(scope, () => nh(use(policy), { name }, rule));
  }
  return {
    matches,
    matchesSourceConstructedReadEditBash,
    host,
    warningNames: () => [...warnings],
  };
}
