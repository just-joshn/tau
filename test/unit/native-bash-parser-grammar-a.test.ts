import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";
import { Rng, testSeed } from "../helpers/seeded.js";

const parser = () => createNativeBashParser({ now: () => 0 });

function nodes(root: NativeBashSyntaxNode): NativeBashSyntaxNode[] {
  return [root, ...root.children.flatMap(nodes)];
}

/** Every node's text is its UTF-8 byte slice and the root reaches the input's end. */
function textViolations(input: string, root: NativeBashSyntaxNode): string[] {
  const bytes = Buffer.from(input);
  const problems = nodes(root)
    .filter(
      (node) =>
        node.startIndex > node.endIndex ||
        bytes.toString("utf8", node.startIndex, node.endIndex) !== node.text,
    )
    .map((node) => `${node.type} text`);
  if (root.endIndex !== bytes.length) problems.push("root does not reach end");
  return problems;
}

/** On well-formed input, additionally, children nest in order inside their parent. */
function spanViolations(input: string, root: NativeBashSyntaxNode): string[] {
  const problems = textViolations(input, root);
  for (const node of nodes(root)) {
    let previous = node.startIndex;
    for (const child of node.children) {
      if (
        child.startIndex < previous ||
        child.endIndex > node.endIndex ||
        child.startIndex > child.endIndex
      )
        problems.push(`${node.type} > ${child.type} span`);
      previous = Math.max(previous, child.endIndex);
    }
  }
  return problems;
}

const corpus: readonly string[] = [
  "echo a |& cat",
  "case $x in a) echo a;;& b) echo b;& c) echo c;; esac",
  'case "$x" in (a|b) echo ab ;; *) : ;; esac',
  "exec 3<&- 4>&-",
  "cat <&3 >&2 2>&1",
  "echo hi >| out &>> log",
  "echo hi &> both",
  'cat <<< "here $x"',
  "cat <<-EOF\n\tbody $x\n\tEOF\n",
  "cat <<'EOF'\nraw $x\nEOF\n",
  'cat << "END" > f\nline\nEND\n',
  "[[ -f a && ( -d b || ! -e c ) ]]",
  "[[ $a == b* ]]",
  "[[ $a =~ ^[0-9]+$ ]]",
  "[[\t-n x ]]",
  "[[\n-n x ]]",
  "[[(-n x)]]",
  '[ -n "$x" ] && [ "$a" = "$b" ]',
  "test -z x",
  "echo $((1 + 2 * (3 - 4) / 5 % 6))",
  "echo $(( a += 1, b <<= 2, c ? d : e ))",
  "(( i++ )); (( --j ))",
  "for ((i = 0; i < 10; i++)); do echo $i; done",
  "for ((;;)); do break; done",
  "select x in a b; do echo $x; done",
  "for x; do echo $x; done",
  'a=(1 2 "three" [4]=four)',
  "a[1]=x; a+=(y); b[$i+1]=z",
  "declare -a arr=(1 2); local -r x=1; export A=1 B; readonly C; typeset -i n=3",
  "x=1 y=2 cmd arg",
  "f() ( echo sub )",
  "function g() { :; }",
  "{ echo a; echo b; } > out",
  "( cd /tmp && ls ) | wc -l",
  "! true",
  "echo ${a:-x} ${a:=y} ${a:+z} ${a:?err} ${a-x}",
  "echo ${#a} ${!a} ${!a*} ${a[@]} ${a[*]} ${#a[@]}",
  "echo ${a#x} ${a##x} ${a%y} ${a%%y} ${a/x/y} ${a//x/y} ${a/#x/y} ${a/%x/y}",
  "echo ${a:1:2} ${a: -1} ${a^} ${a^^} ${a,} ${a,,} ${a@Q}",
  "echo $@ $# $? $$ $! $- $0 $1 $_ $*",
  'echo `date` "`whoami`" "$(id -u)"',
  "echo $'a\\tb\\'c' $'unterminated",
  'echo "a\\"b" \'x\'"y"$\'z\'',
  "diff <(ls a) >(cat)",
  "echo {a,b,c} {1..5} {a..z..2} x{,y}z",
  "echo ~ ~/x ~user/y",
  "echo a\\ b c\\\nd",
  "echo a#b #comment",
  "echo 16#ff $((16#ff)) $((0x1F)) $((2#101))",
  "echo $[1+2]",
  "echo é ü 日本 😀 $'\\u00e9'",
  "echo \"é$x日\" 'ü'",
  'while read -r line; do echo "$line"; done < file',
  "until false; do :; done",
  "if a; then b; elif c; then d; else e; fi",
  "coproc cat",
  "time ls -l",
  "echo $(( $(echo 1) + 2 ))",
  'echo "${a[$i]}" "${a["k"]}"',
  "v=$(cat <<EOF\ninner\nEOF\n)",
  'x=$\'\\x41\' y="${z:-"q"}"',
  "cmd 2>/dev/null 1>&2 0<in",
  "cmd {fd}>file",
  "cmd 10>out",
  "echo a & echo b &",
  'echo "multi\nline"',
  "echo $((a[1]+b))",
  "echo ${a[1]:-x}",
  "((a[1] = 2))",
  "echo $(( (1) ))",
  "echo a $'\\r' b",
  "echo a\r\necho b\r\n",
  "exec {a['x]']}>f",
  'exec {a["k\\"]"]}>f',
  "exec {a[\\]]}>f",
  "exec {a[[1]]}>f",
  "exec {a[1]}>f",
  "exec {fd}<&-",
  "cat <(ls) >(wc)",
  "cat <<-\tEOF\n\tx\n\tEOF\n",
  'x=$((1))$((2)) y=${a}b"c"$d',
  "f() { :; } >out",
  "! { :; } >out",
  "time ! ls",
  "((a[1]))",
  "echo ${a[((1))]}",
  "a[((1 + 2))]=3",
  "echo $[ a[1] ] $(( ${#a} + $$ ))",
];

test("every corpus snippet parses to spans that are exact byte slices of the input", () => {
  const engine = parser();
  for (const input of corpus) {
    const root = engine.parse(input);
    assert.ok(root, input);
    assert.deepEqual(spanViolations(input, root), [], input);
  }
});

const fragments: readonly string[] = [
  "echo",
  " ",
  " ",
  "x",
  "$x",
  "${",
  "}",
  "$(",
  ")",
  "$((",
  "))",
  "(",
  "((",
  "[",
  "]",
  "[[",
  "]]",
  "{",
  "'",
  '"',
  "`",
  "\\",
  "\n",
  "\t",
  ";",
  ";;",
  "&",
  "&&",
  "|",
  "||",
  "|&",
  "<",
  ">",
  "<<",
  "<<-",
  "<<<",
  ">&",
  "2>",
  "#",
  "=",
  "a=",
  "if",
  "then",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "case",
  "esac",
  "while",
  "function",
  "!",
  "$[",
  "]",
  "1",
  "+",
  "-",
  "*",
  ":",
  "é",
  "EOF",
  "$'",
  "\\\n",
  "{a,b}",
  "~",
  "@",
  "%",
  "/",
  ",",
  "..",
  "\r",
];

test("every prefix and generated token soup parses without throwing, with exact node text", () => {
  const engine = parser();
  const rng = new Rng(testSeed());
  const inputs = [
    ...corpus.flatMap((input) => {
      const characters = Array.from(input);
      return characters.map((_, end) => characters.slice(0, end).join(""));
    }),
    ...Array.from({ length: 1500 }, () =>
      Array.from({ length: rng.int(1, 12) }, () => rng.pick(fragments)).join(
        "",
      ),
    ),
  ];
  let refused = 0;
  for (const input of inputs) {
    // A null result is a deliberate refusal (for example an unscannable heredoc delimiter).
    const root = engine.parse(input, 1e9);
    if (root === null) {
      refused++;
      continue;
    }
    assert.deepEqual(textViolations(input, root), [], JSON.stringify(input));
  }
  // Refusals are rare: nearly every generated input yields a tree to check.
  assert.ok(refused * 20 < inputs.length, `${refused} of ${inputs.length}`);
});
