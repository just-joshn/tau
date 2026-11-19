import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface NativeSessionOwnershipOptions {
  /** Existing, canonical, private directory explicitly designated by this owner. */
  directory: string;
  path: string;
  admit(input: {
    stage: "acquire" | "access" | "release";
    path: string;
    lockPath: string;
  }): boolean | Promise<boolean>;
}

export class NativeSessionOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeSessionOwnershipError";
  }
}

const identity = (value: Stats): string =>
  `${value.dev}:${value.ino}:${value.uid}:${value.mode}:${value.nlink}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
const directoryIdentity = (value: Stats): string =>
  `${value.dev}:${value.ino}:${value.uid}:${value.mode}`;

/**
 * A participating port-process lock, held for the entire session owner lifetime.
 * This is a port ownership extension, not a claim about the native append queue.
 * It neither excludes nonparticipating writers nor reclaims stale/foreign locks.
 */
export class NativeSessionOwnership {
  readonly #options: NativeSessionOwnershipOptions;
  readonly #lock: FileHandle;
  readonly #directory: FileHandle;
  readonly #directoryIdentity: string;
  readonly #lockIdentity: string;
  readonly #receipt: Buffer;
  readonly #inside = new AsyncLocalStorage<boolean>();
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #close: Promise<void> | undefined;

  readonly lockPath: string;

  private constructor(
    options: NativeSessionOwnershipOptions,
    directory: FileHandle,
    directoryInfo: Stats,
    lock: FileHandle,
    lockInfo: Stats,
    receipt: Buffer,
  ) {
    this.#options = Object.freeze({ ...options });
    this.#directory = directory;
    this.#directoryIdentity = directoryIdentity(directoryInfo);
    this.#lock = lock;
    this.#lockIdentity = identity(lockInfo);
    this.#receipt = receipt;
    this.lockPath = `${options.path}.lock`;
  }

  static async acquire(
    options: NativeSessionOwnershipOptions,
    signal: AbortSignal,
  ): Promise<NativeSessionOwnership> {
    signal.throwIfAborted();
    const saved = Object.freeze({ ...options });
    if (
      !isAbsolute(saved.directory) ||
      !isAbsolute(saved.path) ||
      resolve(saved.directory) !== saved.directory ||
      resolve(saved.path) !== saved.path ||
      dirname(saved.path) !== saved.directory ||
      saved.path.includes("\0") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(
        saved.path.slice(saved.directory.length + 1),
      )
    )
      throw new NativeSessionOwnershipError(
        "Ownership requires its canonical directory and native session filename",
      );
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new NativeSessionOwnershipError(
        "Native ownership requires its explicit platform lock adapter",
      );
    const lockPath = `${saved.path}.lock`;
    if (!(await saved.admit({ stage: "acquire", path: saved.path, lockPath })))
      throw new NativeSessionOwnershipError(
        "Native ownership acquisition admission denied",
      );
    signal.throwIfAborted();
    const before = await lstat(saved.directory);
    if (
      !before.isDirectory() ||
      before.uid !== uid ||
      (before.mode & 0o077) !== 0 ||
      (await realpath(saved.directory)) !== saved.directory
    )
      throw new NativeSessionOwnershipError(
        "Ownership directory is not the admitted private canonical directory",
      );
    const directory = await open(
      saved.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let lock: FileHandle | undefined;
    try {
      if (
        directoryIdentity(await directory.stat()) !== directoryIdentity(before)
      )
        throw new NativeSessionOwnershipError(
          "Ownership directory changed while opening",
        );
      signal.throwIfAborted();
      try {
        lock = await open(
          lockPath,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        throw new NativeSessionOwnershipError(
          "Session is already owned or requires explicit stale-lock recovery",
          { cause: error },
        );
      }
      const receipt = Buffer.from(
        JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid }) +
          "\n",
      );
      await lock.writeFile(receipt);
      await lock.sync();
      const lockInfo = await lock.stat();
      const owner = new NativeSessionOwnership(
        saved,
        directory,
        before,
        lock,
        lockInfo,
        receipt,
      );
      await owner.#verify();
      signal.throwIfAborted();
      return owner;
    } catch (error) {
      // Only the exact inode created by this acquisition may be removed. Never
      // consume or delete an existing lock to diagnose or recover another owner.
      if (lock) {
        try {
          const current = await lstat(lockPath),
            opened = await lock.stat();
          if (
            current.isFile() &&
            current.nlink === 1 &&
            identity(current) === identity(opened) &&
            directoryIdentity(await lstat(saved.directory)) ===
              directoryIdentity(before) &&
            (await realpath(saved.directory)) === saved.directory
          )
            await unlink(lockPath);
        } catch {
          /* A changed or inaccessible receipt remains for explicit recovery. */
        }
        await lock.close();
      }
      await directory.close();
      throw error;
    }
  }

  async #verify(): Promise<void> {
    const directory = await lstat(this.#options.directory),
      openedDirectory = await this.#directory.stat();
    if (
      !directory.isDirectory() ||
      directoryIdentity(directory) !== this.#directoryIdentity ||
      directoryIdentity(openedDirectory) !== this.#directoryIdentity ||
      (await realpath(this.#options.directory)) !== this.#options.directory
    )
      throw new NativeSessionOwnershipError(
        "Session ownership directory changed",
      );
    const leaf = await lstat(this.lockPath),
      opened = await this.#lock.stat();
    if (
      !leaf.isFile() ||
      leaf.nlink !== 1 ||
      (leaf.mode & 0o777) !== 0o600 ||
      leaf.uid !== directory.uid ||
      identity(leaf) !== this.#lockIdentity ||
      identity(opened) !== this.#lockIdentity
    )
      throw new NativeSessionOwnershipError(
        "Session ownership receipt changed",
      );
    const bytes = Buffer.alloc(this.#receipt.length + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await this.#lock.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (
      !bytes.subarray(0, count).equals(this.#receipt) ||
      identity(await this.#lock.stat()) !== this.#lockIdentity ||
      identity(await lstat(this.lockPath)) !== this.#lockIdentity ||
      directoryIdentity(await lstat(this.#options.directory)) !==
        this.#directoryIdentity
    )
      throw new NativeSessionOwnershipError(
        "Session ownership receipt changed while reading",
      );
  }

  readonly withExclusiveOwnership = <T>(
    path: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (path !== this.#options.path)
      return Promise.reject(
        new NativeSessionOwnershipError(
          "Ownership cannot authorize another transcript",
        ),
      );
    if (this.#closing)
      return Promise.reject(
        new NativeSessionOwnershipError("Session ownership is closing"),
      );
    if (this.#inside.getStore())
      return Promise.reject(
        new NativeSessionOwnershipError(
          "Recursive ownership access requires an explicit transaction",
        ),
      );
    const run = this.#tail.then(async () => {
      await this.#verify();
      if (
        !(await this.#options.admit({
          stage: "access",
          path,
          lockPath: this.lockPath,
        }))
      )
        throw new NativeSessionOwnershipError(
          "Native ownership access admission denied",
        );
      await this.#verify();
      let result: T;
      try {
        result = await this.#inside.run(true, work);
      } catch (error) {
        try {
          await this.#verify();
        } catch (guard) {
          throw new AggregateError(
            [error, guard],
            "Native transaction failed and its ownership changed",
          );
        }
        throw error;
      }
      await this.#verify();
      return result;
    });
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  /** Recheck the same accepted transaction before publication or owned cleanup. */
  async verifyTransaction(path: string): Promise<void> {
    if (path !== this.#options.path || !this.#inside.getStore())
      throw new NativeSessionOwnershipError(
        "An active transaction for this transcript is required",
      );
    await this.#verify();
  }

  /** Close after the journal/append owner has drained, then retire only this receipt. */
  close(): Promise<void> {
    if (this.#inside.getStore())
      return Promise.reject(
        new NativeSessionOwnershipError(
          "Ownership cannot close inside its active transaction",
        ),
      );
    if (this.#close) return this.#close;
    this.#closing = true;
    this.#close = this.#tail.then(async () => {
      try {
        await this.#verify();
        if (
          !(await this.#options.admit({
            stage: "release",
            path: this.#options.path,
            lockPath: this.lockPath,
          }))
        )
          throw new NativeSessionOwnershipError(
            "Native ownership release admission denied",
          );
        await this.#verify();
        await unlink(this.lockPath);
        if ((await this.#lock.stat()).nlink !== 0)
          throw new NativeSessionOwnershipError(
            "Ownership receipt remains linked after release",
          );
      } finally {
        try {
          await this.#lock.close();
        } finally {
          await this.#directory.close();
        }
      }
    });
    return this.#close;
  }
}
