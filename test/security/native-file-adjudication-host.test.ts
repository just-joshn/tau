import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  adjudicateNativeFileEdit,
  adjudicateNativeFileRead,
  type NativeFileAdjudicationPolicy,
  type NativeFileAdjudicationResult,
} from "../../src/native-file-adjudication.js";
import { nativeLocalPermissionPathFilesystem } from "../../src/native-path-inspection.js";
import {
  parseNativePermissionRule,
  type NativeFileRule,
} from "../../src/native-permission-rules.js";
import type {
  NativePermissionFact,
  NativePermissionOutcome,
  NativePermissionRule,
} from "../../src/native-permission-outcome.js";
import {
  createNativeConcreteFileAdjudicationHost,
  nativeLocalConcreteIdentityReaders,
  nativeSensitiveLexicalPath,
  nativeSuspiciousWindowsPath,
} from "../../src/native-file-adjudication-host.js";
import { nativeLocalAncestryFilesystem } from "../../src/native-path-ancestry.js";
import { nativeLocalPluginDirectoryFilesystem } from "../../src/native-plugin-permission-scan.js";
import type { NativeFileResourceSnapshot } from "../../src/native-file-adjudication-types.js";

type Input = { file_path: string };
test("missing actual rule/settings owners cannot fall through to positive mode or scoped grants", () =>
  fixture(({ work, policy, rules, faults, edit }) => {
    const path = posix.join(work, "positive.md");
    writeFileSync(path, "owned");
    policy.mode = "acceptEdits";
    rules.allow.push(rule("Edit(./positive.md)"));
    faults.rules = {
      status: "unsupported",
      dependency: "actual-rule-owner",
      reason: "Source admission snapshot is unavailable",
    };
    const missingRules = edit(path);
    assert.equal(missingRules.status, "unsupported");
    if (missingRules.status === "unsupported")
      assert.equal(missingRules.dependency, "actual-rule-owner");
    delete faults.rules;
    faults.resources = {
      status: "unsupported",
      dependency: "actual-profile-owner",
      reason: "Actual account/protected file state is unavailable",
    };
    const missingProfile = edit(path);
    assert.equal(missingProfile.status, "unsupported");
    if (missingProfile.status === "unsupported")
      assert.equal(missingProfile.dependency, "actual-profile-owner");
  }));

test("an unknown bypass owner propagates only in the source branch that actually consumes it", () =>
  fixture(({ work, policy, faults, read }) => {
    faults.bypass = {
      status: "unsupported",
      dependency: "actual-bypass-owner",
      reason: "Actual tool bypass availability is unknown",
    };
    const ordinary = posix.join(work, "ordinary.md");
    writeFileSync(ordinary, "owned");
    assert.equal(decided(read(ordinary)).behavior, "allow");
    const missing = read("/net/owned-host/file.md");
    assert.equal(missing.status, "unsupported");
    if (missing.status === "unsupported")
      assert.equal(missing.dependency, "actual-bypass-owner");
    policy.servedCall = true;
    assert.equal(decided(read("/net/owned-host/file.md")).behavior, "ask");
  }));
function receipt<T>(
  value: T,
  policy: NativeFileAdjudicationPolicy,
): NativePermissionFact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-owned-state",
      sourceContracts: ["explicit-owner-snapshot"],
      scope: policy.scope,
    },
  };
}
function decided(
  result: NativeFileAdjudicationResult<Input>,
): NativePermissionOutcome<Input> {
  if (result.status !== "decided")
    throw new Error(result.dependency + ": " + result.reason);
  return result.outcome;
}
function fixture(
  run: (context: {
    root: string;
    work: string;
    outside: string;
    resources: NativeFileResourceSnapshot;
    policy: NativeFileAdjudicationPolicy;
    rules: Record<"allow" | "ask" | "deny", NativeFileRule[]>;
    clock: { now: number };
    faults: {
      resources?: NativePermissionFact<NativeFileResourceSnapshot>;
      rules?: NativePermissionFact<readonly NativeFileRule[]>;
      bypass?: NativePermissionFact<boolean>;
      wholeToolAllow?: NativePermissionFact<NativePermissionRule | null>;
    };
    host: ReturnType<typeof createNativeConcreteFileAdjudicationHost<Input>>;
    read: (path: string) => NativeFileAdjudicationResult<Input>;
    edit: (path: string) => NativeFileAdjudicationResult<Input>;
  }) => void,
  options: { missingWholeToolOwner?: boolean } = {},
) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-native-concrete-")),
  );
  const work = posix.join(root, "work");
  const outside = posix.join(root, "outside");
  const home = posix.join(root, "home");
  const config = posix.join(home, ".claude");
  for (const directory of [work, outside, config])
    mkdirSync(directory, { recursive: true });
  const policy: NativeFileAdjudicationPolicy = {
    scope: { policyId: "owned-native-policy", cwd: work },
    mode: "default",
    restricted: false,
    alwaysAllowRules: {},
    additionalWorkingDirectories: new Map(),
  };
  const resources: NativeFileResourceSnapshot = {
    diskless: false,
    configDirectory: config,
    configHome: config,
    configContextCwd: work,
    originalCwd: work,
    nativeSessionId: "00000000-0000-4000-8000-000000000001",
    aliasTranslationRoots: [work, work, null, null, null, home],
    launchContextRoot: work,
    initialReadRoot: undefined,
    extraWorkingDirectories: [],
    workingDirPathsHeldAsNamed: new Set(),
    blockFileReadProtectedExceptions: false,
    merryBoot: true,
    memory: {
      paused: false,
      canLackFolderAndUnresolved: false,
      autoMemoryRoot: null,
      ownProjectMemoryRoot: null,
      ownProjectMemoryEnabled: false,
      requireExplicitMemoryWrites: false,
      memoryBlockedByReadFence: false,
      agentMemoryRoots: [],
    },
    runtime: {
      plan: null,
      workflowDirectory: null,
      scratchDirectory: null,
      backgroundJobDirectory: null,
      projectStoreDirectory: null,
      originalProjectStoreDirectory: null,
      connectorDownloadDirectory: null,
      toolResultDirectories: [],
      ownSessionDirectory: null,
      taskOutputDirectory: null,
      projectTempPrefix: posix.join(root, "project-temp") + "/",
      earlierToolResultDirectories: [],
      allowEarlierToolResultsForModel: false,
      bundledSkillReferenceDirectory: posix.join(root, "bundled"),
      syncedPluginDirectories: [],
      reservedSkillDirectories: [],
    },
    protected: {
      hostCredentialsPath: null,
      profileStore: null,
      signInFiles: [],
      settingsFiles: [],
      settingsSourcePaths: [],
      flagSettingsPath: null,
      policySettingsPath: null,
      settingsBodyTemplates: [],
      managedSettingsDirectories: [],
    },
    plugins: {
      devModsFollowLinks: false,
      producerRoots: [],
      retainedProducerPaths: [],
      wslProviderUndeterminable: false,
      inlineRoots: [],
      additionalProducerRoot: null,
    },
  };
  const rules: Record<"allow" | "ask" | "deny", NativeFileRule[]> = {
    allow: [],
    ask: [],
    deny: [],
  };
  const clock = { now: 0 };
  const faults: {
    resources?: NativePermissionFact<NativeFileResourceSnapshot>;
    rules?: NativePermissionFact<readonly NativeFileRule[]>;
    bypass?: NativePermissionFact<boolean>;
    wholeToolAllow?: NativePermissionFact<NativePermissionRule | null>;
  } = {};
  const host = createNativeConcreteFileAdjudicationHost<Input>({
    pathContext: {
      cwd: work,
      initialCwd: work,
      home,
      macos: true,
      filesystem: nativeLocalPermissionPathFilesystem,
    },
    readResources: () => faults.resources ?? receipt(resources, policy),
    readRules: (_policy, behavior) =>
      faults.rules ?? receipt(rules[behavior], policy),
    readRuleRoots: () =>
      receipt(
        {
          launchRoot: work,
          settingsContextCwd: work,
          userConfigDir: config,
          flagSettings: { kind: "absent" },
        },
        policy,
      ),
    relativeRuleRoots: () => receipt([work], policy),
    physicalRuleTwins: true,
    fixedRuleRootsBeforeRelative: true,
    trustedAlias: (path) => path,
    identities: nativeLocalConcreteIdentityReaders,
    ancestryFilesystem: nativeLocalAncestryFilesystem,
    pluginDirectoryFilesystem: nativeLocalPluginDirectoryFilesystem,
    now: () => clock.now,
    monotonicNow: () => clock.now,
    capabilities: {
      quotePath: (path) => receipt(JSON.stringify(path), policy),
      readBypassAvailable: () => faults.bypass ?? receipt(false, policy),
      modelReadMode: () => receipt(false, policy),
      servedReadFenceAskStaysDenied: () => receipt(false, policy),
      isAdmittedSkillName: () => receipt(true, policy),
      ...(options.missingWholeToolOwner
        ? {}
        : {
            // This authored world explicitly closes the compatibility feature;
            // ordinary bare/scoped fixture rules are not OLa results.
            wholeToolAllow: () =>
              faults.wholeToolAllow ?? {
                status: "known" as const,
                value: null,
                provenance: {
                  provider: "authored-OLa-owner-with-compatibility-disabled",
                  sourceContracts: ["OLa/Ng/aW/authored-closed-feature"],
                  scope: policy.scope,
                },
              },
          }),
    },
  });
  const read = (path: string) =>
    adjudicateNativeFileRead({
      tool: { name: "Read", getPath: (input: Input) => input.file_path },
      input: { file_path: path },
      policy,
      host,
    });
  const edit = (path: string) =>
    adjudicateNativeFileEdit({
      tool: { name: "Write", getPath: (input: Input) => input.file_path },
      input: { file_path: path },
      policy,
      host,
    });
  try {
    run({
      root,
      work,
      outside,
      resources,
      policy,
      rules,
      clock,
      faults,
      host,
      read,
      edit,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
}
const rule = (raw: string, source = "cliArg"): NativeFileRule => ({
  source,
  rule: parseNativePermissionRule(raw),
});

test("real owned file receives native default Read and acceptEdits Write reasons", () =>
  fixture(({ work, policy, read, edit }) => {
    const path = posix.join(work, "selected.md");
    writeFileSync(path, "owned");
    assert.deepEqual(decided(read(path)).decisionReason, {
      type: "mode",
      mode: "default",
    });
    assert.equal(decided(edit(path)).behavior, "ask");
    policy.mode = "acceptEdits";
    assert.deepEqual(decided(edit(path)).decisionReason, {
      type: "mode",
      mode: "acceptEdits",
    });
  }));

test("scoped deny and ask outrank working roots and mode; Write uses actual scoped Edit carrier", () =>
  fixture(({ work, policy, rules, read, edit }) => {
    const path = posix.join(work, "selected.md");
    writeFileSync(path, "owned");
    policy.mode = "acceptEdits";
    rules.deny.push(rule("Read(./selected.md)"));
    assert.equal(decided(read(path)).behavior, "deny");
    rules.deny.length = 0;
    rules.ask.push(rule("Edit(./selected.md)"));
    const asked = decided(edit(path));
    assert.equal(asked.behavior, "ask");
    assert.equal(asked.decisionReason?.type, "rule");
    rules.ask.length = 0;
    policy.mode = "default";
    rules.allow.push(rule("Edit(./selected.md)", "userSettings"));
    const allowed = decided(edit(path));
    assert.equal(allowed.behavior, "allow");
    assert.equal(allowed.decisionReason?.type, "rule");
  }));

test("outside scoped Read allow is a rule outcome; bare Edit does not authorize a Write tool", () =>
  fixture(({ outside, rules, read, edit }) => {
    const path = posix.join(outside, "selected.md");
    writeFileSync(path, "owned");
    rules.allow.push(rule(`Read(/${path})`, "userSettings"));
    assert.equal(decided(read(path)).behavior, "allow");
    rules.allow.length = 0;
    rules.allow.push(rule("Edit", "cliArg"));
    assert.equal(decided(edit(path)).behavior, "ask");
  }));

test("bare Edit and Write rules cannot replace a missing actual OLa compatibility owner", () =>
  fixture(
    ({ work, rules, policy, host, edit }) => {
      const path = posix.join(work, "inside.md");
      writeFileSync(path, "owned");
      assert.equal(host.wholeToolAllow, undefined);
      for (const text of ["Edit", "Write", "Write(*)"]) {
        rules.allow = [rule(text)];
        const result = edit(path);
        assert.equal(result.status, "unsupported", text);
        if (result.status === "unsupported")
          assert.equal(result.dependency, "OLa");
      }
      // The source's earlier mode branch does not consume OLa.
      policy.mode = "acceptEdits";
      assert.equal(decided(edit(path)).behavior, "allow");
    },
    { missingWholeToolOwner: true },
  ));

test("actual OLa compatibility owner results and provenance reach adjudication unchanged", () =>
  fixture(({ work, policy, faults, host, edit }) => {
    const path = posix.join(work, "inside.md");
    writeFileSync(path, "owned");
    assert.equal(decided(edit(path)).behavior, "ask");
    const actual: NativePermissionFact<NativePermissionRule | null> = {
      status: "known",
      value: {
        source: "cliArg",
        ruleBehavior: "allow",
        ruleValue: { toolName: "Write", ruleContent: "*" },
        original: "Write(*)",
      },
      provenance: {
        provider: "authored-actual-OLa-owner",
        sourceContracts: ["H/Ng/aW/fYr/authored-active-feature"],
        scope: policy.scope,
      },
    };
    faults.wholeToolAllow = actual;
    assert.equal(host.wholeToolAllow?.("Write", policy, policy.scope), actual);
    const result = edit(path);
    if (result.status !== "decided") assert.fail(result.reason);
    assert.equal(result.outcome.behavior, "allow");
    assert.deepEqual(result.outcome.decisionReason, {
      type: "rule",
      rule: actual.value,
    });
    assert.ok(result.facts.includes(actual.provenance));
    faults.wholeToolAllow = {
      ...actual,
      provenance: {
        ...actual.provenance,
        scope: { ...policy.scope, policyId: "foreign-OLa-generation" },
      },
    };
    assert.equal(edit(path).status, "unsupported");
  }));

test("physical alias outside roots asks and an actual physical Read deny is enforced", () =>
  fixture(({ work, outside, rules, read }) => {
    const target = posix.join(outside, "secret.md");
    writeFileSync(target, "owned");
    const link = posix.join(work, "alias.md");
    symlinkSync(target, link);
    rules.allow.push(rule("Read(./alias.md)"));
    const held = decided(read(link));
    assert.equal(held.behavior, "ask");
    assert.equal(held.blockedPath, target);
    rules.deny.push(rule(`Read(/${target})`, "userSettings"));
    const denied = decided(read(link));
    assert.equal(denied.behavior, "deny");
    assert.equal(denied.decisionReason?.type, "rule");
  }));

test("adopted original working root differs from evaluation cwd", () =>
  fixture(({ outside, work, resources, policy, read, edit }) => {
    resources.originalCwd = outside;
    policy.mode = "acceptEdits";
    const launched = posix.join(outside, "native.md");
    writeFileSync(launched, "owned");
    const live = posix.join(work, "current.md");
    writeFileSync(live, "owned");
    assert.equal(decided(read(launched)).behavior, "allow");
    assert.equal(decided(edit(live)).behavior, "ask");
  }));

test("metadata identifies a real sign-in hard link before acceptEdits or a scoped allow", () =>
  fixture(({ work, resources, policy, rules, edit }) => {
    const original = posix.join(resources.configDirectory, "credentials.json");
    writeFileSync(original, "owned-nonsecret");
    const alias = posix.join(work, "ordinary.md");
    linkSync(original, alias);
    resources.protected.signInFiles = [{ kind: "tokens", paths: [original] }];
    policy.mode = "acceptEdits";
    rules.allow.push(rule("Edit(./ordinary.md)"));
    const result = decided(edit(alias));
    assert.equal(result.behavior, "deny");
    assert.equal(result.decisionReason?.type, "safetyCheck");
    assert.match(result.message ?? "", /hard link/);
  }));

test("host credential and managed runtime files retain native hard floors", () =>
  fixture(({ work, resources, policy, edit }) => {
    policy.mode = "acceptEdits";
    const credential = posix.join(work, "host.json");
    writeFileSync(credential, "owned");
    resources.protected.hostCredentialsPath = credential;
    assert.match(decided(edit(credential)).message ?? "", /host credentials/);
    for (const name of [
      "jobs/x/adopt.json",
      "daemon/config",
      "daemon.json",
      "shell-snapshots/s.sh",
      "session-env/s.sh",
    ]) {
      const result = decided(edit(posix.join(resources.configDirectory, name)));
      assert.equal(result.behavior, "deny", name);
      assert.equal(result.decisionReason?.type, "safetyCheck");
    }
  }));

test("paused-memory read/write floors are separate from pinned no-op transcript protection", () =>
  fixture(({ outside, resources, read, edit }) => {
    const root = posix.join(outside, "memory");
    mkdirSync(root);
    const path = posix.join(root, "MEMORY.md");
    writeFileSync(path, "owned");
    resources.memory.autoMemoryRoot = root + "/";
    resources.memory.paused = true;
    assert.equal(decided(read(path)).behavior, "deny");
    assert.equal(decided(edit(path)).behavior, "deny");
    resources.memory.paused = false;
    assert.equal(decided(edit(path)).behavior, "allow");
  }));

test("sensitive settings and suspicious path reasons survive mode permissions", () =>
  fixture(({ work, resources, policy, edit }) => {
    policy.mode = "acceptEdits";
    const settings = posix.join(work, ".claude/settings.json");
    mkdirSync(posix.dirname(settings));
    writeFileSync(settings, "{}");
    resources.protected.settingsFiles = [settings];
    const actual = decided(edit(settings));
    assert.equal(actual.behavior, "ask");
    if (actual.decisionReason?.type === "safetyCheck")
      assert.equal(actual.decisionReason.circuitBreaker, "claudeSettingsFile");
    else assert.fail("expected native settings safety reason");
    const suspicious = decided(edit(posix.join(work, "ABC~1/file")));
    assert.equal(suspicious.behavior, "ask");
    if (suspicious.decisionReason?.type === "safetyCheck")
      assert.equal(suspicious.decisionReason.classifierApprovable, false);
    else assert.fail("expected native suspicious path reason");
  }));

test("write-outside fence refuses settings capable of lifting the fence", () =>
  fixture(({ work, resources, policy, edit }) => {
    const settings = posix.join(work, ".claude/settings.json");
    mkdirSync(posix.dirname(settings));
    writeFileSync(settings, "{}");
    resources.protected.settingsFiles = [settings];
    policy.blockWritesOutsideWorkingDirectories = true;
    const result = decided(edit(settings));
    assert.equal(result.behavior, "deny");
    assert.equal(result.decisionReason?.type, "other");
  }));

test("restricted/outside-read fences use native root floors and allow actual protected plan files", () =>
  fixture(({ outside, resources, policy, read }) => {
    const plan = posix.join(outside, "plans");
    mkdirSync(plan);
    const path = posix.join(plan, "actual-slug.md");
    writeFileSync(path, "owned");
    policy.restricted = true;
    assert.equal(decided(read(path)).behavior, "deny");
    resources.runtime.plan = { directory: plan, slug: "actual-slug" };
    assert.equal(decided(read(path)).behavior, "allow");
  }));

test("unresolved symlink writes deny without creating a fake landing", () =>
  fixture(({ work, edit }) => {
    const path = posix.join(work, "cycle");
    symlinkSync("cycle", path);
    const result = decided(edit(path));
    assert.equal(result.behavior, "deny");
    assert.equal(result.decisionReason?.type, "other");
  }));

test("source remote-sensitive exceptions keep nested config and dangerous filename floors", () => {
  assert.equal(
    nativeSensitiveLexicalPath("/work/.claude/skills/x/SKILL.md", true, [
      "/work",
    ]),
    false,
  );
  assert.equal(
    nativeSensitiveLexicalPath(
      "/work/.claude/skills/x/.claude/commands/x",
      true,
      ["/work"],
    ),
    true,
  );
  assert.equal(
    nativeSensitiveLexicalPath("/work/.claude/worktrees/a/file", false, [
      "/work",
    ]),
    false,
  );
  assert.equal(
    nativeSensitiveLexicalPath("/work/bunfig.toml", true, ["/work"]),
    true,
  );
  assert.equal(
    nativeSensitiveLexicalPath("/work/.g\u200dit/config", false, ["/work"]),
    true,
  );
  assert.equal(
    nativeSuspiciousWindowsPath("/owned/ABC~1/file", [], "macos", {
      cwd: "/work",
      home: "/home",
    }),
    "tilde_digit",
  );
});

test("connector classification requires an actual regular file with one link", () =>
  fixture(({ outside, resources, read }) => {
    const directory = posix.join(outside, "connector-downloads");
    mkdirSync(directory);
    const path = posix.join(directory, "owned.md");
    writeFileSync(path, "owned");
    resources.runtime.connectorDownloadDirectory = outside;
    const first = decided(read(path));
    assert.equal(first.behavior, "allow");
    assert.equal(first.decisionReason?.type, "other");
    linkSync(path, posix.join(directory, "second.md"));
    assert.equal(decided(read(path)).behavior, "ask");
  }));

test("auto-memory reading does not inherit scratchpad's sensitive-filename exclusions", () =>
  fixture(({ outside, resources, read }) => {
    const directory = posix.join(outside, "memory");
    mkdirSync(directory);
    const path = posix.join(directory, "bunfig.toml");
    writeFileSync(path, "owned");
    resources.memory.autoMemoryRoot = directory + "/";
    const result = decided(read(path));
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.decisionReason, {
      type: "other",
      reason: "auto memory files are allowed for reading",
    });
  }));

test("trusted network directory admission plus a scoped Read rule admits the actual source branch", () =>
  fixture(({ policy, rules, read }) => {
    const path = "/net/owned-host/file.md";
    const held = decided(read(path));
    assert.equal(held.behavior, "ask");
    if (held.decisionReason?.type === "safetyCheck")
      assert.equal(held.decisionReason.classifierApprovable, false);
    else assert.fail("expected network source floor");
    policy.trustedNetworkDirectories = ["/net/owned-host"];
    rules.allow.push(rule("Read(//net/owned-host/file.md)", "userSettings"));
    const allowed = decided(read(path));
    assert.equal(allowed.behavior, "allow");
    assert.equal(allowed.decisionReason?.type, "rule");
  }));

test("foreign owner scope is an unsupported dependency rather than an invented mode result", () =>
  fixture(({ work, policy, host }) => {
    const fact = host.matchRule?.(
      posix.join(work, "owned.md"),
      policy,
      "read",
      "deny",
      { cwd: work, policyId: "foreign" },
    );
    assert.equal(fact?.status, "unsupported");
    if (fact?.status === "unsupported")
      assert.equal(fact.dependency, "host-scope");
  }));

test("native job controls distinguish adopt carriers from the permitted actual bg tmp subtree", () =>
  fixture(({ resources, edit }) => {
    const directory = posix.join(
      resources.configDirectory,
      "jobs/owned-session",
    );
    mkdirSync(posix.join(directory, "tmp"), { recursive: true });
    resources.runtime.backgroundJobDirectory = directory;
    const carrier = posix.join(directory, "adopt.json");
    writeFileSync(carrier, "{}");
    const rejected = decided(edit(carrier));
    assert.equal(rejected.behavior, "deny");
    assert.match(
      rejected.message ?? "",
      /^adopt\.json is the bg-fork handoff carrier/,
    );
    const path = posix.join(directory, "tmp/owned.md");
    writeFileSync(path, "owned");
    const admitted = decided(edit(path));
    assert.equal(admitted.behavior, "allow");
    assert.deepEqual(admitted.decisionReason, {
      type: "other",
      reason: "Job tmp/ subtree for current bg session is allowed for writing",
    });
  }));

test("actual config-child symlinks keep physical targets protected even under another spelling", () =>
  fixture(({ resources, outside, edit }) => {
    const directory = posix.join(outside, "daemon-storage");
    mkdirSync(directory);
    symlinkSync(directory, posix.join(resources.configDirectory, "daemon"));
    const result = decided(edit(posix.join(directory, "workers.json")));
    assert.equal(result.behavior, "deny");
    assert.match(result.message ?? "", /daemon folder/);
  }));

test("fixed-root physical rule twins deny an outside file reached by another spelling", () =>
  fixture(({ work, outside, rules, read }) => {
    symlinkSync(outside, posix.join(work, "bridge"));
    const target = posix.join(outside, "denied.md");
    writeFileSync(target, "owned");
    rules.deny.push(rule("Read(/bridge/denied.md)"));
    const result = decided(read(target));
    assert.equal(result.behavior, "deny");
    assert.equal(result.decisionReason?.type, "rule");
  }));

test("Nc rejects a collapsed UNC-link network escape even when the named root contains both spellings", () =>
  fixture(({ work, resources, policy, read }) => {
    symlinkSync("//owned-unc-host/share", posix.join(work, "network-link"));
    resources.originalCwd = "/";
    policy.restricted = true;
    const result = decided(read(posix.join(work, "network-link/file.md")));
    assert.equal(result.behavior, "deny");
    assert.match(result.message ?? "", /could not be determined/);
  }));

test("bct inspects all four actual Glob pattern surfaces without a path-level network verdict", () =>
  fixture(({ work, policy, host }) => {
    for (const [pattern, reason] of [
      [
        "//owned-host/share/*",
        "UNC glob pattern detected (defense-in-depth check)",
      ],
      [
        "/net/owned-host/*",
        "Automount -hosts glob pattern detected (defense-in-depth check)",
      ],
      [
        "/Network/files/*",
        "Automount browse surface glob pattern detected (defense-in-depth check)",
      ],
      [
        "/.vol/files/*",
        "Kernel-resolved path prefix (/.vol etc.) glob pattern detected (defense-in-depth check)",
      ],
    ]) {
      const input = { file_path: work, pattern };
      const fact = host.networkRead?.(
        { name: "Glob", getPath: (input: Input) => input.file_path },
        input,
        policy,
        [work],
        policy.scope,
      );
      assert.equal(fact?.status, "known");
      if (fact?.status === "known")
        assert.deepEqual(fact.value?.decisionReason, {
          type: "safetyCheck",
          classifierApprovable: false,
          reason,
        });
    }
  }));

test("remoteSurface preserves actual lLe memory and bundled-skill gates", () =>
  fixture(({ outside, resources, policy, host }) => {
    const directory = posix.join(outside, "memory");
    mkdirSync(directory);
    const path = posix.join(directory, "MEMORY.md");
    writeFileSync(path, "owned");
    resources.memory.autoMemoryRoot = directory + "/";
    const input = { file_path: path };
    const settings = {
      restricted: false,
      blockOutsideReads: false,
      transcriptsJudged: true,
      remoteSurface: true,
    } satisfies Parameters<NonNullable<typeof host.protectedRead>>[4];
    const fact = host.protectedRead?.(
      path,
      input,
      [path],
      policy,
      settings,
      policy.scope,
    );
    assert.equal(fact?.status, "known");
    if (fact?.status === "known")
      assert.equal(fact.value.behavior, "passthrough");
    const bundled = posix.join(
      resources.runtime.bundledSkillReferenceDirectory,
      "ref.md",
    );
    const blocked = host.protectedRead?.(
      bundled,
      { file_path: bundled },
      [bundled],
      policy,
      settings,
      policy.scope,
    );
    if (blocked?.status === "known")
      assert.equal(blocked.value.behavior, "passthrough");
    else assert.fail("expected source-backed remote profile");
    const restricted = host.protectedRead?.(
      bundled,
      { file_path: bundled },
      [bundled],
      policy,
      { ...settings, restricted: true, remoteSurface: false },
      policy.scope,
    );
    if (restricted?.status === "known")
      assert.equal(restricted.value.behavior, "allow");
    else assert.fail("expected source-backed restricted profile");
  }));

test("wwn's UNC/WebDAV clause uses the actual Windows-only tP gate", () => {
  const context = { cwd: "/owned", home: "/owned" };
  assert.equal(
    nativeSuspiciousWindowsPath("//owned-host/share", [], "macos", context),
    undefined,
  );
  assert.equal(
    nativeSuspiciousWindowsPath("//owned-host/share", [], "windows", context),
    "unc_or_webdav_form",
  );
  assert.equal(
    nativeSuspiciousWindowsPath("DavWWWRoot", [], "windows", context),
    "unc_or_webdav_form",
  );
  assert.equal(
    nativeSuspiciousWindowsPath("DavWWWRoot", [], "wsl", context),
    undefined,
  );
});

test("actual producer cache preserves five-second expiry and explicit registry invalidation", () =>
  fixture(({ work, resources, policy, host, edit, clock }) => {
    const directory = posix.join(work, "producer");
    mkdirSync(directory);
    const path = posix.join(directory, "owned.md");
    writeFileSync(path, "owned");
    policy.mode = "acceptEdits";
    assert.equal(decided(edit(path)).behavior, "allow");
    resources.plugins.producerRoots = [directory];
    clock.now = 4999;
    assert.equal(decided(edit(path)).behavior, "allow");
    clock.now = 5000;
    assert.equal(decided(edit(path)).behavior, "ask");
    resources.plugins.producerRoots = [];
    clock.now = 5001;
    assert.equal(decided(edit(path)).behavior, "ask");
    host.invalidateProducerPaths();
    assert.equal(decided(edit(path)).behavior, "allow");
  }));

test("inline producer physical aliases follow the separate thirty-second cache", () =>
  fixture(({ work, resources, policy, host, clock }) => {
    const first = posix.join(work, "first");
    const second = posix.join(work, "second");
    mkdirSync(first);
    mkdirSync(second);
    const alias = posix.join(work, "inline");
    symlinkSync(first, alias);
    const a = posix.join(first, "owned.md");
    const b = posix.join(second, "owned.md");
    writeFileSync(a, "owned");
    writeFileSync(b, "owned");
    resources.plugins.inlineRoots = [alias];
    function safe(path: string) {
      const fact = host.sensitiveWrite?.(path, [path], policy, policy.scope);
      if (fact?.status !== "known")
        assert.fail("expected source-backed classifier");
      return fact.value.safe;
    }
    assert.equal(safe(a), false);
    unlinkSync(alias);
    symlinkSync(second, alias);
    clock.now = 29999;
    assert.equal(safe(b), true);
    clock.now = 30000;
    assert.equal(safe(b), false);
  }));

test("additional producer roots honor native twn config-home overlap gates", () =>
  fixture(({ root, work, resources, policy, edit }) => {
    const path = posix.join(work, "owned.md");
    writeFileSync(path, "owned");
    policy.mode = "acceptEdits";
    resources.plugins.additionalProducerRoot = root;
    assert.equal(decided(edit(path)).behavior, "allow");
    resources.plugins.additionalProducerRoot = work;
    assert.equal(decided(edit(path)).behavior, "ask");
    resources.configHome = null;
    assert.equal(decided(edit(path)).behavior, "allow");
  }));

test("settings link targets use the native two-second monotonic cache and retain linked provenance", () =>
  fixture(({ work, resources, policy, host, clock }) => {
    const first = posix.join(work, "first.md");
    const second = posix.join(work, "second.md");
    writeFileSync(first, "owned");
    writeFileSync(second, "owned");
    const flag = posix.join(resources.configDirectory, "extra-settings.json");
    symlinkSync(first, flag);
    resources.protected.flagSettingsPath = flag;
    function classify(path: string) {
      const fact = host.sensitiveWrite?.(path, [path], policy, policy.scope);
      if (fact?.status !== "known")
        assert.fail("expected actual settings fact");
      return fact.value;
    }
    const actual = classify(first);
    assert.equal(actual.safe, false);
    if (!actual.safe) {
      assert.equal(actual.classifierApprovable, false);
      assert.match(actual.message, /leads here through a link/);
    }
    unlinkSync(flag);
    symlinkSync(second, flag);
    clock.now = 1999;
    assert.equal(classify(second).safe, true);
    clock.now = 2000;
    assert.equal(classify(second).safe, false);
  }));

test("remote-settings body templates locate physical config-root aliases without guessing a filename", () =>
  fixture(({ work, outside, resources, policy, host }) => {
    const alias = posix.join(work, "config-alias");
    symlinkSync(outside, alias);
    const path = posix.join(outside, "remote-settings.json");
    writeFileSync(path, "{}");
    resources.protected.settingsFiles = [
      posix.join(alias, "remote-settings.json"),
    ];
    resources.protected.settingsBodyTemplates = [
      { root: alias, relativePaths: ["remote-settings.json"] },
    ];
    const fact = host.sensitiveWrite?.(path, [path], policy, policy.scope);
    if (fact?.status !== "known" || fact.value.safe)
      assert.fail("expected actual body-root settings classification");
    assert.equal(fact.value.circuitBreaker, "claudeSettingsFile");
    assert.equal(fact.value.classifierApprovable, true);
  }));

test("adopted original cwd owns physical project settings roots independently of evaluation cwd", () =>
  fixture(({ work, outside, resources, policy, host }) => {
    const physical = posix.join(work, "physical-project-settings");
    mkdirSync(physical);
    symlinkSync(physical, posix.join(outside, ".claude"));
    const path = posix.join(physical, "settings.json");
    writeFileSync(path, "{}");
    resources.originalCwd = outside;
    resources.configContextCwd = null;
    assert.notEqual(policy.scope.cwd, resources.originalCwd);
    const fact = host.sensitiveWrite?.(path, [path], policy, policy.scope);
    if (fact?.status !== "known" || fact.value.safe)
      assert.fail("expected adopted physical project settings classification");
    assert.equal(fact.value.circuitBreaker, "claudeSettingsFile");
    assert.equal(fact.value.classifierApprovable, true);
  }));

test("adopted original cwd owns the physical settings directory classification", () =>
  fixture(({ work, outside, resources, policy, host }) => {
    const physical = posix.join(work, "adopted-settings-directory");
    mkdirSync(physical);
    symlinkSync(physical, posix.join(outside, ".claude"));
    resources.originalCwd = outside;
    resources.configContextCwd = null;
    const fact = host.sensitiveWrite?.(
      physical,
      [physical],
      policy,
      policy.scope,
    );
    if (fact?.status !== "known" || fact.value.safe)
      assert.fail(
        "expected adopted physical settings directory classification",
      );
    assert.equal(fact.value.circuitBreaker, "claudeSettingsFile");
    assert.equal(fact.value.classifierApprovable, true);
  }));

test("host fact provenance retains the actual owner contracts and identity", () =>
  fixture(({ work, policy, host }) => {
    const fact = host.inWorkingDirectories?.(
      work,
      [work],
      policy,
      policy.scope,
    );
    if (fact?.status !== "known") assert.fail("expected actual root fact");
    assert.match(fact.provenance.provider, /authored-owned-state/);
    assert.ok(
      fact.provenance.sourceContracts.includes("explicit-owner-snapshot"),
    );
    assert.deepEqual(fact.provenance.scope, policy.scope);
  }));

test("host credentials use native Do rather than broad protected-segment folding", () =>
  fixture(({ work, resources, policy, edit }) => {
    const credential = posix.join(work, "host-creds.json");
    const distinct = posix.join(work, "host\u200d-creds.json");
    writeFileSync(credential, "owned");
    writeFileSync(distinct, "owned");
    resources.protected.hostCredentialsPath = credential;
    policy.mode = "acceptEdits";
    assert.equal(decided(edit(credential)).behavior, "deny");
    assert.equal(decided(edit(distinct)).behavior, "allow");
  }));

test("seed-admin protects its named config root without inventing a child-link physical floor", () =>
  fixture(({ work, resources, policy, edit }) => {
    const path = posix.join(work, "ordinary.md");
    writeFileSync(path, "owned");
    symlinkSync(work, posix.join(resources.configDirectory, "seed-admin"));
    policy.mode = "acceptEdits";
    assert.equal(
      decided(
        edit(posix.join(resources.configDirectory, "seed-admin/ordinary.md")),
      ).behavior,
      "deny",
    );
    assert.equal(decided(edit(path)).behavior, "allow");
  }));
