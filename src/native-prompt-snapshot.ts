import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  captureNativePersistenceJson,
  createNativeAttachmentEvent,
  type NativePersistenceEvent,
} from "./native-persistence-events.js";
import { isNativeObject, type NativeObject } from "./native-session-codec.js";

export type NativePromptFact<T> =
  { status: "known"; value: T } | { status: "unsupported"; reason: string };
export interface NativePromptWireShape {
  systemTurns?: boolean | undefined;
  toolChangeHeader?: boolean | undefined;
  inlineTools?: boolean | undefined;
  keptReminders?: boolean | undefined;
  toolResultSafeguards?: boolean | undefined;
  systemTurnsAnsweredBy?: string | undefined;
  projectDocsAsDocuments?: boolean | undefined;
  effortAfterText?: boolean | undefined;
  leadingTools?: readonly string[] | undefined;
}
export interface NativePromptSnapshotTool {
  name: string;
  description: string;
  /** Actual complete request wire entry; never a guessed input_schema alone. */
  schema?: NativeObject | undefined;
  server?: string | undefined;
}
export interface NativePromptSnapshotPayload extends NativePromptWireShape {
  type: "prompt_snapshot";
  systemPrompt: readonly string[];
  tools?: readonly NativePromptSnapshotTool[];
  cliPrefix?: string | undefined;
  reminderFold?: boolean | undefined;
  echoWireToolInputs?: boolean | undefined;
  contextRendering?: "announced" | "inline" | undefined;
}
export interface NativePromptSnapshotReference {
  uuid: string | undefined;
  attachment: NativeObject;
}
export interface NativePromptSnapshotState {
  reference: NativePromptSnapshotReference;
  systemPrompt: readonly string[];
  systemPromptHash: string;
  /** MVr projection: independent saved description/schema/server Maps merged by name. */
  tools: readonly NativePromptSnapshotTool[];
  cliPrefix: string | undefined;
  wireShape: NativePromptWireShape;
  reminderFold: boolean | undefined;
  echoWireToolInputs: boolean | undefined;
  contextRendering: "announced" | "inline" | undefined;
}
export interface NativePromptToolRedescription {
  names: readonly string[];
  epoch: number;
}
export interface NativePromptSnapshotCreation {
  record: {
    type: "attachment";
    uuid: string;
    timestamp: string;
    attachment: NativePromptSnapshotPayload;
  };
  serialization:
    | { status: "supported"; event: NativePersistenceEvent }
    | { status: "unsupported"; reasons: readonly string[] };
}
export interface NativePromptSnapshotHost {
  stamp(input: {
    phase: "prompt" | "tools";
    attachment: NativePromptSnapshotPayload;
    previous: NativePromptSnapshotState | undefined;
  }): { uuid: string; timestamp: string };
  /** Actual Ga state/turn-section renderer. Undefined means no owed rewrite; [] is a rewrite. */
  owedPrompt(input: {
    snapshot: NativePromptSnapshotState;
    livePrompt: readonly string[];
    turnSections: unknown;
  }): NativePromptFact<readonly string[] | undefined>;
  /** Actual jea/xta session/inheritance/fallback resolution, not a feature default. */
  reminderFold(
    inherited: boolean | undefined,
  ): NativePromptFact<boolean | undefined>;
  echoWireToolInputs(
    inherited: boolean | undefined,
  ): NativePromptFact<boolean | undefined>;
  modelEffortAfterText(model: string): NativePromptFact<boolean>;
  leadingTools?(
    firstRequest: boolean,
  ): NativePromptFact<readonly string[] | undefined>;
  /** Actual request owner vouches for each schema newly carried into Ha's payload. */
  toolSchemaProvenance(
    tool: NativePromptSnapshotTool,
  ): NativePromptFact<"actual-request-wire-entry">;
  noteCopied(
    previous: NativePromptSnapshotReference,
    next: NativePromptSnapshotReference,
  ): void;
  noteRendered(hash: string, turnSections: unknown): void;
  redescribing(
    snapshot: NativePromptSnapshotState | undefined,
    epoch: number,
  ): NativePromptFact<NativePromptToolRedescription | undefined>;
  noteRedescribed(
    reference: NativePromptSnapshotReference,
    handed: NativePromptToolRedescription,
    currentNames: readonly string[],
  ): void;
}
export interface NativePromptSnapshotCommon {
  history: readonly NativeObject[];
  /** Actual Efe decision from admitted options/environment; this module reads no process environment. */
  enabled: NativePromptFact<boolean>;
  /** Actual tu gate, shared by reminder/echo/context recording and Yh merge. */
  replayEnabled: NativePromptFact<boolean>;
  bareFork: boolean;
  querySource: string | undefined;
}
export interface NativePromptSnapshotInput extends NativePromptSnapshotCommon {
  systemPrompt: readonly string[];
  resumeActive: boolean;
  model?: string | undefined;
  inheritedReminderFold?: NativePromptFact<boolean | undefined>;
  inheritedEchoWireToolInputs?: NativePromptFact<boolean | undefined>;
  inheritedWireShape?: NativePromptFact<NativePromptWireShape | undefined>;
  contextRendering?: NativePromptFact<"announced" | "inline" | undefined>;
  /** Opaque actual renderer-owned state, passed only to its explicit owner callbacks. */
  turnSections?: unknown;
  toolDescribeEpoch?: number;
}
export interface NativePromptToolsInput extends NativePromptSnapshotCommon {
  /** Absence means Ha was not supplied a request tool vector; [] is an actual empty vector. */
  tools: readonly NativePromptSnapshotTool[] | undefined;
  head?: { cliPrefix?: string | undefined; wireShape?: NativePromptWireShape };
  handed?: NativePromptToolRedescription;
  /** Actual pfn decision, consulted only for the source ToolSearch removal branch. */
  removeAbsentToolSearch: NativePromptFact<boolean>;
}
export interface NativePromptSnapshotPlan {
  source: "live_unrecorded" | "from_snapshot" | "live_recorded";
  systemPrompt: readonly string[];
  tools: readonly NativePromptSnapshotTool[] | undefined;
  recordedCliPrefix: string | undefined;
  recordedWireShape: NativePromptWireShape | undefined;
  snapshotHash: string | undefined;
  creation: NativePromptSnapshotCreation | undefined;
  atRenderPoint?: boolean | undefined;
  rewritten?: true;
  redescribing?: NativePromptToolRedescription;
}
export type NativePromptSnapshotResult =
  | { status: "resolved"; plan: NativePromptSnapshotPlan }
  | {
      status: "unsupported";
      reasons: readonly string[];
      facts: NativePromptSnapshotFacts;
    };
export type NativePromptToolsResult =
  | { status: "unchanged"; snapshot: NativePromptSnapshotState | undefined }
  | { status: "created"; creation: NativePromptSnapshotCreation }
  | {
      status: "unsupported";
      reasons: readonly string[];
      facts: NativePromptSnapshotFacts;
    };
export interface NativePromptSnapshotFacts {
  phase: "prompt" | "tools";
  querySource: string | undefined;
  bareFork: boolean;
  lastSnapshot: NativeObject | undefined;
  renderPointAfterSnapshot: boolean;
  hasAssistant: boolean;
  enabled: NativePromptFact<boolean>;
  replayEnabled: NativePromptFact<boolean>;
  systemPrompt?: readonly string[] | undefined;
  tools?: readonly NativePromptSnapshotTool[];
  promptInputs?: Pick<
    NativePromptSnapshotInput,
    | "resumeActive"
    | "model"
    | "inheritedReminderFold"
    | "inheritedEchoWireToolInputs"
    | "inheritedWireShape"
    | "contextRendering"
    | "toolDescribeEpoch"
  >;
  toolGrowthInputs?: Pick<
    NativePromptToolsInput,
    "head" | "handed" | "removeAbsentToolSearch"
  >;
}
export class NativePromptSnapshotCaptureError extends Error {
  constructor(cause: unknown) {
    super("Native prompt snapshot owner failed", { cause });
    this.name = "NativePromptSnapshotCaptureError";
  }
}
class UnsupportedFact extends Error {}
function known<T>(fact: NativePromptFact<T>): T {
  if (fact.status !== "known") throw new UnsupportedFact(fact.reason);
  return fact.value;
}
function gate(fact: NativePromptFact<boolean>): boolean {
  const value = known(fact);
  if (typeof value !== "boolean")
    throw new UnsupportedFact("Snapshot gate has no actual boolean value");
  return value;
}
function sessionFlag(
  resolver: (
    inherited: boolean | undefined,
  ) => NativePromptFact<boolean | undefined>,
  inherited: NativePromptFact<boolean | undefined> | undefined,
): boolean | undefined {
  const parent = inherited === undefined ? undefined : known(inherited);
  const value = known(resolver(parent));
  if (
    (value !== undefined && typeof value !== "boolean") ||
    (parent !== undefined && value !== parent)
  )
    throw new UnsupportedFact(
      "Snapshot session resolver did not preserve its actual inherited flag",
    );
  return value;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const children: unknown[] = Object.values(value);
    for (const child of children) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot<T>(value: T): T {
  captureNativePersistenceJson(value);
  return frozen(structuredClone(value));
}
const wireKeys = [
  "systemTurns",
  "toolChangeHeader",
  "inlineTools",
  "keptReminders",
  "toolResultSafeguards",
  "systemTurnsAnsweredBy",
  "projectDocsAsDocuments",
  "effortAfterText",
  "leadingTools",
] as const;
function wire(value: NativePromptWireShape): NativePromptWireShape {
  return Object.fromEntries(
    wireKeys.flatMap((key) =>
      value[key] === undefined ? [] : [[key, value[key]]],
    ),
  );
}
const savedBoolean = z.boolean().optional().catch(undefined);
const saved = z.object({
  systemPrompt: z.array(z.string()),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        schema: z.record(z.string(), z.unknown()).optional(),
        server: z.string().optional(),
      }),
    )
    .optional(),
  cliPrefix: z.string().optional(),
  reminderFold: savedBoolean,
  echoWireToolInputs: savedBoolean,
  systemTurns: savedBoolean,
  toolChangeHeader: savedBoolean,
  inlineTools: savedBoolean,
  keptReminders: savedBoolean,
  toolResultSafeguards: savedBoolean,
  systemTurnsAnsweredBy: z.string().optional().catch(undefined),
  projectDocsAsDocuments: savedBoolean,
  effortAfterText: savedBoolean,
  leadingTools: z.array(z.string()).optional().catch(undefined),
  contextRendering: z.enum(["announced", "inline"]).optional().catch(undefined),
});
const cliPrefixes = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);
export function nativePromptSnapshotHash(prompt: readonly string[]): string {
  return createHash("sha256")
    .update(prompt.join("\0"))
    .digest("hex")
    .slice(0, 12);
}
function isPlainInputSchema(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "object"
  );
}
export function isNativePromptWireToolSchema(
  value: unknown,
): value is NativeObject {
  if (value !== null && typeof value === "object" && "cache_control" in value)
    return false;
  let parsed: unknown;
  try {
    parsed = captureNativePersistenceJson(value);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const object = z.record(z.string(), z.unknown()).parse(parsed);
  return (
    typeof object.name === "string" &&
    (object.description === undefined ||
      typeof object.description === "string") &&
    object.defer_loading !== true &&
    (object.type === undefined || object.type === "custom") &&
    isPlainInputSchema(object.input_schema) &&
    !("cache_control" in object)
  );
}
function selection(history: readonly NativeObject[]) {
  const last = history.findLastIndex(
    (row) =>
      row.type === "attachment" &&
      isNativeObject(row.attachment) &&
      row.attachment.type === "prompt_snapshot",
  );
  const point = history.findLastIndex(
    (row) =>
      row.type === "attachment" &&
      isNativeObject(row.attachment) &&
      row.attachment.type === "prompt_render_point",
  );
  return { row: history[last], renderPointAfterSnapshot: point > last };
}
/** qR selects the last snapshot; invalid last data never searches backward. */
export function readNativePromptSnapshot(
  history: readonly NativeObject[],
): NativePromptSnapshotState | undefined {
  const row = selection(history).row;
  if (!row || !isNativeObject(row.attachment)) return;
  const parsed = saved.safeParse(row.attachment);
  if (!parsed.success) return;
  const data = parsed.data,
    descriptions = new Map<string, string>(),
    entries = new Map<string, NativeObject>(),
    servers = new Map<string, string>();
  for (const tool of data.tools ?? []) {
    descriptions.set(tool.name, tool.description);
    if (isNativePromptWireToolSchema(tool.schema))
      entries.set(tool.name, tool.schema);
    if (tool.server !== undefined) servers.set(tool.name, tool.server);
  }
  return snapshot({
    reference: {
      uuid: typeof row.uuid === "string" ? row.uuid : undefined,
      attachment: row.attachment,
    },
    systemPrompt: data.systemPrompt,
    systemPromptHash: nativePromptSnapshotHash(data.systemPrompt),
    tools: [...descriptions].map(([name, description]) => ({
      name,
      description,
      ...(entries.has(name) ? { schema: entries.get(name) } : {}),
      ...(servers.has(name) ? { server: servers.get(name) } : {}),
    })),
    cliPrefix:
      data.cliPrefix !== undefined && cliPrefixes.has(data.cliPrefix)
        ? data.cliPrefix
        : undefined,
    wireShape: wire(data),
    reminderFold: data.reminderFold,
    echoWireToolInputs: data.echoWireToolInputs,
    contextRendering: data.contextRendering,
  });
}
function queryClass(
  source: string | undefined,
): "main" | "subagent" | "auxiliary" | undefined {
  if (source === undefined) return;
  if (source.startsWith("repl_main_thread") || source === "sdk") return "main";
  if (source.startsWith("agent:") || source === "hook_agent") return "subagent";
  return "auxiliary";
}
function writable(input: NativePromptSnapshotCommon): boolean {
  return !input.bareFork && queryClass(input.querySource) !== "auxiliary";
}
function facts(
  input: NativePromptSnapshotCommon,
  phase: "prompt" | "tools",
  extra: Pick<
    NativePromptSnapshotFacts,
    "systemPrompt" | "tools" | "promptInputs" | "toolGrowthInputs"
  > = {},
): NativePromptSnapshotFacts {
  return snapshot({
    phase,
    querySource: input.querySource,
    bareFork: input.bareFork,
    hasAssistant: input.history.some((row) => row.type === "assistant"),
    enabled: input.enabled,
    replayEnabled: input.replayEnabled,
    lastSnapshot: selection(input.history).row,
    renderPointAfterSnapshot: selection(input.history).renderPointAfterSnapshot,
    ...extra,
  });
}
function owner<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    throw new NativePromptSnapshotCaptureError(error);
  }
}
function create(
  host: NativePromptSnapshotHost,
  phase: "prompt" | "tools",
  attachment: NativePromptSnapshotPayload,
  previous: NativePromptSnapshotState | undefined,
): NativePromptSnapshotCreation {
  const payload = snapshot(attachment);
  const stamp = owner(() =>
    host.stamp(frozen({ phase, attachment: payload, previous })),
  );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      stamp.uuid,
    ) ||
    !Number.isFinite(Date.parse(stamp.timestamp))
  )
    throw new NativePromptSnapshotCaptureError(
      new TypeError("Invalid actual snapshot creation stamp"),
    );
  const record = snapshot({
    type: "attachment" as const,
    ...stamp,
    attachment: payload,
  });
  try {
    return frozen({
      record,
      serialization: {
        status: "supported",
        event: createNativeAttachmentEvent(payload, stamp),
      },
    });
  } catch {
    return frozen({
      record,
      serialization: {
        status: "unsupported",
        reasons: [
          "Full native prompt snapshot requires its positive wire/fold/context/schema serialization adapter; actual fields and identity were retained",
        ],
      },
    });
  }
}
function reference(
  creation: NativePromptSnapshotCreation,
): NativePromptSnapshotReference {
  const attachment = captureNativePersistenceJson(creation.record.attachment);
  if (!isNativeObject(attachment))
    throw new TypeError("Invalid native snapshot attachment");
  return frozen({ uuid: creation.record.uuid, attachment });
}
function buildPayload(
  prompt: readonly string[],
  previous: NativePromptSnapshotState | undefined,
  shape: NativePromptWireShape | undefined,
  fold: boolean | undefined,
  echo: boolean | undefined,
  rendering: "announced" | "inline" | undefined,
): NativePromptSnapshotPayload {
  return {
    type: "prompt_snapshot",
    systemPrompt: [...prompt],
    ...(previous?.tools.length ? { tools: previous.tools } : {}),
    ...(previous?.cliPrefix !== undefined
      ? { cliPrefix: previous.cliPrefix }
      : {}),
    ...(fold !== undefined ? { reminderFold: fold } : {}),
    ...wire(shape ?? {}),
    ...(echo !== undefined ? { echoWireToolInputs: echo } : {}),
    ...(rendering !== undefined ? { contextRendering: rendering } : {}),
  };
}
/** Complete zh + tp ordinary producer, including saved reuse, owed rewrites and actual owner notification seams. */
export function planNativePromptSnapshot(
  input: NativePromptSnapshotInput,
  host: NativePromptSnapshotHost,
): NativePromptSnapshotResult {
  const { turnSections, ...data } = input;
  input = {
    ...snapshot(data),
    ...(turnSections === undefined ? {} : { turnSections }),
  };
  const proof = facts(input, "prompt", {
    systemPrompt: input.systemPrompt,
    promptInputs: {
      resumeActive: input.resumeActive,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.inheritedReminderFold === undefined
        ? {}
        : { inheritedReminderFold: input.inheritedReminderFold }),
      ...(input.inheritedEchoWireToolInputs === undefined
        ? {}
        : { inheritedEchoWireToolInputs: input.inheritedEchoWireToolInputs }),
      ...(input.inheritedWireShape === undefined
        ? {}
        : { inheritedWireShape: input.inheritedWireShape }),
      ...(input.contextRendering === undefined
        ? {}
        : { contextRendering: input.contextRendering }),
      ...(input.toolDescribeEpoch === undefined
        ? {}
        : { toolDescribeEpoch: input.toolDescribeEpoch }),
    },
  });
  try {
    const live = snapshot(input.systemPrompt);
    let previous: NativePromptSnapshotState | undefined;
    let plan: NativePromptSnapshotPlan = {
      source: "live_unrecorded",
      systemPrompt: live,
      tools: undefined,
      recordedCliPrefix: undefined,
      recordedWireShape: undefined,
      creation: undefined,
      snapshotHash: undefined,
    };
    if (gate(input.enabled)) {
      previous = readNativePromptSnapshot(input.history);
      // Pinned cNa returns false: prompt inequality does not request a re-render.
      const changed =
        previous !== undefined &&
        selection(input.history).renderPointAfterSnapshot;
      const owed =
        previous &&
        !changed &&
        !input.resumeActive &&
        writable(input) &&
        queryClass(input.querySource) === "main"
          ? known(
              host.owedPrompt({
                snapshot: previous,
                livePrompt: live,
                turnSections: input.turnSections,
              }),
            )
          : undefined;
      const rewritten = owed !== undefined,
        refresh = changed || rewritten;
      const prompt = owed === undefined ? live : snapshot(owed);
      if (previous && (!refresh || input.resumeActive || !writable(input))) {
        const backfill = !refresh && !input.resumeActive && writable(input);
        let fold: boolean | undefined,
          echo: boolean | undefined,
          rendering: "announced" | "inline" | undefined;
        if (
          backfill &&
          previous.reminderFold === undefined &&
          gate(input.replayEnabled)
        )
          fold = sessionFlag(
            host.reminderFold.bind(host),
            input.inheritedReminderFold,
          );
        if (
          backfill &&
          previous.echoWireToolInputs === undefined &&
          gate(input.replayEnabled)
        )
          echo = sessionFlag(
            host.echoWireToolInputs.bind(host),
            input.inheritedEchoWireToolInputs,
          );
        if (
          backfill &&
          previous.contextRendering === undefined &&
          gate(input.replayEnabled)
        )
          rendering = input.contextRendering
            ? known(input.contextRendering)
            : undefined;
        const creation =
          fold !== undefined || echo !== undefined || rendering !== undefined
            ? create(
                host,
                "prompt",
                buildPayload(
                  previous.systemPrompt,
                  previous,
                  previous.wireShape,
                  previous.reminderFold ?? fold,
                  previous.echoWireToolInputs ?? echo,
                  previous.contextRendering ?? rendering,
                ),
                previous,
              )
            : undefined;
        plan = {
          source: "from_snapshot",
          systemPrompt: previous.systemPrompt,
          tools: previous.tools,
          recordedCliPrefix: previous.cliPrefix,
          recordedWireShape: previous.wireShape,
          creation,
          snapshotHash: previous.systemPromptHash,
        };
      } else if (!input.resumeActive && writable(input)) {
        const fold =
          previous?.reminderFold ??
          (gate(input.replayEnabled)
            ? sessionFlag(
                host.reminderFold.bind(host),
                input.inheritedReminderFold,
              )
            : undefined);
        let inherited = previous?.wireShape;
        if (inherited === undefined && input.inheritedWireShape) {
          const actual = known(input.inheritedWireShape);
          if (actual !== undefined) {
            const { systemTurnsAnsweredBy: _removed, ...remaining } = actual;
            inherited = remaining;
          }
        }
        const first =
          inherited === undefined &&
          queryClass(input.querySource) === "main" &&
          !input.history.some((row) => row.type === "assistant");
        let shape =
          input.model !== undefined &&
          first &&
          gate(host.modelEffortAfterText(input.model))
            ? { effortAfterText: true }
            : inherited;
        const leading =
          inherited === undefined && host.leadingTools
            ? known(host.leadingTools(first))
            : undefined;
        if (leading?.length)
          shape = { ...shape, leadingTools: snapshot(leading) };
        const echo =
          previous?.echoWireToolInputs ??
          (gate(input.replayEnabled)
            ? sessionFlag(
                host.echoWireToolInputs.bind(host),
                input.inheritedEchoWireToolInputs,
              )
            : undefined);
        const rendering =
          previous?.contextRendering ??
          (gate(input.replayEnabled) && input.contextRendering
            ? known(input.contextRendering)
            : undefined);
        const creation = create(
          host,
          "prompt",
          buildPayload(prompt, previous, shape, fold, echo, rendering),
          previous,
        );
        plan = {
          source: "live_recorded",
          systemPrompt: prompt,
          tools: previous?.tools,
          recordedCliPrefix: previous?.cliPrefix,
          recordedWireShape: shape,
          creation,
          snapshotHash: nativePromptSnapshotHash(prompt),
          atRenderPoint:
            rewritten ||
            (changed &&
              previous !== undefined &&
              !isDeepStrictEqual([...prompt], [...previous.systemPrompt])),
          ...(rewritten ? { rewritten: true as const } : {}),
        };
      }
    }
    const creation = plan.creation;
    if (previous && creation)
      owner(() => host.noteCopied(previous.reference, reference(creation)));
    const hash = plan.snapshotHash;
    if (plan.source === "live_recorded" && hash && !plan.rewritten)
      owner(() => host.noteRendered(hash, input.turnSections));
    if (input.toolDescribeEpoch !== undefined && writable(input)) {
      const handed = known(
        host.redescribing(previous, input.toolDescribeEpoch),
      );
      if (handed !== undefined)
        plan = { ...plan, redescribing: snapshot(handed) };
    }
    return frozen({ status: "resolved", plan });
  } catch (error) {
    if (error instanceof NativePromptSnapshotCaptureError) throw error;
    return frozen({
      status: "unsupported",
      reasons: [
        error instanceof Error ? error.message : "Unknown snapshot host fact",
      ],
      facts: proof,
    });
  }
}
/** Yh changes the current five wire flags + answeredBy/docs; effort/leading stay sticky. */
export function mergeNativePromptWireShape(
  previous: NativePromptWireShape,
  current: NativePromptWireShape | undefined,
  replayEnabled: NativePromptFact<boolean>,
): { wireShape: NativePromptWireShape; changed: boolean } {
  if (current === undefined || !gate(replayEnabled))
    return { wireShape: previous, changed: false };
  const merged = wire({
    systemTurns: current.systemTurns ?? previous.systemTurns,
    toolChangeHeader: current.toolChangeHeader ?? previous.toolChangeHeader,
    inlineTools: current.inlineTools ?? previous.inlineTools,
    keptReminders: current.keptReminders ?? previous.keptReminders,
    toolResultSafeguards:
      current.toolResultSafeguards ?? previous.toolResultSafeguards,
    systemTurnsAnsweredBy:
      current.systemTurnsAnsweredBy ?? previous.systemTurnsAnsweredBy,
    projectDocsAsDocuments:
      current.projectDocsAsDocuments ?? previous.projectDocsAsDocuments,
    effortAfterText: previous.effortAfterText,
    leadingTools: previous.leadingTools,
  });
  return {
    wireShape: merged,
    changed: wireKeys.slice(0, 7).some((key) => merged[key] !== previous[key]),
  };
}
/** Complete Ha: sticky saved tools, handed description replacement, ToolSearch removal and actual head merge. */
export function updateNativePromptSnapshotTools(
  input: NativePromptToolsInput,
  host: NativePromptSnapshotHost,
): NativePromptToolsResult {
  input = snapshot(input);
  const proof = facts(input, "tools", {
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    toolGrowthInputs: {
      ...(input.head === undefined ? {} : { head: input.head }),
      ...(input.handed === undefined ? {} : { handed: input.handed }),
      removeAbsentToolSearch: input.removeAbsentToolSearch,
    },
  });
  try {
    if (input.tools === undefined || !gate(input.enabled) || !writable(input))
      return { status: "unchanged", snapshot: undefined };
    if (selection(input.history).renderPointAfterSnapshot)
      return { status: "unchanged", snapshot: undefined };
    const previous = readNativePromptSnapshot(input.history);
    if (!previous) return { status: "unchanged", snapshot: undefined };
    const tools = snapshot(input.tools),
      descriptions = new Map(
        previous.tools.map((tool) => [tool.name, tool.description]),
      ),
      handed = input.handed === undefined ? undefined : snapshot(input.handed),
      handedNames = new Set(handed?.names);
    const additions = tools.filter((tool) => !descriptions.has(tool.name));
    const replacements = new Map(
      tools
        .filter(
          (tool) =>
            handedNames.has(tool.name) &&
            descriptions.get(tool.name) !== tool.description,
        )
        .map((tool) => [tool.name, tool]),
    );
    const names = new Set(tools.map((tool) => tool.name));
    const remove =
      descriptions.has("ToolSearch") &&
      !names.has("ToolSearch") &&
      gate(input.removeAbsentToolSearch);
    const prefix = previous.cliPrefix ?? input.head?.cliPrefix;
    const merged = mergeNativePromptWireShape(
      previous.wireShape,
      input.head?.wireShape,
      input.replayEnabled,
    );
    if (
      !additions.length &&
      !replacements.size &&
      prefix === previous.cliPrefix &&
      !merged.changed &&
      !remove
    ) {
      if (handed !== undefined)
        owner(() =>
          host.noteRedescribed(previous.reference, handed, [...names]),
        );
      return frozen({ status: "unchanged", snapshot: previous });
    }
    for (const tool of tools)
      if (
        tool.schema !== undefined &&
        (!descriptions.has(tool.name) || replacements.get(tool.name) === tool)
      ) {
        const provenance = known(host.toolSchemaProvenance(tool));
        if (provenance !== "actual-request-wire-entry")
          throw new UnsupportedFact(
            "Tool schema has no actual request owner provenance",
          );
      }
    const payload: NativePromptSnapshotPayload = {
      type: "prompt_snapshot",
      systemPrompt: [...previous.systemPrompt],
      tools: [
        ...previous.tools
          .filter((tool) => !(remove && tool.name === "ToolSearch"))
          .map((tool) => replacements.get(tool.name) ?? tool),
        ...additions,
      ].map(({ name, description, schema, server }) => ({
        name,
        description,
        ...(schema ? { schema } : {}),
        ...(server !== undefined ? { server } : {}),
      })),
      ...(prefix !== undefined ? { cliPrefix: prefix } : {}),
      ...(previous.reminderFold !== undefined
        ? { reminderFold: previous.reminderFold }
        : {}),
      ...merged.wireShape,
      ...(previous.echoWireToolInputs !== undefined
        ? { echoWireToolInputs: previous.echoWireToolInputs }
        : {}),
      ...(previous.contextRendering !== undefined
        ? { contextRendering: previous.contextRendering }
        : {}),
    };
    const creation = create(host, "tools", payload, previous);
    owner(() => host.noteCopied(previous.reference, reference(creation)));
    if (handed !== undefined)
      owner(() =>
        host.noteRedescribed(reference(creation), handed, [...names]),
      );
    return frozen({ status: "created", creation });
  } catch (error) {
    if (error instanceof NativePromptSnapshotCaptureError) throw error;
    return frozen({
      status: "unsupported",
      reasons: [
        error instanceof Error
          ? error.message
          : "Unknown snapshot tool host fact",
      ],
      facts: proof,
    });
  }
}
