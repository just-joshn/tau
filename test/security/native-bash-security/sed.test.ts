import { test, expect } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import { createNativeBashSecuritySed } from "../../../src/native-bash-security/sed.js";
import { fixture } from "./security-fixture.js";
function owner() {
  const f = fixture();
  const p = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  return createNativeBashSecuritySed(p.projection, f.semantic, () => true);
}
test("complete native sed read predicate separates print and substitution with file inputs", () => {
  const f = owner();
  for (const input of [
    "sed -n '1p' file",
    "sed -n '1,4p' file",
    "sed 's/a/b/'",
    "sed -E 's/a/b/g'",
    "sed --quiet '1p;2p' file",
  ]) {
    expect(f.isReadOnly(input, { source: "none" })).toBe(true);
  }
  for (const input of [
    "sed 's/a/b/' file",
    "sed -i 's/a/b/' file",
    "sed -f program file",
    "sed -n '1q' file",
    "sed -n 'p;w output' file",
    "sed -n 'p' \"$(cmd)\"",
  ]) {
    expect(f.isReadOnly(input, { source: "none" })).toBe(false);
  }
  expect(
    f.isReadOnly("sed -i 's/a/b/' file", {
      source: "none",
      allowFileWrites: true,
    }),
  ).toBe(true);
});
test("sed native command filter catches execution, writes, addressing and non-ASCII forms", () => {
  const { Okn } = owner().native;
  for (const input of [
    "e whoami",
    "1e whoami",
    "/x/e cmd",
    "s/a/b/e",
    "s/a/b/w output",
    "y/a/e/",
    "p\nq",
    "p#comment",
    "{p}",
    "é",
    "\0",
  ]) {
    expect(Okn(input)).toBe(true);
  }
  for (const input of ["p", "1,2p", "s/a/b/", "s#x#y#", "\x01", "\x7f"]) {
    expect(Okn(input)).toBe(false);
  }
});
test("sed exact option classification retains bundled flags and backup ambiguity", () => {
  const n = owner().native;
  expect(n.Dkn(["-En"], ["-E", "-n"])).toBe(true);
  expect(n.Dkn(["-ne"], ["-n"])).toBe(false);
  expect(n.Kxr("sed -i backup -e program file")).toBe("program");
  expect(n.Kxr("sed -i -i program file")).toBe("__SED_MULTIPLE_I_FLAGS__");
  expect(n.Kxr("sed -i .bak program file")).toBeNull();
  expect(() => n.Vxr("sed -ew program")).toThrow("Dangerous flag combination");
  expect(n.Vxr("sed --expression=s/a/b/ file")).toEqual(["s/a/b/"]);
});
