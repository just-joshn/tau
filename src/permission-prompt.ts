import { z } from "zod";
import { parseMcpCallResult } from "./mcp-content.js";
import type { ExternalToolRegistry } from "./tool-router.js";
import type { ToolUse } from "./types.js";

const destinations = z.enum(["userSettings", "projectSettings", "localSettings", "session", "cliArg"]);
const rule = z.object({ toolName: z.string(), ruleContent: z.string().optional() });
const behavior = z.enum(["allow", "deny", "ask"]);
const mode = z.preprocess(value => value === "manual" ? "default" : value,
  z.enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]));
const permissionUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("addRules"), rules: z.array(rule), behavior, destination: destinations }),
  z.object({ type: z.literal("replaceRules"), rules: z.array(rule), behavior, destination: destinations }),
  z.object({ type: z.literal("removeRules"), rules: z.array(rule), behavior, destination: destinations }),
  z.object({ type: z.literal("setMode"), mode, destination: destinations }),
  z.object({ type: z.literal("addDirectories"), directories: z.array(z.string()), destination: destinations }),
  z.object({ type: z.literal("removeDirectories"), directories: z.array(z.string()), destination: destinations }),
]);
export type PermissionPromptUpdate = z.infer<typeof permissionUpdateSchema>;
export const PERMISSION_UPDATE_ITEM_LIMIT = 4096;
const classification = z.enum(["user_temporary", "user_permanent", "user_reject"]).optional().catch(undefined);
// Native object schemas strip unknown fields; decisions and known field types do not coerce.
const replySchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("allow"), updatedInput: z.record(z.string(), z.unknown()).optional(),
    updatedPermissions: z.unknown().optional(), toolUseID: z.string().optional(), decisionClassification: classification }),
  z.object({ behavior: z.literal("deny"), message: z.string(), interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(), decisionClassification: classification }),
]);
export interface PermissionPromptReply {
  approved: boolean; updatedInput?: Record<string, unknown>; reason?: string; interrupt?: boolean;
  updatedPermissions?: PermissionPromptUpdate[]; toolUseID?: string;
  decisionClassification?: "user_temporary" | "user_permanent" | "user_reject";
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Launcher policy: malformed/over-budget update metadata is ignored, not a new decision. */
export function parsePermissionPromptUpdates(value: unknown, diagnostic?: (message: string) => void): PermissionPromptUpdate[] | undefined {
  if (value === undefined) return;
  let remaining = PERMISSION_UPDATE_ITEM_LIMIT;
  if (Array.isArray(value)) for (const update of value) {
    if (remaining-- === 0) { diagnostic?.("Permission prompt updatedPermissions exceeds 4096 updates, rules and directories; updates were ignored"); return; }
    if (!object(update)) continue;
    const entries = ["addRules", "replaceRules", "removeRules"].includes(String(update.type)) ? update.rules :
      ["addDirectories", "removeDirectories"].includes(String(update.type)) ? update.directories : undefined;
    if (Array.isArray(entries)) {
      if (entries.length > remaining) { diagnostic?.("Permission prompt updatedPermissions exceeds 4096 updates, rules and directories; updates were ignored"); return; }
      remaining -= entries.length;
    }
  }
  const parsed = z.array(permissionUpdateSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  diagnostic?.("Malformed permission prompt updatedPermissions was ignored");
  return;
}

/** File-backed native plan fields are minted by the CLI, not retained by an empty answer. */
export function permissionPromptAllowedInput(call: ToolUse, updatedInput?: Record<string, unknown>, options: { disklessPlan?: boolean } = {}): Record<string, unknown> {
  if (updatedInput && Object.keys(updatedInput).length > 0) return structuredClone(updatedInput);
  if (!object(call.input)) throw new Error("Permission prompt input must be an object");
  const original = structuredClone(call.input);
  if (call.name === "ExitPlanMode" && (!options.disklessPlan || Object.hasOwn(original, "planFilePath"))) {
    delete original.plan; delete original.planFilePath;
  }
  return original;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Direct registered MCP call: never routes through model tools, hooks, refresh or activation. */
export function createMcpPermissionPrompt(options: {
  toolName: string; registry: ExternalToolRegistry;
  onDiagnostic?(message: string): void;
  /** Host owns provider/provenance/connection-floor checks absent from basic MCP metadata. */
  eligible?(metadata: NonNullable<ReturnType<ExternalToolRegistry["lookup"]>>): boolean;
  admitRequest?(call: ToolUse, signal: AbortSignal): boolean | string | Promise<boolean | string>;
  /** Source launcher default is local/file-backed; diskless hosts provide their explicit normalization. */
  normalizeAllowedInput?(call: ToolUse, updatedInput?: Record<string, unknown>): Record<string, unknown>;
  /** Valid metadata is preserved by default. Only this explicit host callback may apply it. */
  applyUpdatedPermissions?(updates: readonly PermissionPromptUpdate[], context: { call: ToolUse; approvedInput: Record<string, unknown>; signal: AbortSignal }): void | Promise<void>;
}) {
  const ready = () => {
    if (!/^mcp__[^\s]+__[^\s]+$/.test(options.toolName)) return false;
    try {
      const metadata = options.registry.lookup(options.toolName);
      return metadata !== undefined && options.eligible?.(metadata) !== false;
    } catch { return false; }
  };
  return {
    get ready() { return ready(); },
    isReady: ready,
    async request(call: ToolUse, signal: AbortSignal): Promise<PermissionPromptReply> {
      signal.throwIfAborted();
      if (!ready()) return { approved: false, reason: "The configured MCP permission prompt tool is not available" };
      if (!object(call.input) || typeof call.name !== "string" || !call.name || typeof call.id !== "string" || !call.id) return { approved: false, reason: "The permission request requires a tool name, id and object input" };
      try {
        const effectiveCall = { ...call, input: structuredClone(call.input) };
        const admission = options.admitRequest ? await abortable(Promise.resolve(options.admitRequest(effectiveCall, signal)), signal) : true;
        signal.throwIfAborted();
        if (admission !== true) return { approved: false, reason: typeof admission === "string" ? admission : "This permission request is not eligible for the configured MCP prompt tool" };
        if (!ready()) return { approved: false, reason: "The configured MCP permission prompt tool is no longer available" };
        const result = await abortable(options.registry.callTool(options.toolName, {
          tool_name: call.name, input: structuredClone(call.input), tool_use_id: call.id,
        }, signal), signal);
        signal.throwIfAborted();
        const raw = parseMcpCallResult(result.raw);
        if (raw.isError === true || result.projection.isError === true) return { approved: false, reason: "The MCP permission prompt tool returned an error" };
        const first = raw.content[0];
        if (!first || first.type !== "text" || typeof first.text !== "string") return { approved: false, reason: "The permission prompt tool must return JSON in its first text content block" };
        let decoded: unknown;
        try { decoded = JSON.parse(first.text.startsWith("\uFEFF") ? first.text.slice(1) : first.text); }
        catch { return { approved: false, reason: "The permission prompt tool returned invalid JSON" }; }
        const parsed = replySchema.safeParse(decoded);
        if (!parsed.success) return { approved: false, reason: "The permission prompt tool returned an invalid permission decision" };
        const reply = parsed.data;
        const metadata = { ...(reply.toolUseID === undefined ? {} : { toolUseID: reply.toolUseID }),
          ...(reply.decisionClassification === undefined ? {} : { decisionClassification: reply.decisionClassification }) };
        if (reply.behavior === "deny") return { approved: false, reason: reply.message,
          ...(reply.interrupt === undefined ? {} : { interrupt: reply.interrupt }), ...metadata };
        if (call.name.startsWith("mcp__") && options.registry.lookup(call.name)?.requiresUserInteraction === true) return {
          approved: false, reason: "MCP tools requiring user interaction cannot be approved through the permission prompt tool", ...metadata,
        };
        const updates = parsePermissionPromptUpdates(reply.updatedPermissions, options.onDiagnostic);
        const updatedInput = options.normalizeAllowedInput ? options.normalizeAllowedInput(effectiveCall, reply.updatedInput) : permissionPromptAllowedInput(effectiveCall, reply.updatedInput);
        if (!object(updatedInput)) return { approved: false, reason: "The permission input normalizer returned invalid input" };
        if (updates?.length) {
          if (options.applyUpdatedPermissions) await options.applyUpdatedPermissions(updates, { call: effectiveCall, approvedInput: updatedInput, signal });
          else options.onDiagnostic?.("Permission prompt returned valid permission updates; this host has not applied them");
        }
        signal.throwIfAborted();
        return { approved: true, updatedInput, ...(updates === undefined ? {} : { updatedPermissions: updates }), ...metadata };
      } catch (error) {
        signal.throwIfAborted();
        options.onDiagnostic?.(`MCP permission prompt failed: ${error instanceof Error ? error.message : "request failed"}`);
        return { approved: false, reason: "The MCP permission prompt request failed" };
      }
    },
  };
}
