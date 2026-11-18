import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import ignore from "ignore";
import { readBoundedConfigurationText, type PathReadPolicy } from "./configuration.js";

export const SKILL_MAX_BYTES = 1_000_000;
export const SKILL_EXPANSION_MAX_CHARS = 4_000_000;
export type SkillSource = "policySettings" | "userSettings" | "projectSettings" | "plugin";
export type SkillEffort = "low" | "medium" | "high" | "xhigh" | "max" | number;
export interface SkillLocation { directory: string; source: SkillSource }
export interface SkillDiagnostic { path: string; source: SkillSource; reason: string; message: string }
export interface LocalSkill {
  name: string; displayName: string; description: string; hasUserSpecifiedDescription: boolean;
  path: string; canonicalPath: string; baseDir: string; source: SkillSource;
  allowedTools: readonly string[]; disallowedTools: readonly string[]; argumentNames: readonly string[];
  userInvocable: boolean; disableModelInvocation: boolean; contentLength: number;
  argumentHint?: string; whenToUse?: string; version?: string; model?: string; effort?: SkillEffort;
  context?: "fork"; agent?: string; background?: boolean; shell?: "bash" | "powershell";
  paths?: readonly string[]; hooks?: unknown; metadata?: Readonly<Record<string, unknown>>;
  /** Explicit plugin host provenance; never inferred from the document's frontmatter. */
  pluginRoot?: string;
}
export interface SkillRegistryOptions {
  cwd: string;
  userConfigDir?: string;
  /** Managed configuration root; skills live beneath .claude/skills, as in the source. */
  managedRoot?: string;
  /** Explicit project roots, nearest first. No home/repository boundary is inferred. */
  projectDirectories?: readonly string[];
  additionalDirectories?: readonly string[];
  sources: { user: boolean; project: boolean };
  managedOnly?: boolean;
  readPolicy?: PathReadPolicy;
  /** Trust, gitignore, connector/sync-owned folders and organization policy belong to the caller. */
  admitSource?: (location: SkillLocation) => boolean | string | Promise<boolean | string>;
  admitSkill?: (skill: Readonly<LocalSkill>) => boolean | string | Promise<boolean | string>;
  normalizeModel?: (name: string) => string;
  /** Return the validated hooks object, or throw to withhold hooks AND allowed-tools. */
  validateHooks?: (hooks: unknown, path: string) => unknown;
  /** Caller can implement the full shipped Unicode/reserved-namespace name policy. */
  isOfferedName?: (name: string) => boolean;
}
export interface SkillInvocationOptions {
  invocation: "model" | "user";
  sessionId: string;
  /** Effective effort string after the caller resolves model/policy defaults. */
  effortLevel?: string;
  /** Source uses a shell parser for positional arguments. Supply exact tokens for complex syntax. */
  argumentTokens?: readonly string[];
  signal?: AbortSignal;
  /** Executes shell substitutions under the caller's tool permissions, never this module's authority. */
  processShellBlocks?: (text: string, skill: Readonly<LocalSkill>, signal?: AbortSignal) => Promise<string>;
  authorize?: (skill: Readonly<LocalSkill>) => boolean | string | Promise<boolean | string>;
}
export interface SkillInvocation {
  skill: Readonly<LocalSkill>; text: string;
  allowedTools: readonly string[]; disallowedTools: readonly string[];
  model?: string; effort?: SkillEffort; context?: "fork"; agent?: string; background?: boolean; hooks?: unknown;
}
export interface AdmittedSkillDefinition { info: LocalSkill; body: string; isSkillMode?: boolean }
interface SkillDefinition extends AdmittedSkillDefinition {}
interface ParsedSkill { fields: Record<string, unknown>; content: string; parseError?: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const hookEvents = new Set("PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification UserPromptSubmit UserPromptExpansion SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop PreCompact PostCompact PreModelSwitch PostModelSwitch PermissionRequest PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged DirectoryAdded MessageDisplay".split(" "));
const unscannedGuardKeys = new Set(["metadata", "mcpServers", "lspServers"]);
function hasGuard(value: unknown): boolean { return record(value) && ["PreToolUse", "PermissionRequest"].some((key) => value[key] !== null && value[key] !== undefined && !(Array.isArray(value[key]) && value[key].length === 0)); }
function matcherShape(value: unknown): boolean {
  if (!record(value) || !("matcher" in value) && Object.keys(value).some((key) => hookEvents.has(key))) return false;
  const hooks = value.hooks; return Array.isArray(hooks) ? hooks.length > 0 : record(hooks) && ("matcher" in value || typeof hooks.type === "string");
}
function nestedGuard(value: unknown, depth = 3, matchersCount = true, inHooksList = false): boolean {
  if (hasGuard(value) || matchersCount && matcherShape(value)) return true;
  if (depth === 0 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => nestedGuard(item, depth - 1, matchersCount, inHooksList));
  if (inHooksList && record(value) && typeof value.type === "string") return false;
  return Object.entries(value).some(([key, item]) => !unscannedGuardKeys.has(key) && nestedGuard(item, depth - 1, matchersCount && !hookEvents.has(key), key === "hooks" && Array.isArray(item)));
}
function misplacedGuard(fields: Record<string, unknown>): boolean { return hasGuard(fields) || Object.entries(fields).some(([key, value]) => key !== "hooks" && !unscannedGuardKeys.has(key) && nestedGuard(value, 3, !hookEvents.has(key))); }
function absolute(path: string): string { if (!isAbsolute(path)) throw new Error(`Skill root must be absolute: ${path}`); return resolve(path); }
function offered(name: string): boolean { return name.length > 0 && name.length <= 256 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>]/u.test(name) && !/[^\P{Z} ]/u.test(name) && !name.includes("  ") && !/(?:^|:) | (?::|$)|^:|:$/.test(name); }
function boolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") return;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return;
}
function scalar(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function effort(value: unknown): SkillEffort | undefined {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = String(value).toLowerCase(), level = text === "med" ? "medium" : text;
  const named = (["low", "medium", "high", "xhigh", "max"] as const).find(name => name === level); if (named) return named;
  const parsed = Number.parseInt(text, 10); return Number.isInteger(parsed) ? parsed : undefined;
}
function quoteFallback(text: string): string {
  return text.split("\n").map((line) => {
    const [, key, value] = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line) ?? [];
    if (key === undefined || value === undefined) return line;
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) return line;
    if (value.startsWith("[") && value.endsWith("]")) { try { if (Array.isArray(parseYaml(value))) return line; } catch { /* Quote below. */ } }
    return /[{}[\]*&#!|>%@`]|: /.test(value) ? `${key}: ${JSON.stringify(value)}` : line;
  }).join("\n").replace(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
}
/** The shipped normalizeKeys helper is identity; aliases are not invented here. */
export function parseSkillText(text: string): ParsedSkill {
  const normalized = text.replace(/^\uFEFF/, ""), match = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(normalized);
  if (!match) return { fields: {}, content: text };
  const content = normalized.slice(match[0].length), yaml = match[1] ?? "";
  try { const value: unknown = parseYaml(yaml); return { fields: record(value) ? value : {}, content }; }
  catch {
    try { const value: unknown = parseYaml(quoteFallback(yaml)); return { fields: record(value) ? value : {}, content }; }
    catch (error) { return { fields: {}, content, parseError: error instanceof Error ? error.message : String(error) }; }
  }
}
/** Source tool-list grammar splits spaces/commas outside parentheses; wildcard covers the list. */
export function parseSkillToolList(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const result: string[] = [];
  for (const item of items) {
    let current = "", parentheses = false;
    for (const char of item) {
      if (char === "(") parentheses = true;
      if (char === ")") parentheses = false;
      if ((char === " " || char === ",") && !parentheses) { if (current.trim()) result.push(current.trim()); current = ""; }
      else current += char;
    }
    if (current.trim()) result.push(current.trim());
  }
  return result.includes("*") ? ["*"] : result;
}
function argumentNames(value: unknown): string[] {
  const values = typeof value === "string" ? value.split(/\s+/) : Array.isArray(value) ? value : [];
  return values.filter((item): item is string => typeof item === "string" && item.trim() !== "" && !/^\d+$/.test(item));
}
function description(value: unknown, content: string): { description: string; hasUserSpecifiedDescription: boolean } {
  const specified = typeof value === "string" ? value.trim() || undefined : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
  if (specified !== undefined) return { description: specified, hasUserSpecifiedDescription: true };
  const line = content.split("\n").map((part) => part.trim()).find(Boolean), body = line?.replace(/^#+\s+(\S.*)$/, "$1") ?? "Skill";
  return { description: body.length > 100 ? body.slice(0, 97) + "..." : body, hasUserSpecifiedDescription: false };
}
function pathPatterns(value: unknown): string[] {
  const split = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(split);
    if (typeof value !== "string") return [];
    let depth = 0, current = ""; const items: string[] = [];
    for (const char of value) { if (char === "{") depth++; if (char === "}") depth--; if (char === "," && depth === 0) { if (current.trim()) items.push(current.trim()); current = ""; } else current += char; }
    if (current.trim()) items.push(current.trim()); return items;
  };
  let results = 1000, bytes = 4_194_304;
  const expanded = split(value).flatMap((pattern) => {
    const pending = [pattern], result: string[] = [];
    for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
      const [, head, body, tail] = /^([^{]*)\{([^}]+)\}(.*)$/.exec(part) ?? [];
      if (head === undefined || body === undefined || tail === undefined) { result.push(part); continue; }
      const alternatives = body.split(",").map((value) => value.trim()); bytes -= part.length;
      const count = pending.length + result.length + alternatives.length;
      if (bytes < 0 || count > results || count * pattern.length > bytes) return [pattern];
      for (const alternative of alternatives.toReversed()) pending.push(head + alternative + tail);
    }
    results -= result.length; bytes -= result.length * pattern.length; return result;
  }).map((pattern) => pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern).filter(Boolean);
  return expanded.every((pattern) => pattern === "**") ? [] : expanded;
}
/** Ordinary quoted words only. Complex shell syntax requires explicit tokens; no shell is executed. */
function ordinaryArgumentTokens(text: string): string[] {
  if (/[$`<>|;&()\n]/.test(text)) return text.split(/\s+/).filter(Boolean);
  const tokens: string[] = []; let current = "", quote = "", started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === "\\" && quote !== "'") { if (index + 1 < text.length) { current += text.charAt(++index); started = true; } else return text.split(/\s+/).filter(Boolean); }
    else if (quote) { if (char === quote) quote = ""; else current += char; started = true; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(current); current = ""; started = false; }
    else { current += char; started = true; }
  }
  if (quote) return text.split(/\s+/).filter(Boolean);
  if (started) tokens.push(current); return tokens;
}
const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function expandArguments(text: string, args: string | undefined, names: readonly string[], tokens?: readonly string[]): string {
  if (args === undefined) return text;
  const dollar = "\uFFFF", marker = "\uFFFE"; text = text.replaceAll(dollar, "\uFFFD").replaceAll(marker, "\uFFFD");
  let size = text.length, substituted = false;
  const escape = (value: string) => value.replace(/`!/g, "` !").replace(/!`/g, "! `").replace(/(^|\s)!/gm, "$1\\!").replaceAll(dollar, "\uFFFD").replaceAll(marker, "\uFFFD").replaceAll("$", dollar);
  const insert = (value: string) => { const escaped = escape(value); size += Math.max(value.length, escaped.length); if (size > SKILL_EXPANSION_MAX_CHARS) throw new Error("Skill and expanded arguments exceed 4,000,000 characters"); substituted = true; return escaped; };
  const positional = tokens ?? ordinaryArgumentTokens(args), named = names.map((name, index) => ({ name, index })).filter(({ name }) => name.length <= 64).slice(0, 64).sort((a, b) => b.name.length - a.name.length);
  const choices = ["\\d", "ARGUMENTS", ...named.map(({ name }) => `${regexEscape(name)}(?![\\[\\w])`)].join("|");
  text = text.replace(new RegExp(`(?<!\\\\)\\\\\\$(?=${choices})`, "g"), dollar);
  for (const { name, index } of named) text = text.replace(new RegExp(`\\$${regexEscape(name)}(?![\\[\\w])`, "g"), () => insert(positional[index] ?? ""));
  text = text.replace(/\$ARGUMENTS\[(\d+)\]/g, (original, index: string) => { const value = positional[Number.parseInt(index, 10)]; return value === undefined ? dollar + original.slice(1) : insert(value); });
  text = text.replace(/\$(\d+)(?!\w)/g, (original, index: string) => { const value = positional[Number.parseInt(index, 10)]; return value === undefined ? original : insert(value); });
  text = text.replaceAll("$ARGUMENTS", () => insert(args));
  if (!substituted && args) text += `\n\nARGUMENTS: ${insert(args)}`;
  return text.replaceAll(dollar, "$").replaceAll(marker, "");
}

export class LocalSkillRegistry {
  readonly diagnostics: SkillDiagnostic[] = [];
  readonly limitations = [
    "Explicit local roots only; trust, ancestor boundaries, ignore/connector/sync policy and nested-directory admission belong to the caller",
    "No plugin/synced/legacy-command/host catalogs, reserved builtin namespaces, skillOverrides or model allowlist inference",
    "Ordinary quoted argument tokens only; complex shell parsing and shell substitutions require caller callbacks",
    "Unicode emoji exceptions, model/effort policy resolution and invocation permission arbitration are not inferred",
  ] as const;
  private readonly definitions: SkillDefinition[] = [];
  private readonly canonical = new Set<string>();
  private readonly active = new Set<string>();
  private readonly loaded = new Set<string>();
  constructor(private readonly options: SkillRegistryOptions) {
    absolute(options.cwd); if (options.userConfigDir !== undefined) absolute(options.userConfigDir); if (options.managedRoot !== undefined) absolute(options.managedRoot);
  }
  /** Register already admitted inert host/plugin definitions, after local source discovery. */
  registerDefinitions(definitions: readonly AdmittedSkillDefinition[]): number {
    let count = 0;
    for (const definition of definitions) {
      const info = definition.info;
      absolute(info.path); absolute(info.canonicalPath); absolute(info.baseDir);
      if (info.pluginRoot !== undefined) absolute(info.pluginRoot);
      if (this.options.managedOnly && info.source !== "policySettings") { this.issue(info.path, info.source, "withheld-source", "Managed-only skills exclude this host definition"); continue; }
      if (!info.name || !Array.isArray(info.allowedTools) || !Array.isArray(info.disallowedTools) || typeof definition.body !== "string") throw new Error("Invalid admitted skill definition");
      const detached = structuredClone(definition);
      this.definitions.push(detached); count++;
    }
    return count;
  }
  async discover(locations: readonly SkillLocation[]): Promise<void> {
    for (const location of locations) {
      const directory = absolute(location.directory), { source } = location;
      if (this.options.managedOnly && source !== "policySettings" || source === "userSettings" && !this.options.sources.user || source === "projectSettings" && !this.options.sources.project) continue;
      const key = `${source}\0${directory}`; if (this.loaded.has(key)) continue;
      const admitted = await this.options.admitSource?.({ directory, source });
      if (admitted === false || typeof admitted === "string") { this.issue(directory, source, "withheld-source", typeof admitted === "string" ? admitted : "Source was withheld"); continue; }
      this.loaded.add(key);
      let entries: import("node:fs").Dirent[];
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (!(record(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))) this.issue(directory, source, "read-directory", String(error)); continue; }
      const loaded: SkillDefinition[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const { name } = entry;
        if (name.normalize("NFKC").toLowerCase() === "synced") continue;
        if (!(this.options.isOfferedName ?? offered)(name)) { this.issue(join(directory, name), source, "invalid-name", "Skill directory name is not offered"); continue; }
        const path = join(directory, name, "SKILL.md"), read = await readBoundedConfigurationText(path, SKILL_MAX_BYTES, this.options.readPolicy);
        if (read.status !== "loaded") { if (read.status !== "absent") this.issue(path, source, read.reason, read.message); continue; }
        if (this.canonical.has(read.canonicalPath)) continue;
        const { fields, content, parseError } = parseSkillText(read.text);
        if (parseError !== undefined) this.issue(path, source, "frontmatter", parseError);
        const displayName = scalar(fields.name);
        const info: LocalSkill = { name, displayName: displayName && displayName.length <= 256 ? displayName : name, ...description(fields.description, content), path, canonicalPath: read.canonicalPath, baseDir: dirname(path), source, allowedTools: parseSkillToolList(fields["allowed-tools"]), disallowedTools: parseSkillToolList(fields["disallowed-tools"] ?? fields.disallowedTools), argumentNames: argumentNames(fields.arguments), userInvocable: fields["user-invocable"] === undefined ? true : boolean(fields["user-invocable"]) ?? false, disableModelInvocation: boolean(fields["disable-model-invocation"]) ?? false, contentLength: content.length };
        const strings = [["argumentHint", fields["argument-hint"]], ["whenToUse", fields.when_to_use], ["version", fields.version], ["agent", fields.agent]] as const;
        for (const [name, value] of strings) { const parsed = scalar(value); if (parsed !== undefined) info[name] = parsed; }
        if (typeof fields.model === "string" && fields.model.trim()) { const value = fields.model.trim(); info.model = value.toLowerCase() === "inherit" ? "inherit" : this.options.normalizeModel?.(value) ?? value; }
        const level = effort(fields.effort); if (level !== undefined) info.effort = level;
        else if (fields.effort !== undefined) this.issue(path, source, "effort", "Invalid skill effort was ignored");
        const background = boolean(fields.background); if (background !== undefined) info.background = background;
        if (fields.context === "fork") info.context = "fork";
        const shell = scalar(fields.shell)?.trim().toLowerCase(); if (shell === "bash" || shell === "powershell") info.shell = shell;
        const patterns = pathPatterns(fields.paths); if (patterns.length) info.paths = patterns;
        if (record(fields.metadata)) info.metadata = fields.metadata;
        if (misplacedGuard(fields)) { info.allowedTools = []; this.issue(path, source, "unloadable-guard", "Misplaced hook guard withheld hooks and allowed-tools"); }
        else if (fields.hooks) {
          try {
            if (!this.options.validateHooks) throw new Error("Skill hooks require caller validation");
            const hooks = this.options.validateHooks(fields.hooks, path);
            if (!record(hooks)) throw new Error("Skill hook validator must return a validated hooks object");
            info.hooks = hooks;
          }
          catch (error) { info.allowedTools = []; this.issue(path, source, "unloadable-guard", String(error)); }
        }
        const grants = (value: string) => value.replaceAll("${CLAUDE_SKILL_DIR}", info.baseDir).replaceAll("${CLAUDE_PROJECT_DIR}", this.options.cwd);
        info.allowedTools = info.allowedTools.map(grants);
        const accepted = await this.options.admitSkill?.(info);
        if (accepted === false || typeof accepted === "string") { this.issue(path, source, "withheld-skill", typeof accepted === "string" ? accepted : "Skill was withheld"); continue; }
        this.canonical.add(read.canonicalPath); loaded.push({ info, body: content });
      }
      loaded.sort((a, b) => a.info.name.localeCompare(b.info.name)); this.definitions.push(...loaded);
    }
  }
  catalog(options: { invocation?: "model" | "user"; includeConditional?: boolean } = {}): readonly Readonly<LocalSkill>[] {
    const names = new Set<string>(), result: LocalSkill[] = [];
    for (const { info } of this.definitions) {
      if (!options.includeConditional && info.paths?.length && !this.active.has(info.canonicalPath) || names.has(info.name)) continue;
      names.add(info.name);
      if (options.invocation === "model" && info.disableModelInvocation || options.invocation === "user" && !info.userInvocable) continue;
      result.push(info);
    }
    return result;
  }
  activateForPaths(paths: readonly string[], root = this.options.cwd): readonly string[] {
    absolute(root); const activated: string[] = [];
    for (const { info } of this.definitions) {
      if (!info.paths?.length || this.active.has(info.canonicalPath)) continue;
      const matcher = ignore().add(info.paths);
      if (paths.some((path) => { const suffix = isAbsolute(path) ? relative(root, path) : path; return !!suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix) && matcher.ignores(suffix.replaceAll(sep, "/")); })) { this.active.add(info.canonicalPath); activated.push(info.name); }
    }
    return activated;
  }
  async invoke(name: string, args: string | undefined, options: SkillInvocationOptions): Promise<SkillInvocation> {
    options.signal?.throwIfAborted();
    const selected = this.catalog().find((skill) => skill.name === name);
    if (!selected) throw new Error(`Unknown or inactive skill: ${name}`);
    if (options.invocation === "model" && selected.disableModelInvocation) throw new Error(`Skill ${name} requires explicit user invocation`);
    const decision = await options.authorize?.(selected); if (decision === false || typeof decision === "string") throw new Error(typeof decision === "string" ? decision : "Skill execution blocked by permission rules");
    const definition = this.definitions.find(({ info }) => info === selected);
    if (!definition) throw new Error(`Unknown or inactive skill: ${name}`);
    let text = definition.isSkillMode === false ? definition.body : `Base directory for this skill: ${selected.baseDir}\n\n${definition.body}`;
    text = expandArguments(text, args, selected.argumentNames, options.argumentTokens);
    if (text.includes("${CLAUDE_EFFORT}") && options.effortLevel === undefined) throw new Error("Skill effort placeholder requires the caller's resolved effortLevel");
    text = text.replaceAll("${CLAUDE_SKILL_DIR}", selected.baseDir).replaceAll("${CLAUDE_PROJECT_DIR}", this.options.cwd).replaceAll("${CLAUDE_SESSION_ID}", options.sessionId).replaceAll("${CLAUDE_EFFORT}", options.effortLevel ?? "");
    if (selected.pluginRoot !== undefined) text = text.replaceAll("${CLAUDE_PLUGIN_ROOT}", selected.pluginRoot);
    if (/```!\s*\n?[\s\S]*?\n?```|(?:^|\s)!`[^`]+`/m.test(text)) {
      if (!options.processShellBlocks) throw new Error(`Skill ${name} requires a caller-authorized shell substitution handler`);
      text = await options.processShellBlocks(text, selected, options.signal);
    }
    options.signal?.throwIfAborted();
    const result: SkillInvocation = { skill: selected, text, allowedTools: selected.allowedTools, disallowedTools: selected.disallowedTools };
    for (const key of ["model", "effort", "context", "agent", "background", "hooks"] as const) if (selected[key] !== undefined) Object.assign(result, { [key]: selected[key] });
    return result;
  }
  private issue(path: string, source: SkillSource, reason: string, message: string): void { this.diagnostics.push({ path, source, reason, message }); }
}
export async function createLocalSkillRegistry(options: SkillRegistryOptions): Promise<LocalSkillRegistry> {
  const registry = new LocalSkillRegistry(options), locations: SkillLocation[] = [];
  if (options.managedRoot !== undefined) locations.push({ directory: join(options.managedRoot, ".claude", "skills"), source: "policySettings" });
  if (options.userConfigDir !== undefined) locations.push({ directory: join(options.userConfigDir, "skills"), source: "userSettings" });
  for (const root of [...options.projectDirectories ?? [], ...options.additionalDirectories ?? []]) locations.push({ directory: join(absolute(root), ".claude", "skills"), source: "projectSettings" });
  await registry.discover(locations); return registry;
}
