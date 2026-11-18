import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Replace `file` by renaming a fully written sibling temp file over it. */
export async function writeAtomic(file: string, data: string | Buffer, beforeCommit?: () => Promise<void>, operations: {
  rename(source: string, destination: string): Promise<void>;
} = { rename }): Promise<number> {
  let mode = 0o666;
  let existing = false;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("Refusing to write through a symlink");
    if (!info.isFile()) throw new Error("Not a regular file");
    mode = info.mode & 0o7777; existing = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try {
      if (existing) await handle.chmod(mode);
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    await beforeCommit?.();
    await operations.rename(temp, file);
    const saved = await lstat(file), expected = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    if (!saved.isFile() || saved.size !== expected) throw new Error(`Write verification failed: saved file has ${saved.size} bytes; expected ${expected}. Read it again before retrying.`);
    return Math.floor(saved.mtimeMs);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
