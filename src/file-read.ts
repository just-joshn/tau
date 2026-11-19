import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { integerSetting } from "./env-settings.js";
import {
  readAllowance,
  type ReadAllowance,
  type ReadToolContext,
} from "./context-room.js";

export const FILE_READ_BYTES = 262144,
  DEFAULT_FILE_READ_TOKENS = 25000;
export interface TextSelection {
  text: string;
  lineCount: number;
  totalLines: number;
  mtimeMs: number;
  endsWithCR: boolean;
}
export interface ReadWindow {
  offset: number;
  limit?: number | undefined;
  allow_large?: boolean | undefined;
}
export type FileTokenCounter = (
  text: string,
  signal: AbortSignal,
) => Promise<number | undefined>;
export const fileReadTokenLimit = (
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const configured = integerSetting(
    env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS,
  );
  return configured !== undefined && configured > 0
    ? configured
    : DEFAULT_FILE_READ_TOKENS;
};
export const estimateFileTokens = (text: string, filename: string): number =>
  Math.round(
    text.length /
      ([".json", ".jsonl", ".jsonc"].includes(
        path.extname(filename).toLowerCase(),
      )
        ? 2
        : 4),
  );

export class FileReadTokenLimit extends Error {
  constructor(
    readonly tokens: number,
    readonly maximum: number,
  ) {
    super(
      `Selected text requires ${tokens} tokens; Read allows ${maximum}. Use a smaller line range or Grep.`,
    );
    this.name = "FileReadTokenLimit";
  }
}

export async function checkFileTokens(
  text: string,
  filename: string,
  maximum: number,
  whole: boolean,
  signal: AbortSignal,
  count?: FileTokenCounter,
  raised = false,
): Promise<number> {
  signal.throwIfAborted();
  let tokens = estimateFileTokens(text, filename);
  if (raised) tokens = Math.max(tokens, Math.ceil(Buffer.byteLength(text) / 2));
  if (tokens > maximum / 4) {
    if (!whole && text.length > maximum * 128)
      throw new FileReadTokenLimit(tokens, maximum);
    if (count) {
      try {
        const actual = await count(text, signal);
        if (actual !== undefined && Number.isSafeInteger(actual) && actual >= 0)
          tokens = actual;
      } catch {
        signal.throwIfAborted();
      }
    }
  }
  signal.throwIfAborted();
  if (tokens > maximum) throw new FileReadTokenLimit(tokens, maximum);
  return tokens;
}

export class FileReadByteLimit extends Error {
  constructor(
    readonly bytes: number,
    readonly maximum: number,
    readonly selected: boolean,
  ) {
    super(
      selected
        ? `Selected line range exceeds ${maximum} bytes. Use a smaller limit or Grep.`
        : `File exceeds the ${maximum}-byte whole-file Read limit. Use offset and limit.`,
    );
    this.name = "FileReadByteLimit";
  }
}

export function largeReadHint(
  context: ReadToolContext | undefined,
  optedIn: boolean,
  baseTokens: number,
  failure: { bytes?: number; tokens?: number },
): string {
  const allowance = readAllowance(context, baseTokens, FILE_READ_BYTES);
  if (allowance.roomTokens === undefined)
    return optedIn
      ? " Large reads are unavailable in this tool context; use a smaller range."
      : "";
  const raised = allowance.raised;
  if (
    optedIn ||
    !raised ||
    (failure.bytes !== undefined && failure.bytes > raised.maxSizeBytes) ||
    (failure.tokens !== undefined && failure.tokens > raised.maxTokens)
  )
    return " This exceeds the available context room for Read; use a smaller range.";
  return " Retry with allow_large: true to use the available context room.";
}

/** Scan a regular file completely, retaining only the requested normalized lines. */
export async function selectTextFile(
  handle: FileHandle,
  input: ReadWindow,
  signal: AbortSignal,
  maxTokens: number,
  raisedBytes?: number,
): Promise<TextSelection> {
  signal.throwIfAborted();
  const info = await handle.stat();
  if (!info.isFile()) throw new Error("Read requires a regular file");
  const wholeBytes = raisedBytes ?? FILE_READ_BYTES;
  if (input.limit === undefined && info.size > wholeBytes)
    throw new FileReadByteLimit(info.size, wholeBytes, false);
  const first = Math.max(0, input.offset - 1),
    last = input.limit === undefined ? Infinity : first + input.limit;
  const maxSelectedBytes =
    input.limit === undefined
      ? undefined
      : Math.max(maxTokens * 128, raisedBytes ?? 0);
  const selected: string[] = [];
  let selectedBytes = 0,
    index = 0,
    partial = "",
    header = "",
    endsWithCR = false;
  let decoder: TextDecoder | undefined,
    position = 0,
    probe: Buffer | undefined;
  const append = (line: string) => {
    if (index >= first && index < last) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      selectedBytes +=
        Buffer.byteLength(normalized) + (selected.length ? 1 : 0);
      if (maxSelectedBytes !== undefined && selectedBytes > maxSelectedBytes)
        throw new FileReadByteLimit(selectedBytes, maxSelectedBytes, true);
      selected.push(normalized);
    }
    index++;
  };
  const accept = (text: string) => {
    if (!text) return;
    endsWithCR = text.endsWith("\r");
    if (text.includes("\0"))
      throw new Error(
        "Read supports regular text only; binary/media data is unsupported",
      );
    if (header.length < 12) {
      header = (header + text).slice(0, 12);
      if (
        header.startsWith("%PDF-") ||
        header.startsWith("GIF87a") ||
        header.startsWith("GIF89a") ||
        (header.startsWith("RIFF") && header.slice(8) === "WEBP")
      )
        throw new Error(
          "Read supports regular text only; binary/media data is unsupported",
        );
    }
    let start = 0,
      end: number;
    while ((end = text.indexOf("\n", start)) >= 0) {
      append(partial + text.slice(start, end));
      partial = "";
      start = end + 1;
    }
    // Discard skipped line bodies immediately; preserve only a trailing CR for normalization.
    const tail = text.slice(start);
    if (index >= first && index < last) {
      partial += tail;
      if (
        maxSelectedBytes !== undefined &&
        selectedBytes + (selected.length ? 1 : 0) + Buffer.byteLength(partial) >
          maxSelectedBytes
      )
        throw new FileReadByteLimit(
          selectedBytes +
            (selected.length ? 1 : 0) +
            Buffer.byteLength(partial),
          maxSelectedBytes,
          true,
        );
    } else partial = tail.endsWith("\r") ? "\r" : "";
  };
  const buffer = Buffer.alloc(524288);
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await handle.read(buffer, 0, buffer.length, position);
      if (!next.bytesRead) break;
      position += next.bytesRead;
      if (input.limit === undefined && position > wholeBytes)
        throw new FileReadByteLimit(position, wholeBytes, false);
      let bytes = buffer.subarray(0, next.bytesRead);
      if (!decoder) {
        if (probe) {
          bytes = Buffer.concat([probe, bytes]);
          probe = undefined;
        }
        if (bytes.length < 2) {
          probe = Buffer.from(bytes);
          continue;
        }
        if (bytes[0] === 0xfe && bytes[1] === 0xff)
          throw new Error(
            "UTF-16BE text is unsupported; use UTF-8 or BOM-marked UTF-16LE",
          );
        decoder = new TextDecoder(
          bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8",
          { fatal: true },
        );
      }
      accept(decoder.decode(bytes, { stream: true }));
    }
    if (probe) {
      decoder = new TextDecoder("utf-8", { fatal: true });
      accept(decoder.decode(probe, { stream: true }));
    }
    if (decoder) accept(decoder.decode());
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(
        "Invalid text encoding; use UTF-8 or BOM-marked UTF-16LE",
      );
    throw error;
  }
  append(partial);
  signal.throwIfAborted();
  return {
    text: selected.join("\n"),
    lineCount: selected.length,
    totalLines: index,
    mtimeMs: info.mtimeMs,
    endsWithCR,
  };
}

/** Source-derived adaptive paging; wording and formatting are independently authored. */
export function tokenPage(
  text: string,
  tokens: number,
  maximum: number,
): { text: string; lines: number; byCharacters: boolean } {
  const lines = text.split("\n"),
    ratio = Math.max(0.5, text.length / Math.max(1, tokens));
  let count = Math.max(
    1,
    Math.min(
      lines.length,
      Math.floor(((lines.length * maximum) / Math.max(1, tokens)) * 0.85),
    ),
  );
  let content = lines.slice(0, count).join("\n");
  for (let i = 0; i < 6 && content.length / ratio > maximum && count > 1; i++) {
    count = Math.max(1, Math.floor(count * 0.7));
    content = lines.slice(0, count).join("\n");
  }
  const byCharacters = content.length / ratio > maximum || !content.trim();
  if (byCharacters) {
    let length = Math.max(1, Math.floor(maximum * ratio * 0.85));
    for (let i = 0; i < 6; i++) {
      content = text.slice(0, length);
      if (content.length / ratio <= maximum) break;
      length = Math.max(1, Math.floor(length * 0.7));
    }
    const last = content.charCodeAt(content.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) content = content.slice(0, -1);
    count = content.split("\n").length;
  }
  return { text: content, lines: count, byCharacters };
}

export async function renderSelectedText(
  selection: TextSelection,
  input: ReadWindow,
  filename: string,
  maxTokens: number,
  signal: AbortSignal,
  count?: FileTokenCounter,
  large?: { initial: ReadAllowance; context: ReadToolContext | undefined },
): Promise<{ content: string; complete: boolean; baseline: string }> {
  const whole = input.offset <= 1 && input.limit === undefined;
  let text = selection.text,
    start = input.offset,
    notice = "",
    paged = false;
  try {
    const raised = large?.initial.raised;
    const measuredText =
      raised && text
        ? text
            .split("\n")
            .map((line, i) => `${Math.max(1, input.offset) + i}\t${line}`)
            .join("\n")
        : text;
    const tokens = await checkFileTokens(
      measuredText,
      filename,
      raised?.maxTokens ?? maxTokens,
      whole,
      signal,
      count,
      raised !== undefined,
    );
    if (raised && tokens > 0) {
      const current =
        readAllowance(large?.context, maxTokens, FILE_READ_BYTES).raised
          ?.maxTokens ?? maxTokens;
      if (tokens > current) throw new FileReadTokenLimit(tokens, current);
      large?.context?.room?.claim(tokens);
    }
  } catch (error) {
    if (!(error instanceof FileReadTokenLimit) || !whole) throw error;
    const page = tokenPage(text, error.tokens, maxTokens);
    text = page.text;
    start = Math.max(1, start);
    paged = true;
    notice =
      page.byCharacters || page.lines >= selection.totalLines
        ? `[Read truncated by token limit: first ${text.length} of ${selection.text.length} characters; ${selection.totalLines} total lines. Use Grep or a narrower Read range.]\n`
        : `[Read truncated by token limit: lines 1-${page.lines} of ${selection.totalLines}. Continue with offset=${page.lines + 1} limit=${page.lines}, or use Grep.]\n`;
    notice += largeReadHint(
      large?.context,
      input.allow_large === true,
      maxTokens,
      { tokens: error.tokens },
    );
    if (!notice.endsWith("\n")) notice += "\n";
  }
  const complete =
    !paged &&
    input.offset <= 1 &&
    !selection.endsWithCR &&
    (input.limit === undefined ||
      (text !== "" && selection.lineCount < input.limit));
  const content =
    selection.lineCount === 0
      ? `[end of file: requested offset ${input.offset}; file has ${selection.totalLines} lines]`
      : selection.totalLines === 1 && text === ""
        ? "[empty file]"
        : text
            .split("\n")
            .map((line, index) => `${start + index}\t${line}`)
            .join("\n");
  return { content: notice + content, complete, baseline: text };
}
