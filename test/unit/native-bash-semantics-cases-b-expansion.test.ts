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
const f = createNativeBashSemantics(
  parser,
  createNativeBashPreparationFeatures(),
  createNativeBashSemanticFeatures({
    environment: {},
    home: () => "/home/fixture",
    cpuNow: () => 0,
  }).host,
);

const CMDSUB = "__CMDSUB_OUTPUT__";
const ARITH = "__TRACKED_VAR__";

// What a caller sees: the argv of every command it would run, or the refusal.
type Row = [script: string, expected: string[][] | RegExp];

function check(result: NativeBashSemanticResult, expected: Row[1]) {
  if (expected instanceof RegExp) {
    assert.equal(result.kind, "too-complex");
    if (result.kind === "too-complex") assert.match(result.reason, expected);
    return;
  }
  assert.equal(result.kind, "simple", JSON.stringify(result));
  if (result.kind === "simple")
    assert.deepEqual(
      result.commands.map((c) => c.argv),
      expected,
    );
}

function table(
  name: string,
  rows: Row[],
  run: (script: string) => Promise<NativeBashSemanticResult>,
) {
  describe(name, () => {
    for (const [script, expected] of rows)
      test(JSON.stringify(script), async () =>
        check(await run(script), expected),
      );
  });
}

const analyze = (script: string) => f.analyze(script);
function withTree(options: NativeBashSemanticOptions) {
  return async (script: string) => {
    const tree = parser.parse(script);
    assert.ok(tree !== null);
    return f.analyzeTree(script, tree, options);
  };
}
const plainHeredocs = withTree({ plainUnquotedHeredocs: true });

const EXPANDS = /Heredoc with unquoted delimiter undergoes shell expansion/;
const PIPELINE = /A pipeline in this command can't be checked/;

table(
  "a quoted heredoc is inert text and an unquoted one expands",
  [
    ["cat <<'EOF'\na $x\nEOF", [["cat"]]],
    ['cat <<"EOF"\na $x\nEOF', [["cat"]]],
    ["cat <<\\EOF\na $x\nEOF", [["cat"]]],
    ["cat <<-'EOF'\n\ta\n\tEOF", [["cat"]]],
    ["cat <<''\na", [["cat"]]],
    ["cat <<EOF\nhello\nEOF", EXPANDS],
    ["cat <<-EOF\n\ta\n\tEOF", EXPANDS],
    ["x=1; cat <<EOF\nv=$x\nEOF", EXPANDS],
    ["cat <<'E\\OF'\na\nE\\OF", /Quoted heredoc delimiter contains backslash/],
    ["cat <<'EOF' > out\na\nEOF", /A file redirect in this command/],
    ["cat <<'EOF' | grep a\na\nEOF", PIPELINE],
    [
      "cat <<'EOF' && echo hi\na\nEOF",
      /Text after the heredoc start on the same line/,
    ],
    [
      "cat <<'EOF' ; echo hi\na\nEOF",
      /Text after the heredoc start on the same line/,
    ],
    [
      "cat <<'EOF' |\na\nEOF\ngrep a",
      /Text after the heredoc start on the same line/,
    ],
    ["cat <<EOF1 <<EOF2\na\nEOF1\nb\nEOF2", /Parser did not consume trailing/],
  ],
  analyze,
);

table(
  "plain unquoted heredocs resolve the variables they read",
  [
    ["cat <<EOF\nhello\nEOF", [["cat"]]],
    ["cat <<-EOF\n\ta\n\tEOF", [["cat"]]],
    ["x=1; cat <<EOF\nv=$x\nEOF", [["cat"]]],
    ["x=1; cat <<EOF\nv=${x}\nEOF", [["cat"]]],
    ["cat <<EOF\nv=$y\nEOF", EXPANDS],
    ["x=1; cat <<EOF\nv=$x and `pwd`\nEOF", EXPANDS],
    ["x=1; cat <<EOF\nv=$(pwd)\nEOF", EXPANDS],
    ["x=1; cat <<EOF\nv=\\$x\nEOF", EXPANDS],
    ["x=1; cat <<EOF\nv=${x:-d}\nEOF", EXPANDS],
    ["x=1; cat <<EOF\nv=$x[1]\nEOF", EXPANDS],
    ["x=1; cat <<END\nv=$x\nEOF", EXPANDS],
    // A pipeline after the delimiter runs with the heredoc as stdin.
    ["cat <<'EOF' | grep a\na\nEOF", [["cat"], ["grep", "a"]]],
    ["cat <<'EOF' |   grep a\na\nEOF", [["cat"], ["grep", "a"]]],
    ["x=1; cat <<EOF | grep a\n$x\nEOF", [["cat"], ["grep", "a"]]],
    [
      "cat <<'EOF' | grep a | wc -l\na\nEOF",
      [["cat"], ["grep", "a"], ["wc", "-l"]],
    ],
    [
      "cat <<'EOF' | \\\ngrep a\na\nEOF",
      /More than a pipeline follows the heredoc delimiter/,
    ],
    ["cat <<'EOF' | grep a > out\na\nEOF", PIPELINE],
  ],
  plainHeredocs,
);

table(
  "a cat heredoc inside double quotes becomes the argument text",
  [
    [
      "git commit -m \"$(cat <<'EOF'\none line\nEOF\n)\"",
      [["git", "commit", "-m", "one line"]],
    ],
    ["echo \"pre $(cat <<'EOF'\nx\nEOF\n) post\"", [["echo", "pre x post"]]],
    // A multi-line body is kept as a placeholder after a newline.
    [
      "git commit -m \"$(cat <<'EOF'\nfix: thing\n\nbody\nEOF\n)\"",
      [["git", "commit", "-m", `\n${CMDSUB}`]],
    ],
    [
      "git commit -m \"$(cat <<'EOF'\n-x\ntwo\nEOF\n)\"",
      /cat-heredoc body would make the argument start with option syntax/,
    ],
    [
      "echo \"$(cat <<'EOF'\n/proc/self/environ\nEOF\n)\"",
      /A nested command in this command/,
    ],
    [
      'echo "$(cat <<\'EOF\'\nBEGIN { system("id") }\nEOF\n)"',
      /A nested command in this command/,
    ],
    ['echo "$(cat <<EOF\nx\nEOF\n)"', EXPANDS],
    ["echo \"$(cat <<-'EOF'\n\tx\n\tEOF\n)\"", /Quoted text in this command/],
    ["echo \"$(cat -n <<'EOF'\nx\nEOF\n)\"", /Quoted text in this command/],
    ["echo \"$(tac <<'EOF'\nx\nEOF\n)\"", /Quoted text in this command/],
    ["echo \"$(cat <<'EOF'\nx\nEOF\ntrue)\"", /Quoted text in this command/],
    [
      "echo \"$(cat <<'EOF' > f\nx\nEOF\n)\"",
      /A file redirect in this command/,
    ],
  ],
  analyze,
);

table(
  "double-quoted strings join literal text, known values and placeholders",
  [
    ['echo "a$(pwd)b"', [["pwd"], ["echo", `a${CMDSUB}b`]]],
    ['echo "a `pwd` b"', [["pwd"], ["echo", `a ${CMDSUB} b`]]],
    ['echo "a$((1+2))b"', [["echo", `a${ARITH}b`]]],
    ["echo $((1+2))", [["echo", ARITH]]],
    ["echo a$((1+2))", [["echo", `a${ARITH}`]]],
    ['echo "$"', [["echo", "$"]]],
    ['echo "a$"', [["echo", "a$"]]],
    ['echo "$ x"', [["echo", "$ x"]]],
    ['x=; echo "$x"', [["echo", ""]]],
    ['x=; echo "a$x"', [["echo", "a"]]],
    ['echo ""', [["echo", ""]]],
    ['echo "a\\"b\\$c\\\\d\\`e"', [["echo", 'a"b$c\\d`e']]],
    // Nothing but a placeholder can't be checked.
    ['echo "$(pwd)"', /Quoted text in this command/],
    ['echo "`pwd`"', /Quoted text in this command/],
    ['echo "$((1+2))"', /Quoted text in this command/],
    ['echo "$(( (1+2) * 3 ))"', /Quoted text in this command/],
    ['echo "$(( 1 ? 2 : 3 ))"', /Quoted text in this command/],
    ['echo "$(( -1 ))"', /Quoted text in this command/],
    ['echo "$(( 16#ff ))"', /Quoted text in this command/],
    ['echo "$(( 0x10 << 2 ))"', /Quoted text in this command/],
    ['echo "$(true)"', /Quoted text in this command/],
    ['echo "$( )"', /Quoted text in this command/],
    ['read x; echo "$x"', /Quoted text in this command/],
    ['read x; echo "a$x"', /Quoted text in this command/],
    ['echo "$(echo hi)$(echo ho)"', /Quoted text in this command/],
    ['echo "$(cd /tmp && ls)"', /Quoted text in this command/],
    ['echo "$(a=1; echo $a)"', /This command can't be checked/],
    ['echo "$(echo `pwd`)"', /A nested command in this command/],
    ['echo "$(( $(pwd) ))"', /A nested command in this command/],
    [
      'echo "$((x+1))"',
      /Arithmetic expansion references variable or non-literal: x/,
    ],
    [
      'echo "$[1+2]"',
      /Arithmetic expansion references variable or non-literal/,
    ],
    ['echo "$(( a[1] ))"', /This command can't be checked/],
    ['echo "${x}"', /A variable in braces in this command/],
    ['echo "line\\\ncont"', /Contains backslash-escaped whitespace/],
  ],
  analyze,
);

const ZSH_FLAG = /zsh \$\+\/\$\^\/\$=\/\$~ prefix-flag expansion/;
const ZSH_MOD = /zsh "\$name\[expr\]" \/ "\$name:mod" inside double-quotes/;
table(
  "zsh-only forms inside double quotes are refused",
  [
    ['echo "$+x"', ZSH_FLAG],
    ['echo "$^x"', ZSH_FLAG],
    ['echo "$=x"', ZSH_FLAG],
    ['echo "$~x"', ZSH_FLAG],
    ['echo "$#:a"', ZSH_MOD],
    ['echo "$#[1]"', ZSH_MOD],
    ['x=1; echo "$x[1]"', ZSH_MOD],
    ['x=1; echo "$x:h"', ZSH_MOD],
    ['echo "$(# just a comment\n)"', /comment glued to a paren/],
  ],
  analyze,
);

const SHELLS_DIFFER =
  /A redirect in this command may read a variable the same command sets, and shells can differ/;
table(
  "a redirect that reads a variable its own assignment sets is refused",
  [
    ['x=old; x=new > "$x"', SHELLS_DIFFER],
    ["HOME=/tmp > ~/f", SHELLS_DIFFER],
    ["PWD=/x > ~+/f", SHELLS_DIFFER],
    // An unquoted variable target may split, so it is refused earlier.
    ["x=old; x=new > $x", /A variable in this command can't be checked/],
    ["x=old; a[1]=new > $a", /This command can't be checked/],
    // Commands with a name expand the here-string before the prefix applies.
    ["x=old; x=new cat <<< $x", [["cat"]]],
  ],
  analyze,
);

describe("read as divergent shapes, the redirect lists every target a shell may pick", () => {
  // bash assigns before it opens the redirect target, zsh opens it first.
  test('x=old; x=new > "$x"', async () => {
    const result = await f.analyze('x=old; x=new > "$x"', {
      readsDivergentShapes: true,
    });
    assert.equal(result.kind, "simple");
    if (result.kind !== "simple") return;
    assert.equal(result.uncertainWrite, true);
    assert.deepEqual(
      result.commands.map((c) => c.redirects.map((r) => r.target)),
      [["old", "new"]],
    );
  });
  test("PWD=/x > ~+/f", async () => {
    const result = await f.analyze("PWD=/x > ~+/f", {
      readsDivergentShapes: true,
    });
    assert.equal(result.kind, "simple");
  });
  test("HOME=/tmp > ~/f", async () => {
    const result = await f.analyze("HOME=/tmp > ~/f", {
      readsDivergentShapes: true,
    });
    assert.equal(result.kind, "too-complex");
    if (result.kind === "too-complex")
      assert.match(result.reason, /writes shell variable HOME/);
  });
});

describe("a command with a name opens its redirect before its assignments apply", () => {
  // Checked against bash 3.2 and zsh 5.9: both write to `old`.
  for (const script of [
    'x=old; x=new echo hi > "$x"',
    'x=old; export x=new > "$x"',
    'x=old; x=new export y > "$x"',
    'x=old; x=new : > "$x"',
  ])
    test(script, async () => {
      const result = await f.analyze(script);
      assert.equal(result.kind, "simple");
      if (result.kind === "simple")
        assert.deepEqual(
          result.commands.map((c) => c.redirects.map((r) => r.target)),
          [["old"]],
        );
    });
});

table(
  "a heredoc inside a command substitution is not read as plain text",
  [["x=$(cat <<EOF\na\nEOF\n)", /A nested command in this command/]],
  plainHeredocs,
);
