import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  readBoundedConfigurationText,
  type PathReadPolicy,
} from "./configuration.js";
import { parseSkillText, parseSkillToolList } from "./skills.js";
import { parseQueryEffort, type QueryEffort } from "./query-model-effort.js";

export const AGENT_DEFINITION_MAX_BYTES = 1_048_576;
export type AgentDefinitionSource =
  | "built-in"
  | "plugin"
  | "userSettings"
  | "projectSettings"
  | "flagSettings"
  | "policySettings";
export type AgentMemoryScope = "user" | "project" | "local";
export type AgentDefinitionPermissionMode =
  "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
export interface AgentDefinitionLocation {
  directory: string;
  source: "userSettings" | "projectSettings" | "policySettings";
  fromAdditionalDirectory?: boolean;
}
export interface LocalAgentDefinition {
  agentType: string;
  whenToUse: string;
  prompt: string;
  source: AgentDefinitionSource;
  baseDir?: string;
  filename?: string;
  filePath?: string;
  canonicalPath?: string;
  fromAdditionalDirectory?: boolean;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  skills: readonly string[];
  model?: string;
  effort?: QueryEffort;
  permissionMode?: AgentDefinitionPermissionMode;
  maxTurns?: number;
  autoCompactWindow?: number;
  cacheTtl?: "5m" | "1h";
  memory?: AgentMemoryScope;
  background?: true;
  omitClaudeMd?: true;
  isolation?: "worktree" | "remote";
  initialPrompt?: string;
  observer?: string;
  observerMessage?: string;
  observeSubagents?: false;
  color?: string;
  hooks?: unknown;
  mcpServers?: readonly (string | Readonly<Record<string, unknown>>)[];
}
export interface AgentDefinitionDiagnostic {
  path?: string;
  source?: AgentDefinitionSource;
  reason: string;
  message: string;
}
export type AgentCatalogEntry = Omit<
  LocalAgentDefinition,
  "prompt" | "initialPrompt" | "observerMessage" | "hooks" | "mcpServers"
> & { hasHooks: boolean; mcpServerCount: number };
export interface AgentRegistryOptions {
  /** Actual agent folders, in scan order. No cwd/home/account discovery occurs. */
  locations: readonly AgentDefinitionLocation[];
  /** Host-provided metadata/prompt fixtures; this module includes no vendor built-in prompts. */
  definitions?: readonly LocalAgentDefinition[];
  sources?: { user?: boolean; project?: boolean; policy?: boolean };
  readPolicy?: PathReadPolicy;
  allowExternalLinks?: boolean;
  maxDirectories?: number;
  maxFiles?: number;
  memoryEnabled?: boolean;
  admitSource?(
    location: Readonly<AgentDefinitionLocation>,
  ): boolean | string | Promise<boolean | string>;
  /** Applied after precedence: withholding a winning definition does not revive a shadowed one. */
  eligible?(
    definition: Readonly<LocalAgentDefinition>,
    context?: unknown,
  ): boolean | string | Promise<boolean | string>;
  /** No hook command runs here. A malformed/unadmitted hook block withholds the entire agent. */
  validateHooks?(hooks: unknown, definitionName: string, path: string): unknown;
  /** Inline MCP transport schemas are owned by the host; invalid items are omitted with diagnostics. */
  validateInlineMcp?(
    server: Readonly<Record<string, unknown>>,
    path: string,
  ): Readonly<Record<string, unknown>>;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const modes = new Set<unknown>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);
const isPermissionMode = (
  value: unknown,
): value is AgentDefinitionPermissionMode => modes.has(value);
const isMemoryScope = (value: unknown): value is AgentMemoryScope =>
  value === "user" || value === "project" || value === "local";
const colors = new Set([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);
const inside = (path: string, root: string) => {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(".." + sep) && !isAbsolute(value))
  );
};
const depth = (path: string | undefined) =>
  path === undefined ? Infinity : (path.match(/[/\\]/g)?.length ?? 0);
const positive = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return;
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      typeof value !== "bigint"
    )
      return;
    const raw = String(value).trim();
    if (raw.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(raw))
      parsed = Number(raw);
    else if (
      raw.length <= 32 &&
      /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/.test(raw)
    )
      parsed = Number.parseInt(raw.replace(/[_,\u00A0\u202F ]/g, ""), 10);
    else parsed = Number.parseInt(raw, 10);
  }
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};
const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_]/g, "");
/** Guard-shaped declarations outside hooks must never be silently ignored. */
function misplacedGuard(fields: Record<string, unknown>): boolean {
  const visit = (value: unknown, remaining: number): boolean => {
    if ((!isRecord(value) && !Array.isArray(value)) || remaining < 0)
      return false;
    if (Array.isArray(value))
      return value.some((item) => visit(item, remaining - 1));
    return Object.entries(value).some(
      ([key, item]) =>
        (["pretooluse", "permissionrequest"].includes(normalizeKey(key)) &&
          item != null &&
          (!Array.isArray(item) || item.length > 0)) ||
        (!["metadata", "mcpservers", "lspservers"].includes(
          normalizeKey(key),
        ) &&
          visit(item, remaining - 1)),
    );
  };
  return Object.entries(fields).some(
    ([key, value]) =>
      key !== "hooks" &&
      !["metadata", "mcpServers", "lspServers"].includes(key) &&
      ((["pretooluse", "permissionrequest"].includes(normalizeKey(key)) &&
        value != null &&
        (!Array.isArray(value) || value.length > 0)) ||
        visit(value, 3)),
  );
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const item of Object.values(value)) freeze(item, seen);
    Object.freeze(value);
  }
  return value;
}
export function agentDefinitionLocations(options: {
  managedRoot?: string;
  userConfigDir?: string;
  projectDirectories?: readonly string[];
  additionalDirectories?: readonly string[];
}): AgentDefinitionLocation[] {
  return [
    ...(options.managedRoot
      ? [
          {
            directory: join(options.managedRoot, ".claude", "agents"),
            source: "policySettings" as const,
          },
        ]
      : []),
    ...(options.userConfigDir
      ? [
          {
            directory: join(options.userConfigDir, "agents"),
            source: "userSettings" as const,
          },
        ]
      : []),
    ...(options.additionalDirectories ?? []).map((path) => ({
      directory: join(path, ".claude", "agents"),
      source: "projectSettings" as const,
      fromAdditionalDirectory: true,
    })),
    ...(options.projectDirectories ?? []).map((path) => ({
      directory: join(path, ".claude", "agents"),
      source: "projectSettings" as const,
    })),
  ];
}

export class LocalAgentRegistry {
  private candidates: LocalAgentDefinition[] = [];
  private winners: LocalAgentDefinition[] = [];
  readonly diagnostics: AgentDefinitionDiagnostic[] = [];
  private constructor(private readonly options: AgentRegistryOptions) {}
  static async create(
    options: AgentRegistryOptions,
  ): Promise<LocalAgentRegistry> {
    const registry = new LocalAgentRegistry(options);
    await registry.load();
    return registry;
  }
  private diagnostic(
    reason: string,
    message: string,
    location?: AgentDefinitionLocation,
    path?: string,
  ) {
    this.diagnostics.push({
      reason,
      message,
      ...(location ? { source: location.source } : {}),
      ...(path ? { path } : {}),
    });
  }
  private parse(
    text: string,
    filePath: string,
    canonicalPath: string,
    location: AgentDefinitionLocation,
  ): LocalAgentDefinition | undefined {
    const { fields, content, parseError } = parseSkillText(text);
    if (parseError)
      this.diagnostic(
        "frontmatter",
        "Agent frontmatter failed to parse: " + parseError,
        location,
        filePath,
      );
    const name = fields.name,
      description = fields.description;
    if (
      typeof name !== "string" ||
      !name ||
      name.startsWith("-") ||
      name.length > 256 ||
      name.normalize("NFKC").includes(":")
    ) {
      this.diagnostic(
        "name",
        "Agent requires a nonempty name of at most 256 UTF16 units, without a leading '-' or NFKC colon",
        location,
        filePath,
      );
      return;
    }
    if (typeof description !== "string" || !description) {
      this.diagnostic(
        "description",
        "Agent requires a string description",
        location,
        filePath,
      );
      return;
    }
    if (misplacedGuard(fields)) {
      this.diagnostic(
        "hooks",
        "Agent has a permission guard outside hooks",
        location,
        filePath,
      );
      return;
    }
    let hooks: unknown;
    if (fields.hooks) {
      try {
        if (!this.options.validateHooks)
          throw new Error("Host hook validator is required");
        hooks = this.options.validateHooks(fields.hooks, name, filePath);
        if (hooks === undefined)
          throw new Error("Host validator withheld agent hooks");
      } catch (error) {
        this.diagnostic(
          "hooks",
          error instanceof Error ? error.message : "Invalid hooks",
          location,
          filePath,
        );
        return;
      }
    }
    const toolsValue = fields.tools,
      tools =
        toolsValue === undefined
          ? undefined
          : toolsValue === null
            ? []
            : parseSkillToolList(toolsValue);
    let allowed = tools?.includes("*") ? undefined : tools;
    const deniedValue = fields.disallowedTools,
      denied =
        deniedValue === undefined ? undefined : parseSkillToolList(deniedValue);
    if (
      this.options.memoryEnabled &&
      typeof fields.memory === "string" &&
      ["user", "project", "local"].includes(fields.memory) &&
      allowed !== undefined
    ) {
      for (const tool of ["Write", "Edit", "Read"])
        if (!allowed.includes(tool)) allowed = [...allowed, tool];
    }
    const permission =
      fields.permissionMode === "manual" ? "default" : fields.permissionMode;
    if (
      fields.background !== undefined &&
      ![true, false, "true", "false"].some(
        (valid) => valid === fields.background,
      )
    )
      this.diagnostic(
        "background",
        "Invalid background value was ignored",
        location,
        filePath,
      );
    if (permission && !modes.has(permission))
      this.diagnostic(
        "permissionMode",
        "Invalid agent permissionMode",
        location,
        filePath,
      );
    const maxTurns = positive(fields.maxTurns),
      compact = positive(fields.autoCompactWindow),
      effort = parseQueryEffort(fields.effort);
    const memory = isMemoryScope(fields.memory) ? fields.memory : undefined;
    const isolation =
      fields.isolation === "worktree" || fields.isolation === "remote"
        ? fields.isolation
        : undefined;
    for (const [key, valid] of [
      ["maxTurns", maxTurns !== undefined],
      [
        "autoCompactWindow",
        compact !== undefined && compact >= 100000 && compact <= 1000000,
      ],
      ["effort", effort !== undefined],
      ["memory", memory !== undefined],
      ["isolation", isolation !== undefined],
    ] as const) {
      if (fields[key] !== undefined && !valid)
        this.diagnostic(
          key,
          "Invalid agent " + key + " was ignored",
          location,
          filePath,
        );
    }
    const mcp: (string | Readonly<Record<string, unknown>>)[] = [];
    if (Array.isArray(fields.mcpServers))
      for (const item of fields.mcpServers) {
        if (typeof item === "string") mcp.push(item);
        else
          try {
            if (!isRecord(item) || !this.options.validateInlineMcp)
              throw new Error(
                "Inline MCP requires the host transport validator",
              );
            mcp.push(this.options.validateInlineMcp(item, filePath));
          } catch (error) {
            this.diagnostic(
              "mcpServers",
              error instanceof Error ? error.message : "Invalid MCP server",
              location,
              filePath,
            );
          }
      }
    const model =
      typeof fields.model === "string" && fields.model.trim()
        ? fields.model.trim()
        : undefined;
    const experimental = isRecord(fields.experimental)
        ? fields.experimental
        : {},
      ttl = Object.entries(experimental).find(
        ([key]) => normalizeKey(key) === "cachettl",
      )?.[1];
    const definition: LocalAgentDefinition = {
      agentType: name,
      whenToUse: description.replaceAll("\\n", "\n"),
      prompt: content.trim(),
      source: location.source,
      baseDir: location.directory,
      filename: basename(filePath, ".md"),
      filePath,
      canonicalPath,
      ...(location.fromAdditionalDirectory
        ? { fromAdditionalDirectory: true }
        : {}),
      ...(allowed === undefined ? {} : { tools: allowed }),
      ...(denied === undefined || denied.includes("*")
        ? {}
        : { disallowedTools: denied }),
      skills: parseSkillToolList(fields.skills),
      ...(model === undefined
        ? {}
        : { model: model.toLowerCase() === "inherit" ? "inherit" : model }),
      ...(effort === undefined ? {} : { effort }),
      ...(isPermissionMode(permission) ? { permissionMode: permission } : {}),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(compact === undefined || compact < 100000 || compact > 1000000
        ? {}
        : { autoCompactWindow: compact }),
      ...(ttl === "5m" || ttl === "1h" ? { cacheTtl: ttl } : {}),
      ...(memory ? { memory } : {}),
      ...(isolation ? { isolation } : {}),
      ...(fields.background === true || fields.background === "true"
        ? { background: true }
        : {}),
      ...(fields.omitClaudeMd === true || fields.omitClaudeMd === "true"
        ? { omitClaudeMd: true }
        : {}),
      ...(typeof fields.initialPrompt === "string" &&
      fields.initialPrompt.trim()
        ? { initialPrompt: fields.initialPrompt }
        : {}),
      ...(typeof fields.observer === "string" && fields.observer.trim()
        ? { observer: fields.observer.trim() }
        : {}),
      ...(typeof fields.observerMessage === "string" &&
      fields.observerMessage.trim()
        ? { observerMessage: fields.observerMessage }
        : {}),
      ...(fields.observeSubagents === false ||
      fields.observeSubagents === "false"
        ? { observeSubagents: false }
        : {}),
      ...(typeof fields.color === "string" && colors.has(fields.color)
        ? { color: fields.color }
        : {}),
      ...(hooks === undefined ? {} : { hooks }),
      ...(mcp.length ? { mcpServers: mcp } : {}),
    };
    return freeze(structuredClone(definition));
  }
  private async load(): Promise<void> {
    const locations = this.options.locations.map((location) => {
      if (!isAbsolute(location.directory))
        throw new Error("Agent roots must be absolute");
      return { ...location, directory: resolve(location.directory) };
    });
    const roots = await Promise.all(
      locations.map((location) =>
        realpath(location.directory).catch(() => location.directory),
      ),
    );
    const ordinaryProjectRoots = new Set(
      roots.filter(
        (_root, index) =>
          locations[index]?.source === "projectSettings" &&
          !locations[index]?.fromAdditionalDirectory,
      ),
    );
    const maxDirectories = this.options.maxDirectories ?? 10000,
      maxFiles = this.options.maxFiles ?? 10000;
    if (
      !Number.isSafeInteger(maxDirectories) ||
      maxDirectories < 1 ||
      !Number.isSafeInteger(maxFiles) ||
      maxFiles < 1
    )
      throw new Error("Invalid agent scan bound");
    let directories = 0,
      files = 0;
    const seenFiles = new Set<string>();
    for (const [locationIndex, location] of locations.entries()) {
      const root = roots[locationIndex];
      if (
        location.fromAdditionalDirectory &&
        root !== undefined &&
        ordinaryProjectRoots.has(root)
      )
        continue;
      const sourceKey =
        location.source === "policySettings"
          ? "policy"
          : location.source === "userSettings"
            ? "user"
            : "project";
      if (this.options.sources?.[sourceKey] === false) continue;
      const admission = await this.options.admitSource?.(location);
      if (admission === false || typeof admission === "string") {
        this.diagnostic(
          "source",
          typeof admission === "string" ? admission : "Agent source withheld",
          location,
        );
        continue;
      }
      const seenDirectories = new Set<string>();
      const admitPath: PathReadPolicy = async (path, canonical) => {
        if (
          canonical &&
          !this.options.allowExternalLinks &&
          !roots.some((root) => inside(canonical, root))
        )
          return "Agent link leaves the explicit registry roots";
        return (await this.options.readPolicy?.(path, canonical)) ?? true;
      };
      const walk = async (directory: string): Promise<void> => {
        if (++directories > maxDirectories) {
          this.diagnostic(
            "scan-bound",
            "Agent directory bound reached",
            location,
            directory,
          );
          return;
        }
        try {
          const canonical = await realpath(directory),
            admission = await admitPath(directory, canonical);
          if (admission !== true) {
            this.diagnostic(
              "read-policy",
              typeof admission === "string"
                ? admission
                : "Agent directory withheld",
              location,
              directory,
            );
            return;
          }
          const info = await stat(directory, { bigint: true }),
            identity = `${info.dev}:${info.ino}`;
          if (!info.isDirectory() || seenDirectories.has(identity)) return;
          seenDirectories.add(identity);
          const entries = await readdir(directory, { withFileTypes: true });
          for (const entry of entries.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          )) {
            const path = join(directory, entry.name),
              info = entry.isSymbolicLink()
                ? await stat(path).catch(() => undefined)
                : entry;
            if (info?.isDirectory()) {
              await walk(path);
              continue;
            }
            if (!info?.isFile() || !entry.name.endsWith(".md")) continue;
            if (++files > maxFiles) {
              this.diagnostic(
                "scan-bound",
                "Agent file bound reached",
                location,
                path,
              );
              return;
            }
            const read = await readBoundedConfigurationText(
              path,
              AGENT_DEFINITION_MAX_BYTES,
              admitPath,
            );
            if (read.status !== "loaded") {
              this.diagnostic(read.reason, read.message, location, path);
              continue;
            }
            const fileInfo = await lstat(path, { bigint: true }),
              fileIdentity = `${fileInfo.dev}:${fileInfo.ino}`;
            if (seenFiles.has(fileIdentity)) {
              this.diagnostic(
                "duplicate-file",
                "Agent file inode already loaded",
                location,
                path,
              );
              continue;
            }
            seenFiles.add(fileIdentity);
            try {
              const definition = this.parse(
                read.text,
                path,
                read.canonicalPath,
                location,
              );
              if (definition) this.candidates.push(definition);
            } catch (error) {
              this.diagnostic(
                "parse",
                error instanceof Error
                  ? error.message
                  : "Agent definition could not be parsed",
                location,
                path,
              );
            }
          }
        } catch (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
          if (code !== "ENOENT" && code !== "ENOTDIR")
            this.diagnostic(
              "scan",
              error instanceof Error ? error.message : "Agent scan failed",
              location,
              directory,
            );
        }
      };
      await walk(location.directory);
    }
    this.candidates.unshift(
      ...(this.options.definitions ?? []).map((definition) =>
        freeze(structuredClone(definition)),
      ),
    );
    const groups = [
      this.candidates.filter((d) => d.source === "built-in"),
      this.candidates.filter((d) => d.source === "plugin"),
      this.candidates.filter((d) => d.source === "userSettings"),
      [
        ...this.candidates.filter(
          (d) => d.source === "projectSettings" && d.fromAdditionalDirectory,
        ),
        ...this.candidates
          .filter(
            (d) => d.source === "projectSettings" && !d.fromAdditionalDirectory,
          )
          .sort((a, b) => depth(a.baseDir) - depth(b.baseDir)),
      ],
      this.candidates.filter((d) => d.source === "flagSettings"),
      this.candidates.filter((d) => d.source === "policySettings"),
    ];
    const active = new Map<string, LocalAgentDefinition>();
    for (const group of groups)
      for (const definition of group)
        active.set(definition.agentType, definition);
    const duplicates = new Map<string, LocalAgentDefinition[]>();
    for (const definition of this.candidates.filter(
      (d) => d.source !== "built-in",
    )) {
      const key =
        definition.source +
        "\0" +
        (definition.baseDir ?? "") +
        "\0" +
        definition.agentType;
      const previous = duplicates.get(key) ?? [];
      previous.push(definition);
      duplicates.set(key, previous);
    }
    for (const group of duplicates.values()) {
      const [first] = group;
      if (first && group.length > 1)
        this.diagnostics.push({
          reason: "duplicate-name",
          source: first.source,
          message: `Duplicate agent name ${first.agentType} in the same source and base directory`,
        });
    }
    this.winners = [...active.values()].sort((a, b) =>
      a.agentType.localeCompare(b.agentType, "en"),
    );
  }
  get allDefinitions(): readonly Readonly<LocalAgentDefinition>[] {
    return [...this.candidates];
  }
  get activeDefinitions(): readonly Readonly<LocalAgentDefinition>[] {
    return [...this.winners];
  }
  async resolve(
    name: string,
    context?: unknown,
  ): Promise<Readonly<LocalAgentDefinition> | undefined> {
    const definition = this.winners.find(
      (candidate) => candidate.agentType === name,
    );
    if (!definition) return;
    const admission = await this.options.eligible?.(definition, context);
    return admission === undefined || admission === true
      ? definition
      : undefined;
  }
  async catalog(context?: unknown): Promise<readonly AgentCatalogEntry[]> {
    const offered = await Promise.all(
      this.winners.map((definition) =>
        this.resolve(definition.agentType, context),
      ),
    );
    return offered
      .filter((value): value is LocalAgentDefinition => value !== undefined)
      .map(
        ({
          prompt: _prompt,
          initialPrompt: _initial,
          observerMessage: _observer,
          hooks,
          mcpServers,
          ...metadata
        }) => ({
          ...metadata,
          hasHooks: hooks !== undefined,
          mcpServerCount: mcpServers?.length ?? 0,
        }),
      );
  }
  /** Persistent memory guidance is supplied by the host; this module reads no memory or resource files. */
  async prompt(
    name: string,
    options: {
      context?: unknown;
      memoryContext?(
        definition: Readonly<LocalAgentDefinition>,
      ): string | Promise<string>;
    } = {},
  ): Promise<string | undefined> {
    const definition = await this.resolve(name, options.context);
    if (!definition) return;
    const extra =
      this.options.memoryEnabled && definition.memory && options.memoryContext
        ? await options.memoryContext(definition)
        : "";
    return extra ? definition.prompt + "\n\n" + extra : definition.prompt;
  }
}
export const createLocalAgentRegistry = (options: AgentRegistryOptions) =>
  LocalAgentRegistry.create(options);
