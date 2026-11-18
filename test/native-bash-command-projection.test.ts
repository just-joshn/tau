import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../src/native-bash-parser.js";
import { createNativeBashCommandProjection } from "../src/native-bash-command-projection.js";
const fixture = () =>
  createNativeBashCommandProjection(createNativeBashParser({ now: () => 0 }));
function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
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

test("AST splitting preserves compound statement units while separating lists and pipelines", () => {
  const f = fixture();
  assert.deepEqual(
    f.splitCommands(
      "printf one > out.txt && cat input | grep owned; echo done # comment",
    ),
    ["printf one", "cat input", "grep owned", "echo done"],
  );
  assert.deepEqual(f.splitCommands("while false; do echo no; done"), [
    "while false; do echo no; done",
  ]);
  assert.deepEqual(f.splitCommands(""), []);
  const long = `printf ${"x".repeat(10000)}`;
  assert.deepEqual(f.splitCommands(long), [long]);
});

test("static argv projection keeps native quote/backslash and assignment asymmetries", () => {
  const f = fixture();
  assert.deepEqual(f.staticArgv("NAME=value printf 'hello world' a\\ b"), [
    "printf",
    "hello world",
    "a b",
  ]);
  assert.deepEqual(f.staticArgv('printf "a\\$b"'), ["printf", "a\\$b"]);
  assert.deepEqual(f.staticArgv("export NAME=value"), ["export"]);
  assert.deepEqual(f.staticArgv("printf first $(echo hidden) after"), [
    "printf",
    "first",
  ]);
  assert.deepEqual(f.staticArgv("printf first a$(echo hidden)b after"), [
    "printf",
    "first",
  ]);
  assert.deepEqual(f.staticArgv(""), []);
});

test("flattening and strict literal projection retain their distinct redirection and substitution gates", () => {
  const f = fixture();
  assert.deepEqual(f.flattenCommandTexts("! printf first; echo second"), [
    "printf first",
    "echo second",
  ]);
  assert.deepEqual(f.strictLiteralCommandTexts("printf value 2>&1"), [
    "printf value",
  ]);
  assert.equal(f.strictLiteralCommandTexts("printf value > output.txt"), null);
  assert.equal(f.strictLiteralCommandTexts("echo $(printf nested)"), null);
  assert.equal(f.flattenCommandTexts("while true; do echo value; done"), null);
});

test("nested command collection includes complete outer commands and substitutions", () => {
  const f = fixture();
  assert.deepEqual(f.nestedCommandTexts("echo $(printf nested)"), [
    "echo $(printf nested)",
    "printf nested",
  ]);
  const tree = node(
    "program",
    "",
    Array.from({ length: 17 }, () => node("ERROR", "${ echo nested; }")),
  );
  assert.equal(f.collectNestedTexts(tree), null);
  assert.deepEqual(f.nestedTextsFromTree(tree), []);
  const large = present(f.parser.parse(`echo ${"x".repeat(65537)}`));
  assert.equal(f.collectNestedTexts(large), null);
});

test("backtick alternative work is bounded and retained parser instances share their cache", () => {
  const f = fixture();
  const queue = {
    first: Array.from({ length: 150 }, (_, index) => `echo ${index}`),
    second: [],
  };
  const result = [...f.readBodyAlternatives(queue)];
  assert.equal(result.length, 128);
  assert.equal(queue.first.length, 22);
  assert.ok(result.every((item) => item.bodyRoot !== null));
  const before = present(f.parser.parse("echo cache"));
  f.splitCommands("echo cache");
  assert.equal(f.parser.parse("echo cache"), before);
});

test("inline shell-body extraction and expansion checks preserve explicit unknown shapes", () => {
  const f = fixture();
  assert.equal(
    f.extractInlineShellBody(node("ERROR", "${ | echo owned; }")),
    "echo owned",
  );
  assert.equal(
    f.extractInlineShellBody(node("word", "${ echo owned; }")),
    null,
  );
  assert.equal(f.extractInlineShellBody(node("expansion", "${value}")), null);
  assert.equal(
    f.hasParenthesizedExpansion("echo ${value:-$(echo nested)}"),
    true,
  );
});

test("tail-after-and detection uses the final AST path rather than text matching", () => {
  const f = fixture();
  assert.equal(f.tailAfterAnd("echo first && echo second"), true);
  assert.equal(f.tailAfterAnd("echo first || echo second"), false);
  assert.equal(f.tailAfterAnd("echo 'literal && text'"), false);
  assert.equal(f.tailAfterAnd("x".repeat(10001)), true);
});

test("complex-read predicate rejects expansions and outer unsupported spellings without granting plain commands", () => {
  const f = fixture();
  assert.equal(f.requiresComplexRead("printf 'literal'"), false);
  assert.equal(f.requiresComplexRead("echo literal > output.txt"), false);
  for (const value of [
    "",
    "echo $value",
    "echo $(printf nested)",
    "echo $'value'",
    "echo \u0007",
    "echo \uD800",
    "echo ~[path]",
    "echo =command",
  ])
    assert.equal(f.requiresComplexRead(value), true, value);
});

test("redirection extraction retains operators and exact literal targets including UTF8", () => {
  const f = fixture();
  assert.deepEqual(
    f.redirections("printf first > 'é.txt' && echo second >> log.txt"),
    {
      commandWithoutRedirections: "printf first && echo second",
      redirections: [
        { target: "é.txt", operator: ">" },
        { target: "log.txt", operator: ">>" },
      ],
      hasDangerousRedirection: false,
      dangerousRedirectionReason: undefined,
    },
  );
  assert.deepEqual(f.redirections("printf value 2>&1").redirections, []);
  assert.deepEqual(f.redirections("cat < input.txt").redirections, []);
});

test("redirection classifications preserve network and dynamic-path reasons", () => {
  const f = fixture();
  for (const value of ["printf x > /dev/tcp/host/80", "cat < /dev/udp/host/53"])
    assert.equal(
      f.redirections(value).dangerousRedirectionReason,
      "network_device",
    );
  for (const value of [
    'printf x > "$target"',
    "printf x > *.txt",
    "printf x > ~/file",
    "printf x > '!file'",
  ])
    assert.equal(
      f.redirections(value).dangerousRedirectionReason,
      "shell_expansion",
      value,
    );
  assert.equal(
    f.redirections("printf x > .env").hasDangerousRedirection,
    false,
  );
});

test("redirect review retains the caller's per-command predicate and nested AST checks", () => {
  const f = fixture();
  const calls: string[] = [];
  assert.equal(
    f.redirectsNeedReview('echo value > "$target"', (command) => {
      calls.push(command);
      return true;
    }),
    true,
  );
  assert.equal(
    f.redirectsNeedReview('echo value > "$target"', () => false),
    false,
  );
  assert.ok(calls.some((value) => value.startsWith("echo value")));
  assert.equal(
    f.redirectsNeedReview("echo value 2>&1", () => true),
    false,
  );
});

test("outer caps preserve their native fallback shapes and explicit parser deadline", () => {
  const f = fixture();
  const input = "x".repeat(10001);
  assert.deepEqual(f.staticArgv(input), []);
  assert.deepEqual(f.nestedCommandTexts(input), []);
  assert.equal(f.flattenCommandTexts(input), null);
  assert.deepEqual(f.redirections(input), {
    commandWithoutRedirections: input,
    redirections: [],
    hasDangerousRedirection: false,
    dangerousRedirectionReason: undefined,
  });
  let reads = 0;
  const timed = createNativeBashCommandProjection(
    createNativeBashParser({ now: () => reads++ * 100 }),
  );
  const compound = "printf x;".repeat(100);
  assert.equal(
    timed.redirections(compound, 50).commandWithoutRedirections,
    compound,
  );
  assert.equal(reads, 2);
});
