import { isNativeObject, type NativeObject } from "./native-session-codec.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";

export interface NativePreparedRequest {
  readonly transport: "stream" | "json";
  readonly requestedModel: string;
  readonly wireModel: string;
  readonly body: NativeObject;
  readonly byteLength: number;
}
export type NativePreparedRequestHost = (
  request: NativePreparedRequest,
) => void | Promise<void>;

export class NativeRequestCaptureError extends Error {
  constructor(cause: unknown) {
    super("Native request creation capture failed", { cause });
    this.name = "NativeRequestCaptureError";
  }
}

/** Observe exactly the serialized body about to be sent, before transport/budget begins. */
export async function captureNativePreparedRequest(
  host: NativePreparedRequestHost,
  serialized: string,
  requestedModel: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  try {
    const parsed: unknown = JSON.parse(serialized),
      body = snapshotNativeResponseJson(parsed);
    if (
      !isNativeObject(body) ||
      typeof body.model !== "string" ||
      typeof body.stream !== "boolean"
    )
      throw new TypeError("Actual provider request model/transport is missing");
    await host(
      Object.freeze({
        transport: body.stream ? "stream" : "json",
        requestedModel,
        wireModel: body.model,
        body,
        byteLength: Buffer.byteLength(serialized),
      }),
    );
  } catch (error) {
    signal.throwIfAborted();
    throw new NativeRequestCaptureError(error);
  }
  signal.throwIfAborted();
}
