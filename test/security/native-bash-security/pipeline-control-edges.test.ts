import { expect, test } from "bun:test";
import { createNativeBashSecurityPipelineControl } from "../../../src/native-bash-security/pipeline-control.js";
import { createNativeBashSecurityOutcomeControl } from "../../../src/native-bash-security/outcome-control.js";
import { gitFixture } from "./git-fixture.js";
import { policy, known } from "./security-fixture.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityInput as Input,
  NativeBashSecurityReason as Reason,
} from "../../../src/native-bash-security/security-types.js";

const El = (_tool: string, reason?: Reason) =>
  reason?.type === "other" ? reason.reason : "prompt";
const sandboxReason =
  "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)";
function allow(input: Input): Decision {
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
const fence: Decision = {
  behavior: "ask",
  message: "read fence",
  decisionReason: {
    type: "safetyCheck",
    reason: "read fence",
    classifierApprovable: false,
    circuitBreaker: "outsideReadsBlocked",
  },
};

function owner(options: { duplicate?: boolean; sandbox?: boolean } = {}) {
  const f = gitFixture();
  const outcomes = createNativeBashSecurityOutcomeControl(El);
  const pipeline = createNativeBashSecurityPipelineControl(
    f.semantic,
    f.git.preparation,
    f.git,
    outcomes,
    El,
    {
      duplicatePipeReasons: (s) => known(options.duplicate ?? true, s),
      currentCwd: (s) => known(s.cwd, s),
    },
  );
  const predicates = {
    isNormalizedCdCommand: (text: string) => /^cd(?: |$)/.test(text),
    isNormalizedGitCommand: (text: string) => /^git(?: |$)/.test(text),
    shouldUseSandbox: () => options.sandbox === true,
  };
  async function run(
    command: string,
    check: (input: Input) => Decision | Promise<Decision> = allow,
    options: { semantic?: boolean; tree?: boolean } = {},
  ) {
    const tree =
      options.tree === false ? undefined : await f.semantic.parse(command);
    const receipt = await f.semantic.analyze(command);
    const commands =
      options.semantic === false || receipt.kind !== "simple"
        ? undefined
        : receipt.commands;
    return pipeline.withPolicyScope(policy(), "/work", () =>
      pipeline.native.Swn(
        { command },
        check,
        predicates,
        tree,
        commands,
        undefined,
        undefined,
      ),
    ).result;
  }
  return { ...f, outcomes, pipeline, run };
}

test("pipeline construction refuses owners that do not share one semantic instance", () => {
  const f = gitFixture();
  const other = gitFixture();
  expect(() =>
    createNativeBashSecurityPipelineControl(
      other.semantic,
      f.git.preparation,
      f.git,
      createNativeBashSecurityOutcomeControl(El),
      El,
      {},
    ),
  ).toThrow("Native Bash process owners must be shared");
});

test("pipeline checks outside a policy scope fail instead of reading unscoped features", async () => {
  const f = owner();
  await expect(
    f.pipeline.native.AMr(
      { command: "cat a | cat b" },
      ["cat a", "cat b"],
      ["cat a", "cat b"],
      allow,
      {
        isNormalizedCdCommand: () => false,
        isNormalizedGitCommand: () => false,
      },
      undefined,
      undefined,
      undefined,
    ),
  ).rejects.toThrow("Missing native pipeline invariant");
});

test("a bare redirect span that the path layer asks about keeps the ask and its suggestions", async () => {
  const f = owner();
  const suggestion = {
    type: "addRules" as const,
    rules: [{ toolName: "Edit", ruleContent: "/work/out" }],
    behavior: "allow" as const,
    destination: "session" as const,
  };
  const pathAsk: Decision = {
    behavior: "ask",
    message: "write out",
    decisionReason: { type: "other", reason: "write out" },
    suggestions: [suggestion],
  };
  const result = await f.run("> out | cat", (input) =>
    input.command === "> out" ? pathAsk : allow(input),
  );
  expect(result.behavior).toBe("ask");
  expect(result.suggestions).toEqual([suggestion]);
  if (result.decisionReason?.type !== "subcommandResults")
    throw new Error("Missing pipe map");
  expect(result.decisionReason.reasons.get("> out")).toBe(pathAsk);
});

test("an ask span without suggestions yields an ask with no suggestions", async () => {
  const f = owner();
  const plain: Decision = {
    behavior: "ask",
    decisionReason: { type: "other", reason: "plain" },
  };
  const result = await f.run("cat a | wc -l", (input) =>
    input.command === "wc -l" ? plain : allow(input),
  );
  expect(result.behavior).toBe("ask");
  expect(result.suggestions).toBeUndefined();
});

test("a span allowed both without and with its redirect keeps the as-written allow", async () => {
  const f = owner();
  const calls: string[] = [];
  const result = await f.run("echo x > out | cat", (input) => {
    calls.push(input.command);
    return allow(input);
  });
  expect(calls).toEqual(["echo x", "echo x > out", "cat"]);
  expect(result.behavior).toBe("allow");
  if (result.decisionReason?.type !== "subcommandResults")
    throw new Error("Missing pipe map");
  expect(result.decisionReason.reasons.get("echo x > out")).toEqual(
    allow({ command: "echo x > out" }),
  );
});

test("without duplicate pipe reasons the as-written span is not rechecked", async () => {
  const f = owner({ duplicate: false });
  const calls: string[] = [];
  const result = await f.run("echo x > out | cat", (input) => {
    calls.push(input.command);
    return allow(input);
  });
  expect(calls).toEqual(["echo x", "cat"]);
  expect(result.behavior).toBe("allow");
  if (result.decisionReason?.type !== "subcommandResults")
    throw new Error("Missing pipe map");
  expect([...result.decisionReason.reasons.keys()]).toEqual(["echo x", "cat"]);
});

test.each([
  {
    command: "cd /work/sub | git status",
    reason: "changes directory before running a version-control command",
  },
  {
    command: "touch HEAD | git status",
    reason: "creates git repository structure files",
  },
])(
  "without a semantic receipt, $command is still held by text splitting",
  async ({ command, reason }) => {
    const f = owner();
    const result = await f.run(command, allow, { semantic: false });
    expect(result.behavior).toBe("ask");
    if (result.decisionReason?.type !== "other")
      throw new Error("Missing pipeline hold");
    expect(result.decisionReason.reason).toContain(reason);
    expect(result.decisionReason.bashMissKind).toBe("cd-git-compound");
  },
);

test.each(["cd /work/sub | git status", "touch HEAD | git status"])(
  "a non-waivable fence in %s is returned instead of the generic git hold",
  async (command) => {
    const f = owner();
    const result = await f.run(command, (input) =>
      input.command.startsWith("git") ? fence : allow(input),
    );
    expect(result).toBe(fence);
  },
);

test("a sandbox auto-allowed assignment pipe stays allowed when the command runs sandboxed", async () => {
  const sandboxAllow = (input: Input): Decision => ({
    behavior: "allow",
    updatedInput: input,
    decisionReason: { type: "other", reason: sandboxReason },
  });
  expect((await owner().run("A=1 | cat", sandboxAllow)).behavior).toBe("ask");
  expect(
    (await owner({ sandbox: true }).run("A=1 | cat", sandboxAllow)).behavior,
  ).toBe("allow");
});

test("a pipeline without a supplied tree is parsed from the command text", async () => {
  const f = owner();
  const result = await f.run("cat a | wc -l", allow, { tree: false });
  expect(result.behavior).toBe("allow");
  const single = await f.run("cat a", allow, { tree: false });
  expect(single).toEqual({
    behavior: "passthrough",
    message: "No pipes found in command",
  });
});
