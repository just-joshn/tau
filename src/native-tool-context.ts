import {
  decodeNativeSession,
  encodeNativeSessionRows,
  indexNativeSession,
  isNativeArray,
  isNativeObject,
  type NativeJson,
  type NativeSessionDocument,
  type NativeTranscriptNode,
} from "./native-session-codec.js";
import {
  projectNativeHistory,
  projectNativeHistoryForModelRequest,
  reconstructNativeHistory,
  type NativeHistoryOptions,
  type NativeHistoryProjection,
} from "./native-history-projection.js";
import {
  NativeResumeContextError,
  planNativeResumeContext,
  reorderNativeResumeContextNodes,
  type NativeResumeContextDisposition,
  type NativeResumeContextHost,
} from "./native-resume-context.js";
import {
  assistantBlockSchema,
  type ApiToolContent,
  type Message,
  type ToolResult,
  type ToolUse,
} from "./types.js";

type Block = Message["content"][number];
export type NativeToolTextPlacement =
  "ordinary" | "beside" | "beside-reorderable" | "direct-event" | "unsupported";
export interface NativeToolContextClassifiers {
  result(input: {
    result: ToolResult;
    owner: ToolUse | undefined;
  }): "ordinary" | "beside" | "unsupported";
  /** DBt/eUt classification, including the tUt&&!XTe trailing-text barrier. No default false. */
  text(input: {
    text: string;
    phase: "incoming" | "existing";
    uuid: string;
    nativeType: string | undefined;
    source: NativeResumeContextDisposition["source"] | undefined;
  }): NativeToolTextPlacement;
}
export interface NativeToolContextEvent {
  uuid: string;
  nativeType: string;
  placement:
    | "string-result"
    | "array-result"
    | "beside-result"
    | "user-blocks"
    | "system-local-command";
  toolUseId?: string;
  reorderedPastTextBlocks?: number;
}
export interface NativeToolContextProjection {
  originalDocument: NativeSessionDocument;
  documentForProjection: NativeSessionDocument;
  projection: NativeHistoryProjection;
  messages: Message[];
  messageSources: readonly (readonly string[])[];
  dispositions: readonly NativeResumeContextDisposition[];
  contextMergeEvents: readonly NativeToolContextEvent[];
  parentRewrites: readonly {
    uuid: string;
    from: string | null;
    to: string | null;
    skippedContext: readonly string[];
  }[];
  assistantBlockIndices: readonly {
    responseId: string;
    indices: readonly number[];
  }[];
  errorResultCleanups: readonly {
    toolUseId: string;
    removedNonTextBlocks: number;
    retainedTextBlocks: number;
  }[];
}
const fail = (code: string, uuid?: string): never => {
  throw new NativeResumeContextError(code, uuid);
};
const clone = <T>(value: T): T => structuredClone(value);

/** gGo/pGo/JYe/mGo/ZYe with the source Jx poll capability supplied explicitly. */
export function classifyNativeToolResult(
  result: ToolResult,
  pollEventsEnabled: boolean,
): "ordinary" | "beside" {
  if (
    [
      "poll_",
      "gettask_",
      "projectread_",
      "toolu_pdfread_",
      "voicecallrecord_",
    ].some((prefix) => result.tool_use_id.startsWith(prefix))
  )
    return "beside";
  if (
    pollEventsEnabled &&
    result.apiContent === undefined &&
    isNativePollEventText(result.content)
  )
    return "beside";
  return "ordinary";
}
export function isNativePollEventText(text: string): boolean {
  return (
    text.startsWith("<system>authentic event nonces for this delivery: ") ||
    text.startsWith("<event ") ||
    (text.startsWith("<tools-used-before-summary>") &&
      text.slice(text.indexOf("\n") + 1).startsWith("<event "))
  );
}
function escapedReminder(text: string): string {
  const prefix = "<system-reminder",
    next = text.charAt(prefix.length),
    code = next.charCodeAt(0);
  return text.startsWith(prefix) &&
    (/\s/.test(next) || (code >= 28 && code <= 31) || code === 133)
    ? `&lt;${text.slice(1)}`
    : text;
}
function summary(blocks: readonly ApiToolContent[]): string {
  return blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}
function withArray(result: ToolResult, blocks: ApiToolContent[]): ToolResult {
  return { ...result, content: summary(blocks), apiContent: blocks };
}
function toolsFirst(blocks: readonly Block[]): Block[] {
  return [
    ...blocks.filter((block) => block.type === "tool_result"),
    ...blocks.filter((block) => block.type !== "tool_result"),
  ];
}
function assistantOrder(blocks: readonly Block[]): Block[] {
  let seenTool = false,
    nonToolAfterTool = false,
    previousThinking = false,
    toolSinceNonTool = false,
    interleaved = false;
  for (const block of blocks) {
    if (block.type === "tool_use") {
      seenTool = true;
      toolSinceNonTool = true;
    } else {
      if (seenTool) nonToolAfterTool = true;
      const thinking =
        block.type === "thinking" || block.type === "redacted_thinking";
      if (thinking && previousThinking && toolSinceNonTool) interleaved = true;
      previousThinking = thinking;
      toolSinceNonTool = false;
    }
  }
  return !nonToolAfterTool || interleaved
    ? [...blocks]
    : [
        ...blocks.filter((block) => block.type !== "tool_use"),
        ...blocks.filter((block) => block.type === "tool_use"),
      ];
}
interface AssistantState {
  message: Message;
  indices?: number[];
  sources: string[];
}
function fragmentIndices(
  node: NativeTranscriptNode,
  length: number,
): number[] | undefined {
  if (typeof node.row.apiBlockIndex !== "number") return;
  if (!Number.isFinite(node.row.apiBlockIndex))
    return fail("invalid-native-api-block-index", node.uuid);
  const existing = node.row.apiBlockIndices;
  if (
    isNativeArray(existing) &&
    existing.length === length &&
    existing.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    return existing.map((value) =>
      typeof value === "number"
        ? value
        : fail("invalid-native-api-block-index", node.uuid),
    );
  return Array.from({ length }, () =>
    typeof node.row.apiBlockIndex === "number" ? node.row.apiBlockIndex : 0,
  );
}
function mergeAssistant(
  target: AssistantState,
  incoming: AssistantState,
  echoApiBlockOrder: boolean,
) {
  if (
    echoApiBlockOrder &&
    target.indices !== undefined &&
    incoming.indices !== undefined
  ) {
    const indexed = [
      ...target.message.content.map((block, i) => ({
        block,
        index: target.indices?.[i] ?? 0,
      })),
      ...incoming.message.content.map((block, i) => ({
        block,
        index: incoming.indices?.[i] ?? 0,
      })),
    ].sort((a, b) => a.index - b.index);
    target.message.content = indexed.map((entry) => entry.block);
    target.indices = indexed.map((entry) => entry.index);
  } else {
    const blocks = [...target.message.content, ...incoming.message.content];
    const filtered = blocks.filter((block, i) => {
      if (
        block.type !== "text" ||
        !block.text.length ||
        block.text.trim().length
      )
        return true;
      const before = blocks[i - 1],
        after = blocks[i + 1];
      return (
        (before?.type === "thinking" || before?.type === "redacted_thinking") &&
        (after?.type === "thinking" || after?.type === "redacted_thinking")
      );
    });
    const hasOrdinary = filtered.some(
      (block) =>
        block.type !== "thinking" && block.type !== "redacted_thinking",
    );
    target.message.content = assistantOrder(hasOrdinary ? filtered : blocks);
    delete target.indices;
  }
  target.sources.push(...incoming.sources);
}

/** Caller selects/folds history first. No leaf guessing, checkpoint repair or scope promotion. */
export async function projectNativeToolContext(
  document: NativeSessionDocument,
  options: {
    selection: NativeHistoryOptions;
    host:
      | NativeResumeContextHost
      | ((nodes: readonly NativeTranscriptNode[]) => NativeResumeContextHost);
    classifiers: NativeToolContextClassifiers;
    echoApiBlockOrder: boolean;
    preserveTrailingThinking: boolean;
    signal: AbortSignal;
  },
): Promise<NativeToolContextProjection> {
  return projectNativeToolContextCore(document, options, "completed");
}

export async function projectNativeToolRequestContext(
  document: NativeSessionDocument,
  options: Parameters<typeof projectNativeToolContext>[1],
): Promise<NativeToolContextProjection> {
  return projectNativeToolContextCore(document, options, "model-request");
}

async function projectNativeToolContextCore(
  document: NativeSessionDocument,
  options: Parameters<typeof projectNativeToolContext>[1],
  phase: "completed" | "model-request",
): Promise<NativeToolContextProjection> {
  const index = indexNativeSession(document);
  const recovered = reconstructNativeHistory(index, options.selection);
  const host =
    typeof options.host === "function"
      ? options.host(recovered.nodes)
      : options.host;
  if (
    host.systemTurns !== false ||
    host.reminderFold !== false ||
    host.withoutAttachmentHooks !== true
  )
    return fail("unsupported-tool-context-projection-gates");
  for (const node of recovered.nodes) {
    if (
      node.row.sharedHeadBlocks !== undefined ||
      node.row.ephemeral !== undefined
    )
      return fail("unsupported-native-merge-metadata", node.uuid);
    const transforms = [
      "appendToToolResult",
      "taskDelivery",
      "answeredPost",
      "withdrawnImages",
      "withdrawnDocuments",
      "withdrawnFiles",
      "withdrawnResults",
      "hiddenBefore",
    ];
    if (
      transforms.some((field) => node.row[field] !== undefined) ||
      node.row.isCompactSummary === true
    )
      return fail("unsupported-native-delivery-or-withdrawal", node.uuid);
  }
  const dispositions = await planNativeResumeContext(
    recovered.nodes,
    host,
    options.signal,
  );
  const requiring = dispositions.find(
    (entry) => entry.requiredTransform !== undefined,
  );
  if (requiring)
    return fail(
      `unsupported-context-transform-${requiring.requiredTransform ?? "unknown"}`,
      requiring.uuid,
    );
  const removed = new Set(dispositions.map((entry) => entry.uuid));
  const selectedUuids = new Set(recovered.nodes.map((node) => node.uuid));
  const parentRewrites: NativeToolContextProjection["parentRewrites"][number][] =
    [];
  const retained: NativeJson[] = [];
  for (const line of document.lines) {
    if (line.kind !== "record" || line.value === undefined) continue;
    const row = line.value;
    if (!isNativeObject(row)) {
      retained.push(row);
      continue;
    }
    if (typeof row.uuid === "string" && removed.has(row.uuid)) continue;
    if (
      (row.type !== "user" && row.type !== "assistant") ||
      typeof row.uuid !== "string" ||
      !selectedUuids.has(row.uuid)
    ) {
      retained.push(row);
      continue;
    }
    let parent = typeof row.parentUuid === "string" ? row.parentUuid : null;
    const skippedContext: string[] = [];
    while (parent !== null && removed.has(parent)) {
      if (skippedContext.includes(parent))
        return fail("tool-context-parent-cycle", parent);
      skippedContext.push(parent);
      parent = index.nodes.get(parent)?.parentUuid ?? null;
    }
    if (skippedContext.length && typeof row.uuid === "string")
      parentRewrites.push({
        uuid: row.uuid,
        from: typeof row.parentUuid === "string" ? row.parentUuid : null,
        to: parent,
        skippedContext,
      });
    retained.push(skippedContext.length ? { ...row, parentUuid: parent } : row);
  }
  const documentForProjection = decodeNativeSession(
    encodeNativeSessionRows(retained),
    { parser: "source-line-fallback" },
  );
  // This validates every individual source block before combining response fragments.
  const projection = (
    phase === "completed"
      ? projectNativeHistory
      : projectNativeHistoryForModelRequest
  )(documentForProjection, options.selection);
  const users = new Map<string, Message>();
  for (const [i, sources] of projection.messageSources.entries()) {
    const message = projection.messages[i];
    if (message?.role === "user" && sources.length === 1 && sources[0])
      users.set(sources[0], message);
  }
  const owners = new Map<string, ToolUse>();
  for (const message of projection.messages)
    for (const block of message.content)
      if (block.type === "tool_use") owners.set(block.id, block);
  const messages: Message[] = [],
    sources: string[][] = [],
    events: NativeToolContextEvent[] = [];
  const assistants = new Map<string, AssistantState>();
  const allAssistants: AssistantState[] = [];
  const assistantStates = new Map<Message, AssistantState>();
  let scannedMessages = 0;
  const contexts = new Map(dispositions.map((entry) => [entry.uuid, entry]));
  const textProvenance = new WeakMap<
    object,
    { uuid: string; nativeType: string | undefined }
  >();
  const copyBlocks = (
    blocks: readonly Block[],
    uuid: string,
    nativeType: string | undefined,
  ): Block[] =>
    blocks.map((block) => {
      const copied = clone(block);
      if (copied.type === "text")
        textProvenance.set(copied, { uuid, nativeType });
      return copied;
    });
  function incomingClass(
    text: string,
    uuid: string,
    nativeType: string | undefined,
    phase: "incoming" | "existing",
  ): NativeToolTextPlacement {
    const value = options.classifiers.text({
      text,
      phase,
      uuid,
      nativeType,
      source: contexts.get(uuid)?.source,
    });
    if (
      !["ordinary", "beside", "beside-reorderable", "direct-event"].includes(
        value,
      )
    )
      return fail("unsupported-native-context-text-classification", uuid);
    return value;
  }
  function mergeAttachment(
    blocks: readonly Block[],
    text: readonly { type: "text"; text: string }[],
    disposition: NativeResumeContextDisposition,
  ): Block[] {
    const current = [...blocks];
    let indexOfResult = current.length - 1;
    if (current[indexOfResult]?.type !== "tool_result") {
      while (indexOfResult >= 0) {
        const last = current[indexOfResult];
        if (last?.type !== "text") break;
        const prior = textProvenance.get(last);
        if (
          incomingClass(
            last.text,
            prior?.uuid ?? disposition.uuid,
            prior?.nativeType,
            "existing",
          ) !== "beside-reorderable"
        )
          break;
        indexOfResult--;
      }
      if (
        current[indexOfResult]?.type === "tool_result" &&
        text.every((block) => {
          const kind = incomingClass(
            block.text,
            disposition.uuid,
            disposition.nativeType,
            "incoming",
          );
          return kind === "ordinary" || kind === "direct-event";
        })
      ) {
        const head = mergeAttachment(
          current.slice(0, indexOfResult + 1),
          text,
          disposition,
        );
        const event = events.at(-1);
        if (event)
          event.reorderedPastTextBlocks = current.length - indexOfResult - 1;
        return [...head, ...current.slice(indexOfResult + 1)];
      }
      events.push({
        uuid: disposition.uuid,
        nativeType: disposition.nativeType,
        placement: "user-blocks",
      });
      return [...current, ...text];
    }
    const result = current[indexOfResult];
    if (result?.type !== "tool_result")
      return fail("missing-native-context-result", disposition.uuid);
    const resultClass = options.classifiers.result({
      result,
      owner: owners.get(result.tool_use_id),
    });
    if (resultClass !== "ordinary" && resultClass !== "beside")
      return fail(
        "unsupported-native-tool-result-classification",
        disposition.uuid,
      );
    if (
      resultClass === "beside" ||
      text.some(
        (block) =>
          incomingClass(
            block.text,
            disposition.uuid,
            disposition.nativeType,
            "incoming",
          ) !== "ordinary",
      )
    ) {
      events.push({
        uuid: disposition.uuid,
        nativeType: disposition.nativeType,
        placement: "beside-result",
        toolUseId: result.tool_use_id,
      });
      return [...current, ...text];
    }
    if (result.apiContent === undefined) {
      const merged = [
        result.content.trim(),
        ...text.map((block) => block.text.trim()),
      ]
        .filter(Boolean)
        .join("\n\n");
      current[indexOfResult] = { ...result, content: merged };
      events.push({
        uuid: disposition.uuid,
        nativeType: disposition.nativeType,
        placement: "string-result",
        toolUseId: result.tool_use_id,
      });
    } else {
      const data = clone(result.apiContent),
        last = data.at(-1);
      if (last?.type === "text") last.text += "\n";
      current[indexOfResult] = withArray(result, [...data, ...text]);
      events.push({
        uuid: disposition.uuid,
        nativeType: disposition.nativeType,
        placement: "array-result",
        toolUseId: result.tool_use_id,
      });
    }
    return current;
  }
  function appendUser(
    message: Message,
    uuid: string,
    disposition?: NativeResumeContextDisposition,
  ) {
    for (const block of message.content)
      if (block.type === "text")
        textProvenance.set(block, {
          uuid,
          nativeType: disposition?.nativeType,
        });
    const previous = messages.at(-1);
    if (previous?.role === "user") {
      if (disposition && disposition.source !== "local-command") {
        const texts = message.content.flatMap((block) =>
          block.type === "text" ? [block] : [],
        );
        if (texts.length !== message.content.length)
          return fail("unsupported-nontext-context", uuid);
        previous.content = toolsFirst(
          mergeAttachment(previous.content, texts, disposition),
        );
      } else {
        const before = previous.content.at(-1),
          after = message.content[0];
        if (before?.type === "text" && after?.type === "text")
          before.text += "\n";
        previous.content = toolsFirst([
          ...previous.content,
          ...copyBlocks(message.content, uuid, disposition?.nativeType),
        ]);
        if (disposition)
          events.push({
            uuid,
            nativeType: disposition.nativeType,
            placement: "system-local-command",
          });
      }
      sources.at(-1)?.push(uuid);
    } else {
      messages.push({
        ...clone(message),
        content: copyBlocks(message.content, uuid, disposition?.nativeType),
      });
      sources.push([uuid]);
      if (disposition)
        events.push({
          uuid,
          nativeType: disposition.nativeType,
          placement:
            disposition.source === "local-command"
              ? "system-local-command"
              : "user-blocks",
        });
    }
  }
  for (const node of reorderNativeResumeContextNodes(recovered.nodes)) {
    options.signal.throwIfAborted();
    const context = contexts.get(node.uuid);
    if (context) {
      if (context.destination === "system-round")
        return fail("unsupported-tool-context-system-round", node.uuid);
      for (const rendered of context.content) {
        const blocks: { type: "text"; text: string }[] =
          typeof rendered === "string"
            ? [{ type: "text", text: rendered }]
            : rendered.map((block) => ({ ...block }));
        if (context.source !== "local-command")
          for (const block of blocks) block.text = escapedReminder(block.text);
        appendUser({ role: "user", content: blocks }, node.uuid, context);
      }
      continue;
    }
    if (node.type === "user") {
      const message = users.get(node.uuid);
      if (!message) return fail("missing-validated-user-row", node.uuid);
      const prepared = clone(message);
      for (const block of prepared.content)
        if (block.type === "text") block.text = escapedReminder(block.text);
      appendUser(prepared, node.uuid);
      continue;
    }
    if (node.type !== "assistant" || !isNativeObject(node.row.message))
      return fail("unsupported-tool-context-row", node.uuid);
    const native = node.row.message;
    if (typeof native.id !== "string" || !isNativeArray(native.content))
      return fail("invalid-native-assistant-fragment", node.uuid);
    const message: Message = {
      role: "assistant",
      content: assistantBlockSchema.array().parse(native.content),
      responseId: native.id,
      ...(typeof native.model === "string"
        ? { responseModel: native.model }
        : {}),
      ...(node.row.resumedFromIncompleteThinking === true
        ? { resumedFromIncompleteThinking: true }
        : {}),
    };
    const indices = fragmentIndices(node, message.content.length);
    const incoming: AssistantState = {
      message,
      sources: [node.uuid],
      ...(indices ? { indices } : {}),
    };
    // Native Kke scans lazily here: a temporary context-only user can acquire
    // a result before this boundary, so clearing at append time would be wrong.
    for (; scannedMessages < messages.length; scannedMessages++) {
      const prior = messages[scannedMessages];
      if (prior?.role === "assistant" && prior.responseId) {
        const state = assistantStates.get(prior);
        if (state) assistants.set(prior.responseId, state);
      } else if (
        prior?.role === "user" &&
        !prior.content.some((block) => block.type === "tool_result")
      )
        assistants.clear();
    }
    const current = assistants.get(native.id);
    if (current) {
      mergeAssistant(current, incoming, options.echoApiBlockOrder);
      continue;
    }
    if (!options.echoApiBlockOrder || indices === undefined) {
      message.content = assistantOrder(message.content);
      delete incoming.indices;
    }
    messages.push(message);
    sources.push(incoming.sources);
    assistantStates.set(message, incoming);
    allAssistants.push(incoming);
  }
  const errorResultCleanups: NativeToolContextProjection["errorResultCleanups"][number][] =
    [];
  // qPi is a final wire cleanup: error result arrays retain text only, without losing raw records.
  for (const message of messages)
    for (const block of message.content)
      if (
        block.type === "tool_result" &&
        block.is_error &&
        block.apiContent !== undefined &&
        block.apiContent.some((item) => item.type !== "text")
      ) {
        errorResultCleanups.push({
          toolUseId: block.tool_use_id,
          removedNonTextBlocks: block.apiContent.filter(
            (item) => item.type !== "text",
          ).length,
          retainedTextBlocks: block.apiContent.filter(
            (item) => item.type === "text",
          ).length,
        });
        const texts = block.apiContent.flatMap((item) =>
          item.type === "text" ? [item.text] : [],
        );
        const blocks: ApiToolContent[] = texts.length
          ? [{ type: "text", text: texts.join("\n\n") }]
          : [];
        block.content = summary(blocks);
        block.apiContent = blocks;
      }
  // Preserve signed history: unsupported native trailing-thinking repairs are not guessed.
  const last = messages.at(-1),
    trailing = last?.content.at(-1);
  if (
    !options.preserveTrailingThinking &&
    last?.role === "assistant" &&
    (trailing?.type === "thinking" || trailing?.type === "redacted_thinking")
  )
    return fail("unsupported-trailing-thinking-context-repair");
  return {
    originalDocument: document,
    documentForProjection,
    projection,
    messages,
    messageSources: sources,
    dispositions,
    contextMergeEvents: events,
    parentRewrites,
    errorResultCleanups,
    assistantBlockIndices: allAssistants.flatMap((state) =>
      state.message.responseId && state.indices
        ? [{ responseId: state.message.responseId, indices: state.indices }]
        : [],
    ),
  };
}
