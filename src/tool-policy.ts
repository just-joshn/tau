import { z } from "zod";
import { sanitizeMcpName } from "./mcp-config.js";
import { parseSkillToolList } from "./skills.js";
import { parseNativePermissionRule } from "./native-permission-rules.js";
import {
  matchesLocalSkillPermissionRule,
  parseSkillPermissionRule,
} from "./skill-runtime.js";

export const toolNameSchema = z.enum([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "NotebookEdit",
]);
export type ToolName = z.infer<typeof toolNameSchema>;
export const taskPolicyNameSchema = z.enum([
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
]);
export const planPolicyNameSchema = z.enum(["EnterPlanMode", "ExitPlanMode"]);
export const webToolNameSchema = z.enum(["WebFetch", "WebSearch"]);
export const monitorWorktreeNameSchema = z.enum([
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
]);
export const eagerCatalogNameSchema = z.enum([
  "ListAgents",
  "ReportFindings",
  "ScheduleWakeup",
  "Workflow",
]);
export const agentPolicyNameSchema = z.enum(["Agent", "Task"]);
export const backgroundTaskPolicyNameSchema = z.enum([
  "TaskStop",
  "KillShell",
  "KillBash",
]);
const agentRule = (rule: string): [string, string, string?] | null => {
  if (rule === "Agent" || rule === "Task") return [rule, rule];
  const tool = rule.startsWith("Agent(")
    ? "Agent"
    : rule.startsWith("Task(")
      ? "Task"
      : undefined;
  if (!tool || !rule.endsWith(")")) return null;
  let escapes = 0;
  for (let index = rule.length - 2; index >= 0 && rule[index] === "\\"; index--)
    escapes++;
  if (escapes % 2) return null;
  const raw = rule.slice(tool.length + 1, -1);
  return [
    rule,
    tool,
    raw.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\"),
  ];
};
export const selectableToolNameSchema = z.union([
  toolNameSchema,
  z.literal("Skill"),
  z.literal("ToolSearch"),
  taskPolicyNameSchema,
  planPolicyNameSchema,
  agentPolicyNameSchema,
  backgroundTaskPolicyNameSchema,
  webToolNameSchema,
  monitorWorktreeNameSchema,
  eagerCatalogNameSchema,
]);
const scopedBuiltinFamilies = new Set(["Read", "Write", "Edit", "Bash"]);
// Ng/joi's finite native compatibility set, under fYr's default-true feature.
// Bash is deliberately absent: xr normalizes Bash()/Bash(*) to bare Bash.
const compatibilityWildcardTools = new Set([
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LSP",
  "SendUserFile",
]);
function builtinCallRule(rule: string): boolean {
  if (!rule.includes("(")) return false;
  const parsed = parseNativePermissionRule(rule);
  return (
    parsed.kind !== "malformed" && scopedBuiltinFamilies.has(parsed.toolName)
  );
}
export const toolRuleNameSchema = z.union([
  toolNameSchema,
  z.literal("ToolSearch"),
  taskPolicyNameSchema,
  planPolicyNameSchema,
  backgroundTaskPolicyNameSchema,
  webToolNameSchema,
  monitorWorktreeNameSchema,
  eagerCatalogNameSchema,
  z.string().regex(/^(TaskStop|KillShell|KillBash)\([\s\S]*\)$/),
  z.string().regex(/^WebFetch\([\s\S]*\)$/),
  z.string().refine((rule) => agentRule(rule) !== null),
  z.string().refine(builtinCallRule),
  z.string().refine((rule) => parseSkillPermissionRule(rule) !== undefined),
  z.string().regex(/^mcp__[a-zA-Z0-9_-]+(?:__[a-zA-Z0-9_*-]+)?$/),
]);
export const toolPolicySchema = z.object({
  tools: z.array(selectableToolNameSchema).optional(),
  allowedTools: z.array(toolRuleNameSchema).default([]),
  disallowedTools: z.array(toolRuleNameSchema).default([]),
  askedTools: z.array(toolRuleNameSchema).optional(),
  sourcedRules: z
    .array(
      z.object({
        source: z.string(),
        behavior: z.enum(["allow", "deny", "ask"]),
        rule: z.string(),
        path: z.string().optional(),
      }),
    )
    .optional(),
});
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

function parseNames(value: string, builtinsOnly = false): string[] {
  if (!value.trim()) return [];
  // Retain existing whitespace separators while preserving spaces in Skill calls.
  let inCall = false;
  const separated = Array.from(value.trim(), (char) => {
    if (char === "(") inCall = true;
    if (char === ")") inCall = false;
    return !inCall && /\s/.test(char) ? " " : char;
  }).join("");
  return parseSkillToolList(separated).map((name) => {
    const result = (
      builtinsOnly ? selectableToolNameSchema : toolRuleNameSchema
    ).safeParse(name);
    if (!result.success)
      throw new Error(
        `Unsupported tool rule: ${name}. Use exact tool names${builtinsOnly ? "" : ", Read(path), Edit(path), Bash(command), Skill[(name)], or mcp__server[__tool-pattern]"}; cross-server wildcards are not supported.`,
      );
    return result.data;
  });
}

/** Ordinary MCP whole-tool matching: parsed server coverage plus actual-server prefix. */
export function matchesMcpRule(
  rule: string,
  qualifiedName: string,
  serverName: string,
): boolean {
  if (rule === qualifiedName) return true;
  const parts = rule.split("__"),
    actual = qualifiedName.split("__");
  if (parts[0] !== "mcp" || !parts[1] || parts[1] !== actual[1]) return false;
  const serverPrefix = `mcp__${sanitizeMcpName(serverName)}`;
  if (rule !== serverPrefix && !rule.startsWith(serverPrefix + "__"))
    return false;
  if (parts.length === 2) return true;
  const pattern = parts.slice(2).join("__"),
    value = actual.slice(2).join("__");
  if (!pattern.includes("*")) return false;
  const segments = pattern.split("*");
  const first = segments[0] ?? "";
  if (!value.startsWith(first)) return false;
  let cursor = first.length;
  for (const segment of segments.slice(1, -1)) {
    const index = value.indexOf(segment, cursor);
    if (index < 0) return false;
    cursor = index + segment.length;
  }
  const end = segments.at(-1) ?? "";
  return value.endsWith(end) && value.length - end.length >= cursor;
}

export function parseToolPolicy(options: {
  tools?: string | undefined;
  allowedTools?: string[];
  disallowedTools?: string[];
}): ToolPolicy {
  return toolPolicySchema.parse({
    tools:
      options.tools === undefined || options.tools === "default"
        ? undefined
        : parseNames(options.tools, true),
    allowedTools: [
      ...new Set(
        (options.allowedTools ?? []).flatMap((value) => parseNames(value)),
      ),
    ],
    disallowedTools: [
      ...new Set(
        (options.disallowedTools ?? []).flatMap((value) => parseNames(value)),
      ),
    ],
  });
}

export type PermissionRuleBehavior = "allow" | "deny" | "ask";
export interface PolicyRuleMatch {
  rule: string;
  source?: string;
  path?: string;
}
interface ParsedSettingsRule {
  tool: string;
  /** Native Ng preserves allow Tool()/Tool(*) as compatibility content under its default feature. */
  compatibilityWildcard?: true;
  /** Dedicated native file/Bash consumers, never a whole-tool or generic key-pattern rule. */
  dedicated?: true;
  parameter?: { key: string; pattern: string };
  skillRule?: string;
  agentRule?: string;
}

function splitSourcedRule(rule: string): ParsedSettingsRule {
  const trimmed = rule;
  const skill = parseSkillPermissionRule(trimmed);
  if (skill)
    return skill.content === undefined
      ? { tool: "Skill" }
      : { tool: "Skill", skillRule: trimmed };
  const agent = agentRule(trimmed);
  if (agent) return { tool: "Agent", agentRule: trimmed };
  // WebFetch(domain:…) content belongs to the web tool's own matcher.
  if (/^WebFetch\([\s\S]*\)$/.test(trimmed)) {
    const parsed = parseNativePermissionRule(trimmed);
    if (parsed.kind === "call") return { tool: "WebFetch", dedicated: true };
    if (parsed.kind === "bare") return { tool: "WebFetch" };
  }
  if (builtinCallRule(trimmed)) {
    const parsed = parseNativePermissionRule(trimmed);
    if (parsed.kind === "bare")
      return compatibilityWildcardTools.has(parsed.toolName)
        ? { tool: parsed.toolName, compatibilityWildcard: true }
        : { tool: parsed.toolName };
    if (parsed.kind === "call") {
      const colon = parsed.content.indexOf(":"),
        key = parsed.content.slice(0, colon).trim(),
        pattern = parsed.content.slice(colon + 1).trim();
      return {
        tool: parsed.toolName,
        dedicated: true,
        ...(colon > 0 && key && pattern ? { parameter: { key, pattern } } : {}),
      };
    }
  }
  const open = trimmed.indexOf("(");
  if (open === -1) {
    if (!toolRuleNameSchema.safeParse(trimmed).success)
      throw new Error(`Unsupported settings permission rule: ${rule}`);
    return { tool: trimmed };
  }
  const tool = trimmed.slice(0, open),
    body = trimmed.slice(open + 1, -1);
  if (!trimmed.endsWith(")") || !toolRuleNameSchema.safeParse(tool).success)
    throw new Error(`Unsupported settings permission rule: ${rule}`);
  // Source xr treats empty or '*' call content as a whole-tool rule.
  if (body === "" || body === "*")
    return compatibilityWildcardTools.has(tool)
      ? { tool, compatibilityWildcard: true }
      : { tool };
  // Generic source Gc/lpe applies primitive argument matching to exact MCP names.
  // Built-in path and shell rules have their own dedicated parsers and are not guessed here.
  const decodedBody = body
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replaceAll("\\\\", "\\");
  const colon = decodedBody.indexOf(":");
  if (
    ((tool.startsWith("mcp__") && !tool.includes("*")) ||
      backgroundTaskPolicyNameSchema.safeParse(tool).success) &&
    colon > 0
  ) {
    const key = decodedBody.slice(0, colon).trim(),
      pattern = decodedBody.slice(colon + 1).trim();
    if (key && pattern) return { tool, parameter: { key, pattern } };
  }
  throw new Error(
    `Unsupported settings permission rule: ${rule}. Use exact tool names, supported file/Bash call rules, or exact MCP primitive argument rules.`,
  );
}

/** Source vx/p: '*' is the only wildcard; all other characters are literal. */
export function matchesPermissionArgument(
  pattern: string,
  value: string,
): boolean {
  const pieces = pattern.split("*");
  if (pieces.length === 1) return pattern === value;
  const start = pieces[0] ?? "",
    end = pieces.at(-1) ?? "";
  const boundary = value.length - end.length;
  if (
    boundary < start.length ||
    !value.startsWith(start) ||
    !value.endsWith(end)
  )
    return false;
  let cursor = start.length;
  for (const piece of pieces.slice(1, -1).filter(Boolean)) {
    const index = value.indexOf(piece, cursor);
    if (index === -1 || index + piece.length > boundary) return false;
    cursor = index + piece.length;
  }
  return true;
}

function matchesName(
  rule: string,
  name: string,
  serverName?: string,
  behavior?: PermissionRuleBehavior,
): boolean {
  if (
    serverName === undefined &&
    scopedBuiltinFamilies.has(name) &&
    builtinCallRule(rule)
  ) {
    const parsed = parseNativePermissionRule(rule);
    return (
      parsed.kind === "bare" &&
      parsed.toolName === name &&
      (behavior !== "allow" || !compatibilityWildcardTools.has(name))
    );
  }
  if (
    (name === "Agent" || name === "Task") &&
    (rule === "Agent" || rule === "Task")
  )
    return true;
  if (
    backgroundTaskPolicyNameSchema.safeParse(name).success &&
    backgroundTaskPolicyNameSchema.safeParse(rule).success
  )
    return true;
  return serverName === undefined
    ? rule === name
    : matchesMcpRule(rule, name, serverName);
}

function matchesBuiltinPrimitive(
  rule: string,
  name: string,
  behavior: PermissionRuleBehavior,
  input: unknown,
): boolean {
  if (
    behavior === "allow" ||
    !scopedBuiltinFamilies.has(name) ||
    !builtinCallRule(rule)
  )
    return false;
  const parsed = splitSourcedRule(rule);
  if (
    parsed.tool !== name ||
    !parsed.parameter ||
    typeof input !== "object" ||
    input === null ||
    !Object.hasOwn(input, parsed.parameter.key)
  )
    return false;
  const value: unknown = Reflect.get(input, parsed.parameter.key);
  return (
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint") &&
    matchesPermissionArgument(parsed.parameter.pattern, String(value).trim())
  );
}

/** Native Xie/G9r compare Agent(type) content exactly; Task is the legacy tool alias. */
export function matchingAgentTypeDeny(
  policy: ToolPolicy,
  agentType: string,
): PolicyRuleMatch | undefined {
  const direct = policy.disallowedTools.find(
    (rule) => agentRule(rule)?.[2] === agentType,
  );
  if (direct !== undefined) return { rule: direct, source: "cliArg" };
  const sourced = policy.sourcedRules?.find(
    (rule) =>
      rule.behavior === "deny" && agentRule(rule.rule)?.[2] === agentType,
  );
  return sourced === undefined
    ? undefined
    : {
        rule: sourced.rule,
        source: sourced.source,
        ...(sourced.path === undefined ? {} : { path: sourced.path }),
      };
}

function matchesAgentRule(
  rule: string,
  input: unknown,
  behavior: PermissionRuleBehavior,
): boolean {
  const parsed = agentRule(rule);
  if (!parsed) return false;
  if (parsed[2] === undefined || parsed[2] === "" || parsed[2] === "*")
    return true;
  if (typeof input !== "object" || input === null) return false;
  const value: object = input;
  // Fresh ordinary Agent dispatch consumes exact type denies. G9r's exact asks
  // gate background/resume/observer admission, not this fresh foreground path.
  if (
    behavior === "deny" &&
    Object.hasOwn(value, "subagent_type") &&
    Reflect.get(value, "subagent_type") === parsed[2]
  )
    return true;
  if (behavior === "allow") return false;
  const colon = parsed[2].indexOf(":"),
    key = parsed[2].slice(0, colon).trim(),
    pattern = parsed[2].slice(colon + 1).trim();
  if (colon <= 0 || !key || !pattern || !Object.hasOwn(value, key))
    return false;
  const field: unknown = Reflect.get(value, key);
  return (
    (typeof field === "string" ||
      typeof field === "number" ||
      typeof field === "boolean" ||
      typeof field === "bigint") &&
    matchesPermissionArgument(pattern, String(field).trim())
  );
}

/** Skill's native matcher plus the generic primitive deny/ask input-key path. */
function matchesSkillRule(
  rule: string,
  behavior: PermissionRuleBehavior,
  input: unknown,
): boolean {
  const parsed = parseSkillPermissionRule(rule);
  if (!parsed) return false;
  if (parsed.content === undefined) return true;
  const record =
    typeof input === "object" && input !== null ? input : undefined;
  const skill: unknown =
    record && Object.hasOwn(record, "skill")
      ? Reflect.get(record, "skill")
      : undefined;
  if (
    typeof skill === "string" &&
    matchesLocalSkillPermissionRule(
      rule,
      skill.trim().replace(/^\//, ""),
      behavior,
    )
  )
    return true;
  if (behavior === "allow" || !record) return false;
  const colon = parsed.content.indexOf(":"),
    key = parsed.content.slice(0, colon).trim(),
    pattern = parsed.content.slice(colon + 1).trim();
  if (colon <= 0 || !key || !pattern || !Object.hasOwn(record, key))
    return false;
  const value: unknown = Reflect.get(record, key);
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    typeof value !== "bigint"
  )
    return false;
  return matchesPermissionArgument(pattern, String(value).trim());
}

export function matchingToolRule(
  policy: ToolPolicy,
  behavior: PermissionRuleBehavior,
  name: string,
  context: { serverName?: string; input?: unknown } = {},
): PolicyRuleMatch | undefined {
  const list =
    behavior === "allow"
      ? policy.allowedTools
      : behavior === "deny"
        ? policy.disallowedTools
        : (policy.askedTools ?? []);
  const direct = list.find((rule) =>
    name === "Skill"
      ? matchesSkillRule(rule, behavior, context.input)
      : name === "Agent" || name === "Task"
        ? matchesAgentRule(rule, context.input, behavior)
        : matchesName(rule, name, context.serverName, behavior) ||
          (context.serverName === undefined &&
            matchesBuiltinPrimitive(rule, name, behavior, context.input)),
  );
  if (direct !== undefined) return { rule: direct, source: "cliArg" };
  for (const sourced of policy.sourcedRules ?? []) {
    if (sourced.behavior !== behavior) continue;
    const parsed = splitSourcedRule(sourced.rule);
    if (parsed.compatibilityWildcard && behavior === "allow") continue;
    if (
      parsed.dedicated &&
      (behavior === "allow" || parsed.parameter === undefined)
    )
      continue;
    if (!matchesName(parsed.tool, name, context.serverName)) continue;
    if (
      parsed.agentRule !== undefined &&
      !matchesAgentRule(parsed.agentRule, context.input, behavior)
    )
      continue;
    if (
      parsed.skillRule !== undefined &&
      !matchesSkillRule(parsed.skillRule, behavior, context.input)
    )
      continue;
    if (parsed.parameter !== undefined) {
      // aEt calls generic Gc for deny/ask only; whole-tool allows exclude ruleContent.
      if (behavior === "allow") continue;
      const input = context.input;
      if (
        typeof input !== "object" ||
        input === null ||
        !Object.hasOwn(input, parsed.parameter.key)
      )
        continue;
      const value: unknown = Reflect.get(input, parsed.parameter.key);
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        typeof value !== "bigint"
      )
        continue;
      if (
        !matchesPermissionArgument(
          parsed.parameter.pattern,
          String(value).trim(),
        )
      )
        continue;
    }
    return {
      rule: sourced.rule,
      source: sourced.source,
      ...(sourced.path !== undefined ? { path: sourced.path } : {}),
    };
  }
  return undefined;
}

/** Rwn/zc deliberately excludes CLI/launch narrowing from inherited file Read protection. */
export function inheritedReadDeny(
  policy: ToolPolicy,
): PolicyRuleMatch | undefined {
  for (const rule of policy.sourcedRules ?? []) {
    if (
      rule.behavior !== "deny" ||
      ["toolsNarrowing", "cliArg", "command"].includes(rule.source)
    )
      continue;
    const parsed = splitSourcedRule(rule.rule);
    if (
      parsed.tool === "Read" &&
      parsed.parameter === undefined &&
      !parsed.dedicated
    )
      return {
        rule: rule.rule,
        source: rule.source,
        ...(rule.path !== undefined ? { path: rule.path } : {}),
      };
  }
  return undefined;
}

/** Preserve source identity: inherited settings restrictions differ from CLI launch narrowing. */
export function combineToolPolicy(
  cliPolicy: ToolPolicy,
  sourcedRules: readonly NonNullable<ToolPolicy["sourcedRules"]>[number][],
): ToolPolicy {
  const policy = toolPolicySchema.parse(cliPolicy);
  for (const rule of sourcedRules) splitSourcedRule(rule.rule);
  if (sourcedRules.length === 0) return policy;
  return {
    ...policy,
    sourcedRules: [
      ...(policy.sourcedRules ?? []),
      ...sourcedRules.map((rule) => ({ ...rule })),
    ],
  };
}

/** Local dispatch classification; API serializers must omit the marker fields. */
export class ToolPermissionDenied extends Error {
  constructor(
    message: string,
    readonly decideLocation?: "pre-ask",
  ) {
    super(message);
    this.name = "ToolPermissionDenied";
  }
}

/** Result marker fields for a permission denial, local only. */
export function permissionDeniedMarkers(error: unknown): {
  permissionDenied?: true;
  permissionDecideLocation?: "pre-ask";
} {
  if (!(error instanceof ToolPermissionDenied)) return {};
  return error.decideLocation === undefined
    ? { permissionDenied: true }
    : {
        permissionDenied: true,
        permissionDecideLocation: error.decideLocation,
      };
}
export class ToolInputRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputRejected";
  }
}
