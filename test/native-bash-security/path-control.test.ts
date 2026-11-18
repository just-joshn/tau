import { test, expect } from "bun:test";
import { posix } from "node:path";
import { createNativeBashCommandPreparation } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPathControl,
  type NativeBashSecurityPathHost,
} from "../../src/native-bash-security/path-control.js";
import { fixture, policy, known } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityPolicy as Policy,
} from "../../src/native-bash-security/security-types.js";
function owner(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const host: NativeBashSecurityPathHost = {
    ...f.host,
    protectedRoots: (s) => known([], s),
    workingDirectories: (_p, s) => known(["/work"], s),
    suggestionDirectory: (path, s) => known(posix.dirname(path), s),
    readDirectorySuggestion: (path, destination, s) =>
      known(
        {
          type: "addRules",
          rules: [{ toolName: "Read", ruleContent: path + "/**" }],
          behavior: "allow",
          destination,
        },
        s,
      ),
    feature: (_key, _default, s) =>
      known({ value: true, source: "virtual-test" }, s),
    mountedDriveRmPromptDisabled: (s) => known(false, s),
  };
  const controller = createNativeBashSecurityPathControl(
    f.semantic,
    preparation,
    host,
  );
  async function run(
    command: string,
    p: Policy = policy(),
    cwdChanging = false,
  ) {
    const r = await f.semantic.analyze(command);
    if (r.kind !== "simple") throw new Error(r.reason);
    return controller.withPolicyScope(p, "/work", () =>
      controller.native.mD(
        { command },
        "/work",
        p,
        cwdChanging,
        r.commands.flatMap((c) => c.redirects),
        r.commands,
        undefined,
      ),
    );
  }
  return { ...f, host, controller, preparation, run };
}
test("scoped Read deny remains after semantic command extraction and compound wrappers", async () => {
  const f = owner({ deny: "/work/denied" });
  for (const command of [
    "cat denied",
    "time cat denied",
    "env -i cat denied",
    "command -p cat denied",
    "true; cat denied",
  ]) {
    const r = (await f.run(command)).result;
    expect(r.behavior).toBe("deny");
    expect(r.decisionReason?.type).toBe("rule");
  }
});
test("Edit deny defeats default write prompt and redirected writes", async () => {
  const f = owner({ writeDeny: "/work/denied" });
  for (const command of [
    "touch denied",
    "printf x > denied",
    "cp source denied",
  ]) {
    const r = (await f.run(command, policy({ mode: "acceptEdits" }))).result;
    expect(r.behavior).toBe("deny");
    expect(r.decisionReason?.type).toBe("rule");
  }
});
test("default shell writes retain overrideable in-directory refusal and suggestions", async () => {
  const f = owner();
  const r = (await f.run("touch file")).result;
  expect(r.behavior).toBe("ask");
  expect(r.bashAllowRuleOverridable).toBe(true);
  expect(r.blockedPath).toBe("/work/file");
  expect(r.suggestions).toEqual([
    { type: "addDirectories", directories: ["/work"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
});
test("read block continues past output prompt to retain later read denial", async () => {
  const f = owner({ deny: "/outside/secret", outsideBlocked: true });
  const r = (
    await f.run(
      "printf x > local; cat /outside/secret",
      policy({ blockReadsOutsideWorkingDirectories: true }),
    )
  ).result;
  expect(r.behavior).toBe("deny");
  expect(r.decisionReason?.type).toBe("rule");
});
test("native redirection collector preserves input, output, descriptor duplication and dangerous priority", async () => {
  const f = owner();
  const result = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.RSn([
      { op: ">&", target: "2" },
      { op: "<&", target: "0" },
      { op: "<", target: "input" },
      { op: ">&", target: "file" },
      { op: ">>", target: "*.log" },
      { op: "<", target: "/dev/tcp/host/80" },
    ]),
  ).result;
  expect(result).toEqual({
    redirections: [{ target: "file", operator: ">" }],
    inputRedirections: ["input"],
    denyCheckOutputRedirections: [{ target: "*.log", operator: ">>" }],
    hasDangerousRedirection: true,
    dangerousRedirectionReason: "network_device",
  });
});
test("input redirects and link sources carry native Read denial provenance", async () => {
  const f = owner({ deny: "/work/secret" });
  for (const command of [
    "wc < secret",
    "ln secret alias",
    "link secret alias",
  ]) {
    const r = (
      await f.run(
        command,
        policy({ blockReadsOutsideWorkingDirectories: true }),
      )
    ).result;
    expect(r.behavior).toBe("deny");
    expect(r.decisionReason?.type).toBe("rule");
  }
});
test("pushd and env chdir paths are checked under the read block", async () => {
  const f = owner({ deny: "/outside/secret" });
  for (const argv of [
    ["pushd", "/outside/secret"],
    ["env", "-C/outside/secret", "cat", "file"],
    ["env", "--chdir=/outside/secret", "cat", "file"],
  ]) {
    const r = f.controller.withPolicyScope(policy(), "/work", () =>
      f.controller.native.DPr(argv, "/work", policy()),
    ).result;
    expect(r?.behavior).toBe("deny");
  }
});
test("compound cwd dependencies produce separate read/write holds", async () => {
  const f = owner();
  const read = (
    await f.run(
      "cat file",
      policy({ blockReadsOutsideWorkingDirectories: true }),
      true,
    )
  ).result;
  expect(read.behavior).toBe("ask");
  if (read.decisionReason?.type === "safetyCheck")
    expect(read.decisionReason.circuitBreaker).toBe("outsideReadsBlocked");
  else throw new Error("Expected native read hold");
  const write = (
    await f.run("touch file", policy({ mode: "acceptEdits" }), true)
  ).result;
  expect(write.behavior).toBe("ask");
  if (write.decisionReason?.type === "other")
    expect(write.decisionReason.bashMissKind).toBe("cd-compound-write");
  else throw new Error("Expected cwd write hold");
});
test("source safety merge retains primary and secondary circuits without severity sorting", async () => {
  const f = owner();
  const r = f.controller.native.wU(
    {
      behavior: "ask",
      decisionReason: {
        type: "safetyCheck",
        reason: "first",
        classifierApprovable: false,
        circuitBreaker: "outsideReadsBlocked",
        also: ["internalHardDeny"],
      },
    },
    {
      behavior: "ask",
      decisionReason: {
        type: "safetyCheck",
        reason: "second",
        classifierApprovable: false,
        circuitBreaker: "dangerousRemoval",
        also: ["outsideReadsBlocked", "internalHardDeny"],
      },
    },
  );
  expect(r.decisionReason).toEqual({
    type: "safetyCheck",
    reason: "first",
    classifierApprovable: false,
    circuitBreaker: "outsideReadsBlocked",
    also: ["internalHardDeny", "dangerousRemoval"],
  });
});
test("missing factual protected roots never become a successful command path check", async () => {
  const f = owner();
  delete f.host.protectedRoots;
  expect(f.run("rm file")).rejects.toThrow(NativeBashSecurityUnsupported);
  const wrong = owner();
  wrong.host.workingDirectories = () =>
    known(["/work"], { policyId: "stale", cwd: "/work" });
  expect(wrong.run("touch /outside/file")).rejects.toThrow(
    NativeBashSecurityUnsupported,
  );
});
test("argv quoted spaces and Unicode remain exact through all path checks", async () => {
  const f = owner({ deny: "/work/ 雪 " });
  const r = (await f.run("cat ' 雪 '")).result;
  expect(r.behavior).toBe("deny");
  expect(f.calls).toContain("rule:read:deny:/work/ 雪 ");
});
test("unknown-cwd relative deny scanner probes every source rule prefix and preserves matcher identity", () => {
  const f = owner({ deny: "/work/sub/secret" });
  f.host.nativePathSpelling = (path, s) =>
    known(posix.resolve("/work", path.trim()), s);
  f.host.originalWorkingDirectory = (s) => known("/work", s);
  f.host.sourceRuleRoot = (_source, s) => known("/project", s);
  f.host.fileDenyRules = (_family, _policy, s) =>
    known(
      [
        {
          source: "projectSettings",
          ruleBehavior: "deny",
          ruleValue: { toolName: "Read", ruleContent: "sub/secret" },
        },
      ],
      s,
    );
  const r = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.Pti("../secret", policy(), "read"),
  );
  expect(r.result?.ruleValue.toolName).toBe("Read");
  expect(f.calls).toContain("rule:read:deny:/work/secret");
  expect(f.calls).toContain("rule:read:deny:/work/sub/secret");
});
test("raw source file-rule rooting stays separate from prepared matcher validation", () => {
  const f = owner();
  f.host.sourceRuleRoot = (_source, s) => known("/project", s);
  const r = f.controller.withPolicyScope(policy(), "/work", () => ({
    source: f.controller.native.u7e("/sub/file", "projectSettings"),
    absolute: f.controller.native.u7e("//etc/file", "projectSettings"),
    relative: f.controller.native.u7e("./sub//file", "projectSettings"),
    normalized: f.controller.native.$t("\ufeff!sub//file"),
  })).result;
  expect(r).toEqual({
    source: { relativePattern: "/sub/file", root: "/project" },
    absolute: { relativePattern: "/etc/file", root: "/" },
    relative: { relativePattern: "sub//file", root: null },
    normalized: "\\!sub/file",
  });
});
test("dangerous removals retain critical roots, workspace ancestors and multi-level glob causes", () => {
  const f = owner();
  f.host.pathPrimitive = (_kind, path, s) => known(path, s);
  function removal(args: string[], cwd = "/work", changed = false) {
    return f.controller.withPolicyScope(policy(), cwd, () =>
      f.controller.native.o2("rm", args, cwd, policy(), changed),
    ).result;
  }
  const cases: [string[], string][] = [
    [["/"], "root"],
    [["/home/test"], "home"],
    [["/work/repo"], "working_directory"],
    [["scratch/*"], "relative_glob_after_cd"],
    [["/work/scratch/*/*"], "multi_level_glob"],
    [["__TRACKED_VAR__/nix"], "placeholder_root_child"],
    [["\\\\"], "backslash_only"],
  ];
  for (const [args, cause] of cases) {
    const r = removal(
      args,
      cause === "working_directory" ? "/work/repo/sub" : "/work",
      cause === "relative_glob_after_cd",
    );
    expect(r.behavior).toBe("ask");
    if (r.decisionReason?.type === "safetyCheck") {
      expect(r.decisionReason.circuitBreaker).toBe("dangerousRemoval");
      expect(r.decisionReason.removalRule).toBe(cause);
    } else throw new Error("Missing native removal safety");
  }
});
test("mounted-drive candidates wait for later stronger critical removal targets", () => {
  const f = owner();
  f.host.pathPrimitive = (_kind, path, s) => known(path, s);
  const mounted = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.o2(
      "rm",
      ["-rf", "/Volumes/drive/file"],
      "/work",
      policy(),
      false,
    ),
  ).result;
  if (mounted.decisionReason?.type === "safetyCheck")
    expect(mounted.decisionReason.removalRule).toBe("mounted_drive_path");
  else throw new Error("Missing mounted-drive ask");
  const critical = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.o2(
      "rm",
      ["-rf", "/Volumes/drive/file", "/"],
      "/work",
      policy(),
      false,
    ),
  ).result;
  if (critical.decisionReason?.type === "safetyCheck")
    expect(critical.decisionReason.removalRule).toBe("root");
  else throw new Error("Missing critical-root ask");
});
