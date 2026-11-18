import type { Frame } from "./render.js";
import { ansi } from "./text.js";

export const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H";
export const LEAVE = "\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l";

/**
 * The bytes that turn the `previous` rows into `frame`: each changed row is
 * erased and rewritten in place, then the cursor rests at the caret. An
 * unchanged frame writes nothing.
 */
export function paintBytes(
  previous: readonly string[],
  frame: Frame,
  rows: number,
): { bytes: string; painted: string[] } {
  const painted = Array.from({ length: rows }, (_, index) => {
    const row = frame.lines[index];
    return row === undefined ? "" : ansi(row);
  });
  let bytes = "";
  painted.forEach((row, index) => {
    if (previous[index] !== row) bytes += `\x1b[${index + 1};1H\x1b[2K${row}`;
  });
  if (!bytes) return { bytes, painted };
  if (frame.cursor)
    bytes += `\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H`;
  // Synchronized output: terminals that support it show the frame at once.
  return { bytes: `\x1b[?2026h${bytes}\x1b[?2026l`, painted };
}

/** The alternate screen, repainted row by row from the last frame drawn. */
export class Screen {
  private previous: readonly string[] = [];

  constructor(private readonly output: NodeJS.WriteStream) {}

  enter(): void {
    this.output.write(ENTER);
    this.previous = [];
  }

  leave(): void {
    this.output.write(LEAVE);
  }

  /** Forgets what is shown, so the next paint redraws every row. */
  invalidate(): void {
    this.output.write("\x1b[2J");
    this.previous = [];
  }

  paint(frame: Frame, rows: number): void {
    const { bytes, painted } = paintBytes(this.previous, frame, rows);
    this.previous = painted;
    if (bytes) this.output.write(bytes);
  }
}
