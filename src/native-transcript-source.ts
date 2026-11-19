import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface NativeTranscriptFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly links: string;
  readonly mode: string;
  readonly uid: string;
  readonly bytes: number;
  readonly modifiedNs: string;
  readonly changedNs: string;
}
export interface NativeTranscriptSourceIdentity {
  readonly path: string;
  readonly parent: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly file: NativeTranscriptFileIdentity;
}
export interface NativeTranscriptSourceReceipt extends NativeTranscriptSourceIdentity {
  readonly sha256: string;
}
export interface NativeTranscriptSourceSnapshot {
  /** Caller-owned raw bytes. Mutating these cannot change the file or receipt. */
  readonly bytes: Buffer;
  readonly receipt: NativeTranscriptSourceReceipt;
}
export class NativeTranscriptSourceError extends Error {
  constructor(
    message: string,
    readonly observation?: Readonly<{
      stage: "before-content" | "after-content" | "recheck";
      contentRead: boolean;
      expected: NativeTranscriptSourceIdentity | NativeTranscriptSourceReceipt;
      observed?: NativeTranscriptSourceIdentity | NativeTranscriptSourceReceipt;
    }>,
  ) {
    super(message);
    this.name = "NativeTranscriptSourceError";
  }
}
const fileIdentity = (value: BigIntStats): NativeTranscriptFileIdentity =>
  Object.freeze({
    device: String(value.dev),
    inode: String(value.ino),
    links: String(value.nlink),
    mode: String(value.mode),
    uid: String(value.uid),
    bytes: Number(value.size),
    modifiedNs: String(value.mtimeNs),
    changedNs: String(value.ctimeNs),
  });
const parentIdentity = (
  path: string,
  value: BigIntStats,
): NativeTranscriptSourceIdentity["parent"] =>
  Object.freeze({ path, device: String(value.dev), inode: String(value.ino) });

/**
 * Bounded, readonly explicit-source capture. This does not discover sessions or
 * establish write/account ownership. Readonly source hardlinks remain distinct
 * from the writable destination's single-link policy.
 */
export async function readNativeTranscriptSource(options: {
  path: string;
  signal: AbortSignal;
  maxBytes?: number;
  /** Optional actual identity admission, after safe open and before any content read. */
  admitOpened?(
    identity: NativeTranscriptSourceIdentity,
  ): boolean | Promise<boolean>;
}): Promise<NativeTranscriptSourceSnapshot> {
  options.signal.throwIfAborted();
  if (
    !isAbsolute(options.path) ||
    resolve(options.path) !== options.path ||
    options.path.includes("\0")
  )
    throw new TypeError(
      "An explicit normalized absolute native transcript path is required",
    );
  const limit = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024)
    throw new RangeError("Invalid native transcript source byte bound");
  const parentPath = await realpath(dirname(options.path)),
    parent = await stat(parentPath, { bigint: true });
  const before = await lstat(options.path, { bigint: true });
  if (!parent.isDirectory() || !before.isFile() || before.size > BigInt(limit))
    throw new NativeTranscriptSourceError(
      "Native transcript must be a regular file within its admitted byte bound",
    );
  const expected: NativeTranscriptSourceIdentity = Object.freeze({
    path: options.path,
    parent: parentIdentity(parentPath, parent),
    file: fileIdentity(before),
  });
  const file = await open(
    options.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const inspect = async (contentRead: boolean): Promise<void> => {
      const current = await lstat(options.path, { bigint: true }),
        opened = await file.stat({ bigint: true });
      const currentParentPath = await realpath(dirname(options.path)),
        currentParent = await stat(currentParentPath, { bigint: true });
      const observed: NativeTranscriptSourceIdentity = Object.freeze({
        path: options.path,
        parent: parentIdentity(currentParentPath, currentParent),
        file: fileIdentity(current),
      });
      if (
        !current.isFile() ||
        !opened.isFile() ||
        !currentParent.isDirectory() ||
        !isDeepStrictEqual(observed, expected) ||
        !isDeepStrictEqual(fileIdentity(opened), expected.file)
      )
        throw new NativeTranscriptSourceError(
          "Native transcript changed while loading",
          {
            stage: contentRead ? "after-content" : "before-content",
            contentRead,
            expected,
            observed,
          },
        );
    };
    await inspect(false);
    if (options.admitOpened && !(await options.admitOpened(expected)))
      throw new NativeTranscriptSourceError(
        "Native transcript identity admission denied",
        { stage: "before-content", contentRead: false, expected },
      );
    options.signal.throwIfAborted();
    await inspect(false);
    const buffer = Buffer.alloc(expected.file.bytes + 1);
    let size = 0;
    while (size < buffer.length) {
      options.signal.throwIfAborted();
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    options.signal.throwIfAborted();
    await inspect(true);
    if (size !== expected.file.bytes)
      throw new NativeTranscriptSourceError(
        "Native transcript length changed while loading",
        { stage: "after-content", contentRead: true, expected },
      );
    const bytes = buffer.subarray(0, size),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    return Object.freeze({
      bytes,
      receipt: Object.freeze({ ...expected, sha256 }),
    });
  } finally {
    await file.close();
  }
}

/** Re-read the same explicit source; identical bytes in a replacement inode are not the same receipt. */
export async function recheckNativeTranscriptSource(
  expected: NativeTranscriptSourceReceipt,
  signal: AbortSignal,
): Promise<NativeTranscriptSourceSnapshot> {
  const observed = await readNativeTranscriptSource({
    path: expected.path,
    signal,
    admitOpened: (identity) => {
      const { sha256: _digest, ...admittedIdentity } = expected;
      if (!isDeepStrictEqual(identity, admittedIdentity))
        throw new NativeTranscriptSourceError(
          "Native transcript source no longer matches its admitted receipt",
          {
            stage: "before-content",
            contentRead: false,
            expected,
            observed: identity,
          },
        );
      return true;
    },
  });
  if (!isDeepStrictEqual(observed.receipt, expected))
    throw new NativeTranscriptSourceError(
      "Native transcript source no longer matches its admitted receipt",
      {
        stage: "recheck",
        contentRead: true,
        expected,
        observed: observed.receipt,
      },
    );
  return observed;
}
