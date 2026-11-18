import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createBackgroundAgentRuntime,
  ordinaryLocalAgentLaunchMode,
  type BackgroundAgentRuntimeOptions,
  type BackgroundAgentCompletion,
  type BackgroundTaskSnapshot,
} from "../../src/background-agent-runtime.js";
import type {
  SubagentPlan,
  SubagentChildResult,
} from "../../src/subagent-runtime.js";
import type { Message, ToolResult, ToolUse } from "../../src/types.js";
import { runAgent } from "../../src/agent.js";

const signal = () => new AbortController().signal;
const hasCode = (error: unknown, code: string) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const assistant = (text = "OWNED_CHILD_FINAL"): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  usage: { input_tokens: 10, output_tokens: 3 },
});
const plan = (agentId = "owned-background"): SubagentPlan => ({
  agentId,
  definition: {
    agentType: "owned-reader",
    whenToUse: "Owned fixture",
    prompt: "OWNED_CHILD_SYSTEM",
    source: "userSettings",
    skills: [],
    tools: ["Read"],
  },
  input: {
    description: "Owned background read",
    prompt: "OWNED_CHILD_REQUEST",
    run_in_background: true,
  },
  parent: {
    sessionId: "owned-session",
    parentModel: "claude-sonnet-4-6",
    parentMode: "default",
    depth: 0,
    maxDepth: 3,
    availableTools: [],
    allowedModes: ["default"],
    foregroundAllowed: true,
  },
  depth: 1,
  model: "claude-sonnet-4-6",
  permissionMode: "default",
  selectedToolNames: ["Read"],
  compaction: {},
  budget: { ownership: "independent-query" },
  maxTurns: 4,
});
function setup(patch: Partial<BackgroundAgentRuntimeOptions> = {}) {
  const child = deferred<SubagentChildResult>(),
    snapshots: Readonly<BackgroundTaskSnapshot>[] = [],
    notifications: Readonly<BackgroundAgentCompletion>[] = [],
    requests: Parameters<BackgroundAgentRuntimeOptions["runChild"]>[0][] = [],
    order: string[] = [],
    diagnostics: string[] = [];
  let executions = 0,
    cleanups = 0;
  const options: BackgroundAgentRuntimeOptions = {
    sessionId: "owned-session",
    admit: () => true,
    materialize: () => ({
      system: "OWNED_CHILD_SYSTEM",
      tools: {
        definitions: [
          {
            name: "Read",
            description: "Owned read",
            input_schema: { type: "object" },
          },
        ],
        async execute(call) {
          executions++;
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: "OWNED_FILE",
          };
        },
      },
      enforcesLiveParentPolicy: true,
      enforcesBackgroundToolScope: true,
      permissionPrompts: "avoid",
      cleanup: () => {
        cleanups++;
      },
    }),
    authorizeTool: () => true,
    async runChild(request) {
      order.push("run");
      requests.push(request);
      return child.promise;
    },
    outputFile: (p) => `/owned/${p.agentId}.json`,
    canReadOutputFile: () => true,
    async persist(snapshot) {
      snapshots.push(snapshot);
      order.push(`persist:${snapshot.status}`);
    },
    enqueueNotification(notification) {
      notifications.push(notification);
    },
    cleanupTask: async () => 0,
    watchdog: { kind: "unsupported" },
    now: () => 1000,
    onDiagnostic: (text) => diagnostics.push(text),
    ...patch,
  };
  return {
    options,
    runtime: createBackgroundAgentRuntime(options),
    child,
    snapshots,
    notifications,
    requests,
    order,
    diagnostics,
    get request() {
      const [first] = requests;
      assert.ok(first);
      return first;
    },
    get executions() {
      return executions;
    },
    get cleanups() {
      return cleanups;
    },
  };
}

test("ordinary local selection preserves host-resolved default async, explicit false, declaration and disabled fallback", () => {
  assert.equal(
    ordinaryLocalAgentLaunchMode({
      backgroundTasksDisabled: false,
      defaultAsync: true,
    }),
    "background",
  );
  assert.equal(
    ordinaryLocalAgentLaunchMode({
      requestedBackground: false,
      backgroundTasksDisabled: false,
      defaultAsync: true,
    }),
    "foreground",
  );
  assert.equal(
    ordinaryLocalAgentLaunchMode({
      requestedBackground: false,
      definitionBackground: true,
      backgroundTasksDisabled: false,
      defaultAsync: true,
    }),
    "background",
  );
  assert.equal(
    ordinaryLocalAgentLaunchMode({
      requestedBackground: true,
      backgroundTasksDisabled: true,
      defaultAsync: true,
    }),
    "foreground",
  );
  assert.equal(
    ordinaryLocalAgentLaunchMode({
      backgroundTasksDisabled: false,
      defaultAsync: false,
    }),
    "foreground",
  );
});

test("launch persists before detached child start and parent-turn abort afterward cannot cancel it", async () => {
  const f = setup(),
    parentTurn = new AbortController(),
    p = plan();
  const launched = await f.runtime.launch(p, {
    admissionSignal: parentTurn.signal,
  });
  assert.equal(launched.status, "async_launched");
  assert.equal(f.runtime.hasRunning, true);
  assert.equal(f.runtime.hasUnsettled, true);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.order[0], "persist:running");
  assert.equal(f.order[1], "run");
  parentTurn.abort();
  assert.equal(f.request.signal.aborted, false);
  assert.equal(f.request.isAsync, true);
  assert.equal(f.request.permissionPrompts, "avoid");
  assert.equal(f.request.plan.budget.ownership, "independent-query");
  f.child.resolve({ messages: [...f.request.messages, assistant()] });
  await f.runtime.settled();
  assert.equal(f.runtime.get(p.agentId).status, "completed");
  assert.equal(f.notifications.length, 1);
  assert.equal(f.cleanups, 1);
  assert.match(f.runtime.limitations.join(), /watchdog is not implemented/);
});

test("immutable plan/progress/snapshots and fresh context never expose or mutate parent history", async () => {
  const f = setup(),
    p = plan(),
    parent: Message[] = [
      { role: "user", content: [{ type: "text", text: "PARENT_PRIVATE" }] },
    ],
    before = structuredClone(parent);
  await f.runtime.launch(p, {
    admissionSignal: signal(),
    ownerAgentId: "owner",
    parentAgentId: "parent",
  });
  Reflect.set(p.input, "prompt", "MUTATED_AFTER_LAUNCH");
  assert.equal(f.request.plan.input.prompt, "OWNED_CHILD_REQUEST");
  assert.ok(Object.isFrozen(f.request.plan));
  const progress: Message[] = [
    ...f.request.messages,
    assistant("OWNED_PROGRESS"),
  ];
  f.request.onProgress({
    messages: progress,
    latestInputTokens: 10,
    cumulativeOutputTokens: 3,
  });
  const [firstProgress] = progress;
  assert.ok(firstProgress);
  const [firstBlock] = firstProgress.content;
  assert.ok(firstBlock);
  Reflect.set(firstBlock, "text", "MUTATED_PROGRESS");
  const snapshot = f.runtime.get(p.agentId);
  assert.ok(Object.isFrozen(snapshot));
  assert.match(JSON.stringify(snapshot.messages), /OWNED_CHILD_REQUEST/);
  assert.throws(() => {
    Reflect.apply(Array.prototype.push, snapshot.messages, [assistant()]);
  }, TypeError);
  f.child.resolve({ messages: [...f.request.messages, assistant()] });
  await f.runtime.settled();
  assert.deepEqual(parent, before);
  assert.ok(!JSON.stringify(f.notifications).includes("PARENT_PRIVATE"));
});

test("live parent deny survives declared tool metadata and execution cannot mutate committed tool input", async () => {
  let denied = false,
    executeResult: ToolResult | undefined;
  const execute = deferred<void>();
  const f = setup({
    authorizeTool(call) {
      if (typeof call.input === "object" && call.input !== null)
        Reflect.set(call.input, "path", "AUTHORIZATION_MUST_NOT_REWRITE");
      return denied ? "OWNED_LIVE_PARENT_DENY" : true;
    },
    async runChild(request) {
      await execute.promise;
      const call: ToolUse = {
        type: "tool_use",
        id: "owned-read",
        name: "Read",
        input: { path: "/owned/file" },
      };
      executeResult = await request.tools.execute(call, request.signal);
      assert.deepEqual(call.input, { path: "/owned/file" });
      return { messages: [...request.messages, assistant()] };
    },
  });
  await f.runtime.launch(plan(), { admissionSignal: signal() });
  denied = true;
  execute.resolve();
  await f.runtime.settled();
  assert.equal(executeResult?.permissionDenied, true);
  assert.equal(f.executions, 0);
  assert.match(executeResult?.content ?? "", /OWNED_LIVE_PARENT_DENY/);
});

test("TaskStop checks main-or-self ownership, awaits sweep but not child settlement, and retains retry handle", async () => {
  const sweep = deferred<number>();
  let sweeps = 0;
  const f = setup({
    cleanupTask: async () => {
      sweeps++;
      return sweeps === 1 ? sweep.promise : 0;
    },
  });
  const p = plan();
  await f.runtime.launch(p, {
    admissionSignal: signal(),
    ownerAgentId: "spawner",
  });
  await assert.rejects(
    f.runtime.stop(p.agentId, { callerAgentId: "spawner" }),
    (error) => hasCode(error, "not_owner"),
  );
  let returned = false;
  const stopping = f.runtime
    .stop(p.agentId, { callerAgentId: p.agentId })
    .then((value) => {
      returned = true;
      return value;
    });
  await Promise.resolve();
  assert.equal(returned, false);
  assert.equal(f.runtime.get(p.agentId).status, "killed");
  assert.equal(f.request.signal.aborted, true);
  sweep.resolve(2);
  assert.equal((await stopping).task_type, "local_agent");
  assert.equal(f.runtime.hasUnsettled, true);
  assert.match(
    (await f.runtime.stop(p.agentId)).message,
    /loop had not exited/,
  );
  assert.equal(sweeps, 2);
  f.child.resolve({
    messages: [...f.request.messages, assistant("LATE_COMPLETION")],
  });
  await f.runtime.settled();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0]?.status, "killed");
  assert.equal(f.runtime.get(p.agentId).result, undefined);
  await assert.rejects(f.runtime.stop(p.agentId), (error) =>
    hasCode(error, "not_running"),
  );
});

test("one child's completion/cancellation cannot settle or stop its sibling", async () => {
  const gates = new Map([
    ["alpha", deferred<SubagentChildResult>()],
    ["beta", deferred<SubagentChildResult>()],
  ]);
  const gate = (id: string) => {
    const found = gates.get(id);
    assert.ok(found);
    return found;
  };
  const f = setup({
    runChild: (request) => gate(request.plan.agentId).promise,
  });
  await Promise.all([
    f.runtime.launch(plan("alpha"), { admissionSignal: signal() }),
    f.runtime.launch(plan("beta"), { admissionSignal: signal() }),
  ]);
  await f.runtime.stop("alpha");
  gate("alpha").reject(new DOMException("stopped", "AbortError"));
  await f.runtime.settled("alpha");
  assert.equal(f.runtime.get("beta").status, "running");
  assert.equal(f.runtime.hasRunning, true);
  gate("beta").resolve({ messages: [assistant("BETA_FINAL")] });
  await f.runtime.settled();
  assert.deepEqual(
    f.notifications
      .map((n): [string, string] => [n.taskId, n.status])
      .sort(([a], [b]) => a.localeCompare(b)),
    [
      ["alpha", "killed"],
      ["beta", "completed"],
    ],
  );
});

test("notification enqueue failures are explicit and cannot rerun the child or claim another terminal notification", async () => {
  let deliveries = 0;
  const delivery = deferred<void>(),
    f = setup({
      async enqueueNotification() {
        deliveries++;
        await delivery.promise;
        throw new Error("OWNED_QUEUE_FAILURE");
      },
    });
  await f.runtime.launch(plan(), { admissionSignal: signal() });
  f.child.resolve({ messages: [assistant()] });
  while (!f.runtime.hasPendingNotifications)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.runtime.hasUnsettled, true);
  assert.equal(f.runtime.hasRunning, false);
  delivery.resolve();
  await f.runtime.settled();
  const value = f.runtime.get("owned-background");
  assert.equal(value.status, "completed");
  assert.equal(value.notification, "failed");
  assert.equal(value.deliveryError, "OWNED_QUEUE_FAILURE");
  await f.runtime.close();
  assert.equal(deliveries, 1);
  assert.equal(f.requests.length, 1);
});

test("failed initial registration never starts a child; later archive failures remain explicit without changing child outcome", async () => {
  const initial = setup({
    async persist() {
      throw new Error("OWNED_REGISTER_FAILURE");
    },
  });
  await assert.rejects(
    initial.runtime.launch(plan(), { admissionSignal: signal() }),
    /OWNED_REGISTER_FAILURE/,
  );
  assert.equal(initial.requests.length, 0);
  assert.equal(initial.cleanups, 1);
  assert.equal(initial.runtime.list().length, 0);
  const later = setup({
    async persist(value) {
      if (value.status !== "running")
        throw new Error("OWNED_LATE_ARCHIVE_FAILURE");
    },
  });
  await later.runtime.launch(plan(), { admissionSignal: signal() });
  later.child.resolve({ messages: [assistant()] });
  await later.runtime.settled();
  assert.equal(later.runtime.get("owned-background").status, "completed");
  assert.equal(
    later.runtime.get("owned-background").persistenceError,
    "OWNED_LATE_ARCHIVE_FAILURE",
  );
});

test("admission abort during registration archives cancellation and never publishes a running orphan", async () => {
  const gate = deferred<void>(),
    entered = deferred<void>(),
    parent = new AbortController();
  const archived: Readonly<BackgroundTaskSnapshot>[] = [];
  const f = setup({
    async persist(value) {
      archived.push(value);
      if (value.status === "running") {
        entered.resolve();
        await gate.promise;
      }
    },
  });
  const launching = f.runtime.launch(plan(), {
    admissionSignal: parent.signal,
  });
  await entered.promise;
  parent.abort(new DOMException("Owned admission cancelled", "AbortError"));
  gate.resolve();
  await assert.rejects(launching, { name: "AbortError" });
  assert.deepEqual(
    archived.map((value) => value.status),
    ["running", "killed"],
  );
  assert.equal(archived[1]?.settled, true);
  assert.equal(f.runtime.list().length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.notifications.length, 0);
});

test("host admission, isolation/metadata/prompt-policy guards and duplicate reservations precede child dispatch", async () => {
  const blocked = setup({ admit: () => "OWNED_ASYNC_DISABLED" });
  await assert.rejects(
    blocked.runtime.launch(plan(), { admissionSignal: signal() }),
    /OWNED_ASYNC_DISABLED/,
  );
  assert.equal(blocked.requests.length, 0);
  const unsupported = setup();
  const isolated = plan();
  isolated.definition = { ...isolated.definition, isolation: "worktree" };
  await assert.rejects(
    unsupported.runtime.launch(isolated, { admissionSignal: signal() }),
    /does not support/,
  );
  const memory = plan();
  memory.definition = { ...memory.definition, memory: "user" };
  await assert.rejects(
    unsupported.runtime.launch(memory, { admissionSignal: signal() }),
    /memory requires an admitted host adapter/,
  );
  const registration = deferred<void>(),
    duplicate = setup({ persist: () => registration.promise });
  const launching = duplicate.runtime.launch(plan(), {
    admissionSignal: signal(),
  });
  await assert.rejects(
    duplicate.runtime.launch(plan(), { admissionSignal: signal() }),
    (error) => hasCode(error, "duplicate"),
  );
  registration.resolve();
  await launching;
  duplicate.child.resolve({ messages: [assistant()] });
  await duplicate.runtime.settled();
});

test("required watchdog adapter receives progress and its timeout fails the task without pretending it was user-stopped", async () => {
  let timeout!: (message: string) => void,
    disposed = false,
    progressSeen = 0;
  const f = setup({
    watchdog: {
      kind: "adapter",
      start: (request) => {
        timeout = (message) => request.onTimeout(message);
        return {
          progress: () => {
            progressSeen++;
          },
          dispose: () => {
            disposed = true;
          },
        };
      },
    },
  });
  await f.runtime.launch(plan(), { admissionSignal: signal() });
  f.request.onProgress({ toolsInFlight: 1 });
  assert.equal(progressSeen, 1);
  timeout("OWNED_STALL");
  assert.equal(f.request.signal.aborted, true);
  f.child.reject(new Error("abort surfaced"));
  await f.runtime.settled();
  assert.equal(f.runtime.get("owned-background").status, "failed");
  assert.equal(f.notifications[0]?.error, "OWNED_STALL");
  assert.equal(disposed, true);
});

test("session close explicitly stops cooperative children and subscriptions expose lifecycle changes without another loop", async () => {
  const cleaned: string[] = [],
    f = setup({
      runChild: (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          ),
        ),
      cleanupTask: async ({ task, reason }) => {
        assert.equal(reason, "session-close");
        cleaned.push(task.id);
      },
    });
  let changes = 0;
  const unsubscribe = f.runtime.subscribe(() => {
    changes++;
  });
  await f.runtime.launch(plan("close-a"), { admissionSignal: signal() });
  await f.runtime.launch(plan("close-b"), { admissionSignal: signal() });
  await f.runtime.close();
  assert.deepEqual(
    cleaned.sort((a, b) => a.localeCompare(b)),
    ["close-a", "close-b"],
  );
  assert.equal(f.runtime.hasUnsettled, false);
  assert.ok(changes > 2);
  const before = changes;
  unsubscribe();
  await f.runtime.close();
  assert.equal(changes, before);
  await assert.rejects(
    f.runtime.launch(plan("after-close"), { admissionSignal: signal() }),
    (error) => hasCode(error, "closed"),
  );
});

test("session close owns pending admission cleanup and never publishes it into a later session", async () => {
  const entered = deferred<void>(),
    f = setup();
  f.options.materialize = async (request) => {
    entered.resolve();
    await new Promise((_resolve, reject) =>
      request.signal.addEventListener(
        "abort",
        () => reject(request.signal.reason),
        { once: true },
      ),
    );
    throw new Error("unreachable");
  };
  const launching = f.runtime.launch(plan(), { admissionSignal: signal() });
  const rejected = assert.rejects(launching, { name: "AbortError" });
  await entered.promise;
  await f.runtime.close();
  await rejected;
  assert.equal(f.runtime.list().length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.snapshots.length, 0);
});

test("real child runAgent keeps report13, notification16 and cumulative child ledger26 separate", async () => {
  let requests = 0,
    cumulativeOutput = 0,
    cumulativeLedger = 0,
    childUsage = 0;
  const parent: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "OWNED_PARENT_PRIVATE" }],
      },
    ],
    before = structuredClone(parent);
  const f = setup({
    async runChild(request) {
      const child = await runAgent({
        provider: {
          async complete(value) {
            requests++;
            assert.ok(
              !JSON.stringify(value.messages).includes("OWNED_PARENT_PRIVATE"),
            );
            cumulativeLedger += 13;
            return {
              content:
                requests === 1
                  ? [
                      {
                        type: "tool_use",
                        id: "owned-read",
                        name: "Read",
                        input: { path: "/owned/file" },
                      },
                    ]
                  : [{ type: "text", text: "OWNED_FINAL" }],
              stop_reason: requests === 1 ? "tool_use" : "end_turn",
              usage: { input_tokens: 10, output_tokens: 3 },
            };
          },
        },
        tools: request.tools,
        model: request.plan.model,
        system: request.system,
        messages: request.messages,
        maxTokens: 100,
        maxTurns: 4,
        autoCompact: false,
        signal: request.signal,
        onEvent(event) {
          if (event.type === "usage") {
            cumulativeOutput += event.usage.output_tokens;
            request.onProgress({
              latestInputTokens: event.usage.input_tokens,
              cumulativeOutputTokens: cumulativeOutput,
            });
          }
          if (event.type === "assistant" || event.type === "tool_result")
            request.onProgress({ messages: request.messages });
        },
      });
      childUsage = child.usage.input_tokens + child.usage.output_tokens;
      return { messages: child.messages };
    },
  });
  await f.runtime.launch(plan(), { admissionSignal: signal() });
  await f.runtime.settled();
  assert.equal(requests, 2);
  assert.equal(f.executions, 1);
  assert.equal(f.runtime.get("owned-background").result?.totalTokens, 13);
  assert.equal(f.notifications[0]?.usage?.totalTokens, 16);
  assert.equal(f.notifications[0]?.usage?.toolUses, 1);
  assert.equal(cumulativeLedger, 26);
  assert.equal(childUsage, 26);
  assert.deepEqual(parent, before);
});
