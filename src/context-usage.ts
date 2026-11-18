import type { Message, Usage } from "./types.js";

const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined;
export function contextUsage(usage: Usage | NonNullable<Message["usage"]>): Required<Omit<Usage, "iterations">> {
  const aggregate = { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 };
  if (aggregate.input_tokens + aggregate.cache_creation_input_tokens + aggregate.cache_read_input_tokens === 0 || !Array.isArray(usage.iterations)) return aggregate;
  const last = usage.iterations.findLast(entry => !["advisor_message", "compaction"].includes(String(record(entry)?.type)));
  const data = record(last);
  if (!data || !["message", "fallback_message"].includes(String(data.type))) return aggregate;
  const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = data;
  if (!nonnegative(input_tokens) || !nonnegative(output_tokens) || !nonnegative(cache_creation_input_tokens) || !nonnegative(cache_read_input_tokens) || input_tokens + cache_creation_input_tokens + cache_read_input_tokens <= 0) return aggregate;
  return { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens };
}
export function contextTokens(usage: Usage): number { return Object.values(contextUsage(usage)).reduce((sum, value) => sum + value, 0); }
export function clearedInputTokens(value: unknown): number {
  const data = record(value);
  if (!data) return 0;
  if (nonnegative(data.client_cut_tool_uses) && data.client_cut_tool_uses > 0) return nonnegative(data.client_estimated_cleared_input_tokens) ? data.client_estimated_cleared_input_tokens : 0;
  if (!Array.isArray(data.applied_edits)) return 0;
  let actual = 0;
  for (const edit of data.applied_edits) {
    const entry = record(edit);
    if (entry?.type === "clear_tool_uses_20250919" && nonnegative(entry.cleared_input_tokens)) actual += entry.cleared_input_tokens;
  }
  const estimate = data.client_estimated_cleared_input_tokens;
  return !nonnegative(estimate) ? actual : data.client_estimate_measured_from_prompts === true && actual > 0 ? estimate : Math.min(actual, estimate);
}
export function activeContextStart(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.contextBoundary) return index;
  return 0;
}
export function estimateMessageTokens(message: Message, charactersPerToken = 4): number {
  let tokens = 0;
  for (const block of message.content) {
    const value = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : block.type === "redacted_thinking" ? block.data : block.type === "tool_result" ? block.content : block.name + JSON.stringify(block.input ?? {});
    tokens += Math.round(value.length / charactersPerToken);
  }
  return tokens;
}
export function estimateContextTokens(messages: Message[], charactersPerToken = 4): number {
  const start = activeContextStart(messages);
  let anchor = start - 1, tokens = 0;
  for (let index = messages.length - 1; index >= start; index--) {
    const row = messages[index];
    if (!row) continue;
    if (row.contextBoundary) { anchor = index - 1; break; }
    const usage = row.role === "assistant" && row.usage && !row.contextUsageDiscarded ? contextUsage(row.usage) : undefined;
    if (usage && usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens > 0) {
      anchor = index; tokens = Object.values(usage).reduce((sum, value) => sum + value, 0) + (row.contextClearedInputTokens ?? 0); break;
    }
  }
  for (const message of messages.slice(Math.max(start, anchor + 1))) tokens += estimateMessageTokens(message, charactersPerToken);
  return tokens;
}
