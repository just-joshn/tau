import { z } from "zod";
import { sanitizeAutoMemoryIndex } from "./auto-memory.js";
import { escapeReminderText } from "./attachments.js";
import {
  validateNativeHookProgressRow,
  validateNativeStopHookSummaryRow,
} from "./native-hook-progress.js";
import {
  isNativeObject,
  type NativeJson,
  type NativeObject,
} from "./native-session-codec.js";

export type NativePersistenceEvent = NativeObject & {
  readonly type: "user" | "assistant" | "attachment" | "system" | "progress";
  readonly uuid: string;
  readonly timestamp: string;
};
function hasEventIdentity(value: NativeJson): value is NativePersistenceEvent {
  return (
    isNativeObject(value) &&
    (value.type === "user" ||
      value.type === "assistant" ||
      value.type === "system" ||
      value.type === "progress" ||
      value.type === "attachment") &&
    typeof value.uuid === "string" &&
    typeof value.timestamp === "string"
  );
}
/** Finite plain JSON capture before validation; optional object undefineds follow JSON.stringify. */
export function captureNativePersistenceJson(
  value: unknown,
  active = new Set<object>(),
): NativeJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || active.has(value))
    throw new TypeError("Native persistence requires finite plain JSON");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError("Unsupported native persistence JSON prototype");
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
    throw new TypeError("Unsupported native persistence JSON symbol");
  if (Array.isArray(value) && Object.keys(value).length !== value.length)
    throw new TypeError("Sparse or decorated native persistence array");
  active.add(value);
  try {
    const entries: [string, NativeJson][] = [];
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (Array.isArray(value) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new TypeError("Unsupported native persistence JSON accessor");
      if (descriptor.value === undefined && !Array.isArray(value)) continue;
      entries.push([
        key,
        captureNativePersistenceJson(descriptor.value, active),
      ]);
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
const json = z.custom<NativeJson>((value) => {
  try {
    captureNativePersistenceJson(value);
    return true;
  } catch {
    return false;
  }
});
const nonempty = z.string().min(1),
  count = z.number().int().nonnegative();
const text = z.strictObject({ type: z.literal("text"), text: z.string() });
const toolUse = z.strictObject({
  type: z.literal("tool_use"),
  id: nonempty,
  name: nonempty,
  input: json,
});
const assistantBlock = z.discriminatedUnion("type", [
  text,
  toolUse,
  z.strictObject({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  }),
  z.strictObject({ type: z.literal("redacted_thinking"), data: nonempty }),
]);
const toolResult = z.strictObject({
  type: z.literal("tool_result"),
  tool_use_id: nonempty,
  content: z.union([z.string(), z.array(text)]),
  is_error: z.boolean().optional(),
});
const identity = {
  uuid: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  timestamp: nonempty.refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Invalid native timestamp",
  ),
};
const reasons = [
  "session_start",
  "compaction",
  "policy_refresh",
  "managed_folder_check",
  "directory_added",
  "settings_sync",
  "account_change",
  "hooks_invalidate",
  "policy_verdict",
  "project_reread",
  "project_changed",
  "project_left",
  "memory_paused",
  "memory_resumed",
  "auto_memory_off",
  "auto_memory_back_on",
] as const;
const instructionFile = z.strictObject({
  path: nonempty,
  type: z.enum(["Managed", "User", "Project", "Local", "AutoMem"]),
  content: z.string(),
  unverified: z.boolean().optional(),
  startOnly: z.boolean().optional(),
  cutForRoom: z.boolean().optional(),
});
const lifecycleHookEvent = z.enum([
  "SessionStart",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "UserPromptExpansion",
]);
const lifecycleHookIdentity = {
  hookName: nonempty,
  toolUseID: nonempty,
  hookEvent: lifecycleHookEvent,
};
const attachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hook_success"),
    ...lifecycleHookIdentity,
    content: z.string(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
    command: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("hook_system_message"),
    ...lifecycleHookIdentity,
    content: z.string(),
    heldForServedCall: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("hook_non_blocking_error"),
    ...lifecycleHookIdentity,
    stderr: z.string(),
    stdout: z.string(),
    exitCode: z.number().int().optional(),
    command: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("hook_error_during_execution"),
    ...lifecycleHookIdentity,
    content: z.string(),
    command: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("hook_cancelled"),
    ...lifecycleHookIdentity,
    command: z.string().optional(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("hook_blocking_error"),
    ...lifecycleHookIdentity,
    blockingError: z.strictObject({
      blockingError: z.string(),
      command: z.string(),
    }),
  }),
  z.strictObject({
    type: z.literal("hook_stopped_continuation"),
    ...lifecycleHookIdentity,
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal("max_turns_reached"),
    maxTurns: count,
    turnCount: count,
    exitCommitted: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("instructions"),
    files: z.array(instructionFile),
    removed: z.array(nonempty).optional(),
    changed: z.boolean().optional(),
    reason: z.enum(reasons).optional(),
  }),
  z.strictObject({
    type: z.literal("agent_listing_delta"),
    addedTypes: z.array(nonempty),
    addedLines: z.array(z.string()),
    builtInTypes: z.array(nonempty),
    builtInPluginTypes: z.array(nonempty),
    removedTypes: z.array(nonempty),
    isInitial: z.boolean(),
    showConcurrencyNote: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("skill_listing"),
    content: z.string(),
    skillCount: count,
    isInitial: z.boolean(),
    names: z.array(nonempty),
    digests: z.array(z.string()).optional(),
    shortened: z.literal(true).optional(),
    addsToEarlier: z.literal(true).optional(),
    callsSkillToolDirectly: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("hook_additional_context"),
    content: z.array(z.string()),
    hookName: nonempty,
    toolUseID: nonempty,
    hookEvent: z.enum([
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
      "UserPromptExpansion",
    ]),
  }),
  // This renderer/writer host is the ordinary announced branch. Positive wire/fold
  // gates require their dedicated context adapter, never replacement with false.
  z.strictObject({
    type: z.literal("prompt_snapshot"),
    systemPrompt: z.array(z.string()),
    tools: z
      .array(
        z.strictObject({
          name: nonempty,
          description: z.string(),
          schema: z.record(z.string(), json).optional(),
          server: z.string().optional(),
        }),
      )
      .optional(),
    cliPrefix: z.string().optional(),
    reminderFold: z.literal(false).optional(),
    echoWireToolInputs: z.literal(false).optional(),
    contextRendering: z.literal("announced").optional(),
    systemTurns: z.literal(false).optional(),
    toolChangeHeader: z.literal(false).optional(),
    inlineTools: z.literal(false).optional(),
    keptReminders: z.literal(false).optional(),
    toolResultSafeguards: z.literal(false).optional(),
    projectDocsAsDocuments: z.literal(false).optional(),
    effortAfterText: z.literal(false).optional(),
    leadingTools: z.tuple([]).optional(),
  }),
]);
export type NativePersistenceAttachment = z.infer<typeof attachmentSchema>;
const renderedContent = z.union([
  nonempty,
  z.array(z.strictObject({ type: z.literal("text"), text: nonempty })).min(1),
]);
const rendered = z.array(z.strictObject({ content: renderedContent })).min(1);
const rawReadResult = z.strictObject({
  type: z.literal("text"),
  file: z.strictObject({
    filePath: nonempty,
    content: z.string(),
    numLines: count,
    startLine: count,
    totalLines: count,
  }),
});
const observedPermissionDecision = z.strictObject({
  decision: z.literal("accept"),
  source: z.literal("config"),
  reasonType: z.literal("mode"),
});
const usage = z.strictObject({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
  output_tokens_details: json.optional(),
  server_tool_use: json.optional(),
  service_tier: z.string().nullable().optional(),
  cache_creation: json.optional(),
  inference_geo: z.string().nullable().optional(),
  iterations: z.array(json).nullable().optional(),
  speed: z.string().nullable().optional(),
  fallback_credit: json.optional(),
});
const assistantMessage = z.strictObject({
  id: nonempty,
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: nonempty,
  content: z.array(assistantBlock).min(1),
  stop_reason: nonempty,
  stop_sequence: z.string().nullable().optional(),
  stop_details: json.optional(),
  usage,
  diagnostics: json.optional(),
  container: json.optional(),
  context_management: json.optional(),
  resumable: z.boolean().optional(),
});
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("system"),
    ...identity,
    subtype: z.literal("informational"),
    content: z.string(),
    isMeta: z.literal(false),
    level: nonempty,
  }),
  z.strictObject({
    type: z.literal("assistant"),
    ...identity,
    message: assistantMessage,
    apiBlockIndex: count,
    requestedModel: nonempty.optional(),
    requestId: z.string().optional(),
    promptCacheRequested: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("user"),
    ...identity,
    message: z.strictObject({
      role: z.literal("user"),
      content: z.union([nonempty, z.array(z.union([text, toolResult])).min(1)]),
    }),
    sourceToolAssistantUUID: identity.uuid.optional(),
    toolUseResult: rawReadResult.optional(),
    permissionDecision: observedPermissionDecision.optional(),
    permissionMode: z
      .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
      .optional(),
    promptSource: nonempty.optional(),
    isMeta: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("attachment"),
    ...identity,
    attachment: attachmentSchema,
    rendered: rendered.optional(),
    renderedRole: z.enum(["user", "system"]).optional(),
    placement: z.literal("next_to_message").optional(),
  }),
]);
const instructionPreamble =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";
const instructionKinds = {
  Managed: " (organization-managed policy instructions)",
  User: " (user's private global instructions for all projects)",
  Project: " (project instructions, checked into the codebase)",
  Local: " (user's private project instructions, not checked in)",
  AutoMem: " (user's auto-memory, persists across conversations)",
};
const reasonText: Record<(typeof reasons)[number], string> = {
  session_start: "when this session started",
  compaction: "after the conversation was compacted",
  policy_refresh: "after the organization's managed settings changed",
  managed_folder_check: "after a check of this machine's managed folder",
  directory_added: "after a working directory was added",
  settings_sync: "after settings were synced onto this machine",
  account_change: "after the account changed",
  hooks_invalidate: "after a plugin had the context re-read",
  policy_verdict: "after the organization's policy arrived",
  project_reread:
    "after an earlier read of the attached claude.ai Project failed",
  project_changed: "after this chat's claude.ai Project changed",
  project_left:
    "after this chat was moved out of its claude.ai Project, which no longer applies",
  memory_paused: "after memory was paused for this session",
  memory_resumed: "after memory was resumed for this session",
  auto_memory_off: "after auto-memory was turned off for this session",
  auto_memory_back_on: "after auto-memory was turned back on for this session",
};
const wrap = (value: string) =>
  `<system-reminder>\n${value}\n</system-reminder>`;
type InstructionNoticeFile = {
  path: string;
  type: keyof typeof instructionKinds;
  content: string;
};
function instructionContents(files: readonly InstructionNoticeFile[]): string {
  return files
    .map((file) => {
      const content =
        file.type === "AutoMem"
          ? sanitizeAutoMemoryIndex(file.content).trim()
          : file.content.trim();
      return `Contents of ${file.path}${instructionKinds[file.type]}:\n\n${content}`;
    })
    .join("\n\n");
}
function initialInstructionText(
  files: readonly InstructionNoticeFile[],
): string {
  const body = instructionContents(files);
  return body ? `${instructionPreamble}\n\n${body}` : "";
}
/** First-load claudeMd reminder, including the AutoMem index sanitizer. */
export function renderFirstLoadInstructionReminder(
  files: readonly InstructionNoticeFile[],
): string {
  const text = initialInstructionText(files);
  return text ? wrap(text) : "";
}
/** Exact supported ordinary QTe/amn branch. This host has no Code Mode/system-turn renderer. */
export function renderNativePersistenceAttachment(
  value: unknown,
): readonly { content: string }[] {
  const attachment = attachmentSchema.parse(
    captureNativePersistenceJson(value),
  );
  let output = "";
  switch (attachment.type) {
    case "max_turns_reached":
      return [];
    case "hook_success":
      if (
        !["SessionStart", "UserPromptSubmit", "UserPromptExpansion"].includes(
          attachment.hookEvent,
        ) ||
        !attachment.content
      )
        return [];
      output = escapeReminderText(
        `${attachment.hookName} hook success: ${attachment.content}`,
      );
      break;
    case "hook_blocking_error":
      output = escapeReminderText(
        `${attachment.hookName} hook blocking error from command: "${attachment.blockingError.command}": ${attachment.blockingError.blockingError}`,
      );
      break;
    case "hook_stopped_continuation":
      output = escapeReminderText(
        `${attachment.hookName} hook stopped continuation: ${attachment.message}`,
      );
      break;
    case "hook_system_message":
    case "hook_non_blocking_error":
    case "hook_error_during_execution":
    case "hook_cancelled":
      return [];
    case "prompt_snapshot":
      return [];
    case "instructions": {
      if (
        attachment.files.some(
          (file) => file.unverified === true || file.type === "AutoMem",
        )
      )
        throw new Error(
          "Unverified/auto-memory instruction rendering requires its native sanitizer host",
        );
      if (!attachment.changed) {
        if (attachment.removed?.length)
          throw new Error(
            "Removed instructions require their native changed attachment",
          );
        output = initialInstructionText(attachment.files);
      } else {
        const body = instructionContents(attachment.files);
        const removed = (attachment.removed ?? []).map(
          (path) => `Instructions no longer present: ${path}`,
        );
        const heading = attachment.reason
          ? `Instruction files were re-read ${reasonText[attachment.reason]}; these differ from their earlier copies`
          : "These instruction files changed";
        output = [
          ...(body
            ? [
                `${heading} — each replaces its earlier copy, and the instructions preamble above still applies:\n\n${body}`,
              ]
            : []),
          ...(removed.length && !body && attachment.reason
            ? [
                `Instruction files were re-read ${reasonText[attachment.reason]}.`,
              ]
            : []),
          ...removed,
        ].join("\n\n");
      }
      break;
    }
    case "agent_listing_delta": {
      const parts: string[] = [];
      if (attachment.addedLines.length && attachment.addedTypes.length)
        parts.push(
          `${attachment.isInitial ? "Available agent types for the Agent tool:" : "New agent types are now available for the Agent tool:"}\n${attachment.addedLines.join("\n")}`,
        );
      if (attachment.removedTypes.length)
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map((type) => `- ${type}`).join("\n")}`,
          "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
        );
      if (
        attachment.addedLines.length &&
        attachment.addedTypes.length &&
        attachment.isInitial &&
        attachment.showConcurrencyNote
      )
        parts.push(
          "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
        );
      output = parts.join("\n\n");
      break;
    }
    case "skill_listing": {
      if (!attachment.content) return [];
      const body = attachment.shortened
        ? `${attachment.content}\n\nThis list is shortened to save room: some skills are listed by name alone. A skill listed by name alone works like any other.`
        : attachment.content;
      output = `The following skills are ${attachment.addsToEarlier ? "also " : ""}available for use with the Skill tool${attachment.addsToEarlier ? ". This list adds to the skills listed earlier in this conversation and is not the full list" : ""}:\n\n${body}`;
      break;
    }
    case "hook_additional_context": {
      const toolHook = [
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
      ].includes(attachment.hookEvent);
      if (
        toolHook
          ? !attachment.hookName.startsWith(`${attachment.hookEvent}:`) ||
            attachment.hookName.length <= attachment.hookEvent.length + 1
          : attachment.hookName !== attachment.hookEvent
      )
        throw new Error(
          "Hook attachment requires its actual supported native event/name identity",
        );
      if (
        attachment.hookEvent === "SessionStart" &&
        attachment.toolUseID !== "SessionStart"
      )
        throw new Error(
          "SessionStart context requires its native SessionStart identity",
        );
      if (!attachment.content.length) return [];
      output = escapeReminderText(
        `${attachment.hookName} hook additional context: ${attachment.content.join("\n")}`,
      );
      break;
    }
  }
  return output ? [{ content: wrap(output) }] : [];
}

export function validateNativePersistenceEvent(
  input: unknown,
): NativePersistenceEvent {
  const value = captureNativePersistenceJson(input);
  if (isNativeObject(value) && value.type === "progress")
    return validateNativeHookProgressRow(value);
  if (
    isNativeObject(value) &&
    value.type === "system" &&
    value.subtype === "stop_hook_summary"
  )
    return validateNativeStopHookSummaryRow(value);
  const parsed = eventSchema.parse(value);
  if (parsed.type === "attachment") {
    const expected = renderNativePersistenceAttachment(parsed.attachment);
    if (expected.length) {
      if (
        parsed.renderedRole !== "system" ||
        JSON.stringify(parsed.rendered) !== JSON.stringify(expected)
      )
        throw new Error(
          "Native attachment recorded rendering disagrees with its supported payload/role",
        );
    } else if (
      parsed.rendered !== undefined ||
      parsed.renderedRole !== undefined
    )
      throw new Error(
        "An empty native attachment cannot claim recorded rendering",
      );
  }
  if (parsed.type === "user") {
    const results =
      typeof parsed.message.content === "string"
        ? []
        : parsed.message.content.filter(
            (block) => block.type === "tool_result",
          );
    if (results.length > 0 !== (parsed.sourceToolAssistantUUID !== undefined))
      throw new Error(
        "Native result events require their actual assistant source UUID",
      );
    if (
      (parsed.toolUseResult !== undefined ||
        parsed.permissionDecision !== undefined) &&
      results.length !== 1
    )
      throw new Error(
        "Raw native tool metadata requires one actual tool-result carrier",
      );
  }
  if (!hasEventIdentity(value))
    throw new TypeError("Missing validated native event identity");
  return freeze(value);
}
export function captureNativePersistenceEvents(
  inputs: readonly unknown[],
): readonly NativePersistenceEvent[] {
  return Object.freeze(inputs.map(validateNativePersistenceEvent));
}
/** The caller supplies the attachment's real creation identity; no stamp or payload fallback exists. */
export function createNativeAttachmentEvent(
  payload: unknown,
  stamp: { uuid: string; timestamp: string },
  options: { placement?: "next_to_message" } = {},
): NativePersistenceEvent {
  const attachment = attachmentSchema.parse(
      captureNativePersistenceJson(payload),
    ),
    output = renderNativePersistenceAttachment(attachment);
  return validateNativePersistenceEvent({
    type: "attachment",
    ...stamp,
    attachment,
    ...(output.length ? { rendered: output, renderedRole: "system" } : {}),
    ...options,
  });
}
