import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  builtinAgentProfile,
  builtinOmitClaudeMdPolicy,
  createBuiltinAgentCatalog,
  createExplorePlanAvailability,
  DEFAULT_BUILTIN_SUBAGENT_TYPE,
  EXPLORATION_DISALLOWED_TOOLS,
  resolveBuiltinAgentModelSpec,
  resolveDefaultSubagentType,
  type BuiltinAgentCatalogOptions,
} from "../src/builtin-agent-definitions.js";
import { createLocalAgentRegistry } from "../src/agent-definitions.js";

function agentNamed<T extends { agentType: string }>(
  definitions: readonly T[],
  agentType: string,
): T {
  const agent = definitions.find(
    (candidate) => candidate.agentType === agentType,
  );
  assert.ok(agent, `missing built-in agent ${agentType}`);
  return agent;
}
function withoutExplorePlan(): BuiltinAgentCatalogOptions {
  const invalid = options();
  Reflect.set(invalid, "explorePlanEnabled", undefined);
  return invalid;
}
function options(
  changes: Partial<BuiltinAgentCatalogOptions> = {},
): BuiltinAgentCatalogOptions {
  return {
    profile: "default",
    promptContext: "subagent",
    safeMode: false,
    agentViewDisabled: true,
    explorePlanEnabled: true,
    entrypoint: "owned-cli",
    guideToolMode: "native-search",
    webFetch: { enabled: false },
    deniedAgentTypes: [],
    isToolDenied: () => false,
    isToolEnabled: () => true,
    ...changes,
  };
}

test("ordinary built-in catalog provides exact default identity and independently authored frozen definitions", async () => {
  const catalog = await createBuiltinAgentCatalog(options());
  assert.deepEqual(
    catalog.definitions.map((agent) => agent.agentType),
    [
      "general-purpose",
      "statusline-setup",
      "Explore",
      "Plan",
      "claude-code-guide",
    ],
  );
  const general = catalog.definitions[0];
  assert.ok(general);
  assert.equal(general.source, "built-in");
  assert.equal(general.baseDir, "built-in");
  assert.deepEqual(general.tools, ["*"]);
  assert.equal(general.model, undefined);
  assert.equal(general.permissionMode, undefined);
  assert.equal(
    resolveDefaultSubagentType(catalog.definitions),
    DEFAULT_BUILTIN_SUBAGENT_TYPE,
  );
  assert.ok(general.prompt.length > 30 && general.prompt.length < 400);
  assert.throws(
    () => Reflect.apply(Array.prototype.push, general.tools, ["Bash"]),
    TypeError,
  );
  assert.ok(Object.isFrozen(general) && Object.isFrozen(catalog.definitions));
});

test("headless disable precedence, safe mode, entrypoint and explore/plan latch have exact gates", async () => {
  assert.equal(
    builtinAgentProfile({
      headless: true,
      disableBuiltinAgents: "0",
      coordinator: true,
    }),
    "none",
  );
  assert.equal(
    builtinAgentProfile({
      headless: false,
      disableBuiltinAgents: "1",
      coordinator: false,
    }),
    "default",
  );
  assert.equal(
    builtinAgentProfile({
      headless: true,
      disableBuiltinAgents: "",
      coordinator: true,
    }),
    "coordinator",
  );
  let raw: string | undefined;
  const first = createExplorePlanAvailability(() => raw);
  assert.equal(first(), true);
  raw = "1";
  assert.equal(first(), true);
  const disabled = createExplorePlanAvailability(() => raw);
  assert.equal(disabled(), false);
  raw = undefined;
  assert.equal(disabled(), false);
  for (const entrypoint of ["sdk-ts", "sdk-py", "sdk-cli"]) {
    const catalog = await createBuiltinAgentCatalog(
      options({ safeMode: true, explorePlanEnabled: false, entrypoint }),
    );
    assert.deepEqual(
      catalog.definitions.map((agent) => agent.agentType),
      ["general-purpose"],
    );
  }
  assert.equal(
    (await createBuiltinAgentCatalog(options({ profile: "none" }))).definitions
      .length,
    0,
  );
  const coordinator = await createBuiltinAgentCatalog(
    options({ profile: "coordinator" }),
  );
  assert.equal(coordinator.definitions.length, 0);
  assert.deepEqual(coordinator.unsupportedCapabilities, [
    { capability: "coordinator-agents" },
  ]);
  await assert.rejects(
    createBuiltinAgentCatalog(withoutExplorePlan()),
    /Explicit built-in host capabilities/,
  );
});

test("Explore and Plan inherit tool pool with actual deny floor and do not manufacture plan mode", async () => {
  const catalog = await createBuiltinAgentCatalog(options());
  for (const name of ["Explore", "Plan"]) {
    const agent = agentNamed(catalog.definitions, name);
    assert.equal(agent.tools, undefined);
    assert.deepEqual(agent.disallowedTools, EXPLORATION_DISALLOWED_TOOLS);
    assert.equal(agent.model, "inherit");
    assert.equal(agent.omitClaudeMd, true);
    assert.equal(agent.permissionMode, undefined);
    assert.ok(!agent.disallowedTools?.includes("Bash"));
    assert.ok(agent.disallowedTools?.includes("NotebookEdit"));
  }
});

test("bounded-tool availability uses deny floors and WebFetch policy without pretending parent tool pool is permissions", async () => {
  const catalog = await createBuiltinAgentCatalog(
    options({
      webFetch: { enabled: true, model: "inherit" },
      isToolDenied: (name) => ["Read", "Edit"].includes(name),
      isToolEnabled: () => false,
    }),
  );
  assert.ok(
    !catalog.definitions.some(
      (agent) => agent.agentType === "statusline-setup",
    ),
  );
  assert.ok(
    !catalog.definitions.some((agent) => agent.agentType === "web-fetch"),
  );
  assert.ok(
    catalog.definitions.some(
      (agent) => agent.agentType === "claude-code-guide",
    ),
  ); // Glob/Grep remain source-enabled.
  assert.ok(
    catalog.definitions.some((agent) => agent.agentType === "general-purpose"),
  );
  assert.ok(catalog.definitions.some((agent) => agent.agentType === "Explore"));
  assert.equal(
    catalog.diagnostics.filter(
      (item) => item.code === "all-declared-tools-unavailable",
    ).length,
    2,
  );
});

test("exact subtype deny/allow filters precede offer admission and do not add a wildcard subtype grammar", async () => {
  const offered: string[] = [];
  const catalog = await createBuiltinAgentCatalog(
    options({
      deniedAgentTypes: ["Explore", "Plan*", "general-purpose:*"],
      allowedAgentTypes: ["general-purpose", "Explore", "Plan"],
      offer: (definition) => {
        offered.push(definition.agentType);
        return definition.agentType === "Plan" ? "owned offer withheld" : true;
      },
    }),
  );
  assert.deepEqual(
    catalog.definitions.map((agent) => agent.agentType),
    ["general-purpose"],
  );
  assert.deepEqual(offered, ["general-purpose", "Plan"]);
  assert.ok(
    catalog.diagnostics.some(
      (item) =>
        item.code === "denied-agent-type" && item.agentType === "Explore",
    ),
  );
  assert.ok(
    catalog.diagnostics.some(
      (item) =>
        item.code === "not-offered" && item.reason === "owned offer withheld",
    ),
  );
});

test("claude append-system mode requires a real adapter and never silently substitutes its prompt", async () => {
  const child = await createBuiltinAgentCatalog(
    options({
      agentViewDisabled: false,
      appendSystemPrompt: () => {
        throw new Error("Main-thread adapter must not run in a child");
      },
    }),
  );
  assert.ok(child.definitions.some((agent) => agent.agentType === "claude"));
  assert.deepEqual(child.appendedSystemPromptAgents, []);
  assert.deepEqual(child.nativeAppendSystemPromptAgents, ["claude"]);
  const unavailable = await createBuiltinAgentCatalog(
    options({ agentViewDisabled: false, promptContext: "main-thread" }),
  );
  assert.ok(
    !unavailable.definitions.some((agent) => agent.agentType === "claude"),
  );
  assert.deepEqual(unavailable.unsupportedCapabilities, [
    { agentType: "claude", capability: "append-system-prompt" },
  ]);
  let calls = 0;
  const admitted = await createBuiltinAgentCatalog(
    options({
      agentViewDisabled: false,
      promptContext: "main-thread",
      appendSystemPrompt: (prompt, definition) => {
        calls++;
        assert.equal(definition.agentType, "claude");
        assert.ok(Object.isFrozen(definition));
        return `OWNED BASE SYSTEM\n${prompt}`;
      },
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(admitted.appendedSystemPromptAgents, ["claude"]);
  assert.match(
    agentNamed(admitted.definitions, "claude").prompt,
    /^OWNED BASE SYSTEM/,
  );
  await assert.rejects(
    createBuiltinAgentCatalog(
      options({
        agentViewDisabled: false,
        promptContext: "main-thread",
        appendSystemPrompt: () => "",
      }),
    ),
    /nonempty system prompt/,
  );
});

test("guide and web-fetch retain their distinct source tools, models, turns, mode and metadata", async () => {
  const native = await createBuiltinAgentCatalog(
    options({ webFetch: { enabled: true, model: "haiku" } }),
  );
  const guide = agentNamed(native.definitions, "claude-code-guide");
  assert.deepEqual(guide.tools, [
    "Glob",
    "Grep",
    "Read",
    "WebFetch",
    "WebSearch",
  ]);
  assert.equal(guide.model, "haiku");
  assert.equal(guide.permissionMode, "dontAsk");
  const bash = await createBuiltinAgentCatalog(
    options({ guideToolMode: "bash" }),
  );
  assert.deepEqual(agentNamed(bash.definitions, "claude-code-guide").tools, [
    "Bash",
    "Read",
    "WebFetch",
    "WebSearch",
  ]);
  const web = agentNamed(native.definitions, "web-fetch");
  assert.deepEqual(web.tools, ["WebFetch"]);
  assert.equal(web.model, "haiku");
  assert.equal(web.maxTurns, 15);
  assert.equal(web.omitClaudeMd, true);
  assert.equal(web.color, "blue");
});

test("Explore model cap uses explicit catalog capability callback and source identity", () => {
  const explore = {
    agentType: "Explore",
    source: "built-in",
    model: "inherit",
  } as const;
  let calls = 0;
  const policy = {
    firstParty: true,
    disableExploreInheritCap: undefined,
    aboveOpusFamilyCap: (model: string) => {
      calls++;
      return model === "owned-above-opus";
    },
  };
  assert.deepEqual(
    resolveBuiltinAgentModelSpec(explore, "owned-above-opus", policy),
    { inheritCap: "opus" },
  );
  assert.equal(
    resolveBuiltinAgentModelSpec(explore, "owned-opus", policy),
    "inherit",
  );
  assert.equal(
    resolveBuiltinAgentModelSpec(explore, "owned-above-opus", {
      ...policy,
      firstParty: false,
    }),
    "inherit",
  );
  assert.equal(
    resolveBuiltinAgentModelSpec(explore, "owned-above-opus", {
      ...policy,
      disableExploreInheritCap: "0",
    }),
    "inherit",
  );
  assert.equal(
    resolveBuiltinAgentModelSpec(
      { ...explore, source: "projectSettings", model: "owned-model" },
      "owned-above-opus",
      policy,
    ),
    "owned-model",
  );
  assert.equal(calls, 2);
});

test("default resolution preserves exact spelling, canonical ambiguity and allowed-type scope", () => {
  assert.equal(
    resolveDefaultSubagentType([{ agentType: "GENERAL_PURPOSE" }]),
    "GENERAL_PURPOSE",
  );
  assert.equal(
    resolveDefaultSubagentType([
      { agentType: "GeneralPurpose" },
      { agentType: "GENERAL_PURPOSE" },
    ]),
    undefined,
  );
  assert.equal(
    resolveDefaultSubagentType([
      { agentType: "GeneralPurpose" },
      { agentType: "general-purpose" },
    ]),
    "general-purpose",
  );
  assert.equal(
    resolveDefaultSubagentType([{ agentType: "general-purpose" }], []),
    undefined,
  );
  assert.equal(
    resolveDefaultSubagentType(
      [{ agentType: "GENERAL_PURPOSE" }],
      ["general-purpose"],
    ),
    undefined,
  );
});

test("registry consumes admitted builtin definitions and custom precedence still owns exact names", async () => {
  const catalog = await createBuiltinAgentCatalog(options());
  const builtin = agentNamed(catalog.definitions, "general-purpose");
  const registry = await createLocalAgentRegistry({
    locations: [],
    definitions: [
      ...catalog.definitions,
      {
        ...builtin,
        source: "projectSettings",
        prompt: "OWNED CUSTOM TASK PROMPT",
      },
    ],
  });
  assert.equal(
    (await registry.resolve("general-purpose"))?.prompt,
    "OWNED CUSTOM TASK PROMPT",
  );
  assert.equal((await registry.resolve("Explore"))?.source, "built-in");
});

test("omitClaudeMd distinguishes builtin/policy initial removal from managed-only custom resolution", () => {
  assert.equal(
    builtinOmitClaudeMdPolicy("built-in", false),
    "omit-all-initial-claude-md",
  );
  assert.equal(
    builtinOmitClaudeMdPolicy("policySettings", false),
    "omit-all-initial-claude-md",
  );
  assert.equal(
    builtinOmitClaudeMdPolicy("projectSettings", false),
    "managed-subset-host-resolution",
  );
  assert.equal(
    builtinOmitClaudeMdPolicy("built-in", true),
    "keep-supplied-context",
  );
});
