import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookRegistryLike } from "../../src/composite-hooks.js";
import {
  createHookRegistry,
  type CommandHook,
  type HookInput,
  type HookRunOptions,
  type PreparedHookDispatch,
} from "../../src/hooks.js";
import {
  createReducedScopedHookRegistry,
  reduceMatchedOrdinaryCommandHooks,
  type ScopedHookSelectionBackend,
} from "../../src/scoped-hook-dispatch.js";

const input = (patch: Partial<HookInput> = {}): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "owner",
  transcript_path: "/owned/transcript.jsonl",
  cwd: "/owned",
  tool_name: "Read",
  tool_use_id: "owned-read",
  tool_input: { file_path: "/owned/file" },
  ...patch,
});
const command: CommandHook = { type: "command", command: "owned" };
const hookOrigin = () => ({ namespace: "hook" as const });

async function runOptions(signal = new AbortController().signal) {
  const cwd = await mkdtemp(join(tmpdir(), "tau-scoped-hook-edges-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const options: HookRunOptions = {
    cwd,
    projectDir: cwd,
    env: {},
    signal,
    defaultTimeoutMs: 3000,
  };
  return options;
}

function settings(): HookRegistryLike {
  const registry = createHookRegistry([
    {
      source: "userSettings",
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [command] }] },
    },
  ]);
  onTestFinished(() => registry.close());
  return registry;
}

/** A backend whose prepared snapshots report their own retirement. */
function recordingBackend(
  id: string,
  prepare: () => Promise<void> = async () => {},
) {
  const closed: string[] = [];
  const registry: HookRegistryLike = {
    list: () => [],
    run: () => Promise.reject(new Error("unprepared run")),
    close: async () => {},
    async prepareDispatch(): Promise<PreparedHookDispatch> {
      await prepare();
      return {
        candidates: [],
        runSelected: () => Promise.reject(new Error("nothing selected")),
        close: async () => {
          closed.push(id);
        },
      };
    },
  };
  const backend: ScopedHookSelectionBackend = {
    id,
    registry,
    nativeOrigin: hookOrigin,
  };
  return { backend, closed };
}

function reduced(backends: () => readonly ScopedHookSelectionBackend[]) {
  const registry = createReducedScopedHookRegistry({
    ownerSessionId: "owner",
    defaultShell: "bash",
    personalConfigRestricted: false,
    backends,
  });
  onTestFinished(() => registry.close());
  return registry;
}

test("a dispatcher needs an owning session and refuses restricted personal configuration", () => {
  const options = {
    defaultShell: "bash" as const,
    backends: () => [],
  };
  assert.throws(
    () =>
      createReducedScopedHookRegistry({
        ...options,
        ownerSessionId: "",
        personalConfigRestricted: false,
      }),
    /owning hook session required/,
  );
  assert.throws(
    () =>
      createReducedScopedHookRegistry({
        ...options,
        ownerSessionId: "owner",
        personalConfigRestricted: true,
      }),
    /requires its native provenance adapter/,
  );
});

test("candidates without a unique backend and hook identity are rejected", () => {
  const context = {
    defaultShell: "bash" as const,
    personalConfigRestricted: false,
  };
  const candidate = {
    backendId: "settings",
    id: "one",
    hook: command,
    nativeOrigin: { namespace: "hook" as const },
  };
  for (const candidates of [
    [candidate, { ...candidate, hook: { ...command, command: "other" } }],
    [{ ...candidate, id: "" }],
    [{ ...candidate, backendId: "" }],
  ])
    assert.throws(
      () => reduceMatchedOrdinaryCommandHooks(candidates, context),
      /Ambiguous scoped hook candidate identity/,
    );
  assert.throws(
    () =>
      reduceMatchedOrdinaryCommandHooks([candidate], {
        ...context,
        personalConfigRestricted: true,
      }),
    /requires its native provenance adapter/,
  );
});

test("backends must carry distinct non-empty identities", async () => {
  const options = await runOptions();
  for (const ids of [["settings", "settings"], [""]]) {
    const registry = reduced(() =>
      ids.map((id) => ({ id, registry: settings(), nativeOrigin: hookOrigin })),
    );
    await assert.rejects(
      registry.run(input(), options),
      /Duplicate scoped hook backend identity/,
    );
  }
});

test("a dispatcher only serves its owning session", async () => {
  const registry = reduced(() => [
    { id: "settings", registry: settings(), nativeOrigin: hookOrigin },
  ]);
  await assert.rejects(
    registry.run(input({ session_id: "intruder" }), await runOptions()),
    /belongs to a different session/,
  );
});

test("an aborted signal stops selection before any backend is prepared", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller gave up"));
  let prepared = 0;
  const { backend } = recordingBackend("settings", async () => {
    prepared++;
  });
  const registry = reduced(() => [backend]);
  await assert.rejects(
    registry.run(input(), await runOptions(controller.signal)),
    /caller gave up/,
  );
  assert.equal(prepared, 0);
});

test("a backend without prepared dispatch fails selection and retires the others' snapshots", async () => {
  const ready = recordingBackend("ready");
  const legacy: ScopedHookSelectionBackend = {
    id: "legacy",
    registry: {
      list: () => [],
      run: () => Promise.reject(new Error("unprepared run")),
      close: async () => {},
    },
    nativeOrigin: hookOrigin,
  };
  const registry = reduced(() => [ready.backend, legacy]);
  await assert.rejects(
    registry.run(input(), await runOptions()),
    /lacks immutable prepared dispatch/,
  );
  assert.deepEqual(ready.closed, ["ready"]);
});

test("closing during selection fails the dispatch and retires prepared snapshots", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = recordingBackend("slow", () => gate);
  const registry = reduced(() => [slow.backend]);
  const pending = registry.run(input(), await runOptions());
  await registry.close();
  release();
  await assert.rejects(pending, /closed during selection/);
  assert.deepEqual(slow.closed, ["slow"]);
});

test("a closed dispatcher lists nothing, prepares nothing and retires live snapshots", async () => {
  const registry = reduced(() => [
    { id: "settings", registry: settings(), nativeOrigin: hookOrigin },
  ]);
  const options = await runOptions();
  assert.equal(registry.list("PreToolUse").length, 1);
  const prepareDispatch = registry.prepareDispatch;
  assert.ok(prepareDispatch);
  const snapshot = await prepareDispatch(input(), options);
  const ids = new Set(snapshot.candidates.map((entry) => entry.id));
  assert.equal(ids.size, 1);
  await assert.rejects(
    snapshot.runSelected(new Set(["unlisted"])),
    /Unknown or consumed scoped hook dispatch candidate/,
  );
  await registry.close();
  assert.deepEqual(registry.list("PreToolUse"), []);
  await assert.rejects(
    prepareDispatch(input(), options),
    /dispatcher is closed/,
  );
  await assert.rejects(snapshot.runSelected(ids), /snapshot is retired/);
});
