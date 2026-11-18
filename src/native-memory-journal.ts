import { isDeepStrictEqual } from "node:util";
import type { NativeAgentEventJournal } from "./agent.js";
import type { NativeSourceRow, NativeObject } from "./native-session-codec.js";
import { isNativeArray, isNativeObject } from "./native-session-codec.js";
import {
  NativeRetainedMemoryOwner,
  type NativeMemoryAdmissionHost,
  type NativeMemoryProducerCapability,
  type NativeMemoryView,
} from "./native-retained-memory.js";
import {
  nativeResponseRecordingSchema,
  snapshotNativeResponseJson,
  type NativeResponseRecordingHost,
} from "./native-response-recording.js";
import {
  NativeSessionJournalError,
  type NativeJournalQueryFrame,
  type NativeJournalRequestOptions,
  type NativeJournalToolResult,
  type NativeSessionJournalHost,
} from "./native-session-journal.js";
import {
  createNativeAttachmentEvent,
  validateNativePersistenceEvent,
} from "./native-persistence-events.js";
import {
  projectNativeRetainedToolRequestContext,
  type NativeToolContextRendering,
} from "./native-tool-context.js";
import type {
  NativeLifecycleCaptureHost,
  NativeLifecycleDecision,
} from "./native-lifecycle-hooks.js";
import type {
  NativeAttachmentCaptureHost,
  NativeAttachmentCaptureResult,
  NativeAttachmentDelivery,
} from "./native-attachment-capture.js";
import type {
  NativeInstructionCaptureResult,
  NativeInstructionPayloadFile,
} from "./native-instruction-capture.js";
import type { NativePromptSnapshotCreation } from "./native-prompt-snapshot.js";
import type { NativeStopQueryTransition } from "./native-stop-query.js";
import type { Message, PermissionMode } from "./types.js";
import {
  nativeHookProgressRetention,
  validateNativeHookProgressRow,
  validateNativeStopHookSummaryRow,
  type NativeHookProgressRetentionInput,
  type NativeStopHookSummaryCreation,
} from "./native-hook-progress.js";

export interface NativeMemoryJournalView {
  readonly kind: "ephemeral";
  readonly state: NativeMemoryView;
}
export interface NativeMemoryJournalRequest {
  readonly kind: "ephemeral";
  readonly retentionRevision: number;
  readonly queryFrame?: {
    readonly revision: number;
    readonly uuids: readonly string[];
  };
  readonly projection: NativeToolContextRendering<NativeSourceRow>;
}
export interface NativeMemoryJournalHost {
  stamp: NativeSessionJournalHost["stamp"];
  /** Actual producer/consumer ownership. There is no file-writer admission fallback. */
  admission: NativeMemoryAdmissionHost;
}
interface Frame {
  handle: NativeJournalQueryFrame;
  revision: number;
  rows: NativeObject[];
  ids: Set<string>;
  recovery: NativeJournalRequestOptions["recovery"];
  pending: boolean;
  retired: boolean;
  progress: Set<string>;
}
class NativeMemoryJournalClosingError extends NativeSessionJournalError {}

/**
 * Actual finalized retention and query ownership without a transcript backend.
 * Source creation identities remain raw; no file envelopes, graph or checkpoint
 * is manufactured to satisfy the durable journal's API.
 */
export class NativeMemoryJournal implements NativeAgentEventJournal<
  NativeMemoryJournalView,
  NativeSourceRow
> {
  readonly #memory: NativeRetainedMemoryOwner;
  readonly #producer: NativeMemoryProducerCapability;
  readonly #host: NativeMemoryJournalHost;
  readonly #observed = new Map<string, NativeObject>();
  readonly #calls = new Map<string, string>();
  readonly #completed = new Set<string>();
  readonly #post = new Map<string, NativeObject[]>();
  readonly #frames = new WeakMap<NativeJournalQueryFrame, Frame>();
  #active: Frame | undefined;
  #instructions: readonly NativeInstructionPayloadFile[] | undefined;
  #tail: Promise<void> = Promise.resolve();
  #failure: NativeSessionJournalError | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;

  private constructor(
    memory: NativeRetainedMemoryOwner,
    producer: NativeMemoryProducerCapability,
    host: NativeMemoryJournalHost,
  ) {
    this.#memory = memory;
    this.#producer = producer;
    this.#host = Object.freeze({
      stamp: host.stamp.bind(host),
      admission: host.admission,
    });
  }
  static async open(
    options: { sessionId: string },
    host: NativeMemoryJournalHost,
    signal: AbortSignal,
  ): Promise<NativeMemoryJournal> {
    signal.throwIfAborted();
    const actualHost = Object.freeze({
      stamp: host.stamp.bind(host),
      admission: host.admission,
    });
    const memory = NativeRetainedMemoryOwner.open(options, host.admission);
    try {
      const producer = await memory.admitProducer(
        {
          name: "actual-finalized-native-consumers",
          kinds: ["user", "assistant", "attachment", "system", "progress"],
        },
        signal,
      );
      return new NativeMemoryJournal(memory, producer, actualHost);
    } catch (error) {
      await memory.close().catch(() => {});
      throw error;
    }
  }
  #reject(error: unknown): NativeSessionJournalError {
    if (error instanceof NativeMemoryJournalClosingError) return error;
    this.#failure ??=
      error instanceof NativeSessionJournalError
        ? error
        : new NativeSessionJournalError("Native retained journal failed", {
            cause: error,
          });
    return this.#failure;
  }
  producerFailure(error: unknown): never {
    throw this.#reject(error);
  }
  #accept(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing)
      throw new NativeMemoryJournalClosingError(
        "Native retained journal is closing",
      );
  }
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.#accept();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      try {
        return await work();
      } catch (error) {
        throw this.#reject(error);
      }
    });
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  #stamp(kind: Parameters<NativeSessionJournalHost["stamp"]>[0]) {
    this.#accept();
    try {
      return Object.freeze({ ...this.#host.stamp(kind) });
    } catch (error) {
      throw this.#reject(error);
    }
  }
  #capture(input: readonly NativeObject[]): readonly NativeObject[] {
    const saved = snapshotNativeResponseJson(input);
    if (!isNativeArray(saved) || !saved.every(isNativeObject))
      throw new NativeSessionJournalError(
        "Missing actual retained source rows",
      );
    return Object.freeze([...saved]);
  }
  #settled(): void {
    if (this.#post.size)
      throw new NativeSessionJournalError(
        "Retained Post events await their actual core result",
      );
  }
  #frame(handle: NativeJournalQueryFrame, revision?: number): Frame {
    const frame = this.#frames.get(handle);
    if (!frame || frame.retired || frame !== this.#active)
      throw new NativeSessionJournalError(
        "Unknown or retired native query owner",
      );
    if (revision !== undefined && revision !== frame.revision)
      throw new NativeSessionJournalError("Native query revision changed");
    return frame;
  }
  #add(frame: Frame, rows: readonly NativeObject[]): void {
    const added = new Set<string>();
    for (const row of rows) {
      if (
        typeof row.uuid !== "string" ||
        added.has(row.uuid) ||
        frame.ids.has(row.uuid) ||
        !isDeepStrictEqual(this.#observed.get(row.uuid), row)
      )
        throw new NativeSessionJournalError(
          "Native query lacks a unique actual retained producer",
        );
      added.add(row.uuid);
    }
    for (const row of rows) {
      if (typeof row.uuid !== "string")
        throw new NativeSessionJournalError(
          "Missing actual query row identity",
        );
      frame.rows.push(row);
      frame.ids.add(row.uuid);
    }
    if (rows.length) frame.revision++;
  }
  async #retain(
    rows: readonly NativeObject[],
    signal: AbortSignal,
    delivery: "ordinary" | "lifecycle" | "terminal",
  ): Promise<void> {
    signal.throwIfAborted();
    const frame = this.#active;
    if (
      frame &&
      ((delivery === "ordinary" && frame.pending) ||
        (delivery === "lifecycle" && !frame.pending))
    )
      throw new NativeSessionJournalError(
        "Native producer arrived outside its owning query transition",
      );
    const ids = new Set<string>(),
      calls = new Map<string, string>();
    for (const row of rows) {
      if (
        typeof row.uuid !== "string" ||
        ids.has(row.uuid) ||
        this.#observed.has(row.uuid)
      )
        throw new NativeSessionJournalError(
          "Native creation identity was already retained or absent",
        );
      ids.add(row.uuid);
      if (
        row.type !== "assistant" ||
        !isNativeObject(row.message) ||
        !isNativeArray(row.message.content)
      )
        continue;
      for (const block of row.message.content) {
        if (!isNativeObject(block) || block.type !== "tool_use") continue;
        if (
          typeof block.id !== "string" ||
          this.#calls.has(block.id) ||
          calls.has(block.id)
        )
          throw new NativeSessionJournalError(
            "Native tool call identity has multiple source owners",
          );
        calls.set(block.id, row.uuid);
      }
    }
    await this.#memory.retain(this.#producer, rows, { signal });
    for (const row of rows)
      if (typeof row.uuid === "string") this.#observed.set(row.uuid, row);
    for (const [id, owner] of calls) this.#calls.set(id, owner);
    if (frame) {
      if (delivery === "ordinary") this.#add(frame, rows);
      else if (rows.length) {
        if (delivery === "lifecycle")
          for (const row of rows)
            if (row.type === "progress" && typeof row.uuid === "string")
              frame.progress.add(row.uuid);
        frame.revision++;
      }
    }
  }
  #append(
    input: readonly NativeObject[],
    signal: AbortSignal,
    delivery: "ordinary" | "lifecycle" | "terminal" = "ordinary",
  ): Promise<void> {
    try {
      this.#accept();
      const saved = this.#capture(input);
      return this.#enqueue(() => this.#retain(saved, signal, delivery));
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
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
        !promptId ||
        message.role !== "user" ||
        message.content.some((block) => block.type !== "text")
      )
        throw new NativeSessionJournalError(
          "Human prompt requires its actual text producer and identity",
        );
      return this.#append(
        [
          validateNativePersistenceEvent({
            type: "user",
            ...this.#stamp("user"),
            message,
            ...(permissionMode === undefined ? {} : { permissionMode }),
          }),
        ],
        signal,
      );
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  stampAttachment() {
    return this.#stamp("attachment");
  }
  stampHookProgress() {
    return this.#stamp("progress");
  }
  stampStopSummary() {
    return this.#stamp("system");
  }
  captureHookProgress(
    input: unknown,
    policy: NativeHookProgressRetentionInput,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#accept();
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
        (!this.#active?.pending || row.data.hookEvent !== "Stop")
      )
        throw new NativeSessionJournalError(
          "Retained Stop progress lacks its actual main-query phase",
        );
      return this.#append([row], signal, "lifecycle");
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  captureStopSummary(
    creation: NativeStopHookSummaryCreation,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#accept();
      if (creation.status === "absent") return Promise.resolve();
      const row = validateNativeStopHookSummaryRow(creation.row),
        frame = this.#active;
      const observed = frame
        ? [...frame.progress].map((uuid) => this.#observed.get(uuid))
        : [];
      if (
        !frame?.pending ||
        !observed.length ||
        row.hookCount !== observed.length ||
        row.toolUseID !== observed.at(-1)?.toolUseID
      )
        throw new NativeSessionJournalError(
          "Stop summary lacks its actual observed progress owner",
        );
      return this.#append([row], signal, "lifecycle");
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  instructionState() {
    return this.#instructions === undefined
      ? undefined
      : structuredClone(this.#instructions);
  }
  capturePromptSnapshot(
    creation: NativePromptSnapshotCreation,
    signal: AbortSignal,
  ): Promise<void> {
    try {
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
          "Prompt snapshot lost its actual creation provenance",
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
      this.#accept();
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
  lifecycleHost(
    signal: AbortSignal,
  ): Pick<NativeLifecycleCaptureHost, "stamp" | "capture" | "unsupported"> {
    return {
      stamp: ({ kind }) =>
        this.#stamp(kind === "attachment" ? "attachment" : "user"),
      capture: (creation) => {
        try {
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
          return this.#append([event], signal, "lifecycle");
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
      this.#accept();
      if (result.status !== "captured")
        throw new NativeSessionJournalError(result.reasons.join("; "));
      const event = validateNativePersistenceEvent(result.event);
      if (delivery.kind !== "tool-hook") return this.#append([event], signal);
      const callId = delivery.call.id,
        phase = delivery.phase;
      if (result.facts.source !== "tool-hook")
        throw new NativeSessionJournalError(
          "Hook attachment has a foreign creation source",
        );
      const source = result.facts.source,
        resultCall = result.facts.toolUseID,
        resultPhase = result.facts.phase;
      return this.#enqueue(async () => {
        signal.throwIfAborted();
        if (
          source !== "tool-hook" ||
          resultCall !== callId ||
          resultPhase !== phase ||
          !this.#calls.has(callId) ||
          this.#completed.has(callId)
        )
          throw new NativeSessionJournalError(
            "Hook attachment lacks its active actual tool owner",
          );
        if (phase === "pre") await this.#retain([event], signal, "ordinary");
        else this.#post.set(callId, [...(this.#post.get(callId) ?? []), event]);
      });
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  recordToolResult(
    input: NativeJournalToolResult,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#accept();
      const result = input.result,
        callId = result.tool_use_id,
        parent = this.#calls.get(callId);
      if (!parent || this.#completed.has(callId))
        throw new NativeSessionJournalError(
          "Tool result lacks its unique actual assistant owner",
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
      return this.#enqueue(async () => {
        if (this.#completed.has(callId))
          throw new NativeSessionJournalError(
            "Tool result was already retained",
          );
        const post = this.#post.get(callId) ?? [];
        await this.#retain([event, ...post], signal, "ordinary");
        this.#post.delete(callId);
        this.#completed.add(callId);
      });
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  assertToolResultCommitted(id: string): void {
    this.#accept();
    if (!this.#completed.has(id))
      throw this.#reject(
        new NativeSessionJournalError(
          "Tool completion lacks its actual retained producer",
        ),
      );
  }
  async #view(signal: AbortSignal): Promise<NativeMemoryJournalView> {
    signal.throwIfAborted();
    return Object.freeze({
      kind: "ephemeral",
      state: await this.#memory.view(signal),
    });
  }
  readCommitted(signal: AbortSignal): Promise<NativeMemoryJournalView> {
    return this.#enqueue(async () => {
      this.#settled();
      return this.#view(signal);
    });
  }
  beginQueryFrame(
    recovery: NativeJournalRequestOptions["recovery"],
    signal: AbortSignal,
  ): Promise<NativeJournalQueryFrame> {
    const actualRecovery = structuredClone(recovery);
    return this.#enqueue(async () => {
      this.#settled();
      if (this.#active)
        throw new NativeSessionJournalError(
          "Native query already has an active owner",
        );
      const view = await this.#view(signal),
        rows = view.state.entries.map((entry) => entry.row);
      if (!rows.some((row) => row.type === "user" || row.type === "assistant"))
        throw new NativeSessionJournalError(
          "Native query requires actual conversation",
        );
      let frame: Frame;
      const handle = Object.freeze({
        get revision() {
          return frame.revision;
        },
      });
      frame = {
        handle,
        revision: 0,
        rows,
        ids: new Set(rows.map((row) => row.uuid)),
        recovery: actualRecovery,
        pending: false,
        retired: false,
        progress: new Set(),
      };
      this.#frames.set(handle, frame);
      this.#active = frame;
      return handle;
    });
  }
  endQueryFrame(handle: NativeJournalQueryFrame): void {
    const frame = this.#frame(handle);
    frame.retired = true;
    this.#active = undefined;
  }
  beginLifecycleTransition(
    handle: NativeJournalQueryFrame,
    signal: AbortSignal,
  ): Promise<void> {
    const revision = handle.revision;
    return this.#enqueue(async () => {
      this.#settled();
      signal.throwIfAborted();
      const frame = this.#frame(handle, revision);
      if (frame.pending)
        throw new NativeSessionJournalError(
          "Native lifecycle transition is already pending",
        );
      frame.pending = true;
      frame.progress.clear();
      frame.revision++;
    });
  }
  #checkDecision(decision: NativeLifecycleDecision): void {
    if (decision.unsupported.length)
      throw new NativeSessionJournalError(
        "Native lifecycle has unsupported producers",
      );
    const check = (event: NativeObject) => {
      if (
        typeof event.uuid !== "string" ||
        !isDeepStrictEqual(this.#observed.get(event.uuid), event)
      )
        throw new NativeSessionJournalError(
          "Lifecycle decision contains an unowned creation",
        );
    };
    for (const creation of decision.emitted) check(creation.event);
    for (const event of decision.continuationEvents) check(event);
  }
  assertLifecycleCommitted(
    decision: NativeLifecycleDecision,
    signal: AbortSignal,
    handle?: NativeJournalQueryFrame,
  ): Promise<void> {
    let actual: NativeLifecycleDecision;
    try {
      snapshotNativeResponseJson(decision);
      actual = structuredClone(decision);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
    const revision = handle?.revision;
    return this.#enqueue(async () => {
      this.#settled();
      signal.throwIfAborted();
      if (handle) this.#frame(handle, revision);
      this.#checkDecision(actual);
      if (!handle && actual.continue && !actual.preventContinuation)
        throw new NativeSessionJournalError(
          "A native continuation requires its actual query owner",
        );
    });
  }
  commitLifecycleTransition(
    handle: NativeJournalQueryFrame,
    decision: NativeLifecycleDecision,
    signal: AbortSignal,
  ): Promise<void> {
    let actual: NativeLifecycleDecision;
    try {
      snapshotNativeResponseJson(decision);
      actual = structuredClone(decision);
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
    const revision = handle.revision;
    return this.#enqueue(async () => {
      this.#settled();
      signal.throwIfAborted();
      const frame = this.#frame(handle, revision);
      if (
        !frame.pending ||
        actual.event !== "Stop" ||
        !actual.continue ||
        actual.preventContinuation ||
        !actual.continuationEvents.length
      )
        throw new NativeSessionJournalError(
          "Native continuation is not an owning Stop transition",
        );
      this.#checkDecision(actual);
      this.#add(frame, actual.continuationEvents);
      frame.pending = false;
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
          "terminal",
        );
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(this.#reject(error));
    }
  }
  projectRequest(
    options: NativeJournalRequestOptions<NativeSourceRow>,
  ): Promise<NativeMemoryJournalRequest> {
    const handle = options.frame ?? this.#active?.handle,
      revision = options.frameRevision ?? handle?.revision;
    return this.#enqueue(async () => {
      this.#settled();
      const frame = handle ? this.#frame(handle, revision) : undefined;
      if (frame?.pending)
        throw new NativeSessionJournalError(
          "Native Stop transition has not committed its query vector",
        );
      if (frame && !isDeepStrictEqual(frame.recovery, options.recovery))
        throw new NativeSessionJournalError(
          "Native query recovery policy changed owner",
        );
      if (!options.requestedModel)
        throw new NativeSessionJournalError(
          "Native request requires actual current model",
        );
      const view = await this.#view(options.signal),
        rows = frame?.rows ?? view.state.entries.map((entry) => entry.row);
      const retained = new Map(
        view.state.entries.map((entry) => [entry.row.uuid, entry.row]),
      );
      const nodes: NativeSourceRow[] = [];
      for (const row of rows) {
        if (
          typeof row.uuid !== "string" ||
          typeof row.type !== "string" ||
          !isDeepStrictEqual(retained.get(row.uuid), row)
        )
          throw new NativeSessionJournalError(
            "Native query row lost its actual retained ownership",
          );
        const message = row.message;
        if (
          row.type === "assistant" &&
          isNativeObject(message) &&
          isNativeArray(message.content) &&
          message.content.some(
            (block) =>
              isNativeObject(block) &&
              (block.type === "thinking" || block.type === "redacted_thinking"),
          ) &&
          message.model !== options.requestedModel
        )
          throw new NativeSessionJournalError(
            "Foreign-model native thinking requires its actual signature compatibility host",
          );
        nodes.push(Object.freeze({ uuid: row.uuid, type: row.type, row }));
      }
      const leaf = nodes.findLast(
        (node) => node.type === "user" || node.type === "assistant",
      );
      if (!leaf)
        throw new NativeSessionJournalError(
          "Native query requires actual conversation",
        );
      const projection = await projectNativeRetainedToolRequestContext(
        Object.freeze({
          leafUuid: leaf.uuid,
          nodes: Object.freeze(nodes),
          diagnostics: Object.freeze([]),
        }),
        options,
      );
      return Object.freeze({
        kind: "ephemeral",
        retentionRevision: view.state.revision,
        ...(frame
          ? {
              queryFrame: Object.freeze({
                revision: frame.revision,
                uuids: Object.freeze([...frame.ids]),
              }),
            }
          : {}),
        projection,
      });
    });
  }
  async flush(signal: AbortSignal): Promise<void> {
    await this.#tail;
    if (this.#failure) throw this.#failure;
    try {
      this.#settled();
      await this.#memory.flush(signal);
    } catch (error) {
      throw this.#reject(error);
    }
  }
  close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#closed = (async () => {
      let failure: unknown;
      try {
        await this.flush(signal);
      } catch (error) {
        failure = error;
      }
      try {
        await this.#memory.close();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })();
    return this.#closed;
  }
}
