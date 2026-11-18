import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";
import { createNativeBashCommandProjection } from "../../src/native-bash-command-projection.js";

const projection = createNativeBashCommandProjection(
  createNativeBashParser({ now: () => 0 }),
);

// Every deadline sample jumps a billion milliseconds, so any parse that
// creates 128 nodes times out and the parser reports no tree.
function timedOutProjection() {
  let reads = 0;
  return createNativeBashCommandProjection(
    createNativeBashParser({ now: () => reads++ * 1e9 }),
  );
}
const heavy = "printf x;".repeat(100);

function tree(text: string): NativeBashSyntaxNode {
  const root = projection.parser.parse(text);
  assert.ok(root !== null, text);
  return root;
}
function node(
  type: string,
  text: string,
  children: NativeBashSyntaxNode[] = [],
): NativeBashSyntaxNode {
  return {
    type,
    text,
    startIndex: 0,
    endIndex: Buffer.byteLength(text),
    children,
  };
}
const inlineBodies = (count: number) =>
  node(
    "program",
    "",
    Array.from({ length: count }, () => node("ERROR", "${ echo nested; }")),
  );

describe("a parser that times out", () => {
  test("every text consumer falls back to its native refusal shape", () => {
    const f = timedOutProjection();
    assert.deepEqual(f.splitCommands(heavy), [heavy]);
    assert.deepEqual(f.staticArgv(heavy), []);
    assert.deepEqual(f.nestedCommandTexts(heavy), []);
    assert.equal(f.flattenCommandTexts(heavy), null);
    assert.equal(f.strictLiteralCommandTexts(heavy), null);
    assert.equal(f.hasParenthesizedExpansion(heavy), true);
    assert.equal(f.tailAfterAnd(heavy), true);
    assert.equal(
      f.redirectsNeedReview(heavy, () => false),
      true,
    );
    assert.equal(f.requiresComplexRead(heavy), true);
    assert.deepEqual(f.redirections(heavy), {
      commandWithoutRedirections: heavy,
      redirections: [],
      hasDangerousRedirection: false,
      dangerousRedirectionReason: undefined,
    });
  });

  test("a backtick reading that cannot be parsed contributes nothing", () => {
    const f = timedOutProjection();
    const text = `echo \`${'printf \\"x\\";'.repeat(100)}\``;
    const root = f.parser.parse(text);
    assert.ok(root !== null);
    assert.deepEqual(f.nestedCommandTexts(text), [text]);
    assert.ok(
      f.alternateLines(text, root).every((item) => item.lineRoot === null),
    );
    assert.equal(f.hasErroredAlternatives(root), false);
  });

  test("an inline body that cannot be parsed is an overrun only when the caller asks", () => {
    const f = timedOutProjection();
    const expansion = node("expansion", `\${ ${heavy} }`);
    assert.deepEqual(f.collectNestedTexts(expansion), []);
    assert.equal(f.hasUnparsedBodies(expansion), true);
    assert.deepEqual(
      [...f.readBodyAlternatives({ first: [heavy], second: [] })],
      [{ body: heavy, bodyRoot: null }],
    );
  });
});

test("an ERROR root that wraps a program still splits and strips its statements", () => {
  const text = "echo ${ echo a; } > out.txt";
  assert.deepEqual(projection.splitCommands(text), ["echo ${ echo a; }"]);
  const result = projection.redirections(text);
  assert.equal(result.commandWithoutRedirections, "echo ${ echo a; }");
  assert.deepEqual(result.redirections, [{ target: "out.txt", operator: ">" }]);
});

describe("static argv names the first simple command", () => {
  test.each<[string, string[]]>([
    ["A=1; echo hi", ["echo", "hi"]],
    ["A=1", []],
    ["echo a | grep b", ["echo", "a"]],
    ["(true) | cat", ["true"]],
    ["(A=1) | cat", ["cat"]],
    ["{ echo; } > out.txt", []],
    ["if true; then echo; fi", ["true"]],
    ["(( 1 ))", []],
    ["a$(b)c x", ["a$(b)c", "x"]],
    ['"ec"ho x', ["echo", "x"]],
    ["printf 42 'a' \"b\"", ["printf", "42", "a", "b"]],
    ['printf a"b" c', ["printf", "ab", "c"]],
    ["cat <(echo) after", ["cat"]],
    ["echo $x y", ["echo", "y"]],
  ])("%p", (text, argv) => {
    assert.deepEqual(projection.staticArgv(text), argv);
  });

  test("hand-built command shapes keep the first word as the name", () => {
    assert.deepEqual(
      projection.projectStaticArgv(
        node("declaration_command", "x", [node("word", "x")]),
      ),
      [],
    );
    assert.deepEqual(
      projection.projectStaticArgv(node("declaration_command", "", [])),
      [],
    );
    assert.deepEqual(
      projection.projectStaticArgv(
        node("command", "echo hi", [node("word", "echo"), node("word", "hi")]),
      ),
      ["echo", "hi"],
    );
    assert.deepEqual(
      projection.projectStaticArgv(
        node("command", "x", [node("command_name", "x")]),
      ),
      ["x"],
    );
    assert.equal(
      projection.findStaticCommand(node("variable_assignment", "A=1"), null),
      null,
    );
  });
});

describe("adjacent statements on one line", () => {
  test.each<[string, string | null]>([
    ["A=1 ! echo", "statement"],
    ["A=1 (echo)", "subshell"],
    ["{ A=1 ! echo; }", "statement"],
    ["A=1 ! echo && echo", "statement"],
    ["A=1\n! echo", null],
    ["A=1; ! echo", null],
  ])("%p", (text, kind) => {
    const refusal = projection.adjacentStatementRefusal(tree(text));
    if (kind === null) {
      assert.equal(refusal, null);
      return;
    }
    assert.ok(refusal !== null);
    assert.equal(refusal.kind, "too-complex");
    assert.equal(refusal.differential, true);
    assert.equal(refusal.reason.startsWith("`(…)`"), kind === "subshell");
    assert.equal(projection.strictLiteralCommandTexts(text), null);
  });

  test("an empty container after a statement is not a glued statement", () => {
    assert.equal(
      projection.adjacentStatementRefusal(
        node("program", "", [node("command", "a"), node("list", "")]),
      ),
      null,
    );
  });
});

describe("strict literal command texts", () => {
  test.each<[string, string[] | null]>([
    ["", null],
    ["x".repeat(10001), null],
    ["echo '`'", null],
    ["echo {a,b}", null],
    ["echo {a..c}", null],
    ["echo '{a,b}'", ["echo '{a,b}'"]],
    ["echo $'x'", null],
    ['echo $"x"', null],
    ["echo '$\"'", ["echo '$\"'"]],
    ["echo {a} -x", ["echo {a} -x"]],
    ["echo {a} -x\\ y", null],
    ['echo \'a\' "b\\"c" d\\ e', ['echo \'a\' "b\\"c" d\\ e']],
    ["echo x 2>&1", ["echo x"]],
    ["cat 3<&0", ["cat"]],
    ["echo x >&2", ["echo x"]],
    ["echo x 2>&-", null],
    ["A=1", ["A=1"]],
    ["{ echo; }", null],
  ])("%p", (text, expected) => {
    assert.deepEqual(projection.strictLiteralCommandTexts(text), expected);
  });
});

describe("flattened command texts refuse subshell operands", () => {
  test.each<[string, string[] | null]>([
    ["echo (x)", null],
    ["echo $(echo (x))", null],
    ["echo > $(echo (x))", null],
    ["A=1; echo b", ["A=1", "echo b"]],
  ])("%p", (text, expected) => {
    assert.deepEqual(projection.flattenCommandTexts(text), expected);
  });
});

test.each<[string, boolean]>([
  ["", false],
  ["x".repeat(10001), true],
  ["echo ${a:-(} ${b:-(}", true],
  ["echo ${a}", false],
])("parenthesized expansion %p", (text, expected) => {
  assert.equal(projection.hasParenthesizedExpansion(text), expected);
});

describe("unparsed bodies", () => {
  test.each<[string, boolean]>([
    ["echo plain", false],
    ["echo )", true],
    ["cat <<EOF\n`x`\nEOF", true],
    ["cat <<'EOF'\n`x`\nEOF", false],
    ['cat <<"EOF"\n`x`\nEOF', false],
    ["cat <<$X\nhi\n$X", true],
    ["echo ${a[$(x)]}", true],
    ["echo ${a[1]}", false],
    ["echo ${a[$x]}", false],
    ["[[ $x =~ ^a$(b) ]]", true],
    ["[[ $x =~ ^a ]]", false],
    ["[[ $x == @(a|$(b)) ]]", false],
  ])("%p", (text, expected) => {
    assert.equal(projection.hasUnparsedBodies(tree(text)), expected);
  });

  test("hand-built nodes the grammar only reaches through other productions", () => {
    assert.equal(
      projection.hasUnparsedBodies(
        node("heredoc_redirect", "<<EOF", [node("heredoc_start", "EOF")]),
      ),
      true,
    );
    assert.equal(projection.hasUnparsedBodies(node("word", "a$(b)")), true);
    assert.equal(projection.hasUnparsedBodies(node("word", "a\\$b")), false);
    assert.equal(
      projection.hasUnparsedBodies(node("extglob_pattern", "@(a|$(b))")),
      true,
    );
    assert.equal(
      projection.hasUnparsedBodies(
        node("heredoc_redirect", "<<\n`x`\n", [node("heredoc_body", "`x`\n")]),
      ),
      true,
    );
    assert.equal(projection.hasUnparsedBodies(inlineBodies(17)), true);
  });
});

describe("nested command collection", () => {
  test("an overrun with siblings still pending stops the whole walk", () => {
    assert.equal(projection.collectNestedTexts(inlineBodies(18)), null);
  });

  test("escaped backticks are reread as nested commands", () => {
    assert.deepEqual(
      projection.nestedCommandTexts("echo `echo \\`printf x\\``"),
      ["echo `echo \\`printf x\\``", "echo `printf x`", "printf x"],
    );
  });

  test("an overrun inside a reread body keeps the commands found so far", () => {
    const text = `echo \`echo \\"a\\" ${"${ b; }".repeat(17)}\``;
    const result = projection.nestedCommandTexts(text);
    assert.equal(result[0], text);
  });
});

describe("backtick alternatives", () => {
  test("lines with no unsupported escapes or with escaped expansions have none", () => {
    for (const text of ["echo `x`", "echo `echo \\`a\\$b\\``"])
      assert.deepEqual(projection.alternateLines(text, tree(text)), [], text);
  });

  test("an unquoted body reads its escaped quotes one way", () => {
    const text = 'echo `echo \\"x\\"`';
    const lines = projection.alternateLines(text, tree(text));
    assert.deepEqual(
      lines.map((item) => item.line),
      ["echo `echo %x%`"],
    );
    assert.ok(lines.every((item) => item.lineRoot !== null));
  });

  test("a body inside double quotes reads its escaped quotes both ways", () => {
    const text = 'echo "`echo \\"x\\"`"';
    assert.deepEqual(
      projection.alternateLines(text, tree(text)).map((item) => item.line),
      ['echo "`echo "x"`"', 'echo "`echo %x%`"'],
    );
  });

  test("errored alternatives are those where every reading fails to parse", () => {
    assert.equal(
      projection.hasErroredAlternatives(tree('echo `echo \\"x\\" ${ a; }`')),
      true,
    );
    assert.equal(
      projection.hasErroredAlternatives(tree('echo `echo \\"x\\"`')),
      false,
    );
    assert.equal(
      projection.hasErroredAlternatives(tree('echo `echo \\"x\\" (`'), {
        parsesLeft: 0,
      }),
      false,
    );
  });

  test("queued bodies unescape backticks, dollars and line continuations", () => {
    const queue = { first: [], second: [] };
    projection.enqueueBodyAlternatives(node("word", "echo"), queue);
    assert.deepEqual(queue, { first: [], second: [] });
    projection.enqueueBodyAlternatives(
      node("backtick_escape_unsupported", 'echo \\"a\\$b\\\nc\\`'),
      queue,
    );
    projection.enqueueBodyAlternatives(
      node("backtick_escape_unsupported", "echo \\`x\\`"),
      queue,
    );
    assert.deepEqual(queue, {
      first: ['echo \\"a$bc`', "echo `x`"],
      second: ['echo "a$bc`'],
    });
  });

  test("an inline body without its closing brace runs to the end", () => {
    assert.equal(
      projection.extractInlineShellBody(node("ERROR", "${ echo owned")),
      "echo owned",
    );
  });
});

describe("complex reads", () => {
  test.each<[string, boolean]>([
    ["echo a; echo b", true],
    ["(echo)", true],
    ["{ echo; } > out.txt", true],
    ["echo `x`", true],
    ['echo "$1"', true],
    ['echo "a`x`"', true],
    ["echo a*", true],
    ["echo a?", true],
    ["echo [a]", true],
    ["cat =(ls)", true],
    ["echo {a,b}", true],
    ["echo {a..c}", true],
    ["echo 'open", true],
    ['echo "open', true],
    ['echo "a$', true],
    ["echo a$", true],
    ["cat <<EOF\nx\nEOF", true],
    ["cat <<'E\\OF'\nx\nE\\OF", true],
    ["cat <<'EOF'\nx\nEOF", false],
    ['cat <<"EOF"\nx\nEOF', false],
    ['echo "\\$x"', false],
    ['echo "a\\\\"', false],
    ['echo "a\\n"', false],
    ['echo "$"', false],
    ["echo a\\*", false],
    ["echo a,b", false],
    ["echo a}", false],
    ["echo {a}", false],
    ["echo {a.b}", false],
    ["echo 'a b'", false],
    ["cat <<< x", false],
  ])("%p", (text, expected) => {
    assert.equal(projection.requiresComplexRead(text), expected);
  });
});

describe("redirect review", () => {
  const always = () => true;
  test.each<[string, boolean]>([
    ["", false],
    ["x".repeat(10001), true],
    ["echo a\\ b > out.txt", true],
    ["echo ) > out.txt", true],
    ['{ echo; } > "$x"', true],
    ['> "$x"', true],
    ['echo $(cat > "$x")', false],
    ['cat <<< "$x"', true],
    ['echo (cat > "$x")', true],
    ["echo > *.txt", true],
    ["echo > =x", true],
    ["echo > a$", true],
    ["cat <<EOF\nx\nEOF", true],
    ["cat <<'EOF'\nx\nEOF", false],
    ["echo >&-", false],
    ["echo 2>&-x", true],
    ['echo >&"-x"', true],
    ["echo > out.txt", false],
    ["echo > $'x'", true],
    ['[[ $(x) ]] > "$y"', true],
    ['( cat > "$x" ) > out.txt', true],
  ])("%p", (text, expected) => {
    assert.equal(projection.redirectsNeedReview(text, always), expected);
  });

  test("redirects of a command the caller trusts are not reviewed", () => {
    assert.equal(
      projection.redirectsNeedReview('cat <<< "$x"', () => false),
      false,
    );
  });
});

describe("redirection targets", () => {
  const plain = (
    redirections: { target: string; operator: ">" | ">>" }[],
    commandWithoutRedirections: string,
  ) => ({
    commandWithoutRedirections,
    redirections,
    hasDangerousRedirection: false,
    dangerousRedirectionReason: undefined,
  });
  test.each<[string, ReturnType<typeof plain>]>([
    ["cat <&3", plain([], "cat")],
    ["echo 2>&-", plain([], "echo")],
    ["cat <", plain([], "cat")],
    ["echo >", plain([], "echo")],
    ["echo >& 2", plain([], "echo")],
    ["echo > 5", plain([{ target: "5", operator: ">" }], "echo")],
    ["echo >& out.txt", plain([{ target: "out.txt", operator: ">" }], "echo")],
    ["echo > 'a b'", plain([{ target: "a b", operator: ">" }], "echo")],
    ['echo > "a\\$b"', plain([{ target: "a$b", operator: ">" }], "echo")],
    ['echo > "a\\\nb"', plain([{ target: "ab", operator: ">" }], "echo")],
    ["echo &> f", plain([{ target: "f", operator: ">" }], "echo")],
    ["echo >| f", plain([{ target: "f", operator: ">" }], "echo")],
    ["echo &>> f", plain([{ target: "f", operator: ">>" }], "echo")],
    ["echo a # c", plain([], "echo a")],
    ["# c", plain([], "# c")],
  ])("%p", (text, expected) => {
    assert.deepEqual(projection.redirections(text), expected);
  });

  const ambiguous = [
    'cat <&"-x"',
    "cat <&3 4",
    "echo 2>&-x",
    "cat < a b",
    "echo > a b",
    'echo >&"-x"',
    "echo > $x$y",
    "echo > ~/f",
    "echo > !f",
    "echo >& 'a b'",
  ];
  test.each(ambiguous)("%p is a shell expansion", (text) => {
    const result = projection.redirections(text);
    assert.equal(result.hasDangerousRedirection, true);
    assert.equal(result.dangerousRedirectionReason, "shell_expansion");
  });
  test.each(ambiguous)(
    "a network device before %p keeps its reason",
    (text) => {
      const result = projection.redirections(`echo > /dev/tcp/h/1; ${text}`);
      assert.equal(result.hasDangerousRedirection, true);
      assert.equal(result.dangerousRedirectionReason, "network_device");
    },
  );
});
