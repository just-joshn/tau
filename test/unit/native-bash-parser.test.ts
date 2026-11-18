import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";
import { createNativeBashParserFeatures } from "../../src/native-bash-parser-features.js";

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function nodes(root: NativeBashSyntaxNode): NativeBashSyntaxNode[] {
  return [root, ...root.children.flatMap(nodes)];
}
const parser = () => createNativeBashParser({ now: () => 0 });
function node(
  type: string,
  text: string,
  startIndex: number,
  endIndex: number,
  children: NativeBashSyntaxNode[] = [],
): NativeBashSyntaxNode {
  return { type, text, startIndex, endIndex, children };
}

test("the complete grammar produces the exact program/command/quoted-word shape", () => {
  const input = "echo 'hi there'";
  assert.deepEqual(
    parser().parse(input),
    node("program", input, 0, 15, [
      node("command", input, 0, 15, [
        node("command_name", "echo", 0, 4, [node("word", "echo", 0, 4)]),
        node("raw_string", "'hi there'", 5, 15),
      ]),
    ]),
  );
});

const grammarCases: readonly {
  name: string;
  input: string;
  types: readonly string[];
}[] = [
  {
    name: "boolean lists and pipelines",
    input: "echo one; printf two | cat && true || false",
    types: ["list", "pipeline", ";", "&&", "||"],
  },
  {
    name: "negated subshell and grouped commands",
    input: "! (echo one; echo two) && { true; }",
    types: ["negated_command", "subshell", "compound_statement"],
  },
  {
    name: "function definition and nested parameter expansion",
    input: 'greet() { echo "$1"; }',
    types: ["function_definition", "compound_statement", "simple_expansion"],
  },
  {
    name: "function keyword",
    input: "function greet { printf hello; }",
    types: ["function_definition", "compound_statement"],
  },
  {
    name: "if elif else",
    input:
      "if true; then echo first; elif false; then echo second; else echo third; fi",
    types: ["if_statement", "elif_clause", "else_clause"],
  },
  {
    name: "while and until",
    input: "while false; do echo no; done; until true; do echo no; done",
    types: ["while_statement", "do_group"],
  },
  {
    name: "for loop",
    input: 'for item in one two; do echo "$item"; done',
    types: ["for_statement", "do_group", "simple_expansion"],
  },
  {
    name: "C-style for arithmetic",
    input: 'for ((i=0; i<3; i++)); do echo "$i"; done',
    types: [
      "c_style_for_statement",
      "variable_assignment",
      "binary_expression",
      "postfix_expression",
    ],
  },
  {
    name: "case alternatives",
    input: 'case "$value" in one|two) echo found;; *) echo other;; esac',
    types: ["case_statement", "case_item", "|"],
  },
  {
    name: "array assignment and subscript",
    input: 'values=(one two); echo "${values[0]}"',
    types: ["variable_assignment", "array", "subscript", "expansion"],
  },
  {
    name: "declaration and unset",
    input: "export NAME=value; unset NAME",
    types: ["declaration_command", "unset_command"],
  },
  {
    name: "command substitution",
    input: 'printf "prefix$(echo nested)suffix"',
    types: ["command_substitution", "string"],
  },
  {
    name: "backtick substitution",
    input: "printf `echo nested`",
    types: ["command_substitution"],
  },
  {
    name: "arithmetic substitution",
    input: "echo $((1 + 2 * 3))",
    types: ["arithmetic_expansion", "binary_expression"],
  },
  {
    name: "process substitutions",
    input: "cat <(printf left) >(printf right)",
    types: ["process_substitution"],
  },
  {
    name: "file descriptors and redirects",
    input: "cat < input.txt > output.txt 2>&1",
    types: ["redirected_statement", "file_redirect", "file_descriptor"],
  },
  {
    name: "here string",
    input: "cat <<< 'owned value'",
    types: ["herestring_redirect"],
  },
  {
    name: "quoted heredoc",
    input: "cat <<'END'\nowned body\nEND\n",
    types: ["heredoc_redirect", "heredoc_body", "heredoc_end"],
  },
  {
    name: "tab-stripped heredoc",
    input: "cat <<-'END'\n\towned body\n\tEND\n",
    types: ["heredoc_redirect", "heredoc_body", "heredoc_end"],
  },
  {
    name: "test operators",
    input: '[[ -n "$name" && "$name" == value ]]',
    types: ["test_command", "binary_expression", "unary_expression"],
  },
  {
    name: "comments and line continuations",
    input: "# owned\nprintf one\\\ntwo # trailing\n",
    types: ["comment", "command", "word"],
  },
  {
    name: "ANSI-C quoting",
    input: "printf $'line\\n'",
    types: ["ansi_c_string"],
  },
  {
    name: "parameter pattern replacement",
    input: 'echo "${value/foo/bar}"',
    types: ["expansion", "regex", "/"],
  },
  {
    name: "parameter slicing",
    input: "echo ${value:1:2}",
    types: ["expansion", "number"],
  },
  {
    name: "nested default parameter expansion",
    input: "echo ${missing:-${fallback}}",
    types: ["expansion", ":-"],
  },
  {
    name: "parameter length and case conversion",
    input: "echo ${#value} ${value^^} ${!ref}",
    types: ["expansion", "#", "^^"],
  },
  {
    name: "arithmetic ternary",
    input: "echo $((ready ? 1 : 2))",
    types: ["arithmetic_expansion", "ternary_expression"],
  },
  {
    name: "regex test",
    input: "[[ value =~ ^[a-z]+$ ]]",
    types: ["test_command", "regex", "=~"],
  },
  {
    name: "single bracket numeric test",
    input: '[ "$value" -gt 0 ]',
    types: ["test_command", "binary_expression"],
  },
  {
    name: "unquoted heredoc expansion",
    input: "cat <<END\nhello $name\nEND\n",
    types: ["heredoc_body", "heredoc_content", "simple_expansion"],
  },
  {
    name: "select loop",
    input: 'select item in one two; do echo "$item"; done',
    types: ["for_statement", "select", "do_group"],
  },
  {
    name: "indexed assignment",
    input: "values[2]=three; echo ${values[2]}",
    types: ["variable_assignment", "subscript"],
  },
  {
    name: "extended case glob",
    input: "case value in @(one|two)) echo yes;; esac",
    types: ["case_statement", "extglob_pattern"],
  },
];
for (const example of grammarCases)
  test(`complete shell production: ${example.name}`, () => {
    const root = present(parser().parse(example.input));
    const found = nodes(root);
    for (const type of example.types)
      assert.ok(
        found.some((value) => value.type === type),
        `Missing ${type} in ${example.name}`,
      );
    const bytes = Buffer.from(example.input);
    for (const value of found) {
      assert.equal(
        value.text,
        bytes.subarray(value.startIndex, value.endIndex).toString("utf8"),
        `${value.type} byte span`,
      );
      assert.ok(value.startIndex <= value.endIndex);
    }
  });

test("UTF8 byte offsets preserve decomposed text and astral characters without normalization", () => {
  const input = "echo e\u0301🙂";
  const root = present(parser().parse(input));
  const word = present(
    nodes(root).find(
      (value) => value.type === "word" && value.text === "e\u0301🙂",
    ),
  );
  assert.deepEqual(
    [word.startIndex, word.endIndex, word.text],
    [5, 12, "e\u0301🙂"],
  );
  assert.equal(root.endIndex, 12);
});

test("lone high surrogate follows native byte-cursor counting rather than replacement UTF8 encoding", () => {
  const input = "echo \uD800";
  const root = present(parser().parse(input));
  assert.equal(root.endIndex, 9);
  assert.equal(Buffer.byteLength(input), 8);
  assert.equal(
    present(
      nodes(root).find(
        (value) => value.type === "word" && value.text === "\uD800",
      ),
    ).endIndex,
    9,
  );
});

test("unclosed constructs retain error nodes or zero-width closing nodes rather than asserting a certificate", () => {
  const process = present(parser().parse("echo <(cat input"));
  assert.ok(
    nodes(process).some(
      (value) => value.type === ")" && value.startIndex === value.endIndex,
    ),
  );
  const failedList = present(parser().parse("echo value &&"));
  assert.ok(nodes(failedList).some((value) => value.type === "ERROR"));
});

test("root misreading and keyword-prefix metadata survive caching and contextual observations", async () => {
  const features = createNativeBashParserFeatures();
  const engine = createNativeBashParser({ features, now: () => 0 });
  const input = "NAME=value if true; then echo yes; fi";
  const first = await features.observeKeywordGuard(false, () =>
    present(engine.parse(input)),
  );
  assert.equal(first.fired, true);
  assert.equal(first.result.type, "ERROR");
  assert.equal(first.result.keywordAfterPrefix, true);
  const second = await features.observeKeywordGuard(false, () =>
    present(engine.parse(input)),
  );
  assert.equal(second.result, first.result);
  assert.equal(second.fired, true);
  const ambiguousTest = present(engine.parse("[[ x =y ]]"));
  assert.equal(ambiguousTest.misreading, "equals_in_test");
});

test("only queried feature changes invalidate a cache entry", () => {
  let enabled = true;
  const features = createNativeBashParserFeatures({
    keywordReader: () => ({
      value: enabled,
      source: "payload",
      defaultHost: true,
    }),
  });
  const engine = createNativeBashParser({ features, now: () => 0 });
  const plain = present(engine.parse("echo unchanged"));
  const input = "NAME=value if true; then echo yes; fi";
  const guarded = present(engine.parse(input));
  enabled = false;
  assert.equal(engine.parse("echo unchanged"), plain);
  const unguarded = present(engine.parse(input));
  assert.notEqual(unguarded, guarded);
  assert.equal(unguarded.keywordAfterPrefix, undefined);
  assert.equal(engine.parse(input), unguarded);
});

test("arithmetic context feature bits and mayDiffer observations remain explicit", async () => {
  const features = createNativeBashParserFeatures();
  const engine = createNativeBashParser({ features, now: () => 0 });
  assert.equal(engine.featureAnswers(16, "echo value"), 16);
  assert.equal(
    features.withoutArithmeticGuard(() =>
      engine.featureAnswers(16, "echo value"),
    ),
    0,
  );
  assert.equal(engine.featureAnswers(32, "echo value"), 0);
  assert.equal(
    features.withAlternateArithmeticRead(() =>
      engine.featureAnswers(32, "echo value"),
    ),
    32,
  );
  const plain = await features.observeMayDiffer(() =>
    engine.parse("echo value"),
  );
  assert.equal(plain.mayDiffer, false);
  const arithmetic = await features.observeMayDiffer(() =>
    engine.parse("echo $((1+2))"),
  );
  assert.equal(arithmetic.mayDiffer, true);
});

test("cache preserves object identity, insertion order and the 64-entry bound", () => {
  const engine = parser();
  for (let value = 0; value < 64; value++)
    present(engine.parse(`echo value-${value}`));
  const first = present(engine.parse("echo value-0"));
  present(engine.parse("echo value-64"));
  assert.equal(engine.cacheKeys().length, 64);
  assert.equal(engine.cacheKeys()[0], "echo value-1");
  assert.notEqual(engine.parse("echo value-0"), first);
});

test("aggregate cache characters and over-10000-character bypass are separate from parser admission", () => {
  const engine = parser();
  for (let value = 0; value < 40; value++)
    present(engine.parse(`echo ${value} ${"a".repeat(995)}`));
  assert.ok(
    engine.cacheKeys().reduce((sum, key) => sum + key.length, 0) <= 32000,
  );
  const input = `echo ${"a".repeat(10000)}`;
  const first = present(engine.parse(input));
  assert.notEqual(engine.parse(input), first);
  assert.equal(engine.cacheKeys().includes(input), false);
});

test("implicit timeout retries once, while an explicit budget or long input has one attempt", () => {
  const input = "echo x;".repeat(100);
  let calls = 0;
  const recovered = createNativeBashParser({
    now: () => [0, 100, 200][calls++] ?? 200,
  });
  const root = present(recovered.parse(input));
  assert.ok(calls >= 4);
  assert.equal(recovered.parse(input), root);
  for (const [text, budget] of [
    [input, 50],
    [input.repeat(20), undefined],
  ] satisfies [string, number | undefined][]) {
    let attempts = 0;
    const engine = createNativeBashParser({ now: () => attempts++ * 100 });
    assert.equal(engine.parse(text, budget), null);
    assert.equal(attempts, 2);
    assert.deepEqual(engine.cacheKeys(), []);
  }
  let failedCalls = 0;
  const twice = createNativeBashParser({ now: () => failedCalls++ * 100 });
  assert.equal(twice.parse(input), null);
  assert.equal(failedCalls, 4);
});

test("a zero explicit budget still samples time only at the source node interval", () => {
  let calls = 0;
  const engine = createNativeBashParser({ now: () => calls++ });
  assert.ok(engine.parse("echo small", 0));
  assert.equal(calls, 1);
  assert.deepEqual(engine.cacheKeys(), []);
});

test(
  "the 50000-node limit returns null without a timeout retry",
  () => {
    let calls = 0;
    const engine = createNativeBashParser({
      now: () => {
        calls++;
        return 0;
      },
    });
    assert.equal(engine.parse("echo x\n".repeat(13000)), null);
    assert.equal(calls, 391);
  },
  { timeout: 5000 },
);

test(
  "the 64MiB byte boundary rejects before creating nodes or starting a deadline",
  () => {
    let calls = 0;
    const engine = createNativeBashParser({
      now: () => {
        calls++;
        return 0;
      },
    });
    assert.equal(engine.parse("x".repeat(67108864)), null);
    assert.equal(calls, 0);
  },
  { timeout: 5000 },
);

test("substitution differential helper masks quoted text while retaining ambiguous nested shell syntax", () => {
  const engine = parser();
  const quoted = "echo $(echo '#')";
  assert.equal(
    engine.hasDifferentialSubstitution(
      present(engine.parse(quoted)),
      Buffer.from(quoted),
    ),
    false,
  );
  const compound = "echo $(case x in x) echo y;; esac)";
  assert.equal(
    engine.hasDifferentialSubstitution(
      present(engine.parse(compound)),
      Buffer.from(compound),
    ),
    true,
  );
});
