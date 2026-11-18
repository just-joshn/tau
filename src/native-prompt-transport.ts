import { isDeepStrictEqual } from "node:util";
import { captureNativePersistenceJson } from "./native-persistence-events.js";
import {
  prepareNativePromptRequest,
  type NativePromptRequestInput,
  type NativePromptRequestPlan,
} from "./native-prompt-request.js";
import {
  isNativeArray,
  isNativeObject,
  type NativeObject,
} from "./native-session-codec.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";

export interface NativePromptTransportAttempt {
  readonly requestedModel: string;
  readonly wireModel: string;
  readonly transport: "stream" | "json";
  readonly currentSystem: string;
  /** Actual current definitions before provider cache stripping/serialization. */
  readonly currentTools: readonly NativeObject[];
  readonly disablePromptCaching: boolean;
}
export interface NativePromptTransportHost {
  /** Supplies real snapshot/render/gate facts; unknown branches remain unsupported. */
  prepare(
    actual: NativePromptTransportAttempt,
    signal: AbortSignal,
  ): NativePromptRequestInput | Promise<NativePromptRequestInput>;
  /** Earlier Ha declaration boundary, distinct from the final serialized tools. */
  onInlineToolsDeclared(
    declarations: NativePromptRequestPlan["inlineDeclarations"],
    actual: NativePromptTransportAttempt,
    signal: AbortSignal,
  ): void | Promise<void>;
}
export class NativePromptPreparationError extends Error {
  constructor(cause: unknown) {
    super("Native prompt request preparation failed", { cause });
    this.name = "NativePromptPreparationError";
  }
}

/** Apply the source-backed replay plan before body serialization or transport accounting. */
export async function prepareNativePromptForTransport(
  host: NativePromptTransportHost,
  actual: Omit<NativePromptTransportAttempt, "currentTools"> & {
    currentTools: readonly unknown[];
  },
  signal: AbortSignal,
): Promise<NativePromptRequestPlan> {
  signal.throwIfAborted();
  try {
    const captured = snapshotNativeResponseJson(
      captureNativePersistenceJson(actual),
    );
    if (
      !isNativeObject(captured) ||
      !isNativeArray(captured.currentTools) ||
      !captured.currentTools.every(isNativeObject)
    )
      throw new TypeError(
        "Current native prompt definitions require actual plain objects",
      );
    const attempt: NativePromptTransportAttempt = Object.freeze({
      requestedModel: actual.requestedModel,
      wireModel: actual.wireModel,
      transport: actual.transport,
      currentSystem: actual.currentSystem,
      currentTools: captured.currentTools,
      disablePromptCaching: actual.disablePromptCaching,
    });
    const supplied = await host.prepare(attempt, signal);
    signal.throwIfAborted();
    if (
      supplied.attempt.requestedModel !== attempt.requestedModel ||
      supplied.attempt.wireModel !== attempt.wireModel ||
      supplied.attempt.transport !== attempt.transport ||
      !isDeepStrictEqual(
        supplied.currentTools.map((tool) => tool.baseEntry),
        attempt.currentTools,
      )
    )
      throw new Error(
        "Native prompt facts do not describe this attempt's actual current render vector",
      );
    const prepared = prepareNativePromptRequest(supplied);
    if (prepared.status !== "prepared")
      throw new Error(prepared.reasons.join("; "));
    const plan = prepared.plan;
    if (
      attempt.disablePromptCaching &&
      (plan.system.some((block) => block.cache_control !== undefined) ||
        plan.tools.some((tool) => tool.cache_control !== undefined))
    )
      throw new Error("Native prompt plan contradicts actual cache disabling");
    await host.onInlineToolsDeclared(plan.inlineDeclarations, attempt, signal);
    signal.throwIfAborted();
    return plan;
  } catch (error) {
    signal.throwIfAborted();
    throw new NativePromptPreparationError(error);
  }
}
