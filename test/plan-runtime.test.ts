import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  PlanRuntime,
  PlanFileManager,
  selectPlanDirectory,
  validPlanSlug,
  type PlanActor,
  type PlanApproval,
  type PlanPermissionState,
  type PlanSaveResult,
  type PlanToolPermission,
} from "../src/plan-runtime.js";
import type { ToolUse } from "../src/types.js";

const tool = (name: string, input: unknown = {}): ToolUse => ({
  type: "tool_use",
  id: "owned-plan",
  name,
  input,
});
const enter = () => tool("EnterPlanMode"),
  exit = (input: unknown = {}) => tool("ExitPlanMode", input);
const signal = () => new AbortController().signal;
async function fixture(
  t: any,
  initial: PlanPermissionState = { mode: "default" },
) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "tau-plan-runtime-")),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, "plans");
  await mkdir(directory);
  const files = new PlanFileManager({
    directory,
    createSlug: () => "owned-plan",
  });
  let state = initial,
    actor: PlanActor = {},
    bridge = true,
    sessionId = "one",
    writes = 0;
  let approval = async (
    _request: PlanToolPermission,
    _signal: AbortSignal,
  ): Promise<PlanApproval> => ({ approved: true });
  let save = async (
    path: string,
    text: string,
    active: AbortSignal,
  ): Promise<PlanSaveResult> => {
    active.throwIfAborted();
    writes++;
    await writeFile(path, text);
    return { savedPath: path };
  };
  const asks: PlanToolPermission[] = [];
  const options: ConstructorParameters<typeof PlanRuntime>[0] = {
    sessionId: () => sessionId,
    actor: () => actor,
    permissions: () => state,
    setPermissions: (update) => {
      state = update(state);
    },
    files,
    storage: {
      read: async (path, active) => {
        active.throwIfAborted();
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      save: (...args) => save(...args),
    },
    canRequestApproval: () => bridge,
    approve: async (request, active) => {
      asks.push(request);
      return approval(request, active);
    },
  };
  return {
    cwd,
    directory,
    files,
    options,
    runtime: new PlanRuntime(options),
    asks,
    get state() {
      return state;
    },
    get writes() {
      return writes;
    },
    stateTo: (value: PlanPermissionState) => {
      state = value;
    },
    actorTo: (value: PlanActor) => {
      actor = value;
    },
    bridgeTo: (value: boolean) => {
      bridge = value;
    },
    sessionTo: (value: string) => {
      sessionId = value;
    },
    approveWith: (value: typeof approval) => {
      approval = value;
    },
    saveWith: (value: typeof save) => {
      save = value;
    },
  };
}

test("ordinary entry saves prior permissions, clears stale Doc state and repeated entry is idempotent", async (t) => {
  const f = await fixture(t, {
    mode: "acceptEdits",
    planDoc: { id: "stale" },
    marker: "keep",
  });
  const result = await f.runtime.execute(enter(), signal());
  assert.deepEqual(result.transition, {
    from: "acceptEdits",
    to: "plan",
    reason: "enter_plan_mode",
  });
  assert.deepEqual(f.state, {
    mode: "plan",
    prePlanMode: "acceptEdits",
    marker: "keep",
  });
  assert.equal(f.asks.length, 0);
  assert.equal(
    f.files.peekSlug("one"),
    undefined,
    "entry itself does not allocate the reminder's path",
  );
  assert.equal(
    f.runtime.planLocation("owned query"),
    join(f.directory, "owned-plan.md"),
  );
  const again = await f.runtime.execute(enter(), signal());
  assert.equal(again.transition, undefined);
  assert.equal(f.state.prePlanMode, "acceptEdits");
});

test("agent entry, built-in fork exit and exit outside plan reject before approval", async (t) => {
  const f = await fixture(t);
  f.actorTo({ agentId: "child" });
  await assert.rejects(
    f.runtime.execute(enter(), signal()),
    /Only the main session/,
  );
  f.stateTo({ mode: "plan" });
  f.actorTo({ agentId: "child", builtInFork: true });
  await assert.rejects(f.runtime.execute(exit(), signal()), /fork must report/);
  f.actorTo({});
  f.stateTo({ mode: "default" });
  await assert.rejects(
    f.runtime.execute(exit(), signal()),
    /Enter plan mode before/,
  );
  assert.equal(f.asks.length, 0);
  assert.equal(f.writes, 0);
});

test("headless without a prompt bridge and deny-instead sessions do not advertise plan tools", async (t) => {
  const f = await fixture(t);
  f.bridgeTo(false);
  assert.deepEqual(f.runtime.definitions, []);
  await assert.rejects(f.runtime.execute(enter(), signal()), /unavailable/);
  f.bridgeTo(true);
  assert.equal(f.runtime.definitions.length, 2);
  assert.deepEqual(
    new PlanRuntime({ ...f.options, denyInsteadOfPrompting: true }).definitions,
    [],
  );
  assert.deepEqual(
    new PlanRuntime({ ...f.options, fileBacked: false }).definitions,
    [],
    "Doc/diskless sessions are not guessed",
  );
});

test("declining or cancelling plan approval preserves mode and the plan file", async (t) => {
  const f = await fixture(t, { mode: "plan", prePlanMode: "acceptEdits" });
  const path = f.runtime.planLocation()!;
  await writeFile(path, "owned plan\n");
  f.approveWith(async () => ({ approved: false, reason: "revise the scope" }));
  await assert.rejects(f.runtime.execute(exit(), signal()), /revise the scope/);
  assert.equal(f.state.mode, "plan");
  assert.equal(f.writes, 0);
  assert.equal(await readFile(path, "utf8"), "owned plan\n");
  const controller = new AbortController();
  f.approveWith(async () => {
    controller.abort(new Error("owned approval cancellation"));
    return { approved: true };
  });
  await assert.rejects(
    f.runtime.execute(exit(), controller.signal),
    /owned approval cancellation/,
  );
  assert.equal(f.state.mode, "plan");
  assert.equal(f.writes, 0);
});

test("disk plan replaces model-supplied approval text and host-approved edits are saved", async (t) => {
  const f = await fixture(t, { mode: "plan", prePlanMode: "acceptEdits" });
  const path = f.runtime.planLocation()!;
  await writeFile(path, "owned disk plan");
  const original = exit({
    plan: "counterfeit model plan",
    planFilePath: "/outside/fake.md",
  });
  f.approveWith(async (request) => {
    assert.equal(request.plan, "owned disk plan");
    assert.equal(request.filePath, path);
    return { approved: true, updatedInput: { plan: "approved edit" } };
  });
  const completed = await f.runtime.execute(original, signal());
  assert.equal(await readFile(path, "utf8"), "approved edit");
  assert.equal(f.state.mode, "acceptEdits");
  assert.deepEqual(original.input, {
    plan: "counterfeit model plan",
    planFilePath: "/outside/fake.md",
  });
  assert.deepEqual(completed.data, {
    plan: "approved edit",
    isAgent: false,
    filePath: path,
    planWasEdited: true,
  });
  assert.deepEqual(completed.result.hookResponse, completed.data);
  assert.match(completed.result.content, /approved edit/);
});

test("missing or empty main-session plan can be approved and repeated exit is rejected", async (t) => {
  const f = await fixture(t, { mode: "plan" });
  const missing = await f.runtime.execute(exit(), signal());
  assert.equal(missing.data.plan, null);
  assert.equal(f.state.mode, "default");
  assert.equal(f.writes, 0);
  await assert.rejects(
    f.runtime.execute(exit(), signal()),
    /Enter plan mode before/,
  );
  await f.runtime.execute(enter(), signal());
  await writeFile(f.runtime.planLocation()!, "");
  const empty = await f.runtime.execute(exit(), signal());
  assert.equal(empty.data.plan, "");
  assert.equal(f.state.mode, "default");
});

test("a plan created while approval waits is read during the approved call if no snapshot was injected", async (t) => {
  const f = await fixture(t, { mode: "plan" });
  const path = f.runtime.planLocation()!;
  f.approveWith(async (request) => {
    assert.equal(request.plan, null);
    await writeFile(path, "created during approval");
    return { approved: true };
  });
  const result = await f.runtime.execute(exit(), signal());
  assert.equal(result.data.plan, "created during approval");
  assert.equal(f.writes, 0);
});

test("restoration respects unavailable auto/bypass modes and host transition effects", async (t) => {
  const f = await fixture(t, {
    mode: "plan",
    prePlanMode: "bypassPermissions",
  });
  const blocked = await f.runtime.execute(exit(), signal());
  assert.equal(f.state.mode, "default");
  assert.equal(blocked.notices.length, 1);
  f.stateTo({
    mode: "plan",
    prePlanMode: "bypassPermissions",
    isBypassPermissionsModeAvailable: true,
  });
  await f.runtime.execute(exit(), signal());
  assert.equal(f.state.mode, "bypassPermissions");
  f.stateTo({ mode: "plan", prePlanMode: "auto", planEnteredBy: "model" });
  await f.runtime.execute(exit(), signal());
  assert.equal(f.state.mode, "default");
  const controlled = new PlanRuntime({
    ...f.options,
    canRestoreMode: () => true,
    prepareTransition: (state, transition) => ({
      ...state,
      effect: transition.reason,
    }),
  });
  f.stateTo({ mode: "auto" });
  await controlled.execute(enter(), signal());
  assert.equal(f.state.planEnteredBy, "model");
  assert.equal(f.state.prePlanMode, "auto");
  await controlled.execute(exit(), signal());
  assert.equal(f.state.mode, "auto");
  assert.equal(f.state.planEnteredBy, undefined);
  assert.equal(f.state.prePlanMode, undefined);
  assert.equal(f.state.effect, "exit_plan_mode");
});

test("permission state already changed by the approval host is preserved", async (t) => {
  const f = await fixture(t, { mode: "plan", prePlanMode: "default" });
  f.approveWith(async () => {
    f.stateTo({ mode: "acceptEdits", marker: "UI decision" });
    return { approved: true };
  });
  const result = await f.runtime.execute(exit(), signal());
  assert.equal(result.transition, undefined);
  assert.deepEqual(f.state, { mode: "acceptEdits", marker: "UI decision" });
});

test("ordinary agent exits use agent filenames while teammate submission leaves approval pending", async (t) => {
  const f = await fixture(t, { mode: "plan", prePlanMode: "default" });
  f.actorTo({ agentId: "agent-one" });
  const path = f.runtime.planLocation()!;
  assert.equal(path, join(f.directory, "owned-plan-agent-agent-one.md"));
  await writeFile(path, "owned child plan");
  const result = await f.runtime.execute(exit(), signal());
  assert.equal(result.data.isAgent, true);
  assert.equal(result.data.filePath, path);
  assert.equal(f.state.mode, "default");
  f.stateTo({ mode: "plan" });
  f.actorTo({
    agentId: "agent-one",
    teammate: { requiresApproval: true, taskAvailable: true },
  });
  const team = new PlanRuntime({
    ...f.options,
    submitLeaderPlan: async (request) => {
      assert.equal(request.plan, "owned child plan");
      return { requestId: "owned-request" };
    },
  });
  const before = f.asks.length,
    pending = await team.execute(exit(), signal());
  assert.equal(
    f.asks.length,
    before,
    "team submission does not prompt the local user",
  );
  assert.equal(f.state.mode, "plan");
  assert.equal(pending.data.awaitingLeaderApproval, true);
  assert.equal(pending.data.requestId, "owned-request");
  f.actorTo({
    agentId: "agent-one",
    teammate: { requiresApproval: true, taskAvailable: false },
  });
  await assert.rejects(team.execute(exit(), signal()), /task is unavailable/);
  f.actorTo({
    agentId: "empty",
    teammate: { requiresApproval: true, taskAvailable: true },
  });
  await assert.rejects(team.execute(exit(), signal()), /Write a plan file/);
});

test("storage failure retains approved text and fallback storage updates the designated path", async (t) => {
  const f = await fixture(t, { mode: "plan" });
  const originalPath = f.runtime.planLocation()!;
  await writeFile(originalPath, "owned approved text");
  f.saveWith(async () => {
    throw new Error("owned storage failure");
  });
  const failed = await f.runtime.execute(exit(), signal());
  assert.equal(f.state.mode, "default");
  assert.equal(failed.data.filePath, undefined);
  assert.equal(failed.data.plan, "owned approved text");
  assert.deepEqual(failed.notices, ["owned storage failure"]);
  f.stateTo({ mode: "plan" });
  const fallbackDir = join(f.cwd, "fallback");
  await mkdir(fallbackDir);
  const fallback = join(fallbackDir, "fallback-plan.md");
  f.saveWith(async (_path, text) => {
    await writeFile(fallback, text);
    return { savedPath: fallback, notice: "moved to fallback" };
  });
  const moved = await f.runtime.execute(exit(), signal());
  assert.equal(moved.data.filePath, fallback);
  assert.equal(f.files.path("one"), fallback);
  assert.equal(f.runtime.isSessionPlanPath(originalPath), false);
  assert.equal(f.runtime.isSessionPlanPath(fallback), true);
});

test("slug reservation and session plan family matching reject unrelated paths and unsafe names", () => {
  const seen: Array<{ sessionId: string; seed?: string; attempt: number }> = [];
  const files = new PlanFileManager({
    directory: "/owned/plans",
    knownNames: ["occupied.md"],
    createSlug: (context) => {
      seen.push(context);
      return context.attempt < 2 ? "occupied" : "available";
    },
  });
  assert.equal(
    files.path("one", undefined, "owned seed"),
    "/owned/plans/available.md",
  );
  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.seed, "owned seed");
  assert.equal(
    files.path("one", "child"),
    "/owned/plans/available-agent-child.md",
  );
  assert.equal(seen.length, 3);
  for (const name of [
    "available.md",
    "available-agent-child.md",
    "available-agent-.md",
  ])
    assert.equal(files.isSessionPlanPath("one", `/owned/plans/${name}`), true);
  for (const path of [
    "/owned/plans/other.md",
    "/owned/plans/nested/available.md",
    "/owned/available.md",
    "/owned/plans/available.md.bak",
  ])
    assert.equal(files.isSessionPlanPath("one", path), false);
  assert.equal(
    files.isSessionPlanPath("two", "/owned/plans/available.md"),
    false,
  );
  assert.throws(() => files.path("one", "../escape"), /Invalid agent id/);
  for (const bad of [
    "../escape",
    "CON",
    "con",
    "aux",
    "lpt1",
    "uppercase-Name",
    "x".repeat(101),
  ]) {
    assert.equal(validPlanSlug(bad), false);
    assert.equal(files.restore("one", bad), false);
  }
  const colliding = new PlanFileManager({
    directory: "/owned/plans",
    knownNames: ["same.md"],
    createSlug: () => "same",
  });
  assert.equal(
    colliding.path("one"),
    "/owned/plans/same.md",
    "bounded source reservation keeps the final candidate after ten collisions",
  );
});
test("configured plan directories require project containment and explicit real-path vetting", async (t) => {
  const f = await fixture(t),
    outside = join(f.cwd, "outside"),
    project = join(f.cwd, "project");
  await mkdir(outside);
  await mkdir(project);
  await mkdir(join(project, "safe"));
  await symlink(outside, join(project, "unsafe"));
  const canonicalProject = await realpath(project),
    canonical = new Map<string, string>();
  for (const child of ["safe", "unsafe"])
    canonical.set(join(project, child), await realpath(join(project, child)));
  const choose = (configuredDirectory: string) =>
    selectPlanDirectory({
      projectRoot: project,
      defaultDirectory: f.directory,
      configuredDirectory,
      vet: (candidate) => {
        const rel = relative(canonicalProject, canonical.get(candidate)!);
        return rel !== ".." && !rel.startsWith(`..${sep}`);
      },
    });
  assert.equal(choose("safe"), join(project, "safe"));
  assert.equal(choose("unsafe"), f.directory);
  assert.equal(choose("../outside"), f.directory);
  assert.equal(
    selectPlanDirectory({
      projectRoot: project,
      defaultDirectory: f.directory,
      configuredDirectory: "safe",
      vet: () => {
        throw new Error("unknown");
      },
    }),
    f.directory,
  );
});

test("prepared calls stay bound to their runtime and session", async (t) => {
  const f = await fixture(t),
    prepared = await f.runtime.prepare(enter(), signal());
  assert.throws(
    () => new PlanRuntime(f.options).checkPermissions(prepared),
    /does not belong/,
  );
  f.sessionTo("other");
  await assert.rejects(f.runtime.call(prepared, signal()), /active session/);
  assert.equal(f.state.mode, "default");
});

test("deprecated allowed prompts never grant commands and exit approval remains required", async (t) => {
  const f = await fixture(t, {
    mode: "plan",
    prePlanMode: "bypassPermissions",
    isBypassPermissionsModeAvailable: true,
  });
  const completed = await f.runtime.execute(
    exit({
      allowedPrompts: [{ tool: "Bash", prompt: "owned arbitrary command" }],
    }),
    signal(),
  );
  assert.equal(f.asks.length, 1);
  assert.equal(f.asks[0]?.behavior, "ask");
  assert.equal(f.state.mode, "bypassPermissions");
  assert.equal(f.state.allowedPrompts, undefined);
  assert.equal(completed.data.allowedPrompts, undefined);
});

test("session change during approved persistence cannot transition another session", async (t) => {
  const f = await fixture(t, { mode: "plan", prePlanMode: "acceptEdits" });
  const path = f.runtime.planLocation()!;
  await writeFile(path, "owned plan");
  f.saveWith(async (ownedPath) => {
    f.sessionTo("other");
    return { savedPath: ownedPath };
  });
  await assert.rejects(f.runtime.execute(exit(), signal()), /active session/);
  assert.equal(f.state.mode, "plan");
  assert.equal(f.files.peekSlug("other"), undefined);
});
