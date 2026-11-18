import type { PermissionDialog } from "../permission-dialog.js";
import type { PermissionMode } from "../types.js";

/** The welcome header's facts: product, version, model, billing and workspace. */
export interface Welcome {
  product: string;
  version: string;
  model: string;
  billing?: string;
  cwd: string;
}

/** One row of a structured patch, numbered in the file it belongs to. */
export interface PatchLine {
  kind: "context" | "removed" | "added";
  number: number;
  text: string;
}

export type ToolStatus = "pending" | "done" | "error" | "rejected";

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  /** Consecutive Read/Grep/Glob calls collapse into one counted row. */
  | { kind: "explore"; ids: readonly string[]; reads: number; searches: number }
  | {
      kind: "tool";
      id: string;
      label: string;
      target: string;
      status: ToolStatus;
      summary?: string;
      detail: readonly string[];
      patch?: readonly PatchLine[];
    }
  /** A slash command's echo and its result rows. */
  | {
      kind: "command";
      input: string;
      output: readonly string[];
      tone: "info" | "error";
    }
  | { kind: "notice"; text: string; tone: "info" | "error" }
  | { kind: "done"; verb: string; elapsed: string; at: string }
  | { kind: "interrupted" };

export interface CommandEntry {
  name: string;
  description: string;
}

export interface ModelChoice {
  label: string;
  description: string;
  model: string;
  current: boolean;
}

export type HelpTab = "general" | "commands" | "custom";
export const HELP_TABS: readonly HelpTab[] = ["general", "commands", "custom"];

export type StatusTab = "status" | "usage";
export const STATUS_TABS: readonly StatusTab[] = ["status", "usage"];

export type Field = readonly [label: string, value: string];

/** What owns the bottom of the screen. */
export type View =
  | { kind: "prompt" }
  | {
      kind: "permission";
      dialog: PermissionDialog;
      /** The tool header; a plain confirmation has none. */
      title?: string;
      patch?: readonly PatchLine[];
      focus: number;
      /** Feedback typed after Tab, sent with a refusal. */
      amend?: string | undefined;
    }
  | { kind: "help"; tab: HelpTab; custom: readonly CommandEntry[] }
  | {
      kind: "status";
      tab: StatusTab;
      fields: Readonly<Record<StatusTab, readonly Field[]>>;
    }
  | { kind: "model"; choices: readonly ModelChoice[]; focus: number };

export interface Busy {
  verb: string;
  startedAt: number;
  frame: number;
}

export interface Editor {
  text: string;
  cursor: number;
}

export interface AppState {
  welcome: Welcome;
  items: readonly TranscriptItem[];
  editor: Editor;
  mode: PermissionMode;
  bypassAvailable: boolean;
  view: View;
  busy?: Busy | undefined;
  commands: readonly CommandEntry[];
  /** Highlighted row of the slash-command suggestions. */
  suggestion: number;
  /** A first Ctrl-C or Ctrl-D waiting for its second press. */
  exitArmed?: { key: "Ctrl-C" | "Ctrl-D"; at: number } | undefined;
  escapeArmedAt?: number | undefined;
  shortcuts: boolean;
  history: readonly string[];
  historyIndex?: number | undefined;
}

export function initialState(
  welcome: Welcome,
  options: {
    mode: PermissionMode;
    bypassAvailable: boolean;
    commands: readonly CommandEntry[];
  },
): AppState {
  return {
    welcome,
    items: [],
    editor: { text: "", cursor: 0 },
    mode: options.mode,
    bypassAvailable: options.bypassAvailable,
    view: { kind: "prompt" },
    commands: options.commands,
    suggestion: 0,
    shortcuts: false,
    history: [],
  };
}

/** The original's shift+tab cycle: default → acceptEdits → plan → bypass (when launched with it) → default. */
export function nextMode(
  mode: PermissionMode,
  bypassAvailable: boolean,
): PermissionMode {
  switch (mode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return bypassAvailable ? "bypassPermissions" : "default";
    case "bypassPermissions":
      return "default";
  }
}

/** Slash commands whose names match what is typed so far, best first; at most five. */
export function suggestions(state: AppState): readonly CommandEntry[] {
  const match = /^\/(\S*)$/.exec(state.editor.text);
  if (match === null || state.view.kind !== "prompt") return [];
  const typed = (match[1] ?? "").toLowerCase();
  const rank = (entry: CommandEntry) => {
    const name = entry.name.toLowerCase();
    if (name.startsWith(typed)) return 0;
    if (name.includes(typed)) return 1;
    return entry.description.toLowerCase().includes(typed) ? 2 : 3;
  };
  return state.commands
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .filter((candidate) => candidate.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, 5)
    .map((candidate) => candidate.entry);
}
