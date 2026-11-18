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

/** Simple commands project to argv lists and bare names, refusals to their reason. */
function outcome(
  result: NativeBashSemanticResult,
): { argv: string[][]; bare: string[] } | string {
  return result.kind === "simple"
    ? {
        argv: result.commands.map((command) => command.argv),
        bare: result.bareAssignmentNames,
      }
    : result.reason;
}

const UNKNOWN_VARIABLE =
  "A variable in this command can't be checked before it runs";
const conditionModifies = (name: string, value: string) =>
  `'${name}' was tracked as literal '${value}' but condition may modify it (||/pipeline/unset/&&-short-circuit) — cannot prove downstream value`;
const loopVariable = (name: string) =>
  `${name} as loop variable bypasses assignment validation`;

describe("lists, pipelines and subshells", () => {
  test.each<[string, string[][], string[]]>([
    // A pipeline of bare assignments still runs one command.
    ["x=1 | y=2", [["true"]], ["x", "y"]],
    ["true | true", [["true"], ["true"]], []],
    ["x=1 || y=2", [], ["x", "y"]],
    [
      "x=1; false || unset x; echo ok",
      [["false"], ["unset", "x"], ["echo", "ok"]],
      ["x"],
    ],
    // An assignment in a subshell does not reach the parent shell.
    ["x=1; (x=2); echo $x", [["true"], ["echo", "1"]], ["x", "x"]],
    ["(x=1)", [["true"]], ["x"]],
    ["(echo a)", [["echo", "a"]], []],
    ["( )", [], []],
    // A background job runs in its own process, so its assignment is lost.
    ["echo a & x=1", [["echo", "a"]], ["x"]],
    ["x=1 & echo a", [["echo", "a"]], ["x"]],
    ["! x=1", [["true"]], ["x"]],
  ])("%j", async (text, argv, bare) => {
    expect(outcome(await semantics.analyze(text))).toEqual({ argv, bare });
  });

  test.each([
    // After || or a pipe the assignment may or may not have happened.
    "x=1; true || x=2; echo $x",
    "true || x=2; echo $x",
    "x=1; true | x=2; echo $x",
    "x=1; echo a & x=2; echo $x",
    "while true; do x=1 || b; done; echo $x",
  ])("%j cannot know the variable afterwards", async (text) => {
    expect(outcome(await semantics.analyze(text))).toBe(UNKNOWN_VARIABLE);
  });
});

describe("if and while conditions", () => {
  test.each<[string, string[][], string[]]>([
    // The condition always runs, so its assignment is known in the body.
    ["if x=1; then echo $x; fi", [["echo", "1"]], ["x"]],
    [
      "if true; then echo a; elif false; then echo b; else echo c; fi",
      [["true"], ["echo", "a"], ["false"], ["echo", "b"], ["echo", "c"]],
      [],
    ],
    ["if read -r y; then echo; fi", [["read", "-r", "y"], ["echo"]], ["y"]],
    [
      "if read y || true; then echo; fi",
      [["read", "y"], ["true"], ["echo"]],
      ["y"],
    ],
    [
      "if read y | true; then echo; fi",
      [["read", "y"], ["true"], ["echo"]],
      ["y"],
    ],
    ["if ! read y; then echo; fi", [["read", "y"], ["echo"]], ["y"]],
    ["while true; do echo a; done", [["true"], ["echo", "a"]], []],
    ["until false; do echo a; done", [["false"], ["echo", "a"]], []],
    [
      "while true; do echo a || echo b; done",
      [["true"], ["echo", "a"], ["echo", "b"]],
      [],
    ],
    ["while true; do a || x=1; done", [["true"], ["a"]], ["x"]],
    [
      "x=1; while read -r line; do echo; done",
      [["read", "-r", "line"], ["echo"]],
      ["x", "line"],
    ],
  ])("%j", async (text, argv, bare) => {
    expect(outcome(await semantics.analyze(text))).toEqual({ argv, bare });
  });

  test.each<[string, string]>([
    ["x=1; if x=2 || true; then echo $x; fi", conditionModifies("x", "1")],
    ["x=1; if unset x && true; then echo; fi", conditionModifies("x", "1")],
    ["x=1; if true | x=2; then echo; fi", conditionModifies("x", "1")],
    ["x=1; if read -r x; then echo; fi", conditionModifies("x", "1")],
    ["x=1; if true | read x; then echo; fi", conditionModifies("x", "1")],
    ["y=1; if read y || true; then echo; fi", conditionModifies("y", "1")],
    // read with no name writes REPLY.
    ["REPLY=a; if read; then echo; fi", conditionModifies("REPLY", "a")],
    ["x=1; while read x; do echo; done", conditionModifies("x", "1")],
    ["x=1; while true; do x=2; done; echo $x", conditionModifies("x", "1")],
    [
      "x=1; while true; do echo a || unset x; done",
      conditionModifies("x", "1"),
    ],
  ])("%j", async (text, reason) => {
    expect(outcome(await semantics.analyze(text))).toBe(reason);
  });

  test.each([
    "if true; then x=1; fi; echo $x",
    "x=1; if true; then x=2; fi; echo $x",
    "x=1; if false; then :; else x=2; fi; echo $x",
    "while x=1; do echo $x; done",
    "while true; do echo; done; echo $REPLY",
  ])("%j cannot know the variable after the branch", async (text) => {
    expect(outcome(await semantics.analyze(text))).toBe(UNKNOWN_VARIABLE);
  });
});

describe("for loops", () => {
  test.each<[string, string[][], string[]]>([
    ["for x in a b; do echo hi; done", [["echo", "hi"]], ["x"]],
    ["for x in a b\ndo\n  echo hi\ndone", [["echo", "hi"]], ["x"]],
    ["for x in \"a\" 'b' c; do echo hi; done", [["echo", "hi"]], ["x"]],
    ["for x in *.txt; do echo hi; done", [["echo", "hi"]], ["x"]],
    ["for x in $((1)); do echo hi; done", [["echo", "hi"]], ["x"]],
    // The word list runs its substitution once, before the body.
    [
      "for x in $(seq 3); do echo hi; done",
      [
        ["seq", "3"],
        ["echo", "hi"],
      ],
      ["x"],
    ],
    ["for x in a; do x=2; done", [], ["x", "x"]],
    ["for x in a; do (echo hi); done", [["echo", "hi"]], ["x"]],
    ["for x in a; do for y in b; do :; done; done", [[":"]], ["x", "y"]],
    // A literal from before the loop is still known inside it.
    ["y=1; for x in a; do echo $y; done", [["echo", "1"]], ["y", "x"]],
  ])("%j", async (text, argv, bare) => {
    expect(outcome(await semantics.analyze(text))).toEqual({ argv, bare });
  });

  test.each(["BASH_ARGV0", "UID", "HOME", "SHELLOPTS", "PS4", "IFS", "PATH"])(
    "%s cannot be the loop variable",
    async (name) => {
      expect(
        outcome(await semantics.analyze(`for ${name} in a; do :; done`)),
      ).toBe(loopVariable(name));
    },
  );

  test.each([
    "for x in a b; do echo hi; done; echo $x",
    "for x in a; do y=1; done; echo $y",
    "y=1; for x in a; do y=2; done; echo $y",
    "for x in a; do echo $y; done",
    "for x in $y; do :; done",
  ])("%j cannot know the variable", async (text) => {
    expect(outcome(await semantics.analyze(text))).toBe(UNKNOWN_VARIABLE);
  });

  test("a loop variable cannot overwrite a tracked literal", async () => {
    expect(
      outcome(await semantics.analyze("x=1; for x in a; do echo; done")),
    ).toBe(
      `for-loop variable 'x' would overwrite tracked literal "1"; post-loop value cannot be statically determined`,
    );
  });

  test("select reads stdin and is refused", async () => {
    expect(
      outcome(await semantics.analyze("select x in a b; do echo; done")),
    ).toBe("select statement reads stdin into $REPLY; cannot statically model");
  });
});

describe("$HOME expands to the host home directory", () => {
  test.each(["echo $HOME", 'echo "$HOME"'])("%j", async (text) => {
    expect(outcome(await semantics.analyze(text))).toEqual({
      argv: [["echo", "/home/fixture"]],
      bare: [],
    });
  });
});
