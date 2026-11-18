import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  createHookRegistry,
  type HookResult,
  type HookRunOptions,
} from "../../src/hooks.js";
import { createReducedScopedHookRegistry } from "../../src/scoped-hook-dispatch.js";
import {
  createSkillHookExecutionRegistry,
  SessionSkillHookRegistry,
} from "../../src/skill-hook-registry.js";
import {
  nativeLifecycleCommandRegistry,
  runNativeLifecycleHookDispatch,
  type NativeLifecycleCreation,
} from "../../src/native-lifecycle-hooks.js";
import type { NativePromptFact } from "../../src/native-prompt-snapshot.js";

const known = <T>(value: T): NativePromptFact<T> => ({
  status: "known",
  value,
});
const signal = () => new AbortController().signal;
async function fixture(asyncSkill = false, once = false) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-hook-observation-")),
  );
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, "executed.jsonl");
  const command = (name: string, delay = 0) => ({
    type: "command",
    command: process.execPath,
    args: [
      "-e",
      `await new Promise(r=>setTimeout(r,${delay}));require('node:fs').appendFileSync(${JSON.stringify(log)},${JSON.stringify(name + "\n")});process.stdout.write(${JSON.stringify(JSON.stringify({ systemMessage: `${name}_SYSTEM`, hookSpecificOutput: { hookEventName: "Stop", additionalContext: `${name}_ORIGINAL` } }))})`,
    ],
    ...(once ? { once: true } : {}),
  });
  const base = createHookRegistry([
    {
      source: "owned-settings",
      hooks: { Stop: [{ hooks: [command("SETTINGS")] }] },
    },
  ]);
  onTestFinished(() => base.close());
  const store = new SessionSkillHookRegistry();
  const registration = store.register({
    sessionId: "owner",
    skillName: "owned",
    source: "userSettings",
    path: join(cwd, "SKILL.md"),
    skillRoot: cwd,
    hooks: {
      Stop: [
        {
          hooks: [
            { ...command("SKILL", 60), ...(asyncSkill ? { async: true } : {}) },
          ],
        },
      ],
    },
  });
  assert.equal(registration.registered, true);
  const skill = createSkillHookExecutionRegistry(store, "owner");
  onTestFinished(() => skill.close());
  const registry = createReducedScopedHookRegistry({
    ownerSessionId: "owner",
    defaultShell: "bash",
    personalConfigRestricted: false,
    backends: () => [
      {
        id: "settings",
        registry: base,
        nativeOrigin: () => ({
          namespace: "hook",
          settingsSource: "owned-settings",
        }),
      },
      {
        id: "skill",
        registry: skill,
        nativeOrigin: () => ({ namespace: "hook", skillRoot: cwd }),
      },
    ],
  });
  onTestFinished(() => registry.close());
  const input = {
    hook_event_name: "Stop" as const,
    session_id: "owner",
    cwd,
    transcript_path: join(cwd, "never-written.jsonl"),
    stop_hook_active: false,
  };
  const options: HookRunOptions = {
    cwd,
    projectDir: cwd,
    env: {},
    signal: signal(),
    defaultTimeoutMs: 3000,
  };
  const lines = async () =>
    (await readFile(log, "utf8")).trim().split("\n").sort();
  return {
    cwd,
    log,
    base,
    store,
    skill,
    registry,
    input,
    options,
    lines,
    registration,
  };
}

test("settings and nested skill observers share the exact admitted result objects returned by their scoped batch", async () => {
  const f = await fixture(),
    observed: HookResult[] = [];
  const prepared = await f.registry.prepareDispatch?.(f.input, {
    ...f.options,
    onResult: (result) => {
      observed.push(result);
    },
  });
  assert.ok(prepared);
  const expected = prepared.candidates.map((entry) => entry.id).sort();
  assert.equal(expected.length, 2);
  const batch = await prepared.runSelected(new Set(expected));
  assert.deepEqual(observed.map((row) => row.id).sort(), expected);
  assert.deepEqual(batch.results.map((row) => row.id).sort(), expected);
  assert.ok(batch.results.every((row) => observed.includes(row)));
  assert.deepEqual(await f.lines(), ["SETTINGS", "SKILL"]);
  await prepared.close();
  assert.equal(f.base.list("Stop").length, 1);
});

test("scoped observer body edits reach phase reduction without changing nested registration identity", async () => {
  const f = await fixture(),
    observed: HookResult[] = [];
  const batch = await f.registry.run(f.input, {
    ...f.options,
    onResult: async (result) => {
      observed.push(result);
      result.additionalContext = `${result.origin.source}_CHANGED`;
      delete result.systemMessage;
      await Promise.resolve();
      result.stdout = "ACTUAL_ASYNC_OBSERVER_EDIT";
    },
  });
  assert.ok(batch.results.every((row) => observed.includes(row)));
  assert.ok(batch.additionalContext.every((text) => text.endsWith("_CHANGED")));
  assert.deepEqual(batch.systemMessages, []);
  assert.ok(
    batch.results.every((row) => row.stdout === "ACTUAL_ASYNC_OBSERVER_EDIT"),
  );
  assert.equal(
    f.store.snapshot("owner").list()[0]?.id,
    f.registration.registrationIds[0],
  );
});

test("native lifecycle settlement capture accepts canonical scoped settings and skill outcomes before existing observers mutate display fields", async () => {
  const f = await fixture(),
    emitted: NativeLifecycleCreation[] = [];
  let stamp = 0;
  const result = await runNativeLifecycleHookDispatch(
    {
      input: {
        event: "Stop",
        dispatchToolUseID: "ACTUAL_DISPATCH",
        phase: "ordinary",
      },
      hookInput: f.input,
      host: {
        stamp: () => ({
          uuid: `00000000-1111-1111-1111-${String(++stamp).padStart(12, "0")}`,
          timestamp: "2026-11-18T00:00:00Z",
        }),
        capture: (creation) => {
          emitted.push(creation);
        },
        unsupported: (fact) => {
          throw new Error(fact.reasons.join("; "));
        },
      },
      stages: {
        classicOrFunctionChain: known(false),
        managedOrRemoteTransport: known(false),
        activeGoalOrTaskEnforcement: known(false),
        backgroundRewake: known(false),
      },
      runner: nativeLifecycleCommandRegistry({
        registry: f.registry,
        runOptions: () => ({
          ...f.options,
          onResult: (outcome) => {
            outcome.additionalContext = "CHANGED_DISPLAY_ONLY";
          },
        }),
        facts: (outcome) => ({
          output: known("structured"),
          command: known(outcome.command),
          structuredSuccessNotice: known(undefined),
          retainMessageForStop: known(false),
          retainContextForStop: known(true),
          hasProgress: known(true),
        }),
      }),
    },
    signal(),
  );
  assert.equal(result.continue, true);
  const wire = JSON.stringify(result.continuationEvents);
  assert.match(wire, /SETTINGS_ORIGINAL/);
  assert.match(wire, /SKILL_ORIGINAL/);
  assert.doesNotMatch(wire, /CHANGED_DISPLAY_ONLY/);
  assert.ok(emitted.length >= 4);
  assert.deepEqual(await f.lines(), ["SETTINGS", "SKILL"]);
});

test("a settings capture failure drains the slower owned skill command and preserves both borrowed registries", async () => {
  const f = await fixture();
  await assert.rejects(
    f.registry.run(f.input, {
      ...f.options,
      onResult: (row) => {
        if (row.origin.source === "owned-settings")
          throw new Error("ACTUAL_CAPTURE_FAILURE");
      },
    }),
    /observation failed|ACTUAL_CAPTURE_FAILURE/,
  );
  assert.deepEqual(await f.lines(), ["SETTINGS", "SKILL"]);
  assert.equal(f.base.list("Stop").length, 1);
  assert.equal(f.skill.list("Stop").length, 1);
  await f.registry.run(f.input, f.options);
  assert.deepEqual(await f.lines(), ["SETTINGS", "SETTINGS", "SKILL", "SKILL"]);
});

test("nested async skill result has one scoped identity through settlement, task completion and background observation", async () => {
  const f = await fixture(true),
    observed: HookResult[] = [],
    background: HookResult[] = [],
    seen = Promise.withResolvers<void>();
  const batch = await f.registry.run(f.input, {
    ...f.options,
    onResult: (row) => {
      observed.push(row);
    },
    onBackgroundResult: (row) => {
      background.push(row);
      seen.resolve();
    },
  });
  assert.equal(batch.background.length, 1);
  const task = batch.background[0];
  assert.ok(task);
  const completed = await task.completion;
  await seen.promise;
  assert.equal(completed.id, task.id);
  assert.ok(observed.includes(completed));
  assert.ok(background.includes(completed));
  assert.deepEqual(await f.lines(), ["SETTINGS", "SKILL"]);
});

test("skill success removal still waits for the actual observed batch rather than firing at the namespace callback", async () => {
  const f = await fixture(false, true),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const run = f.registry.run(f.input, {
    ...f.options,
    onResult: async (row) => {
      if (row.origin.source.startsWith("skill:")) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  await entered.promise;
  assert.equal(f.store.snapshot("owner").list().length, 1);
  release.resolve();
  await run;
  assert.equal(f.store.snapshot("owner").list().length, 0);
  assert.equal((await f.registry.run(f.input, f.options)).results.length, 0);
  assert.deepEqual(await f.lines(), ["SETTINGS", "SKILL"]);
});
