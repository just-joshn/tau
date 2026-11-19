import { z } from "zod";
import { snapshotNativeResponseJson } from "./native-response-recording.js";
import {
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeObject,
} from "./native-session-codec.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";

/** Source Yc registry; payload admission is separate from an implemented runtime adapter. */
export const NATIVE_HOOK_PROGRESS_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay",
] as const;
export type NativeHookProgressEvent =
  (typeof NATIVE_HOOK_PROGRESS_EVENTS)[number];
export interface NativeHookProgressData extends NativeObject {
  readonly type: "hook_progress";
  readonly hookEvent: NativeHookProgressEvent;
  readonly hookName: string;
  readonly command: string;
  readonly promptText?: string;
  readonly statusMessage?: string;
}
export interface NativeHookProgressRow extends NativeObject {
  readonly type: "progress";
  readonly data: NativeHookProgressData;
  readonly parentToolUseID: string;
  readonly toolUseID: string;
  readonly timestamp: string;
  readonly uuid: string;
}
export interface NativeStopHookInfo extends NativeObject {
  readonly command: string;
  readonly promptText?: string;
  readonly durationMs?: number;
}
export interface NativeStopHookSummaryAccumulators extends NativeObject {
  readonly hookCount: number;
  readonly hookInfos: readonly NativeStopHookInfo[];
  readonly hookErrors: readonly string[];
  readonly hookAdditionalContext?: readonly string[];
  readonly preventedContinuation: boolean;
  readonly stopReason?: string;
  readonly hasOutput: boolean;
  readonly level: string;
  readonly toolUseID?: string;
  readonly hookLabel?: string;
  readonly totalDurationMs?: number;
}
export interface NativeStopHookSummaryRow extends NativeStopHookSummaryAccumulators {
  readonly type: "system";
  readonly subtype: "stop_hook_summary";
  readonly timestamp: string;
  readonly uuid: string;
}
export interface NativeHookProgressIdentity {
  uuid: string;
  timestamp: string;
}
export class NativeHookProgressValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NativeHookProgressValidationError";
  }
}
export class NativeHookProgressCaptureError extends Error {
  constructor(cause: unknown) {
    super("Native hook progress creation owner failed", { cause });
    this.name = "NativeHookProgressCaptureError";
  }
}
const nonempty = z.string().min(1);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const identity = {
  uuid,
  timestamp: nonempty.refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Invalid actual native timestamp",
  ),
};
const dataSchema = z.strictObject({
  type: z.literal("hook_progress"),
  hookEvent: z.enum(NATIVE_HOOK_PROGRESS_EVENTS),
  hookName: nonempty,
  command: z.string(),
  promptText: z.string().optional(),
  statusMessage: z.string().optional(),
});
const progressSchema = z
  .strictObject({
    type: z.literal("progress"),
    data: dataSchema,
    parentToolUseID: nonempty,
    toolUseID: nonempty,
    ...identity,
  })
  .refine(
    (row) => row.parentToolUseID === row.toolUseID,
    "Progress must keep its actual dispatch correlation",
  )
  .refine(
    (row) =>
      row.data.hookName === row.data.hookEvent ||
      (row.data.hookName.startsWith(`${row.data.hookEvent}:`) &&
        row.data.hookName.length > row.data.hookEvent.length + 1),
    "Progress hookName must belong to the actual event",
  );
const infoSchema = z.strictObject({
  command: z.string(),
  promptText: z.string().optional(),
  durationMs: z.number().finite().optional(),
});
const accumulatorShape = {
  hookCount: z.number().int().nonnegative(),
  hookInfos: z.array(infoSchema),
  hookErrors: z.array(z.string()),
  hookAdditionalContext: z.array(z.string()).optional(),
  preventedContinuation: z.boolean(),
  stopReason: z.string().optional(),
  hasOutput: z.boolean(),
  level: nonempty,
  toolUseID: nonempty.optional(),
  hookLabel: z.string().optional(),
  totalDurationMs: z.number().finite().optional(),
};
const accumulatorSchema = z.strictObject(accumulatorShape);
const summarySchema = z.strictObject({
  type: z.literal("system"),
  subtype: z.literal("stop_hook_summary"),
  ...accumulatorShape,
  ...identity,
});
function isAccumulators(
  value: NativeJson,
): value is NativeStopHookSummaryAccumulators {
  return accumulatorSchema.safeParse(value).success;
}
function actualIdentity(input: unknown): NativeHookProgressIdentity {
  const value = snapshot(input);
  if (
    !isNativeObject(value) ||
    !z.strictObject(identity).safeParse(value).success ||
    typeof value.uuid !== "string" ||
    typeof value.timestamp !== "string"
  )
    throw new NativeHookProgressValidationError(
      "Actual creation stamp must contain only UUID and timestamp",
    );
  return Object.freeze({ uuid: value.uuid, timestamp: value.timestamp });
}
function isProgress(value: NativeJson): value is NativeHookProgressRow {
  return progressSchema.safeParse(value).success;
}
function isSummary(value: NativeJson): value is NativeStopHookSummaryRow {
  return summarySchema.safeParse(value).success;
}
function snapshot(value: unknown): NativeJson {
  try {
    return snapshotNativeResponseJson(value);
  } catch (error) {
    throw new NativeHookProgressValidationError(
      "Native hook progress requires finite descriptor-only JSON",
      error,
    );
  }
}
export function validateNativeHookProgressRow(
  input: unknown,
): NativeHookProgressRow {
  const value = snapshot(input);
  if (!isProgress(value))
    throw new NativeHookProgressValidationError(
      "Invalid actual raw hook progress DTO",
    );
  return value;
}
export function validateNativeStopHookSummaryRow(
  input: unknown,
): NativeStopHookSummaryRow {
  const value = snapshot(input);
  if (!isSummary(value))
    throw new NativeHookProgressValidationError(
      "Invalid actual Stop hook summary DTO",
    );
  return value;
}
export interface NativeHookProgressCandidate extends NativeObject {
  readonly id: string;
  readonly hook: NativeObject;
  readonly notTested?: NativeJson;
}
export type NativeHookProgressAdmission =
  | { readonly status: "admitted"; readonly source: "actual-final-dispatch" }
  | {
      readonly status: "skipped";
      readonly reason:
        "trust" | "call-refusal" | "no-hooks" | "initial-abort" | "source-gate";
    }
  | { readonly status: "unsupported"; readonly reasons: readonly string[] };
export interface NativeHookProgressDispatchInput {
  readonly event: NativeHookProgressEvent;
  readonly dispatchToolUseID: string;
  readonly matchQuery?: string;
  readonly admission: NativeHookProgressAdmission;
  /** Actual admitted ao vector; Ln filtering remains explicit and does not run selection. */
  readonly candidates: readonly NativeHookProgressCandidate[];
}
export interface NativeHookProgressDisplay {
  readonly command: string;
  readonly promptText?: string;
  readonly statusMessage?: string;
}
export interface NativeHookProgressHost {
  /** Actual Blo map for the full Ln vector; known [] means no aliases, not a guessed feature value. */
  aliases(
    input: Readonly<{
      event: NativeHookProgressEvent;
      hookName: string;
      candidates: readonly NativeHookProgressCandidate[];
    }>,
  ): NativePromptFact<
    readonly { readonly id: string; readonly alias: string }[]
  >;
  /** Actual o2r/Up projection, from admitted declared hook fields and the actual alias. */
  display(
    input: Readonly<{
      candidate: NativeHookProgressCandidate;
      alias: string | undefined;
      hookName: string;
      event: NativeHookProgressEvent;
    }>,
  ): NativePromptFact<NativeHookProgressDisplay>;
  stamp(
    input: Readonly<{
      kind: "progress";
      candidate: NativeHookProgressCandidate;
      data: NativeHookProgressData;
      dispatchToolUseID: string;
    }>,
  ): NativeHookProgressIdentity;
}
export type NativeHookProgressDispatchOutcome =
  | {
      readonly status: "drained";
      readonly created: number;
      readonly eligible: number;
      readonly signalAborted: boolean;
    }
  | { readonly status: "skipped"; readonly reason: string; readonly created: 0 }
  | {
      readonly status: "unsupported";
      readonly reasons: readonly string[];
      readonly created: number;
      readonly facts: NativeObject;
    };
const hookTypes = new Set([
  "command",
  "prompt",
  "agent",
  "http",
  "mcp_tool",
  "script",
  "callback",
  "function",
]);
const admissionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("admitted"),
    source: z.literal("actual-final-dispatch"),
  }),
  z.strictObject({
    status: z.literal("skipped"),
    reason: z.enum([
      "trust",
      "call-refusal",
      "no-hooks",
      "initial-abort",
      "source-gate",
    ]),
  }),
  z.strictObject({
    status: z.literal("unsupported"),
    reasons: z.array(nonempty).min(1),
  }),
]);
function dispatchSnapshot(
  input: NativeHookProgressDispatchInput,
): NativeHookProgressDispatchInput {
  const saved = snapshot(input);
  if (
    !isNativeObject(saved) ||
    Object.keys(saved).some(
      (key) =>
        ![
          "event",
          "dispatchToolUseID",
          "matchQuery",
          "admission",
          "candidates",
        ].includes(key),
    ) ||
    !NATIVE_HOOK_PROGRESS_EVENTS.some((event) => event === saved.event) ||
    typeof saved.dispatchToolUseID !== "string" ||
    !saved.dispatchToolUseID ||
    (saved.matchQuery !== undefined && typeof saved.matchQuery !== "string") ||
    !isNativeArray(saved.candidates)
  )
    throw new NativeHookProgressValidationError(
      "Missing actual final dispatch facts",
    );
  const admission = admissionSchema.safeParse(saved.admission);
  if (!admission.success)
    throw new NativeHookProgressValidationError(
      "Missing actual dispatch admission",
      admission.error,
    );
  const candidates: NativeHookProgressCandidate[] = [],
    seen = new Set<string>();
  for (const value of saved.candidates) {
    if (
      !isNativeObject(value) ||
      typeof value.id !== "string" ||
      !value.id ||
      seen.has(value.id) ||
      !isNativeObject(value.hook) ||
      typeof value.hook.type !== "string" ||
      !hookTypes.has(value.hook.type) ||
      (value.hook.internal !== undefined &&
        typeof value.hook.internal !== "boolean") ||
      (value.hook.statusMessage !== undefined &&
        value.hook.statusMessage !== null &&
        typeof value.hook.statusMessage !== "string") ||
      (value.hook.type === "prompt" && typeof value.hook.prompt !== "string")
    )
      throw new NativeHookProgressValidationError(
        "Invalid actual matched hook candidate",
      );
    seen.add(value.id);
    candidates.push({ ...value, id: value.id, hook: value.hook });
  }
  const event = NATIVE_HOOK_PROGRESS_EVENTS.find(
    (value) => value === saved.event,
  );
  if (!event)
    throw new NativeHookProgressValidationError("Unknown actual hook event");
  return Object.freeze({
    event,
    dispatchToolUseID: saved.dispatchToolUseID,
    ...(saved.matchQuery === undefined ? {} : { matchQuery: saved.matchQuery }),
    admission: Object.freeze(admission.data),
    candidates: Object.freeze(candidates.map((value) => Object.freeze(value))),
  });
}
function owned<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new NativeHookProgressCaptureError(error);
  }
}
function unsupported(
  input: NativeHookProgressDispatchInput,
  reasons: readonly string[],
  created: number,
): NativeHookProgressDispatchOutcome {
  const facts = snapshot(input);
  if (!isNativeObject(facts))
    throw new NativeHookProgressValidationError(
      "Missing actual dispatch facts",
    );
  return Object.freeze({
    status: "unsupported",
    reasons: Object.freeze([...reasons]),
    created,
    facts,
  });
}
/** Lazy EPs pre-launch prefix only. The caller alone owns actual selection, consumer next/return and execution. */
export function nativeHookProgressDispatch(
  input: NativeHookProgressDispatchInput,
  host: NativeHookProgressHost,
  signal: AbortSignal,
): AsyncGenerator<
  NativeHookProgressRow,
  NativeHookProgressDispatchOutcome | undefined,
  unknown
> {
  const captured = dispatchSnapshot(input),
    actual = Object.freeze({
      aliases: host.aliases.bind(host),
      display: host.display.bind(host),
      stamp: host.stamp.bind(host),
    });
  return (async function* () {
    let created = 0;
    const identities = new Set<string>();
    if (captured.admission.status === "unsupported")
      return unsupported(captured, captured.admission.reasons, created);
    if (captured.admission.status === "skipped")
      return Object.freeze({
        status: "skipped",
        reason: captured.admission.reason,
        created: 0,
      });
    if (signal.aborted)
      return Object.freeze({
        status: "skipped",
        reason: "initial-abort",
        created: 0,
      });
    const eligible = Object.freeze(
      captured.candidates.filter(
        (candidate) =>
          candidate.hook.type !== "callback" ||
          candidate.hook.internal !== true ||
          candidate.notTested !== undefined,
      ),
    );
    if (captured.candidates.length === 0)
      return Object.freeze({
        status: "skipped",
        reason: "no-hooks",
        created: 0,
      });
    if (eligible.length === 0)
      return Object.freeze({
        status: "drained",
        created,
        eligible: 0,
        signalAborted: signal.aborted,
      });
    const hookName = captured.matchQuery
      ? `${captured.event}:${captured.matchQuery}`
      : captured.event;
    const aliasKinds = new Set(["command", "http", "script"]);
    // Blo does not read its feature host when there are no aliasable hooks.
    const aliases: NativePromptFact<
      readonly { readonly id: string; readonly alias: string }[]
    > = eligible.some(
      (candidate) =>
        typeof candidate.hook.type === "string" &&
        aliasKinds.has(candidate.hook.type),
    )
      ? owned(() =>
          actual.aliases(
            Object.freeze({
              event: captured.event,
              hookName,
              candidates: eligible,
            }),
          ),
        )
      : { status: "known", value: [] };
    if (aliases.status === "unsupported")
      return unsupported(captured, [aliases.reason], created);
    const aliasRows = snapshot(aliases.value),
      names = new Set(
        eligible
          .filter(
            (candidate) =>
              typeof candidate.hook.type === "string" &&
              aliasKinds.has(candidate.hook.type),
          )
          .map((candidate) => candidate.id),
      ),
      aliasMap = new Map<string, string>();
    if (!isNativeArray(aliasRows))
      throw new NativeHookProgressCaptureError(
        new Error("Actual alias owner did not return its finite map"),
      );
    for (const row of aliasRows) {
      if (
        !isNativeObject(row) ||
        Object.keys(row).some((key) => key !== "id" && key !== "alias") ||
        typeof row.id !== "string" ||
        !names.has(row.id) ||
        aliasMap.has(row.id) ||
        typeof row.alias !== "string"
      )
        throw new NativeHookProgressCaptureError(
          new Error("Invalid actual native progress alias map"),
        );
      aliasMap.set(row.id, row.alias);
    }
    for (const candidate of eligible) {
      const alias = aliasMap.get(candidate.id),
        display = owned(() =>
          actual.display(
            Object.freeze({
              candidate,
              alias,
              hookName,
              event: captured.event,
            }),
          ),
        );
      if (display.status === "unsupported")
        return unsupported(captured, [display.reason], created);
      const shown = snapshot(display.value);
      if (
        !isNativeObject(shown) ||
        Object.keys(shown).some(
          (key) => !["command", "promptText", "statusMessage"].includes(key),
        ) ||
        typeof shown.command !== "string" ||
        (candidate.hook.type === "prompt") !==
          Object.hasOwn(shown, "promptText") ||
        (shown.promptText !== undefined &&
          typeof shown.promptText !== "string") ||
        (candidate.hook.statusMessage !== undefined &&
          candidate.hook.statusMessage !== null) !==
          Object.hasOwn(shown, "statusMessage") ||
        (shown.statusMessage !== undefined &&
          typeof shown.statusMessage !== "string") ||
        (alias !== undefined &&
          !candidate.hook.statusMessage &&
          shown.command !== alias)
      )
        throw new NativeHookProgressCaptureError(
          new Error(
            "Native display owner did not preserve actual o2r/Up field provenance",
          ),
        );
      const data: NativeHookProgressData = Object.freeze({
        type: "hook_progress",
        hookEvent: captured.event,
        hookName,
        command: shown.command,
        ...(typeof shown.promptText === "string"
          ? { promptText: shown.promptText }
          : {}),
        ...(typeof shown.statusMessage === "string"
          ? { statusMessage: shown.statusMessage }
          : {}),
      });
      const identity = owned(() =>
        actualIdentity(
          actual.stamp(
            Object.freeze({
              kind: "progress",
              candidate,
              data,
              dispatchToolUseID: captured.dispatchToolUseID,
            }),
          ),
        ),
      );
      if (identities.has(identity.uuid))
        throw new NativeHookProgressCaptureError(
          new Error("A native progress creation stamp was reused"),
        );
      identities.add(identity.uuid);
      const row = owned(() =>
        validateNativeHookProgressRow({
          type: "progress",
          data,
          parentToolUseID: captured.dispatchToolUseID,
          toolUseID: captured.dispatchToolUseID,
          ...identity,
        }),
      );
      created++;
      yield row;
    }
    return Object.freeze({
      status: "drained",
      created,
      eligible: eligible.length,
      signalAborted: signal.aborted,
    });
  })();
}

export type NativeHookProgressRetentionInput =
  | {
      consumer: "session-start";
      dispatchToolUseID: string;
      signalAborted: boolean;
      admission:
        | { status: "buffer" }
        | {
            status: "resolved";
            source: "fresh-initial" | "actual-LBe" | "actual-overdue-LBe";
            retainedUuids: readonly string[];
          }
        | { status: "unsupported"; reason: string };
    }
  | {
      consumer: "user-prompt-submit" | "blockable-stop" | "turn-end-reactions";
      dispatchToolUseID: string;
      signalAborted: boolean;
    };
export type NativeHookProgressRetention =
  | {
      readonly status: "resolved";
      readonly retention: "retain" | "discard" | "startup-buffer";
      readonly closeUpstream: boolean;
    }
  | { readonly status: "unsupported"; readonly reasons: readonly string[] };
const retentionSchema = z.discriminatedUnion("consumer", [
  z.strictObject({
    consumer: z.literal("session-start"),
    dispatchToolUseID: nonempty,
    signalAborted: z.boolean(),
    admission: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("buffer") }),
      z.strictObject({
        status: z.literal("resolved"),
        source: z.enum(["fresh-initial", "actual-LBe", "actual-overdue-LBe"]),
        retainedUuids: z.array(uuid),
      }),
      z.strictObject({ status: z.literal("unsupported"), reason: nonempty }),
    ]),
  }),
  z.strictObject({
    consumer: z.literal("user-prompt-submit"),
    dispatchToolUseID: nonempty,
    signalAborted: z.boolean(),
  }),
  z.strictObject({
    consumer: z.literal("blockable-stop"),
    dispatchToolUseID: nonempty,
    signalAborted: z.boolean(),
  }),
  z.strictObject({
    consumer: z.literal("turn-end-reactions"),
    dispatchToolUseID: nonempty,
    signalAborted: z.boolean(),
  }),
]);
/** Post-yield consumer disposition, independent of disk OE and current model-frame membership. */
export function nativeHookProgressRetention(
  row: NativeHookProgressRow,
  input: NativeHookProgressRetentionInput,
): NativeHookProgressRetention {
  row = validateNativeHookProgressRow(row);
  const policy = retentionSchema.safeParse(snapshot(input));
  if (!policy.success)
    throw new NativeHookProgressValidationError(
      "Missing actual event-specific progress retention policy",
      policy.error,
    );
  input = policy.data;
  if (
    row.toolUseID !== input.dispatchToolUseID ||
    typeof input.signalAborted !== "boolean"
  )
    throw new NativeHookProgressValidationError(
      "Progress retention does not own the actual dispatch",
    );
  if (input.consumer === "session-start") {
    if (row.data.hookEvent !== "SessionStart")
      throw new NativeHookProgressValidationError(
        "Wrong actual SessionStart progress event",
      );
    if (input.admission.status === "unsupported")
      return Object.freeze({
        status: "unsupported",
        reasons: Object.freeze([input.admission.reason]),
      });
    if (input.admission.status === "buffer")
      return Object.freeze({
        status: "resolved",
        retention: "startup-buffer",
        closeUpstream: false,
      });
    if (
      !Array.isArray(input.admission.retainedUuids) ||
      !input.admission.retainedUuids.every((value) => typeof value === "string")
    )
      throw new NativeHookProgressValidationError(
        "Missing actual startup retention vector",
      );
    return Object.freeze({
      status: "resolved",
      retention: input.admission.retainedUuids.includes(row.uuid)
        ? "retain"
        : "discard",
      closeUpstream: false,
    });
  }
  if (input.consumer === "user-prompt-submit") {
    if (row.data.hookEvent !== "UserPromptSubmit")
      throw new NativeHookProgressValidationError(
        "Wrong actual qvo progress event",
      );
    return Object.freeze({
      status: "resolved",
      retention: "discard",
      closeUpstream: false,
    });
  }
  if (row.data.hookEvent !== "Stop" && row.data.hookEvent !== "SubagentStop")
    throw new NativeHookProgressValidationError(
      "Wrong actual Stop progress event",
    );
  return Object.freeze({
    status: "resolved",
    retention: "retain",
    closeUpstream: input.consumer === "blockable-stop" && input.signalAborted,
  });
}
export interface NativeStopHookSummaryInput {
  phase: "blockable-turn-end" | "turn-end-reactions";
  end:
    | "normally-drained"
    | "aborted-in-loop"
    | "aborted-exception"
    | "control-stream-closed"
    | "failed"
    | "consumer-closed";
  observedProgress: readonly NativeHookProgressRow[];
  accumulators?: NativeStopHookSummaryAccumulators;
}
export interface NativeStopHookSummaryHost {
  stamp(
    input: Readonly<{
      kind: "stop-summary";
      payload: NativeStopHookSummaryAccumulators;
    }>,
  ): NativeHookProgressIdentity;
}
export type NativeStopHookSummaryCreation =
  | { readonly status: "created"; readonly row: NativeStopHookSummaryRow }
  | {
      readonly status: "absent";
      readonly reason:
        "reaction-pass" | "not-normally-drained" | "no-observed-progress";
    };
/** Source Eua creation from the actual normally-drained kc accumulators, never reconstructed batch output. */
export function createNativeStopHookSummary(
  input: NativeStopHookSummaryInput,
  host: NativeStopHookSummaryHost,
): NativeStopHookSummaryCreation {
  const captured = snapshot(input);
  if (
    !isNativeObject(captured) ||
    Object.keys(captured).some(
      (key) =>
        !["phase", "end", "observedProgress", "accumulators"].includes(key),
    ) ||
    typeof captured.phase !== "string" ||
    !["blockable-turn-end", "turn-end-reactions"].includes(captured.phase) ||
    typeof captured.end !== "string" ||
    ![
      "normally-drained",
      "aborted-in-loop",
      "aborted-exception",
      "control-stream-closed",
      "failed",
      "consumer-closed",
    ].includes(captured.end) ||
    !isNativeArray(captured.observedProgress)
  )
    throw new NativeHookProgressValidationError(
      "Missing actual Stop summary drain facts",
    );
  const observed = captured.observedProgress.map(validateNativeHookProgressRow);
  if (new Set(observed.map((row) => row.uuid)).size !== observed.length)
    throw new NativeHookProgressValidationError(
      "Repeated observed progress identity",
    );
  if (captured.phase === "turn-end-reactions")
    return Object.freeze({ status: "absent", reason: "reaction-pass" });
  if (captured.end !== "normally-drained")
    return Object.freeze({ status: "absent", reason: "not-normally-drained" });
  if (!observed.length)
    return Object.freeze({ status: "absent", reason: "no-observed-progress" });
  const payload = captured.accumulators;
  if (
    !isNativeObject(payload) ||
    !isAccumulators(payload) ||
    typeof payload.stopReason !== "string" ||
    !isNativeArray(payload.hookAdditionalContext) ||
    payload.level !== "suggestion" ||
    payload.hookCount !== observed.length ||
    payload.toolUseID !== observed.at(-1)?.toolUseID ||
    observed.some(
      (row) =>
        (row.data.hookEvent !== "Stop" &&
          row.data.hookEvent !== "SubagentStop") ||
        row.toolUseID !== payload.toolUseID,
    )
  )
    throw new NativeHookProgressValidationError(
      "Stop summary lacks its actual observed progress and accumulator owner",
    );
  const infos = payload.hookInfos,
    described = observed.filter((row) => row.data.command);
  if (
    !isNativeArray(infos) ||
    infos.length !== described.length ||
    infos.some(
      (info, index) =>
        !isNativeObject(info) ||
        info.command !== described[index]?.data.command ||
        info.promptText !== described[index]?.data.promptText,
    )
  )
    throw new NativeHookProgressValidationError(
      "Stop hookInfos are not the actual observed progress vector",
    );
  const identity = owned(() =>
    actualIdentity(
      host.stamp(Object.freeze({ kind: "stop-summary", payload })),
    ),
  );
  if (observed.some((row) => row.uuid === identity.uuid))
    throw new NativeHookProgressCaptureError(
      new Error("Stop summary reused a progress identity"),
    );
  return Object.freeze({
    status: "created",
    row: owned(() =>
      validateNativeStopHookSummaryRow({
        type: "system",
        subtype: "stop_hook_summary",
        ...payload,
        ...identity,
      }),
    ),
  });
}
