import { isDeepStrictEqual } from "node:util";
import type { HookRegistryLike } from "./composite-hooks.js";
import type {
  CommandHook,
  HookBatchResult,
  HookInput,
  HookResult,
  HookRunOptions,
} from "./hooks.js";
import { sanitizeHookAttachmentText } from "./hook-attachment-projection.js";
import {
  captureNativePersistenceJson,
  createNativeAttachmentEvent,
  validateNativePersistenceEvent,
  type NativePersistenceAttachment,
  type NativePersistenceEvent,
} from "./native-persistence-events.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";
import { isNativeObject, type NativeObject } from "./native-session-codec.js";

import {
  type NativeHookProgressRow,
  type NativeHookProgressRetentionInput,
  type NativeStopHookSummaryHost,
  type NativeStopHookSummaryCreation,
  validateNativeHookProgressRow,
} from "./native-hook-progress.js";
import { createNativeStopHookAccumulator } from "./native-stop-hook-accumulator.js";

export type NativeLifecycleEvent = "SessionStart" | "Stop" | "UserPromptSubmit";
export type NativeLifecycleAttachment = Extract<
  NativePersistenceAttachment,
  {
    type:
      | "hook_success"
      | "hook_system_message"
      | "hook_non_blocking_error"
      | "hook_error_during_execution"
      | "hook_cancelled"
      | "hook_blocking_error"
      | "hook_stopped_continuation"
      | "hook_additional_context";
  }
>;
export interface NativeLifecycleCause {
  event: NativeLifecycleEvent;
  dispatchToolUseID: string;
  outcomeID?: string;
  branch: string;
}
export interface NativeLifecycleCreation {
  cause: NativeLifecycleCause;
  event: NativePersistenceEvent;
}
export interface NativeLifecycleUnsupported {
  cause: NativeLifecycleCause;
  reasons: readonly string[];
  facts: NativeObject;
}
export interface NativeLifecycleCaptureHost {
  /** Called at the actual producer creation; creation and retention order are separate. */
  stamp(input: {
    kind: "attachment" | "feedback";
    payload: NativeObject;
    cause: NativeLifecycleCause;
  }): { uuid: string; timestamp: string };
  capture(creation: NativeLifecycleCreation): void | Promise<void>;
  unsupported(fact: NativeLifecycleUnsupported): void | Promise<void>;
  /** Actual mC() / hook-${UUID} creation seam, distinct from dispatch/progress identity. */
  toolUseID?(input: {
    purpose: "SessionStart-Q6t" | "UserPromptSubmit-context";
    cause: NativeLifecycleCause;
  }): string;
  /** Actual WMe projection when the native 10000 JS-character boundary is exceeded. */
  projectText?(input: {
    text: string;
    field:
      "additionalContext" | "stdout" | "systemMessage" | "initialUserMessage";
    cause: NativeLifecycleCause;
  }): string | Promise<string>;
  /** Source U_e normal completion, including empty metadata, before final CUn creation. */
  startCompletion?(input: NativeLifecycleStartCompletion): void | Promise<void>;
  startMetadata?(input: {
    initialUserMessage?: string;
    lateInitialUserMessage?: string;
    sessionTitle?: string;
    watchPaths?: readonly string[];
    reloadSkills?: true;
    addWatchPaths?: true;
  }): void | Promise<void>;
}
export interface NativeLifecycleStartCompletion {
  source: "startup" | "resume" | "clear" | "compact" | "fork";
  newPluginsOnly: boolean;
  overtaken: boolean;
  end: NativeLifecycleEnd;
  sessionTitle: string | undefined;
  watchPaths: readonly string[];
  reloadSkills: boolean;
}
export interface NativeLifecycleInput {
  event: NativeLifecycleEvent;
  dispatchToolUseID: string;
  phase: "ordinary" | "turn-end-reactions";
  start?: {
    source: "startup" | "resume" | "clear" | "compact" | "fork";
    newPluginsOnly: boolean;
  };
  prompt?: {
    submitted: string;
    typed: string;
    suppressOriginalPrompt: boolean;
    stoppedText: string;
  };
}
export type NativeLifecycleYield =
  | {
      kind: "message";
      creation: NativeLifecycleCreation;
      retainForStop: boolean;
    }
  | { kind: "progress"; toolUseID: string }
  | {
      kind: "context";
      content: readonly string[];
      cause: NativeLifecycleCause;
      retainForStop: boolean;
    }
  | {
      kind: "blocking";
      text: string;
      command: string;
      cause: NativeLifecycleCause;
      suppressOriginalPrompt?: boolean;
    }
  | { kind: "prevent"; reason?: string; cause: NativeLifecycleCause }
  | { kind: "initial-user-message"; text: string; cause: NativeLifecycleCause }
  | { kind: "session-title"; text: string }
  | { kind: "watch-paths"; paths: readonly string[] }
  | { kind: "reload-skills" }
  | { kind: "unsupported"; fact: NativeLifecycleUnsupported };
export type NativeLifecycleEnd =
  | { kind: "completed" }
  | { kind: "aborted-in-loop" }
  | { kind: "aborted-exception" }
  | { kind: "orphaned" }
  | { kind: "control-stream-closed" }
  | {
      kind: "failed";
      message: string;
      enforcementEvents: readonly NativePersistenceEvent[];
    };
export interface NativeLifecycleDecision {
  event: NativeLifecycleEvent;
  emitted: readonly NativeLifecycleCreation[];
  continuationEvents: readonly NativePersistenceEvent[];
  continue: boolean;
  preventContinuation: boolean;
  wasCancelled: boolean;
  unsupported: readonly NativeLifecycleUnsupported[];
  /** Actual qvo metadata return; applying/persisting a title remains the prompt owner's job. */
  sessionTitle?: string;
  startupRetention?: "retained" | "pending" | "unsupported";
  promptEnding?: {
    kind: "blocked" | "stopped";
    text: string;
    promptKept: boolean;
  };
}
export class NativeLifecycleCaptureError extends Error {
  constructor(cause: unknown) {
    super("Native lifecycle capture owner failed", { cause });
    this.name = "NativeLifecycleCaptureError";
  }
}
function frozen<T>(value: T): T {
  captureNativePersistenceJson(value);
  const copy = structuredClone(value);
  const pending: object[] =
    copy !== null && typeof copy === "object" ? [copy] : [];
  for (const item of pending) {
    const children: unknown[] = Object.values(item);
    for (const child of children)
      if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(item);
  }
  return copy;
}
function jsonObject(value: unknown): NativeObject {
  const result = captureNativePersistenceJson(value);
  if (!isNativeObject(result))
    throw new TypeError("Expected native lifecycle JSON object");
  return result;
}
function known<T>(value: NativePromptFact<T>): T {
  if (value.status !== "known") throw new Error(value.reason);
  return value.value;
}
function factBoolean(value: NativePromptFact<boolean>): boolean {
  const result = known(value);
  if (typeof result !== "boolean")
    throw new Error("Native lifecycle gate has no actual boolean value");
  return result;
}
async function owned<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof NativeLifecycleCaptureError) throw error;
    throw new NativeLifecycleCaptureError(error);
  }
}
/** A real source-created attachment may be retained later than its stamp. */
export function createNativeLifecycleAttachment(
  host: NativeLifecycleCaptureHost,
  attachment: NativeLifecycleAttachment,
  cause: NativeLifecycleCause,
): NativeLifecycleCreation {
  const captured = frozen({ attachment, cause });
  try {
    const stamp = host.stamp(
      frozen({
        kind: "attachment",
        payload: jsonObject(captured.attachment),
        cause: captured.cause,
      }),
    );
    return frozen({
      cause: captured.cause,
      event: createNativeAttachmentEvent(captured.attachment, stamp),
    });
  } catch (error) {
    throw new NativeLifecycleCaptureError(error);
  }
}
function createFeedback(
  host: NativeLifecycleCaptureHost,
  text: string,
  cause: NativeLifecycleCause,
): NativeLifecycleCreation {
  const payload = frozen({
    message: { role: "user", content: text },
    isMeta: true,
  });
  try {
    const stamp = host.stamp(frozen({ kind: "feedback", payload, cause }));
    return frozen({
      cause,
      event: validateNativePersistenceEvent({
        type: "user",
        ...stamp,
        ...payload,
      }),
    });
  } catch (error) {
    throw new NativeLifecycleCaptureError(error);
  }
}

/** Full ordinary U_e/CUn, blockable Stop, reaction-pass and qvo retention boundaries. */
export function createNativeLifecycleConsumer(
  input: NativeLifecycleInput,
  host: NativeLifecycleCaptureHost,
) {
  input = frozen(input);
  if (
    !input.dispatchToolUseID ||
    (input.event === "SessionStart" && !input.start) ||
    (input.phase === "turn-end-reactions" && input.event !== "Stop")
  )
    throw new Error("Missing actual lifecycle dispatch/source ownership");
  const emitted: NativeLifecycleCreation[] = [],
    continuation: NativePersistenceEvent[] = [],
    unsupported: NativeLifecycleUnsupported[] = [],
    contexts: string[] = [],
    watchPaths: string[] = [];
  let prevented = false,
    overtaken = false,
    finished = false,
    progressID = "",
    title: string | undefined,
    reload = false,
    ending: NativeLifecycleDecision["promptEnding"];
  const unsupportedFact = async (fact: NativeLifecycleUnsupported) => {
    const copy = frozen(fact);
    unsupported.push(copy);
    await owned(() => host.unsupported(copy));
  };
  const emit = async (creation: NativeLifecycleCreation, retain = false) => {
    const copy = frozen(creation);
    emitted.push(copy);
    if (retain) continuation.push(copy.event);
    await owned(() => host.capture(copy));
  };
  const metadata = async (
    value: Parameters<
      NonNullable<NativeLifecycleCaptureHost["startMetadata"]>
    >[0],
    cause: NativeLifecycleCause,
  ) => {
    if (host.startMetadata)
      await owned(() => host.startMetadata?.(frozen(value)));
    else
      await unsupportedFact({
        cause,
        reasons: [
          "Actual SessionStart metadata requires its owning session-state adapter",
        ],
        facts: jsonObject(value),
      });
  };
  const contextCreation = (
    content: readonly string[],
    event: NativeLifecycleEvent,
    toolUseID: string,
    cause: NativeLifecycleCause,
  ) =>
    createNativeLifecycleAttachment(
      host,
      {
        type: "hook_additional_context",
        content: [...content],
        hookName: event,
        toolUseID,
        hookEvent: event,
      },
      cause,
    );
  const identity = async (
    purpose: "SessionStart-Q6t" | "UserPromptSubmit-context",
    cause: NativeLifecycleCause,
  ) => {
    if (!host.toolUseID) {
      await unsupportedFact({
        cause,
        reasons: [
          "Lifecycle attachment requires its actual independent tool-use identity producer",
        ],
        facts: { purpose },
      });
      return;
    }
    const value = await owned(() =>
      host.toolUseID?.(frozen({ purpose, cause })),
    );
    const pattern =
      purpose === "SessionStart-Q6t"
        ? /^[0-9a-f]{8}-[0-9a-f-]{27}$/i
        : /^hook-[0-9a-f]{8}-[0-9a-f-]{27}$/i;
    if (!value || !pattern.test(value))
      throw new NativeLifecycleCaptureError(
        new Error("Invalid actual lifecycle attachment tool-use identity"),
      );
    return value;
  };
  const startContext = async (branch: string) => {
    if (!contexts.length) return;
    await emit(
      contextCreation(contexts, "SessionStart", "SessionStart", {
        event: "SessionStart",
        dispatchToolUseID: input.dispatchToolUseID,
        branch,
      }),
    );
  };
  return {
    reportUnsupported: unsupportedFact,
    async consume(value: NativeLifecycleYield): Promise<void> {
      if (finished)
        throw new Error("Native lifecycle consumer is already finished");
      if (ending) return; // qvo returns at the first actual blocking/prevent yield.
      value = frozen(value);
      if (
        "cause" in value &&
        (value.cause.event !== input.event ||
          value.cause.dispatchToolUseID !== input.dispatchToolUseID)
      )
        throw new Error("Lifecycle yield belongs to another dispatch");
      if (value.kind === "message") {
        validateNativePersistenceEvent(value.creation.event);
        if (
          value.creation.cause.event !== input.event ||
          value.creation.cause.dispatchToolUseID !== input.dispatchToolUseID
        )
          throw new Error("Lifecycle message belongs to another dispatch");
      }
      if (value.kind === "unsupported") {
        await unsupportedFact(value.fact);
        return;
      }
      if (value.kind === "progress") {
        if (value.toolUseID !== input.dispatchToolUseID)
          throw new Error("Lifecycle progress belongs to another dispatch");
        progressID = value.toolUseID;
        return;
      }
      if (value.kind === "message") {
        const attachment = isNativeObject(value.creation.event.attachment)
          ? value.creation.event.attachment
          : undefined;
        if (
          input.event === "SessionStart" &&
          attachment?.type === "hook_blocking_error"
        )
          return;
        if (
          input.event === "UserPromptSubmit" &&
          attachment?.type === "hook_success" &&
          !attachment.content
        )
          return;
        await emit(
          value.creation,
          input.event === "Stop" &&
            input.phase !== "turn-end-reactions" &&
            value.retainForStop,
        );
        return;
      }
      if (input.phase === "turn-end-reactions") return; // Eo retains messages only; it discards block/prevent/context decisions.
      if (value.kind === "context") {
        if (!value.content.length) return;
        if (input.event === "SessionStart") contexts.push(...value.content);
        else {
          const id =
            input.event === "Stop"
              ? progressID
              : await identity("UserPromptSubmit-context", value.cause);
          if (!id) {
            await unsupportedFact({
              cause: value.cause,
              reasons: [
                "The native consumer has no observed physical hook identity; no event-name fallback is allowed",
              ],
              facts: { content: value.content },
            });
            return;
          }
          await emit(
            contextCreation(value.content, input.event, id, value.cause),
            input.event === "Stop" && value.retainForStop,
          );
        }
      } else if (value.kind === "blocking") {
        if (input.event === "SessionStart") {
          const id = await identity("SessionStart-Q6t", value.cause);
          if (id)
            await emit(
              createNativeLifecycleAttachment(
                host,
                {
                  type: "hook_non_blocking_error",
                  hookName: `SessionStart:${input.start?.source ?? ""}`,
                  toolUseID: id,
                  hookEvent: "SessionStart",
                  stderr: value.text,
                  stdout: "",
                  exitCode: 2,
                  command: value.command,
                },
                { ...value.cause, branch: "SessionStart-Q6t" },
              ),
            );
        } else if (input.event === "Stop") {
          await emit(
            createFeedback(
              host,
              `Stop hook feedback:\n${sanitizeHookAttachmentText(value.text)}`,
              value.cause,
            ),
            true,
          );
        } else {
          const prompt = input.prompt;
          if (!prompt) {
            await unsupportedFact({
              cause: value.cause,
              reasons: [
                "UserPromptSubmit needs actual submitted/typed prompt and suppression facts",
              ],
              facts: { blockingText: value.text },
            });
            return;
          }
          const suppress =
            prompt.suppressOriginalPrompt ||
            value.suppressOriginalPrompt === true ||
            prompt.typed !== prompt.submitted;
          const text = `UserPromptSubmit operation blocked by hook:\n${value.text}${suppress ? "" : `\n\nOriginal prompt: ${prompt.submitted}`}`;
          ending = { kind: "blocked", text, promptKept: false };
        }
      } else if (value.kind === "prevent") {
        if (input.event === "SessionStart") return; // U_e does not act on preventContinuation.
        prevented = true;
        if (input.event === "Stop") {
          if (!progressID) {
            await unsupportedFact({
              cause: value.cause,
              reasons: [
                "Stop continuation requires the actual progress-correlated hook identity",
              ],
              facts: { reason: value.reason ?? "" },
            });
            return;
          }
          await emit(
            createNativeLifecycleAttachment(
              host,
              {
                type: "hook_stopped_continuation",
                hookName: "Stop",
                toolUseID: progressID,
                hookEvent: "Stop",
                message: value.reason || "Stop hook prevented continuation",
              },
              value.cause,
            ),
          );
        } else if (input.prompt) {
          const text = input.prompt.stoppedText;
          await emit(createFeedback(host, text, value.cause));
          ending = { kind: "stopped", text, promptKept: true };
        } else
          await unsupportedFact({
            cause: value.cause,
            reasons: [
              "Prompt stopping requires the actual source stopped-text result",
            ],
            facts: { reason: value.reason ?? "" },
          });
      } else if (
        input.event === "UserPromptSubmit" &&
        value.kind === "session-title" &&
        value.text
      ) {
        title = value.text;
      } else if (input.event === "SessionStart") {
        if (value.kind === "initial-user-message" && value.text) {
          if (!input.start?.newPluginsOnly)
            await metadata(
              overtaken
                ? { lateInitialUserMessage: value.text }
                : { initialUserMessage: value.text },
              value.cause,
            );
        } else if (value.kind === "session-title" && value.text)
          title = value.text;
        else if (value.kind === "watch-paths") watchPaths.push(...value.paths);
        else if (value.kind === "reload-skills") reload = true;
      }
    },
    async overtakeStart(): Promise<readonly NativeLifecycleCreation[]> {
      if (finished || input.event !== "SessionStart" || overtaken)
        throw new Error("Invalid native SessionStart takeover");
      overtaken = true;
      await startContext("SessionStart-overtaken-CUn");
      return frozen(emitted);
    },
    async finish(end: NativeLifecycleEnd): Promise<NativeLifecycleDecision> {
      if (finished)
        throw new Error("Native lifecycle consumer is already finished");
      finished = true;
      end = frozen(end);
      const cancelled = [
        "aborted-in-loop",
        "aborted-exception",
        "orphaned",
        "control-stream-closed",
      ].includes(end.kind);
      if (
        input.event === "SessionStart" &&
        (end.kind === "completed" || end.kind === "control-stream-closed")
      ) {
        const newPlugins = input.start?.newPluginsOnly === true;
        const cause: NativeLifecycleCause = {
          event: input.event,
          dispatchToolUseID: input.dispatchToolUseID,
          branch: "SessionStart-drained-metadata",
        };
        if (host.startCompletion) {
          const start = input.start;
          if (!start)
            throw new Error("Missing actual SessionStart completion source");
          await owned(() =>
            host.startCompletion?.(
              frozen({
                source: start.source,
                newPluginsOnly: newPlugins,
                overtaken,
                end,
                sessionTitle: title,
                watchPaths,
                reloadSkills: reload,
              }),
            ),
          );
        } else if (
          reload ||
          watchPaths.length ||
          (!newPlugins &&
            title &&
            ["startup", "resume", "fork"].includes(input.start?.source ?? ""))
        )
          await metadata(
            {
              ...(reload ? { reloadSkills: true } : {}),
              ...(watchPaths.length
                ? {
                    watchPaths,
                    ...(newPlugins || overtaken ? { addWatchPaths: true } : {}),
                  }
                : {}),
              ...(!newPlugins &&
              title &&
              ["startup", "resume", "fork"].includes(input.start?.source ?? "")
                ? { sessionTitle: title }
                : {}),
            },
            cause,
          );
        await startContext("SessionStart-drained-CUn");
      }
      if (end.kind === "failed") {
        await unsupportedFact({
          cause: {
            event: input.event,
            dispatchToolUseID: input.dispatchToolUseID,
            branch: "lifecycle-consumer-failed",
          },
          reasons: [
            "Native failure warning/reaction handling requires its owning lifecycle adapter",
          ],
          facts: {
            message: end.message,
            enforcementEvents: end.enforcementEvents,
          },
        });
        continuation.splice(0, continuation.length, ...end.enforcementEvents);
      }
      const prevent =
        input.event === "Stop" && end.kind === "aborted-in-loop"
          ? true
          : input.event === "Stop" && end.kind === "aborted-exception"
            ? false
            : prevented;
      const kept =
        input.event === "Stop" &&
        (prevent ||
          end.kind === "aborted-in-loop" ||
          end.kind === "aborted-exception")
          ? []
          : continuation;
      return frozen({
        event: input.event,
        emitted,
        continuationEvents: kept,
        continue:
          input.event === "Stop" &&
          input.phase !== "turn-end-reactions" &&
          !prevent &&
          kept.length > 0,
        preventContinuation: prevent,
        wasCancelled: cancelled,
        unsupported,
        ...(input.event === "UserPromptSubmit" && !ending && title
          ? { sessionTitle: title }
          : {}),
        ...(ending ? { promptEnding: ending } : {}),
      });
    },
  };
}

export interface NativeLifecycleCommandFacts {
  /** Actual source EX/nZ branch, not a guess from an aggregate display string. */
  output: NativePromptFact<"plain" | "structured">;
  command: NativePromptFact<string>;
  /** Actual ac/suppressOutput success-notice result; undefined means that branch was inactive. */
  structuredSuccessNotice: NativePromptFact<string | undefined>;
  retainMessageForStop: NativePromptFact<boolean>;
  retainContextForStop: NativePromptFact<boolean>;
  /** Native progress was produced for this actual dispatch; callbacks-only paths may differ. */
  hasProgress: NativePromptFact<boolean>;
}
export type NativeLifecycleCommandResult = Omit<HookResult, "event"> & {
  event: NativeLifecycleEvent;
};
export interface NativeLifecycleObservedOutcome {
  result: Readonly<NativeLifecycleCommandResult>;
  hook: Readonly<CommandHook>;
  background: boolean;
  facts: NativeLifecycleCommandFacts;
}
export interface NativeLifecycleRunStages {
  classicOrFunctionChain: NativePromptFact<boolean>;
  managedOrRemoteTransport: NativePromptFact<boolean>;
  activeGoalOrTaskEnforcement: NativePromptFact<boolean>;
  backgroundRewake: NativePromptFact<boolean>;
}
export interface NativeLifecycleActualPrefix {
  /** False closes the lazy upstream before its next identity or any execution. */
  progress(row: NativeHookProgressRow): Promise<boolean>;
  unsupported(reasons: readonly string[], facts: NativeObject): Promise<void>;
}
export type NativeLifecycleStartupCreation =
  | { kind: "progress"; row: NativeHookProgressRow }
  | { kind: "attachment"; creation: NativeLifecycleCreation };
export interface NativeLifecyclePreparedCapture {
  progress(
    row: NativeHookProgressRow,
    policy: NativeHookProgressRetentionInput,
  ): void | Promise<void>;
  summary?: {
    host: NativeStopHookSummaryHost;
    capture(creation: NativeStopHookSummaryCreation): void | Promise<void>;
  };
  startup?: {
    /** Actual final LBe/Aue/overdue owner; it returns transformed full rows before publication. */
    finalize(
      input: Readonly<{
        creations: readonly NativeLifecycleStartupCreation[];
        end: NativeLifecycleEnd;
      }>,
    ): Promise<
      | {
          status: "retained";
          source: "fresh-initial" | "actual-LBe" | "actual-overdue-LBe";
          creations: readonly NativeLifecycleStartupCreation[];
        }
      | { status: "pending" }
      | {
          status: "unsupported";
          reasons: readonly string[];
          facts: NativeObject;
        }
    >;
  };
}
export interface NativeLifecycleRunner {
  readonly progressProtocol?: "actual-created-prefix";
  /** Implementations must observe actual per-command settlement, drain siblings on observer failure, and own async completions. */
  run(
    input: Readonly<NativeObject>,
    signal: AbortSignal,
    onResult: (outcome: NativeLifecycleObservedOutcome) => Promise<void>,
    prefix?: NativeLifecycleActualPrefix,
  ): Promise<{ backgroundIDs: readonly string[]; cancelled: boolean }>;
}
export interface NativeLifecycleRuntimeOptions {
  input: NativeLifecycleInput;
  hookInput: NativeObject;
  stages: NativeLifecycleRunStages;
  host: NativeLifecycleCaptureHost;
  runner: NativeLifecycleRunner;
  /** Required for actual-prefix runners; absent preserves legacy correlation-only behavior. */
  preparedCapture?: NativeLifecyclePreparedCapture;
  /** Exact owner classification; no arbitrary error is reclassified as source stream closure. */
  classifyEnd?(error: unknown): NativeLifecycleEnd | undefined;
}
/** Source per-command nZ/EPs sequencing into the lifecycle consumer; no batch-string reconstruction. */
export async function runNativeLifecycleHookDispatch(
  options: NativeLifecycleRuntimeOptions,
  signal: AbortSignal,
): Promise<NativeLifecycleDecision> {
  const captured = frozen({
    input: options.input,
    hookInput: options.hookInput,
    stages: options.stages,
  });
  const requestedCapture = options.preparedCapture;
  const preparedCapture: NativeLifecyclePreparedCapture | undefined =
    requestedCapture
      ? {
          progress: requestedCapture.progress.bind(requestedCapture),
          ...(requestedCapture.summary
            ? {
                summary: {
                  host: {
                    stamp: requestedCapture.summary.host.stamp.bind(
                      requestedCapture.summary.host,
                    ),
                  },
                  capture: requestedCapture.summary.capture.bind(
                    requestedCapture.summary,
                  ),
                },
              }
            : {}),
          ...(requestedCapture.startup
            ? {
                startup: {
                  finalize: requestedCapture.startup.finalize.bind(
                    requestedCapture.startup,
                  ),
                },
              }
            : {}),
        }
      : undefined;
  const actualPrefix =
    options.runner.progressProtocol === "actual-created-prefix";
  const buffered: NativeLifecycleStartupCreation[] = [];
  const bufferStartup = actualPrefix && captured.input.event === "SessionStart";
  const accumulator =
    actualPrefix &&
    captured.input.event === "Stop" &&
    captured.input.phase === "ordinary"
      ? createNativeStopHookAccumulator()
      : undefined;
  const consumer = createNativeLifecycleConsumer(
    captured.input,
    bufferStartup
      ? {
          ...options.host,
          capture(creation) {
            buffered.push(frozen({ kind: "attachment", creation }));
          },
        }
      : options.host,
  );
  let stopped = false;
  const consume = async (value: NativeLifecycleYield) => {
    if (stopped) return;
    if (value.kind !== "progress") accumulator?.observed(value);
    await consumer.consume(value);
    if (actualPrefix && captured.input.event === "Stop" && signal.aborted)
      stopped = true;
  };
  const finish = async (
    end: NativeLifecycleEnd,
  ): Promise<NativeLifecycleDecision> => {
    const decision = await owned(() => consumer.finish(end));
    const summaryOwner = preparedCapture?.summary;
    if (accumulator && summaryOwner) {
      const summary = await owned(() =>
        accumulator.finish(
          decision.unsupported.length
            ? {
                kind: "failed",
                message: "Unsupported lifecycle facts",
                enforcementEvents: [],
              }
            : end,
          summaryOwner.host,
        ),
      );
      // Creation is complete before this first sink await; never recreate on a failed publication.
      await owned(() => preparedCapture?.summary?.capture(summary));
    }
    if (!bufferStartup || !preparedCapture?.startup) return decision;
    const selected = await owned(() =>
      preparedCapture?.startup?.finalize(frozen({ creations: buffered, end })),
    );
    if (!selected)
      throw new NativeLifecycleCaptureError(
        new Error("Missing startup final owner result"),
      );
    if (selected.status !== "retained") {
      if (selected.status === "unsupported")
        await owned(() =>
          options.host.unsupported({
            cause: {
              event: "SessionStart",
              dispatchToolUseID: captured.input.dispatchToolUseID,
              branch: "SessionStart-final-owner",
            },
            reasons: selected.reasons,
            facts: selected.facts,
          }),
        );
      return frozen({
        ...decision,
        emitted: [],
        startupRetention: selected.status,
      });
    }
    const retained = await owned(() => {
      const retained = frozen(selected.creations),
        identities = new Set<string>();
      if (
        !["fresh-initial", "actual-LBe", "actual-overdue-LBe"].includes(
          selected.source,
        )
      )
        throw new NativeLifecycleCaptureError(
          new Error("Unknown startup retention provenance"),
        );
      let lastIndex = -1;
      for (const entry of retained) {
        const row =
          entry.kind === "progress"
            ? validateNativeHookProgressRow(entry.row)
            : validateNativePersistenceEvent(entry.creation.event);
        const originalIndex = buffered.findIndex(
          (value) =>
            value.kind === entry.kind &&
            (value.kind === "progress"
              ? value.row.uuid
              : value.creation.event.uuid) === row.uuid,
        );
        const original = buffered[originalIndex];
        const originalRow =
          original?.kind === "progress"
            ? original.row
            : original?.creation.event;
        if (
          !originalRow ||
          originalRow.timestamp !== row.timestamp ||
          identities.has(row.uuid) ||
          originalIndex <= lastIndex ||
          (entry.kind === "progress" &&
            !isDeepStrictEqual(entry.row, originalRow)) ||
          (entry.kind === "attachment" &&
            (entry.creation.cause.event !== "SessionStart" ||
              entry.creation.cause.dispatchToolUseID !==
                captured.input.dispatchToolUseID))
        )
          throw new NativeLifecycleCaptureError(
            new Error(
              "Startup final owner changed or invented creation identity",
            ),
          );
        identities.add(row.uuid);
        lastIndex = originalIndex;
      }
      return retained;
    });
    for (const entry of retained) {
      if (entry.kind === "attachment")
        await owned(() => options.host.capture(entry.creation));
      else
        await owned(() =>
          preparedCapture?.progress(entry.row, {
            consumer: "session-start",
            dispatchToolUseID: captured.input.dispatchToolUseID,
            signalAborted: signal.aborted,
            admission: {
              status: "resolved",
              source: selected.source,
              retainedUuids: retained.map((v) =>
                v.kind === "progress" ? v.row.uuid : v.creation.event.uuid,
              ),
            },
          }),
        );
    }
    return frozen({
      ...decision,
      emitted: retained.flatMap((value) =>
        value.kind === "attachment" ? [value.creation] : [],
      ),
      startupRetention: "retained",
    });
  };
  const cause: NativeLifecycleCause = {
    event: captured.input.event,
    dispatchToolUseID: captured.input.dispatchToolUseID,
    branch: "lifecycle-dispatch",
  };
  const unsupported = async (
    reasons: readonly string[],
    facts: NativeObject,
    owner = cause,
  ) =>
    consume({
      kind: "unsupported",
      fact: { cause: owner, reasons, facts },
    });
  const text = async (
    raw: string,
    field:
      "additionalContext" | "stdout" | "systemMessage" | "initialUserMessage",
    owner: NativeLifecycleCause,
  ): Promise<string | undefined> => {
    if (raw.length <= 10_000) return raw;
    if (!options.host.projectText) {
      await unsupported(
        [
          "Native WMe persisted-output projection is required above 10000 JS characters",
        ],
        { text: raw, field },
        owner,
      );
      return;
    }
    const projected = await owned(() =>
      options.host.projectText?.(frozen({ text: raw, field, cause: owner })),
    );
    if (typeof projected !== "string")
      throw new NativeLifecycleCaptureError(
        new Error("Native WMe host returned no actual text"),
      );
    return projected;
  };
  let tail = Promise.resolve();
  let stageReason: string | undefined;
  try {
    if (actualPrefix !== (preparedCapture !== undefined))
      throw new Error(
        "Actual progress runner and owning capture protocol must agree",
      );
    if (
      actualPrefix &&
      captured.input.event === "Stop" &&
      !preparedCapture?.summary
    )
      throw new Error(
        "Actual Stop requires its summary creation/publication owner",
      );
    if (bufferStartup && !preparedCapture?.startup)
      throw new Error(
        "Actual SessionStart requires its final full-vector owner before capture",
      );
    if (captured.input.phase === "turn-end-reactions")
      throw new Error(
        "Reaction-only dispatch requires the actual native function-hook runner; command hooks must not run again",
      );
    if (captured.hookInput.hook_event_name !== captured.input.event)
      throw new Error("Lifecycle input and actual dispatch event do not agree");
    if (
      captured.input.event === "UserPromptSubmit" &&
      (!captured.input.prompt ||
        captured.hookInput.prompt !== captured.input.prompt.submitted)
    )
      throw new Error(
        "UserPromptSubmit actual command input does not own its submitted prompt",
      );
    for (const name of [
      "classicOrFunctionChain",
      "managedOrRemoteTransport",
      "activeGoalOrTaskEnforcement",
      "backgroundRewake",
    ] as const)
      if (factBoolean(captured.stages[name]))
        throw new Error(`Actual ${name} requires its native runtime adapter`);
  } catch (error) {
    stageReason =
      error instanceof Error ? error.message : "Unknown actual lifecycle stage";
  }
  if (stageReason) {
    await unsupported([stageReason], jsonObject(captured));
    return finish({ kind: "completed" });
  }
  try {
    const batch = await options.runner.run(
      captured.hookInput,
      signal,
      (outcome) => {
        // Snapshot before any callback or asynchronous projection can mutate outcome/input.
        const observation = frozen(outcome);
        const result = observation.result;
        const owner: NativeLifecycleCause = {
          ...cause,
          outcomeID: result.id,
          branch: "command-settlement",
        };
        if (observation.background)
          return unsupported(
            [
              "Asynchronous lifecycle completion requires its native delivery/rewake owner",
            ],
            jsonObject(observation),
            owner,
          );
        // Native nZ creates its message before EPs yields prevent/block/message/context.
        // For ordinary bounded success this stamp happens synchronously at settlement.
        let diagnostic: NativeLifecycleCreation | undefined,
          earlyReason: string | undefined;
        try {
          if (
            result.event !== captured.input.event ||
            result.command !== observation.hook.command
          )
            throw new Error(
              "Actual lifecycle outcome does not own the dispatch command/event",
            );
          if (
            result.status !== "success" &&
            !(result.status === "blocking" && result.exitCode === 0)
          )
            throw new Error(
              "Failure/cancellation/exit-2 salvage requires its exact native command outcome adapter",
            );
          const output = known(observation.facts.output),
            command = known(observation.facts.command);
          if (
            typeof command !== "string" ||
            (output !== "plain" && output !== "structured")
          )
            throw new Error(
              "Actual native command/output branch is unavailable",
            );
          factBoolean(observation.facts.hasProgress);
          factBoolean(observation.facts.retainMessageForStop);
          factBoolean(observation.facts.retainContextForStop);
          let content: string | undefined;
          if (output === "plain") {
            if (result.stdout.trim().length <= 10_000)
              content = result.stdout.trim();
          } else {
            const notice = known(observation.facts.structuredSuccessNotice);
            if (notice !== undefined && typeof notice !== "string")
              throw new Error("Invalid actual native success notice");
            if (notice !== undefined && result.suppressOutput)
              throw new Error(
                "Suppressed structured output cannot create a native enhanced success notice",
              );
            content = notice ?? "";
          }
          if (content !== undefined)
            diagnostic = createNativeLifecycleAttachment(
              options.host,
              result.status === "blocking"
                ? {
                    type: "hook_blocking_error",
                    hookName:
                      result.event === "SessionStart"
                        ? `SessionStart:${captured.input.start?.source ?? ""}`
                        : result.event,
                    hookEvent: result.event,
                    toolUseID: captured.input.dispatchToolUseID,
                    blockingError: {
                      blockingError: result.reason || "Blocked by hook",
                      command,
                    },
                  }
                : {
                    type: "hook_success",
                    hookName:
                      result.event === "SessionStart"
                        ? `SessionStart:${captured.input.start?.source ?? ""}`
                        : result.event,
                    hookEvent: result.event,
                    toolUseID: captured.input.dispatchToolUseID,
                    content,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    ...(result.exitCode === null
                      ? {}
                      : { exitCode: result.exitCode }),
                    command,
                    durationMs: result.durationMs,
                  },
              owner,
            );
        } catch (error) {
          if (error instanceof NativeLifecycleCaptureError)
            return Promise.reject(error);
          earlyReason =
            error instanceof Error
              ? error.message
              : "Unknown lifecycle outcome";
        }
        const run = async () => {
          if (earlyReason) {
            await unsupported([earlyReason], jsonObject(observation), owner);
            return;
          }
          if (!actualPrefix && factBoolean(observation.facts.hasProgress))
            await consume({
              kind: "progress",
              toolUseID: captured.input.dispatchToolUseID,
            });
          if (!diagnostic) {
            const output = await text(result.stdout.trim(), "stdout", owner);
            if (output !== undefined)
              diagnostic = createNativeLifecycleAttachment(
                options.host,
                {
                  type: "hook_success",
                  hookName:
                    result.event === "SessionStart"
                      ? `SessionStart:${captured.input.start?.source ?? ""}`
                      : result.event,
                  hookEvent: result.event,
                  toolUseID: captured.input.dispatchToolUseID,
                  content: output,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  ...(result.exitCode === null
                    ? {}
                    : { exitCode: result.exitCode }),
                  command: known(observation.facts.command),
                  durationMs: result.durationMs,
                },
                owner,
              );
          }
          if (result.preventContinuation)
            await consume({
              kind: "prevent",
              ...(result.stopReason === undefined
                ? {}
                : { reason: result.stopReason }),
              cause: owner,
            });
          if (result.status === "blocking")
            await consume({
              kind: "blocking",
              text: result.reason || "Blocked by hook",
              command: known(observation.facts.command),
              cause: owner,
              ...(result.suppressOriginalPrompt === undefined
                ? {}
                : { suppressOriginalPrompt: result.suppressOriginalPrompt }),
            });
          if (diagnostic)
            await consume({
              kind: "message",
              creation: diagnostic,
              retainForStop: factBoolean(
                observation.facts.retainMessageForStop,
              ),
            });
          if (result.systemMessage) {
            const projected = await text(
              result.systemMessage,
              "systemMessage",
              owner,
            );
            if (projected !== undefined)
              await consume({
                kind: "message",
                creation: createNativeLifecycleAttachment(
                  options.host,
                  {
                    type: "hook_system_message",
                    content: projected,
                    hookName:
                      result.event === "SessionStart"
                        ? `SessionStart:${captured.input.start?.source ?? ""}`
                        : result.event,
                    hookEvent: result.event,
                    toolUseID: captured.input.dispatchToolUseID,
                  },
                  owner,
                ),
                retainForStop: factBoolean(
                  observation.facts.retainMessageForStop,
                ),
              });
          }
          if (result.additionalContext) {
            const projected = await text(
              result.additionalContext,
              "additionalContext",
              owner,
            );
            if (projected !== undefined)
              await consume({
                kind: "context",
                content: [projected],
                cause: owner,
                retainForStop: factBoolean(
                  observation.facts.retainContextForStop,
                ),
              });
          }
          if (result.initialUserMessage) {
            const projected = await text(
              result.initialUserMessage,
              "initialUserMessage",
              owner,
            );
            if (projected !== undefined)
              await consume({
                kind: "initial-user-message",
                text: projected,
                cause: owner,
              });
          }
          if (result.watchPaths?.length)
            await consume({
              kind: "watch-paths",
              paths: result.watchPaths,
            });
          if (result.reloadSkills) await consume({ kind: "reload-skills" });
          if (result.sessionTitle)
            await consume({
              kind: "session-title",
              text: result.sessionTitle,
            });
        };
        const completed = tail.then(run);
        // Retain the original failure while draining sibling observations. No command rerun.
        tail = completed.catch(() => {});
        return completed;
      },
      actualPrefix
        ? {
            unsupported: (reasons, facts) => unsupported(reasons, facts),
            progress: async (inputRow) => {
              const row = validateNativeHookProgressRow(inputRow);
              if (
                row.data.hookEvent !== captured.input.event ||
                row.toolUseID !== captured.input.dispatchToolUseID
              )
                throw new NativeLifecycleCaptureError(
                  new Error("Actual progress does not own lifecycle dispatch"),
                );
              accumulator?.progress(row);
              await consumer.consume({
                kind: "progress",
                toolUseID: row.toolUseID,
              });
              if (bufferStartup)
                buffered.push(frozen({ kind: "progress", row }));
              else
                await owned(() =>
                  preparedCapture?.progress(row, {
                    consumer:
                      captured.input.event === "UserPromptSubmit"
                        ? "user-prompt-submit"
                        : "blockable-stop",
                    dispatchToolUseID: captured.input.dispatchToolUseID,
                    signalAborted: signal.aborted,
                  }),
                );
              if (captured.input.event === "Stop" && signal.aborted) {
                stopped = true;
                return false;
              }
              return true;
            },
          }
        : undefined,
    );
    await tail;
    if (batch.backgroundIDs.length)
      await unsupported(
        [
          "Pending lifecycle background ownership cannot be reconstructed from synchronous results",
        ],
        { backgroundIDs: batch.backgroundIDs },
      );
    return finish(
      signal.aborted || batch.cancelled
        ? { kind: "aborted-in-loop" }
        : { kind: "completed" },
    );
  } catch (error) {
    await tail;
    if (error instanceof NativeLifecycleCaptureError) throw error;
    const classified = options.classifyEnd?.(error);
    if (classified) return finish(classified);
    if (signal.aborted) return finish({ kind: "aborted-exception" });
    throw error;
  }
}

/** Borrow actual command registries and observe source lifecycle settlements without batch reconstruction. */
export function nativeLifecycleCommandRegistry(options: {
  registry: HookRegistryLike;
  runOptions(): Omit<HookRunOptions, "signal" | "validateUpdatedInput">;
  facts(
    result: Readonly<HookResult>,
    context: { background: boolean; hook: Readonly<CommandHook> },
  ): NativeLifecycleCommandFacts;
}): NativeLifecycleRunner {
  return {
    async run(input, signal, onResult) {
      if (
        input.hook_event_name !== "SessionStart" &&
        input.hook_event_name !== "Stop" &&
        input.hook_event_name !== "UserPromptSubmit"
      )
        throw new Error("Unsupported actual lifecycle command event");
      const runOptions = options.runOptions(),
        observed = new Set<HookResult>();
      const batch: HookBatchResult = await options.registry
        .run(registryInput(input), {
          ...runOptions,
          signal,
          onResult: (result, context) => {
            observed.add(result);
            const snapshotResult = frozen(result),
              snapshotContext = frozen(context);
            const capture = onResult(
              frozen({
                result: lifecycleResult(snapshotResult),
                ...snapshotContext,
                facts: options.facts(snapshotResult, snapshotContext),
              }),
            );
            let previous: void | Promise<void>;
            try {
              previous = runOptions.onResult?.(result, context);
            } catch (error) {
              previous = Promise.reject(error);
            }
            return Promise.allSettled([capture, previous]).then((settled) => {
              const errors = settled.flatMap((entry): unknown[] =>
                entry.status === "rejected" ? [entry.reason] : [],
              );
              if (errors.length)
                throw new NativeLifecycleCaptureError(
                  new AggregateError(
                    errors,
                    "Lifecycle result observer failed",
                  ),
                );
            });
          },
        })
        .catch((error: unknown) => {
          if (error instanceof AggregateError)
            throw new NativeLifecycleCaptureError(error);
          throw error;
        });
      if (
        batch.results.some((result) => !observed.has(result)) ||
        (batch.additionalContext.length > 0 && batch.results.length === 0)
      )
        throw new NativeLifecycleCaptureError(
          new Error(
            "Unobserved lifecycle batch results cannot reconstruct physical events",
          ),
        );
      return {
        backgroundIDs: batch.background.map((task) => task.id),
        cancelled: batch.cancelled,
      };
    },
  };
}

function lifecycleResult(
  result: Readonly<HookResult>,
): NativeLifecycleCommandResult {
  if (
    result.event !== "SessionStart" &&
    result.event !== "Stop" &&
    result.event !== "UserPromptSubmit"
  )
    throw new NativeLifecycleCaptureError(
      new Error("Wrong actual lifecycle command result"),
    );
  return { ...result, event: result.event };
}
function registryInput(input: NativeObject): HookInput {
  if (
    (input.hook_event_name !== "SessionStart" &&
      input.hook_event_name !== "Stop" &&
      input.hook_event_name !== "UserPromptSubmit") ||
    typeof input.session_id !== "string" ||
    typeof input.transcript_path !== "string" ||
    typeof input.cwd !== "string"
  )
    throw new Error("Missing actual lifecycle command input");
  const result: HookInput = {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
  };
  for (const [key, value] of Object.entries(input)) result[key] = value;
  return result;
}
