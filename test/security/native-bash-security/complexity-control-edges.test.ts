import { describe, expect, test } from "bun:test";
import { createComplexityFixture } from "./complexity-fixture.js";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import { known, policy } from "./security-fixture.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityInput as Input,
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityRule as Rule,
  NativeBashSecuritySandboxFacts as SandboxFacts,
} from "../../../src/native-bash-security/security-types.js";

type Fixture = ReturnType<typeof createComplexityFixture>;

function patchSandbox(f: Fixture, patch: Partial<SandboxFacts>) {
  const base = f.policyHost.sandbox;
  if (!base) throw new Error("Missing authored sandbox profile");
  f.policyHost.sandbox = (permission, s) => {
    const fact = base(permission, s);
    if (fact.status !== "known") throw new Error("Missing sandbox fact");
    return known({ ...fact.value, ...patch }, s);
  };
}

function sandboxAdmission(
  f: Fixture,
  input: Input,
  permission: Policy = policy(),
  kind: string | undefined = "command",
) {
  return f.run(() => f.complex.native._Or(input, permission, kind), permission);
}

// The raw-text sandbox admission auto-allows a command only when every
// projected command is a plain invocation whose words the shell cannot turn
// into something else. Anything else falls through (null) to the full checks.
describe("raw-text sandbox auto-allow admission", () => {
  const allowed = [
    ["echo hello", "plain command"],
    ["FOO=bar echo hi", "literal assignment prefix"],
    ["FOO=bar", "bare literal assignment"],
    ["nice -n 5 echo hi", "nice wrapper with literal priority"],
    ["builtin echo hi", "builtin wrapper"],
    ["/usr/bin/env echo", "path-qualified env with no assignments"],
    ["./script.sh", "workspace script runs inside the sandbox"],
    ["test -f file", "file test"],
    ["test $a", "single operand test"],
    ["read -r x", "read into a plain name"],
    ["printf 'a$'", "single-quoted trailing dollar is literal"],
    ['printf "a$"', "double-quoted trailing dollar is literal"],
    ["printf $((1+2))", "arithmetic expansion"],
    ["set -e", "known short option"],
    ["set +x", "known short option off"],
    ["set -o pipefail", "known long option"],
    ["set -euo pipefail", "bundled options ending in -o name"],
    ["set -opipefail", "attached long option"],
    ["set -o", "option listing"],
    ["set -o vi", "editing mode option"],
    ["set -A arr x", "array assignment stops option parsing"],
    ["set -- a b", "positional parameters after --"],
    ["set foo", "positional parameter"],
    ["jobs -l", "job listing"],
    ["print hello", "zsh print literal"],
    ["print -r foo", "zsh print raw literal"],
    ["print 'a*'", "quoted glob is literal"],
    ["find . -name foo", "find with literal name"],
    ["find . -type f", "find with type predicate"],
    ["find . -name '*.ts'", "find with quoted pattern"],
    ['find . -name "$x"', "find with quoted variable pattern"],
    ["find -f dir -name x", "BSD find -f path operand"],
    ["find . -name", "predicate missing its operand"],
    ["make all", "make target"],
    ["env FOO=bar ls", "env wrapper with literal assignment"],
  ] as const;
  test.each(allowed)("%s is auto-allowed (%s)", (command) => {
    const f = createComplexityFixture();
    expect(sandboxAdmission(f, { command })).toMatchObject({
      behavior: "allow",
      updatedInput: { command },
      decisionReason: {
        type: "other",
        reason: "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)",
      },
    });
  });

  const refused = [
    ["", "empty command"],
    ["a=1 b=2", "multiple bare assignments are not projected"],
    ["LD_PRELOAD=/x echo hi", "loader hijack assignment"],
    ['FOO="a b" echo', "quoted assignment value"],
    ["env LD_PRELOAD=/x echo hi", "loader hijack through env"],
    ["env PATH=/x ls", "PATH hijack through env"],
    ["env FOO=$x ls", "expanded value through env"],
    ["make PATH=/tmp/bin", "make passes PATH to its recipes"],
    ["export PATH=/x", "exported PATH"],
    ["declare -x LD_PRELOAD=x", "exported loader hijack"],
    ["command -v ls", "command lookup cannot be unwrapped"],
    ["time", "bare time"],
    ["nohup", "bare nohup"],
    ["timeout abc echo", "timeout with non-duration"],
    ["-foo", "word starting with a dash"],
    ["eval foo", "eval runs arbitrary text"],
    ["rm -rf x", "removal needs its own checks"],
    ["jq . file", "jq programs"],
    ["gawk x", "awk programs"],
    ["printf '%s' $'\\x41'", "ANSI-C quoting"],
    ['printf $"x"', "locale quoting"],
    ["printf `date`", "backtick substitution"],
    ["printf $(date)", "command substitution"],
    ["printf $x-y", "expansion next to a dash"],
    ["printf ${x:=y}", "assigning expansion"],
    ["printf {a,b}", "brace list"],
    ["printf {1..3}", "brace sequence"],
    ["printf {", "unbalanced brace"],
    ["printf x[$i]", "subscript with expansion"],
    ["test -t 0", "terminal test"],
    ["test 1 -eq 2", "arithmetic comparison evaluates operands"],
    ["test x $y z", "expansion in operator position"],
    ["test -n $x $y $z q", "expansion in a long expression"],
    ["test a '>' b", "quoted comparison operator"],
    ["set -k", "unknown short option"],
    ["set -o foo", "unknown long option"],
    ["set -ofoo", "unknown attached long option"],
    ["set -o $x", "expanded option"],
    ["jobs -x cmd", "jobs -x runs a command"],
    ["jobs $x", "expanded jobs operand"],
    ["jobs a '>' b", "quoted redirection character"],
    ["print -P %F", "prompt expansion"],
    ["print $x", "expanded print operand"],
    ["print \\'x", "escaped quote"],
    ["print foo*", "unquoted glob"],
    ["print a '<' b", "quoted redirection character"],
    ["set a '>' b", "quoted redirection character"],
    ["find . -delete", "find deletion"],
    ["find . -name *.ts", "unquoted pattern glob"],
    ["find . -name $x", "unquoted expanded pattern"],
    ["find . -xf", "find flag cluster ending in -f"],
    ["find . '-name' foo", "quoted predicate"],
    ["find . foo*", "unquoted glob operand"],
    ["find -f $dir", "expanded path operand"],
    ["find . $'x'", "ANSI-C quoting"],
    ["find a '>' b", "quoted redirection character"],
    ["echo ${ x}", "zsh brace command"],
    ["echo ${|x}", "valueless substitution"],
    ["echo ${(a)x}", "zsh expansion flags are not projected"],
    ["echo ${x:-(a)}", "parenthesized expansion"],
    ["echo ${x:-$(date)}", "substitution inside an expansion"],
    ["set $x", "expanded set operand"],
    ["cat <<EOF", "heredoc"],
  ] as const;
  test.each(refused)("%s falls through (%s)", (command) => {
    const f = createComplexityFixture();
    expect(sandboxAdmission(f, { command })).toBeNull();
  });

  test("an ask rule on one projected command turns the admission into that ask", () => {
    const f = createComplexityFixture();
    const ask = f.add("ask", "ls:*");
    expect(sandboxAdmission(f, { command: "echo a && ls -la" })).toMatchObject({
      behavior: "ask",
      decisionReason: { type: "rule", rule: ask },
    });
  });

  test("a deny rule message names the trimmed command", () => {
    const f = createComplexityFixture();
    const deny = f.add("deny", "ls:*");
    expect(sandboxAdmission(f, { command: "  ls -la  " })).toMatchObject({
      behavior: "deny",
      message: "Permission to use Bash with command ls -la has been denied.",
      decisionReason: { type: "rule", rule: deny },
    });
  });

  test("admission requires an enabled sandbox with Bash auto-allow", () => {
    const disabled = createComplexityFixture();
    patchSandbox(disabled, { enabled: false });
    expect(sandboxAdmission(disabled, { command: "echo hi" })).toBeNull();
    const manual = createComplexityFixture();
    patchSandbox(manual, { autoAllowBashIfSandboxed: false });
    expect(sandboxAdmission(manual, { command: "echo hi" })).toBeNull();
  });

  test("a command that will run unsandboxed is not auto-allowed", () => {
    const f = createComplexityFixture();
    patchSandbox(f, { unsandboxedCommandsAllowed: true });
    expect(
      sandboxAdmission(f, {
        command: "echo hi",
        dangerouslyDisableSandbox: true,
      }),
    ).toBeNull();
    expect(sandboxAdmission(f, { command: "echo hi" })?.behavior).toBe("allow");
  });

  test("suspended policy data and exempt commands are not auto-allowed", () => {
    const suspended = createComplexityFixture();
    suspended.host.sandboxPolicyDataSuspended = (_p, s) => known(true, s);
    expect(sandboxAdmission(suspended, { command: "echo hi" })).toBeNull();
    const exempt = createComplexityFixture();
    exempt.host.sandboxCommandExempt = (command, s) =>
      known(command === "echo hi", s);
    expect(sandboxAdmission(exempt, { command: "echo hi" })).toBeNull();
    expect(sandboxAdmission(exempt, { command: "echo ho" })?.behavior).toBe(
      "allow",
    );
  });

  test("under the outside-read block admission needs usable sandbox read fences", () => {
    const fenced = createComplexityFixture();
    fenced.policyHost.sandboxReadFencesUsable = (s) => known(true, s);
    fenced.policyHost.globalReadBlock = (s) => known(true, s);
    const blocked = policy({ blockReadsOutsideWorkingDirectories: true });
    expect(
      sandboxAdmission(fenced, { command: "echo hi" }, blocked)?.behavior,
    ).toBe("allow");
    const unfenced = createComplexityFixture();
    unfenced.policyHost.sandboxReadFencesUsable = (s) => known(false, s);
    expect(
      sandboxAdmission(unfenced, { command: "echo hi" }, blocked),
    ).toBeNull();
  });

  test("a served call under the outside-read block is not auto-allowed", () => {
    const f = createComplexityFixture();
    expect(
      sandboxAdmission(
        f,
        { command: "echo hi" },
        policy({ blockReadsOutsideWorkingDirectories: true, servedCall: true }),
      ),
    ).toBeNull();
  });

  test("an aborted or errored parse is never auto-allowed", () => {
    const f = createComplexityFixture();
    expect(
      sandboxAdmission(f, { command: "echo hi" }, policy(), "PARSE_ABORT"),
    ).toBeNull();
  });
});

async function semanticAdmission(
  f: Pick<Fixture, "semantic" | "complex" | "context">,
  command: string,
  permission: Policy = policy(),
) {
  const analysis = await f.semantic.analyze(command);
  if (analysis.kind !== "simple") throw new Error(analysis.kind);
  return f.complex.withPolicyScope(permission, "/work", () =>
    f.complex.native.elt(
      { command },
      permission,
      analysis.commands,
      analysis.bareAssignmentNames,
      f.context("").context,
    ),
  ).result;
}

function sandboxedProcess() {
  const f = createSecurityProcessFixture();
  const base = f.policyHost.sandbox;
  if (!base) throw new Error("Missing authored sandbox profile");
  f.policyHost.sandbox = (permission, s) => {
    const fact = base(permission, s);
    if (fact.status !== "known") throw new Error("Missing sandbox fact");
    return known(
      {
        ...fact.value,
        enabled: true,
        autoAllowBashIfSandboxed: true,
        autoAllowSupported: true,
      },
      s,
    );
  };
  return f;
}

// The semantic sandbox admission reads the parsed commands: environment and
// argument assignments, tilde-user paths, network redirects and removals.
describe("semantic sandbox auto-allow admission", () => {
  const allowed = [
    ["echo hi", "plain command"],
    ["FOO=bar node a.js", "interpreter with a plain variable"],
    ["FOO=$HOME python a.py", "interpreter with an expanded variable"],
    ["FOO='a;b' python a.py", "interpreter with a quoted variable"],
    ["BAR=1 bun x", "bun with a plain variable"],
    ["dd if=in of=out", "dd operands are not assignments"],
    ['python x.py "a b=c d"', "interpreter argument with spaced name"],
    ["make all", "no assignments"],
    ["pushd /tmp", "directory change alone"],
    ["cd x", "directory change alone"],
    ["nohup", "bare wrapper runs nothing"],
  ] as const;
  test.each(allowed)("%s is auto-allowed (%s)", async (command) => {
    const f = createComplexityFixture();
    expect((await semanticAdmission(f, command))?.behavior).toBe("allow");
  });

  const refused = [
    ["PATH=/x node a.js", "PATH hijack before an interpreter"],
    ["NODE_OPTIONS=x python a.py", "interpreter option variable"],
    ["LD_PRELOAD=x echo", "loader hijack"],
    ["FOO=bar echo", "unreviewed variable before a non-interpreter"],
    ["FOO+=bar echo", "appended variable"],
    ["cat < ~other/x", "input from another user's home"],
    ["dd if=~bob/x of=out", "dd input from another user's home"],
    ["make LD_PRELOAD=/tmp/x.so", "make passes the loader hijack on"],
    ["python x.py LD_PRELOAD=x", "interpreter argument assignment"],
    ["echo a+=b", "appending argument assignment"],
    ["echo hi > /dev/tcp/host/80", "network redirect"],
    ["FOO=bar >out", "unreviewed variable with no command"],
    ["export FOO+=bar", "appending export"],
  ] as const;
  test.each(refused)("%s falls through (%s)", async (command) => {
    const f = createComplexityFixture();
    expect(await semanticAdmission(f, command)).toBeNull();
  });

  test("interpreter variables need the trusted closed fallback, a non-relaxed mode and the plover gate", async () => {
    const untrusted = createComplexityFixture();
    untrusted.host.unsandboxedFallbackClosedByTrustedSource = (s) =>
      known(false, s);
    expect(await semanticAdmission(untrusted, "FOO=bar node a.js")).toBeNull();
    const relaxed = createComplexityFixture();
    relaxed.host.permissionMode = (s) => known("relaxed", s);
    expect(await semanticAdmission(relaxed, "FOO=bar node a.js")).toBeNull();
    const ungated = createComplexityFixture();
    ungated.host.readFeature = (_kind, key, fallback, s) =>
      known(key === "tengu_umber_plover" ? false : fallback, s);
    expect(await semanticAdmission(ungated, "FOO=bar node a.js")).toBeNull();
  });

  test("under the outside-read block admission needs usable sandbox read fences", async () => {
    const blocked = policy({ blockReadsOutsideWorkingDirectories: true });
    const fenced = createComplexityFixture();
    fenced.policyHost.sandboxReadFencesUsable = (s) => known(true, s);
    fenced.policyHost.globalReadBlock = (s) => known(true, s);
    expect(
      (await semanticAdmission(fenced, "echo hi", blocked))?.behavior,
    ).toBe("allow");
    const unfenced = createComplexityFixture();
    unfenced.policyHost.sandboxReadFencesUsable = (s) => known(false, s);
    expect(await semanticAdmission(unfenced, "echo hi", blocked)).toBeNull();
  });

  test("dd and interpreter argument exemptions follow their feature gates", async () => {
    const f = createComplexityFixture();
    f.host.readFeature = (_kind, key, fallback, s) =>
      known(
        key === "tengu_plain_sorrel" || key === "tengu_quiet_larkspur"
          ? false
          : fallback,
        s,
      );
    expect(await semanticAdmission(f, "dd if=in of=out")).toBeNull();
    expect(await semanticAdmission(f, 'python x.py "a b=c d"')).toBeNull();
  });

  const removals = [
    ["rm file", "allow", "removal inside the workspace"],
    ["rmdir d", "allow", "directory removal inside the workspace"],
    ["/bin/rm file", "allow", "path-qualified removal"],
    ["rm -rf /work/x", "allow", "absolute workspace removal"],
    ["rm -rf /", null, "root removal"],
    ["cd sub && rm file", null, "removal after cd"],
    ["chdir x; rm y", null, "removal after chdir"],
    ["popd; rm f", null, "removal after popd"],
    ["pushd a; rmdir b", null, "directory removal after pushd"],
  ] as const;
  test.each(removals)("%s -> %p (%s)", async (command, expected) => {
    const f = sandboxedProcess();
    const result = await semanticAdmission(f, command);
    expect(result === null ? null : result.behavior).toBe(expected);
  });
});

type Scenario = Pick<Fixture, "semantic" | "complex" | "context" | "host">;

function recordTelemetry(f: Scenario) {
  const events: string[] = [];
  f.host.telemetry = (event, metadata, s) => {
    events.push(`${event}:${metadata.behavior ?? metadata.kind}`);
    return known(undefined, s);
  };
  return events;
}

function disableRemovalReview(f: Pick<Fixture, "nested">) {
  f.nested.host.dangerousRemovalTimeoutDisabled = (s) => known(true, s);
}

const outsideReadFloor: Decision = {
  behavior: "ask",
  decisionReason: {
    type: "safetyCheck",
    reason: "authored read block",
    circuitBreaker: "outsideReadsBlocked",
    classifierApprovable: false,
  },
};

async function complexDecision(
  f: Scenario,
  command: string,
  options: {
    nodeType?: string;
    tree?: "parsed" | "abort" | "missing";
    readBlock?: Decision;
    wholeCommand?: string;
    rereading?: boolean;
  } = {},
) {
  const tree =
    options.tree === "abort"
      ? f.semantic.parseAbort
      : options.tree === "missing"
        ? null
        : await f.semantic.parse(command);
  const state = f.context(command);
  state.budget.rereading = options.rereading === true;
  const floor = options.readBlock;
  return f.complex.withPolicyScope(policy(), "/work", () =>
    f.complex.native.AOr(
      { command },
      policy(),
      tree,
      options.nodeType,
      floor === undefined ? undefined : () => floor,
      options.wholeCommand,
      false,
      state,
      state.context,
    ),
  ).result;
}

// Commands the parser marks too complex: rule matching, alternate shell
// readings of escaped backtick quotes, removal hazards and exact allows.
describe("too-complex command decisions", () => {
  test("an exact deny rule decides before any reading", async () => {
    const f = createComplexityFixture();
    const deny = f.add("deny", "rm -rf /tmp/x", "projectSettings", false);
    expect(await complexDecision(f, "rm -rf /tmp/x")).toMatchObject({
      behavior: "deny",
      decisionReason: { type: "rule", rule: deny },
    });
  });

  test("a prefix deny reaches a command nested in a compound", async () => {
    const f = createComplexityFixture();
    const deny = f.add("deny", "rm:*", "projectSettings", false);
    const command = "if true; then rm -rf x; fi";
    expect(
      await complexDecision(f, command, { nodeType: "if_statement" }),
    ).toMatchObject({
      behavior: "deny",
      message: `Permission to use Bash with command ${command} has been denied.`,
      decisionReason: { type: "rule", rule: deny },
    });
    expect(
      await complexDecision(f, "if true; then echo x; fi", {
        nodeType: "if_statement",
      }),
    ).toBeNull();
  });

  test("a prefix deny applies to an unreadable command's own segments", async () => {
    const f = createComplexityFixture();
    const deny = f.add("deny", "rm:*", "projectSettings", false);
    expect(
      await complexDecision(f, "echo a; rm x", { tree: "abort" }),
    ).toMatchObject({ behavior: "deny", decisionReason: { rule: deny } });
  });

  test("a prefix deny on a command only visible after de-escaping wins", async () => {
    const f = createComplexityFixture();
    const deny = f.add("deny", "rm:*", "projectSettings", false);
    const command = 'x=`rm \\"f\\"`';
    expect(await complexDecision(f, command)).toMatchObject({
      behavior: "deny",
      decisionReason: { type: "rule", rule: deny },
    });
  });

  // A settings deny rule kept only as text is searched for in the raw command
  // exactly when the parse cannot be trusted to match what the shell runs.
  test("text deny rules are searched only when the parse cannot be trusted", async () => {
    const f = createSecurityProcessFixture();
    const events = recordTelemetry(f);
    const deny: Rule = {
      source: "projectSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Bash", ruleContent: "rm:*" },
    };
    f.raw.deny.push(deny);
    for (const command of [
      "echo a\\ b; rm x",
      "echo a\\\tb; rm x",
      "echo a\\ b; case x in y) rm x;; esac",
    ])
      expect(await complexDecision(f, command)).toBeNull();
    expect(
      await complexDecision(f, "echo a\\ b; rm x", { nodeType: "command" }),
    ).toBeNull();
    expect(events).toEqual([]);
    for (const [command, options] of [
      ['echo a\\ b `rm \\"x\\"`', {}],
      ["echo a\\ b; ${ rm x; }", {}],
      ["echo a\\ b; [[ $x == y ]] && rm x", {}],
      ["echo a\\ \\\nb; rm x", {}],
      ["rm x", {}],
      ["rm x", { tree: "abort" }],
      ["rm x", { tree: "missing" }],
      ["rm x", { nodeType: "ERROR" }],
      ["rm x", { nodeType: "PARSE_ABORT" }],
    ] as const) {
      events.length = 0;
      expect(await complexDecision(f, command, options)).toMatchObject({
        behavior: "deny",
        decisionReason: { type: "rule", rule: deny },
      });
      expect(events).toEqual(["tengu_bash_rule_found_in_text:deny"]);
    }
  });

  test("an edit-denied removal in an alternate reading denies even under a read-block floor", async () => {
    const f = createSecurityProcessFixture();
    const rule = f.deny("/work/secret", "edit");
    const command = 'x=`rm /work/secret \\"y\\"`';
    for (const options of [{}, { readBlock: outsideReadFloor }])
      expect(await complexDecision(f, command, options)).toMatchObject({
        behavior: "deny",
        decisionReason: { type: "rule", rule },
      });
  });

  test("a deny after a directory change in an alternate reading denies", async () => {
    const f = createSecurityProcessFixture();
    const rule = f.deny("/work/secret", "edit");
    expect(
      await complexDecision(f, 'x=`cd \\"sub\\" && rm /work/secret`'),
    ).toMatchObject({
      behavior: "deny",
      decisionReason: { type: "rule", rule },
    });
  });

  test("the read-block floor applies when no reading is denied", async () => {
    const f = createComplexityFixture();
    expect(
      await complexDecision(f, 'x=`echo \\"a\\"`', {
        readBlock: outsideReadFloor,
      }),
    ).toBe(outsideReadFloor);
  });

  test("a denied reading keeps its denial next to a root removal", async () => {
    const f = createSecurityProcessFixture();
    const events = recordTelemetry(f);
    f.deny("/work/secret", "edit");
    const result = await complexDecision(
      f,
      'x=`rm -rf /work/secret / \\"y\\"`',
    );
    expect(result).toMatchObject({
      behavior: "deny",
      decisionReason: { type: "subcommandResults" },
    });
    expect(events).toEqual([
      "tengu_bash_dangerous_rm_too_complex:literalTarget",
    ]);
  });

  const removals = [
    ["rm -rf $UNSET_DIR/", "variable_path", "emptyVariable"],
    ["echo $(rm -rf /)", "root", "literalTarget"],
    ['x=`rm -rf / \\"y\\"`', "root", "literalTarget"],
  ] as const;
  test.each(removals)(
    "%s asks as a dangerous removal (%s)",
    async (command, removalRule, kind) => {
      const f = createSecurityProcessFixture();
      const events = recordTelemetry(f);
      expect(await complexDecision(f, command)).toMatchObject({
        behavior: "ask",
        decisionReason: {
          type: "safetyCheck",
          circuitBreaker: "dangerousRemoval",
          removalRule,
          classifierApprovable: false,
        },
      });
      expect(events).toEqual([`tengu_bash_dangerous_rm_too_complex:${kind}`]);
    },
  );

  test("an unreadable command being re-read is held as an unfinished removal check", async () => {
    const f = createComplexityFixture();
    expect(
      await complexDecision(f, "echo hi", { tree: "abort", rereading: true }),
    ).toMatchObject({
      behavior: "ask",
      decisionReason: {
        circuitBreaker: "dangerousRemoval",
        removalRule: "nestedSpansOverrun",
      },
    });
    expect(await complexDecision(f, "echo hi", { tree: "abort" })).toBeNull();
  });

  test("an ask rule on an alternate reading asks", async () => {
    const f = createComplexityFixture();
    const ask = f.add("ask", "echo:*", "projectSettings", false);
    expect(await complexDecision(f, 'x=`echo \\"a\\"`')).toMatchObject({
      behavior: "ask",
      decisionReason: { type: "rule", rule: ask },
    });
  });

  test("a text ask rule asks and records where it was found", async () => {
    const f = createComplexityFixture();
    const events = recordTelemetry(f);
    const ask = f.add("ask", "echo:*");
    expect(await complexDecision(f, "if true; then echo x; fi")).toMatchObject({
      behavior: "ask",
      decisionReason: { type: "rule", rule: ask },
    });
    expect(events).toEqual(["tengu_bash_rule_found_in_text:ask"]);
  });

  test("a text ask on a line the shell may misread becomes the unparsed-line removal ask", async () => {
    const reviewed = createComplexityFixture();
    const events = recordTelemetry(reviewed);
    reviewed.add("ask", "echo:*");
    const command = "true && echo hi $(";
    const reviewedResult = await complexDecision(reviewed, command);
    expect(reviewedResult).toMatchObject({
      behavior: "ask",
      decisionReason: {
        type: "safetyCheck",
        circuitBreaker: "dangerousRemoval",
        removalRule: "unparsed_line",
      },
    });
    expect(reviewedResult).not.toHaveProperty("matchedAskRule");
    expect(events).toEqual(["tengu_bash_rule_found_in_text:ask"]);
    const unreviewed = createComplexityFixture();
    disableRemovalReview(unreviewed);
    const ask = unreviewed.add("ask", "echo:*");
    expect(await complexDecision(unreviewed, command)).toMatchObject({
      decisionReason: { removalRule: "unparsed_line" },
      matchedAskRule: ask,
    });
  });

  const criticalTargets = [
    ["/", "root"],
    ["..", "root"],
    ["~", "home"],
    ["/work", "other_critical_path"],
    ["/work/*", "other_critical_path"],
    [".", "other_critical_path"],
    ["/usr", "other_critical_path"],
  ] as const;
  test.each(criticalTargets)(
    "a text ask alongside removing %s in an alternate reading keeps the removal ask",
    async (target, removalRule) => {
      const f = createSecurityProcessFixture();
      f.add("ask", "true:*");
      expect(
        await complexDecision(f, `true && x=\`rm -rf ${target} \\"y\\"\``),
      ).toMatchObject({
        behavior: "ask",
        decisionReason: { circuitBreaker: "dangerousRemoval", removalRule },
      });
    },
  );

  test("an exact allow holds only for the exact command the shell reads as parsed", async () => {
    const f = createComplexityFixture();
    const exact = f.add("allow", "echo x");
    expect(
      await complexDecision(f, "echo x ", { nodeType: "command" }),
    ).toMatchObject({
      behavior: "allow",
      decisionReason: { type: "rule", rule: exact },
    });
    for (const spelling of ["echo x  ", " echo x", "echo  x"]) {
      const spaced = createComplexityFixture();
      spaced.add("allow", spelling);
      expect(
        await complexDecision(spaced, "echo x", { nodeType: "command" }),
      ).toBeNull();
    }
    const prefix = createComplexityFixture();
    prefix.add("allow", "echo:*");
    expect(
      await complexDecision(prefix, "echo x", { nodeType: "command" }),
    ).toBeNull();
    const cases = [
      ["rm -rf / $(", "This command could not be checked for dangerous rm"],
      ["echo hi $(", "Claude Code can't be sure it read this command"],
      [
        'echo `echo \\"a\\" $(`',
        "Claude Code can't be sure it read this command",
      ],
    ] as const;
    for (const [command, message] of cases) {
      const g = createComplexityFixture();
      g.add("allow", command);
      const result = await complexDecision(g, command, { nodeType: "command" });
      expect(result).toMatchObject({
        behavior: "ask",
        decisionReason: {
          type: "safetyCheck",
          circuitBreaker: "dangerousRemoval",
          removalRule: "unparsed_line",
        },
      });
      expect(result?.message).toStartWith(message);
    }
  });

  test("an exact allow reached from an outer whole-command check is kept", async () => {
    const f = createComplexityFixture();
    const exact = f.add("allow", "echo hi $(");
    expect(
      await complexDecision(f, "echo hi $(", {
        nodeType: "command",
        wholeCommand: "echo hi $(",
      }),
    ).toMatchObject({ behavior: "allow", decisionReason: { rule: exact } });
  });

  test("an exact ask is returned as is", async () => {
    const f = createComplexityFixture();
    f.add("ask", "echo x", "projectSettings", false);
    expect(
      await complexDecision(f, "echo x", { nodeType: "command" }),
    ).toMatchObject({ behavior: "ask", decisionReason: { type: "rule" } });
  });
});

describe("alternate shell readings of escaped backtick quotes", () => {
  async function readings(
    f: Pick<Fixture, "semantic" | "complex">,
    command: string,
  ) {
    const tree = await f.semantic.parse(command);
    if (tree === null || tree === f.semantic.parseAbort)
      throw new Error("Expected authored tree");
    return f.complex.withPolicyScope(policy(), "/work", () =>
      f.complex.native.COr(command, tree, policy()),
    ).result;
  }

  test("a root removal reading asks, and carries a matched ask rule only when removal review is off", async () => {
    const command = 'x=`rm -rf / \\"y\\"`';
    const plain = createSecurityProcessFixture();
    expect(await readings(plain, command)).toMatchObject({
      behavior: "ask",
      decisionReason: {
        circuitBreaker: "dangerousRemoval",
        removalRule: "root",
      },
    });
    const reviewed = createSecurityProcessFixture();
    reviewed.add("ask", "rm:*", "projectSettings", false);
    const reviewedResult = await readings(reviewed, command);
    expect(reviewedResult).toMatchObject({
      decisionReason: { removalRule: "root" },
    });
    expect(reviewedResult).not.toHaveProperty("matchedAskRule");
    const unreviewed = createSecurityProcessFixture();
    disableRemovalReview(unreviewed);
    const ask = unreviewed.add("ask", "rm:*", "projectSettings", false);
    expect(await readings(unreviewed, command)).toMatchObject({
      decisionReason: { removalRule: "root" },
      matchedAskRule: ask,
    });
  });

  test("a prefix deny on a reading names the whole command", async () => {
    const f = createComplexityFixture();
    const deny = f.add("deny", "rm:*", "projectSettings", false);
    const command = 'x=`rm \\"f\\"`';
    expect(await readings(f, command)).toEqual({
      behavior: "deny",
      message: `Permission to use Bash with command ${command} has been denied.`,
      decisionReason: { type: "rule", rule: deny },
    });
  });

  test("a redirect to an edit-denied file in a reading is denied", async () => {
    const f = createSecurityProcessFixture();
    const rule = f.deny("/work/secret", "edit");
    expect(await readings(f, 'x=`echo \\"a\\" > /work/secret`')).toMatchObject({
      behavior: "deny",
      decisionReason: { rule },
    });
  });

  test("commands without escaped backtick quotes have no alternate reading", async () => {
    const f = createComplexityFixture();
    expect(await readings(f, "echo hi")).toBeUndefined();
    expect(await readings(f, 'echo `echo \\"hi\\"`')).toBeUndefined();
  });
});

test("native complexity checks refuse to run outside a policy scope", () => {
  const f = createComplexityFixture();
  expect(() => f.complex.native.IDt(policy())).toThrow(
    "Missing native complexity scope",
  );
});
