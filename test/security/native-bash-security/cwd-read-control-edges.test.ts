import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeIgnoreBackend } from "../../../src/native-file-permission-host.js";
import { createNativeBashDescendantDeny } from "../../../src/native-bash-security/descendant-deny.js";
import {
  createNativeBashCwdReadControl,
  type NativeBashCwdReadHost,
} from "../../../src/native-bash-security/cwd-read-control.js";
import type { NativeBashSecurityRule as Rule } from "../../../src/native-bash-security/security-types.js";
import { createRecursionFixture } from "./recursion-fixture.js";
import { known, policy } from "./security-fixture.js";

// cwd/read control answers three questions about a command line that starts
// with a directory change:
// - EOr: does "cd X && read ..." need the full check (true) or can the reads
//   be judged from both directories (false)?
// - vOr: may the read-only shortcut accept the reads after the cd?
// - TOr / bOr: do the cd commands provably stay in the current directory?

function owner(platform: "macos" | "windows" = "macos") {
  const f = createRecursionFixture(
    async (input) => ({ behavior: "allow", updatedInput: input }),
    platform,
  );
  const rules: Rule[] = [];
  f.policyHost.sourceRuleRoot = (_source, s) => known("/work", s);
  f.policyHost.readOnly = (input, _context, s) =>
    known(/^(?:cat|ls)\b/.test(input.command), s);
  const descendant = createNativeBashDescendantDeny(f.syntax.policy, {
    platformProfile: platform,
    compileErrorMessage: (pattern, s) =>
      known(createNativeIgnoreBackend().validate(pattern), s),
    denyReadRules: (_permission, s) => known(rules, s),
    denialRelativeRoots: (_permission, _path, s) => known(["/work"], s),
  });
  const host: NativeBashCwdReadHost = {
    statDirectory: (_path, s) =>
      known({ status: "stat", isDirectory: true }, s),
    realpath: async (path, s) => known(await realpath(path), s),
    bigintStat: async (_path, s) => known({ dev: 1n, ino: 2n }, s),
    delightfulGoblet: (s) => known(false, s),
    cozyRaven: (s) => known(true, s),
  };
  const cwd = createNativeBashCwdReadControl(f.syntax, descendant, host);
  function run<T>(callback: () => T, at = "/work") {
    return cwd.withPolicyScope(policy(), at, callback).result;
  }
  async function analyze(text: string) {
    const result = await f.semantic.analyze(text);
    if (result.kind !== "simple") throw new Error(result.reason);
    return result.commands;
  }
  async function needsCheck(text: string, at = "/work") {
    const commands = await analyze(text);
    return run(
      () => cwd.native.EOr(commands, at, policy(), f.context("").context),
      at,
    );
  }
  async function readOnlyAfterCd(text: string) {
    const commands = await analyze(text);
    return run(() =>
      cwd.native.vOr(commands, "/work", policy(), f.context("").context),
    );
  }
  return {
    ...f,
    descendant,
    cwd,
    host,
    rules,
    run,
    analyze,
    needsCheck,
    readOnlyAfterCd,
  };
}

test("a cwd/read owner over another policy owner is refused", () => {
  const f = owner();
  const g = owner();
  expect(() =>
    createNativeBashCwdReadControl(f.syntax, g.descendant, f.host),
  ).toThrow("must be shared");
});

test("a feature read outside a cwd/read scope fails loudly", () => {
  const f = owner();
  expect(() => f.cwd.native.Q_n()).toThrow("Missing native cwd/read scope");
  expect(f.run(() => f.cwd.native.Q_n())).toBe(false);
  expect(f.run(() => f.cwd.native.RIo())).toBe(true);
});

test.each([
  ["cd ./sub && cat file", false],
  ["cd /work/sub && cat file", false],
  ["cd . && cat file", false],
  ["cd ./sub && cat ''", false],
  ["cd -- ./sub && cat file", false],
  // Anything the reads cannot be judged against needs the full check.
  ["cat file", true],
  ["popd && cat file", true],
  ["X=1 cd ./sub && cat file", true],
  ["cd ./a ./b && cat file", true],
  ["cd - && cat file", true],
  ["cd ~ && cat file", true],
  ["cd './a b*' && cat file", true],
  ['cd "$PWD/sub" && cat file', true],
  ["cd './a\tb' && cat file", true],
  ["cd /etc && cat passwd", true],
  ["cd ./sub && cat *", true],
  ["cd ./sub && X=1 cat file", true],
  ["cd ./sub && cd ./x", true],
  ["cd ./sub && cat ../file", true],
  ['cd ./sub && cat "$PWD/x"', true],
  ["cd ./sub && cat ~/file", true],
  ["cd ./sub && cat --file=../x", true],
  ["cd ./sub && cat 'a{b}'", true],
])("cd then read %p needs the full check: %p", async (command, expected) => {
  expect(await owner().needsCheck(command)).toBe(expected);
});

test("a cd onto something that is not a directory needs the full check", async () => {
  const f = owner();
  f.host.statDirectory = (_path, s) =>
    known({ status: "stat", isDirectory: false }, s);
  expect(await f.needsCheck("cd ./file && cat x")).toBe(true);
});

test("Windows cd/read is always fully checked", async () => {
  expect(await owner("windows").needsCheck("cd ./sub && cat file")).toBe(true);
});

test("a deny rule below the target or the read path needs the full check", async () => {
  const f = owner();
  f.rules.push({
    source: "projectSettings",
    ruleBehavior: "deny",
    ruleValue: { toolName: "Read", ruleContent: "//etc/secret" },
  });
  expect(await f.needsCheck("cd ./sub && cat file")).toBe(false);
  expect(await f.needsCheck("cd ./sub && cat /etc/secret")).toBe(true);
});

test.each([
  ["cd ./sub && cat file", true],
  ["cd ./sub && cat file 2>&1", true],
  ["cd ./sub && cat file > /dev/null", true],
  ["cd ./sub && cat file >> /dev/null", true],
  ["cd ./sub && cat /work/x", true],
  ["cd ./sub && ls '*.txt'", true],
  // Shapes the shortcut does not accept.
  ["cd ./sub", false],
  ["cd sub && cat file", false],
  ['cd "./sub" && cat file', false],
  ["cd ./sub && cat file > out", false],
  ["cd ./sub && X=1 cat file", false],
  ["cd ./sub && rm file", false],
  ["cd ./sub && cat file | xargs cat", false],
  ["cd ./sub && cat 'a{b}'", false],
  ["cd ./sub && ls *.txt", false],
  ["cd ./sub && cat ./x && cd ./y", false],
])(
  "the read-only shortcut after %p accepts it: %p",
  async (command, expected) => {
    expect(await owner().readOnlyAfterCd(command)).toBe(expected);
  },
);

test("the read-only shortcut is unavailable on Windows and for unresolved directories", async () => {
  expect(await owner("windows").readOnlyAfterCd("cd ./sub && cat file")).toBe(
    false,
  );
  const f = owner();
  f.policyHost.filesystem.canonical = (path, s) =>
    known({ resolvedPath: path, isCanonical: false, isSymlink: true }, s);
  expect(await f.readOnlyAfterCd("cd ./sub && cat file")).toBe(false);
});

test.each<[string, string | null]>([
  ["cd sub", "sub"],
  ["  cd sub  ", "sub"],
  ["cd -", "-"],
  ['cd "a b"', "a b"],
  ["cd 'a b'", "a b"],
  ["ls sub", null],
  ["cd ", null],
  ['cd "a', null],
  ['cd "', null],
  ["cd 'a'b'", null],
  ['cd "a\\b"', null],
  ["cd 'a\u0001b'", null],
  ["cd a b", null],
  ["cd a'b", null],
  ["cd a\\b", null],
  ["cd a;b", null],
  ["cd a|b", null],
])("the literal cd target of %p is %p", (text, expected) => {
  expect(owner().cwd.native.wbn(text)).toBe(expected);
});

test("a double-quoted Windows cd target keeps its backslashes", () => {
  expect(owner("windows").cwd.native.wbn('cd "C:\\work"')).toBe("C:\\work");
});

let root = "";
let here = "";
let other = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tau-cwd-read-")));
  here = join(root, "here");
  other = join(root, "other");
  await mkdir(here);
  await mkdir(other);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each<[string, (h: string) => string[], boolean]>([
  ["no statement", () => [], false],
  ["no cd", () => ["echo hi"], false],
  ["cd .", () => ["cd ."], true],
  ["cd ./", () => ["cd ./"], true],
  ["an absolute path to here", (h) => [`cd ${h}`], true],
  ["a quoted absolute path to here", (h) => [`cd "${h}"`], true],
  ["an absolute path through ..", (h) => [`cd ${h}/../here`], false],
  ["a path into another directory", (h) => [`cd ${h}/../other`], false],
  ["two cds", () => ["cd .", "cd ."], false],
  ["cd -", () => ["cd -"], false],
  ["a bare name", () => ["cd here"], false],
  ["a variable", () => ["cd $X"], false],
  ["a backtick", () => ["cd ./`x`"], false],
  ["a glob", () => ["cd ./h*"], false],
  ["a backslash", () => ["cd ./a\\b"], false],
  ["a relative parent", () => ["cd ../here"], false],
  ["an unparsable target", () => ["cd a b"], false],
  ["a missing directory", (h) => [`cd ${h}/missing`], false],
])("TOr with %s stays here: %p", async (_label, texts, expected) => {
  const f = owner();
  expect(await f.run(() => f.cwd.native.TOr(texts(here), here))).toBe(expected);
});

test("TOr cannot prove anything from a directory that does not exist", async () => {
  const f = owner();
  expect(
    await f.run(() => f.cwd.native.TOr(["cd ."], join(root, "gone"))),
  ).toBe(false);
});

test.each<[string, boolean]>([
  ["cd .", true],
  ["cd ./", true],
  ["X=1 cd .", false],
  ["cd . > /dev/null", false],
  ["cd", false],
  ["cd . .", false],
  ["cd ../here", false],
])("bOr with %p stays here: %p", async (text, expected) => {
  const f = owner();
  const commands = await f.analyze(text);
  expect(await f.run(() => f.cwd.native.bOr(commands, [text], here))).toBe(
    expected,
  );
});

test("bOr refuses a cd without a matching command or with two cds", async () => {
  const f = owner();
  expect(await f.run(() => f.cwd.native.bOr([], ["cd ."], here))).toBe(false);
  const two = await f.analyze("cd . && cd .");
  expect(await f.run(() => f.cwd.native.bOr(two, ["cd .", "cd ."], here))).toBe(
    false,
  );
  expect(await f.run(() => f.cwd.native.bOr([], ["echo"], here))).toBe(false);
  expect(
    await f.run(() => f.cwd.native.bOr([], ["cd ."], join(root, "gone"))),
  ).toBe(false);
});

test.each<[string, boolean]>([
  ["cd C:/work", true],
  ['cd "C:\\work"', true],
  ["cd C:/work/%X%", false],
  ["cd //server/share", false],
  ["cd C:/wo rk", false],
])("on Windows, bOr with %p stays in C:\\work: %p", async (text, expected) => {
  const f = owner("windows");
  const commands = await f.analyze(text.replace(/\\/g, "/"));
  expect(
    await f.run(() => f.cwd.native.bOr(commands, [text], "C:\\work")),
  ).toBe(expected);
});

test("a missing stdin interpreter name is not code on stdin", () => {
  expect(owner().cwd.native.fOr([])).toBe(false);
});
