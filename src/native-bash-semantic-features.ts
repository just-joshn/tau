/** Complete source-backed semantic port; proofs: artifacts/native-bash-semantic-port.
 * Result metadata and v6e classifications require the separate native permission/security consumers. */
import { homedir } from "node:os";
import type { NativeBashSemanticHost } from "./native-bash-semantics.js";

export interface NativeBashSemanticEvent {
  eventName: string;
  metadata: { cmdLength: number; panic: boolean };
  async: boolean;
}
export interface NativeBashSemanticEventSink {
  logEvent(name: string, metadata: NativeBashSemanticEvent["metadata"]): void;
  logEventAsync(
    name: string,
    metadata: NativeBashSemanticEvent["metadata"],
  ): Promise<void>;
  keepsWholeEvents?(): boolean;
}
export interface NativeBashSemanticFeatureOptions {
  environment?: Readonly<Record<string, string | boolean | undefined>>;
  home?: () => string;
  cpuNow?: () => number;
}
/** Source-backed cp/Ae latch and semantic telemetry owner; no target application host is loaded. */
export function createNativeBashSemanticFeatures(
  options: NativeBashSemanticFeatureOptions = {},
) {
  const environment = options.environment ?? process.env;
  let scrubEnabledLatched: boolean | undefined;
  let eventQueue: NativeBashSemanticEvent[] = [];
  let sink: NativeBashSemanticEventSink | null = null;
  let droppedEventCount = 0;
  const enqueue = (event: NativeBashSemanticEvent): void => {
    if (eventQueue.length >= 1000) {
      eventQueue.shift();
      droppedEventCount++;
    }
    eventQueue.push(event);
  };
  const parseBoolean = (value: string | boolean | undefined): boolean => {
    if (!value) return false;
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(
      String(value).toLowerCase().trim(),
    );
  };
  const host: NativeBashSemanticHost = {
    subprocessEnvironmentScrubEnabled() {
      if (scrubEnabledLatched !== undefined) return scrubEnabledLatched;
      const value = parseBoolean(environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB);
      scrubEnabledLatched = value;
      return value;
    },
    logParseEvent(eventName, metadata) {
      if (sink === null) {
        enqueue({ eventName, metadata, async: false });
        return;
      }
      sink.logEvent(eventName, metadata);
    },
    cpuNow:
      options.cpuNow ??
      (() => {
        const { user, system } =
          process.threadCpuUsage?.() ?? process.cpuUsage();
        return (user + system) / 1000;
      }),
    home: options.home ?? homedir,
  };
  return {
    host,
    setScrubEnabledLatched(value: boolean | undefined): void {
      scrubEnabledLatched = value;
    },
    resetScrubLatch(): void {
      scrubEnabledLatched = undefined;
    },
    installEventSink(next: NativeBashSemanticEventSink): boolean {
      if (sink !== null) return false;
      sink = next;
      if (eventQueue.length > 0) {
        const queued = eventQueue;
        eventQueue = [];
        queueMicrotask(() => {
          for (const event of queued)
            if (event.async)
              void next.logEventAsync(event.eventName, event.metadata);
            else next.logEvent(event.eventName, event.metadata);
        });
      }
      return true;
    },
    keepsWholeEvents(): boolean {
      try {
        return sink?.keepsWholeEvents?.() ?? true;
      } catch {
        return true;
      }
    },
    async logParseEventAsync(
      eventName: string,
      metadata: NativeBashSemanticEvent["metadata"],
    ): Promise<void> {
      if (sink === null) {
        enqueue({ eventName, metadata, async: true });
        return;
      }
      await sink.logEventAsync(eventName, metadata);
    },
    pendingEvents(): readonly NativeBashSemanticEvent[] {
      return [...eventQueue];
    },
    droppedEventCount(): number {
      return droppedEventCount;
    },
  };
}
export type NativeBashSemanticFeatures = ReturnType<
  typeof createNativeBashSemanticFeatures
>;
