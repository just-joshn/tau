import { snapshotNativeResponseJson } from "./native-response-recording.js";
import {
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeObject,
} from "./native-session-codec.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";

export interface NativeStartupRendering extends NativeObject {
  readonly rendered?: NativeJson;
  readonly renderedInHumanTurn?: NativeJson;
  readonly renderedWithdrawn?: NativeJson;
  readonly renderedRole?: "user" | "system";
  readonly renderedBesideToolResult?: boolean;
}
export interface NativeStartupSelectionHost {
  /** Actual amn result at Aue's transformation seam, including native caught-error behavior. */
  render(
    input: Readonly<{ original: NativeObject; attachment: NativeObject }>,
  ): NativePromptFact<NativeStartupRendering>;
}
export interface NativeStartupRewrite {
  readonly uuid: string;
  readonly source: "Aue";
  readonly original: NativeObject;
  readonly selected: NativeObject;
}
export type NativeStartupSelection =
  | {
      readonly status: "selected";
      readonly reason:
        | "empty-new-vector"
        | "no-existing-signatures"
        | "no-new-signature"
        | "new-signature";
      readonly rows: readonly NativeObject[];
      readonly existingSignatureCount: number;
      readonly rewrites: readonly NativeStartupRewrite[];
    }
  | {
      readonly status: "unsupported";
      readonly reason: string;
      readonly existing: readonly NativeObject[];
      readonly created: readonly NativeObject[];
    };

class UnsupportedStartupSelection extends Error {}
const renderFields = new Set([
  "rendered",
  "renderedInHumanTurn",
  "renderedWithdrawn",
  "renderedRole",
  "renderedBesideToolResult",
]);
const fail = (reason: string): never => {
  throw new UnsupportedStartupSelection(reason);
};
function objects(input: readonly NativeObject[]): readonly NativeObject[] {
  const saved = snapshotNativeResponseJson(input);
  if (!isNativeArray(saved) || !saved.every(isNativeObject))
    return fail("Startup selection requires its actual source row vectors");
  return Object.freeze([...saved]);
}
function text(value: NativeJson | undefined): string {
  return typeof value === "string"
    ? value
    : fail("SessionStart signature lacks its actual source string");
}
/** Exact yyt: no trimming, wrapper validation, path resolution or normalization of other text. */
export function normalizeNativeStartupSignature(value: string): string {
  if (!value.startsWith("<persisted-output>")) return value;
  return value.replace(/(saved to: ).*$/m, "$1<persisted>");
}
/** Exact x$n inputs; signatures share one native string Set across these three types. */
function sessionStartSignatures(row: NativeObject): readonly string[] {
  if (row.type !== "attachment") return [];
  const attachment = row.attachment;
  if (!isNativeObject(attachment))
    return fail("Startup attachment lacks its actual payload");
  if (!("hookEvent" in attachment) || attachment.hookEvent !== "SessionStart")
    return [];
  if (attachment.type === "hook_additional_context") {
    if (!isNativeArray(attachment.content))
      return fail("SessionStart context lacks its actual content vector");
    return attachment.content.map((value) =>
      normalizeNativeStartupSignature(text(value)),
    );
  }
  if (attachment.type === "hook_success") {
    const content = text(attachment.content);
    return content === "" ? [] : [normalizeNativeStartupSignature(content)];
  }
  if (attachment.type === "hook_non_blocking_error") {
    const command =
      attachment.command === undefined || attachment.command === null
        ? ""
        : text(attachment.command);
    const exit = attachment.exitCode;
    if (
      exit !== undefined &&
      exit !== null &&
      typeof exit !== "number" &&
      typeof exit !== "string" &&
      typeof exit !== "boolean"
    )
      return fail(
        "SessionStart error signature lacks its actual primitive exit code",
      );
    return [`${command}\x00${exit}\x00${text(attachment.stderr)}`];
  }
  return [];
}
export function nativeSessionStartSignatures(
  row: NativeObject,
): readonly string[] {
  const captured = snapshotNativeResponseJson(row);
  if (!isNativeObject(captured))
    return fail("Startup signatures require an actual source row");
  return sessionStartSignatures(captured);
}
function rendering(value: NativeStartupRendering): NativeStartupRendering {
  const saved = snapshotNativeResponseJson(value);
  if (
    !isNativeObject(saved) ||
    Object.keys(saved).some((key) => !renderFields.has(key))
  )
    return fail(
      "Startup amn host returned fields outside its rendering ownership",
    );
  if (
    saved.renderedRole !== undefined &&
    saved.renderedRole !== "user" &&
    saved.renderedRole !== "system"
  )
    return fail("Startup amn host returned an invalid recorded role");
  if (
    saved.renderedBesideToolResult !== undefined &&
    typeof saved.renderedBesideToolResult !== "boolean"
  )
    return fail("Startup amn host returned an invalid beside-result flag");
  for (const key of ["rendered", "renderedInHumanTurn", "renderedWithdrawn"]) {
    const blocks = saved[key];
    if (blocks === undefined) continue;
    if (
      !isNativeArray(blocks) ||
      !blocks.every(
        (block) =>
          isNativeObject(block) &&
          Object.keys(block).every((field) => field === "content") &&
          (typeof block.content === "string" ||
            (isNativeArray(block.content) &&
              block.content.every(
                (part) =>
                  isNativeObject(part) &&
                  part.type === "text" &&
                  typeof part.text === "string",
              ))),
      )
    )
      return fail("Startup amn host returned an invalid recorded text vector");
  }
  // The actual renderer owns these known fields. No default role/rendering is inferred.
  return {
    ...saved,
    ...(saved.renderedRole === "user" || saved.renderedRole === "system"
      ? { renderedRole: saved.renderedRole }
      : {}),
  };
}

/** LBe runs on the final full vector before retention, never as a post-save repair. */
export function selectNativeStartupRows(
  input: {
    existing: readonly NativeObject[];
    created: readonly NativeObject[];
  },
  host?: NativeStartupSelectionHost,
): NativeStartupSelection {
  const existing = objects(input.existing),
    created = objects(input.created);
  try {
    const selected = (
      reason: Extract<NativeStartupSelection, { status: "selected" }>["reason"],
      rows: readonly NativeObject[],
      count: number,
      rewrites: readonly NativeStartupRewrite[] = [],
    ): NativeStartupSelection =>
      Object.freeze({
        status: "selected",
        reason,
        rows: Object.freeze([...rows]),
        existingSignatureCount: count,
        rewrites: Object.freeze([...rewrites]),
      });
    if (!created.length) return selected("empty-new-vector", [], 0);
    const signatures = new Set(
      existing.flatMap((row) => sessionStartSignatures(row)),
    );
    if (!signatures.size) return selected("no-existing-signatures", created, 0);
    let changed = false;
    const rows: NativeObject[] = [],
      rewrites: NativeStartupRewrite[] = [];
    for (const row of created) {
      const keys = sessionStartSignatures(row);
      if (!keys.length || row.type !== "attachment") {
        rows.push(row);
        continue;
      }
      const attachment = row.attachment;
      if (!isNativeObject(attachment))
        return fail("Startup attachment lacks its actual payload");
      if (
        attachment.type === "hook_additional_context" &&
        isNativeArray(attachment.content) &&
        attachment.content.length > 1
      ) {
        const content = attachment.content.filter(
          (value) =>
            !signatures.has(normalizeNativeStartupSignature(text(value))),
        );
        if (!content.length) continue;
        changed = true;
        if (content.length === attachment.content.length) {
          rows.push(row);
          continue;
        }
        if (!host)
          return fail(
            "Partial startup context selection requires the actual Aue/amn renderer",
          );
        if (typeof row.uuid !== "string" || typeof row.timestamp !== "string")
          return fail(
            "Startup context transformation lacks its original creation identity",
          );
        const payload = snapshotNativeResponseJson({ ...attachment, content });
        if (!isNativeObject(payload))
          return fail("Invalid selected startup context");
        const rendered = host.render(
          Object.freeze({ original: row, attachment: payload }),
        );
        if (rendered.status !== "known") return fail(rendered.reason);
        const base = Object.fromEntries(
          Object.entries(row).filter(([key]) => !renderFields.has(key)),
        );
        const transformed = snapshotNativeResponseJson({
          ...base,
          attachment: payload,
          ...rendering(rendered.value),
        });
        if (!isNativeObject(transformed))
          return fail("Invalid actual Aue startup result");
        rows.push(transformed);
        rewrites.push(
          Object.freeze({
            uuid: row.uuid,
            source: "Aue",
            original: row,
            selected: transformed,
          }),
        );
        continue;
      }
      const first = keys[0];
      if (first !== undefined && signatures.has(first)) continue;
      changed = true;
      rows.push(row);
    }
    return changed
      ? selected("new-signature", rows, signatures.size, rewrites)
      : selected("no-new-signature", [], signatures.size);
  } catch (error) {
    if (!(error instanceof UnsupportedStartupSelection)) throw error;
    return Object.freeze({
      status: "unsupported",
      reason: error.message,
      existing,
      created,
    });
  }
}
