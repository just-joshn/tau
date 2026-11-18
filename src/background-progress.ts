import type { ProviderStreamProgress } from "./types.js";
import { contextUsage } from "./context-usage.js";

/** Source NNr/$Nr/FNr accounting keeps stamped usage distinct from later transcript usage. */
export function createBackgroundProgressMeter(
  options: { now?(): number; intervalMs?(): number } = {},
) {
  let observed = false,
    active = false,
    estimated = 0,
    emitted = 0,
    startEstimate = 0,
    blockThinking = 0,
    lastSent = 0;
  let latestInputTokens = 0,
    cumulativeOutputTokens = 0,
    streamedTokenEstimate = 0,
    lastResponseId: string | undefined;
  const flush = (force = false) => {
    const now = options.now?.() ?? Date.now(),
      interval = options.intervalMs?.() ?? 500;
    if (!force && now - lastSent < interval) return;
    const delta = Math.floor(estimated) - emitted;
    if (delta > 0) {
      lastSent = now;
      emitted += delta;
      streamedTokenEstimate += delta;
    }
  };
  return {
    get observed() {
      return observed;
    },
    accept(event: ProviderStreamProgress): void {
      observed = true;
      switch (event.type) {
        case "response_start":
          if (active) streamedTokenEstimate -= emitted;
          else startEstimate = streamedTokenEstimate;
          active = true;
          estimated = 0;
          emitted = 0;
          blockThinking = 0;
          lastSent = 0;
          break;
        case "block_start":
          blockThinking = 0;
          break;
        case "length": {
          if (!Number.isFinite(event.chars) || event.chars < 0)
            throw new Error("Invalid streamed length");
          estimated += event.chars / 4;
          flush();
          break;
        }
        case "thinking_progress":
          if (!Number.isFinite(event.estimatedTokensDelta))
            throw new Error("Invalid thinking estimate");
          blockThinking += event.estimatedTokensDelta;
          estimated += event.estimatedTokensDelta;
          flush();
          break;
        case "thinking_signature": {
          if (!Number.isFinite(event.chars) || event.chars < 0)
            throw new Error("Invalid signature length");
          const tokens = Math.ceil(event.chars / 4);
          if (tokens > blockThinking) {
            estimated += tokens - blockThinking;
            blockThinking = tokens;
            flush();
          }
          break;
        }
        case "assistant": {
          const usage = contextUsage(event.usage);
          latestInputTokens =
            usage.input_tokens +
            usage.cache_creation_input_tokens +
            usage.cache_read_input_tokens;
          cumulativeOutputTokens += usage.output_tokens;
          if (event.responseId !== lastResponseId) {
            lastResponseId = event.responseId;
            streamedTokenEstimate -= startEstimate;
            startEstimate = 0;
          }
          break;
        }
        case "response_end":
          flush(true);
          active = false;
          break;
      }
    },
    snapshot() {
      return {
        latestInputTokens,
        cumulativeOutputTokens,
        streamedTokenEstimate,
        usageSource: "stream-stamped" as const,
      };
    },
  };
}
