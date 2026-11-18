import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";

const parser = () => createNativeBashParser({ now: () => 0 });

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

// Each input holds one construct that another shell may read differently, so
// the root records the matching reason from the parser's reason table.
const misreadings: readonly [input: string, reason: string][] = [
  ["[ a ] b", "words_after_test"],
  ["x=1 {", "reserved_word_after_prefix"],
  ["if :; then x=1 time ls; fi", "reserved_word_after_prefix"],
  ["x=1 time -p -- if", "reserved_word_after_prefix"],
  ["x=1 coproc { :; }", "reserved_word_after_prefix"],
  ["x=1 time 2>&1 >&- then", "reserved_word_after_prefix"],
  ["x=1 time <<<a fi", "reserved_word_after_prefix"],
  ["[[ a =b ]]", "equals_in_test"],
  ["[[ a = #b ]]", "hash_in_test"],
  ["for x in a #b; do :; done", "hash_in_for_list"],
  ["echo 12>f", "digits_before_redirect"],
  ["echo 1&>f", "digits_before_redirect"],
  ["echo a 10>f", "digits_before_redirect"],
  ["echo {a..Z}", "brace_text_read_again"],
  ["echo {A..z}", "brace_text_read_again"],
  ["a[$'x']=1", "dollar_quote_string"],
  ["a['$(id)']=1", "quoted_code_in_subscript"],
  ["a[x]=1 b['`id`']=2", "quoted_code_in_subscript"],
  ["a[((1))]=2", "bracket_word"],
  ["a[((1]=2", "bracket_word"],
  ["a=(['k']=v [\"$(id)\"]=w)", "bracket_word"],
  ["a=(#c\n)", "bracket_word"],
  ["a=(x)y", "bracket_word"],
  ["x=(a", "bracket_word"],
];

test("constructs another shell reads differently record their misreading reason", () => {
  const engine = parser();
  for (const [input, reason] of misreadings) {
    const root = present(engine.parse(input));
    assert.equal(root.misreading, reason, input);
    assert.ok(reason in engine.misreadingReasons, reason);
  }
});

// The same shapes without the ambiguous part stay unremarkable.
const plainNeighbours: readonly string[] = [
  "[[ a ]] b",
  "x=1 time -p ls",
  "x=1 echo",
  "[[ a = b ]]",
  "for x in a#b; do :; done",
  "echo 1>f",
  "echo {a..z}",
  "a[1]=x; echo $'y'",
  "a[$i]=1",
  "a=([k]=$(id))",
  "echo a[b]c",
];

test("the unambiguous neighbour of each misreading carries no reason", () => {
  const engine = parser();
  for (const input of plainNeighbours) {
    const root = present(engine.parse(input));
    assert.equal(root.type, "program", input);
    assert.equal(root.misreading, undefined, input);
  }
});

// zsh reads these differently from bash, so the program is wrapped in an ERROR root.
const zshDifferentials: readonly string[] = [
  "x=1 if true; then :; fi",
  "x=1 then",
  "[[(-n x)]]",
  "echo $\\\nx",
  "echo $\\\n(( 1 ))",
  "echo $$(( 1 ))",
  "echo $(( `a` ))",
  "echo $(( (1 ))",
  "echo $(( 1 ) ))",
];

test("input zsh reads differently wraps the parsed program in an ERROR root", () => {
  const engine = parser();
  for (const input of zshDifferentials) {
    const root = present(engine.parse(input));
    assert.equal(root.type, "ERROR", input);
    assert.equal(root.children.length, 1, input);
    const program = present(root.children[0]);
    assert.equal(program.type, "program", input);
    assert.equal(program.text, root.text, input);
  }
});

test("a keyword after a prefix assignment marks the root it returns", () => {
  const engine = parser();
  assert.equal(
    present(engine.parse("x=1 if true; then :; fi")).keywordAfterPrefix,
    true,
  );
  assert.equal(present(engine.parse("x=1 echo")).keywordAfterPrefix, undefined);
});

function firstOfType(
  root: NativeBashSyntaxNode,
  type: string,
): NativeBashSyntaxNode {
  const stack = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === type) return node;
    stack.push(...[...node.children].reverse());
  }
  assert.fail(`no ${type} node`);
}

// An unterminated group gets a zero-width closing token anchored where its opener ends.
const missingClosers: readonly [
  input: string,
  group: string,
  closer: string,
  at: number,
][] = [
  ["(echo a", "subshell", ")", 1],
  ["{ echo a", "compound_statement", "}", 1],
  ["[ a", "test_command", "]", 1],
  ["[[ -n x", "test_command", "]]", 2],
  ["x=(a", "array", ")", 3],
];

test("an unterminated group ends with a zero-width closer at its opener", () => {
  const engine = parser();
  for (const [input, group, closer, at] of missingClosers) {
    const node = firstOfType(present(engine.parse(input)), group);
    const last = present(node.children.at(-1));
    assert.deepEqual(
      [last.type, last.text, last.startIndex, last.endIndex],
      [closer, "", at, at],
      input,
    );
    assert.equal(node.endIndex, at, input);
  }
});

// Substitution text that a second shell pass could read differently.
const substitutions: readonly [input: string, differs: boolean][] = [
  ["echo $(echo a)", false],
  ["echo $(echo # x\n)", true],
  ['echo $(echo "#")', false],
  ["echo $(echo $'#')", false],
  ["echo $(echo \\#)", false],
  ["echo $(echo $x#)", false],
  ["echo `echo #`", false],
  ["echo <(echo case)", true],
  ["echo $(echo esac)", true],
  ["echo $(echo $)", true],
  ['echo $(echo ")")', false],
  ["echo $(a \\\nb)", false],
  ["echo $(a\\ b)", false],
  ["echo $(cat <<EOF\nx\nEOF\n)", false],
  ["echo $(cat <<-EOF\n\tx\n\tEOF\n)", false],
  ["echo $(cat <<'EOF'\nx\nEOF\n)", false],
  ["echo $(cat <<case\nx\ncase\n)", true],
  ["echo $((1+2))", false],
  ["echo $(( (1+2) ))", false],
  ["echo $(( (1 ))", true],
  ["echo $((  $(a)  ))", true],
  ["(( $(a) ))", true],
  ["for ((i=$(a);;)); do :; done", true],
  ['echo "$[1]"', false],
  ['echo "$[$(a)]"', true],
  ["echo `a` $(b)", false],
];

test("substitution text is flagged exactly when a second read could differ", () => {
  const engine = parser();
  for (const [input, differs] of substitutions) {
    const root = present(engine.parse(input));
    assert.equal(
      engine.hasDifferentialSubstitution(root, Buffer.from(input)),
      differs,
      input,
    );
  }
});

// A heredoc whose delimiter or terminator cannot be pinned down is refused outright.
const refusedHeredocs: readonly string[] = [
  'cat <<"E$x"\nb\nE$x\n',
  'cat <<"E\\x"\nb\nE\\x\n',
  "cat <<`x`",
  "cat <<E\u{1F600}\nb\nE\u{1F600}\n",
  "echo $(cat <<EOF\nx\nEOF)",
];

test("a heredoc with an unscannable delimiter or terminator is refused", () => {
  const engine = parser();
  for (const input of refusedHeredocs)
    assert.equal(engine.parse(input), null, input);
  assert.ok(engine.parse("cat <<E\nb\nE\n"));
});

// A subscript or array element is a bracket word only when its bracketed text
// holds code, blanks or quoting another shell could end somewhere else.
const bracketWords: readonly [input: string, isBracketWord: boolean][] = [
  ["a=(x[$y] x[${y}] x[$((1))])", false],
  ['a=(x["k"])', false],
  ["a=(x['k'])", false],
  ["a=(x[${#y}])", false],
  ['a=(x["$y"])', false],
  ['a=(x[$y]z "q" $w ${v} $((1)))', false],
  ["a=([0]=a [1]+=b)", false],
  ["a=(x[${y:-a b}])", true],
  ["a=(x[${y:+$z}])", true],
  ["a=(x[$(id)])", true],
  ['a=(x["$(id)"])', true],
  ["a=(x[`id`])", true],
  ["a=(x[$((1+(2)))])", true],
  ['a["x y"]=1', false],
  ["a[$((1+2))]=1", false],
  ["a[${x}]=1", false],
  ["a[${#x}]=1", false],
  ["a[${!x}]=1", false],
  ["a[${x:-y}]=1", false],
  ['a["$x"]=1', false],
  ["a['k]']=1", true],
  ["a[$(id)]=1", true],
  ["a[x y]=1", true],
  ['a["`id`"]=1', true],
  ["a[${ x}]=1", true],
  ["a[{x}]=1", true],
  ["a[(( 1 ))]=2", true],
];

test("bracketed subscripts and array elements are bracket words only when another shell could end them elsewhere", () => {
  const engine = parser();
  for (const [input, isBracketWord] of bracketWords)
    assert.equal(
      present(engine.parse(input)).misreading,
      isBracketWord ? "bracket_word" : undefined,
      input,
    );
});
