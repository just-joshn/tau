import { readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  readBoundedConfigurationText,
  type PathReadPolicy,
} from "./configuration.js";
import {
  parseSkillText,
  parseSkillToolList,
  type LocalSkill,
} from "./skills.js";
import { parseQueryEffort } from "./query-model-effort.js";
import type { LocalAgentDefinition } from "./agent-definitions.js";
import {
  isPluginCacheDescendant,
  type CatalogPlugin,
  type PluginComponent,
} from "./plugin-catalog.js";

export const PLUGIN_DOCUMENT_MAX_BYTES = 1_048_576;
export interface PluginDefinitionProvenance {
  pluginName: string;
  sourceName: string;
  pluginPath: string;
  realPluginPath: string;
  scope: CatalogPlugin["scope"];
  projectPath?: string;
  manifest: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
}
export interface PluginPromptInfo extends Omit<LocalSkill, "source"> {
  source: "plugin";
  pluginRoot: string;
  pluginSource: PluginDefinitionProvenance;
}
export interface PluginPromptDefinition {
  info: PluginPromptInfo;
  body: string;
  frontmatter: Readonly<Record<string, unknown>>;
  /** Legacy markdown commands do not receive a skill base-directory prefix at invocation. */
  isSkillMode: boolean;
  /** Directory-scanned command SKILL.md files can carry skill hooks without skill-mode invocation. */
  isSkillFile: boolean;
  kind: "command" | "skill";
  aliases?: readonly string[];
}
export interface PluginAgentDefinition extends LocalAgentDefinition {
  pluginSource: PluginDefinitionProvenance;
}
export type PluginRuntimeDefinition =
  PluginPromptDefinition | PluginAgentDefinition;
export interface PluginDefinitionDiagnostic {
  source: string;
  path?: string;
  kind?: "command" | "skill" | "agent";
  reason: string;
  message: string;
}
export interface PluginComponentDefinitions {
  prompts: readonly PluginPromptDefinition[];
  agents: readonly PluginAgentDefinition[];
  diagnostics: readonly PluginDefinitionDiagnostic[];
}
export interface PluginComponentOptions {
  plugins: readonly CatalogPlugin[];
  signal?: AbortSignal;
  readPolicy?: PathReadPolicy;
  /** Catalog roots have already passed trust, managed lock and scope admission. */
  admitDefinition?: (
    definition: Readonly<PluginRuntimeDefinition>,
    plugin: Readonly<CatalogPlugin>,
  ) => boolean | string | Promise<boolean | string>;
  validateHooks?: (
    hooks: unknown,
    path: string,
    plugin: Readonly<CatalogPlugin>,
  ) => unknown | Promise<unknown>;
  /** Source strips invalid skill hooks and grants. Hosts may explicitly refuse that definition instead. */
  rejectInvalidHooks?: boolean;
  normalizeModel?: (model: string) => string;
  isOfferedName?: (name: string) => boolean;
  memoryEnabled?: boolean;
  /** Ordinary --plugin-dir > installed > skills-dir ordering; complex synced/builtin policy stays in the host. */
  applyOrdinaryPrecedence?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown): string | undefined =>
  value == null ? undefined : String(value);
const flag = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") return;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text)
    ? true
    : ["0", "false", "no", "off"].includes(text)
      ? false
      : undefined;
};
const descriptionValue = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value.trim() || undefined
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const offered = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 256 &&
  !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>]/u.test(name);
const skillFile = (path: string): boolean =>
  /^skill\.md$/i.test(basename(path));
const named = (value: unknown): string | undefined => {
  const text = scalar(value);
  return text !== undefined && text.length <= 256 ? text : undefined;
};
const positive = (value: unknown): number | undefined => {
  const raw = typeof value === "string" ? value.trim() : undefined;
  let number =
    typeof value === "number"
      ? value
      : raw !== undefined
        ? /^[-+]?\d+(?:\.\d+)?e[-+]?\d+$/i.test(raw)
          ? Number(raw)
          : /^[+-]?\d{1,3}([_,\u00a0\u202f ])\d{3}(?:\1\d{3})*$/.test(raw)
            ? Number.parseInt(raw.replace(/[_,\u00a0\u202f ]/g, ""), 10)
            : Number.parseInt(raw, 10)
        : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function model(
  value: unknown,
  options: PluginComponentOptions,
  normalize = true,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const text = value.trim();
  return text.toLowerCase() === "inherit"
    ? "inherit"
    : normalize
      ? (options.normalizeModel?.(text) ?? text)
      : text;
}
function provenance(plugin: CatalogPlugin): PluginDefinitionProvenance {
  return {
    pluginName: plugin.name,
    sourceName: plugin.source,
    pluginPath: plugin.root,
    realPluginPath: plugin.realRoot,
    scope: plugin.scope,
    ...(plugin.projectPath !== undefined && {
      projectPath: plugin.projectPath,
    }),
    manifest: plugin.manifest,
    provenance: plugin.provenance,
  };
}
function validToolList(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}
function guarded(value: unknown, depth = 3): boolean {
  if (depth < 0 || value == null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => guarded(item, depth - 1));
  return Object.entries(value).some(
    ([key, child]) =>
      (["PreToolUse", "PermissionRequest"].includes(key) &&
        child != null &&
        !(Array.isArray(child) && child.length === 0)) ||
      (!["metadata", "mcpServers", "lspServers"].includes(key) &&
        guarded(child, depth - 1)),
  );
}
function outsideGuard(fields: Record<string, unknown>): boolean {
  return Object.entries(fields).some(
    ([key, value]) =>
      key !== "hooks" &&
      !["metadata", "mcpServers", "lspServers"].includes(key) &&
      guarded({ [key]: value }),
  );
}

/** Apply only the ordinary admitted local/installed/skills-dir merge, preserving declaration order. */
export function selectOrdinaryPluginPrecedence(
  plugins: readonly CatalogPlugin[],
): readonly CatalogPlugin[] {
  const active = plugins.filter((plugin) => plugin.enabled),
    inline = new Set(
      active
        .filter((plugin) => plugin.source.endsWith("@inline"))
        .map((plugin) => plugin.name),
    );
  const installed = new Set(
    active
      .filter(
        (plugin) =>
          !["inline", "skills-dir", "synced", "builtin"].includes(
            plugin.source.slice(plugin.source.lastIndexOf("@") + 1),
          ),
      )
      .map((plugin) => plugin.name),
  );
  return active.filter((plugin) => {
    const origin = plugin.source.slice(plugin.source.lastIndexOf("@") + 1);
    if (origin === "inline" || origin === "synced" || origin === "builtin")
      return true;
    return origin === "skills-dir"
      ? !inline.has(plugin.name) && !installed.has(plugin.name)
      : !inline.has(plugin.name);
  });
}

/** Convert admitted local plugin documents to inert definitions. No shell, MCP, hook or agent executes. */
export async function loadPluginComponentDefinitions(
  options: PluginComponentOptions,
): Promise<PluginComponentDefinitions> {
  const prompts: PluginPromptDefinition[] = [],
    agents: PluginAgentDefinition[] = [],
    diagnostics: PluginDefinitionDiagnostic[] = [];
  const check = () => options.signal?.throwIfAborted();
  const selected =
    options.applyOrdinaryPrecedence === false
      ? options.plugins.filter((plugin) => plugin.enabled)
      : selectOrdinaryPluginPrecedence(options.plugins);
  for (const plugin of selected) {
    check();
    const seenFiles = new Map<string, Set<string>>(),
      seenDirs = new Set<string>();
    let directories = 0;
    const issue = (
      reason: string,
      message: string,
      path?: string,
      kind?: PluginDefinitionDiagnostic["kind"],
    ) =>
      diagnostics.push({
        source: plugin.source,
        reason,
        message,
        ...(path !== undefined && { path }),
        ...(kind !== undefined && { kind }),
      });
    const policy: PathReadPolicy = async (path, canonical) => {
      check();
      if (
        isPluginCacheDescendant(plugin.root, path) ||
        (canonical !== undefined &&
          isPluginCacheDescendant(plugin.realRoot, canonical)) ||
        !within(plugin.root, path) ||
        (canonical !== undefined && !within(plugin.realRoot, canonical))
      )
        return "Plugin descendant leaves the admitted root or enters .mcpb-cache";
      const result = await options.readPolicy?.(path, canonical);
      check();
      return result ?? true;
    };
    const admit = async (definition: PluginRuntimeDefinition) => {
      const detached = freeze(structuredClone(definition));
      check();
      const result = await options.admitDefinition?.(detached, plugin);
      check();
      if (result === false || typeof result === "string") {
        issue(
          "withheld",
          typeof result === "string"
            ? result
            : "Host withheld plugin definition",
          "info" in detached ? detached.info.path : detached.filePath,
        );
        return;
      }
      if ("info" in detached) prompts.push(detached);
      else agents.push(detached);
    };
    const read = async (path: string, kind: "command" | "skill" | "agent") => {
      check();
      const value = await readBoundedConfigurationText(
        path,
        PLUGIN_DOCUMENT_MAX_BYTES,
        policy,
      );
      check();
      if (value.status !== "loaded") {
        if (value.status !== "absent")
          issue(value.reason, value.message, path, kind);
        return;
      }
      const seen = seenFiles.get(kind) ?? new Set<string>();
      seenFiles.set(kind, seen);
      if (seen.has(value.canonicalPath)) return;
      seen.add(value.canonicalPath);
      const parsed = parseSkillText(value.text);
      if (parsed.parseError) {
        issue("frontmatter", parsed.parseError, path, kind);
        return;
      }
      return { ...parsed, canonicalPath: value.canonicalPath };
    };
    const prompt = async (
      path: string,
      name: string,
      isSkillMode: boolean,
      kind: "command" | "skill",
      metadata?: Readonly<Record<string, unknown>>,
      inline?: string,
      loaded?: ReturnType<typeof parseSkillText> & { canonicalPath: string },
    ) => {
      const value =
        loaded ??
        (inline === undefined
          ? await read(path, kind)
          : { ...parseSkillText(inline), canonicalPath: path });
      if (!value) return;
      if (value.parseError) {
        issue("frontmatter", value.parseError, path, kind);
        return;
      }
      const fields = { ...value.fields },
        body = value.content;
      if (metadata) {
        if (metadata.description) fields.description = metadata.description;
        if (metadata.argumentHint)
          fields["argument-hint"] = metadata.argumentHint;
        if (metadata.model) fields.model = metadata.model;
        if (metadata.allowedTools) {
          if (!Array.isArray(metadata.allowedTools))
            throw new TypeError(
              "Plugin command allowedTools metadata must be an array",
            );
          fields["allowed-tools"] = metadata.allowedTools.join(",");
        }
      }
      if (!(options.isOfferedName ?? offered)(name)) {
        issue("name", "Namespaced plugin prompt is not offered", path, kind);
        return;
      }
      const denied = fields["disallowed-tools"] ?? fields.disallowedTools;
      if (!validToolList(denied)) {
        issue(
          "disallowed-tools",
          "Invalid declared deny list withholds the definition",
          path,
          kind,
        );
        return;
      }
      const specified = descriptionValue(fields.description),
        description = specified ?? body.trim().split("\n")[0] ?? "";
      const display = named(fields.name),
        prefix = name.slice(0, name.lastIndexOf(":") + 1),
        displayName = display
          ? display.startsWith(prefix)
            ? display
            : prefix + display
          : name;
      const info: PluginPromptInfo = {
        name,
        displayName,
        description,
        hasUserSpecifiedDescription: !!specified?.trim(),
        path,
        canonicalPath: value.canonicalPath,
        baseDir: inline === undefined ? dirname(path) : plugin.root,
        source: "plugin",
        pluginRoot: plugin.root,
        pluginSource: provenance(plugin),
        allowedTools: parseSkillToolList(fields["allowed-tools"]),
        disallowedTools: parseSkillToolList(denied),
        argumentNames: (Array.isArray(fields.arguments)
          ? fields.arguments
          : typeof fields.arguments === "string"
            ? fields.arguments.split(/\s+/)
            : []
        ).filter(
          (item): item is string =>
            typeof item === "string" && !!item.trim() && !/^\d+$/.test(item),
        ),
        userInvocable:
          fields["user-invocable"] === undefined
            ? true
            : (flag(fields["user-invocable"]) ?? false),
        disableModelInvocation:
          flag(fields["disable-model-invocation"]) ?? false,
        contentLength: body.length,
      };
      for (const [key, raw] of [
        ["argumentHint", fields["argument-hint"]],
        ["whenToUse", fields.when_to_use],
        ["version", fields.version],
        ["agent", fields.agent],
      ] as const) {
        const string = scalar(raw);
        if (string !== undefined) info[key] = string;
      }
      const selectedModel = model(fields.model, options),
        effort = parseQueryEffort(fields.effort),
        background = flag(fields.background),
        shell = scalar(fields.shell)?.trim().toLowerCase();
      if (selectedModel !== undefined) info.model = selectedModel;
      if (effort !== undefined) info.effort = effort;
      if (background !== undefined) info.background = background;
      if (fields.context === "fork") info.context = "fork";
      if (shell === "bash" || shell === "powershell") info.shell = shell;
      if (record(fields.metadata)) info.metadata = fields.metadata;
      let invalid =
        outsideGuard(fields) ||
        (!isSkillMode &&
          fields.hooks != null &&
          (typeof fields.hooks !== "object" || guarded(fields.hooks)));
      if (!invalid && isSkillMode && fields.hooks) {
        try {
          if (!options.validateHooks)
            throw new Error("Plugin skill hooks require a host validator");
          const hooks = await options.validateHooks(fields.hooks, path, plugin);
          check();
          if (!record(hooks)) throw new Error("Host withheld plugin hooks");
          info.hooks = hooks;
        } catch (error) {
          check();
          invalid = true;
          issue("hooks", String(error), path, kind);
        }
      }
      if (invalid) {
        info.allowedTools = [];
        delete info.hooks;
        issue(
          "hooks-and-grants-withheld",
          "Invalid or misplaced hooks withheld hooks and allowed-tools; declared denies remain",
          path,
          kind,
        );
        if (options.rejectInvalidHooks) return;
      }
      await admit({
        info,
        body,
        frontmatter: fields,
        isSkillMode: kind === "skill",
        isSkillFile: isSkillMode,
        kind,
        ...(display &&
          !display.includes(":") &&
          offered(displayName) && { aliases: [display] }),
      });
    };
    const agent = async (path: string, namespace: readonly string[]) => {
      const value = await read(path, "agent");
      if (!value) return;
      const fields = value.fields,
        filename = named(fields.name) || basename(path).replace(/\.md$/, ""),
        agentType = [plugin.name, ...namespace, filename].join(":");
      // Native plugin agents bound the optional leaf name, not the composed namespace length.
      if (options.isOfferedName && !options.isOfferedName(agentType)) {
        issue(
          "name",
          "Plugin agent name is not offered by the host",
          path,
          "agent",
        );
        return;
      }
      if (!validToolList(fields.disallowedTools)) {
        issue(
          "disallowedTools",
          "Invalid declared deny list withholds plugin agent",
          path,
          "agent",
        );
        return;
      }
      let tools: string[] | undefined =
        fields.tools === undefined
          ? undefined
          : parseSkillToolList(fields.tools);
      if (tools?.includes("*")) tools = undefined;
      const denied =
        fields.disallowedTools === undefined
          ? undefined
          : parseSkillToolList(fields.disallowedTools);
      const memory =
        fields.memory === "user" ||
        fields.memory === "project" ||
        fields.memory === "local"
          ? fields.memory
          : undefined;
      if (options.memoryEnabled && memory && tools !== undefined)
        for (const tool of ["Write", "Edit", "Read"])
          if (!tools.includes(tool)) tools.push(tool);
      const definition: PluginAgentDefinition = {
        agentType,
        whenToUse:
          descriptionValue(fields.description) ||
          descriptionValue(fields.when_to_use) ||
          descriptionValue(fields["when-to-use"]) ||
          `Agent provided by ${plugin.name}`,
        prompt: value.content.trim(),
        source: "plugin",
        filename,
        filePath: path,
        canonicalPath: value.canonicalPath,
        baseDir: dirname(path),
        skills: parseSkillToolList(fields.skills),
        pluginSource: provenance(plugin),
        ...(tools !== undefined && { tools }),
        ...(denied !== undefined &&
          !denied.includes("*") && { disallowedTools: denied }),
        ...(memory !== undefined && { memory }),
      };
      const selectedModel = model(fields.model, options, false),
        effort = parseQueryEffort(fields.effort),
        maxTurns = positive(fields.maxTurns),
        compact = positive(fields.autoCompactWindow);
      if (selectedModel !== undefined) definition.model = selectedModel;
      if (effort !== undefined) definition.effort = effort;
      if (maxTurns !== undefined) definition.maxTurns = maxTurns;
      if (compact !== undefined && compact >= 100_000 && compact <= 1_000_000)
        definition.autoCompactWindow = compact;
      if (typeof fields.color === "string") definition.color = fields.color;
      if (fields.background === true || fields.background === "true")
        definition.background = true;
      if (fields.omitClaudeMd === true || fields.omitClaudeMd === "true")
        definition.omitClaudeMd = true;
      if (fields.isolation === "worktree") definition.isolation = "worktree";
      const experimental = record(fields.experimental)
        ? fields.experimental
        : {};
      const ttl = Object.entries(experimental).find(
        ([key]) => key.toLowerCase().replace(/[-_]/g, "") === "cachettl",
      )?.[1];
      if (ttl === "5m" || ttl === "1h") definition.cacheTtl = ttl;
      for (const field of [
        "permissionMode",
        "hooks",
        "mcpServers",
        "initialPrompt",
        "observer",
        "observerMessage",
        "observeSubagents",
      ])
        if (fields[field] !== undefined)
          issue(
            "ignored-plugin-agent-field",
            `${field} is not applied by plugin agents`,
            path,
            "agent",
          );
      await admit(definition);
    };
    const walk = async (
      directory: string,
      namespace: readonly string[],
      kind: "command" | "agent",
      rootPath: string,
    ) => {
      check();
      if (namespace.length >= 32 || ++directories > 4096) {
        issue(
          "scan-bound",
          "Plugin recursive scan reached its source depth/directory bound",
          directory,
          kind,
        );
        return;
      }
      let entries: import("node:fs").Dirent[];
      try {
        const canonical = await realpath(directory);
        if ((await policy(directory, canonical)) !== true) {
          issue("path", "Plugin directory was withheld", directory, kind);
          return;
        }
        const info = await stat(directory, { bigint: true }),
          key = `${kind}:${info.dev}:${info.ino}`;
        if (seenDirs.has(key)) return;
        seenDirs.add(key);
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        issue("scan", String(error), directory, kind);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      const skill =
        kind === "command"
          ? entries.find(
              (entry) => entry.isFile() && /^skill\.md$/i.test(entry.name),
            )
          : undefined;
      if (skill) {
        const suffix = relative(rootPath, directory).split(sep).filter(Boolean),
          name = [
            plugin.name,
            ...(suffix.length ? suffix : [basename(directory)]),
          ].join(":");
        await prompt(join(directory, skill.name), name, true, "command");
        return;
      }
      for (const entry of entries) {
        check();
        if (isPluginCacheDescendant(plugin.root, join(directory, entry.name)))
          continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory())
          await walk(path, [...namespace, entry.name], kind, rootPath);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          if (kind === "agent") await agent(path, namespace);
          else
            await prompt(
              path,
              [plugin.name, ...namespace, entry.name.replace(/\.md$/, "")].join(
                ":",
              ),
              false,
              "command",
            );
        }
      }
    };
    for (const component of plugin.components) {
      check();
      if (!["commands", "skills", "agents"].includes(component.kind)) continue;
      const kind =
        component.kind === "agents"
          ? "agent"
          : component.kind === "skills"
            ? "skill"
            : "command";
      if (component.path === undefined) {
        if (
          kind === "command" &&
          typeof component.metadata?.content === "string" &&
          component.commandName !== undefined
        )
          await prompt(
            `<inline:${plugin.name}:${component.commandName}>`,
            `${plugin.name}:${component.commandName}`,
            false,
            "command",
            component.metadata,
            component.metadata.content,
          );
        continue;
      }
      let info;
      try {
        const canonical = await realpath(component.path);
        if (
          canonical !== component.realPath ||
          (await policy(component.path, canonical)) !== true
        ) {
          issue(
            "path-changed",
            "Component changed or was withheld after catalog discovery",
            component.path,
            kind,
          );
          continue;
        }
        info = await stat(component.path);
      } catch (error) {
        issue("path", String(error), component.path, kind);
        continue;
      }
      if (kind === "agent") {
        if (info.isDirectory())
          await walk(component.path, [], "agent", component.path);
        else if (info.isFile()) await agent(component.path, []);
      } else if (kind === "command") {
        if (info.isDirectory())
          await walk(component.path, [], "command", component.path);
        else if (info.isFile())
          await prompt(
            component.path,
            `${plugin.name}:${component.commandName ?? basename(component.path).replace(/\.md$/, "")}`,
            false,
            "command",
            component.metadata,
          );
      } else if (info.isDirectory()) {
        const direct = join(component.path, "SKILL.md");
        let directPresent = false;
        try {
          directPresent = (await stat(direct)).isFile();
        } catch {
          /* absent direct skill permits the child scan */
        }
        if (directPresent) {
          // yPe uses direct skill frontmatter name; read once here, then the shared prompt parser.
          const value = await read(direct, "skill");
          if (!value) continue;
          const raw = value.fields.name,
            front = typeof raw === "string" ? raw.trim() : "",
            local = front.startsWith(`${plugin.name}:`)
              ? front.slice(plugin.name.length + 1)
              : front;
          await prompt(
            direct,
            `${plugin.name}:${(local || basename(component.path)).replace(/[^a-zA-Z0-9_-]/g, "-")}`,
            true,
            "skill",
            undefined,
            undefined,
            value,
          );
        } else {
          const entries = await readdir(component.path, {
            withFileTypes: true,
          });
          for (const entry of entries.sort((a, b) =>
            a.name.localeCompare(b.name, "en"),
          )) {
            if (
              (!entry.isDirectory() && !entry.isSymbolicLink()) ||
              isPluginCacheDescendant(
                plugin.root,
                join(component.path, entry.name),
              )
            )
              continue;
            await prompt(
              join(component.path, entry.name, "SKILL.md"),
              `${plugin.name}:${entry.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
              true,
              "skill",
            );
          }
        }
      }
    }
  }
  check();
  return { prompts, agents, diagnostics };
}
