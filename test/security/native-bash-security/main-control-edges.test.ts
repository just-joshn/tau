import { expect, test } from "bun:test";
import { createMainFixture } from "./main-fixture.js";
import { known, policy } from "./security-fixture.js";
import {
  createNativeBashMainControl,
  NativeBashSecurityAbortError,
} from "../../../src/native-bash-security/main-control.js";
import { NativeBashSecurityUnsupported } from "../../../src/native-bash-security/security-types.js";
import type {
  NativeBashSecurityContext as Context,
  NativeBashSecurityPrefix as Prefix,
} from "../../../src/native-bash-security/security-recursion-types.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityPolicy as Policy,
} from "../../../src/native-bash-security/security-types.js";

// Commands the read-only classifier admits, standing in for the host's
// read-only command table.
const READ_ONLY = /^(cat|cd|ls|echo|grep|head|pwd|wc|git status|git log)\b/;

interface Setup {
  policy?: Partial<Policy>;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  readDeny?: string[];
  sandbox?: boolean;
  readFences?: boolean;
  remote?: boolean;
}

function owner(setup: Setup = {}) {
  const f = createMainFixture();
  const permission = policy(setup.policy);
  f.setPolicy(permission);
  f.policyHost.readOnly = (input, _context, s) =>
    known(READ_ONLY.test(input.command.trim()), s);
  f.policyHost.allDenyRules = (_permission, s) => known([...f.denied], s);
  f.policyHost.commandDenyBuiltinRuleNames = (s) => known(new Set<string>(), s);
  f.policyHost.xargsSafeFlags = (s) => known({ "-n": "number" }, s);
  f.policyHost.currentCwd = (s) => known(s.cwd, s);
  f.policyHost.windowsBashAvailable = (s) => known(true, s);
  f.policyHost.sandboxReadFencesUsable = (s) =>
    known(setup.readFences === true, s);
  f.policyHost.globalReadBlock = (s) => known(setup.readFences === true, s);
  f.policyHost.pathPrimitive = (_kind, path, s) => known(path, s);
  f.policyHost.filesystem.realpathSpelling = (path, s) => known(path, s);
  const authored = f.policyHost.sandbox;
  f.policyHost.sandbox = (permission, s) => {
    const fact = authored?.(permission, s);
    if (fact?.status !== "known") throw new Error("Missing sandbox profile");
    const enabled = setup.sandbox === true;
    return known(
      {
        ...fact.value,
        enabled,
        autoAllowBashIfSandboxed: enabled,
        autoAllowSupported: enabled,
      },
      s,
    );
  };
  f.main.cwd.host.realpath = async (path, s) => known(path, s);
  f.main.cwd.host.bigintStat = async (_path, s) =>
    known({ dev: 1n, ino: 1n }, s);
  for (const path of setup.readDeny ?? []) f.deny(path, "read");
  for (const rule of setup.allow ?? []) f.add("allow", rule);
  for (const rule of setup.ask ?? []) f.add("ask", rule);
  for (const rule of setup.deny ?? []) f.add("deny", rule);
  function context(): Context {
    return {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
      ...(setup.remote === true ? { forRemoteExecution: true } : {}),
    };
  }
  async function decide(
    command: string,
    run: (context: Context) => Promise<Decision> = (c) =>
      f.main.native.nIe({ command }, c),
  ) {
    return f.main.withPolicyScope(permission, "/work", () => run(context()))
      .result;
  }
  return { ...f, permission, context, decide };
}

// behavior plus the reason fields callers branch on.
function label(decision: Decision): string {
  const reason = decision.decisionReason;
  if (reason === undefined) return `${decision.behavior} none`;
  if (reason.type === "other")
    return `${decision.behavior} other/${reason.bashMissKind ?? "-"}`;
  if (reason.type === "safetyCheck")
    return `${decision.behavior} safetyCheck/${reason.circuitBreaker ?? "-"}`;
  return `${decision.behavior} ${reason.type}`;
}

type Row = [command: string, expected: string];

function table(name: string, setup: Setup, rows: Row[]) {
  test.each(rows)(`${name}: %p decides %p`, async (command, expected) => {
    expect(label(await owner(setup).decide(command))).toBe(expected);
  });
}

table("default policy", {}, [
  ["cat file", "allow subcommandResults"],
  ["cat file | grep x", "allow subcommandResults"],
  ["x=1; echo $x", "allow subcommandResults"],
  ["npm test", "passthrough other/no-rule-match"],
  ["ls; npm test", "passthrough subcommandResults"],
  ["ls; npm test; npx foo", "passthrough subcommandResults"],
  // A dangerous removal is never admitted, alone or in a list.
  ["rm -rf /", "ask safetyCheck/dangerousRemoval"],
  ["ls; rm -rf /", "ask safetyCheck/dangerousRemoval"],
  ["rm -rf $(pwd)", "ask safetyCheck/dangerousRemoval"],
  // Commands the semantic safety pass refuses.
  ["eval ls", "ask other/semantics"],
  ["find . -exec rm {} \\;", "ask other/semantics"],
  ["cat /proc/1/environ", "ask other/semantics"],
  ['echo "a\n#b"', "ask other/semantics"],
  ["export A=$(ls)", "ask other/semantics"],
  // Shapes the analyzer cannot model.
  ["echo $(whoami)", "ask other/too-complex"],
  ["ls `pwd`", "ask other/too-complex"],
  ["cat <<EOF\n$x\nEOF", "ask other/too-complex"],
  ["cat <<EOF | grep a\nx\nEOF", "ask other/too-complex"],
  ["declare -a x=(1 2)", "ask other/too-complex"],
  ['for f in *; do rm "$f"; done', "ask other/too-complex"],
  ["ls | (cat)", "ask other/shell-operators"],
  ["(ls)", "ask other/shell-operators"],
  // Directory changes.
  ["cd /work && ls", "allow subcommandResults"],
  ["cd a && cd b", "ask other/multi-cd"],
  ["cd /work/sub && cd /work/other", "ask other/multi-cd"],
  ["cd sub; pushd /work/a; popd; rm x", "ask other/multi-cd"],
  ["cd sub && git status", "ask other/cd-git-compound"],
  ["cd sub && rm -rf x", "ask other/cd-compound-write"],
  // Writes inside the working directory still prompt in default mode.
  ["mkdir a", "ask none"],
  ["echo hi > out", "ask none"],
  ["sed -i s/a/b/ f", "ask none"],
  ["sed -n p f", "passthrough other/no-rule-match"],
]);

table("read block", { policy: { blockReadsOutsideWorkingDirectories: true } }, [
  ["eval ls", "ask safetyCheck/outsideReadsBlocked"],
  ["echo $(whoami)", "ask safetyCheck/outsideReadsBlocked"],
  ["python - < x.py", "ask safetyCheck/outsideReadsBlocked"],
  ["cat x | python -", "ask safetyCheck/outsideReadsBlocked"],
  ["python <<'E'\nprint(1)\nE", "ask safetyCheck/outsideReadsBlocked"],
  ["cd a && cd b", "ask safetyCheck/outsideReadsBlocked"],
  ["ls | (cat)", "ask safetyCheck/outsideReadsBlocked"],
  ['echo "a\n#b"', "ask safetyCheck/outsideReadsBlocked"],
  ["env FOO=bar ls", "ask safetyCheck/outsideReadsBlocked"],
  ["git -C /tmp status", "ask safetyCheck/outsideReadsBlocked"],
  ["python -c 'print(1)'", "ask safetyCheck/outsideReadsBlocked"],
  ["xargs ls", "ask safetyCheck/outsideReadsBlocked"],
  ["ls ~other/x", "ask safetyCheck/outsideReadsBlocked"],
  ["ls; sed -i s/a/b/ f", "ask safetyCheck/outsideReadsBlocked"],
  ["cd /work && ls", "allow subcommandResults"],
  ["git status", "allow subcommandResults"],
  ["ls *.txt", "allow subcommandResults"],
]);

table(
  "read block, cwd and git",
  {
    policy: { blockReadsOutsideWorkingDirectories: true },
  },
  [
    ["rm -rf $(pwd)", "ask safetyCheck/outsideReadsBlocked"],
    ["for i in 1 2; do x=$i; done", "ask safetyCheck/outsideReadsBlocked"],
    ["cat <<EOF\nx\nEOF", "ask safetyCheck/outsideReadsBlocked"],
    ["x=1 declare y=2", "ask safetyCheck/outsideReadsBlocked"],
    // A relative cd target in a cwd-changing list cannot be pinned.
    ["cd sub && ls", "ask safetyCheck/outsideReadsBlocked"],
    ["cd ./sub && ls", "allow subcommandResults"],
    ["cd /work/sub && ls", "allow subcommandResults"],
    ["touch HEAD && git status", "ask safetyCheck/outsideReadsBlocked"],
    ["cat f; cat f", "allow subcommandResults"],
  ],
);

table("default policy, cwd and git", {}, [
  ["cd sub && ls", "allow subcommandResults"],
  ["cd /work/sub && ls", "allow subcommandResults"],
  ["cat f; cat f", "allow subcommandResults"],
  ["cat f > /dev/null; cat f 2>&1", "allow subcommandResults"],
  ["cat f >&2; cat f 2>/dev/null", "allow subcommandResults"],
  ["declare x=1; echo $x", "passthrough subcommandResults"],
  // Writing git structure then running git can run planted hooks.
  ["touch HEAD && git status", "ask other/cd-git-compound"],
  ["git init x && cd x && git status", "ask other/cd-git-compound"],
  ["mkdir -p .git/hooks && git status", "ask none"],
]);

table("acceptEdits", { policy: { mode: "acceptEdits" } }, [
  ["mkdir a", "allow subcommandResults"],
  ["touch a b", "allow subcommandResults"],
  ["ls; mkdir a", "allow subcommandResults"],
  ["(rm -rf /)", "ask safetyCheck/dangerousRemoval"],
  ["ls | (rm -rf /)", "ask safetyCheck/dangerousRemoval"],
  ["npm test", "passthrough other/no-rule-match"],
]);

table("auto", { policy: { mode: "auto" } }, [
  ["mkdir a", "ask none"],
  ["echo $(whoami)", "ask other/too-complex"],
  ["eval ls", "ask other/semantics"],
  ["(rm -rf /)", "ask safetyCheck/dangerousRemoval"],
]);

table("bypassPermissions", { policy: { mode: "bypassPermissions" } }, [
  ["eval ls", "ask other/semantics"],
  ["rm -rf $(pwd)", "ask safetyCheck/dangerousRemoval"],
]);

table("remote execution", { remote: true }, [
  ["mkdir a", "ask none"],
  ["echo $(whoami)", "ask other/too-complex"],
  ["cat <<EOF | grep a\nx\nEOF", "ask other/too-complex"],
  ["ls | (cat)", "ask other/shell-operators"],
  ["(rm -rf /)", "ask safetyCheck/dangerousRemoval"],
  ["cd sub && ls", "allow subcommandResults"],
  ["cd a && cd b", "ask other/multi-cd"],
  ['echo "a\n#b"', "ask other/semantics"],
]);

// The sandbox auto-allows what it confines; dangerous removals and shell
// evaluation still prompt.
table("sandbox auto-allow", { sandbox: true }, [
  ["while true; do ls; done", "allow other/-"],
  ["cat <<EOF | grep a\nx\nEOF", "allow other/-"],
  ["cat <<EOF\nx\nEOF", "allow other/-"],
  ["cd sub && ls", "allow other/-"],
  ["npm test", "allow other/-"],
  ["eval cat secret", "ask other/semantics"],
  ["rm -rf $(pwd)", "ask safetyCheck/dangerousRemoval"],
  ["for i in 1 2; do x=$i; done", "ask other/too-complex"],
  ["x=1 declare y=2", "passthrough other/no-rule-match"],
]);

table(
  "sandbox read fences under the read block",
  {
    sandbox: true,
    readFences: true,
    policy: { blockReadsOutsideWorkingDirectories: true },
  },
  [
    ["mkdir a", "allow other/-"],
    ["echo $(whoami)", "allow other/-"],
    ["ls | (cat)", "allow other/-"],
    ["cd a && cd b", "allow other/-"],
    ['echo "a\n#b"', "allow other/-"],
    ["eval ls", "ask other/semantics"],
    ["(rm -rf /)", "ask safetyCheck/dangerousRemoval"],
    ["for i in 1 2; do echo $i; done", "ask other/too-complex"],
  ],
);

table("Bash rules", { allow: ["npm test", "git status"], deny: ["rm:*"] }, [
  ["ls; rm x", "deny subcommandResults"],
  ["npm test", "allow rule"],
  ["ls; npm test", "allow subcommandResults"],
  ["cd sub && npm test", "allow subcommandResults"],
]);

table("exact whole-command allow", { allow: ["ls; npm test"] }, [
  ["ls; npm test", "allow rule"],
]);

table("ask rule on a subcommand", { ask: ["npm test"] }, [
  ["ls; npm test", "ask rule"],
  ["npm test; npx y", "ask subcommandResults"],
]);

const secret = {
  readDeny: ["/work/b/secret"],
  policy: {
    alwaysDenyRules: { projectSettings: ["Read(/work/b/secret)"] },
  },
};

// A Read deny rule follows the directory the read runs in.
table("Read deny after directory changes", secret, [
  ["cat /work/b/secret", "deny subcommandResults"],
  ["cd /work/b && cat secret", "deny subcommandResults"],
  ["cd /work/b && ls && cat secret", "deny subcommandResults"],
  ["cat /work/b/secret; eval ls", "deny subcommandResults"],
  ["cd /work/a && cd /work/b && cat secret", "deny rule"],
  ["cd /work/a && pushd /work/b && popd && cat secret", "deny rule"],
  ["cd /work/a && cd ~/x && cat secret", "ask other/multi-cd"],
  ["cd /work/a && cd /work/b && cat ../secret", "ask other/multi-cd"],
  ["cd /work/b && (cat secret)", "ask other/shell-operators"],
  ["(cd /work/b && cat secret)", "ask other/shell-operators"],
  ["cd $X && cat secret", "ask other/too-complex"],
  ["cat secret | grep x", "allow subcommandResults"],
]);

table(
  "Read deny under the read block",
  {
    ...secret,
    policy: { ...secret.policy, blockReadsOutsideWorkingDirectories: true },
  },
  [
    ["eval cat /work/b/secret", "deny subcommandResults"],
    ["cd /work/a && cd /work/b && cat secret", "deny rule"],
    [
      "cd /work/a && cd ~/x && cat secret",
      "ask safetyCheck/outsideReadsBlocked",
    ],
    ["cd /work/b; ls | (cat secret)", "ask safetyCheck/outsideReadsBlocked"],
    ["cd /work/b && cat secret", "deny subcommandResults"],
  ],
);

table("removals after several directory changes", {}, [
  ["cd /work/a && cd /work/b && rm -rf /", "ask safetyCheck/dangerousRemoval"],
  ["cd /work/a && cd /work/b && rm -rf x", "ask other/multi-cd"],
  ["pushd /work/a && popd && rm -rf *", "ask safetyCheck/dangerousRemoval"],
  ["pushd /work/a && popd x && rm -rf *", "ask safetyCheck/dangerousRemoval"],
  [
    "cd -- /work/a && cd /work/b && rm -rf *",
    "ask safetyCheck/dangerousRemoval",
  ],
  ["cd /work/a && cd .. && rm -rf *", "ask safetyCheck/dangerousRemoval"],
  ["cd /work/a && cd /etc && rm -rf *", "ask safetyCheck/dangerousRemoval"],
  ["cd /work/a && cd $HOME && rm -rf *", "ask safetyCheck/dangerousRemoval"],
  ["cd /work/a; cd /work/b; rm -rf *", "ask safetyCheck/dangerousRemoval"],
  [
    "FOO=1 cd /work/a && cd /work/b && rm -rf *",
    "ask safetyCheck/dangerousRemoval",
  ],
  ["cd /work/a && rmdir x && cd /work/b", "ask other/multi-cd"],
  ["chdir /work/a && cd /work/b && rm -rf x", "ask other/multi-cd"],
  ["cd ~ && cd /work && rm -rf *", "ask subcommandResults"],
  ["(cd /work/sub && rm -rf /)", "ask safetyCheck/dangerousRemoval"],
  ["cd /work && (rm -rf /)", "ask safetyCheck/dangerousRemoval"],
  ["(rm -rf /) > /work/out", "ask safetyCheck/dangerousRemoval"],
  ["(cd /tmp && ls)", "ask other/shell-operators"],
  ["cd sub && (ls)", "ask other/shell-operators"],
]);

function ruleContents(decision: Decision): (string | undefined)[] {
  return (decision.suggestions ?? []).flatMap((suggestion) =>
    suggestion.type === "addRules"
      ? suggestion.rules.map((rule) => rule.ruleContent)
      : [],
  );
}

test("deciding outside a policy scope fails instead of returning a decision", async () => {
  const f = owner();
  let caught: unknown;
  try {
    await f.main.native.nIe({ command: "ls" }, f.context());
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
});

test("main control refuses process owners built from different fixtures", () => {
  const a = owner();
  const b = owner();
  expect(() =>
    createNativeBashMainControl(
      a.state,
      b.main.cwd,
      a.main.pipeline,
      a.main.host,
      async (input) => ({ behavior: "ask", updatedInput: input }),
    ),
  ).toThrow("Native Bash process owners must be shared");
});

test("a prefix reader turns an unmatched command into a prefix rule suggestion", async () => {
  const f = owner();
  const asked: string[] = [];
  const decision = await f.decide("npm test", (context) =>
    f.main.native.nIe({ command: "npm test" }, context, async (command) => {
      asked.push(command);
      return { commandPrefix: "npm test", subcommandPrefixes: new Map() };
    }),
  );
  expect(asked).toEqual(["npm test"]);
  expect(decision.behavior).toBe("passthrough");
  expect(ruleContents(decision)).toEqual(["npm test *"]);
});

test("a compound command collects each subcommand's prefix suggestion", async () => {
  const f = owner();
  const prefixes: Prefix = {
    subcommandPrefixes: new Map([
      ["npm test", { commandPrefix: "npm" }],
      ["npx foo", { commandPrefix: "npx" }],
    ]),
  };
  const decision = await f.decide("npm test; npx foo", (context) =>
    f.main.native.nIe(
      { command: "npm test; npx foo" },
      context,
      async () => prefixes,
    ),
  );
  expect(decision.behavior).toBe("passthrough");
  expect(ruleContents(decision)).toEqual(["npm *", "npx *"]);
});

test("cancelling while prefixes are read aborts the decision", async () => {
  const f = owner();
  let caught: unknown;
  try {
    await f.decide("npm test", (context) =>
      f.main.native.nIe({ command: "npm test" }, context, async () => {
        context.abortController.abort();
        return null;
      }),
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeBashSecurityAbortError);
});

test("compound suggestions are de-duplicated and capped at five rules", async () => {
  const f = owner();
  f.policyHost.ruleSuggestions = (command, s) =>
    known(
      [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: command.split(" ")[0] }],
          behavior: "allow",
          destination: "localSettings",
        },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
      s,
    );
  const decision = await f.decide("a1; a2; a3; a1; a4; a5; a6");
  expect(decision.behavior).toBe("passthrough");
  expect(ruleContents(decision)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
});

test("an ask without suggestions still offers rules for the asking subcommand", async () => {
  const f = owner({ ask: ["npm test"] });
  f.policyHost.ruleSuggestions = (command, s) =>
    known(
      [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: command }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
      s,
    );
  const decision = await f.decide("npm test; npx foo; mkdir a");
  expect(decision.behavior).toBe("ask");
  expect(decision.decisionReason?.type).toBe("subcommandResults");
});

test("observers see the analyzed commands and declaration prefixes", async () => {
  const f = owner();
  const seen: string[] = [];
  const decision = await f.decide("x=1 declare y=2", (context) =>
    f.main.native.nIe(
      { command: "x=1 declare y=2" },
      context,
      undefined,
      undefined,
      undefined,
      undefined,
      (names, kept, uncertain) =>
        seen.push(`declarations:${names}:${String(kept)}:${uncertain}`),
      undefined,
      undefined,
      (commands) => seen.push(`commands:${commands.length}`),
    ),
  );
  expect(seen).toEqual(["commands:1", "declarations:1:false:false"]);
  expect(decision.behavior).toBe("passthrough");
});

test("a caller-supplied declaration reading replaces the observed prefixes", async () => {
  const f = owner();
  const seen: string[] = [];
  const decision = await f.decide("x=1 declare y=2", (context) =>
    f.main.native.nIe(
      { command: "x=1 declare y=2" },
      context,
      undefined,
      undefined,
      undefined,
      [true],
      (names) => seen.push(`declarations:${names}`),
    ),
  );
  expect(seen).toEqual([]);
  expect(label(decision)).toBe("passthrough other/no-rule-match");
});

test("with sandbox auto-allow suspended a heredoc is re-read but still prompts", async () => {
  const f = owner({
    sandbox: true,
    policy: { sandboxAutoAllowSuspended: true },
  });
  const command = "cat <<EOF | grep a\nx\nEOF";
  const reads: number[] = [];
  const declarations: string[] = [];
  const decision = await f.decide(command, (context) =>
    f.main.native.nIe(
      { command },
      context,
      undefined,
      undefined,
      undefined,
      undefined,
      (names) => declarations.push(String(names)),
      undefined,
      undefined,
      (commands) => reads.push(commands.length),
    ),
  );
  // Both pipeline stages are re-read, but with auto-allow suspended the
  // heredoc still prompts.
  expect(reads).toEqual([2]);
  expect(declarations).toEqual([]);
  expect(label(decision)).toBe("ask other/too-complex");
});

// Once a dangerous removal inside a subshell is found, a later failure while
// refining that prompt must not lose it.
function failingAfterRemoval(failure: () => unknown) {
  const f = owner();
  const reported: unknown[] = [];
  let found = false;
  f.main.host.telemetry = (event, _metadata, s) => {
    if (event === "tengu_bash_dangerous_rm_too_complex") found = true;
    return known(undefined, s);
  };
  const live = f.main.host.livePolicy;
  f.main.host.livePolicy = (context, s) => {
    if (found) throw failure();
    if (live === undefined) throw new Error("Missing live policy");
    return live(context, s);
  };
  f.main.host.reportError = (error, s) => {
    reported.push(error);
    return known(undefined, s);
  };
  return { ...f, reported };
}

async function outcome(run: () => Promise<Decision>) {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

test("a failure after a subshell removal is found reports it and keeps the prompt", async () => {
  const failure = new Error("policy store unavailable");
  const f = failingAfterRemoval(() => failure);
  const decision = await f.decide("(rm -rf /)");
  expect(label(decision)).toBe("ask safetyCheck/dangerousRemoval");
  expect(f.reported).toEqual([failure]);
});

test("a failing error reporter does not lose the subshell removal prompt", async () => {
  const f = failingAfterRemoval(() => new Error("policy store unavailable"));
  f.main.host.reportError = () => {
    throw new Error("reporter offline");
  };
  expect(label(await f.decide("(rm -rf /)"))).toBe(
    "ask safetyCheck/dangerousRemoval",
  );
});

test("an unsupported reporter after a subshell removal is surfaced", async () => {
  const f = failingAfterRemoval(() => new Error("policy store unavailable"));
  f.main.host.reportError = () => {
    throw new NativeBashSecurityUnsupported("errors.report", "offline");
  };
  expect(await outcome(() => f.decide("(rm -rf /)"))).toBeInstanceOf(
    NativeBashSecurityUnsupported,
  );
});

test("an unsupported capability after a subshell removal is surfaced", async () => {
  const f = failingAfterRemoval(
    () => new NativeBashSecurityUnsupported("policy.live", "offline"),
  );
  expect(await outcome(() => f.decide("(rm -rf /)"))).toBeInstanceOf(
    NativeBashSecurityUnsupported,
  );
  expect(f.reported).toEqual([]);
});

test("cancellation after a subshell removal is found propagates", async () => {
  const cancelled = new Error("cancelled");
  const f = failingAfterRemoval(() => cancelled);
  f.main.host.isAbortError = (error, s) => known(error === cancelled, s);
  const result = await outcome(() =>
    f.decide("(rm -rf /)", (context) => {
      context.abortController.abort();
      return f.main.native.nIe({ command: "(rm -rf /)" }, context);
    }),
  );
  expect(result).toBe(cancelled);
  expect(f.reported).toEqual([]);
});

test("sandbox auto-allow admits a heredoc pipeline without declaration prefixes", async () => {
  const f = owner({ sandbox: true });
  const command = "cat <<EOF | grep a\nx\nEOF";
  const declarations: number[] = [];
  const decision = await f.decide(command, (context) =>
    f.main.native.nIe(
      { command },
      context,
      undefined,
      undefined,
      undefined,
      undefined,
      (names) => declarations.push(names),
    ),
  );
  expect(declarations).toEqual([]);
  expect(label(decision)).toBe("allow other/-");
});
