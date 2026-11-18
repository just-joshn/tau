import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticResult,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

const features = createNativeBashPreparationFeatures();
const f = createNativeBashSemantics(
  createNativeBashParser({ now: () => 0 }),
  features,
  createNativeBashSemanticFeatures({
    environment: {},
    home: () => "/home/fixture",
    cpuNow: () => 0,
  }).host,
);

// A later pass of `while true` sees whatever the body wrote on the pass
// before, so `echo "$x"` can only be resolved to 1 when nothing in the body
// may write x.
const loop = (body: string) => `x=1; while true; do echo "$x"; ${body}; done`;
const CHANGED = /'x' was tracked as literal '1' but condition may modify it/;

// Each row: the loop body, and either the argv of the body's command (x is
// untouched, so the loop resolves) or CHANGED / another refusal.
type Row = [body: string, expected: string[] | RegExp];

function check(result: NativeBashSemanticResult, expected: string[] | RegExp) {
  if (expected instanceof RegExp) {
    assert.equal(result.kind, "too-complex");
    if (result.kind === "too-complex") assert.match(result.reason, expected);
    return;
  }
  assert.equal(result.kind, "simple", JSON.stringify(result));
  if (result.kind !== "simple") return;
  assert.equal(result.hasLoop, true);
  assert.deepEqual(
    result.commands.map((c) => c.argv),
    [["true"], ["echo", "1"], expected],
  );
}

function table(
  name: string,
  rows: Row[],
  run: (script: string) => Promise<NativeBashSemanticResult>,
) {
  describe(name, () => {
    for (const [body, expected] of rows)
      test(body, async () => check(await run(loop(body)), expected));
  });
}

table(
  "a loop body that may write x keeps x from resolving",
  [
    ["x=2", CHANGED],
    ["read x", CHANGED],
    ["read -r x", CHANGED],
    ["read -a x", CHANGED],
    ["read -ax", CHANGED],
    ["read -rax", CHANGED],
    ["read -p p x", CHANGED],
    ["read -- x", CHANGED],
    ["read -t 1 -r x", CHANGED],
    ["read -n1 x", CHANGED],
    ["read -rn 1 x", CHANGED],
    ["read x <<< hi", CHANGED],
    ["mapfile x", CHANGED],
    ["readarray -t x", CHANGED],
    ["mapfile -n 1 x", CHANGED],
    ["unset x", CHANGED],
    ["unset -v x", CHANGED],
    ["unset -f x", CHANGED],
    ["unset -- x", CHANGED],
    ["unset -m x", CHANGED],
    ["unset 'x'", CHANGED],
    ["command read x", CHANGED],
    ["builtin read x", CHANGED],
    ["command -v read x", CHANGED],
    ["command -p read x", CHANGED],
    ["builtin -p read x", CHANGED],
    ["command x=2 true", CHANGED],
    ["noglob x=2", CHANGED],
    ["command ! read x", CHANGED],
    ["! read x", CHANGED],
    ["time read x", CHANGED],
    ["nocorrect read x", CHANGED],
    ["command unset x", CHANGED],
    ["declare x=2", CHANGED],
    ["export x=2", CHANGED],
    ["typeset 'x=2'", CHANGED],
    ['declare "x"=2', CHANGED],
    ["readonly x+=2", CHANGED],
    ["x=2 export z", CHANGED],
    ["x=2 :", CHANGED],
    ["x=2 &", CHANGED],
    ["x=2 & true", CHANGED],
    ["true | x=2", CHANGED],
    ["true && x=2", CHANGED],
    ["{ x=2; }", CHANGED],
    ["if true; then x=2; fi", CHANGED],
    ["for x in a; do :; done", CHANGED],
    ["case a in a) x=2;; esac", CHANGED],
    ["while read x; do :; done", CHANGED],
  ],
  (script) => f.analyze(script),
);

table(
  "a loop body that cannot write x lets x resolve",
  [
    ["read y", ["read", "y"]],
    ["read", ["read"]],
    ["read -r -- -x", ["read", "-r", "--", "-x"]],
    ["mapfile -t", ["mapfile", "-t"]],
    // -V only describes the command.
    ["command -V unset x", ["command", "-V", "unset", "x"]],
    ["local x", ["local", "x"]],
    ["declare -- x", ["declare", "--", "x"]],
    // A prefix on a regular command does not outlive it.
    ["x=2 true", ["true"]],
    // Subshells and the left side of a pipe run in a child shell.
    ["(x=2)", ["true"]],
    ["x=2 | true", ["true"]],
    ["[[ -v x ]]", ["[[", "-v", "x"]],
    ["echo hi > f", ["echo", "hi"]],
    ["cat <<< $x", ["cat"]],
  ],
  (script) => f.analyze(script),
);

table(
  "read run the way bash reads it does not count as a write in the loop",
  [
    ["read x", ["read", "x"]],
    ["read -a x", ["read", "-a", "x"]],
    ["read -rax", ["read", "-rax"]],
    ["read -t 1 -r x", ["read", "-t", "1", "-r", "x"]],
    ["command -p read x", ["command", "-p", "read", "x"]],
    ["time read x", ["time", "read", "x"]],
  ],
  (script) => features.asBashReads(() => f.analyze(script)),
);

table(
  "loop bodies the analysis cannot follow",
  [
    ["unset \\x", /unset operand '\\x' is not a plain variable name/],
    ["declare -i x", /declare with a flag that changes assignment semantics/],
    ["declare $k=2", /declare operand '\$k=2' is not a plain NAME/],
    ["f() { x=2; }", /A function definition in this command/],
    ["echo $(x=2)", /A nested command in this command/],
  ],
  (script) => f.analyze(script),
);

describe("writes the loop pass cannot see are caught by comparing a later pass", () => {
  for (const body of ["printf -v x %s 2", "getopts ab x", "wait -p x"])
    test(body, async () => {
      const result = await f.analyze(loop(body));
      assert.equal(result.kind, "simple");
      if (result.kind === "simple") {
        assert.equal(result.hasLoop, true);
        assert.equal(result.laterLoopPassesDiffer, true);
      }
    });
});
