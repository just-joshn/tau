import stringWidth from "string-width";
import { terminalText } from "../terminal.js";

/** xterm-256 colour indexes the original's dark theme resolves to. */
export const COLOR = {
  claude: 174,
  shimmer: 216,
  dim: 246,
  rule: 244,
  dashed: 239,
  permission: 153,
  help: 110,
  text: 231,
  userBackground: 237,
  success: 114,
  error: 211,
  removedText: 167,
  removedBackground: 52,
  addedText: 77,
  addedBackground: 22,
  acceptEdits: 147,
  plan: 72,
  bypass: 211,
  logoBackground: 16,
  inverseText: 16,
} as const;

export interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  inverse?: boolean;
}

export interface Span {
  text: string;
  style?: Style;
}

/** One screen row: styled runs, no newlines. */
export type Line = readonly Span[];

export const span = (text: string, style?: Style): Span =>
  style === undefined ? { text } : { text, style };

export const line = (...spans: (Span | string)[]): Line =>
  spans.map((part) => (typeof part === "string" ? { text: part } : part));

export const plain = (row: Line): string =>
  row.map((part) => part.text).join("");

export const width = (text: string): number => stringWidth(text);

export const lineWidth = (row: Line): number => width(plain(row));

/** Pads a line with spaces (in `style`) up to `columns`. */
export function padLine(row: Line, columns: number, style?: Style): Line {
  const missing = columns - lineWidth(row);
  return missing > 0 ? [...row, span(" ".repeat(missing), style)] : row;
}

export const graphemes = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Cuts a line to at most `columns` cells. */
export function clipLine(row: Line, columns: number): Line {
  if (lineWidth(row) <= columns) return row;
  const result: Span[] = [];
  let used = 0;
  for (const part of row) {
    let text = "";
    for (const { segment } of graphemes.segment(part.text)) {
      const cells = width(segment);
      if (used + cells > columns) break;
      text += segment;
      used += cells;
    }
    if (text) result.push({ ...part, text });
    if (text.length < part.text.length) break;
  }
  return result;
}

/** Word wrap to `columns` cells; words longer than a row break by grapheme. */
export function wrap(text: string, columns: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/(?<= )/)) {
      if (width(current + word.trimEnd()) <= columns) {
        current += word;
        continue;
      }
      if (current.trim()) rows.push(current.trimEnd());
      current = "";
      let rest = word;
      while (width(rest.trimEnd()) > columns) {
        let head = "";
        for (const { segment } of graphemes.segment(rest)) {
          if (width(head + segment) > columns) break;
          head += segment;
        }
        rows.push(head);
        rest = rest.slice(head.length);
      }
      current = rest;
    }
    rows.push(current.trimEnd());
  }
  return rows;
}

function sgr(style: Style | undefined): string {
  if (style === undefined) return "";
  const codes: (string | number)[] = [];
  if (style.bold) codes.push(1);
  if (style.inverse) codes.push(7);
  if (style.fg !== undefined) codes.push(`38;5;${style.fg}`);
  if (style.bg !== undefined) codes.push(`48;5;${style.bg}`);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

/**
 * The escape-coded form of a row; every styled run resets after itself. Text
 * passes through `terminalText` here, so no model or tool output reaches the
 * terminal as a control sequence.
 */
export function ansi(row: Line): string {
  return row
    .map((part) => {
      const text = terminalText(part.text).replace(/[\t\n]/g, " ");
      const open = sgr(part.style);
      return open ? `${open}${text}\x1b[0m` : text;
    })
    .join("");
}
