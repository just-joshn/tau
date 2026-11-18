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
import { dirname, join } from "node:path";
import { onTestFinished, test } from "bun:test";
import {
  createLaunchPlanHost,
  type SavedPlanState,
} from "../../src/plan-launch.js";
import type { PlanApproval } from "../../src/plan-runtime.js";
import type {
  PreToolHookResult,
  ToolHookRuntime,
} from "../../src/tool-hook-runtime.js";
import { toolPolicySchema } from "../../src/tool-policy.js";
import type { PermissionMode, ToolExecutor, ToolUse } from "../../src/types.js";

const signal = () => new AbortController().signal;
const call = (name: string): ToolUse => ({
  type: "tool_use",
  id: `call-${name}`,
  name,
  input: {},
});
const base: ToolExecutor = {
  definitions: [],
  execute: async () => assert.fail("ordinary tools must not run"),
};

async function launch(
  options: {
    mode?: PermissionMode;
    saved?: SavedPlanState;
    configuredDirectory?: string;
    policy?: Parameters<typeof toolPolicySchema.parse>[0];
    pre?: Partial<PreToolHookResult>;
    requestApproval?: (call: ToolUse) => Promise<PlanApproval>;
    hasTaskTool?: () => boolean;
    onDiagnostic?: (message: string) => void;
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-plan-launch-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const userConfigDir = join(root, "user");
  await mkdir(cwd);
  let mode: PermissionMode = options.mode ?? "default";
  let saved = options.saved;
  const saves: SavedPlanState[] = [];
  const prompts: string[] = [];
  const hooks: ToolHookRuntime = {
    async before() {
      return {
        additionalContext: [],
        preventContinuation: false,
        ...options.pre,
      };
    },
    async after(_call, result) {
      return result;
    },
  };
  const host = createLaunchPlanHost({
    cwd,
    userConfigDir,
    ...(options.configuredDirectory === undefined
      ? {}
      : { configuredDirectory: options.configuredDirectory }),
    sessionId: () => "s1",
    saved: () => saved,
    save: (state) => {
      saved = state;
      saves.push(state);
    },
    mode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    policy: () => toolPolicySchema.parse(options.policy ?? {}),
    canRequestApproval: () => true,
    approve: async (description) => {
      prompts.push(description);
      return true;
    },
    hooks,
    ...(options.requestApproval
      ? { requestApproval: options.requestApproval }
      : {}),
    ...(options.hasTaskTool ? { hasTaskTool: options.hasTaskTool } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  const tools = host.wrap(base, []);
  return {
    cwd,
    userConfigDir,
    host,
    tools,
    saves,
    prompts,
    mode: () => mode,
    saved: () => saved,
    planPath: () => host.files.path("s1"),
    run: (name: string) => tools.execute(call(name), signal()),
  };
}

test("a non-plan launch records that a saved plan session is no longer active", async () => {
  const { saves, host } = await launch({
    mode: "acceptEdits",
    saved: { active: true, slug: "plan-s1", prePlanMode: "default" },
  });
  assert.deepEqual(saves[0], {
    active: false,
    slug: "plan-s1",
    prePlanMode: "default",
  });
  assert.equal(host.location(), undefined);
});

test("a configured plan directory inside the workspace holds the plan", async () => {
  const { cwd, host } = await launch({
    mode: "plan",
    configuredDirectory: "docs/plans",
  });
  assert.equal(host.location(), join(cwd, "docs", "plans", "plan-s1.md"));
});

test("configured plan directories under .git, node_modules or .tau fall back to the user plans directory", async () => {
  for (const configuredDirectory of [
    ".git/plans",
    "node_modules/plans",
    ".tau/plans",
  ]) {
    const { userConfigDir, host } = await launch({
      mode: "plan",
      configuredDirectory,
    });
    assert.equal(host.location(), join(userConfigDir, "plans", "plan-s1.md"));
  }
});

test("plan storage reads and saves only the designated session plan file", async () => {
  const { cwd, host, planPath } = await launch({ mode: "plan" });
  const path = planPath();
  const elsewhere = join(cwd, "notes.md");
  await assert.rejects(
    host.storage.read(elsewhere, signal()),
    /designated plan path is unavailable/,
  );
  await assert.rejects(
    host.storage.save(elsewhere, "x", signal()),
    /designated plan path is unavailable/,
  );
  assert.equal(await host.storage.read(path, signal()), null);
  assert.deepEqual(await host.storage.save(path, "# Plan\n", signal()), {
    savedPath: path,
  });
  assert.equal(await readFile(path, "utf8"), "# Plan\n");
  assert.equal(await host.storage.read(path, signal()), "# Plan\n");
  assert.deepEqual(await host.storage.save(path, "# Plan v2\n", signal()), {
    savedPath: path,
  });
  assert.equal(await host.storage.read(path, signal()), "# Plan v2\n");
});

test("plan permission updates reject modes the CLI cannot run and drop unsupported pre-plan modes", async () => {
  const { host, mode, saved } = await launch({ mode: "plan" });
  assert.throws(
    () => host.setPermissions((state) => ({ ...state, mode: "auto" })),
    /Unsupported CLI plan permission mode: auto/,
  );
  assert.equal(mode(), "plan");
  host.setPermissions(() => ({
    mode: "bypassPermissions",
    prePlanMode: "auto",
  }));
  assert.equal(mode(), "bypassPermissions");
  assert.deepEqual(saved(), { active: false });
});

test("headless plan exits ask with the plan text when a plan file exists", async () => {
  const empty = await launch({
    mode: "plan",
    saved: { active: true, prePlanMode: "acceptEdits" },
  });
  const bare = await empty.host.runtime.execute(call("ExitPlanMode"), signal());
  assert.equal(bare.result.content, "Leaving plan mode was approved.");
  assert.deepEqual(empty.prompts, ["Approve ExitPlanMode?"]);
  assert.equal(empty.mode(), "acceptEdits");

  const written = await launch({ mode: "plan", hasTaskTool: () => true });
  await mkdir(dirname(written.planPath()), { recursive: true });
  await writeFile(written.planPath(), "Step 1\n");
  const approved = await written.host.runtime.execute(
    call("ExitPlanMode"),
    signal(),
  );
  assert.deepEqual(written.prompts, [
    "Plan:\nStep 1\n\n\nApprove ExitPlanMode?",
  ]);
  assert.equal(approved.result.content, "Plan approved.\n\nStep 1\n");
  assert.equal(
    typeof approved.data === "object" && "hasTaskTool" in approved.data
      ? approved.data.hasTaskTool
      : undefined,
    true,
  );
});

test("an ask rule or ask hook makes plan entry prompt before switching modes", async () => {
  const ruled = await launch({ policy: { askedTools: ["EnterPlanMode"] } });
  assert.equal(
    (await ruled.run("EnterPlanMode")).content,
    "Plan mode is active.",
  );
  assert.deepEqual(ruled.prompts, ["Approve EnterPlanMode?"]);
  assert.equal(ruled.mode(), "plan");

  const hooked = await launch({ pre: { permission: "ask" } });
  assert.equal(
    (await hooked.run("EnterPlanMode")).content,
    "Plan mode is active.",
  );
  assert.deepEqual(hooked.prompts, ["Approve EnterPlanMode?"]);

  const plain = await launch();
  await plain.run("EnterPlanMode");
  assert.deepEqual(plain.prompts, []);
  assert.equal(plain.mode(), "plan");
});

test("a denied plan tool is hidden and refused without changing mode", async () => {
  const { tools, run, mode } = await launch({
    policy: { disallowedTools: ["EnterPlanMode"] },
  });
  assert.deepEqual(
    tools.definitions.map((tool) => tool.name),
    ["ExitPlanMode"],
  );
  const result = await run("EnterPlanMode");
  assert.equal(result.permissionDenied, true);
  assert.equal(mode(), "default");
});

test("the wrapped exit prompts with the plan, or delegates to the host approval bridge", async () => {
  const prompted = await launch({ mode: "plan" });
  await mkdir(dirname(prompted.planPath()), { recursive: true });
  await writeFile(prompted.planPath(), "Ship it\n");
  assert.equal(
    (await prompted.run("ExitPlanMode")).content,
    "Plan approved.\n\nShip it\n",
  );
  assert.deepEqual(prompted.prompts, [
    "Plan:\nShip it\n\n\nApprove ExitPlanMode?",
  ]);
  assert.equal(prompted.mode(), "default");

  const bridged: string[] = [];
  const bridge = await launch({
    mode: "plan",
    requestApproval: async (planCall) => {
      bridged.push(planCall.name);
      return { approved: false, reason: "not yet" };
    },
  });
  const declined = await bridge.run("ExitPlanMode");
  assert.equal(declined.content, "not yet");
  assert.equal(declined.permissionDenied, true);
  assert.deepEqual(bridged, ["ExitPlanMode"]);
  assert.deepEqual(bridge.prompts, []);
  assert.equal(bridge.mode(), "plan");
});

test("exit notices about an unavailable pre-plan mode reach the diagnostic sink", async () => {
  const diagnostics: string[] = [];
  const { run, mode } = await launch({
    mode: "plan",
    saved: {
      active: true,
      prePlanMode: "bypassPermissions",
      bypassAvailable: false,
    },
    onDiagnostic: (message) => diagnostics.push(message),
  });
  await run("ExitPlanMode");
  assert.equal(mode(), "default");
  assert.deepEqual(diagnostics, [
    "Restoring bypassPermissions is unavailable; using default permissions",
  ]);
});
