import {
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeObject,
  type NativeSessionDocument,
  type NativeTranscriptNode,
  type NativeSourceRow,
} from "./native-session-codec.js";
import {
  projectNativeHistory,
  reconstructNativeHistory,
  type NativeHistoryOptions,
  type NativeHistoryProjection,
} from "./native-history-projection.js";
import type { NativeEntryFold } from "./native-resume-entry.js";
import type { Message } from "./types.js";
import { validateNativePersistenceEvent } from "./native-persistence-events.js";

export type NativeResumeContextContent =
  string | readonly { type: "text"; text: string }[];
export interface NativeResumeContextHost {
  /** Effective native projection gates, after any admitted snapshot/model/host selection. */
  systemTurns: boolean;
  reminderFold: boolean;
  /** This bounded branch cannot replay live attachment rewrite/withdrawal state. */
  withoutAttachmentHooks: true;
  admit(input: {
    row: NativeObject;
    uuid: string;
    nativeType: string;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  /** Type-specific native renderer, never generic JSON-to-text conversion. Empty means native emits nothing. */
  renderMissing?(input: {
    row: NativeObject;
    attachment: NativeObject;
    signal: AbortSignal;
  }):
    | readonly NativeResumeContextContent[]
    | Promise<readonly NativeResumeContextContent[]>;
}
export interface NativeResumeContextDisposition {
  uuid: string;
  row: NativeObject;
  nativeType: string;
  source:
    | "recorded-rendered"
    | "native-empty"
    | "native-text"
    | "host-rendered"
    | "local-command";
  destination: "none" | "user-context" | "system-round";
  recordedRole?: "user" | "system";
  content: readonly NativeResumeContextContent[];
  /** Preserved metadata only; never sets model, tools, permissions or system prompt. */
  promptSnapshot?: NativeObject;
  requiredTransform?: string;
}
export class NativeResumeContextError extends Error {
  constructor(
    readonly code: string,
    readonly uuid?: string,
  ) {
    super(`Native resume context: ${code}${uuid ? ` (${uuid})` : ""}`);
    this.name = "NativeResumeContextError";
  }
}
const fail = (code: string, uuid?: string): never => {
  throw new NativeResumeContextError(code, uuid);
};
const projectionEmpty = new Set([
  "prompt_snapshot",
  "prompt_render_point",
  "thinking_drop",
  "tool_results_cut",
  "credential_org",
  "whole_texts_withdrawn",
  "deferred_tools_record",
]);
const transient = new Set([
  "compaction_reminder",
  "companion_intro",
  "echo_activities",
  "pen_mode_enter",
  "pen_mode_exit",
  "verify_plan_reminder",
  "fold_nudge",
  "context_tip",
  "audio_transcript",
  "new_file",
  "new_directory",
]);
const supported = new Set([
  "environment",
  "model",
  "session_context",
  "date",
  "total_tokens_reminder",
]);
const typedRecordedAttachments = new Set([
  "instructions",
  "agent_listing_delta",
  "skill_listing",
  "hook_additional_context",
  "hook_success",
  "hook_system_message",
  "hook_non_blocking_error",
  "hook_error_during_execution",
  "hook_cancelled",
  "hook_blocking_error",
  "hook_stopped_continuation",
  "max_turns_reached",
]);
function wrap(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}
function unknownObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function content(value: unknown): NativeResumeContextContent | undefined {
  if (typeof value === "string") return value.length ? value : undefined;
  if (!Array.isArray(value) || !value.length) return;
  const blocks: { type: "text"; text: string }[] = [];
  for (const item of value) {
    if (
      !unknownObject(item) ||
      item.type !== "text" ||
      typeof item.text !== "string" ||
      !item.text.length
    )
      return;
    blocks.push({ type: "text", text: item.text });
  }
  return blocks;
}
function recorded(
  value: NativeJson | undefined,
): NativeResumeContextContent[] | undefined {
  if (!isNativeArray(value) || !value.length) return;
  const output: NativeResumeContextContent[] = [];
  for (const item of value) {
    if (!isNativeObject(item)) return;
    const parsed = content(item.content);
    if (parsed === undefined) return;
    output.push(parsed);
  }
  return output;
}
function validModelIdentity(value: NativeJson | undefined): boolean {
  return (
    isNativeObject(value) &&
    typeof value.modelId === "string" &&
    (typeof value.marketingName === "string" || value.marketingName === null) &&
    (typeof value.knowledgeCutoff === "string" ||
      value.knowledgeCutoff === null)
  );
}
async function missing(
  attachment: NativeObject,
  row: NativeObject,
  host: NativeResumeContextHost,
  signal: AbortSignal,
): Promise<{
  source: NativeResumeContextDisposition["source"];
  content: readonly NativeResumeContextContent[];
}> {
  if (attachment.type === "session_context") {
    const context = attachment.context;
    if (!isNativeObject(context))
      return { source: "native-empty", content: [] };
    if (Object.keys(context).length === 0 && attachment.changed !== true)
      return { source: "native-empty", content: [] };
  }
  if (attachment.type === "model") {
    if (!validModelIdentity(attachment.identity))
      return { source: "native-empty", content: [] };
    if (typeof attachment.text === "string")
      return {
        source: attachment.text.length ? "native-text" : "native-empty",
        content: attachment.text.length ? [wrap(attachment.text)] : [],
      };
  }
  if (attachment.type === "date") {
    if (
      typeof attachment.date !== "string" ||
      (attachment.changed !== undefined &&
        typeof attachment.changed !== "boolean") ||
      (attachment.assumedUtc !== undefined &&
        typeof attachment.assumedUtc !== "boolean")
    )
      return { source: "native-empty", content: [] };
    if (attachment.changed !== true && attachment.assumedUtc !== true)
      return {
        source: "native-text",
        content: [wrap(`Today's date is ${attachment.date}.`)],
      };
  }
  if (attachment.type === "total_tokens_reminder") {
    if (typeof attachment.text !== "string")
      return fail(
        "invalid-token-reminder-text",
        typeof row.uuid === "string" ? row.uuid : undefined,
      );
    return { source: "native-text", content: [wrap(attachment.text)] };
  }
  if (!host.renderMissing)
    return fail(
      `missing-native-renderer-${typeof attachment.type === "string" ? attachment.type : "unknown"}`,
      typeof row.uuid === "string" ? row.uuid : undefined,
    );
  signal.throwIfAborted();
  const rendered = await host.renderMissing({ row, attachment, signal });
  signal.throwIfAborted();
  const checked: NativeResumeContextContent[] = [];
  for (const item of rendered) {
    const parsed = content(item);
    if (parsed === undefined) return fail("invalid-host-context-rendering");
    checked.push(parsed);
  }
  return { source: "host-rendered", content: checked };
}

/** L$n/ZZr plus Kw's jf/Y_e disposition, without generic attachment serialization. */
export async function planNativeResumeContext(
  nodes: readonly NativeSourceRow[],
  host: NativeResumeContextHost,
  signal: AbortSignal,
): Promise<readonly NativeResumeContextDisposition[]> {
  const output: NativeResumeContextDisposition[] = [];
  for (const node of nodes) {
    if (node.type === "progress") {
      signal.throwIfAborted();
      let row: NativeObject;
      try {
        row = validateNativePersistenceEvent(node.row);
      } catch {
        return fail("unsupported-retained-progress", node.uuid);
      }
      if (
        !(await host.admit({
          row,
          uuid: node.uuid,
          nativeType: "hook_progress",
          signal,
        }))
      )
        return fail("context-admission-denied", node.uuid);
      signal.throwIfAborted();
      output.push({
        uuid: node.uuid,
        row,
        nativeType: "hook_progress",
        source: "native-empty",
        destination: "none",
        content: [],
      });
      continue;
    }
    if (node.type !== "attachment" && node.type !== "system") continue;
    signal.throwIfAborted();
    const row = node.row;
    const attachment =
      node.type === "attachment" && isNativeObject(row.attachment)
        ? row.attachment
        : undefined;
    if (
      node.type === "attachment" &&
      (!attachment || typeof attachment.type !== "string")
    )
      return fail("malformed-attachment", node.uuid);
    const nativeType = attachment
      ? typeof attachment.type === "string"
        ? attachment.type
        : "unknown"
      : typeof row.subtype === "string"
        ? row.subtype
        : "unknown-system";
    if (nativeType === "compact_boundary")
      return fail("unsupported-compaction", node.uuid);
    if (nativeType === "stop_hook_summary") {
      try {
        validateNativePersistenceEvent(
          Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => !ordinaryTerminalEnvelope.has(key),
            ),
          ),
        );
      } catch {
        return fail("invalid-recorded-stop-hook-summary", node.uuid);
      }
    }
    if (!(await host.admit({ row, uuid: node.uuid, nativeType, signal })))
      return fail("context-admission-denied", node.uuid);
    signal.throwIfAborted();
    if (!attachment) {
      if (nativeType !== "local_command" || row.isDisplayOnly === true) {
        output.push({
          uuid: node.uuid,
          row,
          nativeType,
          source: "native-empty",
          destination: "none",
          content: [],
        });
        continue;
      }
      if (typeof row.content !== "string" || !row.content.length)
        return fail("unsupported-local-command-content", node.uuid);
      output.push({
        uuid: node.uuid,
        row,
        nativeType,
        source: "local-command",
        destination: "user-context",
        content: [row.content],
      });
      continue;
    }
    if (projectionEmpty.has(nativeType) || transient.has(nativeType)) {
      output.push({
        uuid: node.uuid,
        row,
        nativeType,
        source: "native-empty",
        destination: "none",
        content: [],
        ...(nativeType === "prompt_snapshot"
          ? { promptSnapshot: attachment }
          : {}),
        ...(nativeType !== "prompt_snapshot" && projectionEmpty.has(nativeType)
          ? { requiredTransform: nativeType }
          : {}),
      });
      continue;
    }
    let typedEmpty = false;
    if (typedRecordedAttachments.has(nativeType)) {
      try {
        const event = validateNativePersistenceEvent({
          type: "attachment",
          uuid: row.uuid,
          timestamp: row.timestamp,
          attachment,
          ...(row.rendered === undefined ? {} : { rendered: row.rendered }),
          ...(row.renderedRole === undefined
            ? {}
            : { renderedRole: row.renderedRole }),
          ...(row.placement === undefined ? {} : { placement: row.placement }),
        });
        typedEmpty = event.rendered === undefined;
      } catch {
        return fail(`invalid-recorded-attachment-${nativeType}`, node.uuid);
      }
    } else if (!supported.has(nativeType))
      return fail(`unsupported-attachment-${nativeType}`, node.uuid);
    if (typedEmpty) {
      output.push({
        uuid: node.uuid,
        row,
        nativeType,
        source: "native-empty",
        destination: "none",
        content: [],
      });
      continue;
    }
    const saved = recorded(row.rendered);
    const rendered =
      saved === undefined
        ? await missing(attachment, row, host, signal)
        : ({ source: "recorded-rendered", content: saved } satisfies Pick<
            NativeResumeContextDisposition,
            "source" | "content"
          >);
    const recordedRole =
      row.renderedRole === "user" || row.renderedRole === "system"
        ? row.renderedRole
        : undefined;
    const promote =
      recordedRole === undefined
        ? nativeType !== "session_context"
        : recordedRole === "system";
    output.push({
      uuid: node.uuid,
      row,
      nativeType,
      source: rendered.source,
      content: rendered.content,
      destination: !rendered.content.length
        ? "none"
        : host.systemTurns && promote
          ? "system-round"
          : "user-context",
      ...(recordedRole === undefined ? {} : { recordedRole }),
    });
  }
  return output;
}

/** RPi/ZWo's ordinary non-system-turn ordering. No message bodies are rewritten. */
export function reorderNativeResumeContextNodes<N extends NativeSourceRow>(
  nodes: readonly N[],
): readonly N[] {
  const result: N[] = [];
  let pending: N[] = [];
  let human = false;
  const flush = () => {
    const ordered = human
      ? [
          ...pending.filter((node) => node.row.placement === "next_to_message"),
          ...pending.filter((node) => node.row.placement !== "next_to_message"),
        ]
      : pending;
    result.push(...ordered);
    pending = [];
  };
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    const attachmentType = isNativeObject(node.row.attachment)
      ? node.row.attachment.type
      : undefined;
    if (node.type === "attachment" && attachmentType !== "message_pdf_reads") {
      pending.push(node);
      continue;
    }
    const value = isNativeObject(node.row.message)
      ? node.row.message.content
      : undefined;
    const boundary =
      node.type === "assistant" ||
      node.type === "attachment" ||
      (node.type === "user" &&
        ((isNativeArray(value) &&
          isNativeObject(value[0]) &&
          value[0].type === "tool_result") ||
          node.row.taskDelivery !== undefined));
    if (boundary && pending.length) {
      flush();
      result.push(node);
    } else result.push(node);
    human =
      !boundary &&
      (human ||
        (node.type === "user" &&
          !(isNativeArray(value) && value.length === 0)));
  }
  flush();
  return result.reverse();
}
function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
function escapeMalformedReminder(text: string): string {
  const prefix = "<system-reminder";
  const next = text.charAt(prefix.length),
    code = next.charCodeAt(0);
  return text.startsWith(prefix) &&
    (/\s/.test(next) || (code >= 28 && code <= 31) || code === 133)
    ? `&lt;${text.slice(1)}`
    : text;
}
function textBlocks(
  value: NativeResumeContextContent,
): { type: "text"; text: string }[] {
  return typeof value === "string"
    ? [{ type: "text", text: escapeMalformedReminder(value) }]
    : value.map((block) => ({
        ...block,
        text: escapeMalformedReminder(block.text),
      }));
}

export interface NativeOrdinaryContextResult {
  fold: NativeEntryFold;
  /** The strict conversation projection before context is materialized. */
  projection: NativeHistoryProjection;
  messages: Message[];
  messageSources: readonly (readonly string[])[];
  dispositions: readonly NativeResumeContextDisposition[];
  reorderedUuids: readonly string[];
}

export interface NativeOrdinaryResumeSelection {
  index: ReturnType<typeof indexNativeSession>;
  selectedLeaf: NativeTranscriptNode;
  /** Actual physical terminal cursor, including admitted snapshot/lifecycle/system tails. */
  terminalUuid: string;
  transcriptSessionId: string;
  checkpoints: readonly { leaf: string; explicit: boolean }[];
  historyOptions: NativeHistoryOptions;
  recovered: ReturnType<typeof reconstructNativeHistory>;
  /** Complete selected history/tail for effective last-snapshot and context gates. */
  gateNodes: readonly NativeTranscriptNode[];
  /** Only already-applied checkpoint rows are removed; context remains for projection. */
  documentForProjection: NativeSessionDocument;
}
const terminalLifecycleTypes = new Set([
  "hook_additional_context",
  "hook_success",
  "hook_system_message",
  "hook_non_blocking_error",
  "hook_error_during_execution",
  "hook_cancelled",
  "hook_blocking_error",
  "hook_stopped_continuation",
  "max_turns_reached",
]);
const ordinaryTerminalEnvelope = new Set([
  "parentUuid",
  "sessionId",
  "cwd",
  "version",
  "entrypoint",
  "userType",
  "sessionKind",
  "isSidechain",
  "teamName",
  "agentName",
  "promptId",
  "gitBranch",
  "slug",
]);
function validateOrdinaryLifecycleTail(node: NativeTranscriptNode): void {
  const event: Record<string, NativeJson> = {};
  for (const [key, value] of Object.entries(node.row))
    if (!ordinaryTerminalEnvelope.has(key)) event[key] = value;
  try {
    validateNativePersistenceEvent(event);
  } catch {
    return fail("invalid-terminal-lifecycle-event", node.uuid);
  }
  if (
    isNativeObject(node.row.attachment) &&
    node.row.attachment.type === "max_turns_reached" &&
    node.row.attachment.exitCommitted === false
  )
    return fail("unsupported-terminal-max-turn-interruption", node.uuid);
}
function requireOrdinaryLifecycleAnswer(
  selected: NativeTranscriptNode,
  recovered: readonly NativeTranscriptNode[],
): void {
  const message = isNativeObject(selected.row.message)
    ? selected.row.message
    : undefined;
  if (
    selected.type !== "assistant" ||
    !message ||
    message.stop_reason !== "end_turn" ||
    typeof message.id !== "string" ||
    !message.id ||
    typeof message.model !== "string" ||
    !message.model ||
    message.model === "<synthetic>" ||
    !isNativeArray(message.content) ||
    !message.content.some(
      (block) =>
        isNativeObject(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    )
  )
    return fail("unsupported-terminal-lifecycle-answer", selected.uuid);
  const calls = new Map<string, string>();
  const pending = new Set<string>();
  for (const node of recovered) {
    if (
      node.row.isVirtual === true ||
      node.row.isApiErrorMessage === true ||
      node.row.resumedFromIncompleteThinking === true ||
      node.row.interruptedByShutdown === true ||
      node.row.answeredWithoutRequest === true ||
      node.row.isVisibleInTranscriptOnly === true ||
      node.row.madeBy === "input"
    )
      return fail("unsupported-terminal-lifecycle-recovery", node.uuid);
    if (node.type !== "assistant" && node.type !== "user") continue;
    const body = isNativeObject(node.row.message)
      ? node.row.message
      : undefined;
    if (!body) return fail("invalid-terminal-lifecycle-message", node.uuid);
    if (
      node.type === "assistant" &&
      !["end_turn", "tool_use", "stop_sequence", "refusal"].includes(
        typeof body.stop_reason === "string" ? body.stop_reason : "",
      )
    )
      return fail("unsupported-terminal-lifecycle-recovery", node.uuid);
    const blocks = isNativeArray(body.content) ? body.content : [];
    const results = blocks.filter(
      (block) => isNativeObject(block) && block.type === "tool_result",
    );
    if (
      node.type === "user" &&
      !results.length &&
      node.row.isMeta !== true &&
      pending.size
    )
      return fail("terminal-human-crosses-pending-response", node.uuid);
    for (const block of blocks) {
      if (!isNativeObject(block)) continue;
      if (node.type === "assistant" && block.type === "tool_use") {
        if (typeof block.id !== "string" || !block.id || calls.has(block.id))
          return fail("invalid-terminal-tool-use", node.uuid);
        calls.set(block.id, node.uuid);
        pending.add(block.id);
      } else if (node.type === "user" && block.type === "tool_result") {
        if (
          typeof block.tool_use_id !== "string" ||
          !pending.has(block.tool_use_id) ||
          (node.row.sourceToolAssistantUUID !== undefined &&
            node.row.sourceToolAssistantUUID !== calls.get(block.tool_use_id))
        )
          return fail("invalid-terminal-tool-result", node.uuid);
        pending.delete(block.tool_use_id);
      }
    }
  }
  if (pending.size)
    return fail("unsupported-terminal-unresolved-calls", selected.uuid);
}
/** Source ordinary main leaf/checkpoint selection, shared by text and tool-context projection. */
export function selectOrdinaryNativeResumeHistory(
  document: NativeSessionDocument,
  recovery: NativeHistoryOptions["recovery"],
): NativeOrdinaryResumeSelection {
  const index = indexNativeSession(document);
  if (
    index.diagnostics.some(
      (item) => item.code === "invalid-transcript-envelope",
    )
  )
    return fail("malformed-transcript-envelope");
  let leaf: NativeTranscriptNode | undefined;
  const checkpoints: { leaf: string; explicit: boolean }[] = [];
  let lastStoredMain: NativeTranscriptNode | undefined;
  for (const line of document.lines) {
    const row = line.value;
    if (!isNativeObject(row)) continue;
    if (row.type === "last-prompt") {
      if (
        row.rewound === true ||
        row.cutUuid !== undefined ||
        typeof row.leafUuid !== "string" ||
        !row.leafUuid
      )
        return fail("unsupported-checkpoint-fold");
      checkpoints.push({ leaf: row.leafUuid, explicit: row.explicit === true });
      continue;
    }
    if (
      typeof row.uuid === "string" &&
      row.isSidechain !== true &&
      row.agentId === undefined &&
      index.nodes.has(row.uuid)
    )
      lastStoredMain = index.nodes.get(row.uuid);
    if (row.type === "api_system") return fail("unsupported-native-api-system");
    if (
      ["content-replacement", "fork-context-ref", "observer-ref"].includes(
        typeof row.type === "string" ? row.type : "",
      )
    )
      return fail("unsupported-native-fold-transform");
    if (
      row.retractedMessageUuids !== undefined ||
      row.subtype === "compact_boundary"
    )
      return fail("unsupported-retraction-or-compaction");
    if (row.type === "user" || row.type === "assistant") {
      if (row.isSidechain === true || row.agentId !== undefined)
        return fail("unsupported-nonmain-transcript");
      if (typeof row.uuid === "string") leaf = index.nodes.get(row.uuid);
    }
  }
  if (!leaf || typeof leaf.row.sessionId !== "string" || !leaf.row.sessionId)
    return fail("missing-main-terminal-identity");
  const selectedLeaf = leaf;
  const terminalChain = new Set([selectedLeaf.uuid]);
  const terminalTail: NativeTranscriptNode[] = [];
  let lifecycleTail = false;
  let terminal = selectedLeaf;
  for (;;) {
    const children = [...index.nodes.values()].filter(
      (node) => node.parentUuid === terminal.uuid,
    );
    if (!children.length) break;
    const next = children[0];
    if (
      children.length !== 1 ||
      !next ||
      next.row.sessionId !== leaf.row.sessionId ||
      next.row.isSidechain === true ||
      next.row.agentId !== undefined ||
      (next.type !== "attachment" && next.type !== "system")
    )
      return fail("unsupported-terminal-context-descendants", terminal.uuid);
    const attachment = isNativeObject(next.row.attachment)
      ? next.row.attachment
      : undefined;
    if (next.type === "attachment" && attachment?.type === "prompt_snapshot") {
      // Existing passive snapshot admission/gate precedence is unchanged.
    } else if (
      (next.type === "system" &&
        ["informational", "stop_hook_summary"].includes(
          typeof next.row.subtype === "string" ? next.row.subtype : "",
        )) ||
      (next.type === "attachment" &&
        attachment &&
        typeof attachment.type === "string" &&
        terminalLifecycleTypes.has(attachment.type))
    ) {
      if (next.row.cwd !== selectedLeaf.row.cwd)
        return fail("unsupported-terminal-lifecycle-context", next.uuid);
      validateOrdinaryLifecycleTail(next);
      lifecycleTail = true;
    } else
      return fail("unsupported-terminal-context-descendants", terminal.uuid);
    if (terminalChain.has(next.uuid))
      return fail("context-parent-cycle", next.uuid);
    terminalChain.add(next.uuid);
    terminalTail.push(next);
    terminal = next;
  }
  const finalCheckpoint = checkpoints.at(-1);
  if (
    (finalCheckpoint && finalCheckpoint.leaf !== terminal.uuid) ||
    checkpoints.some((checkpoint) => !index.nodes.has(checkpoint.leaf))
  )
    return fail("unsupported-checkpoint-selection");
  if (
    !finalCheckpoint?.explicit &&
    lastStoredMain &&
    !terminalChain.has(lastStoredMain.uuid)
  )
    return fail("unsupported-ordinary-terminal-branch", lastStoredMain.uuid);
  const historyOptions: NativeHistoryOptions = {
    leafUuid: selectedLeaf.uuid,
    scope: { kind: "main", sessionId: leaf.row.sessionId },
    recovery: recovery,
  };
  const recovered = reconstructNativeHistory(index, historyOptions);
  if (lifecycleTail)
    requireOrdinaryLifecycleAnswer(selectedLeaf, recovered.nodes);
  const documentForProjection = checkpoints.length
    ? decodeNativeSession(
        encodeNativeSessionRows(
          document.lines.flatMap((line) =>
            line.kind === "record" &&
            line.value !== undefined &&
            !(isNativeObject(line.value) && line.value.type === "last-prompt")
              ? [line.value]
              : [],
          ),
        ),
        { parser: "source-line-fallback" },
      )
    : document;
  return {
    index,
    selectedLeaf,
    terminalUuid: terminal.uuid,
    transcriptSessionId: leaf.row.sessionId,
    checkpoints,
    historyOptions,
    recovered,
    gateNodes: [
      ...recovered.nodes,
      ...terminalTail.filter(
        (node) =>
          !recovered.nodes.some((selected) => selected.uuid === node.uuid),
      ),
    ],
    documentForProjection,
  };
}

/** Completed, noncompacted main history with no tool-result/response-regrouping projection branch. */
export async function materializeOrdinaryNativeResumeContext(
  document: NativeSessionDocument,
  options: {
    host:
      | NativeResumeContextHost
      | ((nodes: readonly NativeTranscriptNode[]) => NativeResumeContextHost);
    recovery: NativeHistoryOptions["recovery"];
    signal: AbortSignal;
  },
): Promise<NativeOrdinaryContextResult> {
  const {
    index,
    selectedLeaf,
    transcriptSessionId,
    checkpoints,
    historyOptions,
    recovered,
    gateNodes,
  } = selectOrdinaryNativeResumeHistory(document, options.recovery);
  const host =
    typeof options.host === "function" ? options.host(gateNodes) : options.host;
  if (host.systemTurns || host.reminderFold)
    return fail("unsupported-projection-gates");
  for (const node of recovered.nodes) {
    const message = isNativeObject(node.row.message)
      ? node.row.message
      : undefined;
    if (
      isNativeArray(message?.content) &&
      message.content.some(
        (block) =>
          isNativeObject(block) &&
          (block.type === "tool_result" || block.type === "tool_use"),
      )
    )
      return fail("unsupported-tool-result-materialization", node.uuid);
  }
  const dispositions = await planNativeResumeContext(
    recovered.nodes,
    host,
    options.signal,
  );
  const transform = dispositions.find(
    (item) => item.requiredTransform !== undefined,
  );
  if (transform)
    return fail(
      `unsupported-context-transform-${transform.requiredTransform ?? "unknown"}`,
      transform.uuid,
    );
  const removed = new Set(dispositions.map((item) => item.uuid));
  const resolveParent = (parent: NativeJson | undefined): NativeJson => {
    const visited = new Set<string>();
    while (typeof parent === "string" && removed.has(parent)) {
      if (visited.has(parent)) return fail("context-parent-cycle", parent);
      visited.add(parent);
      parent = index.nodes.get(parent)?.row.parentUuid;
    }
    return parent ?? null;
  };
  const retained: NativeJson[] = [];
  for (const line of document.lines) {
    if (line.kind !== "record" || line.value === undefined) continue;
    const row = line.value;
    if (!isNativeObject(row)) {
      retained.push(row);
      continue;
    }
    if (
      row.type === "last-prompt" ||
      (typeof row.uuid === "string" && removed.has(row.uuid))
    )
      continue;
    retained.push(
      row.type === "user" || row.type === "assistant"
        ? { ...row, parentUuid: resolveParent(row.parentUuid) }
        : row,
    );
  }
  const documentForProjection = decodeNativeSession(
    encodeNativeSessionRows(retained),
    { parser: "source-line-fallback" },
  );
  const projection = projectNativeHistory(
    documentForProjection,
    historyOptions,
  );
  if (projection.messageSources.some((sources) => sources.length !== 1))
    return fail("unsupported-response-fragment-context-fold");
  const conversation = new Map<string, Message>();
  for (const [i, sources] of projection.messageSources.entries()) {
    const uuid = sources[0];
    const message = projection.messages[i];
    if (uuid && message) conversation.set(uuid, message);
  }
  const contextByUuid = new Map(dispositions.map((item) => [item.uuid, item]));
  const messages: Message[] = [];
  const sources: string[][] = [];
  const append = (message: Message, uuid: string, newline: boolean) => {
    const previous = messages.at(-1);
    if (previous?.role === "user" && message.role === "user") {
      const last = previous.content.at(-1),
        first = message.content[0];
      if (newline && last?.type === "text" && first?.type === "text")
        last.text += "\n";
      previous.content.push(...cloneJson(message.content));
      sources.at(-1)?.push(uuid);
    } else {
      messages.push(cloneJson(message));
      sources.push([uuid]);
    }
  };
  const ordered = reorderNativeResumeContextNodes(recovered.nodes);
  for (const node of ordered) {
    const contextual = contextByUuid.get(node.uuid);
    if (contextual) {
      if (contextual.destination === "system-round")
        return fail("unsupported-system-context-materialization", node.uuid);
      for (const rendered of contextual.content)
        append(
          { role: "user", content: textBlocks(rendered) },
          node.uuid,
          contextual.source === "local-command",
        );
    } else {
      const message = conversation.get(node.uuid);
      if (message) append(message, node.uuid, message.role === "user");
    }
  }
  options.signal.throwIfAborted();
  return {
    fold: {
      documentForProjection,
      leafUuid: selectedLeaf.uuid,
      transcriptSessionId,
      appliedCheckpoints: checkpoints.length,
    },
    projection,
    messages,
    messageSources: sources,
    dispositions,
    reorderedUuids: ordered.map((node) => node.uuid),
  };
}

export interface NativeResumeContextGateFacts {
  /** Already normalized through the native model identity/provider selection host. */
  canonicalModel: string;
  forceMidConversationSystem: boolean;
  providerSystemOverride: boolean | undefined;
  cachedSystemTurns: boolean | undefined;
  /** Effective tu()/tengu_foamy_spring reader, default true when no reader exists natively. */
  replayPromptSnapshot: boolean;
  explicitReminderFold: boolean | undefined;
  /** Effective Fre(): native session cache/live flag resolution, not an invented false default. */
  liveReminderFold: boolean;
}
function snapshotReminderFold(value: NativeObject): {
  valid: boolean;
  reminderFold?: boolean;
} {
  if (
    !isNativeArray(value.systemPrompt) ||
    !value.systemPrompt.every((item) => typeof item === "string")
  )
    return { valid: false };
  if (value.cliPrefix !== undefined && typeof value.cliPrefix !== "string")
    return { valid: false };
  if (value.tools !== undefined) {
    if (!isNativeArray(value.tools)) return { valid: false };
    for (const tool of value.tools)
      if (
        !isNativeObject(tool) ||
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        (tool.server !== undefined && typeof tool.server !== "string") ||
        (tool.schema !== undefined && !isNativeObject(tool.schema))
      )
        return { valid: false };
  }
  return {
    valid: true,
    ...(typeof value.reminderFold === "boolean"
      ? { reminderFold: value.reminderFold }
      : {}),
  };
}

/** Narrow pR old-family floor plus Git/qR precedence. Unknown capability profiles stay explicit. */
export function resolveOrdinaryNativeResumeContextGates(
  nodes: readonly NativeTranscriptNode[],
  facts: NativeResumeContextGateFacts,
): {
  systemTurns: false;
  reminderFold: boolean;
  reminderFoldSource: "explicit" | "saved-snapshot" | "live";
  snapshotUuid?: string;
} {
  if (
    facts.canonicalModel !== "claude-sonnet-4-6" ||
    facts.forceMidConversationSystem ||
    facts.providerSystemOverride === true ||
    facts.cachedSystemTurns === true
  )
    return fail("unsupported-native-model-capability-profile");
  if (facts.explicitReminderFold !== undefined)
    return {
      systemTurns: false,
      reminderFold: facts.explicitReminderFold,
      reminderFoldSource: "explicit",
    };
  if (facts.replayPromptSnapshot) {
    const last = nodes.findLast(
      (node) =>
        node.type === "attachment" &&
        isNativeObject(node.row.attachment) &&
        node.row.attachment.type === "prompt_snapshot",
    );
    const attachment =
      last && isNativeObject(last.row.attachment)
        ? last.row.attachment
        : undefined;
    if (attachment) {
      const parsed = snapshotReminderFold(attachment);
      if (parsed.valid && parsed.reminderFold !== undefined)
        return {
          systemTurns: false,
          reminderFold: parsed.reminderFold,
          reminderFoldSource: "saved-snapshot",
          ...(last ? { snapshotUuid: last.uuid } : {}),
        };
    }
  }
  return {
    systemTurns: false,
    reminderFold: facts.liveReminderFold,
    reminderFoldSource: "live",
  };
}
