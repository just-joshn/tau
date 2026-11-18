import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiToolContent } from "./types.js";

/** The original's Cq notebook size bound. */
export const MAX_NOTEBOOK_BYTES = 104857600;
const MAX_OUTPUT_CHARS = 30000;
const LARGE_OUTPUTS_CHARS = 10000;

export const notebookEditInputSchema = z.strictObject({
  notebook_path: z
    .string()
    .describe(
      "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)",
    ),
  cell_id: z
    .string()
    .optional()
    .describe(
      "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.",
    ),
  new_source: z.string().describe("The new source for the cell"),
  cell_type: z
    .enum(["code", "markdown"])
    .optional()
    .describe(
      "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.",
    ),
  edit_mode: z
    .enum(["replace", "insert", "delete"])
    .optional()
    .describe(
      "The type of edit to make (replace, insert, delete). Defaults to replace.",
    ),
});
export type NotebookEditInput = z.infer<typeof notebookEditInputSchema>;

export const NOTEBOOK_EDIT_DESCRIPTION = `Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).

Usage:
- You must use the Read tool on the notebook in this conversation before editing — this tool will fail otherwise.
- \`notebook_path\` must be an absolute path.
- \`cell_id\` is the \`id\` attribute shown in the Read tool's \`<cell id="...">\` output. It is required for \`replace\` and \`delete\`.
- \`edit_mode\` defaults to \`replace\`. Use \`insert\` to add a new cell after the cell with the given \`cell_id\` (or at the beginning of the notebook if \`cell_id\` is omitted) — \`cell_type\` is required when inserting. Use \`delete\` to remove the cell.`;

const INVALID_SHAPE =
  'Notebook file is not a valid Jupyter notebook (top-level "cells" must be an array of cell objects, each with a string or string-array "source").';

interface Output {
  output_type: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface Cell {
  cell_type: string;
  id?: string | undefined;
  source: string | string[];
  metadata?: unknown;
  execution_count?: number | null;
  outputs?: Output[];
}
interface Notebook {
  cells: Cell[];
  metadata?: { language_info?: { name?: string } };
  nbformat?: number;
  nbformat_minor?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSource = (value: unknown): value is string | string[] =>
  typeof value === "string" ||
  (Array.isArray(value) &&
    value.every((line: unknown) => typeof line === "string"));
/** Pkt: only the cells array and each cell's source are checked. */
function isNotebook(value: unknown): value is Notebook {
  return (
    isRecord(value) &&
    Array.isArray(value.cells) &&
    value.cells.every(
      (cell: unknown) => isRecord(cell) && isSource(cell.source),
    )
  );
}
/** `text` is the file content without a BOM. */
export function parseNotebook(text: string, invalidJson: string): Notebook {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(invalidJson);
  }
  if (!isNotebook(value)) throw new Error(INVALID_SHAPE);
  return value;
}
const joined = (source: string | string[]) =>
  Array.isArray(source) ? source.join("") : source;

/** Wun: a cell id, or the `cell-N` index form Read prints for id-less cells. */
function targetCell(
  cells: readonly Cell[],
  cellId: string | undefined,
): { index: number; cell: Cell } {
  if (!cellId)
    throw new Error("Cell ID must be specified when not inserting a new cell.");
  const index = cells.findIndex((cell) => cell.id === cellId);
  const byId = cells[index];
  if (byId) return { index, cell: byId };
  const numbered = /^cell-(\d+)$/.exec(cellId)?.[1];
  if (numbered === undefined)
    throw new Error(`Cell with ID "${cellId}" not found in notebook.`);
  const position = parseInt(numbered, 10);
  const cell = cells[position];
  if (!cell)
    throw new Error(`Cell with index ${position} does not exist in notebook.`);
  return { index: position, cell };
}

export interface NotebookEditResult {
  /** Reserialized notebook, line endings matching the original file. */
  updated: string;
  message: string;
  hookResponse: Record<string, unknown>;
}
export function applyNotebookEdit(
  original: string,
  input: NotebookEditInput,
  notebookPath: string,
): NotebookEditResult {
  const mode = input.edit_mode ?? "replace";
  const notebook = parseNotebook(original, "Notebook is not valid JSON.");
  let cellId = input.cell_id;
  let oldSource: string | undefined;
  if (mode === "delete") {
    const { index, cell } = targetCell(notebook.cells, input.cell_id);
    oldSource = joined(cell.source);
    notebook.cells.splice(index, 1);
  } else if (mode === "insert") {
    const index = input.cell_id
      ? targetCell(notebook.cells, input.cell_id).index + 1
      : 0;
    cellId =
      (notebook.nbformat ?? 0) > 4 ||
      (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5)
        ? randomUUID().slice(0, 8)
        : undefined;
    notebook.cells.splice(
      index,
      0,
      input.cell_type === "markdown"
        ? {
            cell_type: "markdown",
            id: cellId,
            source: input.new_source,
            metadata: {},
          }
        : {
            cell_type: "code",
            id: cellId,
            source: input.new_source,
            metadata: {},
            execution_count: null,
            outputs: [],
          },
    );
  } else {
    const { cell } = targetCell(notebook.cells, input.cell_id);
    oldSource = joined(cell.source);
    cell.source = input.new_source;
    if (cell.cell_type === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    }
    if (input.cell_type && input.cell_type !== cell.cell_type)
      cell.cell_type = input.cell_type;
  }
  const serialized = JSON.stringify(notebook, null, 1);
  const updated = original.includes("\r\n")
    ? serialized.replace(/\n/g, "\r\n")
    : serialized;
  const message =
    mode === "replace"
      ? `Updated cell ${input.cell_id} with ${input.new_source}`
      : mode === "insert"
        ? `Inserted ${cellId ? `cell ${cellId}` : "a new cell"} with ${input.new_source}`
        : `Deleted cell ${input.cell_id}`;
  return {
    updated,
    message,
    hookResponse: {
      new_source: input.new_source,
      ...(oldSource === undefined ? {} : { old_source: oldSource }),
      cell_type: input.cell_type ?? "code",
      language: notebook.metadata?.language_info?.name ?? "python",
      edit_mode: mode,
      ...(cellId ? { cell_id: cellId } : {}),
      error: "",
      notebook_path: notebookPath,
      original_file: original,
      updated_file: updated,
    },
  };
}

function truncated(text: unknown): string {
  if (!isSource(text)) return "";
  const value = joined(text);
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  const hidden = value.slice(MAX_OUTPUT_CHARS).split("\n").length;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n... [${hidden} lines truncated] ...`;
}
function image(data: Record<string, unknown> | undefined) {
  for (const mediaType of ["image/png", "image/jpeg"] as const) {
    const value = data?.[mediaType];
    if (typeof value === "string")
      return { data: value.replace(/\s/g, ""), mediaType };
  }
  return undefined;
}
function renderOutput(output: Output): {
  text: string;
  image?: { data: string; mediaType: "image/png" | "image/jpeg" };
} {
  switch (output.output_type) {
    case "stream":
      return { text: truncated(output.text) };
    case "execute_result":
    case "display_data": {
      const found = image(output.data);
      return {
        text: truncated(output.data?.["text/plain"]),
        ...(found ? { image: found } : {}),
      };
    }
    case "error":
      return {
        text: truncated(
          `${output.ename}: ${output.evalue}\n${(output.traceback ?? []).join("\n")}`,
        ),
      };
    default:
      return { text: "" };
  }
}

/** Read's .ipynb projection: one `<cell id>` text per cell, outputs after, adjacent texts merged. */
export function renderNotebook(text: string): ApiToolContent[] {
  const notebook = parseNotebook(
    text,
    "Notebook file is not valid JSON (it may be truncated, corrupted, or still being written)",
  );
  const language = notebook.metadata?.language_info?.name ?? "python";
  const blocks: ApiToolContent[] = [];
  const push = (block: ApiToolContent) => {
    const last = blocks.at(-1);
    if (last?.type === "text" && block.type === "text")
      last.text += `\n${block.text}`;
    else blocks.push(block);
  };
  notebook.cells.forEach((cell, index) => {
    const id = cell.id ?? `cell-${index}`;
    const tags =
      cell.cell_type !== "code"
        ? `<cell_type>${cell.cell_type}</cell_type>`
        : language !== "python"
          ? `<language>${language}</language>`
          : "";
    push({
      type: "text",
      text: `<cell id="${id}">${tags}${joined(cell.source)}</cell id="${id}">`,
    });
    if (cell.cell_type !== "code" || !cell.outputs?.length) return;
    let outputs = cell.outputs.map(renderOutput);
    let size = 0;
    for (const output of outputs)
      size += output.text.length + (output.image?.data.length ?? 0);
    if (size > LARGE_OUTPUTS_CHARS)
      outputs = [
        {
          text: `Outputs are too large to include. Use Bash with: cat <notebook_path> | jq '.cells[${index}].outputs'`,
        },
      ];
    for (const output of outputs) {
      if (output.text) push({ type: "text", text: `\n${output.text}` });
      if (output.image)
        push({
          type: "image",
          source: {
            type: "base64",
            media_type: output.image.mediaType,
            data: output.image.data,
          },
        });
    }
  });
  return blocks;
}
