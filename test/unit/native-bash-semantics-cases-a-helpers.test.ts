import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import { createNativeBashSemantics } from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

function create(home?: () => string) {
  return createNativeBashSemantics(
    createNativeBashParser({ now: () => 0 }),
    createNativeBashPreparationFeatures(),
    createNativeBashSemanticFeatures({
      environment: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: false },
      ...(home && { home }),
      cpuNow: () => 0,
    }).host,
  );
}

const semantics = create(() => "/home/fixture");
const { native } = semantics;
const OUTPUT = native.pJ;

describe("parseCommand finds the first command and its prefix assignments", () => {
  test.each<[string, string[], string | undefined]>([
    ["FOO=1 git status", ["FOO=1"], "FOO=1 git status"],
    ["a=1 b=2 git", ["a=1", "b=2"], "a=1 b=2 git"],
    ["x=1; git", [], "git"],
    ["x=1 | git", [], "git"],
    ["! git", [], "git"],
    ["git | cat", [], "git"],
    ["echo a > out", [], "echo a"],
    ["if true; then git; fi", [], "true"],
    ["export A=1", [], "export A=1"],
    ["a=1", [], undefined],
  ])("%j", async (text, envVars, commandText) => {
    const parsed = await semantics.parseCommand(text);
    expect(parsed?.originalCommand).toBe(text);
    expect(parsed?.envVars).toEqual(envVars);
    expect(parsed?.commandNode?.text).toBe(commandText);
  });

  test("empty and over-long input have no parse", async () => {
    expect(await semantics.parseCommand("")).toBeNull();
    expect(await semantics.parseCommand("x".repeat(10_001))).toBeNull();
  });
});

describe("Zxt lists a command's leading literal words", () => {
  async function words(text: string): Promise<string[]> {
    const node = (await semantics.parseCommand(text))?.commandNode;
    if (!node) throw new Error(`no command in ${text}`);
    return native.Zxt(node);
  }

  test.each<[string, string[]]>([
    ["FOO=1 git status", ["git", "status"]],
    [`"git" 'status' "a b"`, ["git", "status", "a b"]],
    ["g\\it st\\atus", ["git", "status"]],
    [`git a"b"c`, ["git", "abc"]],
    ["git 1", ["git", "1"]],
    ["git ''", ["git", ""]],
    // A substitution ends the literal prefix.
    ["git $(id) x", ["git"]],
    ["git a$(id) x", ["git"]],
    ["git <(x)y z", ["git"]],
    // A name built around a substitution is kept as written.
    ["$(id)x arg", ["$(id)x", "arg"]],
    // A declaration reports only its keyword.
    ["export A=1", ["export"]],
    ["local x", ["local"]],
  ])("%j", async (text, expected) => {
    expect(await words(text)).toEqual(expected);
  });
});

describe("placeholder text helpers", () => {
  test("IVo strips a leading placeholder and reports text without one", () => {
    expect(native.IVo(`${OUTPUT}rest`)).toBe("rest");
    expect(native.IVo("rest")).toBeUndefined();
  });

  test("Gti accepts substitution output only at the start of a line", () => {
    expect(native.Gti("plain")).toBe(false);
    expect(native.Gti(`a\n${OUTPUT}`)).toBe(false);
    expect(native.Gti(OUTPUT)).toBe(true);
    expect(native.Gti(`a${OUTPUT}`)).toBe(true);
    expect(native.Gti(`a\n${OUTPUT}b${OUTPUT}`)).toBe(true);
  });
});

describe("option spelling helpers", () => {
  test("Qxt recognises a -p/-v/-V cluster that asks for a lookup", () => {
    expect(native.Qxt("-pv")).toBe(true);
    expect(native.Qxt("-V")).toBe(true);
    expect(native.Qxt("-p")).toBe(false);
    expect(native.Qxt("-pvx")).toBe(false);
  });

  test("JMa finds a lower-case option letter in a cluster", () => {
    expect(native.JMa("-ab", ["b"])).toBe(true);
    expect(native.JMa("-ab", ["c"])).toBe(false);
    expect(native.JMa("-AB", ["A"])).toBe(false);
  });
});

describe("MVo numbers the node types that make a command too complex", () => {
  test.each<[string | undefined, number]>([
    [undefined, -2],
    ["", -2],
    ["ERROR", -1],
    ["command_substitution", 1],
    ["heredoc_redirect", 18],
    ["word", 0],
  ])("%j", (type, code) => {
    expect(native.MVo(type)).toBe(code);
  });
});

test("$HOME uses the process home directory when the host gives none", async () => {
  const result = await create().analyze("echo $HOME");
  expect(result.kind === "simple" && result.commands[0]?.argv).toEqual([
    "echo",
    homedir(),
  ]);
});

describe("each argv word records whether it carries an unquoted glob", () => {
  test.each<[string, string[], boolean[]]>([
    ["echo a*", ["echo", "a*"], [false, true]],
    ["echo a#*", ["echo", "a#*"], [false, true]],
    ["echo 'a*'", ["echo", "a*"], [false, false]],
    ['echo "a*"', ["echo", "a*"], [false, false]],
    ['echo "\\"*"', ["echo", '"*'], [false, false]],
    ["echo \\*", ["echo", "*"], [false, false]],
    // A # at the start of a word starts a comment.
    ["echo a # *", ["echo", "a"], [false, false]],
  ])("%j", async (text, argv, globs) => {
    const result = await semantics.analyze(text);
    expect(
      result.kind === "simple" &&
        result.commands.map((command) => [
          command.argv,
          command.argvUnquotedGlob,
          command.hasUnquotedGlob,
        ]),
    ).toEqual([[argv, globs, globs.includes(true)]]);
  });
});

describe("a brace is only suspect next to a quote when it is unquoted", () => {
  test.each<[string, string[]]>([
    [`echo {a} "'"`, ["echo", "{a}", "'"]],
    [`echo '{' "'"`, ["echo", "{", "'"]],
    [`echo "{" "'"`, ["echo", "{", "'"]],
    [`echo "\\"{" "'"`, ["echo", '"{', "'"]],
    ["echo # {", ["echo"]],
  ])("%j", async (text, argv) => {
    const result = await semantics.analyze(text);
    expect(
      result.kind === "simple" && result.commands.map((c) => c.argv),
    ).toEqual([argv]);
  });

  test("an unquoted brace before a quote mid-word is refused", async () => {
    expect(await semantics.analyze(`echo a#{ "'"`)).toMatchObject({
      kind: "too-complex",
      reason: "Contains brace with quote character (expansion obfuscation)",
    });
  });
});
