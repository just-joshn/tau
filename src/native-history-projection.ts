import { isNativeArray, isNativeObject, indexNativeSession, traceNativeParentChain, type NativeJson, type NativeObject,
  type NativeSessionDocument, type NativeSessionIndex, type NativeTranscriptNode } from "./native-session-codec.js";
import { apiToolContentSchema, assistantBlockSchema, type Message } from "./types.js";

export type NativeHistoryScope = { kind: "main"; sessionId: string } | { kind: "agent"; sessionId: string; agentId: string };
export interface NativeHistoryOptions {
  /** Selection belongs to the caller: this helper never chooses a latest leaf. */
  leafUuid: string;
  scope: NativeHistoryScope;
  /** Native feature-reader values must be supplied by the importing host. */
  recovery: {
    callIdToolResults: boolean;
    descendantOrder: "depth-first" | "breadth-first";
    timestampFallback: "reject" | "source-5s";
  };
}
export interface NativeHistoryDiagnostic { code: string; uuid?: string; relatedUuid?: string }
export interface NativeRecoveredHistory {
  readonly leafUuid: string;
  readonly nodes: readonly NativeTranscriptNode[];
  readonly diagnostics: readonly NativeHistoryDiagnostic[];
}
export interface NativeHistoryProjection extends NativeRecoveredHistory {
  /** Detached owned messages. Mutating these cannot modify the lossless document. */
  readonly messages: Message[];
  readonly messageSources: readonly (readonly string[])[];
}
export class NativeHistoryProjectionError extends Error {
  constructor(readonly code: string, readonly uuid?: string) { super(`Native history projection: ${code}${uuid ? ` (${uuid})` : ""}`); this.name = "NativeHistoryProjectionError"; }
}
function fail(code: string, node?: NativeTranscriptNode): never { throw new NativeHistoryProjectionError(code, node?.uuid); }
const message = (node: NativeTranscriptNode): NativeObject | undefined => isNativeObject(node.row.message) ? node.row.message : undefined;
const response = (node: NativeTranscriptNode): string | undefined => {
  const id = message(node)?.id; return node.type === "assistant" && typeof id === "string" && id ? id : undefined;
};
function ids(node: NativeTranscriptNode, kind: "tool_use" | "tool_result"): string[] {
  if (node.type !== (kind === "tool_use" ? "assistant" : "user")) return [];
  const content = message(node)?.content;
  if (!isNativeArray(content)) return [];
  return content.flatMap(block => {
    if (!isNativeObject(block) || block.type !== kind) return [];
    const id = block[kind === "tool_use" ? "id" : "tool_use_id"]; return typeof id === "string" ? [id] : [];
  });
}
function scopeMatches(node: NativeTranscriptNode, scope: NativeHistoryScope): boolean {
  return node.row.sessionId === scope.sessionId && (scope.kind === "main"
    ? node.row.isSidechain !== true && node.row.agentId === undefined
    : node.row.isSidechain === true && node.row.agentId === scope.agentId);
}
const sameSide = (a: NativeTranscriptNode, b: NativeTranscriptNode): boolean =>
  (a.row.isSidechain ?? false) === (b.row.isSidechain ?? false) && a.row.agentId === b.row.agentId;
function continuation(node: NativeTranscriptNode, id: string): boolean {
  if (node.type === "assistant") return response(node) === id;
  if (node.type === "user") return node.row.isMeta === true || ids(node, "tool_result").length > 0;
  return node.type === "attachment" || node.type === "system" && node.row.subtype !== "compact_boundary";
}
function contextTail(node: NativeTranscriptNode): boolean {
  return node.type === "attachment" || node.type === "system" && node.row.subtype !== "compact_boundary" ||
    node.type === "user" && node.row.isMeta === true && ids(node, "tool_result").length === 0;
}
const clone = <T>(value: T): T => structuredClone(value);
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left: [string, unknown][] = Object.entries(a), right = new Map<string, unknown>(Object.entries(b));
  return left.length === right.size && left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)));
}

/** Upn/Esr's supported graph stage. This is separate from checkpoint selection and resume policy. */
export function reconstructNativeHistory(index: NativeSessionIndex, options: NativeHistoryOptions): NativeRecoveredHistory {
  if (typeof options.leafUuid !== "string" || !options.leafUuid || typeof options.scope.sessionId !== "string" || !options.scope.sessionId ||
    !["main", "agent"].includes(options.scope.kind) || options.scope.kind === "agent" && !options.scope.agentId) throw new TypeError("Explicit native history identity is required");
  if (typeof options.recovery.callIdToolResults !== "boolean" || !["depth-first", "breadth-first"].includes(options.recovery.descendantOrder) ||
    !["reject", "source-5s"].includes(options.recovery.timestampFallback)) throw new TypeError("Explicit native recovery profile is required");
  const all = [...index.nodes.values()], order = new Map(all.map((node, position) => [node.uuid, position]));
  const ordinal = (node: NativeTranscriptNode): number => order.get(node.uuid) ?? fail("unindexed-node", node);
  const leaf = index.nodes.get(options.leafUuid);
  if (!leaf) throw new NativeHistoryProjectionError("missing-leaf", options.leafUuid);
  if (!scopeMatches(leaf, options.scope)) fail("scope-mismatch", leaf);
  if (leaf.type !== "user" && leaf.type !== "assistant") fail("leaf-must-be-conversational", leaf);
  const diagnostics: NativeHistoryDiagnostic[] = [];
  const raw = traceNativeParentChain(index, leaf.uuid);
  let chain = [...raw.nodes];
  if (!raw.complete) {
    if (options.recovery.timestampFallback === "reject") throw new NativeHistoryProjectionError(raw.diagnostics[0]?.code ?? "incomplete-chain", raw.diagnostics[0]?.uuid);
    const reversed: NativeTranscriptNode[] = [], visited = new Set<string>();
    let current: NativeTranscriptNode | undefined = leaf;
    while (current) {
      if (visited.has(current.uuid)) fail("parent-cycle", current);
      visited.add(current.uuid); reversed.push(current);
      if (current.parentUuid === null) break;
      let parent = index.nodes.get(current.parentUuid);
      if (!parent || visited.has(parent.uuid)) {
        const time: number = typeof current.row.timestamp === "string" ? Date.parse(current.row.timestamp) : NaN;
        const sidechain = current.row.isSidechain;
        const candidates: { node: NativeTranscriptNode; time: number }[] = all
          .flatMap(node => !visited.has(node.uuid) && node.row.isSidechain === sidechain && !(node.type === "system" && node.row.subtype === "file_snapshot") &&
            typeof node.row.timestamp === "string" ? [{ node, time: Date.parse(node.row.timestamp) }] : [])
          .filter(item => Number.isFinite(time) && item.time <= time && time - item.time <= 5000)
          .sort((a, b) => b.time - a.time || ordinal(a.node) - ordinal(b.node));
        parent = candidates[0]?.node;
        if (!parent) fail("unrecoverable-parent", current);
        diagnostics.push({ code: "timestamp-parent-recovered", uuid: current.uuid, relatedUuid: parent.uuid });
      }
      current = parent;
    }
    chain = reversed.reverse();
  }
  for (const node of chain) if (!scopeMatches(node, options.scope)) fail("cross-scope-parent-chain", node);
  const seen = new Set(chain.map(node => node.uuid));
  const groups = new Map<string, NativeTranscriptNode[]>(), results: NativeTranscriptNode[] = [];
  const children = new Map<string, NativeTranscriptNode[]>();
  for (const node of all) {
    const id = response(node);
    if (id) { const group = groups.get(id) ?? []; group.push(node); groups.set(id, group); }
    if (ids(node, "tool_result").length) results.push(node);
    if (node.parentUuid) { const list = children.get(node.parentUuid) ?? []; list.push(node); children.set(node.parentUuid, list); }
  }
  const callOwners = new Map<string, NativeTranscriptNode | null>();
  for (const group of groups.values()) for (const node of group) for (const id of ids(node, "tool_use")) {
    const previous = callOwners.get(id);
    callOwners.set(id, previous === undefined || previous !== null && response(previous) === response(node) ? node : null);
  }
  const linked = new Map<string, NativeTranscriptNode[]>();
  const link = (uuid: string, node: NativeTranscriptNode): void => {
    const list = linked.get(uuid) ?? []; if (!list.some(item => item.uuid === node.uuid)) list.push(node); linked.set(uuid, list);
  };
  for (const result of results) {
    if (result.parentUuid) link(result.parentUuid, result);
    if (!options.recovery.callIdToolResults) continue;
    const parent = result.parentUuid ? index.nodes.get(result.parentUuid) : undefined;
    if (ids(result, "tool_result").every(id => parent && ids(parent, "tool_use").includes(id))) continue;
    const sourceId = result.row.sourceToolAssistantUUID;
    const source = typeof sourceId === "string" && sourceId !== result.parentUuid ? index.nodes.get(sourceId) : undefined;
    if (source && sameSide(source, result)) link(source.uuid, result);
    for (const id of ids(result, "tool_result")) {
      const owner = callOwners.get(id);
      if (owner && owner.uuid !== result.parentUuid && sameSide(owner, result)) link(owner.uuid, result);
    }
  }
  const effective = new Map<string, number>();
  const rank = (node: NativeTranscriptNode): number => effective.get(node.uuid) ?? ordinal(node);
  const compare = (a: NativeTranscriptNode, b: NativeTranscriptNode): number => rank(a) - rank(b) || ordinal(a) - ordinal(b);
  const chainPositions = new Map(chain.map((node, position) => [node.uuid, position]));
  const windows: { start: number; end: number; recovered: NativeTranscriptNode[]; anchored: Map<string, NativeTranscriptNode[]> }[] = [];
  const processed = new Set<string>(), alreadyAnswered = new Set(chain.flatMap(node => ids(node, "tool_result")));
  for (const [start, anchor] of chain.entries()) {
    if (anchor.type !== "assistant") continue;
    const id = response(anchor); if (!id || processed.has(id)) continue; processed.add(id);
    const group = groups.get(id) ?? fail("missing-response-group", anchor);
    for (const node of group) if (!scopeMatches(node, options.scope)) fail("response-id-crosses-scope", node);
    const groupIds = new Set(group.map(node => node.uuid));
    const missing = group.filter(node => !seen.has(node.uuid)), direct: NativeTranscriptNode[] = [], detached: NativeTranscriptNode[] = [];
    const candidates = new Set<string>();
    for (const node of group) for (const result of linked.get(node.uuid) ?? []) {
      if (seen.has(result.uuid) || candidates.has(result.uuid)) continue;
      candidates.add(result.uuid);
      if (!scopeMatches(result, options.scope)) fail("tool-result-crosses-scope", result);
      (result.parentUuid && groupIds.has(result.parentUuid) ? direct : detached).push(result);
    }
    const answered = new Set([...alreadyAnswered, ...direct.flatMap(node => ids(node, "tool_result"))]);
    const lastFragment = Math.max(...group.map(ordinal));
    for (const result of detached.sort(compare)) {
      const calls = ids(result, "tool_result");
      if (!calls.some(call => { const owner = callOwners.get(call); return !answered.has(call) && owner && groupIds.has(owner.uuid); })) continue;
      calls.forEach(call => answered.add(call)); effective.set(result.uuid, Math.max(ordinal(result), lastFragment + 0.5)); direct.push(result);
      diagnostics.push({ code: "tool-result-reconnected", uuid: result.uuid });
    }
    const recovered = [...missing, ...direct]; recovered.forEach(node => seen.add(node.uuid));
    let end = Math.max(start + 1, ...group.map(node => (chainPositions.get(node.uuid) ?? -1) + 1));
    for (let next = chain[end]; next && continuation(next, id); next = chain[end]) end++;
    const anchored = new Map<string, NativeTranscriptNode[]>();
    const recoverTails = (parent: NativeTranscriptNode, target: NativeTranscriptNode[]): void => {
      for (const child of children.get(parent.uuid) ?? []) {
        const path: NativeTranscriptNode[] = []; let current: NativeTranscriptNode | undefined = child;
        while (current) {
          if (seen.has(current.uuid) || current.row.isSidechain !== parent.row.isSidechain || !contextTail(current)) { path.length = 0; break; }
          if (!scopeMatches(current, options.scope)) fail("context-tail-crosses-scope", current);
          path.push(current);
          const next: NativeTranscriptNode[] = (children.get(current.uuid) ?? []).filter(node => !seen.has(node.uuid));
          if (next.length > 1) { path.length = 0; break; } current = next[0];
          if (path.length > all.length) fail("context-tail-cycle", child);
        }
        for (const node of path) { seen.add(node.uuid); target.push(node); if (effective.has(parent.uuid)) effective.set(node.uuid, Math.max(ordinal(node), rank(parent))); }
      }
    };
    if (group.some(node => ids(node, "tool_use").length)) {
      for (const node of [...group, ...group.flatMap(item => (linked.get(item.uuid) ?? []).filter(result => seen.has(result.uuid)))]) recoverTails(node, recovered);
      for (const node of chain.slice(start + 1, end)) if (contextTail(node)) { const tail: NativeTranscriptNode[] = []; recoverTails(node, tail); if (tail.length) anchored.set(node.uuid, tail); }
    }
    if (recovered.length || anchored.size) windows.push({ start, end, recovered: recovered.sort(compare), anchored });
    missing.forEach(node => diagnostics.push({ code: "assistant-fragment-recovered", uuid: node.uuid }));
  }
  const merged: typeof windows = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && window.start < previous.end) {
      previous.end = Math.max(previous.end, window.end); previous.recovered.push(...window.recovered); previous.recovered.sort(compare);
      for (const [uuid, nodes] of window.anchored) previous.anchored.set(uuid, [...previous.anchored.get(uuid) ?? [], ...nodes]);
    } else merged.push(window);
  }
  const rebuilt: NativeTranscriptNode[] = []; let cursor = 0;
  for (const window of merged) {
    rebuilt.push(...chain.slice(cursor, window.start + 1)); let recoveredIndex = 0;
    for (const node of chain.slice(window.start + 1, window.end)) {
      for (let next = window.recovered[recoveredIndex]; next && rank(next) < ordinal(node); next = window.recovered[recoveredIndex]) { rebuilt.push(next); recoveredIndex++; }
      rebuilt.push(node, ...window.anchored.get(node.uuid) ?? []);
    }
    rebuilt.push(...window.recovered.slice(recoveredIndex)); cursor = window.end;
  }
  rebuilt.push(...chain.slice(cursor)); chain = rebuilt;
  // SZt restricts this last expansion to non-user/assistant descendants of the selected leaf.
  const nonConversationChildren = (node: NativeTranscriptNode): NativeTranscriptNode[] => (children.get(node.uuid) ?? [])
    .filter(item => item.type !== "user" && item.type !== "assistant" && !seen.has(item.uuid));
  const byTime = (a: NativeTranscriptNode, b: NativeTranscriptNode): number => {
    const left = String(a.row.timestamp), right = String(b.row.timestamp); return left < right ? -1 : left > right ? 1 : 0;
  };
  const pending = [leaf], descendants: NativeTranscriptNode[] = [];
  const take = (): NativeTranscriptNode | undefined => options.recovery.descendantOrder === "depth-first" ? pending.pop() : pending.shift();
  for (let parent = take(); parent; parent = take()) {
    if (parent !== leaf) { if (seen.has(parent.uuid)) continue; seen.add(parent.uuid); descendants.push(parent); }
    const children = nonConversationChildren(parent);
    if (options.recovery.descendantOrder === "depth-first") pending.push(...children.sort(byTime).reverse()); else pending.push(...children);
  }
  if (options.recovery.descendantOrder === "breadth-first") descendants.sort(byTime);
  chain.push(...descendants);
  for (const node of chain) if (!scopeMatches(node, options.scope)) fail("recovered-node-crosses-scope", node);
  if (new Set(chain.map(node => node.uuid)).size !== chain.length) throw new NativeHistoryProjectionError("duplicate-recovered-node");
  return Object.freeze({ leafUuid: leaf.uuid, nodes: Object.freeze(chain), diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))) });
}

function strictKeys(object: NativeObject, allowed: readonly string[], node: NativeTranscriptNode): void {
  if (Object.keys(object).some(key => !allowed.includes(key))) fail("unsupported-content-field", node);
}
type ProjectedRow = { kind: "user"; message: Message } | { kind: "assistant"; message: Message; responseId: string };
function projectRow(node: NativeTranscriptNode): ProjectedRow {
  if (node.type !== "user" && node.type !== "assistant") fail(node.row.subtype === "compact_boundary" ? "unsupported-compaction" : "unsupported-context-row", node);
  if (node.row.sentAsUuid !== undefined || node.row.storedAnewFor !== undefined) fail("unsupported-user-identity-migration", node);
  if (node.row.isApiErrorMessage === true || node.row.madeBy === "input" || node.row.retractedMessageUuids !== undefined ||
    node.row.interruptedByShutdown === true || node.row.isVisibleInTranscriptOnly === true || node.row.wireToolInputs !== undefined ||
    node.row.wireIngestContext !== undefined || node.row.batchToolUses !== undefined || node.row.isVirtual === true ||
    node.row.isMeta === true || node.row.turnCompanion === true || node.row.sourceToolUseID !== undefined ||
    node.row.origin !== undefined || node.row.queueOrigin !== undefined || node.row.pluginPrompt !== undefined ||
    node.row.hiddenPictures !== undefined || node.row.withdrawnBefore !== undefined || node.row.contentReplacement !== undefined)
    fail("unsupported-resume-row-transform", node);
  const native = message(node); if (!native || native.role !== node.type) fail("invalid-message-envelope", node);
  const content: NativeJson | undefined = typeof native.content === "string" ? [{ type: "text", text: native.content }] : native.content;
  if (!isNativeArray(content) || content.length === 0) fail("empty-or-invalid-content", node);
  const blocks: Message["content"] = [];
  for (const value of content) {
    if (!isNativeObject(value)) fail("invalid-content-block", node);
    if (value.type === "tool_result" && node.type === "user") {
      strictKeys(value, ["type", "tool_use_id", "content", "is_error"], node);
      if (typeof value.tool_use_id !== "string" || value.is_error !== undefined && typeof value.is_error !== "boolean") fail("invalid-tool-result", node);
      if (typeof value.content === "string") blocks.push({ type: "tool_result", tool_use_id: value.tool_use_id, content: value.content,
        ...(value.is_error === undefined ? {} : { is_error: value.is_error }) });
      else {
        if (!isNativeArray(value.content)) fail("unsupported-tool-result-content", node);
        const parsed = apiToolContentSchema.array().safeParse(value.content);
        if (!parsed.success || !sameJson(parsed.data, value.content)) fail("unsupported-tool-result-content", node);
        blocks.push({ type: "tool_result", tool_use_id: value.tool_use_id, content: parsed.data.filter(item => item.type === "text").map(item => item.text).join("\n"), apiContent: clone(parsed.data),
          ...(value.is_error === undefined ? {} : { is_error: value.is_error }) });
      }
      continue;
    }
    const keys = value.type === "text" ? ["type", "text"] : value.type === "thinking" ? ["type", "thinking", "signature"] :
      value.type === "redacted_thinking" ? ["type", "data"] : value.type === "tool_use" ? ["type", "id", "name", "input"] : [];
    strictKeys(value, keys, node);
    const parsed = assistantBlockSchema.safeParse(value);
    if (!parsed.success || node.type === "user" && parsed.data.type !== "text") fail("unsupported-content-block", node);
    blocks.push(clone(parsed.data));
  }
  const result: Message = { role: node.type, content: blocks };
  if (node.type === "user") return { kind: "user", message: result };
  const id = response(node); if (!id) fail("missing-assistant-response-id", node); result.responseId = id;
  if (typeof native.model === "string") result.responseModel = native.model;
  if (node.row.resumedFromIncompleteThinking === true) result.resumedFromIncompleteThinking = true;
  return { kind: "assistant", message: result, responseId: id };
}

/**
 * A deliberately bounded, completed ordinary-history importer. Graph recovery precedes
 * content conversion. Rich attachments, checkpoint selection and interrupted-turn rescue
 * require their own host implementations and are rejected, never flattened or discarded.
 */
export function projectNativeHistory(document: NativeSessionDocument, options: NativeHistoryOptions): NativeHistoryProjection {
  for (const line of document.lines) {
    const row = line.value;
    if (isNativeObject(row) && ["last-prompt", "content-replacement", "fork-context-ref", "observer-ref"].includes(String(row.type)) &&
      (row.sessionId === undefined || row.sessionId === options.scope.sessionId)) throw new NativeHistoryProjectionError(`unsupported-${String(row.type)}`);
  }
  const recovered = reconstructNativeHistory(indexNativeSession(document), options);
  const messages: Message[] = [], sources: string[][] = [], rows = recovered.nodes.map(node => ({ node, projected: projectRow(node) }));
  const callOwners = new Map<string, string>();
  for (const { node, projected } of rows) if (projected.kind === "assistant") for (const block of projected.message.content) if (block.type === "tool_use") {
    if (callOwners.has(block.id)) fail("duplicate-tool-use-id", node); callOwners.set(block.id, projected.responseId);
  }
  // Same-response fragments may straddle parallel results. Keep their signed blocks
  // together before existing reasoning projection can classify a fragment as orphaned.
  const candidates = new Map<string, { target: Message; source: string[] }>(); const answered = new Set<string>();
  for (const { node, projected: row } of rows) {
    const projected = row.message;
    if (row.kind === "user") {
      if (!projected.content.some(block => block.type === "tool_result")) candidates.clear();
      for (const block of projected.content) if (block.type === "tool_result") {
        if (!callOwners.has(block.tool_use_id)) fail("orphan-tool-result", node);
        if (answered.has(block.tool_use_id)) fail("duplicate-tool-result", node); answered.add(block.tool_use_id);
      }
      messages.push(projected); sources.push([node.uuid]); continue;
    }
    const existing = candidates.get(row.responseId);
    if (existing !== undefined) {
      const { target, source } = existing;
      if (target.responseModel !== projected.responseModel) fail("response-model-conflict", node);
      target.content.push(...projected.content); source.push(node.uuid);
      if (projected.resumedFromIncompleteThinking) target.resumedFromIncompleteThinking = true;
    } else {
      if (messages.some(item => item.role === "assistant" && item.responseId === projected.responseId)) fail("response-crosses-human-boundary", node);
      const source = [node.uuid]; messages.push(projected); sources.push(source); candidates.set(row.responseId, { target: projected, source });
    }
  }
  for (const id of callOwners.keys()) if (!answered.has(id)) throw new NativeHistoryProjectionError("unresolved-tool-use", id);
  for (const item of messages) if (item.role === "assistant") {
    if (item.content.every(block => block.type === "thinking" || block.type === "redacted_thinking")) throw new NativeHistoryProjectionError("unsupported-orphan-thinking", item.responseId);
    if (item.content.some(block => block.type === "thinking" && !block.signature)) throw new NativeHistoryProjectionError("unsupported-unsigned-thinking", item.responseId);
    if (item.content.every(block => block.type === "text" && !block.text.trim())) throw new NativeHistoryProjectionError("unsupported-blank-assistant", item.responseId);
  }
  // Results must follow their reconstructed response, not merely exist somewhere in the file.
  const visibleCalls = new Set<string>();
  for (const item of messages) for (const block of item.content) {
    if (block.type === "tool_use") visibleCalls.add(block.id);
    if (block.type === "tool_result" && !visibleCalls.has(block.tool_use_id)) throw new NativeHistoryProjectionError("result-precedes-response", block.tool_use_id);
  }
  const last = recovered.nodes.findLast(node => node.type === "assistant" || node.type === "user");
  if (!last || last.type !== "assistant" || message(last)?.stop_reason !== "end_turn") fail("unsupported-incomplete-turn", last);
  return Object.freeze({ ...recovered, messages, messageSources: Object.freeze(sources.map(source => Object.freeze(source))) });
}
