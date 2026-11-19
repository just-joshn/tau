import type { InstructionFile } from "./instructions.js";
import type { Message, ToolResult, ToolUse } from "./types.js";
import {
  createNativeAttachmentEvent,
  renderNativePersistenceAttachment,
  type NativePersistenceAttachment,
  type NativePersistenceEvent,
} from "./native-persistence-events.js";

export type NativeInstructionAttachment = Extract<
  NativePersistenceAttachment,
  { type: "instructions" }
>;
export type NativeInstructionPayloadFile =
  NativeInstructionAttachment["files"][number];
export type NativeInstructionReason = NonNullable<
  NativeInstructionAttachment["reason"]
>;
export interface NativeInstructionFileFacts {
  path: string;
  canonicalPath: string;
  kind: InstructionFile["kind"];
  /** Actual admitted complete semantic body, before independent notice rendering. */
  admittedContent: string;
  projectedBody: string;
  /** Observed port clipping decision; not a fabricated native startOnly/cutForRoom value. */
  clipped: boolean;
  contentDiffersFromDisk: boolean;
  rawDiskText?: string;
  parent?: string;
  globs?: readonly string[];
  isRule?: boolean;
  /** Actual port baseline candidate, not a claim that a Read-state seed succeeded. */
  readBaselineCandidate: {
    canonicalPath: string;
    text: string;
    partial: boolean;
  };
}
export type NativeInstructionDelivery =
  | { kind: "eager"; message: Message }
  | {
      kind: "nested";
      call: ToolUse;
      result: ToolResult;
      effectivePath: string;
    };
export interface NativeInstructionCaptureFacts {
  phase: "eager" | "nested";
  files: readonly NativeInstructionFileFacts[];
}
export type NativeInstructionCaptureResult =
  | {
      status: "captured";
      facts: NativeInstructionCaptureFacts;
      event: NativePersistenceEvent;
      attachment: NativeInstructionAttachment;
      currentFiles: readonly NativeInstructionPayloadFile[];
    }
  | { status: "unchanged"; facts: NativeInstructionCaptureFacts }
  | {
      status: "unsupported";
      facts: NativeInstructionCaptureFacts;
      reasons: readonly string[];
    };
export interface NativeInstructionCaptureHost {
  /** Actual owning native attachment history, including accepted journal events; never a hash reconstruction. */
  state():
    | {
        status: "known";
        previous: readonly NativeInstructionPayloadFile[] | undefined;
        reason: NativeInstructionReason | undefined;
      }
    | { status: "unsupported"; reason: string };
  /** InstructionFile intentionally has no native unverified field. Its absence is not trust evidence. */
  trust(
    file: Readonly<NativeInstructionFileFacts>,
  ):
    | { status: "verified"; nativeProjection: "unclipped" }
    | { status: "unsupported"; reason: string };
  /** Called only when a supported source attachment actually changes; identity belongs to this owner. */
  stamp(
    input: Readonly<{
      attachment: NativeInstructionAttachment;
      facts: NativeInstructionCaptureFacts;
    }>,
  ): { uuid: string; timestamp: string };
  capture(
    result: NativeInstructionCaptureResult,
    delivery: NativeInstructionDelivery,
  ): void | Promise<void>;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** Select known admitted fields explicitly; no host callback can mutate the source file through these facts. */
export function nativeInstructionFileFacts(
  file: InstructionFile,
  projection: { body: string; clipped: boolean; partial: boolean },
): NativeInstructionFileFacts {
  return frozen({
    path: file.path,
    canonicalPath: file.canonicalPath,
    kind: file.kind,
    admittedContent: file.content,
    projectedBody: projection.body,
    clipped: projection.clipped,
    contentDiffersFromDisk: file.contentDiffersFromDisk,
    ...(file.rawContent === undefined ? {} : { rawDiskText: file.rawContent }),
    ...(file.parent === undefined ? {} : { parent: file.parent }),
    ...(file.globs === undefined ? {} : { globs: [...file.globs] }),
    ...(file.isRule === undefined ? {} : { isRule: file.isRule }),
    readBaselineCandidate: {
      canonicalPath: file.canonicalPath,
      text: file.rawContent ?? file.content,
      partial: projection.partial,
    },
  });
}

/** Source Lea/Nea/Jt pipeline for the host's known ordinary trusted and unclipped eager state. */
export async function captureNativeInstructions(
  host: NativeInstructionCaptureHost,
  input: NativeInstructionCaptureFacts,
  delivery: NativeInstructionDelivery,
): Promise<void> {
  // Facts arrive detached from actual file objects; clone once more to isolate callback-owned arrays.
  const facts = frozen(structuredClone(input));
  if (facts.phase === "nested") {
    await host.capture(
      frozen({
        status: "unsupported",
        facts,
        reasons: [
          "Nested instruction activation requires its source nested_memory clipping/trust/cache adapter; no port notice is serialized as native content",
        ],
      }),
      delivery,
    );
    return;
  }
  const state = host.state();
  if (state.status !== "known") {
    await host.capture(
      frozen({ status: "unsupported", facts, reasons: [state.reason] }),
      delivery,
    );
    return;
  }
  const reason = state.reason;
  const previous =
    state.previous === undefined
      ? undefined
      : frozen(structuredClone(state.previous));
  const reasons: string[] = [],
    currentFiles: NativeInstructionPayloadFile[] = [];
  const seen = new Set<string>();
  for (const file of facts.files) {
    if (seen.has(file.path)) {
      reasons.push(`Duplicate native instruction path: ${file.path}`);
      continue;
    }
    seen.add(file.path);
    if (file.clipped || file.projectedBody !== file.admittedContent.trim()) {
      reasons.push(
        `Instruction projection requires its native clipping adapter: ${file.path}`,
      );
      continue;
    }
    const trust = host.trust(file);
    if (trust.status !== "verified") {
      reasons.push(trust.reason);
      continue;
    }
    if (trust.nativeProjection !== "unclipped") {
      reasons.push(
        `Instruction projection has no known native unclipped admission: ${file.path}`,
      );
      continue;
    }
    currentFiles.push({
      path: file.path,
      type: file.kind,
      content: file.admittedContent.trim(),
    });
  }
  if (reasons.length) {
    await host.capture(
      frozen({ status: "unsupported", facts, reasons }),
      delivery,
    );
    return;
  }
  // Snapshot caller-owned prior bodies before any identity/capture callback can mutate its journal.
  const prior =
    previous === undefined
      ? undefined
      : new Map(previous.map((file) => [file.path, file]));
  const changed = currentFiles.filter((file) => {
    const earlier = prior?.get(file.path);
    return (
      !earlier ||
      earlier.content !== file.content ||
      earlier.type !== file.type ||
      earlier.unverified !== file.unverified
    );
  });
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const removed =
    prior === undefined
      ? []
      : [...prior.keys()].filter((path) => !currentPaths.has(path));
  if (
    (prior === undefined && !currentFiles.length) ||
    (prior !== undefined && !changed.length && !removed.length)
  ) {
    await host.capture(frozen({ status: "unchanged", facts }), delivery);
    return;
  }
  const attachment: NativeInstructionAttachment = frozen({
    type: "instructions",
    files: prior === undefined ? currentFiles : changed,
    ...(prior === undefined ? {} : { changed: true }),
    ...(removed.length ? { removed } : {}),
    ...(prior !== undefined && reason !== undefined ? { reason } : {}),
  });
  try {
    renderNativePersistenceAttachment(attachment);
  } catch {
    await host.capture(
      frozen({
        status: "unsupported",
        facts,
        reasons: [
          "Instruction payload requires its supported native reason/trust/rendering adapter",
        ],
      }),
      delivery,
    );
    return;
  }
  const stamp = host.stamp(frozen({ attachment, facts }));
  const event = createNativeAttachmentEvent(attachment, stamp);
  await host.capture(
    frozen({ status: "captured", facts, event, attachment, currentFiles }),
    delivery,
  );
}
