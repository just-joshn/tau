import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { captureNativePersistenceJson } from "./native-persistence-events.js";
import type { NativePreparedRequest } from "./native-request-capture.js";
import { isNativeObject, type NativeObject } from "./native-session-codec.js";
import type {
  NativePromptFact,
  NativePromptSnapshotPlan,
  NativePromptSnapshotTool,
  NativePromptWireShape,
} from "./native-prompt-snapshot.js";

const CLI = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const AGENT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const prefixes = new Set([CLI, SDK, AGENT]);
const dynamicBoundary = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
const staticBoundary = "__SYSTEM_PROMPT_STATIC_BREAKPOINT__";
const headerPrefix = "x-anthropic-billing-header:";
function reportingSection(text: string): boolean {
  return (
    text.length === 907 &&
    createHash("sha256").update(text).digest("hex") ===
      "a11f50f6b3db6a8398147c47e0705204c4edeecb443aa0bb282d659bb9170fae"
  );
}
class Unsupported extends Error {}
function known<T>(fact: NativePromptFact<T>): T {
  if (fact.status !== "known") throw new Unsupported(fact.reason);
  return fact.value;
}
function gate(fact: NativePromptFact<boolean>): boolean {
  const value = known(fact);
  if (typeof value !== "boolean")
    throw new Unsupported("Request gate has no actual boolean value");
  return value;
}
function snapshot<T>(value: T): T {
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
export interface NativePromptSystemFacts {
  systemContext: NativePromptFact<Readonly<Record<string, string>>>;
  /** Actual Ipi result, including "" for its real opt-out branch; never inferred from body text. */
  attributionHeader: NativePromptFact<string>;
  provider: NativePromptFact<"vertex" | "other">;
  isNonInteractive: NativePromptFact<boolean>;
  hasAppendSystemPrompt: NativePromptFact<boolean>;
  globalCache: NativePromptFact<boolean>;
  skipGlobalCacheForSystemPrompt: NativePromptFact<boolean>;
  promptCaching: NativePromptFact<boolean>;
  cacheTtl: NativePromptFact<"5m" | "1h" | undefined>;
  cacheScopeRefused: NativePromptFact<boolean>;
}
export interface NativePromptToolReplayFacts {
  origin: NativePromptFact<"current-render" | "recorded-shortcut">;
  deferred: NativePromptFact<boolean>;
  /** Actual ZXo decision; deferred tools skip this decision in the caller. */
  ignoreRecordedText: NativePromptFact<boolean>;
  /** Actual Na-family saved-schema exclusion, separate from text suppression. */
  excludeRecordedSchema: NativePromptFact<boolean>;
  withoutToolDescribeHooks: NativePromptFact<boolean>;
  rewrittenByHook: NativePromptFact<boolean>;
  hookCacheBreakerPresent: NativePromptFact<boolean>;
  citationTool: NativePromptFact<boolean>;
  modelAllowsCitations: NativePromptFact<boolean>;
  limitedAttributes: NativePromptFact<boolean>;
  allowDeferredWhenLimited: NativePromptFact<boolean>;
}
export interface NativePromptCurrentTool {
  name: string;
  /** Actual Hn base before late H2 replay/citations/cache and later request decoration. */
  baseEntry: NativeObject;
  server?: string;
  facts: NativePromptToolReplayFacts;
}
export interface NativePromptRequestStages {
  recordedOnlyTools: NativePromptFact<boolean>;
  toolAdditionOrDeferredChannel: NativePromptFact<boolean>;
  ownershipDecoration: NativePromptFact<boolean>;
  schemaRefusalRepair: NativePromptFact<boolean>;
  foundryFeatureRepair: NativePromptFact<boolean>;
  inheritedThreadFields: NativePromptFact<boolean>;
  extraToolSchemasOrPlaceholder: NativePromptFact<boolean>;
}
export interface NativePromptRequestInput {
  snapshot: NativePromptSnapshotPlan;
  /** Actual source-selected/current rendering vector, never reconstructed from saved names. */
  currentTools: readonly NativePromptCurrentTool[];
  system: NativePromptSystemFacts;
  stages: NativePromptRequestStages;
  actualHeadWireShape: NativePromptFact<NativePromptWireShape>;
  attempt: {
    requestedModel: string;
    wireModel: string;
    transport: "stream" | "json";
  };
}
export interface NativePromptSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h"; scope?: "global" };
}
export interface NativePromptRequestPlan {
  system: readonly NativePromptSystemBlock[];
  tools: readonly NativeObject[];
  /** Ha's actual earlier callback vector: no cached/decorated later-body reconstruction. */
  inlineDeclarations: readonly NativePromptSnapshotTool[];
  head: { cliPrefix: string; wireShape: NativePromptWireShape };
  availableNames: readonly string[];
  attempt: NativePromptRequestInput["attempt"];
}
export type NativePromptRequestResult =
  | { status: "prepared"; plan: NativePromptRequestPlan }
  | {
      status: "unsupported";
      reasons: readonly string[];
      facts: NativePromptRequestInput;
    };
export interface NativePromptToolReplay {
  entry: NativeObject;
  declaration: NativePromptSnapshotTool | undefined;
}
const baseKeys = new Set([
  "name",
  "description",
  "input_schema",
  "strict",
  "eager_input_streaming",
]);
/** Exact late H2 overlay at the supplied actual current-render/cache base boundary. */
export function replayNativePromptTool(
  tool: NativePromptCurrentTool,
  saved: readonly NativePromptSnapshotTool[] | undefined,
  handedNames: readonly string[] | undefined,
): NativePromptToolReplay {
  const origin = known(tool.facts.origin);
  if (origin !== "current-render" && origin !== "recorded-shortcut")
    throw new Unsupported("Tool base has no actual render/cache provenance");
  const fresh = tool.baseEntry;
  if (
    fresh.name !== tool.name ||
    typeof fresh.name !== "string" ||
    typeof fresh.description !== "string" ||
    !isNativeObject(fresh.input_schema) ||
    Object.keys(fresh).some((key) => !baseKeys.has(key))
  )
    throw new Unsupported(
      "Actual ordinary H2 base entry is unavailable before cache/provenance/extra-field decoration",
    );
  if (
    (fresh.strict !== undefined && typeof fresh.strict !== "boolean") ||
    (fresh.eager_input_streaming !== undefined &&
      typeof fresh.eager_input_streaming !== "boolean")
  )
    throw new Unsupported(
      "Tool base strict/streaming facts are not actual booleans",
    );
  const deferred = gate(tool.facts.deferred);
  const suppressed = deferred || gate(tool.facts.ignoreRecordedText);
  const previous = saved?.find((entry) => entry.name === tool.name);
  const recordedDescription = suppressed ? undefined : previous?.description;
  const recordedEntry =
    suppressed || gate(tool.facts.excludeRecordedSchema)
      ? undefined
      : previous?.schema;
  const handed =
    !gate(tool.facts.withoutToolDescribeHooks) &&
    handedNames?.includes(tool.name) === true;
  const freshDescription =
    handed &&
    gate(tool.facts.rewrittenByHook) &&
    gate(tool.facts.hookCacheBreakerPresent);
  const description = freshDescription
    ? fresh.description
    : (recordedEntry?.description ?? recordedDescription ?? fresh.description);
  if (typeof description !== "string")
    throw new Unsupported("Recorded native tool description is not a string");
  const strictParity =
    recordedEntry !== undefined &&
    (recordedEntry.strict === true) === (fresh.strict === true);
  const schema = strictParity ? recordedEntry.input_schema : fresh.input_schema;
  if (!isNativeObject(schema))
    throw new Unsupported(
      "Recorded entry has no actual native object input schema",
    );
  let entry: NativeObject = {
    name: fresh.name,
    description,
    input_schema: schema,
    ...(fresh.strict ? { strict: true } : {}),
    ...(fresh.eager_input_streaming ? { eager_input_streaming: true } : {}),
    ...(deferred ? { defer_loading: true } : {}),
  };
  if (
    gate(tool.facts.citationTool) &&
    (recordedEntry === undefined || "citations" in recordedEntry) &&
    gate(tool.facts.modelAllowsCitations)
  )
    entry = { ...entry, citations: { enabled: true } };
  if (gate(tool.facts.limitedAttributes)) {
    const keepDefer = deferred && gate(tool.facts.allowDeferredWhenLimited);
    entry = {
      name: fresh.name,
      description,
      input_schema: schema,
      ...(keepDefer ? { defer_loading: true } : {}),
    };
  }
  return snapshot({
    entry,
    declaration: deferred
      ? undefined
      : {
          name: fresh.name,
          description,
          schema: entry,
          ...(tool.server === undefined ? {} : { server: tool.server }),
        },
  });
}
function staticParts(text: string): string[] {
  if (!text.includes(staticBoundary)) return [text];
  let at = text.indexOf(staticBoundary);
  while (at !== -1) {
    const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1,
      lineEnd = text.indexOf("\n", at),
      end = lineEnd === -1 ? text.length : lineEnd;
    if (text.slice(start, end).trim() === staticBoundary) {
      const before = text.slice(0, start),
        after = text.slice(end);
      return [
        ...(before.trim() ? [before] : []),
        ...(after.trim() ? [after] : []),
      ];
    }
    if (lineEnd === -1) break;
    at = text.indexOf(staticBoundary, lineEnd + 1);
  }
  return [text];
}
function cliPrefix(
  recorded: string | undefined,
  facts: NativePromptSystemFacts,
): string {
  if (known(facts.provider) === "vertex") return CLI;
  if (recorded !== undefined) return recorded;
  if (gate(facts.isNonInteractive))
    return gate(facts.hasAppendSystemPrompt) ? SDK : AGENT;
  return CLI;
}
/** Complete Roa → eAa → J9s → Mhs ordinary system block construction. */
export function prepareNativePromptSystem(
  prompt: readonly string[],
  recordedPrefix: string | undefined,
  facts: NativePromptSystemFacts,
): { blocks: readonly NativePromptSystemBlock[]; cliPrefix: string } {
  const context = known(facts.systemContext);
  if (Object.values(context).some((value) => typeof value !== "string"))
    throw new Unsupported("Actual system-context entries are not strings");
  const contextual = [
    ...prompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  ].filter(Boolean);
  const prefix = cliPrefix(recordedPrefix, facts),
    attribution = known(facts.attributionHeader);
  if (
    typeof attribution !== "string" ||
    (attribution !== "" && !attribution.startsWith(headerPrefix))
  )
    throw new Unsupported("Actual native attribution result is unavailable");
  const input = [attribution, prefix, ...contextual].filter(Boolean),
    boundary = input.indexOf(dynamicBoundary),
    global = gate(facts.globalCache);
  let header: string | undefined,
    identity: string | undefined,
    reporting: string | undefined;
  const before: string[] = [],
    after: string[] = [];
  for (const [index, text] of input.entries()) {
    if (!text || text === dynamicBoundary) continue;
    if (text.startsWith(headerPrefix)) header = text;
    else if (prefixes.has(text)) identity = text;
    else if (reportingSection(text)) reporting = text;
    else if (global && boundary !== -1 && index > boundary) after.push(text);
    else
      before.push(
        !global && index < boundary ? staticParts(text).join("") : text,
      );
  }
  const selected: Array<{ text: string; scope: "org" | "global" | null }> = [];
  if (header) selected.push({ text: header, scope: null });
  const bounded = global && boundary !== -1;
  // The skip-global/no-boundary branch shares the ordinary grouping; the gate
  // still has actual provenance and is consulted only where native J9s reads it.
  if (global && boundary === -1) gate(facts.skipGlobalCacheForSystemPrompt);
  if (identity)
    selected.push({ text: identity, scope: bounded ? null : "org" });
  if (reporting && header && identity)
    selected.push({ text: reporting, scope: null });
  if (bounded) {
    const fixed = before.join("\n\n"),
      pieces = fixed ? staticParts(fixed) : [];
    for (const text of pieces) selected.push({ text, scope: "global" });
    const dynamic = after.join("\n\n");
    if (dynamic)
      selected.push({ text: dynamic, scope: pieces.length > 1 ? null : "org" });
  } else {
    const body = before.join("\n\n");
    if (body) selected.push({ text: body, scope: "org" });
  }
  const caching = gate(facts.promptCaching);
  const blocks: NativePromptSystemBlock[] = selected.map(({ text, scope }) => {
    if (!caching || scope === null) return { type: "text", text };
    const ttl = known(facts.cacheTtl),
      refused = gate(facts.cacheScopeRefused);
    if (ttl !== undefined && ttl !== "5m" && ttl !== "1h")
      throw new Unsupported("Actual system cache TTL is unsupported");
    return {
      type: "text",
      text,
      cache_control: {
        type: "ephemeral",
        ...(ttl ? { ttl } : {}),
        ...(!refused && scope === "global" ? { scope: "global" } : {}),
      },
    };
  });
  return snapshot({ blocks, cliPrefix: prefix });
}
function requireOrdinaryWire(shape: NativePromptWireShape | undefined): void {
  if (!shape) return;
  for (const [key, value] of Object.entries(shape))
    if (
      value !== undefined &&
      value !== false &&
      !(key === "leadingTools" && Array.isArray(value) && value.length === 0)
    )
      throw new Unsupported(
        `Actual ${key} request/history transformation requires its source adapter`,
      );
}
/** Pre-serialization replay fragments; this function never constructs model/metadata/messages or sends HTTP. */
export function prepareNativePromptRequest(
  input: NativePromptRequestInput,
): NativePromptRequestResult {
  input = snapshot(input);
  try {
    const stages = [
      "recordedOnlyTools",
      "toolAdditionOrDeferredChannel",
      "ownershipDecoration",
      "schemaRefusalRepair",
      "foundryFeatureRepair",
      "inheritedThreadFields",
      "extraToolSchemasOrPlaceholder",
    ] as const;
    for (const name of stages)
      if (gate(input.stages[name]))
        throw new Unsupported(
          `Actual ${name} request stage requires its source adapter`,
        );
    requireOrdinaryWire(input.snapshot.recordedWireShape);
    const headShape = known(input.actualHeadWireShape);
    requireOrdinaryWire(headShape);
    const names = input.currentTools.map((tool) => tool.name);
    if (new Set(names).size !== names.length)
      throw new Unsupported(
        "Current admitted tool vector has ambiguous duplicate names",
      );
    const replayed = input.currentTools.map((tool) =>
      replayNativePromptTool(
        tool,
        input.snapshot.tools,
        input.snapshot.redescribing?.names,
      ),
    );
    const system = prepareNativePromptSystem(
      input.snapshot.systemPrompt,
      input.snapshot.recordedCliPrefix,
      input.system,
    );
    return snapshot({
      status: "prepared",
      plan: {
        system: system.blocks,
        tools: replayed.map((tool) => tool.entry),
        inlineDeclarations: replayed.flatMap((tool) =>
          tool.declaration === undefined ? [] : [tool.declaration],
        ),
        head: { cliPrefix: system.cliPrefix, wireShape: headShape },
        availableNames: names,
        attempt: input.attempt,
      },
    });
  } catch (error) {
    return snapshot({
      status: "unsupported",
      reasons: [
        error instanceof Error
          ? error.message
          : "Unknown actual request replay fact",
      ],
      facts: input,
    });
  }
}
/** Compare the actual final pre-fetch truth boundary; this does not edit an already serialized request. */
export function verifyNativePromptPreparedRequest(
  actual: NativePreparedRequest,
  plan: NativePromptRequestPlan,
):
  | { status: "verified" }
  | { status: "unsupported"; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (
    actual.requestedModel !== plan.attempt.requestedModel ||
    actual.wireModel !== plan.attempt.wireModel ||
    actual.transport !== plan.attempt.transport ||
    actual.body.model !== plan.attempt.wireModel ||
    actual.body.stream !== (plan.attempt.transport === "stream")
  )
    reasons.push(
      "Actual attempt model/transport differs from the admitted replay facts",
    );
  if (!isDeepStrictEqual(actual.body.system, plan.system))
    reasons.push(
      "Actual serialized system blocks differ from native replay preparation",
    );
  if (!isDeepStrictEqual(actual.body.tools, plan.tools))
    reasons.push(
      "Actual serialized tools differ from native replay preparation",
    );
  return snapshot(
    reasons.length
      ? { status: "unsupported", reasons }
      : { status: "verified" },
  );
}
