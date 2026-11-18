import { test, expect } from "bun:test";
import { createNativeBashSecurityPipelineControl } from "../../src/native-bash-security/pipeline-control.js";
import { createNativeBashSecurityOutcomeControl } from "../../src/native-bash-security/outcome-control.js";
import { gitFixture } from "./git-fixture.js";
import { policy, known } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
} from "../../src/native-bash-security/security-types.js";
const El = (_tool: string, reason?: Reason) =>
  reason?.type === "other" ? reason.reason : "prompt";
function allow(input: { command: string }): Decision {
  return {
    behavior: "allow",
    updatedInput: input,
    decisionReason: {
      type: "rule",
      rule: {
        source: "session",
        ruleBehavior: "allow",
        ruleValue: { toolName: "Bash", ruleContent: input.command },
      },
    },
  };
}
function owner() {
  const f = gitFixture();
  const outcomes = createNativeBashSecurityOutcomeControl(El);
  const host = {
    duplicatePipeReasons: (s: Parameters<typeof known>[1]) => known(true, s),
    currentCwd: (s: Parameters<typeof known>[1]) => known(s?.cwd ?? "/work", s),
  };
  const preparation = f.git.preparation;
  const pipeline = createNativeBashSecurityPipelineControl(
    f.semantic,
    preparation,
    f.git,
    outcomes,
    El,
    host,
  );
  const predicates = {
    isNormalizedCdCommand: (text: string) => /^cd(?: |$)/.test(text),
    isNormalizedGitCommand: (text: string) => /^git(?: |$)/.test(text),
    shouldUseSandbox: () => false,
  };
  async function run(
    command: string,
    check: (input: { command: string }) => Decision | Promise<Decision> = allow,
    trust?: (commands: string[]) => boolean | Promise<boolean>,
    fallback?: () => Decision | undefined,
  ) {
    const tree = await f.semantic.parse(command);
    const receipt = await f.semantic.analyze(command);
    return pipeline.withPolicyScope(policy(), "/work", () =>
      pipeline.native.Swn(
        { command },
        check,
        predicates,
        tree,
        receipt.kind === "simple" ? receipt.commands : undefined,
        trust,
        fallback,
      ),
    ).result;
  }
  return { ...f, pipeline, run, host, preparation };
}
test("pipeline consumer checks every span before selecting a denial", async () => {
  const f = owner();
  const calls: string[] = [];
  const r = await f.run("cat file | wc -c | head", (input) => {
    calls.push(input.command);
    return input.command === "wc -c"
      ? {
          behavior: "deny",
          decisionReason: { type: "other", reason: "blocked" },
        }
      : allow(input);
  });
  expect(calls).toEqual(["cat file", "wc -c", "head"]);
  expect(r.behavior).toBe("deny");
  expect(r.decisionReason?.type).toBe("subcommandResults");
});
test("source output removal recheck preserves as-written provenance while outer path stage remains required", async () => {
  const f = owner();
  const calls: string[] = [];
  const r = await f.run("echo x > out | cat", (input) => {
    calls.push(input.command);
    return input.command.includes(">")
      ? {
          behavior: "ask",
          decisionReason: { type: "other", reason: "write prompt" },
        }
      : allow(input);
  });
  expect(calls).toEqual(["echo x", "echo x > out", "cat"]);
  expect(r.behavior).toBe("allow");
  if (r.decisionReason?.type !== "subcommandResults")
    throw new Error("Missing pipe map");
  const first = r.decisionReason.reasons.get("echo x > out");
  if (first?.decisionReason?.type !== "subcommandResults")
    throw new Error("Missing as-written annotation");
  const original = first.decisionReason.reasons.get("echo x > out");
  expect(original?.behavior).toBe("allow");
  if (original?.decisionReason?.type === "other")
    expect(original.decisionReason.reason).toContain("not allowed as written");
  else throw new Error("Missing source provenance");
});
test("bare output-redirection spans retain native path-layer-approved annotation", async () => {
  const f = owner();
  const r = await f.run("> out | cat", (input) =>
    input.command === "> out" ? { behavior: "passthrough" } : allow(input),
  );
  expect(r.behavior).toBe("allow");
  if (r.decisionReason?.type !== "subcommandResults")
    throw new Error("Missing map");
  const bare = r.decisionReason.reasons.get("> out");
  expect(bare?.decisionReason).toEqual({
    type: "other",
    reason: "Bare output redirection with no command; path layer approved",
  });
});
test("subshell and command groups return source structural holds before recursion", async () => {
  const f = owner();
  for (const command of ["(echo x) | cat", "{ echo x; } | cat"]) {
    const r = await f.run(command, () => {
      throw new Error("Must not recursively grant a structural hold");
    });
    expect(r.behavior).toBe("ask");
    if (r.decisionReason?.type === "other")
      expect(r.decisionReason.bashMissKind).toBe("shell-operators");
    else throw new Error("Missing structural hold");
  }
});
test("multiple cwd pipeline stages cannot bypass an existing immune safety fence", async () => {
  const f = owner();
  const plain = await f.run("cd /a | cd /b");
  expect(plain.behavior).toBe("ask");
  if (plain.decisionReason?.type === "other")
    expect(plain.decisionReason.bashMissKind).toBe("multi-cd");
  const safety: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "safetyCheck",
      reason: "read fence",
      classifierApprovable: false,
      circuitBreaker: "outsideReadsBlocked",
    },
  };
  expect(
    await f.run("cd /a | cd /b", (input) =>
      input.command === "cd /a" ? safety : allow(input),
    ),
  ).toBe(safety);
});
test("git metadata creation and cwd git trust remain separate source pipeline fences", async () => {
  const f = owner();
  const writes = await f.run("touch HEAD | git status");
  expect(writes.behavior).toBe("ask");
  if (writes.decisionReason?.type === "other")
    expect(writes.decisionReason.reason).toContain(
      "creates git repository structure files",
    );
  else throw new Error("Missing metadata fence");
  const changed = await f.run("cd /work/sub | git status");
  expect(changed.behavior).toBe("ask");
  let trustCalls = 0;
  const trusted = await f.run(
    "cd /work/sub | git status",
    allow,
    (commands) => {
      trustCalls++;
      expect(commands).toEqual(["cd /work/sub", "git status"]);
      return true;
    },
  );
  expect(trusted.behavior).toBe("allow");
  expect(trustCalls).toBe(2);
});
test("native assignment-stage pipe hold records refusal in the shared environment observer", async () => {
  const f = owner();
  const held = await f.run("A=1 | cat");
  expect(held.behavior).toBe("ask");
  if (held.decisionReason?.type === "other")
    expect(held.decisionReason.bashMissKind).toBe("assigned-variable");
  const observed = await f.preparation.features.observeEnvironment(true, () =>
    f.run("A=1 | cat"),
  );
  expect(observed.result.behavior).toBe("allow");
  expect(observed.refused).toBe(true);
});
test("whole-command and separate-span semantic disagreement retains assigned-variable hold", async () => {
  const f = owner();
  const tree = await f.semantic.parse("echo one | cat");
  const different = await f.semantic.analyze("echo two | cat");
  if (different.kind !== "simple") throw new Error(different.reason);
  const r = await f.pipeline.withPolicyScope(policy(), "/work", () =>
    f.pipeline.native.Swn(
      { command: "echo one | cat" },
      allow,
      {
        isNormalizedCdCommand: () => false,
        isNormalizedGitCommand: () => false,
      },
      tree,
      different.commands,
      undefined,
      undefined,
    ),
  ).result;
  expect(r.behavior).toBe("ask");
  if (r.decisionReason?.type === "other")
    expect(r.decisionReason.bashMissKind).toBe("assigned-variable");
  else throw new Error("Missing source mismatch hold");
});
test("pipeline feature facts retain explicit unsupported instead of a default grant", async () => {
  const f = owner();
  f.host.duplicatePipeReasons = () => ({
    status: "unsupported",
    dependency: "pipe-provenance-feature",
    reason: "No known reader",
  });
  expect(f.run("echo x | cat")).rejects.toThrow(NativeBashSecurityUnsupported);
});
