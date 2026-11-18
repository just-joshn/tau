import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticCommand,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

const CMDSUB = "__CMDSUB_OUTPUT__";

function semantics() {
  const parser = createNativeBashParser({ now: () => 0 });
  const features = createNativeBashPreparationFeatures();
  const host = createNativeBashSemanticFeatures({
    environment: {},
    home: () => "/home/fixture",
    cpuNow: () => 0,
  });
  return {
    f: createNativeBashSemantics(parser, features, host.host),
    features,
  };
}

function command(
  argv: string[],
  other: Partial<NativeBashSemanticCommand> = {},
): NativeBashSemanticCommand {
  return {
    argv,
    envVars: [],
    redirects: [],
    text: argv.join(" "),
    hasUnquotedGlob: false,
    ...other,
  };
}

const { f, features } = semantics();

function refusal(
  argv: string[],
  other: Partial<NativeBashSemanticCommand> = {},
) {
  const verdict = f.commandSafety([command(argv, other)]);
  return verdict.ok ? null : verdict.reason;
}

// Each row: argv the shell would run, and either null (nothing to refuse) or
// a pattern the refusal reason must name.
const wrappers: [string[], RegExp | null][] = [
  [["time"], null],
  [["time", "ls"], null],
  [["time", "a;b"], /'time a;b' can't be checked/],
  [["nohup", "a b"], /'nohup a b' can't be checked/],
  [["timeout"], null],
  [["timeout", "--foreground", "--verbose", "5", "ls"], null],
  [["timeout", "--preserve-status", "5", "ls"], null],
  [["timeout", "--kill-after=5", "--signal=KILL", "5s", "ls"], null],
  [["timeout", "--signal", "KILL", "5", "ls"], null],
  [["timeout", "--signal", "$x", "5", "ls"], /'timeout --signal'/],
  [["timeout", "--frobnicate", "5", "ls"], /'timeout --frobnicate'/],
  [["timeout", "-v", "-k", "5", "-s", "TERM", "1.5m", "ls"], null],
  [["timeout", "-sKILL", "5", "ls"], null],
  [["timeout", "-k", "$(x)", "5", "ls"], /'timeout -k'/],
  [["timeout", "-x", "5", "ls"], /'timeout -x'/],
  [["timeout", "soon", "ls"], /timeout duration 'soon'/],
  [["timeout", "5", "eval", "x"], /'eval' evaluates arguments/],
  [["nice", "-n", "5", "eval", "x"], /'eval' evaluates/],
  [["nice", "-5", "eval", "x"], /'eval' evaluates/],
  [["nice", "$(pick)", "ls"], /nice argument '\$\(pick\)' contains expansion/],
  [["nice", CMDSUB, "ls"], /nice argument .* contains expansion/],
  [["nice", "eval", "x"], /'eval' evaluates/],
  [["env", "A=1", "-i", "-0", "-v", "-u", "B", "eval", "x"], /'eval'/],
  [["env", "--chdir=/", "ls"], /'env --chdir=\/'/],
  [["env", "A=1"], null],
  [["stdbuf", "-o", "L", "eval", "x"], /'eval'/],
  [["stdbuf", "-oL", "--error=0", "eval", "x"], /'eval'/],
  [["stdbuf", "--bogus", "ls"], /'stdbuf --bogus'/],
  [["stdbuf", "-oL"], null],
  [["command", "-p", "eval", "x"], /'eval'/],
  [["command", "-x", "ls"], /'command -x'/],
  [["command", "-v", "eval"], null],
  [["command", "--", "eval", "x"], /'eval'/],
  [["command"], null],
  [["builtin", "--", "eval", "x"], /'eval'/],
  [["builtin", "eval", "x"], /'eval'/],
  [["noglob"], null],
  [["xargs", "find", "."], /What xargs adds to find/],
  [["xargs", "jq", "."], /What xargs adds to jq/],
  [["xargs", "-0", "rm"], null],
  [["xargs", "awk", "{print}"], null],
  [["xargs", "awk", "-F", ":", "--", "{print}"], null],
  [["xargs", "awk", "-F", ":"], /The program xargs gives awk/],
  [["xargs", "awk", "--"], /The program xargs gives awk/],
  [["xargs", "awk", "-"], null],
  [["xargs", "awk", "-vx=1", "{print}"], null],
  [["xargs", "grep", "x"], null],
];

const names: [string[], RegExp | null][] = [
  [[""], /Empty command name/],
  [[CMDSUB, "x"], /runtime-determined \(placeholder argv\[0\]\)/],
  [["-rf"], /incomplete fragment/],
  [["|grep"], /incomplete fragment/],
  [["&x"], /incomplete fragment/],
  [["if"], /Shell keyword 'if'/],
];

const subscripts: [string[], RegExp | null][] = [
  [["test", "-v", "a[1]"], /'test -v' operand contains array subscript/],
  [["[", "-R", CMDSUB], /'\[ -R' operand/],
  [["test", "-t", "fd"], /'test -t' operand is non-numeric/],
  [["[[", "-t", "1", "]]"], null],
  [["test", "-n", "x"], null],
  [["printf", "-v", "a[1]", "%s", "x"], /'printf -v' operand/],
  [["printf", "-vout", "%s"], null],
  [["printf", "-vfoo[1]", "%s"], /'printf -v' \(fused in '-vfoo\[1\]'\)/],
  [["printf", "-vfoo", CMDSUB], /'printf -v' \(combined in '-vfoo'\)/],
  [["printf", "%s", CMDSUB], /printf operand .* is runtime-determined/],
  [
    ["printf", "%d", "a[$(id)]"],
    /printf operand .* array subscript with expansion/,
  ],
  [["wait", "-np", "a[0]"], /'wait -p' \(combined in '-np'\)/],
  [["wait", "-xyz", "a"], null],
  [["read", "-ra", "arr[1]"], /'read -a' \(combined in '-ra'\)/],
  [
    ["[[", "x", "-eq", "1", "]]"],
    /'\[\[ \.\.\. -eq \.\.\.' operand is non-numeric/,
  ],
  [["test", "1", "-lt", "a[0]"], /operand is non-numeric/],
  [["test", "0x1F", "-ge", "-2"], null],
  [["test", "-eq"], null],
  [["test", "1", "-eq"], null],
];

const reads: [string[], RegExp | null][] = [
  [["read", "-t", "abc", "v"], /'read -t' operand 'abc' is non-numeric/],
  [["read", "-t", "1.5", "-n", ".5", "v"], null],
  [
    ["read", "-p", "a[1]", "v"],
    /'read -p' operand 'a\[1\]' is a subscripted NAME/,
  ],
  [["read", "-p", "-x[1]", "v"], /subscripted NAME, dash-prefixed/],
  [["read", "-p", `>${CMDSUB}`, "v"], /'read -p' operand/],
  [["read", "-p", "prompt> ", "v"], null],
  [["read", "-d", "x", "v"], null],
  [["read", "-rt", "x", "v"], /'read -rt' operand 'x' is non-numeric/],
  [["read", "-rp", "a[1]"], /'read -rp' operand/],
  [["read", "-rd", "x", "v"], null],
  [["read", "-rz", "v"], null],
  [["read", "-r", "v"], null],
  [
    ["read", "-t5x", "v"],
    /'read -t' \(fused in '-t5x'\) operand is non-numeric/,
  ],
  [["read", "-t5", "v"], null],
  [["read", "-pfoo[1]"], /'read -p' fused remainder 'foo\[1\]'/],
  [["read", `-p${CMDSUB}`], /'read -p' fused remainder/],
  [["read", "-pok", "v"], null],
  [["read", "-ufd", "v"], null],
  [["read", "x[1]"], /'read' positional NAME 'x\[1\]'/],
  [["unset", "a[1]"], /'unset' positional NAME/],
  [["unset", "-f", "fn"], null],
];

const declarations: [string[], RegExp | null][] = [
  [["declare", "-f", "-u", "fn"], /both -f and -u\/-U/],
  [["readonly", "-fU", "fn"], /both -f and -u\/-U/],
  [["declare", "-n", "ref"], /changes assignment eval semantics/],
  [["export", "-l", "x"], /zsh bin_typeset mathevals/],
  [["export", "-m", "X*"], /-m\/\+m flag/],
  [["private", "+m", "x"], /-m\/\+m flag/],
  [
    ["typeset", "-T", "A", "a"],
    /'typeset -T' creates a user-defined zsh tied pair/,
  ],
  [["declare", "a[$i]=1"], /array subscript with expansion/],
  [
    ["export", CMDSUB],
    /is runtime-determined and may carry an array subscript/,
  ],
  [["integer", "x"], /zsh 'integer' operand/],
  [["float", "-g"], null],
  [["declare", "-x", "A=1"], null],
  [["export", "-p", "A=1"], /export -p with an assignment/],
  [["readonly", "A=1", "A=2"], /readonly names 'A' twice/],
  [["declare", "A=1", "-x"], /comes after the options/],
  [["declare", "--", "A=1"], null],
  [
    ["declare", "-Q", "A"],
    /option '-Q' is not one bash and zsh are both known/,
  ],
  [["local", "A=1"], /'local' outside a function/],
  [["export", "-a", "A"], /export -a|array attribute/],
  [["shift"], null],
];

const builtins: [string[], RegExp | null][] = [
  [["set", "-o", "pipefail", "-e"], null],
  [["set", "-opipefail"], null],
  [
    ["set", "-o", "glob_subst"],
    /'set -o\/\+o glob_subst' changes shell parsing/,
  ],
  [["set", "+o"], null],
  [["set", "-a"], /'set -a' changes shell option state/],
  [["set", "-A", "arr", "x"], null],
  [["set", "--", "-a"], null],
  [["set", "x", "-a"], /'set -a'/],
  [["print", "-P", "%n"], /'print -P'/],
  [["print", "-rn", "x"], null],
  [["jobs", "-x", "ls"], /'jobs -x'/],
  [["jobs", "-l"], null],
  [["zmodload", "zsh/system"], /Zsh builtin 'zmodload'/],
  [["zformat", "-f", "x"], /Zsh builtin 'zformat'/],
  [["stat", "-A", "arr", "f"], /'stat' with -A or -H/],
  [["stat", "-c", "%s", "f"], null],
  [["fc", "-l"], null],
  [["fc", "-e", "vi"], /'fc' evaluates arguments/],
  [["compgen", "-A", "file"], null],
  [["compgen", "-W", "a b"], /'compgen' evaluates arguments/],
  [["watch", "ls"], /What 'watch' starts/],
  [["watch"], null],
  [["cat", "/proc/self/environ"], /\/proc\/\*\/environ/],
];

const programs: [string[], RegExp | null][] = [
  [["jq", 'system("id")'], /jq command contains system\(\)/],
  [["jq", 'include "m"; .'], /include\/import/],
  [["jq", "-rf", "prog.jq"], /jq command contains dangerous flags/],
  [["jq", "--slurpfile", "a", "f"], /dangerous flags/],
  [["jq", "-r", ".a"], null],
  [["awk", 'BEGIN{system("id")}'], /system\(\) which executes/],
  [["awk", '{print | "sh"}'], /command pipe/],
  [["awk", '{"date" | getline d}'], /command pipe/],
  [["awk", "{print}", CMDSUB], /awk is given text that can't be checked/],
  [["gawk", "-f", "prog.awk"], /awk has an option/],
  [["awk", "--include=lib", "{print}"], /awk has an option/],
  [["mawk", "-F:", "{print $1}"], null],
  [["find", ".", "-exec", "rm", "{}", ";"], /find with '-exec'/],
  [["find", ".", "-xf"], /find option '-xf' is read differently/],
  [["find", "-D", "tree", ".", "-name", "a"], null],
  [["find", "-H", ".", "-newer", "x"], null],
  [["find", ".", CMDSUB], /find argument is runtime-determined/],
  [["find", ".", "*.txt"], /find argument '\*\.txt' contains glob characters/],
  [["find", ".", "-name", "*.txt"], null],
];

describe("command safety refuses what it cannot verify and passes the rest", () => {
  const tables: [string, [string[], RegExp | null][]][] = [
    ["wrappers", wrappers],
    ["command names", names],
    ["subscript operands", subscripts],
    ["read operands", reads],
    ["declarations", declarations],
    ["shell builtins", builtins],
    ["program interpreters", programs],
  ];
  for (const [title, rows] of tables)
    test(title, () => {
      for (const [argv, expected] of rows) {
        const reason = refusal(argv);
        if (expected === null) assert.equal(reason, null, argv.join(" "));
        else assert.match(reason ?? "<allowed>", expected, argv.join(" "));
      }
    });
});

test("awk and find refuse unquoted globs the shell would expand first", () => {
  assert.match(
    refusal(["awk", "-f", "*.awk"], { hasUnquotedGlob: true }) ?? "",
    /awk command contains unquoted glob/,
  );
  assert.match(
    refusal(["find", "*"], { hasUnquotedGlob: true }) ?? "",
    /find contains unquoted glob/,
  );
  assert.match(
    refusal(["find", "*"], { argvUnquotedGlob: [false, true] }) ?? "",
    /find contains unquoted glob/,
  );
  const unrecorded = f.commandSafety(
    [command(["find", "*"], { argvUnquotedGlob: [false, true] })],
    { sourceGlobRecord: false },
  );
  assert.match(
    unrecorded.ok ? "" : unrecorded.reason,
    /find argument '\*' contains glob/,
  );
});

test("secret and hidden-argument checks see redirects and environment values", () => {
  assert.match(
    refusal(["cat"], {
      redirects: [{ op: "<", target: "/proc/1/environ" }],
    }) ?? "",
    /\/proc\/\*\/environ/,
  );
  const env = f.commandSafety([
    command(["ls"], { envVars: [{ name: "A", value: "x\n# y" }] }),
  ]);
  assert.deepEqual(env.ok ? null : [env.kind, env.reason], [
    "newline-hash",
    "Newline followed by # inside an env var value can hide arguments from path validation",
  ]);
  assert.deepEqual(
    f.commandSafety([
      command(["ls"], {
        envVars: [{ name: "A", value: "1" }],
        redirects: [{ op: ">", target: "out" }],
      }),
    ]),
    { ok: true },
  );
  const target = f.commandSafety([
    command(["ls"], { redirects: [{ op: ">", target: "x\n#y" }] }),
  ]);
  assert.match(target.ok ? "" : target.reason, /inside a redirect target/);
  // The first newline-hash finding wins and a later hard refusal still overrides it.
  const both = f.commandSafety([
    command(["echo", "a\n#b"], { envVars: [{ name: "A", value: "x\n#y" }] }),
    command(["eval", "x"]),
  ]);
  assert.match(both.ok ? "" : both.reason, /'eval' evaluates/);
});

test("declaration listing checks apply only to the last command of a loop-free list", () => {
  const local = command(["local", "A=1"]);
  const later = command(["true"]);
  assert.equal(f.commandSafety([local, later], { hasLoop: false }).ok, false);
  assert.equal(f.commandSafety([later, local], { hasLoop: false }).ok, true);
  assert.equal(f.commandSafety([later, local]).ok, false);
});

test("zsh helper builtins pass when the environment guard accepts them", async () => {
  const accepted = await features.observeEnvironment(true, () =>
    f.commandSafety([command(["zformat", "-f", "x"])]),
  );
  assert.deepEqual(accepted, { result: { ok: true }, refused: true });
  const statAccepted = await features.observeEnvironment(true, () =>
    f.commandSafety([command(["stat", "-A", "arr", "f"])]),
  );
  assert.equal(statAccepted.result.ok, true);
});

test("dangerous-command name classifier covers evaluators, zsh modules, launchers and removal", () => {
  const n = f.native;
  for (const name of [
    "eval",
    "zmodload",
    "watch",
    "/usr/bin/nsenter",
    "/bin/rm",
    "rmdir.exe",
  ])
    assert.equal(n.qti(name), true, name);
  for (const name of ["ls", "git", "/bin/cat"])
    assert.equal(n.qti(name), false, name);
});

test("shell variables that steer execution are recognised case-insensitively by family", () => {
  const n = f.native;
  for (const name of [
    "PATH",
    "path",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_FUNC_x",
    "IFS",
    "PS4",
    "PROMPT4",
    "RANDOM",
  ])
    assert.equal(n.epe(name), true, name);
  for (const name of ["FOO", "ps4", "PROMPT"])
    assert.equal(n.epe(name), false, name);
});

test("braced expansion bodies are found outside single quotes with nesting and escapes", () => {
  const n = f.native;
  assert.deepEqual(n.Vti("a ${x} '${no}' \"${y:-${z}}\" \\${esc}"), [
    "x",
    "y:-${z}",
  ]);
  assert.deepEqual(n.Vti("${a:-'}'}"), ["a:-'}'"]);
  assert.deepEqual(n.Vti('${a:-"}"}'), ['a:-"}"']);
  assert.deepEqual(n.Vti("${a\\}b}"), ["a\\}b"]);
  assert.deepEqual(n.Vti("${open"), ["open"]);
  assert.deepEqual(n.Vti("$x {y}"), []);
});

test("backslash unescaping keeps quotes and leaves single-quoted text untouched", () => {
  const n = f.native;
  assert.equal(n.JKt("a\\ b"), "a b");
  assert.equal(n.JKt('\\$x \\"y\\"'), "x y");
  assert.equal(n.JKt("'a\\b' \"c\""), "'' \"c\"");
  assert.equal(n.JKt('"it\'s"'), '"it\'s"');
  assert.equal(n.JKt("end\\"), "end");
});

test("quote removal drops quoted text and escaped characters", () => {
  const n = f.native;
  assert.equal(n.Rct('a \'b c\' "d\\"e" f\\ g'), "a   fg");
  assert.equal(n.Rct("plain"), "plain");
});
