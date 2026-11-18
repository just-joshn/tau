import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createBashPermissionSession,
  type BashPermissionSessionProfile,
  type BashRuleAdmission,
} from "../../src/bash-permission-session.js";
import type { ToolPolicy } from "../../src/tool-policy.js";

function fixture(initial: Partial<ToolPolicy> = {}) {
  let policy: ToolPolicy = {
    allowedTools: [],
    disallowedTools: [],
    ...initial,
  };
  let profile: BashPermissionSessionProfile = {
    kind: "ordinary-local-posix",
    mode: "default",
    restricted: false,
    servedCall: false,
  };
  let admission: (rule: string) => BashRuleAdmission = () => ({
    status: "admit",
  });
  const session = createBashPermissionSession({
    policy: () => policy,
    profile: () => profile,
    admitRule: (rule) => admission(rule.rule),
  });
  return {
    session,
    evaluate(command: string) {
      return session.evaluate({
        command,
        signal: new AbortController().signal,
      });
    },
    policy(value: ToolPolicy) {
      policy = value;
    },
    profile(value: Partial<BashPermissionSessionProfile>) {
      profile = { ...profile, ...value };
    },
    admission(value: typeof admission) {
      admission = value;
    },
  };
}

test("simple literal commands preserve exact and prefix phase distinctions", () => {
  const f = fixture({ allowedTools: ["Bash(printf:*)"] });
  const bare = f.evaluate("printf");
  assert.equal(bare.status, "classified");
  assert.equal(bare.exact.allow?.rule, "Bash(printf:*)");
  const argument = f.evaluate("printf '%s' owned");
  assert.equal(argument.exact.allow, undefined);
  assert.equal(argument.prefix.allow?.rule, "Bash(printf:*)");
  assert.deepEqual(argument.nativeArgv, ["printf", "%s", "owned"]);
  assert.equal(f.evaluate("printfake owned").prefix.allow, undefined);
  assert.equal(
    f.evaluate("printf\towned").prefix.allow?.matchedText,
    "printf\towned",
  );
});

test("literal exact rules retain allow whitespace but restrictive argv adds normalized words", () => {
  const f = fixture({
    allowedTools: ["Bash(echo owned)"],
    askedTools: ["Bash(echo owned)"],
    disallowedTools: ["Bash(echo owned)"],
  });
  const r = f.evaluate("  echo   'owned'  ");
  assert.equal(r.status, "classified");
  assert.equal(r.exact.allow, undefined);
  assert.equal(r.exact.deny?.matchedText, "echo owned");
  assert.equal(r.exact.ask?.matchedText, "echo owned");
  assert.equal(r.exact.deny?.source, "cliArg");
});

test("executable-only dequoting and escaped literal argv agree with bounded native variants", () => {
  const f = fixture({
    allowedTools: ["Bash(printf:*)"],
    askedTools: ["Bash(printf own ed)"],
  });
  const r = f.evaluate("p'rint'f own\\ ed");
  assert.equal(r.status, "classified");
  assert.equal(r.prefix.allow?.matchedText, "printf own\\ ed");
  assert.equal(r.exact.ask?.matchedText, "printf own ed");
  assert.deepEqual(r.nativeArgv, ["printf", "own ed"]);
  assert.equal(
    f.evaluate('"printf" "owned text"').prefix.allow?.matchedText,
    'printf "owned text"',
  );
});

test("absolute executable basename variant is restrictive only", () => {
  const f = fixture({
    allowedTools: ["Bash(printf:*)"],
    disallowedTools: ["Bash(printf:*)"],
  });
  const r = f.evaluate("/usr/bin/printf owned");
  assert.equal(r.status, "classified");
  assert.equal(r.prefix.deny?.matchedText, "printf owned");
  assert.equal(r.prefix.allow, undefined);
});

test("argument wildcard is native text matching, not a prefix or regex matcher", () => {
  const f = fixture({ allowedTools: ["Bash(echo owned*)"] });
  assert.equal(f.evaluate("echo owned.txt").prefix.allow?.resolved, true);
  assert.equal(f.evaluate("echo OWNED.txt").prefix.allow, undefined);
  assert.equal(f.evaluate("echo owned.txt").exact.allow, undefined);
  f.policy({ allowedTools: ["Bash(echo file?.txt)"], disallowedTools: [] });
  assert.equal(f.evaluate("echo file1.txt").prefix.allow, undefined);
  assert.equal(f.evaluate("echo 'file?.txt'").exact.allow, undefined);
  f.policy({ allowedTools: ["Bash(echo *)"], disallowedTools: [] });
  assert.equal(f.evaluate("echo").prefix.allow?.rule, "Bash(echo *)");
});

test("xargs prefix and wildcard fallback retain native trailing-star asymmetry", () => {
  const f = fixture({ allowedTools: ["Bash(echo:*)"] });
  assert.equal(
    f.evaluate("xargs echo owned").prefix.allow?.rule,
    "Bash(echo:*)",
  );
  assert.equal(f.evaluate("xargs echoing owned").prefix.allow, undefined);
  f.policy({
    allowedTools: ["Bash(echo own*d)"],
    disallowedTools: ["Bash(echo own*d)"],
  });
  const noTail = f.evaluate("xargs echo owned");
  assert.equal(noTail.prefix.allow, undefined);
  assert.equal(noTail.prefix.deny?.rule, "Bash(echo own*d)");
  f.policy({ allowedTools: ["Bash(echo own*)"], disallowedTools: [] });
  assert.equal(
    f.evaluate("xargs echo owned").prefix.allow?.rule,
    "Bash(echo own*)",
  );
});

test("unresolved executable wildcard boundary suppresses allow but preserves restrictive metadata", () => {
  const f = fixture({ allowedTools: ["Bash(ec*)"], askedTools: ["Bash(ec*)"] });
  const r = f.evaluate("echo owned");
  assert.equal(r.status, "unsupported");
  assert.equal(r.prefix.allow, undefined);
  assert.equal(r.prefix.ask?.source, "cliArg");
  assert.equal(r.prefix.ask?.matchedText, "echo owned");
  assert.ok(
    r.unsupported.some(
      (item) => item.rule?.rule === "Bash(ec*)" && item.reason.includes("dOr"),
    ),
  );
});

test("compound, substitution and redirect commands never inherit a simple-rule grant", () => {
  const f = fixture({
    allowedTools: ["Bash(echo:*)"],
    disallowedTools: ["Bash(echo:*)"],
  });
  for (const command of [
    "echo one; printf two",
    "echo $(printf owned)",
    "echo owned > topic.md",
    "echo `printf owned`",
    "echo owned | cat",
    "echo $OWNED",
    "echo *.md",
  ]) {
    const r = f.evaluate(command);
    assert.equal(r.status, "unsupported", command);
    assert.equal(r.prefix.allow, undefined, command);
    assert.equal(r.prefix.deny?.rule, "Bash(echo:*)", command);
    assert.equal(r.prefix.deny?.resolved, false, command);
  }
});

test("quoted metacharacters remain literal while double-quote evaluation and malformed words are unresolved", () => {
  const f = fixture({ allowedTools: ["Bash(echo:*)"] });
  const literal = f.evaluate("echo '; $OWNED *.md # owned'");
  assert.equal(literal.status, "classified");
  assert.deepEqual(literal.nativeArgv, ["echo", "; $OWNED *.md # owned"]);
  assert.equal(literal.prefix.allow?.resolved, true);
  for (const command of [
    'echo "$OWNED"',
    'echo "own\\ed"',
    "echo 'unterminated",
    "echo own\\",
    "echo one\necho two",
    "echo \0",
    "echo " + "x".repeat(10_000),
  ])
    assert.equal(
      f.evaluate(command).status,
      "unsupported",
      command.slice(0, 40),
    );
});

test("environment and source wrapper preparation cannot be invented from literal tokens", () => {
  const f = fixture({ allowedTools: ["Bash(printf:*)"] });
  for (const command of [
    "OWNED=yes printf x",
    "env OWNED=yes printf x",
    "timeout 2 printf x",
    "command printf x",
    "/usr/bin/sudo printf x",
    "nohup printf x",
    "taskset 1 printf x",
    "flock -c 'printf x' lock",
    "nocorrect printf x",
  ])
    assert.equal(f.evaluate(command).status, "unsupported", command);
});

test("dequoting a literal executable cannot silently invent a simple candidate", () => {
  const f = fixture({ allowedTools: ["Bash(owned;name:*)", "Bash(owned*)"] });
  for (const command of [
    "'owned;name' argument",
    "'owned*name' argument",
    "'owned name' argument",
  ]) {
    const r = f.evaluate(command);
    assert.equal(r.status, "unsupported");
    assert.equal(r.prefix.allow, undefined);
  }
});

test("source-ordered content dedupe retains last provenance and first insertion position", () => {
  const f = fixture({
    allowedTools: ["Bash(echo:*)"],
    sourcedRules: [
      {
        rule: "Bash(echo:*)",
        source: "session",
        behavior: "allow",
        path: "/owned/session",
      },
      {
        rule: "Bash(echo:*)",
        source: "userSettings",
        behavior: "allow",
        path: "/owned/settings",
      },
      { rule: "Bash(echo owned)", source: "projectSettings", behavior: "deny" },
      { rule: "Bash(echo:*)", source: "policySettings", behavior: "ask" },
    ],
  });
  const r = f.evaluate("echo owned");
  assert.equal(r.prefix.allow?.source, "session");
  assert.equal(r.prefix.allow?.path, "/owned/session");
  assert.equal(r.prefix.allow?.origin, "sourced");
  assert.equal(r.exact.deny?.source, "projectSettings");
  assert.equal(r.prefix.ask?.source, "policySettings");
  assert.equal(r.exact.allow, undefined);
});

test("mode/source admission is required and cannot silently discard a restrictive match", () => {
  const f = fixture({
    allowedTools: ["Bash(echo:*)"],
    askedTools: ["Bash(echo:*)"],
  });
  f.profile({ mode: "plan" });
  f.admission(() => ({
    status: "exclude",
    reason: "host auto-mode source gate",
  }));
  const r = f.evaluate("echo owned");
  assert.equal(r.status, "unsupported");
  assert.equal(r.prefix.allow, undefined);
  assert.equal(r.prefix.ask?.resolved, false);
  assert.ok(r.diagnostics.some((text) => text.includes("grant excluded")));
  assert.ok(r.unsupported.some((item) => item.rule?.behavior === "ask"));
});

test("unknown provenance and protected profiles retain restrictive evidence without authorizing", () => {
  const f = fixture({
    allowedTools: ["Bash(echo:*)"],
    sourcedRules: [
      { rule: "Bash(echo:*)", source: "unproved-host", behavior: "deny" },
    ],
  });
  let r = f.evaluate("echo owned");
  assert.equal(r.status, "unsupported");
  assert.equal(r.prefix.deny?.source, "unproved-host");
  assert.equal(r.prefix.allow, undefined);
  f.policy({ allowedTools: ["Bash(echo:*)"], disallowedTools: [] });
  f.profile({ restricted: true });
  r = f.evaluate("echo owned");
  assert.equal(r.status, "unsupported");
  assert.equal(r.prefix.allow, undefined);
});

test("certified and command-origin exception hosts are explicit unsupported branches", () => {
  const f = fixture({
    allowedTools: ["Bash(certified: echo owned)"],
    disallowedTools: ["Bash(certified: echo owned)"],
  });
  const r = f.evaluate("echo owned");
  assert.equal(r.status, "unsupported");
  assert.equal(r.exact.deny, undefined);
  assert.equal(r.prefix.deny, undefined);
  assert.ok(r.unsupported.some((item) => item.reason.includes("Certified")));
  f.policy({
    allowedTools: [],
    disallowedTools: [],
    sourcedRules: [
      { source: "command", behavior: "deny", rule: "Bash(echo:*)" },
    ],
  });
  const command = f.evaluate("echo owned");
  assert.equal(command.status, "unsupported");
  assert.equal(command.prefix.deny?.source, "command");
});

test("effective live policy changes recompile without resurrecting removed launch rules", () => {
  const f = fixture({ allowedTools: ["Bash(echo:*)"] });
  const first = f.evaluate("echo owned");
  assert.equal(f.evaluate("echo next").generation, first.generation);
  f.policy({ allowedTools: [], disallowedTools: [] });
  const removed = f.evaluate("echo owned");
  assert.equal(removed.prefix.allow, undefined);
  assert.ok(removed.generation > first.generation);
  f.session.invalidate();
  assert.ok(f.evaluate("echo owned").generation > removed.generation);
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      f.session.evaluate({ command: "echo owned", signal: controller.signal }),
    /abort/i,
  );
});
