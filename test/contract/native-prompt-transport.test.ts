import assert from "node:assert/strict";
import { createServer } from "node:http";
import { onTestFinished, test } from "bun:test";
import { AnthropicProvider } from "../../src/provider.js";
import { ApiAttemptBudget } from "../../src/attempt-ledger.js";
import {
  NativePromptPreparationError,
  type NativePromptTransportAttempt,
  type NativePromptTransportHost,
} from "../../src/native-prompt-transport.js";
import {
  prepareNativePromptRequest,
  verifyNativePromptPreparedRequest,
  type NativePromptRequestInput,
  type NativePromptRequestPlan,
} from "../../src/native-prompt-request.js";
import type { NativePromptFact } from "../../src/native-prompt-snapshot.js";
import type { CompletionRequest } from "../../src/types.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

const MODEL = "claude-sonnet-4-6";
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
function sourceFacts(
  actual: NativePromptTransportAttempt,
): NativePromptRequestInput {
  return {
    attempt: {
      requestedModel: actual.requestedModel,
      wireModel: actual.wireModel,
      transport: actual.transport,
    },
    snapshot: {
      source: "from_snapshot",
      systemPrompt: ["ACTUAL_SAVED_SYSTEM"],
      tools: [
        {
          name: "Read",
          description: "SAVED_DESCRIPTION",
          schema: {
            name: "Read",
            description: "SAVED_WIRE_DESCRIPTION",
            input_schema: {
              type: "object",
              properties: { saved: { type: "number" } },
            },
          },
        },
        { name: "ABSENT", description: "STICKY_HISTORY_UNAVAILABLE" },
      ],
      recordedCliPrefix:
        "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      recordedWireShape: { systemTurns: false },
      snapshotHash: "actual-owned-snapshot",
      creation: undefined,
    },
    currentTools: actual.currentTools.map((baseEntry) => {
      assert.equal(typeof baseEntry.name, "string");
      if (typeof baseEntry.name !== "string") assert.fail();
      return {
        name: baseEntry.name,
        baseEntry,
        facts: {
          origin: known("current-render"),
          deferred: known(false),
          ignoreRecordedText: known(false),
          excludeRecordedSchema: known(false),
          withoutToolDescribeHooks: known(true),
          rewrittenByHook: known(false),
          hookCacheBreakerPresent: known(false),
          citationTool: known(false),
          modelAllowsCitations: known(false),
          limitedAttributes: known(false),
          allowDeferredWhenLimited: known(false),
        },
      };
    }),
    system: {
      systemContext: known({ fixture: "ACTUAL_CONTEXT" }),
      attributionHeader: known(""),
      provider: known("other"),
      isNonInteractive: known(false),
      hasAppendSystemPrompt: known(false),
      globalCache: known(false),
      skipGlobalCacheForSystemPrompt: known(false),
      promptCaching: known(!actual.disablePromptCaching),
      cacheTtl: known(undefined),
      cacheScopeRefused: known(false),
    },
    actualHeadWireShape: known({ systemTurns: false }),
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
async function fixture(jsonFallback = false) {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += String(part);
      bodies.push(JSON.parse(body));
      const message = {
        id: "owned-reply",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "ACTUAL_FINAL" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
      };
      if (jsonFallback) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          fixtureSse([
            {
              type: "message_start",
              message: {
                ...message,
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: message.content[0],
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 3 },
            },
            { type: "message_stop" },
          ]),
        );
      }
    })().catch((error) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    bodies,
    provider: new AnthropicProvider({
      apiKey: "owned-dummy",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 2,
    }),
  };
}
function request(
  host: NativePromptTransportHost,
  extra: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    model: MODEL,
    system: "ACTUAL_CURRENT_SYSTEM",
    messages: [
      { role: "user", content: [{ type: "text", text: "ACTUAL_PROMPT" }] },
    ],
    tools: [
      {
        name: "Read",
        description: "ACTUAL_CURRENT_DESCRIPTION",
        input_schema: {
          type: "object",
          properties: { fresh: { type: "string" } },
        },
      },
    ],
    maxTokens: 100,
    signal: new AbortController().signal,
    onText: () => {},
    nativePromptPreparation: host,
    ...extra,
  };
}

test("actual provider applies saved prompt/schema/prefix before serialization and awaits earlier inline capture", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    budget = new ApiAttemptBudget(1);
  let plan: NativePromptRequestPlan | undefined,
    captured = false;
  const host: NativePromptTransportHost = {
    prepare: (actual) => {
      assert.equal(actual.currentSystem, "ACTUAL_CURRENT_SYSTEM");
      assert.ok(Object.isFrozen(actual.currentTools[0]?.input_schema));
      const facts = sourceFacts(actual),
        prepared = prepareNativePromptRequest(facts);
      assert.equal(prepared.status, "prepared");
      if (prepared.status === "prepared") plan = prepared.plan;
      return facts;
    },
    onInlineToolsDeclared: async (declarations) => {
      assert.deepEqual(
        declarations.map((entry) => entry.name),
        ["Read"],
      );
      assert.equal(declarations[0]?.description, "SAVED_WIRE_DESCRIPTION");
      assert.ok(Object.isFrozen(declarations));
      entered.resolve();
      await release.promise;
      captured = true;
    },
  };
  const completed = f.provider.complete(
    request(host, {
      attemptBudget: budget,
      nativeRequestPrepared: (actual) => {
        assert.ok(captured && plan);
        assert.deepEqual(verifyNativePromptPreparedRequest(actual, plan), {
          status: "verified",
        });
      },
    }),
  );
  await entered.promise;
  assert.equal(f.bodies.length, 0);
  assert.equal(budget.remaining, 1);
  release.resolve();
  await completed;
  assert.equal(f.bodies.length, 1);
  const body = JSON.stringify(f.bodies[0]);
  assert.match(body, /ACTUAL_SAVED_SYSTEM/);
  assert.match(body, /ACTUAL_CONTEXT/);
  assert.match(body, /running within the Claude Agent SDK/);
  assert.match(body, /SAVED_WIRE_DESCRIPTION/);
  assert.doesNotMatch(
    body,
    /ACTUAL_CURRENT_SYSTEM|ACTUAL_CURRENT_DESCRIPTION|STICKY_HISTORY_UNAVAILABLE|ABSENT/,
  );
});

test("unsupported source facts, substituted current vectors and sink failure stay local with zero attempt use", async () => {
  const f = await fixture();
  for (const variant of [
    "unknown",
    "vector",
    "transport",
    "sink",
    "decorated",
  ] as const) {
    const budget = new ApiAttemptBudget(1);
    const decoratedTool = {
      name: "Read",
      description: "ACTUAL",
      input_schema: { type: "object" as const },
      cache_control: { type: "ephemeral" },
    };
    let prepared = 0;
    const host: NativePromptTransportHost = {
      prepare: (actual) => {
        prepared++;
        const facts = sourceFacts(actual);
        if (variant === "unknown")
          facts.stages.ownershipDecoration = {
            status: "unsupported",
            reason: "ACTUAL_UNKNOWN_STAGE",
          };
        if (variant === "vector") facts.currentTools = [];
        if (variant === "transport") facts.attempt.transport = "json";
        return facts;
      },
      onInlineToolsDeclared: () => {
        if (variant === "sink") throw new Error("ACTUAL_SINK_FAILURE");
      },
    };
    await assert.rejects(
      f.provider.complete(
        request(host, {
          attemptBudget: budget,
          ...(variant === "decorated"
            ? {
                tools: [decoratedTool],
              }
            : {}),
        }),
      ),
      NativePromptPreparationError,
    );
    assert.equal(prepared, 1);
    assert.equal(budget.remaining, 1);
    assert.equal(f.bodies.length, 0);
  }
});

test("actual stream-to-JSON fallback prepares and captures both actual attempt vectors", async () => {
  const f = await fixture(true),
    attempts: string[] = [],
    declarations: string[] = [];
  await f.provider.complete(
    request(
      {
        prepare: (actual) => {
          attempts.push(actual.transport);
          return sourceFacts(actual);
        },
        onInlineToolsDeclared: (_tools, actual) => {
          declarations.push(actual.transport);
        },
      },
      { disablePromptCaching: true },
    ),
  );
  assert.deepEqual(attempts, ["stream", "json"]);
  assert.deepEqual(declarations, attempts);
  assert.equal(f.bodies.length, 2);
  assert.doesNotMatch(JSON.stringify(f.bodies), /cache_control/);
});

test("cancellation during source preparation retains the actual reason and dispatches nothing", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    cancellation = new AbortController(),
    reason = new Error("ACTUAL_PREPARE_CANCELLED"),
    budget = new ApiAttemptBudget(1);
  const completed = f.provider.complete(
    request(
      {
        prepare: async (actual) => {
          entered.resolve();
          await release.promise;
          return sourceFacts(actual);
        },
        onInlineToolsDeclared: () =>
          assert.fail("Cancelled declaration must not be created"),
      },
      { signal: cancellation.signal, attemptBudget: budget },
    ),
  );
  await entered.promise;
  cancellation.abort(reason);
  release.resolve();
  await assert.rejects(completed, (error: unknown) => error === reason);
  assert.equal(f.bodies.length, 0);
  assert.equal(budget.remaining, 1);
});
