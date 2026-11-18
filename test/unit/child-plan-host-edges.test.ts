import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import {
  createChildPlanHost,
  type ChildPlanHostOptions,
} from "../../src/child-plan-host.js";
import {
  PlanFileManager,
  type PlanPermissionState,
} from "../../src/plan-runtime.js";
import type { ToolPolicy } from "../../src/tool-policy.js";
import type { ToolExecutor, ToolResult, ToolUse } from "../../src/types.js";

const signal = () => new AbortController().signal;
const call = (name = "ExitPlanMode", input: unknown = {}): ToolUse => ({
  type: "tool_use",
  id: "child-plan-call",
  name,
  input,
});
const base: ToolExecutor = {
  definitions: [],
  async execute(tool) {
    return { type: "tool_result", tool_use_id: tool.id, content: "base" };
  },
};
const data = (result: ToolResult) =>
  z.record(z.string(), z.unknown()).parse(result.hookResponse);

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-child-plan-edges-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"),
    plans = join(root, "plans");
  await mkdir(cwd);
  await mkdir(plans);
  let state: PlanPermissionState = { mode: "plan", prePlanMode: "acceptEdits" },
    policy: ToolPolicy = { allowedTools: [], disallowedTools: [] };
  const notices: string[] = [];
  const options: ChildPlanHostOptions = {
    cwd,
    sessionId: () => "session",
    actor: { agentId: "agent" },
    isAsync: false,
    fileBacked: true,
    files: new PlanFileManager({ directory: plans, createSlug: () => "slug" }),
    permissions: () => state,
    setSessionPermissions(update) {
      state = update(state);
    },
    storage: {
      async read(_path, _signal, context) {
        return readFile(context.canonicalPath, "utf8").catch(() => null);
      },
      async save(path, text, _signal, context) {
        await writeFile(context.canonicalPath, text);
        return { savedPath: path };
      },
    },
    enabled: () => true,
    policy: () => policy,
    canRequestApproval: () => true,
    authorize: () => ({ behavior: "allow" }),
    approve: async () => ({ approved: true }),
    hooks: {
      before: async () => ({
        additionalContext: [],
        preventContinuation: false,
      }),
      after: async (_call, result) => result,
    },
    vetDirectory: (canonical) => canonical === plans,
    onExecution(execution) {
      notices.push(...execution.notices);
    },
  };
  const host = (overrides: Partial<ChildPlanHostOptions> = {}) =>
    createChildPlanHost({ ...options, ...overrides });
  return {
    cwd,
    host,
    notices,
    state: () => state,
    setState(value: PlanPermissionState) {
      state = value;
    },
    setPolicy(value: ToolPolicy) {
      policy = value;
    },
    async writePlan(text: string) {
      const target = host().location();
      assert.ok(target);
      await writeFile(target, text);
      return target;
    },
  };
}

test("a relative workspace is refused", async () => {
  const f = await fixture();
  assert.throws(() => f.host({ cwd: "workspace" }), /must be absolute/);
});

test("a Doc plan attached after creation stops the child's exit and plan file access", async () => {
  const f = await fixture();
  const host = f.host(),
    target = host.location();
  assert.ok(target);
  f.setState({ mode: "plan", planDoc: { id: "doc" } });
  const result = await host.wrap(base).execute(call(), signal());
  assert.equal(result.permissionDenied, true);
  await assert.rejects(
    host.fileAccess.extraPathAdmission({
      operation: "Write",
      requestedPath: target,
      signal: signal(),
    }),
    /Doc plans require a separate child approval adapter/,
  );
});

test("an explicit parent tool list admits or excludes ExitPlanMode", async () => {
  const f = await fixture();
  await f.writePlan("plan text");
  f.setPolicy({
    allowedTools: [],
    disallowedTools: [],
    tools: ["Read"],
  });
  const excluded = await f.host().wrap(base).execute(call(), signal());
  assert.equal(excluded.is_error, true);
  assert.equal(f.state().mode, "plan");
  f.setPolicy({
    allowedTools: [],
    disallowedTools: [],
    tools: ["Read", "ExitPlanMode"],
  });
  const admitted = await f.host().wrap(base).execute(call(), signal());
  assert.equal(admitted.is_error, undefined);
  assert.equal(data(admitted).plan, "plan text");
  assert.equal(f.state().mode, "acceptEdits");
});

test("a save without a confirmed path keeps the plan but reports no file", async () => {
  const f = await fixture();
  await f.writePlan("draft");
  const result = await f
    .host({
      storage: {
        read: async () => "stored plan",
        save: async () => ({}),
      },
    })
    .wrap(base)
    .execute(call("ExitPlanMode", { plan: "approved plan" }), signal());
  assert.equal(result.is_error, undefined);
  assert.equal(data(result).filePath, undefined);
});

test("a host restore veto and transition effects shape the restored mode", async () => {
  const f = await fixture();
  await f.writePlan("plan text");
  const restored: string[] = [];
  const result = await f
    .host({
      canRestoreMode(mode) {
        restored.push(mode);
        return { allowed: false, reason: "host keeps edits off" };
      },
      prepareTransition: (state, transition) => ({
        ...state,
        isBypassPermissionsModeAvailable: transition.to === "default",
      }),
    })
    .wrap(base)
    .execute(call(), signal());
  assert.equal(result.is_error, undefined);
  assert.deepEqual(restored, ["acceptEdits"]);
  assert.ok(f.notices.includes("host keeps edits off"));
  assert.equal(f.state().mode, "default");
  assert.equal(f.state().isBypassPermissionsModeAvailable, true);
});

test("a parent denial installed during authorization denies the exit", async () => {
  const f = await fixture();
  await f.writePlan("plan text");
  const result = await f
    .host({
      authorize: () => {
        f.setPolicy({ allowedTools: [], disallowedTools: ["ExitPlanMode"] });
        return { behavior: "allow" };
      },
    })
    .wrap(base)
    .execute(call(), signal());
  assert.equal(result.permissionDenied, true);
  assert.equal(f.state().mode, "plan");
});

test("an authorization decision outside allow, ask and deny fails the exit", async () => {
  const f = await fixture();
  await f.writePlan("plan text");
  const result = await f
    .host({
      authorize: () => {
        const decision = { behavior: "allow" as const };
        Object.defineProperty(decision, "behavior", { value: "maybe" });
        return decision;
      },
    })
    .wrap(base)
    .execute(call(), signal());
  assert.equal(result.is_error, true);
  assert.match(result.content, /Invalid child plan authorization decision/);
  assert.equal(f.state().mode, "plan");
});

test("EnterPlanMode is refused as denied when the host disables it", async () => {
  const f = await fixture();
  const result = await f
    .host({ enabled: (name) => name !== "EnterPlanMode" })
    .wrap(base)
    .execute(call("EnterPlanMode"), signal());
  assert.equal(result.permissionDenied, true);
  assert.equal(result.content, "Child plan entry tool is excluded or denied");
});
