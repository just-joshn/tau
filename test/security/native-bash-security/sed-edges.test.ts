import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import { createNativeBashSecuritySed } from "../../../src/native-bash-security/sed.js";
import { fixture } from "./security-fixture.js";

// The sed classifier accepts only two shapes as safe: a quiet print of line
// addresses (sed -n '1p') and a single plain substitution on stdin, or on
// files when in-place edits are allowed. Anything that can execute, write a
// file, or read differently under GNU and BSD -i parsing is refused.

function owner(quietPeacock = true) {
  const f = fixture();
  const p = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const sed = createNativeBashSecuritySed(
    p.projection,
    f.semantic,
    () => quietPeacock,
  );
  return { ...f, sed };
}

const sed = owner().sed;

test.each<[string, boolean]>([
  ["sed -n '1p' file", true],
  ["sed -nE '1p' file", true],
  ["sed -En '1,2p'", true],
  ["sed --silent '$p'", false],
  ["sed -n ''", false],
  ["sed -n", false],
  ["sed -n -e 1p", false],
  ["sed -n -e=1p", false],
  ["sed -n --expression=1p", false],
  ["sed -n -e", false],
  ["sed 's/a\\/b/c/'", false],
  ["sed 's/a/b/2g'", true],
  ["sed 's/a/b'", false],
  ["sed 's/a/b/x'", false],
  ["sed 'sxaxbx'", false],
  ["sed 'y/a/b/'", false],
  ["sed 's/a;b/c/'", false],
  ["sed 's/é/b/'", false],
  ["sed -e s/a/b/ -e s/c/d/", false],
  ["sed -e s/a/b/ file", false],
  ["sed --expression=s/a/b/ file", false],
  ["sed s/a/b/ one two", false],
  ["sed", false],
  ["sed -ew x", false],
  ["gsed -n 1p", false],
])("sed %p is read-only: %p", (command, expected) => {
  expect(sed.isReadOnly(command, { source: "none" })).toBe(expected);
});

test.each<[string, boolean]>([
  ["sed -i s/a/b/ f", true],
  ["sed -Ei s/a/b/ f", true],
  ["sed -i '' s/a/b/ f", false],
  ["sed -i .bak s/a/b/ f", false],
  ["sed -i", false],
  ["sed -i -i s/a/b/ f", false],
  ["sed -i -e s/a/b/ f", false],
  // Under GNU parsing the word after -i is the script and the next word a
  // file; under BSD parsing the reverse. A file name that reads as a sed
  // command makes the two readings disagree.
  ["sed -i bak s/a/b/ f", false],
  ["sed -i s/a/b/ p", false],
  ["sed -i s/a/b/ s/c/d/", false],
  ["sed -i s/a/b/ 1d", false],
  ["sed -i s/a/b/ /x/d", false],
  ["sed -i s/a/b/ /x/p", false],
  ["sed -i s/a/b/ r", false],
  ["sed -i s/a/b/ '$'", false],
  ["sed -i s/a/b/ 'e x'", false],
  ["sed -i s/a/b/ 'a;b'", false],
  ["sed -i s/a/b/ 'x[1]'", false],
  ["sed -i s/a/b/ 'a\\b'", false],
  ["sed -i s/a/b/ a/../b", false],
  ["sed -i s/a/b/ ../f", true],
  ["sed -i s/a/b/ -E f", true],
])("in-place sed %p is acceptable: %p", (command, expected) => {
  expect(
    sed.isReadOnly(command, { source: "none", allowFileWrites: true }),
  ).toBe(expected);
});

test("the ambiguous -i reading also follows -e and --expression", () => {
  const n = sed.native;
  expect(n.Kxr("sed -i bak --expression=s/a/b/ f")).toBe("s/a/b/");
  expect(n.Kxr("sed -i bak -e")).toBeNull();
  expect(n.Kxr("sed -i bak")).toBeNull();
  expect(n.Kxr("sed -i ''")).toBeNull();
  expect(n.Kxr("awk -i x y")).toBeNull();
  expect(n.Kxr("sed -n p")).toBeNull();
});

test("a glob operand stops sed from being judged read-only when the gate is on", async () => {
  const f = owner(true);
  const result = await f.semantic.analyze("sed -n 1p *.txt");
  if (result.kind !== "simple") throw new Error(result.reason);
  const source = result.commands[0];
  if (source === undefined) throw new Error("Missing command");
  expect(f.sed.isReadOnly("sed -n 1p *.txt", { source: "none" })).toBe(false);
  expect(f.sed.isReadOnly("sed -n 1p file", { source })).toBe(false);
  expect(owner(false).sed.isReadOnly("sed -n 1p file", { source })).toBe(true);
});

test("a tracked variable makes sed text unreadable", () => {
  expect(sed.isReadOnly("sed -n 1p __TRACKED_VAR__", { source: "none" })).toBe(
    false,
  );
});

test.each<[string, boolean]>([
  ["", false],
  ["!p", true],
  ["1!p", true],
  ["1~2p", true],
  ["1,~2p", true],
  ["$~2p", true],
  [",2p", true],
  ["1,+2p", true],
  ["s\\a\\b\\", true],
  ["\\%x%p", true],
  ["\\/x/w f", true],
  ["/x/ w f", true],
  ["s/a/b/c/d", true],
  ["s|a|b|w", true],
  ["s|a|b|gw", true],
  ["w out", true],
  ["1w out", true],
  ["$w out", true],
  ["/x/Iw out", true],
  ["1,2w out", true],
  ["1,$w out", true],
  ["/a/,/b/w out", true],
  ["1e", true],
  ["$e", true],
  ["/x/e", true],
  ["1,2e", true],
  ["1,$e", true],
  ["/a/,/b/e", true],
  ["s/a/b/eg", true],
  ["s/a/b/Wg", true],
  ["y/a/b/;w", true],
  ["s/a#b/c/", true],
  ["s#a#b#", false],
  ["s|a|b|g", false],
  ["s/a/b/g", false],
])("sed script %p can execute, write or misparse: %p", (script, expected) => {
  expect(sed.native.Okn(script)).toBe(expected);
});

test("helpers refuse anything that is not sed", () => {
  const n = sed.native;
  expect(n.Vxr("awk x")).toEqual([]);
  expect(n.qxr("awk x y")).toBe(false);
  expect(n.qxr("sed --expression=p f")).toBe(true);
  expect(n.qxr("sed -e=p f")).toBe(true);
  expect(n.qxr("sed p")).toBe(false);
  expect(n.Pkn("awk -n p", ["p"])).toBe(false);
  expect(n.Mkn("awk s/a/b/", ["s/a/b/"], false)).toBe(false);
  expect(n.zxr("")).toBe(false);
});
