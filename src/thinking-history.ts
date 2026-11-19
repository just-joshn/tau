import type {
  Completion,
  HookAttachment,
  Message,
  WireBlock,
  WireMessage,
} from "./types.js";
import { wrapTaskNotification, type Attachment } from "./attachments.js";
import { resolveModelFacts } from "./reasoning.js";
import { activeContextStart, contextTokens } from "./context-usage.js";
import { foldRoundReminders } from "./context-reminders.js";
import {
  normalizeHistoryMessages,
  type HistoryProjectionMessage,
} from "./history-normalization.js";
import {
  projectHookAttachments,
  type HookProjectionRow,
} from "./hook-attachment-projection.js";

export type ThinkingStrip =
  | { scope: "all" }
  | { scope: "partial"; from: { messageIndex: number; thinkingIndex: number } };
type Block = Message["content"][number];
export const isThinking = (block: { type: string }): boolean =>
  block.type === "thinking" || block.type === "redacted_thinking";
const onlyThinking = (content: Block[]): boolean =>
  content.length > 0 && content.every(isThinking);
const signatureKey = (
  block: Block | WireBlock | undefined,
): string | undefined =>
  block?.type === "thinking" && block.signature
    ? `thinking:${block.signature}`
    : block?.type === "redacted_thinking" && block.data
      ? `redacted:${block.data}`
      : undefined;

function strippedContent(content: Block[], from: number): Block[] {
  let count = 0;
  const first = content.findIndex(
    (block) => isThinking(block) && count++ === from,
  );
  if (first < 0) return content;
  const kept = content.filter(
    (block, index) =>
      (from > 0 && index < first) ||
      (!isThinking(block) && !(block.type === "text" && !block.text.trim())),
  );
  return kept.length ? kept : [{ type: "text", text: "[Thinking removed]" }];
}

/** Store a durable projection instruction while retaining original reasoning in local history. */
export function markThinkingStripped(
  messages: Message[],
  strip: ThinkingStrip,
): Message[] {
  let changed = false;
  const start = activeContextStart(messages);
  const result = messages.map((message, index) => {
    if (
      index < start ||
      message.role !== "assistant" ||
      (strip.scope === "partial" && index < strip.from.messageIndex)
    )
      return message;
    const from =
      strip.scope === "partial" && index === strip.from.messageIndex
        ? strip.from.thinkingIndex
        : 0;
    if (
      message.content.filter(isThinking).length <= from ||
      (message.thinkingStripFrom !== undefined &&
        message.thinkingStripFrom <= from)
    )
      return message;
    changed = true;
    return { ...message, thinkingStripFrom: from };
  });
  return changed ? result : messages;
}

/** Source `RPi` task-notification turn: its texts joined under one notification wrapper. */
function notificationContent(content: Block[]): WireBlock[] {
  const texts = content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  );
  return [
    { type: "text", text: wrapTaskNotification(texts.join("\n")) },
    ...content.flatMap((block): WireBlock[] =>
      block.type === "text" || block.type === "tool_result" ? [] : [block],
    ),
  ];
}

/** Independent projection of local metadata and orphan/trailing reasoning onto API messages. */
export function projectMessages(
  messages: Message[],
  preserveTrailingThinking = false,
): WireMessage[] {
  const lifecycleOrdered: Message[] = [],
    pending: Message[] = [];
  const flushRound = () => {
    // Source RPi queues attachments across ordinary user rows, then emits them
    // before that user round. Assistant/tool-result rows delimit the round.
    lifecycleOrdered.push(
      ...pending.filter((row) => row.contextPlacement === "subagent-start"),
      ...foldRoundReminders(
        pending.filter((row) => row.contextPlacement !== "subagent-start"),
      ),
    );
    pending.length = 0;
  };
  for (const message of messages.slice(activeContextStart(messages))) {
    if (
      message.role === "assistant" ||
      message.content.some((block) => block.type === "tool_result")
    ) {
      flushRound();
      lifecycleOrdered.push(message);
    } else pending.push(message);
  }
  flushRound();
  const rows = lifecycleOrdered.map((message) => ({
    ...message,
    content:
      message.thinkingStripFrom === undefined
        ? message.content
        : strippedContent(message.content, message.thinkingStripFrom),
  }));
  const keep = Array.from({ length: rows.length }, () => true);
  let final = rows.length - 1;
  while (final >= 0) {
    const row = rows[final];
    if (
      !row ||
      !onlyThinking(row.content) ||
      (!row.abandonedByStreamRetry &&
        !row.content.some(
          (block) => block.type === "thinking" && !block.signature,
        ))
    )
      break;
    final--;
  }
  let next = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row) continue;
    if (row.role === "assistant" && onlyThinking(row.content)) {
      const unsigned = row.content.some(
        (block) => block.type === "thinking" && !block.signature,
      );
      const following = next < 0 ? undefined : rows[next];
      keep[index] =
        !unsigned &&
        !row.abandonedByStreamRetry &&
        ((preserveTrailingThinking && index === final) ||
          (following?.role === "assistant" &&
            following.resumedFromIncompleteThinking === true &&
            keep[next] === true &&
            following.content.some(
              (block) =>
                isThinking(block) ||
                block.type !== "text" ||
                (block.text.trim() && block.text !== "[No message content]"),
            )));
    }
    if (
      !row.abandonedByStreamRetry &&
      !(
        onlyThinking(row.content) &&
        row.content.some(
          (block) => block.type === "thinking" && !block.signature,
        )
      )
    )
      next = index;
  }
  const attachments = new Map<WireBlock, HookAttachment[]>();
  const attachmentRows = new Map<HistoryProjectionMessage, Attachment>();
  const result: HistoryProjectionMessage[] = rows
    .filter(
      (row, index) =>
        keep[index] && (row.role !== "assistant" || row.content.length > 0),
    )
    .map(({ role, content, responseId, attachment, origin }) => {
      const projected: HistoryProjectionMessage = {
        role,
        ...(responseId === undefined ? {} : { responseId }),
        content:
          origin === "task-notification"
            ? notificationContent(content)
            : content.map(wireBlock),
      };
      if (attachment) attachmentRows.set(projected, attachment);
      return projected;
    });
  function wireBlock(block: Block): WireBlock {
    if (block.type !== "tool_result") return block;
    const {
      readContentOmitted: _omitted,
      apiContent,
      mcpResult: _raw,
      permissionDenied: _permission,
      permissionDecideLocation: _location,
      inputRejected: _input,
      instructionFiles: _instructions,
      hookStop: _hookStop,
      effectiveToolInput: _effectiveInput,
      hookResponse: _hookResponse,
      hookRewrittenOutput: _hookOutput,
      hookAttachments: orderedAttachments,
      ...wire
    } = block;
    const projected: WireBlock =
      apiContent === undefined ? wire : { ...wire, content: apiContent };
    if (orderedAttachments?.length)
      attachments.set(projected, orderedAttachments);
    return projected;
  }
  for (;;) {
    const last = result.at(-1);
    if (last?.role !== "assistant") break;
    let content = last.content.slice();
    for (
      let block = content.at(-1);
      block?.type === "text";
      block = content.at(-1)
    ) {
      if (!block.text.length || block.text.trim()) break;
      content.pop();
    }
    if (!content.length) {
      result.pop();
      continue;
    }
    if (!preserveTrailingThinking) {
      for (
        let tail = content.at(-1);
        tail && isThinking(tail);
        tail = content.at(-1)
      )
        content.pop();
      if (!content.length)
        content = [{ type: "text", text: "[No message content]" }];
    }
    if (content.length === last.content.length) break;
    last.content = content;
  }
  if (!attachments.size && !attachmentRows.size)
    return normalizeHistoryMessages(result);
  const ordered: HookProjectionRow[] = [];
  for (const row of result) {
    const attachment = attachmentRows.get(row);
    if (attachment) {
      ordered.push({ type: "hook_attachment", attachment });
      continue;
    }
    let pending: WireBlock[] = [];
    const flush = () => {
      if (pending.length)
        ordered.push({
          type: "message",
          message: { ...row, content: pending },
        });
      pending = [];
    };
    for (const block of row.content) {
      const tagged = attachments.get(block);
      if (!tagged?.length || block.type !== "tool_result") {
        pending.push(block);
        continue;
      }
      flush();
      const hookRow = ({ phase, ...attachment }: HookAttachment) => ({
        type: "hook_attachment" as const,
        phase,
        attachment,
        toolUseId: block.tool_use_id,
      });
      ordered.push(
        ...tagged.filter((item) => item.phase === "pre").map(hookRow),
      );
      ordered.push({ type: "message", message: { ...row, content: [block] } });
      ordered.push(
        ...tagged.filter((item) => item.phase !== "pre").map(hookRow),
      );
    }
    flush();
  }
  return projectHookAttachments(ordered);
}

export function prefixMismatchLocation(
  header: string | null,
): { messageIndex: number; blockIndex: number } | undefined {
  if (!header || header.length > 2048) return;
  const fields = new Map<string, string>();
  for (const field of header.split(";")) {
    const equal = field.indexOf("=");
    if (equal <= 0) continue;
    const key = field.slice(0, equal).trim();
    if (!fields.has(key)) fields.set(key, field.slice(equal + 1).trim());
  }
  const match = /^messages\.(\d{1,6})\.content\.(\d{1,6})$/.exec(
    fields.get("block") ?? "",
  );
  return match
    ? { messageIndex: Number(match[1]), blockIndex: Number(match[2]) }
    : undefined;
}

export function planThinkingStrip(
  messages: Message[],
  wire: ReturnType<typeof projectMessages>,
  header: string | null,
  attempt: number,
): ThinkingStrip | undefined {
  const location = attempt <= 2 ? prefixMismatchLocation(header) : undefined;
  const row = location ? wire[location.messageIndex] : undefined;
  const key =
    row?.role === "assistant" && location
      ? signatureKey(row.content[location.blockIndex])
      : undefined;
  if (key) {
    const matches: Array<{ messageIndex: number; thinkingIndex: number }> = [];
    const start = activeContextStart(messages);
    for (const [messageIndex, message] of messages.entries()) {
      if (messageIndex < start) continue;
      if (message.role !== "assistant") continue;
      let thinkingIndex = 0;
      for (const block of message.content) {
        if (!isThinking(block)) continue;
        if (
          (message.thinkingStripFrom === undefined ||
            thinkingIndex < message.thinkingStripFrom) &&
          signatureKey(block) === key
        )
          matches.push({ messageIndex, thinkingIndex });
        thinkingIndex++;
      }
    }
    const [match] = matches;
    if (matches.length === 1 && match) {
      const partial: ThinkingStrip = { scope: "partial", from: match };
      if (markThinkingStripped(messages, partial) !== messages) return partial;
    }
  }
  const all: ThinkingStrip = { scope: "all" };
  return markThinkingStripped(messages, all) === messages ? undefined : all;
}

export function canResumeThinking(
  completion: Completion,
  model: string,
  contextWindow: number,
): boolean {
  const [block] = completion.content;
  if (
    completion.stop_reason !== "max_tokens" ||
    completion.resumable !== true ||
    completion.content.length !== 1 ||
    !block ||
    !completion.responseModel
  )
    return false;
  if (!isThinking(block) || (block.type === "thinking" && !block.signature))
    return false;
  if (
    resolveModelFacts(completion.responseModel).canonical !==
    resolveModelFacts(model).canonical
  )
    return false;
  const tokens = contextTokens(completion.usage);
  return tokens <= 0 || tokens + 2048 < contextWindow;
}
