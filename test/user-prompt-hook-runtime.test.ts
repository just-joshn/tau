import assert from "node:assert/strict";
import { onTestFinished, test } from "bun:test";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHookRegistry,
  type HookInput,
  type HookResult,
  type HookRunOptions,
} from "../src/hooks.js";
import { composeHookRegistries } from "../src/composite-hooks.js";
import {
  SessionSkillHookRegistry,
  createSkillHookExecutionRegistry,
} from "../src/skill-hook-registry.js";
import {
  validateAgentDefinitionHooks,
  createAgentDefinitionHookScope,
} from "../src/agent-definition-hooks.js";
import {
  nativeLifecycleCommandRegistry,
  runNativeLifecycleHookDispatch,
  type NativeLifecycleCaptureHost,
  type NativeLifecycleCreation,
  type NativeLifecycleUnsupported,
  type NativeLifecycleCommandFacts,
  type NativeLifecycleInput,
} from "../src/native-lifecycle-hooks.js";
import type { NativePromptFact } from "../src/native-prompt-snapshot.js";
import { isNativeObject } from "../src/native-session-codec.js";

const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tau-prompt-hook-")));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "authored-hook.mjs"),
    log = join(cwd, "runs.jsonl");
  await writeFile(
    script,
    `import {appendFileSync} from 'node:fs';let raw='';for await(const part of process.stdin)raw+=part;await new Promise(r=>setTimeout(r,Number(process.argv[4])));appendFileSync(process.argv[2],raw);process.stdout.write(process.argv[3]);process.exitCode=Number(process.argv[5]);`,
  );
  const command = (
    output: unknown,
    options: {
      delay?: number;
      exit?: number;
      once?: boolean;
      async?: boolean;
    } = {},
  ) => ({
    type: "command" as const,
    command: process.execPath,
    args: [
      script,
      log,
      typeof output === "string" ? output : JSON.stringify(output),
      String(options.delay ?? 0),
      String(options.exit ?? 0),
    ],
    ...(options.once ? { once: true } : {}),
    ...(options.async ? { async: true } : {}),
  });
  const input: HookInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: id(90),
    transcript_path: join(cwd, "native.jsonl"),
    cwd,
    permission_mode: "default",
    prompt: "EXACT_PROMPT",
    source: "sdk",
    session_title: "OLD_TITLE",
  };
  const runOptions = (): HookRunOptions => ({
    cwd,
    projectDir: cwd,
    env: {},
    signal: new AbortController().signal,
    defaultTimeoutMs: 3000,
  });
  const registry = (commands: ReturnType<typeof command>[]) => {
    // This invalid matcher is intentionally irrelevant: UserPromptSubmit has no source matcher query.
    const value = createHookRegistry([
      {
        source: "userSettings",
        hooks: { UserPromptSubmit: [{ matcher: "[", hooks: commands }] },
      },
    ]);
    onTestFinished(() => value.close());
    return value;
  };
  return { cwd, log, command, input, runOptions, registry };
}
function capture() {
  const creations: NativeLifecycleCreation[] = [],
    unsupported: NativeLifecycleUnsupported[] = [];
  let n = 0,
    tool = 100;
  const host: NativeLifecycleCaptureHost = {
    stamp: () => ({
      uuid: id(++n),
      timestamp: `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z`,
    }),
    toolUseID: () => `hook-${id(++tool)}`,
    capture: (value) => {
      creations.push(value);
    },
    unsupported: (value) => {
      unsupported.push(value);
    },
  };
  return { host, creations, unsupported };
}
function lifecycleInput(): NativeLifecycleInput {
  return {
    event: "UserPromptSubmit",
    dispatchToolUseID: id(91),
    phase: "ordinary",
    prompt: {
      submitted: "EXACT_PROMPT",
      typed: "EXACT_PROMPT",
      suppressOriginalPrompt: false,
      stoppedText: "ACTUAL_STOP_TEXT",
    },
  };
}
const facts = (result: Readonly<HookResult>): NativeLifecycleCommandFacts => ({
  output: known(result.stdout.trim().startsWith("{") ? "structured" : "plain"),
  command: known("ACTUAL_NATIVE_COMMAND"),
  structuredSuccessNotice: known(undefined),
  retainMessageForStop: known(false),
  retainContextForStop: known(true),
  hasProgress: known(true),
});
async function dispatch(
  f: Awaited<ReturnType<typeof fixture>>,
  registry: ReturnType<typeof composeHookRegistries>,
  c: ReturnType<typeof capture>,
  input = lifecycleInput(),
) {
  return runNativeLifecycleHookDispatch(
    {
      input,
      hookInput: {
        hook_event_name: "UserPromptSubmit",
        session_id: id(90),
        transcript_path: join(f.cwd, "native.jsonl"),
        cwd: f.cwd,
        permission_mode: "default",
        prompt: "EXACT_PROMPT",
        source: "sdk",
        session_title: "OLD_TITLE",
      },
      host: c.host,
      stages: {
        classicOrFunctionChain: known(false),
        managedOrRemoteTransport: known(false),
        activeGoalOrTaskEnforcement: known(false),
        backgroundRewake: known(false),
      },
      runner: nativeLifecycleCommandRegistry({
        registry,
        runOptions: f.runOptions,
        facts,
      }),
    },
    new AbortController().signal,
  );
}

test("UserPromptSubmit registry sends exact actual input, has no matcher query and retains typed per-command output", async () => {
  const f = await fixture(),
    registry = f.registry([
      f.command({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "CONTEXT",
          sessionTitle: "NEW_TITLE",
          suppressOriginalPrompt: false,
        },
      }),
    ]);
  const batch = await registry.run(f.input, f.runOptions());
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0]?.status, "success");
  assert.equal(batch.results[0]?.suppressOriginalPrompt, false);
  assert.equal(batch.sessionTitle, "NEW_TITLE");
  assert.deepEqual(batch.additionalContext, ["CONTEXT"]);
  assert.deepEqual(JSON.parse((await readFile(f.log, "utf8")).trim()), f.input);
  for (const patch of [
    { prompt: undefined },
    { prompt: 7 },
    { source: "guessed" },
    { session_title: 7 },
  ])
    await assert.rejects(
      registry.run(Object.assign({}, f.input, patch), f.runOptions()),
      /UserPromptSubmit/,
    );
  for (const source of [
    undefined,
    "user",
    "sdk",
    "system",
    "loop_wakeup",
    "schedule_wakeup",
    "poll_event",
  ]) {
    const input = { ...f.input };
    if (source === undefined) delete input.source;
    else input.source = source;
    assert.equal((await registry.run(input, f.runOptions())).results.length, 1);
  }
});

test("UserPromptSubmit validates suppression schema and retains legacy mismatch block without foreign output", async () => {
  const f = await fixture(),
    malformed = f.registry([
      f.command({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          suppressOriginalPrompt: "true",
        },
      }),
    ]);
  assert.equal(
    (await malformed.run(f.input, f.runOptions())).results[0]?.status,
    "error",
  );
  const registry = f.registry([
    f.command({
      decision: "block",
      reason: "ACTUAL_BLOCK",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "FOREIGN",
        sessionTitle: "FOREIGN_TITLE",
      },
    }),
  ]);
  const [result] = (await registry.run(f.input, f.runOptions())).results;
  assert.equal(result?.status, "blocking");
  assert.equal(result.suppressOriginalPrompt, true);
  assert.equal(result.additionalContext, undefined);
  assert.equal(result.sessionTitle, undefined);
  const c = capture(),
    decision = await dispatch(f, registry, c);
  assert.equal(
    decision.promptEnding?.text,
    "UserPromptSubmit operation blocked by hook:\nACTUAL_BLOCK",
  );
  assert.equal(c.creations.length, 0);
  assert.equal(c.unsupported.length, 0);
});

test("actual UserPromptSubmit command settlements create distinct native contexts and return title metadata", async () => {
  const f = await fixture(),
    slow = f.registry([
      f.command(
        {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "SLOW_CONTEXT",
            sessionTitle: "SLOW_TITLE",
          },
        },
        { delay: 90 },
      ),
    ]),
    fast = f.registry([
      f.command({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "FAST_CONTEXT",
          sessionTitle: "FAST_TITLE",
        },
      }),
    ]),
    c = capture();
  const decision = await dispatch(f, composeHookRegistries(slow, fast), c);
  assert.equal(decision.sessionTitle, "SLOW_TITLE");
  assert.equal(decision.continue, false);
  assert.equal(c.unsupported.length, 0);
  assert.deepEqual(
    c.creations.map((value) => {
      assert.ok(isNativeObject(value.event.attachment));
      return value.event.attachment.content;
    }),
    [["FAST_CONTEXT"], ["SLOW_CONTEXT"]],
  );
  assert.equal(new Set(c.creations.map((value) => value.event.uuid)).size, 2);
  assert.ok(
    c.creations.every(
      (value) =>
        isNativeObject(value.event.attachment) &&
        typeof value.event.attachment.toolUseID === "string" &&
        value.event.attachment.toolUseID.startsWith("hook-"),
    ),
  );
  assert.ok(
    c.creations.every(
      (value) => Object.isFrozen(value) && Object.isFrozen(value.event),
    ),
  );
});

test("UserPromptSubmit per-command block suppression survives composition and later sibling events stay unretained", async () => {
  const f = await fixture(),
    block = f.registry([
      f.command({
        decision: "block",
        reason: "BLOCK",
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          suppressOriginalPrompt: true,
        },
      }),
    ]),
    late = f.registry([
      f.command(
        {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "LATE",
            sessionTitle: "LATE_TITLE",
          },
        },
        { delay: 90 },
      ),
    ]),
    c = capture();
  const decision = await dispatch(f, composeHookRegistries(block, late), c);
  assert.equal(
    decision.promptEnding?.text,
    "UserPromptSubmit operation blocked by hook:\nBLOCK",
  );
  assert.equal(decision.sessionTitle, undefined);
  assert.equal(c.creations.length, 0);
  assert.equal(c.unsupported.length, 0);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 2);
});

test("UserPromptSubmit prevent retains actual stopped feedback and input mismatch cannot execute", async () => {
  const f = await fixture(),
    registry = f.registry([
      f.command({
        continue: false,
        stopReason: "STOP",
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "NEVER",
        },
      }),
    ]),
    c = capture();
  const decision = await dispatch(f, registry, c);
  assert.equal(decision.preventContinuation, true);
  assert.equal(decision.promptEnding?.text, "ACTUAL_STOP_TEXT");
  assert.equal(c.creations.length, 1);
  assert.equal(c.creations[0]?.event.type, "user");
  const wrong = capture(),
    input = lifecycleInput();
  assert.ok(input.prompt);
  input.prompt.submitted = "FOREIGN";
  const mismatch = await dispatch(f, registry, wrong, input);
  assert.match(
    mismatch.unsupported[0]?.reasons.join(" ") ?? "",
    /does not own/,
  );
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1);
});

test("UserPromptSubmit async delivery is explicitly unsupported and once/observer ownership remains exact", async () => {
  const f = await fixture(),
    registry = f.registry([f.command("RAW_SUCCESS", { once: true })]),
    c = capture();
  await dispatch(f, registry, c);
  await dispatch(f, registry, c);
  assert.equal(c.creations.length, 1);
  const asyncRegistry = f.registry([f.command("ASYNC", { async: true })]),
    background = capture();
  const decision = await dispatch(f, asyncRegistry, background);
  assert.ok(
    decision.unsupported.some((fact) =>
      fact.reasons.some((reason) => /background ownership/.test(reason)),
    ),
  );
  await asyncRegistry.close();
  assert.ok(background.unsupported.length);
  assert.equal(background.creations.length, 0);
});

test("UserPromptSubmit skill once callbacks and agent-definition event enumeration do not lose valid hooks", async () => {
  const f = await fixture(),
    skill = new SessionSkillHookRegistry(),
    hook = f.command("SKILL", { once: true });
  const admission = skill.register({
    sessionId: id(90),
    skillName: "owned",
    path: join(f.cwd, "SKILL.md"),
    source: "userSettings",
    hooks: { UserPromptSubmit: [{ hooks: [hook] }] },
  });
  assert.equal(admission.registered, true);
  const registry = createSkillHookExecutionRegistry(skill, id(90));
  onTestFinished(() => registry.close());
  assert.equal((await registry.run(f.input, f.runOptions())).results.length, 1);
  assert.equal(skill.snapshot(id(90)).list().length, 0);
  const hooks = { UserPromptSubmit: [{ hooks: [f.command("DEFINITION")] }] };
  assert.ok(validateAgentDefinitionHooks(hooks).UserPromptSubmit);
  const scope = createAgentDefinitionHookScope({
    ownerSessionId: id(90),
    agentId: "child-owned",
    definition: {
      agentType: "owned",
      whenToUse: "owned",
      prompt: "OWNED_PROMPT",
      skills: [],
      source: "userSettings",
      hooks,
    },
    policy: () => ({
      disabled: false,
      managedOnly: false,
      strictPluginOnly: false,
    }),
    admitDefinition: () => true,
    admitOrigin: () => true,
    provenance: () => ({ personal: false, checkout: false }),
    admitExecution: () => true,
  });
  onTestFinished(() => scope.close());
  const result = await scope.afterStart(new AbortController().signal);
  assert.equal(result.registered, true);
  assert.equal(scope.registry.list("UserPromptSubmit").length, 1);
  const executed = await scope.registry.run(
    { ...f.input, agent_id: "child-owned" },
    f.runOptions(),
  );
  assert.equal(executed.results[0]?.stdout, "DEFINITION");
});

test("UserPromptSubmit capture errors drain sibling commands and failures retain explicit unsupported evidence", async () => {
  const f = await fixture(),
    registry = f.registry([
      f.command("FAST"),
      f.command("SLOW", { delay: 80 }),
    ]),
    c = capture();
  c.host.capture = () => {
    throw new Error("OWNED_SINK_FAILURE");
  };
  await assert.rejects(dispatch(f, registry, c), /capture owner failed/);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 2);
  const failed = f.registry([f.command("", { exit: 2, once: true })]),
    evidence = capture();
  const first = await dispatch(f, failed, evidence);
  assert.match(first.unsupported[0]?.reasons.join(" ") ?? "", /exit-2 salvage/);
  await dispatch(f, failed, evidence);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 3);
  assert.equal(evidence.creations.length, 0);
});
