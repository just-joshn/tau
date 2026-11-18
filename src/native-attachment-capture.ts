import type { CatalogProjection } from "./catalog-projection.js";
import type { CommandHook, HookResult } from "./hooks.js";
import {
  captureNativePersistenceJson,
  createNativeAttachmentEvent,
  type NativePersistenceAttachment,
  type NativePersistenceEvent,
} from "./native-persistence-events.js";
import type { Message, ToolResult, ToolUse } from "./types.js";

export type NativeCapturedAttachment = Extract<
  NativePersistenceAttachment,
  { type: "agent_listing_delta" | "skill_listing" | "hook_additional_context" }
>;
export type NativeToolHookPhase = "pre" | "post" | "failure";
export interface NativeHookCaptureFacts {
  source: "tool-hook";
  phase: NativeToolHookPhase;
  event: string;
  toolName: string;
  toolUseID: string;
  toolInput: unknown;
  execution: "sync" | "background";
  /** Actual observed command outcome, detached before owner callbacks. */
  outcome: Readonly<HookResult>;
  transport: "command" | "unknown";
  commandHook?: Readonly<CommandHook>;
}
export interface NativeHookBatchCaptureFacts {
  source: "tool-hook-batch";
  phase: NativeToolHookPhase;
  event: string;
  toolName: string;
  toolUseID: string;
  toolInput: unknown;
  backgroundIDs: readonly string[];
  unobservedResults: readonly HookResult[];
  aggregateAdditionalContext: readonly string[];
}
export interface NativeCatalogCaptureFacts {
  source: "catalog";
  attachmentIndex: number;
  /** Independent existing notice; canonical native rendering is retained on the event. */
  projectedBlock: CatalogProjection["blocks"][number] | null;
}
export type NativeAttachmentCaptureFacts =
  | NativeCatalogCaptureFacts
  | NativeHookCaptureFacts
  | NativeHookBatchCaptureFacts;
export type NativeAttachmentDelivery =
  | { kind: "catalog"; message: Message; createdMessage: boolean }
  | {
      kind: "tool-hook";
      phase: NativeToolHookPhase;
      call: ToolUse;
      result?: ToolResult;
      error?: unknown;
    };
export type NativeAttachmentCaptureResult =
  | {
      status: "captured";
      facts: NativeAttachmentCaptureFacts;
      attachment: NativeCapturedAttachment;
      event: NativePersistenceEvent;
    }
  | {
      status: "unsupported";
      facts: NativeAttachmentCaptureFacts;
      reasons: readonly string[];
    };
export interface NativeAttachmentCaptureHost {
  /** The owning journal stamps actual creation, never a display hash or save-time pass. */
  stamp(
    input: Readonly<{
      attachment: NativeCapturedAttachment;
      facts: NativeAttachmentCaptureFacts;
    }>,
  ): { uuid: string; timestamp: string };
  capture(
    result: NativeAttachmentCaptureResult,
    delivery: NativeAttachmentDelivery,
  ): void | Promise<void>;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot<T>(value: T): T {
  // Descriptor-only finite JSON validation precedes the structured clone. Delivery
  // identities and errors deliberately stay outside this native payload boundary.
  captureNativePersistenceJson(value);
  return freeze(structuredClone(value));
}
async function emit(
  host: NativeAttachmentCaptureHost,
  attachment: NativeCapturedAttachment,
  facts: NativeAttachmentCaptureFacts,
  delivery: NativeAttachmentDelivery,
): Promise<void> {
  const stamp = host.stamp(freeze({ attachment, facts }));
  const event = createNativeAttachmentEvent(attachment, stamp);
  await host.capture(
    freeze({ status: "captured", facts, attachment, event }),
    delivery,
  );
}
/** Exact structured catalog projection, one native attachment per producer entry. */
export async function captureNativeCatalogAttachments(
  host: NativeAttachmentCaptureHost,
  projection: CatalogProjection,
  delivery: Extract<NativeAttachmentDelivery, { kind: "catalog" }>,
): Promise<void> {
  // Snapshot the whole production before the first callback can mutate arrays.
  const captured = snapshot(projection);
  for (const [attachmentIndex, attachment] of captured.attachments.entries()) {
    const facts: NativeCatalogCaptureFacts = freeze({
      source: "catalog",
      attachmentIndex,
      projectedBlock: captured.blocks[attachmentIndex] ?? null,
    });
    await emit(host, attachment, facts, delivery);
  }
}
/** Consume an actual individual hook outcome, never the phase aggregate strings. */
export async function captureNativeToolHookResult(
  host: NativeAttachmentCaptureHost,
  input: NativeHookCaptureFacts,
  delivery: Extract<NativeAttachmentDelivery, { kind: "tool-hook" }>,
): Promise<void> {
  const facts = snapshot(input);
  const reasons: string[] = [];
  const expected = (
    {
      pre: "PreToolUse",
      post: "PostToolUse",
      failure: "PostToolUseFailure",
    } as const
  )[facts.phase];
  if (facts.event !== expected || facts.outcome.event !== expected)
    reasons.push("Hook phase and actual outcome event do not agree");
  if (
    delivery.phase !== facts.phase ||
    delivery.call.name !== facts.toolName ||
    delivery.call.id !== facts.toolUseID
  )
    reasons.push(
      "Hook delivery does not own the actual captured call and physical phase",
    );
  if (
    facts.transport !== "command" ||
    !facts.commandHook ||
    facts.commandHook.command !== facts.outcome.command
  )
    reasons.push("Hook transport requires its actual source outcome adapter");
  if (facts.execution !== "sync")
    reasons.push(
      "Background hook completion requires its native asynchronous attachment owner",
    );
  if (facts.outcome.status !== "success")
    reasons.push(
      "Non-success hook outcome requires its native diagnostic/blocking attachment adapter",
    );
  if (facts.outcome.systemMessage || facts.outcome.preventContinuation)
    reasons.push(
      "Hook system/continuation attachments require their native physical event adapter",
    );
  if (facts.phase === "pre" && facts.outcome.permission === "defer")
    reasons.push(
      "Deferred pre-hook additional context is not emitted by the native tool consumer",
    );
  const context = facts.outcome.additionalContext;
  if (context && context.length > 10_000)
    reasons.push(
      "Hook context above the source 10000-character bound requires its actual WMe persisted-output projection",
    );
  if (reasons.length) {
    await host.capture(
      freeze({ status: "unsupported", facts, reasons }),
      delivery,
    );
    return;
  }
  if (!context) return;
  const attachment: NativeCapturedAttachment = freeze({
    type: "hook_additional_context",
    content: [context],
    hookName: `${facts.event}:${facts.toolName}`,
    hookEvent: expected,
    toolUseID: facts.toolUseID,
  });
  await emit(host, attachment, facts, delivery);
}
/** A registry without creation observations, or pending async transport, cannot be reconstructed from a batch. */
export async function captureUnsupportedNativeHookBatch(
  host: NativeAttachmentCaptureHost,
  input: NativeHookBatchCaptureFacts,
  delivery: Extract<NativeAttachmentDelivery, { kind: "tool-hook" }>,
): Promise<void> {
  const facts = snapshot(input);
  await host.capture(
    freeze({
      status: "unsupported",
      facts,
      reasons: [
        "Hook batch contains pending asynchronous ownership or outcomes without creation observations; phase aggregation cannot reconstruct native events",
      ],
    }),
    delivery,
  );
}
