import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticResult,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

const f = createNativeBashSemantics(
  createNativeBashParser({ now: () => 0 }),
  createNativeBashPreparationFeatures(),
  createNativeBashSemanticFeatures({
    environment: {},
    home: () => "/home/fixture",
    cpuNow: () => 0,
  }).host,
);

const CMDSUB = "__CMDSUB_OUTPUT__";
// The placeholder for a value only known when the command runs.
const RUNTIME = "__TRACKED_VAR__";

// What a caller sees: each command's prefix assignments then its argv, or the
// refusal.
type Row = [script: string, expected: string[][] | RegExp, bare?: string[]];

function words(result: NativeBashSemanticResult): string[][] {
  assert.equal(result.kind, "simple", JSON.stringify(result));
  return result.kind === "simple"
    ? result.commands.map((c) => [
        ...c.envVars.map((e) => `${e.name}${e.isAppend ? "+" : ""}=${e.value}`),
        ...c.argv,
      ])
    : [];
}

function table(name: string, rows: Row[], options = {}) {
  describe(name, () => {
    for (const [script, expected, bare] of rows)
      test(JSON.stringify(script), async () => {
        const result = await f.analyze(script, options);
        if (expected instanceof RegExp) {
          assert.equal(result.kind, "too-complex");
          if (result.kind === "too-complex")
            assert.match(result.reason, expected);
          return;
        }
        assert.deepEqual(words(result), expected);
        if (bare !== undefined && result.kind === "simple")
          assert.deepEqual(result.bareAssignmentNames, bare);
      });
  });
}

const VARIABLE = /A variable in this command can't be checked/;
const QUOTED = /Quoted text in this command can't be checked/;

table("assignment values carry the value the shell would store", [
  ["x=$(pwd)", [["pwd"]], ["x"]],
  ["y=1; x=$y; echo $x", [["echo", "1"]], ["y", "x"]],
  ["x=$y", VARIABLE],
  ['x=$(pwd); echo "$x"', QUOTED],
  ['x=$(pwd); echo "a$x"', QUOTED],
  [
    'x=$(pwd); echo "--$x"',
    /Argument starting with `-` contains runtime-determined content/,
  ],
  ['x=a; x+=b; echo "$x"', [["echo", "ab"]], ["x", "x"]],
  ["x=$((1)) echo", [[`x=${RUNTIME}`, "echo"]]],
  ["x=$((1)) y=2 echo", [[`x=${RUNTIME}`, "y=2", "echo"]]],
  ["z=$((1)) cat <<< hi", [[`z=${RUNTIME}`, "cat"]]],
  ["x=1 > f echo", [["x=1", "echo"]]],
  ["SECONDS=1 echo", [["SECONDS=1", "echo"]]],
  ["integer_x=1", [], ["integer_x"]],
  [
    "x=1 y=$x echo",
    /Env-prefix value references `\$x` assigned by an earlier env-prefix/,
  ],
  ["x=1; x=$((x+1)) echo", /Arithmetic expansion references variable/],
  ['x=1 echo "$x"', VARIABLE],
  ["a=1 b=2 c=3 echo $a", VARIABLE],
]);

table("PS4 and tilde values are refused unless they are plainly literal", [
  ["PS4=+", [], ["PS4"]],
  ["PROMPT4=ok", [], ["PROMPT4"]],
  ["PS4='${HOME}:x'", [], ["PS4"]],
  ["y=1; PS4=$y", [], ["y", "PS4"]],
  ["PS4+=x", /PS4 \+= cannot be statically verified/],
  ["PS4='$(id)'", /PS4 value outside safe charset/],
  ["PS4=$y", VARIABLE],
  ["x=~/a", /Tilde in assignment value/],
  ["x=a~b", /Tilde in assignment value/],
]);

table(
  "tilde values pass when divergent shapes are read",
  [
    ["x=~/a", [], ["x"]],
    ["x=a~b", [], ["x"]],
  ],
  { readsDivergentShapes: true },
);

table("variables resolve to their tracked value or a runtime placeholder", [
  ["echo $HOME", [["echo", "/home/fixture"]]],
  ['echo "$HOME"', [["echo", "/home/fixture"]]],
  ['echo "h $HOME"', [["echo", "h /home/fixture"]]],
  ['echo "pid $$"', [["echo", `pid ${RUNTIME}`]]],
  ['echo "status $?"', [["echo", `status ${RUNTIME}`]]],
  ['echo "n $#"', [["echo", `n ${RUNTIME}`]]],
  ['echo "r $RANDOM"', [["echo", `r ${RUNTIME}`]]],
  ['echo "b $BASHPID"', [["echo", `b ${RUNTIME}`]]],
  ['echo "s $SECONDS"', [["echo", `s ${RUNTIME}`]]],
  ['echo "l $LINENO"', [["echo", `l ${RUNTIME}`]]],
  ['x=1; echo "$x"', [["echo", "1"]]],
  ['x=a; echo "$x$x"', [["echo", "aa"]]],
  ["x='a b'; echo \"$x\"", [["echo", "a b"]]],
  ['x=--force; echo "$x"', [["echo", "--force"]]],
  ["x=--force; rm $x", [["rm", "--force"]]],
  ["x=ls; $x", [["ls"]]],
  ['x=ls; "$x" -l', [["ls", "-l"]]],
  ['x=ls; "a$x"', [["als"]]],
  ['echo "arg $1"', VARIABLE],
  ['echo "all $@"', VARIABLE],
  ['echo "o $OPTIND"', VARIABLE],
  ['echo "u $UNSETVAR"', VARIABLE],
  ['echo "$REPLY"', VARIABLE],
  ['read; echo "$REPLY"', VARIABLE],
  ["echo $$", VARIABLE],
  ['echo "$$"', QUOTED],
  ['echo "$RANDOM"', QUOTED],
  // Unquoted, a value with blanks or glob characters splits or expands.
  ["x='a b'; echo $x", VARIABLE],
  ["x='a*'; echo $x", VARIABLE],
  ["x=''; echo $x", VARIABLE],
  ["echo -$x", VARIABLE],
  ["$x", VARIABLE],
  ["x=ls; ${x}", /A variable in braces in this command/],
]);

table("words that a shell would expand further are refused", [
  ["echo $(pwd)", /A nested command in this command/],
  ["echo `pwd`", /A nested command in this command/],
  ["echo {a,b}", /Brace expansion/],
  ["echo a{b,c}", /Brace expansion/],
  ["echo {a\\,b}", /Brace expansion/],
  ["echo {a..c}", /A brace pattern in this command/],
  ["echo \\{a,b\\}", /Word contains brace expansion syntax/],
  ["echo x{a\\}b", /Brace body contains backslash-escaped brace/],
  [
    "x=1; echo a$x[1]",
    /zsh \$name\[expr\] \/ \$name:mod in bare concatenation/,
  ],
  ["x=1; echo a$x:h", /zsh \$name\[expr\] \/ \$name:mod in bare concatenation/],
  ["echo $((x))", /Arithmetic expansion references variable or non-literal: x/],
  ["echo $(( 1 + $y ))", VARIABLE],
  ["echo a > f b", /Redirect has multiple targets/],
]);

table("words a shell passes through unchanged", [
  ["echo $((16#ff))", [["echo", RUNTIME]]],
  ["echo $((1)) $((2))", [["echo", RUNTIME, RUNTIME]]],
  ["echo a$((1))", [["echo", `a${RUNTIME}`]]],
  ["echo 2#101", [["echo", "2#101"]]],
  ['echo a"b"c', [["echo", "abc"]]],
  ["echo a'b'c", [["echo", "abc"]]],
  ["echo a=ls", [["echo", "a=ls"]]],
  ["echo a <<< x b", [["echo", "a", "b"]]],
  ["let 'x = 1'", [["let", "x = 1"]]],
  ["for f in $(ls); do echo hi; done", [["ls"], ["echo", "hi"]]],
  ['echo "a$(pwd)b"', [["pwd"], ["echo", `a${CMDSUB}b`]]],
]);
