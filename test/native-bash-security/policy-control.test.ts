import { test, expect } from "bun:test";
import { posix } from "node:path";
import { createNativeBashCommandPreparation } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPolicyControl,
  type NativeBashSecurityPolicyHost,
} from "../../src/native-bash-security/policy-control.js";
import { fixture, policy, known } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityRule as Rule,
} from "../../src/native-bash-security/security-types.js";
function owner(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  const ruleCalls: string[] = [];
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const rules = {
    allow: new Map<string, Rule>(),
    ask: new Map<string, Rule>(),
    deny: new Map<string, Rule>(),
  };
  const host: NativeBashSecurityPolicyHost = {
    ...f.host,
    protectedRoots: (s) => known([], s),
    workingDirectories: (_p, s) => known(["/work"], s),
    suggestionDirectory: (path, s) => known(posix.dirname(path), s),
    readDirectorySuggestion: (path, destination, s) =>
      known(
        {
          type: "addRules",
          rules: [{ toolName: "Read", ruleContent: path + "/**" }],
          behavior: "allow",
          destination,
        },
        s,
      ),
    feature: (_key, _default, s) =>
      known({ value: true, source: "virtual-test" }, s),
    mountedDriveRmPromptDisabled: (s) => known(false, s),
    orderedRules: (_p, behavior, s) => {
      ruleCalls.push(behavior);
      return known(rules[behavior], s);
    },
    allDenyRules: (_p, s) => known([...rules.deny.values()], s),
    commandDenyBuiltinRuleNames: (s) => known(new Set(["Bash(cat:*)"]), s),
    ruleSuggestions: (_command, s) => known([], s),
    readOnly: (_input, _context, s) => known(false, s),
    spawnEnvironmentOwner: (s) =>
      known(
        {
          spawnEnvKeys: (_keys, evalScope) =>
            known(new Set<string>(), evalScope),
        },
        s,
      ),
    isConfined: (s) => known(false, s),
    executingConfined: (s) => known(false, s),
    windowsBashAvailable: (s) => known(true, s),
    evalConfined: (s) => known(false, s),
    sandboxCommandExempt: (_command, _shell, s) => known(false, s),
    sandboxReadFencesUsable: (s) => known(false, s),
    globalReadBlock: (s) => known(false, s),
    securityFeature: (_kind, _key, _fallback, s) => known(true, s),
    xargsSafeFlags: (s) =>
      known({ "-a": "string", "-n": "number", "-r": "none" }, s),
    currentCwd: (s) => known(s.cwd, s),
  };
  const controller = createNativeBashSecurityPolicyControl(
    f.semantic,
    preparation,
    host,
  );
  function add(
    behavior: "allow" | "ask" | "deny",
    content: string,
    source = "projectSettings",
  ) {
    const r: Rule = {
      source,
      ruleBehavior: behavior,
      ruleValue: { toolName: "Bash", ruleContent: content },
    };
    rules[behavior].set(content, r);
    return r;
  }
  async function run(
    command: string,
    p: Policy = policy(),
    cwdChanging = false,
  ) {
    const analyzed = await f.semantic.analyze(command);
    if (analyzed.kind !== "simple") throw new Error(analyzed.reason);
    const c = analyzed.commands[0];
    if (c === undefined) throw new Error("Missing command");
    return controller.withPolicyScope(p, "/work", () =>
      controller.native.PIo(
        { command },
        p,
        cwdChanging,
        c,
        "/work",
        analyzed.bareAssignmentNames,
      ),
    );
  }
  return { ...f, host, controller, preparation, rules, add, run, ruleCalls };
}
test("native prefix allow follows scoped Read deny and Edit deny", async () => {
  const r = owner({ deny: "/work/secret" });
  r.add("allow", "cat:*");
  const read = (await r.run("cat secret")).result;
  expect(read.behavior).toBe("deny");
  expect(read.decisionReason?.type).toBe("rule");
  if (read.decisionReason?.type === "rule")
    expect(read.decisionReason.rule.ruleValue.toolName).toBe("Read");
  const w = owner({ writeDeny: "/work/secret" });
  w.add("allow", "touch:*");
  expect(
    (await w.run("touch secret", policy({ mode: "acceptEdits" }))).result
      .behavior,
  ).toBe("deny");
});
test("source exact allow is still checked against prefix deny", async () => {
  const f = owner();
  f.add("allow", "cat file");
  const deny = f.add("deny", "cat:*");
  const r = (await f.run("cat file")).result;
  expect(r.behavior).toBe("deny");
  expect(r.decisionReason).toEqual({ type: "rule", rule: deny });
});
test("non-session exact asks return before prefix deny but session exact asks wait", async () => {
  const n = owner();
  const ask = n.add("ask", "cat file");
  n.add("deny", "cat:*");
  const nonSession = (await n.run("cat file")).result;
  expect(nonSession.behavior).toBe("ask");
  expect(nonSession.decisionReason).toEqual({ type: "rule", rule: ask });
  const s = owner();
  s.add("ask", "cat file", "session");
  const deny = s.add("deny", "cat:*");
  const session = (await s.run("cat file")).result;
  expect(session.behavior).toBe("deny");
  expect(session.decisionReason).toEqual({ type: "rule", rule: deny });
});
test("ordinary prefix allow can cover the native overrideable in-directory write prompt", async () => {
  const f = owner();
  const allow = f.add("allow", "touch:*");
  const r = (await f.run("touch file")).result;
  expect(r.behavior).toBe("allow");
  expect(r.decisionReason).toEqual({ type: "rule", rule: allow });
  expect(f.calls).toContain("rule:edit:deny:/work/file");
});
test("read block retains outside-read safety before Bash allows", async () => {
  const f = owner({ outsideBlocked: true });
  f.add("allow", "cat:*");
  const r = (
    await f.run(
      "cat /outside/file",
      policy({ blockReadsOutsideWorkingDirectories: true }),
    )
  ).result;
  expect(r.behavior).toBe("ask");
  if (r.decisionReason?.type === "safetyCheck")
    expect(r.decisionReason.circuitBreaker).toBe("outsideReadsBlocked");
  else throw new Error("Expected native read block");
});
test("safe environment and generic existing paths retain scoped Read denials", async () => {
  const f = owner({ deny: "/outside/file" });
  f.add("allow", "custom:*");
  const p = policy({ blockReadsOutsideWorkingDirectories: true });
  expect(
    (await f.run("custom --config=/outside/file", p)).result.behavior,
  ).toBe("deny");
  const inline = (await f.run("node -e 'print(1)'", p)).result;
  expect(inline.behavior).toBe("ask");
  if (inline.decisionReason?.type === "safetyCheck")
    expect(inline.decisionReason.circuitBreaker).toBe("outsideReadsBlocked");
  else throw new Error("Expected inline-code hold");
});
test("read-only application fact is required at native fallback and cannot substitute missing metadata", async () => {
  const f = owner();
  delete f.host.readOnly;
  expect(f.run("cat file")).rejects.toThrow(NativeBashSecurityUnsupported);
  const allowed = owner();
  allowed.host.readOnly = (_input, _context, s) => known(true, s);
  expect((await allowed.run("cat file")).result.behavior).toBe("allow");
  const unknown = owner();
  unknown.host.readOnly = () => ({
    status: "unsupported",
    dependency: "readonly-schema",
    reason: "No source-backed classifier",
  });
  expect(unknown.run("cat file")).rejects.toThrow("readonly-schema");
});
test("native source command deny optimization requires actual builtin table provenance", async () => {
  const f = owner();
  f.add("deny", "cat:*", "command");
  delete f.host.commandDenyBuiltinRuleNames;
  expect(
    f.run(
      "cat file",
      policy({ alwaysDenyRules: { command: ["Bash(cat:*)"] } }),
    ),
  ).rejects.toThrow(NativeBashSecurityUnsupported);
});
test("readonly assignment dependency observes PWD and actual spawn environment keys", () => {
  const f = owner();
  const r = f.controller.withPolicyScope(policy(), "/work", () => {
    const n = f.controller.native;
    let calls = 0;
    const read = () => {
      calls++;
      return new Set(["PATH", "EXISTING"]);
    };
    expect(n.T8(["LANG", "EXISTING"], read)).toBe(true);
    expect(calls).toBe(1);
    expect(
      n.T8(["PWD"], () => {
        throw new Error("must not read environment");
      }),
    ).toBe(true);
    expect(n.T8(["NEW"], () => new Set())).toBe(false);
  });
  expect(r.result).toBeUndefined();
});
test("native reason formatter preserves hook, rule, compound and prompt-tool payload", () => {
  const f = owner();
  const El = f.controller.native.El;
  expect(
    El("Bash", { type: "hook", hookName: "PreToolUse", reason: "blocked" }),
  ).toBe("Hook 'PreToolUse' blocked this action: blocked");
  expect(
    El("Bash", {
      type: "permissionPromptTool",
      permissionPromptToolName: "review",
    }),
  ).toBe("Tool 'review' requires approval for this Bash command");
  expect(
    El("Bash", {
      type: "rule",
      rule: {
        source: "session",
        ruleValue: { toolName: "Bash", ruleContent: "echo (x)" },
      },
    }),
  ).toBe(
    "Permission rule 'Bash(echo \\(x\\))' from current session requires approval for this Bash command",
  );
});
test("inferred evaluation cwd scopes every inner rule and filesystem host fact", async () => {
  const f = owner({ deny: "/elsewhere/secret" });
  f.add("allow", "cat:*");
  const analyzed = await f.semantic.analyze("cat secret");
  if (analyzed.kind !== "simple") throw new Error(analyzed.reason);
  const c = analyzed.commands[0];
  if (c === undefined) throw new Error("Missing actual semantic command");
  const r = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.PIo(
      { command: "cat secret" },
      policy(),
      false,
      c,
      "/elsewhere",
      analyzed.bareAssignmentNames,
    ),
  );
  expect(r.result.behavior).toBe("deny");
  expect(r.facts.length).toBeGreaterThan(0);
  expect(r.facts.every((fact) => fact.scope.cwd === "/elsewhere")).toBe(true);
  expect(f.calls).toContain("rule:read:deny:/elsewhere/secret");
});
test("complete cwd alternate-path scanner keeps Read denials from every reachable directory", async () => {
  const f = owner({ deny: "/work/sub/secret" });
  const analyzed = await f.semantic.analyze("cd sub && cat secret");
  if (analyzed.kind !== "simple") throw new Error(analyzed.reason);
  const r = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.Elt(analyzed.commands, "/work", policy()),
  ).result;
  expect(r?.behavior).toBe("deny");
  expect(f.calls).toContain("rule:read:deny:/work/secret");
  expect(f.calls).toContain("rule:read:deny:/work/sub/secret");
});
test("cwd argv validator and same-directory elision use source exact structure", async () => {
  const f = owner();
  const one = await f.semantic.analyze("cd /work; cat file");
  if (one.kind !== "simple") throw new Error(one.reason);
  const r = f.controller.native.wOr(
    one.commands.map((c) => c.text),
    one.commands,
    "/work",
    "/work",
  );
  expect(r.subcommands).toEqual(["cat file"]);
  const quoted = await f.semantic.analyze("cd '/work'; cat file");
  if (quoted.kind !== "simple") throw new Error(quoted.reason);
  expect(
    f.controller.native.wOr(
      quoted.commands.map((c) => c.text),
      quoted.commands,
      "/work",
      "/work",
    ).subcommands,
  ).toEqual(["cd '/work'", "cat file"]);
  const n = f.controller.native;
  expect(n.vbn("C:/safe/path", "C:/cwd")).toBe(true);
  expect(n.vbn("C:/../escape", "C:/cwd")).toBe(false);
  expect(n.vbn("dir/../later", "C:/cwd")).toBe(false);
  expect(n.Tbn("plain-name")).toBe(false);
  expect(n.Tbn("./plain-name")).toBe(true);
});
test("native unsandboxed-toggle probe is independent of bare tool grants and accepts its generic true spelling", () => {
  const f = owner({ sandbox: true });
  const base = f.host.sandbox;
  if (base === undefined) throw new Error("Missing virtual sandbox profile");
  f.host.sandbox = (p, s) => {
    const result = base(p, s);
    if (result.status !== "known") return result;
    return {
      ...result,
      value: { ...result.value, unsandboxedCommandsAllowed: true },
    };
  };
  const shells: string[] = [];
  f.host.sandboxCommandExempt = (_command, shell, s) => {
    shells.push(shell);
    return known(false, s);
  };
  const r = f.controller.withPolicyScope(policy(), "/work", () => ({
    bash: f.controller.native.D5e(
      { name: "Bash" },
      { command: "echo x", dangerouslyDisableSandbox: true },
    ),
    power: f.controller.native.D5e(
      { name: "PowerShell" },
      { command: "echo x", dangerouslyDisableSandbox: "true" },
    ),
  })).result;
  expect(r).toEqual({ bash: true, power: true });
  expect(shells).toEqual(["bash", "powershell"]);
  delete f.host.isConfined;
  expect(
    f.controller.withPolicyScope(policy(), "/work", () =>
      f.controller.native.D5e(
        { name: "Bash" },
        { dangerouslyDisableSandbox: false },
      ),
    ).result,
  ).toBe(false);
  expect(() =>
    f.controller.withPolicyScope(policy(), "/work", () =>
      f.controller.native.D5e(
        { name: "Bash" },
        { dangerouslyDisableSandbox: true },
      ),
    ),
  ).toThrow(NativeBashSecurityUnsupported);
});
test("alternate Cbn consumer checks prefix denies before exact asks", () => {
  const f = owner();
  f.add("ask", "cat file");
  const rule = f.add("deny", "cat:*");
  const r = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.Cbn({ command: "cat file" }, policy()),
  ).result;
  expect(r?.behavior).toBe("deny");
  expect(r?.decisionReason).toEqual({ type: "rule", rule });
});
test("semantic safety rejection rule floor checks each actual command under an exact compound allowance", async () => {
  const f = owner();
  const command = "echo x; cat secret";
  f.add("allow", command);
  const deny = f.add("deny", "cat:*");
  const receipt = await f.semantic.analyze(command);
  if (receipt.kind !== "simple") throw new Error(receipt.reason);
  const r = f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.jOr({ command }, policy(), receipt.commands),
  ).result;
  expect(r?.behavior).toBe("deny");
  expect(r?.decisionReason).toEqual({ type: "rule", rule: deny });
});
test("classifier command prefix only supplies native space-star suggestions after actual permission checks", async () => {
  const f = owner();
  const command = "custom operand";
  const receipt = await f.semantic.analyze(command);
  if (receipt.kind !== "simple") throw new Error(receipt.reason);
  const r = await f.controller.withPolicyScope(policy(), "/work", () =>
    f.controller.native.qwn(
      { command },
      policy(),
      { commandPrefix: "custom" },
      false,
      receipt.commands[0],
      "/work",
      receipt.bareAssignmentNames,
    ),
  ).result;
  expect(r.behavior).toBe("passthrough");
  expect(r.suggestions).toEqual([
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "custom *" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ]);
});
