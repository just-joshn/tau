import { captureNativePersistenceJson } from "./native-persistence-events.js";
import {
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeObject,
} from "./native-session-codec.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";

export type NativePersistenceExclusion =
  "progress" | "empty-hook-success" | "laptop-memory-context" | "persist-false";
export interface NativePersistenceSelectionInput {
  rows: readonly NativeObject[];
  userType: NativePromptFact<string>;
  evalFeature: NativePromptFact<boolean>;
  sessionCodeMode: NativePromptFact<boolean>;
  /** Actual Set/callback result or actual Xpn context; never derive from the new batch when the source uses full history. */
  toolResults:
    | { kind: "actual-set"; ids: readonly string[] }
    | { kind: "derive"; context: readonly NativeObject[] };
}
export interface NativePersistenceSelectionHost {
  /** Actual mM/Nne carrier: known undefined means this owned row has no original-row sidecar. */
  original(
    row: NativeObject,
    index: number,
  ): NativePromptFact<NativeObject | undefined>;
  /** Actual _4r result after any source-owned incomplete-thinking classification. */
  incompleteThinkingRanges?(
    rows: readonly NativeObject[],
  ): NativePromptFact<readonly { fromIdx: number; toIdx: number }[]>;
}
export interface NativePersistenceSelectionDecision {
  inputIndex: number;
  uuid: NativeJson | undefined;
  disposition:
    "kept" | NativePersistenceExclusion | "empty-assistant" | "empty-user";
  originalRowRestored?: true;
  unsentMediaReplaced?: true;
  removedToolCalls?: readonly string[];
  removedToolResults?: readonly string[];
  virtualFlagRemoved?: true;
}
export type NativePersistenceSelection =
  | {
      status: "selected";
      rows: readonly NativeObject[];
      decisions: readonly NativePersistenceSelectionDecision[];
    }
  | {
      status: "unsupported";
      reasons: readonly string[];
      input: NativePersistenceSelectionInput;
    };
class Unsupported extends Error {}
function known<T>(fact: NativePromptFact<T>): T {
  if (fact.status !== "known") throw new Unsupported(fact.reason);
  return fact.value;
}
function boolean(fact: NativePromptFact<boolean>): boolean {
  const value = known(fact);
  if (typeof value !== "boolean")
    throw new Unsupported("Persistence feature has no actual boolean value");
  return value;
}
function freeze<T>(input: T): T {
  captureNativePersistenceJson(input);
  const copy = structuredClone(input);
  const queue: object[] =
    copy !== null && typeof copy === "object" ? [copy] : [];
  for (const item of queue) {
    const children: unknown[] = Object.values(item);
    for (const child of children)
      if (child !== null && typeof child === "object") queue.push(child);
    Object.freeze(item);
  }
  return copy;
}
function object(value: NativeJson | undefined, name: string): NativeObject {
  if (!isNativeObject(value))
    throw new Unsupported(`Missing actual native ${name} object`);
  return value;
}
function maybeString(value: NativeJson | undefined): string | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== "string")
    throw new Unsupported("Malformed native hook-success stdout/stderr");
  return value;
}
/** Complete pinned OE predicate. A native-empty model projection is not itself a persistence exclusion. */
export function classifyNativePersistenceRow(
  row: NativeObject,
): { keep: true } | { keep: false; reason: NativePersistenceExclusion } {
  row = freeze(row);
  if (row.type === "progress") return { keep: false, reason: "progress" };
  if (row.type === "attachment") {
    const attachment = object(row.attachment, "attachment");
    if (
      attachment.type === "hook_success" &&
      !attachment.content &&
      !maybeString(attachment.stdout)?.trim() &&
      !maybeString(attachment.stderr)?.trim()
    )
      return { keep: false, reason: "empty-hook-success" };
    // uir is literally new Set([]) in retained326; no user-type gate can add a type.
    if (
      (attachment.type === "cowork_memory_context" ||
        attachment.type === "account_memory_recall") &&
      attachment.leg === "laptop" &&
      attachment.content !== null
    )
      return { keep: false, reason: "laptop-memory-context" };
  }
  if (row.persist === false) return { keep: false, reason: "persist-false" };
  return { keep: true };
}
const unsentMediaText =
  "[media removed: request limit. If you have seen this, what you concluded from it still stands. Re-reading pushes out others and re-sends everything, so don't re-read them all.]";
function unsent(value: NativeJson): boolean {
  return (
    isNativeObject(value) &&
    isNativeObject(value.source) &&
    value.source.type === "base64" &&
    typeof value.source.data === "string" &&
    value.source.data.startsWith("unsent:")
  );
}
function media(row: NativeObject): { row: NativeObject; changed: boolean } {
  if (row.type !== "user") return { row, changed: false };
  const message = object(row.message, "user message");
  if (!isNativeArray(message.content)) return { row, changed: false };
  let changed = false;
  const content = message.content.map((block) => {
    if (
      !isNativeObject(block) ||
      block.type !== "tool_result" ||
      !isNativeArray(block.content) ||
      !block.content.some(unsent)
    )
      return block;
    changed = true;
    return {
      ...block,
      content: block.content.map((part) =>
        unsent(part) ? { type: "text", text: unsentMediaText } : part,
      ),
    };
  });
  return changed
    ? { row: { ...row, message: { ...message, content } }, changed }
    : { row, changed };
}
function nativeBlocks(row: NativeObject): readonly NativeJson[] | undefined {
  if (row.type !== "assistant" && row.type !== "user") return;
  const message = object(row.message, `${row.type} message`);
  return isNativeArray(message.content) ? message.content : undefined;
}
function removeVirtual(row: NativeObject): NativeObject {
  const result: Record<string, NativeJson> = {};
  for (const [key, value] of Object.entries(row))
    if (key !== "isVirtual") result[key] = value;
  return result;
}
/** Full OE→mM→m9t→ordinary fir pipeline, with explicit actual sidecar/range/feature owners. */
export function selectNativePersistenceRows(
  input: NativePersistenceSelectionInput,
  host: NativePersistenceSelectionHost,
): NativePersistenceSelection {
  input = freeze(input);
  try {
    const decisions: NativePersistenceSelectionDecision[] = [],
      kept: {
        row: NativeObject;
        decision: NativePersistenceSelectionDecision;
      }[] = [];
    for (const [index, original] of input.rows.entries()) {
      const keep = classifyNativePersistenceRow(original),
        decision: NativePersistenceSelectionDecision = {
          inputIndex: index,
          uuid: original.uuid,
          disposition: keep.keep ? "kept" : keep.reason,
        };
      decisions.push(decision);
      if (!keep.keep) continue;
      let row = original;
      if (row.type === "user" || row.type === "attachment") {
        const fact = known(host.original(row, index));
        const previous = fact === undefined ? undefined : freeze(fact);
        if (previous !== undefined && previous.uuid === row.uuid) {
          row = previous;
          decision.originalRowRestored = true;
        }
      }
      const cleaned = media(row);
      if (cleaned.changed) decision.unsentMediaReplaced = true;
      kept.push({ row: cleaned.row, decision });
    }
    const userType = known(input.userType);
    if (typeof userType !== "string")
      throw new Unsupported("Missing actual persistence user type");
    if (
      userType === "ant" ||
      (boolean(input.evalFeature) && boolean(input.sessionCodeMode))
    )
      return freeze({
        status: "selected",
        rows: kept.map((entry) => entry.row),
        decisions,
      });
    const special = (name: NativeJson | undefined) =>
      name === "REPL" || (name === "Eval" && boolean(input.evalFeature));
    const ids = new Set<string>();
    if (input.toolResults.kind === "actual-set")
      for (const id of input.toolResults.ids) {
        if (typeof id !== "string")
          throw new Unsupported(
            "Actual excluded tool-result IDs are not strings",
          );
        ids.add(id);
      }
    else
      for (const row of input.toolResults.context) {
        if (row.type !== "assistant" || row.madeBy === "input") continue;
        for (const block of nativeBlocks(row) ?? [])
          if (
            isNativeObject(block) &&
            block.type === "tool_use" &&
            special(block.name)
          ) {
            if (typeof block.id !== "string")
              throw new Unsupported(
                "Actual excluded native call has no string ID",
              );
            ids.add(block.id);
          }
      }
    const retainedIncomplete = new Set<number>();
    if (
      kept.some(
        ({ row }) =>
          row.type === "assistant" &&
          row.resumedFromIncompleteThinking === true,
      )
    ) {
      if (!host.incompleteThinkingRanges)
        throw new Unsupported(
          "Incomplete-thinking virtual preservation requires actual _4r ranges",
        );
      const ranges = known(
        host.incompleteThinkingRanges(freeze(kept.map(({ row }) => row))),
      );
      for (const range of ranges) {
        if (
          !Number.isSafeInteger(range.fromIdx) ||
          !Number.isSafeInteger(range.toIdx) ||
          range.fromIdx < 0 ||
          range.toIdx < range.fromIdx ||
          range.toIdx >= kept.length
        )
          throw new Unsupported("Actual incomplete-thinking range is invalid");
        for (let index = range.fromIdx; index <= range.toIdx; index++)
          retainedIncomplete.add(index);
      }
    }
    const output: NativeObject[] = [];
    for (const [index, entry] of kept.entries()) {
      let row = entry.row;
      const blocks = nativeBlocks(row),
        decision = entry.decision;
      if (row.type === "assistant" && blocks) {
        const removed = blocks.filter(
          (block) =>
            row.madeBy !== "input" &&
            isNativeObject(block) &&
            block.type === "tool_use" &&
            special(block.name),
        );
        const next = removed.length
          ? blocks.filter((block) => !removed.includes(block))
          : blocks;
        if (removed.length)
          decision.removedToolCalls = removed.flatMap((block) =>
            isNativeObject(block) && typeof block.id === "string"
              ? [block.id]
              : [],
          );
        if (!next.length) {
          decision.disposition = "empty-assistant";
          continue;
        }
        if (
          row.isVirtual &&
          !retainedIncomplete.has(index) &&
          row.virtualInResumeRun !== true
        ) {
          row = removeVirtual(row);
          decision.virtualFlagRemoved = true;
        }
        if (next !== blocks) {
          const message = object(row.message, "assistant message");
          row = { ...row, message: { ...message, content: next } };
        }
      } else if (row.type === "user" && blocks) {
        const removed = blocks.filter(
          (block) =>
            isNativeObject(block) &&
            block.type === "tool_result" &&
            typeof block.tool_use_id === "string" &&
            ids.has(block.tool_use_id),
        );
        const next = removed.length
          ? blocks.filter((block) => !removed.includes(block))
          : blocks;
        if (removed.length)
          decision.removedToolResults = removed.flatMap((block) =>
            isNativeObject(block) && typeof block.tool_use_id === "string"
              ? [block.tool_use_id]
              : [],
          );
        if (!next.length) {
          decision.disposition = "empty-user";
          continue;
        }
        if (
          row.isVirtual &&
          !(row.isMeta === true && row.isVirtual === true) &&
          !retainedIncomplete.has(index) &&
          row.virtualInResumeRun !== true
        ) {
          row = removeVirtual(row);
          decision.virtualFlagRemoved = true;
        }
        if (next !== blocks) {
          const message = object(row.message, "user message");
          row = { ...row, message: { ...message, content: next } };
        }
      } else if (
        "isVirtual" in row &&
        row.isVirtual &&
        !(
          row.type === "user" &&
          row.isMeta === true &&
          row.isVirtual === true
        ) &&
        !retainedIncomplete.has(index) &&
        row.virtualInResumeRun !== true
      ) {
        row = removeVirtual(row);
        decision.virtualFlagRemoved = true;
      }
      output.push(row);
    }
    return freeze({ status: "selected", rows: output, decisions });
  } catch (error) {
    return freeze({
      status: "unsupported",
      reasons: [
        error instanceof Error
          ? error.message
          : "Unknown actual persistence selection fact",
      ],
      input,
    });
  }
}
