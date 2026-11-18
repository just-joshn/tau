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
import { join } from "node:path";
import { onTestFinished, test } from "bun:test";
import { loadLaunchConfiguration } from "../src/launch-configuration.js";
import { parseOptions } from "../src/options.js";
import { createLaunchScopedPermissionHost } from "../src/scoped-permission-launch.js";
import {
  combineToolPolicy,
  parseToolPolicy,
  type ToolPolicy,
} from "../src/tool-policy.js";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";
import type { PermissionMode } from "../src/types.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-scoped-permissions-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"),
    config = join(root, "config");
  await mkdir(cwd);
  await mkdir(config);
  const launch = await loadLaunchConfiguration(parseOptions([]), {
    cwd,
    homeDirectory: root,
    nonInteractive: true,
    env: { CLAUDE_CONFIG_DIR: config, TAU_MANAGED_ROOT: join(root, "managed") },
  });
  const owner = createLaunchScopedPermissionHost({ cwd, launch, env: {} });
  let policy: ToolPolicy = parseToolPolicy({}),
    mode: PermissionMode = "default";
  const approvals: string[] = [];
  const readState = new ReadState();
  const access = owner.scope({ policy: () => policy, mode: () => mode });
  const tools = () =>
    createTools({
      cwd,
      mode,
      policy,
      readState,
      ...access,
      approve: async (description) => {
        approvals.push(description);
        return false;
      },
    });
  const run = (name: string, input: Record<string, unknown>) =>
    tools().execute(
      { type: "tool_use", id: "owned-scoped", name, input },
      new AbortController().signal,
    );
  return {
    root,
    cwd,
    launch,
    owner,
    access,
    run,
    tools,
    approvals,
    policy: (value: ToolPolicy) => {
      policy = value;
    },
    mode: (value: PermissionMode) => {
      mode = value;
    },
  };
}

test("scoped Edit grants Write only at the selected path; whole Edit and Write(path) do not", async () => {
  const f = await fixture();
  f.policy(parseToolPolicy({ allowedTools: ["Edit(/out/**)"] }));
  assert.equal(
    (await f.run("Write", { file_path: "out/yes.txt", content: "SCOPED" }))
      .is_error,
    undefined,
  );
  assert.equal(await readFile(join(f.cwd, "out/yes.txt"), "utf8"), "SCOPED");
  for (const allowedTools of [
    ["Edit"],
    ["Write(/out/**)"],
    ["Edit(/else/**)"],
  ]) {
    f.policy(parseToolPolicy({ allowedTools }));
    assert.equal(
      (await f.run("Write", { file_path: "out/no.txt", content: "NO" }))
        .is_error,
      true,
    );
  }
  await assert.rejects(readFile(join(f.cwd, "out/no.txt")), { code: "ENOENT" });
  assert.equal(f.approvals.length, 3);
});

test("scoped restrictions and primitive arguments retain priority over grants and read defaults", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "secret.txt"), "PRIVATE");
  f.policy(
    combineToolPolicy(parseToolPolicy({ allowedTools: ["Write", "Bash"] }), [
      {
        source: "projectSettings",
        behavior: "deny",
        rule: "Read(/secret.txt)",
      },
      { source: "policySettings", behavior: "ask", rule: "Edit(/asked.txt)" },
      {
        source: "flagSettings",
        behavior: "deny",
        rule: "Bash(command:printf blocked)",
      },
    ]),
  );
  assert.equal(
    (await f.run("Read", { file_path: "secret.txt" })).is_error,
    true,
  );
  assert.equal(
    (await f.run("Write", { file_path: "asked.txt", content: "NO" })).is_error,
    true,
  );
  assert.equal(
    (await f.run("Bash", { command: "printf blocked" })).is_error,
    true,
  );
  assert.equal(f.approvals.length, 1);
});

test("source roots, live child scopes, and compatibility grants keep independent provenance", async () => {
  const f = await fixture();
  const flag = join(f.root, "flag/settings.json");
  await mkdir(join(f.root, "flag"));
  await writeFile(flag, "{}");
  // Flag slash rules are rooted at the flag document, rather than launch cwd.
  const launch = await loadLaunchConfiguration(
    parseOptions(["--settings", flag]),
    {
      cwd: f.cwd,
      homeDirectory: f.root,
      nonInteractive: true,
      env: {
        CLAUDE_CONFIG_DIR: join(f.root, "config"),
        TAU_MANAGED_ROOT: join(f.root, "managed"),
      },
    },
  );
  const owner = createLaunchScopedPermissionHost({
    cwd: f.cwd,
    launch,
    env: {},
  });
  const parentPolicy = combineToolPolicy(parseToolPolicy({}), [
    {
      source: "flagSettings",
      path: flag,
      behavior: "allow",
      rule: "Edit(/out/**)",
    },
  ]);
  const parent = owner.scope({
    policy: () => parentPolicy,
    mode: () => "default",
  });
  const child = owner.scope({
    policy: () => parseToolPolicy({ allowedTools: ["Write(*)"] }),
    mode: () => "default",
  });
  const evaluate = (scope: typeof parent, file: string) =>
    scope.filePermissionCandidates({
      operation: "Write",
      requestedPath: file,
      canonicalPath: file,
      signal: new AbortController().signal,
    });
  assert.equal(evaluate(parent, join(f.cwd, "out/a"))?.allow, undefined);
  assert.equal(
    evaluate(parent, join(f.root, "flag/out/a"))?.allow?.source,
    "flagSettings",
  );
  assert.equal(
    evaluate(child, join(f.cwd, "out/a"))?.compatibilityAllow?.rule,
    "Write(*)",
  );
  assert.equal(
    evaluate(child, join(f.root, "flag/out/a"))?.compatibilityAllow,
    undefined,
  );
  assert.equal(
    evaluate(parent, join(f.cwd, "out/a"))?.compatibilityAllow,
    undefined,
  );
});

test("scoped file grants preserve Plan, sensitive paths, and canonical filesystem boundaries", async () => {
  const f = await fixture();
  f.policy(parseToolPolicy({ allowedTools: ["Edit(**)", "Write(*)"] }));
  f.mode("plan");
  assert.equal(
    (await f.run("Write", { file_path: "plan-held", content: "NO" })).is_error,
    true,
  );
  f.mode("default");
  assert.equal(
    (
      await f.run("Write", {
        file_path: ".claude/settings.json",
        content: "NO",
      })
    ).is_error,
    true,
  );
  await writeFile(join(f.root, "outside"), "OUTSIDE");
  await symlink(f.root, join(f.cwd, "escape"));
  assert.equal(
    (await f.run("Write", { file_path: "escape/outside", content: "NO" }))
      .is_error,
    true,
  );
  assert.equal(await readFile(join(f.root, "outside"), "utf8"), "OUTSIDE");
});

test("simple Bash scope grants, prefix restrictions, asks, and unknown shell forms retain their stages", async () => {
  const f = await fixture();
  f.policy(
    combineToolPolicy(parseToolPolicy({ allowedTools: ["Bash(printf:*)"] }), [
      {
        source: "policySettings",
        behavior: "deny",
        rule: "Bash(printf blocked:*)",
      },
      { source: "userSettings", behavior: "ask", rule: "Bash(printf asked)" },
    ]),
  );
  const allowed = await f.run("Bash", { command: "printf owned" });
  assert.equal(allowed.is_error, undefined, String(allowed.content));
  assert.match(String(allowed.content), /owned/);
  for (const command of [
    "printf blocked now",
    "printf asked",
    "printf first; printf second",
    "env printf wrapped",
  ])
    assert.equal((await f.run("Bash", { command })).is_error, true, command);
  assert.equal(f.approvals.length, 1);
});

test("missing native rule consumers fail at construction rather than ignoring scoped restrictions", async () => {
  const f = await fixture();
  for (const rule of ["Read(/private/**)", "Edit(/out/**)", "Bash(printf:*)"])
    assert.throws(
      () =>
        createTools({
          cwd: f.cwd,
          mode: "default",
          policy: parseToolPolicy({ disallowedTools: [rule] }),
          approve: async () => true,
        }),
      /require/,
    );
});

test("Bash empty/star call forms retain ordinary bare-tool semantics outside the finite file compatibility set", async () => {
  const f = await fixture();
  for (const rule of ["Bash()", "Bash(*)"]) {
    const tools = createTools({
      cwd: f.cwd,
      mode: "default",
      policy: parseToolPolicy({ allowedTools: [rule] }),
      approve: async () => false,
    });
    const result = await tools.execute(
      {
        type: "tool_use",
        id: "bare-bash",
        name: "Bash",
        input: { command: "printf owned-wildcard" },
      },
      new AbortController().signal,
    );
    assert.equal(result.is_error, undefined, String(result.content));
    f.policy(parseToolPolicy({ allowedTools: [rule] }));
    assert.equal(
      (await f.run("Bash", { command: "printf scoped-owner-wildcard" }))
        .is_error,
      undefined,
    );
  }
  assert.deepEqual(f.approvals, []);
});

test("a new scoped Read deny also blocks post-compaction file restoration", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "context.txt"), "RETAINED_FILE_SECRET");
  assert.equal(
    (await f.run("Read", { file_path: "context.txt" })).is_error,
    undefined,
  );
  f.policy(parseToolPolicy({ disallowedTools: ["Read(/context.txt)"] }));
  const prepared = await f.tools().prepareCompaction?.({
    keptMessages: [],
    signal: new AbortController().signal,
  });
  assert.ok(prepared);
  assert.deepEqual(prepared.messages, []);
  prepared.commit();
});

test("nested Git configuration roots do not replace ordinary native permission session anchors", async () => {
  const f = await fixture();
  const owner = createLaunchScopedPermissionHost({
    cwd: f.cwd,
    env: {},
    launch: {
      ...f.launch,
      workspace: { ...f.launch.workspace, gitRoot: f.root },
    },
  });
  let policy = parseToolPolicy({ disallowedTools: ["Read(context.txt)"] });
  const access = owner.scope({ policy: () => policy, mode: () => "default" });
  const evaluate = () =>
    access.filePermissionCandidates({
      operation: "Read",
      requestedPath: join(f.cwd, "context.txt"),
      canonicalPath: join(f.cwd, "context.txt"),
      signal: new AbortController().signal,
    });
  assert.equal(evaluate()?.status, "classified");
  assert.equal(evaluate()?.deny?.rule, "Read(context.txt)");
  policy = parseToolPolicy({ disallowedTools: ["Read(/context.txt)"] });
  assert.equal(evaluate()?.deny?.rule, "Read(/context.txt)");
});
