import { describe, expect, test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticResult,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

const parser = createNativeBashParser({ now: () => 0 });
const semantics = createNativeBashSemantics(
  parser,
  createNativeBashPreparationFeatures(),
  createNativeBashSemanticFeatures({
    environment: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: false },
    home: () => "/home/fixture",
    cpuNow: () => 0,
  }).host,
);

/** Simple commands project to their argv lists, refusals to their reason. */
function outcome(result: NativeBashSemanticResult): string[][] | string {
  return result.kind === "simple"
    ? result.commands.map((command) => command.argv)
    : result.reason;
}

/** A tree node spec: type, the exact source text it spans, then its children. */
type Spec = [string, string, ...Spec[]];

/**
 * Builds a syntax tree over `source` by locating each node's text in order.
 * It lets a test hand the analyzer a tree that drops bytes the parser would
 * never drop, so the analyzer's own defence against that is observable.
 */
function tree(source: string, spec: Spec, from = 0): NativeBashSyntaxNode {
  const [type, text, ...children] = spec;
  const start = source.indexOf(text, from);
  if (start < 0) throw new Error(`${JSON.stringify(text)} not in source`);
  let cursor = start;
  const built = children.map((child) => {
    const node = tree(source, child, cursor);
    cursor = node.endIndex;
    return node;
  });
  return {
    type,
    text,
    startIndex: start,
    endIndex: start + text.length,
    children: built,
  };
}

const TEST = "[[ ]]";
const REASON = {
  bangParen: "zsh reads !( in [[ ]] as part of a word",
  regexExpansion: `${TEST} regex contains expansion / command / process substitution`,
  patternEqualsParen: `${TEST} pattern contains zsh =(CMD) process substitution`,
  regexEqualsParen: `${TEST} regex contains zsh =(CMD) process substitution`,
  gluedOr: `${TEST} regex contains glued || (zsh splits it as a cond operator)`,
  regexAmpersand: `${TEST} regex contains unquoted & (zsh splits the word at & at any depth)`,
  patternAmpersand: `${TEST} pattern contains unquoted & (zsh splits the word at & at any depth)`,
  unbalanced: `${TEST} regex has unbalanced parentheses (parser desync)`,
  doubleAmpersand: `${TEST} pattern leaf contains \`&&\` — shell cond-lexer divergence (zsh splits the word there)`,
  closer: `${TEST} pattern leaf contains a potential standalone \`]]\` closer — shell cond-lexer divergence (zsh may close the conditional early)`,
  quotedCloser: `${TEST} quoted operand contains \`]]\` closer or \`]]\`+separator bytes — possible parser quote-state desync`,
  singleQuotedCloser:
    "test command quoted operand contains `]]`+separator bytes — possible parser quote-state desync",
  gapBetween:
    "Test command has unparsed bytes between children — parser dropped content that shell will see",
  gapAfter:
    "Test command has unparsed bytes after its last child — parser dropped content that shell will see",
  missingRhs:
    "Test command comparison is missing its right-hand side — parser dropped consumed bytes",
  subscript: "zsh $name[expr] / $name:mod in [[ ]] operand — recursive eval",
};

describe("a conditional becomes one command whose argv lists its operands and operators", () => {
  test.each<[string, string[]]>([
    ["[[ a == b ]]", ["[[", "a", "==", "b"]],
    // Both bracket forms produce the same receipt head.
    ["[ a = b ]", ["[[", "a", "=", "b"]],
    ["[[ a != b ]]", ["[[", "a", "!=", "b"]],
    ["[[ a < b ]]", ["[[", "a", "<", "b"]],
    ["[[ a > b ]]", ["[[", "a", ">", "b"]],
    ["[[ a -nt b ]]", ["[[", "a", "-nt", "b"]],
    ["[[ -f ]]", ["[[", "-f"]],
    ["[[ ! -f a ]]", ["[[", "!", "-f", "a"]],
    ["[ !(a) ]", ["[[", "!", "(", "a", ")"]],
    ["[[ ( -n a ) ]]", ["[[", "(", "-n", "a", ")"]],
    ["[[ a == b || c ]]", ["[[", "a", "==", "b", "||", "c"]],
    ["[[ -n 'a' ]]", ["[[", "-n", "a"]],
    // Blanks, newlines and comments between operands are layout inside [[ ]].
    ["[[\t-n a ]]", ["[[", "-n", "a"]],
    ["[[ -n a &&\n-n b ]]", ["[[", "-n", "a", "&&", "-n", "b"]],
    ["[[ -n a &&\n# note\n-n b ]]", ["[[", "-n", "a", "&&", "-n", "b"]],
    ["[ -n a \\\n]", ["[[", "-n", "a"]],
    // A tracked literal is substituted into the operand.
    ["x=1; [[ $x == 1 ]]", ["[[", "1", "==", "1"]],
  ])("%j", async (text, argv) => {
    expect(outcome(await semantics.analyze(text))).toEqual([argv]);
  });
});

describe("regex and pattern leaves keep their text when zsh and bash read them alike", () => {
  test.each<[string, string]>([
    ["[[ abc =~ ^a(b|c)$ ]]", "^a(b|c)$"],
    ["[[ abc =~ a\\) ]]", "a\\)"],
    ["[[ abc =~ (a||b) ]]", "(a||b)"],
    ["[[ abc =~ a\\=(b) ]]", "a\\=(b)"],
    ["[[ abc =~ a'(' ]]", "a'('"],
    ['[[ abc =~ ("a\\")"|b) ]]', '("a\\")"|b)'],
    ['[[ abc =~ x"=("y ]]', 'x"=("y'],
    ["[[ abc =~ a]]b ]]", "a]]b"],
    ["[[ abc == a\\&b ]]", "a\\&b"],
    ["[[ abc == @(a|b) ]]", "@(a|b)"],
    // A ]] glued between word characters cannot close the conditional.
    ["[[ abc == a]]b]]c ]]", "a]]b]]c"],
    ["[[ abc == x[[:alpha:]] ]]", "x[[:alpha:]]"],
  ])("%j", async (text, leaf) => {
    const result = outcome(await semantics.analyze(text));
    expect(result).toEqual([
      ["[[", "abc", text.includes("=~") ? "=~" : "==", leaf],
    ]);
  });

  test("a quoted operand drops its quotes when it holds no ]] closer", async () => {
    expect(outcome(await semantics.analyze('[[ abc == "a]]b" ]]'))).toEqual([
      ["[[", "abc", "==", "a]]b"],
    ]);
    // [ ] has no ]] closer, so only a ]] followed by a separator is suspect.
    expect(outcome(await semantics.analyze('[ abc = "a]]" ]'))).toEqual([
      ["[[", "abc", "=", "a]]"],
    ]);
  });
});

describe("conditional text that zsh would read differently from bash is refused", () => {
  test.each<[string, string]>([
    ["[[ !(a) == b ]]", REASON.bangParen],
    ["[[ abc =~ ^a$(id)$ ]]", REASON.regexExpansion],
    ["[[ abc =~ a${x} ]]", REASON.regexExpansion],
    ["[[ abc =~ a<(x) ]]", REASON.regexExpansion],
    ["[[ abc == =(id) ]]", REASON.patternEqualsParen],
    ["[[ abc =~ =(id) ]]", REASON.regexEqualsParen],
    // zsh starts =( process substitution after a pipe or a glued ||.
    ["[[ abc =~ a|=(id) ]]", REASON.regexEqualsParen],
    ["[[ abc =~ a||=(id) ]]", REASON.regexEqualsParen],
    ["[[ abc =~ a||b ]]", REASON.gluedOr],
    ["[[ abc =~ (a&b) ]]", REASON.regexAmpersand],
    ["[[ abc == @(a&b) ]]", REASON.patternAmpersand],
    ["[[ abc == x@(a&&b) ]]", REASON.patternAmpersand],
    ['[[ abc =~ x"&&"y ]]', REASON.doubleAmpersand],
    ["[[ abc =~ x'&&' ]]", REASON.doubleAmpersand],
    ["[[ abc == []]] ]]", REASON.closer],
    ["[[ abc == [[:alpha:]]] ]]", REASON.closer],
    ["[[ abc == ]]b ]]", REASON.closer],
    ["[[ abc == a]] ]]", REASON.closer],
    ['[[ abc == "]]" ]]', REASON.quotedCloser],
    ['[[ abc == "a]]" ]]', REASON.quotedCloser],
    ['[ abc = "]];x" ]', REASON.singleQuotedCloser],
  ])("%j", async (text, reason) => {
    const result = await semantics.analyze(text);
    expect(outcome(result)).toBe(reason);
    expect(result.kind === "too-complex" && result.differential).toBe(true);
  });

  test("a refusal from inside [[ ]] is marked as a shell difference and loses its node type", async () => {
    const result = await semantics.analyze("[[ abc == $'x' ]]");
    expect(result).toMatchObject({
      kind: "too-complex",
      reason:
        "Text with escape codes in this command can't be checked before it runs",
      differential: true,
    });
    expect(result.kind === "too-complex" && result.nodeType).toBeUndefined();
  });

  test("a refusal from inside [ ] keeps its node type", async () => {
    expect(await semantics.analyze("[ abc = $(id) ]")).toMatchObject({
      kind: "too-complex",
      reason:
        "A nested command in this command can't be checked before it runs",
      nodeType: "command_substitution",
    });
  });
});

describe("a conditional tree that dropped bytes the shell will read is refused", () => {
  const analyzeSpec = (
    source: string,
    spec: Spec,
    readsDivergentShapes = false,
  ) =>
    outcome(
      semantics.analyzeTree(source, tree(source, spec), {
        readsDivergentShapes,
      }),
    );
  const unary = (text: string): Spec => [
    "unary_expression",
    text,
    ["test_operator", "-n"],
    ["word", text.slice(3)],
  ];

  test("non-blank bytes between two children", () => {
    const source = "[[ -n a x ]]";
    expect(
      analyzeSpec(source, [
        "program",
        source,
        ["test_command", source, ["[[", "[["], unary("-n a"), ["]]", "]]"]],
      ]),
    ).toBe(REASON.gapBetween);
  });

  test("non-blank bytes after the last child", () => {
    const source = "[[ -n a ]] x";
    expect(
      analyzeSpec(source, [
        "program",
        source,
        ["test_command", source, ["[[", "[["], unary("-n a"), ["]]", "]]"]],
      ]),
    ).toBe(REASON.gapAfter);
  });

  test("bytes dropped inside a nested expression", () => {
    const source = "[[ -n a x && -n b ]]";
    expect(
      analyzeSpec(source, [
        "program",
        source,
        [
          "test_command",
          source,
          ["[[", "[["],
          [
            "binary_expression",
            "-n a x && -n b",
            unary("-n a"),
            ["&&", "&&"],
            unary("-n b"),
          ],
          ["]]", "]]"],
        ],
      ]),
    ).toBe(REASON.gapBetween);
  });

  test("[ ] does not treat a newline or a comment as layout", () => {
    for (const source of ["[ -n a\n]", "[ -n a #c\n]"])
      expect(
        analyzeSpec(source, [
          "program",
          source,
          ["test_command", source, ["[", "["], unary("-n a"), ["]", "]"]],
        ]),
      ).toBe(REASON.gapBetween);
  });

  test("a comparison whose right-hand side is missing", () => {
    // The empty node is itself a parse error unless divergent shapes are read.
    const source = "[ a = ]";
    expect(
      analyzeSpec(
        source,
        [
          "program",
          source,
          [
            "test_command",
            source,
            ["[", "["],
            [
              "binary_expression",
              "a =",
              ["word", "a"],
              ["=", "="],
              ["test_rhs_missing", ""],
            ],
            ["]", "]"],
          ],
        ],
        true,
      ),
    ).toBe(REASON.missingRhs);
  });

  test.each<[string, string]>([
    ["[[ abc =~ a) ]]", "a)"],
    ["[[ abc =~ (a ]]", "(a"],
  ])("a regex leaf with unbalanced parentheses: %j", (source, leaf) => {
    expect(
      analyzeSpec(source, [
        "program",
        source,
        [
          "test_command",
          source,
          ["[[", "[["],
          [
            "binary_expression",
            `abc =~ ${leaf}`,
            ["word", "abc"],
            ["=~", "=~"],
            ["regex", leaf],
          ],
          ["]]", "]]"],
        ],
      ]),
    ).toBe(REASON.unbalanced);
  });

  test.each<[string, string]>([
    ["x=1; [[ $x [1] ]]", "[1]"],
    ["x=1; [[ $x :h ]]", ":h"],
  ])(
    "an expansion followed by a subscript or modifier sibling: %j",
    (source, next) => {
      expect(
        analyzeSpec(source, [
          "program",
          source,
          [
            "list",
            source,
            [
              "variable_assignment",
              "x=1",
              ["variable_name", "x"],
              ["=", "="],
              ["number", "1"],
            ],
            [";", ";"],
            [
              "test_command",
              source.slice(5),
              ["[[", "[["],
              [
                "binary_expression",
                `$x ${next}`,
                ["simple_expansion", "$x", ["$", "$"], ["variable_name", "x"]],
                ["word", next],
              ],
              ["]]", "]]"],
            ],
          ],
        ]),
      ).toBe(REASON.subscript);
    },
  );
});
