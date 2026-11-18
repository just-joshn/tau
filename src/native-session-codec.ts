/** Lossless native transcript inspection. This is not the native resume/API projector. */
export type NativeJson = null | boolean | number | string | readonly NativeJson[] | { readonly [key: string]: NativeJson };
export type NativeObject = { readonly [key: string]: NativeJson };
export interface NativeSessionDiagnostic {
  readonly code: string;
  readonly line?: number;
  readonly uuid?: string;
}
export interface NativeSessionLine {
  readonly line: number;
  /** UTF-8 byte offsets, including any BOM and the terminating LF. */
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly terminated: boolean;
  readonly kind: "record" | "blank" | "invalid";
  readonly value?: NativeJson;
  /** A fresh copy; modifying it cannot change serialization. */
  rawBytes(): Uint8Array;
}
export interface NativeSessionDocument {
  readonly parser: "source-line-fallback";
  readonly byteLength: number;
  readonly tailTerminated: boolean;
  readonly lines: readonly NativeSessionLine[];
  readonly diagnostics: readonly NativeSessionDiagnostic[];
}
export interface NativeSessionDecodeOptions {
  /** Explicitly selects the recovered Node buffer fallback, not Bun JSONL.parseChunk. */
  parser: "source-line-fallback";
  /** Helper resource limits, not claims about native loader limits. */
  maxBytes?: number;
  maxLineBytes?: number;
  maxLines?: number;
}
const documents = new WeakMap<NativeSessionDocument, Buffer>();
function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`Invalid ${name}`);
  return result;
}
function freezeJson(value: NativeJson): NativeJson {
  const pending: object[] = value !== null && typeof value === "object" ? [value] : [];
  for (const object of pending) {
    const children: unknown[] = Object.values(object);
    for (const child of children) if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(object);
  }
  return value;
}
function isNativeJson(value: unknown): value is NativeJson {
  const pending: unknown[] = [value];
  for (const item of pending) {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") continue;
    if (typeof item !== "object") return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    const children: unknown[] = Object.values(item);
    for (const child of children) pending.push(child);
  }
  return true;
}
export function isNativeObject(value: NativeJson | undefined): value is NativeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isNativeArray(value: NativeJson | undefined): value is readonly NativeJson[] {
  return Array.isArray(value);
}
export function decodeNativeSession(input: Uint8Array, options: NativeSessionDecodeOptions): NativeSessionDocument {
  if (options.parser !== "source-line-fallback") throw new TypeError("Unsupported native session parser");
  const maxBytes = limit(options.maxBytes, 64 * 1024 * 1024, "maxBytes");
  const maxLineBytes = limit(options.maxLineBytes, 16 * 1024 * 1024, "maxLineBytes");
  const maxLines = limit(options.maxLines, 1_000_000, "maxLines");
  if (input.byteLength > maxBytes) throw new RangeError("Native session exceeds maxBytes");
  const bytes = Buffer.from(input);
  const lines: NativeSessionLine[] = [], diagnostics: NativeSessionDiagnostic[] = [];
  const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  for (let start = 0; start < bytes.length;) {
    if (lines.length >= maxLines) throw new RangeError("Native session exceeds maxLines");
    const lf = bytes.indexOf(10, start), contentEnd = lf < 0 ? bytes.length : lf;
    const terminated = lf >= 0, end = contentEnd + (terminated ? 1 : 0);
    if (contentEnd - start > maxLineBytes) throw new RangeError("Native session exceeds maxLineBytes");
    const text = bytes.toString("utf8", start === 0 && bom ? 3 : start, contentEnd).trim();
    let kind: NativeSessionLine["kind"] = "blank", value: NativeJson | undefined;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!isNativeJson(parsed)) throw new TypeError("Unsupported JSON value");
        value = freezeJson(parsed); kind = "record";
      }
      catch { kind = "invalid"; diagnostics.push({ code: "invalid-json-line", line: lines.length + 1 }); }
    }
    const line = lines.length + 1, from = start, to = end;
    lines.push(Object.freeze({ line, start, contentEnd, end, terminated, kind,
      ...(kind === "record" && value !== undefined ? { value } : {}), rawBytes: () => Uint8Array.from(bytes.subarray(from, to)) }));
    start = end;
  }
  const tailTerminated = bytes.length === 0 || bytes[bytes.length - 1] === 10;
  if (!tailTerminated) diagnostics.push({ code: "unterminated-tail", line: lines.length });
  const document: NativeSessionDocument = Object.freeze({ parser: options.parser, byteLength: bytes.length,
    tailTerminated, lines: Object.freeze(lines), diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))) });
  documents.set(document, bytes);
  return document;
}
function original(document: NativeSessionDocument): Buffer {
  const bytes = documents.get(document);
  if (!bytes) throw new TypeError("Expected a decoded native session document");
  return bytes;
}
export function serializeNativeSession(document: NativeSessionDocument): Uint8Array {
  return Uint8Array.from(original(document));
}
/** Author fresh JSON rows without invoking getters, toJSON methods, or prototype behavior. */
export function encodeNativeSessionRows(rows: readonly NativeJson[]): Uint8Array {
  const stack: { value: unknown; exit?: boolean }[] = [];
  const active = new Set<object>();
  for (const row of rows) {
    stack.push({ value: row });
    for (let item = stack.pop(); item; item = stack.pop()) {
      const { value, exit } = item;
      if (value === null || typeof value === "string" || typeof value === "boolean") continue;
      if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number"); continue; }
      if (typeof value !== "object") throw new TypeError("Unsupported JSON value");
      if (exit) { active.delete(value); continue; }
      if (active.has(value)) throw new TypeError("Cyclic JSON value");
      if (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Unsupported JSON prototype");
      active.add(value); stack.push({ value, exit: true });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some(key => typeof key === "symbol")) throw new TypeError("Symbol JSON key");
      if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new TypeError("Sparse or decorated JSON array");
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(value) && key === "length") continue;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Unsupported JSON property");
        stack.push({ value: descriptor.value });
      }
    }
  }
  return Buffer.from(rows.map(row => JSON.stringify(row) + "\n").join(""));
}
/** Native torn-tail sealing appends LF; it does not discard the existing tail. */
export function appendNativeSessionRows(document: NativeSessionDocument, rows: readonly NativeJson[]): Uint8Array {
  const bytes = original(document), encoded = encodeNativeSessionRows(rows);
  if (encoded.length === 0) return Uint8Array.from(bytes);
  return Buffer.concat([bytes, !document.tailTerminated ? Buffer.from("\n") : Buffer.alloc(0), encoded]);
}
const conversationTypes = new Set(["user", "assistant", "attachment", "system"]);
export interface NativeTranscriptNode {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly type: string;
  readonly row: NativeObject;
  readonly line: number;
}
export interface NativeSessionIndex {
  readonly nodes: ReadonlyMap<string, NativeTranscriptNode>;
  /** Raw topology candidates only: checkpoints, repairs, and native branch selection are not applied. */
  readonly rawLeafUuids: readonly string[];
  readonly rawMainLeafUuids: readonly string[];
  readonly diagnostics: readonly NativeSessionDiagnostic[];
}
export function indexNativeSession(document: NativeSessionDocument): NativeSessionIndex {
  original(document);
  const nodes = new Map<string, NativeTranscriptNode>(), diagnostics: NativeSessionDiagnostic[] = [];
  for (const line of document.lines) {
    const row = line.value;
    if (!isNativeObject(row) || typeof row.type !== "string" || !conversationTypes.has(row.type)) continue;
    if (typeof row.uuid !== "string" || !row.uuid || (row.parentUuid !== null && typeof row.parentUuid !== "string")) {
      diagnostics.push({ code: "invalid-transcript-envelope", line: line.line }); continue;
    }
    if (nodes.has(row.uuid)) diagnostics.push({ code: "duplicate-uuid-last-wins", line: line.line, uuid: row.uuid });
    nodes.set(row.uuid, Object.freeze({ uuid: row.uuid, parentUuid: row.parentUuid, type: row.type, row, line: line.line }));
  }
  const parents = new Set<string>(), hasUserAssistantChild = new Set<string>();
  for (const node of nodes.values()) {
    if (node.parentUuid) {
      parents.add(node.parentUuid);
      if (node.type === "user" || node.type === "assistant") hasUserAssistantChild.add(node.parentUuid);
      if (!nodes.has(node.parentUuid)) diagnostics.push({ code: "missing-parent", uuid: node.uuid, line: node.line });
    }
  }
  const leaves = new Map<string, NativeTranscriptNode>();
  for (const terminal of nodes.values()) {
    if (parents.has(terminal.uuid)) continue;
    const seen = new Set<string>(); let node: NativeTranscriptNode | undefined = terminal;
    while (node) {
      if (seen.has(node.uuid)) { diagnostics.push({ code: "parent-cycle", uuid: node.uuid }); break; }
      seen.add(node.uuid);
      if (node.type === "user" || node.type === "assistant") {
        if (!hasUserAssistantChild.has(node.uuid)) leaves.set(node.uuid, node);
        break;
      }
      node = node.parentUuid ? nodes.get(node.parentUuid) : undefined;
    }
  }
  return Object.freeze({ nodes, rawLeafUuids: Object.freeze([...leaves.keys()]),
    rawMainLeafUuids: Object.freeze([...leaves].filter(([, leaf]) => leaf.row.isSidechain !== true).map(([uuid]) => uuid)),
    diagnostics: Object.freeze(diagnostics) });
}
export interface NativeParentChain {
  readonly leafUuid: string;
  readonly nodes: readonly NativeTranscriptNode[];
  readonly complete: boolean;
  readonly diagnostics: readonly NativeSessionDiagnostic[];
}
/** Explicit raw leaf only. No timestamp repairs, sibling recovery, or API message conversion. */
export function traceNativeParentChain(index: NativeSessionIndex, leafUuid: string): NativeParentChain {
  const nodes: NativeTranscriptNode[] = [], diagnostics: NativeSessionDiagnostic[] = [], seen = new Set<string>();
  let uuid: string | null = leafUuid;
  while (uuid !== null) {
    if (seen.has(uuid)) { diagnostics.push({ code: "parent-cycle", uuid }); break; }
    seen.add(uuid);
    const node = index.nodes.get(uuid);
    if (!node) { diagnostics.push({ code: nodes.length ? "missing-parent" : "missing-leaf", uuid }); break; }
    nodes.push(node); uuid = node.parentUuid;
  }
  return Object.freeze({ leafUuid, nodes: Object.freeze(nodes.reverse()), complete: uuid === null,
    diagnostics: Object.freeze(diagnostics) });
}
const simpleMetadataFields: Readonly<Record<string, string>> = {
  "custom-title": "customTitle", "ai-title": "aiTitle", tag: "tag", relocated: "relocatedCwd",
  "agent-name": "agentName", "agent-color": "agentColor", "agent-setting": "agentSetting",
  mode: "mode", "permission-mode": "permissionMode", "isolation-latch": "side", "worktree-state": "worktreeSession",
};
export interface NativeSessionMetadata {
  readonly valuesByTypeAndSession: ReadonlyMap<string, ReadonlyMap<string, NativeJson | undefined>>;
  readonly summariesByLeaf: ReadonlyMap<string, NativeJson | undefined>;
  readonly historySuppressedSessions: ReadonlySet<string>;
  readonly fileSnapshotsByMessage: ReadonlyMap<string, NativeObject>;
  readonly fileDeltasByMessage: ReadonlyMap<string, readonly NativeObject[]>;
  readonly attributionSnapshot: NativeObject | undefined;
  /** Preserve order and full payload; these checkpoints are not applied to leaf selection. */
  readonly checkpoints: readonly NativeObject[];
  /** Every non-conversation record, including unsupported and future metadata. */
  readonly records: readonly NativeJson[];
}
export function foldSupportedNativeMetadata(document: NativeSessionDocument): NativeSessionMetadata {
  original(document);
  const values = new Map<string, Map<string, NativeJson | undefined>>(), summaries = new Map<string, NativeJson | undefined>();
  const suppressed = new Set<string>(), snapshots = new Map<string, NativeObject>(), deltas = new Map<string, NativeObject[]>();
  const checkpoints: NativeObject[] = [], records: NativeJson[] = []; let attribution: NativeObject | undefined;
  for (const line of document.lines) {
    const row = line.value;
    if (line.kind !== "record" || row === undefined) continue;
    if (isNativeObject(row) && typeof row.type === "string" && conversationTypes.has(row.type)) continue;
    records.push(row);
    if (!isNativeObject(row) || typeof row.type !== "string") continue;
    if (row.type === "summary" && typeof row.leafUuid === "string" && row.leafUuid) summaries.set(row.leafUuid, row.summary);
    const field = simpleMetadataFields[row.type];
    if (field && typeof row.sessionId === "string" && row.sessionId) {
      let map = values.get(row.type); if (!map) values.set(row.type, map = new Map<string, NativeJson | undefined>()); map.set(row.sessionId, row[field]);
    }
    if (row.type === "last-prompt") checkpoints.push(row);
    if (row.type === "history-suppression" && typeof row.sessionId === "string" && row.sessionId) suppressed.add(row.sessionId);
    if (row.type === "file-history-snapshot" && typeof row.messageId === "string") snapshots.set(row.messageId, row);
    if (row.type === "file-history-delta" && typeof row.messageId === "string") {
      let list = deltas.get(row.messageId); if (!list) deltas.set(row.messageId, list = []); list.push(row);
    }
    if (row.type === "attribution-snapshot") attribution = row;
  }
  for (const list of deltas.values()) Object.freeze(list);
  return Object.freeze({ valuesByTypeAndSession: values, summariesByLeaf: summaries, historySuppressedSessions: suppressed,
    fileSnapshotsByMessage: snapshots, fileDeltasByMessage: deltas, attributionSnapshot: attribution,
    checkpoints: Object.freeze(checkpoints), records: Object.freeze(records) });
}
