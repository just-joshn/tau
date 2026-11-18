import { dirname, isAbsolute, resolve } from "node:path";
import {
  decodeNativeSession,
  encodeNativeSessionRows,
  foldSupportedNativeMetadata,
  indexNativeSession,
  isNativeObject,
  type NativeSessionDocument,
  type NativeJson,
} from "./native-session-codec.js";
import {
  projectNativeHistory,
  type NativeHistoryOptions,
  type NativeHistoryProjection,
} from "./native-history-projection.js";
import type { Message } from "./types.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type NativeResumeTarget =
  | { kind: "file"; path: string; provisionalSessionId: string }
  | { kind: "id"; sessionId: string }
  | { kind: "title"; title: string }
  | { kind: "url"; url: string };
/** Native print entry trims the value before Iis; .jsonl precedes UUID/URL interpretation. */
export function parseNativeResumeTarget(
  value: string | true,
  newSessionId: () => string,
): NativeResumeTarget {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text)
    throw new Error(
      "--resume requires a session ID or title when used with --print",
    );
  if (text.toLowerCase().endsWith(".jsonl"))
    return Object.freeze({
      kind: "file",
      path: text,
      provisionalSessionId: newSessionId(),
    });
  if (uuid.test(text)) return Object.freeze({ kind: "id", sessionId: text });
  try {
    return Object.freeze({ kind: "url", url: new URL(text).href });
  } catch {
    return Object.freeze({ kind: "title", title: text });
  }
}
export interface NativeResumeCandidate {
  sessionId: string;
  transcriptPath: string;
  customTitle?: string;
  aiTitle?: string;
  modifiedAtMs: number;
  bookkeepingOnly?: boolean;
  superseded?: boolean;
  archived?: boolean;
  continuedInSessionId?: string;
  sessionKind?: string;
}
export function matchNativeResumeTitle(
  candidates: readonly NativeResumeCandidate[],
  title: string,
): readonly NativeResumeCandidate[] {
  const query = title.toLowerCase().trim(),
    matches = new Map<string, NativeResumeCandidate>();
  for (const candidate of candidates) {
    const name = (candidate.customTitle ?? candidate.aiTitle)
      ?.toLowerCase()
      .trim();
    if (!name || name !== query) continue;
    const previous = matches.get(candidate.sessionId);
    if (!previous || candidate.modifiedAtMs > previous.modifiedAtMs)
      matches.set(candidate.sessionId, candidate);
  }
  return Object.freeze(
    [...matches.values()].sort((a, b) => b.modifiedAtMs - a.modifiedAtMs),
  );
}
export type NativeContinueSelection =
  | { kind: "selected"; candidate: NativeResumeCandidate }
  | { kind: "none" }
  | { kind: "held-by-background"; sessionId: string };
/** Input order must be the host's native project/alias listing+hydration order, never invented here. */
export function selectNativeContinue(
  candidates: readonly NativeResumeCandidate[],
  liveBackgroundIds: ReadonlySet<string> | undefined,
  forkSession: boolean,
): NativeContinueSelection {
  for (const candidate of candidates) {
    if (candidate.bookkeepingOnly) continue;
    if (
      !forkSession &&
      candidate.continuedInSessionId !== undefined &&
      liveBackgroundIds?.has(candidate.continuedInSessionId)
    )
      return {
        kind: "held-by-background",
        sessionId: candidate.continuedInSessionId,
      };
    if (candidate.superseded || candidate.archived) continue;
    if (forkSession) return { kind: "selected", candidate };
    if (liveBackgroundIds?.has(candidate.sessionId)) continue;
    if (
      liveBackgroundIds === undefined &&
      (candidate.sessionKind || candidate.continuedInSessionId !== undefined)
    )
      continue;
    return { kind: "selected", candidate };
  }
  return { kind: "none" };
}
export function nativeSessionAdoption(
  sessionId: string | undefined,
  forkSession: boolean,
  registeredCustomId?: (id: string) => boolean,
): { adoptedSessionId: string | null; effectiveFork: boolean } {
  if (forkSession) return { adoptedSessionId: null, effectiveFork: true };
  if (sessionId === undefined)
    return { adoptedSessionId: null, effectiveFork: false };
  const safe =
    sessionId.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(sessionId) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(sessionId);
  const ordinaryCustom =
    /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(sessionId) &&
    registeredCustomId?.(sessionId) === true;
  return safe && (uuid.test(sessionId) || ordinaryCustom)
    ? { adoptedSessionId: sessionId, effectiveFork: false }
    : { adoptedSessionId: null, effectiveFork: true };
}
export function nativeRestoredAgentIntent(input: {
  resumedAgentSetting: string | undefined;
  mainThreadAgentType: string | undefined;
  blockedByHostMode: boolean;
  hasStreamingInput: boolean;
  explicitAgentFlag: string | undefined;
}): { attempt: boolean; loud: boolean } {
  if (
    !input.resumedAgentSetting ||
    input.mainThreadAgentType ||
    input.blockedByHostMode
  )
    return { attempt: false, loud: false };
  return input.hasStreamingInput
    ? { attempt: !input.explicitAgentFlag, loud: false }
    : { attempt: true, loud: true };
}

export interface NativeEntryFold {
  documentForProjection: NativeSessionDocument;
  leafUuid: string;
  transcriptSessionId: string;
  appliedCheckpoints: number;
}
/** Source aen's narrow no-compaction ordinary terminal-row/checkpoint case. Advanced folds remain explicit. */
export function foldOrdinaryNativeResume(
  document: NativeSessionDocument,
): NativeEntryFold {
  const index = indexNativeSession(document);
  let lastMain: string | undefined;
  if (
    index.diagnostics.some(
      (item) => item.code === "invalid-transcript-envelope",
    )
  )
    throw new Error("Malformed native envelopes require the full fold adapter");
  const checkpoints: { leaf: string; explicit: boolean }[] = [];
  for (const line of document.lines) {
    const row = line.value;
    if (!isNativeObject(row)) continue;
    if (row.type === "last-prompt") {
      if (
        row.rewound === true ||
        row.cutUuid !== undefined ||
        row.leafUuid === null ||
        typeof row.leafUuid !== "string" ||
        !row.leafUuid
      )
        throw new Error(
          "Native checkpoint/rewind requires the full fold adapter",
        );
      checkpoints.push({ leaf: row.leafUuid, explicit: row.explicit === true });
      continue;
    }
    if (
      typeof row.type === "string" &&
      ["system", "attachment"].includes(row.type)
    )
      throw new Error(
        "Native context/compaction rows require the full fold adapter",
      );
    if (
      (row.type === "user" || row.type === "assistant") &&
      row.isSidechain !== true &&
      typeof row.uuid === "string" &&
      index.nodes.has(row.uuid)
    )
      lastMain = row.uuid;
  }
  if (!lastMain) throw new Error("No native main-session conversation found");
  const leaf = index.nodes.get(lastMain);
  if (!leaf) throw new Error("No native main-session conversation found");
  if (typeof leaf.row.sessionId !== "string" || !leaf.row.sessionId)
    throw new Error("Native transcript has no session identity");
  const children = [...index.nodes.values()].filter(
    (node) => node.row.isSidechain !== true && node.parentUuid === lastMain,
  );
  if (children.length)
    throw new Error(
      "Native terminal-row descendant recovery requires the full fold adapter",
    );
  const finalCheckpoint = checkpoints.at(-1);
  if (finalCheckpoint && finalCheckpoint.leaf !== lastMain)
    throw new Error(
      "Native checkpoint branch selection requires the full fold adapter",
    );
  for (const checkpoint of checkpoints)
    if (!index.nodes.has(checkpoint.leaf))
      throw new Error("Native checkpoint references an absent row");
  // Only this already-applied checkpoint type is removed from the projection input.
  // Original document bytes, all metadata and its checkpoint records remain returned separately.
  const retained: NativeJson[] = document.lines.flatMap((line) =>
    line.kind === "record" &&
    line.value !== undefined &&
    !(isNativeObject(line.value) && line.value.type === "last-prompt")
      ? [line.value]
      : [],
  );
  const documentForProjection = checkpoints.length
    ? decodeNativeSession(encodeNativeSessionRows(retained), {
        parser: "source-line-fallback",
      })
    : document;
  return Object.freeze({
    documentForProjection,
    leafUuid: lastMain,
    transcriptSessionId: leaf.row.sessionId,
    appliedCheckpoints: checkpoints.length,
  });
}

export interface NativeResumeEntryOptions {
  workingDirectory: string;
  newSessionId: () => string;
  /** Already source-scoped/admitted native listings; this helper performs no personal directory scan. */
  continueCandidates(
    signal: AbortSignal,
  ): Promise<readonly NativeResumeCandidate[]>;
  titleCandidates(
    signal: AbortSignal,
  ): Promise<readonly NativeResumeCandidate[]>;
  resolveSessionId(
    id: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  liveBackgroundSessionIds(
    signal: AbortSignal,
  ): Promise<ReadonlySet<string> | undefined>;
  admitTranscript(input: {
    path: string;
    source: "file" | "id" | "title" | "continue";
    requestedSessionId: string | undefined;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  /** Caller supplies bounded stable read and canonical/symlink policy. No native disk lookup is inferred. */
  readTranscript(path: string, signal: AbortSignal): Promise<Uint8Array>;
  fold?(
    document: NativeSessionDocument,
    signal: AbortSignal,
  ): NativeEntryFold | Promise<NativeEntryFold>;
  recovery: NativeHistoryOptions["recovery"];
  registeredCustomSessionId?: (id: string) => boolean;
  maxBytes?: number;
}
export interface NativeResumeEntryRequest {
  continue?: boolean;
  resume?: string | true;
  forkSession?: boolean;
  resumeSessionAt?: string;
  resumeDropsTurn?: string;
  rewindFiles?: string;
}
export interface NativeResumeEntryResult {
  kind: "resumed";
  source: "file" | "id" | "title" | "continue";
  transcriptPath: string;
  originalDocument: NativeSessionDocument;
  projection: NativeHistoryProjection;
  messages: Message[];
  requestedSessionId: string | undefined;
  transcriptSessionId: string;
  adoptedSessionId: string | null;
  effectiveFork: boolean;
  appliedCheckpoints: number;
  /** Passive identity only: reading a foreign session never changes cwd or establishes workspace trust. */
  sessionProjectPath: string | undefined;
  relocatedCwd: string | undefined;
  agentSetting: string | undefined;
  /** Jb's adopted native writer project-dir override; no cwd change or writer action is performed. */
  storageProjectDirectory: string | undefined;
}
export async function prepareNativePrintResume(
  request: NativeResumeEntryRequest,
  options: NativeResumeEntryOptions,
  signal: AbortSignal,
): Promise<NativeResumeEntryResult | undefined> {
  if (
    request.resumeSessionAt !== undefined ||
    request.resumeDropsTurn !== undefined ||
    request.rewindFiles !== undefined
  )
    throw new Error(
      "Native resume clipping/file rewind requires the complete entry host",
    );
  if (!isAbsolute(options.workingDirectory))
    throw new TypeError("Explicit absolute native resume cwd is required");
  signal.throwIfAborted();
  let path: string | undefined,
    requestedSessionId: string | undefined,
    source: NativeResumeEntryResult["source"] | undefined;
  let live: ReadonlySet<string> | undefined;
  if (request.continue) {
    const [candidates, ids] = await Promise.all([
      options.continueCandidates(signal),
      options.liveBackgroundSessionIds(signal),
    ]);
    live = ids;
    const selection = selectNativeContinue(
      candidates,
      live,
      request.forkSession === true,
    );
    if (selection.kind === "held-by-background")
      throw new Error(
        `Native session is held by a background session: ${selection.sessionId}`,
      );
    if (selection.kind === "selected") {
      path = selection.candidate.transcriptPath;
      requestedSessionId = selection.candidate.sessionId;
      source = "continue";
    }
  }
  const resolveSessionPath = async (
    sessionId: string,
  ): Promise<string | undefined> => {
    if (!request.forkSession) {
      const ids = await options.liveBackgroundSessionIds(signal);
      if (ids?.has(sessionId))
        throw new Error(
          `Native session is held by a background session: ${sessionId}`,
        );
    }
    return options.resolveSessionId(sessionId, signal);
  };
  if (!source && request.resume) {
    const target = parseNativeResumeTarget(
      request.resume,
      options.newSessionId,
    );
    if (target.kind === "url")
      throw new Error("Native URL resume requires the remote hydration host");
    if (target.kind === "file") {
      path = resolve(options.workingDirectory, target.path);
      requestedSessionId = undefined;
      source = "file";
      // Native checks the provisional file ID before loading the actual tail ID.
      if (!request.forkSession) {
        const ids = await options.liveBackgroundSessionIds(signal);
        if (ids?.has(target.provisionalSessionId))
          throw new Error(
            `Native session is held by a background session: ${target.provisionalSessionId}`,
          );
      }
    } else if (target.kind === "id") {
      requestedSessionId = target.sessionId;
      source = "id";
      path = await resolveSessionPath(target.sessionId);
    } else {
      const matches = matchNativeResumeTitle(
        await options.titleCandidates(signal),
        target.title,
      );
      if (matches.length > 1)
        throw new Error(
          `Native resume title is ambiguous; use a session ID: ${matches.map((candidate) => candidate.sessionId).join(", ")}`,
        );
      const [match] = matches;
      if (!match || !uuid.test(match.sessionId))
        throw new Error("Native resume target not found");
      requestedSessionId = match.sessionId;
      source = "title";
      path = await resolveSessionPath(match.sessionId);
    }
  }
  if (!source) return;
  if (!path) throw new Error("Native resume transcript not found");
  path = resolve(options.workingDirectory, path);
  if (
    !(await options.admitTranscript({
      path,
      source,
      requestedSessionId,
      signal,
    }))
  )
    throw new Error("Native transcript admission denied");
  signal.throwIfAborted();
  const bytes = await options.readTranscript(path, signal);
  const originalDocument = decodeNativeSession(bytes, {
    parser: "source-line-fallback",
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const folded = await (options.fold
    ? options.fold(originalDocument, signal)
    : foldOrdinaryNativeResume(originalDocument));
  const projection = projectNativeHistory(folded.documentForProjection, {
    leafUuid: folded.leafUuid,
    scope: { kind: "main", sessionId: folded.transcriptSessionId },
    recovery: options.recovery,
  });
  const metadata = foldSupportedNativeMetadata(originalDocument);
  const value = (type: string): string | undefined => {
    const result = metadata.valuesByTypeAndSession
      .get(type)
      ?.get(folded.transcriptSessionId);
    return typeof result === "string" ? result : undefined;
  };
  const first = projection.nodes[0]?.row.cwd,
    relocatedCwd = value("relocated");
  const sessionProjectPath =
    relocatedCwd ?? (typeof first === "string" ? first : undefined);
  // S0e uses requested UUID identity for id/title/continue; file input adopts the actual tail identity.
  const actualIdentity =
    source === "file" ? folded.transcriptSessionId : requestedSessionId;
  const adoption = nativeSessionAdoption(
    actualIdentity,
    request.forkSession === true,
    options.registeredCustomSessionId,
  );
  signal.throwIfAborted();
  return Object.freeze({
    kind: "resumed",
    source,
    transcriptPath: path,
    originalDocument,
    projection,
    messages: projection.messages,
    requestedSessionId,
    transcriptSessionId: folded.transcriptSessionId,
    ...adoption,
    appliedCheckpoints: folded.appliedCheckpoints,
    sessionProjectPath,
    relocatedCwd,
    agentSetting: value("agent-setting"),
    storageProjectDirectory: adoption.adoptedSessionId
      ? dirname(path)
      : undefined,
  });
}
