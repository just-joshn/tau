import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticOptions,
  type NativeBashSemanticResult,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

const parser = createNativeBashParser({ now: () => 0 });
const features = createNativeBashPreparationFeatures();
const f = createNativeBashSemantics(
  parser,
  features,
  createNativeBashSemanticFeatures({
    environment: {},
    home: () => "/home/fixture",
    cpuNow: () => 0,
  }).host,
);

// What a caller sees: the argv of every command it would run, or the refusal.
type Expected = string[][] | RegExp;
// Every name the script leaves assigned, in the order the analysis reports.
type Row = [script: string, expected: Expected, bare?: string[]];

function check(result: NativeBashSemanticResult, [, expected, bare]: Row) {
  if (expected instanceof RegExp) {
    assert.equal(result.kind, "too-complex");
    if (result.kind === "too-complex") assert.match(result.reason, expected);
    return;
  }
  assert.equal(result.kind, "simple", JSON.stringify(result));
  if (result.kind !== "simple") return;
  assert.deepEqual(
    result.commands.map((c) => c.argv),
    expected,
  );
  if (bare !== undefined) assert.deepEqual(result.bareAssignmentNames, bare);
}

function table(
  name: string,
  rows: Row[],
  run: (script: string) => Promise<NativeBashSemanticResult>,
) {
  describe(name, () => {
    for (const row of rows)
      test(row[0], async () => check(await run(row[0]), row));
  });
}

const analyze = (script: string) => f.analyze(script);
const asBash = (script: string) =>
  features.asBashReads(() => f.analyze(script));
const divergent = (script: string) =>
  f.analyze(script, { readsDivergentShapes: true });
function withTree(options: NativeBashSemanticOptions) {
  return async (script: string) => {
    const tree = parser.parse(script);
    assert.ok(tree !== null);
    return f.analyzeTree(script, tree, options);
  };
}

const SAME_SHELL = /can't be checked before it runs/;

table(
  "command and builtin prefixes keep tracking what the wrapped command assigns",
  [
    ["builtin time ls", [["builtin", "time", "ls"]], []],
    ["command command ls", [["command", "command", "ls"]], []],
    ["builtin noglob ls", /'builtin noglob' runs the wrapped command on zsh/],
    ["command noglob ls", /'command noglob' runs the wrapped command on zsh/],
    ["command -V read", [["command", "-V", "read"]], []],
    ["command builtin read x", [["command", "builtin", "read", "x"]], ["x"]],
    ["command -p read x", [["command", "-p", "read", "x"]], ["x"]],
    ["builtin -p read x", [["builtin", "-p", "read", "x"]], ["x"]],
    ["command ! read x", [["command", "!", "read", "x"]], ["x"]],
    ["! read x", [["read", "x"]], ["x"]],
    ["command x=1", [["command", "x=1"]], ["x"]],
    ["builtin x+=1", [["builtin", "x+=1"]], ["x"]],
    ["command -v x=1", [["command", "-v", "x=1"]], ["x"]],
    ["command ls *.c", [["command", "ls", "*.c"]], []],
    ["builtin [ -f x ]", [["builtin", "[", "-f", "x", "]"]], []],
    // zsh reads a glob or subscript after `command`/`noglob` differently.
    ["command a[1]=2", /'command a\[1\]=2' has a pattern the shell may expand/],
    ["noglob x=*.txt", /'noglob x=\*\.txt' has a pattern the shell may expand/],
    ["command export a=1", [["command", "export", "a=1"]], ["a"]],
  ],
  analyze,
);

table(
  "glob-bearing wrapper operands pass when divergent shapes are read",
  [
    ["command a[1]=2", [["command", "a[1]=2"]], ["a"]],
    ["noglob x=*.txt", [["noglob", "x=*.txt"]], ["x"]],
  ],
  divergent,
);

table(
  "read assigns every NAME operand and option argument it names",
  [
    ["read", [["read"]], []],
    ["read -r", [["read", "-r"]], []],
    ["read -a", [["read", "-a"]], []],
    ["read -rn", [["read", "-rn"]], []],
    ["read 1x", [["read", "1x"]], []],
    ["read -- x", [["read", "--", "x"]], ["x"]],
    ["read -p prompt x", [["read", "-p", "prompt", "x"]], ["x"]],
    ["read -n 1 x", [["read", "-n", "1", "x"]], ["x"]],
    ["read -u 3 x", [["read", "-u", "3", "x"]], ["x"]],
    ["read -d , x", [["read", "-d", ",", "x"]], ["x"]],
    ["read -i def x", [["read", "-i", "def", "x"]], ["x"]],
    ["read -N 3 x", [["read", "-N", "3", "x"]], ["x"]],
    ["read -t 5 x y", [["read", "-t", "5", "x", "y"]], ["x", "y"]],
    ["read -ra arr", [["read", "-ra", "arr"]], ["arr"]],
    // `-ax` fuses the array name, so `arr` is an ordinary NAME.
    ["read -ax arr", [["read", "-ax", "arr"]], ["x", "arr"]],
    ["read -sr x", [["read", "-sr", "x"]], ["x"]],
    ["read -rp prompt x", [["read", "-rp", "prompt", "x"]], ["x"]],
    ["read -rt5 x", [["read", "-rt5", "x"]], ["x"]],
    ["read -e x", [["read", "-e", "x"]], ["x"]],
    ['x=1; read -p "$x" y', [["read", "-p", "1", "y"]], ["x", "y"]],
    ["read IFS", /'read' writes shell variable IFS/],
    ["read PATH", /'read' writes shell variable PATH/],
  ],
  analyze,
);

table(
  "read of a NAME the script already set refuses zsh-only subscript and prompt forms",
  [
    ["x=1; read x", [["read", "x"]], ["x", "x"]],
    ["x=1; read -t 1 x", [["read", "-t", "1", "x"]], ["x", "x"]],
    ["x=1; read -a x", [["read", "-a", "x"]], ["x", "x"]],
    ["x=1; read -p p x", [["read", "-p", "p", "x"]], ["x", "x"]],
    ["x=1; read x[1]", /In zsh, 'read x\[…\]' can set x differently/],
    ["x=1; read 'x[1]'", /In zsh, 'read x\[…\]' can set x differently/],
    ["x=1; read x?prompt", /In zsh, 'read x\?…' can set x differently/],
    ['x=1; read "x?prompt"', /In zsh, 'read x\?…' can set x differently/],
  ],
  analyze,
);

table(
  "read run the way bash reads it skips the zsh read rules",
  [
    ["x=1; read x[1]", [["read", "x[1]"]], ["x"]],
    ["x=1; read x?prompt", [["read", "x?prompt"]], ["x"]],
    ["read IFS", [["read", "IFS"]], []],
    ["read -n 1 x", [["read", "-n", "1", "x"]], []],
    ["command -p read x", [["command", "-p", "read", "x"]], []],
  ],
  asBash,
);

table(
  "printf -v, print -v, getopts and wait -p assign their target NAME",
  [
    ["printf -v", [["printf", "-v"]], []],
    ["printf -v out %s hi", [["printf", "-v", "out", "%s", "hi"]], ["out"]],
    ["printf -vout %s", [["printf", "-vout", "%s"]], ["out"]],
    ["printf -- -v x", [["printf", "--", "-v", "x"]], []],
    ["printf %s -v x", [["printf", "%s", "-v", "x"]], []],
    ["printf -v PATH %s x", /'printf' writes shell variable PATH/],
    ["getopts ab", [["getopts", "ab"]], []],
    ["getopts ab opt", [["getopts", "ab", "opt"]], ["opt"]],
    ["getopts -- ab opt", [["getopts", "--", "ab", "opt"]], ["opt"]],
    ["getopts ab opt arg1", [["getopts", "ab", "opt", "arg1"]], ["opt"]],
    ["wait -n", [["wait", "-n"]], []],
    ["wait -p", [["wait", "-p"]], []],
    ["wait -p pid", [["wait", "-p", "pid"]], ["pid"]],
    ["wait -fp pid", [["wait", "-fp", "pid"]], ["pid"]],
    ["wait -ppid", [["wait", "-ppid"]], ["pid"]],
    ["wait -- -p x", [["wait", "--", "-p", "x"]], []],
    ["wait 1 2", [["wait", "1", "2"]], []],
    ["print -v", [["print", "-v"]], []],
    ["print -v out hi", [["print", "-v", "out", "hi"]], ["out"]],
    ["print -vout hi", [["print", "-vout", "hi"]], ["out"]],
    ["print -rv out hi", [["print", "-rv", "out", "hi"]], ["out"]],
    ["print -f fmt x", [["print", "-f", "fmt", "x"]], []],
    ["print -C 2 a b", [["print", "-C", "2", "a", "b"]], []],
    ["print -nr hi", [["print", "-nr", "hi"]], []],
    ["print -- -v x", [["print", "--", "-v", "x"]], []],
    ["print - -v x", [["print", "-", "-v", "x"]], []],
  ],
  analyze,
);

table(
  "set -A, mapfile and readarray assign the array they name",
  [
    ["set -A", [["set", "-A"]], []],
    ["set -A arr a b", [["set", "-A", "arr", "a", "b"]], ["arr"]],
    ["set -Aarr a", [["set", "-Aarr", "a"]], ["arr"]],
    ["set +A arr x", [["set", "+A", "arr", "x"]], ["arr"]],
    ["set -o vi -A arr", [["set", "-o", "vi", "-A", "arr"]], ["arr"]],
    ["set -e -A arr x", [["set", "-e", "-A", "arr", "x"]], ["arr"]],
    ["set -- -A x", [["set", "--", "-A", "x"]], []],
    ["set a b", [["set", "a", "b"]], []],
    ["set -o", [["set", "-o"]], []],
    ["mapfile", [["mapfile"]], []],
    ["mapfile -t", [["mapfile", "-t"]], []],
    ["mapfile -t lines", [["mapfile", "-t", "lines"]], ["lines"]],
    ["readarray arr", [["readarray", "arr"]], ["arr"]],
    [
      "mapfile -d , -n 3 -O 1 -s 1 -u 3 -C cb -c 10 arr",
      [
        [
          "mapfile",
          "-d",
          ",",
          "-n",
          "3",
          "-O",
          "1",
          "-s",
          "1",
          "-u",
          "3",
          "-C",
          "cb",
          "-c",
          "10",
          "arr",
        ],
      ],
      ["arr"],
    ],
    ["readarray -t PATH", /'readarray' writes shell variable PATH/],
  ],
  analyze,
);

table(
  "cd, pushd and popd change the directory variables later commands read",
  [
    ["cd /tmp", [["cd", "/tmp"]], []],
    ["chdir /tmp", [["chdir", "/tmp"]], []],
    ["command cd /tmp", [["command", "cd", "/tmp"]], []],
    ["pushd /tmp", [["pushd", "/tmp"]], []],
    ["pushd -n /tmp", [["pushd", "-n", "/tmp"]], []],
    ["pushd +1", [["pushd", "+1"]], []],
    ["pushd -- -n", [["pushd", "--", "-n"]], []],
    ["popd", [["popd"]], []],
    ["popd -n", [["popd", "-n"]], []],
    ["popd +1", [["popd", "+1"]], []],
    ["popd -0", [["popd", "-0"]], []],
    ["cd /tmp; echo $PWD", /A variable in this command can't be checked/],
  ],
  analyze,
);

table(
  "unset behind command or builtin is modelled only for plain names and -f/-v",
  [
    ["command unset x", [["command", "unset", "x"]], []],
    ["command unsetenv x", [["command", "unsetenv", "x"]], []],
    [
      "command unset -v x -f",
      /'unset … -f' \(wrapped form\) — flag after name/,
    ],
    ["command unset -n x", /'unset -n' \(wrapped form\)/],
    ["command unset -- x", /'unset --' \(wrapped form\)/],
    ["command unset 'x*'", /unset spelled 'command …' with an operand/],
    ["command unset IFS", /'unset' targets shell variable IFS/],
    [
      "read x; command unset -f x",
      /'x' no longer has a statically known value at this unset \(wrapped form\)/,
    ],
    [
      "x=1; command unset -f x; echo $x",
      [
        ["command", "unset", "-f", "x"],
        ["echo", "1"],
      ],
      ["x"],
    ],
    ["true; command unset x", [["true"], ["command", "unset", "x"]], []],
    // After `true && unset x`, x is set or unset depending on `true`.
    [
      "x=1; true && command unset x; echo $x",
      /A variable in this command can't be checked/,
    ],
  ],
  analyze,
);

table(
  "plain unset clears tracked values and refuses names it cannot model",
  [
    ["unset -v x", [["unset", "-v", "x"]], []],
    ["unset -f", [["unset", "-f"]], []],
    ["unset x y z", [["unset", "x", "y", "z"]], []],
    ["unsetenv FOO", [["unsetenv", "FOO"]], []],
    ["x=1; unsetenv x", [["unsetenv", "x"]], ["x"]],
    [
      "x=1; unset -f x; echo $x",
      [
        ["unset", "-f", "x"],
        ["echo", "1"],
      ],
      ["x"],
    ],
    ["x=1; unset x; echo $x", /A variable in this command can't be checked/],
    ["unset PS4", /'unset' targets shell variable PS4/],
    ["unset BASH_ENV", /'unset' targets shell variable BASH_ENV/],
    ["unset 'x*'", /unset operand ''x\*'' is not a plain variable name/],
    ["unset a[1]", /unset operand 'a\[1\]' carries a subscript/],
  ],
  analyze,
);

table(
  "declarations and prefix assignments report the names they leave set",
  [
    ["typeset -x a=1 b", [["typeset", "-x", "a=1", "b"]], ["a"]],
    ["readonly a=1", [["readonly", "a=1"]], ["a"]],
    ["declare -x a=1 b=2", [["declare", "-x", "a=1", "b=2"]], ["a", "b"]],
    ["local -r a=1", [["local", "-r", "a=1"]], ["a"]],
    ["export PATH=/bin", [["export", "PATH=/bin"]], ["PATH"]],
    ["x=1 :", [[":"]], ["x"]],
    ["x=1 set a", [["set", "a"]], ["x"]],
    ["x=1 shift", [["shift"]], ["x"]],
    // A prefix on a regular command does not outlive it.
    ["x=1 true", [["true"]], []],
    ["x=1 readonly y=2", [["readonly", "y=2"]], ["y", "x"]],
    ["integer x=1", [["integer", "x=1"]], []],
    ["declare +m x", /declare flag \+m — zsh -m\/\+m pattern-assigns/],
    ["local -- a=1 -m", /local flag -m — zsh -m\/\+m pattern-assigns/],
    ["export -n -- x=1", /export -n with an assignment/],
    ["IFS=: export y", /IFS assignment changes word-splitting/],
    ["command declare -m 'x*'", /declare spelled 'command …'/],
    ["declare -a arr=(1 2)", /declare flag -a changes assignment semantics/],
  ],
  analyze,
);

describe("a prefix in front of a declaration reports whether bash keeps it", () => {
  const rows: [string, boolean[]][] = [
    ["x=1 export y", [false]],
    ["x=1 export -x y", [false]],
    ["x=1 local y", [false]],
    ["a=1 export a", [true]],
    ["command x=1 export y", [false]],
  ];
  for (const [script, keeps] of rows)
    test(script, async () => {
      const result = await f.analyze(script);
      assert.equal(result.kind, "simple");
      assert.equal(result.declarationPrefixes, keeps.length);
      assert.deepEqual(result.declarationPrefixBashKeeps, keeps);
    });
});

table(
  "a declaration prefix bash keeps sets the variable for later commands",
  [
    [
      "x=1 export y; echo $x",
      [
        ["export", "y"],
        ["echo", "1"],
      ],
      [],
    ],
    [
      "true; x=1 export y; echo $x",
      [["true"], ["export", "y"], ["echo", "1"]],
      [],
    ],
    [
      "x=1; x+=2 export y; echo $x",
      [
        ["export", "y"],
        ["echo", "12"],
      ],
      ["x"],
    ],
    ["x=1 declare -x y", [["declare", "-x", "y"]], []],
    ["command a=1 export y", [["command", "a=1", "export", "y"]], ["a"]],
    ["x=$y export z", SAME_SHELL],
    ["x+=2 export y; echo $x", /A variable set in front of export/],
    ["read x; x+=2 export y", /A variable set in front of export/],
    ["PATH=/x export y", /A variable set in front of export/],
    ["IFS=x export y", /IFS assignment changes word-splitting/],
  ],
  withTree({ declarationPrefix: [true] }),
);

table(
  "two kept declaration prefixes",
  [
    [
      "a=1 b=2 export y; echo $a $b",
      [
        ["export", "y"],
        ["echo", "1", "2"],
      ],
      [],
    ],
    ["command a=1 b=2 export y", /A variable set in front of export/],
  ],
  withTree({ declarationPrefix: [true, true] }),
);

table(
  "a declaration prefix bash drops leaves the variable unset",
  [["x=1 export y; echo $x", /A variable in this command can't be checked/]],
  withTree({ declarationPrefix: [false] }),
);

test("a declaration-prefix reading that does not match the prefixes is refused", async () => {
  const run = withTree({ declarationPrefix: [true, true, true] });
  const result = await run("x=1 export y");
  assert.equal(result.kind, "too-complex");
  if (result.kind === "too-complex")
    assert.match(
      result.reason,
      /variables set in front of declarations in this command can't be checked/,
    );
});

table(
  "with the reading rule off, a zsh-only read form of a set NAME passes",
  [["x=1; read x[1]", [["read", "x[1]"]], ["x", "x"]]],
  (script) => features.withoutReadingRule(() => f.analyze(script)),
);

describe("with the zsh wrapper and nested read rules rolled back", () => {
  // A reader that reports the rollout payload turned both rules off.
  const off = () => ({
    value: false,
    source: "payload",
    defaultHost: true,
  });
  const rolledBack = createNativeBashPreparationFeatures({
    stagedReader: off,
    nestedReader: off,
  });
  const g = createNativeBashSemantics(
    parser,
    rolledBack,
    createNativeBashSemanticFeatures({
      environment: {},
      home: () => "/home/fixture",
      cpuNow: () => 0,
    }).host,
  );
  const rows: Row[] = [
    ["command a[1]=2", [["command", "a[1]=2"]], ["a"]],
    ["noglob x=*.txt", [["noglob", "x=*.txt"]], ["x"]],
    ["builtin -p read x", [["builtin", "-p", "read", "x"]], ["x"]],
    ["x=1; read x[1]", [["read", "x[1]"]], ["x", "x"]],
  ];
  for (const row of rows)
    test(row[0], async () => check(await g.analyze(row[0]), row));
});
