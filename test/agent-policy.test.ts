import assert from "node:assert/strict";
import test from "node:test";
import { combineToolPolicy, matchingToolRule, parseToolPolicy, toolNameSchema } from "../src/tool-policy.js";

test("Agent selection and legacy Task alias preserve exact type rules and scoped source identity", () => {
  assert.equal(toolNameSchema.safeParse("Agent").success, false);
  assert.deepEqual(parseToolPolicy({ tools: "Agent,Read" }).tools, ["Agent", "Read"]);
  assert.throws(() => parseToolPolicy({ tools: "Agent(reader)" }), /Unsupported/);
  const policy = combineToolPolicy(parseToolPolicy({ disallowedTools: ["Task(reader)", "Agent(owned*)"] }), [
    { source: "policySettings", behavior: "ask", rule: "Task(subagent_type: private*)" },
    { source: "userSettings", behavior: "allow", rule: "Agent(reader)" },
    { source: "projectSettings", behavior: "deny", rule: "Agent(prompt:*erase*)" },
  ]);
  assert.equal(matchingToolRule(policy, "deny", "Agent", { input: { subagent_type: "reader" } })?.rule, "Task(reader)");
  assert.equal(matchingToolRule(policy, "deny", "Task", { input: { subagent_type: "Reader" } }), undefined);
  assert.equal(matchingToolRule(policy, "deny", "Agent", { input: { subagent_type: "owned-reader" } }), undefined);
  assert.equal(matchingToolRule(policy, "deny", "Agent", { input: { subagent_type: "owned*" } })?.rule, "Agent(owned*)");
  assert.equal(matchingToolRule(policy, "ask", "Agent", { input: { subagent_type: " private-reader " } })?.source, "policySettings");
  assert.equal(matchingToolRule(policy, "ask", "Agent", { input: Object.create({ subagent_type: "private-reader" }) }), undefined);
  assert.equal(matchingToolRule(policy, "deny", "Agent", { input: { prompt: " erase the fixture " } })?.source, "projectSettings");
  assert.equal(matchingToolRule(policy, "allow", "Agent", { input: { subagent_type: "reader" } }), undefined);
  assert.equal(matchingToolRule(parseToolPolicy({ allowedTools: [], disallowedTools: [] }), "ask", "Agent", { input: { subagent_type: "reader" } }), undefined);
  assert.equal(matchingToolRule(combineToolPolicy(parseToolPolicy({}), [{ source: "userSettings", behavior: "ask", rule: "Agent(reader)" }]), "ask", "Agent", { input: { subagent_type: "reader" } }), undefined);
  assert.equal(matchingToolRule(policy, "allow", "Read", { input: { subagent_type: "reader" } }), undefined);
  for (const rule of ["Agent", "Task", "Agent()", "Task(*)"]) assert.ok(matchingToolRule(parseToolPolicy({ disallowedTools: [rule] }), "deny", "Agent"));
  assert.equal(matchingToolRule(parseToolPolicy({ disallowedTools: [String.raw`Agent(reader\(v2\))`] }), "deny", "Agent", { input: { subagent_type: "reader(v2)" } })?.rule, String.raw`Agent(reader\(v2\))`);
  assert.equal(matchingToolRule(parseToolPolicy({ disallowedTools: ["Agent( )"] }), "deny", "Agent", { input: { subagent_type: "reader" } }), undefined);
  assert.equal(matchingToolRule(parseToolPolicy({ allowedTools: ["Agent(subagent_type: reader)"] }), "allow", "Agent", { input: { subagent_type: "reader" } }), undefined);
});
