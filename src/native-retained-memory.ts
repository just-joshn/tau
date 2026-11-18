import {
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeObject,
} from "./native-session-codec.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";

export type NativeMemoryRowKind =
  "user" | "assistant" | "attachment" | "system" | "progress";
export interface NativeMemoryRawRow extends NativeObject {
  readonly type: NativeMemoryRowKind;
  readonly uuid: string;
  readonly timestamp: string;
}
export interface NativeMemoryProducerDescriptor {
  readonly name: string;
  readonly kinds: readonly NativeMemoryRowKind[];
}
/** Authority is object identity in one owner, never the descriptor's field values. */
export interface NativeMemoryProducerCapability {
  readonly descriptor: NativeMemoryProducerDescriptor;
}
export interface NativeMemoryEntry {
  readonly sequence: number;
  readonly producer: NativeMemoryProducerDescriptor;
  readonly row: NativeMemoryRawRow;
}
export interface NativeMemoryView {
  readonly kind: "ephemeral";
  readonly sessionId: string;
  readonly revision: number;
  readonly nextSequence: number;
  readonly status: "open" | "closing" | "closed";
  readonly entries: readonly NativeMemoryEntry[];
  readonly failure?: { readonly message: string };
}
export interface NativeMemoryAdmissionHost {
  admitProducer(
    input: Readonly<{
      sessionId: string;
      producer: NativeMemoryProducerDescriptor;
    }>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  /** The actual producer owner validates full payload/provenance; this grants no model projection. */
  admitRetention(
    input: Readonly<{
      sessionId: string;
      producer: NativeMemoryProducerDescriptor;
      revision: number;
      nextSequence: number;
      rows: readonly NativeMemoryRawRow[];
    }>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
}
export class NativeMemoryOwnerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NativeMemoryOwnerError";
  }
}
export class NativeMemoryCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeMemoryCapabilityError";
  }
}
export class NativeMemoryConflictError extends Error {
  constructor() {
    super("The actual retained-history revision changed");
    this.name = "NativeMemoryConflictError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function kind(input: unknown): input is NativeMemoryRowKind {
  return (
    input === "user" ||
    input === "assistant" ||
    input === "attachment" ||
    input === "system" ||
    input === "progress"
  );
}
function nonempty(input: unknown): input is string {
  return typeof input === "string" && input.length > 0;
}
function fail(message: string): never {
  throw new NativeMemoryOwnerError(message);
}
function descriptor(
  input: NativeMemoryProducerDescriptor,
): NativeMemoryProducerDescriptor {
  const value = snapshotNativeResponseJson(input);
  if (
    !isNativeObject(value) ||
    Object.keys(value).some((key) => key !== "name" && key !== "kinds") ||
    !nonempty(value.name) ||
    !isNativeArray(value.kinds) ||
    value.kinds.length === 0 ||
    !value.kinds.every(kind) ||
    new Set(value.kinds).size !== value.kinds.length
  )
    return fail(
      "Missing actual memory producer name or retained row categories",
    );
  return Object.freeze({
    name: value.name,
    kinds: Object.freeze([...value.kinds]),
  });
}
function isRow(value: NativeJson): value is NativeMemoryRawRow {
  if (
    !isNativeObject(value) ||
    !kind(value.type) ||
    typeof value.uuid !== "string" ||
    !uuid.test(value.uuid) ||
    !nonempty(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp))
  )
    return false;
  for (const field of ["parentUuid", "logicalParentUuid", "isSidechain"])
    if (Object.hasOwn(value, field))
      fail(
        "Restored/enveloped native rows require their actual initial-source adapter",
      );
  if (value.type === "user" || value.type === "assistant") {
    const message = value.message;
    if (!isNativeObject(message) || message.role !== value.type) return false;
    if (value.type === "assistant")
      return (
        isNativeArray(message.content) &&
        nonempty(message.id) &&
        nonempty(message.model) &&
        message.type === "message" &&
        isNativeObject(message.usage) &&
        nonempty(message.stop_reason)
      );
    return (
      typeof message.content === "string" || isNativeArray(message.content)
    );
  }
  if (value.type === "attachment")
    return isNativeObject(value.attachment) && nonempty(value.attachment.type);
  if (value.type === "system") return nonempty(value.subtype);
  return isNativeObject(value.data) && nonempty(value.data.type);
}
function rows(input: readonly NativeObject[]): readonly NativeMemoryRawRow[] {
  const value = snapshotNativeResponseJson(input);
  if (!isNativeArray(value) || !value.every(isRow))
    return fail(
      "Memory retention requires actual identified, finalized native rows",
    );
  return Object.freeze([...value]);
}
interface ProducerState {
  readonly descriptor: NativeMemoryProducerDescriptor;
  retired: boolean;
}

/** Finalized source retention, independent of native disk selection, envelopes and API projection. */
export class NativeRetainedMemoryOwner {
  readonly #sessionId: string;
  readonly #host: NativeMemoryAdmissionHost;
  readonly #producers = new Map<
    NativeMemoryProducerCapability,
    ProducerState
  >();
  readonly #uuids = new Set<string>();
  readonly #entries: NativeMemoryEntry[] = [];
  #revision = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: NativeMemoryOwnerError | undefined;
  #closing = false;
  #closed = false;
  #close: Promise<NativeMemoryView> | undefined;
  private constructor(sessionId: string, host: NativeMemoryAdmissionHost) {
    this.#sessionId = sessionId;
    this.#host = Object.freeze({
      admitProducer: host.admitProducer.bind(host),
      admitRetention: host.admitRetention.bind(host),
    });
  }
  static open(
    options: { sessionId: string },
    host: NativeMemoryAdmissionHost,
  ): NativeRetainedMemoryOwner {
    const saved = snapshotNativeResponseJson(options);
    if (
      !isNativeObject(saved) ||
      Object.keys(saved).some((key) => key !== "sessionId") ||
      !nonempty(saved.sessionId)
    )
      return fail(
        "A fresh ephemeral owner needs its actual session identity; restored history needs an explicit adapter",
      );
    if (
      typeof host.admitProducer !== "function" ||
      typeof host.admitRetention !== "function"
    )
      return fail("Actual producer and retention admission hosts are required");
    return new NativeRetainedMemoryOwner(saved.sessionId, host);
  }
  #mutable(): void {
    if (this.#closing || this.#closed)
      throw new NativeMemoryCapabilityError(
        "The ephemeral owner is closing or closed",
      );
  }
  #producer(capability: NativeMemoryProducerCapability): ProducerState {
    const state = this.#producers.get(capability);
    if (!state || state.retired)
      throw new NativeMemoryCapabilityError(
        "Foreign or retired retained-event producer capability",
      );
    return state;
  }
  #enqueue<T>(operation: () => Promise<T>, readOnly = false): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#failure && !readOnly) throw this.#failure;
      return operation();
    });
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  #owned<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof NativeMemoryCapabilityError ||
          error instanceof NativeMemoryConflictError ||
          (signal.aborted && error === signal.reason)
        )
          throw error;
        this.#failure ??=
          error instanceof NativeMemoryOwnerError
            ? error
            : new NativeMemoryOwnerError(
                "The actual retained-event owner failed",
                error,
              );
        throw this.#failure;
      }
    });
  }
  async #admission(
    callback: () => boolean | Promise<boolean>,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await callback();
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw error;
      // Host-thrown conflict/capability classes are still host failures, not
      // authority to bypass the retained owner's failure latch.
      throw new NativeMemoryOwnerError(
        "The actual retained-event admission failed",
        error,
      );
    }
  }
  admitProducer(
    input: NativeMemoryProducerDescriptor,
    signal: AbortSignal,
  ): Promise<NativeMemoryProducerCapability> {
    try {
      this.#mutable();
    } catch (error) {
      return Promise.reject(error);
    }
    let saved: NativeMemoryProducerDescriptor | undefined,
      captureError: unknown;
    try {
      saved = descriptor(input);
    } catch (error) {
      captureError = error;
    }
    return this.#owned(async () => {
      if (!saved) throw captureError;
      const actualProducer = saved;
      const allowed = await this.#admission(
        () =>
          this.#host.admitProducer(
            Object.freeze({
              sessionId: this.#sessionId,
              producer: actualProducer,
            }),
            signal,
          ),
        signal,
      );
      signal.throwIfAborted();
      if (allowed !== true)
        return fail("The actual memory producer was not admitted");
      const capability = Object.freeze({ descriptor: saved });
      this.#producers.set(capability, { descriptor: saved, retired: false });
      return capability;
    }, signal);
  }
  retain(
    capability: NativeMemoryProducerCapability,
    input: readonly NativeObject[],
    options: { signal: AbortSignal; expectedRevision?: number },
  ): Promise<NativeMemoryView> {
    try {
      this.#mutable();
      this.#producer(capability);
    } catch (error) {
      return Promise.reject(error);
    }
    let saved: readonly NativeMemoryRawRow[] | undefined, captureError: unknown;
    try {
      saved = rows(input);
    } catch (error) {
      captureError = error;
    }
    const { signal, expectedRevision } = options;
    return this.#owned(async () => {
      const producer = this.#producer(capability);
      if (expectedRevision !== undefined && expectedRevision !== this.#revision)
        throw new NativeMemoryConflictError();
      if (!saved) throw captureError;
      if (
        !Number.isSafeInteger(this.#revision + 1) ||
        !Number.isSafeInteger(this.#entries.length + saved.length + 1)
      )
        return fail("Retained source sequence exceeds the finite owner range");
      const added = new Set<string>();
      for (const row of saved) {
        if (!producer.descriptor.kinds.includes(row.type))
          return fail(
            "The actual producer does not own this retained row category",
          );
        if (this.#uuids.has(row.uuid) || added.has(row.uuid))
          return fail(
            "A finalized source UUID cannot be retained twice or replaced",
          );
        added.add(row.uuid);
      }
      const actualRows = saved;
      const allowed = await this.#admission(
        () =>
          this.#host.admitRetention(
            Object.freeze({
              sessionId: this.#sessionId,
              producer: producer.descriptor,
              revision: this.#revision,
              nextSequence: this.#entries.length + 1,
              rows: actualRows,
            }),
            signal,
          ),
        signal,
      );
      signal.throwIfAborted();
      if (allowed !== true)
        return fail("The actual retained source rows were not admitted");
      for (const row of saved) {
        this.#uuids.add(row.uuid);
        this.#entries.push(
          Object.freeze({
            sequence: this.#entries.length + 1,
            producer: producer.descriptor,
            row,
          }),
        );
      }
      if (saved.length) this.#revision++;
      return this.#view();
    }, signal);
  }
  retireProducer(
    capability: NativeMemoryProducerCapability,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.#mutable();
      this.#producer(capability);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#owned(async () => {
      this.#producer(capability).retired = true;
    }, signal);
  }
  #view(): NativeMemoryView {
    return Object.freeze({
      kind: "ephemeral",
      sessionId: this.#sessionId,
      revision: this.#revision,
      nextSequence: this.#entries.length + 1,
      status: this.#closed ? "closed" : this.#closing ? "closing" : "open",
      entries: Object.freeze([...this.#entries]),
      ...(this.#failure
        ? { failure: Object.freeze({ message: this.#failure.message }) }
        : {}),
    });
  }
  view(signal: AbortSignal): Promise<NativeMemoryView> {
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      return this.#view();
    }, true);
  }
  flush(signal: AbortSignal): Promise<NativeMemoryView> {
    return this.view(signal);
  }
  close(): Promise<NativeMemoryView> {
    if (this.#close) return this.#close;
    this.#closing = true;
    this.#close = this.#enqueue(async () => {
      for (const state of this.#producers.values()) state.retired = true;
      this.#closed = true;
      if (this.#failure) throw this.#failure;
      return this.#view();
    }, true);
    return this.#close;
  }
}
