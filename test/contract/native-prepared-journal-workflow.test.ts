import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { runAgent, type NativeAgentStopHooks } from "../../src/agent.js";
import { createHookRegistry, type HookInput } from "../../src/hooks.js";
import { NativeMemoryJournal } from "../../src/native-memory-journal.js";
import { NativeSessionLifetime } from "../../src/native-session-lifetime.js";
import { nativeLifecyclePreparedCommandRegistry } from "../../src/native-lifecycle-prepared.js";
import {
  createNativeLifecycleConsumer,
  runNativeLifecycleHookDispatch,
  type NativeLifecycleInput,
} from "../../src/native-lifecycle-hooks.js";
import { createNativeStartupFinalizer } from "../../src/native-startup-finalizer.js";
import { NativeStructuredInput } from "../../src/native-structured-input.js";
import { NativeStartupMetadataOwner } from "../../src/native-startup-metadata.js";
import { nativeTypedEnvironmentBoolean } from "../../src/native-rule-environment.js";
import {
  createNativeAttachmentEvent,
  renderNativePersistenceAttachment,
} from "../../src/native-persistence-events.js";
import { createNativeContextClassifiers } from "../../src/native-context-classifiers.js";
import type { NativePromptFact } from "../../src/native-prompt-snapshot.js";
import {
  recordNativeJsonResponse,
  snapshotNativeResponseJson,
} from "../../src/native-response-recording.js";
import {
  decodeNativeSession,
  isNativeObject,
  type NativeObject,
  type NativeSourceRow,
} from "../../src/native-session-codec.js";
import type { NativeJournalRequestOptions } from "../../src/native-session-journal.js";
import type {
  NativeHookProgressRow,
  NativeStopHookSummaryRow,
} from "../../src/native-hook-progress.js";
import { importNativeSessionFile } from "../../src/native-session-import.js";
import { AnthropicProvider } from "../../src/provider.js";
import { createTools } from "../../src/tools.js";
import { createToolHookRuntime } from "../../src/tool-hook-runtime.js";
import type { Message, ToolUse } from "../../src/types.js";
import { fixtureSse } from "../helpers/sse-fixture.js";

const SID = "11111111-1111-1111-1111-111111111111",
  MODEL = "claude-sonnet-4-6";
const signal = () => new AbortController().signal;
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const profile = () =>
  ({
    requestedModel: MODEL,
    recovery: {
      callIdToolResults: true,
      descendantOrder: "depth-first",
      timestampFallback: "reject",
    },
    host: {
      systemTurns: false,
      reminderFold: false,
      withoutAttachmentHooks: true,
      admit: () => true,
    },
    classifiers: createNativeContextClassifiers({
      systemTurns: false,
      pollEventsEnabled: false,
    }),
    echoApiBlockOrder: false,
    preserveTrailingThinking: false,
    signal: signal(),
  }) satisfies NativeJournalRequestOptions<NativeSourceRow>;

async function fixture(
  kind: "file" | "memory",
  duplicateStartupContext = false,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-prepared-journal-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let serial = 0;
  const stamp = () => ({
    uuid: `00000000-1111-1111-1111-${String(++serial).padStart(12, "0")}`,
    timestamp: "2026-11-18T00:00:00Z",
  });
  const path = join(root, `${SID}.jsonl`);
  const memory = async () => {
    const journal = await NativeMemoryJournal.open(
      { sessionId: SID },
      {
        stamp,
        admission: { admitProducer: () => true, admitRetention: () => true },
      },
      signal(),
    );
    return {
      kind: "memory" as const,
      journal,
      close: () => journal.close(signal()),
      rows: async () =>
        (await journal.readCommitted(signal())).state.entries.map((e) => e.row),
    };
  };
  const file = async () => {
    const lifetime = await NativeSessionLifetime.open(
      {
        ownership: { directory: root, path, admit: () => true },
        persistence: {
          context: {
            sessionId: SID,
            cwd: root,
            version: "2.1.326",
            userType: "external",
            sidechain: false,
          },
          admit: () => true,
        },
        initial: { kind: "fresh" },
        host: {
          stamp,
          persistence: {
            freshHead: known(
              "ordinary-unchanged-owner-without-attachment-rewrites",
            ),
            select: ({ history }) => ({
              facts: {
                userType: known("external"),
                evalFeature: known(false),
                sessionCodeMode: known(false),
                toolResults: { kind: "derive", context: history },
              },
              host: { original: () => known(undefined) },
            }),
          },
        },
      },
      signal(),
    );
    return {
      kind: "file" as const,
      journal: lifetime.journal,
      close: () => lifetime.close(signal()),
      rows: async () =>
        decodeNativeSession(await readFile(path), {
          parser: "source-line-fallback",
        }).lines.flatMap((l) =>
          isNativeObject(l.value) && typeof l.value.uuid === "string"
            ? [l.value]
            : [],
        ),
    };
  };
  const f = kind === "file" ? await file() : await memory();
  onTestFinished(() => f.close().catch(() => {}));
  await writeFile(join(root, "actual.txt"), "ACTUAL_FILE_CONTENT\n");
  const script = join(root, "hook.mjs"),
    log = join(root, "hook.log"),
    counter = join(root, "counter");
  await writeFile(
    script,
    `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
for await(const part of process.stdin){};
const [log,counter,event,label]=process.argv.slice(2);appendFileSync(log,event+':'+label+'\\n');
let output={};if(event==='Stop'){let n=0;try{n=Number(readFileSync(counter,'utf8'))}catch{};writeFileSync(counter,String(n+1));if(n===0)output={decision:'block',reason:'ACTUAL_STOP_REASON'}}
else output={hookSpecificOutput:{hookEventName:event,additionalContext:event==='SessionStart'&&${duplicateStartupContext}?'OLD':label,...event==='SessionStart'?{initialUserMessage:'INITIAL_'+label,sessionTitle:'TITLE_'+label}:{}}};
process.stdout.write(JSON.stringify(output));`,
  );
  const declaration = (event: string, label: string) => ({
    type: "command",
    command: process.execPath,
    args: [script, log, counter, event, label],
  });
  const registry = createHookRegistry([
    {
      source: "userSettings",
      hooks: {
        SessionStart: [
          {
            hooks: [
              declaration("SessionStart", "OLD"),
              declaration("SessionStart", "NEW"),
            ],
          },
        ],
        UserPromptSubmit: [
          { hooks: [declaration("UserPromptSubmit", "ACTUAL_PROMPT_CONTEXT")] },
        ],
        Stop: [{ hooks: [declaration("Stop", "stop")] }],
        PreToolUse: [
          { hooks: [declaration("PreToolUse", "ACTUAL_PRE_CONTEXT")] },
        ],
        PostToolUse: [
          { hooks: [declaration("PostToolUse", "ACTUAL_POST_CONTEXT")] },
        ],
      },
    },
  ]);
  onTestFinished(() => registry.close());
  const initialMessages: string[] = [],
    hookTitles: string[] = [];
  const runOptions = () => ({
    cwd: root,
    projectDir: root,
    env: {},
    defaultTimeoutMs: 3000,
    onResult: (result: import("../../src/hooks.js").HookResult) => {
      if (result.event === "SessionStart") {
        if (result.initialUserMessage)
          initialMessages.push(result.initialUserMessage);
        if (result.sessionTitle) hookTitles.push(result.sessionTitle);
      }
    },
  });
  const startupRoot: { title?: string; agentName?: string } = {};
  const input = new NativeStructuredInput<NativeObject>({
    input: {
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify({
          type: "user",
          session_id: "",
          message: { role: "user", content: "ACTUAL_LATER_USER" },
          parent_tool_use_id: null,
        }) + "\n";
      },
    },
    host: {
      processLine: (text) => {
        const value = snapshotNativeResponseJson(JSON.parse(text));
        assert.ok(
          isNativeObject(value) &&
            value.type === "user" &&
            isNativeObject(value.message) &&
            value.message.role === "user" &&
            typeof value.message.content === "string",
        );
        return value;
      },
      serialize: JSON.stringify,
      configProbe: () => nativeTypedEnvironmentBoolean("0"),
      probeDiscarded: () => assert.fail("No probe in this owned input profile"),
      yieldTick: async () => {},
      parsed: () => {},
      lineBudgetExceeded: () => assert.fail("Bounded fixture input"),
      fatalInput: async () => {
        throw new Error("Unexpected structured input failure");
      },
      inputClosed: () => {},
    },
  });
  const metadata = new NativeStartupMetadataOwner({
    root: startupRoot,
    sessionId: SID,
    initial: { kind: "actual-new-root" },
    host: {
      reloadSkills: () => assert.fail("No reload requested"),
      invalidateEnvironment: () =>
        assert.fail("No environment-file owner supplied"),
      watchPaths: () => assert.fail("No watch paths requested"),
      unsupported: (fact) => assert.fail(fact.reason),
      title: {
        teamOwned: () => known(false),
        current: () => known(startupRoot.title),
        collisionYield: () => known(undefined),
        setTitle: (value) => {
          startupRoot.title = value;
        },
        setAgentName: (value) => {
          startupRoot.agentName = value;
        },
        sourcePathMatches: () =>
          assert.fail("Fresh title applies only its cache"),
        persistenceSkipped: () => assert.fail("No metadata append requested"),
        reappend: async () => {
          assert.fail("No title file write requested");
        },
        writeFailure: (error) => assert.fail(String(error)),
      },
    },
  });
  const queueOwner = {
    root: startupRoot,
    sessionId: SID,
    prependOwnedUserMessage: (text: string, by: "process") =>
      input.prependOwnedUserMessage(text, by),
  };
  const appliedTitles: Awaited<
    ReturnType<NativeStartupMetadataOwner["takeHookTitle"]>
  >[] = [];
  onTestFinished(async () => {
    await input.structuredInput.return();
    await metadata.close(startupRoot);
  });
  const progress: NativeHookProgressRow[] = [],
    summaries: NativeStopHookSummaryRow[] = [];
  const display = (hook: { command?: unknown; args?: unknown }) => {
    assert.equal(typeof hook.command, "string");
    const args: unknown[] = Array.isArray(hook.args)
      ? hook.args
      : assert.fail("Missing actual fixture arguments");
    assert.ok(
      args.every((v: unknown) => typeof v === "string" && !/[\s"'\\]/.test(v)),
    );
    // Fixture arguments have no shell quoting/control characters: native Up leaves them unchanged.
    return [hook.command, ...args].join(" ");
  };
  const dispatch = async (
    event: "SessionStart" | "UserPromptSubmit" | "Stop",
    actualSignal: AbortSignal,
    stopHookActive = false,
    history: () => Promise<readonly NativeObject[]> = async () => [],
    submittedPrompt = "ACTUAL_USER",
  ) => {
    const metadataLease =
      event === "SessionStart"
        ? metadata.begin(startupRoot, {
            sessionId: SID,
            source: "startup",
            newPluginsOnly: { presence: "absent" },
            agentContext: "absent",
            resumedMessages: { presence: "absent" },
            envFileSessionId: { presence: "absent" },
          })
        : undefined;
    const dispatchToolUseID = `actual-${event}-${++serial}`;
    const input: NativeLifecycleInput = {
      event,
      dispatchToolUseID,
      phase: "ordinary",
      ...(event === "SessionStart"
        ? { start: { source: "startup", newPluginsOnly: false } }
        : {}),
      ...(event === "UserPromptSubmit"
        ? {
            prompt: {
              submitted: submittedPrompt,
              typed: submittedPrompt,
              suppressOriginalPrompt: false,
              stoppedText: "stopped",
            },
          }
        : {}),
    };
    const hookInput: HookInput = {
      hook_event_name: event,
      session_id: SID,
      cwd: root,
      transcript_path: path,
      ...(event === "SessionStart"
        ? { source: "startup" }
        : event === "Stop"
          ? { stop_hook_active: stopHookActive }
          : { prompt: submittedPrompt, source: "sdk" }),
    };
    const displayById = new Map<string, string>();
    const nativeInput = snapshotNativeResponseJson(hookInput);
    assert.ok(isNativeObject(nativeInput));
    metadataLease?.dispatchReady();
    return runNativeLifecycleHookDispatch(
      {
        input,
        hookInput: nativeInput,
        host: {
          ...f.journal.lifecycleHost(actualSignal),
          ...metadataLease?.lifecycleHost,
          toolUseID: ({ purpose }) =>
            purpose === "UserPromptSubmit-context"
              ? `hook-${randomUUID()}`
              : randomUUID(),
        },
        stages: {
          classicOrFunctionChain: known(false),
          managedOrRemoteTransport: known(false),
          activeGoalOrTaskEnforcement: known(false),
          backgroundRewake: known(false),
        },
        runner: nativeLifecyclePreparedCommandRegistry({
          registry,
          runOptions,
          facts: (result) => ({
            output: known("structured"),
            command: known(
              displayById.get(result.id) ?? assert.fail("Unobserved command"),
            ),
            structuredSuccessNotice: known(undefined),
            retainMessageForStop: known(false),
            retainContextForStop: known(true),
            hasProgress: known(true),
          }),
          finalDispatch: (_input, plan) => ({
            admission: { status: "admitted", source: "actual-final-dispatch" },
            origins: known(
              plan.candidates.map((c) => ({
                id: c.id,
                nativeOrigin: {
                  namespace: "hook" as const,
                  settingsSource: "userSettings",
                },
              })),
            ),
            defaultShell: known("bash"),
            personalConfigRestricted: known(false),
            dispatchToolUseID,
            ...(event === "SessionStart" ? { matchQuery: "startup" } : {}),
          }),
          progressHost: {
            aliases: () => known([]),
            display: ({ candidate }) => {
              const command = display(candidate.hook);
              displayById.set(candidate.id, command);
              return known({ command });
            },
            stamp: () => f.journal.stampHookProgress(),
          },
        }),
        preparedCapture: {
          progress: async (row, policy) => {
            progress.push(row);
            await f.journal.captureHookProgress(row, policy, actualSignal);
          },
          summary: {
            host: { stamp: () => f.journal.stampStopSummary() },
            capture: async (creation) => {
              if (creation.status === "created") summaries.push(creation.row);
              await f.journal.captureStopSummary(creation, actualSignal);
            },
          },
          startup: {
            async finalize(input) {
              // Actual Zke applies its cached title before wun runs LBe.
              appliedTitles.push(
                await metadata.takeHookTitle(startupRoot, "fresh-cache"),
              );
              return createNativeStartupFinalizer({
                // This ordinary unchanged profile has no mM rewrite or concurrent producer.
                // Read the complete current vector after command completion, before publication.
                readHistory: async () => {
                  assert.equal(startupRoot.title, hookTitles.at(-1));
                  return {
                    status: "ready",
                    source: "actual-LBe",
                    rows: await history(),
                  };
                },
                rendering: {
                  render: ({ attachment }) =>
                    known({
                      rendered: [
                        ...renderNativePersistenceAttachment(attachment),
                      ],
                      renderedRole: "system",
                    }),
                },
              }).finalize(input);
            },
          },
        },
      },
      actualSignal,
    ).finally(() => metadataLease?.retire());
  };
  const requests: NativeObject[] = [],
    call: ToolUse = {
      type: "tool_use",
      id: "actual-read",
      name: "Read",
      input: { file_path: "actual.txt" },
    };
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += String(part);
      const parsed = snapshotNativeResponseJson(JSON.parse(body));
      assert.ok(isNativeObject(parsed));
      requests.push(parsed);
      const n = requests.length,
        blocks =
          n === 1
            ? [{ type: "text", text: "ACTUAL_READING" }, call]
            : [{ type: "text", text: `ACTUAL_ANSWER_${n}` }];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `actual-request-${n}`,
      });
      response.end(
        fixtureSse([
          {
            type: "message_start",
            message: {
              id: `actual-api-${n}`,
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
              diagnostics: { exact: n },
            },
          },
          ...blocks.flatMap((block, index) => [
            { type: "content_block_start", index, content_block: block },
            { type: "content_block_stop", index },
          ]),
          {
            type: "message_delta",
            delta: { stop_reason: n === 1 ? "tool_use" : "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]),
      );
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
  const provider = new AnthropicProvider({
    apiKey: "owned-dummy",
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
    allowNonStreamingFallback: false,
  });
  const tools = createTools({
    cwd: root,
    mode: "default",
    policy: { tools: ["Read"], allowedTools: [], disallowedTools: [] },
    approve: async () => false,
    hooks: createToolHookRuntime({
      registry,
      context: () => ({ session_id: SID, cwd: root, transcript_path: path }),
      runOptions,
      nativeCapture: f.journal.attachmentHost(signal()),
    }),
    onTextReadResult: async (facts) => {
      assert.equal(facts.permissionTrace.branch, "readonly");
      assert.equal(facts.nativeCompatibility.status, "supported");
      await f.journal.recordToolResult(
        { result: facts.coreResult, toolUseResult: facts.rawResult },
        signal(),
      );
    },
  });
  const messages: Message[] = [];
  const stops = {
    blockCap: known(undefined),
    run: (context: { signal: AbortSignal; stopHookActive: boolean }) =>
      dispatch("Stop", context.signal, context.stopHookActive),
    reactions: async (context: { signal: AbortSignal }) =>
      createNativeLifecycleConsumer(
        {
          event: "Stop",
          dispatchToolUseID: "actual-reactions",
          phase: "turn-end-reactions",
        },
        f.journal.lifecycleHost(context.signal),
      ).finish({ kind: "completed" }),
  };
  const base = {
    provider,
    tools,
    messages,
    model: MODEL,
    system: "ACTUAL_SYSTEM",
    maxTokens: 100,
    maxTurns: 5,
    autoCompact: false as const,
    signal: signal(),
    onEvent: () => {},
  };
  const run = () =>
    f.kind === "memory"
      ? runAgent({
          ...base,
          nativeJournal: {
            journal: f.journal,
            requestProfile: profile,
            admitToolCall: (t) => t.name === "Read",
            stopHooks: stops satisfies NativeAgentStopHooks<
              Awaited<ReturnType<typeof f.journal.readCommitted>>
            >,
          },
        })
      : runAgent({
          ...base,
          nativeJournal: {
            journal: f.journal,
            requestProfile: profile,
            admitToolCall: (t) => t.name === "Read",
            stopHooks: stops,
          },
        });
  return {
    ...f,
    root,
    path,
    messages,
    dispatch,
    requests,
    progress,
    summaries,
    run,
    input,
    metadata,
    startupRoot,
    queueOwner,
    initialMessages,
    hookTitles,
    appliedTitles,
  };
}

for (const kind of ["file", "memory"] as const) {
  for (const duplicateStartupContext of [false, true]) {
    test(`${kind} actual startup metadata and ${duplicateStartupContext ? "whole-vector drop" : "partial context"} -> queued input -> HTTP Read Pre/Post -> Stop retry`, async () => {
      const f = await fixture(kind, duplicateStartupContext);
      const old = createNativeAttachmentEvent(
        {
          type: "hook_additional_context",
          hookName: "SessionStart",
          hookEvent: "SessionStart",
          toolUseID: "SessionStart",
          content: ["OLD"],
        },
        f.journal.stampAttachment(),
      );
      await f.journal.lifecycleHost(signal()).capture({
        event: old,
        cause: {
          event: "SessionStart",
          dispatchToolUseID: "prior-start",
          branch: "actual-context",
        },
      });
      await f.journal.recordUser(
        { role: "user", content: [{ type: "text", text: "PRIOR_USER" }] },
        "prior-prompt",
        signal(),
      );
      await f.journal.recordResponse(
        recordNativeJsonResponse(
          { requestedModel: MODEL, host: f.journal.responseHost },
          {
            id: "prior-api",
            type: "message",
            role: "assistant",
            model: MODEL,
            content: [{ type: "text", text: "PRIOR_ANSWER" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          [{ type: "text", text: "PRIOR_ANSWER" }],
        ),
        signal(),
      );
      const startup = await f.dispatch("SessionStart", signal(), false, f.rows);
      assert.equal(startup.startupRetention, "retained");
      const aggregate = startup.emitted.find(
        (e) =>
          isNativeObject(e.event.attachment) &&
          e.event.attachment.type === "hook_additional_context",
      );
      if (duplicateStartupContext) assert.deepEqual(startup.emitted, []);
      else {
        assert.ok(aggregate && isNativeObject(aggregate.event.attachment));
        assert.deepEqual(aggregate.event.attachment.content, ["NEW"]);
      }
      const afterStart = await f.rows();
      if (aggregate)
        assert.equal(
          afterStart.filter((r) => r.uuid === aggregate.event.uuid).length,
          1,
        );
      assert.equal(f.initialMessages.length, 2);
      assert.equal(new Set(f.initialMessages).size, 2);
      const expectedInitial = f.initialMessages.at(-1);
      assert.ok(expectedInitial);
      assert.equal(
        f.metadata.snapshot(f.startupRoot).pendingInitialUserMessage,
        expectedInitial,
      );
      assert.deepEqual(f.appliedTitles[0], {
        status: "cached",
        title: f.hookTitles.at(-1),
      });
      assert.deepEqual(
        await f.metadata.takeHookTitle(f.startupRoot, "fresh-cache"),
        { status: "absent" },
      );
      assert.equal(f.startupRoot.title, f.hookTitles.at(-1));
      assert.equal(f.startupRoot.agentName, f.hookTitles.at(-1));
      assert.deepEqual(
        f.metadata.takeInitialInput(f.startupRoot, f.queueOwner),
        { status: "enqueued" },
      );
      assert.deepEqual(
        f.metadata.takeInitialInput(f.startupRoot, f.queueOwner),
        { status: "absent" },
      );
      const firstInput = await f.input.structuredInput.next();
      assert.ok(!firstInput.done && isNativeObject(firstInput.value.message));
      const inputRow = firstInput.value;
      assert.equal(inputRow.session_id, "");
      assert.equal(Object.hasOwn(inputRow, "uuid"), false);
      assert.equal(Object.hasOwn(inputRow, "timestamp"), false);
      assert.equal(f.input.isLocallyPrependedMessage(inputRow), true);
      assert.equal(f.input.isPersonsOwnPrepend(inputRow), false);
      assert.equal(firstInput.value.message.content, expectedInitial);
      const submit = await f.dispatch(
        "UserPromptSubmit",
        signal(),
        false,
        undefined,
        expectedInitial,
      );
      assert.equal(submit.unsupported.length, 0);
      const human: Message = {
        role: "user",
        content: [{ type: "text", text: expectedInitial }],
      };
      f.messages.push(human);
      await f.journal.recordUser(human, "actual-prompt", signal());
      const result = await f.run();
      assert.equal(result.turns, 3);
      assert.equal(f.requests.length, 3);
      assert.deepEqual(result.nativeTermination, { reason: "completed" });
      assert.equal(f.summaries.length, 2);
      assert.deepEqual(
        f.summaries.map((s) => s.hookCount),
        [1, 1],
      );
      assert.deepEqual(
        f.summaries.map((s) => s.hookErrors),
        [["ACTUAL_STOP_REASON"], []],
      );
      const retry = JSON.stringify(f.requests[2]?.messages);
      for (const marker of [
        "ACTUAL_PRE_CONTEXT",
        "ACTUAL_FILE_CONTENT",
        "ACTUAL_POST_CONTEXT",
        "ACTUAL_STOP_REASON",
      ])
        assert.equal(retry.split(marker).length - 1, 1, marker);
      assert.doesNotMatch(retry, /hook blocking error from command/);
      const retained = await f.rows();
      const createdUsers = retained.filter(
        (row) =>
          row.type === "user" &&
          isNativeObject(row.message) &&
          JSON.stringify(row.message.content) === JSON.stringify(human.content),
      );
      assert.equal(createdUsers.length, 1);
      const createdUser = createdUsers[0];
      assert.ok(createdUser && typeof createdUser.uuid === "string");
      assert.match(createdUser.uuid, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
      assert.equal(Object.hasOwn(inputRow, "uuid"), false);
      assert.equal(
        retained.filter((r) => r.type === "progress").length,
        kind === "memory" ? (duplicateStartupContext ? 2 : 4) : 0,
      );
      assert.equal(
        retained.filter((r) => r.subtype === "stop_hook_summary").length,
        2,
      );
      assert.equal(
        f.progress.filter((r) => r.data.hookEvent === "UserPromptSubmit")
          .length,
        1,
      );
      for (const row of f.progress.filter(
        (r) => r.data.hookEvent === "UserPromptSubmit",
      ))
        assert.ok(retained.every((r) => r.uuid !== row.uuid));
      for (const summary of f.summaries) {
        const index = retained.findIndex((r) => r.uuid === summary.uuid);
        assert.ok(index > 0);
        assert.equal(
          retained[index]?.parentUuid,
          kind === "file" ? retained[index - 1]?.uuid : undefined,
        );
      }
      const readRow = retained.find((r) => isNativeObject(r.toolUseResult));
      assert.ok(readRow);
      const assistant = retained.find(
        (r) => r.uuid === readRow.sourceToolAssistantUUID,
      );
      assert.ok(assistant && isNativeObject(assistant.message));
      assert.deepEqual(assistant.message.diagnostics, { exact: 1 });
      assert.equal(assistant.requestId, "actual-request-1");
      const wireInput = await f.input.structuredInput.next();
      assert.ok(!wireInput.done && isNativeObject(wireInput.value.message));
      assert.equal(f.input.isLocallyPrependedMessage(wireInput.value), false);
      assert.equal(wireInput.value.message.content, "ACTUAL_LATER_USER");
      const next: Message = {
        role: "user",
        content: [{ type: "text", text: "ACTUAL_LATER_USER" }],
      };
      f.messages.push(next);
      await f.journal.recordUser(next, "later-prompt", signal());
      await f.run();
      assert.match(
        JSON.stringify(f.requests[0]?.messages),
        new RegExp(expectedInitial),
      );
      const overwrittenInitial = f.initialMessages[0];
      assert.ok(overwrittenInitial && overwrittenInitial !== expectedInitial);
      assert.ok(
        f.requests.every(
          (request) =>
            !JSON.stringify(request.messages).includes(overwrittenInitial),
        ),
      );
      assert.match(
        JSON.stringify(f.requests[3]?.messages),
        /hook blocking error from command/,
      );
      for (const request of f.requests)
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /hook_progress|stop_hook_summary|"uuid"/,
        );
      if (f.kind === "file") {
        const cold = await importNativeSessionFile({
          path: f.path,
          cwd: f.root,
          model: MODEL,
          signal: signal(),
          env: {},
        });
        assert.match(
          JSON.stringify(cold.session.messages),
          /ACTUAL_LATER_USER/,
        );
        assert.doesNotMatch(
          JSON.stringify(cold.session.messages),
          /hook_progress|stop_hook_summary/,
        );
      }
      await f.close();
      if (f.kind === "memory")
        assert.deepEqual((await readdir(f.root)).sort(), [
          "actual.txt",
          "counter",
          "hook.log",
          "hook.mjs",
        ]);
      const commands = (await readFile(join(f.root, "hook.log"), "utf8"))
        .trim()
        .split("\n");
      assert.equal(commands.filter((v) => v.startsWith("Stop:")).length, 3);
      assert.equal(
        commands.filter((v) => v.startsWith("SessionStart:")).length,
        2,
      );
      assert.equal(
        commands.filter((v) => v.startsWith("PreToolUse:")).length,
        1,
      );
      assert.equal(
        commands.filter((v) => v.startsWith("PostToolUse:")).length,
        1,
      );
    });
  }
}
