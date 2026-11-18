import { TextDecoder } from "node:util";

export type TextFile = { text: string; encoding: "utf8" | "utf16le"; bom: boolean };

/** Detect only unambiguous encodings: UTF-8, or UTF-16LE with its byte-order mark. */
export function decodeTextFile(bytes: Buffer, truncated = false): TextFile {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) throw new Error("UTF-16BE text is unsupported; use UTF-8 or BOM-marked UTF-16LE");
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8";
  const bom = encoding === "utf16le" || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  try {
    const text = new TextDecoder(encoding === "utf8" ? "utf-8" : "utf-16le", { fatal: true }).decode(bytes, { stream: truncated });
    return { text, encoding, bom };
  } catch {
    throw new Error("Invalid text encoding; use UTF-8 or BOM-marked UTF-16LE");
  }
}

/** Keep an existing encoding/BOM, except that an empty replacement is zero bytes. */
export function encodeTextFile(text: string, previous?: TextFile): Buffer {
  const content = previous?.bom && text !== "" && !text.startsWith("\uFEFF") ? "\uFEFF" + text : text;
  const bytes = Buffer.from(content, previous?.encoding ?? "utf8");
  // UTF-16 can otherwise persist lone surrogates and fail only after committing the file.
  if (previous?.encoding === "utf16le") {
    try { new TextDecoder("utf-16le", { fatal: true }).decode(bytes); }
    catch { throw new Error("Replacement contains invalid Unicode"); }
  }
  return bytes;
}
