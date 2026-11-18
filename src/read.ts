import { z } from "zod";
import { decodeTextFile } from "./text-file.js";

export const readInputSchema = z.strictObject({
  file_path: z.string().min(1).max(4096).refine(value => !value.includes("\0"), "Read path cannot contain NUL bytes"),
  offset: z.number().int().nonnegative().default(1),
  limit: z.number().int().positive().optional(),
  allow_large: z.boolean().optional(),
});
type ReadInput = z.infer<typeof readInputSchema>;

export function renderRead(options: { input: ReadInput; bytes: Buffer; truncated: boolean }): string {
  return renderReadView(options).content;
}

/** Completeness describes the actual model-facing output, before the shared output cap. */
export function renderReadView(options: { input: ReadInput; bytes: Buffer; truncated: boolean }): { content: string; complete: boolean } {
  const { input, bytes, truncated } = options;
  const { text } = decodeTextFile(bytes, truncated);
  const header = text.slice(0, 12);
  if (text.includes("\0") || header.startsWith("%PDF-") || header.startsWith("GIF87a") || header.startsWith("GIF89a") || (header.startsWith("RIFF") && header.slice(8) === "WEBP")) {
    throw new Error("Read supports regular text only; binary/media data is unsupported");
  }
  const lines = text.replace(/\r\n/g, "\n").replace(/\r$/, "").split("\n");
  if (truncated && lines.at(-1) === "") lines.pop();
  const first = input.offset === 0 ? 0 : input.offset - 1;
  if (first >= lines.length) {
    if (truncated) throw new Error("Read offset is beyond the bounded file prefix; later lines were not scanned");
    return { content: `[end of file: requested offset ${input.offset}; file has ${lines.length} lines]`, complete: false };
  }
  const selected = lines.slice(first, input.limit === undefined ? undefined : first + input.limit);
  const content = lines.length === 1 && lines[0] === "" ? "[empty file]" : selected.map((line, index) => `${input.offset + index}\t${line}`).join("\n");
  return {
    content: (truncated ? `[read truncated: only first ${bytes.length} bytes inspected; prefix may end mid-line]\n` : "") + content,
    complete: !truncated && first === 0 && !text.endsWith("\r") && (input.limit === undefined || (text !== "" && lines.length < input.limit)),
  };
}
