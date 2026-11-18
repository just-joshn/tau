import assert from "node:assert/strict";
import { test } from "bun:test";
import { createNativeBashParser } from "../../src/native-bash-parser.js";
import type { NativeBashFeatureReader } from "../../src/native-bash-parser-features.js";
import {
  createNativeBashCommandPreparation,
  createNativeBashPreparationFeatures,
  verifyNativeBashCertifiedRule,
  buildNativeBashCertifiedPushRule,
  type NativeBashPreparationAstCommand,
  type NativeBashPreparationHost,
  type NativeBashPreparationOptions,
} from "../../src/native-bash-command-preparation.js";
const fixture = (host: NativeBashPreparationHost = {}) =>
  createNativeBashCommandPreparation(
    createNativeBashParser({ now: () => 0 }),
    host,
  );
function semantic(
  argv: string[],
  options: Partial<NativeBashPreparationAstCommand> = {},
): NativeBashPreparationAstCommand {
  return {
    argv,
    envVars: [],
    redirects: [],
    text: argv.join(" "),
    hasUnquotedGlob: false,
    argvSourceLiteral: true,
    carveOutMayDesyncQuoteScan: false,
    ...options,
  };
}
function matches(
  command: string,
  patterns: string[],
  options: NativeBashPreparationOptions = {},
  phase: "exact" | "prefix" = "prefix",
) {
  return fixture({ escapedWhitespaceFeature: () => false }).matchRules(
    { command },
    new Map(patterns.map((pattern) => [pattern, pattern])),
    phase,
    options,
  );
}
function resolved(
  command: string,
  patterns: string[],
  options: NativeBashPreparationOptions = {},
  phase: "exact" | "prefix" = "prefix",
): string[] {
  const result = matches(command, patterns, options, phase);
  assert.equal(result.status, "resolved");
  return result.matches;
}

test("complete simple wrapper normalization retains comments, env safety and first-word quoting", () => {
  const f = fixture();
  assert.equal(
    f.stripSimpleWrappers(
      "# comment\nCI=true timeout --signal TERM -k 2s 1.5s nice -n -2 -- nohup -- 'g'it status",
    ),
    "git status",
  );
  assert.equal(
    f.stripSimpleWrappers("command -pp -- builtin -- noglob g\\it status"),
    "git status",
  );
  assert.equal(
    f.stripSimpleWrappers("LANG=en_US.UTF-8 stdbuf -oL -e0 cat file"),
    "cat file",
  );
  assert.equal(
    f.stripSimpleWrappers("EVIL=true git status"),
    "EVIL=true git status",
  );
  assert.equal(
    f.stripSimpleWrappers("CI=true git status", false),
    "CI=true git status",
  );
  assert.equal(f.stripSimpleWrappers("#only"), "#only");
  assert.equal(
    f.stripSimpleWrappers("'unterminated git status"),
    "'unterminated git status",
  );
  assert.equal(f.stripSimpleWrappers('"g\\qit" status'), "g\\qit status");
  assert.equal(f.stripSimpleWrappers("git\\"), "git\\");
  assert.equal(
    f.stripSimpleWrappers("timeout --unknown 2 git status"),
    "timeout --unknown 2 git status",
  );
});

test("timed argv and timeout flags preserve incomplete and unrecognized forms", () => {
  const f = fixture();
  assert.deepEqual(
    f.stripTimedArgv([
      "/usr/bin/time",
      "-p",
      "timeout",
      "--foreground",
      "--kill-after=1",
      "-s",
      "TERM",
      "--",
      "2m",
      "nohup",
      "--",
      "nice",
      "-n",
      "-4",
      "--",
      "echo",
      "ok",
    ]),
    ["echo", "ok"],
  );
  for (const args of [
    ["timeout", "--bad", "1", "echo"],
    ["timeout", "-s", "!", "1", "echo"],
    ["timeout", "1x", "echo"],
    ["time", "-f", "%E", "echo"],
    ["nice", "-3", "echo"],
  ])
    assert.deepEqual(f.stripTimedArgv(args), args);
  assert.equal(
    f.timeoutFlagsEnd(["timeout", "-v", "-k2", "--signal=TERM", "3", "echo"]),
    4,
  );
  assert.equal(f.timeoutFlagsEnd(["timeout", "-k"]), -1);
});

test("broad assignment stripping preserves stop predicates, arrays and shell quoting boundaries", () => {
  const f = fixture();
  assert.equal(
    f.stripAssignments("#c\nX='a b' ARR[1]+=value Y=\\ z cat file"),
    "cat file",
  );
  assert.equal(
    f.stripAssignments("X=1 STOP=2 cat file", /^STOP$/),
    "STOP=2 cat file",
  );
  const names: string[] = [];
  assert.equal(
    f.stripAssignments("X=1 Y=2 cat", (name, value) => {
      names.push(`${name}:${value}`);
      return name === "Y";
    }),
    "Y=2 cat",
  );
  assert.deepEqual(names, ["X:1", "Y:2"]);
  assert.equal(f.stripAssignments('X="$HOME" cat'), 'X="$HOME" cat');
  assert.equal(
    f.stripAssignments("#c\nX=1 cat", undefined, false),
    "#c\nX=1 cat",
  );
});

test("complete argv wrapper tables cover option arities, positional masks and split-command forms", () => {
  const f = fixture();
  const fixtures: [string[], string[]][] = [
    [
      ["env", "-u", "HOME", "X=1", "sudo", "-u", "root", "--", "echo", "ok"],
      ["echo", "ok"],
    ],
    [
      ["taskset", "-c", "0", "0xff", "echo", "ok"],
      ["echo", "ok"],
    ],
    [
      ["chrt", "-f", "12", "echo", "ok"],
      ["echo", "ok"],
    ],
    [
      ["flock", "-w", "2", "lock", "echo", "ok"],
      ["echo", "ok"],
    ],
    [
      ["script", "--command=echo ok"],
      ["echo", "ok"],
    ],
    [
      ["env", "-Secho ok"],
      ["echo", "ok"],
    ],
    [
      ["flock", "lock", "-c", "echo ok"],
      ["echo", "ok"],
    ],
    [
      ["/usr/bin/SUDO.exe", "-u", "root", "echo", "ok"],
      ["/usr/bin/SUDO.exe", "-u", "root", "echo", "ok"],
    ],
    [
      ["constructor", "echo"],
      ["constructor", "echo"],
    ],
    [
      ["command", "-pv", "echo"],
      ["command", "-pv", "echo"],
    ],
    [
      ["sudo", "-u"],
      ["sudo", "-u"],
    ],
    [
      ["script", "-c", ""],
      ["script", "-c", ""],
    ],
  ];
  for (const [args, expected] of fixtures)
    assert.deepEqual(f.stripWrapperArgv(args), expected, args.join(" "));
  assert.deepEqual(f.stripWrapperArgv(["sudo", "-Hu", "root", "A=B", "echo"]), [
    "root",
    "A=B",
    "echo",
  ]);
  assert.deepEqual(
    f.stripWrapperArgv(["sudo", "-Hu", "root", "A=B", "echo"], { wide: true }),
    ["echo"],
  );
  assert.deepEqual(f.stripWrapperArgv(["env", "bad=name", "echo"]), ["echo"]);
});

test("environment safety uses the finite whitelist, path placeholders and locale constraints", () => {
  const f = fixture();
  for (const name of ["CI", "GOOS", "ANTHROPIC_API_KEY", "GIT_TERMINAL_PROMPT"])
    assert.equal(f.environmentValueSafe(name, "simple"), true);
  for (const [name, value] of [
    ["PATH", "simple"],
    ["LANG", "bad"],
    ["LC_ALL", ""],
    ["CI", "./bin"],
    ["CI", "x:/bin"],
    ["CI", "__CMDSUB_OUTPUT__"],
  ])
    assert.equal(
      f.environmentValueSafe(name ?? "", value ?? ""),
      false,
      `${name}=${value}`,
    );
  assert.equal(f.environmentValueSafe("LANG", ""), true);
  assert.equal(f.environmentValueSafe("LANG", "'en_US.UTF-8'"), true);
  assert.equal(f.environmentValueSafe("LANG", "C"), true);
  assert.equal(
    f.environmentNeedsReview({ command: "CI=true LANG=C git status" }),
    false,
  );
  assert.equal(
    f.environmentNeedsReview({ command: "CI+=true git status" }),
    true,
  );
  assert.equal(
    f.environmentNeedsReview({ command: 'CI="$HOME" git status' }),
    true,
  );
  assert.equal(f.environmentNeedsReview({ command: "echo CI=bad" }), false);
  assert.equal(
    f.environmentNeedsReview(
      { command: "ignored" },
      semantic(["git"], {
        envVars: [{ name: "CI", value: "true", isAppend: true }],
      }),
    ),
    true,
  );
});

test("accepted environment context records refusals while allowing source-defined reinterpretation", async () => {
  const f = fixture();
  const result = await f.features.observeEnvironment(true, async () => {
    await Promise.resolve();
    return [
      f.environmentValueSafe("CI", "./bin"),
      f.environmentValueSafe("LANG", "bad"),
      f.environmentValueSafe("CI", "__CMDSUB_OUTPUT__"),
    ];
  });
  assert.deepEqual(result, { result: [true, true, true], refused: true });
  assert.equal(
    f.features.withAcceptedEnvironment(() =>
      f.environmentNeedsReview({ command: "CI+=1 git" }),
    ),
    false,
  );
  assert.equal(f.environmentValueSafe("CI", "./bin"), false);
  const rejected = await f.features.observeEnvironment(false, () =>
    f.environmentValueSafe("CI", "./bin"),
  );
  assert.deepEqual(rejected, { result: false, refused: true });
});

test("R8 exact and prefix phases retain distinct source candidates and map order", () => {
  assert.deepEqual(
    resolved(
      "timeout 2 git status > out",
      ["git status", "git:*", "git status > out", "timeout 2 git status > out"],
      { ruleBehavior: "allow" },
      "exact",
    ),
    ["git status", "git status > out", "timeout 2 git status > out"],
  );
  assert.deepEqual(
    resolved("git status > out", ["git:*", "git status", "git status > out"], {
      ruleBehavior: "allow",
    }),
    ["git:*", "git status"],
  );
  assert.deepEqual(
    resolved(
      "git\tstatus",
      ["git status:*", "git status"],
      { ruleBehavior: "allow" },
      "exact",
    ),
    ["git status:*"],
  );
  assert.deepEqual(
    resolved("git statusx", ["git status:*"], { ruleBehavior: "allow" }),
    [],
  );
  assert.deepEqual(
    resolved("xargs git status", ["git:*"], { ruleBehavior: "allow" }),
    ["git:*"],
  );
  assert.deepEqual(
    resolved("git status && echo done", ["git:*", "git*"], {
      ruleBehavior: "allow",
    }),
    [],
  );
  assert.deepEqual(
    resolved("git status && echo done", ["git:*"], {
      ruleBehavior: "deny",
      skipCompoundCheck: true,
    }),
    ["git:*"],
  );
});

test("deny/ask transformations strip broad wrappers and paths without enlarging allow candidates", () => {
  const patterns = ["git:*", "git status"];
  for (const behavior of ["deny", "ask"] as const)
    assert.deepEqual(
      resolved("X=1 sudo -u root /usr/bin/git status", patterns, {
        ruleBehavior: behavior,
        stripAllEnvVars: true,
      }),
      patterns,
    );
  assert.deepEqual(
    resolved("X=1 sudo -u root /usr/bin/git status", patterns, {
      ruleBehavior: "allow",
    }),
    [],
  );
  assert.deepEqual(
    resolved("CI=true nohup git status", patterns, { ruleBehavior: "allow" }),
    patterns,
  );
  assert.deepEqual(
    resolved("env -S 'git status'", patterns, {
      ruleBehavior: "deny",
      stripAllEnvVars: true,
    }),
    patterns,
  );
});

test("wildcard matching preserves executable guard and restrictive xargs fallback asymmetry", () => {
  const f = fixture();
  assert.equal(f.executableWildcardUnsafe("git*", "git$(evil) status"), true);
  assert.equal(f.executableWildcardUnsafe("git*", "gitstatus"), false);
  assert.equal(f.executableWildcardUnsafe("git *", "git status"), false);
  assert.deepEqual(
    resolved("xargs foobar", ["foo*bar"], { ruleBehavior: "allow" }),
    [],
  );
  assert.deepEqual(
    resolved("xargs foobar", ["foo*bar"], { ruleBehavior: "deny" }),
    ["foo*bar"],
  );
  assert.deepEqual(
    resolved("xargs foobar", ["foo*"], { ruleBehavior: "allow" }),
    ["foo*"],
  );
  assert.deepEqual(resolved("gitstatus", ["git*"], { ruleBehavior: "allow" }), [
    "git*",
  ]);
  assert.deepEqual(resolved(":*", [":*"], { ruleBehavior: "allow" }), [":*"]);
  assert.deepEqual(resolved("foo*", ["foo\\*"], { ruleBehavior: "allow" }), []);
});

test("escaped whitespace feature and semantic certificate dependencies are explicit unresolved results", () => {
  const f = fixture();
  assert.deepEqual(
    f.matchRules(
      { command: "echo a\\ b" },
      new Map([["echo:*", 1]]),
      "prefix",
      { ruleBehavior: "deny", stripAllEnvVars: true },
    ),
    {
      status: "unresolved",
      matches: [],
      dependency: "je:tengu_humble_hartmanis",
    },
  );
  assert.deepEqual(
    f.matchRules(
      { command: "git status" },
      new Map([["certified: git status", 1]]),
      "prefix",
      { ruleBehavior: "allow" },
    ),
    {
      status: "unresolved",
      matches: [],
      dependency: "semantic-command-certificate",
    },
  );
  assert.deepEqual(
    f.matchRules(
      { command: "git status" },
      new Map([["certified: git status", 1]]),
      "prefix",
      { ruleBehavior: "allow", astCommand: semantic(["git", "status"]) },
    ),
    {
      status: "unresolved",
      matches: [],
      dependency: "semantic-certified-rule-verifier",
    },
  );
  assert.deepEqual(
    f.matchRules({ command: "echo a\\ b" }, new Map(), "prefix", {
      ruleBehavior: "deny",
      stripAllEnvVars: true,
    }),
    { status: "resolved", matches: [] },
  );
  const enabled = fixture({ escapedWhitespaceFeature: () => true });
  assert.deepEqual(
    enabled.matchRules(
      { command: "echo a\\ b" },
      new Map([["echo a b", 1]]),
      "exact",
      { ruleBehavior: "deny", stripAllEnvVars: true },
    ),
    { status: "resolved", matches: [1] },
  );
});

test("certified native descriptors cover every finite family and dynamic remote grammar", () => {
  const cases: [string, string[]][] = [
    ["git status", ["git", "status", "--porcelain", "-b"]],
    ["git add", ["git", "add", "src/file.ts"]],
    ["git commit", ["git", "commit", "-m", "message", "src/file.ts"]],
    ["git checkout -b", ["git", "checkout", "-b", "feature/a"]],
    ["git log", ["git", "log", "--oneline", "-12", "main...feature/a"]],
    ["git diff", ["git", "diff", "--cached", "main..feature/a"]],
    ["git branch --show-current", ["git", "branch", "--show-current"]],
    [
      "gh pr create",
      ["gh", "pr", "create", "--title", "Title", "--body", "Body", "--draft"],
    ],
    ["gh pr edit", ["gh", "pr", "edit", "--add-reviewer", "person"]],
    ["gh pr view", ["gh", "pr", "view", "123", "--json", "title"]],
    ["git push origin", ["git", "push", "-u", "origin", "feature/a"]],
  ];
  for (const [rule, argv] of cases)
    assert.equal(
      verifyNativeBashCertifiedRule(`certified: ${rule}`, semantic(argv), []),
      true,
      rule,
    );
  assert.equal(
    buildNativeBashCertifiedPushRule("upstream-2"),
    "certified: git push upstream-2",
  );
  for (const remote of ["-bad", "../bad", "user@host:repo", ""])
    assert.equal(buildNativeBashCertifiedPushRule(remote), null);
});

test("certified verifier rejects missing literal provenance, envs, assignments, redirects and uncertain operands", () => {
  const rule = "certified: git status";
  assert.equal(
    verifyNativeBashCertifiedRule(
      rule,
      semantic(["git", "status"], { argvSourceLiteral: false }),
      [],
    ),
    false,
  );
  assert.equal(
    verifyNativeBashCertifiedRule(
      rule,
      semantic(["git", "status"], { envVars: [{ name: "CI", value: "true" }] }),
      [],
    ),
    false,
  );
  assert.equal(
    verifyNativeBashCertifiedRule(rule, semantic(["git", "status"]), ["X"]),
    false,
  );
  const redirected = semantic(["git", "status"], {
    redirects: [{ op: ">", target: "/dev/null", targetSourceLiteral: true }],
  });
  assert.equal(verifyNativeBashCertifiedRule(rule, redirected, []), true);
  for (const redirect of [
    { op: ">>", target: "/dev/null", targetSourceLiteral: true },
    { op: ">", target: "/dev/null", fd: 1, targetSourceLiteral: true },
    { op: ">", target: "out", targetSourceLiteral: true },
    { op: ">", target: "/dev/null", targetSourceLiteral: false },
  ])
    assert.equal(
      verifyNativeBashCertifiedRule(
        rule,
        semantic(["git", "status"], { redirects: [redirect] }),
        [],
      ),
      false,
    );
  for (const argv of [
    ["git", "status", "--porcelain", "--porcelain"],
    ["git", "status", "-sb"],
    ["git", "status", "--porcelain=true"],
    ["git", "status", "__TRACKED_VAR__"],
    ["/usr/bin/git", "status"],
  ])
    assert.equal(
      verifyNativeBashCertifiedRule(rule, semantic(argv), []),
      false,
      argv.join(" "),
    );
  for (const argv of [
    ["git", "commit"],
    ["git", "commit", "-m", "-unsafe"],
    ["git", "add", "../bad"],
    ["git", "push", "other", "main"],
    ["git", "push", "origin", "bad..ref"],
  ])
    assert.equal(
      verifyNativeBashCertifiedRule(
        `certified: git ${argv[1] === "push" ? "push origin" : argv[1]}`,
        semantic(argv),
        [],
      ),
      false,
      argv.join(" "),
    );
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git add",
      semantic(["git", "add", "*.ts"], { hasUnquotedGlob: true }),
      [],
    ),
    false,
  );
});

test("certified matching requires the explicit actual-metadata verifier and remains allow-prefix only", () => {
  const f = fixture({ verifyCertifiedRule: verifyNativeBashCertifiedRule });
  const command = semantic(["git", "status"]);
  const rules = new Map([["certified: git status", { id: 1 }]]);
  assert.deepEqual(
    f.matchRules({ command: "git status" }, rules, "prefix", {
      ruleBehavior: "allow",
      astCommand: command,
    }),
    { status: "resolved", matches: [{ id: 1 }] },
  );
  for (const behavior of ["deny", "ask"] as const)
    assert.deepEqual(
      f.matchRules({ command: "git status" }, rules, "prefix", {
        ruleBehavior: behavior,
        astCommand: command,
      }),
      { status: "resolved", matches: [] },
    );
  assert.deepEqual(
    f.matchRules({ command: "git status" }, rules, "exact", {
      ruleBehavior: "allow",
      astCommand: command,
    }),
    { status: "resolved", matches: [] },
  );
});

const disabled: NativeBashFeatureReader = () => ({
  value: false,
  source: "payload",
  defaultHost: true,
});
test("preparation feature defaults and all reader registration channels preserve source metadata", () => {
  const f = createNativeBashPreparationFeatures();
  assert.deepEqual(
    [
      f.environmentGuardEnabled(),
      f.removalOptionAccepted("-rm"),
      f.vastPuddleEnabled(),
      f.snappyTowerEnabled(),
      f.stagedPumpkinEnabled(),
      f.nestedRippleEnabled(),
    ],
    [true, true, true, true, true, true],
  );
  assert.equal(f.registerEnvironmentReader(disabled), null);
  assert.equal(f.registerRemovalReader(disabled), null);
  assert.equal(f.registerCommandReader(disabled), null);
  assert.equal(f.registerStagedReader(disabled), null);
  assert.equal(f.registerNestedReader(disabled), null);
  assert.deepEqual(
    [
      f.environmentGuardEnabled(),
      f.removalOptionAccepted("-rm"),
      f.vastPuddleEnabled(),
      f.snappyTowerEnabled(),
      f.stagedPumpkinEnabled(),
      f.nestedRippleEnabled(),
    ],
    [false, false, false, false, false, false],
  );
  assert.equal(f.removalOptionAccepted("--other"), true);
  assert.equal(f.registerEnvironmentReader(undefined), disabled);
  f.registerCommandReader(() => ({
    value: false,
    source: "fallback",
    defaultHost: true,
  }));
  assert.equal(f.vastPuddleEnabled(), true);
  f.registerCommandReader(() => {
    throw new Error("reader unavailable");
  });
  assert.equal(f.snappyTowerEnabled(), true);
});

test("AR-style environment reads remain lazy while eager source guards read all metadata", () => {
  const reads: string[] = [];
  const reader: NativeBashFeatureReader = () => ({
    value: true,
    get source() {
      reads.push("source");
      return "payload";
    },
    get defaultHost() {
      reads.push("host");
      return true;
    },
  });
  const f = createNativeBashPreparationFeatures({
    environmentReader: reader,
    commandReader: reader,
  });
  assert.equal(f.environmentGuardEnabled(), true);
  assert.deepEqual(reads, []);
  assert.equal(f.vastPuddleEnabled(), true);
  assert.deepEqual(reads, ["source", "host"]);
});

test("reading contexts share nested counters, preserve first reasons and isolate asynchronous branches", async () => {
  const f = createNativeBashPreparationFeatures();
  const observed = await f.observeReading(async () => {
    f.markReadingRefusal("first");
    const inner = await f.observeReading(() => {
      f.markReadingRefusal("second");
      return 2;
    });
    assert.deepEqual(inner, [2, "first"]);
    return 1;
  });
  assert.deepEqual(observed, [1, "first"]);
  assert.deepEqual(await f.observeReading(() => 3), [3, undefined]);
  assert.deepEqual(
    await f.withoutReadingRule(() =>
      f.observeReading(() => {
        f.markReadingRefusal("ignored");
        return [f.readingRuleOff(), f.readsAsBash()];
      }),
    ),
    [[true, false], undefined],
  );
  assert.deepEqual(
    await f.asBashReads(() =>
      f.observeReading(() => {
        f.markReadingRefusal("ignored");
        return [f.readingRuleOff(), f.readsAsBash()];
      }),
    ),
    [[true, true], undefined],
  );
  assert.deepEqual(
    await Promise.all([
      f.observeReading(async () => {
        await Promise.resolve();
        f.markReadingRefusal("left");
        return 1;
      }),
      f.observeReading(async () => {
        await Promise.resolve();
        f.markReadingRefusal("right");
        return 2;
      }),
    ]),
    [
      [1, "left"],
      [2, "right"],
    ],
  );
});

test("first-command wildcard contents prevent a later recognized tail from creating the match", () => {
  const f = fixture({ escapedWhitespaceFeature: () => false });
  const pattern = "git *file*";
  const rules = new Map([[pattern, 1]]);
  assert.deepEqual(
    f.matchRules({ command: "git status && echo file" }, rules, "prefix", {
      ruleBehavior: "allow",
      skipCompoundCheck: true,
    }),
    { status: "resolved", matches: [1] },
  );
  assert.deepEqual(
    f.matchRules({ command: "git status && echo file" }, rules, "prefix", {
      ruleBehavior: "allow",
      skipCompoundCheck: true,
      firstCommandRuleContents: new Set([pattern]),
    }),
    { status: "resolved", matches: [] },
  );
  assert.deepEqual(
    f.matchRules({ command: "git status && curl file" }, rules, "prefix", {
      ruleBehavior: "allow",
      skipCompoundCheck: true,
      firstCommandRuleContents: new Set([pattern]),
    }),
    { status: "resolved", matches: [1] },
  );
  assert.deepEqual(
    f.matchRules({ command: "git file && echo done" }, rules, "prefix", {
      ruleBehavior: "allow",
      skipCompoundCheck: true,
      firstCommandRuleContents: new Set([pattern]),
    }),
    { status: "resolved", matches: [1] },
  );
});

test("certified placeholder and glob checks retain source-specific quote and newline exceptions", () => {
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git commit",
      semantic(["git", "commit", "-m", "__CMDSUB_OUTPUT__"]),
      [],
    ),
    false,
  );
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git commit",
      semantic(["git", "commit", "-m", "\n__CMDSUB_OUTPUT__"]),
      [],
    ),
    true,
  );
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git commit",
      semantic(["git", "commit", "-m", "literal*"], { hasUnquotedGlob: false }),
      [],
    ),
    true,
  );
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git commit",
      semantic(["git", "commit", "-m", "literal*"], { hasUnquotedGlob: true }),
      [],
    ),
    false,
  );
  assert.equal(
    verifyNativeBashCertifiedRule(
      "certified: git commit",
      semantic(["git", "commit", "-m", "literal*"], {
        carveOutMayDesyncQuoteScan: true,
      }),
      [],
    ),
    false,
  );
});
