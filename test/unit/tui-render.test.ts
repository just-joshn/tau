// Pure render snapshots against the original 2.1.326's captured screens
// (100x30, exported by scripts/differential/compare_pty.py --export-fixtures).
// Every row must match except the rows each test names: those are the honest
// differences, and the test states what tau shows instead.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  permissionDialog,
  rejectionMessage,
} from "../../src/permission-dialog.js";
import { render } from "../../src/tui/render.js";
import {
  initialState,
  type AppState,
  type CommandEntry,
  type TranscriptItem,
} from "../../src/tui/state.js";
import { plain } from "../../src/tui/text.js";
import { finishTool, startTool } from "../../src/tui/tool-display.js";

const SIZE = { columns: 100, rows: 30 };

function fixture(name: string): string[] {
  const rows = readFileSync(
    join(import.meta.dir, "../fixtures/tui", `${name}.txt`),
    "utf8",
  )
    .replace(/\n$/, "")
    .split("\n");
  return [
    ...rows,
    ...Array.from({ length: SIZE.rows - rows.length }, () => ""),
  ];
}

function screen(state: AppState): string[] {
  return render(state, SIZE).lines.map((row) => plain(row).trimEnd());
}

/** The captured screen with the named rows replaced by what tau shows there. */
function expected(
  rows: string[],
  differences: Readonly<Record<number, string>> = {},
): string[] {
  return rows.map((row, index) => differences[index] ?? row);
}

// The original's footer adds "· ← for agents" (its background-agents panel); tau has no such panel.
const NO_AGENTS_PANEL = (row: string) => row.replace(" · ← for agents", "");

function base(cwdFrom: string[], commands: CommandEntry[] = []): AppState {
  return initialState(
    {
      product: "Claude Code",
      version: "2.1.326",
      model: "Sonnet 4.5",
      billing: "API Usage Billing",
      cwd: (cwdFrom[3] ?? "").slice(11),
    },
    { mode: "default", bypassAvailable: false, commands },
  );
}

const CWD = "/work";
const editCall = (id: string, before: string, after: string) => ({
  type: "tool_use" as const,
  id,
  name: "Edit",
  input: { file_path: `${CWD}/a.txt`, old_string: before, new_string: after },
});
const readCall = (id: string) => ({
  type: "tool_use" as const,
  id,
  name: "Read",
  input: { file_path: `${CWD}/a.txt` },
});

/** A prompt that reads a.txt and edits `before` → `after`, up to the pending edit. */
function editTurn(
  items: TranscriptItem[],
  before: string,
  after: string,
): TranscriptItem[] {
  let next: TranscriptItem[] = [
    ...items,
    { kind: "user", text: "TAU_PTY_EDIT" },
  ];
  next = startTool(next, readCall("read"), CWD, () => `${before}\n`);
  next = finishTool(next, {
    type: "tool_result",
    tool_use_id: "read",
    content: `1\t${before}`,
  });
  return startTool(
    next,
    editCall("edit", before, after),
    CWD,
    () => `${before}\n`,
  );
}

function finishEdit(
  items: TranscriptItem[],
  verb: string,
  at: string,
): TranscriptItem[] {
  return [
    ...finishTool(items, {
      type: "tool_result",
      tool_use_id: "edit",
      content: "The file a.txt has been updated successfully.",
    }),
    { kind: "assistant", text: "TAU_PTY_EDIT_REPLY error=False" },
    { kind: "done", verb, elapsed: "0s", at },
  ];
}

function editDialog(state: AppState): AppState {
  const dialog = permissionDialog(
    { tool: "Edit", path: `${CWD}/a.txt` },
    "Edit a.txt",
    { cwd: CWD, mode: "default", exists: true },
  );
  const pending = state.items.at(-1);
  return {
    ...state,
    view: {
      kind: "permission",
      dialog,
      title: dialog.title ?? "",
      focus: 0,
      ...(pending?.kind === "tool" && pending.patch
        ? { patch: pending.patch }
        : {}),
    },
  };
}

describe("tour screens", () => {
  const ready = fixture("tour-ready");
  const textTurn: TranscriptItem[] = [
    { kind: "user", text: "TAU_PTY_TEXT" },
    { kind: "assistant", text: "TAU_PTY_TEXT_REPLY mock done" },
    { kind: "done", verb: "Cooked", elapsed: "0s", at: "9:15 PM" },
  ];
  const approved = finishEdit(
    editTurn(textTurn, "alpha", "beta"),
    "Baked",
    "9:15 PM",
  );

  test("startup: welcome header, empty input box and mode line", () => {
    expect(screen(base(ready))).toEqual(
      expected(ready, { 29: NO_AGENTS_PANEL(ready[29] ?? "") }),
    );
  });

  test("a text turn: prompt, reply and completion line", () => {
    const rows = fixture("tour-text");
    expect(screen({ ...base(rows), items: textTurn })).toEqual(
      expected(rows, { 29: NO_AGENTS_PANEL(rows[29] ?? "") }),
    );
  });

  test("the edit permission dialog with its diff, scrolled under the header", () => {
    const rows = fixture("tour-edit");
    const state = editDialog({
      ...base(fixture("tour-ready")),
      items: editTurn(textTurn, "alpha", "beta"),
    });
    expect(screen(state)).toEqual(expected(rows));
  });

  test("an approved edit: Update row, change summary and numbered diff", () => {
    const rows = fixture("tour-edit-approve");
    expect(screen({ ...base(rows), items: approved })).toEqual(
      expected(rows, { 29: NO_AGENTS_PANEL(rows[29] ?? "") }),
    );
  });

  test("slash suggestions overlay the rows above the input box", () => {
    const rows = fixture("tour-help-typed");
    const state: AppState = {
      ...base(rows, [
        { name: "help", description: "Show help and available commands" },
        {
          name: "team-onboarding",
          description:
            "Help teammates ramp on Claude Code with a guide from your usage",
        },
      ]),
      items: approved.slice(0, -1),
      editor: { text: "/help", cursor: 5 },
    };
    // The original also lists /debug (it ranks by usage); tau matches names, then descriptions.
    expect(screen(state)).toEqual(
      expected(rows, { 23: "", 24: rows[23] ?? "", 25: rows[25] ?? "" }),
    );
  });

  test("a dismissed /model picker leaves its echo and result", () => {
    const rows = fixture("tour-model-close");
    const state: AppState = {
      ...base(ready),
      items: [
        ...approved,
        {
          kind: "command",
          input: "/model",
          output: ["Kept model as Sonnet 4.5"],
          tone: "info",
        },
      ],
    };
    expect(screen(state)).toEqual(
      expected(rows, { 29: "  ⏸ manual mode on · ? for shortcuts" }),
    );
  });

  test("a first Ctrl-C replaces the mode line with the exit hint", () => {
    const rows = fixture("tour-ctrl-c-1");
    const state: AppState = {
      ...base(ready),
      items: [
        ...approved,
        {
          kind: "command",
          input: "/model",
          output: ["Kept model as Sonnet 4.5"],
          tone: "info",
        },
      ],
      exitArmed: { key: "Ctrl-C", at: 0 },
    };
    expect(screen(state)).toEqual(expected(rows));
  });
});

describe("edit outcomes", () => {
  test("option 2 switches the footer to accept edits", () => {
    const rows = fixture("edit-always-edit-always");
    const state: AppState = {
      ...base(rows),
      mode: "acceptEdits",
      items: finishEdit(editTurn([], "alpha", "beta"), "Sautéed", "9:14 PM"),
    };
    expect(screen(state)).toEqual(
      expected(rows, { 29: NO_AGENTS_PANEL(rows[29] ?? "") }),
    );
  });

  test("a refusal marks the update rejected and keeps its diff", () => {
    const rows = fixture("edit-reject-edit-reject");
    const state: AppState = {
      ...base(rows),
      items: finishTool(editTurn([], "alpha", "beta"), {
        type: "tool_result",
        tool_use_id: "edit",
        content: rejectionMessage(),
        is_error: true,
      }),
    };
    expect(screen(state)).toEqual(
      expected(rows, { 29: NO_AGENTS_PANEL(rows[29] ?? "") }),
    );
  });
});

describe("input box", () => {
  test("multi-line input grows the box and the caret follows the cursor", () => {
    const state: AppState = {
      ...base(fixture("tour-ready")),
      editor: { text: "one\ntwo", cursor: 5 },
    };
    const frame = render(state, SIZE);
    const rows = frame.lines.map((row) => plain(row).trimEnd());
    expect(rows.slice(-5)).toEqual([
      "─".repeat(100),
      "❯\u00a0one",
      "  two",
      "─".repeat(100),
      "  ⏸ manual mode on",
    ]);
    expect(frame.cursor).toEqual({ row: 27, column: 3 });
  });

  test("a long line hard-wraps at the box width", () => {
    const state: AppState = {
      ...base(fixture("tour-ready")),
      editor: { text: "x".repeat(120), cursor: 120 },
    };
    const frame = render(state, SIZE);
    const rows = frame.lines.map((row) => plain(row).trimEnd());
    expect(rows.slice(-4, -2)).toEqual([
      `❯\u00a0${"x".repeat(98)}`,
      `  ${"x".repeat(22)}`,
    ]);
    expect(frame.cursor).toEqual({ row: 27, column: 24 });
  });
});

describe("explore rows", () => {
  test("consecutive searches and reads collapse into one counted row", () => {
    let items: TranscriptItem[] = [];
    for (const [id, name] of [
      ["g1", "Grep"],
      ["r1", "Read"],
      ["g2", "Glob"],
      ["r2", "Read"],
    ] as const)
      items = startTool(
        items,
        { type: "tool_use", id, name, input: { pattern: "x" } },
        CWD,
        () => undefined,
      );
    const rows = screen({ ...base(fixture("tour-ready")), items });
    expect(rows[6]).toBe("  Searched for 2 patterns, read 2 files");
  });
});
