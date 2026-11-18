import { describe, expect, test } from "bun:test";
import { permissionDialog } from "../../src/permission-dialog.js";
import { decodeKeys, type Key } from "../../src/tui/keys.js";
import { initialState, nextMode, type AppState } from "../../src/tui/state.js";
import { patchLines } from "../../src/tui/tool-display.js";
import { update, type Effect } from "../../src/tui/update.js";

describe("key decoder", () => {
  test("splits text, controls, CSI and SS3 keys", () => {
    expect(
      decodeKeys("ab\x1b[A\x1bOB\x1b[Z\r\x7f\x03\x1b[3~\x1b[1;2C").keys,
    ).toEqual([
      { kind: "text", text: "ab" },
      { kind: "up" },
      { kind: "down" },
      { kind: "shift-tab" },
      { kind: "enter" },
      { kind: "backspace" },
      { kind: "ctrl-c" },
      { kind: "delete" },
      { kind: "right" },
    ]);
  });

  test("a lone ESC is Escape; ESC CR is a newline", () => {
    expect(decodeKeys("\x1b").keys).toEqual([{ kind: "escape" }]);
    expect(decodeKeys("\x1b\r").keys).toEqual([{ kind: "newline" }]);
  });

  test("bracketed paste arrives whole, with CRLF folded", () => {
    expect(decodeKeys("\x1b[200~one\r\ntwo\x1b[201~x").keys).toEqual([
      { kind: "paste", text: "one\ntwo" },
      { kind: "text", text: "x" },
    ]);
    const split = decodeKeys("\x1b[200~par");
    expect(split).toEqual({ keys: [], rest: "\x1b[200~par" });
    expect(decodeKeys(`${split.rest}t\x1b[201~`).keys).toEqual([
      { kind: "paste", text: "part" },
    ]);
  });

  test("a sequence cut between reads waits for its end", () => {
    expect(decodeKeys("x\x1b[")).toEqual({
      keys: [{ kind: "text", text: "x" }],
      rest: "\x1b[",
    });
  });

  test("mouse, focus and terminal replies are dropped", () => {
    expect(decodeKeys("\x1b[<0;10;5M\x1b[I\x1b[?1;2c\x1b[O").keys).toEqual([]);
  });
});

const fresh = (): AppState =>
  initialState(
    { product: "tau", version: "0", model: "m", cwd: "/w" },
    {
      mode: "default",
      bypassAvailable: false,
      commands: [
        { name: "help", description: "Show help and available commands" },
        { name: "model", description: "Set the AI model" },
      ],
    },
  );

function press(
  state: AppState,
  keys: readonly (Key | string)[],
  now = 0,
): { state: AppState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const key of keys) {
    const decoded: Key[] =
      typeof key === "string" ? decodeKeys(key).keys : [key];
    for (const one of decoded) {
      const next = update(state, one, now);
      state = next.state;
      effects.push(...next.effects);
    }
  }
  return { state, effects };
}

describe("prompt editing", () => {
  test("typing and Enter submit the trimmed line and clear the box", () => {
    const { state, effects } = press(fresh(), ["  hello world ", "\r"]);
    expect(effects).toEqual([{ kind: "submit", text: "hello world" }]);
    expect(state.editor).toEqual({ text: "", cursor: 0 });
    expect(state.history).toEqual(["hello world"]);
  });

  test("backslash then Enter inserts a newline instead of submitting", () => {
    const { state, effects } = press(fresh(), ["one\\", "\r", "two"]);
    expect(effects).toEqual([]);
    expect(state.editor.text).toBe("one\ntwo");
  });

  test("cursor keys edit in place", () => {
    const { state } = press(fresh(), ["acd", "\x1b[D\x1b[D", "b", "\x05", "!"]);
    expect(state.editor).toEqual({ text: "abcd!", cursor: 5 });
  });

  test("Enter while a turn runs still submits, for the host to queue", () => {
    const busy = { ...fresh(), busy: { verb: "V", startedAt: 0, frame: 0 } };
    expect(press(busy, ["later", "\r"]).effects).toEqual([
      { kind: "submit", text: "later" },
    ]);
  });

  test("Up recalls earlier prompts", () => {
    const { state } = press(fresh(), ["first\r", "second\r", "\x1b[A\x1b[A"]);
    expect(state.editor.text).toBe("first");
  });

  test("a slash prefix offers commands; Enter runs the highlighted one", () => {
    const typed = press(fresh(), ["/mo"]);
    expect(press(typed.state, ["\r"]).effects).toEqual([
      { kind: "submit", text: "/model" },
    ]);
    expect(press(typed.state, ["\t"]).state.editor.text).toBe("/model ");
  });
});

describe("shift+tab", () => {
  test("cycles default → accept edits → plan → default", () => {
    const { effects } = press(fresh(), ["\x1b[Z", "\x1b[Z", "\x1b[Z"]);
    expect(effects).toEqual([
      { kind: "mode", mode: "acceptEdits" },
      { kind: "mode", mode: "plan" },
      { kind: "mode", mode: "default" },
    ]);
  });

  test("passes through bypass only when the launch allowed it", () => {
    expect(nextMode("plan", true)).toBe("bypassPermissions");
    expect(nextMode("bypassPermissions", true)).toBe("default");
    expect(nextMode("plan", false)).toBe("default");
  });
});

describe("exit and interrupt", () => {
  test("a first Ctrl-C clears the input and arms; a second within 800ms exits", () => {
    const armed = press(fresh(), ["draft", "\x03"], 1000);
    expect(armed.state.editor.text).toBe("");
    expect(armed.state.exitArmed).toEqual({ key: "Ctrl-C", at: 1000 });
    expect(press(armed.state, ["\x03"], 1700).effects).toEqual([
      { kind: "exit" },
    ]);
    expect(press(armed.state, ["\x03"], 1900).effects).toEqual([]);
  });

  test("Ctrl-C or Esc during a turn interrupts it", () => {
    const busy = { ...fresh(), busy: { verb: "V", startedAt: 0, frame: 0 } };
    expect(press(busy, ["\x03"]).effects).toEqual([{ kind: "interrupt" }]);
    expect(press(busy, ["\x1b"]).effects).toEqual([{ kind: "interrupt" }]);
  });

  test("Esc twice clears the input", () => {
    expect(press(fresh(), ["draft", "\x1b", "\x1b"]).state.editor.text).toBe(
      "",
    );
  });
});

describe("permission dialog keys", () => {
  const dialogState = (): AppState => {
    const dialog = permissionDialog(
      { tool: "Edit", path: "/w/a.txt" },
      "Edit",
      { cwd: "/w", mode: "default", exists: true },
    );
    return {
      ...fresh(),
      view: { kind: "permission", dialog, title: "Edit file", focus: 0 },
    };
  };

  test("a number picks its row", () => {
    expect(press(dialogState(), ["1"]).effects).toEqual([
      { kind: "permission", choice: { kind: "accept-once" } },
    ]);
    expect(press(dialogState(), ["3"]).effects).toEqual([
      { kind: "permission", choice: { kind: "reject" } },
    ]);
  });

  test("arrows move the focus and Enter takes it", () => {
    const { effects, state } = press(dialogState(), ["\x1b[B", "\x1b[B", "\r"]);
    expect(effects).toEqual([
      { kind: "permission", choice: { kind: "reject" } },
    ]);
    expect(state.view.kind).toBe("prompt");
  });

  test("shift+tab takes the session row; Esc refuses", () => {
    expect(press(dialogState(), ["\x1b[Z"]).effects[0]).toMatchObject({
      choice: { kind: "accept-session" },
    });
    expect(press(dialogState(), ["\x1b"]).effects).toEqual([
      { kind: "permission", choice: { kind: "reject" } },
    ]);
  });

  test("Tab amends the refusal with feedback", () => {
    expect(press(dialogState(), ["\t", "use gamma", "\r"]).effects).toEqual([
      {
        kind: "permission",
        choice: { kind: "reject", feedback: "use gamma" },
      },
    ]);
  });
});

describe("panes", () => {
  test("the model picker returns the picked model, or nothing on Esc", () => {
    const picker: AppState = {
      ...fresh(),
      view: {
        kind: "model",
        focus: 1,
        choices: [
          { label: "A", description: "", model: "a", current: false },
          { label: "B", description: "", model: "b", current: true },
        ],
      },
    };
    expect(press(picker, ["\x1b[A", "\r"]).effects).toEqual([
      { kind: "model", model: "a" },
    ]);
    expect(press(picker, ["2"]).effects).toEqual([
      { kind: "model", model: "b" },
    ]);
    expect(press(picker, ["\x1b"]).effects).toEqual([{ kind: "model" }]);
  });

  test("help tabs cycle with arrows and Esc closes", () => {
    const help: AppState = {
      ...fresh(),
      view: { kind: "help", tab: "general", custom: [] },
    };
    const moved = press(help, ["\x1b[C"]).state.view;
    expect(moved).toMatchObject({ tab: "commands" });
    expect(press(help, ["\x1b[D"]).state.view).toMatchObject({ tab: "custom" });
    expect(press(help, ["\x1b"]).state.view).toEqual({ kind: "prompt" });
  });
});

describe("patch lines", () => {
  test("number changed rows in their file with up to three context rows", () => {
    expect(patchLines("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nd\nE\nf\n")).toEqual([
      { kind: "context", number: 2, text: "b" },
      { kind: "context", number: 3, text: "c" },
      { kind: "context", number: 4, text: "d" },
      { kind: "removed", number: 5, text: "e" },
      { kind: "added", number: 5, text: "E" },
      { kind: "context", number: 6, text: "f" },
    ]);
  });

  test("a new file is all added rows", () => {
    expect(patchLines("", "x\ny\n")).toEqual([
      { kind: "added", number: 1, text: "x" },
      { kind: "added", number: 2, text: "y" },
    ]);
  });
});
