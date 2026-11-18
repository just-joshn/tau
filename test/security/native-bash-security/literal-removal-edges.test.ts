import { test, expect } from "bun:test";
import {
  createNativeBashLiteralRemoval,
  type NativeBashLiteralRemovalCandidate as Candidate,
} from "../../../src/native-bash-security/literal-removal.js";
import type { NativeBashSecurityDecision as Decision } from "../../../src/native-bash-security/security-types.js";
import { gitFixture } from "./git-fixture.js";
import { policy, known } from "./security-fixture.js";

function owner() {
  const f = gitFixture();
  f.host.pathPrimitive = (_kind, path, s) => known(path, s);
  const literal = createNativeBashLiteralRemoval(
    f.semantic,
    f.git.preparation,
    f.git.pathOwner,
  );
  const n = literal.native;
  const run = <T>(check: () => T): T =>
    literal.withPolicyScope(policy(), "/work", check).result;
  return { ...f, literal, n, run };
}

function removalRule(decision: Decision): string | undefined {
  return decision.decisionReason?.type === "safetyCheck"
    ? decision.decisionReason.removalRule
    : undefined;
}

function candidate(target: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    command: "rm",
    target,
    invocation: `rm -rf ${target}`,
    reparsed: false,
    ...extra,
  };
}

test("literal removal refuses process owners that do not share one semantic model", () => {
  const a = gitFixture();
  const b = gitFixture();
  expect(() =>
    createNativeBashLiteralRemoval(
      a.semantic,
      b.git.preparation,
      b.git.pathOwner,
    ),
  ).toThrow();
});

test("removal guidance names the right remedy for each kind of expanded target", () => {
  const { n, run } = owner();
  const decide = (c: Candidate, nested = false) => run(() => n.LOe(c, nested));
  const cases: {
    name: string;
    c: Candidate;
    nested?: boolean;
    rule: string;
    says: string[];
  }[] = [
    {
      name: "unquoted named variable gets a quoted :? guard",
      c: candidate("$BUILD/*"),
      rule: "variable_path",
      says: ['"${BUILD:?}"/*', "stop with an error"],
    },
    {
      name: "fallback to another variable guards the fallback",
      c: candidate('"${BUILD:-$OUT}/"'),
      rule: "variable_path",
      says: ["${BUILD:-${OUT:?}}", "$BUILD or $OUT"],
    },
    {
      name: "a home-like variable is normally set so no guard helps",
      c: candidate('"$HOME/"'),
      rule: "variable_path",
      says: ["$HOME is normally set", "literal absolute path"],
    },
    {
      name: "a positional parameter must be bound",
      c: candidate('"$1/$DIR"'),
      rule: "variable_path",
      says: ["bind $1", "${DIR:?}", "single-quote the script"],
    },
    {
      name: "a reparsed target cannot be protected by pasted quotes",
      c: candidate('"$BUILD/"', { reparsed: true }),
      rule: "variable_path",
      says: ["parsed again before it runs"],
    },
    {
      name: "a target with an unverifiable command substitution",
      c: candidate("$(pwd)/$BUILD"),
      rule: "variable_path",
      says: ["cannot verify part of this target"],
    },
    {
      name: "a target with no variable at all cannot be verified",
      c: candidate("`pwd`/"),
      rule: "variable_path",
      says: ["$VAR", "cannot verify part of this target"],
    },
    {
      name: "a root child target names the top-level directory",
      c: candidate('"$BUILD/etc"', { rootChild: "etc" }),
      rule: "var_root_child",
      says: ["/etc", "${BUILD:?}"],
    },
    {
      name: "a reparsed root child target asks for a literal path",
      c: candidate('"$BUILD/etc"', { rootChild: "etc", reparsed: true }),
      rule: "var_root_child",
      says: ["removes /etc", "parsed again"],
    },
    {
      name: "a variable assigned in the command",
      c: candidate('"$BUILD/"', { assigned: true }),
      rule: "variable_path_set_in_command",
      says: ["${BUILD:?}"],
    },
    {
      name: "inside a command substitution",
      c: candidate('"$BUILD/"'),
      nested: true,
      rule: "variable_path",
      says: ["(inside a command substitution)"],
    },
    {
      name: "a derived value inside a command substitution",
      c: candidate('"$BUILD/"', {
        derived: { value: "$(pwd)", becomes: "prints the current directory" },
      }),
      nested: true,
      rule: "derived_var",
      says: ["sets $BUILD from `$(pwd)`", "(inside a command substitution)"],
    },
    {
      name: "a derived value on a composite target names the first variable",
      c: candidate('"$A$B/"', {
        derived: { value: "$(pwd)", becomes: "prints the current directory" },
      }),
      rule: "derived_var",
      says: ["sets $A from"],
    },
  ];
  for (const { name, c, nested, rule, says } of cases) {
    const d = decide(c, nested);
    expect({ name, behavior: d.behavior }).toEqual({ name, behavior: "ask" });
    expect({ name, rule: removalRule(d) }).toEqual({ name, rule });
    for (const s of says)
      expect({ name, has: d.message?.includes(s) }).toEqual({
        name,
        has: true,
      });
  }
});

test("command heads see through redirections, wrappers and their options", () => {
  const { n, run } = owner();
  const hits = [
    '2>/dev/null rm -rf "$BUILD/"',
    '> log rm -rf "$BUILD/"',
    'sudo -u root rm -rf "$BUILD/"',
    'sudo -E -- rm -rf "$BUILD/"',
    'timeout 5 rm -rf "$BUILD/"',
    'nice -n 5 rm -rf "$BUILD/"',
    'env -i X=1 rm -rf "$BUILD/"',
    'nohup $WRAP rm -rf "$BUILD/"',
    'xargs -0 rm -rf "$BUILD/"',
    '/usr/bin/sudo /bin/rm -rf "$BUILD/"',
    '\\rm -rf "$BUILD/"',
    'if true; then rm -rf "$BUILD/"; fi',
    'rmdir "$BUILD/"',
  ];
  for (const command of hits)
    expect({ command, hit: run(() => n.FOe(command)) !== null }).toEqual({
      command,
      hit: true,
    });
  const misses = [
    // the redirect target is a file the shell opens, not an rm operand
    'rm -rf . 2> "$LOG/"',
    'rm -rf . > "$LOG/"',
    // a wrapper option value that is itself a removal word is not the command
    'echo "$BUILD/" rm',
    'printf rm "$BUILD/"',
  ];
  for (const command of misses)
    expect({ command, hit: run(() => n.FOe(command)) }).toEqual({
      command,
      hit: null,
    });
});

test("long removal invocations are shortened but keep the dangerous target", () => {
  const { n, run } = owner();
  const many = Array.from({ length: 30 }, (_, i) => `file${i}`).join(" ");
  const late = run(() => n.FOe(`rm -rf ${many} "$BUILD/"`));
  expect(late?.target).toBe('"$BUILD/"');
  expect(late?.invocation.endsWith('… "$BUILD/"')).toBe(true);
  expect(late?.invocation.startsWith("rm -rf file0")).toBe(true);
  const early = run(() => n.FOe(`rm -rf "$BUILD/" ${many}`));
  expect(early?.target).toBe('"$BUILD/"');
  expect(early?.invocation.endsWith("…")).toBe(true);
  expect(early?.invocation.length).toBe(121);
});

// Bash runs every word after a mid-command redirection as an operand, so each
// of these removes "$BUILD/" (the filesystem root when BUILD is empty). The
// command splitter drops the words that follow the redirection, so the guard
// never sees the target.
for (const command of [
  'rm -rf 2>/dev/null "$BUILD/"',
  'rm -rf 2> /dev/null "$BUILD/"',
  'rm 2>&1 -rf "$BUILD/"',
  'sudo 2>/dev/null rm -rf "$BUILD/"',
  'nice >log rm -rf "$BUILD/"',
])
  test.failing(
    `KNOWN-GAP mid-command redirection hides the target: ${command}`,
    () => {
      const { n, run } = owner();
      expect(run(() => n.FOe(command))?.target).toBe('"$BUILD/"');
    },
  );

type Tracked = "set" | "rootValued" | "emptied" | "untracked";
function tracked(
  a: {
    set: ReadonlySet<string>;
    emptied: ReadonlySet<string>;
    rootValued: ReadonlySet<string>;
  },
  name: string,
): Tracked {
  if (a.rootValued.has(name)) return "rootValued";
  if (a.set.has(name)) return "set";
  if (a.emptied.has(name)) return "emptied";
  return "untracked";
}

test("assignment tracking follows how bash binds a variable before the removal", () => {
  const { n, run } = owner();
  const unsetEnv = () => true;
  const cases: [string, string, Tracked][] = [
    // for loops bind the loop variable to each word
    ['for D in a b; do rm -rf "$D/"; done', "D", "set"],
    ['for D in /; do rm -rf "$D/"; done', "D", "rootValued"],
    // an expanded or empty word list may bind nothing usable
    ['for D in "$@"; do rm -rf "$D/"; done', "D", "untracked"],
    ['for D in ""; do rm -rf "$D/"; done', "D", "untracked"],
    // unset in any command position clears the value
    ['if true; then unset -v D; fi; rm -rf "$D/"', "D", "emptied"],
    // export/local/declare still assign in this shell
    ['export D=./out; rm -rf "$D/"', "D", "set"],
    ['local -r D=./out; rm -rf "$D/"', "D", "set"],
    // a prefix assignment only reaches the one command's environment
    ['D=./out make; rm -rf "$D/"', "D", "untracked"],
    // several assignments on one line all bind
    ['A=./a D=./out; rm -rf "$D/"', "D", "set"],
    // a conditional first assignment may never run
    ['false || D=./out; rm -rf "$D/"', "D", "emptied"],
    // ...but it keeps an earlier unconditional value
    ['D=./a; false || D=./b; rm -rf "$D/"', "D", "set"],
    ['D=/; false || D=./b; rm -rf "$D/"', "D", "rootValued"],
    // copying a variable copies what is known about it
    ['D=$O; rm -rf "$D/"', "D", "emptied"],
    ['O=./x; D=$O; rm -rf "$D/"', "D", "set"],
    ['O=/; D=$O; rm -rf "$D/"', "D", "rootValued"],
    ['unset O; D=$O; rm -rf "$D/"', "D", "emptied"],
    ['D=$HOME; rm -rf "$D/"', "D", "rootValued"],
    ['D=..; rm -rf "$D/"', "D", "rootValued"],
    ['D=""; rm -rf "$D/"', "D", "emptied"],
    // a trap body runs at exit, after later assignments
    ["trap 'rm -rf \"$D/\"' EXIT; D=./out", "D", "set"],
    // an escaped newline joins the assignment to its line
    ['D=./o\\\nut; rm -rf "$D/"', "D", "set"],
    // a here-document body is data, terminated or not
    ['cat <<-EOF\n\tD=/\n\tEOF\nD=./out; rm -rf "$D/"', "D", "set"],
    // unterminated, the body runs to the end, so no removal ever runs
    ['D=./out; cat <<EOF\nD=/\nrm -rf "$D/"', "D", "untracked"],
  ];
  const wrong = cases.flatMap(([text, name, want]) => {
    const got = tracked(
      run(() => n.aat(text, unsetEnv)),
      name,
    );
    return got === want ? [] : [{ text, want, got }];
  });
  expect(wrong).toEqual([]);
});

test("assignment tracking explains values derived from commands and other variables", () => {
  const { n, run } = owner();
  const becomes = (text: string, name = "D") =>
    run(() => n.aat(text, () => true)).derived.get(name)?.becomes;
  const cases: [string, string | undefined][] = [
    [
      'D=$(git rev-parse --show-toplevel); rm -rf "$D/"',
      "prints a git value such as the repository root",
    ],
    ['D=`pwd`; rm -rf "$D/"', "prints the current directory"],
    ['D="$(pwd)"; rm -rf "$D/"', "prints the current directory"],
    [
      'D=$(dirname "$F"); rm -rf "$D/"',
      "prints the current directory (as `.`) when its input is empty",
    ],
    ['D=$(dirname /etc/hosts); rm -rf "$D/"', "prints /etc"],
    ['D=$(dirname ./a/b); rm -rf "$D/"', undefined],
    [
      'D=$(cd "$S" && pwd); rm -rf "$D/"',
      'prints the current directory when its input is empty (`cd ""` stays put)',
    ],
    ['D=$(cd ./sub && pwd); rm -rf "$D/"', undefined],
    [
      'D=$(cd ./sub; pwd); rm -rf "$D/"',
      'prints the current directory when its input is empty (`cd ""` stays put)',
    ],
    ['D=$(echo x); rm -rf "$D/"', undefined],
    ['D=$(pwd) x; rm -rf "$D/"', undefined],
    ['D=$BASE/etc; rm -rf "$D/"', "is /etc when the variable in it is empty"],
    [
      'D=$BASE/; rm -rf "$D/"',
      "is the filesystem root when the variable in it is empty",
    ],
    ['D=$PWD; rm -rf "$D/"', "is the current directory"],
    ['A=$(pwd); D=$A; rm -rf "$D/"', "prints the current directory"],
    ['D=$(pwd); D=./safe; rm -rf "$D/"', undefined],
    ['D=$(pwd); false || D=./x; rm -rf "$D/"', "prints the current directory"],
  ];
  const wrong = cases.flatMap(([text, want]) => {
    const got = becomes(text);
    return got === want ? [] : [{ text, want, got }];
  });
  expect(wrong).toEqual([]);
});

test("assignment tracking reads only a bounded prefix of a huge command", () => {
  const { n, run } = owner();
  const late = `${"#".repeat(10_000)}\nD=/; rm -rf "$D/"`;
  expect(
    tracked(
      run(() => n.aat(late, () => true)),
      "D",
    ),
  ).toBe("untracked");
});
