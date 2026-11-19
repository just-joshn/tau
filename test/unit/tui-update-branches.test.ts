import { expect, test } from "bun:test";
import type { PermissionDialog } from "../../src/permission-dialog.js";
import type { Key } from "../../src/tui/keys.js";
import { initialState, type AppState, type View } from "../../src/tui/state.js";
import { DOUBLE_PRESS_MS, update } from "../../src/tui/update.js";

const base = (bypass = false): AppState =>
  initialState(
    { product: "tau", version: "0", model: "m", cwd: "/w" },
    {
      mode: "default",
      bypassAvailable: bypass,
      commands: [
        { name: "help", description: "Show help" },
        { name: "model", description: "Set the model" },
      ],
    },
  );
const k = (kind: Key["kind"], text = ""): Key =>
  kind === "text" || kind === "paste" ? { kind, text } : { kind };
const withText = (text: string, cursor = text.length): AppState => ({
  ...base(),
  editor: { text, cursor },
});

test("Ctrl-C: interrupts when busy, arms, then exits inside the window only", () => {
  const busy = { ...base(), busy: { verb: "v", startedAt: 0, frame: 0 } };
  expect(update(busy, k("ctrl-c"), 0).effects).toEqual([{ kind: "interrupt" }]);
  const armed = update(withText("abc"), k("ctrl-c"), 100);
  expect(armed.state.editor.text).toBe("");
  expect(armed.state.exitArmed).toEqual({ key: "Ctrl-C", at: 100 });
  expect(
    update(armed.state, k("ctrl-c"), 100 + DOUBLE_PRESS_MS).effects,
  ).toEqual([{ kind: "exit" }]);
  const late = update(armed.state, k("ctrl-c"), 101 + DOUBLE_PRESS_MS);
  expect(late.effects).toEqual([]);
  expect(late.state.exitArmed?.at).toBe(101 + DOUBLE_PRESS_MS);
  const wrongKey = update(
    { ...base(), exitArmed: { key: "Ctrl-D", at: 100 } },
    k("ctrl-c"),
    101,
  );
  expect(wrongKey.effects).toEqual([]);
});

test("Ctrl-D exits on an empty box twice, and edits otherwise", () => {
  const first = update(base(), k("ctrl-d"), 0);
  expect(first.state.exitArmed).toEqual({ key: "Ctrl-D", at: 0 });
  expect(update(first.state, k("ctrl-d"), 10).effects).toEqual([
    { kind: "exit" },
  ]);
  const stale = update(first.state, k("ctrl-d"), DOUBLE_PRESS_MS + 1);
  expect(stale.effects).toEqual([]);
  const wrongKey = update(
    { ...base(), exitArmed: { key: "Ctrl-C", at: 0 } },
    k("ctrl-d"),
    1,
  );
  expect(wrongKey.effects).toEqual([]);
  expect(update(withText("x"), k("ctrl-d"), 0)).toMatchObject({ effects: [] });
  expect(update(withText("x"), k("ctrl-d"), 0).state.editor.text).toBe("x");
});

test("Escape interrupts, clears shortcuts, arms, then clears the box", () => {
  const busy = { ...base(), busy: { verb: "v", startedAt: 0, frame: 0 } };
  expect(update(busy, k("escape"), 0).effects).toEqual([{ kind: "interrupt" }]);
  expect(update(base(), k("escape"), 0).state.editor.text).toBe("");
  const shortcuts = { ...withText("abc"), shortcuts: true };
  expect(update(shortcuts, k("escape"), 0).state.shortcuts).toBe(false);
  expect(update(shortcuts, k("escape"), 0).state.editor.text).toBe("abc");
  const armed = update(withText("abc"), k("escape"), 50).state;
  expect(armed.escapeArmedAt).toBe(50);
  const cleared = update(armed, k("escape"), 60).state;
  expect(cleared.editor.text).toBe("");
  expect(cleared.escapeArmedAt).toBeUndefined();
  const late = update(armed, k("escape"), 50 + DOUBLE_PRESS_MS + 1).state;
  expect(late.editor.text).toBe("abc");
  expect(late.escapeArmedAt).toBe(50 + DOUBLE_PRESS_MS + 1);
});

test("shift-tab cycles modes, including bypass when available", () => {
  const a = update(base(true), k("shift-tab"), 0);
  expect(a.effects).toEqual([{ kind: "mode", mode: "acceptEdits" }]);
  const plan = { ...base(true), mode: "plan" as const };
  expect(update(plan, k("shift-tab"), 0).effects).toEqual([
    { kind: "mode", mode: "bypassPermissions" },
  ]);
});

test("'?' toggles shortcuts on an empty box and types otherwise", () => {
  const on = update(base(), k("text", "?"), 0).state;
  expect(on.shortcuts).toBe(true);
  expect(update(on, k("text", "?"), 0).state.shortcuts).toBe(false);
  expect(update(withText("a"), k("text", "?"), 0).state.editor.text).toBe("a?");
});

test("slash suggestions: tab completes, arrows wrap, enter submits the match", () => {
  const typing = withText("/m");
  const tab = update(typing, k("tab"), 0).state;
  expect(tab.editor.text).toBe("/model ");
  expect(update(withText("plain"), k("tab"), 0).state.editor.text).toBe(
    "plain",
  );
  const slash = withText("/");
  expect(update(slash, k("down"), 0).state.suggestion).toBe(1);
  expect(update(slash, k("up"), 0).state.suggestion).toBe(1);
  const second = { ...slash, suggestion: 1 };
  const enter = update(second, k("enter"), 0);
  expect(enter.effects).toEqual([{ kind: "submit", text: "/model" }]);
  expect(enter.state.suggestion).toBe(0);
});

test("history navigation clamps at both ends and yields an empty line past the newest", () => {
  const s: AppState = { ...base(), history: ["one", "two"] };
  const up1 = update(s, k("up"), 0).state;
  expect(up1.editor.text).toBe("two");
  const up2 = update(up1, k("up"), 0).state;
  expect(up2.editor.text).toBe("one");
  const up3 = update(up2, k("up"), 0).state;
  expect(up3.editor.text).toBe("one");
  const down = update(up2, k("down"), 0).state;
  expect(down.editor.text).toBe("two");
  const past = update(down, k("down"), 0).state;
  expect(past.editor.text).toBe("");
  expect(past.historyIndex).toBe(2);
  const multi = withText("a\nb");
  expect(update(multi, k("up"), 0).state.editor).toEqual(multi.editor);
});

test("enter on blank text does nothing; backslash continuation mid-line", () => {
  const blank = update(withText("   "), k("enter"), 0);
  expect(blank.effects).toEqual([]);
  const mid = update(withText("ab\\cd", 3), k("enter"), 0).state;
  expect(mid.editor).toEqual({ text: "ab\ncd", cursor: 3 });
});

test("line editing keys cover every branch", () => {
  const ed = (s: AppState, key: Key) => update(s, key, 0).state.editor;
  expect(ed(withText("abc"), k("paste", "XY"))).toEqual({
    text: "abcXY",
    cursor: 5,
  });
  expect(ed(withText("ab"), k("newline"))).toEqual({ text: "ab\n", cursor: 3 });
  expect(ed(withText("abc", 0), k("backspace"))).toEqual({
    text: "abc",
    cursor: 0,
  });
  expect(ed(withText("abc"), k("backspace"))).toEqual({
    text: "ab",
    cursor: 2,
  });
  expect(ed(withText("abc", 1), k("delete"))).toEqual({
    text: "ac",
    cursor: 1,
  });
  expect(ed(withText("abc", 0), k("left"))).toEqual({ text: "abc", cursor: 0 });
  expect(ed(withText("abc"), k("right"))).toEqual({ text: "abc", cursor: 3 });
  expect(ed(withText("ab\ncd", 4), k("home"))).toEqual({
    text: "ab\ncd",
    cursor: 3,
  });
  expect(ed(withText("ab\ncd", 1), k("end"))).toEqual({
    text: "ab\ncd",
    cursor: 2,
  });
  expect(ed(withText("ab\ncd", 4), k("end"))).toEqual({
    text: "ab\ncd",
    cursor: 5,
  });
  expect(ed(withText("ab\ncd", 1), k("ctrl-k"))).toEqual({
    text: "a\ncd",
    cursor: 1,
  });
  expect(ed(withText("ab\ncd", 4), k("ctrl-u"))).toEqual({
    text: "ab\nd",
    cursor: 3,
  });
  expect(ed(withText("foo bar "), k("ctrl-w"))).toEqual({
    text: "foo ",
    cursor: 4,
  });
  expect(ed(withText("abc"), k("home"))).toEqual({ text: "abc", cursor: 0 });
  expect(update(withText("abc"), k("ctrl-d"), 0).state.editor.text).toBe("abc");
});

const dialog: PermissionDialog = {
  body: "b",
  question: "q",
  options: [
    { label: "Yes", choice: { kind: "accept-once" } },
    { label: "Session", choice: { kind: "accept-session", updates: [] } },
    { label: "No", choice: { kind: "reject" } },
  ],
};
const perm = (
  extra: Partial<Extract<View, { kind: "permission" }>> = {},
): AppState => ({
  ...base(),
  view: { kind: "permission", dialog, focus: 0, ...extra },
});

test("permission dialog: digits, enter, escape, shift-tab, arrows and others", () => {
  expect(update(perm(), k("text", "2"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "accept-session", updates: [] } },
  ]);
  expect(update(perm(), k("text", "9"), 0).effects).toEqual([]);
  expect(update(perm(), k("text", "x"), 0).effects).toEqual([]);
  expect(update(perm({ focus: 2 }), k("enter"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "reject" } },
  ]);
  expect(update(perm({ focus: 7 }), k("enter"), 0).effects).toEqual([]);
  expect(update(perm(), k("escape"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "reject" } },
  ]);
  expect(update(perm(), k("ctrl-c"), 0).effects).toHaveLength(1);
  expect(update(perm(), k("shift-tab"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "accept-session", updates: [] } },
  ]);
  const first = dialog.options[0];
  if (first === undefined) throw new Error("no option");
  const noSession: AppState = {
    ...perm(),
    view: {
      kind: "permission",
      dialog: { ...dialog, options: [first] },
      focus: 0,
    },
  };
  expect(update(noSession, k("shift-tab"), 0).effects).toEqual([]);
  const wrap = update(perm(), k("up"), 0).state.view;
  expect(wrap).toMatchObject({ focus: 2 });
  expect(update(perm({ focus: 2 }), k("down"), 0).state.view).toMatchObject({
    focus: 0,
  });
  expect(update(perm(), k("home"), 0).effects).toEqual([]);
  const amend = update(perm(), k("tab"), 0).state.view;
  expect(amend).toMatchObject({ amend: "" });
});

test("permission amend mode types feedback, folds newline, rejects with it", () => {
  const typed = update(perm({ amend: "no" }), k("text", "pe"), 0).state;
  expect(typed.view).toMatchObject({ amend: "nope" });
  const nl = update(perm({ amend: "a" }), k("newline"), 0).state;
  expect(nl.view).toMatchObject({ amend: "a " });
  expect(update(perm({ amend: "a" }), k("up"), 0).effects).toEqual([]);
  expect(update(perm({ amend: "a" }), k("up"), 0).state.view).toMatchObject({
    amend: "a",
  });
  expect(update(perm({ amend: "  why " }), k("enter"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "reject", feedback: "why" } },
  ]);
  expect(update(perm({ amend: " " }), k("enter"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "reject" } },
  ]);
  expect(update(perm({ amend: "a" }), k("ctrl-c"), 0).effects).toEqual([
    { kind: "permission", choice: { kind: "reject" } },
  ]);
  const dismissing: Key["kind"][] = ["escape", "tab"];
  for (const kind of dismissing)
    expect(update(perm({ amend: "a" }), k(kind), 0).state.view).toMatchObject({
      amend: undefined,
    });
});

const help: AppState = {
  ...base(),
  view: { kind: "help", tab: "general", custom: [] },
};
const status: AppState = {
  ...base(),
  view: { kind: "status", tab: "status", fields: { status: [], usage: [] } },
};
const modelView = (focus = 0): AppState => ({
  ...base(),
  view: {
    kind: "model",
    focus,
    choices: [
      { label: "A", description: "", model: "a", current: true },
      { label: "B", description: "", model: "b", current: false },
    ],
  },
});

test("help and status panes close or cycle tabs", () => {
  const closers: Key["kind"][] = ["escape", "ctrl-c"];
  for (const key of closers) {
    expect(update(help, k(key), 0).effects).toEqual([{ kind: "dismiss" }]);
    expect(update(status, k(key), 0).effects).toEqual([{ kind: "dismiss" }]);
  }
  expect(update(status, k("enter"), 0).effects).toEqual([{ kind: "dismiss" }]);
  expect(update(help, k("right"), 0).state.view).toMatchObject({
    tab: "commands",
  });
  expect(update(help, k("left"), 0).state.view).toMatchObject({
    tab: "custom",
  });
  expect(update(help, k("tab"), 0).state.view).toMatchObject({
    tab: "commands",
  });
  expect(update(help, k("shift-tab"), 0).state.view).toMatchObject({
    tab: "custom",
  });
  expect(update(help, k("up"), 0).state).toBe(help);
  expect(update(status, k("right"), 0).state.view).toMatchObject({
    tab: "usage",
  });
  expect(update(status, k("up"), 0).state).toBe(status);
});

test("model picker: digits, enter, arrows, escape", () => {
  expect(update(modelView(), k("escape"), 0).effects).toEqual([
    { kind: "model" },
  ]);
  expect(update(modelView(), k("ctrl-c"), 0).effects).toEqual([
    { kind: "model" },
  ]);
  expect(update(modelView(), k("text", "2"), 0).effects).toEqual([
    { kind: "model", model: "b" },
  ]);
  expect(update(modelView(1), k("enter"), 0).effects).toEqual([
    { kind: "model", model: "b" },
  ]);
  expect(update(modelView(), k("text", "9"), 0).effects).toEqual([]);
  expect(update(modelView(), k("text", "x"), 0).effects).toEqual([]);
  expect(update(modelView(), k("up"), 0).state.view).toMatchObject({
    focus: 1,
  });
  expect(update(modelView(1), k("down"), 0).state.view).toMatchObject({
    focus: 0,
  });
  expect(update(modelView(), k("left"), 0).effects).toEqual([]);
});
