import path from "node:path";
import { ReadState } from "./read-state.js";
import { renderReadView } from "./read.js";
import { decodeTextFile } from "./text-file.js";
import { estimateFileTokens } from "./file-read.js";
export { estimateFileTokens } from "./file-read.js";
import type { Message, PrepareCompaction } from "./types.js";

const FILE_LIMIT = 5,
  FILE_TOKENS = 5000,
  TOTAL_TOKENS = 50000;

function retainedReads(messages: Message[], cwd: string): Set<string> {
  const omitted = new Set(
    messages.flatMap((message) =>
      message.role === "user"
        ? message.content.flatMap((block) =>
            block.type === "tool_result" && block.readContentOmitted
              ? [block.tool_use_id]
              : [],
          )
        : [],
    ),
  );
  const paths = new Set<string>();
  for (const message of messages)
    if (message.role === "assistant")
      for (const block of message.content) {
        if (
          block.type !== "tool_use" ||
          block.name !== "Read" ||
          omitted.has(block.id) ||
          !block.input ||
          typeof block.input !== "object" ||
          !("file_path" in block.input) ||
          typeof block.input.file_path !== "string"
        )
          continue;
        paths.add(path.resolve(cwd, block.input.file_path));
      }
  return paths;
}

/** Reread candidates into an isolated cache. Only the caller's history commit publishes it. */
export async function prepareFileRestoration(
  options: Parameters<PrepareCompaction>[0] & {
    cwd: string;
    state: ReadState;
    excludedPaths: string[];
    read(
      file: string,
      signal: AbortSignal,
    ): Promise<{ bytes: Buffer; mtimeMs: number; truncated: boolean }>;
  },
): ReturnType<PrepareCompaction> {
  const { signal } = options;
  signal.throwIfAborted();
  const excluded = new Set([
    ...options.excludedPaths.map((file) => path.resolve(options.cwd, file)),
    ...retainedReads(options.keptMessages, options.cwd),
  ]);
  const candidates = options.state
    .candidates()
    .filter(
      ({ file }) =>
        !excluded.has(file) &&
        !(
          path.basename(file).toLowerCase().startsWith("artifact-") &&
          path.basename(path.dirname(file)).toLowerCase() === "tool-results"
        ),
    )
    .slice(0, FILE_LIMIT);
  const results = await Promise.all(
    candidates.map(async ({ file }) => {
      try {
        const data = await options.read(file, signal);
        signal.throwIfAborted();
        const view = renderReadView({
          input: { file_path: file, offset: 1 },
          bytes: data.bytes,
          truncated: data.truncated,
        });
        const text = decodeTextFile(data.bytes, data.truncated)
          .text.replace(/\r\n/g, "\n")
          .replace(/\r$/, "");
        let tokens = estimateFileTokens(text, file);
        if (
          !data.truncated &&
          tokens > FILE_TOKENS / 4 &&
          options.countTokens
        ) {
          try {
            const counted = await options.countTokens(text);
            if (
              counted !== undefined &&
              Number.isSafeInteger(counted) &&
              counted >= 0
            )
              tokens = counted;
          } catch {
            signal.throwIfAborted(); /* Source falls back to the text estimate when counting fails. */
          }
        }
        signal.throwIfAborted();
        const reference = data.truncated || tokens > FILE_TOKENS;
        const attachment = reference
          ? { kind: "reference" as const, path: file }
          : { kind: "text" as const, path: file, text };
        const message: Message = {
          role: "user",
          restoredFile: {
            path: file,
            kind: attachment.kind,
            timestamp: Math.floor(data.mtimeMs),
          },
          content: [
            {
              type: "text",
              text: reference
                ? `File reference after context compaction: ${file}\nContents exceeded the restoration limit. Use Read to inspect the file.`
                : `Restored file after context compaction: ${file}\n${view.content}`,
            },
          ],
        };
        return {
          file,
          data,
          message,
          complete: !reference && view.complete,
          cost: Math.round(JSON.stringify(attachment).length / 4),
        };
      } catch {
        signal.throwIfAborted();
        return undefined;
      }
    }),
  );
  const next = new ReadState(),
    messages: Message[] = [];
  let total = 0;
  for (const result of results) {
    if (!result || total + result.cost > TOTAL_TOKENS) continue;
    total += result.cost;
    messages.push(result.message);
    if (result.complete)
      next.remember(result.file, result.data.bytes, result.data.mtimeMs);
    else next.rememberPartial(result.file, result.data.mtimeMs);
  }
  signal.throwIfAborted();
  return { messages, commit: () => options.state.replaceFrom(next) };
}
