import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { serializeNativeSession } from "./native-session-codec.js";
import { selectOrdinaryNativeResumeHistory } from "./native-resume-context.js";
import type { NativeResumeEntryResult } from "./native-resume-entry.js";
import type { NativeSessionOwnership } from "./native-session-ownership.js";
import {
  readNativeTranscriptSource,
  recheckNativeTranscriptSource,
  type NativeTranscriptSourceReceipt,
} from "./native-transcript-source.js";

export interface NativeSessionCopyCommit {
  readonly sessionId: string;
  readonly cursorUuid: string;
  readonly path: string;
  readonly source: NativeTranscriptSourceReceipt;
  readonly sha256: string;
  readonly byteLength: number;
  readonly durability: "file-synced" | "directory-synced";
  readonly cancelledAfterCommit: boolean;
  readonly destination?: NativeTranscriptSourceReceipt;
  readonly stagingPath: string | null;
  readonly issues: readonly { stage: string; message: string }[];
}
export class NativeSessionCopyCommittedError extends Error {
  readonly committed = true;
  constructor(
    readonly receipt: NativeSessionCopyCommit,
    cause: unknown,
  ) {
    super("Native session copy was published but its completion failed", {
      cause,
    });
    this.name = "NativeSessionCopyCommittedError";
  }
}
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const recovery = {
  callIdToolResults: true,
  descendantOrder: "depth-first" as const,
  timestampFallback: "reject" as const,
};

/**
 * Port ownership policy: preserve an admitted external source and publish a
 * distinct exact copy. Native file resume itself can adopt the input directory;
 * this protective copy is not claimed as native's ordinary append algorithm.
 */
export async function copyNativeSessionToOwnedFile(options: {
  imported: {
    native: NativeResumeEntryResult;
    sourceReceipt: NativeTranscriptSourceReceipt;
  };
  path: string;
  ownership: NativeSessionOwnership;
  signal: AbortSignal;
  admit(input: {
    stage: "source" | "publish";
    source: NativeTranscriptSourceReceipt;
    path: string;
    sessionId: string;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  /** Actual owning binding/index notification. Failure cannot undo a published file. */
  onCommitted?(receipt: NativeSessionCopyCommit): void | Promise<void>;
}): Promise<NativeSessionCopyCommit> {
  options.signal.throwIfAborted();
  const { native, sourceReceipt } = options.imported,
    sessionId = native.adoptedSessionId;
  if (
    native.source !== "file" ||
    native.effectiveFork ||
    !sessionId ||
    sessionId !== native.transcriptSessionId ||
    native.transcriptPath !== sourceReceipt.path
  )
    throw new Error(
      "Owned copying requires its actual admitted main file and native identity",
    );
  if (
    !isAbsolute(options.path) ||
    resolve(options.path) !== options.path ||
    basename(options.path) !== `${sessionId}.jsonl` ||
    options.path === sourceReceipt.path
  )
    throw new Error(
      "Owned native destination must be a distinct admitted native session filename",
    );
  const raw = Buffer.from(serializeNativeSession(native.originalDocument)),
    hash = createHash("sha256").update(raw).digest("hex");
  if (hash !== sourceReceipt.sha256 || raw.length !== sourceReceipt.file.bytes)
    throw new Error(
      "Native import document differs from its actual source receipt",
    );
  const selected = selectOrdinaryNativeResumeHistory(
    native.originalDocument,
    recovery,
  );
  if (selected.transcriptSessionId !== sessionId)
    throw new Error(
      "Native copy identity does not match its actual document owner",
    );
  if (selected.checkpoints.some((row) => row.explicit))
    throw new Error(
      "Native copying requires its admitted ordinary checkpoint owner",
    );
  const cursorUuid = selected.terminalUuid;
  let published: NativeSessionCopyCommit | undefined;
  const issues: { stage: string; message: string }[] = [];
  const snapshot = (
    fields: Partial<NativeSessionCopyCommit> = {},
  ): NativeSessionCopyCommit =>
    Object.freeze({
      sessionId,
      cursorUuid,
      path: options.path,
      source: sourceReceipt,
      sha256: hash,
      byteLength: raw.length,
      durability: "file-synced",
      stagingPath: null,
      ...published,
      ...fields,
      cancelledAfterCommit: options.signal.aborted,
      issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
    });
  try {
    return await options.ownership.withExclusiveOwnership(
      options.path,
      async () => {
        const assertAbsent = async () => {
          try {
            await lstat(options.path);
          } catch (error) {
            if (missing(error)) return;
            throw error;
          }
          throw new Error(
            "Native destination already exists; refusing to overwrite or adopt it",
          );
        };
        const admit = async (stage: "source" | "publish") => {
          options.signal.throwIfAborted();
          if (
            !(await options.admit({
              stage,
              source: sourceReceipt,
              path: options.path,
              sessionId,
              signal: options.signal,
            }))
          )
            throw new Error(`Native copy ${stage} admission denied`);
          options.signal.throwIfAborted();
        };
        await admit("source");
        await assertAbsent();
        const currentSource = await recheckNativeTranscriptSource(
          sourceReceipt,
          options.signal,
        );
        if (!currentSource.bytes.equals(raw))
          throw new Error("Admitted native source bytes changed");
        await options.ownership.verifyTransaction(options.path);
        const stagingPath = join(
          dirname(options.path),
          `.${sessionId}.${randomUUID()}.import.tmp`,
        );
        let file: FileHandle | undefined,
          staged = false;
        const removeStaging = async () => {
          if (!file || !staged) return;
          await options.ownership.verifyTransaction(options.path);
          let current;
          try {
            current = await lstat(stagingPath, { bigint: true });
          } catch (error) {
            if (missing(error)) {
              staged = false;
              return;
            }
            throw error;
          }
          const opened = await file.stat({ bigint: true });
          if (
            !current.isFile() ||
            current.dev !== opened.dev ||
            current.ino !== opened.ino ||
            current.size !== opened.size ||
            current.mtimeNs !== opened.mtimeNs ||
            current.ctimeNs !== opened.ctimeNs
          )
            throw new Error("Owned staging identity changed; refusing cleanup");
          await unlink(stagingPath);
          staged = false;
        };
        try {
          options.signal.throwIfAborted();
          file = await open(
            stagingPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          staged = true;
          await options.ownership.verifyTransaction(options.path);
          const created = await file.stat({ bigint: true });
          if (
            String(created.dev) === sourceReceipt.file.device &&
            String(created.ino) === sourceReceipt.file.inode
          )
            throw new Error("Native copy is not a distinct file identity");
          await file.writeFile(raw);
          await file.sync();
          options.signal.throwIfAborted();
          await admit("publish");
          await recheckNativeTranscriptSource(sourceReceipt, options.signal);
          await options.ownership.verifyTransaction(options.path);
          await assertAbsent();
          options.signal.throwIfAborted();
          // link is atomic and refuses an existing destination. The staging link is
          // then retired while this owner still excludes participating writers.
          await link(stagingPath, options.path);
          published = snapshot({ stagingPath });
          await removeStaging();
          const cleanupSignal = new AbortController().signal;
          const target = await readNativeTranscriptSource({
            path: options.path,
            signal: cleanupSignal,
          });
          if (!target.bytes.equals(raw) || target.receipt.file.links !== "1")
            throw new Error(
              "Published native destination differs from its exact owned copy",
            );
          published = snapshot({
            destination: target.receipt,
            stagingPath: null,
          });
          let directory: FileHandle | undefined;
          try {
            directory = await open(
              dirname(options.path),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            await directory.sync();
            published = snapshot({ durability: "directory-synced" });
          } catch (error) {
            issues.push({ stage: "directory-sync", message: message(error) });
          } finally {
            if (directory) await directory.close();
          }
          published = snapshot();
          await options.onCommitted?.(published);
          await recheckNativeTranscriptSource(target.receipt, cleanupSignal);
          published = snapshot({
            cancelledAfterCommit: options.signal.aborted,
          });
          return published;
        } finally {
          if (staged) {
            try {
              await removeStaging();
            } catch (error) {
              issues.push({
                stage: "staging-cleanup",
                message: message(error),
              });
            }
          }
          if (file) await file.close();
        }
      },
    );
  } catch (error) {
    if (published)
      throw new NativeSessionCopyCommittedError(
        snapshot({ cancelledAfterCommit: options.signal.aborted }),
        error,
      );
    if (issues.length)
      throw new AggregateError(
        [
          error,
          ...issues.map(
            (issue) => new Error(`${issue.stage}: ${issue.message}`),
          ),
        ],
        "Native copy failed before publication and staging cleanup needs review",
      );
    throw error;
  }
}
