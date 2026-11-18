import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { readBoundedConfigurationText, SETTINGS_MAX_BYTES } from "./configuration.js";
import { loadLocalPluginCatalog, isPluginCacheDescendant, type PluginEnableLayer, type PluginComponent } from "./plugin-catalog.js";
import { loadPluginComponentDefinitions } from "./plugin-components.js";
import { createHookRegistry, HOOK_EVENTS, type HookSource } from "./hooks.js";
import { resolveDirectSkillModelAlias } from "./skill-session.js";
import type { LaunchConfiguration } from "./launch-configuration.js";
import type { AdmittedSkillDefinition } from "./skills.js";
import { managedLocalPluginAdmission, resolveLocalPluginDependencies } from "./plugin-policy.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const within = (root: string, path: string) => { const suffix = relative(root, path); return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };

/** Only explicitly supplied local plugin directories. Marketplaces/installed-state discovery remain separate. */
export async function loadLaunchPlugins(options: {
  cwd: string; directories: readonly string[]; launch: LaunchConfiguration; signal?: AbortSignal;
  env?: NodeJS.ProcessEnv; onDiagnostic?(message: string): void;
}) {
  const env = options.env ?? process.env, diagnostic = (message: string) => options.onDiagnostic?.(message);
  const roots: { root: string; source: string; scope: "session"; fallbackName: string }[] = [];
  // Resolve the inline identity before applying enabledPlugins. Verify the same
  // identity on the catalog's full read so a changed manifest is not relabelled.
  const directories = options.launch.snapshot.policy.disableSideloadFlags === true ? [] : options.directories;
  if (options.directories.length && !directories.length) diagnostic("Explicit local plugins are disabled by managed sideload policy");
  for (const directory of directories) {
    options.signal?.throwIfAborted();
    const root = resolve(options.cwd, directory);
    try {
      const canonicalRoot = await realpath(root), fallback = basename(root);
      const read = await readBoundedConfigurationText(join(root, ".claude-plugin", "plugin.json"), SETTINGS_MAX_BYTES,
        (_path, canonical) => canonical === undefined || within(canonicalRoot, canonical) && !isPluginCacheDescendant(canonicalRoot, canonical));
      let name = fallback;
      if (read.status === "loaded") {
        const value: unknown = JSON.parse(read.text.replace(/^\uFEFF/, ""));
        if (!record(value) || typeof value.name !== "string") throw new Error("Plugin manifest requires a name");
        name = value.name;
      } else if (read.status !== "absent") throw new Error(read.message);
      roots.push({ root, source: `${name}@inline`, scope: "session", fallbackName: name });
    } catch (error) { diagnostic(`Plugin ${root} withheld: ${error instanceof Error ? error.message : "cannot resolve explicit directory"}`); }
  }
  const layers: PluginEnableLayer[] = options.launch.snapshot.documents.slice().reverse().flatMap(document => {
    if (!record(document.effective?.enabledPlugins)) return [];
    const enabledPlugins = Object.fromEntries(Object.entries(document.effective.enabledPlugins).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
    return [{ source: document.source, enabledPlugins, managed: document.source === "policySettings" }];
  });
  const validateHooks = (hooks: unknown) => {
    if (!record(hooks) || Object.keys(hooks).some(event => !HOOK_EVENTS.some(known => known === event))) throw new Error("Plugin declares hook events unsupported by this command host");
    const registry = createHookRegistry([{ source: "plugin-validation", hooks }]); void registry.close(); return hooks;
  };
  const catalog = await loadLocalPluginCatalog({ roots, enableLayers: layers, ...(options.signal ? { signal: options.signal } : {}),
    admitPlugin: plugin => { const admission = managedLocalPluginAdmission(plugin.name, options.launch.snapshot.policy.enabledPlugins); return admission.admitted || admission.reason || "Managed settings withhold this local plugin"; },
    validateManifest: (manifest, declaration) => { if (`${manifest.name}@inline` !== declaration.source) throw new Error("Plugin identity changed between reads"); },
    validateComponent: component => { if (component.kind === "hooks") validateHooks(component.config); },
  });
  for (const issue of catalog.diagnostics) diagnostic(`${issue.source}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
  const admitted = resolveLocalPluginDependencies(catalog.plugins);
  for (const issue of admitted.diagnostics) diagnostic(`${issue.source}: ${issue.message}`);
  const definitions = await loadPluginComponentDefinitions({ plugins: admitted.plugins,
    ...(options.signal ? { signal: options.signal } : {}), validateHooks,
    normalizeModel: model => resolveDirectSkillModelAlias(model, env),
  });
  for (const issue of definitions.diagnostics) diagnostic(`${issue.source}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
  const prompts: AdmittedSkillDefinition[] = definitions.prompts.map(definition => ({ ...definition,
    info: { ...definition.info,
      allowedTools: definition.info.allowedTools.map(rule => rule.replaceAll("${CLAUDE_PLUGIN_ROOT}", definition.info.pluginRoot).replaceAll("${CLAUDE_SKILL_DIR}", definition.info.baseDir).replaceAll("${CLAUDE_PROJECT_DIR}", options.cwd)) } }));
  const hookSources: HookSource[] = [];
  const mcpComponents: { plugin: string; root: string; component: PluginComponent }[] = [];
  for (const plugin of admitted.plugins) for (const component of plugin.components) {
    if (component.kind === "hooks") hookSources.push({ source: "plugin", hooks: component.config, pluginRoot: plugin.root,
      ...(component.path ? { path: component.path } : {}) });
    if (component.kind === "mcp") mcpComponents.push({ plugin: plugin.name, root: plugin.root, component });
    if (component.kind === "lsp") diagnostic(`${plugin.source}: LSP registration is not yet implemented`);
  }
  return { plugins: admitted.plugins, prompts, agents: definitions.agents, hookSources, mcpComponents };
}
