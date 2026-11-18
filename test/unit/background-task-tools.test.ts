import { test } from "bun:test";
import assert from "node:assert/strict";
import { BackgroundTaskError } from "../../src/background-agent-runtime.js";
import {
  createBackgroundTaskTools,
  projectTaskStopText,
  type BackgroundTaskToolView,
  type BackgroundTaskToolsOptions,
  taskStopOutputSchema,
  type TaskStopOutput,
} from "../../src/background-task-tools.js";
import { projectMessages } from "../../src/thinking-history.js";
import type { ToolPolicy } from "../../src/tool-policy.js";
import type { ToolHookRuntime } from "../../src/tool-hook-runtime.js";
import type { ToolUse } from "../../src/types.js";
import { z } from "zod";
function head<T>(items: readonly T[]): T {
  const [item] = items;
  assert.ok(item);
  return item;
}
const owned = (
  f: { tasks: Map<string, BackgroundTaskToolView> },
  id = "owned-a",
) => {
  const item = f.tasks.get(id);
  assert.ok(item);
  return item;
};
const signal = () => new AbortController().signal;
const call = (input: unknown, name = "TaskStop"): ToolUse => ({
  type: "tool_use",
  id: "owned-stop-call",
  name,
  input,
});
const pre = (): {
  additionalContext: string[];
  preventContinuation: boolean;
} => ({
  additionalContext: [],
  preventContinuation: false,
});
const task = (id = "owned-a"): BackgroundTaskToolView => ({
  id,
  agentId: id,
  type: "local_agent",
  status: "running",
  settled: false,
  description: `Owned ${id}`,
});
function fixture(overrides: Partial<BackgroundTaskToolsOptions> = {}) {
  const tasks = new Map(
      [task(), task("owned-b")].map((task) => [task.id, task]),
    ),
    events: string[] = [],
    stops: Parameters<BackgroundTaskToolsOptions["stop"]>[] = [];
  const options: BackgroundTaskToolsOptions = {
    get: (id) => tasks.get(id),
    list: () => [...tasks.values()],
    context: () => ({}),
    enabled: () => true,
    policy: () => ({ allowedTools: [], disallowedTools: [] }),
    authorize: () => {
      events.push("authorize");
      return true;
    },
    async stop(id, request) {
      stops.push([id, request]);
      events.push("stop");
      const item = tasks.get(id);
      if (!item) throw new BackgroundTaskError("No task", "not_found");
      if (
        request.callerAgentId !== undefined &&
        request.callerAgentId !== item.agentId
      )
        throw new BackgroundTaskError(
          "Owned scheduler refuses another agent",
          "not_owner",
        );
      if (item.status !== "running" && item.settled)
        throw new BackgroundTaskError(
          "Owned task already ended",
          "not_running",
        );
      item.status = "killed";
      return {
        message: "Owned task stopped",
        task_id: id,
        task_type: item.type,
        ...(item.description === undefined
          ? {}
          : { command: item.description }),
      };
    },
    ...overrides,
  };
  return {
    tasks,
    events,
    stops,
    options,
    runtime: createBackgroundTaskTools(options),
  };
}

test("canonical TaskStop and KillShell/KillBash aliases preserve shell_id and explicit parent kill cause", async () => {
  for (const name of ["TaskStop", "KillShell", "KillBash"]) {
    const f = fixture();
    const model = call({ shell_id: "owned-a" }, name),
      controller = new AbortController();
    const result = await f.runtime.execute(model, controller.signal);
    assert.equal(result.is_error, undefined);
    assert.equal(
      taskStopOutputSchema.parse(JSON.parse(result.content)).task_id,
      "owned-a",
    );
    assert.equal(head(f.stops)[0], "owned-a");
    assert.equal(head(f.stops)[1].killedBy, "parent");
    assert.equal(head(f.stops)[1].signal, controller.signal);
    assert.deepEqual(model, call({ shell_id: "owned-a" }, name));
    assert.deepEqual(
      f.runtime.definitions.map((tool) => tool.name),
      ["TaskStop"],
    );
  }
});
test("strict optional schema requires a truthy selected ID and task_id wins over deprecated shell_id", async () => {
  const events: string[] = [];
  const hooks: ToolHookRuntime = {
    async before() {
      events.push("pre");
      return pre();
    },
    async after(_call, result) {
      return result;
    },
  };
  const f = fixture({ hooks });
  for (const input of [
    {},
    { task_id: "" },
    { task_id: 1 },
    { task_id: "owned-a", extra: true },
    { task_id: "", shell_id: "owned-a" },
  ]) {
    const result = await f.runtime.execute(call(input), signal());
    assert.equal(result.inputRejected, true);
  }
  assert.deepEqual(events, []);
  assert.deepEqual(f.stops, []);
  assert.equal(
    (
      await f.runtime.execute(
        call({ task_id: "owned-a", shell_id: "owned-b" }),
        signal(),
      )
    ).is_error,
    undefined,
  );
  assert.equal(head(f.stops)[0], "owned-a");
});
test("missing and finished tasks reject before hooks; scheduler not_found errors are typed", async () => {
  let hooks = 0;
  const f = fixture({
    hooks: {
      async before() {
        hooks++;
        return pre();
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  owned(f).status = "completed";
  owned(f).settled = true;
  for (const id of ["missing", "owned-a"])
    assert.equal(
      (await f.runtime.execute(call({ task_id: id }), signal())).inputRejected,
      true,
    );
  assert.equal(hooks, 0);
  assert.deepEqual(f.stops, []);
  const missing = fixture({
    get() {
      throw new BackgroundTaskError("not exposed", "not_found");
    },
  });
  assert.match(
    (await missing.runtime.execute(call({ task_id: "missing" }), signal()))
      .content,
    /No task found with ID/,
  );
});
test("ended local loop may reach scheduler to re-signal, without rewriting task status in wrapper", async () => {
  const f = fixture();
  owned(f).status = "completed";
  assert.equal(
    (await f.runtime.execute(call({ task_id: "owned-a" }), signal())).is_error,
    undefined,
  );
  assert.equal(f.stops.length, 1);
});
test("hooks see canonical alias, validated full replacements authorize and stop effective ID without mutating model", async () => {
  const seen: ToolUse[] = [],
    events: string[] = [];
  const hooks: ToolHookRuntime = {
    async before(tool, _signal, validate) {
      events.push("pre");
      seen.push(tool);
      return {
        ...pre(),
        additionalContext: ["owned pre context"],
        permission: "allow",
        updatedInput: await validate({ shell_id: "owned-b" }),
      };
    },
    async after(tool, result) {
      events.push("post");
      seen.push(tool);
      assert.equal(
        taskStopOutputSchema.parse(result.hookResponse).task_id,
        "owned-b",
      );
      return result;
    },
  };
  const f = fixture({
    hooks,
    authorize(tool, _context, permission) {
      events.push("authorize");
      assert.equal(permission, "allow");
      assert.deepEqual(tool.input, { shell_id: "owned-b" });
      return true;
    },
  });
  const model = call({ task_id: "owned-a" }, "KillShell"),
    result = await f.runtime.execute(model, signal());
  assert.deepEqual(events, ["pre", "authorize", "post"]);
  assert.equal(head(f.stops)[0], "owned-b");
  assert.equal(head(seen).name, "TaskStop");
  assert.deepEqual(result.effectiveToolInput, { shell_id: "owned-b" });
  assert.deepEqual(model.input, { task_id: "owned-a" });
  assert.deepEqual(
    result.hookAttachments?.flatMap((item) => item.content),
    ["owned pre context"],
  );
  const wire = projectMessages([
    { role: "assistant", content: [model] },
    { role: "user", content: [result] },
  ]);
  assert.equal(JSON.stringify(wire).includes("effectiveToolInput"), false);
  assert.equal(JSON.stringify(wire).includes("hookResponse"), false);
});
test("invalid hook full replacement cannot retain allow or stop the original task", async () => {
  const f = fixture({
    hooks: {
      async before() {
        return {
          ...pre(),
          permission: "allow",
          updatedInput: { task_id: "absent" },
        };
      },
      async after(_call, result) {
        return result;
      },
    },
  });
  assert.equal(
    (await f.runtime.execute(call({ task_id: "owned-a" }), signal()))
      .inputRejected,
    true,
  );
  assert.deepEqual(f.stops, []);
  assert.equal(owned(f).status, "running");
});
test("explicit deny, asked policy, and host refusal retain authority over hook allow", async () => {
  const hooks: ToolHookRuntime = {
    async before() {
      return { ...pre(), permission: "allow" };
    },
    async after(_call, result) {
      return result;
    },
  };
  const denied = fixture({
    hooks,
    policy: () => ({
      allowedTools: [],
      disallowedTools: [],
      sourcedRules: [
        {
          source: "policySettings",
          behavior: "deny",
          rule: "KillShell(task_id:owned-*)",
        },
      ],
    }),
  });
  assert.equal(
    (await denied.runtime.execute(call({ task_id: "owned-a" }), signal()))
      .permissionDenied,
    true,
  );
  assert.deepEqual(denied.stops, []);
  let passedPermission: unknown;
  const asked = fixture({
    hooks,
    policy: () => ({
      allowedTools: [],
      disallowedTools: [],
      sourcedRules: [
        { source: "policySettings", behavior: "ask", rule: "TaskStop" },
      ],
    }),
    authorize(_call, _context, permission) {
      passedPermission = permission;
      return false;
    },
  });
  assert.equal(
    (await asked.runtime.execute(call({ task_id: "owned-a" }), signal()))
      .permissionDenied,
    true,
  );
  assert.equal(passedPermission, "ask");
  assert.deepEqual(asked.stops, []);
  const refused = fixture({
    hooks,
    authorize: () => "Owned host policy refused",
  });
  assert.match(
    (await refused.runtime.execute(call({ task_id: "owned-a" }), signal()))
      .content,
    /Owned host policy refused/,
  );
  assert.deepEqual(refused.stops, []);
});
test("hook deny/defer/stop skips host stop and carries stop continuation metadata", async () => {
  for (const decision of [
    { permission: "deny" as const },
    { permission: "defer" as const },
    { preventContinuation: true, stopReason: "Owned stop" },
  ]) {
    const f = fixture({
      hooks: {
        async before() {
          return { ...pre(), ...decision };
        },
        async after(_call, result) {
          return result;
        },
      },
    });
    const result = await f.runtime.execute(
      call({ task_id: "owned-a" }),
      signal(),
    );
    assert.equal(result.is_error, true);
    assert.deepEqual(f.stops, []);
    if (decision.preventContinuation)
      assert.deepEqual(result.hookStop, { reason: "Owned stop" });
  }
});
test("ownership is delegated at stop after Pre and permissions; failure hooks receive original typed error", async () => {
  const events: string[] = [];
  const f = fixture({
    context: () => ({ callerAgentId: "another" }),
    hooks: {
      async before() {
        events.push("pre");
        return pre();
      },
      async after(_call, result) {
        events.push("post");
        return result;
      },
      async failure(tool, error) {
        events.push("failure");
        assert.equal(tool.name, "TaskStop");
        assert.ok(error instanceof BackgroundTaskError);
        assert.equal(error.code, "not_owner");
        return { additionalContext: ["Owned failure feedback"] };
      },
    },
    authorize() {
      events.push("authorize");
      return true;
    },
  });
  const result = await f.runtime.execute(
    call({ task_id: "owned-a" }),
    signal(),
  );
  assert.deepEqual(events, ["pre", "authorize", "failure"]);
  assert.equal(result.is_error, true);
  assert.equal(result.inputRejected, undefined);
  assert.match(result.content, /scheduler refuses/);
  assert.deepEqual(result.hookContext, ["Owned failure feedback"]);
  assert.equal(owned(f).status, "running");
  assert.equal(head(f.stops)[1].callerAgentId, "another");
});
test("post output replacement validates native payload shape and preserves short projected fields", async () => {
  const f = fixture({
    hooks: {
      async before() {
        return pre();
      },
      async after(_call, result, _signal, validate) {
        assert.ok(validate);
        return validate(
          {
            message: "\u001b[31mOwned revised\u001b[0m",
            task_id: "owned-a",
            task_type: "local_agent",
            command: "\u001b[32mowned\u001b[0m",
          },
          result,
        );
      },
    },
  });
  const result = await f.runtime.execute(
    call({ task_id: "owned-a" }),
    signal(),
  );
  assert.deepEqual(JSON.parse(result.content), {
    message: "\u001b[31mOwned revised\u001b[0m",
    task_id: "owned-a",
    task_type: "local_agent",
    command: "\u001b[32mowned\u001b[0m",
  });
});
test("malformed stop/post output is an outcome error, not an input-validation error", async () => {
  const invalid = fixture({
    // Deliberately violates the output schema; z.custom without a check admits any value.
    stop: () => z.custom<TaskStopOutput>().parse({ task_id: "owned-a" }),
  });
  const badStop = await invalid.runtime.execute(
    call({ task_id: "owned-a" }),
    signal(),
  );
  assert.equal(badStop.is_error, true);
  assert.equal(badStop.inputRejected, undefined);
  const invalidPost = fixture({
    hooks: {
      async before() {
        return pre();
      },
      async after(_call, result, _signal, validate) {
        assert.ok(validate);
        return validate({ message: 1 }, result);
      },
    },
  });
  const badPost = await invalidPost.runtime.execute(
    call({ task_id: "owned-a" }),
    signal(),
  );
  assert.equal(badPost.is_error, true);
  assert.equal(badPost.inputRejected, undefined);
});
test("disabled/narrowed tool stays unavailable, policy changes during authorization cannot stop", async () => {
  for (const override of [
    { enabled: () => false },
    {
      policy: (): ToolPolicy => ({
        allowedTools: [],
        disallowedTools: [],
        tools: ["Read"],
      }),
    },
  ]) {
    const f = fixture(override);
    assert.deepEqual(f.runtime.definitions, []);
    assert.equal(
      (await f.runtime.execute(call({ task_id: "owned-a" }), signal()))
        .permissionDenied,
      true,
    );
    assert.deepEqual(f.stops, []);
  }
  let enabled = true;
  const changed = fixture({
    enabled: () => enabled,
    authorize() {
      enabled = false;
      return true;
    },
  });
  assert.equal(
    (await changed.runtime.execute(call({ task_id: "owned-a" }), signal()))
      .permissionDenied,
    true,
  );
  assert.deepEqual(changed.stops, []);
});
test("cancellation after hook or authorization prevents host stop", async () => {
  for (const phase of ["pre", "authorize"] as const) {
    const controller = new AbortController();
    const f = fixture({
      hooks: {
        async before() {
          if (phase === "pre") controller.abort();
          return pre();
        },
        async after(_call, result) {
          return result;
        },
      },
      authorize() {
        if (phase === "authorize") controller.abort();
        return true;
      },
    });
    await assert.rejects(
      f.runtime.execute(call({ task_id: "owned-a" }), controller.signal),
      { name: "AbortError" },
    );
    assert.deepEqual(f.stops, []);
  }
});
test("wrapper delegates unrelated tools and does not advertise aliases, TaskOutput or ListAgents", async () => {
  const f = fixture();
  let delegated = false;
  const wrapped = f.runtime.wrap({
    definitions: [
      { name: "Read", description: "Owned", input_schema: { type: "object" } },
    ],
    async execute(tool) {
      delegated = true;
      return {
        type: "tool_result",
        tool_use_id: tool.id,
        content: "Owned base",
      };
    },
  });
  assert.deepEqual(
    wrapped.definitions.map((tool) => tool.name),
    ["Read", "TaskStop"],
  );
  assert.equal(
    (await wrapped.execute(call({}, "Read"), signal())).content,
    "Owned base",
  );
  assert.equal(delegated, true);
  assert.equal(f.runtime.handles("ListAgents"), false);
  assert.equal(f.runtime.handles("TaskOutput"), false);
});

test("long stop output bounds text without splitting surrogate pairs and retains authored-data markers", () => {
  const marker = "<artifact-content-authored-by-others/>",
    control = "<remote-control-device-report/>";
  const text =
    "x".repeat(499) +
    "😀" +
    "x".repeat(200) +
    marker +
    control +
    "x".repeat(200) +
    "😀" +
    "y".repeat(299);
  const projected = projectTaskStopText(text);
  assert.match(projected, /characters truncated/);
  assert.ok(projected.endsWith(marker + "\n" + control));
  const withoutMarkers = projected.slice(
    0,
    projected.lastIndexOf("\n" + marker),
  );
  assert.equal(withoutMarkers.startsWith("x".repeat(499) + "\n"), true);
  assert.equal(withoutMarkers.endsWith("y".repeat(299)), true);
  assert.equal(projectTaskStopText("owned"), "owned");
});
