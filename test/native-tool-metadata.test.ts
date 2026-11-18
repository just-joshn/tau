import { expect, test } from "bun:test";
import {
  NativePermissionDependencyError,
  type NativePermissionFact as Fact,
  type NativePermissionScope as Scope,
} from "../src/native-permission-outcome.js";
import {
  createNativeToolMetadataMatcher,
  nativeMcpNamePart,
  type NativeToolMetadataHost,
  type NativeToolRegistryRead,
  type NativeToolMetadata,
  type NativeToolAliasPolicy,
  type NativeToolPermissionRule as Rule,
} from "../src/native-tool-metadata.js";
const scope: Scope = { policyId: "metadata-test", cwd: "/work" };
function known<T>(value: T, request: Scope = scope): Fact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-native-metadata-facts",
      sourceContracts: ["nh/N/w/V fixture"],
      scope: request,
    },
  };
}
function rule(
  name: string,
  behavior: "allow" | "deny" | "ask" = "deny",
  source = "projectSettings",
  content?: string,
): Rule {
  return {
    source,
    ruleBehavior: behavior,
    ruleValue: {
      toolName: name,
      ...(content === undefined ? {} : { ruleContent: content }),
    },
  };
}
function fixture() {
  const registry: NativeToolRegistryRead = {
    active: false,
    tools: new Map(),
    servers: new Map(),
    sessionKeyById: new Map(),
    otherDenyOrAskNames: new Map(),
  };
  const reads: string[] = [],
    warnings: string[] = [];
  const host: NativeToolMetadataHost = {
    registry: (s) => {
      reads.push("registry");
      return known(registry, s);
    },
    inheritedGosling: (_fallback, s) => {
      reads.push("gosling");
      return known(true, s);
    },
    rp: (s) => {
      reads.push("rp");
      return known(false, s);
    },
    snappyLighthouse: (_fallback, s) => {
      reads.push("lighthouse");
      return known(false, s);
    },
    convertedSkillsPluginConfig: (s) => {
      reads.push("converted");
      return known(undefined, s);
    },
    disklessLaunch: (s) => {
      reads.push("diskless");
      return known(false, s);
    },
    warn: (message, _level, s) => {
      warnings.push(message);
      return known(undefined, s);
    },
  };
  const owner = createNativeToolMetadataMatcher(host);
  function match(
    tool: NativeToolMetadata,
    value: Rule,
    policy: NativeToolAliasPolicy = {},
    strict = false,
  ) {
    return owner.matches(scope, known(policy), known(tool), value, strict)
      .result;
  }
  return { host, owner, registry, reads, warnings, match };
}

test("native name matching retains exact case, literal nonstar punctuation and source alias direction", () => {
  const f = fixture();
  expect(f.match({ name: "Bash" }, rule("Bash"))).toBe(true);
  expect(f.match({ name: "Bash" }, rule("bash"))).toBe(false);
  expect(f.match({ name: "Bash" }, rule("Ba?h"))).toBe(false);
  expect(f.match({ name: "Ba?h" }, rule("Ba?h"))).toBe(true);
  expect(
    f.match({ name: "Bash" }, rule("Executor"), {
      toolAliases: { Executor: "Bash" },
    }),
  ).toBe(true);
  expect(
    f.match({ name: "Executor" }, rule("Bash"), {
      toolAliases: { Executor: "Bash" },
    }),
  ).toBe(false);
});

test("native cliArg/toolsNarrowing rules disable proxy expansion without disabling direct or glob matches", () => {
  const f = fixture(),
    aliases = { toolAliases: { Executor: "Bash" } };
  for (const source of ["cliArg", "toolsNarrowing"]) {
    expect(
      f.match({ name: "Bash" }, rule("Executor", "deny", source), aliases),
    ).toBe(false);
    expect(
      f.match({ name: "Bash" }, rule("Exec*", "deny", source), aliases),
    ).toBe(false);
    expect(
      f.match({ name: "Bash" }, rule("Ba*", "deny", source), aliases),
    ).toBe(true);
  }
  expect(f.match({ name: "Bash" }, rule("Exec*"), aliases)).toBe(true);
});

test("native star matcher retains fragment ordering, newlines, UTF16 and literal backslashes", () => {
  const f = fixture();
  expect(f.match({ name: "ababa-tail" }, rule("a*aba*-tail"))).toBe(true);
  expect(f.match({ name: "aba-tail" }, rule("a*aba*-tail"))).toBe(false);
  expect(f.match({ name: "a\nb" }, rule("a*b"))).toBe(true);
  expect(f.match({ name: "a雪b" }, rule("a*b"))).toBe(true);
  expect(f.match({ name: "a\uD800b" }, rule("a*b"))).toBe(true);
  expect(f.match({ name: "Bash" }, rule("Ba\\*"))).toBe(false);
  expect(f.match({ name: "Ba\\sh" }, rule("Ba\\*"))).toBe(true);
});

test("native source-constructed Bash/Read/Edit contract does not require a fabricated registry owner", () => {
  const owner = createNativeToolMetadataMatcher({});
  expect(
    owner.matchesSourceConstructedReadEditBash(
      scope,
      known({}),
      "Bash",
      rule("B*", "deny", "projectSettings", "rm:*"),
    ).result,
  ).toBe(true);
  expect(
    owner.matchesSourceConstructedReadEditBash(
      scope,
      known({ toolAliases: { Inspect: "Read" } }),
      "Read",
      rule("Inspect"),
    ).result,
  ).toBe(true);
  expect(
    owner.matchesSourceConstructedReadEditBash(
      scope,
      known({}),
      "Edit",
      rule("Read"),
    ).result,
  ).toBe(false);
  // nh itself matches names; the upstream Zl source controls content/source admission.
});

test("native family and ordinary skill aliases retain their asymmetric MCP and packaging gates", () => {
  const f = fixture();
  expect(
    f.match({ name: "Child", familyParentToolName: "Parent" }, rule("Parent")),
  ).toBe(true);
  expect(
    f.match(
      {
        name: "Child",
        familyParentToolName: "Parent",
        mcpInfo: { serverName: "server", toolName: "child" },
      },
      rule("Parent", "allow"),
    ),
  ).toBe(false);
  expect(
    f.match(
      { name: "Child", aliasSkillToolNames: ["SkillAlias"] },
      rule("SkillAlias"),
    ),
  ).toBe(true);
  expect(
    f.match(
      { name: "Child", packagingAliasSkillToolNames: ["SkillAlias"] },
      rule("SkillAlias"),
    ),
  ).toBe(true);
  expect(f.reads.filter((value) => value === "rp")).toEqual([]);
  expect(
    f.match(
      { name: "Child", packagingAliasSkillToolNames: ["SkillAlias"] },
      rule("Skill*"),
    ),
  ).toBe(false);
  expect(f.reads.slice(-3)).toEqual(["rp", "lighthouse", "converted"]);
});

test("native packaging wildcard feature reads preserve rp, strict, settings and diskless short circuits", () => {
  const f = fixture();
  const tool = { name: "Child", packagingAliasSkillToolNames: ["SkillAlias"] };
  f.host.rp = (s) => {
    f.reads.push("rp");
    return known(true, s);
  };
  expect(f.match(tool, rule("Skill*"), {}, true)).toBe(true);
  expect(f.reads).toEqual(["rp"]);
  f.reads.length = 0;
  f.host.rp = (s) => {
    f.reads.push("rp");
    return known(false, s);
  };
  expect(f.match(tool, rule("Skill*"), {}, true)).toBe(false);
  expect(f.reads).toEqual(["rp"]);
  f.reads.length = 0;
  f.host.snappyLighthouse = (_fallback, s) => {
    f.reads.push("lighthouse");
    return known(true, s);
  };
  expect(f.match(tool, rule("Skill*"))).toBe(true);
  expect(f.reads).toEqual(["rp", "lighthouse", "diskless"]);
  f.host.disklessLaunch = (s) => known(true, s);
  expect(f.match(tool, rule("Skill*"))).toBe(false);
});

test("native plugin packaging wildcard has its exact special case-fold prefix", () => {
  const f = fixture();
  expect(
    f.match(
      { name: "mcp__plugin_demo_Foo__Run" },
      rule("mcp__plugin_*_foo__run", "allow"),
    ),
  ).toBe(true);
  expect(
    f.match(
      { name: "mcp__other_demo_Foo__Run" },
      rule("mcp__other_*_foo__run", "allow"),
    ),
  ).toBe(false);
});

test("native MCP allow ambiguity differs from deny/ask and warns once per rule", () => {
  const f = fixture();
  const tool = {
    name: "wire-name",
    mcpInfo: { serverName: "server__nested", toolName: "run" },
  };
  expect(f.match(tool, rule("mcp__server", "allow"))).toBe(false);
  expect(f.match(tool, rule("mcp__server", "allow"))).toBe(false);
  expect(f.warnings).toHaveLength(1);
  expect(f.warnings[0]).toContain("another MCP server");
  expect(f.match(tool, rule("mcp__server", "deny"))).toBe(true);
  expect(f.match(tool, rule("mcp__server", "ask", "mcpServerPolicy"))).toBe(
    true,
  );
  expect(f.match(tool, rule("mcp__server__nested__run", "allow"))).toBe(true);
});

test("native inherited MCP deny names use the actual registry and source own metadata", () => {
  const f = fixture();
  const tool = {
    name: "wire",
    mcpInfo: {
      serverName: "current",
      toolName: "run",
      nameKey: "inherited",
      denyKey: "old",
      standardKey: { key: "standard" },
    },
  };
  expect(f.match(tool, rule("mcp__old__run"))).toBe(true);
  expect(f.match(tool, rule("mcp__inherited__run"))).toBe(true);
  expect(f.match(tool, rule("mcp__standard__run"))).toBe(true);
  f.host.inheritedGosling = (_fallback, s) => known(false, s);
  expect(f.match(tool, rule("mcp__inherited__run"))).toBe(false);
  expect(f.match(tool, rule("mcp__old__run", "allow"))).toBe(false);
});

test("native retired hashed server deny translation requires the actual active registry identity", () => {
  const f = fixture();
  const tools = new Map([
    ["mcp__current__run", { serverId: "actual-id", toolPart: "run" }],
  ]);
  const servers = new Map([["actual-id", { standardKey: { key: "old" } }]]);
  const sessionKeyById = new Map([["actual-id", "old"]]);
  f.host.registry = (s) =>
    known(
      {
        active: true,
        tools,
        servers,
        sessionKeyById,
        otherDenyOrAskNames: new Map(),
      },
      s,
    );
  const tool = {
    name: "wire",
    mcpInfo: { serverName: "current", toolName: "run" },
  };
  expect(f.match(tool, rule("mcp__old-a1234abcd__run"))).toBe(true);
  sessionKeyById.set("actual-id", "different");
  expect(f.match(tool, rule("mcp__old-a1234abcd__run"))).toBe(false);
  expect(f.match(tool, rule("mcp__old-a1234abcd__run", "allow"))).toBe(false);
});

test("native missing registry/feature facts and stale metadata provenance stay explicit", () => {
  const owner = createNativeToolMetadataMatcher({});
  expect(() =>
    owner.matches(
      scope,
      known({}),
      known({ name: "wire", mcpInfo: { serverName: "x", toolName: "run" } }),
      rule("not-a-match"),
    ),
  ).toThrow(NativePermissionDependencyError);
  expect(() =>
    owner.matches(
      scope,
      known({}),
      known({ name: "Child", packagingAliasSkillToolNames: ["SkillAlias"] }),
      rule("Skill*"),
    ),
  ).toThrow(NativePermissionDependencyError);
  expect(() =>
    owner.matches(
      scope,
      known({}, { policyId: "wrong", cwd: "/work" }),
      known({ name: "Bash" }),
      rule("Bash"),
    ),
  ).toThrow(NativePermissionDependencyError);
});

test("native MCP name normalization retains its exact claude.ai special case without NFC inference", () => {
  expect(nativeMcpNamePart("claude.ai  A / B")).toBe("claude_ai_A_B");
  expect(nativeMcpNamePart("Other  A / B")).toBe("Other__A___B");
  expect(nativeMcpNamePart("server__key-name")).toBe("server__key-name");
  expect(nativeMcpNamePart("é")).toBe("_");
  expect(nativeMcpNamePart("e\u0301")).toBe("e_");
});

test("native MCP server-policy excludes the fallback server-prefix allowance", () => {
  const f = fixture();
  const tool = {
    name: "wire",
    mcpInfo: { serverName: "server__nested", toolName: "run" },
  };
  expect(
    f.match(tool, rule("mcp__server__nested", "deny", "projectSettings")),
  ).toBe(true);
  expect(
    f.match(tool, rule("mcp__server__nested", "deny", "mcpServerPolicy")),
  ).toBe(false);
  expect(
    f.match(tool, rule("mcp__server__nested__run", "deny", "mcpServerPolicy")),
  ).toBe(true);
});
