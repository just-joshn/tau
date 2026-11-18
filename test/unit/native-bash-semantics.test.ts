import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createNativeBashParser,
  type NativeBashSyntaxNode,
} from "../../src/native-bash-parser.js";
import {
  createNativeBashCommandPreparation,
  createNativeBashPreparationFeatures,
  verifyNativeBashCertifiedRule,
} from "../../src/native-bash-command-preparation.js";
import {
  createNativeBashSemantics,
  type NativeBashSemanticSimple,
  type NativeBashSemanticResult,
  type NativeBashSemanticCommand,
} from "../../src/native-bash-semantics.js";
import { createNativeBashSemanticFeatures } from "../../src/native-bash-semantic-features.js";
function fixture(options: { scrub?: boolean; cpuNow?: () => number } = {}) {
  const parser = createNativeBashParser({ now: () => 0 });
  const features = createNativeBashPreparationFeatures();
  const host = createNativeBashSemanticFeatures({
    environment: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: options.scrub ?? false },
    home: () => "/home/fixture",
    cpuNow: options.cpuNow ?? (() => 0),
  });
  return {
    f: createNativeBashSemantics(parser, features, host.host),
    parser,
    features,
    host,
  };
}
function simple(result: NativeBashSemanticResult): NativeBashSemanticSimple {
  assert.equal(result.kind, "simple");
  return result;
}
function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}
function argv(result: NativeBashSemanticResult): string[][] {
  return simple(result).commands.map((command) => command.argv);
}
function synthetic(
  argv: string[],
  other: Partial<NativeBashSemanticCommand> = {},
): NativeBashSemanticCommand {
  return {
    argv,
    envVars: [],
    redirects: [],
    text: argv.join(" "),
    hasUnquotedGlob: false,
    ...other,
  };
}
function node(
  type: string,
  text: string,
  start = 0,
  children: NativeBashSyntaxNode[] = [],
): NativeBashSyntaxNode {
  return {
    type,
    text,
    startIndex: start,
    endIndex: start + Buffer.byteLength(text),
    children,
  };
}

test("literal semantic receipt retains actual parser identity and the complete source metadata", async () => {
  const { f, parser } = fixture();
  const result = simple(await f.analyze("git status"));
  assert.equal(f.parser, parser);
  assert.equal(result.tree, parser.parse("git status"));
  assert.deepEqual(result.commands, [
    {
      argv: ["git", "status"],
      envVars: [],
      redirects: [],
      text: "git status",
      hasUnquotedGlob: false,
      argvSourceLiteral: true,
      carveOutMayDesyncQuoteScan: false,
      argvUnquotedGlob: [false, false],
      andChainOperand: true,
    },
  ]);
  assert.deepEqual(result.bareAssignmentNames, []);
  assert.equal(result.hasLoop, false);
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git status",
      first(result.commands),
      [],
    ),
    true,
  );
  const prep = createNativeBashCommandPreparation(
    parser,
    { verifyCertifiedRule: verifyNativeBashCertifiedRule },
    f.features,
  );
  assert.deepEqual(
    prep.matchRules(
      { command: "git status" },
      new Map([["certified: git status", 1]]),
      "prefix",
      { ruleBehavior: "allow", astCommand: first(result.commands) },
    ),
    { status: "resolved", matches: [1] },
  );
});

test("semantic environment prefixes and literal redirects preserve explicit fd absence and provenance", async () => {
  const { f } = fixture();
  const result = simple(await f.analyze("CI=true git status > out"));
  const c = first(result.commands);
  assert.deepEqual(c.envVars, [{ name: "CI", value: "true" }]);
  assert.deepEqual(c.redirects, [
    { op: ">", target: "out", fd: undefined, targetSourceLiteral: true },
  ]);
  assert.equal(Object.hasOwn(first(c.redirects), "fd"), true);
  assert.equal(c.text, "CI=true git status");
  assert.equal(
    verifyNativeBashCertifiedRule("certified: git status", c, []),
    false,
  );
  const safeRedirect = first(
    simple(await f.analyze("git status 2> /dev/null")).commands,
  );
  assert.equal(
    verifyNativeBashCertifiedRule("certified: git status", safeRedirect, []),
    true,
  );
});

test("tracked assignments, declarations, and append metadata retain native invalidation rules", async () => {
  const { f } = fixture();
  const result = simple(await f.analyze('x=src; cat "$x"'));
  assert.deepEqual(result.bareAssignmentNames, ["x"]);
  assert.equal(result.usesAssignedValue, true);
  assert.deepEqual(first(result.commands).argv, ["cat", "src"]);
  assert.equal(first(result.commands).text, "cat src");
  assert.equal(first(result.commands).argvSourceLiteral, false);
  const declared = simple(await f.analyze('export X=src; cat "$X"'));
  assert.deepEqual(
    declared.commands.map((c) => c.argv),
    [
      ["export", "X=src"],
      ["cat", "src"],
    ],
  );
  assert.equal(
    Object.hasOwn(first(declared.commands), "argvSourceLiteral"),
    false,
  );
  const appended = simple(await f.analyze("export X+=value"));
  assert.equal(first(appended.commands).operandAppends, true);
  const unknown = await f.analyze("X=1 echo $X");
  assert.equal(unknown.kind, "too-complex");
});

test("compound traversal includes all source-supported branch and pipeline commands", async () => {
  const { f } = fixture();
  assert.deepEqual(argv(await f.analyze("echo a | grep a && echo b")), [
    ["echo", "a"],
    ["grep", "a"],
    ["echo", "b"],
  ]);
  assert.deepEqual(
    argv(await f.analyze("if true; then echo a; else echo b; fi")),
    [["true"], ["echo", "a"], ["echo", "b"]],
  );
  const loop = simple(await f.analyze("for x in a b; do echo ok; done"));
  assert.deepEqual(loop.bareAssignmentNames, ["x"]);
  assert.equal(loop.hasLoop, true);
  assert.deepEqual(
    loop.commands.map((c) => c.argv),
    [["echo", "ok"]],
  );
  const whileLoop = simple(await f.analyze("while false; do echo x; done"));
  assert.equal(whileLoop.hasLoop, true);
  assert.deepEqual(
    whileLoop.commands.map((c) => c.argv),
    [["false"], ["echo", "x"]],
  );
  assert.equal(
    (await f.analyze("case x in x) echo a;; esac")).kind,
    "too-complex",
  );
  assert.equal((await f.analyze("f(){ echo hi; }; f")).kind, "too-complex");
});

test("nested quoted substitution retains inner commands and runtime output markers without fabricating literals", async () => {
  const { f } = fixture();
  const result = simple(await f.analyze('printf "%s" "prefix$(pwd)suffix"'));
  assert.deepEqual(
    result.commands.map((c) => c.argv),
    [["pwd"], ["printf", "%s", "prefix__CMDSUB_OUTPUT__suffix"]],
  );
  assert.equal(first(result.commands).argvSourceLiteral, true);
  assert.equal(result.commands.at(-1)?.argvSourceLiteral, false);
  assert.equal((await f.analyze("echo $(pwd)")).kind, "too-complex");
  assert.equal((await f.analyze("echo `pwd`")).kind, "too-complex");
  assert.equal(f.commandSafety(result.commands).ok, false);
});

test("home and original UTF8 cwd-word offsets are emitted only by the semantic producer", async () => {
  const { f } = fixture();
  assert.deepEqual(argv(await f.analyze('echo "$HOME"')), [
    ["echo", "/home/fixture"],
  ]);
  const text = 'echo é; cat "$PWD/é"';
  const result = simple(await f.analyze(text));
  const command = result.commands.at(-1);
  assert.ok(command);
  assert.deepEqual(command.argv, ["cat", "__TRACKED_VAR__/é"]);
  const start = Buffer.byteLength(text.slice(0, text.indexOf('"$PWD')));
  const end = Buffer.byteLength(text);
  assert.deepEqual(command.atShellCwd, {
    start: Buffer.byteLength("echo é; "),
    end,
    words: [{ start, end }],
  });
  assert.equal(result.tree?.endIndex, end);
  assert.deepEqual(argv(await f.analyze("echo 😀")), [["echo", "😀"]]);
});

test("heredoc and here-string branches retain their distinct provenance and expansion refusals", async () => {
  const { f } = fixture();
  for (const text of ["cat <<'EOF'\nhello\nEOF", "cat <<< 'hello'"]) {
    const c = first(simple(await f.analyze(text)).commands);
    assert.deepEqual(c.argv, ["cat"]);
    assert.deepEqual(c.redirects, []);
    assert.equal(c.argvSourceLiteral, false);
  }
  const unquoted = await f.analyze("cat <<EOF\n$HOME\nEOF");
  assert.equal(unquoted.kind, "too-complex");
  if (unquoted.kind === "too-complex")
    assert.match(unquoted.reason, /unquoted delimiter/);
  const expanded = simple(
    f.native.SG(
      "cat <<EOF\n$HOME\nEOF",
      f.parser.parse("cat <<EOF\n$HOME\nEOF") ?? f.parseAbort,
      { plainUnquotedHeredocs: true },
    ),
  );
  assert.deepEqual(first(expanded.commands).argv, ["cat"]);
});

test("literal output, input, and numeric fd redirects preserve operator shapes and dynamic targets refuse", async () => {
  const { f } = fixture();
  const result = simple(await f.analyze('cat < input >> "é.txt" 2>&1'));
  assert.deepEqual(first(result.commands).redirects, [
    { op: "<", target: "input", fd: undefined, targetSourceLiteral: true },
    { op: ">>", target: "é.txt", fd: undefined, targetSourceLiteral: true },
    { op: ">&", target: "1", fd: 2, targetSourceLiteral: true },
  ]);
  for (const text of [
    'cat > "$UNKNOWN"',
    "cat > $(pwd)",
    'cat > "bad\npath"',
    "cat > =ls",
    "cat > !bad",
  ])
    assert.equal((await f.analyze(text)).kind, "too-complex", text);
});

const differentialFixtures: readonly (readonly [string, string])[] = [
  ["echo \ud800", "Contains lone surrogate"],
  ["echo \udc00", "Contains lone surrogate"],
  ["echo \u0000", "Contains control characters"],
  ["echo \u007f", "Contains control characters"],
  ["echo a\u00a0b", "Contains Unicode whitespace"],
  ["echo a\u200bb", "Contains Unicode whitespace"],
  ["echo a\\ b", "Contains backslash-escaped whitespace"],
  ["echo ~[foo]", "Contains zsh ~[ dynamic directory syntax"],
  ["echo =ls", "Contains zsh =cmd equals expansion"],
  ["echo <1-2>", "Contains zsh <N-M> numeric-range glob"],
];
for (const [text, reason] of differentialFixtures)
  test(`semantic differential gate: ${reason} ${JSON.stringify(text)}`, async () => {
    const { f } = fixture();
    const r = await f.analyze(text);
    assert.equal(r.kind, "too-complex");
    if (r.kind === "too-complex") {
      assert.equal(r.reason, reason);
      assert.equal(r.differential, true);
    }
  });

test("bare assignment names that change lookup and arithmetic semantics cannot become inert tracking", async () => {
  const { f } = fixture();
  for (const text of [
    "PATH=/tmp; echo hi",
    "BASH_ENV=file; echo hi",
    "IFS=x; echo hi",
    "RANDOM=bad; echo hi",
    "PS4+=x; echo hi",
    "for PATH in x; do echo hi; done",
  ]) {
    const r = await f.analyze(text);
    assert.equal(r.kind, "too-complex", text);
  }
  const r = await f.analyze("x=a; while false; do unset x; done");
  assert.equal(r.kind, "too-complex");
  if (r.kind === "too-complex") assert.match(r.reason, /condition may modify/);
});

test("scrub latch is a real host feature affecting loop and command-name expansion acceptance", async () => {
  const off = fixture({ scrub: false });
  const on = fixture({ scrub: true });
  assert.equal(
    (await off.f.analyze("for x in a; do echo ok; done")).kind,
    "simple",
  );
  assert.equal(
    (await on.f.analyze("for x in a; do echo ok; done")).kind,
    "too-complex",
  );
  assert.equal((await off.f.analyze('x=echo; "$x" hello')).kind, "simple");
  assert.equal((await on.f.analyze('x=echo; "$x" hello')).kind, "too-complex");
});

test("outer semantic length cap differs from direct parser and emits source parse-abort telemetry", async () => {
  const { f, host, parser } = fixture();
  const text = `echo ${"x".repeat(10000)}`;
  assert.ok(parser.parse(text));
  const r = await f.analyze(text);
  assert.equal(r.kind, "too-complex");
  if (r.kind === "too-complex") assert.equal(r.nodeType, "PARSE_ABORT");
  assert.deepEqual(host.pendingEvents(), [
    {
      eventName: "tengu_tree_sitter_parse_abort",
      metadata: { cmdLength: text.length, panic: false },
      async: false,
    },
  ]);
  assert.deepEqual(await f.analyze(""), {
    kind: "simple",
    commands: [],
    bareAssignmentNames: [],
  });
});

test("byte coverage and zero-width/error nodes refuse incomplete or skipped input", async () => {
  const { f } = fixture();
  for (const text of ["echo >", "echo ``"]) {
    const r = await f.analyze(text);
    assert.equal(r.kind, "too-complex", text);
  }
  const fake = node("program", "echo hidden", 0, [
    node("command", "echo", 0, [
      node("command_name", "echo", 0, [node("word", "echo")]),
    ]),
  ]);
  const r = f.analyzeTree(fake.text, fake);
  assert.equal(r.kind, "too-complex");
  if (r.kind === "too-complex")
    assert.equal(r.reason, "Parser did not consume trailing input");
});

test("shared prep reading modes govern semantic refusal recording and never separate owners", async () => {
  const { f, features } = fixture();
  assert.equal(f.features, features);
  const r = await features.observeReading(() =>
    f.analyze("x=a; read -p x; echo ok"),
  );
  assert.equal(r[0].kind, "too-complex");
  assert.match(r[1] ?? "", /zsh.*read/);
  const ignored = await features.asBashReads(() =>
    features.observeReading(() => f.analyze("x=a; read -p x; echo ok")),
  );
  assert.equal(ignored[0].kind, "simple");
  assert.equal(ignored[1], undefined);
});

test("native declaration-prefix combinations are exhaustive through three and bounded thereafter", () => {
  const { f } = fixture();
  assert.deepEqual(f.native.F5r(2).readings, [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]);
  assert.equal(f.native.F5r(3).exhaustive, true);
  const four = f.native.F5r(4, [true, true, false, false]);
  assert.equal(four.exhaustive, false);
  assert.equal(four.readings.length, 7);
  assert.deepEqual(four.readings.at(-1), [true, true, false, false]);
  const nine = f.native.F5r(9);
  assert.equal(nine.readings.length, 2);
});

test("CPU deadline, cumulative budget and source > boundary preserve the native budget error contract", async () => {
  let now = 0;
  const { f } = fixture({ cpuNow: () => now });
  assert.doesNotThrow(() => f.checkBudget(10001));
  await f.withBudget(async () => {
    const firstResult = await f.observeBudget(() => {
      now = 5000;
      f.checkBudget();
      return 1;
    });
    assert.deepEqual(firstResult, { result: 1, outOfTime: false });
    const exhausted = await f.observeBudget(() => {
      now = 5001;
      f.checkBudget();
      return 2;
    });
    assert.deepEqual(exhausted, { outOfTime: true });
  });
  const fresh = await f.observeBudget(() => {
    f.resetSplicedBudget();
    return 3;
  });
  assert.deepEqual(fresh, { result: 3, outOfTime: false });
  const oversize = await f.observeBudget(() => {
    f.checkBudget(10001);
    return 4;
  });
  assert.deepEqual(oversize, { outOfTime: true });
  await assert.rejects(
    f.observeBudget(() => {
      throw new Error("other host error");
    }),
    /other host error/,
  );
});

test("expanded value budgets retain bounded divergent data and share nested cut-short markers", async () => {
  const { f } = fixture();
  const text = `x=${"a".repeat(5000)}; echo ${Array.from({ length: 20 }, () => '"$x"').join(" ")}`;
  const refused = await f.analyze(text);
  assert.equal(refused.kind, "too-complex");
  const observed = await f.observeCutShort(async () => {
    const nested = await f.observeCutShort(() =>
      f.analyze(text, { readsDivergentShapes: true }),
    );
    assert.equal(nested.cutShort, true);
    return nested.result;
  });
  const r = simple(observed.result);
  assert.equal(observed.cutShort, true);
  assert.equal(f.isCutShort(), false);
  assert.deepEqual(
    first(r.commands).argv.map((value) => value.length),
    [
      4,
      ...Array.from({ length: 13 }, () => 5000),
      ...Array.from({ length: 7 }, () => 256),
    ],
  );
  assert.deepEqual(
    await f.observeBudget(() =>
      f.analyze(text, { readsDivergentShapes: true }),
    ),
    { outOfTime: true },
  );
});

const unsafeSafety: [string[], RegExp][] = [
  [["time", "$bad", "echo"], /can't be checked/],
  [["timeout", "--bad", "1", "echo"], /timeout/],
  [["timeout", "not-a-duration", "echo"], /duration/],
  [["nice", "$X", "echo"], /nice argument/],
  [["env", "--bad", "echo"], /env/],
  [["stdbuf", "--bad", "echo"], /stdbuf/],
  [["command", "-x", "echo"], /command/],
  [[""], /Empty command name/],
  [["__TRACKED_VAR__"], /runtime-determined/],
  [["-fragment"], /incomplete fragment/],
  [["test", "-v", "x[1]"], /array subscript/],
  [["test", "-t", "name"], /non-numeric/],
  [["[[", "name", "-eq", "1"], /non-numeric/],
  [["read", "-a", "x[1]"], /array subscript/],
  [["read", "-t", "name"], /non-numeric/],
  [["read", "-p", "x[1]"], /subscripted/],
  [["unset", "x[1]"], /positional NAME/],
  [["declare", "-n", "x"], /changes assignment eval semantics/],
  [["readonly", "-i", "x=1"], /bin_typeset/],
  [["export", "-m", "X"], /pattern-assigns/],
  [["typeset", "-T", "X"], /tied pair/],
  [["float", "X"], /arithmetically evaluates/],
  [["printf", "%d", "x[$(cmd)]"], /array subscript/],
  [["set", "-o", "globsubst"], /shell parsing/],
  [["set", "-a"], /shell option state/],
  [["print", "-P", "%N"], /print -P/],
  [["jobs", "-x"], /jobs -x/],
  [["if"], /Shell keyword/],
  [["xargs", "find", "."], /What xargs adds/],
  [["xargs", "jq", "."], /What xargs adds/],
  [["xargs", "awk"], /program xargs gives/],
  [["jq", 'system("cmd")'], /system/],
  [["jq", 'include "x"; .'], /include\/import/],
  [["jq", "-f", "file"], /dangerous flags/],
  [["awk", '{ system("cmd") }'], /system/],
  [["gawk", '@include "file"'], /@load\/@include/],
  [["awk", "__TRACKED_VAR__"], /can't be checked/],
  [["awk", "-f", "file"], /option/],
  [["find", ".", "-exec", "echo", "{}", ";"], /executes commands/],
  [["find", "-df", "path"], /read differently/],
  [["find", ".", "__TRACKED_VAR__"], /runtime-determined/],
  [["find", ".", "*.txt"], /glob characters/],
  [["zmodload", "module"], /Zsh builtin/],
  [["stat", "-A", "X"], /stat/],
  [["eval", "echo"], /evaluates arguments/],
  [["watch", "echo"], /What 'watch' starts/],
  [["cat", "/proc/self/environ"], /expose secrets/],
];
for (const [args, reason] of unsafeSafety)
  test(`complete v6e safety family: ${args.join(" ")}`, () => {
    const { f } = fixture();
    const result = f.commandSafety([synthetic(args)]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, reason);
  });

test("v6e retains safe wrappers, command lookup, finite exceptions, read numeric operands and scope limits", () => {
  const { f } = fixture();
  for (const args of [
    [
      "time",
      "nohup",
      "timeout",
      "-s",
      "TERM",
      "1s",
      "nice",
      "-n",
      "2",
      "env",
      "CI=true",
      "stdbuf",
      "-oL",
      "command",
      "-p",
      "builtin",
      "noglob",
      "echo",
      "ok",
    ],
    ["command", "-v", "eval"],
    ["test", "-t", "2"],
    ["[[", "2", "-eq", "1"],
    ["read", "-t", "0.5", "NAME"],
    ["set", "-o", "pipefail"],
    ["set", "--", "-a"],
    ["fc", "-l"],
    ["compgen", "-A", "file"],
    ["find", ".", "-name", "plain"],
    ["awk", "{print 1}"],
    ["jq", "."],
    ["bash", "-c", "echo hello"],
  ])
    assert.deepEqual(
      f.commandSafety([synthetic(args)]),
      { ok: true },
      args.join(" "),
    );
  const newline = f.commandSafety([synthetic(["echo", "text\n# hidden"])]);
  assert.equal(newline.ok, false);
  if (!newline.ok) assert.equal(newline.kind, "newline-hash");
  const redirect = f.commandSafety([
    synthetic(["echo"], {
      redirects: [{ op: ">", target: "/proc/self/environ" }],
    }),
  ]);
  assert.equal(redirect.ok, false);
  const record = synthetic(["awk", "literal*"], {
    hasUnquotedGlob: false,
    argvUnquotedGlob: [false, true],
  });
  assert.equal(f.commandSafety([record]).ok, false);
  assert.equal(f.commandSafety([record], { sourceGlobRecord: false }).ok, true);
});

test("native permissive quote and environment-prefix receipts remain separate from downstream permission fences", async () => {
  const { f } = fixture();
  const prefixed = first(simple(await f.analyze("PATH=/tmp echo hi")).commands);
  assert.deepEqual(prefixed.envVars, [{ name: "PATH", value: "/tmp" }]);
  const unfinished = first(simple(await f.analyze("echo 'open")).commands);
  assert.deepEqual(unfinished.argv, ["echo", "ope"]);
  assert.equal(
    f.commandSafety([synthetic(["bash", "-c", "echo hi"])]).ok,
    true,
  );
});

test("parser misreading contexts preserve the separate observation receipt required by native callers", async () => {
  const { f, parser } = fixture();
  const direct = await f.analyze("[ x ] tail");
  assert.equal(direct.kind, "too-complex");
  if (direct.kind === "too-complex")
    assert.equal(direct.reason, parser.misreadingReasons.words_after_test);
  const observed = await parser.features.observeMisreading(() =>
    f.analyze("[ x ] tail"),
  );
  assert.equal(observed.misreading, "words_after_test");
  assert.equal(observed.result.kind, "simple");
});

test("semantic pass state restores after a throwing host and later analyses retain their genuine provenance", async () => {
  const parser = createNativeBashParser({ now: () => 0 });
  const features = createNativeBashPreparationFeatures();
  const host = createNativeBashSemanticFeatures({
    environment: {},
    cpuNow: () => 0,
    home: () => "/home/fixture",
  });
  let fails = true;
  const f = createNativeBashSemantics(parser, features, {
    ...host.host,
    subprocessEnvironmentScrubEnabled() {
      if (fails) throw new Error("host state unavailable");
      return false;
    },
  });
  await assert.rejects(f.analyze('x=cat; "$x" file'), /host state unavailable/);
  fails = false;
  const result = simple(await f.analyze("git status"));
  assert.equal(first(result.commands).argvSourceLiteral, true);
  assert.deepEqual(result.bareAssignmentNames, []);
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git status",
      first(result.commands),
      [],
    ),
    true,
  );
});

test("later-loop reanalysis preserves the depth guard and its source feature instead of issuing a certificate", async () => {
  const { f, features } = fixture();
  const input = "while false; do ".repeat(6) + "echo ok; " + "done; ".repeat(6);
  const guarded = simple(await f.analyze(input));
  assert.equal(guarded.hasLoop, true);
  assert.equal(guarded.laterLoopPassesDiffer, true);
  features.registerCommandReader(() => ({
    value: false,
    source: "payload",
    defaultHost: true,
  }));
  const unguarded = simple(await f.analyze(input));
  assert.equal(unguarded.hasLoop, true);
  assert.equal(unguarded.laterLoopPassesDiffer, undefined);
});
