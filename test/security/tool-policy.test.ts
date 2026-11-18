import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseOptions } from "../../src/options.js";
import {
  combineToolPolicy,
  inheritedReadDeny,
  matchingToolRule,
  parseToolPolicy,
  selectableToolNameSchema,
  toolNameSchema,
  toolPolicySchema,
} from "../../src/tool-policy.js";

test("tool policy defaults and explicit availability", () => {
  assert.deepEqual(parseOptions([]).toolPolicy, {
    tools: undefined,
    allowedTools: [],
    disallowedTools: [],
  });
  assert.equal(
    parseOptions(["--tools", "default"]).toolPolicy.tools,
    undefined,
  );
  assert.deepEqual(parseOptions(["--tools", ""]).toolPolicy.tools, []);
  assert.deepEqual(
    parseOptions(["--tools", "Read, Write Edit"]).toolPolicy.tools,
    ["Read", "Write", "Edit"],
  );
});

test("TaskStop aliases and scoped rules parse without affecting unrelated tool checks", () => {
  const direct = parseToolPolicy({
    tools: "Read,TaskStop",
    disallowedTools: ["KillBash(task_id:agent-owned)"],
  });
  assert.deepEqual(direct.tools, ["Read", "TaskStop"]);
  const policy = combineToolPolicy(direct, [
    {
      source: "policySettings",
      behavior: "ask",
      rule: "KillShell(task_id:agent-*)",
    },
  ]);
  assert.equal(matchingToolRule(policy, "ask", "Read"), undefined);
  assert.equal(
    matchingToolRule(policy, "ask", "TaskStop", {
      input: { task_id: "agent-owned" },
    })?.source,
    "policySettings",
  );
  assert.equal(
    matchingToolRule(policy, "ask", "TaskStop", {
      input: { task_id: "other" },
    }),
    undefined,
  );
});

test("aliases and repeated allow/deny flags accumulate without consuming prompts", () => {
  const options = parseOptions([
    "--allowedTools",
    "Write,Bash",
    "--allowed-tools",
    "Edit Write",
    "--disallowedTools",
    "Bash",
    "--disallowed-tools",
    "Read",
    "explain",
    "this",
  ]);
  assert.deepEqual(options.toolPolicy.allowedTools, ["Write", "Bash", "Edit"]);
  assert.deepEqual(options.toolPolicy.disallowedTools, ["Bash", "Read"]);
  assert.equal(options.prompt, "explain this");
  assert.equal(
    parseOptions(["--tools", "Read", "--", "Write"]).prompt,
    "Write",
  );
  assert.equal(
    parseOptions(["--tools", "Read", "Summarize foo, bar"]).prompt,
    "Summarize foo, bar",
  );
});

test("unsupported grammar and ambiguous variadic lists fail closed", () => {
  for (const rule of ["*", "Read:/tmp", "Unknown", "read"]) {
    for (const flag of ["--tools", "--allowedTools", "--disallowed-tools"]) {
      assert.throws(() => parseOptions([flag, rule]), /Unsupported tool rule/);
    }
  }
  assert.throws(
    () => parseOptions(["--tools", "Read", "--tools", "Write"]),
    /only be specified once/,
  );
  assert.throws(
    () => parseOptions(["--allowedTools", "Read", "Write"]),
    /quote/,
  );
  assert.throws(
    () => parseToolPolicy({ allowedTools: ["default"] }),
    /Unsupported tool rule/,
  );
});

test("settings permission composition preserves source and CLI arrays instead of erasing rule provenance", async () => {
  const { combineToolPolicy, matchingToolRule } =
    await import("../../src/tool-policy.js");
  const cli = parseToolPolicy({ allowedTools: ["Read"] });
  const records = [
    {
      source: "projectSettings",
      path: "/fixture/.claude/settings.json",
      behavior: "ask",
      rule: "Read",
    },
    { source: "localSettings", behavior: "deny", rule: "Bash" },
  ] as const;
  const combined = combineToolPolicy(cli, records);
  assert.deepEqual(combined.allowedTools, ["Read"]);
  assert.deepEqual(combined.disallowedTools, []);
  assert.deepEqual(combined.sourcedRules, records);
  assert.equal(
    matchingToolRule(combined, "ask", "Read")?.source,
    "projectSettings",
  );
  assert.equal(
    matchingToolRule(combined, "deny", "Bash")?.source,
    "localSettings",
  );
  assert.equal(cli.sourcedRules, undefined);
  assert.equal(combineToolPolicy(cli, []).askedTools, undefined);
});

test("compatibility wildcard allows stay scoped while restrictive wildcards cover the whole tool", async () => {
  const { combineToolPolicy, inheritedReadDeny, matchingToolRule } =
    await import("../../src/tool-policy.js");
  const records = [
    { source: "flagSettings", behavior: "deny", rule: "Read(*)" },
    { source: "policySettings", behavior: "allow", rule: "Write()" },
  ] as const;
  const combined = combineToolPolicy(parseToolPolicy({}), records);
  assert.equal(matchingToolRule(combined, "deny", "Read")?.rule, "Read(*)");
  assert.equal(inheritedReadDeny(combined)?.source, "flagSettings");
  assert.equal(matchingToolRule(combined, "allow", "Write"), undefined);
  const scoped = parseOptions([
    "--allowedTools",
    "Bash(git *) Read(*) Edit(/out/**)",
  ]).toolPolicy;
  assert.deepEqual(scoped.allowedTools, [
    "Bash(git *)",
    "Read(*)",
    "Edit(/out/**)",
  ]);
  assert.equal(matchingToolRule(scoped, "allow", "Bash"), undefined);
  assert.equal(matchingToolRule(scoped, "allow", "Read"), undefined);
  for (const rule of ["Read(*)", "Bash(git *)"])
    assert.throws(
      () => parseOptions(["--tools", rule]),
      /Unsupported tool rule/,
    );
  const paths = combineToolPolicy(parseToolPolicy({}), [
    { source: "userSettings", behavior: "deny", rule: "Read(**/.env)" },
    {
      source: "projectSettings",
      behavior: "allow",
      rule: "Bash(git status:*)",
    },
  ]);
  assert.equal(matchingToolRule(paths, "deny", "Read"), undefined);
  assert.equal(inheritedReadDeny(paths), undefined);
  assert.equal(matchingToolRule(paths, "allow", "Bash"), undefined);
  for (const rule of ["Bash(*)", "Bash()"])
    assert.equal(
      matchingToolRule(
        parseToolPolicy({ allowedTools: [rule] }),
        "allow",
        "Bash",
      )?.rule,
      rule,
    );
  const finiteSet = combineToolPolicy(parseToolPolicy({}), [
    { source: "userSettings", behavior: "allow", rule: "Glob(*)" },
    { source: "userSettings", behavior: "allow", rule: "Grep()" },
    { source: "userSettings", behavior: "allow", rule: "Bash(*)" },
  ]);
  assert.equal(matchingToolRule(finiteSet, "allow", "Glob"), undefined);
  assert.equal(matchingToolRule(finiteSet, "allow", "Grep"), undefined);
  assert.equal(matchingToolRule(finiteSet, "allow", "Bash")?.rule, "Bash(*)");
  for (const rule of ["mcp__*__tool", "Unknown", "Read(value"]) {
    assert.throws(
      () =>
        combineToolPolicy(parseToolPolicy({}), [
          { source: "userSettings", behavior: "deny", rule },
        ]),
      /Unsupported settings permission rule/,
    );
  }
});

test("MCP primitive argument deny/ask matching is trimmed, '*' only, and scoped allows do not grant whole permission", async () => {
  const { combineToolPolicy, matchingToolRule, matchesPermissionArgument } =
    await import("../../src/tool-policy.js");
  const combined = combineToolPolicy(parseToolPolicy({}), [
    {
      source: "userSettings",
      behavior: "deny",
      rule: "mcp__fixture__tool(action: destroy*)",
    },
    {
      source: "projectSettings",
      behavior: "ask",
      rule: "mcp__fixture__tool(confirm: false)",
    },
    {
      source: "localSettings",
      behavior: "allow",
      rule: "mcp__fixture__tool(action: safe)",
    },
  ]);
  assert.equal(
    matchingToolRule(combined, "deny", "mcp__fixture__tool", {
      serverName: "fixture",
      input: { action: " destroy all " },
    })?.source,
    "userSettings",
  );
  assert.equal(
    matchingToolRule(combined, "ask", "mcp__fixture__tool", {
      serverName: "fixture",
      input: { confirm: false },
    })?.source,
    "projectSettings",
  );
  assert.equal(
    matchingToolRule(combined, "ask", "mcp__fixture__tool", {
      serverName: "fixture",
      input: Object.create({ confirm: false }),
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(combined, "deny", "mcp__fixture__tool", {
      serverName: "fixture",
      input: { action: {} },
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(combined, "deny", "mcp__fixture__tool", {
      serverName: "fixture",
      input: { action: null },
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(combined, "allow", "mcp__fixture__tool", {
      serverName: "fixture",
      input: { action: "safe" },
    }),
    undefined,
  );
  assert.equal(matchesPermissionArgument("a?", "ab"), false);
  assert.equal(matchesPermissionArgument("ab*bc", "abc"), false);
  assert.equal(matchesPermissionArgument("a**c", "abc"), true);
});

test("Skill selection preserves six builtin names while permission lists retain scoped rules and argument spaces", () => {
  assert.deepEqual(toolNameSchema.options, [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
  ]);
  assert.equal(toolNameSchema.safeParse("Skill").success, false);
  assert.equal(selectableToolNameSchema.safeParse("Skill").success, true);
  assert.deepEqual(parseOptions(["--tools", "Read Skill"]).toolPolicy.tools, [
    "Read",
    "Skill",
  ]);
  assert.deepEqual(parseToolPolicy({ tools: "Read\tSkill\nWrite" }).tools, [
    "Read",
    "Skill",
    "Write",
  ]);
  assert.deepEqual(
    parseOptions(["--allowedTools", "Skill(review *) Skill(other),Read"])
      .toolPolicy.allowedTools,
    ["Skill(review *)", "Skill(other)", "Read"],
  );
  assert.deepEqual(
    parseOptions(["--disallowedTools", "Skill(skill:internal*)"]).toolPolicy
      .disallowedTools,
    ["Skill(skill:internal*)"],
  );
  for (const value of ["Skill(review)", "Skill(*)", "!Skill", "skill"])
    assert.throws(
      () => parseToolPolicy({ tools: value }),
      /Unsupported tool rule/,
    );
  assert.throws(
    () => parseOptions(["--allowedTools", "Skill", "Skill(review)"]),
    /quote/,
  );
  assert.equal(
    toolPolicySchema.safeParse({
      tools: ["Skill"],
      allowedTools: ["Skill(review *)"],
      disallowedTools: ["Skill(blocked)"],
    }).success,
    true,
  );
});

test("Skill permission scope applies to exact names and raw prefixes without hiding or allowing unrelated skills", () => {
  const policy = parseToolPolicy({
    allowedTools: ["Skill(review *)"],
    disallowedTools: ["Skill(blocked)"],
  });
  for (const skill of ["review", "review:sub", "review-more", " /review "])
    assert.equal(
      matchingToolRule(policy, "allow", "Skill", { input: { skill } })?.rule,
      "Skill(review *)",
    );
  assert.equal(
    matchingToolRule(policy, "allow", "Skill", {
      input: { skill: "unrelated", args: "review" },
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(policy, "deny", "Skill", { input: { skill: "blocked" } })
      ?.rule,
    "Skill(blocked)",
  );
  assert.equal(matchingToolRule(policy, "deny", "Skill"), undefined);
  assert.equal(
    matchingToolRule(policy, "deny", "Read", { input: { skill: "blocked" } }),
    undefined,
  );
  assert.equal(
    matchingToolRule(policy, "allow", "Skill", { input: { skill: "reviewed" } })
      ?.rule,
    "Skill(review *)",
  );
  for (const rule of ["Skill", "Skill()", "Skill(*)"])
    assert.equal(
      matchingToolRule(
        parseToolPolicy({ disallowedTools: [rule] }),
        "deny",
        "Skill",
      )?.rule,
      rule,
    );
});

test("sourced Skill rules retain provenance and primitive deny/ask keys do not become scoped allows", () => {
  const policy = combineToolPolicy(parseToolPolicy({}), [
    {
      source: "projectSettings",
      path: "/fixture/settings.json",
      behavior: "deny",
      rule: "Skill(private:*)",
    },
    { source: "policySettings", behavior: "ask", rule: "Skill(skill:review*)" },
    { source: "userSettings", behavior: "ask", rule: "Skill(args:*publish*)" },
    { source: "localSettings", behavior: "allow", rule: "Skill(args:safe)" },
    { source: "localSettings", behavior: "allow", rule: "Skill(exact)" },
  ]);
  assert.deepEqual(
    matchingToolRule(policy, "deny", "Skill", {
      input: { skill: "private:sub" },
    }),
    {
      source: "projectSettings",
      path: "/fixture/settings.json",
      rule: "Skill(private:*)",
    },
  );
  assert.equal(
    matchingToolRule(policy, "ask", "Skill", { input: { skill: "review" } })
      ?.source,
    "policySettings",
  );
  assert.equal(
    matchingToolRule(policy, "ask", "Skill", {
      input: { skill: "other", args: " publish artifact " },
    })?.source,
    "userSettings",
  );
  assert.equal(
    matchingToolRule(policy, "allow", "Skill", {
      input: { skill: "other", args: "safe" },
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(policy, "allow", "Skill", { input: { skill: "exact" } })
      ?.rule,
    "Skill(exact)",
  );
  assert.equal(
    matchingToolRule(policy, "ask", "Skill", {
      input: { skill: "other", args: { value: "publish" } },
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(policy, "ask", "Skill", {
      input: Object.create({ args: "publish" }),
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(policy, "ask", "Skill", { input: { args: null } }),
    undefined,
  );
  assert.equal(
    matchingToolRule(policy, "ask", "Read", { input: { skill: "review" } }),
    undefined,
  );
});

test("Skill primitive raw input and legacy ask forms remain distinct, including CLI local rules", () => {
  const legacy = toolPolicySchema.parse({
    allowedTools: [],
    disallowedTools: [],
    askedTools: ["Skill(review)"],
  });
  assert.equal(
    matchingToolRule(legacy, "ask", "Skill", { input: { skill: "review" } }),
    undefined,
  );
  const primitive = toolPolicySchema.parse({
    allowedTools: ["Skill(skill:review*)"],
    disallowedTools: ["Skill(args:bad*)"],
    askedTools: ["Skill(skill:/review)", "Skill(confirm:false)"],
  });
  assert.equal(
    matchingToolRule(primitive, "allow", "Skill", {
      input: { skill: "review" },
    }),
    undefined,
  );
  assert.equal(
    matchingToolRule(primitive, "deny", "Skill", {
      input: { skill: "other", args: " bad input " },
    })?.source,
    "cliArg",
  );
  assert.equal(
    matchingToolRule(primitive, "ask", "Skill", { input: { skill: "/review" } })
      ?.rule,
    "Skill(skill:/review)",
  );
  assert.equal(
    matchingToolRule(primitive, "ask", "Skill", { input: { confirm: false } })
      ?.rule,
    "Skill(confirm:false)",
  );
  assert.equal(
    matchingToolRule(primitive, "ask", "Skill", {
      input: { confirm: () => false },
    }),
    undefined,
  );
});

test("temporary command Skill layers compose without converting command Read narrowing into inherited protection", () => {
  const base = combineToolPolicy(parseToolPolicy({ allowedTools: ["Read"] }), [
    { source: "policySettings", behavior: "ask", rule: "Skill(skill:review)" },
  ]);
  const layered = combineToolPolicy(base, [
    { source: "command", behavior: "allow", rule: "Skill(review)" },
    { source: "command", behavior: "deny", rule: "Read" },
  ]);
  assert.equal(
    matchingToolRule(layered, "allow", "Skill", { input: { skill: "review" } })
      ?.source,
    "command",
  );
  assert.equal(
    matchingToolRule(layered, "ask", "Skill", { input: { skill: "review" } })
      ?.source,
    "policySettings",
  );
  assert.equal(matchingToolRule(layered, "deny", "Read")?.source, "command");
  assert.equal(inheritedReadDeny(layered), undefined);
  assert.equal(
    matchingToolRule(base, "allow", "Skill", { input: { skill: "review" } }),
    undefined,
  );
});
