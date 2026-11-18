import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHookRegistry, type HookRunOptions } from "../src/hooks.js";
import {
  createNativeLifecycleAttachment,
  createNativeLifecycleConsumer,
  nativeLifecycleCommandRegistry,
  runNativeLifecycleHookDispatch,
  NativeLifecycleCaptureError,
  type NativeLifecycleCaptureHost,
  type NativeLifecycleCreation,
  type NativeLifecycleUnsupported,
  type NativeLifecycleInput,
  type NativeLifecycleCause,
  type NativeLifecycleCommandFacts,
  type NativeLifecycleRunStages,
  type NativeLifecycleRuntimeOptions,
} from "../src/native-lifecycle-hooks.js";
import type { NativePromptFact } from "../src/native-prompt-snapshot.js";
import { isNativeObject } from "../src/native-session-codec.js";

const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const stages = (): NativeLifecycleRunStages => ({
  classicOrFunctionChain: known(false),
  managedOrRemoteTransport: known(false),
  activeGoalOrTaskEnforcement: known(false),
  backgroundRewake: known(false),
});
const facts = (): NativeLifecycleCommandFacts => ({
  output: known("structured"),
  command: known("OWNED_COMMAND"),
  structuredSuccessNotice: known(undefined),
  retainMessageForStop: known(false),
  retainContextForStop: known(true),
  hasProgress: known(true),
});
const signal = () => new AbortController().signal;
const input = (event: NativeLifecycleInput["event"]): NativeLifecycleInput => ({
  event,
  dispatchToolUseID: id(90),
  phase: "ordinary",
  ...(event === "SessionStart"
    ? { start: { source: "startup", newPluginsOnly: false } }
    : {}),
});
const cause = (
  event: NativeLifecycleInput["event"],
  branch = "owned-creation",
): NativeLifecycleCause => ({ event, dispatchToolUseID: id(90), branch });
function fixture() {
  const creations: NativeLifecycleCreation[] = [],
    unsupported: NativeLifecycleUnsupported[] = [],
    metadata: Parameters<
      NonNullable<NativeLifecycleCaptureHost["startMetadata"]>
    >[0][] = [],
    stamps: Parameters<NativeLifecycleCaptureHost["stamp"]>[0][] = [];
  let serial = 0,
    toolIDs = 100;
  const host: NativeLifecycleCaptureHost = {
    stamp: (value) => {
      stamps.push(value);
      return {
        uuid: id(++serial),
        timestamp: `2026-01-01T00:00:00.${String(serial).padStart(3, "0")}Z`,
      };
    },
    toolUseID: ({ purpose }) =>
      purpose === "SessionStart-Q6t" ? id(++toolIDs) : `hook-${id(++toolIDs)}`,
    capture: (value) => {
      creations.push(value);
    },
    unsupported: (value) => {
      unsupported.push(value);
    },
    startMetadata: (value) => {
      metadata.push(value);
    },
  };
  return { host, creations, unsupported, metadata, stamps };
}
const attachment = (creation: NativeLifecycleCreation | undefined) => {
  assert.ok(creation);
  assert.ok(isNativeObject(creation.event.attachment));
  return creation.event.attachment;
};

async function commandFixture(
  event: "SessionStart" | "Stop",
  outputs: {
    label: string;
    delay?: number;
    output: unknown;
    once?: boolean;
    async?: boolean;
    exit?: number;
  }[],
) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-native-lifecycle-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "owned.mjs"),
    log = join(cwd, "commands.jsonl");
  await writeFile(
    script,
    `import {appendFileSync} from 'node:fs';let raw='';for await(const part of process.stdin)raw+=part;await new Promise(r=>setTimeout(r,Number(process.argv[3])));appendFileSync(process.argv[2],JSON.stringify({label:process.argv[4],input:JSON.parse(raw)})+'\\n');process.stdout.write(process.argv[5]);process.exitCode=Number(process.argv[6]);`,
  );
  const entries = outputs.map((entry) => ({
    type: "command",
    command: process.execPath,
    args: [
      script,
      log,
      String(entry.delay ?? 0),
      entry.label,
      typeof entry.output === "string"
        ? entry.output
        : JSON.stringify(entry.output),
      String(entry.exit ?? 0),
    ],
    ...(entry.once ? { once: true } : {}),
    ...(entry.async ? { async: true } : {}),
  }));
  const registry = createHookRegistry([
    { source: "owned-settings", hooks: { [event]: [{ hooks: entries }] } },
  ]);
  onTestFinished(() => registry.close());
  const runOptions = (): Omit<
    HookRunOptions,
    "signal" | "validateUpdatedInput"
  > => ({ cwd, projectDir: cwd, env: {}, defaultTimeoutMs: 3000 });
  const hookInput = {
    session_id: id(99),
    transcript_path: join(cwd, "owned.jsonl"),
    cwd,
    hook_event_name: event,
    ...(event === "SessionStart"
      ? { source: "startup" }
      : { stop_hook_active: false }),
  };
  return { cwd, log, registry, runOptions, hookInput };
}

test("SessionStart captures actual command settlement order, then one aggregate context row; initial prompt is deferred metadata", async () => {
  const f = fixture(),
    commands = await commandFixture("SessionStart", [
      {
        label: "SLOW",
        delay: 80,
        output: {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "SLOW",
            initialUserMessage: "LATER_PROMPT",
            sessionTitle: "OWNED_TITLE",
            watchPaths: ["owned/watch"],
            reloadSkills: true,
          },
        },
      },
      {
        label: "FAST",
        output: {
          continue: false,
          stopReason: "IGNORED_BY_NATIVE_START",
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "FAST",
          },
        },
      },
    ]);
  const runtime = nativeLifecycleCommandRegistry({
    registry: commands.registry,
    runOptions: commands.runOptions,
    facts: () => facts(),
  });
  const result = await runNativeLifecycleHookDispatch(
    {
      input: input("SessionStart"),
      hookInput: commands.hookInput,
      stages: stages(),
      host: f.host,
      runner: runtime,
    },
    signal(),
  );
  assert.deepEqual(
    f.creations.map((creation) => attachment(creation).type),
    ["hook_success", "hook_success", "hook_additional_context"],
  );
  assert.deepEqual(attachment(f.creations[2]).content, ["FAST", "SLOW"]);
  assert.equal(attachment(f.creations[0]).hookName, "SessionStart:startup");
  assert.equal(attachment(f.creations[2]).toolUseID, "SessionStart");
  assert.equal(result.preventContinuation, false);
  assert.equal(result.continue, false);
  assert.deepEqual(f.metadata, [
    { initialUserMessage: "LATER_PROMPT" },
    {
      reloadSkills: true,
      watchPaths: ["owned/watch"],
      sessionTitle: "OWNED_TITLE",
    },
  ]);
  assert.equal(f.unsupported.length, 0);
  assert.equal(f.stamps.length, 3);
  assert.match(await readFile(commands.log, "utf8"), /FAST/);
});

test("Stop contexts alone continue with separate actual rows; diagnostics remain empty and are not continuation feedback", async () => {
  const f = fixture(),
    commands = await commandFixture("Stop", [
      {
        label: "SLOW",
        delay: 60,
        output: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "SLOW",
          },
        },
      },
      {
        label: "FAST",
        output: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "FAST",
          },
        },
      },
    ]);
  const result = await runNativeLifecycleHookDispatch(
    {
      input: input("Stop"),
      hookInput: commands.hookInput,
      stages: stages(),
      host: f.host,
      runner: nativeLifecycleCommandRegistry({
        registry: commands.registry,
        runOptions: commands.runOptions,
        facts: () => facts(),
      }),
    },
    signal(),
  );
  assert.deepEqual(
    result.continuationEvents.map((event) =>
      isNativeObject(event.attachment) ? event.attachment.content : null,
    ),
    [["FAST"], ["SLOW"]],
  );
  assert.equal(result.continue, true);
  assert.equal(f.creations.length, 4);
  assert.ok(
    f.creations
      .filter((creation) => attachment(creation).type === "hook_success")
      .every((creation) => creation.event.rendered === undefined),
  );
});

test("Stop command diagnostic is created before stopped/feedback rows but retained after them, and prevention wins", async () => {
  const f = fixture(),
    commands = await commandFixture("Stop", [
      {
        label: "BLOCK",
        output: {
          continue: false,
          stopReason: "OWNED_STOP",
          decision: "block",
          reason: "OWNED_BLOCK",
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "OWNED_CONTEXT",
          },
        },
      },
    ]);
  const result = await runNativeLifecycleHookDispatch(
    {
      input: input("Stop"),
      hookInput: commands.hookInput,
      stages: stages(),
      host: f.host,
      runner: nativeLifecycleCommandRegistry({
        registry: commands.registry,
        runOptions: commands.runOptions,
        facts: () => facts(),
      }),
    },
    signal(),
  );
  assert.deepEqual(
    f.creations.map((creation) =>
      creation.event.type === "user" ? "feedback" : attachment(creation).type,
    ),
    [
      "hook_stopped_continuation",
      "feedback",
      "hook_blocking_error",
      "hook_additional_context",
    ],
  );
  assert.equal(f.creations[2]?.event.uuid, id(1));
  assert.equal(f.creations[0]?.event.uuid, id(2));
  assert.equal(f.creations[1]?.event.uuid, id(3));
  assert.equal(result.continue, false);
  assert.equal(result.preventContinuation, true);
  assert.deepEqual(result.continuationEvents, []);
  assert.ok(isNativeObject(f.creations[1]?.event.message));
  assert.equal(
    f.creations[1]?.event.message.content,
    "Stop hook feedback:\nOWNED_BLOCK",
  );
});

test("SessionStart block conversion owns a new Q6t identity, drops original blocking row and still delivers context", async () => {
  const f = fixture(),
    commands = await commandFixture("SessionStart", [
      {
        label: "BLOCK",
        output: {
          decision: "block",
          reason: "OWNED_BLOCK",
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "STILL_ALLOWED",
          },
        },
      },
    ]);
  const result = await runNativeLifecycleHookDispatch(
    {
      input: input("SessionStart"),
      hookInput: commands.hookInput,
      stages: stages(),
      host: f.host,
      runner: nativeLifecycleCommandRegistry({
        registry: commands.registry,
        runOptions: commands.runOptions,
        facts: () => facts(),
      }),
    },
    signal(),
  );
  assert.deepEqual(
    f.creations.map((creation) => attachment(creation).type),
    ["hook_non_blocking_error", "hook_additional_context"],
  );
  assert.equal(f.stamps.length, 3);
  assert.equal(f.creations[0]?.event.uuid, id(2));
  assert.equal(attachment(f.creations[0]).toolUseID, id(101));
  assert.equal(result.preventContinuation, false);
  assert.equal(result.continue, false);
});

test("SessionStart abort drops undelivered contexts/finish metadata; teardown, takeover and new-plugin metadata preserve source distinction", async () => {
  for (const end of ["aborted-in-loop", "orphaned"] as const) {
    const f = fixture(),
      consumer = createNativeLifecycleConsumer(input("SessionStart"), f.host);
    await consumer.consume({
      kind: "context",
      content: ["NEVER_APPEND"],
      cause: cause("SessionStart"),
      retainForStop: true,
    });
    await consumer.consume({ kind: "session-title", text: "NEVER_APPLY" });
    await consumer.finish({ kind: end });
    assert.equal(f.creations.length, 0);
    assert.equal(f.metadata.length, 0);
  }
  const f = fixture(),
    consumer = createNativeLifecycleConsumer(input("SessionStart"), f.host);
  await consumer.consume({
    kind: "context",
    content: ["EARLY"],
    cause: cause("SessionStart"),
    retainForStop: true,
  });
  await consumer.overtakeStart();
  await consumer.consume({
    kind: "initial-user-message",
    text: "LATE_PROMPT",
    cause: cause("SessionStart"),
  });
  await consumer.consume({
    kind: "context",
    content: ["LATE"],
    cause: cause("SessionStart"),
    retainForStop: true,
  });
  await consumer.consume({ kind: "watch-paths", paths: ["a"] });
  await consumer.finish({ kind: "control-stream-closed" });
  assert.deepEqual(
    f.creations.map((creation) => attachment(creation).content),
    [["EARLY"], ["EARLY", "LATE"]],
  );
  assert.notEqual(f.creations[0]?.event.uuid, f.creations[1]?.event.uuid);
  assert.deepEqual(f.metadata, [
    { lateInitialUserMessage: "LATE_PROMPT" },
    { watchPaths: ["a"], addWatchPaths: true },
  ]);
  const g = fixture(),
    newPlugins = createNativeLifecycleConsumer(
      {
        ...input("SessionStart"),
        start: { source: "resume", newPluginsOnly: true },
      },
      g.host,
    );
  await newPlugins.consume({
    kind: "initial-user-message",
    text: "IGNORED",
    cause: cause("SessionStart"),
  });
  await newPlugins.consume({ kind: "session-title", text: "IGNORED" });
  await newPlugins.consume({ kind: "watch-paths", paths: ["b"] });
  await newPlugins.finish({ kind: "completed" });
  assert.deepEqual(g.metadata, [{ watchPaths: ["b"], addWatchPaths: true }]);
});

test("genuine UserPromptSubmit yields own hook UUIDs, skip empty success, return at first block and preserve suppression", async () => {
  const f = fixture(),
    consumer = createNativeLifecycleConsumer(
      {
        ...input("UserPromptSubmit"),
        prompt: {
          submitted: "RAW_PROMPT",
          typed: "RAW_PROMPT",
          suppressOriginalPrompt: false,
          stoppedText: "ACTUAL_STOPPED_TEXT",
        },
      },
      f.host,
    );
  const empty = createNativeLifecycleAttachment(
    f.host,
    {
      type: "hook_success",
      hookName: "UserPromptSubmit",
      hookEvent: "UserPromptSubmit",
      toolUseID: id(90),
      content: "",
    },
    cause("UserPromptSubmit"),
  );
  await consumer.consume({
    kind: "message",
    creation: empty,
    retainForStop: false,
  });
  await consumer.consume({
    kind: "context",
    content: ["CTX"],
    cause: cause("UserPromptSubmit"),
    retainForStop: false,
  });
  await consumer.consume({
    kind: "blocking",
    text: "BLOCK",
    command: "OWNED",
    cause: cause("UserPromptSubmit"),
  });
  await consumer.consume({
    kind: "context",
    content: ["NEVER"],
    cause: cause("UserPromptSubmit"),
    retainForStop: false,
  });
  const result = await consumer.finish({ kind: "completed" });
  assert.equal(f.creations.length, 1);
  assert.equal(attachment(f.creations[0]).toolUseID, `hook-${id(101)}`);
  assert.deepEqual(result.promptEnding, {
    kind: "blocked",
    text: "UserPromptSubmit operation blocked by hook:\nBLOCK\n\nOriginal prompt: RAW_PROMPT",
    promptKept: false,
  });
  const g = fixture(),
    stopped = createNativeLifecycleConsumer(
      {
        ...input("UserPromptSubmit"),
        prompt: {
          submitted: "EDITED",
          typed: "RAW",
          suppressOriginalPrompt: true,
          stoppedText: "ACTUAL_STOPPED_TEXT",
        },
      },
      g.host,
    );
  await stopped.consume({
    kind: "prevent",
    reason: "NOT_A_TEMPLATE",
    cause: cause("UserPromptSubmit"),
  });
  const ended = await stopped.finish({ kind: "completed" });
  assert.deepEqual(ended.promptEnding, {
    kind: "stopped",
    text: "ACTUAL_STOPPED_TEXT",
    promptKept: true,
  });
  assert.ok(isNativeObject(g.creations[0]?.event.message));
  assert.equal(g.creations[0]?.event.message.content, "ACTUAL_STOPPED_TEXT");
});

test("reaction pass never reruns commands or converts block/prevent/context into continuation; abort outcomes remain distinct", async () => {
  const f = fixture(),
    consumer = createNativeLifecycleConsumer(
      { ...input("Stop"), phase: "turn-end-reactions" },
      f.host,
    );
  await consumer.consume({ kind: "prevent", cause: cause("Stop") });
  await consumer.consume({
    kind: "blocking",
    text: "IGNORED",
    command: "OWNED",
    cause: cause("Stop"),
  });
  await consumer.consume({
    kind: "context",
    content: ["IGNORED"],
    cause: cause("Stop"),
    retainForStop: true,
  });
  const result = await consumer.finish({ kind: "completed" });
  assert.equal(result.continue, false);
  assert.equal(f.creations.length, 0);
  for (const [end, prevent] of [
    ["aborted-in-loop", true],
    ["aborted-exception", false],
  ] as const) {
    const g = fixture(),
      stop = createNativeLifecycleConsumer(input("Stop"), g.host);
    await stop.consume({ kind: "progress", toolUseID: id(90) });
    await stop.consume({ kind: "prevent", cause: cause("Stop") });
    assert.equal(
      (await stop.finish({ kind: end })).preventContinuation,
      prevent,
    );
  }
});

test("missing source facts/identity and positive advanced runtime produce explicit unsupported, never an invented native row", async () => {
  const f = fixture(),
    consumer = createNativeLifecycleConsumer(input("Stop"), f.host);
  await consumer.consume({
    kind: "context",
    content: ["NO_PROGRESS"],
    cause: cause("Stop"),
    retainForStop: true,
  });
  const decision = await consumer.finish({ kind: "completed" });
  assert.equal(f.stamps.length, 0);
  assert.equal(decision.unsupported.length, 1);
  const g = fixture();
  let ran = false;
  const result = await runNativeLifecycleHookDispatch(
    {
      input: input("Stop"),
      hookInput: { hook_event_name: "Stop" },
      stages: { ...stages(), activeGoalOrTaskEnforcement: known(true) },
      host: g.host,
      runner: {
        async run() {
          ran = true;
          return { backgroundIDs: [], cancelled: false };
        },
      },
    },
    signal(),
  );
  assert.equal(ran, false);
  assert.equal(result.unsupported.length, 1);
  assert.equal(g.stamps.length, 0);
  await assert.rejects(
    consumer.consume({
      kind: "context",
      content: ["AFTER_CLOSE"],
      cause: cause("Stop"),
      retainForStop: true,
    }),
    /finished/,
  );
});

test("actual once/observer isolation and sink failure drain owned siblings without rerunning commands", async () => {
  const f = fixture(),
    commands = await commandFixture("Stop", [
      {
        label: "FAST",
        once: true,
        output: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "FAST",
          },
        },
      },
      {
        label: "SLOW",
        delay: 70,
        once: true,
        output: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "SLOW",
          },
        },
      },
    ]);
  const originalFacts = facts;
  const runtime = nativeLifecycleCommandRegistry({
    registry: commands.registry,
    runOptions: () => ({
      ...commands.runOptions(),
      onResult: (result) => {
        result.additionalContext = "MUTATED_AFTER_SNAPSHOT";
      },
    }),
    facts: (result) => {
      assert.ok(Object.isFrozen(result));
      assert.throws(() => {
        Object.assign(result, { additionalContext: "BAD" });
      });
      return originalFacts();
    },
  });
  f.host.capture = () => {
    throw new Error("OWNED_SINK_FAILURE");
  };
  const options: NativeLifecycleRuntimeOptions = {
    input: input("Stop"),
    hookInput: commands.hookInput,
    stages: stages(),
    host: f.host,
    runner: runtime,
  };
  await assert.rejects(
    runNativeLifecycleHookDispatch(options, signal()),
    NativeLifecycleCaptureError,
  );
  assert.equal(
    (await readFile(commands.log, "utf8")).trim().split("\n").length,
    2,
  );
  const g = fixture();
  await runNativeLifecycleHookDispatch({ ...options, host: g.host }, signal());
  assert.equal(g.creations.length, 0);
  assert.equal(
    (await readFile(commands.log, "utf8")).trim().split("\n").length,
    2,
  );
});

test("pending background results and non-success outcomes remain explicit unsupported with original outcome evidence", async () => {
  const f = fixture(),
    commands = await commandFixture("Stop", [
      {
        label: "BACKGROUND",
        async: true,
        output: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "LATER",
          },
        },
      },
      { label: "FAILED", exit: 2, output: "" },
    ]);
  const result = await runNativeLifecycleHookDispatch(
    {
      input: input("Stop"),
      hookInput: commands.hookInput,
      stages: stages(),
      host: f.host,
      runner: nativeLifecycleCommandRegistry({
        registry: commands.registry,
        runOptions: commands.runOptions,
        facts: () => facts(),
      }),
    },
    signal(),
  );
  assert.equal(result.continue, false);
  assert.ok(result.unsupported.length >= 2);
  assert.ok(
    result.unsupported.some((item) =>
      item.reasons.some((reason) => reason.includes("Pending lifecycle")),
    ),
  );
  assert.ok(
    result.unsupported.some((item) =>
      item.reasons.some((reason) => reason.includes("exit-2")),
    ),
  );
  assert.equal(f.stamps.length, 0);
  await commands.registry.close();
});

test("actual WMe host owns oversized projection; missing projection preserves raw unsupported evidence without truncation", async () => {
  const raw = "X".repeat(10001),
    commands = await commandFixture("SessionStart", [
      {
        label: "LONG",
        output: {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: raw,
          },
        },
      },
    ]);
  const f = fixture(),
    options: NativeLifecycleRuntimeOptions = {
      input: input("SessionStart"),
      hookInput: commands.hookInput,
      stages: stages(),
      host: f.host,
      runner: nativeLifecycleCommandRegistry({
        registry: commands.registry,
        runOptions: commands.runOptions,
        facts: () => facts(),
      }),
    };
  const unsupported = await runNativeLifecycleHookDispatch(options, signal());
  assert.equal(unsupported.unsupported.length, 1);
  assert.equal(unsupported.unsupported[0]?.facts.text, raw);
  assert.equal(f.creations.length, 1);
  assert.equal(attachment(f.creations[0]).type, "hook_success");
  const g = fixture();
  let projected = false;
  g.host.projectText = ({ text, field, cause }) => {
    assert.equal(text, raw);
    assert.equal(field, "additionalContext");
    assert.equal(
      cause.outcomeID,
      commands.registry.list("SessionStart")[0]?.id,
    );
    projected = true;
    return "ACTUAL_OWNED_PERSISTED_REFERENCE";
  };
  await runNativeLifecycleHookDispatch({ ...options, host: g.host }, signal());
  assert.equal(projected, true);
  assert.deepEqual(attachment(g.creations[1]).content, [
    "ACTUAL_OWNED_PERSISTED_REFERENCE",
  ]);
  assert.equal(g.unsupported.length, 0);
});

test("unknown retention provenance and reaction-only runtime refuse before false context or duplicate command execution", async () => {
  const f = fixture(),
    commands = await commandFixture("Stop", [
      {
        label: "UNKNOWN",
        output: {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: "UNPROVEN",
          },
        },
      },
    ]);
  const options: NativeLifecycleRuntimeOptions = {
    input: input("Stop"),
    hookInput: commands.hookInput,
    stages: stages(),
    host: f.host,
    runner: nativeLifecycleCommandRegistry({
      registry: commands.registry,
      runOptions: commands.runOptions,
      facts: () => ({
        ...facts(),
        retainContextForStop: {
          status: "unsupported",
          reason: "actual _Ct unavailable",
        },
      }),
    }),
  };
  const result = await runNativeLifecycleHookDispatch(options, signal());
  assert.equal(result.unsupported.length, 1);
  assert.equal(f.stamps.length, 0);
  assert.equal(result.continue, false);
  const before = await readFile(commands.log, "utf8"),
    g = fixture();
  await runNativeLifecycleHookDispatch(
    {
      ...options,
      input: { ...input("Stop"), phase: "turn-end-reactions" },
      host: g.host,
    },
    signal(),
  );
  assert.equal(await readFile(commands.log, "utf8"), before);
  assert.match(g.unsupported[0]?.reasons.join(" ") ?? "", /must not run again/);
  let failures = 0;
  g.host.unsupported = () => {
    failures++;
    throw new Error("UNSUPPORTED_OWNER_FAILURE");
  };
  await assert.rejects(
    runNativeLifecycleHookDispatch(
      {
        ...options,
        stages: { ...stages(), backgroundRewake: known(true) },
        host: g.host,
      },
      signal(),
    ),
    NativeLifecycleCaptureError,
  );
  assert.equal(failures, 1);
});

test("foreign yields and mutable stamp callbacks cannot rewrite captured native payload or ownership", async () => {
  const f = fixture();
  f.host.stamp = (value) => {
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.payload));
    assert.throws(() => Object.assign(value.payload, { content: "MUTATED" }));
    return { uuid: id(1), timestamp: "2026-01-01T00:00:00Z" };
  };
  const created = createNativeLifecycleAttachment(
    f.host,
    {
      type: "hook_success",
      content: "ORIGINAL",
      hookName: "SessionStart:startup",
      hookEvent: "SessionStart",
      toolUseID: id(90),
    },
    cause("SessionStart"),
  );
  assert.equal(attachment(created).content, "ORIGINAL");
  const consumer = createNativeLifecycleConsumer(input("Stop"), f.host);
  await assert.rejects(
    consumer.consume({
      kind: "context",
      content: ["FOREIGN"],
      cause: cause("SessionStart"),
      retainForStop: true,
    }),
    /another dispatch/,
  );
  await assert.rejects(
    consumer.consume({ kind: "progress", toolUseID: id(91) }),
    /another dispatch/,
  );
  await assert.rejects(
    consumer.consume({
      kind: "message",
      creation: created,
      retainForStop: true,
    }),
    /another dispatch/,
  );
});
