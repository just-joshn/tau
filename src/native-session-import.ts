import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  foldOrdinaryNativeResume,
  prepareNativePrintResume,
  type NativeResumeEntryResult,
} from "./native-resume-entry.js";
import { isNativeArray, isNativeObject } from "./native-session-codec.js";
import {
  materializeOrdinaryNativeResumeContext,
  resolveOrdinaryNativeResumeContextGates,
  selectOrdinaryNativeResumeHistory,
} from "./native-resume-context.js";
import { projectNativeToolContext } from "./native-tool-context.js";
import {
  createNativeContextClassifiers,
  nativeFirstPartyBaseUrl,
  parseNativeTriBoolean,
  requireOrdinaryNativeContextProjection,
  resolveNativeContextProjectionFlags,
} from "./native-context-classifiers.js";
import { resolveModelFacts } from "./reasoning.js";
import { triBoolean } from "./env-settings.js";
import { newSession, type Session } from "./session.js";
import type { Message } from "./types.js";

const MAX_BYTES = 32 * 1024 * 1024;

/** Explicit file import only; no native session-directory discovery or source writes. */
export async function importNativeSessionFile(options: {
  path: string;
  cwd: string;
  model: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<{ session: Session; native: NativeResumeEntryResult }> {
  const session = newSession(options.cwd, options.model);
  const env = options.env ?? process.env;
  const recovery = {
    callIdToolResults: true,
    descendantOrder: "depth-first" as const,
    timestampFallback: "reject" as const,
  };
  let contextualMessages: Message[] | undefined;
  const native = await prepareNativePrintResume(
    { resume: options.path },
    {
      workingDirectory: options.cwd,
      newSessionId: () => session.id,
      continueCandidates: async () => [],
      titleCandidates: async () => [],
      resolveSessionId: async () => undefined,
      liveBackgroundSessionIds: async () => new Set(),
      admitTranscript: ({ path, source }) =>
        source === "file" && path === resolve(options.cwd, options.path.trim()),
      readTranscript: async (path, signal) => {
        signal.throwIfAborted();
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await file.stat();
          if (!before.isFile() || before.size > MAX_BYTES)
            throw new Error(
              "Native transcript must be a regular file under 32 MiB",
            );
          const bytes = Buffer.alloc(before.size + 1);
          let size = 0;
          while (size < bytes.length) {
            signal.throwIfAborted();
            const result = await file.read(
              bytes,
              size,
              bytes.length - size,
              null,
            );
            if (!result.bytesRead) break;
            size += result.bytesRead;
          }
          const after = await file.stat();
          if (
            size !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            throw new Error("Native transcript changed while loading");
          return bytes.subarray(0, size);
        } finally {
          await file.close();
        }
      },
      // Supported local import requires a complete ordinary parent chain. It does
      // not guess native feature flags to repair broken/compacted transcripts.
      recovery,
      fold: async (document, signal) => {
        const hasContext = document.lines.some(
          ({ value }) =>
            isNativeObject(value) &&
            (value.type === "attachment" || value.type === "system"),
        );
        if (!hasContext) return foldOrdinaryNativeResume(document);
        // This direct local port has no native provider capability/cache host.
        // Explicit custom capability profiles need that host before import.
        if (
          Object.entries(env).some(
            ([key, value]) =>
              value &&
              /^ANTHROPIC_(?:DEFAULT_(?:FABLE|OPUS|SONNET|HAIKU)_MODEL|CUSTOM_MODEL_OPTION)_SUPPORTED_CAPABILITIES$/.test(
                key,
              ),
          )
        )
          throw new Error(
            "Native context import requires a resolved provider capability profile",
          );
        const host = (
          nodes: readonly import("./native-session-codec.js").NativeTranscriptNode[],
        ) => ({
          ...resolveOrdinaryNativeResumeContextGates(nodes, {
            canonicalModel: resolveModelFacts(options.model).canonical,
            forceMidConversationSystem:
              triBoolean(env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM) ===
              true,
            providerSystemOverride: undefined,
            cachedSystemTurns: undefined,
            // Source no-reader defaults for this local host; saved snapshot
            // precedence is resolved from the selected native chain above.
            replayPromptSnapshot: true,
            liveReminderFold: false,
            explicitReminderFold: undefined,
          }),
          withoutAttachmentHooks: true as const,
          admit: () => true,
        });
        const hasToolHistory = document.lines.some(({ value }) => {
          if (
            !isNativeObject(value) ||
            !isNativeObject(value.message) ||
            !isNativeArray(value.message.content)
          )
            return false;
          return value.message.content.some(
            (block) =>
              isNativeObject(block) &&
              (block.type === "tool_use" || block.type === "tool_result"),
          );
        });
        if (hasToolHistory) {
          // This CLI supplies no native poll consumer or tether state. Positive
          // opt-ins need those hosts before their projection can be replayed.
          if (
            parseNativeTriBoolean(env.CLAUDE_CODE_POLL_EVENTS) === true ||
            parseNativeTriBoolean(env.CLAUDE_CODE_TETHER_LIVE) === true ||
            parseNativeTriBoolean(env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE) ===
              true
          )
            throw new Error(
              "Native tool context requires its poll/tether/Code Mode capability host",
            );
          const selection = selectOrdinaryNativeResumeHistory(
            document,
            recovery,
          );
          const flags = resolveNativeContextProjectionFlags(
            selection.gateNodes,
            {
              replayFeature: true,
              explicitEchoWireToolInputs: undefined,
              humbleHammockEnv: parseNativeTriBoolean(
                env.CLAUDE_CODE_HUMBLE_HAMMOCK,
              ),
              tetherLiveOptIn: false,
              sessionEchoWireToolInputs: undefined,
              liveEchoWireToolInputs: false,
              liveEchoFlagSource: "fallback",
              stellarDriftEnv: parseNativeTriBoolean(
                env.CLAUDE_CODE_STELLAR_DRIFT,
              ),
              firstPartyBaseUrl: nativeFirstPartyBaseUrl({
                provider: "firstParty",
                baseUrl: env.ANTHROPIC_BASE_URL,
                assumeEnv: parseNativeTriBoolean(
                  env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL,
                ),
                assumeCache: false,
              }),
              liveApiBlockOrder: false,
              bareFork: false,
              querySource: "sdk",
              // Recorded ordinary context is planned successfully or rejected;
              // this importer has no exception-to-inline live rendering fallback.
              liveContextRendering: "announced",
              queryPhase: "ordinary-completed-new-query",
            },
          );
          requireOrdinaryNativeContextProjection(flags);
          // The ordinary provider projection still normalizes assistant order.
          // Native index sidecars need an end-to-end wire adapter before use.
          if (flags.echoApiBlockOrder)
            throw new Error(
              "Native context import requires its API block-index wire adapter",
            );
          const projected = await projectNativeToolContext(
            selection.documentForProjection,
            {
              selection: selection.historyOptions,
              host: host(selection.gateNodes),
              classifiers: createNativeContextClassifiers({
                systemTurns: false,
                pollEventsEnabled: false,
              }),
              echoApiBlockOrder: flags.echoApiBlockOrder,
              preserveTrailingThinking: flags.preserveTrailingThinking,
              signal,
            },
          );
          contextualMessages = projected.messages;
          return {
            documentForProjection: projected.documentForProjection,
            leafUuid: selection.selectedLeaf.uuid,
            transcriptSessionId: selection.transcriptSessionId,
            appliedCheckpoints: selection.checkpoints.length,
          };
        }
        const contextual = await materializeOrdinaryNativeResumeContext(
          document,
          { recovery, signal, host },
        );
        contextualMessages = contextual.messages;
        return contextual.fold;
      },
      maxBytes: MAX_BYTES,
    },
    options.signal,
  );
  if (!native) throw new Error("Expected an explicit native .jsonl transcript");
  if (native.agentSetting)
    throw new Error(
      "Restoring a native main-thread agent requires its definition host",
    );
  session.id = native.adoptedSessionId ?? session.id;
  session.messages = contextualMessages ?? native.messages;
  return { session, native };
}
