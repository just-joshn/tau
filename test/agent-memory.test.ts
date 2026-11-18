import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  agentMemoryAutomaticFileAllowance,
  agentMemoryDeclaredTools,
  agentMemoryEnabled,
  agentMemoryName,
  createAgentMemoryHost,
  recognizeAgentMemoryPath,
  resolveAgentMemoryLocation,
  truncateAgentMemoryIndex,
  type AgentMemoryGate,
  type AgentMemoryHostOptions,
  type AgentMemoryRoots,
} from "../src/agent-memory.js";
import type { LocalAgentDefinition } from "../src/agent-definitions.js";

const signal = () => new AbortController().signal;
const definition = (
  scope: "user" | "project" | "local" = "project",
): LocalAgentDefinition => ({
  agentType: "owned:Reader",
  source: "projectSettings",
  whenToUse: "owned fixture",
  prompt: "OWNED TASK",
  skills: [],
  memory: scope,
});
async function fixture(): Promise<{
  roots: AgentMemoryRoots;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tau-owned-agent-memory-"));
  const roots = {
    workingDirectory: join(directory, "work"),
    configurationDirectory: join(directory, "config"),
  };
  await mkdir(roots.workingDirectory);
  await mkdir(roots.configurationDirectory);
  return { roots, directory };
}
const hostOptions = (
  roots: AgentMemoryRoots,
  changes: Partial<AgentMemoryHostOptions> = {},
): AgentMemoryHostOptions => ({
  roots,
  enabled: () => true,
  admitDefinition: () => true,
  authorize: () => true,
  persistFile: async ({ path, content }) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
  },
  ...changes,
});
const gate = (changes: Partial<AgentMemoryGate> = {}): AgentMemoryGate => ({
  memoryToggledOff: false,
  autoMemoryOffThisSession: false,
  safeMode: false,
  restricted: false,
  confined: false,
  disableAutoMemory: undefined,
  simple: false,
  remoteWithoutMemoryRoot: false,
  modelGateDisablesMemory: false,
  autoMemoryEnabled: undefined,
  ...changes,
});

test("full agent identity is case-preserving sanitized UTF16 with source collisions visible", () => {
  assert.equal(agentMemoryName("plugin:Reader/Sub"), "plugin-Reader-Sub");
  assert.equal(agentMemoryName(""), "unknown");
  assert.equal(agentMemoryName("a🧭b"), "a--b");
  assert.equal(agentMemoryName("a:b"), agentMemoryName("a/b"));
  const roots = {
    workingDirectory: "/owned/work/subdir",
    configurationDirectory: "/owned/config",
  };
  assert.equal(
    resolveAgentMemoryLocation("Name", "project", roots).directory,
    "/owned/work/subdir/.claude/agent-memory/Name/",
  );
  assert.equal(
    resolveAgentMemoryLocation("Name", "local", roots).directory,
    "/owned/work/subdir/.claude/agent-memory-local/Name/",
  );
  assert.equal(
    resolveAgentMemoryLocation("Name", "user", roots).indexPath,
    "/owned/config/agent-memory/Name/MEMORY.md",
  );
});

test("remote override relocates user/local memory and requires exact host project-key identity", () => {
  const roots = {
    workingDirectory: "/owned/work",
    configurationDirectory: "/owned/config",
    remoteMemoryDirectory: "/owned/remote",
    remoteProjectKey: "-canonical-project-key",
  };
  assert.equal(
    resolveAgentMemoryLocation("n", "user", roots).directory,
    "/owned/remote/agent-memory/n/",
  );
  assert.equal(
    resolveAgentMemoryLocation("n", "local", roots).directory,
    "/owned/remote/projects/-canonical-project-key/agent-memory-local/n/",
  );
  assert.equal(
    resolveAgentMemoryLocation("n", "project", roots).directory,
    "/owned/work/.claude/agent-memory/n/",
  );
  assert.throws(
    () =>
      resolveAgentMemoryLocation("n", "local", {
        ...roots,
        remoteProjectKey: "../escape",
      }),
    /project key/,
  );
  assert.throws(
    () =>
      resolveAgentMemoryLocation("n", "user", {
        ...roots,
        configurationDirectory: "relative",
      }),
    /absolute/,
  );
});

test("enablement forced-on bypasses model/settings/simple but never session/safe/restricted/confinement floors", () => {
  assert.equal(agentMemoryEnabled(gate()), true);
  assert.equal(agentMemoryEnabled(gate({ autoMemoryEnabled: false })), false);
  assert.equal(
    agentMemoryEnabled(
      gate({
        disableAutoMemory: " OFF ",
        autoMemoryEnabled: false,
        modelGateDisablesMemory: true,
        simple: true,
        remoteWithoutMemoryRoot: true,
      }),
    ),
    true,
  );
  assert.equal(agentMemoryEnabled(gate({ disableAutoMemory: "yes" })), false);
  for (const floor of [
    "memoryToggledOff",
    "autoMemoryOffThisSession",
    "safeMode",
    "restricted",
    "confined",
  ] as const)
    assert.equal(
      agentMemoryEnabled(gate({ [floor]: true, disableAutoMemory: "false" })),
      false,
    );
});

test("broad native recognition covers other agents and rejects reserved confusable path segments", () => {
  const roots = {
    workingDirectory: "/owned/work",
    configurationDirectory: "/owned/config",
  };
  assert.ok(
    recognizeAgentMemoryPath(
      "/owned/config/agent-memory/OTHER/topic.bin",
      roots,
    ),
  );
  assert.ok(
    recognizeAgentMemoryPath(
      "/owned/work/.claude/agent-memory-local/OTHER/topic.md",
      roots,
    ),
  );
  for (const part of [
    ".git",
    "Hooks.",
    "ſkills",
    "confıg",
    "a\u202egents",
    "commands:stream",
    "node_modules",
  ]) {
    assert.equal(
      recognizeAgentMemoryPath(
        `/owned/config/agent-memory/OTHER/${part}/topic.md`,
        roots,
      ),
      undefined,
    );
  }
  assert.equal(
    recognizeAgentMemoryPath(
      "/owned/config/agent-memory-lookalike/OTHER/topic.md",
      roots,
    ),
    undefined,
  );
  assert.equal(
    recognizeAgentMemoryPath(
      "/owned/config/agent-memory/OTHER/../../outside.md",
      roots,
    ),
    undefined,
  );
  assert.ok(
    recognizeAgentMemoryPath(
      "/owned/remote/projects/another-key/arbitrary/agent-memory-local/OTHER/topic.md",
      { ...roots, remoteMemoryDirectory: "/owned/remote" },
    ),
  );
});

test("automatic allowance candidates preserve source read/write differences without becoming authorization", () => {
  const roots = {
      workingDirectory: "/owned/work",
      configurationDirectory: "/owned/config",
    },
    path = "/owned/config/agent-memory/OTHER/topic.md";
  const floor = {
    confined: false,
    restricted: false,
    remoteSurface: false,
    blockOutsideReads: false,
    blockOutsideWrites: false,
  };
  assert.equal(
    agentMemoryAutomaticFileAllowance(path, "write", roots, floor),
    true,
  );
  assert.equal(
    agentMemoryAutomaticFileAllowance(path + ".bin", "write", roots, floor),
    false,
  );
  assert.equal(
    agentMemoryAutomaticFileAllowance(path + ".bin", "read", roots, floor),
    true,
  );
  assert.equal(
    agentMemoryAutomaticFileAllowance(path, "read", roots, {
      ...floor,
      remoteSurface: true,
    }),
    false,
  );
  assert.equal(
    agentMemoryAutomaticFileAllowance(path, "write", roots, {
      ...floor,
      remoteSurface: true,
    }),
    true,
  );
  assert.equal(
    agentMemoryAutomaticFileAllowance(path, "write", roots, {
      ...floor,
      restricted: true,
    }),
    false,
  );
  assert.equal(
    agentMemoryAutomaticFileAllowance(path, "write", roots, {
      ...floor,
      blockOutsideWrites: true,
    }),
    false,
  );
});

test("declaration tool extension does not remove explicit denies or grant execution", () => {
  const tools = ["Read", "Bash"];
  assert.deepEqual(agentMemoryDeclaredTools(tools, "user", true), [
    "Read",
    "Bash",
    "Write",
    "Edit",
  ]);
  assert.deepEqual(tools, ["Read", "Bash"]);
  assert.equal(agentMemoryDeclaredTools(undefined, "user", true), undefined);
  assert.deepEqual(agentMemoryDeclaredTools([], "local", true), [
    "Write",
    "Edit",
    "Read",
  ]);
  assert.deepEqual(agentMemoryDeclaredTools(["Read"], "user", false), ["Read"]);
});

test("index truncation uses source200line and25000UTF16 bounds after trim", () => {
  const lines = Array.from({ length: 201 }, (_, index) => `line${index}`).join(
    "\n",
  );
  assert.equal(
    truncateAgentMemoryIndex(" \n" + lines + " \n").content.split("\n").length,
    200,
  );
  assert.equal(truncateAgentMemoryIndex(lines).lineTruncated, true);
  const unicode = truncateAgentMemoryIndex("é".repeat(25_000));
  assert.equal(unicode.unitTruncated, false);
  assert.equal(Buffer.byteLength(unicode.content), 50_000);
  const limited = truncateAgentMemoryIndex("first\n" + "x".repeat(25_000));
  assert.equal(limited.content, "first");
  assert.equal(limited.unitTruncated, true);
});

test("persistent workflow initializes, writes through ordinary adapter, reloads index and isolates topic content", async () => {
  const { roots } = await fixture(),
    accesses: string[] = [],
    writes: string[] = [];
  const host = createAgentMemoryHost(
    hostOptions(roots, {
      authorize: (access) => {
        accesses.push(access.operation);
        return true;
      },
      persistFile: async (access) => {
        writes.push(access.path);
        await mkdir(join(access.path, ".."), { recursive: true });
        await writeFile(access.path, access.content);
      },
    }),
  );
  const initial = await host.prepare(definition(), signal());
  assert.match(initial.prompt, /index is empty/);
  await host.writeTopic(
    definition(),
    "MEMORY.md",
    "OWNED INDEX: see topic.md",
    signal(),
  );
  await host.writeTopic(
    definition(),
    "topic.md",
    "OWNED TOPIC DETAIL SHOULD NOT AUTO-INLINE",
    signal(),
  );
  const restarted = createAgentMemoryHost(hostOptions(roots)),
    context = await restarted.prepare(definition(), signal());
  assert.match(context.prompt, /OWNED INDEX/);
  assert.doesNotMatch(context.prompt, /SHOULD NOT AUTO-INLINE/);
  assert.equal(
    await restarted.readTopic(definition(), "topic.md", signal()),
    "OWNED TOPIC DETAIL SHOULD NOT AUTO-INLINE",
  );
  assert.deepEqual(accesses, [
    "initialize",
    "prompt-read",
    "write-topic",
    "write-topic",
  ]);
  assert.equal(writes.length, 2);
});

test("per-operation denial and absent persistence adapter prevent a candidate automatic allowance from writing", async () => {
  const { roots } = await fixture();
  let persisted = false;
  const host = createAgentMemoryHost(
    hostOptions(roots, {
      authorize: (access) => access.operation !== "write-topic",
      persistFile: async () => {
        persisted = true;
      },
    }),
  );
  await host.prepare(definition(), signal());
  await assert.rejects(
    host.writeTopic(definition(), "topic.md", "owned", signal()),
    /admission denied/,
  );
  assert.equal(persisted, false);
  const noWriterOptions = hostOptions(roots);
  delete noWriterOptions.persistFile;
  const noWriter = createAgentMemoryHost(noWriterOptions);
  await assert.rejects(
    noWriter.writeTopic(definition(), "topic.md", "owned", signal()),
    /persistence adapter/,
  );
  await assert.rejects(
    host.writeTopic(definition(), "../escape.md", "owned", signal()),
    /leaves its scope/,
  );
});

test("project/local leaf links and folder escapes yield read-only prompts; user regular-file links are admitted explicitly", async () => {
  const { roots, directory } = await fixture(),
    target = join(directory, "owned-target.md");
  await writeFile(target, "OWNED LINK CONTENT");
  const project = resolveAgentMemoryLocation(
    definition().agentType,
    "project",
    roots,
  );
  await mkdir(project.directory, { recursive: true });
  await symlink(target, project.indexPath);
  const host = createAgentMemoryHost(hostOptions(roots));
  const refused = await host.prepare(definition(), signal());
  assert.equal(refused.readOnly, true);
  assert.doesNotMatch(refused.prompt, /OWNED LINK CONTENT/);
  const user = resolveAgentMemoryLocation(
    definition().agentType,
    "user",
    roots,
  );
  await mkdir(user.directory, { recursive: true });
  await symlink(target, user.indexPath);
  let canonical: string | undefined;
  const following = createAgentMemoryHost(
    hostOptions(roots, {
      authorize: (access) => {
        if (access.operation === "prompt-read")
          canonical = access.canonicalPath;
        return true;
      },
    }),
  );
  assert.match(
    (await following.prepare(definition("user"), signal())).prompt,
    /OWNED LINK CONTENT/,
  );
  assert.equal(canonical, await realpath(target));
  const escapedDefinition = { ...definition(), agentType: "escape" };
  const escaped = resolveAgentMemoryLocation("escape", "project", roots);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await symlink(outside, escaped.directory.slice(0, -sep.length));
  assert.equal(
    (await host.prepare(escapedDefinition, signal())).readOnly,
    true,
  );
  const dangling = resolveAgentMemoryLocation("dangling", "project", roots);
  await symlink(
    join(roots.workingDirectory, "missing-target"),
    dangling.directory.slice(0, -sep.length),
  );
  assert.equal(
    (await host.prepare({ ...definition(), agentType: "dangling" }, signal()))
      .readOnly,
    true,
  );
});

test("storage user priming is root-specific, miss/failure is empty without disk fallback or directory creation", async () => {
  const { roots } = await fixture();
  let reads = 0;
  const host = createAgentMemoryHost(
    hostOptions(roots, {
      readPrimedUserIndex: async (name) => {
        reads++;
        assert.equal(name, "owned-Reader");
        return "OWNED PRIMED INDEX";
      },
    }),
  );
  const context = await host.prepare(definition("user"), signal());
  assert.match(context.prompt, /OWNED PRIMED INDEX/);
  assert.equal(reads, 1);
  await assert.rejects(access(context.location.directory));
  const disk = resolveAgentMemoryLocation(
    definition().agentType,
    "user",
    roots,
  );
  await mkdir(disk.directory, { recursive: true });
  await writeFile(disk.indexPath, "DISK MUST NOT FALL BACK");
  const failure = createAgentMemoryHost(
    hostOptions(roots, {
      readPrimedUserIndex: async () => {
        throw new Error("owned storage miss");
      },
    }),
  );
  const empty = await failure.prepare(definition("user"), signal());
  assert.doesNotMatch(empty.prompt, /DISK MUST NOT/);
  assert.deepEqual(empty.diagnostics, ["primed-memory-read-failed"]);
  const remote = {
    ...roots,
    remoteMemoryDirectory: join(roots.configurationDirectory, "remote"),
  };
  const remoteDisk = resolveAgentMemoryLocation(
    definition().agentType,
    "user",
    remote,
  );
  await mkdir(remoteDisk.directory, { recursive: true });
  await writeFile(remoteDisk.indexPath, "REMOTE DISK INDEX");
  const otherRoot = createAgentMemoryHost(
    hostOptions(remote, {
      readPrimedUserIndex: async () => {
        throw new Error("Wrong root must not prime");
      },
    }),
  );
  assert.match(
    (await otherRoot.prepare(definition("user"), signal())).prompt,
    /REMOTE DISK INDEX/,
  );
});

test("host read limits, disabled memory, definition admission and cancellation have no silent partial publication", async () => {
  const { roots } = await fixture(),
    location = resolveAgentMemoryLocation(
      definition().agentType,
      "project",
      roots,
    );
  const disabled = createAgentMemoryHost(
    hostOptions(roots, { enabled: () => false }),
  );
  assert.equal((await disabled.prepare(definition(), signal())).enabled, false);
  await assert.rejects(access(location.directory));
  const denied = createAgentMemoryHost(
    hostOptions(roots, { admitDefinition: () => false }),
  );
  await assert.rejects(
    denied.prepare(definition(), signal()),
    /definition admission/,
  );
  await mkdir(location.directory, { recursive: true });
  await writeFile(location.indexPath, "too large");
  const limited = createAgentMemoryHost(
    hostOptions(roots, { maxReadBytes: 3 }),
  );
  await assert.rejects(
    limited.prepare(definition(), signal()),
    /host read bound/,
  );
  assert.equal(await readFile(location.indexPath, "utf8"), "too large");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    limited.prepare(definition(), abort.signal),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  let enabled = true;
  const switched = createAgentMemoryHost(
    hostOptions(roots, {
      enabled: () => enabled,
      readPrimedUserIndex: async () => {
        enabled = false;
        return "OWNED LATE PRIVATE MEMORY";
      },
    }),
  );
  const held = await switched.prepare(definition("user"), signal());
  assert.equal(held.enabled, false);
  assert.equal(held.prompt, "");
});
