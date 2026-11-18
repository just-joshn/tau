import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalTaskStore } from "../src/task-store.js";
import {
  createTaskRuntime,
  coerceTaskCreateInput,
  nativeTasksEnabled,
  type TaskRuntimeOptions,
} from "../src/task-runtime.js";
import { runAgent } from "../src/agent.js";
import { projectMessages } from "../src/thinking-history.js";
import type { Message, Provider, ToolUse } from "../src/types.js";
import type { ToolHookRuntime } from "../src/tool-hook-runtime.js";

const signal = () => new AbortController().signal;
const call = (name: string, input: unknown): ToolUse => ({
  type: "tool_use",
  id: "owned-call",
  name,
  input,
});
test("ordinary task enablement uses the exact canonical catalog and independent typed environment gates", () => {
  assert.equal(nativeTasksEnabled({}), true);
  for (const canonicalModel of [
    "claude-3-7-sonnet",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "arn:owned:application-inference-profile/example",
  ]) {
    assert.equal(nativeTasksEnabled({ canonicalModel }), true);
    assert.equal(
      nativeTasksEnabled({ canonicalModel, enabled: false, todoTools: true }),
      false,
    );
  }
  for (const canonicalModel of [
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-6-20260101",
    "sonnet",
    "",
  ]) {
    assert.equal(nativeTasksEnabled({ canonicalModel }), false);
    assert.equal(nativeTasksEnabled({ canonicalModel, todoTools: true }), true);
  }
});
async function fixture(t: any, overrides: Partial<TaskRuntimeOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-task-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createLocalTaskStore({ root, listId: "owned-list" });
  const runtime = createTaskRuntime({
    store,
    context: () => ({
      sessionId: "owned-session",
      actor: "main",
      mode: "local",
    }),
    authorize: () => true,
    ...overrides,
  });
  const execute = (name: string, input: unknown) =>
    runtime.execute(call(name, input), signal());
  return { store, runtime, execute };
}
test("agent can create/get/update/list local tasks with persistent dependencies and request-only hook metadata", async (t) => {
  const f = await fixture(t),
    messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "track owned work" }] },
    ];
  const calls = [
    call("TaskCreate", { subject: "one", description: "first owned" }),
    call("TaskCreate", { subject: "two", description: "second owned" }),
    call("TaskUpdate", {
      taskId: "1",
      addBlocks: ["2"],
      status: "in_progress",
      owner: "worker",
    }),
    call("TaskGet", { taskId: "1" }),
    call("TaskList", {}),
  ];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      assert.equal(request.tools.length, 4);
      const next = calls[round++];
      return {
        content: next ? [next] : [{ type: "text", text: "done" }],
        stop_reason: next ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  await runAgent({
    provider,
    tools: f.runtime,
    messages,
    model: "test",
    system: "owned",
    maxTokens: 100,
    maxTurns: 7,
    autoCompact: false,
    signal: signal(),
    onEvent() {},
  });
  assert.deepEqual((await f.store.get("2"))!.blockedBy, ["1"]);
  assert.equal((await f.store.get("1"))!.owner, "worker");
  const results = messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result");
  const got = results[3]!.hookResponse as any;
  assert.equal(got.task.owner, undefined);
  assert.equal(got.task.metadata, undefined);
  assert.equal(got.task.description, "first owned");
  assert.equal((results[4]!.hookResponse as any).tasks[0].owner, "worker");
  assert.equal(
    JSON.stringify(projectMessages(messages)).includes("hookResponse"),
    false,
  );
});
test("domain missing tasks remain ordinary results, updates allow nonmonotone status and missing edge reports", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.execute("TaskGet", { taskId: "999" })).is_error,
    undefined,
  );
  const missing = await f.execute("TaskUpdate", {
    taskId: "999",
    status: "completed",
  });
  assert.equal(missing.is_error, undefined);
  assert.equal((missing.hookResponse as any).success, false);
  assert.equal((await f.execute("TaskList", {})).content, "No tasks found");
  await f.execute("TaskCreate", { subject: "one", description: "owned" });
  for (const status of ["completed", "pending", "in_progress"])
    assert.equal(
      (await f.execute("TaskUpdate", { taskId: "1", status })).is_error,
      undefined,
    );
  const changed = await f.execute("TaskUpdate", {
    taskId: "1",
    addBlocks: ["missing"],
  });
  assert.deepEqual((changed.hookResponse as any).updatedFields, ["blocks"]);
  assert.deepEqual((await f.store.get("1"))!.blocks, []);
});
test("list hides internal tasks and removes only visible completed blockers; Get preserves raw links", async (t) => {
  const f = await fixture(t);
  await f.execute("TaskCreate", {
    subject: "hidden",
    description: "owned",
    metadata: { _internal: true },
  });
  await f.execute("TaskCreate", { subject: "visible", description: "owned" });
  await f.execute("TaskUpdate", {
    taskId: "1",
    addBlocks: ["2"],
    status: "completed",
  });
  await f.store.update("2", { blockedBy: ["1", "missing"] });
  let tasks = (await f.execute("TaskList", {})).hookResponse as any;
  assert.equal(tasks.tasks.length, 1);
  assert.deepEqual(tasks.tasks[0].blockedBy, ["1", "missing"]);
  await f.execute("TaskUpdate", { taskId: "1", metadata: { _internal: null } });
  tasks = (await f.execute("TaskList", {})).hookResponse as any;
  assert.equal(tasks.tasks.length, 2);
  assert.deepEqual(tasks.tasks[1].blockedBy, ["missing"]);
  assert.deepEqual(
    ((await f.execute("TaskGet", { taskId: "2" })).hookResponse as any).task
      .blockedBy,
    ["1", "missing"],
  );
  await f.execute("TaskUpdate", { taskId: "1", status: "deleted" });
  assert.deepEqual((await f.store.get("2"))!.blockedBy, ["missing"]);
});
test("TaskCompleted block holds every patch and dependency, while a repeated completion does not rerun lifecycle", async (t) => {
  let block = true,
    completed = 0;
  const f = await fixture(t, {
    lifecycle: {
      async completed(context) {
        completed++;
        assert.equal(context.task.subject, "old");
        assert.equal(context.context.sessionId, "owned-session");
        return {
          blockingErrors: block
            ? ["TaskCompleted hook feedback: owned block"]
            : [],
        };
      },
    },
  });
  await f.execute("TaskCreate", {
    subject: "old",
    description: "owned",
    metadata: { old: true },
  });
  await f.execute("TaskCreate", { subject: "other", description: "owned" });
  const before = await f.store.get("1");
  const input = {
    taskId: "1",
    subject: "new",
    status: "completed",
    owner: "named",
    addBlocks: ["2"],
    metadata: { old: null, passed: true },
  };
  const refused = await f.execute("TaskUpdate", input);
  assert.equal(refused.is_error, undefined);
  assert.equal((refused.hookResponse as any).success, false);
  assert.deepEqual(await f.store.get("1"), before);
  assert.deepEqual((await f.store.get("2"))!.blockedBy, []);
  block = false;
  assert.equal((await f.execute("TaskUpdate", input)).is_error, undefined);
  assert.equal((await f.store.get("1"))!.subject, "new");
  await f.execute("TaskUpdate", { taskId: "1", status: "completed" });
  assert.equal(completed, 2);
  assert.deepEqual((await f.store.get("1"))!.metadata, { passed: true });
});
test("TaskCreated blocking rolls back and consumes id; generic failure hook sees only thrown execution failures", async (t) => {
  let block = true,
    failures = 0,
    posts = 0;
  const hooks: ToolHookRuntime = {
    async before() {
      return { additionalContext: [], preventContinuation: false };
    },
    async after(_call, result) {
      posts++;
      return result;
    },
    async failure() {
      failures++;
      return { additionalContext: ["owned failure feedback"] };
    },
  };
  const f = await fixture(t, {
    hooks,
    lifecycle: {
      async created() {
        return { blockingErrors: block ? ["blocked creation"] : [] };
      },
    },
  });
  const refused = await f.execute("TaskCreate", {
    subject: "one",
    description: "owned",
  });
  assert.equal(refused.is_error, true);
  assert.deepEqual(refused.hookContext, ["owned failure feedback"]);
  assert.deepEqual(await f.store.list(), []);
  block = false;
  const created = await f.execute("TaskCreate", {
    subject: "two",
    description: "owned",
  });
  assert.equal((created.hookResponse as any).task.id, "2");
  await f.execute("TaskUpdate", { taskId: "missing" });
  assert.equal(failures, 1);
  assert.equal(posts, 2);
});
test("strict schemas/coercion validate before hooks and host objections survive hook allow", async (t) => {
  let pres = 0,
    permit = false;
  const hooks: ToolHookRuntime = {
    async before() {
      pres++;
      return {
        additionalContext: [],
        preventContinuation: false,
        permission: "allow",
      };
    },
    async after(_call, result) {
      return result;
    },
  };
  const f = await fixture(t, { hooks, authorize: () => permit });
  for (const input of [
    { tasks: [{ subject: "batch" }] },
    { prompt: "delegate", subagent_type: "Explore" },
    { subject: 9, description: "owned" },
  ])
    assert.equal((await f.execute("TaskCreate", input)).inputRejected, true);
  assert.equal(pres, 0);
  assert.equal(
    (await f.execute("TaskCreate", { subject: "one", description: "owned" }))
      .permissionDenied,
    true,
  );
  assert.deepEqual(await f.store.list(), []);
  permit = true;
  const created = await f.execute("TaskCreate", {
    title: "repaired",
    active_form: "Working",
    status: "completed",
    owner: "not-created-owner",
  });
  assert.equal((created.hookResponse as any).task.description, "repaired");
  assert.equal((await f.store.get("1"))!.status, "pending");
  assert.equal((await f.store.get("1"))!.owner, undefined);
  assert.equal(
    (await f.execute("TaskUpdate", { task_id: "1", active_form: "Reading" }))
      .is_error,
    undefined,
  );
  assert.equal((await f.store.get("1"))!.activeForm, "Reading");
  assert.deepEqual(coerceTaskCreateInput({ task: "simple owned task" }), {
    subject: "simple owned task",
    description: "simple owned task",
  });
});
test("pre rewrites revalidate and retain original assistant input; post output cannot alter task state", async (t) => {
  const hooks: ToolHookRuntime = {
    async before(_call, _signal, validate) {
      return {
        additionalContext: [],
        preventContinuation: false,
        updatedInput: await validate({
          subject: "rewritten",
          description: "effective",
        }),
      };
    },
    async after(_call, result, _signal, validate) {
      return validate!(
        {
          task: {
            id: "display-only",
            subject: "post display",
            description: "post",
          },
        },
        result,
      );
    },
  };
  const f = await fixture(t, { hooks });
  const original = call("TaskCreate", {
    subject: "model",
    description: "original",
  });
  const result = await f.runtime.execute(original, signal());
  assert.deepEqual(original.input, {
    subject: "model",
    description: "original",
  });
  assert.deepEqual(result.effectiveToolInput, {
    subject: "rewritten",
    description: "effective",
  });
  assert.equal((await f.store.get("1"))!.subject, "rewritten");
  assert.equal((result.hookResponse as any).task.id, "display-only");
  assert.equal(await f.store.get("display-only"), null);
});
test("mutation guard precedes hooks, readonly access stays available, disabled and cancelled calls do not mutate", async (t) => {
  let pres = 0;
  const hooks: ToolHookRuntime = {
    async before() {
      pres++;
      return { additionalContext: [], preventContinuation: false };
    },
    async after(_call, result) {
      return result;
    },
  };
  const f = await fixture(t, {
    hooks,
    validateMutation: () => "host background mutation guard",
  });
  assert.equal(
    (await f.execute("TaskCreate", { subject: "owned", description: "owned" }))
      .inputRejected,
    true,
  );
  assert.equal(pres, 0);
  assert.equal((await f.execute("TaskList", {})).is_error, undefined);
  assert.equal(pres, 1);
  const disabled = createTaskRuntime({
    store: f.store,
    context: () => ({ sessionId: "owned" }),
    authorize: () => true,
    enabled: () => false,
  });
  assert.deepEqual(disabled.definitions, []);
  assert.equal(
    (await disabled.execute(call("TaskList", {}), signal())).is_error,
    true,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.runtime.execute(call("TaskList", {}), abort.signal), {
    name: "AbortError",
  });
});
