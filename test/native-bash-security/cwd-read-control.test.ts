import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeIgnoreBackend } from "../../src/native-file-permission-host.js";
import { createRecursionFixture } from "./recursion-fixture.js";
import { createNativeBashDescendantDeny } from "../../src/native-bash-security/descendant-deny.js";
import {
  createNativeBashCwdReadControl,
  type NativeBashCwdReadHost,
} from "../../src/native-bash-security/cwd-read-control.js";
import { known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityRule as Rule,
} from "../../src/native-bash-security/security-types.js";

function owner(platform: "macos" | "windows" = "macos") {
  const f = createRecursionFixture(
    async (input) => ({ behavior: "allow", updatedInput: input }),
    platform,
  );
  const rules: Rule[] = [];
  f.policyHost.sourceRuleRoot = (_source, s) => known("/work", s);
  f.policyHost.readOnly = (input, _context, s) =>
    known(input.command === "cat file", s);
  const descendant = createNativeBashDescendantDeny(f.syntax.policy, {
    platformProfile: platform,
    compileErrorMessage: (pattern, s) =>
      known(createNativeIgnoreBackend().validate(pattern), s),
    denyReadRules: (_permission, s) => known(rules, s),
    denialRelativeRoots: (_permission, _path, s) => known(["/work"], s),
  });
  const statCalls: string[] = [];
  const host: NativeBashCwdReadHost = {
    statDirectory: (path, s) => {
      statCalls.push(path);
      return known({ status: "stat", isDirectory: true }, s);
    },
    realpath: async (path, s) => known(await realpath(path), s),
    bigintStat: async (_path, s) => known({ dev: 1n, ino: 2n }, s),
    delightfulGoblet: (s) => known(false, s),
    cozyRaven: (s) => known(true, s),
  };
  const cwd = createNativeBashCwdReadControl(f.syntax, descendant, host);
  const run = <T>(callback: () => T) =>
    cwd.withPolicyScope(policy(), "/work", callback).result;
  async function analyze(text: string) {
    const result = await f.semantic.analyze(text);
    if (result.kind !== "simple") throw new Error(result.reason);
    return result.commands;
  }
  return { ...f, cwd, host, rules, statCalls, run, analyze };
}

test("native cd/read comparison requires both cwd views, no possible-descendant deny and an actual directory fact", async () => {
  const f = owner();
  const commands = await f.analyze("cd ./sub && cat file");
  expect(
    f.run(() =>
      f.cwd.native.EOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toBe(false);
  expect(f.statCalls).toEqual(["/work/sub"]);
  f.rules.push({
    source: "projectSettings",
    ruleBehavior: "deny",
    ruleValue: { toolName: "Read", ruleContent: "/sub/secrets/**" },
  });
  expect(
    f.run(() =>
      f.cwd.native.EOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toBe(true);
  f.rules.length = 0;
  f.host.statDirectory = (_path, s) =>
    known(
      { status: "error", error: new Error("authored missing directory") },
      s,
    );
  expect(
    f.run(() =>
      f.cwd.native.EOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toBe(true);
  delete f.host.statDirectory;
  expect(() =>
    f.run(() =>
      f.cwd.native.EOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toThrow(NativeBashSecurityUnsupported);
});

test("native plain-relative cd requires explicit CDPATH absence and rejects computed or traversing operands", async () => {
  const f = owner();
  const commands = await f.analyze("cd sub && cat file");
  const context = f.context("").context;
  context.sessionEnvVars = new Map([["CDPATH", "redacted-test"]]);
  expect(
    f.run(() => f.cwd.native.EOr(commands, "/work", policy(), context)),
  ).toBe(true);
  expect(f.statCalls).toEqual([]);
  context.sessionEnvVars = new Map();
  expect(
    f.run(() => f.cwd.native.EOr(commands, "/work", policy(), context)),
  ).toBe(false);
  const traversal = await f.analyze("cd ../parent && cat file");
  expect(
    f.run(() => f.cwd.native.EOr(traversal, "/work", policy(), context)),
  ).toBe(true);
});

test("native alternate readonly cd path requires actual literal metadata and named read-only provider", async () => {
  const f = owner();
  const commands = await f.analyze("cd ./sub && cat file");
  expect(
    f.run(() =>
      f.cwd.native.vOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toBe(true);
  f.policyHost.readOnly = (_input, _context, s) => known(false, s);
  expect(
    f.run(() =>
      f.cwd.native.vOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toBe(false);
  delete f.policyHost.readOnly;
  expect(() =>
    f.run(() =>
      f.cwd.native.vOr(commands, "/work", policy(), f.context("").context),
    ),
  ).toThrow(NativeBashSecurityUnsupported);
});

test("native same-directory trust uses actual followed realpath identity, including owned symlinks", async () => {
  const f = owner();
  const directory = await mkdtemp(join(tmpdir(), "tau-native-cwd-"));
  try {
    const first = join(directory, "first");
    const second = join(directory, "second");
    const alias = join(directory, "alias with space");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias);
    expect(await f.run(() => f.cwd.native.TOr([`cd "${alias}"`], first))).toBe(
      true,
    );
    expect(await f.run(() => f.cwd.native.TOr([`cd "${second}"`], first))).toBe(
      false,
    );
    expect(
      await f.run(() =>
        f.cwd.native.TOr([`cd "${alias}"`, `cd "${alias}"`], first),
      ),
    ).toBe(false);
    expect(
      await f.run(() => f.cwd.native.Glt(join(directory, "missing"))),
    ).toBeNull();
    delete f.host.realpath;
    let caught: unknown;
    try {
      await f.run(() => f.cwd.native.Glt(first));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativeBashSecurityUnsupported);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native Windows followed bigint identity rejects sentinel inodes and lexical ambiguous directories", async () => {
  const f = owner("windows");
  expect(await f.run(() => f.cwd.native.Glt("C:\\work"))).toBe("1:2");
  for (const inode of [0n, -1n, 0xffffffffffffffffn, 1n << 64n]) {
    f.host.bigintStat = async (_path, s) => known({ dev: 1n, ino: inode }, s);
    expect(await f.run(() => f.cwd.native.Glt("C:\\work"))).toBeNull();
  }
  delete f.host.bigintStat;
  expect(await f.run(() => f.cwd.native.Glt("C:\\trailing."))).toBeNull();
  expect(await f.run(() => f.cwd.native.Glt("C:\\illegal:stream"))).toBeNull();
});

test("native stdin-code interpreter guard retains exact executable and argument distinctions", () => {
  const f = owner();
  for (const argv of [["python3"], ["node", "--silent"], ["bash", "-"]])
    expect(f.cwd.native.fOr(argv)).toBe(true);
  for (const argv of [
    ["bash", "-c", "literal"],
    ["cat"],
    ["unknown", "-"],
    ["Rscript", "file.R"],
  ])
    expect(f.cwd.native.fOr(argv)).toBe(false);
});
