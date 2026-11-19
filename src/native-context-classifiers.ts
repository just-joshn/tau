import { createHash } from "node:crypto";
import {
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeObject,
  type NativeTranscriptNode,
} from "./native-session-codec.js";
import { NativeResumeContextError } from "./native-resume-context.js";
import {
  classifyNativeToolResult,
  isNativePollEventText,
  type NativeToolContextClassifiers,
  type NativeToolTextPlacement,
} from "./native-tool-context.js";

export interface NativeTextFingerprint {
  units: number;
  sha256: string;
}
export interface NativeContextConstants {
  backgroundEqualities: readonly NativeTextFingerprint[];
  announcementBodyPrefixes: readonly NativeTextFingerprint[];
  coordinatorBodyPrefix: NativeTextFingerprint;
  coordinatorAnswerBodyPrefix: NativeTextFingerprint;
  isolationEqualities: readonly NativeTextFingerprint[];
  voiceHeaderBodyPrefix: NativeTextFingerprint;
  voiceRecordWrappedPrefix: NativeTextFingerprint;
  firstLineBodyPrefix: NativeTextFingerprint;
  lowDiskBodyPrefix: NativeTextFingerprint;
  systemFileBodyPrefixes: readonly NativeTextFingerprint[];
}
/** Pinned source string fingerprints: recognize protocol text without copying guidance templates. */
export const NATIVE_2_1_326_CONTEXT_CONSTANTS: NativeContextConstants = {
  backgroundEqualities: [
    {
      units: 435,
      sha256:
        "0b2ab19fa11632b4c89adb51da970d0a7abbccd52e1aa804742bda219346b04e",
    },
    {
      units: 497,
      sha256:
        "5fd38d7c912cf9654912025f68cd0776075a5ec6ac62e2092de3ca40d067df17",
    },
  ],
  announcementBodyPrefixes: [
    {
      units: 16,
      sha256:
        "f0ece5e6f21df31e1837a4d51c0be13cb4639842d3261777ed8afdf6a2ee0e11",
    },
    {
      units: 184,
      sha256:
        "0202310221e63befe73cacc2d5ab7308652e1c5185d33280503a625c1cb8b711",
    },
    {
      units: 69,
      sha256:
        "4d38e4d7a73328463a5efa37ca08130acde604e4b837c9850921a15626fc6823",
    },
    {
      units: 94,
      sha256:
        "a5130aee58d6b02e39c5889aaaa1b2cf8ed70665248f4babf69def7a821128ad",
    },
    {
      units: 792,
      sha256:
        "e37073f45f9928dc23633183c9f9561d0bee5318edc6462835aa51bc28d92fd3",
    },
  ],
  coordinatorBodyPrefix: {
    units: 359,
    sha256: "43f5772419b35de3c5ea44c897f783a414aec968c7c0f94ec1fbe1b0c9b715c8",
  },
  coordinatorAnswerBodyPrefix: {
    units: 112,
    sha256: "cefd62d97daf7ef0ae5af682ebcfe5380d233874a28399c6f83ae0ebd527851f",
  },
  isolationEqualities: [
    {
      units: 514,
      sha256:
        "8d9d6f02f2282c5cae1b844182fb57a8d029e95a9f14b57302c18ad95a899d6c",
    },
    {
      units: 325,
      sha256:
        "03e88ea572c43447483e87d6a04e7e191e034e4cf55cf4f17e1c848ffd40618a",
    },
  ],
  voiceHeaderBodyPrefix: {
    units: 42,
    sha256: "80509182bc4ed0ec56c66d81858a75430fad2c399c97a9e424d1ed46a6892851",
  },
  voiceRecordWrappedPrefix: {
    units: 1101,
    sha256: "377eb6057b543e56733de8f14a1c53559ff7ea05a63f8ed7aff15b027ad46859",
  },
  firstLineBodyPrefix: {
    units: 68,
    sha256: "23e879c85de876458f3fdf0feb92084dbc85d89a05f90c6233794d375dabc6c4",
  },
  lowDiskBodyPrefix: {
    units: 19,
    sha256: "81a48d3ebed0c3775afc49946a62de7b1119ae546ff8d0755067a0e56e28141d",
  },
  systemFileBodyPrefixes: [
    {
      units: 58,
      sha256:
        "fc945ac64b9054a3cd8e6360d6f90799a6d255caa95da6de7b011fd3ceb2eed4",
    },
    {
      units: 106,
      sha256:
        "f94c26b00cfefa5a86d6aebe3f6f7732f4c7b7cc5d68153d7878447f248542c7",
    },
  ],
};
const OPEN = "<system-reminder>",
  CLOSE = "</system-reminder>",
  HEAD = `${OPEN}\n`;
function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function prefix(text: string, expected: NativeTextFingerprint): boolean {
  return (
    text.length >= expected.units &&
    fingerprint(text.slice(0, expected.units)) === expected.sha256
  );
}
function equal(text: string, expected: NativeTextFingerprint): boolean {
  return (
    text.length === expected.units && fingerprint(text) === expected.sha256
  );
}
/** Flo/yet: exact lowercase 16..32 hex ID and the required immediate newline. */
export function hasNativeReminderId(text: string): boolean {
  return /^<system-reminder id="[0-9a-f]{16,32}">\n/.test(text);
}
/** XTe: a sequence of complete plain reminder elements with no nested plain opening. */
export function isNativeCompleteReminderSequence(text: string): boolean {
  let remaining = text.trimEnd();
  if (!remaining.length) return false;
  while (remaining.length) {
    if (!remaining.startsWith(OPEN)) return false;
    const end = remaining.indexOf(CLOSE, OPEN.length);
    if (end === -1 || remaining.slice(OPEN.length, end).includes(OPEN))
      return false;
    remaining = remaining.slice(end + CLOSE.length).trimStart();
  }
  return true;
}
/** eUt, whose plain opening is deliberately distinct from an ID-bearing reminder. */
export function isNativeDirectEventReminder(text: string): boolean {
  return (
    text.startsWith(HEAD) && isNativePollEventText(text.slice(HEAD.length))
  );
}
/** DBt, including all shipped prefix/equality guards and its explicit system-turn branch. */
export function isNativeProtectedContextText(
  text: string,
  systemTurns: boolean,
  constants: NativeContextConstants = NATIVE_2_1_326_CONTEXT_CONSTANTS,
): boolean {
  if (text.startsWith(HEAD)) {
    if (
      constants.backgroundEqualities.some((value) =>
        equal(text.trimEnd(), value),
      )
    )
      return true;
    const body = text.slice(HEAD.length);
    if (constants.announcementBodyPrefixes.some((value) => prefix(body, value)))
      return true;
    if (
      prefix(body, constants.coordinatorBodyPrefix) &&
      !text.includes(
        "<cited ",
        HEAD.length + constants.coordinatorBodyPrefix.units,
      )
    )
      return true;
    if (
      prefix(body, constants.voiceHeaderBodyPrefix) ||
      prefix(body, constants.firstLineBodyPrefix) ||
      prefix(body, constants.lowDiskBodyPrefix)
    )
      return true;
    if (
      systemTurns &&
      constants.systemFileBodyPrefixes.some((value) => prefix(body, value))
    )
      return true;
  }
  if (
    (text.startsWith(OPEN) || hasNativeReminderId(text)) &&
    prefix(
      text.slice(text.indexOf("\n") + 1),
      constants.coordinatorAnswerBodyPrefix,
    )
  )
    return true;
  if (
    constants.isolationEqualities.some((value) => equal(text.trimEnd(), value))
  )
    return true;
  if (prefix(text, constants.voiceRecordWrappedPrefix)) return true;
  return systemTurns && hasNativeReminderId(text);
}
export function classifyNativeContextText(
  text: string,
  systemTurns: boolean,
  constants: NativeContextConstants = NATIVE_2_1_326_CONTEXT_CONSTANTS,
): NativeToolTextPlacement {
  if (isNativeProtectedContextText(text, systemTurns, constants)) {
    const firstLine =
      text.startsWith(HEAD) &&
      prefix(text.slice(HEAD.length), constants.firstLineBodyPrefix);
    return firstLine && !isNativeCompleteReminderSequence(text)
      ? "beside"
      : "beside-reorderable";
  }
  return isNativeDirectEventReminder(text) ? "direct-event" : "ordinary";
}
export function createNativeContextClassifiers(options: {
  systemTurns: boolean;
  /** Effective Jx capability, supplied by the actual host. */
  pollEventsEnabled: boolean;
  constants?: NativeContextConstants;
}): NativeToolContextClassifiers {
  if (
    typeof options.systemTurns !== "boolean" ||
    typeof options.pollEventsEnabled !== "boolean"
  )
    throw new NativeResumeContextError(
      "unsupported-native-classifier-feature-facts",
    );
  return {
    result: ({ result }) =>
      classifyNativeToolResult(result, options.pollEventsEnabled),
    text: ({ text }) =>
      classifyNativeContextText(text, options.systemTurns, options.constants),
  };
}

interface SnapshotFlags {
  valid: boolean;
  echoWireToolInputs?: boolean;
  contextRendering?: "announced" | "inline";
}
function snapshotFlags(value: NativeObject): SnapshotFlags {
  if (
    !isNativeArray(value.systemPrompt) ||
    !value.systemPrompt.every((item) => typeof item === "string")
  )
    return { valid: false };
  if (value.cliPrefix !== undefined && typeof value.cliPrefix !== "string")
    return { valid: false };
  if (value.tools !== undefined) {
    if (!isNativeArray(value.tools)) return { valid: false };
    for (const tool of value.tools)
      if (
        !isNativeObject(tool) ||
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        (tool.server !== undefined && typeof tool.server !== "string") ||
        (tool.schema !== undefined && !isNativeObject(tool.schema))
      )
        return { valid: false };
  }
  return {
    valid: true,
    ...(typeof value.echoWireToolInputs === "boolean"
      ? { echoWireToolInputs: value.echoWireToolInputs }
      : {}),
    ...(value.contextRendering === "announced" ||
    value.contextRendering === "inline"
      ? { contextRendering: value.contextRendering }
      : {}),
  };
}
const SESSION_KEYS = new Set([
  "userEmail",
  "attachedProject",
  "gitStatus",
  "perforceMode",
]);
function validSessionContext(value: NativeJson | undefined): boolean {
  return (
    isNativeObject(value) &&
    Object.entries(value).every(
      ([key, item]) => SESSION_KEYS.has(key) && typeof item === "string",
    )
  );
}
export interface NativeContextProjectionFacts {
  /** Effective tu()/foamy-spring feature reader, not inferred from account/environment. */
  replayFeature: boolean;
  explicitEchoWireToolInputs: boolean | undefined;
  humbleHammockEnv: boolean | undefined;
  /** Effective vve(), including its native session cache/provider/capability guards. */
  tetherLiveOptIn: boolean;
  sessionEchoWireToolInputs: boolean | undefined;
  liveEchoWireToolInputs: boolean;
  liveEchoFlagSource: "fallback" | "configured";
  stellarDriftEnv: boolean | undefined;
  /** Effective As(): selected first-party provider and official/assumed base URL. */
  firstPartyBaseUrl: boolean;
  liveApiBlockOrder: boolean;
  bareFork: boolean;
  querySource: string;
  /** Actual Ji live renderer outcome when neither saved profile applies. */
  liveContextRendering: "announced" | "inline" | undefined;
  queryPhase:
    "ordinary-completed-new-query" | "interrupted-resume" | "in-query-recovery";
}
export interface NativeContextProjectionFlags {
  echoWireToolInputs: boolean;
  echoWireSource:
    "explicit" | "forced" | "saved-snapshot" | "session-cache" | "live";
  echoApiBlockOrder: boolean;
  apiBlockOrderSource: "environment" | "tether" | "non-first-party" | "live";
  preserveTrailingThinking: false;
  contextRendering: "announced" | "inline" | undefined;
  contextRenderingSource:
    "saved-snapshot" | "session-context" | "live" | "bare-fork";
  snapshotUuid: string | undefined;
  promptRenderPointAfterSnapshot: boolean;
  /** Proposed native ??=/configured-flag pin only; the helper never mutates session state. */
  cacheUpdates: { echoWireToolInputs?: boolean };
}

/** HA/Lx/W_o/bg for an ordinary completed NEW query; flags are not interchangeable. */
export function resolveNativeContextProjectionFlags(
  nodes: readonly NativeTranscriptNode[],
  facts: NativeContextProjectionFacts,
): NativeContextProjectionFlags {
  for (const value of [
    facts.replayFeature,
    facts.tetherLiveOptIn,
    facts.liveEchoWireToolInputs,
    facts.firstPartyBaseUrl,
    facts.liveApiBlockOrder,
    facts.bareFork,
  ])
    if (typeof value !== "boolean")
      throw new NativeResumeContextError(
        "unsupported-native-projection-feature-facts",
      );
  for (const value of [
    facts.explicitEchoWireToolInputs,
    facts.humbleHammockEnv,
    facts.sessionEchoWireToolInputs,
    facts.stellarDriftEnv,
  ])
    if (value !== undefined && typeof value !== "boolean")
      throw new NativeResumeContextError(
        "unsupported-native-projection-feature-facts",
      );
  if (
    (facts.liveEchoFlagSource !== "fallback" &&
      facts.liveEchoFlagSource !== "configured") ||
    typeof facts.querySource !== "string" ||
    (facts.liveContextRendering !== undefined &&
      facts.liveContextRendering !== "announced" &&
      facts.liveContextRendering !== "inline")
  )
    throw new NativeResumeContextError(
      "unsupported-native-projection-feature-facts",
    );
  if (facts.queryPhase !== "ordinary-completed-new-query")
    throw new NativeResumeContextError("unsupported-thinking-resume-profile");
  const snapshotIndex = nodes.findLastIndex(
    (node) =>
      node.type === "attachment" &&
      isNativeObject(node.row.attachment) &&
      node.row.attachment.type === "prompt_snapshot",
  );
  const pointIndex = nodes.findLastIndex(
    (node) =>
      node.type === "attachment" &&
      isNativeObject(node.row.attachment) &&
      node.row.attachment.type === "prompt_render_point",
  );
  const snapshot = nodes[snapshotIndex];
  const raw =
    snapshot && isNativeObject(snapshot.row.attachment)
      ? snapshot.row.attachment
      : undefined;
  const saved = raw ? snapshotFlags(raw) : { valid: false };
  const activeSaved = facts.replayFeature && saved.valid ? saved : undefined;
  const forced =
    facts.humbleHammockEnv ?? (facts.tetherLiveOptIn ? true : undefined);
  const cacheUpdates: NativeContextProjectionFlags["cacheUpdates"] = {};
  let echoWireToolInputs: boolean,
    echoWireSource: NativeContextProjectionFlags["echoWireSource"];
  if (facts.explicitEchoWireToolInputs !== undefined) {
    echoWireToolInputs = facts.explicitEchoWireToolInputs;
    echoWireSource = "explicit";
  } else if (activeSaved?.echoWireToolInputs !== undefined) {
    echoWireToolInputs = forced ?? activeSaved.echoWireToolInputs;
    echoWireSource = forced !== undefined ? "forced" : "saved-snapshot";
    if (forced === undefined && facts.sessionEchoWireToolInputs === undefined)
      cacheUpdates.echoWireToolInputs = activeSaved.echoWireToolInputs;
  } else if (forced !== undefined) {
    echoWireToolInputs = forced;
    echoWireSource = "forced";
  } else if (facts.sessionEchoWireToolInputs !== undefined) {
    echoWireToolInputs = facts.sessionEchoWireToolInputs;
    echoWireSource = "session-cache";
  } else {
    echoWireToolInputs = facts.liveEchoWireToolInputs;
    echoWireSource = "live";
    if (facts.replayFeature && facts.liveEchoFlagSource !== "fallback")
      cacheUpdates.echoWireToolInputs = facts.liveEchoWireToolInputs;
  }
  let echoApiBlockOrder: boolean,
    apiBlockOrderSource: NativeContextProjectionFlags["apiBlockOrderSource"];
  if (facts.stellarDriftEnv !== undefined) {
    echoApiBlockOrder = facts.stellarDriftEnv;
    apiBlockOrderSource = "environment";
  } else if (facts.tetherLiveOptIn) {
    echoApiBlockOrder = true;
    apiBlockOrderSource = "tether";
  } else if (!facts.firstPartyBaseUrl) {
    echoApiBlockOrder = false;
    apiBlockOrderSource = "non-first-party";
  } else {
    echoApiBlockOrder = facts.liveApiBlockOrder;
    apiBlockOrderSource = "live";
  }
  let contextRendering: NativeContextProjectionFlags["contextRendering"],
    contextRenderingSource: NativeContextProjectionFlags["contextRenderingSource"];
  if (facts.bareFork && facts.querySource !== "resume_cache_warm") {
    contextRendering = undefined;
    contextRenderingSource = "bare-fork";
  } else if (activeSaved?.contextRendering !== undefined) {
    contextRendering = activeSaved.contextRendering;
    contextRenderingSource = "saved-snapshot";
  } else {
    const contextNode = nodes.findLast(
      (node) =>
        node.type === "attachment" &&
        isNativeObject(node.row.attachment) &&
        node.row.attachment.type === "session_context",
    );
    const context =
      contextNode && isNativeObject(contextNode.row.attachment)
        ? contextNode.row.attachment.context
        : undefined;
    if (facts.replayFeature && validSessionContext(context)) {
      contextRendering = "announced";
      contextRenderingSource = "session-context";
    } else {
      contextRendering = facts.liveContextRendering;
      contextRenderingSource = "live";
    }
  }
  return {
    echoWireToolInputs,
    echoWireSource,
    echoApiBlockOrder,
    apiBlockOrderSource,
    preserveTrailingThinking: false,
    contextRendering,
    contextRenderingSource,
    snapshotUuid: snapshot?.uuid,
    promptRenderPointAfterSnapshot: pointIndex > snapshotIndex,
    cacheUpdates,
  };
}

/** Binding guard for current ordinary announced-context import, without live/wire-prompt reconstruction. */
export function requireOrdinaryNativeContextProjection(
  flags: NativeContextProjectionFlags,
): void {
  if (flags.echoWireToolInputs)
    throw new NativeResumeContextError("unsupported-native-wire-input-echo");
  if (flags.contextRendering !== "announced")
    throw new NativeResumeContextError(
      "unsupported-native-context-rendering-profile",
    );
  if (flags.promptRenderPointAfterSnapshot)
    throw new NativeResumeContextError(
      "unsupported-native-prompt-render-point",
    );
  if (flags.preserveTrailingThinking !== false)
    throw new NativeResumeContextError("unsupported-thinking-resume-profile");
}

/** Native N.triBool/Ae/bs data parsing; never JS truthiness of a string such as "false". */
export function parseNativeTriBoolean(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return;
}
/** As/Ki/wz/pc/Ql, with provider and cache state supplied rather than discovered. */
export function nativeFirstPartyBaseUrl(input: {
  provider: string;
  baseUrl: string | undefined;
  assumeEnv: boolean | undefined;
  assumeCache: boolean;
}): boolean {
  if (
    typeof input.provider !== "string" ||
    typeof input.assumeCache !== "boolean" ||
    (input.assumeEnv !== undefined && typeof input.assumeEnv !== "boolean")
  )
    throw new NativeResumeContextError("unsupported-native-provider-facts");
  if (input.provider !== "firstParty") return false;
  if (input.assumeEnv ?? input.assumeCache) return true;
  if (!input.baseUrl) return true;
  try {
    return new URL(input.baseUrl).host === "api.anthropic.com";
  } catch {
    return false;
  }
}
