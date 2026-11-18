const NAMED = [
  "enter",
  "newline",
  "backspace",
  "delete",
  "tab",
  "shift-tab",
  "escape",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "ctrl-c",
  "ctrl-d",
  "ctrl-k",
  "ctrl-u",
  "ctrl-w",
] as const;
type Named = (typeof NAMED)[number];

/** A decoded keystroke. `text` is printable input, `paste` a bracketed paste. */
export type Key =
  | { kind: "text"; text: string }
  | { kind: "paste"; text: string }
  | { kind: Named };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CONTROL: Readonly<Record<string, Named>> = {
  "\r": "enter",
  "\n": "newline",
  "\x7f": "backspace",
  "\b": "backspace",
  "\t": "tab",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x01": "home",
  "\x05": "end",
  "\x0b": "ctrl-k",
  "\x15": "ctrl-u",
  "\x17": "ctrl-w",
  "\x02": "left",
  "\x06": "right",
  "\x10": "up",
  "\x0e": "down",
};

/** Final byte (with parameters, for `~` forms) of a CSI or SS3 sequence. */
const SEQUENCE: Readonly<Record<string, Named>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift-tab",
  "1~": "home",
  "7~": "home",
  "4~": "end",
  "8~": "end",
  "3~": "delete",
};

/** A CSI or SS3 sequence after its ESC. */
const CSI = /^(?:\[([0-9;:<=>?]*)([ -/]*)([@-~])|O([A-Za-z]))/;
const INCOMPLETE = /^(?:O|\[[0-9;:<=>?]*[ -/]*)$/;

export interface Decoded {
  keys: Key[];
  /** An incomplete trailing sequence to prepend to the next chunk. */
  rest: string;
}

/**
 * Splits raw terminal input into keys. Unknown escape sequences (focus and
 * mouse reports, terminal replies) are dropped. A lone ESC at the end of a
 * chunk is the Escape key: terminals send whole sequences in one write.
 */
export function decodeKeys(input: string): Decoded {
  const keys: Key[] = [];
  let text = "";
  const flush = () => {
    if (text) keys.push({ kind: "text", text });
    text = "";
  };
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END);
      if (end < 0) {
        flush();
        return { keys, rest };
      }
      flush();
      keys.push({
        kind: "paste",
        text: rest.slice(PASTE_START.length, end).replace(/\r\n?/g, "\n"),
      });
      index += end + PASTE_END.length;
      continue;
    }
    const char = rest.charAt(0);
    if (char === "\x1b") {
      flush();
      if (rest.length === 1) {
        keys.push({ kind: "escape" });
        index++;
        continue;
      }
      if (rest[1] === "\r") {
        keys.push({ kind: "newline" });
        index += 2;
        continue;
      }
      const match = CSI.exec(rest.slice(1));
      if (match === null) {
        if (INCOMPLETE.test(rest.slice(1))) return { keys, rest };
        keys.push({ kind: "escape" });
        index++;
        continue;
      }
      const [whole, params = "", , final, ss3] = match;
      const named =
        ss3 === undefined
          ? (SEQUENCE[final === "~" ? `${params}~` : (final ?? "")] ??
            undefined)
          : SEQUENCE[ss3];
      if (named !== undefined && (ss3 !== undefined || !params.includes("<")))
        keys.push({ kind: named });
      index += 1 + whole.length;
      continue;
    }
    const control = CONTROL[char];
    if (control !== undefined) {
      flush();
      keys.push({ kind: control });
      index++;
      continue;
    }
    if (char < " ") {
      index++;
      continue;
    }
    text += char;
    index++;
  }
  flush();
  return { keys, rest: "" };
}
