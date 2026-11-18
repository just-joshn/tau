import { describe, expect, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
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

const DIFFERENTIAL = {
  surrogate: "Contains lone surrogate",
  control: "Contains control characters",
  unicodeBlank: "Contains Unicode whitespace",
  escapedBlank: "Contains backslash-escaped whitespace",
  tildeBracket: "Contains zsh ~[ dynamic directory syntax",
  equals: "Contains zsh =cmd equals expansion",
  numericRange: "Contains zsh <N-M> numeric-range glob",
  braceQuote: "Contains brace with quote character (expansion obfuscation)",
};

describe("input text that bash and zsh read differently is refused before parsing", () => {
  test.each<[string, string]>([
    ["echo \ud800", DIFFERENTIAL.surrogate],
    ["echo \udc00x", DIFFERENTIAL.surrogate],
    ["echo a\u0001", DIFFERENTIAL.control],
    ["echo a b", DIFFERENTIAL.unicodeBlank],
    ["echo a　b", DIFFERENTIAL.unicodeBlank],
    ["echo ﻿", DIFFERENTIAL.unicodeBlank],
    ["echo a\\ b", DIFFERENTIAL.escapedBlank],
    ["echo a\\\tb", DIFFERENTIAL.escapedBlank],
    ["echo a\\\\\\\nb", DIFFERENTIAL.escapedBlank],
    ["echo x\\\n#{ 'y'", DIFFERENTIAL.escapedBlank],
    ["ls ~[foo]", DIFFERENTIAL.tildeBracket],
    ["echo =ls", DIFFERENTIAL.equals],
    ["ls <1-5>", DIFFERENTIAL.numericRange],
    ["echo {'a',b}", DIFFERENTIAL.braceQuote],
    ["echo \\{ 'x'", DIFFERENTIAL.braceQuote],
    ["echo `a\\`b` {'x'}", DIFFERENTIAL.braceQuote],
    // A comment is still scanned: its brace and quote stay visible.
    ["# {x 'y'\necho a", DIFFERENTIAL.braceQuote],
    ["echo a # {x 'y'", DIFFERENTIAL.braceQuote],
  ])("%j", async (text, reason) => {
    const result = await semantics.analyze(text);
    expect(result).toMatchObject({
      kind: "too-complex",
      reason,
      differential: true,
    });
  });

  test.each<[string, string[][]]>([
    // A brace inside quotes is literal text, not brace expansion.
    ["echo '{' \"a\"", [["echo", "{", "a"]]],
    ['echo "{" x', [["echo", "{", "x"]]],
    ["echo '{'a'}'", [["echo", "{a}"]]],
    ['echo "a\\"{" \'b\'', [["echo", 'a"{', "b"]]],
    // An unescaped line continuation joins words without a blank.
    ["echo a \\\nb", [["echo", "a", "b"]]],
    [
      "echo a\n\n echo b",
      [
        ["echo", "a"],
        ["echo", "b"],
      ],
    ],
  ])("%j stays simple", async (text, commands) => {
    expect(outcome(await semantics.analyze(text))).toEqual(commands);
  });

  test("passesEscapedBlanks only refuses an escaped blank that hides a line continuation", () => {
    const run = (text: string) =>
      semantics.analyzeTree(text, parser.parse(text) ?? missingTree(), {
        passesEscapedBlanks: true,
      });
    expect(outcome(run("echo a\\ b"))).toEqual([["echo", "a b"]]);
    expect(outcome(run("echo a\\ \\\nb"))).toBe(DIFFERENTIAL.escapedBlank);
  });
});

function missingTree(): never {
  throw new Error("parser returned no tree");
}

describe("backtick substitutions whose boundaries cannot be trusted are refused", () => {
  test.each<[string, string]>([
    [
      "echo `` x",
      "empty backtick substitution — bash joins the surrounding words, so the parsed command boundaries cannot be trusted",
    ],
    [
      "echo `{` x 'y'",
      "backtick substitution scan could not be trusted (backtick_body_overrun) — the parsed bytes may differ from what bash executes",
    ],
    [
      "echo \"`echo {`\" '}'",
      "backtick substitution scan could not be trusted (backtick_body_overrun) — the parsed bytes may differ from what bash executes",
    ],
  ])("%j", async (text, reason) => {
    expect(outcome(await semantics.analyze(text))).toBe(reason);
  });
});

describe("zsh glob-group readings of parenthesised text are refused", () => {
  const GLUED_COMMENT =
    "comment glued to a paren — bash reads `)#…` and `(#…` as a comment, but zsh reads a keyword- or word-glued `(…)` as a glob group whose `#…` text is word content that executes";
  const FUNCTION_BODY =
    "`function` with a parenthesised body and no `()` — bash reads a subshell body, but zsh reads one glob-group word and expands its contents";
  const glued = (keyword: string) =>
    `\`${keyword}\` glued to a paren — bash reads a keyword and a subshell, but zsh reads one glob-group word and expands its contents`;

  test.each<[string, string]>([
    ["echo hi)#x", GLUED_COMMENT],
    ["(echo a)#x", GLUED_COMMENT],
    ["echo (#x)", GLUED_COMMENT],
    [
      "case x in (a #c\n) echo;; esac",
      "`case` pattern group holds a comment — bash reads no comment inside a pattern list, but zsh reads the group as one glob word and expands its contents",
    ],
    ["function f (echo a)", FUNCTION_BODY],
    ["function f \\\n(echo a)", FUNCTION_BODY],
    ["function f (echo a) > out", FUNCTION_BODY],
    ["if(true) then echo; fi", glued("if")],
    ["while(true); do :; done", glued("while")],
    ["case(x) in x) :;; esac", glued("case")],
  ])("%j", async (text, reason) => {
    expect(await semantics.analyze(text)).toMatchObject({
      kind: "too-complex",
      reason,
      differential: true,
    });
  });

  test("a comment that is not glued to a paren is ignored", async () => {
    expect(outcome(await semantics.analyze("echo hi #(x)"))).toEqual([
      ["echo", "hi"],
    ]);
  });
});

describe("statements glued on one line are refused because bash reads one command", () => {
  const STATEMENT =
    "statement directly follows another statement on the same line — bash reads the text as one command (`!` and shell keywords are plain words after an assignment), not two statements";
  test.each<[string, string]>([
    ["x=1 if true; then :; fi", STATEMENT],
    ["x=1 ! true", STATEMENT],
    ["x=1 while :; do :; done", STATEMENT],
    ["x=1 for i in a; do :; done", STATEMENT],
    [
      "x=1 (echo)",
      "`(…)` group directly follows a statement or word on the same line — bash rejects the line, but zsh reads the glued `(…)` as a glob-group word and expands what follows it",
    ],
  ])("%j", async (text, reason) => {
    expect(outcome(await semantics.analyze(text))).toBe(reason);
  });

  test("a newline separates the statements again", async () => {
    const result = await semantics.analyze("x=1\n(echo)");
    expect(outcome(result)).toEqual([["echo"]]);
    expect(result).toMatchObject({ bareAssignmentNames: ["x"] });
  });
});

describe("parse errors carry the ERROR node type", () => {
  test.each<[string, string]>([
    ["echo a;  ; echo b", "Parse error"],
    ["echo a; )", "Parse error"],
    ["echo `a", "Parse error"],
    ["echo ${", "Parse error"],
    ["echo ${ü}", "Parse error"],
    ["[-f x ]", "[ glued to the next word names another command"],
    [
      "echo $üx",
      "A $ followed by non-ASCII text in this command can't be checked before it runs",
    ],
    [
      "echo $#ü[0]",
      "A variable in this command can't be checked before it runs",
    ],
  ])("%j", async (text, reason) => {
    expect(await semantics.analyze(text)).toMatchObject({
      kind: "too-complex",
      reason,
      nodeType: "ERROR",
    });
  });

  test("readsDivergentShapes leaves the glued [ to the caller and reads the test", async () => {
    const result = await semantics.analyze("[-f x ]", {
      readsDivergentShapes: true,
    });
    expect(outcome(result)).toEqual([["[[", "-f", "x"]]);
  });
});

describe("redirects that assign an fd variable are refused", () => {
  const fdVariable = (name: string) =>
    `Redirect uses ${name} fd-variable assignment — modifies shell variable as side effect`;
  test.each<[string, string]>([
    ["exec {fd}>out", fdVariable("{fd}")],
    ["exec {fd}>&-", fdVariable("{fd}")],
    ["exec {fd}<file", fdVariable("{fd}")],
    ["echo {fd} >out", fdVariable("{fd}")],
    ["exec {x}  >out", fdVariable("{x}")],
    ["exec {ü}>out", fdVariable("{…}")],
    ["exec {fd}<<EOF\nx\nEOF", fdVariable("{fd}")],
    ["exec {fd}<<<x", fdVariable("{fd}")],
  ])("%j", async (text, reason) => {
    expect(outcome(await semantics.analyze(text))).toBe(reason);
  });

  test("a blank after a subscripted brace word makes it an ordinary argument", async () => {
    const result = await semantics.analyze("exec {a[1]} >out");
    expect(outcome(result)).toEqual([["exec", "{a[1]}"]]);
    expect(result).toMatchObject({
      commands: [{ redirects: [{ op: ">", target: "out" }] }],
    });
  });

  test("text after a heredoc start on its line is refused", async () => {
    expect(outcome(await semantics.analyze("cat <<EOF extra\nx\nEOF"))).toBe(
      "Text after the heredoc start on the same line cannot be statically analyzed",
    );
  });
});
