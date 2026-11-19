import type { PermissionChoice } from "../permission-dialog.js";
import type { PermissionMode } from "../types.js";
import type { Key } from "./keys.js";
import {
  HELP_TABS,
  STATUS_TABS,
  nextMode,
  suggestions,
  type AppState,
  type Editor,
  type View,
} from "./state.js";

/** What a key asks the host to do beyond redrawing. */
export type Effect =
  | { kind: "submit"; text: string }
  | { kind: "interrupt" }
  | { kind: "exit" }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "permission"; choice: PermissionChoice }
  /** The model picker closed: a model to switch to, or undefined to keep the current one. */
  | { kind: "model"; model?: string }
  | { kind: "dismiss" };

export interface Update {
  state: AppState;
  effects: Effect[];
}

/** The original's window for a second Ctrl-C (and Esc) press. */
export const DOUBLE_PRESS_MS = 800;

const done = (state: AppState, ...effects: Effect[]): Update => ({
  state,
  effects,
});

function insert(editor: Editor, text: string): Editor {
  return {
    text:
      editor.text.slice(0, editor.cursor) +
      text +
      editor.text.slice(editor.cursor),
    cursor: editor.cursor + text.length,
  };
}

const EMPTY: Editor = { text: "", cursor: 0 };

/** Plain line-editing keys; undefined when the key is not an edit. */
function edit(editor: Editor, key: Key): Editor | undefined {
  const { text, cursor } = editor;
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = text.indexOf("\n", cursor);
  const end = lineEnd < 0 ? text.length : lineEnd;
  switch (key.kind) {
    case "text":
    case "paste":
      return insert(editor, key.text);
    case "newline":
      return insert(editor, "\n");
    case "backspace":
      return cursor === 0
        ? editor
        : {
            text: text.slice(0, cursor - 1) + text.slice(cursor),
            cursor: cursor - 1,
          };
    case "delete":
      return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case "left":
      return { text, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { text, cursor: Math.min(text.length, cursor + 1) };
    case "home":
      return { text, cursor: lineStart };
    case "end":
      return { text, cursor: end };
    case "ctrl-k":
      return { text: text.slice(0, cursor) + text.slice(end), cursor };
    case "ctrl-u":
      return {
        text: text.slice(0, lineStart) + text.slice(cursor),
        cursor: lineStart,
      };
    case "ctrl-w": {
      const start = text.slice(0, cursor).replace(/\S+\s*$/, "").length;
      return { text: text.slice(0, start) + text.slice(cursor), cursor: start };
    }
    default:
      return undefined;
  }
}

function cycle<T>(values: readonly T[], current: T, step: number): T {
  const index = values.indexOf(current);
  return values[(index + step + values.length) % values.length] ?? current;
}

function prompt(state: AppState, key: Key, now: number): Update {
  const quiet = { ...state, exitArmed: undefined, shortcuts: false };
  const matches = suggestions(state);
  switch (key.kind) {
    case "ctrl-c":
      if (state.busy) return done(quiet, { kind: "interrupt" });
      if (
        state.exitArmed?.key === "Ctrl-C" &&
        now - state.exitArmed.at <= DOUBLE_PRESS_MS
      )
        return done(state, { kind: "exit" });
      return done({
        ...quiet,
        editor: EMPTY,
        exitArmed: { key: "Ctrl-C", at: now },
      });
    case "ctrl-d":
      if (state.editor.text) break;
      if (
        state.exitArmed?.key === "Ctrl-D" &&
        now - state.exitArmed.at <= DOUBLE_PRESS_MS
      )
        return done(state, { kind: "exit" });
      return done({ ...quiet, exitArmed: { key: "Ctrl-D", at: now } });
    case "escape":
      if (state.busy) return done(quiet, { kind: "interrupt" });
      if (state.shortcuts || !state.editor.text) return done(quiet);
      if (
        state.escapeArmedAt !== undefined &&
        now - state.escapeArmedAt <= DOUBLE_PRESS_MS
      )
        return done({ ...quiet, editor: EMPTY, escapeArmedAt: undefined });
      return done({ ...quiet, escapeArmedAt: now });
    case "shift-tab": {
      const mode = nextMode(state.mode, state.bypassAvailable);
      return done({ ...quiet, mode }, { kind: "mode", mode });
    }
    case "text":
      if (key.text === "?" && !state.editor.text)
        return done({ ...quiet, shortcuts: !state.shortcuts });
      break;
    case "tab": {
      const chosen = matches[state.suggestion];
      if (chosen === undefined) return done(state);
      const text = `/${chosen.name} `;
      return done({ ...quiet, editor: { text, cursor: text.length } });
    }
    case "up":
    case "down": {
      const step = key.kind === "up" ? -1 : 1;
      if (matches.length)
        return done({
          ...quiet,
          suggestion:
            (state.suggestion + step + matches.length) % matches.length,
        });
      if (state.editor.text.includes("\n")) break;
      const index = Math.min(
        state.history.length,
        Math.max(0, (state.historyIndex ?? state.history.length) + step),
      );
      const text = state.history[index] ?? "";
      return done({
        ...quiet,
        historyIndex: index,
        editor: { text, cursor: text.length },
      });
    }
    case "enter": {
      const { text, cursor } = state.editor;
      if (text.slice(0, cursor).endsWith("\\"))
        return done({
          ...quiet,
          editor: insert(
            {
              text: text.slice(0, cursor - 1) + text.slice(cursor),
              cursor: cursor - 1,
            },
            "\n",
          ),
        });
      const chosen = matches[state.suggestion];
      const submitted = chosen ? `/${chosen.name}` : text.trim();
      if (!submitted) return done(quiet);
      return done(
        {
          ...quiet,
          editor: EMPTY,
          suggestion: 0,
          history: [...state.history, submitted],
          historyIndex: undefined,
        },
        { kind: "submit", text: submitted },
      );
    }
    default:
      break;
  }
  const editor = edit(state.editor, key);
  if (editor === undefined) return done(state);
  return done({ ...quiet, editor, suggestion: 0, escapeArmedAt: undefined });
}

function permission(
  state: AppState,
  view: Extract<View, { kind: "permission" }>,
  key: Key,
): Update {
  const options = view.dialog.options;
  const answer = (choice: PermissionChoice) =>
    done(
      { ...state, view: { kind: "prompt" } },
      { kind: "permission", choice },
    );
  if (view.amend !== undefined) {
    if (key.kind === "enter") {
      const feedback = view.amend.trim();
      return answer(
        feedback ? { kind: "reject", feedback } : { kind: "reject" },
      );
    }
    if (key.kind === "escape" || key.kind === "tab")
      return done({ ...state, view: { ...view, amend: undefined } });
    if (key.kind === "ctrl-c") return answer({ kind: "reject" });
    const next = edit(
      { text: view.amend, cursor: view.amend.length },
      key.kind === "newline" ? { kind: "text", text: " " } : key,
    );
    return next === undefined
      ? done(state)
      : done({ ...state, view: { ...view, amend: next.text } });
  }
  switch (key.kind) {
    case "text": {
      const picked = /^[1-9]$/.test(key.text)
        ? options[Number(key.text) - 1]
        : undefined;
      return picked ? answer(picked.choice) : done(state);
    }
    case "enter": {
      const focused = options[view.focus];
      return focused ? answer(focused.choice) : done(state);
    }
    case "escape":
    case "ctrl-c":
      return answer({ kind: "reject" });
    case "shift-tab": {
      const session = options.find(
        (option) => option.choice.kind === "accept-session",
      );
      return session ? answer(session.choice) : done(state);
    }
    case "tab":
      return done({ ...state, view: { ...view, amend: "" } });
    case "up":
    case "down":
      return done({
        ...state,
        view: {
          ...view,
          focus:
            (view.focus + (key.kind === "up" ? -1 : 1) + options.length) %
            options.length,
        },
      });
    default:
      return done(state);
  }
}

function pane(state: AppState, view: View, key: Key): Update {
  const close = (effect: Effect) =>
    done({ ...state, view: { kind: "prompt" } }, effect);
  const step =
    key.kind === "left" || key.kind === "shift-tab"
      ? -1
      : key.kind === "right" || key.kind === "tab"
        ? 1
        : 0;
  switch (view.kind) {
    case "help":
      if (key.kind === "escape" || key.kind === "ctrl-c")
        return close({ kind: "dismiss" });
      return step
        ? done({
            ...state,
            view: { ...view, tab: cycle(HELP_TABS, view.tab, step) },
          })
        : done(state);
    case "status":
      if (
        key.kind === "escape" ||
        key.kind === "ctrl-c" ||
        key.kind === "enter"
      )
        return close({ kind: "dismiss" });
      return step
        ? done({
            ...state,
            view: { ...view, tab: cycle(STATUS_TABS, view.tab, step) },
          })
        : done(state);
    case "model": {
      if (key.kind === "escape" || key.kind === "ctrl-c")
        return close({ kind: "model" });
      const picked =
        key.kind === "text" && /^[1-9]$/.test(key.text)
          ? view.choices[Number(key.text) - 1]
          : key.kind === "enter"
            ? view.choices[view.focus]
            : undefined;
      if (picked) return close({ kind: "model", model: picked.model });
      if (key.kind !== "up" && key.kind !== "down") return done(state);
      const count = view.choices.length;
      return done({
        ...state,
        view: {
          ...view,
          focus: (view.focus + (key.kind === "up" ? -1 : 1) + count) % count,
        },
      });
    }
    default:
      return done(state);
  }
}

/** Applies one key to the state; pure apart from the clock reading passed in. */
export function update(state: AppState, key: Key, now: number): Update {
  const view = state.view;
  switch (view.kind) {
    case "prompt":
      return prompt(state, key, now);
    case "permission":
      return permission(state, view, key);
    default:
      return pane(state, view, key);
  }
}
