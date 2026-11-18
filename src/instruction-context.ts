import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { activeContextStart } from "./context-usage.js";
import type { InstructionCatalog, InstructionFile } from "./instructions.js";
import { modelBytesPerToken } from "./reasoning.js";
import type { ReadState } from "./read-state.js";
import type { InstructionRecord, Message, ToolExecutor } from "./types.js";

interface ProjectedInstruction { file: InstructionFile; body: string; record: InstructionRecord }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Nested per-file projection; eager warning thresholds are not admission caps. */
export function projectNestedInstruction(file: InstructionFile, contextWindow: number, model: string): ProjectedInstruction {
  const full = file.content.trim();
  const limit = Math.max(40000, Math.round(contextWindow * .05 * modelBytesPerToken(model)));
  let body = full, clipped = false;
  if (file.kind !== "Managed" && full.length > limit) {
    const newline = full.lastIndexOf("\n", limit);
    let end = newline > 0 ? newline : limit;
    if (end > 0 && /[\uD800-\uDBFF]/.test(full.charAt(end - 1))) end--;
    const prefix = full.slice(0, end);
    const offset = newline > 0 ? prefix.split("\n").length + 1 : 1;
    body = `${prefix}\n\n[Only the beginning of this instruction file is included. Read ${file.path} from line ${offset} for the continuation.]`;
    clipped = true;
  }
  return { file, body, record: { path: file.canonicalPath, kind: file.kind, contentHash: hash(body), partial: clipped || file.contentDiffersFromDisk } };
}

function previousInstructions(messages: Message[], eagerOnly = false): Map<string, InstructionRecord> {
  const result = new Map<string, InstructionRecord>();
  for (const message of messages.slice(activeContextStart(messages))) {
    const records = [...message.instructionFiles ?? [], ...eagerOnly ? [] : message.content.flatMap(block => block.type === "tool_result" ? block.instructionFiles ?? [] : [])];
    for (const record of records) {
      if (record.removed) result.delete(record.path); else result.set(record.path, record);
    }
  }
  return result;
}
const render = (files: ProjectedInstruction[]) => files.map(({ file, body }) => `Instruction file (${file.kind}): ${file.path}\n${body}`).join("\n\n");

/** Catalog admission, model-visible announcements and file-read baselines stay separate. */
export class InstructionContext {
  private initial: Set<string> | undefined;
  readonly excludedPaths: string[] = [];
  constructor(private readonly options: {
    cwd: string; catalog: InstructionCatalog; model(): string; contextWindow(): number;
    /** Built-in/policy omitClaudeMd drops initial userContext, while nested discovery remains active. */
    omitInitial?: boolean;
    onDiagnostic?(message: string): void;
  }) {}

  private report(update: Awaited<ReturnType<InstructionCatalog["loadInitial"]>>): void {
    for (const issue of [...update.diagnostics, ...update.withheld]) this.options.onDiagnostic?.(`${issue.path}: ${issue.message}`);
    for (const file of this.options.catalog.files) if (!this.excludedPaths.includes(file.canonicalPath)) this.excludedPaths.push(file.canonicalPath);
  }
  private async initialize(): Promise<void> {
    if (this.initial) return;
    this.report(await this.options.catalog.loadInitial());
    this.initial = new Set(this.options.catalog.files.map(file => file.canonicalPath));
  }
  private projection(file: InstructionFile): ProjectedInstruction {
    if (!this.initial?.has(file.canonicalPath)) return projectNestedInstruction(file, this.options.contextWindow(), this.options.model());
    const body = file.content.trim();
    return { file, body, record: { path: file.canonicalPath, kind: file.kind, contentHash: hash(body), partial: file.contentDiffersFromDisk } };
  }
  async announce(message: Message, history: Message[]): Promise<void> {
    await this.initialize();
    if (this.options.omitInitial) return;
    // Nested activation does not add a file to the eager context builder. Its
    // attachment remains in tool history and must not become an eager update.
    const previous = previousInstructions(history, true), files = this.options.catalog.files
      .filter(file => this.initial?.has(file.canonicalPath)).map(file => this.projection(file));
    const current = new Set(files.map(file => file.record.path));
    const changed = files.filter(file => {
      const prior = previous.get(file.record.path);
      return prior?.kind !== file.record.kind || prior.contentHash !== file.record.contentHash;
    });
    const removed = [...previous.values()].filter(file => !current.has(file.path)).map(file => ({ ...file, removed: true }));
    if (!changed.length && !removed.length) return;
    const notice = [changed.length ? `Current instruction files (updated copies replace earlier versions):\n\n${render(changed)}` : "",
      ...removed.map(file => `Instruction file removed from the active catalog: ${file.path}`)].filter(Boolean).join("\n\n");
    message.content.unshift({ type: "text", text: notice });
    message.instructionFiles = [...changed.map(file => file.record), ...removed];
  }

  wrap(tools: ToolExecutor, messages: Message[], state: ReadState): ToolExecutor {
    return {
      ...tools,
      get definitions() { return tools.definitions; },
      beforeModelRequest: async signal => {
        await tools.beforeModelRequest?.(signal);
        signal.throwIfAborted();
        // A new compaction boundary may have removed earlier announcements.
        const announcement: Message = { role: "user", content: [] };
        await this.announce(announcement, messages);
        if (announcement.content.length) messages.push(announcement);
      },
      execute: async (call, signal) => {
        const result = await tools.execute(call, signal);
        // Hooks may redirect an accepted tool input while the assistant's
        // original call stays intact in history. Follow the executed path.
        const input = result.effectiveToolInput ?? call.input;
        if (result.permissionDenied || result.inputRejected || result.hookStop && result.hookResponse === undefined || !["Read", "Write", "Edit"].includes(call.name) ||
            call.name !== "Read" && result.is_error || !input || typeof input !== "object" ||
            !("file_path" in input) || typeof input.file_path !== "string") return result;
        signal.throwIfAborted();
        const update = await this.options.catalog.loadForPath(resolve(this.options.cwd, input.file_path));
        this.report(update);
        const previous = previousInstructions(messages), additions: ProjectedInstruction[] = [];
        for (const file of update.files) {
          if (state.has(file.canonicalPath)) continue;
          const prior = previous.get(file.canonicalPath);
          // A full eager announcement already made this body visible. Nested
          // activation seeds that complete view, without applying a fresh cap.
          const fullBody = file.content.trim();
          const projected = prior?.kind === file.kind && prior.contentHash === hash(fullBody)
            ? { file, body: fullBody, record: { ...prior, partial: file.contentDiffersFromDisk } }
            : this.projection(file);
          if (prior?.kind !== projected.record.kind || prior.contentHash !== projected.record.contentHash) additions.push(projected);
          let timestamp: number;
          try { timestamp = (await stat(file.canonicalPath)).mtimeMs; } catch { continue; }
          signal.throwIfAborted();
          if (state.has(file.canonicalPath)) continue;
          if (projected.record.partial) state.rememberPartial(file.canonicalPath, timestamp);
          else state.remember(file.canonicalPath, Buffer.from(file.rawContent ?? file.content), timestamp);
        }
        if (!additions.length) return result;
        return { ...result, content: `${result.content}\n\nNested instruction files:\n\n${render(additions)}`,
          instructionFiles: additions.map(file => file.record) };
      },
    };
  }
}
