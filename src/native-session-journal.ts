import type {
  NativeAttachmentCaptureHost,
  NativeAttachmentCaptureResult,
  NativeAttachmentDelivery,
} from "./native-attachment-capture.js";
import type {
  NativeInstructionCaptureResult,
  NativeInstructionPayloadFile,
} from "./native-instruction-capture.js";
import {
  captureNativePersistenceEvents,
  validateNativePersistenceEvent,
  type NativePersistenceEvent,
} from "./native-persistence-events.js";
import {
  nativeResponseRecordingSchema,
  type NativeResponseIdentity,
  type NativeResponseRecordingHost,
} from "./native-response-recording.js";
import {
  isNativeArray,
  isNativeObject,
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  type NativeJson,
  type NativeSessionDocument,
  type NativeTranscriptNode,
  type NativeSourceRow,
} from "./native-session-codec.js";
import {
  NativeSessionPersistence,
  type NativeSessionPersistenceOptions,
  type NativeSessionPersistenceState,
} from "./native-session-persistence.js";
import type { Message, PermissionMode, ToolResult } from "./types.js";
import { isDeepStrictEqual } from "node:util";
import type { NativePromptSnapshotCreation } from "./native-prompt-snapshot.js";
import {
  projectNativeToolRequestContext,
  projectNativeOwnedToolRequestContext,
  type NativeToolContextProjection,
  type NativeToolContextRenderOptions,
} from "./native-tool-context.js";
import type {
  NativeLifecycleCaptureHost,
  NativeLifecycleDecision,
} from "./native-lifecycle-hooks.js";
import type { NativeStopQueryTransition } from "./native-stop-query.js";
import { createNativeAttachmentEvent } from "./native-persistence-events.js";
import {
  selectNativePersistenceRows,
  type NativePersistenceSelectionInput,
  type NativePersistenceSelectionHost,
  type NativePersistenceSelectionDecision,
} from "./native-persistence-selection.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";
import type { NativeObject } from "./native-session-codec.js";
import {
  reconstructNativeHistory,
  type NativeRecoveredHistory,
} from "./native-history-projection.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";
import {
  nativeHookProgressRetention,
  validateNativeHookProgressRow,
  validateNativeStopHookSummaryRow,
  type NativeHookProgressRetentionInput,
  type NativeStopHookSummaryCreation,
} from "./native-hook-progress.js";

/** Opaque query capability. Only the creating journal accepts it. */
export interface NativeJournalQueryFrame {
  readonly revision: number;
}
interface QueryFrameEntry {
  uuid: string;
  initial?: NativeObject;
}
interface QueryFrameState {
  handle: NativeJournalQueryFrame;
  revision: number;
  entries: QueryFrameEntry[];
  ids: Set<string>;
  awaitingLifecycle: boolean;
  closed: boolean;
  recovery: NativeJournalRequestOptions["recovery"];
  progress: Set<string>;
}

export type NativeJournalRequestOptions<
  N extends NativeSourceRow = NativeTranscriptNode,
> = NativeToolContextRenderOptions<N> & {
  frame?: NativeJournalQueryFrame;
  frameRevision?: number;
  /** Exact current model for the initial compatible-signature branch; foreign aliases need their native host. */
  requestedModel: string;
  recovery: Parameters<
    typeof projectNativeToolRequestContext
  >[1]["selection"]["recovery"];
};
export interface NativeJournalRequestProjection {
  originalDocument: NativeSessionDocument;
  projection: NativeToolContextProjection;
  omittedCheckpoints: readonly { line: number; leafUuid: string }[];
  queryFrame?: { revision: number; uuids: readonly string[] };
}
export interface NativeJournalCommittedView {
  document: NativeSessionDocument;
  state: NativeSessionPersistenceState;
}

export class NativeSessionJournalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeSessionJournalError";
  }
}
export interface NativeSessionJournalHost {
  /** Actual creation callbacks. The journal never assigns identities during a save. */
  stamp(
    kind:
      | "user"
      | "assistant"
      | "attachment"
      | "tool-result"
      | "system"
      | "progress",
  ): NativeResponseIdentity;
  persistence?: {
    /** Actual source facts and original-row ownership at k9e's selection boundary. */
    select(input: {
      rows: readonly NativePersistenceEvent[];
      history: readonly NativeObject[];
    }): {
      facts: Omit<NativePersistenceSelectionInput, "rows">;
      host: NativePersistenceSelectionHost;
    };
    /** Actual ordinary startup history and unchanged writer owner; no attachment rewrite stage. */
    freshHead: NativePromptFact<"ordinary-unchanged-owner-without-attachment-rewrites">;
  };
}
export interface NativeJournalToolResult {
  /** The actual native model result before separately recorded contexts are folded into it. */
  result: Pick<
    ToolResult,
    "type" | "tool_use_id" | "content" | "is_error" | "apiContent"
  >;
  /** Values from the real tool/permission producer, never recovered from display text or mode. */
  toolUseResult?: unknown;
  permissionDecision?: unknown;
  permissionMode?: PermissionMode;
}

/**
 * One physical event owner. Creation order and native enqueue order are distinct:
 * post-hook attachments are created during hooks, then enqueued after the finalized
 * core result without changing their original UUIDs or timestamps.
 */
export class NativeSessionJournal {
  readonly #owner: NativeSessionPersistence;
  readonly #host: NativeSessionJournalHost;
  readonly #sessionId: string;
  readonly #toolParents = new Map<string, string>();
  readonly #completedTools = new Set<string>();
  readonly #post = new Map<string, NativePersistenceEvent[]>();
  readonly #pendingHead: NativePersistenceEvent[] = [];
  readonly #selectionHistory: NativeObject[] = [];
  readonly #selectionAudit: (readonly NativePersistenceSelectionDecision[])[] =
    [];
  readonly #observedEvents = new Map<
    string,
    {
      original: NativePersistenceEvent;
      selected: NativePersistenceEvent | undefined;
    }
  >();
  #materialized = false;
  readonly #queryFrames = new WeakMap<
    NativeJournalQueryFrame,
    QueryFrameState
  >();
  #activeQuery: QueryFrameState | undefined;
  #instructions: readonly NativeInstructionPayloadFile[] | undefined;
  #tail: Promise<void> = Promise.resolve();
  #failure: NativeSessionJournalError | undefined;
  #closing = false;

  private constructor(
    owner: NativeSessionPersistence,
    host: NativeSessionJournalHost,
    sessionId: string,
  ) {
    this.#owner = owner;
    this.#host = Object.freeze({
      stamp: host.stamp.bind(host),
      ...(host.persistence === undefined
        ? {}
        : {
            persistence: Object.freeze({
              freshHead: structuredClone(host.persistence.freshHead),
              select: host.persistence.select.bind(host.persistence),
            }),
          }),
    });
    this.#sessionId = sessionId;
  }

  static async open(
    options: NativeSessionPersistenceOptions,
    host: NativeSessionJournalHost,
    signal: AbortSignal,
  ): Promise<NativeSessionJournal> {
    // The creation envelope is shared by pending head rows and first conversation.
    // Capture it before I/O so a caller cannot change owner/cwd during open.
    const context = structuredClone(options.context);
    const owner = await NativeSessionPersistence.open(
      { ...options, context },
      signal,
    );
    const journal = new NativeSessionJournal(owner, host, context.sessionId);
    try {
      const document = await owner.readDocument(signal);
      journal.#materialized = owner.state().byteLength > 0;
      for (const line of document.lines) {
        const row = line.value;
        if (!isNativeObject(row)) continue;
        journal.#selectionHistory.push(structuredClone(row));
        journal.#index(row);
        if (
          row.type === "attachment" &&
          isNativeObject(row.attachment) &&
          row.attachment.type === "instructions"
        ) {
          // Only producer-validated canonical recorded events can seed live instruction state.
          const {
            type,
            uuid,
            timestamp,
            attachment,
            rendered,
            renderedRole,
            placement,
          } = row;
          const event = validateNativePersistenceEvent({
            type,
            uuid,
            timestamp,
            attachment,
            rendered,
            renderedRole,
            placement,
          });
          if (
            isNativeObject(event.attachment) &&
            isNativeArray(event.attachment.files)
          ) {
            const parsed = event.attachment.files;
            // The canonical event validator has validated each complete instruction file.
            const files: NativeInstructionPayloadFile[] = parsed.map((file) => {
              if (
                !isNativeObject(file) ||
                typeof file.path !== "string" ||
                typeof file.content !== "string" ||
                typeof file.type !== "string" ||
                !["Managed", "User", "Project", "Local", "AutoMem"].includes(
                  file.type,
                )
              )
                throw new NativeSessionJournalError(
                  "Invalid owned instruction state",
                );
              return {
                path: file.path,
                content: file.content,
                type:
                  file.type === "Managed"
                    ? "Managed"
                    : file.type === "User"
                      ? "User"
                      : file.type === "Local"
                        ? "Local"
                        : file.type === "AutoMem"
                          ? "AutoMem"
                          : "Project",
                ...(typeof file.unverified === "boolean"
                  ? { unverified: file.unverified }
                  : {}),
                ...(typeof file.startOnly === "boolean"
                  ? { startOnly: file.startOnly }
                  : {}),
                ...(typeof file.cutForRoom === "boolean"
                  ? { cutForRoom: file.cutForRoom }
                  : {}),
              };
            });
            if (event.attachment.changed === true) {
              if (journal.#instructions === undefined)
                throw new NativeSessionJournalError(
                  "Changed instructions lack their actual earlier bodies",
                );
              const current = new Map(
                journal.#instructions.map((file) => [file.path, file]),
              );
              for (const removed of isNativeArray(event.attachment.removed)
                ? event.attachment.removed
                : [])
                if (typeof removed === "string") current.delete(removed);
              for (const file of files) current.set(file.path, file);
              journal.#instructions = [...current.values()];
            } else journal.#instructions = files;
          }
        }
      }
      return journal;
    } catch (error) {
      await owner.close();
      throw error;
    }
  }

  #index(row: { readonly [key: string]: NativeJson | undefined }): void {
    const message = row.message;
    if (!isNativeObject(message) || !isNativeArray(message.content)) return;
    for (const block of message.content) {
      if (!isNativeObject(block)) continue;
      if (
        row.type === "assistant" &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof row.uuid === "string"
      ) {
        const previous = this.#toolParents.get(block.id);
        if (previous !== undefined && previous !== row.uuid)
          throw new NativeSessionJournalError(
            "Ambiguous native tool-result owner",
          );
        this.#toolParents.set(block.id, row.uuid);
      }
      if (
        row.type === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      )
        this.#completedTools.add(block.tool_use_id);
    }
  }

  #reject(error: unknown): NativeSessionJournalError {
    this.#failure ??=
      error instanceof NativeSessionJournalError
        ? error
        : new NativeSessionJournalError("Native session journal failed", {
            cause: error,
          });
    return this.#failure;
  }

  producerFailure(error: unknown): never {
    throw this.#reject(error);
  }

  #query(handle: NativeJournalQueryFrame, revision?: number): QueryFrameState {
    const state = this.#queryFrames.get(handle);
    if (!state || state.closed || state !== this.#activeQuery)
      throw new NativeSessionJournalError(
        "Unknown or retired native query owner",
      );
    if (revision !== undefined && revision !== state.revision)
      throw new NativeSessionJournalError("Stale native query revision");
    return state;
  }

  #addToQuery(
    state: QueryFrameState,
    events: readonly NativePersistenceEvent[],
  ): void {
    for (const event of events) {
      if (state.ids.has(event.uuid))
        throw new NativeSessionJournalError(
          "Native query cannot acquire the same creation twice",
        );
      if (!this.#observedEvents.has(event.uuid))
        throw new NativeSessionJournalError(
          "Native query lacks its actual producer",
        );
      state.entries.push({ uuid: event.uuid });
      state.ids.add(event.uuid);
    }
    if (events.length) state.revision++;
  }

  #requestSelection(
    document: NativeSessionDocument,
    recovery: NativeJournalRequestOptions["recovery"],
  ) {
    const index = indexNativeSession(document),
      cursor = this.#owner.state().cursorUuid;
    let leaf = cursor === null ? undefined : index.nodes.get(cursor);
    const visited = new Set<string>();
    while (leaf && leaf.type !== "user" && leaf.type !== "assistant") {
      if (visited.has(leaf.uuid))
        throw new NativeSessionJournalError("Cyclic live journal cursor");
      visited.add(leaf.uuid);
      leaf =
        leaf.parentUuid === null ? undefined : index.nodes.get(leaf.parentUuid);
    }
    if (!leaf)
      throw new NativeSessionJournalError(
        "A native query requires its actual conversational cursor",
      );
    const checkpoints: { line: number; leafUuid: string }[] = [],
      retained: NativeJson[] = [];
    for (const line of document.lines) {
      const row = line.value;
      if (isNativeObject(row) && row.type === "last-prompt") {
        if (
          Object.keys(row).some(
            (key) => !["type", "sessionId", "leafUuid"].includes(key),
          ) ||
          row.sessionId !== this.#sessionId ||
          typeof row.leafUuid !== "string" ||
          !index.nodes.has(row.leafUuid)
        )
          throw new NativeSessionJournalError(
            "Non-advisory checkpoint requires its explicit native fold adapter",
          );
        checkpoints.push({ line: line.line, leafUuid: row.leafUuid });
      } else if (row !== undefined) retained.push(row);
    }
    const requestDocument = decodeNativeSession(
      encodeNativeSessionRows(retained),
      { parser: "source-line-fallback" },
    );
    const selection = {
      leafUuid: leaf.uuid,
      scope: { kind: "main" as const, sessionId: this.#sessionId },
      recovery,
    };
    const recovered = reconstructNativeHistory(
      indexNativeSession(requestDocument),
      selection,
    );
    return { index, checkpoints, requestDocument, selection, recovered };
  }

  beginQueryFrame(
    recovery: NativeJournalRequestOptions["recovery"],
    signal: AbortSignal,
  ): Promise<NativeJournalQueryFrame> {
    const actualRecovery = structuredClone(recovery);
    return this.#enqueue(async () => {
      if (this.#activeQuery || this.#post.size || this.#pendingHead.length)
        throw new NativeSessionJournalError(
          "A native query requires an independent settled owner",
        );
      const document = await this.#owner.readDocument(signal);
      const selected = this.#requestSelection(document, actualRecovery);
      const initialIds = new Set(
        selected.recovered.nodes.map((node) => node.uuid),
      );
      const entries: QueryFrameEntry[] = [];
      for (const row of this.#selectionHistory) {
        if (typeof row.uuid !== "string") continue;
        if (this.#observedEvents.has(row.uuid))
          entries.push({ uuid: row.uuid });
        else if (initialIds.has(row.uuid)) {
          const original = snapshotNativeResponseJson(row);
          if (!isNativeObject(original))
            throw new NativeSessionJournalError(
              "Invalid initial native query row",
            );
          entries.push({ uuid: row.uuid, initial: original });
        }
      }
      const ids = new Set(entries.map((entry) => entry.uuid));
      if (ids.size !== entries.length || !entries.length)
        throw new NativeSessionJournalError(
          "Ambiguous initial native query vector",
        );
      let state: QueryFrameState;
      const handle = Object.freeze({
        get revision() {
          return state.revision;
        },
      });
      state = {
        handle,
        revision: 0,
        entries,
        ids,
        awaitingLifecycle: false,
        closed: false,
        recovery: actualRecovery,
        progress: new Set(),
      };
      this.#queryFrames.set(handle, state);
      this.#activeQuery = state;
      return handle;
    });
  }

  beginLifecycleTransition(
    frame: NativeJournalQueryFrame,
    signal: AbortSignal,
  ): Promise<void> {
    const revision = frame.revision;
    return this.#enqueue(async () => {
      const state = this.#query(frame, revision);
      if (
        state.awaitingLifecycle ||
        this.#post.size ||
        this.#pendingHead.length
      )
        throw new NativeSessionJournalError(
          "Native lifecycle transition is already pending or unready",
        );
      await this.#owner.readDocument(signal);
      state.awaitingLifecycle = true;
      state.progress.clear();
      state.revision++;
    });
  }

  endQueryFrame(frame: NativeJournalQueryFrame): void {
    const state = this.#queryFrames.get(frame);
    if (!state || state.closed || state !== this.#activeQuery)
      throw new NativeSessionJournalError(
        "Unknown or retired native query owner",
      );
    state.closed = true;
    this.#activeQuery = undefined;
  }

  #queryRows(
    state: QueryFrameState,
    index: ReturnType<typeof indexNativeSession>,
  ): NativeRecoveredHistory {
    const nodes: NativeTranscriptNode[] = [];
    for (const entry of state.entries) {
      const stored = index.nodes.get(entry.uuid);
      const observed = this.#observedEvents.get(entry.uuid);
      let row: NativeObject;
      if (observed) {
        if (
          observed.selected &&
          (!stored ||
            Object.entries(observed.selected).some(
              ([key, value]) => !isDeepStrictEqual(stored.row[key], value),
            ))
        )
          throw new NativeSessionJournalError(
            "Native query producer differs from its committed selected row",
          );
        if (!observed.selected && stored)
          throw new NativeSessionJournalError(
            "Native query exclusion disagrees with its physical transcript",
          );
        const envelope = stored
          ? Object.fromEntries(
              Object.entries(stored.row).filter(([key]) =>
                [
                  "parentUuid",
                  "logicalParentUuid",
                  "isSidechain",
                  "agentId",
                  "cwd",
                  "entrypoint",
                  "userType",
                  "sessionKind",
                  "teamName",
                  "agentName",
                  "promptId",
                  "gitBranch",
                  "slug",
                  "version",
                  "requestSessionId",
                  "madeBy",
                ].includes(key),
              ),
            )
          : {};
        const actual = snapshotNativeResponseJson({
          ...envelope,
          ...observed.original,
        });
        if (!isNativeObject(actual))
          throw new NativeSessionJournalError("Invalid owned query creation");
        row = actual;
      } else {
        if (
          !entry.initial ||
          !stored ||
          !isDeepStrictEqual(entry.initial, stored.row)
        )
          throw new NativeSessionJournalError(
            "Native initial query row changed ownership",
          );
        row = entry.initial;
      }
      if (typeof row.type !== "string")
        throw new NativeSessionJournalError("Invalid native query type");
      // An excluded raw creation has no persisted envelope/line. Its parent is
      // unknown, and no graph is inferred from this request-only vector.
      nodes.push(
        Object.freeze({
          uuid: entry.uuid,
          type: row.type,
          row,
          parentUuid: stored?.parentUuid ?? null,
          line: stored?.line ?? 0,
        }),
      );
    }
    const leaf = nodes.findLast(
      (node) => node.type === "user" || node.type === "assistant",
    );
    if (!leaf)
      throw new NativeSessionJournalError(
        "Native query has no actual conversation",
      );
    return Object.freeze({
      leafUuid: leaf.uuid,
      nodes: Object.freeze(nodes),
      diagnostics: Object.freeze([]),
    });
  }

  #admit(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing)
      throw new NativeSessionJournalError("Native session journal is closing");
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.#admit();
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      try {
        return await work();
      } catch (error) {
        throw this.#reject(error);
      }
    });
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  #stamp(
    kind: Parameters<NativeSessionJournalHost["stamp"]>[0],
  ): NativeResponseIdentity {
    this.#admit();
    try {
      return Object.freeze({ ...this.#host.stamp(kind) });
    } catch (error) {
      throw this.#reject(error);
    }
  }

  #append(
    events: readonly NativePersistenceEvent[],
    signal: AbortSignal,
    promptId?: string,
    delivery: "ordinary" | "lifecycle" | "terminal" = "ordinary",
  ): Promise<void> {
    const captured = captureNativePersistenceEvents(events);
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      if (
        this.#activeQuery &&
        ((delivery === "ordinary" && this.#activeQuery.awaitingLifecycle) ||
          (delivery === "lifecycle" && !this.#activeQuery.awaitingLifecycle))
      )
        throw new NativeSessionJournalError(
          "Native producer arrived outside its owning query transition",
        );
      if (captured.some((event) => this.#observedEvents.has(event.uuid)))
        throw new NativeSessionJournalError(
          "Native creation identity was already observed",
        );
      let selected = captured;
      const profile = this.#host.persistence;
      if (profile) {
        const facts = profile.select({
          rows: captured,
          history: structuredClone([...this.#selectionHistory, ...captured]),
        });
        const selection = selectNativePersistenceRows(
          { ...facts.facts, rows: captured },
          facts.host,
        );
        if (selection.status !== "selected")
          throw new NativeSessionJournalError(selection.reasons.join("; "));
        selected = captureNativePersistenceEvents(selection.rows);
        this.#selectionAudit.push(selection.decisions);
      }
      if (!selected.length) {
        this.#selectionHistory.push(...captured);
        for (const event of captured)
          this.#observedEvents.set(event.uuid, {
            original: event,
            selected: undefined,
          });
        if (
          delivery === "ordinary" &&
          this.#activeQuery &&
          !this.#activeQuery.awaitingLifecycle
        )
          this.#addToQuery(this.#activeQuery, captured);
        else if (this.#activeQuery) {
          if (delivery === "lifecycle")
            for (const event of captured)
              if (event.type === "progress")
                this.#activeQuery.progress.add(event.uuid);
          this.#activeQuery.revision++;
        }
        return;
      }
      if (
        !this.#materialized &&
        !selected.some(
          (event) =>
            event.type === "user" ||
            event.type === "assistant" ||
            event.type === "system",
        )
      ) {
        if (
          !profile ||
          profile.freshHead.status !== "known" ||
          profile.freshHead.value !==
            "ordinary-unchanged-owner-without-attachment-rewrites"
        )
          throw new NativeSessionJournalError(
            "Fresh native head requires its actual unchanged owner and startup selection profile",
          );
        this.#pendingHead.push(...selected);
        this.#selectionHistory.push(...captured);
        for (const event of captured)
          this.#observedEvents.set(event.uuid, {
            original: event,
            selected: selected.find((row) => row.uuid === event.uuid),
          });
        return;
      }
      const batch = [...this.#pendingHead, ...selected];
      await this.#owner.appendEvents(
        batch,
        promptId === undefined ? {} : { promptId },
        signal,
      );
      this.#pendingHead.length = 0;
      this.#materialized = true;
      this.#selectionHistory.push(...captured);
      for (const event of captured)
        this.#observedEvents.set(event.uuid, {
          original: event,
          selected: selected.find((row) => row.uuid === event.uuid),
        });
      for (const event of batch) this.#index(event);
      if (
        delivery === "ordinary" &&
        this.#activeQuery &&
        !this.#activeQuery.awaitingLifecycle
      )
        this.#addToQuery(this.#activeQuery, captured);
      else if (this.#activeQuery) {
        if (delivery === "lifecycle")
          for (const event of captured)
            if (event.type === "progress")
              this.#activeQuery.progress.add(event.uuid);
        this.#activeQuery.revision++;
      }
    });
  }

  readonly responseHost: NativeResponseRecordingHost = {
    stamp: () => this.#stamp("assistant"),
  };

  recordResponse(input: unknown, signal: AbortSignal): Promise<void> {
    try {
      const recording = nativeResponseRecordingSchema.parse(input);
      if (recording.status !== "complete")
        throw new NativeSessionJournalError(
          `Unsupported native response: ${recording.reason}`,
        );
      return this.#append(recording.rows, signal);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  recordUser(
    message: Pick<Message, "role" | "content">,
    promptId: string,
    signal: AbortSignal,
    permissionMode?: PermissionMode,
  ): Promise<void> {
    try {
      if (
        message.role !== "user" ||
        message.content.some((block) => block.type !== "text")
      )
        throw new NativeSessionJournalError(
          "Human prompt requires its actual text producer",
        );
      if (!promptId)
        throw new NativeSessionJournalError(
          "Human prompt requires its actual prompt identity",
        );
      const event = validateNativePersistenceEvent({
        type: "user",
        ...this.#stamp("user"),
        message,
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
      return this.#append([event], signal, promptId);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  instructionState(): readonly NativeInstructionPayloadFile[] | undefined {
    return this.#instructions === undefined
      ? undefined
      : structuredClone(this.#instructions);
  }

  stampAttachment(): NativeResponseIdentity {
    return this.#stamp("attachment");
  }
  stampHookProgress(): NativeResponseIdentity {
    return this.#stamp("progress");
  }
  stampStopSummary(): NativeResponseIdentity {
    return this.#stamp("system");
  }

  /** The supplied policy belongs to the actual final lifecycle retention owner. */
  captureHookProgress(
    input: unknown,
    policy: NativeHookProgressRetentionInput,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#admit();
      const row = validateNativeHookProgressRow(input),
        retention = nativeHookProgressRetention(row, policy);
      if (retention.status === "unsupported")
        throw new NativeSessionJournalError(retention.reasons.join("; "));
      if (retention.retention === "startup-buffer")
        throw new NativeSessionJournalError(
          "Startup progress awaits its actual final retention owner",
        );
      if (retention.retention === "discard") return Promise.resolve();
      if (
        policy.consumer !== "session-start" &&
        (!this.#activeQuery?.awaitingLifecycle || row.data.hookEvent !== "Stop")
      )
        throw new NativeSessionJournalError(
          "Retained Stop progress lacks its actual main-query phase",
        );
      if (!this.#host.persistence)
        throw new NativeSessionJournalError(
          "Durable progress requires its actual OE selection profile",
        );
      return this.#append([row], signal, undefined, "lifecycle");
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  captureStopSummary(
    creation: NativeStopHookSummaryCreation,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#admit();
      if (creation.status === "absent") return Promise.resolve();
      const row = validateNativeStopHookSummaryRow(creation.row),
        frame = this.#activeQuery;
      const observed = frame
        ? [...frame.progress].map(
            (uuid) => this.#observedEvents.get(uuid)?.original,
          )
        : [];
      if (
        !frame?.awaitingLifecycle ||
        !observed.length ||
        row.hookCount !== observed.length ||
        row.toolUseID !== observed.at(-1)?.toolUseID
      )
        throw new NativeSessionJournalError(
          "Stop summary lacks its actual observed progress owner",
        );
      return this.#append([row], signal, undefined, "lifecycle");
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  capturePromptSnapshot(
    creation: NativePromptSnapshotCreation,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#admit();
      if (creation.serialization.status !== "supported")
        throw new NativeSessionJournalError(
          creation.serialization.reasons.join("; "),
        );
      const event = validateNativePersistenceEvent(
          creation.serialization.event,
        ),
        record = creation.record;
      if (
        event.type !== "attachment" ||
        event.uuid !== record.uuid ||
        event.timestamp !== record.timestamp ||
        !isDeepStrictEqual(event.attachment, record.attachment)
      )
        throw new NativeSessionJournalError(
          "Prompt snapshot serialization lost its actual creation provenance",
        );
      return this.#append([event], signal);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  async captureInstruction(
    result: NativeInstructionCaptureResult,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#admit();
      if (result.status === "unsupported")
        throw new NativeSessionJournalError(result.reasons.join("; "));
      if (result.status === "unchanged") return;
      const files = structuredClone(result.currentFiles);
      await this.#append([result.event], signal);
      this.#instructions = files;
    } catch (error) {
      throw this.#reject(error);
    }
  }

  attachmentHost(signal: AbortSignal): NativeAttachmentCaptureHost {
    return {
      stamp: () => this.stampAttachment(),
      capture: (result, delivery) =>
        this.captureAttachment(result, delivery, signal),
    };
  }

  /** Consume actual retained lifecycle creations; raw command observations are separate. */
  lifecycleHost(
    signal: AbortSignal,
  ): Pick<NativeLifecycleCaptureHost, "stamp" | "capture" | "unsupported"> {
    return {
      stamp: ({ kind }) =>
        this.#stamp(kind === "attachment" ? "attachment" : "user"),
      capture: (creation) => {
        try {
          this.#admit();
          const event = validateNativePersistenceEvent(creation.event);
          if (
            !creation.cause.branch ||
            !creation.cause.dispatchToolUseID ||
            (event.type === "attachment"
              ? !isNativeObject(event.attachment) ||
                event.attachment.hookEvent !== creation.cause.event
              : event.type !== "user" || event.isMeta !== true)
          )
            throw new NativeSessionJournalError(
              "Lifecycle creation lacks its actual retained event ownership",
            );
          return this.#append([event], signal, undefined, "lifecycle");
        } catch (error) {
          return Promise.reject(this.#reject(error));
        }
      },
      unsupported: (fact) =>
        Promise.reject(
          this.#reject(new NativeSessionJournalError(fact.reasons.join("; "))),
        ),
    };
  }

  captureAttachment(
    result: NativeAttachmentCaptureResult,
    delivery: NativeAttachmentDelivery,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#admit();
      if (result.status !== "captured")
        throw new NativeSessionJournalError(result.reasons.join("; "));
      const event = validateNativePersistenceEvent(result.event);
      if (delivery.kind === "tool-hook") {
        if (
          result.facts.source !== "tool-hook" ||
          result.facts.toolUseID !== delivery.call.id ||
          result.facts.phase !== delivery.phase ||
          !this.#toolParents.has(delivery.call.id) ||
          this.#completedTools.has(delivery.call.id)
        )
          throw new NativeSessionJournalError(
            "Hook attachment lacks its active physical tool owner",
          );
        if (delivery.phase !== "pre") {
          const pending = this.#post.get(delivery.call.id) ?? [];
          pending.push(event);
          this.#post.set(delivery.call.id, pending);
          return Promise.resolve();
        }
      }
      return this.#append([event], signal);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  recordToolResult(
    input: NativeJournalToolResult,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#admit();
      const result = input.result,
        parent = this.#toolParents.get(result.tool_use_id);
      if (!parent || this.#completedTools.has(result.tool_use_id))
        throw new NativeSessionJournalError(
          "Tool result lacks its unique active physical assistant owner",
        );
      const event = validateNativePersistenceEvent({
        type: "user",
        ...this.#stamp("tool-result"),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: result.tool_use_id,
              content: result.apiContent ?? result.content,
              ...(result.is_error === undefined
                ? {}
                : { is_error: result.is_error }),
            },
          ],
        },
        sourceToolAssistantUUID: parent,
        ...(input.toolUseResult === undefined
          ? {}
          : { toolUseResult: input.toolUseResult }),
        ...(input.permissionDecision === undefined
          ? {}
          : { permissionDecision: input.permissionDecision }),
        ...(input.permissionMode === undefined
          ? {}
          : { permissionMode: input.permissionMode }),
      });
      // Snapshot and reserve this result before yielding: a second callback cannot enqueue it twice.
      const post = this.#post.get(result.tool_use_id) ?? [];
      this.#post.delete(result.tool_use_id);
      this.#completedTools.add(result.tool_use_id);
      return this.#append([event, ...post], signal);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  assertToolResultCommitted(toolUseId: string): void {
    this.#admit();
    if (!this.#completedTools.has(toolUseId))
      throw this.#reject(
        new NativeSessionJournalError(
          "Tool completion lacks its actual committed native producer",
        ),
      );
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failure) throw this.#failure;
    if (this.#pendingHead.length)
      throw this.#reject(
        new NativeSessionJournalError(
          "Native startup rows await actual first-conversation materialization",
        ),
      );
    if (this.#post.size)
      throw this.#reject(
        new NativeSessionJournalError(
          "Post-hook events await their actual core result",
        ),
      );
  }

  /** A save receipt describes freshly verified committed bytes, after accepted producers drain. */
  checkpoint(signal: AbortSignal): Promise<NativeSessionPersistenceState> {
    return this.#enqueue(async () => {
      if (this.#pendingHead.length)
        throw new NativeSessionJournalError(
          "Native startup rows await actual first-conversation materialization",
        );
      if (this.#post.size)
        throw new NativeSessionJournalError(
          "Post-hook events await their actual core result",
        );
      await this.#owner.readDocument(signal);
      return this.#owner.state();
    });
  }

  persistenceSelectionAudit(): readonly (readonly NativePersistenceSelectionDecision[])[] {
    return Object.freeze([...this.#selectionAudit]);
  }

  /** Read the settled physical history without imposing a next-request or completed-resume tail. */
  readCommitted(signal: AbortSignal): Promise<NativeJournalCommittedView> {
    return this.#enqueue(async () => {
      if (this.#pendingHead.length || this.#post.size)
        throw new NativeSessionJournalError(
          "Native producers await their actual materialization/result owner",
        );
      return {
        document: await this.#owner.readDocument(signal),
        state: this.#owner.state(),
      };
    });
  }

  #checkLifecycle(
    index: ReturnType<typeof indexNativeSession>,
    decision: NativeLifecycleDecision,
  ): void {
    const check = (event: NativePersistenceEvent, continuation: boolean) => {
      const owned = this.#observedEvents.get(event.uuid);
      if (!owned || !isDeepStrictEqual(owned.original, event))
        throw new NativeSessionJournalError(
          "Lifecycle decision contains an unowned creation",
        );
      if (!owned.selected) {
        if (continuation)
          throw new NativeSessionJournalError(
            "Excluded lifecycle row cannot drive another query",
          );
        return;
      }
      const stored = index.nodes.get(owned.selected.uuid)?.row;
      if (
        !stored ||
        Object.entries(owned.selected).some(
          ([key, value]) => !isDeepStrictEqual(stored[key], value),
        )
      )
        throw new NativeSessionJournalError(
          "Lifecycle decision lacks its actual committed selected row",
        );
    };
    for (const creation of decision.emitted) check(creation.event, false);
    for (const event of decision.continuationEvents) check(event, true);
  }

  assertLifecycleCommitted(
    decision: NativeLifecycleDecision,
    signal: AbortSignal,
    frame?: NativeJournalQueryFrame,
  ): Promise<void> {
    const revision = frame?.revision;
    return this.#enqueue(async () => {
      if (frame) this.#query(frame, revision);
      if (
        decision.unsupported.length ||
        this.#pendingHead.length ||
        this.#post.size
      )
        throw new NativeSessionJournalError(
          "Native lifecycle has unsettled or unsupported producers",
        );
      const document = await this.#owner.readDocument(signal),
        index = indexNativeSession(document);
      this.#checkLifecycle(index, decision);
      if (!frame && decision.continue && !decision.preventContinuation) {
        const continued = new Set(
          decision.continuationEvents.map((event) => event.uuid),
        );
        for (const creation of decision.emitted) {
          const event = this.#observedEvents.get(creation.event.uuid)?.selected;
          if (!event || continued.has(event.uuid)) continue;
          if (
            event.type === "user" ||
            (event.type === "attachment" && event.rendered !== undefined)
          )
            throw new NativeSessionJournalError(
              "Record-only lifecycle output requires its actual live-history disposition adapter",
            );
        }
      }
    });
  }

  recordStopLimit(
    transition: Extract<NativeStopQueryTransition, { kind: "end" }>,
    maxTurns: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (transition.reason === "max-turns")
        return this.#append(
          [
            createNativeAttachmentEvent(
              {
                type: "max_turns_reached",
                maxTurns,
                turnCount: transition.nextTurn,
              },
              this.#stamp("attachment"),
            ),
          ],
          signal,
          undefined,
          "terminal",
        );
      if (transition.reason === "block-cap") {
        if (!transition.warning)
          throw new NativeSessionJournalError(
            "Native Stop cap lacks its actual warning",
          );
        return this.#append(
          [
            validateNativePersistenceEvent({
              type: "system",
              subtype: "informational",
              ...this.#stamp("system"),
              content: transition.warning,
              isMeta: false,
              level: "warning",
            }),
          ],
          signal,
          undefined,
          "terminal",
        );
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }

  commitLifecycleTransition(
    frame: NativeJournalQueryFrame,
    decision: NativeLifecycleDecision,
    signal: AbortSignal,
  ): Promise<void> {
    const revision = frame.revision;
    return this.#enqueue(async () => {
      const state = this.#query(frame, revision);
      if (
        !state.awaitingLifecycle ||
        decision.event !== "Stop" ||
        !decision.continue ||
        decision.preventContinuation ||
        !decision.continuationEvents.length ||
        decision.unsupported.length ||
        this.#post.size ||
        this.#pendingHead.length
      )
        throw new NativeSessionJournalError(
          "Native continuation is not a settled owning Stop transition",
        );
      const document = await this.#owner.readDocument(signal);
      this.#checkLifecycle(indexNativeSession(document), decision);
      this.#addToQuery(state, decision.continuationEvents);
      state.awaitingLifecycle = false;
    });
  }

  /** Read the live owned cursor, never a saved checkpoint or a guessed newest row. */
  async projectRequest(
    options: NativeJournalRequestOptions,
  ): Promise<NativeJournalRequestProjection> {
    const handle = options.frame ?? this.#activeQuery?.handle;
    const revision = options.frameRevision ?? handle?.revision;
    let projected: NativeJournalRequestProjection | undefined;
    await this.#enqueue(async () => {
      if (this.#post.size || this.#pendingHead.length)
        throw new NativeSessionJournalError(
          "A model request cannot precede its actual core result/materialization",
        );
      const frame = handle ? this.#query(handle, revision) : undefined;
      if (frame?.awaitingLifecycle)
        throw new NativeSessionJournalError(
          "Native Stop transition has not committed its actual query vector",
        );
      if (frame && !isDeepStrictEqual(frame.recovery, options.recovery))
        throw new NativeSessionJournalError(
          "Native query recovery policy changed owner",
        );
      const document = await this.#owner.readDocument(options.signal);
      const selected = this.#requestSelection(document, options.recovery);
      const { requestDocument, checkpoints } = selected;
      const ownedRows = frame
        ? this.#queryRows(frame, selected.index)
        : undefined;
      if (!options.requestedModel)
        throw new NativeSessionJournalError(
          "A native request needs its actual current model",
        );
      const projectionOptions: Parameters<
        typeof projectNativeToolRequestContext
      >[1] = {
        ...options,
        host: (nodes) => {
          for (const node of nodes) {
            const message = node.row.message;
            if (
              node.type === "assistant" &&
              isNativeObject(message) &&
              isNativeArray(message.content) &&
              message.content.some(
                (block) =>
                  isNativeObject(block) &&
                  (block.type === "thinking" ||
                    block.type === "redacted_thinking"),
              ) &&
              message.model !== options.requestedModel
            )
              throw new NativeSessionJournalError(
                "Foreign-model native thinking requires its actual signature compatibility host",
              );
          }
          return typeof options.host === "function"
            ? options.host(nodes)
            : options.host;
        },
        selection: selected.selection,
      };
      const projection = ownedRows
        ? await projectNativeOwnedToolRequestContext(
            requestDocument,
            ownedRows,
            projectionOptions,
          )
        : await projectNativeToolRequestContext(
            requestDocument,
            projectionOptions,
          );
      projected = {
        originalDocument: document,
        projection,
        omittedCheckpoints: Object.freeze(
          checkpoints.map((row) => Object.freeze(row)),
        ),
        ...(frame
          ? {
              queryFrame: Object.freeze({
                revision: frame.revision,
                uuids: Object.freeze(frame.entries.map((entry) => entry.uuid)),
              }),
            }
          : {}),
      };
    });
    if (!projected)
      throw new NativeSessionJournalError("Missing owned request projection");
    return projected;
  }

  async close(verificationSignal?: AbortSignal): Promise<void> {
    this.#closing = true;
    let failure: unknown;
    try {
      await this.flush();
      if (verificationSignal)
        await this.#owner.readDocument(verificationSignal);
    } catch (error) {
      failure = error;
    }
    try {
      await this.#owner.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }
}
