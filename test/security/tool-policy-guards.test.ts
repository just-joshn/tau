import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  combineToolPolicy,
  inheritedReadDeny,
  matchesMcpRule,
  matchingAgentTypeDeny,
  matchingToolRule,
  parseToolPolicy,
  type PermissionRuleBehavior,
  type ToolPolicy,
} from "../../src/tool-policy.js";

const settingsPath = "/repo/.claude/settings.json";
const cli = (behavior: "allow" | "deny", ...rules: string[]): ToolPolicy =>
  parseToolPolicy(
    behavior === "allow" ? { allowedTools: rules } : { disallowedTools: rules },
  );
const settings = (
  behavior: PermissionRuleBehavior,
  rule: string,
  path?: string,
): ToolPolicy =>
  combineToolPolicy(parseToolPolicy({}), [
    {
      source: "projectSettings",
      behavior,
      rule,
      ...(path === undefined ? {} : { path }),
    },
  ]);
const decides = (
  policy: ToolPolicy,
  behavior: PermissionRuleBehavior,
  name: string,
  context: { serverName?: string; input?: unknown } = {},
) => matchingToolRule(policy, behavior, name, context) !== undefined;
const agent = (input: unknown) => ({ input });
const mcp = (input?: unknown) => ({
  serverName: "srv",
  ...(input === undefined ? {} : { input }),
});

test("INV-01 CLI lists split on whitespace outside calls and keep call content verbatim", () => {
  assert.deepEqual(cli("deny", "Agent(prompt:a\tb)\nRead").disallowedTools, [
    "Agent(prompt:a\tb)",
    "Read",
  ]);
  assert.ok(
    decides(cli("deny", "Agent(prompt:a\tb)"), "deny", "Agent", {
      input: { prompt: "a\tb" },
    }),
  );
  assert.ok(
    !decides(cli("deny", "Agent(prompt:a\tb)"), "deny", "Agent", {
      input: { prompt: "a b" },
    }),
  );
});

test("INV-01 rejected CLI rules name the grammar each flag accepts", () => {
  assert.throws(
    () => parseToolPolicy({ tools: "mcp__srv__read" }),
    /Unsupported tool rule: mcp__srv__read\. Use exact tool names; /,
  );
  assert.throws(
    () => parseToolPolicy({ allowedTools: ["mcp__*"] }),
    /Use exact tool names, Read\(path\), Edit\(path\), Bash\(command\), Skill\[\(name\)\], or mcp__server\[__tool-pattern\];/,
  );
});

test("INV-01 Agent rules accept bare and closed scoped forms and fail closed otherwise", () => {
  for (const rule of ["Agent", "Task"])
    assert.ok(
      decides(
        cli("deny", rule),
        "deny",
        "Agent",
        agent({ subagent_type: "Explore" }),
      ),
      rule,
    );
  assert.ok(
    decides(
      cli("deny", "Agent(Explore)"),
      "deny",
      "Agent",
      agent({ subagent_type: "Explore" }),
    ),
  );
  assert.throws(() => cli("deny", "Agent(Explore"), /Unsupported tool rule/);
  assert.throws(() => cli("deny", "Agent(Explore\\)"), /Unsupported tool rule/);
  assert.equal(
    matchingAgentTypeDeny(cli("deny", "Agent(Explore\\\\)"), "Explore\\")?.rule,
    "Agent(Explore\\\\)",
  );
});

test("INV-01 an exact Agent type deny blocks that type under either tool name and nothing else", () => {
  const policy = cli("deny", "Agent(Explore)");
  for (const name of ["Agent", "Task"])
    assert.ok(
      decides(policy, "deny", name, agent({ subagent_type: "Explore" })),
      name,
    );
  assert.ok(
    !decides(policy, "deny", "Agent", agent({ subagent_type: "Plan" })),
  );
  assert.ok(
    !decides(
      policy,
      "deny",
      "Agent",
      agent({ subagent_type: "Plan", Explor: "Explore" }),
    ),
  );
  assert.ok(!decides(policy, "deny", "Agent", agent("Explore")));
  assert.ok(!decides(policy, "deny", "Agent", {}));
  assert.ok(
    !decides(
      cli("deny", "Read"),
      "deny",
      "Agent",
      agent({ subagent_type: "Explore" }),
    ),
  );
  assert.ok(decides(cli("deny", "Read"), "deny", "Read"));
  assert.ok(!decides(cli("deny", "Agent"), "deny", "Read"));
});

test("INV-01 whole-tool Agent denies cover every call, and scoped Agent allows preapprove nothing", () => {
  for (const rule of ["Agent", "Agent()", "Agent(*)"]) {
    assert.ok(
      decides(
        cli("deny", rule),
        "deny",
        "Agent",
        agent({ subagent_type: "Plan" }),
      ),
      rule,
    );
    assert.ok(decides(cli("deny", rule), "deny", "Agent", {}), rule);
  }
  assert.ok(
    !decides(
      cli("allow", "Agent(Explore)"),
      "allow",
      "Agent",
      agent({ subagent_type: "Explore" }),
    ),
  );
  assert.ok(
    !decides(
      cli("allow", "Agent(Explore)"),
      "allow",
      "Agent",
      agent({ subagent_type: "Plan" }),
    ),
  );
  assert.ok(
    !decides(
      cli("allow", "Agent(prompt:*)"),
      "allow",
      "Agent",
      agent({ prompt: "go" }),
    ),
  );
});

test("INV-01 Agent key:pattern denies match primitive input fields with '*' wildcards", () => {
  const prompt = cli("deny", "Agent(prompt:*deploy*)");
  assert.ok(
    decides(prompt, "deny", "Agent", agent({ prompt: "please deploy now" })),
  );
  assert.ok(
    !decides(prompt, "deny", "Agent", agent({ prompt: "read the logs" })),
  );
  assert.ok(
    !decides(prompt, "deny", "Agent", agent({ description: "deploy" })),
  );
  assert.ok(
    decides(
      cli("deny", "Agent(max_turns:3)"),
      "deny",
      "Agent",
      agent({ max_turns: 3 }),
    ),
  );
  assert.ok(
    decides(
      cli("deny", "Agent(background:true)"),
      "deny",
      "Agent",
      agent({ background: true }),
    ),
  );
  assert.ok(
    !decides(
      cli("deny", "Agent(prompt:*)"),
      "deny",
      "Agent",
      agent({ prompt: { text: "x" } }),
    ),
  );
  assert.ok(
    !decides(
      cli("deny", "Agent(prompt:)"),
      "deny",
      "Agent",
      agent({ prompt: "" }),
    ),
  );
});

test("INV-01 Agent type denies from the CLI and settings report their source and nothing else", () => {
  assert.deepEqual(
    matchingAgentTypeDeny(cli("deny", "Agent(Explore)"), "Explore"),
    {
      rule: "Agent(Explore)",
      source: "cliArg",
    },
  );
  assert.equal(
    matchingAgentTypeDeny(cli("deny", "Agent(Explore)"), "Plan"),
    undefined,
  );
  assert.deepEqual(
    matchingAgentTypeDeny(
      settings("deny", "Agent(Plan)", settingsPath),
      "Plan",
    ),
    {
      rule: "Agent(Plan)",
      source: "projectSettings",
      path: settingsPath,
    },
  );
  assert.deepEqual(
    matchingAgentTypeDeny(settings("deny", "Agent(Plan)"), "Plan"),
    {
      rule: "Agent(Plan)",
      source: "projectSettings",
    },
  );
  assert.equal(
    matchingAgentTypeDeny(settings("deny", "Agent(Plan)"), "Explore"),
    undefined,
  );
  assert.equal(
    matchingAgentTypeDeny(settings("allow", "Agent(Plan)"), "Plan"),
    undefined,
  );
  assert.equal(
    matchingAgentTypeDeny(settings("deny", "Read"), "Plan"),
    undefined,
  );
});

test("INV-01 settings Agent rules deny both tool names, only the named type, and never other tools", () => {
  for (const rule of ["Agent", "Task"])
    for (const name of ["Agent", "Task"])
      assert.ok(
        decides(
          settings("deny", rule),
          "deny",
          name,
          agent({ subagent_type: "Plan" }),
        ),
        `${rule} ${name}`,
      );
  assert.ok(!decides(settings("deny", "Agent"), "deny", "Read"));
  assert.ok(
    !decides(
      settings("deny", "Read"),
      "deny",
      "Agent",
      agent({ subagent_type: "Plan" }),
    ),
  );
  const scoped = settings("deny", "Agent(Explore)");
  assert.ok(
    decides(scoped, "deny", "Agent", agent({ subagent_type: "Explore" })),
  );
  assert.ok(
    !decides(scoped, "deny", "Agent", agent({ subagent_type: "Plan" })),
  );
});

test("INV-01 background task aliases share rules without covering other tools", () => {
  assert.ok(decides(settings("deny", "KillShell"), "deny", "TaskStop"));
  assert.ok(!decides(settings("deny", "KillShell"), "deny", "Read"));
  assert.ok(!decides(settings("deny", "Read"), "deny", "TaskStop"));
});

test("INV-01 MCP server and star rules cover only the owning server's matching tools", () => {
  const allows = (rule: string, name: string, serverName = "srv") =>
    decides(cli("allow", rule), "allow", name, { serverName });
  assert.ok(allows("mcp__srv", "mcp__srv__read_file"));
  assert.ok(!allows("mcp__srv", "mcp__other__read_file", "other"));
  assert.ok(!allows("mcp__a", "mcp__a__b__read", "a__b"));
  assert.ok(!allows("mcp__srv__read", "mcp__srv__read_file"));
  assert.ok(allows("mcp__srv__read*", "mcp__srv__read_file"));
  assert.ok(allows("mcp__srv__read*", "mcp__srv__read"));
  assert.ok(!allows("mcp__srv__read*", "mcp__srv__write"));
  assert.ok(allows("mcp__srv__*read*", "mcp__srv__read_file"));
  assert.ok(!allows("mcp__srv__*read*", "mcp__srv__write_file"));
  assert.ok(allows("mcp__srv__re*_*le", "mcp__srv__read_file"));
  assert.ok(!allows("mcp__srv__re*_*le", "mcp__srv__readfile"));
  assert.ok(!allows("mcp__srv__*_file", "mcp__srv__read_dir"));
  assert.ok(!allows("mcp__srv__ab*bc", "mcp__srv__abc"));
});

test("INV-01 an MCP rule needs a server segment that agrees with both the tool name and its server", () => {
  assert.equal(matchesMcpRule("mcp__srv", "mcp__other__read", "srv"), false);
  assert.equal(matchesMcpRule("mcp____*", "mcp____read", ""), false);
});

test("INV-01 malformed settings rules fail instead of widening to whole-tool rules", () => {
  for (const rule of [
    "Read(secrets",
    "Read(x",
    "Bogus()",
    "mcp__srv__fetch(url:)",
    "mcp__srv__fetch( :x)",
  ])
    assert.throws(
      () => settings("deny", rule),
      /Unsupported settings permission rule/,
      rule,
    );
});

test("INV-01 MCP argument denies match '*' as any run of characters, anchored at both ends", () => {
  const denies = (pattern: string, value: unknown) =>
    decides(
      settings("deny", `mcp__srv__fetch(${pattern})`),
      "deny",
      "mcp__srv__fetch",
      mcp({ url: value }),
    );
  assert.ok(denies("url:https://*", "https://"));
  assert.ok(!denies("url:https://*.internal", "http://x.internal"));
  assert.ok(denies("url:a*b*c", "abc"));
  assert.ok(!denies("url:a*bc*c", "abc"));
  assert.ok(!denies("url:https://*/admin/*", "https://host/user/x"));
  assert.ok(denies("url:3", 3));
  assert.ok(denies("url:false", false));
  assert.ok(!denies("url:*", { host: "internal" }));
  assert.ok(
    !decides(
      settings("deny", "mcp__srv__fetch(url:*)"),
      "deny",
      "mcp__srv__fetch",
      mcp(null),
    ),
  );
});

test("INV-01 Skill argument denies match primitive fields and ignore malformed input", () => {
  const denies = (rule: string, input: unknown) =>
    decides(cli("deny", rule), "deny", "Skill", { input });
  assert.ok(denies("Skill(attempt:3)", { skill: "review", attempt: 3 }));
  assert.ok(denies("Skill(dry_run:true)", { skill: "review", dry_run: true }));
  assert.ok(!denies("Skill(args:*)", { skill: "review", args: { a: 1 } }));
  assert.ok(!denies("Skill(length:3)", "abc"));
  assert.ok(!denies("Skill(deploy)", { skill: "review", deplo: "deploy" }));
  assert.ok(!denies("Skill(note:)", { skill: "review", note: "" }));
});

test("INV-06 inherited Read denies report the settings file that holds them", () => {
  assert.deepEqual(inheritedReadDeny(settings("deny", "Read", settingsPath)), {
    rule: "Read",
    source: "projectSettings",
    path: settingsPath,
  });
  assert.deepEqual(inheritedReadDeny(settings("deny", "Read")), {
    rule: "Read",
    source: "projectSettings",
  });
});
