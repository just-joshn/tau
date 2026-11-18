import { DIALOG_FOOTER, REJECT_PLACEHOLDER } from "../permission-dialog.js";
import type { PermissionMode } from "../types.js";
import {
  suggestions,
  type AppState,
  type CommandEntry,
  type Field,
  type PatchLine,
  type ToolStatus,
  type TranscriptItem,
  type View,
  type Welcome,
} from "./state.js";
import {
  COLOR,
  clipLine,
  graphemes,
  line,
  padLine,
  span,
  width,
  wrap,
  type Line,
  type Style,
} from "./text.js";

export interface Size {
  columns: number;
  rows: number;
}

export interface Frame {
  lines: Line[];
  /** Where the terminal cursor rests: the input caret, or undefined to hide it. */
  cursor?: { row: number; column: number };
}

const dim: Style = { fg: COLOR.dim };
const bold: Style = { bold: true };
const RESULT = "  ⎿ \u00a0";
const INDENT = " ".repeat(5);
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];

const rule = (char: string, columns: number, fg: number): Line => [
  span(char.repeat(columns), { fg }),
];

function welcome(info: Welcome): Line[] {
  const logo: Style = { fg: COLOR.claude };
  const body: Style = { fg: COLOR.claude, bg: COLOR.logoBackground };
  const facts = [info.model, info.billing].filter(Boolean).join(" · ");
  return [
    [],
    line(
      span(" ▐", logo),
      span("▛███▛█", body),
      "   ",
      span(info.product, bold),
      " ",
      span(`v${info.version}`, dim),
    ),
    line(
      span("▝▜", logo),
      span("██████", body),
      span("▀", logo),
      "  ",
      span(facts, dim),
    ),
    line(span(" ▝▝   ▝▝", logo), "   ", span(info.cwd, dim)),
    [],
  ];
}

/** Rows of `text` wrapped under a fixed first-row prefix and hanging indent. */
function hanging(
  text: string,
  first: Line,
  indent: number,
  columns: number,
  style?: Style,
): Line[] {
  return wrap(text, Math.max(1, columns - indent)).map((row, index) =>
    index === 0
      ? [...first, span(row, style)]
      : line(" ".repeat(indent), span(row, style)),
  );
}

function patchRow(row: PatchLine, digits: number, columns: number): Line {
  const number = String(row.number).padStart(digits);
  if (row.kind === "context") return line(span(` ${number}  `, dim), row.text);
  const removed = row.kind === "removed";
  const background = removed ? COLOR.removedBackground : COLOR.addedBackground;
  return padLine(
    line(
      span(` ${number} ${removed ? "-" : "+"}`, {
        fg: removed ? COLOR.removedText : COLOR.addedText,
        bg: background,
      }),
      span(row.text, { fg: COLOR.text, bg: background }),
    ),
    columns,
    { bg: background },
  );
}

function patch(rows: readonly PatchLine[], columns: number): Line[] {
  const digits = String(Math.max(0, ...rows.map((row) => row.number))).length;
  return rows.map((row) => clipLine(patchRow(row, digits, columns), columns));
}

const BULLET: Readonly<Record<ToolStatus, number>> = {
  pending: COLOR.dim,
  done: COLOR.success,
  error: COLOR.error,
  rejected: COLOR.error,
};

function item(entry: TranscriptItem, columns: number): Line[] {
  switch (entry.kind) {
    case "user": {
      const background: Style = { bg: COLOR.userBackground };
      return wrap(entry.text, columns - 2).map((row, index) =>
        padLine(
          line(
            span(index === 0 ? "❯ " : "  ", { ...background, fg: COLOR.dim }),
            span(row, { ...background, fg: COLOR.text }),
          ),
          columns,
          background,
        ),
      );
    }
    case "assistant":
      return hanging(entry.text, [span("⏺ ", { fg: COLOR.text })], 2, columns);
    case "explore": {
      const counts = [
        ["Read", entry.reads, "file"],
        ["searched for", entry.searches, "pattern"],
      ] as const;
      const spans = counts
        .filter(([, count]) => count > 0)
        .flatMap(([verb, count, noun], index) => [
          span(
            index
              ? `, ${verb} `
              : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} `,
            dim,
          ),
          span(String(count), { ...dim, bold: true }),
          span(` ${noun}${count === 1 ? "" : "s"}`, dim),
        ]);
      return [line("  ", ...spans)];
    }
    case "tool": {
      const header = line(
        span("⏺ ", { fg: BULLET[entry.status] ?? COLOR.dim }),
        span(entry.label, bold),
        entry.target ? `(${entry.target})` : "",
      );
      const rows = [clipLine(header, columns)];
      if (entry.summary === undefined) return rows;
      rows.push(
        ...hanging(
          entry.summary,
          [span(RESULT, dim)],
          5,
          columns,
          entry.status === "error" ? { fg: COLOR.error } : undefined,
        ),
      );
      if (entry.patch && entry.status !== "error")
        rows.push(
          ...patch(entry.patch, columns - 5).map((row) => [
            span(INDENT),
            ...row,
          ]),
        );
      rows.push(
        ...entry.detail.map((row) =>
          clipLine(line(INDENT, span(row, dim)), columns),
        ),
      );
      return rows;
    }
    case "command":
      return [
        line(
          span("❯", { bg: COLOR.userBackground, fg: COLOR.dim }),
          span(" ", { bg: COLOR.userBackground }),
          span(entry.input, { bg: COLOR.userBackground, fg: COLOR.text }),
          span(" ", { bg: COLOR.userBackground }),
        ),
        ...entry.output.flatMap((text, index) =>
          hanging(
            text,
            [span(index === 0 ? RESULT : INDENT, dim)],
            5,
            columns,
            entry.tone === "error" ? { fg: COLOR.error } : undefined,
          ),
        ),
      ];
    case "notice":
      return hanging(
        entry.text,
        [span(RESULT, dim)],
        5,
        columns,
        entry.tone === "error" ? { fg: COLOR.error } : dim,
      );
    case "done":
      return [
        line(
          span("✻ ", dim),
          span(`${entry.verb} for ${entry.elapsed} · done ${entry.at}`, dim),
        ),
      ];
    case "interrupted":
      return [
        line(
          span(RESULT, dim),
          span("Interrupted", { fg: COLOR.error }),
          span(" · What should Claude do instead?", dim),
        ),
      ];
  }
}

const MODE_STYLE: Readonly<
  Record<PermissionMode, { label: string; symbol: string; fg: number }>
> = {
  default: { label: "manual mode on", symbol: "⏸", fg: COLOR.dim },
  acceptEdits: {
    label: "accept edits on",
    symbol: "⏵⏵",
    fg: COLOR.acceptEdits,
  },
  plan: { label: "plan mode on", symbol: "⏸", fg: COLOR.plan },
  bypassPermissions: {
    label: "bypass permissions on",
    symbol: "⏵⏵",
    fg: COLOR.bypass,
  },
};

/** The rows under the input box: shortcuts, the exit hint or the mode line. */
function footer(state: AppState, columns: number): Line[] {
  if (state.shortcuts) return shortcutGrid(columns, 2);
  if (state.exitArmed)
    return [
      line("  ", span(`Press ${state.exitArmed.key} again to exit`, dim)),
    ];
  if (state.escapeArmedAt !== undefined)
    return [line("  ", span("Esc again to clear", dim))];
  const mode = MODE_STYLE[state.mode];
  const cycle = state.mode === "default" ? "" : " (shift+tab to cycle)";
  const hint = state.busy
    ? " · esc to interrupt"
    : state.mode === "default" && !state.editor.text
      ? " · ? for shortcuts"
      : "";
  return [
    clipLine(
      line(
        "  ",
        span(`${mode.symbol} ${mode.label}`, { fg: mode.fg }),
        span(cycle + hint, dim),
      ),
      columns,
    ),
  ];
}

const SHORTCUTS: readonly (readonly string[])[] = [
  ["/ for commands"],
  [
    "esc esc to clear input",
    "shift+tab to cycle modes",
    "backslash (\\) then enter for newline",
  ],
  ["ctrl+c twice to exit"],
];
const SHORTCUT_COLUMNS = [24, 35] as const;

function shortcutGrid(columns: number, indent: number): Line[] {
  const widths = [
    SHORTCUT_COLUMNS[0],
    SHORTCUT_COLUMNS[1],
    Math.max(10, columns - indent - SHORTCUT_COLUMNS[0] - SHORTCUT_COLUMNS[1]),
  ];
  const cells = SHORTCUTS.map((entries, index) =>
    entries.flatMap((entry) => wrap(entry, (widths[index] ?? 10) - 1)),
  );
  const height = Math.max(...cells.map((rows) => rows.length));
  return Array.from({ length: height }, (_, row) =>
    line(
      " ".repeat(indent),
      cells
        .map((rows, index) =>
          index === cells.length - 1
            ? (rows[row] ?? "")
            : (rows[row] ?? "").padEnd(widths[index] ?? 0),
        )
        .join("")
        .trimEnd(),
    ),
  );
}

/** The bordered input box, hard-wrapped, with the caret drawn as an inverse cell. */
function inputBox(
  state: AppState,
  columns: number,
): { rows: Line[]; caret: { row: number; column: number } } {
  const { text, cursor } = state.editor;
  const limit = columns - 2;
  const chunks: { text: string; start: number }[] = [];
  let offset = 0;
  for (const source of text.split("\n")) {
    let chunk = { text: "", start: offset };
    for (const { segment, index } of graphemes.segment(source)) {
      if (width(chunk.text + segment) > limit) {
        chunks.push(chunk);
        chunk = { text: "", start: offset + index };
      }
      chunk.text += segment;
    }
    chunks.push(chunk);
    offset += source.length + 1;
  }
  const at = chunks.findLastIndex((chunk) => chunk.start <= cursor);
  const rows = chunks.map((chunk, index) => {
    const prefix =
      index === 0 ? span("❯\u00a0", state.busy ? dim : undefined) : span("  ");
    if (index !== at) return line(prefix, chunk.text);
    const local = cursor - chunk.start;
    const rest = chunk.text.slice(local);
    const under = rest
      ? ([...graphemes.segment(rest)][0]?.segment ?? " ")
      : " ";
    return line(
      prefix,
      chunk.text.slice(0, local),
      span(under, { inverse: true }),
      rest.slice(rest ? under.length : 0),
    );
  });
  const caretChunk = chunks[at];
  return {
    rows: [
      rule("─", columns, COLOR.rule),
      ...rows,
      rule("─", columns, COLOR.rule),
    ],
    caret: {
      row: at + 1,
      column:
        2 +
        width(
          caretChunk ? caretChunk.text.slice(0, cursor - caretChunk.start) : "",
        ),
    },
  };
}

function suggestionRows(state: AppState, columns: number): Line[] {
  return suggestions(state).map((entry, index) =>
    clipLine(
      line(
        "  ",
        index === state.suggestion
          ? span(`❯ /${entry.name}`.padEnd(30), { fg: COLOR.permission })
          : `  /${entry.name}`.padEnd(30),
        index === state.suggestion
          ? span(entry.description, { fg: COLOR.permission })
          : span(entry.description, dim),
      ),
      columns,
    ),
  );
}

function permissionRows(
  view: Extract<View, { kind: "permission" }>,
  columns: number,
): Line[] {
  const { dialog } = view;
  const rows: Line[] = [rule("─", columns, COLOR.permission)];
  if (view.title !== undefined)
    rows.push(
      line(" ", span(view.title, { fg: COLOR.permission, bold: true })),
    );
  if (dialog.subtitle !== undefined)
    rows.push(line(" ", span(dialog.subtitle, dim)));
  if (view.patch?.length) {
    rows.push(rule("╌", columns, COLOR.dashed));
    rows.push(...patch(view.patch, columns));
    rows.push(rule("╌", columns, COLOR.dashed));
  } else if (dialog.body) {
    rows.push([]);
    for (const text of dialog.body.split("\n"))
      rows.push(...hanging(text, [span("   ")], 3, columns - 1));
    rows.push([]);
  }
  rows.push(...hanging(dialog.question, [span(" ")], 1, columns - 1));
  dialog.options.forEach((option, index) => {
    const focused = index === view.focus;
    const amending =
      view.amend !== undefined && option.choice.kind === "reject";
    const marker = span(focused ? "❯ " : "  ", { fg: COLOR.permission });
    const number = span(
      `${index + 1}. `,
      focused ? { fg: COLOR.permission } : dim,
    );
    if (amending) {
      const typed = view.amend ?? "";
      rows.push(
        line(
          " ",
          marker,
          number,
          `${option.label}, `,
          typed ? typed : span(REJECT_PLACEHOLDER, dim),
          span(" ", { inverse: true }),
        ),
      );
      return;
    }
    rows.push(
      ...hanging(
        option.label,
        [span(" "), marker, number],
        6,
        columns - 1,
        focused ? { fg: COLOR.permission } : undefined,
      ),
    );
  });
  rows.push([], line(" ", span(DIALOG_FOOTER, dim)));
  return rows.map((row) => clipLine(row, columns));
}

const PANE_INDENT = 3;

function tabs(
  title: string,
  names: readonly string[],
  active: number,
  fg: number,
): Line {
  return line(
    " ".repeat(PANE_INDENT),
    span(title, { fg, bold: true }),
    " ",
    ...names.flatMap((name, index) =>
      index === active
        ? [
            span(` ${name} `, { bg: fg, fg: COLOR.inverseText, bold: true }),
            " ",
          ]
        : [` ${name} `, " "],
    ),
  );
}

function paneText(text: string, columns: number, style?: Style): Line[] {
  return hanging(
    text,
    [span(" ".repeat(PANE_INDENT))],
    PANE_INDENT,
    columns - PANE_INDENT,
    style,
  );
}

const LABEL_COLUMN = 28;

function fieldRows(fields: readonly Field[], columns: number): Line[] {
  return fields.flatMap(([label, value]) => {
    if (!label) return [[]];
    const valueWidth = columns - PANE_INDENT * 2 - LABEL_COLUMN;
    const values = value ? wrap(value, valueWidth) : [""];
    return values.map((text, index) =>
      line(
        " ".repeat(PANE_INDENT),
        index === 0
          ? span(`${label}`.padEnd(LABEL_COLUMN), bold)
          : " ".repeat(LABEL_COLUMN),
        text,
      ),
    );
  });
}

const HELP_LEAD =
  "Claude understands your codebase, makes edits with your permission, and runs commands — right from your terminal.";

function commandList(
  entries: readonly CommandEntry[],
  columns: number,
): Line[] {
  return entries.flatMap((entry) =>
    hanging(
      entry.description,
      [
        span(" ".repeat(PANE_INDENT)),
        span(`/${entry.name}`.padEnd(LABEL_COLUMN), bold),
      ],
      PANE_INDENT + LABEL_COLUMN,
      columns - PANE_INDENT,
    ),
  );
}

function paneRows(state: AppState, view: View, columns: number): Line[] {
  switch (view.kind) {
    case "help": {
      const active = ["general", "commands", "custom"].indexOf(view.tab);
      const body =
        view.tab === "general"
          ? [
              ...paneText(HELP_LEAD, columns),
              line(" ".repeat(PANE_INDENT), span("Shortcuts", bold)),
              ...shortcutGrid(columns, PANE_INDENT),
            ]
          : view.tab === "commands"
            ? [
                line(
                  " ".repeat(PANE_INDENT),
                  span("Browse default commands:", bold),
                ),
                ...commandList(
                  state.commands.filter(
                    (entry) => !view.custom.includes(entry),
                  ),
                  columns,
                ),
              ]
            : view.custom.length
              ? [
                  line(
                    " ".repeat(PANE_INDENT),
                    span("Browse custom commands:", bold),
                  ),
                  ...commandList(view.custom, columns),
                ]
              : paneText("No custom commands yet", columns, dim);
      return [
        rule("▔", columns, COLOR.help),
        tabs(
          "Help",
          ["General", "Commands", "Custom commands"],
          active,
          COLOR.help,
        ),
        [],
        ...body,
        [],
        line(" ".repeat(PANE_INDENT), "For more help: ", "tau --help"),
        [],
        line(" ".repeat(PANE_INDENT), span("Esc to cancel", dim)),
      ];
    }
    case "status": {
      const active = view.tab === "status" ? 0 : 1;
      return [
        rule("▔", columns, COLOR.permission),
        tabs("Settings", ["Status", "Usage"], active, COLOR.permission),
        [],
        ...fieldRows(view.fields[view.tab], columns),
        [],
        line(" ".repeat(PANE_INDENT), span("Esc to cancel", dim)),
      ];
    }
    case "model":
      return [
        rule("▔", columns, COLOR.permission),
        line(
          " ".repeat(PANE_INDENT),
          span("Select model", { fg: COLOR.permission, bold: true }),
        ),
        ...paneText(
          "Switch between Claude models for this session. For other or older models, use /model <name> or --model.",
          columns,
          dim,
        ),
        [],
        ...view.choices.flatMap((choice, index) => {
          const focused = index === view.focus;
          const label = `${index + 1}. ${choice.label}${choice.current ? " ✔" : ""}`;
          return hanging(
            choice.description,
            [
              span(" ".repeat(PANE_INDENT)),
              span(focused ? "❯ " : "  ", { fg: COLOR.permission }),
              span(
                label.padEnd(LABEL_COLUMN - 2),
                focused ? { fg: COLOR.permission } : {},
              ),
            ],
            PANE_INDENT + LABEL_COLUMN,
            columns - PANE_INDENT,
            dim,
          );
        }),
        [],
        line(
          " ".repeat(PANE_INDENT),
          span("Enter to confirm · Esc to cancel", dim),
        ),
      ];
    default:
      return [];
  }
}

function spinner(state: AppState): Line[] {
  if (!state.busy || state.view.kind === "permission") return [];
  const glyph = SPINNER_FRAMES[state.busy.frame % SPINNER_FRAMES.length] ?? "·";
  return [
    [],
    line(
      span(glyph, { fg: COLOR.claude }),
      " ",
      span(`${state.busy.verb}…`, { fg: COLOR.claude }),
    ),
  ];
}

const blank = (count: number): Line[] =>
  Array.from({ length: Math.max(0, count) }, () => []);

/** The whole screen for a state: pure, so screens are testable as text. */
export function render(state: AppState, size: Size): Frame {
  const { columns, rows } = size;
  const body: Line[] = [
    ...welcome(state.welcome).map((row) => clipLine(row, columns)),
    ...state.items.flatMap((entry) => [
      [],
      ...item(entry, columns).map((row) => clipLine(row, columns)),
    ]),
    ...spinner(state),
  ];
  const view = state.view;
  if (view.kind === "permission") {
    const all = [...body, [], ...permissionRows(view, columns)];
    return { lines: all.slice(Math.max(0, all.length - rows)) };
  }
  if (view.kind !== "prompt") {
    let pane = paneRows(state, view, columns).map((row) =>
      clipLine(row, columns),
    );
    if (pane.length > rows - 1) {
      pane = pane.slice(0, rows - 1);
      const last = pane.length - 1;
      pane[last] = padLine(pane[last] ?? [], columns - 2).concat(
        span("↓", dim),
      );
    }
    const above = rows - pane.length;
    const tail = body.slice(Math.max(0, body.length - above));
    return { lines: [...tail, ...blank(above - tail.length), ...pane] };
  }
  const box = inputBox(state, columns);
  const bottom = [...box.rows, ...footer(state, columns)];
  const screen = [...body, [], ...bottom];
  const lines =
    screen.length <= rows
      ? [...body, ...blank(rows - screen.length + 1), ...bottom]
      : screen.slice(screen.length - rows);
  const top = lines.length - bottom.length;
  const overlay = suggestionRows(state, columns);
  overlay.forEach((row, index) => {
    const target = top - overlay.length + index;
    if (target >= 0) lines[target] = row;
  });
  return {
    lines,
    cursor: { row: top + box.caret.row, column: box.caret.column },
  };
}
