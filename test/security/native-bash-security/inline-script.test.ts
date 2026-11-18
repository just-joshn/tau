import { test, expect } from "bun:test";
import { createNativeBashInlineScript } from "../../../src/native-bash-security/inline-script.js";
import { gitFixture } from "./git-fixture.js";
import { policy, known } from "./security-fixture.js";
function owner() {
  const f = gitFixture();
  const inline = createNativeBashInlineScript(
    f.semantic,
    f.git.preparation,
    f.git.pathOwner,
  );
  return {
    ...f,
    inline,
    read(argv: string[]) {
      return inline.withPolicyScope(policy(), "/work", () =>
        inline.native.FOr(argv),
      ).result;
    },
  };
}
test("native inline shell reader handles exact executable and option families", () => {
  const f = owner();
  expect(f.read(["bash", "-c", "echo x"])).toEqual({
    script: "echo x",
    judged: "echo x",
    homeWritten: false,
  });
  expect(f.read(["busybox", "sh", "-c", "echo x"])?.judged).toBe("echo x");
  expect(f.read(["bash-5.2", "-c", "echo x"])?.judged).toBe("echo x");
  expect(f.read(["bash5.2", "-c", "echo x"])).toBeUndefined();
  expect(f.read(["bash", "+c", "echo x"])).toBeUndefined();
  expect(f.read(["bash", "--unknown", "-c", "echo x"])).toEqual({
    script: "--unknown -c echo x",
    judged: undefined,
    homeWritten: false,
  });
});
test("positional values are reconstructed as data with exact zero/count and guarded forms", () => {
  const f = owner();
  expect(
    f.read(["sh", "-c", 'printf "%s" "$0:$1:$#"', "named", "value"])?.judged,
  ).toBe('printf "%s" "named:value:1"');
  expect(f.read(["sh", "-c", 'rm -rf "$1/*"', "named", "safe"])?.judged).toBe(
    'rm -rf "safe/*"',
  );
  expect(f.read(["sh", "-c", 'rm -rf "$1/*"'])?.judged).toBe('rm -rf "/*"');
  expect(f.read(["sh", "-c", 'rm -rf "${1:?}/*"'])?.judged).toBe(
    'rm -rf "${__INLINE_SHELL_GUARDED__:?}/*"',
  );
  expect(f.read(["sh", "-c", 'rm -rf "${1?}/*"', "named", ""])?.judged).toBe(
    'rm -rf "/*"',
  );
});
test("quoted all-arguments and unquoted multi-arguments retain source asymmetry", () => {
  const f = owner();
  expect(
    f.read(["sh", "-c", 'printf "%s" "$@"', "zero", "one", "two words"])
      ?.judged,
  ).toBe('printf "%s" "one" "two words"');
  expect(
    f.read(["sh", "-c", "rm -rf $@", "zero", "one", "two"])?.judged,
  ).toBeUndefined();
  expect(f.read(["sh", "-c", "rm -rf $@", "zero", "one"])?.judged).toBe(
    "rm -rf one",
  );
});
test("native script hazards and resource cap retain an explicit unjudged script", () => {
  const f = owner();
  for (const script of [
    "alias rm=something; rm x",
    "IFS=,; read line",
    "function f() { rm $1; }",
    "rm -rf /{a,b}",
    "echo '$1'",
    "x".repeat(2001),
  ]) {
    const r = f.read(["bash", "-c", script]);
    expect(r?.script).toBe(script);
    expect(r?.judged).toBeUndefined();
  }
  expect(f.read(["bash", "-c", "function f() { rm x; }"])?.judged).toBe(
    "function f() { rm x; }",
  );
  expect(f.read(["bash", "-c", "IFS=, read line"])?.judged).toBe(
    "IFS=, read line",
  );
  expect(f.read(["zsh", "-c", "rm =tool"])?.judged).toBeUndefined();
});
test("source home rewriting records Windows-written values and refuses whitespace ambiguity", () => {
  const f = owner();
  f.host.home = (s) => known("C:\\Users\\tester", s);
  const r = f.read([
    "bash",
    "-c",
    'rm -rf "$1/cache"',
    "zero",
    "C:\\Users\\tester\\project",
  ]);
  expect(r).toEqual({
    script: 'rm -rf "$1/cache"',
    judged: 'rm -rf "$HOME/project/cache"',
    homeWritten: true,
  });
  const g = owner();
  g.host.home = (s) => known("C:\\Users\\Test User", s);
  const ambiguous = g.read([
    "bash",
    "-c",
    'rm -rf "$1/cache"',
    "zero",
    "C:\\Users\\Test User\\project",
  ]);
  expect(ambiguous?.homeWritten).toBe(true);
  expect(ambiguous?.judged).toBeUndefined();
});
test("source positional modifiers and assignment mutators never create a guessed script", () => {
  const f = owner();
  for (const script of [
    'echo "${1/foo/bar}"',
    "shift; rm $1/*",
    "eval $1",
    "set -- changed; rm $1/*",
  ]) {
    expect(
      f.read(["sh", "-c", script, "zero", "safe"])?.judged,
    ).toBeUndefined();
  }
  expect(f.inline.native.P8("echo harmless")).toBe(false);
  expect(f.inline.native.P8("find . -exec rm x \\;")).toBe(true);
  expect(f.inline.native.P8("bash -c 'rm x'")).toBe(true);
});
