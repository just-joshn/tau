import { afterEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import {
  createNativeConcreteFileAdjudicationHost,
  nativeLocalConcreteIdentityReaders,
  nativeSensitiveLexicalPath,
  nativeSensitivePathComponent,
  nativeSuspiciousWindowsPath,
  nativeWindowsNetworkPathPattern,
  type NativeConcreteIdentityReaders,
} from "../../src/native-file-adjudication-host.js";
import type {
  NativeFileAdjudicationPolicy,
  NativeFilePermissionInspection,
  NativeProtectedReadOptions,
} from "../../src/native-file-adjudication.js";
import type { NativeFileResourceSnapshot } from "../../src/native-file-adjudication-types.js";
import { nativeLocalAncestryFilesystem } from "../../src/native-path-ancestry.js";
import { nativeLocalPermissionPathFilesystem } from "../../src/native-path-inspection.js";
import type {
  NativePermissionFact,
  NativePermissionOutcome,
} from "../../src/native-permission-outcome.js";
import type { NativeFileRule } from "../../src/native-permission-rules.js";
import { nativeLocalPluginDirectoryFilesystem } from "../../src/native-plugin-permission-scan.js";

type Input = { file_path: string };

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function known<T>(fact: NativePermissionFact<T> | undefined): T {
  if (fact === undefined) throw new Error("host capability is missing");
  if (fact.status !== "known")
    throw new Error(`${fact.dependency}: ${fact.reason}`);
  return fact.value;
}

function receipt<T>(value: T, cwd: string): NativePermissionFact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "edge-test-owner",
      sourceContracts: ["edge-test"],
      scope: { policyId: "edge-policy", cwd },
    },
  };
}

interface WorldOptions {
  macos?: boolean;
  identities?: NativeConcreteIdentityReaders;
  skillAdmission?: boolean | "missing";
}

function world(options: WorldOptions = {}) {
  const root = realpathSync(
    mkdtempSync(posix.join(tmpdir(), "tau-host-edge-")),
  );
  temporary.push(root);
  const work = posix.join(root, "work");
  const outside = posix.join(root, "outside");
  const home = posix.join(root, "home");
  const config = posix.join(home, ".claude");
  for (const directory of [work, outside, config])
    mkdirSync(directory, { recursive: true });
  const scope = { policyId: "edge-policy", cwd: work };
  const policy: NativeFileAdjudicationPolicy = {
    scope,
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
    aliasTranslationRoots: [],
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
  const skillAdmission = options.skillAdmission ?? true;
  const host = createNativeConcreteFileAdjudicationHost<Input>({
    pathContext: {
      cwd: work,
      initialCwd: work,
      home,
      macos: options.macos ?? true,
      filesystem: nativeLocalPermissionPathFilesystem,
    },
    readResources: () => receipt(resources, work),
    readRules: (_policy, behavior) => receipt(rules[behavior], work),
    readRuleRoots: () =>
      receipt(
        {
          launchRoot: work,
          settingsContextCwd: work,
          userConfigDir: config,
          flagSettings: { kind: "absent" },
        },
        work,
      ),
    relativeRuleRoots: () => receipt([work], work),
    physicalRuleTwins: true,
    fixedRuleRootsBeforeRelative: true,
    trustedAlias: (path) => path,
    identities: options.identities ?? nativeLocalConcreteIdentityReaders,
    ancestryFilesystem: nativeLocalAncestryFilesystem,
    pluginDirectoryFilesystem: nativeLocalPluginDirectoryFilesystem,
    now: () => clock.now,
    monotonicNow: () => clock.now,
    capabilities: {
      quotePath: (path) => receipt(JSON.stringify(path), work),
      ...(skillAdmission === "missing"
        ? {}
        : { isAdmittedSkillName: () => receipt(skillAdmission, work) }),
    },
  });
  const inspection = (path: string): NativeFilePermissionInspection =>
    known(host.inspect?.(path, scope));
  const write = (path: string, paths: readonly string[] = [path]) =>
    known(
      host.protectedWrite?.(path, { file_path: path }, paths, policy, scope),
    );
  const readSettings: NativeProtectedReadOptions = {
    restricted: false,
    blockOutsideReads: false,
    transcriptsJudged: true,
  };
  const read = (
    path: string,
    settings: Partial<NativeProtectedReadOptions> = {},
    paths: readonly string[] = [path],
  ) =>
    known(
      host.protectedRead?.(
        path,
        { file_path: path },
        paths,
        policy,
        { ...readSettings, ...settings },
        scope,
      ),
    );
  const floor = (path: string) =>
    known(
      host.writeFloor?.(
        path,
        inspection(path),
        posix.normalize(path),
        policy,
        scope,
      ),
    );
  const sensitive = (path: string, paths: readonly string[] = [path]) =>
    known(host.sensitiveWrite?.(path, paths, policy, scope));
  const file = (path: string, body = "owned") => {
    mkdirSync(posix.dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  return {
    root,
    work,
    outside,
    home,
    config,
    scope,
    policy,
    resources,
    rules,
    clock,
    host,
    inspection,
    write,
    read,
    floor,
    sensitive,
    file,
  };
}

function reason(outcome: NativePermissionOutcome<Input>): string {
  const decision = outcome.decisionReason;
  if (decision === undefined) return "";
  return "reason" in decision && typeof decision.reason === "string"
    ? decision.reason
    : "";
}

describe("exported Windows path screens", () => {
  const context = { cwd: "/work", home: "/home/me" };
  const screen = (
    path: string,
    platform: "macos" | "linux" | "windows" | "wsl" = "linux",
    trusted: readonly string[] = [],
  ) => nativeSuspiciousWindowsPath(path, trusted, platform, context);

  test("names the NT object namespace, including a spelling that normalizes into it", () => {
    expect(screen("/??/C:/x")).toBe("nt_device_namespace");
    expect(screen("/a/../??/x")).toBe("nt_device_namespace");
    expect(screen("/a/??b")).toBeUndefined();
  });

  test("a colon past the drive letter counts only on Windows and WSL", () => {
    expect(screen("C:\\dir\\file:stream", "windows")).toBe(
      "colon_past_drive_position",
    );
    expect(screen("/mnt/c/file:stream", "wsl")).toBe(
      "colon_past_drive_position",
    );
    expect(screen("/srv/file:stream", "linux")).toBeUndefined();
  });

  test("short names, device prefixes, trailing dots and DOS devices are each named", () => {
    expect(screen("/a/PROGRA~1/x")).toBe("tilde_digit");
    expect(screen("\\\\?\\C:\\x")).toBe("device_path_prefix");
    expect(screen("\\\\.\\pipe\\x")).toBe("device_path_prefix");
    expect(screen("//?/C:/x")).toBe("device_path_prefix");
    expect(screen("//./pipe/x")).toBe("device_path_prefix");
    expect(screen("/a/name./x")).toBe("trailing_dot_or_whitespace");
    expect(screen("/a/name /x")).toBe("trailing_dot_or_whitespace");
    expect(screen("/a/.../b")).toBe("trailing_dot_or_whitespace");
    expect(screen("/a/report.CON")).toBe("dos_device_suffix");
    expect(screen("/a/./b/../c")).toBeUndefined();
  });

  test("a UNC form on Windows needs a trusted root without dot segments", () => {
    expect(screen("\\\\server\\share\\x", "windows")).toBe(
      "unc_or_webdav_form",
    );
    expect(screen("\\\\server\\share\\x", "linux")).toBeUndefined();
    expect(
      screen("//server/share/x", "windows", ["//server/share"]),
    ).toBeUndefined();
    expect(screen("//server/share/../x", "windows", ["//server/share"])).toBe(
      "unc_or_webdav_form",
    );
    expect(screen("//server/share/x", "windows", ["//other/share"])).toBe(
      "unc_or_webdav_form",
    );
  });

  test("network forms hide behind option prefixes and assignments", () => {
    expect(nativeWindowsNetworkPathPattern("-x\\\\server\\share")).toBe(true);
    expect(nativeWindowsNetworkPathPattern("-x")).toBe(false);
    expect(nativeWindowsNetworkPathPattern("-xfile")).toBe(false);
    expect(nativeWindowsNetworkPathPattern("--out=//server/share/x")).toBe(
      true,
    );
    expect(
      nativeWindowsNetworkPathPattern("--a=--b=\\\\server\\share\\x"),
    ).toBe(true);
    expect(nativeWindowsNetworkPathPattern("--out=")).toBe(false);
    expect(nativeWindowsNetworkPathPattern("--out=local/file")).toBe(false);
    expect(nativeWindowsNetworkPathPattern(" \\??\\C:")).toBe(true);
    expect(nativeWindowsNetworkPathPattern("a/\\server\\share")).toBe(false);
    expect(nativeWindowsNetworkPathPattern(" /\\server\\share")).toBe(true);
    expect(nativeWindowsNetworkPathPattern(" \\/server/share")).toBe(true);
    expect(nativeWindowsNetworkPathPattern("file@SSL@443")).toBe(true);
    expect(nativeWindowsNetworkPathPattern("host/DavWWWRoot/x")).toBe(true);
    expect(nativeWindowsNetworkPathPattern("https://host/x")).toBe(false);
    expect(nativeWindowsNetworkPathPattern("/plain/local/path")).toBe(false);
  });
});

describe("exported sensitive lexical screen", () => {
  test("folds hidden characters, streams, trailing dots and dotless i", () => {
    expect(nativeSensitivePathComponent(".GIT\u200b")).toBe(".git\u200b");
    expect(nativeSensitivePathComponent(".git\u200c")).toBe(".git");
    expect(nativeSensitivePathComponent(".git:stream")).toBe(".git");
    expect(nativeSensitivePathComponent(".git. .")).toBe(".git");
    expect(nativeSensitivePathComponent(".g\u0131t")).toBe(".git");
    expect(nativeSensitivePathComponent("...")).toBe("...");
  });

  test("sensitive directories, git config and dangerous filenames", () => {
    expect(
      nativeSensitiveLexicalPath("/w/.vscode/settings.json", false, []),
    ).toBe(true);
    expect(nativeSensitiveLexicalPath("/w/.config/git/config", false, [])).toBe(
      true,
    );
    expect(nativeSensitiveLexicalPath("/w/.config/other", false, [])).toBe(
      false,
    );
    expect(nativeSensitiveLexicalPath("/w/.ZSHRC", false, [])).toBe(true);
    expect(nativeSensitiveLexicalPath("/w/src/index.ts", false, [])).toBe(
      false,
    );
  });

  test("a config directory is sensitive unless it holds worktrees or remote-surface skills", () => {
    expect(
      nativeSensitiveLexicalPath("/w/.claude/settings.json", false, ["/w"]),
    ).toBe(true);
    expect(
      nativeSensitiveLexicalPath("/w/.claude/worktrees/a/x.ts", false, ["/w"]),
    ).toBe(false);
    expect(
      nativeSensitiveLexicalPath("/w/.claude/skills/a/SKILL.md", false, ["/w"]),
    ).toBe(true);
    expect(
      nativeSensitiveLexicalPath("/w/.claude/skills/a/SKILL.md", true, ["/w"]),
    ).toBe(false);
    expect(
      nativeSensitiveLexicalPath("/w/.claude/scheduled_tasks.json", true, [
        "/w",
      ]),
    ).toBe(false);
    expect(
      nativeSensitiveLexicalPath("/w/.claude/scheduled_tasks.json/x", true, [
        "/w",
      ]),
    ).toBe(true);
    expect(nativeSensitiveLexicalPath("/w/.claude", true, ["/w"])).toBe(true);
  });

  test("a second config directory past the project boundary is sensitive", () => {
    expect(
      nativeSensitiveLexicalPath(
        "/w/.claude/worktrees/a/.claude/worktrees/b",
        false,
        ["/w"],
      ),
    ).toBe(true);
    expect(
      nativeSensitiveLexicalPath("/w/.claude/skills/a/.claude/skills/b", true, [
        "/w",
      ]),
    ).toBe(true);
    // Before the launch root the first config folder is not counted as seen.
    expect(
      nativeSensitiveLexicalPath(
        "/w/.claude/worktrees/t/.claude/worktrees/b",
        false,
        ["/w/.claude/worktrees/t/"],
      ),
    ).toBe(false);
    // A launch root inside a config folder starts the boundary at that folder.
    expect(
      nativeSensitiveLexicalPath("/w/.claude/agents/x", false, [
        "/w/.claude/agents",
        "/elsewhere",
      ]),
    ).toBe(true);
  });
});

describe("protected read classification", () => {
  test("a diskless session passes reads through unless memory is paused", () => {
    const w = world();
    w.resources.diskless = true;
    expect(w.read("/anything").behavior).toBe("passthrough");
    w.resources.memory.paused = true;
    const paused = w.read("/anything");
    expect(paused.behavior).toBe("deny");
    expect(reason(paused)).toBe("memory access blocked by /pause-memory");
  });

  test("the outside-read fence switches the project store to the original one", () => {
    const w = world();
    const current = posix.join(w.root, "store-current");
    const original = posix.join(w.root, "store-original");
    w.resources.runtime.projectStoreDirectory = current;
    w.resources.runtime.originalProjectStoreDirectory = original;
    expect(w.read(posix.join(current, "a.jsonl")).behavior).toBe("allow");
    expect(
      w.read(posix.join(current, "a.jsonl"), { blockOutsideReads: true })
        .behavior,
    ).toBe("passthrough");
    expect(
      w.read(posix.join(original, "a.jsonl"), { blockOutsideReads: true })
        .behavior,
    ).toBe("allow");
    expect(
      w.read(posix.join(current, "a.jsonl"), { restricted: true }).behavior,
    ).toBe("passthrough");
  });

  test("connector downloads need a regular single-link file", () => {
    const w = world();
    const downloads = posix.join(w.root, "project", "connector-downloads");
    w.resources.runtime.connectorDownloadDirectory = downloads;
    const single = w.file(posix.join(downloads, "single.pdf"));
    const linked = w.file(posix.join(downloads, "linked.pdf"));
    linkSync(linked, posix.join(w.outside, "second-name.pdf"));
    mkdirSync(posix.join(downloads, "folder"));
    expect(w.read(single).behavior).toBe("allow");
    expect(w.read(linked).behavior).toBe("passthrough");
    expect(w.read(posix.join(downloads, "folder")).behavior).toBe(
      "passthrough",
    );
    expect(w.read(posix.join(downloads, "missing.pdf")).behavior).toBe(
      "passthrough",
    );
    expect(w.read(single, { restricted: true }).behavior).toBe("passthrough");
    // The folder must really be named connector-downloads.
    const renamed = posix.join(w.root, "project", "downloads");
    w.resources.runtime.connectorDownloadDirectory = renamed;
    expect(w.read(w.file(posix.join(renamed, "a.pdf"))).behavior).toBe(
      "passthrough",
    );
  });

  test("plan, tool result, own session and scratch files are readable", () => {
    const w = world();
    const plans = posix.join(w.root, "plans");
    w.resources.runtime.plan = { directory: plans, slug: "brave-otter" };
    expect(w.read(posix.join(plans, "brave-otter.md")).behavior).toBe("allow");
    expect(w.read(posix.join(plans, "brave-otter-agent-a1.md")).behavior).toBe(
      "allow",
    );
    expect(w.read(posix.join(plans, "brave-otter-agent-a1.txt")).behavior).toBe(
      "passthrough",
    );
    expect(w.read(posix.join(plans, "other.md")).behavior).toBe("passthrough");
    const results = posix.join(w.root, "tool-results");
    w.resources.runtime.toolResultDirectories = [results];
    expect(w.read(posix.join(results, "r.txt")).behavior).toBe("allow");
    const session = posix.join(w.root, "session");
    w.resources.runtime.ownSessionDirectory = session;
    expect(w.read(posix.join(session, "s.jsonl")).behavior).toBe("allow");
    expect(
      w.read(posix.join(session, "s.jsonl"), { restricted: true }).behavior,
    ).toBe("passthrough");
    const scratch = posix.join(w.root, "Scratch");
    w.resources.runtime.scratchDirectory = scratch;
    expect(w.read(scratch).behavior).toBe("allow");
    expect(w.read(posix.join(w.root, "scratch", "n.txt")).behavior).toBe(
      "allow",
    );
    expect(w.read(posix.join(scratch, ".git", "config")).behavior).toBe(
      "passthrough",
    );
    expect(w.read(posix.join(scratch, ".bashrc")).behavior).toBe("passthrough");
  });

  test("background job tmp files are readable only under the config jobs folder", () => {
    const w = world();
    const job = posix.join(w.config, "jobs", "job-1");
    w.resources.runtime.backgroundJobDirectory = job;
    expect(w.read(posix.join(job, "tmp", "out.txt")).behavior).toBe("allow");
    expect(w.read(posix.join(job, "tmp", ".zshrc")).behavior).toBe(
      "passthrough",
    );
    expect(w.read(posix.join(job, "state.json")).behavior).toBe("passthrough");
    w.resources.runtime.backgroundJobDirectory = posix.join(w.root, "job-1");
    expect(w.read(posix.join(w.root, "job-1", "tmp", "out.txt")).behavior).toBe(
      "passthrough",
    );
  });

  test("task output is readable directly under this session's folder only", () => {
    const w = world();
    const output = posix.join(
      w.root,
      "tasks",
      w.resources.nativeSessionId,
      "output",
    );
    w.resources.runtime.taskOutputDirectory = output;
    expect(w.read(output).behavior).toBe("allow");
    expect(w.read(posix.join(output, "task.log")).behavior).toBe("allow");
    expect(w.read(posix.join(output, "nested", "task.log")).behavior).toBe(
      "passthrough",
    );
    expect(w.read(posix.join(w.root, "elsewhere.log")).behavior).toBe(
      "passthrough",
    );
    w.resources.runtime.taskOutputDirectory = posix.join(
      w.root,
      "tasks",
      "another-session",
      "output",
    );
    expect(
      w.read(posix.join(w.root, "tasks", "another-session", "output", "t.log"))
        .behavior,
    ).toBe("passthrough");
  });

  test("project temp and bundled skill references are readable", () => {
    const w = world();
    expect(w.read(posix.join(w.root, "project-temp", "x.txt")).behavior).toBe(
      "allow",
    );
    const bundled = posix.join(w.root, "bundled", "skill", "ref.md");
    expect(w.read(bundled).behavior).toBe("allow");
    expect(w.read(bundled, { remoteSurface: true }).behavior).toBe(
      "passthrough",
    );
  });

  test("agent memory and earlier tool results stay closed behind a fence", () => {
    const w = world();
    const agent = posix.join(w.root, "agent-memory");
    w.resources.memory.agentMemoryRoots = [agent];
    expect(w.read(posix.join(agent, "notes.md")).behavior).toBe("allow");
    expect(
      w.read(posix.join(agent, "notes.md"), { blockOutsideReads: true })
        .behavior,
    ).toBe("passthrough");
    expect(w.read(posix.join(agent, ".git", "HEAD")).behavior).toBe(
      "passthrough",
    );
    const earlier = posix.join(w.root, "earlier-results");
    w.resources.runtime.earlierToolResultDirectories = [earlier];
    const result = posix.join(earlier, "r.txt");
    expect(w.read(result, { forTheModelHere: true }).behavior).toBe(
      "passthrough",
    );
    w.resources.runtime.allowEarlierToolResultsForModel = true;
    expect(w.read(result, { forTheModelHere: true }).behavior).toBe("allow");
    expect(w.read(result).behavior).toBe("passthrough");
    expect(
      w.read(result, { forTheModelHere: true, remoteSurface: true }).behavior,
    ).toBe("passthrough");
  });

  test("auto memory reads honor the remote surface and the read fence", () => {
    const w = world();
    const memory = posix.join(w.root, "memory") + "/";
    w.resources.memory.autoMemoryRoot = memory;
    const note = posix.join(memory, "note.md");
    expect(w.read(note).behavior).toBe("allow");
    expect(w.read(note, { remoteSurface: true }).behavior).toBe("passthrough");
    expect(w.read(posix.join(memory, "hooks", "x.md")).behavior).toBe(
      "passthrough",
    );
    // The memory folder itself counts only for a search-root fence.
    const folder = posix.join(w.root, "memory");
    expect(w.read(folder).behavior).toBe("passthrough");
    expect(w.read(folder, { searchRootFence: true }).behavior).toBe("allow");
    w.resources.memory.memoryBlockedByReadFence = true;
    expect(w.read(note, { blockOutsideReads: true }).behavior).toBe(
      "passthrough",
    );
    expect(w.read(note).behavior).toBe("allow");
  });

  test("an auto memory root must be a plain local absolute folder", () => {
    const w = world();
    for (const root of [
      "relative/memory/",
      "//server/share/",
      "/net/host/memory/",
      "/Network/Servers/memory/",
      "/.vol/1/2/",
      "C:/",
      "/m\0x/",
    ]) {
      w.resources.memory.autoMemoryRoot = root;
      expect(w.read(posix.join(root, "note.md")).behavior).toBe("passthrough");
    }
    w.resources.memory.autoMemoryRoot = posix.join(w.root, "memory");
    expect(w.read(posix.join(w.root, "memory", "note.md")).behavior).toBe(
      "passthrough",
    );
  });

  test("config tasks and teams are readable only without a fence", () => {
    const w = world();
    const task = posix.join(w.config, "tasks", "t.json");
    const team = posix.join(w.config, "teams", "t.json");
    expect(w.read(task).behavior).toBe("allow");
    expect(w.read(team).behavior).toBe("allow");
    expect(w.read(task, { blockOutsideReads: true }).behavior).toBe(
      "passthrough",
    );
    expect(w.read(team, { restricted: true }).behavior).toBe("passthrough");
  });

  test("a read-block fence admits the user's own config surfaces", () => {
    const w = world();
    const synced = posix.join(w.root, "synced-plugins");
    w.resources.runtime.syncedPluginDirectories = [synced];
    const fenced = { readBlockFence: true, blockOutsideReads: true };
    expect(w.read(posix.join(w.config, "CLAUDE.md"), fenced).behavior).toBe(
      "allow",
    );
    expect(w.read(posix.join(synced, "p", "x.md"), fenced).behavior).toBe(
      "allow",
    );
    for (const name of ["skills", "plugins", "rules", "agents", "commands"]) {
      const outcome = w.read(posix.join(w.config, name, "x.md"), fenced);
      expect(outcome.behavior).toBe("allow");
      expect(reason(outcome)).toContain(name);
    }
    expect(w.read(posix.join(w.config, "settings.json"), fenced).behavior).toBe(
      "passthrough",
    );
    expect(
      w.read(posix.join(w.config, "CLAUDE.md"), { ...fenced, restricted: true })
        .behavior,
    ).toBe("passthrough");
  });

  test("an empty spelling list classifies the requested path itself", () => {
    const w = world();
    expect(
      w.read(posix.join(w.root, "project-temp", "x"), {}, []).behavior,
    ).toBe("allow");
  });

  test("a spelling that only an alias root admits is classified under that root", () => {
    const w = world();
    const real = posix.join(w.root, "real-store");
    const alias = posix.join(w.root, "alias-store");
    mkdirSync(real);
    symlinkSync(real, alias);
    w.resources.aliasTranslationRoots = [null, alias];
    w.resources.runtime.projectStoreDirectory = alias;
    expect(w.read(posix.join(real, "a.jsonl")).behavior).toBe("allow");
    // Any unclassified spelling makes the whole read unclassified.
    expect(
      w.read(posix.join(real, "a.jsonl"), {}, [
        posix.join(real, "a.jsonl"),
        posix.join(w.outside, "x"),
      ]).behavior,
    ).toBe("passthrough");
  });
});

describe("protected write classification", () => {
  test("a diskless session refuses every write because no config folder exists", () => {
    const w = world();
    w.resources.diskless = true;
    for (const outcome of [
      w.write(posix.join(w.work, "a.txt")),
      w.write(posix.join(w.work, "a.txt"), []),
    ]) {
      expect(outcome.behavior).toBe("deny");
      expect(reason(outcome)).toBe(
        "permission check needs a config or temp path; the session has none",
      );
    }
  });

  test("plan, workflow, scratch, job tmp and agent memory files are writable", () => {
    const w = world();
    const plans = posix.join(w.root, "plans");
    w.resources.runtime.plan = { directory: plans, slug: "calm-fox" };
    expect(w.write(posix.join(plans, "calm-fox.md"), []).behavior).toBe(
      "allow",
    );
    const workflow = posix.join(w.root, "workflow");
    w.resources.runtime.workflowDirectory = workflow;
    expect(w.write(posix.join(workflow, "step.js"), []).behavior).toBe("allow");
    expect(w.write(posix.join(workflow, "step.ts"), []).behavior).toBe(
      "passthrough",
    );
    w.policy.restricted = true;
    expect(w.write(posix.join(workflow, "step.js"), []).behavior).toBe(
      "passthrough",
    );
    w.policy.restricted = false;
    const scratch = posix.join(w.root, "scratch");
    w.resources.runtime.scratchDirectory = scratch;
    expect(w.write(posix.join(scratch, "n.txt"), []).behavior).toBe("allow");
    const job = posix.join(w.config, "jobs", "job-2");
    w.resources.runtime.backgroundJobDirectory = job;
    expect(w.write(posix.join(job, "tmp", "o.txt"), []).behavior).toBe("allow");
    const agent = posix.join(w.root, "agent-memory");
    w.resources.memory.agentMemoryRoots = [agent];
    expect(w.write(posix.join(agent, "a.md"), []).behavior).toBe("allow");
    expect(w.write(posix.join(agent, "a.txt"), []).behavior).toBe(
      "passthrough",
    );
  });

  test("paused memory refuses writes that may land in memory", () => {
    const w = world();
    const memory = posix.join(w.root, "memory") + "/";
    w.resources.memory.autoMemoryRoot = memory;
    w.resources.memory.paused = true;
    const outcome = w.write(posix.join(memory, "n.md"), []);
    expect(outcome.behavior).toBe("deny");
    expect(reason(outcome)).toBe("memory access blocked by /pause-memory");
    const read = w.read(posix.join(memory, "n.md"));
    expect(read.behavior).toBe("deny");
    expect(read.message).toContain("Cannot read memory");
    w.resources.memory.autoMemoryRoot = null;
    w.resources.memory.canLackFolderAndUnresolved = true;
    expect(w.write(posix.join(w.work, "n.md"), []).behavior).toBe("deny");
  });

  test("auto and project memory markdown is writable unless writes must be explicit", () => {
    const w = world();
    const memory = posix.join(w.root, "memory") + "/";
    w.resources.memory.autoMemoryRoot = memory;
    expect(w.write(posix.join(memory, "n.md"), []).behavior).toBe("allow");
    expect(w.write(posix.join(memory, "n.txt"), []).behavior).toBe(
      "passthrough",
    );
    w.resources.memory.requireExplicitMemoryWrites = true;
    expect(w.write(posix.join(memory, "n.md"), []).behavior).toBe(
      "passthrough",
    );
    w.resources.memory.requireExplicitMemoryWrites = false;
    const project = posix.join(w.root, "project-memory") + "/";
    w.resources.memory.ownProjectMemoryRoot = project;
    expect(w.write(posix.join(project, "n.md"), []).behavior).toBe(
      "passthrough",
    );
    w.resources.memory.ownProjectMemoryEnabled = true;
    expect(w.write(posix.join(project, "n.md"), []).behavior).toBe("allow");
    w.policy.restricted = true;
    expect(w.write(posix.join(project, "n.md"), []).behavior).toBe(
      "passthrough",
    );
  });

  test("the preview launch config is writable outside restricted mode", () => {
    const w = world();
    const launch = posix.join(w.work, ".claude", "launch.json");
    expect(w.write(launch, []).behavior).toBe("allow");
    w.policy.restricted = true;
    expect(w.write(launch, []).behavior).toBe("passthrough");
  });

  test("the config jobs, daemon, shell-snapshots and session-env folders refuse writes", () => {
    const w = world();
    const cases: [string, string][] = [
      ["jobs/job-1/state.json", "jobs folder"],
      ["jobs/job-1/adopt.json", "adopt.json"],
      ["daemon/socket", "daemon folder"],
      ["daemon.json", "daemon.json"],
      ["daemon.json.tmp.123", "daemon.json"],
      ["shell-snapshots/snap.sh", "shell-snapshots"],
      ["SHELL-~1/snap.sh", "shell-snapshots"],
      ["session-env/env.sh", "session-env"],
      ["SESSIO~1/env.sh", "session-env"],
    ];
    for (const [relative, words] of cases) {
      const outcome = w.write(posix.join(w.config, relative));
      expect(outcome.behavior).toBe("deny");
      expect(reason(outcome)).toContain(words);
    }
    // A Windows short name for the config folder counts as the folder itself.
    const short = w.write(posix.join(w.home, "CLAUDE~1", "daemon", "x"));
    expect(short.behavior).toBe("deny");
    expect(reason(short)).toContain("daemon folder");
    // Job tmp under a job folder is not refused by the jobs floor.
    expect(
      w.write(posix.join(w.config, "jobs", "job-1", "tmp", "x")).behavior,
    ).toBe("passthrough");
    // A dot-only job name stays refused.
    expect(
      w.write(posix.join(w.config, "jobs", " .", "tmp", "x")).behavior,
    ).toBe("deny");
  });

  test.skipIf(process.platform !== "darwin")(
    "the macOS data-volume spelling of the config folder is the same folder",
    () => {
      const w = world();
      const data = "/System/Volumes/Data" + w.config;
      const outcome = w.write(posix.join(data, "daemon", "x"));
      expect(outcome.behavior).toBe("deny");
      expect(reason(outcome)).toContain("daemon folder");
      for (const path of [
        "/System/Volumes/Data/unlisted/daemon/x",
        "/System/Volumes/Other/x/daemon",
        "/System/Other/Data/x/daemon",
        "/Other/Volumes/Data/x/daemon",
        "/System/Volumes/Data",
        "relative/System/Volumes/Data/x/y",
      ])
        expect(w.write(path).behavior).toBe("passthrough");
    },
  );

  test("a relative config directory explains the three-folder resolution", () => {
    const w = world();
    w.resources.configDirectory = "relative-config";
    const outcome = w.write(
      posix.join(w.work, "relative-config", "daemon", "x"),
    );
    expect(outcome.behavior).toBe("deny");
    expect(outcome.message).toContain("CLAUDE_CONFIG_DIR is empty or relative");
  });

  test("without the retained boot profile only adopt carriers and their short names are refused", () => {
    const w = world();
    w.resources.merryBoot = false;
    expect(w.write(posix.join(w.config, "daemon", "x")).behavior).toBe(
      "passthrough",
    );
    expect(
      w.write(posix.join(w.config, "jobs", "job-1", "state.json")).behavior,
    ).toBe("passthrough");
    expect(
      w.write(posix.join(w.config, "jobs", "job-1", "adopt.json")).behavior,
    ).toBe("deny");
    const short = w.write(posix.join(w.config, "jobs", "job-1", "ADOPT~1.JSO"));
    expect(short.behavior).toBe("deny");
    expect(short.message).toContain("Windows short name");
  });

  test("host credentials, seed-admin, profile store and settings review refuse writes", () => {
    const w = world();
    const credentials = posix.join(w.root, "host", "creds.json");
    w.resources.protected.hostCredentialsPath = credentials + "/";
    expect(reason(w.write(credentials))).toBe(
      "host-creds file rewrite redirects the bearer token",
    );
    expect(
      reason(w.write(posix.join(w.config, "seed-admin", "x", "config"))),
    ).toBe(
      "seed-admin git configuration is a code-execution surface for the upload",
    );
    const store = posix.join(w.root, "profiles");
    w.resources.protected.profileStore = {
      directories: [store],
      files: [posix.join(w.root, "profile.json")],
    };
    const profile =
      "profile store write substitutes the credential and organization behind managed settings";
    expect(reason(w.write(posix.join(store, "a", "b.json")))).toBe(profile);
    expect(reason(w.write(posix.join(w.root, "profile.json")))).toBe(profile);
    expect(w.write(posix.join(w.root, "profile.json", "child")).behavior).toBe(
      "passthrough",
    );
    const review = w.write(
      posix.join(w.home, ".claude", "state", "settings-review.json"),
    );
    expect(review.behavior).toBe("deny");
    expect(review.decisionReason).toMatchObject({
      circuitBreaker: "claudeSettingsFile",
    });
  });

  test("a config folder whose physical path cannot be resolved keeps only the named seed root", () => {
    const w = world();
    w.resources.configDirectory = posix.join(w.root, "missing-config");
    expect(
      w.write(posix.join(w.root, "missing-config", "seed-admin", "x")).behavior,
    ).toBe("deny");
  });

  test("sign-in files are refused by name, by short name and through hard links", () => {
    const w = world();
    const tokens = w.file(posix.join(w.config, ".credentials.json"));
    const device = posix.join(w.config, "device.json");
    const lock = posix.join(w.config, "state.lock");
    w.resources.protected.signInFiles = [
      { kind: "tokens", paths: [tokens] },
      { kind: "device", paths: [device] },
      { kind: "lock", paths: [lock] },
    ];
    expect(w.write(tokens).message).toContain("sign-in tokens");
    expect(w.write(device).message).toContain("identify this computer");
    expect(w.write(lock).message).toContain("lock");
    // Suspicious spellings that name the file under its folder.
    expect(w.write(posix.join(w.config, "CREDEN~1.JSO")).message).toContain(
      "sign-in tokens",
    );
    expect(w.write(posix.join(w.config, "DEVICE~1.JSO")).message).toContain(
      "identify this computer",
    );
    expect(w.write(posix.join(w.config, "STATE~1.LOC")).message).toContain(
      "lock",
    );
    expect(
      w.write(posix.join(w.home, "CLAUDE~1", "device.json")).message,
    ).toContain("identify this computer");
    expect(w.write(posix.join(w.outside, "CREDEN~1.JSO")).behavior).toBe(
      "passthrough",
    );
    const twin = posix.join(w.outside, "twin.json");
    linkSync(tokens, twin);
    const linked = w.write(twin);
    expect(linked.behavior).toBe("deny");
    expect(linked.message).toContain("hard link");
    expect(w.write(w.file(posix.join(w.outside, "plain.json"))).behavior).toBe(
      "passthrough",
    );
  });

  test("a hard link with an unusable inode number is not treated as an alias", () => {
    const zero: NativeConcreteIdentityReaders = {
      ...nativeLocalConcreteIdentityReaders,
      identity: (path) => ({
        ...nativeLocalConcreteIdentityReaders.identity(path),
        ino: 0n,
      }),
    };
    const w = world({ identities: zero });
    const tokens = w.file(posix.join(w.config, ".credentials.json"));
    w.resources.protected.signInFiles = [{ kind: "tokens", paths: [tokens] }];
    const twin = posix.join(w.outside, "twin.json");
    linkSync(tokens, twin);
    expect(w.write(twin).behavior).toBe("passthrough");
  });

  test("network-shaped candidates are never probed for identity", () => {
    const w = world();
    const tokens = w.file(posix.join(w.config, ".credentials.json"));
    w.resources.protected.signInFiles = [{ kind: "tokens", paths: [tokens] }];
    expect(w.write("/net/host/x.json").behavior).toBe("passthrough");
  });

  test("an empty spelling list classifies the requested write path itself", () => {
    const w = world();
    expect(w.write(posix.join(w.config, "daemon", "x"), []).behavior).toBe(
      "deny",
    );
    expect(w.write(posix.join(w.work, "a.txt"), []).behavior).toBe(
      "passthrough",
    );
  });
});

describe("session write rules for skills and config", () => {
  test("a project skill path yields a scoped pattern for that skill", () => {
    const w = world();
    const special = (path: string) =>
      known(w.host.specialSessionWriteRule?.(path, w.policy, w.scope));
    const skills = posix.join(w.work, ".claude", "skills");
    expect(special(posix.join(skills, "lint", "SKILL.md"))).toEqual({
      pattern: "/.claude/skills/lint/**",
    });
    expect(special(posix.join(skills, "SKILL.md"))).toBeNull();
    expect(special(posix.join(skills, "a..b", "x.md"))).toBeNull();
    expect(special(posix.join(skills, "a*b", "x.md"))).toBeNull();
    expect(special(posix.join(skills, ".claude", "x.md"))).toBeNull();
    expect(special(posix.join(skills, "lint", ".CLAUDE", "x.md"))).toBeNull();
    expect(special(posix.join(w.work, "src", "x.ts"))).toBeNull();
    w.resources.diskless = true;
    expect(special(posix.join(skills, "lint", "SKILL.md"))).toBeNull();
  });

  test("user and reserved skill folders need the skill registry's admission", () => {
    const allowed = world();
    const user = posix.join(allowed.home, ".claude", "skills", "mine", "a.md");
    expect(
      known(
        allowed.host.specialSessionWriteRule?.(
          user,
          allowed.policy,
          allowed.scope,
        ),
      ),
    ).toEqual({ pattern: "~/.claude/skills/mine/**" });
    const refused = world({ skillAdmission: false });
    const refusedUser = posix.join(
      refused.home,
      ".claude",
      "skills",
      "x",
      "a.md",
    );
    expect(
      known(
        refused.host.specialSessionWriteRule?.(
          refusedUser,
          refused.policy,
          refused.scope,
        ),
      ),
    ).toBeNull();
    const project = posix.join(refused.work, ".claude", "skills");
    refused.resources.runtime.reservedSkillDirectories = [project];
    expect(
      known(
        refused.host.specialSessionWriteRule?.(
          posix.join(project, "x", "a.md"),
          refused.policy,
          refused.scope,
        ),
      ),
    ).toBeNull();
    const missing = world({ skillAdmission: "missing" });
    const result = missing.host.specialSessionWriteRule?.(
      posix.join(missing.home, ".claude", "skills", "x", "a.md"),
      missing.policy,
      missing.scope,
    );
    expect(result?.status).toBe("unsupported");
    if (result?.status === "unsupported")
      expect(result.dependency).toBe("Zte/oae");
  });

  test("a session Edit rule qualifies only for a config subtree without nested config folders", () => {
    const w = world();
    const eligible = (raw: string, paths: readonly string[]) =>
      known(w.host.sessionEditRuleEligible?.(raw, paths, w.policy, w.scope));
    const skill = posix.join(w.work, ".claude", "skills", "a", "x.md");
    expect(eligible("Edit(/.claude/skills/**)", [skill])).toBe(true);
    expect(eligible("Edit", [skill])).toBe(false);
    expect(eligible("Edit(/src/**)", [skill])).toBe(false);
    expect(eligible("Edit(/.claude/../src/**)", [skill])).toBe(false);
    expect(eligible("Edit(/.claude/skills/a)", [skill])).toBe(false);
    expect(
      eligible("Edit(/.claude/**)", [
        posix.join(w.work, ".claude", "a", ".claude", "x"),
      ]),
    ).toBe(false);
    const user = posix.join(w.home, ".claude", "agents", "x.md");
    expect(eligible("Edit(~/.claude/**)", [user])).toBe(true);
    expect(
      eligible("Edit(~/.claude/**)", [
        posix.join(w.home, ".claude", "x", ".Claude", "y"),
      ]),
    ).toBe(false);
  });

  test("the write path shape counts config folders past the launch root", () => {
    const w = world();
    const shape = (path: string) =>
      known(w.host.writePathShape?.(path, w.policy, w.scope));
    expect(shape(posix.join(w.work, ".claude", "a", ".claude", "b"))).toEqual({
      suspiciousNetwork: false,
      nestedConfigDirectories: 2,
    });
    expect(shape(posix.join(w.work, "PROGRA~1", "x"))).toEqual({
      suspiciousNetwork: true,
      nestedConfigDirectories: 0,
    });
  });
});

describe("outside-working-directory fences", () => {
  test("each fence setting names itself in the refusal", () => {
    const w = world();
    const target = w.file(posix.join(w.outside, "secret.txt"));
    const fence = (settings: Partial<NativeProtectedReadOptions> = {}) =>
      known(
        w.host.readFence?.(
          target,
          w.inspection(target),
          { file_path: target },
          w.policy,
          {
            restricted: w.policy.restricted,
            blockOutsideReads: true,
            transcriptsJudged: true,
            ...settings,
          },
          w.scope,
        ),
      );
    w.policy.blockReadsOutsideWorkingDirectories = true;
    const reads = fence();
    expect(reads?.behavior).toBe("deny");
    expect(reads?.message).toContain(
      "permissions.blockReadsOutsideWorkingDirectories setting blocks",
    );
    expect(reads?.message).toContain("/add-dir");
    w.policy.blockFileToolReadsOutsideWorkingDirectories = true;
    const both = fence();
    expect(both?.message).toContain("settings block");
    expect(both?.message).not.toContain("/add-dir");
    w.policy.blockReadsOutsideWorkingDirectories = false;
    const fileTools = fence();
    expect(fileTools === null ? "" : reason(fileTools)).toContain(
      "blockFileToolReadsOutsideWorkingDirectories",
    );
    w.policy.restricted = true;
    const restricted = fence({ restricted: true });
    expect(restricted === null ? "" : reason(restricted)).toContain(
      "--restricted",
    );
    expect(restricted?.message).toContain("--restricted confines");
  });

  test("an exempt path and an inside path pass the read fence", () => {
    const w = world();
    w.policy.blockReadsOutsideWorkingDirectories = true;
    const target = w.file(posix.join(w.outside, "exempt.txt"));
    const inside = w.file(posix.join(w.work, "inside.txt"));
    const fence = (path: string) =>
      known(
        w.host.readFence?.(
          path,
          w.inspection(path),
          { file_path: path },
          w.policy,
          {
            restricted: false,
            blockOutsideReads: true,
            transcriptsJudged: true,
          },
          w.scope,
        ),
      );
    expect(fence(inside)).toBeNull();
    expect(fence(target)?.behavior).toBe("deny");
    w.policy.readBlockExemptPaths = [w.outside];
    expect(fence(target)).toBeNull();
  });

  test("a protected readable file passes the fence unless protected exceptions are blocked", () => {
    const w = world();
    w.policy.blockFileToolReadsOutsideWorkingDirectories = true;
    const temp = w.file(posix.join(w.root, "project-temp", "x.txt"));
    const fence = () =>
      known(
        w.host.readFence?.(
          temp,
          w.inspection(temp),
          { file_path: temp },
          w.policy,
          {
            restricted: false,
            blockOutsideReads: true,
            transcriptsJudged: true,
          },
          w.scope,
        ),
      );
    expect(fence()).toBeNull();
    w.resources.blockFileReadProtectedExceptions = true;
    expect(fence()?.behavior).toBe("deny");
  });

  test("a path the fence cannot resolve is refused with the generic text", () => {
    const w = world();
    w.policy.blockReadsOutsideWorkingDirectories = true;
    const loop = posix.join(w.work, "loop");
    symlinkSync(loop, loop);
    const path = posix.join(loop, "x");
    const outcome = known(
      w.host.readFence?.(
        path,
        w.inspection(path),
        { file_path: path },
        w.policy,
        { restricted: false, blockOutsideReads: true, transcriptsJudged: true },
        w.scope,
      ),
    );
    expect(outcome?.message).toContain("could not be determined");
  });

  test("a link inside the working folder that leads outside names its landing", () => {
    const w = world();
    w.policy.blockReadsOutsideWorkingDirectories = true;
    const target = w.file(posix.join(w.outside, "t.txt"));
    const link = posix.join(w.work, "link.txt");
    symlinkSync(target, link);
    const outcome = known(
      w.host.readFence?.(
        link,
        w.inspection(link),
        { file_path: link },
        w.policy,
        { restricted: false, blockOutsideReads: true, transcriptsJudged: true },
        w.scope,
      ),
    );
    expect(outcome?.message).toContain("resolves through a symlink");
    expect(outcome?.blockedPath).toBe(target);
  });

  test("on macOS a case-only mismatch with a working folder is pointed out", () => {
    const w = world();
    w.policy.blockReadsOutsideWorkingDirectories = true;
    const path = posix.join(w.root, "WORK", "absent.txt");
    const outcome = known(
      w.host.readFence?.(
        path,
        w.inspection(path),
        { file_path: path },
        w.policy,
        { restricted: false, blockOutsideReads: true, transcriptsJudged: true },
        w.scope,
      ),
    );
    expect(outcome?.message).toContain("letter case counts");
  });

  test("the write fence refuses outside writes and settings files", () => {
    const w = world();
    w.policy.blockWritesOutsideWorkingDirectories = true;
    const outside = posix.join(w.outside, "x.txt");
    const refused = w.floor(outside);
    expect(refused === undefined ? "" : reason(refused)).toContain(
      "blockWritesOutsideWorkingDirectories",
    );
    const settings = w.floor(posix.join(w.work, ".claude", "settings.json"));
    expect(settings?.behavior).toBe("deny");
    expect(settings === undefined ? "" : reason(settings)).toContain(
      "settings file can lift that block",
    );
    expect(w.floor(posix.join(w.work, "plain.txt"))).toBeUndefined();
  });

  test("an initial read root decides whether the launch folder stays inside the fence", () => {
    const w = world();
    w.policy.blockFileToolReadsOutsideWorkingDirectories = true;
    const launchFile = w.file(posix.join(w.work, "in-launch.txt"));
    const fence = () =>
      known(
        w.host.readFence?.(
          launchFile,
          w.inspection(launchFile),
          { file_path: launchFile },
          w.policy,
          {
            restricted: false,
            blockOutsideReads: true,
            transcriptsJudged: true,
          },
          w.scope,
        ),
      );
    w.resources.initialReadRoot = w.root;
    expect(fence()).toBeNull();
    w.resources.initialReadRoot = w.outside;
    expect(fence()?.behavior).toBe("deny");
    w.resources.initialReadRoot = null;
    expect(fence()?.behavior).toBe("deny");
    w.resources.extraWorkingDirectories = [
      { path: w.root, source: "session", readFenceAdmitted: true },
    ];
    expect(fence()).toBeNull();
    w.resources.extraWorkingDirectories = [
      { path: w.root, source: "session", readFenceAdmitted: false },
    ];
    expect(fence()?.behavior).toBe("deny");
    w.resources.initialReadRoot = w.outside;
    w.resources.launchContextRoot = null;
    expect(fence()?.behavior).toBe("deny");
  });

  test("without the file-tool fence, project-settings extra folders do not widen it", () => {
    const w = world();
    w.policy.blockReadsOutsideWorkingDirectories = true;
    const target = w.file(posix.join(w.outside, "x.txt"));
    const fence = () =>
      known(
        w.host.readFence?.(
          target,
          w.inspection(target),
          { file_path: target },
          w.policy,
          {
            restricted: false,
            blockOutsideReads: true,
            transcriptsJudged: true,
          },
          w.scope,
        ),
      );
    w.resources.extraWorkingDirectories = [
      { path: w.outside, source: "projectSettings", readFenceAdmitted: true },
    ];
    expect(fence()?.behavior).toBe("deny");
    w.resources.extraWorkingDirectories = [
      { path: w.outside, source: "session", readFenceAdmitted: false },
    ];
    expect(fence()).toBeNull();
  });
});

describe("sensitive write screen", () => {
  test("project command, agent and skill folders need a person outside remote mode", () => {
    const w = world();
    const skill = posix.join(w.work, ".claude", "skills", "a", "SKILL.md");
    expect(w.sensitive(skill)).toMatchObject({
      safe: false,
      classifierApprovable: true,
    });
    w.policy.isRemoteMode = true;
    expect(w.sensitive(skill)).toEqual({ safe: true });
    for (const change of [
      () => (w.policy.mode = "auto"),
      () => {
        w.policy.mode = "plan";
        w.policy.prePlanMode = "auto";
      },
      () => {
        w.policy.mode = "plan";
        w.policy.strippedDangerousRules = true;
      },
      () => (w.policy.modeBeforeRewrite = "auto"),
      () => (w.policy.restricted = true),
    ]) {
      w.policy.mode = "default";
      w.policy.prePlanMode = undefined;
      w.policy.strippedDangerousRules = undefined;
      w.policy.modeBeforeRewrite = undefined;
      w.policy.restricted = false;
      change();
      expect(w.sensitive(skill).safe).toBe(false);
    }
    w.policy.mode = "plan";
    w.policy.prePlanMode = "default";
    w.policy.strippedDangerousRules = false;
    w.policy.modeBeforeRewrite = undefined;
    w.policy.restricted = false;
    expect(w.sensitive(skill)).toEqual({ safe: true });
  });

  test("a suspicious Windows spelling also flags a possible settings file", () => {
    const w = world();
    const plain = w.sensitive(posix.join(w.work, "PROGRA~1", "x.txt"));
    expect(plain).toMatchObject({ circuitBreaker: "suspiciousWindowsPath" });
    expect(plain.safe === false ? plain.also : []).toBeUndefined();
    const settings = w.sensitive(
      posix.join(w.work, ".claude", "settings.json"),
      [
        posix.join(w.work, ".claude", "settings.json"),
        posix.join(w.work, "SETTIN~1.JSO"),
      ],
    );
    expect(settings).toMatchObject({
      circuitBreaker: "suspiciousWindowsPath",
      also: ["claudeSettingsFile"],
    });
  });

  test("settings files are flagged, and a linked one names the settings file", () => {
    const w = world();
    const project = w.sensitive(
      posix.join(w.work, ".claude", "settings.local.json"),
    );
    expect(project).toMatchObject({
      safe: false,
      classifierApprovable: true,
      circuitBreaker: "claudeSettingsFile",
    });
    const target = w.file(posix.join(w.outside, "real-settings.json"), "{}");
    symlinkSync(target, posix.join(w.config, "settings.json"));
    // Settings links are re-read only after two seconds of monotonic time.
    expect(w.sensitive(target)).toEqual({ safe: true });
    w.clock.now = 2000;
    const linked = w.sensitive(target);
    expect(linked).toMatchObject({
      safe: false,
      classifierApprovable: false,
      circuitBreaker: "claudeSettingsFile",
    });
    expect(linked.safe === false ? linked.message : "").toContain(
      "leads here through a link",
    );
    w.clock.now = 3999;
    expect(w.sensitive(target).safe).toBe(false);
  });

  test("named settings sources, managed folders and the policy folder are settings", () => {
    const w = world();
    const source = posix.join(w.outside, "flag-settings.json");
    w.resources.protected.settingsSourcePaths = [source];
    expect(w.sensitive(source).safe).toBe(false);
    const managed = posix.join(w.root, "managed");
    w.resources.protected.managedSettingsDirectories = [managed];
    expect(w.sensitive(posix.join(managed, "any.json")).safe).toBe(false);
    const policy = posix.join(w.root, "policy", "managed-settings.json");
    w.resources.protected.policySettingsPath = policy;
    expect(w.sensitive(posix.join(w.root, "policy")).safe).toBe(false);
    expect(w.sensitive(posix.join(w.root, "elsewhere.txt"))).toEqual({
      safe: true,
    });
  });

  test("a managed folder reached through a link or a missing tail still counts", () => {
    const w = world();
    const real = posix.join(w.root, "real-managed");
    mkdirSync(real);
    const alias = posix.join(w.root, "alias-managed");
    symlinkSync(real, alias);
    w.resources.protected.managedSettingsDirectories = [
      posix.join(alias, "missing", "deeper"),
    ];
    expect(
      w.sensitive(posix.join(real, "missing", "deeper", "x.json")).safe,
    ).toBe(false);
    expect(w.sensitive(posix.join(real, "x.json"))).toEqual({ safe: true });
  });

  test("an unresolvable managed folder makes any JSON write possibly a settings file", () => {
    const w = world();
    const loop = posix.join(w.root, "loop");
    symlinkSync(loop, loop);
    w.resources.protected.managedSettingsDirectories = [
      posix.join(loop, "managed"),
    ];
    expect(w.sensitive(posix.join(w.outside, "data.json"))).toMatchObject({
      safe: false,
      circuitBreaker: "claudeSettingsFile",
    });
    expect(w.sensitive(posix.join(w.outside, "data.txt"))).toEqual({
      safe: true,
    });
    // A file in the way (ENOTDIR) is a definite answer, not an unknown.
    const blocker = w.file(posix.join(w.root, "blocker"));
    w.resources.protected.managedSettingsDirectories = [
      posix.join(blocker, "managed"),
    ];
    expect(w.sensitive(posix.join(w.outside, "data.json"))).toEqual({
      safe: true,
    });
  });

  test("settings files under a template root are protected through its physical path", () => {
    const w = world();
    const real = posix.join(w.root, "remote-real");
    mkdirSync(real);
    const alias = posix.join(w.root, "remote-alias");
    symlinkSync(real, alias);
    w.resources.protected.settingsFiles = [
      posix.join(alias, "conf", "remote-settings.json"),
    ];
    w.resources.protected.settingsBodyTemplates = [
      { root: alias, relativePaths: ["conf/remote-settings.json"] },
      { root: posix.join(w.root, "absent"), relativePaths: ["x"] },
    ];
    expect(
      w.sensitive(posix.join(real, "conf", "remote-settings.json")).safe,
    ).toBe(false);
    expect(
      w.sensitive(posix.join(real, "conf", "other-settings.json")),
    ).toEqual({ safe: true });
  });

  test("a config folder spelled through a link keeps its settings protected", () => {
    const w = world();
    const real = posix.join(w.root, "real-config");
    mkdirSync(real);
    const alias = posix.join(w.root, "alias-config");
    symlinkSync(real, alias);
    w.resources.configDirectory = alias;
    expect(w.sensitive(posix.join(real, "settings.json")).safe).toBe(false);
    expect(w.sensitive(posix.join(real, "notes.json"))).toEqual({ safe: true });
  });

  test("network spellings are sensitive unless trusted", () => {
    const w = world();
    expect(w.sensitive("/net/host/share/x.txt")).toMatchObject({
      safe: false,
      classifierApprovable: true,
    });
    expect(w.sensitive("/Network/Servers/host/x.txt").safe).toBe(false);
  });

  test("diskless sessions and plain files", () => {
    const w = world();
    expect(w.sensitive(posix.join(w.work, "src", "a.ts"))).toEqual({
      safe: true,
    });
    w.resources.diskless = true;
    expect(w.sensitive(posix.join(w.work, "src", "a.ts"))).toMatchObject({
      safe: false,
      classifierApprovable: false,
    });
  });
});

describe("network reads", () => {
  const tool = (name: string) => ({
    name,
    getPath: (input: Input) => input.file_path,
  });

  test("each network surface asks with its own reason", () => {
    const w = world();
    const network = (path: string, name = "Read") =>
      known(
        w.host.networkRead?.(
          tool(name),
          { file_path: path },
          w.policy,
          [path],
          w.scope,
        ),
      );
    expect(network("//server/share/x")?.decisionReason).toMatchObject({
      reason: "UNC path detected (defense-in-depth check)",
    });
    expect(network("/net/host/x")?.decisionReason).toMatchObject({
      reason: "Automount -hosts path detected (defense-in-depth check)",
    });
    expect(network("/Network/Library/x")?.decisionReason).toMatchObject({
      reason: "Automount browse surface detected (defense-in-depth check)",
    });
    expect(network("/.vol/1/2")?.decisionReason).toMatchObject({
      reason:
        "Kernel-resolved path prefix (/.vol etc.) detected (defense-in-depth check)",
    });
    expect(network(posix.join(w.work, "x"))).toBeNull();
    const suspicious = network(posix.join(w.work, "PROGRA~1"));
    expect(suspicious?.behavior).toBe("ask");
    expect(suspicious?.message).toContain("suspicious Windows path");
  });

  test("a Glob pattern is screened for every network surface", () => {
    const w = world();
    const glob = (pattern: string) =>
      known(
        w.host.networkRead?.(
          tool("Glob"),
          Object.assign({ file_path: w.work }, { pattern }),
          w.policy,
          [w.work],
          w.scope,
        ),
      );
    expect(glob("//server/share/*")?.decisionReason).toMatchObject({
      reason: "UNC glob pattern detected (defense-in-depth check)",
    });
    expect(glob("/net/host/*")?.decisionReason).toMatchObject({
      reason: "Automount -hosts glob pattern detected (defense-in-depth check)",
    });
    expect(glob("/Network/Library/*")?.decisionReason).toMatchObject({
      reason:
        "Automount browse surface glob pattern detected (defense-in-depth check)",
    });
    expect(glob("/.vol/*")?.decisionReason).toMatchObject({
      reason:
        "Kernel-resolved path prefix (/.vol etc.) glob pattern detected (defense-in-depth check)",
    });
    expect(glob("**/*.ts")).toBeNull();
  });

  test("a tool without a path and a trusted network folder are not screened", () => {
    const w = world();
    expect(
      known(
        w.host.networkRead?.(
          { name: "Read" },
          { file_path: "//server/share/x" },
          w.policy,
          [],
          w.scope,
        ),
      ),
    ).toBeNull();
    w.policy.trustedNetworkDirectories = ["//server/share"];
    expect(
      known(
        w.host.networkRead?.(
          tool("Read"),
          { file_path: "//server/share/x" },
          w.policy,
          ["//server/share/x"],
          w.scope,
        ),
      ),
    ).toBeNull();
  });
});

describe("permission suggestions", () => {
  test("outside reads suggest the parent folder and outside writes add it", () => {
    const w = world();
    const target = w.file(posix.join(w.outside, "x.txt"));
    const suggest = (family: "read" | "write", path = target) =>
      known(w.host.suggestions?.(path, family, [path], w.policy, w.scope));
    expect(suggest("read")).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: "/" + w.outside + "/**" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(suggest("read", w.outside)[0]).toMatchObject({
      rules: [{ ruleContent: "/" + w.outside + "/**" }],
    });
    expect(suggest("write")).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      {
        type: "addDirectories",
        directories: [w.outside],
        destination: "session",
      },
    ]);
    w.policy.mode = "plan";
    w.policy.prePlanMode = "bypassPermissions";
    expect(suggest("write", posix.join(w.work, "a.txt"))).toEqual([]);
    w.policy.prePlanMode = "default";
    expect(suggest("write", posix.join(w.work, "a.txt"))).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    w.policy.mode = "default";
    w.policy.modeBeforeRewrite = "auto";
    expect(suggest("write", posix.join(w.work, "a.txt"))).toEqual([]);
    expect(suggest("read", "/net/host/x/y")[0]).toMatchObject({
      rules: [{ ruleContent: "//net/host/x/**" }],
    });
  });
});
