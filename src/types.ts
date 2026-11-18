import { z } from "zod";
import type { ApiAttemptBudget } from "./attempt-ledger.js";
import type { StreamFailureCause } from "./recovery.js";
import type { ThinkingOptions } from "./reasoning.js";
import type { ThinkingStrip } from "./thinking-history.js";
import type { ContextWindow } from "./context-window.js";
import type { ReadToolContext } from "./context-room.js";
import type { QueryEffort } from "./query-model-effort.js";

export const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const imageSourceSchema = z.object({ type: z.literal("base64"), media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]), data: z.string() });
const documentSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base64"), media_type: z.literal("application/pdf"), data: z.string() }),
  z.object({ type: z.literal("text"), media_type: z.literal("text/plain"), data: z.string() }),
]);
/** Model-visible MCP projections retained alongside the terminal's textual summary. */
export const apiToolContentSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  z.object({ type: z.literal("image"), source: imageSourceSchema }),
  z.object({ type: z.literal("document"), source: documentSourceSchema, title: z.string().optional() }),
]);
export type ApiToolContent = z.infer<typeof apiToolContentSchema>;
export const instructionRecordSchema = z.object({
  path: z.string(), kind: z.enum(["Managed", "User", "Project", "Local"]),
  contentHash: z.string(), partial: z.boolean(), removed: z.boolean().optional(),
});
export type InstructionRecord = z.infer<typeof instructionRecordSchema>;
export const thinkingBlockSchema = z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() });
export const redactedThinkingSchema = z.object({ type: z.literal("redacted_thinking"), data: z.string() });
export const toolUseSchema = z.object({
  type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1),
  input: z.unknown(),
});
export const hookAttachmentSchema = z.object({
  phase: z.enum(["pre", "post", "failure"]), event: z.enum(["PreToolUse", "PostToolUse", "PostToolUseFailure"]),
  toolName: z.string(), content: z.array(z.string()),
});
export type HookAttachmentMetadata = z.infer<typeof hookAttachmentSchema>;
export const toolResultSchema = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string(), content: z.string(), is_error: z.boolean().optional(),
  /** Local metadata for a future unchanged-content Read notice; never sent to the API. */
  readContentOmitted: z.boolean().optional(),
  apiContent: z.array(apiToolContentSchema).optional(),
  /** Raw MCP result, including structuredContent and _meta; local persistence only. */
  mcpResult: z.unknown().optional(),
  permissionDenied: z.boolean().optional(), inputRejected: z.boolean().optional(),
  hookStop: z.object({ reason: z.string() }).optional(),
  /** Effective hook input and raw execution data; original assistant input stays unchanged. */
  effectiveToolInput: z.unknown().optional(), hookResponse: z.unknown().optional(),
  hookRewrittenOutput: z.unknown().optional(),
  /** Hook attachments are committed as sibling user text, outside tool results. */
  hookContext: z.array(z.string()).optional(),
  /** Ordered hook attachments are projected around the actual result, never inferred from text. */
  hookAttachments: z.array(hookAttachmentSchema).optional(),
  instructionFiles: z.array(instructionRecordSchema).optional(),
});
export const assistantBlockSchema = z.discriminatedUnion("type", [textBlockSchema, toolUseSchema, thinkingBlockSchema, redactedThinkingSchema]);
export const blockSchema = z.discriminatedUnion("type", [textBlockSchema, toolUseSchema, toolResultSchema, thinkingBlockSchema, redactedThinkingSchema]);
export const usageSchema = z.object({
  input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(), cache_read_input_tokens: z.number().nonnegative().optional(),
  iterations: z.array(z.unknown()).optional(),
});
/** Local attachment identity used to compute subsequent catalog deltas; never an API field. */
export const catalogAttachmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_listing_delta"), addedTypes: z.array(z.string()), addedLines: z.array(z.string()),
    builtInTypes: z.array(z.string()), builtInPluginTypes: z.array(z.string()), removedTypes: z.array(z.string()),
    isInitial: z.boolean(), showConcurrencyNote: z.boolean() }),
  z.object({ type: z.literal("skill_listing"), content: z.string(), skillCount: z.number().int().nonnegative(), isInitial: z.boolean(),
    names: z.array(z.string()), digests: z.array(z.string()), shortened: z.literal(true).optional(),
    addsToEarlier: z.literal(true).optional(), callsSkillToolDirectly: z.literal(true).optional() }),
]);
export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(blockSchema),
  instructionFiles: z.array(instructionRecordSchema).optional(),
  catalogAttachments: z.array(catalogAttachmentSchema).optional(),
  partial: z.object({ cause: z.string() }).optional(),
  model: z.string().optional(),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  requestedModel: z.string().optional(),
  resumable: z.boolean().optional(),
  resumedFromIncompleteThinking: z.boolean().optional(),
  abandonedByStreamRetry: z.boolean().optional(),
  thinkingStripFrom: z.number().int().nonnegative().optional(),
  usage: usageSchema.optional(),
  contextClearedInputTokens: z.number().nonnegative().optional(),
  contextUsageDiscarded: z.boolean().optional(),
  contextTruncated: z.boolean().optional(),
  toolDenialKind: z.string().optional(),
  restoredFile: z.object({ path: z.string(), kind: z.enum(["text", "reference"]), timestamp: z.number() }).optional(),
  contextBoundary: z.object({ beforeTokens: z.number().nonnegative(), afterTokens: z.number().nonnegative(), reason: z.enum(["automatic", "manual", "reactive"]),
    groupsPreserved: z.number().int().nonnegative().optional(), totalGroups: z.number().int().nonnegative().optional(), headTruncations: z.number().int().nonnegative().optional(),
    omissionPasses: z.number().int().nonnegative().optional(), omittedToolResults: z.number().int().nonnegative().optional(),
    formatRepairs: z.number().int().nonnegative().optional(), secondarySummary: z.boolean().optional(), openingRescue: z.boolean().optional(), freshRequests: z.number().int().nonnegative().optional(), summaryModel: z.string().optional() }).optional(),
});
export type Message = z.infer<typeof messageSchema>;
export type ToolUse = z.infer<typeof toolUseSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type WireBlock = Exclude<Message["content"][number], ToolResult> |
  { type: "tool_result"; tool_use_id: string; content: string | ApiToolContent[]; is_error?: boolean | undefined };
export interface WireMessage { role: Message["role"]; content: WireBlock[] }
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}
export interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; iterations?: unknown[] }
export interface Completion {
  content: Array<z.infer<typeof assistantBlockSchema>>;
  stop_reason: string;
  usage: Usage;
  partial?: { cause: StreamFailureCause };
  model?: string;
  responseModel?: string;
  responseId?: string;
  resumable?: boolean;
  contextClearedInputTokens?: number;
}
export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens: number;
  useModelTokenDefaults?: boolean;
  thinking?: ThinkingOptions;
  /** Current query effort layer; request-only metadata, never a transcript field. */
  queryEffort?: QueryEffort;
  resumeIncompleteThinking?: boolean;
  signal: AbortSignal;
  onText: (text: string) => void;
  /** Attempt-local stream observations, before later usage reconciliation mutates retained rows. */
  onStreamProgress?: (event: ProviderStreamProgress) => void;
  /** Replace provisional text for this model round, preserving previous completed rounds. */
  onTextReset?: (text: string) => void;
  onThinkingStrip?: (strip: ThinkingStrip) => void;
  attemptBudget?: ApiAttemptBudget;
  disablePromptCaching?: boolean;
}
export type ProviderStreamProgress =
  | { type: "response_start" }
  | { type: "block_start" }
  | { type: "length"; chars: number }
  | { type: "thinking_progress"; estimatedTokensDelta: number }
  | { type: "thinking_signature"; chars: number }
  | { type: "assistant"; responseId?: string; usage: Usage }
  | { type: "response_end" };
export interface Provider {
  countFileTokens?(request: { model: string; text: string; signal: AbortSignal }): Promise<number | undefined>;
  readonly thinkingResumption?: boolean;
  contextWindowTokens?(model: string): number;
  contextWindow?(model: string): ContextWindow;
  outputTokenLimit?(model: string): number;
  resetRequestLimits?(): void;
  canUseModel?(model: string): boolean;
  complete(request: CompletionRequest): Promise<Completion>;
}
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export interface ToolExecutor {
  definitions: ToolDefinition[];
  execute(call: ToolUse, signal: AbortSignal): Promise<ToolResult>;
  beforeModelRequest?(signal: AbortSignal): Promise<void>;
  prepareCompaction?: PrepareCompaction;
  setReadContext?(context: ReadToolContext | undefined): void;
}

export type PrepareCompaction = (options: {
  keptMessages: Message[]; signal: AbortSignal;
  countTokens?: (text: string) => Promise<number | undefined>;
}) => Promise<{ messages: Message[]; commit(): void }>;
export type AgentEvent =
  | { type: "usage"; usage: Usage }
  | { type: "text"; text: string }
  | { type: "text_reset"; text: string }
  | { type: "warning"; message: string }
  | { type: "thinking_stripped"; strip: ThinkingStrip }
  | { type: "compaction"; stage: "start" | "complete" | "failed" | "skipped"; beforeTokens?: number; afterTokens?: number; reason?: string;
      groupsPreserved?: number; totalGroups?: number; headTruncations?: number; omissionPasses?: number; omittedToolResults?: number;
      formatRepairs?: number; secondarySummary?: boolean; openingRescue?: boolean; freshRequests?: number; summaryModel?: string }
  | { type: "assistant"; message: Message }
  | { type: "tool_start"; tool: ToolUse }
  | { type: "tool_result"; result: ToolResult };
