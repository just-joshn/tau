import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  AgentHookOriginUnsupportedError,
  agentHookOriginFolder,
  createAgentHookOriginResolver,
  type AgentHookOriginContext,
} from "../src/agent-hook-origin.js";

const signal = () => new AbortController().signal;
const definition = {
  source: "projectSettings",
  baseDir: "/owned/.claude/agents",
};

test("origin folder follows exact case-sensitive native B without cwd, trim or realpath guesses", () => {
  assert.equal(agentHookOriginFolder("/owned/.claude/agents"), "/owned");
  assert.equal(agentHookOriginFolder("/owned/.claude/agents/"), "/owned");
  assert.equal(
    agentHookOriginFolder("/owned/.CLAUDE/agents"),
    "/owned/.CLAUDE/agents",
  );
  assert.equal(
    agentHookOriginFolder("/owned/.claude/Agents"),
    "/owned/.claude/Agents",
  );
  assert.equal(agentHookOriginFolder("/owned/agents"), "/owned/agents");
  assert.equal(agentHookOriginFolder("/owned/other"), "/owned/other");
  assert.equal(agentHookOriginFolder(" /owned "), " /owned ");
});

test("trusted sources bypass persisted lookup while cancellation remains a host floor", async () => {
  const resolver = createAgentHookOriginResolver({
    context: () => {
      throw new Error("Source branch must not inspect global trust");
    },
    resolveProjectIdentity: () => {
      throw new Error("Source branch must not inspect folder");
    },
    restrictedProjectKey: () => {
      throw new Error("Source branch must not inspect key");
    },
  });
  for (const source of [
    "plugin",
    "policySettings",
    "built-in",
    "builtin",
    "bundled",
    "userSettings",
    "flagSettings",
  ])
    assert.equal(
      await resolver.trusted({ source, baseDir: "/untrusted" }, signal()),
      true,
    );
  const controller = new AbortController();
  controller.abort(new Error("OWNED ABORT"));
  await assert.rejects(
    resolver.trusted({ source: "userSettings" }, controller.signal),
    /OWNED ABORT/,
  );
});

test("project hook admission requires its exact persisted key, with no ancestor/current acceptance", async () => {
  const folders: string[] = [];
  let keys: readonly string[] = ["/owned"];
  const resolver = createAgentHookOriginResolver({
    context: () => ({ persistedTrustEnabled: true, trustedProjectKeys: keys }),
    resolveProjectIdentity: (folder) => {
      folders.push(folder);
      return { projectKey: folder };
    },
    restrictedProjectKey: () => false,
  });
  const nested = {
    source: "projectSettings",
    baseDir: "/owned/nested/.claude/agents",
  };
  assert.equal(await resolver.trusted(nested, signal()), false);
  assert.deepEqual(folders, ["/owned/nested"]);
  keys = ["/owned/nested"];
  const admitted = await resolver.inspect(nested, signal());
  assert.equal(admitted.trusted, true);
  assert.equal(admitted.reason, "persisted-record");
  assert.deepEqual(admitted.keys, ["/owned/nested"]);
  assert.equal(Object.isFrozen(admitted.keys), true);
  assert.equal(
    await resolver.trusted(
      { source: "projectSettings", baseDir: "/additional/.claude/agents" },
      signal(),
    ),
    false,
  );
});

test("canonical project identity comes only from the supplied native resolver and preserves exact key spelling", async () => {
  let keys = ["/canonical/main"];
  const resolver = createAgentHookOriginResolver({
    context: () => ({ persistedTrustEnabled: true, trustedProjectKeys: keys }),
    resolveProjectIdentity: () => ({ projectKey: "/canonical/main" }),
    restrictedProjectKey: () => false,
  });
  assert.equal(await resolver.trusted(definition, signal()), true);
  keys = ["/CANONICAL/main", "/canonical/main/"];
  assert.equal(await resolver.trusted(definition, signal()), false);
});

test("no-baseDir wg requires explicit nonempty workspace roots and every persisted key", async () => {
  let context: AgentHookOriginContext = {
    persistedTrustEnabled: true,
    trustedProjectKeys: ["first", "second"],
    workspaceRoots: ["/first", "/second"],
  };
  const folders: string[] = [];
  const resolver = createAgentHookOriginResolver({
    context: () => context,
    resolveProjectIdentity: (folder) => {
      folders.push(folder);
      return { projectKey: folder.slice(1) };
    },
    restrictedProjectKey: () => false,
  });
  assert.equal(
    await resolver.trusted({ source: "projectSettings" }, signal()),
    true,
  );
  assert.deepEqual(folders, ["/first", "/second"]);
  context = { ...context, trustedProjectKeys: ["first"] };
  assert.equal(
    await resolver.trusted(
      { source: "projectSettings", baseDir: "" },
      signal(),
    ),
    false,
  );
  context = { ...context, workspaceRoots: [] };
  assert.equal(
    (await resolver.inspect({ source: "projectSettings" }, signal())).reason,
    "empty-workspace",
  );
  context = { persistedTrustEnabled: true, trustedProjectKeys: [] };
  await assert.rejects(
    resolver.trusted({ source: "projectSettings" }, signal()),
    AgentHookOriginUnsupportedError,
  );
});

test("unknown persisted records or identity are explicit unsupported; known empty records deny", async () => {
  let context: AgentHookOriginContext = { persistedTrustEnabled: true };
  let key: string | null = "/owned";
  const resolver = createAgentHookOriginResolver({
    context: () => context,
    resolveProjectIdentity: () => ({ projectKey: key }),
    restrictedProjectKey: () => false,
  });
  await assert.rejects(
    resolver.trusted(definition, signal()),
    AgentHookOriginUnsupportedError,
  );
  context = { persistedTrustEnabled: true, trustedProjectKeys: [] };
  assert.equal(await resolver.trusted(definition, signal()), false);
  key = null;
  await assert.rejects(
    resolver.trusted(
      { source: "projectSettings", baseDir: "/other" },
      signal(),
    ),
    AgentHookOriginUnsupportedError,
  );
  context = { persistedTrustEnabled: false };
  assert.equal(
    (await resolver.inspect(definition, signal())).reason,
    "persisted-trust-disabled",
  );
});

test("native M identity cache is per raw definition baseDir and never caches policy or trust decisions", async () => {
  let keys = ["/owned"],
    disabled = false;
  const calls: string[] = [];
  const resolver = createAgentHookOriginResolver({
    context: () => ({
      persistedTrustEnabled: !disabled,
      trustedProjectKeys: keys,
    }),
    resolveProjectIdentity: (folder) => {
      calls.push(folder);
      return { projectKey: folder };
    },
    restrictedProjectKey: () => false,
  });
  assert.equal(await resolver.trusted(definition, signal()), true);
  keys = [];
  assert.equal(await resolver.trusted(definition, signal()), false);
  disabled = true;
  assert.equal(await resolver.trusted(definition, signal()), false);
  disabled = false;
  keys = ["/owned"];
  assert.equal(await resolver.trusted(definition, signal()), true);
  assert.deepEqual(calls, ["/owned"]);
  assert.equal(
    await resolver.trusted(
      { ...definition, baseDir: "/owned/.claude/agents/" },
      signal(),
    ),
    true,
  );
  assert.deepEqual(calls, ["/owned", "/owned"]);
});

test("failed and aborted identity resolutions do not poison another invocation's cache or signal", async () => {
  let calls = 0;
  const controller = new AbortController();
  const resolver = createAgentHookOriginResolver({
    context: () => ({
      persistedTrustEnabled: true,
      trustedProjectKeys: ["/owned"],
    }),
    resolveProjectIdentity: () => {
      calls++;
      if (calls === 1) throw new Error("OWNED RESOLUTION FAILURE");
      if (calls === 2) controller.abort(new Error("OWNED LATE ABORT"));
      return Promise.resolve({ projectKey: "/owned" });
    },
    restrictedProjectKey: () => false,
  });
  await assert.rejects(
    resolver.trusted(definition, signal()),
    /OWNED RESOLUTION FAILURE/,
  );
  await assert.rejects(
    resolver.trusted(definition, controller.signal),
    /OWNED LATE ABORT/,
  );
  assert.equal(await resolver.trusted(definition, signal()), true);
  assert.equal(calls, 3);
});

test("policy and exact-key restrictions stay live after async identity resolution", async () => {
  let context: AgentHookOriginContext = {
    persistedTrustEnabled: true,
    trustedProjectKeys: ["/owned"],
  };
  let restricted = false;
  const resolver = createAgentHookOriginResolver({
    context: () => context,
    resolveProjectIdentity: async () => {
      await Promise.resolve();
      context = { ...context, trustedProjectKeys: [] };
      return { projectKey: "/owned" };
    },
    restrictedProjectKey: () => restricted,
  });
  assert.equal(await resolver.trusted(definition, signal()), false);
  context = { ...context, trustedProjectKeys: ["/owned"] };
  restricted = true;
  assert.equal(
    (await resolver.inspect(definition, signal())).reason,
    "restricted-key",
  );
  restricted = false;
  assert.equal(await resolver.trusted(definition, signal()), true);
});

test("a no-base workspace root change during async resolution is explicit unsupported", async () => {
  let roots = ["/owned"];
  const resolver = createAgentHookOriginResolver({
    context: () => ({
      persistedTrustEnabled: true,
      trustedProjectKeys: ["/owned"],
      workspaceRoots: roots,
    }),
    resolveProjectIdentity: async () => {
      await Promise.resolve();
      roots = ["/different"];
      return { projectKey: "/owned" };
    },
    restrictedProjectKey: () => false,
  });
  await assert.rejects(
    resolver.trusted({ source: "projectSettings" }, signal()),
    /Workspace roots changed/,
  );
});

test("workspace every short-circuits a missing first record before an unsupported later root", async () => {
  const calls: string[] = [];
  const resolver = createAgentHookOriginResolver({
    context: () => ({
      persistedTrustEnabled: true,
      trustedProjectKeys: [],
      workspaceRoots: ["/missing", "/unsupported"],
    }),
    resolveProjectIdentity: (folder) => {
      calls.push(folder);
      return { projectKey: folder === "/unsupported" ? null : folder };
    },
    restrictedProjectKey: () => false,
  });
  assert.equal(
    await resolver.trusted({ source: "projectSettings" }, signal()),
    false,
  );
  assert.deepEqual(calls, ["/missing"]);
});

test("persisted trust disablement during an awaited resolution cannot produce admission", async () => {
  let enabled = true;
  const resolver = createAgentHookOriginResolver({
    context: () => ({
      persistedTrustEnabled: enabled,
      trustedProjectKeys: ["/owned"],
    }),
    resolveProjectIdentity: async () => {
      await Promise.resolve();
      enabled = false;
      return { projectKey: "/owned" };
    },
    restrictedProjectKey: () => false,
  });
  assert.equal(
    (await resolver.inspect(definition, signal())).reason,
    "persisted-trust-disabled",
  );
});

test("concurrent callers never share an abort signal or replace the first successful cached identity", async () => {
  let release: ((value: { projectKey: string }) => void) | undefined;
  let calls = 0;
  const firstSignal = new AbortController();
  const resolver = createAgentHookOriginResolver({
    context: () => ({
      persistedTrustEnabled: true,
      trustedProjectKeys: ["/first", "/second"],
    }),
    resolveProjectIdentity: () => {
      calls++;
      return calls === 1
        ? new Promise<{ projectKey: string }>((resolve) => {
            release = resolve;
          })
        : { projectKey: "/second" };
    },
    restrictedProjectKey: () => false,
  });
  const first = resolver.inspect(definition, firstSignal.signal);
  const second = await resolver.inspect(definition, signal());
  assert.deepEqual(second.keys, ["/second"]);
  if (!release) throw new Error("Owned deferred resolution missing");
  release({ projectKey: "/first" });
  assert.deepEqual((await first).keys, ["/second"]);
  firstSignal.abort();
  assert.equal(await resolver.trusted(definition, signal()), true);
  assert.equal(calls, 2);
});
