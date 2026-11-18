import { expect, test } from "bun:test";
import {
  createNativeBashCwdAlternates,
  type NativeBashCwdWriteProfile as Profile,
} from "../../../src/native-bash-security/cwd-alternates.js";
import { createMainFixture } from "./main-fixture.js";
import { known, policy } from "./security-fixture.js";

// cwd alternates have three jobs:
// - AIo profiles what a command writes, where copies land, and whether some
//   writes cannot be seen from its arguments.
// - nIr flags builtins whose output would reinterpret a cwd- or
//   tilde-dependent operand (printf conversions, set, read).
// - Own rewrites "$PWD/..." words into the real working directory so the
//   rewritten command can be judged too.

function owner(wittyDove = true) {
  const f = createMainFixture();
  const alternates = createNativeBashCwdAlternates(f.main, {
    wittyDove: (s) => known(wittyDove, s),
    immutableToucan: (s) => known(true, s),
  });
  function run<T>(callback: () => T) {
    return alternates.withPolicyScope(policy(), "/work", callback).result;
  }
  async function analyze(command: string) {
    const result = await f.semantic.analyze(command);
    if (result.kind !== "simple") throw new Error(result.reason);
    return result;
  }
  async function first(command: string) {
    const head = (await analyze(command)).commands[0];
    if (head === undefined) throw new Error("Missing command");
    return head;
  }
  async function profile(command: string) {
    const head = await first(command);
    return run(() => alternates.native.AIo(head));
  }
  async function alternatesOf(command: string, cwd = "/work") {
    const result = await analyze(command);
    return run(() =>
      alternates.native.Own(command, result, cwd, (text) =>
        /^(?:cat|ls|grep) /.test(text),
      ),
    );
  }
  return { ...f, alternates, run, first, profile, alternatesOf };
}

test("a feature read outside the cwd-alternates scope fails loudly", async () => {
  const f = owner(true);
  const head = await f.first("sort a.txt");
  expect(() => f.alternates.native.AIo(head)).toThrow(
    "Missing native cwd-alternate invariant",
  );
});

test.each<[string, Partial<Profile>]>([
  ["git status", { known: false, written: [] }],
  ["unknowncmd > out", { known: false, written: ["out"] }],
  ["echo hi 2>&1", { written: [] }],
  ["echo hi &> out", { written: ["out"] }],
  ["echo hi >| out", { written: ["out"] }],
  ["echo hi >> out", { written: ["out"] }],
  ["echo > /dev/null", { written: [] }],
  ["touch a", { known: true, written: ["a"], writesUnseen: false }],
  ["tee out", { written: ["out"], writesUnseen: false }],
  // Read commands that can still write somewhere.
  ["sort --output=out in", { written: [], writesUnseen: true }],
  ["sort -o out in", { writesUnseen: true }],
  ["uniq a b", { writesUnseen: true }],
  ["uniq a", { writesUnseen: false }],
  ["find . -delete", { writesUnseen: true }],
  ["find . -name x", { writesUnseen: false }],
  // A glob or tilde operand could expand into an option such as -o.
  ["sort *.txt", { writesUnseen: true }],
  ["sort ~+/x", { writesUnseen: true }],
  ["sort a.txt", { writesUnseen: false }],
  ["sort '@(a|b)'", { writesUnseen: false }],
  ["base64 -d in", { writesUnseen: false }],
  // sed writes its file only when it edits in place or names a w file.
  ["sed -n p f", { written: [], writesUnseen: false }],
  ["sed -i s/a/b/ f", { written: ["f"], writesUnseen: false }],
  ["sed 's/a/b/w out' f", { writesUnseen: true }],
  // Copies and moves.
  [
    "cp a b c",
    { written: ["c"], landings: ["c/a", "c/b"], copySources: ["a", "b"] },
  ],
  ["mv a b", { written: ["a", "b"], landings: ["b/a"], copySources: [] }],
  ["cp -b a b", { written: ["b"], writesUnseen: true }],
  ["mv --backup a b", { writesUnseen: true }],
  ["cp --parents a/b dir", { landings: ["dir/b"], writesUnseen: true }],
  [
    "cp --target-directory=dir a b",
    { written: ["a", "b", "dir"], landings: ["dir/a", "dir/b", "b/a"] },
  ],
])("the write profile of %p is %p", async (command, expected) => {
  expect(await owner().profile(command)).toMatchObject(expected);
});

test("without the glob-option gate a sort glob is not treated as a hidden write", async () => {
  expect((await owner(false).profile("sort *.txt")).writesUnseen).toBe(false);
});

test.each<[string, string[], boolean]>([
  [`awk '{ print > "out" }' in`, ["out"], false],
  [`awk '{ print >> "out" }' in`, ["out"], false],
  [`awk '{ printf "%s", $0 > "o" }' in`, ["o"], false],
  [`awk '{ print > ("a" "b") }' in`, ["ab"], false],
  [`awk '{ print > "~x" }' in`, ["./~x"], false],
  [`awk '{ print > "a"; print > "b" }' in`, ["a", "b"], false],
  [`awk '{ print "a" "b" }' in`, [], false],
  [`awk '{ print # note\n }' in`, [], false],
  [`awk -F, '{ print > "o" }' in`, ["o"], false],
  [`awk -v x=1 '{ print > "o" }' in`, ["o"], false],
  [`awk '{ print }' ~/in`, [], false],
  [`awk '{ for (k in a) print k > "o" }' in`, ["o"], false],
  // Output that cannot be named from the program text.
  [`awk '{ print > "a" "b" }' in`, [], true],
  [`awk '{ print > ("a" }' in`, [], true],
  [`awk '{ print | "sort" }' in`, [], true],
  [`awk '{ print > target }' in`, [], true],
  [`awk '{ print /x"/ > "o" }' in`, [], true],
  [`awk 'BEGIN { system("x") }'`, [], true],
  [`awk -f prog.awk in`, [], true],
  [`awk '{ print > "\\x" }' in`, [], true],
])("awk program %p writes %p, unseen %p", async (command, files, unseen) => {
  const profile = await owner().profile(command);
  expect(profile.written).toEqual(files);
  expect(profile.writesUnseen).toBe(unseen);
});

test("an awk program with more print statements than can be scanned hides its writes", async () => {
  const body = Array.from({ length: 65 }, () => "print").join("; ");
  const profile = await owner().profile(`awk '{ ${body} }' in`);
  expect(profile.writesUnseen).toBe(true);
});

test.each<[string, boolean]>([
  // printf reads numeric conversions as arithmetic, which can run code.
  ["printf %s *", false],
  ["printf -- %s *", false],
  ["printf '%s' *", false],
  ["printf '%s %%' ~x", false],
  ["printf '%b' ~x", false],
  ["printf '%s' '~x'", false],
  ["printf '%d' *", true],
  ["printf '%n' ~x", true],
  ["printf '\\u0041' ~x", true],
  ["printf -v x %s *", true],
  ["printf ~x", true],
  ["printf -- ~x", true],
  ["set -- ~x", false],
  ["set ~x", true],
  ["read ~x", true],
  ["echo ~x", false],
])(
  "builtin %p reinterprets a cwd-dependent operand: %p",
  async (command, expected) => {
    const f = owner();
    const head = await f.first(command);
    expect(f.run(() => f.alternates.native.nIr(head))).toBe(expected);
  },
);

test.each<[string, string, string[]]>([
  [
    'cat "$PWD/a" "$PWD/b"',
    "/work",
    ["cat /work/a /work/b", 'cat "/work/a" "/work/b"'],
  ],
  [
    'touch x && cat "$PWD/a"',
    "/work",
    ["touch x && cat /work/a", 'touch x && cat "/work/a"'],
  ],
  [
    'cat "$PWD/a" && rm "$PWD/b"',
    "/work",
    ['cat /work/a && rm "$PWD/b"', 'cat "/work/a" && rm "$PWD/b"'],
  ],
  [
    'cat "$PWD/a" | grep "$PWD/b"',
    "/work",
    ["cat /work/a | grep /work/b", 'cat "/work/a" | grep "/work/b"'],
  ],
  [
    'for f in a; do cat "$PWD/a"; done',
    "/work",
    ["for f in a; do cat /work/a; done", 'for f in a; do cat "/work/a"; done'],
  ],
  ['cat "$PWD/a"', "/work dir", ['cat "/work dir/a"']],
  ['cat "$PWD/a"', "/wo$rk", []],
  ['echo hi && cat "$PWD/a"', "/work", []],
  ['unknown && cat "$PWD/a"', "/work", []],
  ['wc "$PWD/a"', "/work", []],
])("the $PWD alternates of %p in %p are %p", async (command, cwd, expected) => {
  expect(await owner().alternatesOf(command, cwd)).toEqual(expected);
});
