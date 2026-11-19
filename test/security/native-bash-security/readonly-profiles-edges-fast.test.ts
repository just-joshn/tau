import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import type {
  NativePermissionScope as Scope,
  NativePermissionFact as Fact,
} from "../../../src/native-permission-outcome.js";
import { NativePermissionDependencyError } from "../../../src/native-permission-outcome.js";
import { createNativeBashReadonlyProfiles } from "../../../src/native-bash-security/readonly-profiles.js";
import { policy } from "./security-fixture.js";

function known<T>(value: T, scope: Scope): Fact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-readonly-profile",
      sourceContracts: ["fMr/_Mr/Aat"],
      scope,
    },
  };
}

function fixture() {
  const f = createSecurityProcessFixture();
  const profiles = createNativeBashReadonlyProfiles(f.process, {
    safeFeature: (_key, _safe, scope) => known(true, scope),
  });
  const run = <T>(fn: () => T) =>
    profiles.withPolicyScope(policy(), "/work", fn).result;
  return { profiles, run };
}

// Each row is [argv, the fast verdict]: true or false decides, null defers.
function expectFast(rows: readonly (readonly [string[], boolean | null])[]) {
  const { profiles, run } = fixture();
  for (const [argv, verdict] of rows)
    expect({ argv, verdict: run(() => profiles.native.fMr(argv)) }).toEqual({
      argv,
      verdict,
    });
}

test("fast readonly verdicts for exact builtins, plain readers and docker listings", () => {
  expectFast([
    [[], false],
    [["whoami"], true],
    [["whoami", "x"], false],
    [["alias"], true],
    [["node", "-v"], true],
    [["ip", "addr"], true],
    [["node", "-v", "script.js"], null],
    [["cat", "file"], true],
    [["docker", "ps", "-a"], true],
    [["docker", "images", "-q"], true],
    // -c selects a docker context, which can point at another daemon.
    [["docker", "ps", "-ac"], false],
    [["docker", "ps", "--context=remote"], false],
    [["docker", "images", "~/x"], false],
    [["docker", "ps", "__CMDSUB_OUTPUT__"], false],
    [["docker"], null],
    [["unknown-command"], null],
  ]);
});

test("printf numeric conversions take only literal numbers", () => {
  expectFast([
    [["printf"], true],
    [["printf", "--", "%d", "1"], true],
    [["printf", "%*d", "5", "1"], true],
    [["printf", "%d", "0x1F"], true],
    [["printf", "%d", "2#101"], true],
    [["printf", "%.2f", "-1.5e3"], true],
    [["printf", "%%d", "text"], true],
    [["printf", "%b", "text"], true],
    [["printf", "%q", "text"], true],
    [["printf", "%*d", "width", "1"], false],
    [["printf", "%d", "x[0]"], false],
    [["printf", "%d", "`id`"], false],
    [["printf", "%d", "$(id)"], false],
    [["printf", "%d", "__CMDSUB_OUTPUT__"], false],
    [["printf", "%y", "text"], false],
    [["printf", "__CMDSUB_OUTPUT__"], false],
    [["printf", "$fmt"], false],
    [["printf", "\\u00e9"], false],
    [["printf", "%\\101"], false],
  ]);
});

test("[[ ]] refuses array subscripts and variable names that arithmetic evaluates", () => {
  expectFast([
    [["[[", "-v", "name", "]]"], true],
    [["[[", "-t", "1", "]]"], true],
    [["[[", "1", "-eq", "2", "]]"], true],
    [["[[", "-v", "a[0]", "]]"], false],
    [["[[", "-R", "__TRACKED_VAR__", "]]"], false],
    [["[[", "-t", "fd", "]]"], false],
    [["[[", "a", "-eq", "1", "]]"], false],
    [["[[", "1", "-eq", "a[1]", "]]"], false],
  ]);
});

test("ls, cd, find, history, arch and ifconfig keep their native read-only shapes", () => {
  expectFast([
    [["ls", "-la"], true],
    [["cd"], true],
    [["cd", "dir"], true],
    [["cd", "a", "b"], false],
    [["find", ".", "-name", "*.ts", "-print"], true],
    [["find", ".", "-newer", "__CMDSUB_OUTPUT__"], true],
    [["find", "-f", "dir", "-type", "f"], true],
    // These find actions write a file.
    [["find", ".", "-fprint", "out"], false],
    [["find", ".", "-fls", "out"], false],
    [["find", "-df", "dir"], false],
    [["find", "-f", "__CMDSUB_OUTPUT__"], false],
    [["find", ".", "__CMDSUB_OUTPUT__"], false],
    [["history"], true],
    [["history", "5"], true],
    [["history", "-c"], false],
    [["history", "5", "6"], false],
    [["arch"], true],
    [["arch", "-h"], true],
    [["arch", "--help"], true],
    // arch with an architecture runs the following command.
    [["arch", "x86_64", "sh"], false],
    [["ifconfig"], true],
    [["ifconfig", "en0"], true],
    [["ifconfig", "-a"], false],
    [["ifconfig", "en0", "down"], false],
  ]);
});

test("jq defers unless it would read files, the environment or modules", () => {
  expectFast([
    [["jq", ".", "file"], null],
    [["jq", "-f", "prog.jq"], false],
    [["jq", "--rawfile", "x", "file"], false],
    [["jq", "env"], false],
    [["jq", "$ENV.HOME"], false],
    [["jq", "__CMDSUB_OUTPUT__"], false],
  ]);
});

test("the plain-text readonly check strips 2>&1 and refuses variables and file-writing find actions", () => {
  const { profiles, run } = fixture();
  const rows: readonly (readonly [string, boolean])[] = [
    ["cat file 2>&1", true],
    ["  pwd  ", true],
    ["echo hi", true],
    ["sort file", true],
    ["ls -la", true],
    ["uniq -c", true],
    // With two operands uniq writes its output file.
    ["uniq in out", false],
    ["jq -r .a file", true],
    ["cd dir", true],
    ["find . -name '*.ts'", true],
    ["echo $HOME", false],
    ["ls `id`", false],
    ["unknown cmd", false],
    // Quote splitting does not hide a find action from the text check.
    ["find . -ex''ec rm", false],
    ['find . -fp"rint" out', false],
    // A git -c/--exec-path/--config-env spelling anywhere fails closed.
    ["head -c 10 .gitignore", false],
    ["cat --exec-path .gitconfig", false],
    ["cat --config-env=x .gitconfig", false],
  ];
  for (const [command, readonly] of rows)
    expect({
      command,
      readonly: run(() => profiles.native._Mr(command)),
    }).toEqual({ command, readonly });
});

test("the text scan distinguishes variables, globs and quoted or escaped text", () => {
  const { profiles } = fixture();
  const rows: readonly (readonly [string, "variable" | "glob" | false])[] = [
    ["echo '\\$x'", false],
    ["echo `$x`", false],
    ["echo \\$x", false],
    ["echo $1", "variable"],
    ["echo $", false],
    ['echo "*"', false],
    ["echo a#b*", "glob"],
    ["echo #*", false],
    ["echo #*\nls *", "glob"],
    ["echo a]", false],
    ["echo [a] b", "glob"],
    ["echo 'a' *", "glob"],
  ];
  for (const [text, kind] of rows)
    expect({ text, kind: profiles.native.Aat(text) }).toEqual({ text, kind });
});

test("checksum, strings, wc and du option predicates recognise abbreviated long options", () => {
  const { iwn } = fixture().profiles.constants;
  const rows: readonly (readonly [string, string, boolean])[] = [
    ["sha256sum", "-c", true],
    ["sha256sum", "-bc", true],
    ["sha1sum", "--ch", true],
    ["md5sum", "--check", true],
    ["md5sum", "--", false],
    ["md5sum", "--status", false],
    ["strings", "@args", true],
    ["strings", "-a", false],
    ["wc", "--files0-from=list", true],
    ["wc", "--files", true],
    ["du", "--fi", true],
    ["du", "-s", false],
  ];
  for (const [command, option, matches] of rows)
    expect({ command, option, matches: iwn.get(command)?.(option) }).toEqual({
      command,
      option,
      matches,
    });
});

test("a feature-gated profile read outside a policy scope fails as a missing dependency", () => {
  const { profiles } = fixture();
  let failure: unknown;
  try {
    profiles.native.rMr("sort -. file");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativePermissionDependencyError);
  expect(
    failure instanceof NativePermissionDependencyError
      ? failure.dependency
      : undefined,
  ).toBe("readonlyProfile.scope");
});

test("profiles refuse to build over a process whose path owner uses another semantic instance", () => {
  const a = createSecurityProcessFixture();
  const b = createSecurityProcessFixture();
  expect(() =>
    createNativeBashReadonlyProfiles(
      { ...a.process, semantic: b.process.semantic },
      {},
    ),
  ).toThrow("Native readonly process owners must be shared");
});
