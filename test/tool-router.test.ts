import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../src/options.js";
import { routeExternalTools, type ExternalToolRegistry } from "../src/tool-router.js";
import { createTools } from "../src/tools.js";
import type { PermissionMode } from "../src/types.js";

const name = "mcp__fixture__lookup";
function fixture(mode: PermissionMode, flags: string[] = [], readonly = false, interaction = false, approved = false) {
  let calls = 0, prompts = 0;
  const policy = parseOptions(flags).toolPolicy;
  const registry: ExternalToolRegistry = {
    definitions: [{ name, description: "fixture", input_schema: { type: "object" } }],
    lookup: tool => tool === name ? { serverName: "fixture", isReadOnly: readonly, requiresUserInteraction: interaction } : undefined,
    async callTool() { calls++; return { raw: { content: [], structuredContent: { found: true }, _meta: { local: true } },
      projection: { text: "lookup result", blocks: [{ type: "text", text: '{"found":true}' }] } }; },
  };
  const approve = async () => { prompts++; return approved; };
  const tools = routeExternalTools(createTools({ cwd: process.cwd(), mode, policy, approve }), registry, { mode, policy, approve });
  return { tools, execute: () => tools.execute({ type: "tool_use", id: "lookup", name, input: {} }, new AbortController().signal),
    counts: () => ({ calls, prompts }) };
}

test("built-in launch selection leaves MCP available while exact deny removes advertisement and prevents side effects", async () => {
  const allowed = fixture("default", ["--tools", "", "--allowedTools", name]);
  assert.deepEqual(allowed.tools.definitions.map(tool => tool.name), [name]);
  const result = await allowed.execute();
  assert.equal(result.is_error, undefined);
  assert.deepEqual(result.apiContent, [{ type: "text", text: '{"found":true}' }]);
  assert.deepEqual(allowed.counts(), { calls: 1, prompts: 0 });
  const denied = fixture("bypassPermissions", ["--tools", "Read", "--allowedTools", name, "--disallowed-tools", name]);
  assert.deepEqual(denied.tools.definitions.map(tool => tool.name), ["Read"]);
  assert.match((await denied.execute()).content, /denied by policy/);
  assert.deepEqual(denied.counts(), { calls: 0, prompts: 0 });
});

test("readOnly MCP annotations do not grant ordinary or acceptEdits approval", async () => {
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    const denied = fixture(mode, [], true);
    assert.equal((await denied.execute()).is_error, true);
    assert.deepEqual(denied.counts(), { calls: 0, prompts: 1 });
    const accepted = fixture(mode, [], true, false, true);
    assert.equal((await accepted.execute()).is_error, undefined);
    assert.deepEqual(accepted.counts(), { calls: 1, prompts: 1 });
  }
});

test("plan mutation asks before exact allow; plan readOnly may be preapproved", async () => {
  const mutation = fixture("plan", ["--allowedTools", name]);
  assert.equal((await mutation.execute()).is_error, true);
  assert.deepEqual(mutation.counts(), { calls: 0, prompts: 1 });
  const once = fixture("plan", ["--allowedTools", name], false, false, true);
  assert.equal((await once.execute()).is_error, undefined);
  assert.deepEqual(once.counts(), { calls: 1, prompts: 1 });
  const readonly = fixture("plan", ["--allowedTools", name], true);
  assert.equal((await readonly.execute()).is_error, undefined);
  assert.deepEqual(readonly.counts(), { calls: 1, prompts: 0 });
});

test("required interaction asks even under bypass or explicit allow", async () => {
  for (const mode of ["default", "bypassPermissions"] as const) {
    const denied = fixture(mode, ["--allowedTools", name], true, true);
    assert.equal((await denied.execute()).is_error, true);
    assert.deepEqual(denied.counts(), { calls: 0, prompts: 1 });
  }
  const bypass = fixture("bypassPermissions");
  assert.equal((await bypass.execute()).is_error, undefined);
  assert.deepEqual(bypass.counts(), { calls: 1, prompts: 0 });
});

test("MCP options retain repeated explicit configs and reject unsupported permission grammar", () => {
  const options = parseOptions(["--mcp-config", "one.json", "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config"]);
  assert.deepEqual(options.mcpConfig, ["one.json", '{"mcpServers":{}}']);
  assert.equal(options.strictMcpConfig, true);
  assert.throws(() => parseOptions(["--allowedTools", "mcp__*__lookup"]), /Unsupported tool rule/);
  assert.throws(() => parseOptions(["--allowedTools", name, "mcp__fixture__other"]), /quote/);
});

test("server and tool-suffix MCP rules approve only their server and deny takes precedence", async () => {
  for (const rule of ["mcp__fixture", "mcp__fixture__*", "mcp__fixture__look*", "mcp__fixture__*up"]) {
    const allowed = fixture("default", ["--allowedTools", rule]);
    assert.equal((await allowed.execute()).is_error, undefined);
    assert.deepEqual(allowed.counts(), { calls: 1, prompts: 0 });
    const denied = fixture("bypassPermissions", ["--allowedTools", rule, "--disallowedTools", "mcp__fixture__look*"]);
    assert.equal((await denied.execute()).is_error, true);
    assert.deepEqual(denied.counts(), { calls: 0, prompts: 0 });
  }
  const other = fixture("default", ["--allowedTools", "mcp__other__*"]);
  assert.equal((await other.execute()).is_error, true);
  assert.deepEqual(other.counts(), { calls: 0, prompts: 1 });
});

async function settingsRegistry(mode: PermissionMode, rules: readonly import("../src/configuration.js").SourcedPermissionRule[], approved = false, cliAllow = true) {
  const { combineToolPolicy, parseToolPolicy } = await import("../src/tool-policy.js");
  let calls = 0, prompts = 0;
  const policy = combineToolPolicy(parseToolPolicy({ allowedTools: cliAllow ? [name] : [] }), rules);
  const approve = async () => { prompts++; return approved; };
  const registry: ExternalToolRegistry = {
    definitions: [{ name, description: "settings fixture", input_schema: { type: "object" } }],
    lookup: tool => tool === name ? { serverName: "fixture", isReadOnly: true, requiresUserInteraction: false } : undefined,
    async callTool() { calls++; return { raw: {}, projection: { text: "ok" } }; },
  };
  const tools = routeExternalTools({ definitions: [], async execute() { throw new Error("Unexpected built-in dispatch"); } }, registry, { mode, policy, approve });
  return { tools, run: (input: unknown = {}) => tools.execute({ type: "tool_use", id: "settings", name, input }, new AbortController().signal), counts: () => ({ calls, prompts }) };
}

test("every settings source can ask/deny MCP before mode bypass and whole-tool allow", async () => {
  for (const source of ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"] as const) {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
      const ask = await settingsRegistry(mode, [{ source, behavior: "ask", rule: "mcp__fixture__*" }]);
      assert.equal(ask.tools.definitions.length, 1);
      assert.equal((await ask.run()).permissionDenied, true);
      assert.deepEqual(ask.counts(), { calls: 0, prompts: 1 });
      const deny = await settingsRegistry(mode, [{ source, behavior: "ask", rule: name }, { source, behavior: "deny", rule: name }], true);
      assert.equal(deny.tools.definitions.length, 0);
      assert.equal((await deny.run()).permissionDenied, true);
      assert.deepEqual(deny.counts(), { calls: 0, prompts: 0 });
      const allow = await settingsRegistry(mode, [{ source, behavior: "allow", rule: name }], false, false);
      assert.equal((await allow.run()).is_error, undefined);
      assert.deepEqual(allow.counts(), { calls: 1, prompts: 0 });
    }
  }
});

test("MCP scoped primitive deny/ask controls dispatch without hiding unrelated calls or inventing scoped allows", async () => {
  const rules = [
    { source: "userSettings", behavior: "deny", rule: `${name}(action: destroy*)` },
    { source: "projectSettings", behavior: "ask", rule: `${name}(action: confirm*)` },
  ] as const;
  const protectedCalls = await settingsRegistry("bypassPermissions", rules);
  assert.equal(protectedCalls.tools.definitions.length, 1);
  assert.equal((await protectedCalls.run({ action: "destroy-all" })).permissionDenied, true);
  assert.deepEqual(protectedCalls.counts(), { calls: 0, prompts: 0 });
  assert.equal((await protectedCalls.run({ action: "confirm this" })).permissionDenied, true);
  assert.deepEqual(protectedCalls.counts(), { calls: 0, prompts: 1 });
  assert.equal((await protectedCalls.run({ action: "read" })).is_error, undefined);
  assert.deepEqual(protectedCalls.counts(), { calls: 1, prompts: 1 });
  const scopedAllow = await settingsRegistry("default", [{ source: "localSettings", behavior: "allow", rule: `${name}(action: read)` }], false, false);
  assert.equal((await scopedAllow.run({ action: "read" })).permissionDenied, true);
  assert.deepEqual(scopedAllow.counts(), { calls: 0, prompts: 1 });
});
