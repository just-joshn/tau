import { expect, test } from "bun:test";
import { posix } from "node:path";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import { createNativeBashSecurityPolicyControl } from "../../../src/native-bash-security/policy-control.js";
import { fixture, known, policy } from "./security-fixture.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityRule as Rule,
} from "../../../src/native-bash-security/security-types.js";

interface Options {
  platform?: "macos" | "windows";
  deny?: string;
  writeDeny?: string;
  outsideBlocked?: boolean;
  sandbox?: boolean;
  unsandboxedAllowed?: boolean;
  unsandboxedDisabled?: boolean;
  confined?: boolean;
  evalConfined?: boolean;
  exempt?: boolean;
  windowsBash?: boolean;
  fences?: boolean;
  served?: boolean;
  feature?: boolean;
  readOnly?: boolean;
  missing?: readonly string[];
  builtins?: readonly string[];
  spawnKeys?: ReadonlySet<string>;
}

function owner(options: Options = {}) {
  const f = fixture({
    ...(options.deny === undefined ? {} : { deny: options.deny }),
    ...(options.writeDeny === undefined
      ? {}
      : { writeDeny: options.writeDeny }),
    ...(options.outsideBlocked === undefined
      ? {}
      : { outsideBlocked: options.outsideBlocked }),
  });
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const rules = {
    allow: new Map<string, Rule>(),
    ask: new Map<string, Rule>(),
    deny: new Map<string, Rule>(),
  };
  const missing = new Set(options.missing ?? []);
  f.host.filesystem.exists = (path, s) => known(!missing.has(path), s);
  f.host.servedMachine = (_p, s) => known(options.served === true, s);
  f.host.sandbox = (_p, s) =>
    known(
      {
        enabled: options.sandbox === true,
        onButNotRunning: false,
        storedDenyListsMayBeShort: false,
        allowOnly: [],
        denyWithinAllow: [],
        autoAllowSupported: true,
        autoAllowBashIfSandboxed: true,
        unsandboxedCommandsAllowed: options.unsandboxedAllowed === true,
        unsandboxedCommandsDisabled: options.unsandboxedDisabled === true,
      },
      s,
    );
  const controller = createNativeBashSecurityPolicyControl(
    f.semantic,
    preparation,
    {
      ...f.host,
      platform: options.platform ?? "macos",
      pathPrimitive: (_kind, path, s) => known(path, s),
      protectedRoots: (s) => known([], s),
      workingDirectories: (_p, s) => known(["/work"], s),
      suggestionDirectory: (path, s) => known(posix.dirname(path), s),
      readDirectorySuggestion: (path, destination, s) =>
        known(
          {
            type: "addRules",
            rules: [{ toolName: "Read", ruleContent: path + "/**" }],
            behavior: "allow",
            destination,
          },
          s,
        ),
      feature: (_key, _default, s) =>
        known({ value: true, source: "virtual-test" }, s),
      mountedDriveRmPromptDisabled: (s) => known(false, s),
      orderedRules: (_p, behavior, s) => known(rules[behavior], s),
      allDenyRules: (_p, s) => known([...rules.deny.values()], s),
      commandDenyBuiltinRuleNames: (s) =>
        known(new Set(options.builtins ?? []), s),
      ruleSuggestions: (command, s) =>
        known(
          [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: command }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          s,
        ),
      readOnly: (_input, _context, s) => known(options.readOnly ?? true, s),
      spawnEnvironmentOwner: (s) =>
        known(
          {
            spawnEnvKeys: (_keys, scope) =>
              known(options.spawnKeys ?? new Set<string>(), scope),
          },
          s,
        ),
      isConfined: (s) => known(options.confined === true, s),
      executingConfined: (s) => known(options.confined === true, s),
      windowsBashAvailable: (s) => known(options.windowsBash !== false, s),
      evalConfined: (s) => known(options.evalConfined === true, s),
      sandboxCommandExempt: (_command, _shell, s) =>
        known(options.exempt === true, s),
      sandboxReadFencesUsable: (s) => known(options.fences === true, s),
      globalReadBlock: (s) => known(options.fences === true, s),
      securityFeature: (_kind, _key, _fallback, s) =>
        known(options.feature !== false, s),
      xargsSafeFlags: (s) =>
        known({ "-a": "string", "-n": "number", "-r": "none" }, s),
      currentCwd: (s) => known(s.cwd, s),
    },
  );
  function add(behavior: "allow" | "ask" | "deny", content: string) {
    const rule: Rule = {
      source: "projectSettings",
      ruleBehavior: behavior,
      ruleValue: { toolName: "Bash", ruleContent: content },
    };
    rules[behavior].set(content, rule);
    return rule;
  }
  function scoped<T>(run: () => T, permission: Policy = policy()) {
    return controller.withPolicyScope(permission, "/work", run).result;
  }
  async function commands(command: string) {
    const analyzed = await f.semantic.analyze(command);
    if (analyzed.kind !== "simple") throw new Error(analyzed.reason);
    return analyzed;
  }
  async function pio(
    command: string,
    permission: Policy = policy(),
    cwdChanging = false,
  ) {
    const analyzed = await commands(command);
    return scoped(
      () =>
        controller.native.PIo(
          { command },
          permission,
          cwdChanging,
          analyzed.commands[0],
          "/work",
          analyzed.bareAssignmentNames,
        ),
      permission,
    );
  }
  return { ...f, controller, rules, add, scoped, commands, pio };
}

// behavior plus the reason fields callers branch on.
function label(decision: Decision): string {
  const reason = decision.decisionReason;
  if (reason === undefined) return `${decision.behavior} none`;
  if (reason.type === "other")
    return `${decision.behavior} other/${reason.bashMissKind ?? "-"}`;
  if (reason.type === "safetyCheck")
    return `${decision.behavior} safetyCheck/${reason.circuitBreaker ?? "-"}`;
  return `${decision.behavior} ${reason.type}`;
}

const readBlock = policy({ blockReadsOutsideWorkingDirectories: true });

type Row = [command: string, expected: string];

function pioTable(
  name: string,
  rows: Row[],
  options: Options = {},
  permission: Policy = policy(),
  cwdChanging = false,
) {
  test.each(rows)(`${name}: %p decides %p`, async (command, expected) => {
    const decision = await owner(options).pio(command, permission, cwdChanging);
    expect(label(decision)).toBe(expected);
  });
}

pioTable(
  "read block arguments",
  [
    ["git -C /work/sub status", "allow other/-"],
    ["git -C /outside status", "ask safetyCheck/outsideReadsBlocked"],
    ["git --git-dir=/outside/.git log", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C/outside status", "ask safetyCheck/outsideReadsBlocked"],
    ["git --work-tree /outside status", "ask safetyCheck/outsideReadsBlocked"],
    ["git -f /outside/cfg status", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C ~other status", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C $HOME status", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C //server/share status", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C '/outside/*' status", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C '' status", "allow other/-"],
    ["git log", "allow other/-"],
    ["env A=1 cat f", "ask safetyCheck/outsideReadsBlocked"],
    ["env PATH=/x cat f", "ask safetyCheck/outsideReadsBlocked"],
    ["python3 - < f", "ask safetyCheck/outsideReadsBlocked"],
    ["python3.11 -c 'x'", "ask safetyCheck/outsideReadsBlocked"],
    ["node --eval=x", "ask safetyCheck/outsideReadsBlocked"],
    ["node -pe x", "ask safetyCheck/outsideReadsBlocked"],
    ["perl -ne 'print' f", "ask safetyCheck/outsideReadsBlocked"],
    ["xargs cat", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool ''", "allow other/-"],
    ["mytool $HOME/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool ~other/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool //server/x", "ask safetyCheck/outsideReadsBlocked"],
    [
      "mytool --files0-from=/outside/list",
      "ask safetyCheck/outsideReadsBlocked",
    ],
    ["mytool -l/outside/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool --", "allow other/-"],
    ["mytool NAME=/outside/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /outside/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /work/x", "allow other/-"],
    ["mytool /outside/*.txt", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /outside/dir/", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /work/../outside/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool ../*/x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /missing", "allow other/-"],
    ["mytool ~/x", "ask safetyCheck/outsideReadsBlocked"],
  ],
  { missing: ["/missing"] },
  readBlock,
);

pioTable(
  "read block arguments with a Read deny",
  [
    ["mytool /outside/x", "deny rule"],
    ["mytool /outside/*", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C /outside status", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /work/../outside/x", "deny rule"],
  ],
  { deny: "/outside/x" },
  readBlock,
);

pioTable(
  "read block arguments outside the working directories",
  [
    ["mytool /outside/x", "ask safetyCheck/outsideReadsBlocked"],
    ["git -C /outside status", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /outside/*", "ask safetyCheck/outsideReadsBlocked"],
  ],
  { outsideBlocked: true },
  readBlock,
);

pioTable(
  "read block with a cwd-changing list",
  [
    ["mytool x", "ask safetyCheck/outsideReadsBlocked"],
    ["mytool /work/x", "allow other/-"],
  ],
  {},
  readBlock,
  true,
);

pioTable(
  "read block with sandbox read fences",
  [
    ["python3 -c 'x'", "allow other/-"],
    ["env A=1 cat f", "allow other/-"],
  ],
  { sandbox: true, fences: true },
  readBlock,
);

// Glob-expanding commands outside the read-only list stay out of read-only
// admission; command/builtin/noglob/timeout wrappers are looked through.
pioTable("glob read-only admission", [
  ["ls *.txt", "allow other/-"],
  ["mytool *.txt", "passthrough other/no-rule-match"],
  ["command -p mytool *.txt", "passthrough other/no-rule-match"],
  ["command -- ls *.txt", "allow other/-"],
  ["command -v", "allow other/-"],
  ["builtin -- mytool *", "passthrough other/no-rule-match"],
  ["builtin", "allow other/-"],
  ["noglob mytool *", "passthrough other/no-rule-match"],
  ["noglob", "allow other/-"],
  ["timeout 5 mytool *", "passthrough other/no-rule-match"],
  ["timeout 5s ls *", "allow other/-"],
  ["timeout 5 cd *", "passthrough other/no-rule-match"],
  ["timeout x mytool *", "passthrough other/no-rule-match"],
  ["xargs grep x *", "passthrough other/no-rule-match"],
  ["xargs -n 1 grep x *", "passthrough other/no-rule-match"],
  ["xargs -r -- grep x *", "passthrough other/no-rule-match"],
  ["xargs -- rm *", "passthrough other/no-rule-match"],
  ["xargs -n", "allow other/-"],
  ["xargs -0 mytool *", "passthrough other/no-rule-match"],
  ["[[ -f *.txt ]]", "allow other/-"],
  ["sha256sum *.txt", "allow other/-"],
]);

pioTable(
  "glob read-only admission with the feature off",
  [
    ["mytool *.txt", "allow other/-"],
    ["timeout 5 mytool *", "allow other/-"],
  ],
  { feature: false },
);

pioTable(
  "path-list hashing on Windows",
  [
    ["sha256sum *.txt", "ask none"],
    ["ls *.txt", "ask none"],
  ],
  { platform: "windows" },
);

pioTable(
  "xargs grep with Read deny rules",
  [
    ["xargs grep x", "passthrough other/no-rule-match"],
    ["cat f | xargs grep x", "passthrough other/no-rule-match"],
  ],
  {},
  policy({ alwaysDenyRules: { projectSettings: ["Read(/work/secret)"] } }),
);

pioTable(
  "acceptEdits writes",
  [
    ["mkdir a", "allow mode"],
    ["touch a b", "allow mode"],
    ["touch 'a b'", "allow mode"],
    ["touch -- -x", "passthrough other/no-rule-match"],
    ["sed -i s/a/b/ f", "allow mode"],
    ["rm f", "allow mode"],
    ["npm test", "passthrough other/no-rule-match"],
  ],
  { readOnly: false },
  policy({ mode: "acceptEdits" }),
);

pioTable(
  "auto mode writes",
  [
    ["mkdir a", "ask none"],
    ["npm test", "passthrough other/no-rule-match"],
  ],
  { readOnly: false },
  policy({ mode: "auto" }),
);

pioTable(
  "bypass and dontAsk defer to the main flow",
  [["mkdir a", "ask none"]],
  { readOnly: false },
  policy({ mode: "bypassPermissions" }),
);

pioTable(
  "dontAsk defers to the main flow",
  [["mkdir a", "ask none"]],
  { readOnly: false },
  policy({ mode: "dontAsk" }),
);

pioTable(
  "sed under the read block",
  [
    ["sed -n p f", "allow other/-"],
    ["sed -i s/a/b/ f", "ask safetyCheck/outsideReadsBlocked"],
    ["sed s/a/b/w /outside/x f", "ask none"],
    ["sed -e 'e ls' f", "ask safetyCheck/outsideReadsBlocked"],
  ],
  {},
  readBlock,
);

pioTable("sed without the read block", [
  ["sed -n p f", "allow other/-"],
  ["sed -e 'e ls' f", "ask none"],
  ["sed s/a/b/w out f", "ask none"],
]);

pioTable(
  "unsafe environment prefixes under the read block",
  [
    ["LD_PRELOAD=/x.so cat f", "ask safetyCheck/outsideReadsBlocked"],
    ["LANG=C cat f", "allow other/-"],
  ],
  {},
  readBlock,
);

pioTable(
  "spawn environment keys",
  [["x=1 cat f", "passthrough other/no-rule-match"]],
  { spawnKeys: new Set(["x"]) },
);

// Leading redirections, here-strings and simple wrappers do not change which
// program runs, so a sed behind them is still recognized as sed.
const sedRecognition: [text: string, isSed: boolean][] = [
  ["", false],
  ["   ", false],
  ["sed -n p f", true],
  ["ls", false],
  ["2>/dev/null sed -n p f", true],
  ["FOO=1 sed -n p f", true],
  ["<<<'x' sed -n p; ls", true],
  ["<<< x sed -n p; ls", true],
  ['<<<"a b" sed -n p; ls', true],
  ["<<<a\\ b sed -n p; ls", true],
  ["<<< sed; ls", false],
  ["<<<'open sed; ls", false],
  ['<<<"open sed; ls', false],
  ['<<<"a\\', false],
  ["<<<", false],
  ["2>/dev/null sed -n p; ls", true],
  [">&2 sed -n p; ls", true],
  ["<>f sed -n p; ls", true],
  [">|f sed -n p; ls", true],
  ["&>f sed -n p; ls", true],
  ["> 'a b' sed -n p; ls", true],
  [">'open sed; ls", false],
  ["> ", false],
  ["<(x) sed; ls", false],
  ["ls; sed -n p", false],
  ["if true; then sed -n p; fi", false],
  // The first program of a pipeline is sed.
  ["sed -n p f | cat", true],
  ["echo $(sed -n p f)", false],
  [`sed -n p ${"a".repeat(12_000)}`, true],
  [`ls ${"a".repeat(12_000)}`, false],
];

test.each(sedRecognition)("sed recognition: %p is sed %p", (text, isSed) => {
  const f = owner();
  expect(f.scoped(() => f.controller.native.Xrt(text))).toBe(isSed);
});

// A Windows cd target is accepted only when it cannot climb out of, or
// re-enter, the directory tree it starts from, and names no stream or
// trailing-dot alias.
const windowsTargets: [target: string, cwd: string, safe: boolean][] = [
  ["C:\\work\\a", "C:\\work", true],
  ["C:/a/../b", "C:/work", true],
  ["C:/..", "C:/work", false],
  ["\\work", "C:\\work", false],
  ["a\\b", "C:\\work", false],
  ["a/b", "//server/share", false],
  ["a/b", "C:/work", true],
  ["./a", "C:/work", true],
  ["..", "C:/work", true],
  ["../..", "C:/work", false],
  ["../x", "C:/work", false],
  ["a/../b", "C:/work", false],
  ["a:stream", "C:/work", false],
  ["a.", "C:/work", false],
  ["a ", "C:/work", false],
  ["..", "C:/work/../x", true],
];

test.each(windowsTargets)(
  "Windows cd target %p from %p is safe %p",
  (target, cwd, safe) => {
    const f = owner({ platform: "windows" });
    expect(f.scoped(() => f.controller.native.vbn(target, cwd))).toBe(safe);
  },
);

// Wlt pins the directory a leading plain `cd` moves to, or refuses to.
const cdTargets: [command: string, target: string | null][] = [
  ["cd /work/sub", "/work/sub"],
  ["cd ./sub", "/work/sub"],
  ["cd .", null],
  ["cd sub", null],
  ["cd ../x", null],
  ["cd /work/../x", null],
  ["cd /outside", null],
  ["cd -", null],
  ["cd -P", null],
  ["cd /work/s*", null],
  ["FOO=1 cd /work", null],
  ["cd /work > f", null],
  ["cd a b", null],
  ["ls /work", null],
];

test.each(cdTargets)("cd target of %p is %p", async (command, target) => {
  const f = owner({ outsideBlocked: true });
  const [parsed] = (await f.commands(command)).commands;
  const value = f.scoped(() =>
    f.controller.native.Wlt(parsed, "/work", policy()),
  );
  expect(value).toBe(target);
});

// Refused before any filesystem fact is read.
const windowsCdTargets: [command: string, target: string | null][] = [
  ["cd a:b", null],
  ["cd ../x", null],
  ["cd C:/..", null],
  ["cd a.", null],
];

test.each(windowsCdTargets)(
  "Windows cd target of %p is %p",
  async (command, target) => {
    const f = owner({ platform: "windows" });
    const [parsed] = (await f.commands(command)).commands;
    const value = f.scoped(() =>
      f.controller.native.Wlt(parsed, "C:/work", policy()),
    );
    expect(value).toBe(target);
  },
);

type SandboxRow = [
  name: string,
  options: Options,
  input: {
    command?: string;
    shellType?: "bash" | "powershell";
    dangerouslyDisableSandbox?: boolean;
  },
  dispatch: {
    disableUnsandboxedCommands?: boolean;
    userTypedShellDispatch?: boolean;
  },
  sandboxed: boolean,
];

const sandboxRows: SandboxRow[] = [
  ["confined execution", { confined: true }, { command: "ls" }, {}, true],
  ["sandbox off", {}, { command: "ls" }, {}, false],
  ["sandbox on", { sandbox: true }, { command: "ls" }, {}, true],
  [
    "Windows without a bash",
    { sandbox: true, platform: "windows", windowsBash: false },
    { command: "ls" },
    {},
    false,
  ],
  [
    "Windows PowerShell without a bash",
    { sandbox: true, platform: "windows", windowsBash: false },
    { command: "ls", shellType: "powershell" },
    {},
    true,
  ],
  [
    "Windows with a bash",
    { sandbox: true, platform: "windows" },
    { command: "ls" },
    {},
    true,
  ],
  [
    "override where unsandboxed commands are allowed",
    { sandbox: true, unsandboxedAllowed: true },
    { command: "ls", dangerouslyDisableSandbox: true },
    {},
    false,
  ],
  [
    "override typed by the user",
    { sandbox: true },
    { command: "ls", dangerouslyDisableSandbox: true },
    { userTypedShellDispatch: true },
    false,
  ],
  [
    "override without permission to leave",
    { sandbox: true },
    { command: "ls", dangerouslyDisableSandbox: true },
    {},
    true,
  ],
  [
    "override where unsandboxed commands are disabled",
    { sandbox: true, unsandboxedAllowed: true, unsandboxedDisabled: true },
    { command: "ls", dangerouslyDisableSandbox: true },
    {},
    true,
  ],
  [
    "override when the dispatch disables unsandboxed commands",
    { sandbox: true, unsandboxedAllowed: true },
    { command: "ls", dangerouslyDisableSandbox: true },
    { disableUnsandboxedCommands: true },
    true,
  ],
  [
    "override in an eval-confined environment",
    { sandbox: true, unsandboxedAllowed: true, evalConfined: true },
    { command: "ls", dangerouslyDisableSandbox: true },
    {},
    true,
  ],
  ["no command", { sandbox: true }, {}, {}, false],
  [
    "no command where unsandboxed commands are disabled",
    { sandbox: true, unsandboxedDisabled: true },
    {},
    {},
    true,
  ],
  [
    "exempt command",
    { sandbox: true, exempt: true },
    { command: "ls" },
    {},
    false,
  ],
  [
    "exempt command where unsandboxed commands are disabled",
    { sandbox: true, exempt: true, unsandboxedDisabled: true },
    { command: "ls" },
    {},
    true,
  ],
];

test.each(sandboxRows)(
  "sandboxed: %s",
  (_name, options, input, dispatch, sandboxed) => {
    const f = owner(options);
    expect(f.scoped(() => f.controller.native.Vh(input, dispatch))).toBe(
      sandboxed,
    );
  },
);

test("the sandbox override only counts when it would actually leave the sandbox", () => {
  const f = owner({ sandbox: true, unsandboxedAllowed: true });
  const bash = { name: "Bash" };
  const effective = (input: {
    command?: unknown;
    dangerouslyDisableSandbox?: unknown;
  }) => f.scoped(() => f.controller.native.D5e(bash, input));
  expect(effective({ command: "ls", dangerouslyDisableSandbox: true })).toBe(
    true,
  );
  expect(effective({ command: "ls", dangerouslyDisableSandbox: "yes" })).toBe(
    false,
  );
  expect(effective({ command: "ls" })).toBe(false);
  // A non-string command is probed as no command at all.
  expect(effective({ command: 42, dangerouslyDisableSandbox: true })).toBe(
    false,
  );
  const off = owner();
  expect(
    off.scoped(() =>
      off.controller.native.D5e(bash, {
        command: "ls",
        dangerouslyDisableSandbox: true,
      }),
    ),
  ).toBe(false);
});

type RuleSet = Partial<Record<"allow" | "ask" | "deny", string[]>>;
type RuleRow = [command: string, rules: RuleSet, expected: string];

function ruled(rules: RuleSet, options: Options = {}) {
  const f = owner(options);
  const behaviors: ("allow" | "ask" | "deny")[] = ["allow", "ask", "deny"];
  for (const behavior of behaviors)
    for (const content of rules[behavior] ?? []) f.add(behavior, content);
  return f;
}

// The sandbox auto-allow rule floor: deny and ask rules still bind, on the
// whole command and on each part of a list.
const sandboxFloor: RuleRow[] = [
  ["ls", {}, "allow other/-"],
  ["ls", { ask: ["ls"] }, "ask rule"],
  ["ls", { deny: ["ls"] }, "deny rule"],
  ["ls; rm x", { deny: ["rm:*"] }, "deny rule"],
  ["ls; rm x", { ask: ["rm:*"] }, "ask rule"],
  ["ls; rm x", { allow: ["rm:*"] }, "allow other/-"],
  ["ls  ", { ask: ["ls"] }, "ask rule"],
];

test.each(sandboxFloor)(
  "sandbox rule floor: %p with %o decides %p",
  async (command, rules, expected) => {
    const f = ruled(rules);
    const { commands } = await f.commands(command);
    expect(
      label(
        f.scoped(() =>
          f.controller.native.kbn({ command }, policy(), commands),
        ),
      ),
    ).toBe(expected);
  },
);

// Rule checks for commands the semantic pass refused: deny on the whole or any
// part wins, an exact allow of the very command or an ask is returned, and
// anything else leaves the refusal standing.
const refusedRules: RuleRow[] = [
  ["eval ls", {}, "null"],
  ["eval ls", { deny: ["eval:*"] }, "deny rule"],
  ["eval ls", { deny: ["eval ls"] }, "deny rule"],
  ["ls; eval ls", { deny: ["eval:*"] }, "deny rule"],
  ["eval ls", { ask: ["eval:*"] }, "ask rule"],
  ["eval ls", { ask: ["eval ls"] }, "ask rule"],
  ["eval ls", { allow: ["eval ls"] }, "allow rule"],
  ["eval ls", { allow: ["eval:*"] }, "null"],
];

test.each(refusedRules)(
  "refused-command rules: %p with %o decides %p",
  async (command, rules, expected) => {
    const f = ruled(rules);
    const { commands } = await f.commands(command);
    const decision = f.scoped(() =>
      f.controller.native.jOr({ command }, policy(), commands),
    );
    expect(decision === null ? "null" : label(decision)).toBe(expected);
  },
);

test.each([
  ["mytool x", {}, "passthrough other/no-rule-match"],
  ["ls", { deny: ["ls"] }, "deny rule"],
  ["ls", { ask: ["ls"] }, "ask rule"],
  ["ls", { allow: ["ls"] }, "allow rule"],
  ["mytool x", { allow: ["mytool:*"] }, "allow rule"],
] satisfies RuleRow[])(
  "per-subcommand check: %p with %o decides %p",
  async (command, rules, expected) => {
    const f = ruled(rules, { readOnly: false });
    const { commands } = await f.commands(command);
    const decision = await f.scoped(() =>
      f.controller.native.qwn(
        { command },
        policy(),
        null,
        false,
        commands[0],
        "/work",
      ),
    );
    expect(label(decision)).toBe(expected);
  },
);

test("prompt messages name the reason a person is asked", () => {
  const f = owner();
  const message = (
    reason: Parameters<typeof f.controller.native.El>[1],
    tool = "Bash",
  ) => f.scoped(() => f.controller.native.El(tool, reason));
  expect(
    message({ type: "classifier", classifier: "net", reason: "egress" }),
  ).toBe("Classifier 'net' requires approval for this Bash command: egress");
  expect(message({ type: "sandboxOverride", reason: "escape" })).toBe(
    "Run outside of the sandbox",
  );
  expect(message({ type: "workingDir", reason: "outside /work" })).toBe(
    "outside /work",
  );
  expect(message({ type: "mode", mode: "plan" })).toBe(
    "Current permission mode (Plan) requires approval for this Bash command",
  );
  expect(message({ type: "mode", mode: "custom" })).toBe(
    "Current permission mode (Manual) requires approval for this Bash command",
  );
  expect(message({ type: "asyncAgent", reason: "background agent" })).toBe(
    "background agent",
  );
  expect(message(undefined, "Edit")).toBe(
    "Claude requested permissions to use Edit, but you haven't granted it yet.",
  );
  const ask: Decision = { behavior: "ask" };
  const allow: Decision = { behavior: "allow" };
  // Bash parts are listed without their redirections; other tools verbatim.
  expect(
    message({
      type: "subcommandResults",
      reasons: new Map<string, Decision>([
        ["npm test > out.log", ask],
        ["ls", allow],
      ]),
    }),
  ).toBe(
    "This Bash command contains multiple operations. The following part requires approval: npm test",
  );
  expect(
    message(
      {
        type: "subcommandResults",
        reasons: new Map<string, Decision>([
          ["a > b", ask],
          ["c", ask],
        ]),
      },
      "PowerShell",
    ),
  ).toBe(
    "This PowerShell command contains multiple operations. The following parts require approval: a > b, c",
  );
  expect(
    message({
      type: "subcommandResults",
      reasons: new Map<string, Decision>([["ls", allow]]),
    }),
  ).toBe(
    "This Bash command contains multiple operations that require approval",
  );
});

pioTable(
  "acceptEdits touch arguments",
  [
    // $HOME/x lands outside the working directory.
    ["touch $HOME/x", "ask none"],
    // A wrapped touch is not admitted by the mode.
    ["command touch a", "passthrough other/no-rule-match"],
  ],
  { readOnly: false },
  policy({ mode: "acceptEdits" }),
);
