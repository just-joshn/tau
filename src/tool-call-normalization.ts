import { z } from "zod";
import {
  normalizeToolInput,
  normalizeToolName,
  unparsedToolInput,
} from "./tool-input.js";
import type { ToolUse } from "./types.js";

export interface ToolCallNormalizationBinding {
  /** Streamed/schema-aware repair (oq), not the execution-time coerceInput callback. */
  repair?(input: unknown): unknown;
  /** Tool-specific ingest projection (yWt), not a blanket execution schema parse. */
  normalize?(input: unknown): unknown;
}
export interface ToolCallNormalizationDiagnostic {
  toolName: string;
  stage: "repair" | "normalize";
  errorName: string;
  issueCodes?: readonly string[];
}
export interface ToolCallNormalizationOptions {
  /** Only currently known tools are normalized, matching the source's tool lookup. */
  resolveTool(name: string): ToolCallNormalizationBinding | undefined;
  onDiagnostic?(diagnostic: ToolCallNormalizationDiagnostic): void;
}

/** Normalize a completed assistant tool block before committing/emitting it.
 * A failed tool-specific stage leaves the preceding stage's input in history;
 * execution validation later turns invalid input into the ordinary tool error.
 * Incoming transport events and the caller's raw block remain unchanged. */
export function normalizeAssistantToolCall<T extends ToolUse>(
  call: T,
  options: ToolCallNormalizationOptions,
): T {
  const name = normalizeToolName(call.name);
  let input = normalizeToolInput(call.input);
  if (
    typeof input === "object" &&
    input !== null &&
    !unparsedToolInput(input)
  ) {
    const binding = options.resolveTool(name);
    if (binding)
      for (const stage of ["repair", "normalize"] as const) {
        const transform = binding[stage];
        if (!transform) continue;
        try {
          input = transform(structuredClone(input));
        } catch (error) {
          options.onDiagnostic?.({
            toolName: name,
            stage,
            errorName: error instanceof Error ? error.name : typeof error,
            ...(error instanceof z.ZodError
              ? {
                  issueCodes: [
                    ...new Set(error.issues.map((issue) => issue.code)),
                  ],
                }
              : {}),
          });
          // q3n has one try around oq followed by yWt; repair failure skips normalization.
          break;
        }
      }
  }
  return { ...call, name, input };
}

function isToolUseBlock<T>(block: T): block is T & ToolUse {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "tool_use" &&
    "id" in block &&
    typeof block.id === "string" &&
    "name" in block &&
    typeof block.name === "string"
  );
}

export function normalizeAssistantToolBlocks<T>(
  content: readonly T[],
  options: ToolCallNormalizationOptions,
): T[] {
  return content.map((block) =>
    isToolUseBlock(block) ? normalizeAssistantToolCall(block, options) : block,
  );
}

/** Execution/hook ownership boundary; do not write repaired hook inputs back into the committed call. */
export function toolCallForExecution<T extends ToolUse>(committed: T): T {
  return { ...committed, input: structuredClone(committed.input) };
}

export interface IngestEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}
const ingestEditSchema = z.strictObject({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .default(false)
    .optional(),
});

/** The standalone Read branch only coerces an already present decimal offset; no default is inserted. */
export function normalizeReadCallInput(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const offset = "offset" in input ? input.offset : undefined;
  if (typeof offset !== "string" || !/^[-+]?\d+(\.\d+)?$/.test(offset.trim()))
    return input;
  const value = Number(offset.trim());
  return Number.isFinite(value) ? { ...input, offset: value } : input;
}

/** Native Edit ingest schema/aliases/projection, separated from source zNo filesystem-dependent normalization.
 * The host can supply zNo-equivalent file/old/new harmonization; omission preserves the parsed strings.
 * Unknown reserved/internal fields require their own host schema and are deliberately not silently dropped. */
export function normalizeEditCallInput(
  input: unknown,
  transform?: (input: Readonly<IngestEditInput>) => IngestEditInput,
): IngestEditInput {
  const aliases: Record<string, unknown> = {
    ...(input !== null && typeof input === "object" ? input : undefined),
  };
  for (const [alias, canonical] of [
    ["old_str", "old_string"],
    ["new_str", "new_string"],
  ] as const)
    if (alias in aliases) {
      if (!(canonical in aliases)) aliases[canonical] = aliases[alias];
      delete aliases[alias];
    }
  const parsed = ingestEditSchema.parse(aliases);
  const fields: IngestEditInput = {
    file_path: parsed.file_path,
    old_string: parsed.old_string,
    new_string: parsed.new_string,
    replace_all: parsed.replace_all ?? false,
  };
  const selected = transform?.(fields) ?? fields;
  // The source returns this projection, including replace_all even when the model omitted it.
  return {
    replace_all: selected.replace_all,
    file_path: selected.file_path,
    old_string: selected.old_string,
    new_string: selected.new_string,
  };
}

/** Only the directly supported pure branches. Bash/Write and other tools require their own source-backed binding. */
export function pureToolCallNormalizationBinding(
  name: string,
  options: {
    editTransform?: (input: Readonly<IngestEditInput>) => IngestEditInput;
  } = {},
): ToolCallNormalizationBinding | undefined {
  if (name === "Read") return { normalize: normalizeReadCallInput };
  if (name === "Edit")
    return {
      normalize: (input) =>
        normalizeEditCallInput(input, options.editTransform),
    };
  return;
}
