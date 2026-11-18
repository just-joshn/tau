import type { ApiToolContent, WireBlock, WireMessage } from "./types.js";

/** Input is already projected onto API blocks; these fields never go on the wire. */
export interface HistoryProjectionMessage extends WireMessage {
  responseId?: string;
  apiBlockIndex?: number;
  apiBlockIndices?: readonly number[];
}

export interface HistoryNormalizationOptions {
  /** Caller supplies the active context boundary before reasoning/block projection. */
  startIndex?: number;
  echoApiBlockOrder?: boolean;
}

const thinking = (block: WireBlock | undefined): boolean => block?.type === "thinking" || block?.type === "redacted_thinking";

/** Shipped EGo: tools follow other blocks, except a thinking/tool/thinking chain. */
export function orderAssistantBlocks(content: readonly WireBlock[]): WireBlock[] {
  let firstTool = -1, move = false, previousThinking = false, toolSincePrevious = false, protectedChain = false;
  for (const [index, block] of content.entries()) {
    if (block.type === "tool_use") {
      if (firstTool < 0) firstTool = index;
      toolSincePrevious = true;
    } else {
      if (firstTool >= 0) move = true;
      const currentThinking = thinking(block);
      if (currentThinking && previousThinking && toolSincePrevious) protectedChain = true;
      previousThinking = currentThinking;
      toolSincePrevious = false;
    }
  }
  return move && !protectedChain
    ? [...content.filter(block => block.type !== "tool_use"), ...content.filter(block => block.type === "tool_use")]
    : [...content];
}

function mergeAssistant(left: HistoryProjectionMessage, right: HistoryProjectionMessage, echo: boolean): HistoryProjectionMessage {
  if (echo && typeof left.apiBlockIndex === "number" && typeof right.apiBlockIndex === "number") {
    const indexed = [{ row: left, base: left.apiBlockIndex }, { row: right, base: right.apiBlockIndex }].flatMap(({ row, base }) => row.content.map((block, index) => ({ block,
      index: row.apiBlockIndices?.length === row.content.length ? row.apiBlockIndices[index] ?? base : base })));
    indexed.sort((a, b) => a.index - b.index);
    return { ...left, apiBlockIndex: Math.min(left.apiBlockIndex, right.apiBlockIndex),
      apiBlockIndices: indexed.map(item => item.index), content: indexed.map(item => item.block) };
  }
  const joined = [...left.content, ...right.content];
  const trimmed = joined.filter((block, index) => block.type !== "text" || !block.text.length || block.text.trim() !== "" ||
    thinking(joined[index - 1]) && thinking(joined[index + 1]));
  const content = trimmed.some(block => !thinking(block)) ? trimmed : joined;
  const { apiBlockIndex: _index, apiBlockIndices: _indices, ...kept } = left;
  return { ...kept, content: orderAssistantBlocks(content) };
}

/** C0/YHo/RGo: stable result-first grouping, with a newline at adjacent text-row seams. */
function mergeUser(left: HistoryProjectionMessage, right: HistoryProjectionMessage): HistoryProjectionMessage {
  const content = [...left.content];
  const last = content.at(-1);
  if (last?.type === "text" && right.content[0]?.type === "text") content[content.length - 1] = { ...last, text: `${last.text}\n` };
  for (const block of right.content) content.push(block);
  return { ...left, content: [...content.filter(block => block.type === "tool_result"), ...content.filter(block => block.type !== "tool_result")] };
}

/**
 * The ordinary assistant/user part of shipped Kke, hMi and Jke.
 * Only explicit, equal response identities coalesce through result-bearing user rows.
 * Neither errors nor tool names imply a shared response. Attachments must be rendered
 * before this helper; their source-specific relocation/folding is a separate stage.
 * All writes target fresh arrays/rows; signed blocks and original tool inputs survive.
 */
export function normalizeHistoryMessages(messages: readonly HistoryProjectionMessage[], options: HistoryNormalizationOptions = {}): WireMessage[] {
  const rows: HistoryProjectionMessage[] = [];
  const candidates = new Map<string, number>();
  let scan = 0;
  for (const source of messages.slice(options.startIndex ?? 0)) {
    if (source.role === "user") {
      const previous = rows.at(-1);
      if (previous?.role === "user") rows[rows.length - 1] = mergeUser(previous, source);
      else rows.push({ ...source, content: [...source.content] });
      continue;
    }
    // This scan intentionally follows the projected rows: consecutive users may
    // have merged since the previous assistant, as in the original Kke loop.
    for (; scan < rows.length; scan++) {
      const row = rows[scan];
      if (!row) break;
      if (row.role === "assistant") {
        if (row.responseId !== undefined) candidates.set(row.responseId, scan);
      } else if (!row.content.some(block => block.type === "tool_result") || row.content.some(block =>
        block.type === "tool_result" && block.tool_use_id.startsWith("projectread_"))) candidates.clear();
    }
    const index = source.responseId === undefined ? undefined : candidates.get(source.responseId);
    if (index !== undefined && rows[index]?.role === "assistant") rows[index] = mergeAssistant(rows[index], source, options.echoApiBlockOrder === true);
    else rows.push({ ...source, content: options.echoApiBlockOrder && typeof source.apiBlockIndex === "number"
      ? [...source.content] : orderAssistantBlocks(source.content) });
  }
  // Moving a later block into an earlier assistant can leave adjacent result rows.
  const grouped: HistoryProjectionMessage[] = [];
  for (const row of rows) {
    const previous = grouped.at(-1);
    if (row.role === "user" && previous?.role === "user") grouped[grouped.length - 1] = mergeUser(previous, row);
    else grouped.push(row);
  }
  return grouped.map(({ role, content }) => ({ role, content }));
}

type WireToolResult = Extract<WireBlock, { type: "tool_result" }>;

/**
 * Shipped o4e's content append for Tau's supported text/image/document blocks.
 * The caller chooses the target and eligible attachment; this helper never guesses
 * ownership from tool IDs or reminder text. Search/tool-reference carriers are
 * outside Tau's API content vocabulary and must be kept out by the caller.
 */
export function appendProjectedToolResultContent(result: WireToolResult, additions: readonly ApiToolContent[]): WireToolResult {
  let appended = additions;
  if (result.is_error) appended = additions.filter(block => block.type === "text");
  if (!appended.length) return { ...result };
  if (typeof result.content === "string" && appended.every(block => block.type === "text")) return { ...result,
    content: [result.content.trim(), ...appended.map(block => block.text.trim())].filter(Boolean).join("\n\n") };
  const initial: ApiToolContent[] = typeof result.content === "string" ? result.content.trim()
    ? [{ type: "text", text: result.content.trim() }] : [] : [...result.content];
  const content: ApiToolContent[] = [];
  for (const block of [...initial, ...appended]) {
    if (block.type !== "text") { content.push(block); continue; }
    const text = block.text.trim();
    if (!text) continue;
    const previous = content.at(-1);
    if (previous?.type === "text") content[content.length - 1] = { ...previous, text: `${previous.text}\n\n${text}` };
    else content.push({ type: "text", text });
  }
  return { ...result, content };
}
