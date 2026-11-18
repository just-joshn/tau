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
} from "./native-session-codec.js";
import {
  NativeSessionPersistence,
  type NativeSessionPersistenceOptions,
} from "./native-session-persistence.js";
import type { Message, PermissionMode, ToolResult } from "./types.js";
import {
  projectNativeToolRequestContext,
  type NativeToolContextProjection,
} from "./native-tool-context.js";

export type NativeJournalRequestOptions = Omit<
  Parameters<typeof projectNativeToolRequestContext>[1],
  "selection"
> & {
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
    kind: "user" | "assistant" | "attachment" | "tool-result",
  ): NativeResponseIdentity;
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
    this.#host = host;
    this.#sessionId = sessionId;
  }

  static async open(
    options: NativeSessionPersistenceOptions,
    host: NativeSessionJournalHost,
    signal: AbortSignal,
  ): Promise<NativeSessionJournal> {
    const owner = await NativeSessionPersistence.open(options, signal);
    const journal = new NativeSessionJournal(
      owner,
      host,
      options.context.sessionId,
    );
    try {
      const document = await owner.readDocument(signal);
      for (const line of document.lines) {
        const row = line.value;
        if (!isNativeObject(row)) continue;
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

  #admit(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing)
      throw new NativeSessionJournalError("Native session journal is closing");
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    try {
      this.#admit();
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      try {
        await work();
      } catch (error) {
        throw this.#reject(error);
      }
    });
    this.#tail = run.catch(() => {});
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
  ): Promise<void> {
    const captured = captureNativePersistenceEvents(events);
    return this.#enqueue(async () => {
      await this.#owner.appendEvents(
        captured,
        promptId === undefined ? {} : { promptId },
        signal,
      );
      for (const event of captured) this.#index(event);
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
    if (this.#post.size)
      throw this.#reject(
        new NativeSessionJournalError(
          "Post-hook events await their actual core result",
        ),
      );
  }

  /** Read the live owned cursor, never a saved checkpoint or a guessed newest row. */
  async projectRequest(
    options: NativeJournalRequestOptions,
  ): Promise<NativeJournalRequestProjection> {
    let projected: NativeJournalRequestProjection | undefined;
    await this.#enqueue(async () => {
      if (this.#post.size)
        throw new NativeSessionJournalError(
          "A model request cannot precede its actual core result",
        );
      const document = await this.#owner.readDocument(options.signal),
        index = indexNativeSession(document),
        cursor = this.#owner.state().cursorUuid;
      let leaf = cursor === null ? undefined : index.nodes.get(cursor);
      const visited = new Set<string>();
      while (leaf?.type === "attachment") {
        if (visited.has(leaf.uuid))
          throw new NativeSessionJournalError("Cyclic live journal cursor");
        visited.add(leaf.uuid);
        leaf =
          leaf.parentUuid === null
            ? undefined
            : index.nodes.get(leaf.parentUuid);
      }
      if (!leaf || (leaf.type !== "user" && leaf.type !== "assistant"))
        throw new NativeSessionJournalError(
          "A live model request requires its actual conversational cursor",
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
      const projection = await projectNativeToolRequestContext(
        requestDocument,
        {
          ...options,
          selection: {
            leafUuid: leaf.uuid,
            scope: { kind: "main", sessionId: this.#sessionId },
            recovery: options.recovery,
          },
        },
      );
      if (!options.requestedModel)
        throw new NativeSessionJournalError(
          "A native request needs its actual current model",
        );
      for (const message of projection.messages)
        if (
          message.role === "assistant" &&
          message.content.some(
            (block) =>
              block.type === "thinking" || block.type === "redacted_thinking",
          ) &&
          message.responseModel !== options.requestedModel
        )
          throw new NativeSessionJournalError(
            "Foreign-model native thinking requires its actual signature compatibility host",
          );
      projected = {
        originalDocument: document,
        projection,
        omittedCheckpoints: Object.freeze(
          checkpoints.map((row) => Object.freeze(row)),
        ),
      };
    });
    if (!projected)
      throw new NativeSessionJournalError("Missing owned request projection");
    return projected;
  }

  async close(): Promise<void> {
    this.#closing = true;
    let failure: unknown;
    try {
      await this.flush();
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
