import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { selectOrdinaryNativeResumeHistory } from "./native-resume-context.js";
import {
  appendNativeSessionRows,
  decodeNativeSession,
  isNativeArray,
  isNativeObject,
  type NativeSessionDocument,
} from "./native-session-codec.js";
import {
  createNativeSessionWriter,
  envelopeNativeWriterEntries,
  planNativeMessageEntries,
  type NativeMessageIdentity,
  type NativeSessionWriter,
  type NativeSessionWriterOptions,
  type NativeWriterBatch,
  type NativeWriterCommit,
  type NativeWriterContext,
  type NativeWriterEntry,
} from "./native-session-writer.js";
import type { Message } from "./types.js";
import { captureNativePersistenceEvents } from "./native-persistence-events.js";

export interface NativeSessionPersistenceOptions extends NativeSessionWriterOptions {
  /** A foreign/import source is never adopted implicitly as a writable destination. */
  initial:
    | { kind: "fresh" }
    | {
        kind: "owned-existing";
        cursorUuid: string;
        /** Exact persisted binding when reopening a previously saved owned file. */
        expected?: { byteLength: number; sha256: string };
      };
}
export interface NativeSessionPersistenceState {
  cursorUuid: string | null;
  byteLength: number;
  sha256: string;
  transcriptUuids: readonly string[];
}
export type NativePersistenceBatch = Omit<
  NativeWriterBatch,
  "parentUuid" | "checkpoint"
>;
interface Snapshot {
  bytes: Buffer;
  exists: boolean;
  document: NativeSessionDocument;
}
const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const noEntry = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const recovery = {
  callIdToolResults: true,
  descendantOrder: "depth-first" as const,
  timestampFallback: "reject" as const,
};

/** Capture caller-owned plain inputs before asynchronous ownership work. */
function detached<T>(value: T): T {
  const active = new Set<object>();
  const inspect = (item: unknown): void => {
    if (
      item === null ||
      item === undefined ||
      typeof item === "string" ||
      typeof item === "boolean"
    )
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || active.has(item))
      throw new TypeError("Persistence input requires finite plain JSON");
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new TypeError("Persistence input requires plain objects");
    if (Reflect.ownKeys(item).some((key) => typeof key === "symbol"))
      throw new TypeError("Persistence input cannot contain symbols");
    active.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item) && Object.keys(item).length !== item.length)
        throw new TypeError(
          "Persistence input cannot contain sparse or decorated arrays",
        );
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(item) && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor))
          throw new TypeError("Persistence input cannot contain accessors");
        inspect(descriptor.value);
      }
    } finally {
      active.delete(item);
    }
  };
  inspect(value);
  return structuredClone(value);
}

async function snapshot(
  options: NativeSessionWriterOptions,
  signal: AbortSignal,
): Promise<Snapshot> {
  signal.throwIfAborted();
  const limit = options.maxFileBytes ?? 32 * 1024 * 1024;
  const parent = await realpath(dirname(options.path));
  let before;
  try {
    before = await lstat(options.path);
  } catch (error) {
    if (!noEntry(error)) throw error;
    const bytes = Buffer.alloc(0);
    return {
      bytes,
      exists: false,
      document: decodeNativeSession(bytes, {
        parser: "source-line-fallback",
        maxBytes: limit,
      }),
    };
  }
  if (!before.isFile() || before.nlink !== 1 || before.size > limit)
    throw new Error(
      "Persistence requires an owned single-linked regular transcript within its host bound",
    );
  const file = await open(
    options.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    const identity = (info: typeof opened) =>
      `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (!opened.isFile() || identity(opened) !== identity(before))
      throw new Error("Persistence transcript changed while opening");
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await file.stat(),
      pathAfter = await lstat(options.path);
    if (
      length !== opened.size ||
      identity(after) !== identity(opened) ||
      identity(pathAfter) !== identity(opened) ||
      (await realpath(dirname(options.path))) !== parent
    )
      throw new Error("Persistence transcript changed while reading");
    const saved = bytes.subarray(0, length);
    return {
      bytes: saved,
      exists: true,
      document: decodeNativeSession(saved, {
        parser: "source-line-fallback",
        maxBytes: limit,
        ...(options.maxLineBytes === undefined
          ? {}
          : { maxLineBytes: options.maxLineBytes }),
      }),
    };
  } finally {
    await file.close();
  }
}

function inspectOwned(
  snapshot: Snapshot,
  context: NativeWriterContext,
  cursor: string | null,
) {
  const known = new Set<string>(),
    toolParents = new Map<string, string>(),
    toolNames = new Map<string, string>();
  if (!snapshot.exists) {
    if (cursor !== null)
      throw new Error(
        "The explicit persistence cursor has no owned transcript",
      );
    return { known, toolParents, toolNames };
  }
  if (snapshot.document.diagnostics.length)
    throw new Error(
      "Malformed persistence state requires its explicit recovery adapter",
    );
  const selection = selectOrdinaryNativeResumeHistory(
    snapshot.document,
    recovery,
  );
  if (
    selection.transcriptSessionId !== context.sessionId ||
    selection.terminalUuid !== cursor
  )
    throw new Error(
      "The explicit persistence cursor does not match the validated owned native tail",
    );
  for (const { value: row } of snapshot.document.lines) {
    if (!isNativeObject(row)) continue;
    if (row.sessionId !== undefined && row.sessionId !== context.sessionId)
      throw new Error("Persistence transcript contains another session owner");
    if (
      ["user", "assistant", "attachment", "system", "progress"].includes(
        typeof row.type === "string" ? row.type : "",
      )
    ) {
      if (
        row.sessionId !== context.sessionId ||
        row.isSidechain === true ||
        row.agentId !== undefined
      )
        throw new Error(
          "Persistence supports only its explicitly owned ordinary main transcript",
        );
      if (typeof row.uuid !== "string" || !row.uuid || known.has(row.uuid))
        throw new Error(
          "Persistence transcript identity is missing or duplicated",
        );
      if (row.type !== "progress") known.add(row.uuid);
    }
    if (
      row.type !== "assistant" ||
      typeof row.uuid !== "string" ||
      !isNativeObject(row.message) ||
      !isNativeArray(row.message.content)
    )
      continue;
    for (const block of row.message.content) {
      if (
        !isNativeObject(block) ||
        block.type !== "tool_use" ||
        typeof block.id !== "string" ||
        !block.id
      )
        continue;
      const existing = toolParents.get(block.id);
      if (existing !== undefined && existing !== row.uuid)
        throw new Error(
          "Persistence transcript has ambiguous tool-parent ownership",
        );
      toolParents.set(block.id, row.uuid);
      if (typeof block.name === "string") toolNames.set(block.id, block.name);
    }
  }
  return { known, toolParents, toolNames };
}

/**
 * One ordinary main-session owner. The caller supplies actual message identities and
 * completion metadata; this host never invents API metadata or rich native contexts.
 */
export class NativeSessionPersistence {
  readonly #writer: NativeSessionWriter;
  readonly #readDocument: (
    signal: AbortSignal,
  ) => Promise<NativeSessionDocument>;
  #state: NativeSessionPersistenceState;
  #known: Set<string>;
  #exists: boolean;
  #toolParents: Map<string, string>;
  #toolNames: Map<string, string>;
  #tail: Promise<void> = Promise.resolve();
  #lastFailure: { error: unknown } | undefined;
  #closing = false;
  #pending:
    | {
        entries: readonly NativeWriterEntry[];
        batch: NativeWriterBatch;
        signal: AbortSignal;
        expectedBytes?: Buffer;
      }
    | undefined;

  private constructor(
    options: NativeSessionWriterOptions,
    initial: Snapshot,
    cursor: string | null,
  ) {
    const inspected = inspectOwned(initial, options.context, cursor);
    this.#known = inspected.known;
    this.#exists = initial.exists;
    this.#toolParents = inspected.toolParents;
    this.#toolNames = inspected.toolNames;
    this.#state = Object.freeze({
      cursorUuid: cursor,
      byteLength: initial.bytes.length,
      sha256: hash(initial.bytes),
      transcriptUuids: Object.freeze([...this.#known]),
    });
    this.#readDocument = (signal) =>
      options.withExclusiveOwnership(options.path, async () => {
        signal.throwIfAborted();
        if (
          !(await options.admit({
            stage: "open",
            path: options.path,
            context: options.context,
            signal,
          }))
        )
          throw new Error("Persistence projection ownership admission denied");
        const current = await snapshot(options, signal);
        if (
          current.exists !== this.#exists ||
          hash(current.bytes) !== this.#state.sha256
        )
          throw new Error(
            "Persistence projection changed outside this owner's cursor",
          );
        return current.document;
      });
    this.#writer = createNativeSessionWriter({
      ...options,
      withExclusiveOwnership: (path, work) =>
        options.withExclusiveOwnership(path, async () => {
          const pending = this.#pending;
          if (!pending)
            throw new Error("Missing owning persistence transaction");
          const current = await snapshot(options, pending.signal);
          if (
            current.exists !== this.#exists ||
            hash(current.bytes) !== this.#state.sha256
          )
            throw new Error(
              "Persistence transcript changed outside this owner's cursor; reopen it explicitly",
            );
          const prepared = envelopeNativeWriterEntries(
            pending.entries,
            options.context,
            pending.batch,
            this.#known,
          );
          pending.expectedBytes = Buffer.from(
            appendNativeSessionRows(current.document, prepared.rows),
          );
          return work();
        }),
    });
  }

  static async open(
    options: NativeSessionPersistenceOptions,
    signal: AbortSignal,
  ): Promise<NativeSessionPersistence> {
    const initial = detached(options.initial);
    if (options.context.sidechain || options.context.agentId !== undefined)
      throw new Error(
        "Persistence requires an explicit ordinary main-session owner",
      );
    const owned: NativeSessionWriterOptions = {
      ...options,
      context: Object.freeze(detached(options.context)),
      maxFileBytes: options.maxFileBytes ?? 32 * 1024 * 1024,
    };
    // Validate the existing writer's absolute paths and required envelope metadata before I/O.
    createNativeSessionWriter(owned);
    return owned.withExclusiveOwnership(owned.path, async () => {
      signal.throwIfAborted();
      if (
        !(await owned.admit({
          stage: "open",
          path: owned.path,
          context: owned.context,
          signal,
        }))
      )
        throw new Error("Persistence ownership admission denied");
      const current = await snapshot(owned, signal);
      if (initial.kind === "fresh" && current.exists)
        throw new Error(
          "Fresh persistence cannot adopt an existing or imported transcript",
        );
      if (initial.kind === "owned-existing" && !current.exists)
        throw new Error(
          "Reopening persistence requires its existing owned transcript",
        );
      if (
        initial.kind === "owned-existing" &&
        initial.expected !== undefined &&
        (initial.expected.byteLength !== current.bytes.length ||
          initial.expected.sha256 !== hash(current.bytes))
      )
        throw new Error(
          "Owned native transcript differs from its persisted binding",
        );
      return new NativeSessionPersistence(
        owned,
        current,
        initial.kind === "fresh" ? null : initial.cursorUuid,
      );
    });
  }

  state(): NativeSessionPersistenceState {
    return this.#state;
  }

  /** Project exactly this owner's committed bytes, serialized with its append queue and lock. */
  readDocument(signal: AbortSignal): Promise<NativeSessionDocument> {
    if (this.#closing)
      return Promise.reject(new Error("Persistence owner is closing"));
    const run = this.#tail.then(() => this.#readDocument(signal));
    this.#tail = run.then(
      () => {},
      (error: unknown) => {
        this.#lastFailure = { error };
      },
    );
    return run;
  }

  appendMessages(
    messages: readonly Message[],
    identities: readonly NativeMessageIdentity[],
    batch: NativePersistenceBatch,
    signal: AbortSignal,
  ): Promise<NativeWriterCommit> {
    const savedMessages = detached(messages),
      savedIdentities = detached(identities),
      savedBatch = detached(batch);
    return this.#append(
      () => {
        if (!savedMessages.length)
          throw new Error("Persistence append requires new completed messages");
        return planNativeMessageEntries(savedMessages, savedIdentities, {
          knownToolParents: this.#toolParents,
        });
      },
      savedBatch,
      signal,
    );
  }

  /** Finalized physical events retain provider block identity and typed attachment placement. */
  appendEvents(
    inputs: readonly unknown[],
    batch: NativePersistenceBatch,
    signal: AbortSignal,
  ): Promise<NativeWriterCommit> {
    const events = captureNativePersistenceEvents(inputs),
      savedBatch = detached(batch);
    return this.#append(
      () => {
        if (!events.length)
          throw new Error("Persistence append requires new physical events");
        const parents = new Map(this.#toolParents),
          names = new Map(this.#toolNames);
        for (const event of events) {
          if (
            !isNativeObject(event.message) ||
            !isNativeArray(event.message.content)
          )
            continue;
          if (event.type === "assistant") {
            for (const block of event.message.content) {
              if (
                !isNativeObject(block) ||
                block.type !== "tool_use" ||
                typeof block.id !== "string"
              )
                continue;
              if (parents.has(block.id))
                throw new Error(
                  "Native physical events have duplicated or ambiguous tool-call identity",
                );
              parents.set(block.id, event.uuid);
              if (typeof block.name === "string")
                names.set(block.id, block.name);
            }
          } else if (event.type === "user") {
            const results = event.message.content.filter(
              (block) => isNativeObject(block) && block.type === "tool_result",
            );
            for (const block of results) {
              if (
                !isNativeObject(block) ||
                typeof block.tool_use_id !== "string" ||
                parents.get(block.tool_use_id) !== event.sourceToolAssistantUUID
              )
                throw new Error(
                  "Native physical result requires its actual committed assistant fragment parent",
                );
              if (
                event.toolUseResult !== undefined &&
                names.get(block.tool_use_id) !== "Read"
              )
                throw new Error(
                  "Structured native result metadata requires its supported actual Read producer",
                );
            }
          }
        }
        return events;
      },
      savedBatch,
      signal,
    );
  }

  #append(
    buildEntries: () => readonly NativeWriterEntry[],
    savedBatch: NativePersistenceBatch,
    signal: AbortSignal,
  ): Promise<NativeWriterCommit> {
    if (this.#closing)
      return Promise.reject(new Error("Persistence owner is closing"));
    const run = this.#tail.then(async () => {
      signal.throwIfAborted();
      const entries = buildEntries();
      const newUuids = new Set<string>();
      for (const entry of entries) {
        if (this.#known.has(entry.uuid) || newUuids.has(entry.uuid))
          throw new Error(
            "Persistence append requires new stable message identities",
          );
        newUuids.add(entry.uuid);
      }
      const nativeBatch: NativeWriterBatch = {
        ...savedBatch,
        parentUuid: this.#state.cursorUuid,
        checkpoint: true,
      };
      const pending = { entries, batch: nativeBatch, signal };
      this.#pending = pending;
      try {
        const result = await this.#writer.appendEntries(
          entries,
          nativeBatch,
          signal,
        );
        const expectedBytes = this.#pending.expectedBytes;
        if (!expectedBytes || result.byteLength !== expectedBytes.length)
          throw new Error(
            "Committed persistence result disagrees with its planned bytes",
          );
        // Only committed data changes the next cursor/ledger. Abort-after-commit is still committed.
        this.#exists = true;
        for (const entry of entries) {
          this.#known.add(entry.uuid);
          if (
            entry.type !== "assistant" ||
            !isNativeObject(entry.message) ||
            !isNativeArray(entry.message.content)
          )
            continue;
          for (const block of entry.message.content)
            if (
              isNativeObject(block) &&
              block.type === "tool_use" &&
              typeof block.id === "string"
            )
              this.#toolParents.set(block.id, entry.uuid);
          for (const block of entry.message.content)
            if (
              isNativeObject(block) &&
              block.type === "tool_use" &&
              typeof block.id === "string" &&
              typeof block.name === "string"
            )
              this.#toolNames.set(block.id, block.name);
        }
        this.#state = Object.freeze({
          cursorUuid: result.leafUuid,
          byteLength: result.byteLength,
          sha256: hash(expectedBytes),
          transcriptUuids: Object.freeze([...this.#known]),
        });
        return result;
      } finally {
        this.#pending = undefined;
      }
    });
    this.#tail = run.then(
      () => {
        this.#lastFailure = undefined;
      },
      (error: unknown) => {
        this.#lastFailure = { error };
      },
    );
    return run;
  }

  /** Drain only this owner's accepted work; no global queue, timer or foreign writer is controlled. */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#tail;
    if (this.#lastFailure) throw this.#lastFailure.error;
  }
}

export const openNativeSessionPersistence = (
  options: NativeSessionPersistenceOptions,
  signal: AbortSignal,
): Promise<NativeSessionPersistence> =>
  NativeSessionPersistence.open(options, signal);
