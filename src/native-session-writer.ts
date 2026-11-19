import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  appendNativeSessionRows,
  decodeNativeSession,
  encodeNativeSessionRows,
  isNativeObject,
  type NativeJson,
  type NativeObject,
} from "./native-session-codec.js";
import type { Message, Usage } from "./types.js";
import { validateNativePersistenceEvent } from "./native-persistence-events.js";

export interface NativeMessageIdentity {
  uuid: string;
  timestamp: string;
  /** Required for assistant rows unless retained in Message metadata. */
  responseId?: string;
  model?: string;
  usage?: Usage;
  /** The local Message type does not retain API stop_reason; do not guess it. */
  stopReason?: "end_turn" | "tool_use";
}
export type NativeWriterEntry = NativeObject & {
  readonly type: "user" | "assistant" | "attachment" | "progress" | "system";
  readonly uuid: string;
  readonly timestamp: string;
};
const messageKeys = new Set([
  "role",
  "content",
  "responseId",
  "responseModel",
  "model",
  "requestedModel",
  "usage",
]);
const resultKeys = new Set([
  "type",
  "tool_use_id",
  "content",
  "is_error",
  "apiContent",
]);
const blockKeys: Readonly<Record<string, readonly string[]>> = {
  text: ["type", "text"],
  tool_use: ["type", "id", "name", "input"],
  thinking: ["type", "thinking", "signature"],
  redacted_thinking: ["type", "data"],
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function json(value: unknown, active = new Set<object>()): NativeJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || active.has(value))
    throw new TypeError("Native writer requires finite plain JSON");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError("Unsupported native JSON prototype");
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
      throw new TypeError("Unsupported native JSON symbol");
    if (Array.isArray(value) && Object.keys(value).length !== value.length)
      throw new TypeError("Sparse/decorated native array");
    const entries: [string, NativeJson][] = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new TypeError("Unsupported native JSON accessor");
      if (descriptor.value === undefined && !Array.isArray(value)) continue; // Native JSON.stringify omits optional object fields.
      entries.push([key, json(descriptor.value, active)]);
    }
    return Array.isArray(value)
      ? entries.map(([, child]) => child)
      : Object.fromEntries(entries);
  } finally {
    active.delete(value);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function planNativeMessageEntries(
  messages: readonly Message[],
  identities: readonly NativeMessageIdentity[],
  options: {
    knownToolParents?: ReadonlyMap<string, string>;
    projectUnsupportedMessage?(
      message: Readonly<Message>,
      identity: Readonly<NativeMessageIdentity>,
      index: number,
    ): readonly NativeWriterEntry[];
  } = {},
): readonly NativeWriterEntry[] {
  if (messages.length !== identities.length)
    throw new Error(
      "Every native message requires an explicit stable UUID/timestamp identity",
    );
  const entries: NativeWriterEntry[] = [],
    owners = new Map(options.knownToolParents),
    seenCalls = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const original = messages[index],
      identity = identities[index];
    if (!original || !identity)
      throw new Error("Missing native message identity");
    const value = json(original);
    if (
      !isNativeObject(value) ||
      Object.keys(value).some((key) => !messageKeys.has(key)) ||
      (original.role === "user" &&
        Object.keys(value).some(
          (key) => key !== "role" && key !== "content",
        )) ||
      original.content.some((block) =>
        Object.keys(block).some((key) =>
          block.type === "tool_result"
            ? !resultKeys.has(key)
            : !blockKeys[block.type]?.includes(key),
        ),
      )
    ) {
      if (!options.projectUnsupportedMessage)
        throw new Error(
          `Message ${index} has unsupported native catalog/hook/instruction/context metadata`,
        );
      const mapped = options
        .projectUnsupportedMessage(
          freeze(structuredClone(original)),
          Object.freeze({ ...identity }),
          index,
        )
        .map(entryValue);
      for (const entry of mapped)
        if (
          entry.type === "assistant" &&
          isNativeObject(entry.message) &&
          isNativeArray(entry.message.content)
        ) {
          for (const block of entry.message.content)
            if (
              isNativeObject(block) &&
              block.type === "tool_use" &&
              typeof block.id === "string"
            ) {
              if (
                seenCalls.has(block.id) ||
                (owners.has(block.id) && owners.get(block.id) !== entry.uuid)
              )
                throw new Error("Ambiguous mapped native tool parent");
              seenCalls.add(block.id);
              owners.set(block.id, entry.uuid);
            }
        }
      entries.push(...mapped);
      continue;
    }
    if (!original.content.length)
      throw new Error(
        "Empty native message content requires its source projection adapter",
      );
    const content: NativeJson[] = [];
    for (const block of original.content) {
      if (block.type === "tool_result") {
        if (original.role !== "user")
          throw new Error("Native tool results belong to user messages");
        content.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: json(block.apiContent ?? block.content),
          ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
        });
      } else {
        if (original.role === "user" && block.type !== "text")
          throw new Error("Unsupported native user content block");
        const projected = json(block);
        if (!isNativeObject(projected))
          throw new Error("Invalid native content block");
        content.push(projected);
        if (block.type === "tool_use") {
          if (
            block.input === undefined ||
            seenCalls.has(block.id) ||
            (owners.has(block.id) && owners.get(block.id) !== identity.uuid)
          )
            throw new Error("Ambiguous/invalid native tool-use identity");
          seenCalls.add(block.id);
          owners.set(block.id, identity.uuid);
        }
      }
    }
    let body: NativeObject;
    if (original.role === "assistant") {
      const responseId = original.responseId ?? identity.responseId,
        model = original.responseModel ?? identity.model ?? original.model,
        usage = original.usage ?? identity.usage;
      if (!responseId || !model || !usage || !identity.stopReason)
        throw new Error(
          "Assistant native export requires explicit response/model/usage/stop metadata",
        );
      body = {
        id: responseId,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: identity.stopReason,
        stop_sequence: null,
        usage: json(usage),
      };
    } else body = { role: "user", content };
    const sourceOwners = new Set(
      original.content.flatMap((block) =>
        block.type === "tool_result" ? [owners.get(block.tool_use_id)] : [],
      ),
    );
    if (sourceOwners.has(undefined) || sourceOwners.size > 1)
      throw new Error(
        "Native result parent ownership is missing or ambiguous; use an explicit source projection adapter",
      );
    const source = [...sourceOwners][0];
    entries.push(
      freeze({
        type: original.role,
        uuid: identity.uuid,
        timestamp: identity.timestamp,
        message: body,
        ...(original.role === "assistant" &&
        original.requestedModel !== undefined
          ? { requestedModel: original.requestedModel }
          : {}),
        ...(source === undefined ? {} : { sourceToolAssistantUUID: source }),
      }),
    );
  }
  encodeNativeSessionRows(entries);
  return Object.freeze(entries);
}

export interface NativeWriterContext {
  sessionId: string;
  cwd: string;
  version: string;
  entrypoint?: string;
  userType: string;
  sessionKind?: string;
  sidechain: boolean;
  agentId?: string;
  teamName?: string;
  agentName?: string;
}
const passiveFields = {
  "custom-title": "customTitle",
  "ai-title": "aiTitle",
  tag: "tag",
  relocated: "relocatedCwd",
  "agent-name": "agentName",
  "agent-color": "agentColor",
  "agent-setting": "agentSetting",
  mode: "mode",
  "permission-mode": "permissionMode",
} as const;
export type NativeWriterMetadata =
  | { type: keyof typeof passiveFields; value: string }
  | { type: "repl-mode"; value: boolean };
export interface NativeWriterBatch {
  parentUuid: string | null;
  promptId?: string;
  gitBranch?: string;
  slug?: string;
  checkpoint?: boolean;
  metadata?: readonly NativeWriterMetadata[];
}
function isPassiveMetadataType(
  value: NativeJson | undefined,
): value is keyof typeof passiveFields {
  return typeof value === "string" && Object.hasOwn(passiveFields, value);
}
function batchValue(input: NativeWriterBatch): NativeWriterBatch {
  const value = json(input);
  if (
    !isNativeObject(value) ||
    (value.parentUuid !== null && typeof value.parentUuid !== "string") ||
    Object.keys(value).some(
      (key) =>
        ![
          "parentUuid",
          "promptId",
          "gitBranch",
          "slug",
          "checkpoint",
          "metadata",
        ].includes(key),
    )
  )
    throw new Error("Invalid native writer batch");
  const result: NativeWriterBatch = { parentUuid: value.parentUuid };
  for (const key of ["promptId", "gitBranch", "slug"] as const) {
    const field = value[key];
    if (field !== undefined) {
      if (typeof field !== "string")
        throw new Error("Invalid native writer batch string");
      result[key] = field;
    }
  }
  if (value.checkpoint !== undefined) {
    if (typeof value.checkpoint !== "boolean")
      throw new Error("Invalid native writer checkpoint");
    result.checkpoint = value.checkpoint;
  }
  if (value.metadata !== undefined) {
    if (!isNativeArray(value.metadata))
      throw new Error("Invalid native writer metadata");
    result.metadata = value.metadata.map((item) => {
      if (
        !isNativeObject(item) ||
        Object.keys(item).some((key) => key !== "type" && key !== "value")
      )
        throw new Error("Invalid native writer metadata item");
      if (item.type === "repl-mode" && typeof item.value === "boolean")
        return { type: "repl-mode", value: item.value };
      if (isPassiveMetadataType(item.type) && typeof item.value === "string")
        return { type: item.type, value: item.value };
      throw new Error("Unsupported native passive metadata type/value");
    });
  }
  return freeze(result);
}
const reservedEntryKeys = new Set([
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
]);
const unsupportedEntryKeys = new Set([
  "storedAnewFor",
  "sentAsUuid",
  "forkedFrom",
  "wireToolInputs",
  "wireIngestContext",
  "batchToolUses",
  "origin",
  "queueOrigin",
  "effectiveToolInput",
  "effectiveInput",
]);
function isNativeArray(value: NativeJson | undefined): value is NativeJson[] {
  return Array.isArray(value);
}
function isWriterEntry(value: NativeJson): value is NativeWriterEntry {
  return (
    isNativeObject(value) &&
    (value.type === "user" ||
      value.type === "assistant" ||
      value.type === "attachment" ||
      value.type === "system" ||
      value.type === "progress") &&
    typeof value.uuid === "string" &&
    uuidPattern.test(value.uuid) &&
    typeof value.timestamp === "string" &&
    Number.isFinite(Date.parse(value.timestamp))
  );
}
function entryValue(input: NativeWriterEntry): NativeWriterEntry {
  const value = json(input);
  if (!isWriterEntry(value))
    throw new Error("Invalid native writer entry identity/type");
  if (
    Object.keys(value).some(
      (key) => reservedEntryKeys.has(key) || unsupportedEntryKeys.has(key),
    )
  )
    throw new Error("Unsupported pre-enveloped/native transformation input");
  if (
    value.type === "attachment" ||
    value.type === "system" ||
    (value.type === "user" &&
      (value.toolUseResult !== undefined ||
        value.permissionDecision !== undefined))
  )
    return validateNativePersistenceEvent(value);
  if (
    value.type !== "progress" &&
    (!isNativeObject(value.message) || value.message.role !== value.type)
  )
    throw new Error("Invalid native message body");
  return freeze(value);
}
export function envelopeNativeWriterEntries(
  inputs: readonly NativeWriterEntry[],
  context: Readonly<NativeWriterContext>,
  batch: Readonly<NativeWriterBatch>,
  existingUuids: ReadonlySet<string>,
): {
  rows: readonly NativeObject[];
  leafUuid: string | null;
  appended: number;
  metadataAppended: number;
  skipped: number;
} {
  const known = new Set(existingUuids),
    rows: NativeObject[] = [];
  let parent = batch.parentUuid,
    skipped = 0;
  if (context.sidechain && (batch.checkpoint || batch.metadata?.length))
    throw new Error(
      "Main-session metadata cannot be routed into an agent transcript",
    );
  if (parent !== null && !known.has(parent))
    throw new Error(
      "Explicit native parent is absent from the owned transcript",
    );
  for (const input of inputs) {
    const entry = entryValue(input);
    let physicalParent = parent;
    if (
      entry.type === "user" &&
      typeof entry.sourceToolAssistantUUID === "string" &&
      entry.sourceToolAssistantUUID &&
      (context.sidechain || known.has(entry.sourceToolAssistantUUID))
    )
      physicalParent = entry.sourceToolAssistantUUID;
    if (
      context.sidechain &&
      physicalParent !== null &&
      !known.has(physicalParent)
    )
      throw new Error(
        "External sidechain parents require their fork-context adapter",
      );
    if (physicalParent === entry.uuid)
      throw new Error("Native writer refuses a self-referential parent");
    const version =
      typeof entry.version === "string"
        ? entry.version
        : Object.hasOwn(entry, "sessionId")
          ? undefined
          : context.version;
    const freshOther =
      entry.type === "assistant" &&
      entry.madeBy === undefined &&
      !Object.hasOwn(entry, "version") &&
      !Object.hasOwn(entry, "sessionId");
    const row: Record<string, unknown> = {
      parentUuid: physicalParent,
      isSidechain: context.sidechain,
      ...entry,
      ...(freshOther ? { madeBy: "other" } : {}),
      ...(context.sessionKind === undefined
        ? {}
        : { sessionKind: context.sessionKind }),
      userType: context.userType,
      ...(context.entrypoint === undefined
        ? {}
        : { entrypoint: context.entrypoint }),
      cwd: context.cwd,
      sessionId: context.sessionId,
      ...(context.teamName === undefined ? {} : { teamName: context.teamName }),
      ...(context.agentName === undefined
        ? {}
        : { agentName: context.agentName }),
      ...(context.sidechain ? { agentId: context.agentId } : {}),
      ...(entry.type === "user" && batch.promptId !== undefined
        ? { promptId: batch.promptId }
        : {}),
      ...(batch.gitBranch === undefined ? {} : { gitBranch: batch.gitBranch }),
      ...(batch.slug === undefined ? {} : { slug: batch.slug }),
    };
    if (version === undefined) delete row.version;
    else row.version = version;
    if (
      Object.hasOwn(entry, "sessionId") &&
      entry.sessionId !== context.sessionId
    ) {
      if (entry.type === "assistant")
        row.requestSessionId =
          typeof entry.requestSessionId === "string"
            ? entry.requestSessionId
            : entry.sessionId;
      else delete row.requestSessionId;
    }
    if (!context.sidechain && known.has(entry.uuid)) skipped++;
    else {
      const native = json(row);
      if (!isNativeObject(native)) throw new Error("Invalid native envelope");
      rows.push(freeze(native));
      known.add(entry.uuid);
    }
    if (entry.type !== "progress") parent = entry.uuid;
  }
  const appended = rows.length;
  for (const metadata of batch.metadata ?? []) {
    const field =
      metadata.type === "repl-mode" ? "replMode" : passiveFields[metadata.type];
    if (
      !field ||
      (metadata.type === "repl-mode"
        ? typeof metadata.value !== "boolean"
        : typeof metadata.value !== "string")
    )
      throw new Error("Unsupported native passive metadata type/value");
    rows.push(
      freeze({
        type: metadata.type,
        sessionId: context.sessionId,
        [field]: metadata.value,
      }),
    );
  }
  if (batch.checkpoint) {
    if (!parent) throw new Error("Cannot checkpoint an empty native cursor");
    rows.push(
      freeze({
        type: "last-prompt",
        leafUuid: parent,
        sessionId: context.sessionId,
      }),
    );
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    leafUuid: parent,
    appended,
    metadataAppended: rows.length - appended,
    skipped,
  });
}

export interface NativeWriterAdmission {
  stage: "open" | "commit";
  path: string;
  context: Readonly<NativeWriterContext>;
  signal: AbortSignal;
}
export interface NativeSessionWriterOptions {
  path: string;
  context: NativeWriterContext;
  /** All writers of this owned file must participate. No unlocked foreign-writer safety is claimed. */
  withExclusiveOwnership<T>(path: string, work: () => Promise<T>): Promise<T>;
  admit(input: NativeWriterAdmission): boolean | Promise<boolean>;
  /** Host resource bound, not a native ordinary-writer transcript cap. */
  maxFileBytes?: number;
  maxLineBytes?: number;
}
export interface NativeWriterCommit {
  committed: true;
  changed: boolean;
  appended: number;
  metadataAppended: number;
  skipped: number;
  leafUuid: string | null;
  byteLength: number;
  sealedTornTail: boolean;
  directorySynced: boolean;
  abortedAfterCommit: boolean;
}
type Snapshot = { bytes: Buffer; identity: string | undefined; parent: string };
const noEntry = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";
export class NativeSessionWriter {
  readonly #path: string;
  readonly #context: Readonly<NativeWriterContext>;
  readonly #limit: number;
  readonly #lineLimit: number;
  readonly #mainProgressUuids = new Set<string>();
  constructor(readonly options: NativeSessionWriterOptions) {
    if (
      !isAbsolute(options.path) ||
      !options.path.toLowerCase().endsWith(".jsonl") ||
      !isAbsolute(options.context.cwd)
    )
      throw new TypeError(
        "Explicit absolute native transcript/cwd paths are required",
      );
    const context = json(options.context);
    if (!isNativeObject(context)) throw new TypeError("Invalid native context");
    if (
      !options.context.sessionId ||
      !options.context.version ||
      (options.context.entrypoint !== undefined &&
        typeof options.context.entrypoint !== "string") ||
      !options.context.userType ||
      typeof options.context.sidechain !== "boolean"
    )
      throw new TypeError(
        "Explicit native owner/version metadata and a valid optional entrypoint are required",
      );
    if (
      options.context.sidechain
        ? !options.context.agentId ||
          !/^[\w-]{1,128}$/.test(options.context.agentId)
        : options.context.agentId !== undefined
    )
      throw new TypeError(
        "Explicit isolated native agent identity is required for sidechain files only",
      );
    if (
      options.context.sidechain &&
      basename(options.path) !== `agent-${options.context.agentId}.jsonl`
    )
      throw new TypeError(
        "Native sidechain destination must name its admitted agent transcript",
      );
    this.#path = options.path;
    this.#context = freeze(structuredClone(options.context));
    this.#limit = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.#lineLimit = options.maxLineBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1)
      throw new RangeError("Invalid native writer resource bound");
    if (!Number.isSafeInteger(this.#lineLimit) || this.#lineLimit < 1)
      throw new RangeError("Invalid native writer line bound");
  }
  async #snapshot(): Promise<Snapshot> {
    const parent = await realpath(dirname(this.#path));
    let before;
    try {
      before = await lstat(this.#path);
    } catch (error) {
      if (noEntry(error))
        return { bytes: Buffer.alloc(0), identity: undefined, parent };
      throw error;
    }
    if (!before.isFile() || before.nlink !== 1)
      throw new Error(
        "Native writer requires an owned regular non-linked transcript",
      );
    if (before.size > this.#limit)
      throw new RangeError("Native transcript exceeds host writer bound");
    const handle = await open(
      this.#path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.size !== before.size ||
        stat.mtimeMs !== before.mtimeMs
      )
        throw new Error("Native transcript changed while opening");
      if (stat.size > this.#limit)
        throw new RangeError("Native transcript exceeds host writer bound");
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const chunk = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      const after = await handle.stat();
      if (
        length !== stat.size ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs
      )
        throw new Error("Native transcript changed while reading");
      return {
        bytes: buffer.subarray(0, length),
        identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        parent,
      };
    } finally {
      await handle.close();
    }
  }
  async appendEntries(
    inputs: readonly NativeWriterEntry[],
    batch: NativeWriterBatch,
    signal: AbortSignal,
  ): Promise<NativeWriterCommit> {
    const entries = Object.freeze(inputs.map(entryValue));
    const admittedBatch = batchValue(batch);
    return this.options.withExclusiveOwnership(this.#path, async () => {
      signal.throwIfAborted();
      if (
        !(await this.options.admit(
          Object.freeze({
            stage: "open",
            path: this.#path,
            context: this.#context,
            signal,
          }),
        ))
      )
        throw new Error("Native writer ownership admission denied");
      const snapshot = await this.#snapshot(),
        document = decodeNativeSession(snapshot.bytes, {
          parser: "source-line-fallback",
          maxBytes: this.#limit,
          maxLineBytes: this.#lineLimit,
        });
      // Cold native sessionMessages loads Lse.messages without progress; live
      // successful appends add progress UUIDs to that in-process cache.
      const known = new Set(this.#mainProgressUuids);
      for (const line of document.lines) {
        const row = line.value;
        if (!isNativeObject(row)) continue;
        if (
          (row.type === "system" && row.subtype === "compact_boundary") ||
          row.type === "fork-context-ref" ||
          (row.type === "last-prompt" &&
            (row.rewound === true || row.leafUuid === null))
        )
          throw new Error(
            "Native compact/fork/rewind append requires its source adapter",
          );
        if (
          typeof row.type === "string" &&
          ["user", "assistant", "attachment", "system", "progress"].includes(
            row.type,
          )
        ) {
          if (
            row.sessionId !== this.#context.sessionId ||
            (row.isSidechain ?? false) !== this.#context.sidechain ||
            (this.#context.sidechain && row.agentId !== this.#context.agentId)
          )
            throw new Error(
              "Existing native transcript owner does not match writer context",
            );
          if (row.type !== "progress" && typeof row.uuid === "string")
            known.add(row.uuid);
        }
      }
      const prepared = envelopeNativeWriterEntries(
        entries,
        this.#context,
        admittedBatch,
        known,
      );
      if (
        snapshot.identity === undefined &&
        !this.#context.sidechain &&
        prepared.rows.length > 0 &&
        !entries.some(
          (entry) =>
            entry.type === "user" ||
            entry.type === "assistant" ||
            entry.type === "system",
        )
      )
        throw new Error(
          "Fresh progress/metadata requires native deferred materialization or a first conversation row",
        );
      const bytes = Buffer.from(
        appendNativeSessionRows(document, prepared.rows),
      );
      if (bytes.length > this.#limit)
        throw new RangeError("Native transcript exceeds host writer bound");
      for (const row of prepared.rows)
        if (Buffer.byteLength(JSON.stringify(row)) > this.#lineLimit)
          throw new RangeError("Native row exceeds host writer line bound");
      signal.throwIfAborted();
      if (!prepared.rows.length)
        return Object.freeze({
          committed: true,
          changed: false,
          appended: 0,
          metadataAppended: 0,
          skipped: prepared.skipped,
          leafUuid: prepared.leafUuid,
          byteLength: bytes.length,
          sealedTornTail: false,
          directorySynced: false,
          abortedAfterCommit: false,
        });
      if (
        !(await this.options.admit(
          Object.freeze({
            stage: "commit",
            path: this.#path,
            context: this.#context,
            signal,
          }),
        ))
      )
        throw new Error("Native writer commit admission denied");
      const unchanged = async (): Promise<void> => {
        const current = await this.#snapshot();
        if (
          current.parent !== snapshot.parent ||
          current.identity !== snapshot.identity ||
          !current.bytes.equals(snapshot.bytes)
        )
          throw new Error("Native transcript changed before atomic commit");
      };
      await unchanged();
      signal.throwIfAborted();
      const temporary = join(
        dirname(this.#path),
        `.${basename(this.#path)}.${randomUUID()}.tmp`,
      );
      let created = false,
        replaced = false;
      try {
        const handle = await open(temporary, "wx", 0o600);
        created = true;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await unchanged();
        signal.throwIfAborted();
        await rename(temporary, this.#path);
        replaced = true;
        if (!this.#context.sidechain)
          for (const entry of entries)
            if (entry.type === "progress")
              this.#mainProgressUuids.add(entry.uuid);
        let directorySynced = false;
        try {
          const dir = await open(dirname(this.#path), "r");
          try {
            await dir.sync();
            directorySynced = true;
          } finally {
            await dir.close();
          }
        } catch {
          /* Commit happened; report the narrower durability result. */
        }
        return Object.freeze({
          committed: true,
          changed: true,
          appended: prepared.appended,
          metadataAppended: prepared.metadataAppended,
          skipped: prepared.skipped,
          leafUuid: prepared.leafUuid,
          byteLength: bytes.length,
          sealedTornTail: prepared.rows.length > 0 && !document.tailTerminated,
          directorySynced,
          abortedAfterCommit: signal.aborted,
        });
      } finally {
        if (created && !replaced) await unlink(temporary).catch(() => {});
      }
    });
  }
}
export const createNativeSessionWriter = (
  options: NativeSessionWriterOptions,
): NativeSessionWriter => new NativeSessionWriter(options);
