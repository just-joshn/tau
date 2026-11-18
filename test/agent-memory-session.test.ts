import { onTestFinished, test } from "bun:test";
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
import {
  agentMemoryModelPolicyDisablesMemory,
  agentMemoryRegistryOptions,
  createAgentMemorySession,
  resolveAgentMemorySessionGate,
  type AgentMemorySessionFacts,
  type AgentMemorySessionOptions,
} from "../src/agent-memory-session.js";
import {
  createLocalAgentRegistry,
  type LocalAgentDefinition,
} from "../src/agent-definitions.js";
import {
  agentMemoryEnabled,
  resolveAgentMemoryLocation,
} from "../src/agent-memory.js";
import { createTools } from "../src/tools.js";
import { ReadState } from "../src/read-state.js";

const signal = () => new AbortController().signal;
const facts = (): AgentMemorySessionFacts => ({
  session: { memoryToggledOff: false, autoMemoryOffThisSession: false },
  profile: { safeMode: false, restricted: false, confined: false },
  environment: {},
  settings: {},
  modelSelection: { initialMainLoopModel: "claude-sonnet-4-6" },
  filePolicy: {
    remoteSurface: false,
    blockOutsideReads: false,
    blockOutsideWrites: false,
  },
});
const definition = (): LocalAgentDefinition => ({
  agentType: "owned-reader",
  source: "projectSettings",
  prompt: "OWNED MEMORY AGENT",
  whenToUse: "Owned memory fixture",
  skills: [],
  memory: "user",
  tools: ["Read"],
});
async function fixture(changes: Partial<AgentMemorySessionOptions> = {}) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "tau-owned-memory-session-")),
  );
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const cwd = join(directory, "work"),
    config = join(directory, "config");
  await mkdir(cwd);
  await mkdir(config);
  const roots = { workingDirectory: cwd, configurationDirectory: config };
  const options: AgentMemorySessionOptions = {
    roots,
    facts,
    admitDefinition: () => true,
    authorizePromptResource: () => true,
    resolveFileIdentity: async ({ requestedPath }) => ({
      canonicalPath: await realpath(requestedPath),
      paths: [],
    }),
    admitFileIdentity: () => true,
    authorizeFileFloors: () => true,
    ...changes,
  };
  const location = resolveAgentMemoryLocation(
    definition().agentType,
    "user",
    roots,
  );
  await mkdir(location.directory, { recursive: true });
  return {
    directory,
    cwd,
    config,
    roots,
    options,
    location,
    session: createAgentMemorySession(options),
  };
}

test("model memory policy follows host override and literal matching, not child aliases or catalog family guesses", () => {
  const policy = {
    disabledModelPatterns: [null, "", 1, "SONNET-4"],
    disableMatchingModels: true,
  };
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      { initialMainLoopModel: "claude-sonnet-4-6" },
      policy,
    ),
    true,
  );
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      { initialMainLoopModel: "claude-sonnet-420250101" },
      policy,
    ),
    false,
  );
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      { mainLoopModelOverride: "", initialMainLoopModel: "claude-sonnet-4-6" },
      policy,
    ),
    false,
  );
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      {
        mainLoopModelOverride: "haiku",
        initialMainLoopModel: "claude-sonnet-4-6",
      },
      policy,
    ),
    false,
  );
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      { initialMainLoopModel: "claude-sonnet-4-6" },
      { ...policy, disableMatchingModels: false },
    ),
    false,
  );
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      { initialMainLoopModel: "claude-opus-5-5" },
      undefined,
    ),
    false,
  );
  assert.equal(
    agentMemoryModelPolicyDisablesMemory(
      { initialMainLoopModel: "claude-sonnet-420250101/sonnet-4-6" },
      policy,
    ),
    true,
  );
});

test("ordinary resolved gates preserve source environment precedence and profile/session floors", () => {
  const state = facts();
  state.environment = {
    CLAUDE_CODE_REMOTE: "yes",
    CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "   ",
  };
  assert.equal(agentMemoryRegistryOptions(state).memoryEnabled, false);
  state.environment = { CLAUDE_CODE_REMOTE: "0", CLAUDE_CODE_SIMPLE: "false" };
  assert.equal(agentMemoryRegistryOptions(state).memoryEnabled, true);
  state.environment = {
    CLAUDE_CODE_REMOTE: "true",
    CLAUDE_CODE_REMOTE_MEMORY_DIR: "   ",
  };
  assert.equal(
    resolveAgentMemorySessionGate(state).remoteWithoutMemoryRoot,
    false,
  ); // raw root is truthy
  state.environment = {
    CLAUDE_CODE_SIMPLE: "true",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: " false ",
  };
  state.settings.autoMemoryEnabled = false;
  state.features = {
    disabledModelPatterns: ["sonnet"],
    disableMatchingModels: true,
  };
  assert.equal(agentMemoryEnabled(resolveAgentMemorySessionGate(state)), true);
  for (const name of ["safeMode", "restricted", "confined"] as const) {
    state.profile[name] = true;
    assert.equal(agentMemoryRegistryOptions(state).memoryEnabled, false);
    state.profile[name] = false;
  }
  state.environment = {
    CLAUDE_CODE_SAFE_MODE: "yes",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "false",
  };
  assert.equal(agentMemoryRegistryOptions(state).memoryEnabled, false);
  state.environment = {};
  state.settings = {};
  delete state.features;
  state.session.memoryToggledOff = true;
  assert.equal(agentMemoryRegistryOptions(state).memoryEnabled, false);
});

test("registry tool augmentation is parse-time metadata, retains disallows, and doesn't waive parent tool-pool admission", async () => {
  const { cwd } = await fixture(),
    folder = join(cwd, "agents");
  await mkdir(folder);
  await writeFile(
    join(folder, "owned-reader.md"),
    "---\nname: owned-reader\ndescription: Owned reader\ntools: Read\ndisallowedTools: Write\nmemory: user\n---\nOWNED AGENT BODY\n",
  );
  const registry = await createLocalAgentRegistry({
    locations: [{ directory: folder, source: "projectSettings" }],
    ...agentMemoryRegistryOptions(facts()),
  });
  const def = await registry.resolve("owned-reader");
  assert.ok(def);
  assert.deepEqual(def.tools, ["Read", "Write", "Edit"]);
  assert.deepEqual(def.disallowedTools, ["Write"]);
  const parentPool = ["Read"];
  assert.deepEqual(
    def.tools?.filter(
      (name) =>
        parentPool.includes(name) && !def.disallowedTools?.includes(name),
    ),
    ["Read"],
  );
  const disabled = facts();
  disabled.settings.autoMemoryEnabled = false;
  const off = await createLocalAgentRegistry({
    locations: [{ directory: folder, source: "projectSettings" }],
    ...agentMemoryRegistryOptions(disabled),
  });
  assert.deepEqual((await off.resolve("owned-reader"))?.tools, ["Read"]);
});

test("memory prompt requires admitted definition/resources separately from ordinary Read permission", async () => {
  const operations: string[] = [];
  const { options, location } = await fixture({
    authorizePromptResource: (access) => {
      operations.push(access.operation);
      return true;
    },
    authorizeFileFloors: () => false,
  });
  await writeFile(location.indexPath, "OWNED LOADED INDEX");
  const session = createAgentMemorySession(options),
    prepared = await session.prepare(definition(), signal());
  assert.equal(prepared.enabled, true);
  assert.deepEqual(prepared.handledFeatures, ["memory"]);
  assert.match(prepared.systemPrompt, /OWNED LOADED INDEX/);
  assert.deepEqual(operations, ["initialize", "prompt-read"]);
  assert.equal(
    await session.fileAccess.automaticFileAllowance({
      operation: "Read",
      requestedPath: location.indexPath,
      canonicalPath: await realpath(location.indexPath),
      signal: signal(),
    }),
    false,
  );
  const denied = createAgentMemorySession({
    ...options,
    admitDefinition: () => false,
  });
  await assert.rejects(
    denied.prepare(definition(), signal()),
    /definition admission/,
  );
  const withheld = createAgentMemorySession({
    ...options,
    authorizePromptResource: () => false,
  });
  await assert.rejects(
    withheld.prepare(definition(), signal()),
    /admission denied/,
  );
});

test("identity admission preserves later real asks; automatic allowances hold without issuing approval", async () => {
  let floorChecks = 0,
    approvals = 0;
  const { options, location, cwd } = await fixture({
    authorizeFileFloors: () => {
      floorChecks++;
      return false;
    },
  });
  await writeFile(location.indexPath, "OWNED EXISTING INDEX");
  const session = createAgentMemorySession(options),
    canonicalPath = await realpath(location.indexPath);
  assert.equal(
    await session.fileAccess.extraPathAdmission({
      operation: "Write",
      requestedPath: location.indexPath,
      signal: signal(),
    }),
    canonicalPath,
  );
  assert.equal(floorChecks, 0);
  assert.equal(
    await session.fileAccess.automaticFileAllowance({
      operation: "Write",
      requestedPath: location.indexPath,
      canonicalPath,
      signal: signal(),
    }),
    false,
  );
  assert.equal(floorChecks, 1);
  const tools = createTools({
    cwd,
    mode: "default",
    policy: { allowedTools: [], disallowedTools: [], askedTools: ["Read"] },
    extraPathAdmission: session.fileAccess.extraPathAdmission,
    approve: async () => {
      approvals++;
      return false;
    },
  });
  const result = await tools.execute(
    {
      type: "tool_use",
      id: "owned-ask",
      name: "Read",
      input: { file_path: location.indexPath },
    },
    signal(),
  );
  assert.equal(result.is_error, true);
  assert.equal(approvals, 1);
  assert.equal(
    await readFile(location.indexPath, "utf8"),
    "OWNED EXISTING INDEX",
  );
});

test("native candidate remains independent of Gg while read/write and remote/restricted fences remain distinct", async () => {
  const state = facts();
  state.session.memoryToggledOff = true;
  const { options, location } = await fixture({ facts: () => state });
  await writeFile(location.indexPath, "OWNED");
  const session = createAgentMemorySession(options),
    request = {
      operation: "Write",
      requestedPath: location.indexPath,
      canonicalPath: await realpath(location.indexPath),
      signal: signal(),
    } satisfies Parameters<typeof session.fileAccess.automaticFileAllowance>[0];
  assert.equal((await session.prepare(definition(), signal())).enabled, false);
  assert.equal(session.nativeFileAllowanceCandidate(request), true);
  assert.equal(await session.fileAccess.automaticFileAllowance(request), true);
  assert.equal(
    session.nativeFileAllowanceCandidate({
      ...request,
      operation: "Read",
      requestedPath: location.indexPath + ".bin",
    }),
    true,
  );
  assert.equal(
    session.nativeFileAllowanceCandidate({
      ...request,
      requestedPath: location.indexPath + ".bin",
    }),
    false,
  );
  state.filePolicy.remoteSurface = true;
  assert.equal(
    session.nativeFileAllowanceCandidate({ ...request, operation: "Read" }),
    false,
  );
  assert.equal(session.nativeFileAllowanceCandidate(request), true);
  state.profile.restricted = true;
  assert.equal(session.nativeFileAllowanceCandidate(request), false);
});

test("strict host identity extension rejects canonical escapes and stale identity, without pretending source lexical recognition did so", async () => {
  const { options, location } = await fixture();
  await writeFile(location.indexPath, "OWNED");
  const escape = createAgentMemorySession({
    ...options,
    resolveFileIdentity: async () => ({
      canonicalPath: "/owned/outside.md",
      paths: [],
    }),
  });
  const request = {
    operation: "Read",
    requestedPath: location.indexPath,
    canonicalPath: "/owned/outside.md",
    signal: signal(),
  } satisfies Parameters<typeof escape.fileAccess.automaticFileAllowance>[0];
  assert.equal(escape.nativeFileAllowanceCandidate(request), true);
  assert.equal(await escape.fileAccess.extraPathAdmission(request), undefined);
  assert.equal(await escape.fileAccess.automaticFileAllowance(request), false);
  const normal = createAgentMemorySession(options);
  assert.equal(
    await normal.fileAccess.automaticFileAllowance({
      ...request,
      canonicalPath: location.indexPath + "-stale",
    }),
    false,
  );
  const crossAgent = join(location.directory, "..", "OTHER", "topic.md");
  const broader = createAgentMemorySession({
    ...options,
    resolveFileIdentity: async () => ({ canonicalPath: crossAgent, paths: [] }),
  });
  assert.equal(
    await broader.fileAccess.extraPathAdmission({
      ...request,
      requestedPath: crossAgent,
    }),
    crossAgent,
  );
});

test("ordinary file executor retains read baseline, isolated read state and durable Read/Edit/Write workflow", async () => {
  const { cwd, location, session } = await fixture();
  await writeFile(location.indexPath, "OWNED ORIGINAL");
  const tools = createTools({
    cwd,
    mode: "acceptEdits",
    extraPathAdmission: session.fileAccess.extraPathAdmission,
    approve: async () => false,
    readState: new ReadState(),
  });
  const call = async (
    id: string,
    name: "Read" | "Write" | "Edit",
    input: unknown,
  ) => tools.execute({ type: "tool_use", id, name, input }, signal());
  const premature = await call("write-before-read", "Write", {
    file_path: location.indexPath,
    content: "SHOULD NOT WRITE",
  });
  assert.equal(premature.is_error, true);
  assert.equal(await readFile(location.indexPath, "utf8"), "OWNED ORIGINAL");
  assert.equal(
    (await call("read-index", "Read", { file_path: location.indexPath }))
      .is_error ?? false,
    false,
  );
  assert.equal(
    (
      await call("edit-index", "Edit", {
        file_path: location.indexPath,
        old_string: "ORIGINAL",
        new_string: "EDITED",
      })
    ).is_error ?? false,
    false,
  );
  assert.equal(
    (
      await call("write-index", "Write", {
        file_path: location.indexPath,
        content: "OWNED PERSISTED INDEX",
      })
    ).is_error ?? false,
    false,
  );
  assert.match(
    (await session.prepare(definition(), signal())).systemPrompt,
    /OWNED PERSISTED INDEX/,
  );
  const sibling = createTools({
    cwd,
    mode: "acceptEdits",
    extraPathAdmission: session.fileAccess.extraPathAdmission,
    approve: async () => false,
    readState: new ReadState(),
  });
  assert.equal(
    (
      await sibling.execute(
        {
          type: "tool_use",
          id: "sibling-no-baseline",
          name: "Edit",
          input: {
            file_path: location.indexPath,
            old_string: "PERSISTED",
            new_string: "WRONG",
          },
        },
        signal(),
      )
    ).is_error,
    true,
  );
  assert.equal(
    await readFile(location.indexPath, "utf8"),
    "OWNED PERSISTED INDEX",
  );
});

test("live policy, cancellation and disabled prompt publication cannot silently reuse admission", async () => {
  const state = facts();
  const { options, location } = await fixture({
    facts: () => state,
    authorizeFileFloors: () => {
      state.filePolicy.blockOutsideWrites = true;
      return true;
    },
  });
  await writeFile(location.indexPath, "OWNED");
  const session = createAgentMemorySession(options),
    request = {
      operation: "Edit",
      requestedPath: location.indexPath,
      canonicalPath: await realpath(location.indexPath),
      signal: signal(),
    } satisfies Parameters<typeof session.fileAccess.automaticFileAllowance>[0];
  assert.equal(await session.fileAccess.automaticFileAllowance(request), false);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    session.fileAccess.extraPathAdmission({
      ...request,
      signal: aborted.signal,
    }),
  );
  state.filePolicy.blockOutsideWrites = false;
  const disappearing = createAgentMemorySession({
    ...options,
    readPrimedUserIndex: async () => {
      state.session.memoryToggledOff = true;
      return "SHOULD NOT PUBLISH";
    },
  });
  const prepared = await disappearing.prepare(definition(), signal());
  assert.equal(prepared.enabled, false);
  assert.equal(prepared.systemPrompt, "");
});
