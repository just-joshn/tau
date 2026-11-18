import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_EDIT_BYTES = 1073741824;
export const MAX_UNSIZED_FILE_BYTES = 10485760;
const changed = () => new Error("File content changed before write; Read it again before retrying");

/** Read the complete regular-file snapshot used for mutation, independently of Read's display limits. */
export async function readFileSnapshot(file: string, signal: AbortSignal, options: {
  maximum?: number;
  requireRead?: () => void;
  expected?: Buffer | null;
} = {}): Promise<Buffer | null> {
  signal.throwIfAborted();
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Not a regular file");
    if (options.maximum !== undefined && info.size > options.maximum) throw new Error(`File exceeds the ${options.maximum}-byte Edit limit`);
    if ("expected" in options && (options.expected === null || info.size !== options.expected?.length)) throw changed();
    options.requireRead?.();
    let bytes: Buffer;
    if (info.size > 0) bytes = await handle.readFile({ signal });
    else {
      // Some regular virtual files report zero size. The original has a separate10MiB guard.
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(65536, MAX_UNSIZED_FILE_BYTES + 8 - total));
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        total += read.bytesRead;
        if (total > MAX_UNSIZED_FILE_BYTES) throw new Error(`A file reporting zero size exceeds ${MAX_UNSIZED_FILE_BYTES} bytes`);
        chunks.push(buffer.subarray(0, read.bytesRead));
      }
      bytes = Buffer.concat(chunks, total);
    }
    signal.throwIfAborted();
    if ("expected" in options && !bytes.equals(options.expected)) throw changed();
    return bytes;
  } finally { await handle.close(); }
}
