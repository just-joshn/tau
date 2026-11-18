import { appendProjectedToolResultContent, normalizeHistoryMessages, orderAssistantBlocks, type HistoryProjectionMessage } from "./history-normalization.js";
import type { ApiToolContent, WireBlock, WireMessage } from "./types.js";

export interface HookAttachmentRow {
  type: "hook_attachment";
  event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  /** Records actual transcript placement; projection never infers it from event. */
  phase: "pre" | "post" | "failure";
  toolName: string;
  toolUseId?: string;
  content: readonly string[];
  source?: string;
  uuid?: string;
  placement?: "next_to_message";
}
export interface HookProjectionMessageRow {
  type: "message";
  message: HistoryProjectionMessage;
  /** Original virtual transcript rows are excluded by RPi(..., true, false). */
  virtual?: boolean;
  /** Explicit source-classified DBt suffixes; arbitrary text is never guessed. */
  protectedSuffixTextIndices?: readonly number[];
  /** Synthetic/provider-specific result carriers that must remain separate. */
  preventFoldResultIds?: readonly string[];
}
export type HookProjectionRow = HookProjectionMessageRow | HookAttachmentRow;
export interface HookAttachmentPlacement {
  sourceIndex: number;
  event: HookAttachmentRow["event"];
  phase: HookAttachmentRow["phase"];
  originToolUseId?: string;
  source?: string;
  uuid?: string;
  channel: "tool_result" | "user_text";
  targetToolUseId?: string;
}
export interface HookAttachmentProjection {
  messages: WireMessage[];
  placements: HookAttachmentPlacement[];
}
export interface HookAttachmentProjectionOptions {
  /** Shipped Git/Fre gate, default false. This helper folds tagged hook text only. */
  reminderFold?: boolean;
}

/** Shipped XVt -> tD: stop additional context from closing its reminder wrapper. */
export function sanitizeHookAttachmentText(value: string): string {
  return value.replace(/<(?=\s*(?:\/\s*)?system-reminder\b)/gi, "&lt;").replace(/<(?=\s*(?:\/\s*)?$)/, "&lt;");
}
export function renderHookAdditionalContext(attachment: HookAttachmentRow): string {
  return `<system-reminder>\n${sanitizeHookAttachmentText(`${attachment.event}:${attachment.toolName} hook additional context: ${attachment.content.join("\n")}`)}\n</system-reminder>`;
}

type IndexedRow = { row: HookProjectionRow; index: number };
/** Hook-only RPi/ZWo path, in ordinary assistant/user mode (no api_system rows). */
function relocate(rows: readonly HookProjectionRow[]): IndexedRow[] {
  const reversed: IndexedRow[] = [], pending: IndexedRow[] = [];
  let humanTurnToRight = false;
  const flush = (): void => {
    const ordered = humanTurnToRight
      ? [...pending.filter(item => item.row.type === "hook_attachment" && item.row.placement === "next_to_message"),
        ...pending.filter(item => item.row.type !== "hook_attachment" || item.row.placement !== "next_to_message")]
      : pending;
    for (const item of ordered) reversed.push(item);
    pending.length = 0;
  };
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row) continue;
    if (row.type === "hook_attachment") { pending.push({ row, index }); continue; }
    const host = row.message.role === "assistant" || row.message.role === "user" && row.message.content[0]?.type === "tool_result";
    if (host && pending.length) flush();
    if (!row.virtual) reversed.push({ row, index });
    if (!host && (humanTurnToRight || row.message.role === "user" && !row.virtual && row.message.content.length > 0)) humanTurnToRight = true;
  }
  flush();
  return reversed.reverse();
}

interface TrackedBlock { value: WireBlock; protectedSuffix?: boolean; preventFold?: boolean; attachment?: HookAttachmentPlacement }
interface TrackedRow { responseId?: string; role: WireMessage["role"]; blocks: TrackedBlock[] }
const wireRow = (row: TrackedRow): HistoryProjectionMessage => ({ role: row.role, content: row.blocks.map(block => block.value),
  ...(row.responseId === undefined ? {} : { responseId: row.responseId }) });
const protectedResult = (block: TrackedBlock): boolean => {
  const value = block.value;
  return block.preventFold === true || value.type === "tool_result" &&
    ["poll_", "gettask_", "projectread_", "toolu_pdfread_", "voicecallrecord_"].some(prefix => value.tool_use_id.startsWith(prefix));
};

function mergeUsers(left: TrackedRow, right: TrackedRow): TrackedRow {
  const blocks = [...left.blocks], last = blocks.at(-1), first = right.blocks[0];
  if (last?.value.type === "text" && first?.value.type === "text") blocks[blocks.length - 1] = { ...last, value: { ...last.value, text: `${last.value.text}\n` } };
  for (const block of right.blocks) blocks.push(block);
  return { role: "user", blocks: [...blocks.filter(block => block.value.type === "tool_result"), ...blocks.filter(block => block.value.type !== "tool_result")] };
}
function markHost(placement: HookAttachmentPlacement, target: WireBlock): void {
  if (target.type !== "tool_result") return;
  placement.channel = "tool_result";
  placement.targetToolUseId = target.tool_use_id;
}
function appendAttachment(row: TrackedRow, block: TrackedBlock, reminderFold: boolean): TrackedRow {
  // xGo can step back across explicitly source-classified protected suffix text.
  let index = row.blocks.length - 1;
  while (index >= 0 && row.blocks[index]?.value.type === "text" && row.blocks[index]?.protectedSuffix) index--;
  const target = row.blocks[index];
  if (!target || target.value.type !== "tool_result" || protectedResult(target) || block.value.type !== "text") return { ...row, blocks: [...row.blocks, block] };
  let value: WireBlock;
  if (reminderFold || typeof target.value.content === "string") value = appendProjectedToolResultContent(target.value, [{ type: "text", text: block.value.text }]);
  else {
    // xGo's gate-off rich branch preserves separate text blocks and one seam newline.
    const content: ApiToolContent[] = [...target.value.content], last = content.at(-1);
    if (last?.type === "text") content[content.length - 1] = { ...last, text: `${last.text}\n` };
    content.push({ type: "text", text: block.value.text });
    value = { ...target.value, content };
  }
  const blocks = [...row.blocks];
  blocks[index] = { ...target, value };
  if (block.attachment) markHost(block.attachment, value);
  return { ...row, blocks };
}

/**
 * Ordered ordinary-mode consumer for hook_additional_context transcript rows.
 * Use after local reasoning/rich-content projection and before losing response IDs.
 * Source/event/phase remain available in placements, but never decide the host.
 * Parallel scheduling, api_system mode and arbitrary attachment kinds stay outside
 * this explicit input vocabulary. Unknown sibling text always remains a barrier.
 */
export function projectHookAttachmentHistory(input: readonly HookProjectionRow[], options: HookAttachmentProjectionOptions = {}): HookAttachmentProjection {
  const output: TrackedRow[] = [], placements: HookAttachmentPlacement[] = [], candidates = new Map<string, number>();
  let scan = 0;
  for (const { row, index: sourceIndex } of relocate(input)) {
    if (row.type === "hook_attachment") {
      if (!row.content.length) continue;
      const placement: HookAttachmentPlacement = { sourceIndex, event: row.event, phase: row.phase,
        ...(row.toolUseId === undefined ? {} : { originToolUseId: row.toolUseId }),
        ...(row.source === undefined ? {} : { source: row.source }), ...(row.uuid === undefined ? {} : { uuid: row.uuid }), channel: "user_text" };
      placements.push(placement);
      const block: TrackedBlock = { value: { type: "text", text: renderHookAdditionalContext(row) }, attachment: placement };
      const previous = output.at(-1);
      if (previous?.role === "user") output[output.length - 1] = appendAttachment(previous, block, options.reminderFold === true);
      else output.push({ role: "user", blocks: [block] });
      continue;
    }
    const message = row.message;
    if (message.role === "user" && message.content.length === 0) continue;
    const current: TrackedRow = { role: message.role, ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      blocks: message.content.map((value, index) => ({ value,
        ...(value.type === "text" && row.protectedSuffixTextIndices?.includes(index) ? { protectedSuffix: true } : {}),
        ...(value.type === "tool_result" && row.preventFoldResultIds?.includes(value.tool_use_id) ? { preventFold: true } : {}) })) };
    if (message.role === "user") {
      const previous = output.at(-1);
      if (previous?.role === "user") output[output.length - 1] = mergeUsers(previous, current);
      else output.push(current);
      continue;
    }
    for (; scan < output.length; scan++) {
      const previous = output[scan];
      if (!previous) break;
      if (previous.role === "assistant") {
        if (previous.responseId !== undefined) candidates.set(previous.responseId, scan);
      } else if (!previous.blocks.some(block => block.value.type === "tool_result") || previous.blocks.some(block =>
        block.value.type === "tool_result" && block.value.tool_use_id.startsWith("projectread_"))) candidates.clear();
    }
    const index = message.responseId === undefined ? undefined : candidates.get(message.responseId);
    if (index !== undefined && output[index]?.role === "assistant") {
      const [merged] = normalizeHistoryMessages([wireRow(output[index]), wireRow(current)]);
      if (!merged) throw new Error("Hook attachment projection merge produced no row");
      output[index] = { ...output[index], blocks: merged.content.map(value => ({ value })) };
    } else output.push({ ...current, blocks: orderAssistantBlocks(current.blocks.map(block => block.value)).map(value => ({ value })) });
  }
  if (options.reminderFold) for (const row of output) {
    if (row.role !== "user") continue;
    const attachments = row.blocks.filter(block => block.attachment !== undefined), kept = row.blocks.filter(block => block.attachment === undefined);
    const index = kept.findLastIndex(block => block.value.type === "tool_result" && !protectedResult(block));
    const target = kept[index];
    if (!attachments.length || !target || target.value.type !== "tool_result") continue;
    const additions = attachments.flatMap(block => block.value.type === "text" ? [{ type: "text" as const, text: block.value.text }] : []);
    const value = appendProjectedToolResultContent(target.value, additions);
    kept[index] = { ...target, value };
    row.blocks = kept;
    for (const block of attachments) if (block.attachment) markHost(block.attachment, value);
  }
  return { messages: output.map(row => ({ role: row.role, content: row.blocks.map(block => block.value) })), placements };
}

export function projectHookAttachments(input: readonly HookProjectionRow[], options: HookAttachmentProjectionOptions = {}): WireMessage[] {
  return projectHookAttachmentHistory(input, options).messages;
}
