import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  prepareNativePromptRequest,
  prepareNativePromptSystem,
  replayNativePromptTool,
  verifyNativePromptPreparedRequest,
  type NativePromptCurrentTool,
  type NativePromptRequestInput,
  type NativePromptRequestResult,
  type NativePromptSystemFacts,
} from "../src/native-prompt-request.js";
import type {
  NativePromptFact,
  NativePromptSnapshotPlan,
} from "../src/native-prompt-snapshot.js";
import {
  captureNativePreparedRequest,
  type NativePreparedRequest,
} from "../src/native-request-capture.js";
import { captureNativePersistenceJson } from "../src/native-persistence-events.js";
import {
  isNativeObject,
  type NativeObject,
} from "../src/native-session-codec.js";
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const unknown = (reason = "unknown actual source fact") => ({
  status: "unsupported" as const,
  reason,
});
const CLI = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const AGENT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const DYNAMIC = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
  STATIC = "__SYSTEM_PROMPT_STATIC_BREAKPOINT__";
const REPORTING_BODY =
  "# Reporting outcomes\n\nReport what actually happened, not what you intended. When you say something is done, sent, saved, fixed, or verified, that claim must rest on a result you observed in this session — tool output, the file as it now reads, the page as it now loads — not on what the step should have produced. If you did not check, say you did not check. If any step failed, was skipped, or came back different from what you expected, say so in the first sentence of your report, before anything else, even when the rest of the work succeeded. Never quietly work around a failure in a way that makes it look resolved; a problem the user can see is recoverable, one your summary hides is not. When you stop before the task is complete, your first line says so plainly and names what is left. Do not describe partial work as done, and do not let a summary read as more certain than the evidence behind it.";
function system(
  extra: Partial<NativePromptSystemFacts> = {},
): NativePromptSystemFacts {
  return {
    systemContext: known({}),
    attributionHeader: known("x-anthropic-billing-header: owned=test;"),
    provider: known("other"),
    isNonInteractive: known(false),
    hasAppendSystemPrompt: known(false),
    globalCache: known(false),
    skipGlobalCacheForSystemPrompt: known(false),
    promptCaching: known(true),
    cacheTtl: known(undefined),
    cacheScopeRefused: known(false),
    ...extra,
  };
}
function tool(name = "Read"): NativePromptCurrentTool {
  return {
    name,
    baseEntry: {
      name,
      description: `fresh ${name}`,
      input_schema: {
        type: "object",
        properties: { fresh: { type: "string" } },
      },
    },
    server: "actual-current-server",
    facts: {
      origin: known("current-render"),
      deferred: known(false),
      ignoreRecordedText: known(false),
      excludeRecordedSchema: known(false),
      withoutToolDescribeHooks: known(false),
      rewrittenByHook: known(false),
      hookCacheBreakerPresent: known(false),
      citationTool: known(false),
      modelAllowsCitations: known(false),
      limitedAttributes: known(false),
      allowDeferredWhenLimited: known(false),
    },
  };
}
function input(): NativePromptRequestInput {
  const snapshot: NativePromptSnapshotPlan = {
    source: "from_snapshot",
    systemPrompt: ["SAVED PROMPT"],
    tools: [
      {
        name: "Read",
        description: "saved map",
        schema: {
          name: "Read",
          description: "saved wire",
          input_schema: {
            type: "object",
            properties: { saved: { type: "number" } },
          },
        },
        server: "old-server",
      },
      { name: "ABSENT", description: "sticky history, unavailable request" },
    ],
    recordedCliPrefix: undefined,
    recordedWireShape: { systemTurns: false },
    snapshotHash: "actual-old-hash",
    creation: undefined,
  };
  return {
    snapshot,
    currentTools: [tool()],
    system: system(),
    actualHeadWireShape: known({ systemTurns: false }),
    attempt: {
      requestedModel: "actual-requested-model",
      wireModel: "actual-wire-model",
      transport: "stream",
    },
    stages: {
      recordedOnlyTools: known(false),
      toolAdditionOrDeferredChannel: known(false),
      ownershipDecoration: known(false),
      schemaRefusalRepair: known(false),
      foundryFeatureRepair: known(false),
      inheritedThreadFields: known(false),
      extraToolSchemasOrPlaceholder: known(false),
    },
  };
}
function prepared(result: NativePromptRequestResult) {
  if (result.status !== "prepared") assert.fail(result.reasons.join(";"));
  return result.plan;
}
function object(value: unknown): NativeObject {
  const cloned = captureNativePersistenceJson(value);
  assert.ok(isNativeObject(cloned));
  return cloned;
}

test("system preparation appends actual context and classifies source header/prefix/body with exact cache omission", () => {
  const actual = prepareNativePromptSystem(
    ["BODY ONE", "BODY TWO"],
    undefined,
    system({
      systemContext: known({ cwd: "/owned", currentDate: "2026-01-01" }),
    }),
  );
  assert.equal(actual.cliPrefix, CLI);
  assert.deepEqual(actual.blocks, [
    { type: "text", text: "x-anthropic-billing-header: owned=test;" },
    { type: "text", text: CLI, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: "BODY ONE\n\nBODY TWO\n\ncwd: /owned\ncurrentDate: 2026-01-01",
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.equal(JSON.stringify(actual).includes('"scope":"org"'), false);
  const noCache = prepareNativePromptSystem(
    ["BODY"],
    SDK,
    system({
      promptCaching: known(false),
      cacheTtl: unknown(),
      cacheScopeRefused: unknown(),
      isNonInteractive: unknown(),
      hasAppendSystemPrompt: unknown(),
    }),
  );
  assert.ok(noCache.blocks.every((block) => block.cache_control === undefined));
  assert.equal(noCache.cliPrefix, SDK);
});

test("provider and actual noninteractive/append facts select prefix with source precedence", () => {
  assert.equal(
    prepareNativePromptSystem(
      [],
      AGENT,
      system({
        provider: known("vertex"),
        isNonInteractive: unknown(),
        hasAppendSystemPrompt: unknown(),
      }),
    ).cliPrefix,
    CLI,
  );
  assert.equal(
    prepareNativePromptSystem(
      [],
      undefined,
      system({
        isNonInteractive: known(true),
        hasAppendSystemPrompt: known(true),
      }),
    ).cliPrefix,
    SDK,
  );
  assert.equal(
    prepareNativePromptSystem(
      [],
      undefined,
      system({
        isNonInteractive: known(true),
        hasAppendSystemPrompt: known(false),
      }),
    ).cliPrefix,
    AGENT,
  );
  const override = prepareNativePromptSystem([AGENT], CLI, system());
  assert.equal(override.cliPrefix, CLI);
  assert.equal(
    override.blocks[1]?.text,
    AGENT,
    "J9s uses the last actual recognized prefix, while head reports zVr's selection",
  );
});

test("complete global boundary construction preserves static chunks and dynamic scope without generic joining", () => {
  const actual = prepareNativePromptSystem(
    [`STATIC A\n${STATIC}\nSTATIC B`, DYNAMIC, "DYNAMIC BODY"],
    undefined,
    system({ globalCache: known(true), cacheTtl: known("1h") }),
  );
  assert.deepEqual(actual.blocks, [
    { type: "text", text: "x-anthropic-billing-header: owned=test;" },
    { type: "text", text: CLI },
    {
      type: "text",
      text: "STATIC A\n",
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    },
    {
      type: "text",
      text: "\nSTATIC B",
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    },
    { type: "text", text: "DYNAMIC BODY" },
  ]);
  const one = prepareNativePromptSystem(
    ["STATIC", DYNAMIC, "DYNAMIC"],
    undefined,
    system({
      globalCache: known(true),
      skipGlobalCacheForSystemPrompt: known(true),
      cacheScopeRefused: known(true),
    }),
  );
  assert.deepEqual(one.blocks[2]?.cache_control, { type: "ephemeral" });
  assert.deepEqual(one.blocks[3]?.cache_control, { type: "ephemeral" });
  const inline = prepareNativePromptSystem(
    [`INLINE ${STATIC} TEXT`, DYNAMIC, "DYNAMIC"],
    undefined,
    system({ globalCache: known(true) }),
  );
  assert.equal(inline.blocks[2]?.text, `INLINE ${STATIC} TEXT`);
  assert.deepEqual(inline.blocks[3]?.cache_control, { type: "ephemeral" });
  const ordinary = prepareNativePromptSystem(
    [`A\n${STATIC}\nB`, DYNAMIC, "C"],
    undefined,
    system(),
  );
  assert.equal(ordinary.blocks[2]?.text, "A\n\nB\n\nC");
});

test("reporting outcomes only passes from an actual existing section with header and prefix; no body is synthesized", () => {
  const withSection = prepareNativePromptSystem(
    [REPORTING_BODY, "BODY"],
    undefined,
    system(),
  );
  assert.equal(withSection.blocks[2]?.text, REPORTING_BODY);
  assert.equal(withSection.blocks[2]?.cache_control, undefined);
  assert.equal(withSection.blocks[3]?.text, "BODY");
  const noHeader = prepareNativePromptSystem(
    [REPORTING_BODY, "BODY"],
    undefined,
    system({ attributionHeader: known("") }),
  );
  assert.equal(
    noHeader.blocks.some((block) => block.text === REPORTING_BODY),
    false,
  );
  const missing = prepareNativePromptSystem(["BODY"], undefined, system());
  assert.equal(
    missing.blocks.some((block) => block.text === REPORTING_BODY),
    false,
  );
});

test("H2 replays description/schema by strict parity and preserves current availability/order/server metadata", () => {
  const value = input();
  value.currentTools = [
    tool("Bash"),
    {
      ...tool(),
      baseEntry: { ...tool().baseEntry, eager_input_streaming: true },
    },
  ];
  const plan = prepared(prepareNativePromptRequest(value));
  assert.deepEqual(plan.availableNames, ["Bash", "Read"]);
  assert.deepEqual(
    plan.tools.map((entry) => entry.name),
    ["Bash", "Read"],
  );
  assert.equal(plan.tools[1]?.description, "saved wire");
  assert.deepEqual(
    plan.tools[1]?.input_schema,
    value.snapshot.tools?.[0]?.schema?.input_schema,
  );
  assert.equal(plan.tools[1]?.eager_input_streaming, true);
  assert.equal(plan.inlineDeclarations[1]?.server, "actual-current-server");
  assert.equal(JSON.stringify(plan.tools).includes("ABSENT"), false);
  assert.ok(Object.isFrozen(plan.tools[1]?.input_schema));
  const strict = tool();
  strict.baseEntry = { ...strict.baseEntry, strict: true };
  const mismatch = replayNativePromptTool(
    strict,
    value.snapshot.tools,
    undefined,
  );
  assert.equal(mismatch.entry.description, "saved wire");
  assert.deepEqual(mismatch.entry.input_schema, strict.baseEntry.input_schema);
  assert.equal(mismatch.entry.strict, true);
});

test("handed description refresh requires actual rewrite/cache-breaker and keeps schema exclusion separate", () => {
  const value = input(),
    current = tool();
  current.facts.rewrittenByHook = known(true);
  assert.equal(
    replayNativePromptTool(current, value.snapshot.tools, ["Read"]).entry
      .description,
    "saved wire",
  );
  current.facts.hookCacheBreakerPresent = known(true);
  assert.equal(
    replayNativePromptTool(current, value.snapshot.tools, ["Read"]).entry
      .description,
    "fresh Read",
  );
  current.facts.withoutToolDescribeHooks = known(true);
  assert.equal(
    replayNativePromptTool(current, value.snapshot.tools, ["Read"]).entry
      .description,
    "saved wire",
  );
  current.facts.excludeRecordedSchema = known(true);
  const excluded = replayNativePromptTool(
    current,
    value.snapshot.tools,
    undefined,
  );
  assert.equal(excluded.entry.description, "saved map");
  assert.deepEqual(excluded.entry.input_schema, current.baseEntry.input_schema);
  current.facts.ignoreRecordedText = known(true);
  assert.equal(
    replayNativePromptTool(current, value.snapshot.tools, undefined).entry
      .description,
    "fresh Read",
  );
});

test("deferred/citation/limited attributes follow actual H2 decisions and declarations use logical placement", () => {
  const value = input(),
    current = tool();
  current.baseEntry = {
    ...current.baseEntry,
    strict: true,
    eager_input_streaming: true,
  };
  current.facts.citationTool = known(true);
  current.facts.modelAllowsCitations = known(true);
  assert.equal(
    replayNativePromptTool(current, value.snapshot.tools, undefined).entry
      .citations,
    undefined,
    "saved entry lacking citations suppresses it",
  );
  const fresh = replayNativePromptTool(current, [], undefined);
  assert.deepEqual(fresh.entry.citations, { enabled: true });
  current.facts.limitedAttributes = known(true);
  const limited = replayNativePromptTool(current, [], undefined);
  assert.deepEqual(Object.keys(limited.entry).sort(), [
    "description",
    "input_schema",
    "name",
  ]);
  current.facts.deferred = known(true);
  const deferred = replayNativePromptTool(
    current,
    value.snapshot.tools,
    undefined,
  );
  assert.equal(deferred.entry.description, "fresh Read");
  assert.equal(deferred.entry.defer_loading, undefined);
  assert.equal(
    deferred.declaration,
    undefined,
    "do not infer logical inline placement from final defer_loading field",
  );
  current.facts.allowDeferredWhenLimited = known(true);
  assert.equal(
    replayNativePromptTool(current, [], undefined).entry.defer_loading,
    true,
  );
});

test("advanced channels, actual repairs, positive wire transforms and undecorated-base ambiguity are explicit unsupported facts", () => {
  for (const stage of [
    "recordedOnlyTools",
    "toolAdditionOrDeferredChannel",
    "ownershipDecoration",
    "schemaRefusalRepair",
    "foundryFeatureRepair",
    "inheritedThreadFields",
    "extraToolSchemasOrPlaceholder",
  ] as const) {
    const value = input();
    value.stages[stage] = known(true);
    const result = prepareNativePromptRequest(value);
    assert.equal(result.status, "unsupported");
    if (result.status === "unsupported")
      assert.equal(
        result.facts.stages[stage].status === "known" &&
          result.facts.stages[stage].value,
        true,
      );
  }
  const value = input();
  value.snapshot.recordedWireShape = { inlineTools: true };
  assert.equal(prepareNativePromptRequest(value).status, "unsupported");
  const decorated = input(),
    current = tool();
  current.baseEntry = {
    ...current.baseEntry,
    cache_control: { type: "ephemeral" },
  };
  decorated.currentTools = [current];
  assert.equal(prepareNativePromptRequest(decorated).status, "unsupported");
  const missing = input();
  missing.system.attributionHeader = unknown("actual Ipi result missing");
  assert.equal(prepareNativePromptRequest(missing).status, "unsupported");
  const duplicate = input();
  duplicate.currentTools = [tool(), tool()];
  assert.equal(prepareNativePromptRequest(duplicate).status, "unsupported");
});

test("actual pre-fetch serialization verifies the replay fragments and per-attempt facts without editing a sent body", async () => {
  const value = input(),
    plan = prepared(prepareNativePromptRequest(value));
  let observed: NativePreparedRequest | undefined;
  const serialized = JSON.stringify({
    model: plan.attempt.wireModel,
    stream: true,
    system: plan.system,
    tools: plan.tools,
    messages: [{ role: "user", content: "OWNED PROMPT" }],
  });
  await captureNativePreparedRequest(
    (actual) => {
      observed = actual;
    },
    serialized,
    plan.attempt.requestedModel,
    new AbortController().signal,
  );
  assert.ok(observed);
  assert.deepEqual(verifyNativePromptPreparedRequest(observed, plan), {
    status: "verified",
  });
  const changed = {
    ...observed,
    body: object({
      ...observed.body,
      tools: [
        { ...plan.tools[0], input_schema: { type: "object", properties: {} } },
      ],
    }),
  };
  assert.equal(
    verifyNativePromptPreparedRequest(changed, plan).status,
    "unsupported",
  );
  assert.equal(
    verifyNativePromptPreparedRequest(
      { ...observed, wireModel: "actual-fallback-model" },
      plan,
    ).status,
    "unsupported",
  );
  assert.equal(
    verifyNativePromptPreparedRequest({ ...observed, transport: "json" }, plan)
      .status,
    "unsupported",
  );
  assert.equal(Object.isFrozen(observed.body), true);
  assert.equal(
    verifyNativePromptPreparedRequest(
      {
        ...observed,
        body: object({
          ...observed.body,
          model: "different actual body model",
        }),
      },
      plan,
    ).status,
    "unsupported",
  );
});
