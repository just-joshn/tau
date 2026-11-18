import type {
  NativeLifecycleEnd,
  NativeLifecyclePreparedCapture,
  NativeLifecycleStartupCreation,
} from "./native-lifecycle-hooks.js";
import { validateNativeHookProgressRow } from "./native-hook-progress.js";
import { validateNativePersistenceEvent } from "./native-persistence-events.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";
import type { NativeObject } from "./native-session-codec.js";
import {
  selectNativeStartupRows,
  type NativeStartupSelectionHost,
} from "./native-startup-selection.js";

export interface NativeStartupFinalizationInput {
  readonly creations: readonly NativeLifecycleStartupCreation[];
  readonly end: NativeLifecycleEnd;
}
export type NativeStartupHistoryResolution =
  | {
      readonly status: "ready";
      readonly source: "fresh-initial" | "actual-LBe";
      readonly rows: readonly NativeObject[];
    }
  | { readonly status: "pending" }
  | {
      readonly status: "unsupported";
      readonly reasons: readonly string[];
      readonly facts: NativeObject;
    };
export interface NativeStartupFinalizerOptions {
  /** Read the actual retained history at finalization, after the hook promise, as wun does. */
  readHistory(
    input: NativeStartupFinalizationInput,
  ): NativeStartupHistoryResolution | Promise<NativeStartupHistoryResolution>;
  rendering?: NativeStartupSelectionHost;
  /** A reached pending branch requires a real owner for the entire created vector. */
  pending?(input: NativeStartupFinalizationInput): void | Promise<void>;
}
function immutable<T>(input: T): T {
  snapshotNativeResponseJson(input);
  const saved = structuredClone(input),
    queue: object[] =
      saved !== null && typeof saved === "object" ? [saved] : [];
  for (const value of queue) {
    const children: unknown[] = Object.values(value);
    for (const child of children)
      if (child !== null && typeof child === "object") queue.push(child);
    Object.freeze(value);
  }
  return saved;
}
const rowOf = (value: NativeLifecycleStartupCreation): NativeObject =>
  value.kind === "progress" ? value.row : value.creation.event;

/** Full-vector LBe/Aue selection only; actual runtime publication follows this callback. */
export function createNativeStartupFinalizer(
  options: NativeStartupFinalizerOptions,
): NonNullable<NativeLifecyclePreparedCapture["startup"]> {
  const read = options.readHistory.bind(options),
    pending = options.pending?.bind(options);
  const rendering =
    options.rendering === undefined
      ? undefined
      : Object.freeze({
          render: options.rendering.render.bind(options.rendering),
        });
  return {
    async finalize(input) {
      const captured = immutable(input);
      const unsupported = (reason: string, facts: NativeObject = {}) =>
        immutable({ status: "unsupported" as const, reasons: [reason], facts });
      const resolution = immutable(await read(captured));
      if (resolution.status === "unsupported") return resolution;
      if (resolution.status === "pending") {
        if (!pending)
          return unsupported(
            "Pending startup vector has no actual late retention owner",
          );
        await pending(captured);
        return Object.freeze({ status: "pending" as const });
      }
      if (
        resolution.source !== "fresh-initial" &&
        resolution.source !== "actual-LBe"
      )
        return unsupported(
          "Startup requires its actual fresh/LBe owner; overdue creation is a separate source adapter",
        );
      const created = captured.creations.map(rowOf),
        originals = new Map<string, NativeLifecycleStartupCreation>();
      for (const entry of captured.creations) {
        const row = rowOf(entry);
        if (
          typeof row.uuid !== "string" ||
          typeof row.timestamp !== "string" ||
          originals.has(row.uuid)
        )
          return unsupported(
            "Startup finalization lacks unique actual creation identities",
          );
        originals.set(row.uuid, entry);
      }
      const selected = selectNativeStartupRows(
        { existing: resolution.rows, created },
        rendering,
      );
      if (selected.status === "unsupported")
        return unsupported(selected.reason, {
          existing: [...selected.existing],
          created: [...selected.created],
        });
      if (
        resolution.source === "fresh-initial" &&
        selected.existingSignatureCount !== 0
      )
        return unsupported(
          "Fresh initial owner conflicts with retained SessionStart signatures",
        );
      const creations: NativeLifecycleStartupCreation[] = [];
      for (const row of selected.rows) {
        if (typeof row.uuid !== "string")
          return unsupported(
            "Selected startup row lost its actual creation identity",
          );
        const original = originals.get(row.uuid);
        if (!original || row.timestamp !== rowOf(original).timestamp)
          return unsupported(
            "Selected startup row changed its actual creation ownership",
          );
        if (original.kind === "progress")
          creations.push({
            kind: "progress",
            row: validateNativeHookProgressRow(row),
          });
        else {
          const event = validateNativePersistenceEvent(row);
          if (event.type !== original.creation.event.type)
            return unsupported(
              "Startup selection changed its actual source row category",
            );
          creations.push({
            kind: "attachment",
            creation: { ...original.creation, event },
          });
        }
      }
      return immutable({
        status: "retained" as const,
        source: resolution.source,
        creations,
      });
    },
  };
}
