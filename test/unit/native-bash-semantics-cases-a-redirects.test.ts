import { describe, expect, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticResult,
  type NativeBashSemanticSimple,
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

function simple(result: NativeBashSemanticResult): NativeBashSemanticSimple {
  if (result.kind !== "simple") throw new Error(result.reason);
  return result;
}

/** Each command as argv plus its redirects written `fd op target`. */
async function redirects(text: string): Promise<[string[], string[]][]> {
  return simple(await semantics.analyze(text)).commands.map((command) => [
    command.argv,
    command.redirects.map(({ fd, op, target }) => `${fd ?? ""}${op} ${target}`),
  ]);
}

const REASON = {
  closeFollowed:
    "Close-fd redirect is followed by a word — bash passes it to the command as a hidden argument",
  dashTarget:
    "Redirect target after >& or <& starts with - — bash treats the dash as close-fd and passes the rest to the command as a hidden argument",
  secondPass:
    "bash `>&` applies a second word-expansion pass to its target — path cannot be statically validated",
  bang: "Redirect target starts with ! — zsh clobber or history expansion",
  equals: "Redirect target starts with = — zsh expands to PATH binary",
  newline: "Redirect target contains newline — potential path traversal",
  dollarConcat:
    "Redirect target concatenation contains $/` — unanalyzable gap or substitution",
  multiple: "Redirect has multiple targets — post-redirect args swallowed",
  unrecognized: "Unrecognized redirect shape",
  generic: "This command can't be checked before it runs",
  failingExpansion: (name: string) =>
    `'${name}' is set for one command that carries an expansion which can fail at runtime — whether the assignment stands for later commands cannot be statically verified`,
};

describe("a literal redirect target is attached to the command it applies to", () => {
  test.each<[string, [string[], string[]][]]>([
    ["> out", [[[], ["> out"]]]],
    ["> out < in", [[[], ["> out", "< in"]]]],
    ["echo a >> out", [[["echo", "a"], [">> out"]]]],
    ["echo a >| out", [[["echo", "a"], [">| out"]]]],
    ["echo a &> out", [[["echo", "a"], ["&> out"]]]],
    ["echo a &>> out", [[["echo", "a"], ["&>> out"]]]],
    ["echo a 3> out", [[["echo", "a"], ["3> out"]]]],
    ["cat <&3", [[["cat"], ["<& 3"]]]],
    [
      "echo a 2>&1 > out",
      [
        [
          ["echo", "a"],
          ["2>& 1", "> out"],
        ],
      ],
    ],
    ["echo a >& a.txt", [[["echo", "a"], [">& a.txt"]]]],
    ['echo a >& "a.txt"', [[["echo", "a"], [">& a.txt"]]]],
    // Quotes and escapes are removed the way the shell removes them.
    ["echo a > 'out'", [[["echo", "a"], ["> out"]]]],
    ["echo a 2> \"o\"'u'", [[["echo", "a"], ["2> ou"]]]],
    ['echo a > o"x"y', [[["echo", "a"], ["> oxy"]]]],
    ["echo a > 'a'b", [[["echo", "a"], ["> ab"]]]],
    ['echo a > "o\\$x"', [[["echo", "a"], ["> o$x"]]]],
    ["echo a > a\\$b", [[["echo", "a"], ["> a$b"]]]],
    ["echo a > a\\`b", [[["echo", "a"], ["> a`b"]]]],
    ["echo a > \\\nout", [[["echo", "a"], ["> out"]]]],
    // Only >& and <& read a leading dash as close-fd.
    ['echo a > "-x"', [[["echo", "a"], ["> -x"]]]],
    // A redirect after a list binds to its last command only.
    [
      "echo a && echo b > out",
      [
        [["echo", "a"], []],
        [["echo", "b"], ["> out"]],
      ],
    ],
    [
      "echo a || echo b > out",
      [
        [["echo", "a"], []],
        [["echo", "b"], ["> out"]],
      ],
    ],
    [
      "echo a && echo b && echo c > out",
      [
        [["echo", "a"], []],
        [["echo", "b"], []],
        [["echo", "c"], ["> out"]],
      ],
    ],
    [
      "echo a | cat > out",
      [
        [["echo", "a"], []],
        [["cat"], ["> out"]],
      ],
    ],
    ["! echo a > out", [[["echo", "a"], ["> out"]]]],
    // A bare assignment with a redirect still opens the file.
    [
      "echo a && x=1 > out",
      [
        [["echo", "a"], []],
        [[], ["> out"]],
      ],
    ],
  ])("%j", async (text, expected) => {
    expect(await redirects(text)).toEqual(expected);
  });

  test("a tracked literal fills a quoted target, which is then not source-literal", async () => {
    const [command] = simple(
      await semantics.analyze('x=1; echo a > "$x"'),
    ).commands;
    expect(command?.redirects).toEqual([
      { op: ">", target: "1", fd: undefined, targetSourceLiteral: false },
    ]);
  });

  test("a glob or tilde target is kept as written for the path check to see", async () => {
    expect(await redirects("echo a > *.txt")).toEqual([
      [["echo", "a"], ["> *.txt"]],
    ]);
    expect(await redirects("echo a > ~/x")).toEqual([
      [["echo", "a"], ["> ~/x"]],
    ]);
  });

  test("a command fed by a heredoc is not source-literal, a later one still is", async () => {
    const result = simple(
      await semantics.analyze("cat <<'EOF'\nx\nEOF\necho b > out"),
    );
    expect(
      result.commands.map(({ argv, argvSourceLiteral }) => [
        argv,
        argvSourceLiteral,
      ]),
    ).toEqual([
      [["cat"], false],
      [["echo", "b"], true],
    ]);
  });

  test("a prefix assignment rides along with a literal redirect", async () => {
    const [command] = simple(
      await semantics.analyze("x=1 echo a > out"),
    ).commands;
    expect(command?.envVars).toEqual([{ name: "x", value: "1" }]);
    expect(command?.redirects.map(({ target }) => target)).toEqual(["out"]);
  });
});

describe("a redirect target the analyzer cannot pin to one path is refused", () => {
  test.each<[string, string]>([
    ["echo a > !out", REASON.bang],
    ['echo a > "!x"', REASON.bang],
    ['echo a > "=out"', REASON.equals],
    ['echo a > "a\nb"', REASON.newline],
    ['echo a > a"b\nc"', REASON.newline],
    ["echo a >& -x", REASON.dashTarget],
    ['echo a >& "-x"', REASON.dashTarget],
    ["echo a <& -", REASON.dashTarget],
    ['cat <&"-"', REASON.dashTarget],
    ["echo a >&- x", REASON.closeFollowed],
    ["echo a >& 'a b'", REASON.secondPass],
    ['echo a >& "a b"', REASON.secondPass],
    ["echo a >& a+b", REASON.secondPass],
    ['echo a >& "&x"', REASON.secondPass],
    ["echo a > o$HOME", REASON.dollarConcat],
    ["echo a > a'$b'", REASON.dollarConcat],
    ['x=1; echo a > a"$x"', REASON.dollarConcat],
    ['echo a > "a"$((1))', REASON.dollarConcat],
    ["echo a > out1 out2", REASON.multiple],
    ["echo a <> out", REASON.unrecognized],
    // Brace, escaped-brace and bare $ targets have no single literal reading.
    ["echo a > a\\{b,c\\}", REASON.generic],
    ["echo a > a$", REASON.generic],
    ["echo a 2>&-", REASON.generic],
    ["echo a 3>&- 4>&-", REASON.generic],
    // A failing expansion may cancel the command and its prefix assignment.
    ["x=1 echo a > out$((1+1))", REASON.failingExpansion("x")],
    ["x=1 y=2 echo a > o$((1))", REASON.failingExpansion("x")],
  ])("%j", async (text, reason) => {
    expect(outcome(await semantics.analyze(text))).toBe(reason);
  });

  test("a redirect after a group or subshell refuses the group", async () => {
    const cases: [string, string][] = [
      ["{ echo a; } > out", "compound_statement"],
      ["(echo a) > out", "subshell"],
      ["echo a && (echo b) > out", "subshell"],
      ["! (echo a) > out", "subshell"],
      ["if true; then echo; fi > out", "if_statement"],
    ];
    for (const [text, nodeType] of cases)
      expect(await semantics.analyze(text)).toMatchObject({
        kind: "too-complex",
        nodeType,
      });
  });

  test("text after a heredoc start on its line is refused, a redirect there is not analyzed", async () => {
    expect(
      outcome(await semantics.analyze("cat <<'EOF' && echo b\nx\nEOF")),
    ).toBe(
      "Text after the heredoc start on the same line cannot be statically analyzed",
    );
    expect(await semantics.analyze("cat <<'EOF' > out\nx\nEOF")).toMatchObject({
      kind: "too-complex",
      nodeType: "file_redirect",
    });
  });
});
