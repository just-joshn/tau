import { isAbsolute, relative } from "node:path";
import type { ToolResult, ToolUse } from "../types.js";
import type { PatchLine, TranscriptItem } from "./state.js";

const CONTEXT = 3;

/** One hunk between two texts: changed lines with up to three context rows each side. */
export function patchLines(before: string, after: string): PatchLine[] {
  const old = before.split("\n");
  const next = after.split("\n");
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head])
    head++;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const removed = old.slice(head, old.length - tail);
  const added = next.slice(head, next.length - tail);
  if (!removed.length && !added.length) return [];
  const start = Math.max(0, head - CONTEXT);
  const lines: PatchLine[] = old.slice(start, head).map((text, index) => ({
    kind: "context",
    number: start + index + 1,
    text,
  }));
  removed.forEach((text, index) =>
    lines.push({ kind: "removed", number: head + index + 1, text }),
  );
  added.forEach((text, index) =>
    lines.push({ kind: "added", number: head + index + 1, text }),
  );
  const afterStart = next.length - tail;
  next
    .slice(afterStart, Math.min(next.length, afterStart + CONTEXT))
    .forEach((text, index) => {
      if (afterStart + index === next.length - 1 && text === "") return;
      lines.push({ kind: "context", number: afterStart + index + 1, text });
    });
  return lines;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function shown(path: string, cwd: string): string {
  const local = relative(cwd, path);
  return local && !local.startsWith("..") && !isAbsolute(local) ? local : path;
}

const LABELS: Readonly<Record<string, string>> = {
  Edit: "Update",
  MultiEdit: "Update",
  WebFetch: "Fetch",
  WebSearch: "Web Search",
};

const READS = new Set(["Read", "NotebookRead"]);
const SEARCHES = new Set(["Grep", "Glob"]);

/** The file text an Edit or Write call would leave, when it can be computed. */
function proposed(
  call: ToolUse,
  current: string | undefined,
): string | undefined {
  const input = record(call.input);
  if (call.name === "Write") return text(input.content);
  if (call.name !== "Edit" || current === undefined) return undefined;
  const oldString = text(input.old_string);
  const newString = text(input.new_string);
  if (oldString === undefined || newString === undefined) return undefined;
  if (oldString === "") return newString;
  return input.replace_all === true
    ? current.split(oldString).join(newString)
    : current.replace(oldString, () => newString);
}

/**
 * The transcript row a starting tool call adds, or the explore row it extends.
 * `read` returns a file's current text so Edit and Write can show their patch.
 */
export function startTool(
  items: readonly TranscriptItem[],
  call: ToolUse,
  cwd: string,
  read: (path: string) => string | undefined,
): TranscriptItem[] {
  const last = items.at(-1);
  if (READS.has(call.name) || SEARCHES.has(call.name)) {
    const reads = READS.has(call.name) ? 1 : 0;
    if (last?.kind === "explore")
      return [
        ...items.slice(0, -1),
        {
          ...last,
          ids: [...last.ids, call.id],
          reads: last.reads + reads,
          searches: last.searches + 1 - reads,
        },
      ];
    return [
      ...items,
      { kind: "explore", ids: [call.id], reads, searches: 1 - reads },
    ];
  }
  const input = record(call.input);
  const path = text(input.file_path) ?? text(input.notebook_path);
  const target =
    path !== undefined
      ? shown(path, cwd)
      : (text(input.command) ??
        text(input.url) ??
        text(input.query) ??
        text(input.pattern) ??
        text(input.description) ??
        "");
  const current = path === undefined ? undefined : read(path);
  const after = proposed(call, current);
  return [
    ...items,
    {
      kind: "tool",
      id: call.id,
      label: LABELS[call.name] ?? call.name,
      target: target.split("\n")[0] ?? "",
      status: "pending",
      detail: [],
      ...(after === undefined
        ? {}
        : { patch: patchLines(current ?? "", after) }),
    },
  ];
}

const FILE_VERBS: Readonly<Record<string, string>> = {
  Update: "update",
  Write: "write",
  NotebookEdit: "edit",
};

const REJECTED = "The user doesn't want to proceed with this tool use.";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

function changeSummary(patch: readonly PatchLine[]): string {
  const added = patch.filter((row) => row.kind === "added").length;
  const removed = patch.filter((row) => row.kind === "removed").length;
  if (added && removed)
    return `Added ${plural(added, "line")}, removed ${plural(removed, "line")}`;
  return added
    ? `Added ${plural(added, "line")}`
    : `Removed ${plural(removed, "line")}`;
}

const PREVIEW_ROWS = 3;

/** Applies a finished call's result to its row; explore rows only count. */
export function finishTool(
  items: readonly TranscriptItem[],
  result: ToolResult,
): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind !== "tool" || item.id !== result.tool_use_id) return item;
    if (result.content.startsWith(REJECTED))
      return {
        ...item,
        status: "rejected",
        summary: FILE_VERBS[item.label]
          ? `Rejected ${FILE_VERBS[item.label]} to ${item.target}`
          : "Rejected",
      };
    const rows = result.content.replace(/\n+$/, "").split("\n");
    if (result.is_error)
      return {
        ...item,
        status: "error",
        summary: rows[0] ?? "Error",
        detail: rows.slice(1, PREVIEW_ROWS),
      };
    if (item.patch !== undefined) {
      const summary =
        item.label === "Write" &&
        item.patch.every((row) => row.kind === "added")
          ? `Wrote ${plural(item.patch.length, "line")} to ${item.target}`
          : changeSummary(item.patch);
      return { ...item, status: "done", summary };
    }
    const preview = rows.slice(0, PREVIEW_ROWS);
    const hidden = rows.length - preview.length;
    return {
      ...item,
      status: "done",
      summary: preview[0] || "(No content)",
      detail: [
        ...preview.slice(1),
        ...(hidden > 0 ? [`… +${plural(hidden, "line")}`] : []),
      ],
    };
  });
}
