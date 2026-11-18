import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

export type PluginScope = "managed" | "user" | "project" | "local" | "session";
export type PluginComponentKind = "commands" | "skills" | "agents" | "hooks" | "mcp" | "lsp";
export interface LocalPluginRoot {
  root: string;
  /** Installed identity or explicit local identity, e.g. example@inline. */
  source: string;
  scope: PluginScope;
  projectPath?: string;
  fallbackName?: string;
  enabled?: boolean;
  version?: string;
  provenance?: Readonly<Record<string, unknown>>;
}
export interface PluginEnableLayer {
  source: string;
  /** Layers are supplied in highest precedence first order. */
  enabledPlugins: Readonly<Record<string, boolean | undefined>>;
  managed?: boolean;
}
export interface PluginEnableDecision { enabled: boolean; source: string; key?: string; managed?: boolean }
export interface PluginComponent {
  kind: PluginComponentKind;
  origin: "default" | "manifest" | "root-skill";
  /** Lexical location and its realpath are both checked inside the explicit root. */
  path?: string;
  realPath?: string;
  /** Configuration is discovery data; the catalog never expands variables or executes it. */
  config?: Readonly<Record<string, unknown>>;
  commandName?: string;
  metadata?: Readonly<Record<string, unknown>>;
}
export interface CatalogPlugin {
  name: string;
  source: string;
  scope: PluginScope;
  root: string;
  realRoot: string;
  projectPath?: string;
  manifestPath?: string;
  manifest: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
  enabled: boolean;
  enableDecision: PluginEnableDecision;
  components: readonly PluginComponent[];
}
export interface PluginCatalogDiagnostic {
  source: string;
  code: "plugin-invalid" | "manifest-invalid" | "plugin-rejected" | "component-rejected" | "component-invalid" | "path-escape" | "path-missing" | "duplicate-hooks" | "unsupported";
  message: string;
  path?: string;
  component?: PluginComponentKind;
}
export interface PluginCatalogOptions {
  roots: readonly LocalPluginRoot[];
  enableLayers?: readonly PluginEnableLayer[];
  signal?: AbortSignal;
  /** Host resolves trust, scope, version constraints and dependency admission here. */
  admitPlugin?: (plugin: Readonly<CatalogPlugin>, declaration: LocalPluginRoot) => boolean | string | Promise<boolean | string>;
  admitComponent?: (component: Readonly<PluginComponent>, plugin: Readonly<CatalogPlugin>) => boolean | string | Promise<boolean | string>;
  /** Additional host schema/guard checks may reject the complete manifest. */
  validateManifest?: (manifest: Readonly<Record<string, unknown>>, declaration: LocalPluginRoot) => void | Promise<void>;
  /** Internal component protocols remain owned by the corresponding host loader. */
  validateComponent?: (component: Readonly<PluginComponent>, plugin: Readonly<CatalogPlugin>) => void | Promise<void>;
  resolveEnabled?: (declaration: LocalPluginRoot, manifest: Readonly<Record<string, unknown>>, layers: readonly PluginEnableLayer[]) => PluginEnableDecision;
}
export interface PluginCatalogSnapshot { plugins: readonly CatalogPlugin[]; diagnostics: readonly PluginCatalogDiagnostic[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const errorCode = (error: unknown): string => typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
const hasGuardEntries = (config: Record<string, unknown> | undefined): boolean => ["PreToolUse", "PermissionRequest"].some(key => { const entries = config?.[key]; return Array.isArray(entries) && entries.length > 0; });
const pathSchema = z.string().startsWith("./");
const jsonPath = pathSchema.endsWith(".json");
const paths = z.union([pathSchema, z.array(pathSchema)]);
const commandMetadata = z.object({ source: pathSchema.optional(), content: z.string().optional(), description: z.string().optional(),
  argumentHint: z.string().optional(), model: z.string().optional(), allowedTools: z.array(z.string()).optional() })
  .refine(value => !!value.source !== !!value.content, "A command needs exactly one nonempty source or content");
const configRecord = z.record(z.string(), z.unknown());
const configDeclaration = z.union([jsonPath, configRecord, z.array(z.union([jsonPath, configRecord]))]);
const mcpPath = z.union([jsonPath, pathSchema.regex(/\.(?:mcpb|dxt)$/), z.url().regex(/\.(?:mcpb|dxt)$/)]);
const manifestSchema = z.object({
  $schema: z.string().optional(), name: z.string().min(1), version: z.string().optional(), description: z.string().optional(), displayName: z.string().optional(),
  author: z.object({ name: z.string().min(1), email: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.url().optional(), repository: z.string().optional(), license: z.string().optional(), keywords: z.array(z.string()).optional(),
  defaultEnabled: z.boolean().optional(),
  commands: z.union([paths, z.record(z.string(), commandMetadata)]).optional(), agents: z.union([pathSchema.endsWith(".md"), z.array(pathSchema.endsWith(".md"))]).optional(),
  skills: z.union([z.literal("."), paths, z.array(z.union([z.literal("."), pathSchema]))]).optional(),
  hooks: configDeclaration.optional(),
  mcpServers: z.union([mcpPath, configRecord, z.array(z.union([mcpPath, configRecord]))]).optional(),
  lspServers: configDeclaration.optional(),
}).passthrough();

function abort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
/** Source OGe/Tft protects plugin-relative MCP bundle extraction segments. */
export function isPluginCacheDescendant(root: string, path: string): boolean {
  return relative(root, path).split(sep).some(segment => segment.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
    .toUpperCase().toLowerCase().replace(/[. ]+$/, "") === ".mcpb-cache");
}
function validName(name: string): boolean { return name.length > 0 && !/[@:\s/\\\p{Cc}\p{Cf}]/u.test(name); }
const fold = (text: string) => text.normalize("NFC").toLowerCase();

/** Generic marketplace identities use exact keys; inline/synced identities use source folding. */
export function resolveLocalPluginEnabled(declaration: LocalPluginRoot, manifest: Readonly<Record<string, unknown>>, layers: readonly PluginEnableLayer[] = []): PluginEnableDecision {
  const marketplace = declaration.source.slice(declaration.source.lastIndexOf("@") + 1);
  const folded = marketplace === "inline" || marketplace === "synced";
  for (const layer of layers) {
    const matches = Object.entries(layer.enabledPlugins).filter(([key, value]) => value !== undefined && (folded ? fold(key) === fold(declaration.source) : key === declaration.source));
    if (marketplace === "synced" && matches.length === 0) {
      const inlineKey = `${declaration.source.slice(0, declaration.source.lastIndexOf("@"))}@inline`;
      matches.push(...Object.entries(layer.enabledPlugins).filter(([key, value]) => value === false && fold(key) === fold(inlineKey)));
    }
    // Fold collisions in one settings record preserve a deny independently of insertion order.
    const match = matches.find(([, value]) => value === false) ?? matches[0];
    if (match) {
      return { enabled: match[1] === true, source: layer.source, key: match[0], ...(layer.managed !== undefined && { managed: layer.managed }) };
    }
  }
  return { enabled: declaration.enabled ?? manifest.defaultEnabled !== false, source: declaration.enabled === undefined ? "manifest-default" : "explicit-root" };
}

const knownHookEvents = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay"]);
function misplacedMatcher(value: unknown): boolean {
  if (!object(value)) return false;
  if (!("matcher" in value) && Object.keys(value).some(key => knownHookEvents.has(key))) return false;
  return Array.isArray(value.hooks) ? value.hooks.length > 0 : object(value.hooks) && ("matcher" in value || typeof value.hooks.type === "string");
}
function protectedOutsideHooks(value: unknown, depth = 0): boolean {
  if (!object(value) || depth > 3) return false;
  return Object.entries(value).some(([key, child]) => {
    if (["hooks", "metadata", "mcpServers", "lspServers", "experimental"].includes(key)) return false;
    if ((key === "PreToolUse" || key === "PermissionRequest") && child != null && !(Array.isArray(child) && child.length === 0)) return true;
    return Array.isArray(child) ? child.some(entry => misplacedMatcher(entry) || protectedOutsideHooks(entry, depth + 1)) : misplacedMatcher(child) || protectedOutsideHooks(child, depth + 1);
  });
}
function hookConfigError(value: unknown): string | undefined {
  if (!object(value)) return "Hook event configuration must be an object";
  if (misplacedMatcher(value)) return "Hook configuration contains a matcher outside an event array";
  for (const [key, nested] of Object.entries(value)) {
    if (!knownHookEvents.has(key) && (Array.isArray(nested) ? nested.some(entry => misplacedMatcher(entry) || protectedOutsideHooks(entry)) : protectedOutsideHooks(nested))) return "Unknown hook event contains a misplaced guard";
  }
  for (const event of ["PreToolUse", "PermissionRequest"]) {
    const groups = value[event];
    if (groups === undefined || groups === null) continue;
    if (!Array.isArray(groups)) return `${event} guards must be an array of matchers`;
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) return `${event} guard matcher must contain a hooks array`;
      if (Object.entries(group).some(([key, nested]) => key !== "hooks" && key !== "matcher" && protectedOutsideHooks(nested))) return `${event} guard contains a nested misplaced guard`;
      if (group.matcher !== undefined && typeof group.matcher !== "string") return `${event} guard matcher must be a string`;
      // A catalog cannot silently drop a guard it cannot understand. The host owns complete hook schemas.
      for (const entry of group.hooks) {
        if (!object(entry) || typeof entry.type !== "string") return `${event} guard hook needs a type`;
        const required: Record<string, readonly string[]> = { command: ["command"], prompt: ["prompt"], agent: ["prompt"], http: ["url"], mcp_tool: ["server", "tool"] };
        const requiredKeys = required[entry.type];
        if (!requiredKeys) return `${event} guard hook has an unknown type`;
        if (requiredKeys.some(key => typeof entry[key] !== "string")) return `${event} guard hook is missing required fields`;
        if (entry.timeout !== undefined && (typeof entry.timeout !== "number" || !Number.isFinite(entry.timeout) || entry.timeout <= 0)) return `${event} guard timeout must be positive`;
      }
    }
  }
  return undefined;
}

/** Filesystem discovery only. Every load starts from explicitly supplied roots and policy. */
export async function loadLocalPluginCatalog(options: PluginCatalogOptions): Promise<PluginCatalogSnapshot> {
  const plugins: CatalogPlugin[] = [], diagnostics: PluginCatalogDiagnostic[] = [];
  const report = (declaration: LocalPluginRoot, code: PluginCatalogDiagnostic["code"], message: string, extra: Partial<Pick<PluginCatalogDiagnostic, "path" | "component">> = {}) => diagnostics.push({ source: declaration.source, code, message, ...extra });
  for (const declaration of options.roots) {
    abort(options.signal);
    let plugin: CatalogPlugin;
    try {
      if (!isAbsolute(declaration.root)) throw new Error("Plugin root must be absolute");
      if (!declaration.source || !["managed", "user", "project", "local", "session"].includes(declaration.scope)) throw new Error("Plugin source and scope are required");
      if ((declaration.scope === "project" || declaration.scope === "local") && !declaration.projectPath) throw new Error("Project/local plugins need an explicit projectPath");
      const root = resolve(declaration.root), realRoot = await realpath(root);
      if (!(await stat(root)).isDirectory()) throw new Error("Plugin root must be a directory");
      const manifestPath = resolve(root, ".claude-plugin/plugin.json");
      let manifest: Record<string, unknown>, present = true;
      try {
        const realManifest = await realpath(manifestPath);
        if (!inside(realRoot, realManifest) || isPluginCacheDescendant(realRoot, realManifest)) throw new Error("Manifest realpath escapes plugin root or enters the MCP bundle cache");
        manifest = manifestSchema.parse(JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, "")));
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(errorCode(error))) {
          present = false; manifest = { name: declaration.fallbackName ?? basename(root) };
        } else { report(declaration, "manifest-invalid", String(error), { path: manifestPath }); continue; }
      }
      if (!validName(String(manifest.name))) throw new Error("Plugin name contains reserved namespace, whitespace, path or invisible characters");
      if (protectedOutsideHooks(manifest) || (object(manifest.experimental) && protectedOutsideHooks(manifest.experimental))) throw new Error("Protected hooks are declared outside the hooks field");
      await options.validateManifest?.(manifest, declaration);
      const decision = (options.resolveEnabled ?? resolveLocalPluginEnabled)(declaration, manifest, options.enableLayers ?? []);
      plugin = { name: String(manifest.name), source: declaration.source, scope: declaration.scope, root, realRoot,
        ...(declaration.projectPath !== undefined && { projectPath: declaration.projectPath }), ...(present && { manifestPath }),
        manifest, provenance: { ...declaration.provenance, ...(declaration.version !== undefined && { installedVersion: declaration.version }) },
        enabled: decision.enabled, enableDecision: decision, components: [] };
      abort(options.signal);
      const admission = await options.admitPlugin?.(plugin, declaration);
      abort(options.signal);
      if (admission === false || typeof admission === "string") { report(declaration, "plugin-rejected", typeof admission === "string" ? admission : "Host rejected plugin"); continue; }
    } catch (error) {
      abort(options.signal); report(declaration, "plugin-invalid", String(error)); continue;
    }
    const components: PluginComponent[] = [];
    const discoveredSkills = new Set<string>();
    const seenHooks = new Set<string>();
    let unloadableGuard = false;
    const add = async (component: PluginComponent) => {
      abort(options.signal);
      try {
        await options.validateComponent?.(component, plugin);
        const admission = await options.admitComponent?.(component, plugin);
        abort(options.signal);
        if (admission === false || typeof admission === "string") {
          if (component.kind === "hooks" && hasGuardEntries(component.config)) unloadableGuard = true;
          report(declaration, "component-rejected", typeof admission === "string" ? admission : "Host rejected component", { component: component.kind, ...(component.path && { path: component.path }) });
        }
        else if (plugin.enabled) components.push(component);
      } catch (error) {
        abort(options.signal);
        if (component.kind === "hooks" && hasGuardEntries(component.config)) unloadableGuard = true;
        report(declaration, "component-invalid", String(error), { component: component.kind });
      }
    };
    const discoverPath = async (kind: PluginComponentKind, declared: string, origin: PluginComponent["origin"], optional = false, metadata?: Record<string, unknown>, commandName?: string) => {
      abort(options.signal);
      const path = resolve(plugin.root, declared);
      if (declared.includes("\\") || !inside(plugin.root, path)) { report(declaration, "path-escape", "Component escapes plugin root or uses an unreliable backslash path", { path, component: kind }); return; }
      if (isPluginCacheDescendant(plugin.root, path)) { report(declaration, "path-escape", "Component enters the reserved MCP bundle cache", { path, component: kind }); return; }
      let canonical: string;
      try {
        canonical = await realpath(path);
        if (!inside(plugin.realRoot, canonical) || isPluginCacheDescendant(plugin.realRoot, canonical)) { report(declaration, "path-escape", "Component realpath escapes plugin root or enters the reserved MCP bundle cache", { path, component: kind }); return; }
        const [info, targetInfo] = await Promise.all([stat(path, { bigint: true }), stat(canonical, { bigint: true })]);
        if (info.ino === 0n || targetInfo.ino === 0n || info.ino !== targetInfo.ino || info.dev !== targetInfo.dev) throw new Error("Component identity differs from its resolved file");
        if ((kind === "skills" || (origin === "default" && ["commands", "agents"].includes(kind))) && !info.isDirectory()) throw new Error("Component requires a directory");
        if (["hooks", "mcp", "lsp"].includes(kind) && !info.isFile()) throw new Error("Configuration requires a file");
      } catch (error) {
        if (optional && ["ENOENT", "ENOTDIR"].includes(errorCode(error))) return;
        const code = ["ENOENT", "ENOTDIR"].includes(errorCode(error)) ? "path-missing" : "component-invalid";
        report(declaration, code, String(error), { path, component: kind }); return;
      }
      if (kind === "hooks") {
        if (seenHooks.has(canonical)) { if (origin !== "default" && canonical !== resolve(plugin.realRoot, "hooks/hooks.json")) report(declaration, "duplicate-hooks", "Hook file already loaded", { path, component: kind }); return; }
        seenHooks.add(canonical);
      }
      if (kind === "skills") { if (discoveredSkills.has(canonical)) return; discoveredSkills.add(canonical); }
      if (origin === "manifest" && (declared.endsWith(".mcpb") || declared.endsWith(".dxt"))) { report(declaration, "unsupported", "MCP bundle extraction is not part of local discovery", { path, component: kind }); return; }
      let config: Record<string, unknown> | undefined;
      if (["hooks", "mcp", "lsp"].includes(kind)) {
        try {
          const parsed: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
          if (!object(parsed)) throw new Error("Configuration must be an object");
          if (kind === "hooks") {
            if (misplacedMatcher(parsed) || protectedOutsideHooks(parsed)) { unloadableGuard = true; throw new Error("Protected hooks outside wrapper hooks field"); }
            if (parsed.hooks !== undefined) {
              const error = hookConfigError(parsed.hooks);
              if (error) { unloadableGuard = true; throw new Error(error); }
              if (object(parsed.hooks)) config = parsed.hooks;
            }
            if (parsed.modules !== undefined) report(declaration, "unsupported", "Hook module execution is not supported by this catalog", { path, component: kind });
            if (!config && parsed.modules === undefined) throw new Error("Hook wrapper must have hooks or modules");
            if (!config) return;
          } else config = parsed;
        } catch (error) { report(declaration, "component-invalid", String(error), { path, component: kind }); return; }
      }
      await add({ kind, origin, path, realPath: canonical, ...(config && { config }), ...(metadata && { metadata }), ...(commandName !== undefined && { commandName }) });
    };
    const manifest = plugin.manifest;
    for (const kind of ["commands", "agents", "skills"] as const) {
      if (kind === "skills" || manifest[kind] === undefined) await discoverPath(kind, kind, "default", true);
      const value = manifest[kind];
      if (value !== undefined) {
        if (kind === "commands" && object(value)) {
          for (const [name, data] of Object.entries(value)) {
            if (!object(data)) continue;
            if (typeof data.source === "string") await discoverPath(kind, data.source, "manifest", false, data, name);
            else await add({ kind, origin: "manifest", commandName: name, metadata: data });
          }
        } else for (const path of Array.isArray(value) ? value : [value]) {
          if (typeof path !== "string") continue;
          if (kind === "skills" && declaration.source.endsWith("@skills-dir") && resolve(plugin.root, path) === plugin.root) continue;
          await discoverPath(kind, path, "manifest");
        }
      } else if (kind === "skills" && discoveredSkills.size === 0 && !declaration.source.endsWith("@skills-dir")) {
        try { const canonical = await realpath(resolve(plugin.root, "SKILL.md")); if (inside(plugin.realRoot, canonical) && (await stat(canonical)).isFile()) await discoverPath(kind, ".", "root-skill"); } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) report(declaration, "component-invalid", String(error), { component: kind }); }
      }
    }
    for (const [kind, field, defaultPath] of [["hooks", "hooks", "hooks/hooks.json"], ["mcp", "mcpServers", ".mcp.json"], ["lsp", "lspServers", ".lsp.json"]] as const) {
      await discoverPath(kind, defaultPath, "default", true);
      const value = manifest[field];
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === "string") {
          if (/^https?:\/\//.test(entry)) report(declaration, "unsupported", "Remote MCP bundle discovery requires a separate host lifecycle", { component: kind });
          else await discoverPath(kind, entry, "manifest");
        } else if (object(entry)) {
          const error = kind === "hooks" ? hookConfigError(entry) : undefined;
          if (error) { unloadableGuard = true; report(declaration, "component-invalid", error, { component: kind }); }
          else await add({ kind, origin: "manifest", config: entry });
        }
      }
    }
    for (const field of ["dependencies", "engines", "settings", "monitors", "binaries", "channels", "types", "userConfig", "experimental", "themes", "workflows", "outputStyles"]) {
      if (manifest[field] !== undefined) report(declaration, "unsupported", `${field} is preserved as manifest metadata; its lifecycle is owned by the host`);
    }
    abort(options.signal);
    if (unloadableGuard) report(declaration, "plugin-rejected", "Plugin has an invalid protected hook guard; no components admitted");
    else plugins.push({ ...plugin, components });
  }
  return { plugins, diagnostics };
}
