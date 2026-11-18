import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlanFileManager,
  PlanRuntime,
  type PlanApproval,
  type PlanPermissionMode,
  type PlanPermissionState,
} from "../../src/plan-runtime.js";
import {
  createPlanFileAccess,
  wrapPlanRuntime,
  type PlanPolicyDecision,
  type PlanSessionOptions,
} from "../../src/plan-session.js";
import type {
  PreToolHookResult,
  ToolHookRuntime,
} from "../../src/tool-hook-runtime.js";
import { z } from "zod";
import { createTools } from "../../src/tools.js";
import { ReadState } from "../../src/read-state.js";
import { toolPolicySchema } from "../../src/tool-policy.js";
import type { PermissionMode, ToolExecutor, ToolUse } from "../../src/types.js";
import { failureFeedback, hookTexts } from "../helpers/hook-attachments.js";

const signal = () => new AbortController().signal;
const call = (name: string, input: unknown = {}): ToolUse => ({
  type: "tool_use",
  id: "owned-plan-session",
  name,
  input,
});
const emptyPre = (): PreToolHookResult => ({
  additionalContext: [],
  preventContinuation: false,
});
const emptyBase: ToolExecutor = {
  definitions: [],
  async execute(tool) {
    return {
      type: "tool_result",
      tool_use_id: tool.id,
      content: "ordinary tool",
    };
  },
};
const planPathOf = (runtime: PlanRuntime): string => {
  const path = runtime.planLocation();
  assert.ok(path);
  return path;
};
const toolMode = (mode: PlanPermissionMode): PermissionMode => {
  assert.ok(mode !== "auto" && mode !== "dontAsk");
  return mode;
};
async function fixture(initial: PlanPermissionState = { mode: "default" }) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-plan-session-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"),
    directory = join(root, "user", "plans");
  await mkdir(cwd);
  await mkdir(directory, { recursive: true });
  const files = new PlanFileManager({
    directory,
    createSlug: () => "owned-session-plan",
  });
  let state = initial,
    session = "owned-session",
    pre = emptyPre(),
    policy: PlanPolicyDecision = { behavior: "allow" },
    approval: PlanApproval = { approved: true };
  const events: string[] = [];
  const runtime = new PlanRuntime({
    files,
    sessionId: () => session,
    permissions: () => state,
    setPermissions: (update) => {
      state = update(state);
    },
    storage: {
      async read(path, active) {
        active.throwIfAborted();
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        }
      },
      async save(path, text, active) {
        active.throwIfAborted();
        await writeFile(path, text);
        return { savedPath: path };
      },
    },
    canRequestApproval: () => true,
    approve: async () => {
      throw new Error("The adapter must own the host approval pipeline");
    },
  });
  const hooks: ToolHookRuntime = {
    async before(tool, _active, validate) {
      events.push(`pre:${tool.name}`);
      if (pre.updatedInput !== undefined) await validate(pre.updatedInput);
      return pre;
    },
    async after(tool, result, _active, validator) {
      events.push(`post:${tool.name}`);
      assert.equal(
        validator,
        undefined,
        "plan output is protected from generic replacement",
      );
      return result;
    },
    async failure(tool) {
      events.push(`failure:${tool.name}`);
      return failureFeedback("owned failure feedback");
    },
  };
  const options: PlanSessionOptions = {
    runtime,
    hooks,
    authorize: ({ call: tool, hookPermission }) => {
      events.push(`policy:${tool.name}:${hookPermission ?? "none"}`);
      return policy;
    },
    approve: async ({ call: tool }) => {
      events.push(`approve:${tool.name}`);
      return approval;
    },
    onExecution: (execution) => {
      events.push(`executed:${execution.transition?.to ?? "same"}`);
    },
  };
  return {
    root,
    cwd,
    directory,
    files,
    runtime,
    hooks,
    options,
    events,
    get state() {
      return state;
    },
    setState: (value: PlanPermissionState) => {
      state = value;
    },
    setSession: (value: string) => {
      session = value;
    },
    setPre: (value: PreToolHookResult) => {
      pre = value;
    },
    setPolicy: (value: PlanPolicyDecision) => {
      policy = value;
    },
    setApproval: (value: PlanApproval) => {
      approval = value;
    },
    wrap: (base: ToolExecutor | (() => ToolExecutor) = emptyBase) =>
      wrapPlanRuntime(base, options),
    access: () =>
      createPlanFileAccess({ cwd, files, sessionId: () => session }),
  };
}

test("plan adapter validates before hooks and ordinary entry follows full host policy", async () => {
  const f = await fixture(),
    tools = f.wrap();
  const bad = await tools.execute(
    call("EnterPlanMode", { unsupported: true }),
    signal(),
  );
  assert.equal(bad.inputRejected, true);
  assert.deepEqual(f.events, []);
  const entered = await tools.execute(call("EnterPlanMode"), signal());
  assert.equal(entered.is_error, undefined);
  assert.equal(f.state.mode, "plan");
  assert.deepEqual(f.events, [
    "pre:EnterPlanMode",
    "policy:EnterPlanMode:none",
    "executed:plan",
    "post:EnterPlanMode",
  ]);
});

test("disabled plan tools produce permission metadata without consuming input-repair classification", async () => {
  const f = await fixture(),
    tools = wrapPlanRuntime(emptyBase, {
      ...f.options,
      available: () => false,
    });
  const denied = await tools.execute(call("EnterPlanMode"), signal());
  assert.equal(denied.permissionDenied, true);
  assert.equal(denied.inputRejected, undefined);
  assert.deepEqual(f.events, []);
});

test("Exit pre-hook allow without replacement still asks and rejection keeps plan mode", async () => {
  const f = await fixture({ mode: "plan" });
  f.setPre({ ...emptyPre(), permission: "allow" });
  f.setApproval({ approved: false });
  const result = await f.wrap().execute(call("ExitPlanMode"), signal());
  assert.equal(result.permissionDenied, true);
  assert.equal(f.state.mode, "plan");
  assert.deepEqual(f.events, [
    "pre:ExitPlanMode",
    "policy:ExitPlanMode:allow",
    "approve:ExitPlanMode",
  ]);
});

test("validated Exit hook allow plus replacement satisfies interaction and saves only the designated target", async () => {
  const f = await fixture({ mode: "plan", prePlanMode: "acceptEdits" });
  const designated = planPathOf(f.runtime);
  await writeFile(designated, "disk plan");
  const original = call("ExitPlanMode", {
    plan: "untrusted model plan",
    planFilePath: join(f.root, "model-target"),
  });
  f.setPre({
    ...emptyPre(),
    permission: "allow",
    updatedInput: {
      plan: "trusted hook plan",
      planFilePath: join(f.root, "hook-target"),
    },
  });
  const result = await f.wrap().execute(original, signal());
  assert.equal(result.is_error, undefined);
  assert.equal(f.state.mode, "acceptEdits");
  assert.equal(await readFile(designated, "utf8"), "trusted hook plan");
  assert.equal(f.events.includes("approve:ExitPlanMode"), false);
  assert.deepEqual(original.input, {
    plan: "untrusted model plan",
    planFilePath: join(f.root, "model-target"),
  });
  await assert.rejects(readFile(join(f.root, "hook-target")), {
    code: "ENOENT",
  });
  assert.equal(
    z.object({ plan: z.string() }).parse(result.effectiveToolInput).plan,
    "trusted hook plan",
  );
});

test("full host deny/ask and hook ask survive the validated Exit interaction exception", async () => {
  const f = await fixture({ mode: "plan" });
  f.setPre({ ...emptyPre(), permission: "allow", updatedInput: {} });
  f.setPolicy({ behavior: "deny", reason: "protected policy" });
  assert.equal(
    (await f.wrap().execute(call("ExitPlanMode"), signal())).permissionDenied,
    true,
  );
  assert.equal(f.state.mode, "plan");
  assert.equal(f.events.includes("approve:ExitPlanMode"), false);
  f.events.length = 0;
  f.setPolicy({ behavior: "ask", reason: "explicit ask" });
  assert.equal(
    (await f.wrap().execute(call("ExitPlanMode"), signal())).is_error,
    undefined,
  );
  assert.equal(f.events.includes("approve:ExitPlanMode"), true);
  f.setState({ mode: "plan" });
  f.events.length = 0;
  f.setPolicy({ behavior: "allow" });
  f.setPre({ ...emptyPre(), permission: "ask", updatedInput: {} });
  await f.wrap().execute(call("ExitPlanMode"), signal());
  assert.equal(f.events.includes("approve:ExitPlanMode"), true);
});

test("hook stop and malformed replacement produce no mode transition or execution failure hook", async () => {
  const f = await fixture();
  f.setPre({
    ...emptyPre(),
    preventContinuation: true,
    stopReason: "owned hook stop",
  });
  const stopped = await f.wrap().execute(call("EnterPlanMode"), signal());
  assert.deepEqual(stopped.hookStop, { reason: "owned hook stop" });
  assert.equal(f.state.mode, "default");
  assert.deepEqual(f.events, ["pre:EnterPlanMode"]);
  f.events.length = 0;
  f.setPre({
    ...emptyPre(),
    permission: "allow",
    updatedInput: { invalid: true },
  });
  const invalid = await f.wrap().execute(call("EnterPlanMode"), signal());
  assert.equal(invalid.inputRejected, true);
  assert.equal(f.state.mode, "default");
  assert.deepEqual(f.events, ["pre:EnterPlanMode"]);
});

test("dynamic underlying executors preserve read context, compaction and model preparation callbacks", async () => {
  const f = await fixture(),
    observed: unknown[] = [];
  const wrapped = wrapPlanRuntime(
    () => ({
      definitions: [],
      setReadContext: (context) => {
        observed.push(context);
      },
      async beforeModelRequest() {
        observed.push("base-model");
      },
      async prepareCompaction() {
        observed.push("compaction");
        return { messages: [], commit() {} };
      },
      async execute(tool) {
        observed.push("base-call");
        return { type: "tool_result", tool_use_id: tool.id, content: "base" };
      },
    }),
    {
      ...f.options,
      beforeModelRequest: () => {
        observed.push("plan-model");
      },
    },
  );
  const context = { bytesPerToken: 4 };
  wrapped.setReadContext?.(context);
  await wrapped.beforeModelRequest?.(signal());
  await wrapped.execute(call("Read", { file_path: "a" }), signal());
  await wrapped.prepareCompaction?.({ keptMessages: [], signal: signal() });
  assert.equal(observed.filter((value) => value === context).length >= 3, true);
  assert.deepEqual(
    observed.filter((value) => typeof value === "string"),
    ["base-model", "plan-model", "base-call", "compaction"],
  );
});

test("plan path admission covers missing external session files without granting directory traversal", async () => {
  const f = await fixture({ mode: "plan" }),
    target = planPathOf(f.runtime),
    access = f.access();
  assert.equal(
    await access.extraPathAdmission({
      operation: "Write",
      requestedPath: target,
    }),
    target,
  );
  assert.equal(
    await access.planWriteEligibility({
      operation: "Write",
      requestedPath: target,
      canonicalPath: target,
    }),
    true,
  );
  assert.equal(
    await access.planWriteEligibility({
      operation: "Write",
      requestedPath: target,
      canonicalPath: join(f.directory, "other.md"),
    }),
    false,
  );
  for (const path of [
    f.directory,
    join(f.directory, "other.md"),
    join(f.directory, "nested", "owned-session-plan.md"),
    join(f.root, "outside.md"),
  ]) {
    assert.equal(
      await access.extraPathAdmission({
        operation: "Read",
        requestedPath: path,
      }),
      undefined,
    );
  }
  assert.equal(
    await access.extraPathAdmission({
      operation: "Glob",
      requestedPath: target,
    }),
    undefined,
  );
  assert.equal(
    await access.extraPathAdmission({
      operation: "Write",
      requestedPath: join(f.directory, "owned-session-plan-agent-child.md"),
    }),
    join(f.directory, "owned-session-plan-agent-child.md"),
  );
  f.setSession("other");
  assert.equal(
    await access.extraPathAdmission({
      operation: "Read",
      requestedPath: target,
    }),
    undefined,
  );
});

test("plan path admission retains leaf link safety and pins an admitted directory across symlink changes", async () => {
  const f = await fixture({ mode: "plan" }),
    path = planPathOf(f.runtime),
    access = f.access();
  await writeFile(path, "owned plan");
  const alias = join(f.directory, "owned-session-plan-agent-alias.md");
  await symlink(path, alias);
  assert.equal(
    await access.extraPathAdmission({
      operation: "Read",
      requestedPath: alias,
    }),
    path,
  );
  assert.equal(
    await access.extraPathAdmission({
      operation: "Write",
      requestedPath: alias,
    }),
    undefined,
  );
  const hard = join(f.directory, "owned-session-plan-agent-hard.md");
  await link(path, hard);
  assert.equal(
    await access.extraPathAdmission({ operation: "Edit", requestedPath: hard }),
    undefined,
  );
  await rm(hard);
  assert.equal(
    await access.extraPathAdmission({
      operation: "Write",
      requestedPath: path,
    }),
    path,
  );
  const moved = join(f.root, "old-plans"),
    replacement = join(f.root, "new-plans");
  await mkdir(replacement);
  await rename(f.directory, moved);
  await symlink(replacement, f.directory);
  assert.equal(
    await access.extraPathAdmission({
      operation: "Write",
      requestedPath: path,
    }),
    undefined,
  );
});

test("plan directory vetting can refuse admission and cancellation cannot become a path grant", async () => {
  const f = await fixture({ mode: "plan" }),
    path = planPathOf(f.runtime);
  const refused = createPlanFileAccess({
    cwd: f.cwd,
    files: f.files,
    sessionId: () => "owned-session",
    vetDirectory: () => false,
  });
  assert.equal(
    await refused.extraPathAdmission({
      operation: "Write",
      requestedPath: path,
    }),
    undefined,
  );
  const controller = new AbortController();
  const cancelled = createPlanFileAccess({
    cwd: f.cwd,
    files: f.files,
    sessionId: () => "owned-session",
    vetDirectory: () => {
      controller.abort(new Error("owned path cancellation"));
      return false;
    },
  });
  await assert.rejects(
    cancelled.extraPathAdmission({
      operation: "Write",
      requestedPath: path,
      signal: controller.signal,
    }),
    /owned path cancellation/,
  );
});

test("coherent Enter, external plan Write/Read/Edit and Exit uses real builtin validation and approval", async () => {
  const f = await fixture(),
    access = f.access(),
    readState = new ReadState(),
    fileApprovals: string[] = [];
  const base = () => {
    const configuration: Parameters<typeof createTools>[0] & typeof access = {
      cwd: f.cwd,
      mode: toolMode(f.state.mode),
      readState,
      policy: toolPolicySchema.parse({}),
      ...access,
      approve: async (description) => {
        fileApprovals.push(description);
        return true;
      },
    };
    return createTools(configuration);
  };
  const tools = f.wrap(base);
  assert.equal(
    (await tools.execute(call("EnterPlanMode"), signal())).is_error,
    undefined,
  );
  const path = planPathOf(f.runtime);
  assert.equal(
    (
      await tools.execute(
        call("Write", { file_path: path, content: "first owned plan\n" }),
        signal(),
      )
    ).is_error,
    undefined,
  );
  assert.equal(
    (await tools.execute(call("Read", { file_path: path }), signal())).is_error,
    undefined,
  );
  assert.equal(
    (
      await tools.execute(
        call("Edit", {
          file_path: path,
          old_string: "first",
          new_string: "final",
        }),
        signal(),
      )
    ).is_error,
    undefined,
  );
  const result = await tools.execute(call("ExitPlanMode"), signal());
  assert.equal(result.is_error, undefined);
  assert.equal(f.state.mode, "default");
  assert.match(result.content, /final owned plan/);
  assert.deepEqual(fileApprovals, []);
  assert.equal(
    f.events.filter((event) => event === "approve:ExitPlanMode").length,
    1,
  );
  assert.equal(await readFile(path, "utf8"), "final owned plan\n");
});

test("coherent builtin plan exception retains explicit asks and rejects unrelated external writes", async () => {
  const f = await fixture({ mode: "plan" }),
    path = planPathOf(f.runtime),
    access = f.access(),
    asks: string[] = [];
  const configuration: Parameters<typeof createTools>[0] & typeof access = {
    cwd: f.cwd,
    mode: "plan",
    policy: toolPolicySchema.parse({ askedTools: ["Write"] }),
    ...access,
    approve: async (description) => {
      asks.push(description);
      return true;
    },
  };
  const tools = createTools(configuration);
  assert.equal(
    (
      await tools.execute(
        call("Write", { file_path: path, content: "owned" }),
        signal(),
      )
    ).is_error,
    undefined,
  );
  assert.equal(asks.length, 1);
  const denied = await tools.execute(
    call("Write", {
      file_path: join(f.directory, "unrelated.md"),
      content: "never",
    }),
    signal(),
  );
  assert.equal(denied.permissionDenied, true);
  await assert.rejects(readFile(join(f.directory, "unrelated.md")), {
    code: "ENOENT",
  });
});

test("coherent sensitive plan exception follows Read validation and preserves ask/deny under bypass", async () => {
  const f = await fixture(),
    directory = join(f.cwd, ".claude", "skills", "plans");
  await mkdir(directory, { recursive: true });
  const files = new PlanFileManager({
    directory,
    createSlug: () => "owned-sensitive-plan",
  });
  const path = files.path("owned-session");
  await writeFile(path, "first plan");
  const access = createPlanFileAccess({
      cwd: f.cwd,
      files,
      sessionId: () => "owned-session",
    }),
    state = new ReadState(),
    asks: string[] = [];
  const tools = createTools({
    cwd: f.cwd,
    mode: "plan",
    ...access,
    readState: state,
    hooks: f.hooks,
    approve: async (description) => {
      asks.push(description);
      return true;
    },
  });
  const unread = await tools.execute(
    call("Write", { file_path: path, content: "no read" }),
    signal(),
  );
  assert.equal(unread.inputRejected, true);
  assert.deepEqual(f.events, []);
  assert.equal(asks.length, 0);
  assert.equal(
    (await tools.execute(call("Read", { file_path: path }), signal())).is_error,
    undefined,
  );
  assert.equal(
    (
      await tools.execute(
        call("Edit", {
          file_path: path,
          old_string: "first",
          new_string: "final",
        }),
        signal(),
      )
    ).is_error,
    undefined,
  );
  assert.equal(
    asks.length,
    0,
    "the session plan allow precedes the ordinary .claude directory hold",
  );
  f.setPre({ ...emptyPre(), permission: "allow" });
  f.events.length = 0;
  const asked = createTools({
    cwd: f.cwd,
    mode: "bypassPermissions",
    ...access,
    hooks: f.hooks,
    policy: toolPolicySchema.parse({ askedTools: ["Write"] }),
    approve: async (description) => {
      asks.push(description);
      return true;
    },
  });
  const agentPath = join(directory, "owned-sensitive-plan-agent-asked.md");
  assert.equal(
    (
      await asked.execute(
        call("Write", { file_path: agentPath, content: "asked" }),
        signal(),
      )
    ).is_error,
    undefined,
  );
  assert.equal(asks.length, 1);
  f.events.length = 0;
  const denied = createTools({
    cwd: f.cwd,
    mode: "bypassPermissions",
    ...access,
    hooks: f.hooks,
    policy: toolPolicySchema.parse({ disallowedTools: ["Write"] }),
    approve: async () => true,
  });
  assert.equal(
    (
      await denied.execute(
        call("Write", {
          file_path: join(directory, "owned-sensitive-plan-agent-denied.md"),
          content: "never",
        }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  assert.deepEqual(f.events, []);
  const readDenied = createTools({
    cwd: f.cwd,
    mode: "bypassPermissions",
    ...access,
    hooks: f.hooks,
    policy: toolPolicySchema.parse({
      sourcedRules: [
        { source: "userSettings", behavior: "deny", rule: "Read" },
      ],
    }),
    approve: async () => true,
  });
  assert.equal(
    (
      await readDenied.execute(
        call("Write", {
          file_path: join(
            directory,
            "owned-sensitive-plan-agent-read-denied.md",
          ),
          content: "never",
        }),
        signal(),
      )
    ).permissionDenied,
    true,
  );
  assert.deepEqual(f.events, []);
});

test("actual plan submission failures invoke failure hooks after validation and retain plan mode", async () => {
  const f = await fixture({ mode: "plan" });
  const runtime = new PlanRuntime({
    files: f.files,
    sessionId: () => "owned-session",
    actor: () => ({
      agentId: "child",
      teammate: { requiresApproval: true, taskAvailable: true },
    }),
    permissions: () => f.state,
    setPermissions: (update) => f.setState(update(f.state)),
    canRequestApproval: () => true,
    approve: async () => ({ approved: true }),
    storage: {
      read: async () => "owned child plan",
      save: async (path) => ({ savedPath: path }),
    },
    submitLeaderPlan: async () => {
      throw new Error("owned inbox unavailable");
    },
  });
  const result = await wrapPlanRuntime(emptyBase, {
    ...f.options,
    runtime,
  }).execute(call("ExitPlanMode"), signal());
  assert.equal(result.is_error, true);
  assert.match(result.content, /owned inbox unavailable/);
  assert.equal(f.state.mode, "plan");
  assert.deepEqual(hookTexts(result.hookAttachments), [
    "owned failure feedback",
  ]);
  assert.deepEqual(f.events, [
    "pre:ExitPlanMode",
    "policy:ExitPlanMode:none",
    "failure:ExitPlanMode",
  ]);
});
