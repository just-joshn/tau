import { test, onTestFinished } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadLaunchConfiguration } from "../../src/launch-configuration.js";
import { parseOptions } from "../../src/options.js";
import type { ToolPolicy } from "../../src/tool-policy.js";
import {
  createFilePermissionSession,
  filePermissionRootsFromLaunch,
  type FileRuleAdmission,
  type FilePermissionSessionProfile,
} from "../../src/file-permission-session.js";

async function fixture(settings?: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-file-permission-session-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"),
    user = join(root, "user"),
    managed = join(root, "managed");
  for (const path of [cwd, user, managed]) await mkdir(path);
  const launch = await loadLaunchConfiguration(
    { ...parseOptions([]), ...(settings === undefined ? {} : { settings }) },
    {
      cwd,
      env: { CLAUDE_CONFIG_DIR: user, TAU_MANAGED_ROOT: managed },
      homeDirectory: root,
      nonInteractive: true,
    },
  );
  let policy: ToolPolicy = {
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: launch.snapshot.permissionRules.map((rule) => ({ ...rule })),
  };
  const profile: FilePermissionSessionProfile = {
    kind: "ordinary-local-posix",
    mode: "default",
    restricted: false,
    servedCall: false,
  };
  let admission: Parameters<
    typeof createFilePermissionSession
  >[0]["admitRule"] = () => ({ status: "admit" });
  const session = createFilePermissionSession({
    launch,
    launchRoot: cwd,
    cwd: () => cwd,
    policy: () => policy,
    profile: () => profile,
    admitRule: (rule, facts) => admission(rule, facts),
    relativeRoots: { kind: "live-cwd" },
    physicalTwinsEnabled: true,
    fixedRootsBeforeRelative: true,
    trustedAlias: (value) => value,
    admitPath: (value) =>
      value === root ||
      value.startsWith(`${root}/`) ||
      root.startsWith(`${value}/`),
  });
  const evaluate = (
    operation: "Read" | "Write" | "Edit",
    file: string,
    canonicalPath = file,
  ) =>
    session.evaluate({
      operation,
      requestedPath: file,
      canonicalPath,
      signal: new AbortController().signal,
    });
  return {
    root,
    cwd,
    user,
    launch,
    session,
    evaluate,
    policy: () => policy,
    setPolicy: (value: ToolPolicy) => {
      policy = value;
    },
    admit: (value: typeof admission) => {
      admission = value;
    },
    profile,
  };
}
async function file(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "owned fixture\n");
}
function sourced(
  rule: string,
  behavior: "deny" | "ask" | "allow",
  source = "session",
) {
  return { rule, behavior, source };
}

test("actual launch flag document anchors slash patterns to its own directory and retains path metadata", async () => {
  const f = await fixture();
  const flag = join(f.root, "flags/settings.json");
  await file(flag);
  await writeFile(
    flag,
    JSON.stringify({ permissions: { allow: ["Edit(/out/**)"] } }),
  );
  const launch = await loadLaunchConfiguration(
    { ...parseOptions([]), settings: flag },
    {
      cwd: f.cwd,
      env: {
        CLAUDE_CONFIG_DIR: f.user,
        TAU_MANAGED_ROOT: join(f.root, "managed"),
      },
      homeDirectory: f.root,
      nonInteractive: true,
    },
  );
  const policy: ToolPolicy = {
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: launch.snapshot.permissionRules.map((rule) => ({ ...rule })),
  };
  const session = createFilePermissionSession({
    launch,
    launchRoot: f.cwd,
    cwd: () => f.cwd,
    policy: () => policy,
    profile: () => f.profile,
    admitRule: () => ({ status: "admit" }),
    relativeRoots: { kind: "live-cwd" },
    physicalTwinsEnabled: true,
    fixedRootsBeforeRelative: true,
    trustedAlias: (value) => value,
  });
  const target = join(dirname(flag), "out/new.txt");
  const result = session.evaluate({
    operation: "Write",
    requestedPath: target,
    canonicalPath: target,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "classified");
  assert.equal(result.allow?.source, "flagSettings");
  assert.equal(result.allow?.path, flag);
  assert.equal(
    session.evaluate({
      operation: "Write",
      requestedPath: join(f.cwd, "out/new.txt"),
      canonicalPath: join(f.cwd, "out/new.txt"),
      signal: new AbortController().signal,
    }).allow,
    undefined,
  );
});
test("settings source roots never substitute project/local/managed document storage for native config context", async () => {
  const f = await fixture('{"permissions":{"deny":["Read(/private/**)"]}}');
  const roots = filePermissionRootsFromLaunch(f.launch, f.cwd);
  assert.equal(roots.settingsContextCwd, f.cwd);
  assert.equal(roots.userConfigDir, f.user);
  f.setPolicy({
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: [
      {
        ...sourced("Read(/private/**)", "deny", "projectSettings"),
        path: join(f.root, "foreign-store/settings.json"),
      },
    ],
  });
  assert.equal(
    f.evaluate("Read", join(f.cwd, "private/a.txt")).deny?.source,
    "projectSettings",
  );
  assert.equal(
    f.evaluate("Read", join(f.root, "foreign-store/private/a.txt")).deny,
    undefined,
  );
  f.setPolicy({
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: [sourced("Read(/private/**)", "deny", "userSettings")],
  });
  assert.equal(
    f.evaluate("Read", join(f.user, "private/a.txt")).deny?.source,
    "userSettings",
  );
});
test("live policy changes refresh compilation without resurrecting removed launch grants", async () => {
  const f = await fixture('{"permissions":{"allow":["Edit(/out/**)"]}}');
  const path = join(f.cwd, "out/new.txt");
  const initial = f.evaluate("Write", path);
  assert.equal(initial.allow?.source, "flagSettings");
  assert.equal(f.evaluate("Write", path).generation, initial.generation);
  f.policy().sourcedRules?.push(sourced("Edit(out/**)", "deny"));
  const changed = f.evaluate("Write", path);
  assert.equal(changed.deny?.source, "session");
  assert.ok(changed.generation > initial.generation);
  f.setPolicy({ allowedTools: [], disallowedTools: [] });
  const removed = f.evaluate("Write", path);
  assert.equal(removed.allow, undefined);
  assert.equal(removed.deny, undefined);
  assert.ok(removed.generation > changed.generation);
});
test("Write/Edit consume Edit content while Edit deny and ask remain separate from Read restrictions", async () => {
  const f = await fixture();
  const target = join(f.cwd, "owned.txt");
  await file(target);
  f.setPolicy({
    allowedTools: ["Write(owned.txt)"],
    disallowedTools: [],
    sourcedRules: [
      sourced("Edit(owned.txt)", "allow"),
      sourced("Edit(owned.txt)", "deny"),
      sourced("Edit(owned.txt)", "ask"),
    ],
  });
  for (const operation of ["Write", "Edit"]) {
    const result = f.evaluate(operation === "Write" ? "Write" : "Edit", target);
    assert.equal(result.allow?.family, "Edit");
    assert.equal(result.ask?.family, "Edit");
    assert.equal(result.deny?.family, "Edit");
    assert.ok(
      result.diagnostics.some((value) => value.includes("Write path rule")),
    );
  }
  const read = f.evaluate("Read", target);
  assert.equal(read.deny, undefined);
  assert.equal(read.ask, undefined);
  assert.equal(read.allow, undefined);
  assert.equal(read.editImplication?.deny?.family, "Edit");
  assert.equal(read.editImplication?.ask?.family, "Edit");
  assert.equal(read.editImplication?.allow?.family, "Edit");
});
test("effective rewritten path and canonical identity are checked every call, with no cached path verdict", async () => {
  const f = await fixture();
  const original = join(f.cwd, "original.txt"),
    rewritten = join(f.cwd, "rewritten.txt");
  await file(original);
  await file(rewritten);
  f.setPolicy({
    allowedTools: ["Read(original.txt)"],
    disallowedTools: ["Read(rewritten.txt)"],
  });
  assert.equal(f.evaluate("Read", original).allow?.rule, "Read(original.txt)");
  assert.equal(f.evaluate("Read", rewritten).deny?.rule, "Read(rewritten.txt)");
  const stale = f.evaluate("Read", rewritten, original);
  assert.equal(stale.status, "unsupported");
  assert.ok(
    stale.unsupported.some((value) => value.includes("canonical identity")),
  );
  assert.ok(stale.deny);
});
test("source collection order matches JSe and preserves all simultaneous candidates without authorizing", async () => {
  const f = await fixture();
  const target = join(f.cwd, "same.txt");
  f.setPolicy({
    allowedTools: ["Read(same.txt)"],
    disallowedTools: ["Read(same.txt)"],
    askedTools: ["Read(same.txt)"],
    sourcedRules: [
      sourced("Read(same.txt)", "deny", "session"),
      sourced("Read(same.txt)", "deny", "projectSettings"),
    ],
  });
  const result = f.evaluate("Read", target);
  assert.equal(result.deny?.source, "session");
  assert.equal(result.ask?.source, "cliArg");
  assert.equal(result.allow?.source, "cliArg");
  assert.equal(Reflect.get(result, "approved"), undefined);
});
test("required mode/provenance admission excludes grants but refuses silently dropped restrictive rules", async () => {
  const f = await fixture();
  const target = join(f.cwd, "a.txt");
  f.setPolicy({ allowedTools: ["Edit(a.txt)"], disallowedTools: [] });
  f.admit(() => ({
    status: "exclude",
    reason: "Source H excluded this grant in current mode",
  }));
  const excluded = f.evaluate("Write", target);
  assert.equal(excluded.status, "classified");
  assert.equal(excluded.allow, undefined);
  f.policy().disallowedTools.push("Edit(a.txt)");
  const restricted = f.evaluate("Write", target);
  assert.equal(restricted.status, "unsupported");
  assert.ok(
    restricted.unsupported.some((value) => value.includes("restrictive")),
  );
  f.admit((_rule, profile): FileRuleAdmission =>
    profile.mode === "unknown"
      ? { status: "unsupported", reason: "Unresolved mode admission" }
      : { status: "admit" },
  );
  f.profile.mode = "unknown";
  assert.ok(
    f
      .evaluate("Write", target)
      .unsupported.includes("Unresolved mode admission"),
  );
});
test("unrecognized provenance is explicit and whole-tool/malformed rules are not generic path wildcards", async () => {
  const f = await fixture();
  const target = join(f.cwd, "a.txt");
  f.setPolicy({
    allowedTools: ["Read", "Read(*)", "Read(broken"],
    disallowedTools: [],
    sourcedRules: [sourced("Read(a.txt)", "allow", "inventedOrigin")],
  });
  const result = f.evaluate("Read", target);
  assert.equal(result.status, "unsupported");
  assert.equal(result.allow, undefined);
  assert.ok(
    result.diagnostics.some((value) => value.includes("literal-name fallback")),
  );
  assert.ok(result.unsupported.some((value) => value.includes("provenance")));
});
test("actual symlink permission uses deny-any and allow-all spellings", async () => {
  const f = await fixture();
  const physical = join(f.root, "physical/data.txt"),
    alias = join(f.cwd, "alias");
  await file(physical);
  await symlink(dirname(physical), alias);
  f.setPolicy({
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: [
      sourced("Read(/alias/**)", "allow", "projectSettings"),
      sourced(`Read(/${physical})`, "deny"),
    ],
  });
  const result = f.evaluate("Read", join(alias, "data.txt"), physical);
  assert.equal(result.status, "classified");
  assert.equal(result.allow, undefined);
  assert.equal(result.deny?.source, "session");
  assert.equal(result.inspection.spellings.length, 2);
});
test("session physical twin history survives explicit recompilation and symlink retarget", async () => {
  const f = await fixture();
  const first = join(f.cwd, "first/data.txt"),
    second = join(f.cwd, "second/data.txt"),
    link = join(f.cwd, "alias");
  await file(first);
  await file(second);
  await symlink(dirname(first), link);
  f.setPolicy({
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: [sourced("Read(/alias/**)", "deny", "projectSettings")],
  });
  assert.ok(f.evaluate("Read", first).deny);
  await unlink(link);
  await symlink(dirname(second), link);
  f.session.invalidate();
  assert.ok(f.evaluate("Read", second).deny);
  assert.ok(f.evaluate("Read", first).deny);
});
test("missing file paths can match before a later file I/O failure and cancellation propagates", async () => {
  const f = await fixture();
  const missing = join(f.cwd, "missing.txt");
  f.setPolicy({ allowedTools: ["Read(missing.txt)"], disallowedTools: [] });
  const result = f.evaluate("Read", missing);
  assert.equal(result.status, "classified");
  assert.ok(result.allow);
  assert.equal(result.inspection.status, "resolved");
  const controller = new AbortController();
  controller.abort(new Error("owned cancellation"));
  assert.throws(
    () =>
      f.session.evaluate({
        operation: "Read",
        requestedPath: missing,
        canonicalPath: missing,
        signal: controller.signal,
      }),
    /owned cancellation/,
  );
});

test("Gitignore-invalid grants drop while restrictive comment-shaped patterns match literal owned filenames", async () => {
  const f = await fixture();
  const target = join(f.cwd, "#owned");
  await file(target);
  f.setPolicy({
    allowedTools: ["Read(#owned)"],
    disallowedTools: ["Read(#owned)"],
  });
  const result = f.evaluate("Read", target);
  assert.equal(result.status, "classified");
  assert.equal(result.allow, undefined);
  assert.equal(result.deny?.rule, "Read(#owned)");
  assert.ok(
    result.diagnostics.some((value) => value.includes("Unusable grant")),
  );
  assert.ok(result.diagnostics.some((value) => value.includes("literalized")));
});

test("unresolved host inspection cannot grant but retains a known lexical deny", async () => {
  const f = await fixture();
  const target = join(f.cwd, "owned.txt");
  const session = createFilePermissionSession({
    launch: f.launch,
    launchRoot: f.cwd,
    cwd: () => f.cwd,
    policy: () => ({
      allowedTools: ["Read(owned.txt)"],
      disallowedTools: ["Read(owned.txt)"],
    }),
    profile: () => f.profile,
    admitRule: () => ({ status: "admit" }),
    relativeRoots: { kind: "live-cwd" },
    physicalTwinsEnabled: true,
    fixedRootsBeforeRelative: false,
    trustedAlias: (value) => value,
    admitPath: () => "Owned host withheld metadata inspection",
  });
  const result = session.evaluate({
    operation: "Read",
    requestedPath: target,
    canonicalPath: target,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.inspection.status, "unresolved");
  assert.equal(result.deny?.rule, "Read(owned.txt)");
  assert.equal(result.allow, undefined);
});

test("host-selected extra roots affect relative restrictions without extending grants", async () => {
  const f = await fixture();
  const additional = join(f.root, "additional");
  const target = join(additional, "private/owned.txt");
  await file(target);
  const calls: string[] = [];
  const session = createFilePermissionSession({
    launch: f.launch,
    launchRoot: f.cwd,
    cwd: () => f.cwd,
    policy: () => ({
      allowedTools: ["Read(private/**)"],
      disallowedTools: ["Read(private/**)"],
    }),
    profile: () => f.profile,
    admitRule: () => ({ status: "admit" }),
    relativeRoots: {
      kind: "host",
      resolve: (_path, behavior) => {
        calls.push(behavior);
        return [f.cwd, additional];
      },
    },
    physicalTwinsEnabled: true,
    fixedRootsBeforeRelative: false,
    trustedAlias: (value) => value,
  });
  const result = session.evaluate({
    operation: "Read",
    requestedPath: target,
    canonicalPath: target,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "classified");
  assert.equal(result.deny?.rule, "Read(private/**)");
  assert.equal(result.allow, undefined);
  assert.ok(calls.includes("deny"));
  assert.equal(calls.includes("allow"), false);
});
