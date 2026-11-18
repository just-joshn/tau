import { z } from "zod";

export type EditInput = {
  old_string: string;
  new_string: string;
  replace_all: boolean;
};

export const editInputFields = {
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
};

const BOM = "\uFEFF";

function usesCrlf(content: string): boolean {
  const head = content.slice(0, 4096);
  const crlf = head.match(/\r\n/g)?.length ?? 0;
  const lf = head.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > lf;
}

function count(content: string, needle: string): number {
  let found = 0;
  for (
    let at = content.indexOf(needle);
    at >= 0;
    at = content.indexOf(needle, at + needle.length)
  )
    found++;
  return found;
}

function foldQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

type Match = {
  text: string;
  form: "literal" | "quotes" | "decoded" | "encoded";
};

function decodeEscapes(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      if (text[index + 1] === "\\") {
        result += "\\\\";
        index++;
        continue;
      }
      const hex = text.slice(index + 2, index + 6);
      if (text[index + 1] === "u" && /^[\da-fA-F]{4}$/.test(hex)) {
        result += String.fromCharCode(parseInt(hex, 16));
        index += 5;
        continue;
      }
    }
    result += text[index];
  }
  return result;
}

function slashesBefore(text: string, at: number): number {
  let count = 0;
  while (text[at - count - 1] === "\\") count++;
  return count;
}

function encodedMatch(text: string, requested: string): string | undefined {
  if (
    !/[^\x00-\x7f]/.test(requested) ||
    !text.includes("\\u") ||
    slashesBefore(requested, requested.length) % 2
  )
    return;
  let pattern = "",
    length = 0;
  const boundaries = requested.startsWith("\\") ? [0] : [];
  for (let index = 0; index < requested.length; index++) {
    const unit = requested.charCodeAt(index);
    if (unit >= 128) {
      boundaries.push(length);
      pattern +=
        "\\\\u" +
        unit
          .toString(16)
          .padStart(4, "0")
          .replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
      length += 6;
    } else {
      pattern += requested.charAt(index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      length++;
    }
    if (length > text.length) return;
  }
  // Every input character is literal; only fixed-width hex character classes are generated.
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "g");
  } catch {
    return;
  }
  for (
    let match = expression.exec(text);
    match !== null;
    match = expression.exec(text)
  ) {
    if (
      boundaries.every(
        (offset) => slashesBefore(text, match.index + offset) % 2 === 0,
      )
    ) {
      // Avoid selecting a spelling whose earlier occurrence is inside an escaped backslash.
      return text.indexOf(match[0]) === match.index ? match[0] : undefined;
    }
    expression.lastIndex = match.index + 1;
  }
}

function encodeLike(
  replacement: string,
  requested: string,
  matched: string,
): string {
  const spellings = new Map<number, string>();
  let upper = 0,
    lower = 0,
    offset = 0;
  for (let index = 0; index < requested.length; index++) {
    const unit = requested.charCodeAt(index);
    if (unit < 128) {
      offset++;
      continue;
    }
    const hex = matched.slice(offset + 2, offset + 6);
    spellings.set(unit, hex);
    upper += hex.match(/[A-F]/g)?.length ?? 0;
    lower += hex.match(/[a-f]/g)?.length ?? 0;
    offset += 6;
  }
  let encoded = "";
  for (let index = 0; index < replacement.length; index++) {
    const unit = replacement.charCodeAt(index);
    if (unit < 128) {
      encoded += replacement[index];
      continue;
    }
    const hex = unit.toString(16).padStart(4, "0");
    encoded +=
      "\\u" +
      (spellings.get(unit) ?? (upper > lower ? hex.toUpperCase() : hex));
  }
  return encoded;
}

function matchText(text: string, requested: string): Match | undefined {
  if (text.includes(requested)) return { text: requested, form: "literal" };
  const at = foldQuotes(text).indexOf(foldQuotes(requested));
  if (at >= 0)
    return { text: text.slice(at, at + requested.length), form: "quotes" };
  const decoded = decodeEscapes(requested);
  if (decoded !== requested && text.includes(decoded))
    return { text: decoded, form: "decoded" };
  const encoded = encodedMatch(text, requested);
  return encoded === undefined ? undefined : { text: encoded, form: "encoded" };
}

function carryQuotes(replacement: string, matched: string): string {
  const double = /[“”]/.test(matched);
  const single = /[‘’]/.test(matched);
  const characters = [...replacement];
  return characters
    .map((character, index) => {
      const before = characters[index - 1];
      const after = characters[index + 1];
      const opening = before === undefined || /[ \t\r\n([{—–]/.test(before);
      if (double && character === '"') return opening ? "“" : "”";
      if (single && character === "'") {
        if (
          before !== undefined &&
          after !== undefined &&
          /\p{L}/u.test(before) &&
          /\p{L}/u.test(after)
        )
          return "’";
        return opening ? "‘" : "’";
      }
      return character;
    })
    .join("");
}

export function applyEdit(content: string, edit: EditInput): string {
  const { old_string, new_string, replace_all } = edit;
  if (old_string === new_string)
    throw new Error(
      "No changes to make: old_string and new_string are exactly the same.",
    );
  const bom = content.startsWith(BOM) ? BOM : "";
  let text = content.slice(bom.length);
  const crlf = usesCrlf(text);
  text = text.replace(/\r\n/g, "\n");
  const restore = (updated: string) =>
    bom +
    (crlf ? updated.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : updated);
  if (old_string === "") {
    if (text.trim() !== "")
      throw new Error(
        "File already exists with nonempty content; provide old_string to edit it.",
      );
    return restore(new_string);
  }
  const match = matchText(text, old_string);
  if (match === undefined)
    throw new Error(
      `String to replace not found in file.\nString: ${old_string}`,
    );
  const matched = match.text;
  let replacement =
    match.form === "literal" ? new_string : carryQuotes(new_string, matched);
  if (match.form === "decoded") replacement = decodeEscapes(replacement);
  if (match.form === "encoded")
    replacement = encodeLike(replacement, old_string, matched);
  const matches = count(text, matched);
  if (matches > 1 && !replace_all) {
    throw new Error(
      `Found ${matches} matches of the string to replace, but replace_all is false. Set replace_all to true to replace every occurrence, or add surrounding context to make the match unique.\nString: ${old_string}`,
    );
  }
  const target =
    replacement === "" &&
    !matched.endsWith("\n") &&
    text.includes(`${matched}\n`)
      ? `${matched}\n`
      : matched;
  const updated = replace_all
    ? text.split(target).join(replacement)
    : replaceFirst(text, target, replacement);
  return restore(updated);
}

function replaceFirst(
  text: string,
  target: string,
  replacement: string,
): string {
  const at = text.indexOf(target);
  return text.slice(0, at) + replacement + text.slice(at + target.length);
}
