import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(
    /[\p{Cc}--[\t\n\u0080-\u009f]]/gv,
    "",
  );
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cursor row displacement from a column-zero attempt start, including delayed wrapping. */
export function provisionalRows(text: string, columns: number): number {
  columns = Math.max(1, Math.floor(columns));
  let row = 0,
    column = 0;
  for (const { segment } of graphemes.segment(terminalText(text))) {
    if (segment === "\n") {
      row++;
      column = 0;
      continue;
    }
    if (segment === "\t") {
      column = Math.min(
        columns - 1,
        (Math.floor(Math.min(column, columns - 1) / 8) + 1) * 8,
      );
      continue;
    }
    const width = Math.min(columns, stringWidth(segment));
    if (!width) continue;
    if (column + width > columns) {
      row++;
      column = 0;
    }
    column += width;
  }
  return row;
}

export function replaceProvisional(
  previous: string,
  replacement: string,
  columns: number,
): string {
  const rows = provisionalRows(previous, columns);
  return (
    "\r" + (rows ? `\x1b[${rows}A` : "") + "\x1b[J" + terminalText(replacement)
  );
}
