import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";
import {
  createNativeBashParserFeatures,
  type NativeBashFeatureReader,
} from "../../src/native-bash-parser-features.js";

// Grammar families after simple commands: expansions, quoting, compound
// statements, declarations, test expressions and arithmetic. Expected shapes
// follow tree-sitter-bash node names and the parser contract: a non-null tree
// is not a syntax certificate, repairs leave ERROR or zero-width nodes, and a
// dialect differential wraps the whole program in an ERROR root.

/** Switches a guard off the only way a reader can: a payload `false` from the default host. */
const guardOff: NativeBashFeatureReader = () => ({
  value: false,
  source: "payload",
  defaultHost: true,
});
const defaultParser = () => createNativeBashParser({ now: () => 0 });
const guardsOffParser = () =>
  createNativeBashParser({
    now: () => 0,
    features: createNativeBashParserFeatures({
      keywordReader: guardOff,
      grammarReader: guardOff,
      quoteReader: guardOff,
    }),
  });

function nodes(root: NativeBashSyntaxNode): NativeBashSyntaxNode[] {
  return [root, ...root.children.flatMap(nodes)];
}

/** Every node's text is its UTF-8 byte slice of the input, for any input. */
function assertTextMatchesOffsets(
  input: string,
  root: NativeBashSyntaxNode,
): void {
  const bytes = Buffer.from(input);
  for (const node of nodes(root)) {
    assert.ok(node.startIndex <= node.endIndex, `${node.type} span`);
    assert.equal(
      node.text,
      bytes.subarray(node.startIndex, node.endIndex).toString(),
      `${node.type} text is its source slice`,
    );
  }
}

/** Without repairs, children are ordered and nested inside their parent. */
function assertNested(root: NativeBashSyntaxNode): void {
  for (const node of nodes(root)) {
    let previousStart = node.startIndex;
    for (const child of node.children) {
      assert.ok(
        child.startIndex >= previousStart,
        `${child.type} starts in order inside ${node.type}`,
      );
      assert.ok(
        child.endIndex <= node.endIndex,
        `${child.type} ends inside ${node.type}`,
      );
      previousStart = child.startIndex;
    }
  }
}

function parseWith(
  parser: () => ReturnType<typeof createNativeBashParser>,
  input: string,
): NativeBashSyntaxNode {
  const root = parser().parse(input);
  assert.ok(root !== null, "parse returns a tree");
  assertTextMatchesOffsets(input, root);
  assert.deepEqual(
    parser().parse(input),
    root,
    "a fresh parser builds the same tree",
  );
  return root;
}

type Outcome = "plain" | "repaired" | "differential";
type Expected = Outcome | readonly [Outcome, string];
/** [input, outcome with default features, outcome with every reader guard off when it differs]. */
type Row = readonly [string, Expected, Expected?];

function outcomeOf(root: NativeBashSyntaxNode): Expected {
  let outcome: Outcome;
  if (root.type === "ERROR") {
    assert.equal(root.children.length, 1);
    assert.equal(
      root.children[0]?.type,
      "program",
      "a differential root wraps the program",
    );
    outcome = "differential";
  } else {
    assert.equal(root.type, "program");
    const repaired = nodes(root).some(
      (node) => node.type === "ERROR" || node.startIndex === node.endIndex,
    );
    if (!repaired) assertNested(root);
    outcome = repaired ? "repaired" : "plain";
  }
  return root.misreading === undefined ? outcome : [outcome, root.misreading];
}

function assertRow([input, expected, guardsOff = expected]: Row): void {
  assert.deepEqual(
    outcomeOf(parseWith(defaultParser, input)),
    expected,
    "default features",
  );
  assert.deepEqual(
    outcomeOf(parseWith(guardsOffParser, input)),
    guardsOff,
    "guards off",
  );
}

interface ShapeCase {
  name: string;
  input: string;
  root?: "ERROR";
  /** Each entry is a node type, or a [type, exact source text] pair. */
  has: readonly (string | readonly [string, string])[];
  /** Node types or [type, text] pairs that must not appear. */
  lacks?: readonly (string | readonly [string, string])[];
}

function matches(
  node: NativeBashSyntaxNode,
  expected: string | readonly [string, string],
): boolean {
  const [type, text] = typeof expected === "string" ? [expected] : expected;
  return node.type === type && (text === undefined || node.text === text);
}

function assertShape(example: ShapeCase): void {
  const root = parseWith(defaultParser, example.input);
  assert.equal(root.type, example.root ?? "program");
  if (example.root === "ERROR")
    assert.equal(
      root.children[0]?.type,
      "program",
      "a differential root wraps the program",
    );
  const all = nodes(root);
  for (const expected of example.has)
    assert.ok(
      all.some((node) => matches(node, expected)),
      `expected ${JSON.stringify(expected)}`,
    );
  for (const absent of example.lacks ?? [])
    assert.ok(
      !all.some((node) => matches(node, absent)),
      `unexpected ${JSON.stringify(absent)}`,
    );
}

const wordShapes: readonly ShapeCase[] = [
  // ${...} operators
  {
    name: "pattern substitution keeps the pattern as a regex and the replacement as a word",
    input: "echo ${path/old/new}",
    has: ["expansion", ["/", "/"], ["regex", "old"], ["word", "new"]],
  },
  {
    name: "global substitution with a quoted replacement",
    input: 'echo ${path//a*/"b c"}',
    has: [["//", "//"], ["regex", "a*"], "string"],
  },
  {
    name: "anchored prefix and suffix substitution",
    input: "echo ${x/#pre/} ${x/%suf/r}",
    has: [
      ["#", "#"],
      ["%", "%"],
      ["regex", "pre"],
      ["regex", "suf"],
    ],
  },
  {
    name: "substitution whose pattern starts with a double-quoted string",
    input: 'echo ${x/"a b"/c}',
    has: [
      ["string", '"a b"'],
      ["word", "c"],
    ],
  },
  {
    name: "substitution pattern with escapes, single quotes and nested expansions",
    input: "echo ${x/a\\/b/c} ${x/'q'/r} ${x/${y}/z} ${x/$'\\t'/s}",
    has: ["expansion", ["word", "c"], ["word", "z"]],
  },
  {
    name: "substitution replacement that is a command substitution followed by text",
    input: "echo ${x/a/$(date)tail}",
    has: ["command_substitution", ["word", "tail"]],
  },
  {
    name: "substitution replacement that mixes quoting styles",
    input: "echo ${x/a/'raw'\"dq\"$'c'$y`date`}",
    has: [
      "concatenation",
      "raw_string",
      "string",
      "ansi_c_string",
      "simple_expansion",
    ],
  },
  {
    name: "prefix and suffix removal",
    input: "echo ${x#*.} ${x##*/} ${x%.*} ${x%%/*}",
    has: [
      ["##", "##"],
      ["%%", "%%"],
      ["regex", "*."],
      ["regex", "/*"],
    ],
  },
  {
    name: "removal patterns with quotes, ANSI-C strings and nested expansions",
    input: "echo ${x#\"$p\"} ${x%'.bak'} ${x#$'\\n'} ${x%${y}} ${x#\\}}",
    has: ["string", ["raw_string", "'.bak'"], ["ansi_c_string", "$'\\n'"]],
  },
  {
    name: "removal pattern with a doubled dollar",
    input: "echo ${x#$$}",
    has: ["expansion", ["#", "#"]],
  },
  {
    name: "case modification operators",
    input: "echo ${x^} ${x^^} ${x,} ${x,,a}",
    has: [
      ["^", "^"],
      ["^^", "^^"],
      [",", ","],
      [",,", ",,"],
    ],
  },
  {
    name: "default, assign, error and alternate operators with and without colon",
    input: "echo ${x:-d} ${x:=d} ${x:?e} ${x:+a} ${x-d} ${x=d} ${x?e} ${x+a}",
    has: [
      [":-", ":-"],
      [":=", ":="],
      [":?", ":?"],
      [":+", ":+"],
      ["-", "-"],
      ["=", "="],
      ["?", "?"],
      ["+", "+"],
    ],
  },
  {
    name: "default value containing words, expansions and quotes",
    input:
      "echo ${x:-a b} ${x:-$HOME/x} ${x:-\"q\"} ${x:-'r'} ${x:-`pwd`} ${x:-$(pwd)}",
    has: ["concatenation", "raw_string", "command_substitution"],
  },
  {
    name: "process substitution inside a default value is a dialect differential",
    input: "echo ${x:-<(ls)}",
    root: "ERROR",
    has: ["process_substitution"],
  },
  {
    name: "default value with an ANSI-C string and a lone dollar",
    input: "echo ${x:-$'\\n'} ${x:-a$}",
    has: [["ansi_c_string", "$'\\n'"]],
  },
  {
    name: "substring offsets and lengths",
    input: "echo ${x:2} ${x: -1} ${x:1:-2} ${x:i:n} ${x:1: 2}",
    has: [
      ["number", "2"],
      ["number", "-1"],
      ["number", "-2"],
    ],
  },
  {
    name: "empty substring operator",
    input: "echo ${x:}",
    has: ["expansion"],
  },
  {
    name: "indirection, length and name listing",
    input: "echo ${!ref} ${#x} ${!pre*} ${!pre@} ${!arr[@]} ${#arr[@]}",
    has: [["!", "!"], ["#", "#"], "subscript"],
  },
  {
    name: "special parameters inside braces",
    input: "echo ${@} ${*} ${#} ${?} ${$} ${!} ${-} ${_} ${10}",
    has: ["special_variable_name", ["variable_name", "10"]],
  },
  {
    name: "length of a special parameter",
    input: "echo ${#@} ${#*} ${##} ${#?}",
    has: ["special_variable_name"],
  },
  {
    name: "transformation operators",
    input: "echo ${x@Q} ${x@E} ${arr[@]@A}",
    has: [["@", "@"]],
  },
  {
    name: "array subscripts with arithmetic and empty index",
    input: 'echo ${a[i+1]} ${a[$i]} ${a["k"]} ${a[]}',
    has: ["subscript", ["[", "["], ["]", "]"]],
  },
  {
    name: "subscript without a name becomes an error node",
    input: "echo ${[0]}",
    has: [["ERROR", "[0]"]],
  },
  {
    name: "empty indirection and length forms",
    input: "echo ${#!} ${!#} ${!##} ${!# }",
    has: ["expansion"],
  },
  {
    name: "indirect assignment-style prefixes",
    input: "echo ${=name} ${~name}",
    has: [
      ["=", "="],
      ["~", "~"],
    ],
  },
  // Dollar forms
  {
    name: "simple expansions of names, digits and specials",
    input: "echo $HOME $1 $? $$ $# $@ $* $- $! $_ $_x",
    has: [
      ["variable_name", "HOME"],
      ["variable_name", "1"],
      ["special_variable_name", "?"],
      ["special_variable_name", "_"],
    ],
  },
  {
    name: "a lone dollar stays a literal dollar",
    input: "echo $ a$ $%",
    has: ["$"],
  },
  {
    name: "arithmetic expansion forms",
    input: "echo $((1+2)) $[3*4] $(( (a) ))",
    has: ["arithmetic_expansion", ["$((", "$(("], ["$[", "$["]],
  },
  {
    name: "unterminated arithmetic expansion is an error node and a differential",
    input: "echo $((1+2",
    root: "ERROR",
    has: ["ERROR"],
  },
  {
    name: "unterminated bracket arithmetic is an error node and a differential",
    input: "echo $[1+2",
    root: "ERROR",
    has: ["ERROR"],
  },
  {
    name: "command substitution holding a lone redirect",
    input: "x=$(< file)",
    has: ["command_substitution", "file_redirect"],
  },
  {
    name: "ANSI-C string after a dollar",
    input: "echo $'a\\tb'",
    has: [["ansi_c_string", "$'a\\tb'"]],
  },
  // Double-quoted strings
  {
    name: "double-quoted string with expansions, escapes and a backtick",
    input: 'echo "a $b ${c} $(d) $((1)) `e` \\" $1 $? end"',
    has: [
      "string",
      "string_content",
      "simple_expansion",
      "expansion",
      "command_substitution",
      "arithmetic_expansion",
    ],
  },
  {
    name: "double-quoted string with a literal dollar before text and at the end",
    input: 'echo "cost $ 5" "end$" "x$"',
    has: [["$", "$"]],
  },
  {
    name: "multi-line double-quoted string",
    input: 'echo "one\n  two\n"',
    has: ["string_content"],
  },
  {
    name: "unterminated double-quoted string gets a zero-width closing quote",
    input: 'echo "open',
    has: ["string"],
  },
  // Backticks
  {
    name: "backtick command substitution with a list",
    input: "echo `a; b & c`",
    has: ["command_substitution", ["`", "`"], [";", ";"], ["&", "&"]],
  },
  {
    name: "backtick with an escaped dollar is kept opaque",
    input: "echo `echo \\$HOME`",
    has: ["backtick_escape_unsupported"],
  },
  {
    name: "empty backtick body",
    input: "echo ``",
    has: ["backtick_body_empty"],
  },
  {
    name: "backtick body spanning newlines",
    input: "echo `a\nb`",
    has: ["command_substitution"],
  },
  {
    name: "unterminated backtick",
    input: "echo `date",
    has: ["command_substitution"],
  },
];

const statementShapes: readonly ShapeCase[] = [
  {
    name: "if with elif and else clauses",
    input: "if a; then b; elif c; then d; else e; fi",
    has: [
      "if_statement",
      ["elif_clause", "elif c; then d;"],
      ["else_clause", "else e;"],
      ["fi", "fi"],
    ],
  },
  {
    name: "an empty else clause is just the keyword",
    input: "if a; then b; else fi",
    has: [
      ["else_clause", "else"],
      ["fi", "fi"],
    ],
  },
  {
    name: "a missing fi is omitted rather than invented",
    input: "if a; then b",
    has: ["if_statement", ["then", "then"]],
    lacks: ["fi"],
  },
  {
    name: "while with a multi-command condition",
    input: "while a; b; do c; done",
    has: ["while_statement", ["do_group", "do c; done"]],
  },
  {
    name: "until shares the while statement node",
    input: "until a; do b; done",
    has: ["while_statement", ["until", "until"], "do_group"],
  },
  {
    name: "a loop without a body has no do group",
    input: "while a",
    has: ["while_statement"],
    lacks: ["do_group"],
  },
  {
    name: "C-style for with a brace body",
    input: "for ((i=0; i<3; i++)) { echo $i; }",
    has: [
      "c_style_for_statement",
      ["variable_assignment", "i=0"],
      ["binary_expression", "i<3"],
      ["postfix_expression", "i++"],
      ["compound_statement", "{ echo $i; }"],
    ],
  },
  {
    name: "C-style for with empty clauses and a do group",
    input: "for ((;;)); do :; done",
    has: ["c_style_for_statement", ["((", "(("], ["))", "))"], "do_group"],
  },
  {
    name: "C-style for with comma-separated updates",
    input: "for ((i=0, j=0; i<3; i++, j++)); do :; done",
    has: [
      ["variable_assignment", "i=0"],
      ["variable_assignment", "j=0"],
      ["postfix_expression", "j++"],
    ],
  },
  {
    name: "for without a word list iterates the positional parameters",
    input: "for x; do :; done",
    has: ["for_statement", ["variable_name", "x"], "do_group"],
    lacks: ["in"],
  },
  {
    name: "a for variable that is not a name is an error node",
    input: "for 1x in a; do :; done",
    has: ["for_statement", ["ERROR", "1x"]],
  },
  {
    name: "for without do keeps the word list",
    input: "for x in a b c",
    has: ["for_statement", ["in", "in"]],
    lacks: ["do_group"],
  },
  {
    name: "select shares the for statement node",
    input: "select x in a b; do break; done",
    has: ["for_statement", ["select", "select"], "do_group"],
  },
  {
    name: "case items with every terminator, a leading paren, globs and quoted patterns",
    input: 'case x in (a) b;; c) ;& d) ;;& -v) ;; *.txt) e;; "a"b) f;; esac',
    has: [
      "case_statement",
      ["case_item", "(a) b;;"],
      [";&", ";&"],
      [";;&", ";;&"],
      ["word", "-v"],
      ["extglob_pattern", "*.txt"],
      ["string", '"a"'],
      ["esac", "esac"],
    ],
  },
  {
    name: "a later alternative built from several parts is a concatenation",
    input: 'case x in a|"b"c) d;; esac',
    has: [
      ["concatenation", '"b"c'],
      ["|", "|"],
    ],
  },
  {
    name: "extglob case patterns",
    input: "case x in @(a|b)) c;; !(d)) e;; esac",
    has: [
      ["extglob_pattern", "@(a|b)"],
      ["extglob_pattern", "!(d)"],
    ],
  },
  {
    name: "function keyword with parentheses",
    input: "function f() { :; }",
    has: [
      "function_definition",
      ["function", "function"],
      ["(", "("],
      [")", ")"],
      "compound_statement",
    ],
  },
  {
    name: "function body redirects belong to the function definition",
    input: "function f { :; } > out",
    has: ["function_definition", ["file_redirect", "> out"]],
    lacks: ["redirected_statement"],
  },
  {
    name: "function with a subshell body",
    input: "function f ( :; )",
    has: ["function_definition", "subshell"],
  },
  {
    name: "declaration with options, arrays, bare names and a redirect",
    input: "declare -a arr=(1 2) x y=1 >out",
    has: [
      "redirected_statement",
      "declaration_command",
      ["word", "-a"],
      ["variable_assignment", "arr=(1 2)"],
      "array",
      ["variable_name", "x"],
      ["variable_assignment", "y=1"],
      ["file_redirect", ">out"],
    ],
  },
  {
    name: "unset with names, options, quoted and expanded operands and a redirect",
    input: "unset x -f y 'z' $w >out",
    has: [
      "redirected_statement",
      "unset_command",
      ["variable_name", "x"],
      ["word", "-f"],
      ["variable_name", "y"],
      ["raw_string", "'z'"],
      ["simple_expansion", "$w"],
    ],
  },
];

const conditionShapes: readonly ShapeCase[] = [
  {
    name: "boolean chains with every comparison operator",
    input: "[[ a == b || c != d && e =~ f ]]",
    has: [
      "test_command",
      ["||", "||"],
      ["&&", "&&"],
      ["==", "=="],
      ["!=", "!="],
      ["=~", "=~"],
      ["regex", "f"],
    ],
  },
  {
    name: "negation and grouping",
    input: "[[ ! a ]] && [[ ( a == b ) ]]",
    has: [
      ["unary_expression", "! a"],
      ["parenthesized_expression", "( a == b )"],
    ],
  },
  {
    name: "unary file tests",
    input: "[[ -f x && ! -d y ]]",
    has: [
      ["test_operator", "-f"],
      ["test_operator", "-d"],
      ["unary_expression", "-f x"],
    ],
  },
  {
    name: "a lone unary operator is a test operator",
    input: "[[ -f ]]",
    has: [["test_operator", "-f"]],
    lacks: ["unary_expression"],
  },
  {
    name: "string ordering operators inside double brackets",
    input: "[[ a < b ]] && [[ c > d ]]",
    has: [
      ["<", "<"],
      [">", ">"],
    ],
  },
  {
    name: "glob, extglob and number right-hand sides",
    input: "[[ a == *.c ]] && [[ a == @(b|c) ]] && [[ a == 1 ]]",
    has: [
      ["extglob_pattern", "*.c"],
      ["extglob_pattern", "@(b|c)"],
      ["number", "1"],
    ],
  },
  {
    name: "a quoted regex stays a string and an unquoted one is a regex",
    input: "[[ a =~ 'b' ]] && [[ a =~ ^(a|b)$ ]]",
    has: [
      ["raw_string", "'b'"],
      ["regex", "^(a|b)$"],
    ],
  },
  {
    name: "a unary operator before a carriage return records the missing operand",
    input: "[[ -f \r ]]",
    has: [
      ["test_operator", "-f"],
      ["test_rhs_missing", " \r "],
    ],
  },
  {
    name: "a comparison without a right side records the missing operand",
    input: "[[ a == && b ]]",
    has: ["test_rhs_missing"],
  },
];

const arithmeticShapes: readonly ShapeCase[] = [
  {
    // Bash reads a = (b ? c : d); the shipped grammar binds = tighter than ?:.
    name: "the shipped grammar groups an assignment before a ternary",
    input: "(( a = b ? c : d ))",
    has: [
      ["ternary_expression", "a = b ? c : d"],
      ["binary_expression", "a = b"],
      ["?", "?"],
      [":", ":"],
      ["=", "="],
    ],
  },
  {
    name: "a ternary without its colon gets a zero-width colon",
    input: "(( a ? b ))",
    has: ["ternary_expression", [":", ""]],
  },
  {
    name: "the shipped grammar reads only a binary operand between ? and :",
    input: "echo $((a ? b ? c : d : e))",
    has: [
      ["ERROR", "$((a ? b ? c : d : e))"],
      ["ternary_expression", "a ? b "],
    ],
  },
  {
    name: "prefix, postfix and unary operators",
    input: "(( ++a + --b + c++ + d-- + -e + !f + ~g ))",
    has: [
      ["unary_expression", "++a"],
      ["unary_expression", "--b"],
      ["postfix_expression", "c++"],
      ["postfix_expression", "d--"],
      ["unary_expression", "-e"],
      ["unary_expression", "!f"],
      ["unary_expression", "~g"],
    ],
  },
  {
    name: "hex and base-n numbers",
    input: "(( 0x1F + 0Xa + 2#101 + 16#ff ))",
    has: [
      ["number", "0x1F"],
      ["number", "0Xa"],
      ["number", "2#101"],
      ["number", "16#ff"],
    ],
  },
  {
    name: "a base prefix followed by an expansion",
    input: "(( 2#$x ))",
    has: [
      ["binary_expression", "2#$x"],
      ["number", "2#"],
      ["simple_expansion", "$x"],
    ],
  },
  {
    name: "compound assignment and shift operators",
    input: "(( x <<= 1, y >>= 2, a ** b << c >> d ))",
    has: [
      ["<<=", "<<="],
      [">>=", ">>="],
      ["**", "**"],
      ["<<", "<<"],
      [">>", ">>"],
    ],
  },
  {
    name: "subscripts and parenthesized groups",
    input: "(( a[1] + (b + c) * d[$i] ))",
    has: [
      ["subscript", "a[1]"],
      ["parenthesized_expression", "(b + c)"],
      ["subscript", "d[$i]"],
    ],
  },
];

// Dollar forms, parameter operators, command substitutions and quoting.
const wordRows: readonly Row[] = [
  ["echo $(echo \"a\" 'b' \\x `c` $$ $'d' (e) f", "differential"],
  ["echo $(echo \"a\" 'b' \\x `c\\d` $$ $'d' (e) f) g", "plain"],
  ["echo $(a `b", "differential"],
  ["echo $(foo }", "differential"],
  ["echo $(a ;; b)", "differential"],
  ["echo $(case x in a) ;; esac", "differential"],
  ["echo $(if)", "plain"],
  ["echo $(a } (b) c)", "plain"],
  ["echo ${x y \"q\" 'r' \\} $(a (b) c) `d` $$ $'e' ${z} }", "differential"],
  ["echo ${x y $(a \\) $$ $'b' \"c\" `d\\e`) }", "differential"],
  ["echo ${x y", "differential"],
  ["echo ${x y $(a", "differential"],
  ["echo ${x y `a", "differential"],
  ["echo ${x y `a\\b` }", "differential"],
  ["echo \"${x:-'a'}\"", "repaired"],
  ["echo ${xé}", "differential"],
  ["echo ${x:-\\\n}", "differential"],
  ["echo ${x:-$[1]}", "differential"],
  ["echo ${ x}", "plain"],
  ["echo ${x:-${ y}}", "differential"],
  ["echo $abcé", "repaired"],
  ["echo $é", "repaired"],
  ["echo $##é", "repaired"],
  ["echo $^é", "repaired"],
  ["echo $#é", "plain"],
  ['echo "$^é"', "repaired"],
  ['echo "$[1]"', "plain"],
  ["echo ${!#x}", "plain"],
  ["echo ${!## }", "plain"],
  ["echo ${a[1}", "repaired"],
  ["echo ${[]}", "repaired"],
  ["echo ${x::2}", "plain"],
  ["echo ${x:1:}", "plain"],
  ["echo ${x: }", "plain"],
  ["echo ${@:-a} ${a[1]:-x} ${###} ${?#x}", "plain"],
  ["echo ${==x} ${+x} ${+'a'} ${=\\x}", "differential", "plain"],
  ["echo ${+$(a)'b'}", "differential", "plain"],
  ["echo ${+`a`'b'}", "differential", "plain"],
  ['echo ${x/"a"}', "plain"],
  ["echo ${x/}", "plain"],
  ["echo ${x/a}", "plain"],
  ["echo ${x//[a]/$'b'}", ["plain", "dollar_quote_string"], "plain"],
  ["echo ${x//a/$'b'}", "plain"],
  ["echo ${x/#/$'b'}", ["plain", "dollar_quote_string"], "plain"],
  ["echo ${#x/a/$'b'}", ["plain", "dollar_quote_string"], "plain"],
  ["echo ${x//[a]/'$(b)'}", ["plain", "quoted_code_in_subscript"], "plain"],
  ["echo ${x/[a]/'`b`'}", ["plain", "quoted_code_in_subscript"], "plain"],
  ["echo ${x[0]/'$(b)'/c}", "plain"],
  [
    "echo ${x:-(a b)} ${x=(a \"b\" 'c' $'d' $$ \\) `e` $(f) {g} )}",
    "differential",
  ],
  ["echo ${x:-(a", "differential"],
  ["echo ${x:-( )}", "plain"],
  ["echo ${x-(a\n)}", "differential"],
  ["echo ${x/a{b}/c}", "differential"],
  ["echo ${x/a'b\\'/c}", "differential"],
  ['echo ${x/a"b`c`"/d}', "differential", "plain"],
  ['echo ${x/a"$(b)"/d}', "differential", "plain"],
  ['echo ${x/a"$\\\n{b}"/d}', "differential"],
  ['echo ${x/a"$y"/d}', "plain"],
  ['echo ${x/a"b\\"c"/d}', "plain"],
  ["echo ${x/a`b\\c`/d}", "differential"],
  ["echo ${x/a`b", "differential"],
  ["echo ${x/a$$/b}", "plain"],
  ["echo ${x/a$${y}/b}", "differential", "plain"],
  ["echo ${x/a$$$/b}", "plain"],
  [
    "echo ${x/a${y\\}$$$'c'\"d\"'e'`f`${z}$(g){h}}/i}",
    ["differential", "dollar_quote_string"],
    "differential",
  ],
  ["echo ${x/a${y`f", "differential"],
  [
    "echo ${x/a$(b\\)$$$'c'\"d\"`e\\f`(g))/h}",
    ["differential", "dollar_quote_string"],
    "differential",
  ],
  ["echo ${x^^[a{b}]}", "differential"],
  ["echo ${x:-a{b}}", "differential"],
  ["echo ${x:-a\\}b}", "plain"],
  ["echo ${x:-  a}", "plain"],
  ["echo ${x:-$'a}", "differential"],
  ["echo ${x:-'a}", "differential"],
  ["echo ${x:-$((1))} ${x:-${y}} ${x:-$y}", "plain"],
  ["echo ${x#a{b}}", "differential"],
  ["echo ${x#'a}", "differential"],
  ["echo ${x#a`b\\c`d}", "differential"],
  ["echo ${x#`a", "differential"],
  ["echo ${x#$'a}", ["differential", "dollar_quote_string"], "differential"],
  [
    "echo ${x#${a\\}$$$'b'\"c\"`d\\e`${f}$(g){h}}}",
    ["differential", "dollar_quote_string"],
    "differential",
  ],
  ["echo ${x#${a`b", "differential"],
  [
    "echo ${x#$(a\\)$$$'b'\"c\"`d\\e`(f))}",
    ["differential", "dollar_quote_string"],
    "differential",
  ],
  ["echo ${x#$(a", "differential"],
  ["echo ${a[0]:-'b'}", "plain"],
  ["echo ${x:-'a'}", "plain"],
  ['echo ${x["$(a)"]}', "plain"],
  ["echo $(a ;; \\x \"q\" 'r' `c\\d` $$ $'e' (f) g) h", "differential"],
  ["echo $(a ;; `b", "differential"],
  ['echo $(a ;; "b', "differential"],
  ["echo $(a ;; $'b", "differential"],
  ["echo $(a ;; (b)", "differential"],
  ["echo $(a ;; \\", "differential"],
  ['echo ${x y "q', "differential"],
  ["echo ${x y $'q", "differential"],
  ["echo ${x y 'q", "differential"],
  ["echo ${éx}", "differential"],
  ["echo ${!é}", "differential"],
  ["echo $é$x", "repaired"],
  ["echo ${x:-$é}", "repaired"],
  ["echo $^x $=x", "plain"],
  ['echo ${x/"a"b/c}', "plain"],
  ["echo ${x:-(a $'b", "differential"],
  ['echo ${x:-(a "b', "differential"],
  ["echo ${x:-(a `b\\c` )}", "differential"],
  ["echo ${x:-(a `b", "differential"],
  ["echo ${x:-(a{b} c)}", "differential"],
  ['echo ${x/a"$\\x"/c}', "plain"],
  ["echo ${x/a${b`c\\d`}/e}", "differential"],
  ["echo ${x:- $y}", "plain"],
  ["echo ${x#$y}", "plain"],
  ['echo ${x:-(a "$b")}', "differential"],
  ["echo ${x:-a} $'b'", "plain"],
  ["echo ${x:-a] b} $'c'", "plain"],
  ["echo ${x:-a[b]} $'c'", "plain"],
  ["echo ${x:-$'b'} $'c'", "plain"],
  ["echo ${x:-$(a)} $'c'", "plain"],
  ["echo ${x:-\"a\"} $'c'", "plain"],
  ["echo ${x:-'a'} $'c'", "plain"],
  ["echo ${x:-`a`} $'c'", "plain"],
  ["echo ${x:-a$%} $'b'", "plain"],
  ["echo ${x:-a$%}", "plain"],
];

// Backtick command substitutions.
const backtickRows: readonly Row[] = [
  ["echo `a \\` b`", "plain"],
  ["echo `$((1)) \\$`", "differential", "plain"],
  ["echo `a\\$((1))`", "differential", "plain"],
  ["echo `a \\\n b`", "plain"],
  ["echo `a\nb`", "plain"],
  ["echo `\nb`", "plain"],
  ["echo `a;`", "plain"],
  ["echo `)`", "plain"],
  ["echo `a | `", "plain"],
  ["echo `a `b``", "plain"],
  ["echo `a\\$b", "repaired"],
  ["echo `a; \\\n`", "plain"],
  ["echo `# c`", "plain"],
  ['echo `echo "$((1))`"`', "differential", "repaired"],
  ['echo `echo "a`b"`', "repaired"],
  ["echo `a >`", "plain"],
  ["echo `a <<<`", "plain"],
];

// Brace sequences and lists.
const braceRows: readonly Row[] = [
  ["echo {a,${x:-y}} '$(z)'", "plain"],
  ["echo {a,b} '$(x)' \"`y`\"", "plain"],
  ["echo {a,b} '`x`'", "plain"],
  ["echo {a,b}# '$(x)'", "plain"],
  ["echo {a,$'b'}", ["plain", "brace_text_read_again"]],
  ["echo {a,b\\}", "plain"],
  ["echo {", "plain"],
  ["echo {a", "plain"],
  ["echo {1..5}", "plain"],
  ["echo {a..e}", "plain"],
  ["echo {A..z}", ["plain", "brace_text_read_again"]],
  ["echo {1..a}", "plain"],
  ["echo {ab..cd}", "plain"],
  ["echo {1..}", "plain"],
  ["echo {..2}", "plain"],
  ["echo {1.2}", "plain"],
  ["echo {a,b}", "plain"],
  ["echo {a,b\\,c}", "plain"],
  ["echo {a,[b]}", "plain"],
  ["echo {x,$(y)}", ["repaired", "brace_text_read_again"]],
  ["echo {A..z..2}", ["plain", "brace_text_read_again"]],
  ["echo {a,b}c", "plain"],
  ["echo {a,b} \"q\" \\x '$(z)'", "plain"],
];

// Loops, conditionals, case statements and function definitions.
const compoundRows: readonly Row[] = [
  ["if a; then b; else fi", "plain"],
  ["if a; then b; elif c; then d; elif e; then f; else g; fi", "plain"],
  ["if a\nthen b\nfi", "plain"],
  ["while a; do b; done", "plain"],
  ["until a; do b; done", "plain"],
  ["while a; b; do c; done", "plain"],
  ["while a", "plain"],
  ["while a; done", "repaired"],
  ["for x in a b # c\ndo :; done", "plain"],
  ["for x in a #b\n do :; done", "plain"],
  ["for 1x in a; do :; done", "repaired"],
  ["for $x in a; do :; done", "repaired"],
  ["for x; do :; done", "plain"],
  ["for x\ndo :; done", "plain"],
  ["for x in; do :; done", "plain"],
  ["for x in a b\ndo :\ndone", "plain"],
  ["select x in a b; do break; done", "plain"],
  ["for x in a b c", "plain"],
  ["for x do :; done", "plain"],
  ["case $x in a|b) echo;; c) ;& d) ;;& *) ;; esac", "plain"],
  ["case x in (a) b;; esac", "plain"],
  ['case x in "a b") c;; esac', "plain"],
  ["case x in 'a'|$'b') c;; esac", ["plain", "dollar_quote_string"], "plain"],
  ["case x in a\\ b) c;; esac", "plain"],
  ["case x in $$) c;; esac", "plain"],
  ["case x in $y) c;; esac", "plain"],
  ["case x in [ab]) c;; esac", "plain"],
  ["case x in *.txt) c;; esac", "plain"],
  ["case x in -v) c;; esac", "plain"],
  ["case x in -v*) c;; esac", "plain"],
  ["case x in @(a|b)) c;; esac", "plain"],
  ["case x in !(a)) c;; esac", "plain"],
  ["case x in +(a\n)) c;; esac", "plain"],
  ['case x in a"b"c) d;; esac', "plain"],
  ["case x in a'b'*) d;; esac", "plain"],
  ["case x in a$'b'?) d;; esac", ["plain", "dollar_quote_string"], "plain"],
  ['case x in "a\\"b") c;; esac', "plain"],
  ["case x in a$'q') c;; esac", ["plain", "dollar_quote_string"], "plain"],
  ["case x in a$$b) c;; esac", "plain"],
  ["case x in a\\*b|c) d;; esac", "plain"],
  ["case x in a \\\n| b) c;; esac", "plain"],
  ["case x in a |\\\n b) c;; esac", "plain"],
  ["case x in a) b", "plain"],
  ["case x in", "plain"],
  ["case x in )", "plain"],
  ["case x\nin\na) b;;\nesac", "plain"],
  ["case x in a) b;; esac; echo", "plain"],
  ["case x in a);; b);; esac", "plain"],
  ["case x in a|) b;; esac", "plain"],
  ["case x in -a|+b|?c|@d|!e) f;; esac", "plain"],
  [
    "case x in \"a\"b'c'$'d'\\e) f;; esac",
    ["plain", "dollar_quote_string"],
    "plain",
  ],
  ['case x in "a"$$b) f;; esac', "plain"],
  ['case x in "a"*) f;; esac', "plain"],
  ["case x in 'a' b) f;; esac", "plain"],
  ["function f() { :; }", "plain"],
  ["function f { :; } > out", "plain"],
  ["function f ( :; )", "plain"],
  ["function f", "plain"],
  ["function f() { :; } 2>&1", "plain"],
  ["function f\n{ :; }", "plain"],
  ["f() { :; } >out 2>err", "plain"],
  ["function f() a", "plain"],
  ["for x-y in a; do :; done", "repaired"],
  ["for x in a ) ; do :; done", "repaired"],
  ["for x in a #b", ["plain", "hash_in_for_list"]],
  ["case x in |", "plain"],
  ['case x in a|"b"c) d;; esac', "plain"],
  ["case x in -v) ;; esac", "plain"],
  ['case x in "a', "repaired"],
  ["case x in a||b) ;; esac", "repaired"],
  ['case x in a|"b"*) c;; esac', "plain"],
];

// Declaration and unset commands.
const declarationRows: readonly Row[] = [
  ["declare -a arr=(1 2) x y=1 >out", "plain"],
  ["local x=1 -r y", "plain"],
  ["export \"a\" 'b' $c", "plain"],
  ["declare x(", "repaired"],
  ["readonly 1x", "plain"],
  ["typeset -i n=$((1))", "plain"],
  ["declare ;", "plain"],
  ["declare x <in", "plain"],
  ["declare a[1]=b", "plain"],
  ["export x=$'a'", "plain"],
  ["declare 'a'=b", "plain"],
  ["local $x=1", "plain"],
  ["declare x &", "plain"],
  ["declare x | cat", "plain"],
  ["declare -- -x", "plain"],
  ["declare $(echo)", "plain"],
  ['declare "x""y"', "plain"],
  ["declare x=`a`", "plain"],
  ["unset x -f y 'z' $w >out", "plain"],
  ["unset a(", "repaired"],
  ["unset ;", "plain"],
  ["unset x <in", "plain"],
  ['unset "$x"', "plain"],
  ["unset a[1]", "plain"],
  ["unset -v", "plain"],
  ["unset x &", "plain"],
  ["declare 12", "plain"],
  ["declare }", "plain"],
  ["declare !", "plain"],
  ["declare ((", "differential", "repaired"],
  ["unset }", "plain"],
  ["unset !", "plain"],
  // A backtick operand ends the shipped declaration reader, so the rest is repaired.
  ["declare `a`", "repaired"],
  ["declare # c", "plain"],
  ["unset # c", "plain"],
  ["unset `a`", "plain"],
];

// Single and double bracket test expressions.
const conditionRows: readonly Row[] = [
  ["[[ a == b || c != d && e =~ f ]]", "plain"],
  ["[[ ( a == b ) ]]", "plain"],
  ["[[ ! a ]]", "plain"],
  ["[[ ! ( a ) ]]", "plain"],
  ["[[ -f x && ! -d y ]]", "plain"],
  ["[[ a < b ]]", "plain"],
  ["[[ a > b ]]", "plain"],
  ["[[ a = b ]]", "plain"],
  ["[[ a =b ]]", ["plain", "equals_in_test"]],
  ["[[ a -nt b ]]", "plain"],
  ['[[ a =~ "b" ]]', "plain"],
  ["[[ a =~ 'b' ]]", "plain"],
  ['[[ a =~ "b"c ]]', "plain"],
  ["[[ a =~ 'b' && c ]]", "plain"],
  ["[[ a =~ 'b' || c ]]", "plain"],
  ["[[ a =~ 'b'\n]]", "repaired"],
  ["[[ a =~ 'b'", "repaired"],
  ['[[ a =~ "b" \\\n]]', "plain"],
  ["[[ a =~ 'b'\\\r\n]]", "repaired"],
  ["[[ a =~ ^(a|b)$ ]]", "plain"],
  ["[[ a =~ a\\ b ]]", "plain"],
  ["[[ a =~ a\"b\"'c' ]]", "plain"],
  ["[[ a =~ a`b` ]]", "plain"],
  ["[[ a =~ (a\nb) ]]", "plain"],
  ["[[ a =~ a&&b ]]", "plain"],
  ["[[ a =~ a|b ]]", "plain"],
  ["[[ a =~ ]]", "repaired"],
  ["[[ a = ]]", "repaired"],
  ["[[ a == ]]", "repaired"],
  ["[[ a = b|c ]]", "repaired"],
  ["[[ a = (b) ]]", "plain"],
  ["[[ a == @(b|c) ]]", "plain"],
  ["[[ a == b\\ c ]]", "plain"],
  ["[[ a == $'b' ]]", ["plain", "dollar_quote_string"], "plain"],
  ['[[ a == $"b" ]]', "plain"],
  ["[[ a == $x${y}$(z) ]]", "plain"],
  ["[[ a == \"b\"'c'`d` ]]", "plain"],
  ["[[ a == <(b) ]]", "plain"],
  ["[[ a == (b\nc) ]]", "plain"],
  ["[[ a == b\n]]", "repaired"],
  ["[[ a == b c ]]", "plain"],
  ["[[ a == b # c\n]]", "repaired"],
  ["[[ a == b \\\n]] ]]", "plain"],
  ["[[ a == b \\\r\n]]", "repaired"],
  ["[[ a == b &&c ]]", "plain"],
  ["[[ a == b || c ]]", "plain"],
  ["[[ a == b) ]]", "repaired"],
  ["[[ a == $[1] ]]", "plain"],
  ["[[ a == $é ]]", "repaired"],
  ["[[ a == $@ ]]", "plain"],
  ["[[ -f ]]", "plain"],
  ["[[ -f \\\n ]]", "plain"],
  ["[[ -f", "repaired"],
  ["[[ -fx ]]", "plain"],
  ["[[ a -eq ]]", "plain"],
  ["[[ ( a ]]", "repaired"],
  ["[[ ( ]]", "repaired"],
  ["[[ a &&\n b ]]", "plain"],
  ["[[ a &&\n# c\n b ]]", "plain"],
  ["[[ a ||\n b ]]", "plain"],
  ["[[ a && ]]", "repaired"],
  ["[[ a || ]]", "repaired"],
  ["[[ #x ]]", "repaired"],
  ["[[ a == #b ]]", ["plain", "hash_in_test"]],
  ["[ a = b ]", "plain"],
  ["[ ! a ]", "plain"],
  ["[ \\( a \\) ]", "repaired"],
  ["[ -n ]", "plain"],
  ["[ a -a b ]", "plain"],
  ["[ ( a ) ]", "plain"],
  ["[ a < b ]", "plain"],
  ["[ a ]", "plain"],
  ["[ ]", "plain"],
  ["[ -n a ]]", "repaired"],
  ["[[ a != b ]]", "plain"],
  ["[[ !a ]]", "plain"],
  ["[[ ! ]]", "plain"],
  ["[[ ! ( a ]]", "repaired"],
  ["[[ ! ( ) ]]", "plain"],
  ["[[ -a/b ]]", "plain"],
  ["[[ -f \\\r\n]]", "repaired"],
  ["[[ a =~ 'b' ]\\\n]", "repaired"],
  ["[[ a =~ 'b' ]\\\r\n]", "repaired"],
  ["[[ a =~ 'b' ]\\x", "repaired"],
  ["[[ a =~", "repaired"],
  ["[[ a =~ )", "repaired"],
  ["[[ a = ", "repaired"],
  ["[[ a ==", "repaired"],
  ["[[ a == && b ]]", "plain"],
  ['[[ a = "b\\"c" ]]', "plain"],
  ['[[ a = "b', "repaired"],
  ["[[ a = `b\\c` ]]", "plain"],
  ["[[ a = `b", "repaired"],
  ["[[ a = b) ]]", "repaired"],
  ["[[ a = )", "repaired"],
  ["[[ a == 1 ]]", "plain"],
  ["[[ a == b&&c ]]", "plain"],
  ["[[ a == b \\\n\\\n]]", "plain"],
  ["[[ a == b ]\\\n]", "repaired"],
  ["[[ a == b ]\\\r\n]", "repaired"],
  ["[[ a == b ]\\x", "repaired"],
  ["[[ a == b ", "repaired"],
  ["[[ a == b ]", "repaired"],
  ["[[ -f \r ]]", "plain"],
];

// Arithmetic commands, expansions and C-style for heads.
const arithmeticRows: readonly Row[] = [
  ["for ((i=0; i<3; i++)) { echo $i; }", "plain"],
  ["for ((i=0; i<3; i++)) { echo", "repaired"],
  ["for ((;;)); do :; done", "plain"],
  ["for ((i=0; i<3; i++))\ndo echo; done", "plain"],
  ["for ((i=0 i<3; i++)); do :; done", "differential", "plain"],
  ["for ((i=0; i<3; i++); do :; done", "differential", "repaired"],
  ["for ((i=0; i<'3'; i++)); do :; done", "differential", "repaired"],
  ["for ((i=0; i<3; i++ )) ; do :; done", "plain"],
  ["for ((", "differential", "repaired"],
  ["for ((i=0;", "differential", "repaired"],
  ["for ((i=$((1)); i<3; i++)); do :; done", "plain"],
  ["(( a = b ? c : d ))", "plain"],
  ["(( a ? b ))", "repaired"],
  ["(( a ? : c ))", "plain"],
  ["(( x <<= 1, y >>= 2, z **= 2 ))", "repaired"],
  ["(( a ** b << c >> d == e != f <= g >= h && i || j ))", "plain"],
  [
    "(( a += 1, b -= 1, c *= 2, d /= 2, e %= 2, f &= 1, g ^= 1, h |= 1 ))",
    "plain",
  ],
  ["(( a + b - c * d / e % f < g > h & i | j ^ k ))", "plain"],
  ["(( ++a + --b + c++ + d-- ))", "plain"],
  ["(( -a + +b + !c + ~d ))", "plain"],
  ["(( ++ ))", "plain"],
  ["(( - ))", "plain"],
  ["(( 0x1F + 0Xa + 2#101 + 16#ff ))", "plain"],
  ["(( 2#$x ))", "plain", "repaired"],
  ["(( a[1] + b[$i] + c[ ] ))", "repaired"],
  ["(( a[1 ))", "differential", "repaired"],
  ["(( (a + b) * (c ))", "differential", "repaired"],
  ['(( "1" + $x ))', "plain"],
  ["(( a = = b ))", "repaired"],
  ["(( a +  ))", "plain"],
  ["(( a, ))", "plain"],
  ["(( , ))", "plain"],
  ["(( 1 2 ))", "repaired"],
  ["(( a = ))", "plain"],
  ["(( a ? b : ))", "plain"],
  ["echo $(( a = 1 ))", "plain"],
  ["echo $(( a[$(b)] ))", "plain"],
  ["echo $(( -1 ))", "plain"],
  ["echo $[ a ? b : c ]", "plain"],
  ["echo $(( a\n))", "repaired"],
  ["echo $(( a ) ))", "differential", "repaired"],
  ["echo $(( (a ))", "differential", "repaired"],
  ['echo $(( a "b" ))', "differential", "repaired"],
  ["echo $(( a ]", "differential", "repaired"],
  ["for ((i = -1; i < 3; i += 2)); do :; done", "plain"],
  ["for ((i=0, j=0; i<3; i++, j++)); do :; done", "plain"],
  ["for ((a[0]=1;;)); do :; done", "plain"],
  ["echo $((1 <<2))", "plain"],
  ["echo $((a ? b ? c : d : e))", "repaired"],
  ["(( $'a' ))", ["plain", "dollar_quote_string"], "plain"],
  ["echo $(( $'a' ))", ["plain", "dollar_quote_string"], "plain"],
  ["echo $[ a b ]", "repaired"],
  ["echo $[ a [b] ]", "repaired"],
  ["echo $[ a b", "differential", "repaired"],
  ["echo $(( (a", "differential", "repaired"],
  ["for ((i=;;)); do :; done", "plain"],
  ["(( $'a", ["differential", "dollar_quote_string"], "repaired"],
];

describe("expansion and quoting shapes", () => {
  for (const example of wordShapes)
    test(example.name, () => assertShape(example));
});
describe("statement shapes", () => {
  for (const example of statementShapes)
    test(example.name, () => assertShape(example));
});
describe("test expression shapes", () => {
  for (const example of conditionShapes)
    test(example.name, () => assertShape(example));
});
describe("arithmetic shapes", () => {
  for (const example of arithmeticShapes)
    test(example.name, () => assertShape(example));
});

// Each row pins whether the tree is plain, repaired or a dialect
// differential, its misreading reason, and what changes when every reader
// guard is off. Plain means no ERROR or zero-width node; it is not a claim
// that bash accepts the input.
const families: readonly (readonly [string, readonly Row[]])[] = [
  ["expansions and quoting", wordRows],
  ["backticks", backtickRows],
  ["brace expressions", braceRows],
  ["compound statements", compoundRows],
  ["declarations", declarationRows],
  ["test expressions", conditionRows],
  ["arithmetic", arithmeticRows],
];
describe("outcome corpus", () => {
  for (const [family, rows] of families)
    test(`${family}: ${rows.length} inputs`, () => {
      for (const row of rows) {
        try {
          assertRow(row);
        } catch (error) {
          throw new Error(`input ${JSON.stringify(row[0])}`, { cause: error });
        }
      }
    });
});
