import { describe, expect, test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import { createNativeBashPreparationFeatures } from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticResult,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";

const semantics = createNativeBashSemantics(
  createNativeBashParser({ now: () => 0 }),
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

const notPlainName = (command: string, operand: string) =>
  `${command} operand '${operand}' is not a plain variable name — the shell expands or matches it before assigning`;
const notInertName = (command: string, operand: string) =>
  `${command} operand '${operand}' is not a plain NAME with an inert value — the shell may re-parse it as a subscript, an expanded name or a compound assignment`;
const evaluatedSubscript = (command: string, operand: string) =>
  `${command} operand '${operand}' carries a subscript or escape the shell evaluates — the parser read it as literal text`;
const decodedOperand = (command: string, operand: string) =>
  `${command} operand ${operand} — a $'…' word the shell decodes, which may carry a subscript the parser cannot read`;
const evaluatingFlag = (command: string) =>
  `${command} with a flag that changes assignment semantics and an operand it would evaluate`;
const changesSemantics = (flag: string) =>
  `declare flag ${flag} changes assignment semantics (nameref/integer/float/array/width-truncation/case-conversion)`;
const zshTypeset = (command: string, flag: string) =>
  `${command} flag ${flag} — zsh bin_typeset mathevals (-i/-E/-F), width-truncates (-L/-R/-Z), or case-converts (-l/-u) the assigned value`;
const autoload = (command: string) =>
  `${command} with both -f and -u/-U flags — zsh marks a function for autoload (synonym of 'autoload'), creating a function from file contents at call time`;
const assigningOption = (command: string, option: string) =>
  `${command} ${option} with an assignment — not every supported bash and zsh assigns under that option, so the value cannot be statically verified`;
const unknownOption = (command: string, option: string) =>
  `${command} option '${option}' is not one bash and zsh are both known to accept — a shell that rejects it assigns nothing, so the names it declares cannot be statically verified`;
const lateOption = (command: string, word: string) =>
  `${command} word '${word}' comes after the options — the shell reads it as a name, which it cannot be, and bash and zsh go on from that error differently`;
const arrayAttribute = (command: string) =>
  `'${command}' gives a name the array attribute — zsh empties a value it held and bash keeps it, so it cannot be statically verified`;
const spelled = (command: string, head: string) =>
  `${command} spelled '${head}' with an operand the shell would evaluate — the parser did not read this as a declaration`;
const decodedHead = (head: string, after?: string) =>
  `command head ${head}${after === undefined ? "" : ` after ${after}`} — a $'…' word the shell decodes before looking the command up`;
const UNCHECKABLE = "This command can't be checked before it runs";
const VARIABLE = "A variable in this command can't be checked before it runs";

type Case = [text: string, expected: string[][] | string];

async function expectCases(cases: Case[]) {
  for (const [text, expected] of cases)
    expect([text, outcome(await semantics.analyze(text))]).toEqual([
      text,
      expected,
    ]);
}

describe("declaration operands", () => {
  test("plain names and inert values are tracked as assignments", async () => {
    await expectCases([
      ["declare a=b", [["declare", "a=b"]]],
      ["local a=b", [["local", "a=b"]]],
      ["'declare' x=1", [["declare", "x=1"]]],
      ["declare 'x'=a", [["declare", "x=a"]]],
      ["declare x+=a", [["declare", "x=a"]]],
      ['declare x+="a"', [["declare", "x=a"]]],
      ['declare x="a b"', [["declare", "x=a b"]]],
      ["declare x='a'", [["declare", "x=a"]]],
      ["declare -- x=1", [["declare", "--", "x=1"]]],
      ["declare -x x=1", [["declare", "-x", "x=1"]]],
      ["declare -r x=1", [["declare", "-r", "x=1"]]],
      ["declare -t x", [["declare", "-t", "x"]]],
      ["declare +x x", [["declare", "+x", "x"]]],
      ["declare +r x", [["declare", "+r", "x"]]],
      ["declare -fg x", [["declare", "-fg", "x"]]],
      ["declare -f a.b", [["declare", "-f", "a.b"]]],
      ["local -f x.y", [["local", "-f", "x.y"]]],
      ["local -r x", [["local", "-r", "x"]]],
      ["local -p", [["local", "-p"]]],
      ["typeset -U x", [["typeset", "-U", "x"]]],
      ["export x=a y=b", [["export", "x=a", "y=b"]]],
      ["export a+=b", [["export", "a=b"]]],
      ['export "x"=1', [["export", "x=1"]]],
      ["export \\x=1", [["export", "x=1"]]],
      ["export a=\\x", [["export", "a=x"]]],
      ["export 'a=\\x'", [["export", "a=\\x"]]],
      ['export "a=b\\c"', [["export", "a=b\\c"]]],
      ["export a=b'c'", [["export", "a=bc"]]],
      ["export 'a'", [["export", "a"]]],
      ['export "a"', [["export", "a"]]],
      ["export \\abc", [["export", "abc"]]],
      ["export -- a", [["export", "--", "a"]]],
      ["export -- x=1", [["export", "--", "x=1"]]],
      ["export -p", [["export", "-p"]]],
      ["export -n x", [["export", "-n", "x"]]],
      ["export -f fn", [["export", "-f", "fn"]]],
      ["export -f a.b", [["export", "-f", "a.b"]]],
      ["export x; echo", [["export", "x"], ["echo"]]],
      ["readonly -p", [["readonly", "-p"]]],
      ["readonly -x x", [["readonly", "-x", "x"]]],
      ["readonly \\x", [["readonly", "x"]]],
      ["readonly x='a[1]'", [["readonly", "x=a[1]"]]],
      // Arithmetic and command output become runtime placeholders.
      ["declare x=$((1+2))", [["declare", "x=__TRACKED_VAR__"]]],
      ["declare a=$(x)", [["x"], ["declare", "a=__CMDSUB_OUTPUT__"]]],
      [
        "export y=$(date) z=1",
        [["date"], ["export", "y=__CMDSUB_OUTPUT__", "z=1"]],
      ],
    ]);
  });

  test("declare, typeset and local refuse operands that are not inert names", async () => {
    await expectCases([
      ["declare x='(a b)'", notInertName("declare", "x='(a b)'")],
      ["declare x=\\(a\\)", notInertName("declare", "x=\\(a\\)")],
      ["declare x=${y:-(}", notInertName("declare", "x=${y:-(}")],
      ["declare 'a[1]'=1", notInertName("declare", "'a[1]'=1")],
      ["declare a[1]", notInertName("declare", "a[1]")],
      ["declare \\a[1]", notInertName("declare", "\\a[1]")],
      ["local a[1]=x", notInertName("local", "a[1]=x")],
      ["declare a{b,c}", notInertName("declare", "a{b,c}")],
      ["declare a{1..2}", notInertName("declare", "a{1..2}")],
      ['declare "a{b,c}"', notInertName("declare", '"a{b,c}"')],
      ["declare 'a{b,c}'", notInertName("declare", "'a{b,c}'")],
      ["declare 'a'b", notInertName("declare", "'a'b")],
      ["declare \"a\"'b'", notInertName("declare", "\"a\"'b'")],
      ["typeset 1x=2", notInertName("typeset", "1x=2")],
      ["declare a.b=1", notInertName("declare", "a.b=1")],
      ["declare x.y", notInertName("declare", "x.y")],
      ["declare 'a[$(id)]'=1", notInertName("declare", "'a[$(id)]'=1")],
      [
        "declare -f x.y=1",
        "declare operand 'x.y=1' is not a plain variable name — the shell may turn it into an assignment the parser did not see",
      ],
      [
        'declare x="$(a)"(b)',
        "declare operand 'x=\"$(a)\"(' is split across adjacent quoted segments — the shell joins them into one word the analyzer cannot verify",
      ],
      ["declare $'a'", decodedOperand("declare", "$'a'")],
      ["declare x=$y", VARIABLE],
      [
        "declare x=${y}",
        "A variable in braces in this command can't be checked before it runs",
      ],
    ]);
  });

  test("export, readonly and unset refuse operands the shell would expand or evaluate", async () => {
    await expectCases([
      ["export A 'B''C'", notPlainName("export", "'B''C'")],
      ['export a "b""c"', notPlainName("export", '"b""c"')],
      ["export 'a b'", notPlainName("export", "'a b'")],
      ["export 1abc", notPlainName("export", "1abc")],
      ["export a.b", notPlainName("export", "a.b")],
      ["export x.y", notPlainName("export", "x.y")],
      ["export 'a'+=b", notPlainName("export", "'a'+=b")],
      ["export a{b,c}", notPlainName("export", "a{b,c}")],
      ["export -m 'a*'", notPlainName("export", "'a*'")],
      ["unset 1x", notPlainName("unset", "1x")],
      ["unset x.y", notPlainName("unset", "x.y")],
      ["unset \\x", notPlainName("unset", "\\x")],
      ["export a\\[1\\]", evaluatedSubscript("export", "a\\[1\\]")],
      ["export 'a[1]'", evaluatedSubscript("export", "'a[1]'")],
      ["export 'a[$(id)]'=1", evaluatedSubscript("export", "'a[$(id)]'=1")],
      ["export x\\=1", evaluatedSubscript("export", "x\\=1")],
      ["unset a[1]", evaluatedSubscript("unset", "a[1]")],
      ["unset 'a[1]'", evaluatedSubscript("unset", "'a[1]'")],
      ['unset a"[1]"', evaluatedSubscript("unset", 'a"[1]"')],
      ["export $'a'", decodedOperand("export", "$'a'")],
      ["readonly $'a'", decodedOperand("readonly", "$'a'")],
      ["unset $'x'", decodedOperand("unset", "$'x'")],
      [
        "export $'-x' a",
        "export flag $'-x' — a $'…' flag word the shell decodes",
      ],
      ["export a[1]=x", "This command can't be checked before it runs"],
      ["export $x", VARIABLE],
      ['export "$x"', VARIABLE],
      ['export x="$y"', VARIABLE],
      [
        "export x=$'a'",
        "Text with escape codes in this command can't be checked before it runs",
      ],
    ]);
  });

  test("flags that change how a value is assigned are refused", async () => {
    await expectCases([
      ["export -a x=$(foo)", evaluatingFlag("export")],
      ["declare -i x=a+b", evaluatingFlag("declare")],
      ["declare -i 'x=1'", evaluatingFlag("declare")],
      ["declare -i x='a'", evaluatingFlag("declare")],
      ["declare -F x.y", evaluatingFlag("declare")],
      ["declare -i x=1+2", changesSemantics("-i")],
      ["declare -n a=b", changesSemantics("-n")],
      ["declare -l x", changesSemantics("-l")],
      ["declare -Z x", changesSemantics("-Z")],
      ["declare -a x=(a b)", changesSemantics("-a")],
      ["export -i x=1", zshTypeset("export", "-i")],
      ["export -E x=1", zshTypeset("export", "-E")],
      ["export -F x=1", zshTypeset("export", "-F")],
      ["readonly -i x=1", zshTypeset("readonly", "-i")],
      [
        "typeset +m x",
        "typeset flag +m — zsh -m/+m pattern-assigns every matching variable; cannot statically model target set",
      ],
      ["declare -fu f", autoload("declare")],
      ["typeset -f -U f", autoload("typeset")],
      ["readonly -fu f", autoload("readonly")],
      [
        "typeset -T A a",
        "typeset -T creates a user-defined zsh tied pair — tracked literals for its operands are unreliable",
      ],
      [
        "readonly -a x=(1 2)",
        "A list of values in this command can't be checked before it runs",
      ],
    ]);
  });

  test("options and operand order that bash and zsh treat differently are refused", async () => {
    await expectCases([
      ["declare -g x=1", assigningOption("declare", "-g")],
      ["declare -p x=1", assigningOption("declare", "-p")],
      ["export -n x=1", assigningOption("export", "-n")],
      ["export -z x", unknownOption("export", "-z")],
      ["export +x x", unknownOption("export", "+x")],
      ["readonly -r x", unknownOption("readonly", "-r")],
      ["export x -n", lateOption("export", "-n")],
      ["declare x=1 -r", lateOption("declare", "-r")],
      ["declare -- -x", lateOption("declare", "-x")],
      [
        "readonly x=1 x=2",
        "readonly names 'x' twice — the first makes it read-only, so bash does not carry out the second",
      ],
      [
        "local x=1; echo",
        "'local' outside a function — bash refuses that and assigns nothing, so the value cannot be statically verified",
      ],
      ["export -a x; echo", arrayAttribute("export")],
      ["readonly -A x; echo", arrayAttribute("readonly")],
    ]);
  });

  test("an option refusal keeps the declaration node type", async () => {
    expect(await semantics.analyze("export -z x")).toMatchObject({
      kind: "too-complex",
      divergentShape: true,
      nodeType: "declaration_command",
    });
  });
});

describe("declarations hidden behind a command prefix", () => {
  test("a wrapper does not hide an operand the declaration would evaluate", async () => {
    await expectCases([
      ["builtin declare -i x=a+b", spelled("declare", "builtin …")],
      ["command export a[1]=x", spelled("export", "command …")],
      ["builtin readonly a[1]=x", spelled("readonly", "builtin …")],
      ["builtin readonly a[1]=b", spelled("readonly", "builtin …")],
      ["command declare x='(a)'", spelled("declare", "command …")],
      ["\\declare -i x=a", spelled("declare", "\\declare")],
      ["builtin export $'x'", spelled("export", "builtin …")],
      ["builtin export 'a\\b'", spelled("export", "builtin …")],
      ["builtin local a.b", spelled("local", "builtin …")],
      ["builtin typeset -A a=(b c)", spelled("typeset", "builtin …")],
      ["builtin declare x=$'a'", spelled("declare", "builtin …")],
      ["builtin export $'-a' x", spelled("export", "builtin …")],
      ["builtin unset a[0]", spelled("unset", "builtin …")],
      ["command command export a[0]=1", spelled("export", "command …")],
      ["time export a[0]=1", spelled("export", "time …")],
      ["exec builtin export x[1]=a", spelled("export", "exec …")],
      ["- export x[1]=a", spelled("export", "- …")],
      ["coproc export x[1]=1", spelled("export", "coproc …")],
      ["builtin export a=$x", VARIABLE],
    ]);
  });

  test("a wrapped declaration with inert operands stays simple", async () => {
    await expectCases([
      ["builtin integer x=1", [["builtin", "integer", "x=1"]]],
      ["builtin float y=1", [["builtin", "float", "y=1"]]],
      ["builtin export a=b", [["builtin", "export", "a=b"]]],
      ['builtin export "x=y"', [["builtin", "export", "x=y"]]],
      ["builtin export -a a=b", [["builtin", "export", "-a", "a=b"]]],
      // command -v only looks the name up, so nothing is declared.
      ["command -v export a[1]", [["command", "-v", "export", "a[1]"]]],
    ]);
  });

  test("a $'...' command name is refused when it takes operands", async () => {
    await expectCases([
      ["$'ls' x", decodedHead("$'ls'")],
      ["command $'ls' x", decodedHead("$'ls'", "command")],
      ["builtin $'ls' x", decodedHead("$'ls'", "builtin")],
      ["exec -a name $'ls' x", decodedHead("$'ls'", "exec")],
      [
        "$'ls' -l",
        "Text with escape codes in this command can't be checked before it runs",
      ],
    ]);
  });
});

describe("unset", () => {
  test("plain names and the -f/-v options are accepted", async () => {
    await expectCases([
      ["unset -f fn", [["unset", "-f", "fn"]]],
      ["unset -f x.y", [["unset", "-f", "x.y"]]],
      ["unset -v a", [["unset", "-v", "a"]]],
      ["unset -f -v x", [["unset", "-f", "-v", "x"]]],
      ["unsetenv x", [["unsetenv", "x"]]],
      ["x=1; unsetenv x", [["unsetenv", "x"]]],
      ["echo; unset x", [["echo"], ["unset", "x"]]],
    ]);
  });

  test("an unset name is no longer known to later commands", async () => {
    await expectCases([["unset x; echo $x", VARIABLE]]);
  });

  test("unset refuses shell-control variables, unknown options and quoted operands", async () => {
    const shellVariable = (name: string) =>
      `'unset' targets shell variable ${name} (exec-influencing / integer-attr / IFS / PS4)`;
    const unknownValue = (name: string) =>
      `'${name}' no longer has a statically known value at this unset — cannot verify what the command leaves behind`;
    await expectCases([
      ["unset PATH", shellVariable("PATH")],
      ["unset IFS", shellVariable("IFS")],
      ["x=$(a); unset -f x", unknownValue("x")],
      ["x=$(a); unsetenv x", unknownValue("x")],
      ["unset -x a", UNCHECKABLE],
      ["unset a -f", UNCHECKABLE],
      ["unset - x", UNCHECKABLE],
      ["unset 'x'", UNCHECKABLE],
      ["unset -f 'x'", UNCHECKABLE],
      ["unset 'PATH'", UNCHECKABLE],
      [
        'unset "x"',
        "Quoted text in this command can't be checked before it runs",
      ],
    ]);
  });
});
