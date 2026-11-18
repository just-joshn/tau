import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMemoryScope, LocalAgentDefinition } from "./agent-definitions.js";

export const AGENT_MEMORY_INDEX = "MEMORY.md";
export const AGENT_MEMORY_INDEX_LINES = 200;
export const AGENT_MEMORY_INDEX_UNITS = 25_000;
export interface AgentMemoryRoots {
  /** Exact source ue(): task-scoped cwd or host cwd, not an inferred repository root. */
  workingDirectory: string;
  configurationDirectory: string;
  remoteMemoryDirectory?: string;
  /** Exact host nH(EP(projectRoot) ?? projectRoot); required only for remote local scope. */
  remoteProjectKey?: string;
}
export interface AgentMemoryLocation { agentType: string; name: string; scope: AgentMemoryScope; directory: string; indexPath: string }
const absolute = (path: string): string => { if (!isAbsolute(path) || path.includes("\0")) throw new TypeError("Agent memory roots must be absolute"); return resolve(path); };
const beneath = (path: string, root: string): boolean => { const r = relative(root, path); return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r); };
export const agentMemoryName = (agentType: string): string => agentType.replace(/[^a-zA-Z0-9\-_]/g, "-") || "unknown";
export function resolveAgentMemoryLocation(agentType: string, scope: AgentMemoryScope, roots: AgentMemoryRoots): AgentMemoryLocation {
  const cwd = absolute(roots.workingDirectory), config = absolute(roots.configurationDirectory);
  const remote = roots.remoteMemoryDirectory === undefined ? undefined : absolute(roots.remoteMemoryDirectory);
  const name = agentMemoryName(agentType); let directory: string;
  if (scope === "user") directory = join(remote ?? config, "agent-memory", name);
  else if (scope === "project") directory = join(cwd, ".claude", "agent-memory", name);
  else if (scope === "local") {
    if (remote !== undefined) {
      const key = roots.remoteProjectKey;
      if (!key || key === "." || key === ".." || /[/\\\0]/.test(key)) throw new TypeError("Explicit remote project key is required");
      directory = join(remote, "projects", key, "agent-memory-local", name);
    } else directory = join(cwd, ".claude", "agent-memory-local", name);
  } else throw new TypeError("Unknown agent memory scope");
  return Object.freeze({ agentType, name, scope, directory: directory + sep, indexPath: join(directory, AGENT_MEMORY_INDEX) });
}
export interface AgentMemoryGate {
  memoryToggledOff: boolean; autoMemoryOffThisSession: boolean;
  safeMode: boolean; restricted: boolean; confined: boolean;
  disableAutoMemory: string | undefined;
  simple: boolean; remoteWithoutMemoryRoot: boolean;
  modelGateDisablesMemory: boolean;
  autoMemoryEnabled: boolean | undefined;
}
export function agentMemoryEnabled(gate: AgentMemoryGate): boolean {
  if (gate.memoryToggledOff || gate.autoMemoryOffThisSession || gate.safeMode || gate.restricted || gate.confined) return false;
  const raw = gate.disableAutoMemory?.toLowerCase().trim();
  if (raw !== undefined && ["1", "true", "yes", "on"].includes(raw)) return false;
  if (raw !== undefined && ["0", "false", "no", "off"].includes(raw)) return true;
  if (gate.simple || gate.remoteWithoutMemoryRoot || gate.modelGateDisablesMemory) return false;
  return gate.autoMemoryEnabled ?? true;
}

const sensitiveSegments = new Set([".git", "hooks", ".husky", ".githooks", "node_modules", ".vscode", ".idea", "head", "config", "objects", "refs", ".claude", "skills", "commands", "agents", ".cargo", ".devcontainer", ".yarn", ".mvn"]);
const normalizeSegment = (value: string): string => {
  const lower = value.toLowerCase().replace(/\u0131/g, "i").replace(/\u017f/g, "s");
  return lower.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "").replace(/:.*$/, "").replace(/[. ]+$/, "") || lower;
};
export interface RecognizedAgentMemoryPath { path: string; root: string; scope: AgentMemoryScope }
/** Native of/mwn is broad across agent names, lexical, and excludes reserved segments. */
export function recognizeAgentMemoryPath(path: string, roots: AgentMemoryRoots): RecognizedAgentMemoryPath | undefined {
  const value = absolute(path), cwd = absolute(roots.workingDirectory), config = absolute(roots.configurationDirectory);
  const remote = roots.remoteMemoryDirectory === undefined ? undefined : absolute(roots.remoteMemoryDirectory);
  const candidates: { root: string; scope: AgentMemoryScope }[] = [
    { root: join(remote ?? config, "agent-memory") + sep, scope: "user" },
    { root: join(cwd, ".claude", "agent-memory") + sep, scope: "project" },
  ];
  if (remote !== undefined) candidates.push({ root: join(remote, "projects") + sep, scope: "local" });
  else candidates.push({ root: join(cwd, ".claude", "agent-memory-local") + sep, scope: "local" });
  for (const candidate of candidates) {
    if (!value.startsWith(candidate.root)) continue;
    if (remote !== undefined && candidate.scope === "local" && !value.includes(sep + "agent-memory-local" + sep)) continue;
    if (value.slice(candidate.root.length).split(sep).some(part => sensitiveSegments.has(normalizeSegment(part)))) return;
    return Object.freeze({ path: value, ...candidate });
  }
}
/** Candidate only: parent deny/ask/mode/sensitive/realpath checks are separate prerequisites. */
export function agentMemoryAutomaticFileAllowance(path: string, operation: "read" | "write", roots: AgentMemoryRoots,
  floor: { confined: boolean; restricted: boolean; remoteSurface: boolean; blockOutsideReads: boolean; blockOutsideWrites: boolean }): boolean {
  if (floor.confined || floor.restricted || (operation === "read" ? floor.remoteSurface || floor.blockOutsideReads : floor.blockOutsideWrites || !path.endsWith(".md"))) return false;
  return recognizeAgentMemoryPath(path, roots) !== undefined;
}
export function agentMemoryDeclaredTools(tools: readonly string[] | undefined, memory: AgentMemoryScope | undefined, enabled: boolean): readonly string[] | undefined {
  if (!enabled || !memory || tools === undefined) return tools === undefined ? undefined : Object.freeze([...tools]);
  return Object.freeze([...tools, ...["Write", "Edit", "Read"].filter(tool => !tools.includes(tool))]);
}
export interface TruncatedAgentMemoryIndex { content: string; lineCount: number; unitCount: number; lineTruncated: boolean; unitTruncated: boolean }
/** Source p5r bounds JavaScript UTF-16 units, despite its byteCount variable name. */
export function truncateAgentMemoryIndex(text: string): TruncatedAgentMemoryIndex {
  const trimmed = text.trim(), lineCount = trimmed.split("\n").length, unitCount = trimmed.length;
  const lineTruncated = lineCount > AGENT_MEMORY_INDEX_LINES, unitTruncated = unitCount > AGENT_MEMORY_INDEX_UNITS;
  let content = lineTruncated ? trimmed.split("\n").slice(0, AGENT_MEMORY_INDEX_LINES).join("\n") : trimmed;
  if (content.length > AGENT_MEMORY_INDEX_UNITS) {
    const lastLf = content.lastIndexOf("\n", AGENT_MEMORY_INDEX_UNITS);
    content = content.slice(0, lastLf > 0 ? lastLf : AGENT_MEMORY_INDEX_UNITS);
  }
  return Object.freeze({ content, lineCount, unitCount, lineTruncated, unitTruncated });
}

export interface AgentMemoryAccess { operation: "initialize" | "prompt-read" | "read-topic" | "write-topic"; location: Readonly<AgentMemoryLocation>; path: string; canonicalPath: string | undefined; signal: AbortSignal }
export interface AgentMemoryHostOptions {
  roots: AgentMemoryRoots;
  enabled(): boolean;
  admitDefinition(definition: Readonly<LocalAgentDefinition>, signal: AbortSignal): boolean | Promise<boolean>;
  /** Resource admission for prompt reads; ordinary file-tool floors for explicit topic operations. */
  authorize(access: AgentMemoryAccess): boolean | Promise<boolean>;
  /** Optional storageV5 equivalent, only used for user scope at the normal config root. Failure/miss means empty. */
  readPrimedUserIndex?(name: string, signal: AbortSignal): Promise<string | undefined>;
  /** Must use the host's ordinary Write baseline, deny/ask/mode, sensitive-file and race checks. */
  persistFile?(access: AgentMemoryAccess & { content: string }): Promise<void>;
  /** Host read bound; native disk path instead reads first, then truncates the prompt. */
  maxReadBytes?: number;
}
export interface AgentMemoryContext {
  enabled: boolean; location: Readonly<AgentMemoryLocation>; prompt: string; readOnly: boolean;
  index?: TruncatedAgentMemoryIndex; diagnostics: readonly string[];
}
const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
async function canonicalOrMissing(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if (!missing(error)) throw error;
    // A dangling existing link is not an absent directory to be projected from
    // its parent. Native rf explicitly rejects this lstat-success case.
    try { await lstat(path.replace(/[/\\]+$/, "")); throw new Error("Existing memory path cannot be resolved"); }
    catch (probe) { if (!missing(probe)) throw probe; }
    const parent = dirname(path); if (parent === path) throw error;
    return join(await canonicalOrMissing(parent), relative(parent, path));
  }
}
export class AgentMemoryHost {
  readonly #roots: AgentMemoryRoots; readonly #limit: number;
  constructor(readonly options: AgentMemoryHostOptions) {
    this.#roots = Object.freeze({ ...options.roots }); absolute(this.#roots.workingDirectory); absolute(this.#roots.configurationDirectory);
    this.#limit = options.maxReadBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1) throw new RangeError("Invalid memory read bound");
  }
  async #location(definition: Readonly<LocalAgentDefinition>, signal: AbortSignal): Promise<AgentMemoryLocation> {
    signal.throwIfAborted();
    const { agentType, memory } = definition;
    if (!memory) throw new Error("Agent does not declare persistent memory");
    if (!(await this.options.admitDefinition(definition, signal))) throw new Error("Agent memory definition admission denied");
    return resolveAgentMemoryLocation(agentType, memory, this.#roots);
  }
  async #authorize(operation: AgentMemoryAccess["operation"], location: AgentMemoryLocation, path: string, signal: AbortSignal): Promise<AgentMemoryAccess> {
    signal.throwIfAborted();
    if (!this.options.enabled()) throw new Error("Agent memory is disabled");
    let canonicalPath: string | undefined;
    try { canonicalPath = await canonicalOrMissing(path); } catch { /* Explicit host admission receives unresolved identity. */ }
    const access: AgentMemoryAccess = Object.freeze({ operation, location, path, canonicalPath, signal });
    if (!(await this.options.authorize(access))) throw new Error(`Agent memory ${operation} admission denied`);
    signal.throwIfAborted(); if (!this.options.enabled()) throw new Error("Agent memory is disabled"); return access;
  }
  async #entryMode(location: AgentMemoryLocation): Promise<"follow" | "regular-file" | "none"> {
    if (location.scope === "user") return "follow";
    try {
      // Remote-local directories outside the working copy still require a regular leaf,
      // but native tf does not impose the working-copy folder containment branch there.
      if (beneath(location.directory, absolute(this.#roots.workingDirectory))) {
        const [canonical, cwd] = await Promise.all([canonicalOrMissing(location.directory), realpath(this.#roots.workingDirectory)]);
        if (canonical === cwd || !beneath(canonical, cwd)) return "none";
      }
      return "regular-file";
    } catch { return "none"; }
  }
  async #read(path: string, mode: "follow" | "regular-file", signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    let before;
    try { before = await lstat(path); } catch (error) { if (missing(error)) return ""; throw error; }
    if (mode === "regular-file" && !before.isFile()) throw new Error("Agent memory leaf is not a regular file");
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat(); if (!stat.isFile()) throw new Error("Agent memory entry is not a regular file");
      if (mode === "regular-file" && (before.dev !== stat.dev || before.ino !== stat.ino)) throw new Error("Agent memory entry changed while opening");
      if (stat.size > this.#limit) throw new RangeError("Agent memory exceeds host read bound");
      const buffer = Buffer.alloc(Math.min(stat.size + 1, this.#limit + 1)); let length = 0;
      while (length < buffer.length) { signal.throwIfAborted(); const chunk = await handle.read(buffer, length, buffer.length - length, null); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      if (length > this.#limit) throw new RangeError("Agent memory exceeds host read bound");
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || length !== stat.size) throw new Error("Agent memory changed while reading");
      return buffer.subarray(0, length).toString("utf8");
    } finally { await handle.close(); }
  }
  async prepare(definition: Readonly<LocalAgentDefinition>, signal: AbortSignal): Promise<AgentMemoryContext> {
    const location = await this.#location(definition, signal);
    if (!this.options.enabled()) return Object.freeze({ enabled: false, location, prompt: "", readOnly: true, diagnostics: Object.freeze(["memory-disabled"]) });
    const diagnostics: string[] = [], mode = await this.#entryMode(location); let text = "", readOnly = mode === "none";
    if (mode !== "none") {
      const normalUserRoot = location.scope === "user" && (!this.#roots.remoteMemoryDirectory || absolute(this.#roots.remoteMemoryDirectory) === absolute(this.#roots.configurationDirectory));
      const primed = normalUserRoot && this.options.readPrimedUserIndex !== undefined;
      if (!primed) {
        await this.#authorize("initialize", location, location.directory, signal);
        try { await mkdir(location.directory, { recursive: true, mode: 0o700 }); } catch { diagnostics.push("memory-directory-create-failed"); }
      }
      await this.#authorize("prompt-read", location, location.indexPath, signal);
      if (primed) {
        try { text = await this.options.readPrimedUserIndex?.(location.name, signal) ?? ""; } catch { signal.throwIfAborted(); diagnostics.push("primed-memory-read-failed"); }
        if (Buffer.byteLength(text) > this.#limit) throw new RangeError("Agent memory exceeds host read bound");
      } else {
        try { text = await this.#read(location.indexPath, mode, signal); }
        catch (error) { signal.throwIfAborted(); if (error instanceof RangeError) throw error; diagnostics.push("memory-index-read-failed");
          if (mode === "regular-file") { try { const leaf = await lstat(location.indexPath); readOnly = !leaf.isFile(); } catch { /* Native missing/read failures become empty. */ } } }
      }
    } else diagnostics.push("memory-folder-refused");
    signal.throwIfAborted();
    if (!this.options.enabled()) return Object.freeze({ enabled: false, location, prompt: "", readOnly: true, diagnostics: Object.freeze([...diagnostics, "memory-disabled-during-load"]) });
    const index = truncateAgentMemoryIndex(text);
    const scopeGuide = location.scope === "user" ? "Keep durable facts useful across projects." : location.scope === "project" ? "Keep project facts suitable for sharing in version control." : "Keep project and machine-specific notes outside version control.";
    const parts = ["Persistent agent memory", `Directory: ${location.directory}`, scopeGuide,
      "Use MEMORY.md as a short index. Read relevant topic files explicitly; their contents are not loaded automatically. Preserve useful notes and avoid secrets or temporary task state.",
      readOnly ? "This memory location could not be verified for index loading. Treat its files as read-only in this session." : "Use the host's ordinary file tools and permissions to maintain memory; this context grants no tool permission."];
    if (index.content) parts.push(`Loaded ${AGENT_MEMORY_INDEX}:`, index.content);
    else parts.push(readOnly ? "The memory index was not loaded." : "The memory index is empty.");
    if (index.lineTruncated || index.unitTruncated) parts.push(`Only part of the index was loaded (limits: ${AGENT_MEMORY_INDEX_LINES} lines, ${AGENT_MEMORY_INDEX_UNITS} UTF-16 units). Read the file explicitly for further detail.`);
    return Object.freeze({ enabled: true, location, prompt: parts.join("\n\n"), readOnly, index, diagnostics: Object.freeze(diagnostics) });
  }
  async #topic(definition: Readonly<LocalAgentDefinition>, name: string, signal: AbortSignal): Promise<{ location: AgentMemoryLocation; path: string; mode: "follow" | "regular-file" }> {
    if (!this.options.enabled()) throw new Error("Agent memory is disabled");
    const location = await this.#location(definition, signal);
    if (!name || isAbsolute(name) || name.includes("\0")) throw new TypeError("Relative memory topic path is required");
    const path = resolve(location.directory, name);
    if (!beneath(path, location.directory) || path === resolve(location.directory)) throw new Error("Memory topic leaves its scope");
    const mode = await this.#entryMode(location); if (mode === "none") throw new Error("Agent memory folder is not admitted");
    if (mode === "regular-file") {
      const canonical = await canonicalOrMissing(path), root = await canonicalOrMissing(location.directory);
      if (!beneath(canonical, root)) throw new Error("Memory topic leaves its canonical scope");
    }
    return { location, path, mode };
  }
  async readTopic(definition: Readonly<LocalAgentDefinition>, name: string, signal: AbortSignal): Promise<string> {
    const { location, path, mode } = await this.#topic(definition, name, signal);
    await this.#authorize("read-topic", location, path, signal); return this.#read(path, mode, signal);
  }
  async writeTopic(definition: Readonly<LocalAgentDefinition>, name: string, content: string, signal: AbortSignal): Promise<void> {
    if (!this.options.persistFile) throw new Error("Agent memory writes require the ordinary file-tool persistence adapter");
    const { location, path } = await this.#topic(definition, name, signal);
    const access = await this.#authorize("write-topic", location, path, signal);
    await this.options.persistFile(Object.freeze({ ...access, content })); signal.throwIfAborted();
  }
}
export const createAgentMemoryHost = (options: AgentMemoryHostOptions): AgentMemoryHost => new AgentMemoryHost(options);
