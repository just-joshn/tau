import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../src/native-bash-command-preparation.js";
import type { NativeBashSyntaxNode as Node } from "../../src/native-bash-parser.js";
import {
  createNativeBashSecurityPolicyControl,
  type NativeBashSecurityPolicyHost,
} from "../../src/native-bash-security/policy-control.js";
import { createNativeBashSecurityRecursiveSyntax } from "../../src/native-bash-security/recursive-syntax.js";
import { fixture, known, policy } from "./security-fixture.js";
import { NativeBashSecurityUnsupported } from "../../src/native-bash-security/security-types.js";

function owner(observeRemoval = false) {
  const f = fixture();
  const prep = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const host: NativeBashSecurityPolicyHost = {
    ...f.host,
    protectedRoots: (s) => known([], s),
    workingDirectories: (_p, s) => known(["/work"], s),
    mountedDriveRmPromptDisabled: (s) => known(false, s),
    feature: (_key, _default, s) =>
      known({ value: true, source: "authored-test" }, s),
  };
  const controller = createNativeBashSecurityPolicyControl(
    f.semantic,
    prep,
    host,
  );
  const removals: { name: string; args: string[] }[] = [];
  if (observeRemoval)
    controller.pathOwner.native.o2 = (name, args) => {
      removals.push({ name, args });
      return controller.pathOwner.native.nb(
        name,
        "authored callback",
        "authored callback",
        "test",
      );
    };
  let enabled = true;
  let featureCalls = 0;
  const syntax = createNativeBashSecurityRecursiveSyntax(controller, {
    wildOctopus: (s) => {
      featureCalls++;
      return known(enabled, s);
    },
  });
  async function tree(text: string): Promise<Node> {
    const node = await f.semantic.parse(text);
    if (node === null || node === f.semantic.parseAbort)
      throw new Error("Expected authored tree");
    return node;
  }
  async function history(text: string) {
    const receipt = await f.semantic.analyze(text);
    if (receipt.kind !== "simple") throw new Error(receipt.reason);
    return syntax.withPolicyScope(policy(), "/work", () =>
      syntax.native.$Or(text, receipt.commands),
    ).result;
  }
  return {
    ...f,
    syntax,
    controller,
    tree,
    history,
    removals,
    featureCalls: () => featureCalls,
    setEnabled(value: boolean) {
      enabled = value;
    },
  };
}

test("recursive separators retain command indices, implicit newlines and explicit compound operators", async () => {
  const f = owner();
  expect(
    await f.syntax.native.Lbn("echo 雪 && cat a | wc -c\necho done", 4),
  ).toEqual([
    { after: 0, type: "&&" },
    { after: 1, type: "|" },
    { after: 2, type: "\n" },
  ]);
  expect(await f.syntax.native.Lbn("echo a; echo b & echo c", 3)).toEqual([
    { after: 0, type: ";" },
    { after: 1, type: "&" },
  ]);
  expect(await f.syntax.native.Lbn("echo a && cat b", 3)).toBeNull();
  expect(await f.syntax.native.Lbn("echo 'unterminated", 1)).toEqual([]);
});

test("native cwd recognition consults wild-octopus only after the simple candidate fails", () => {
  const f = owner();
  const run = (text: string) =>
    f.syntax.withPolicyScope(policy(), "/work", () => f.syntax.native.sb(text))
      .result;
  expect(run("cd child")).toBe(true);
  expect(f.featureCalls()).toBe(0);
  expect(run('"builtin" cd child')).toBe(true);
  expect(f.featureCalls()).toBe(0);
  const rewritten = () =>
    f.syntax.withPolicyScope(policy(), "/work", () =>
      f.syntax.native.jbn(
        "echo value",
        () => ["cd"],
        ([name]) => name === "cd",
      ),
    ).result;
  expect(rewritten()).toBe(true);
  expect(f.featureCalls()).toBe(1);
  f.setEnabled(false);
  expect(rewritten()).toBe(false);
  expect(f.featureCalls()).toBe(2);
  const unsupported = createNativeBashSecurityRecursiveSyntax(f.controller, {});
  expect(() =>
    unsupported.withPolicyScope(policy(), "/work", () =>
      unsupported.native.sb("echo value"),
    ),
  ).toThrow(NativeBashSecurityUnsupported);
});

test("history preserves exported names, function-unset asymmetry and bare assignments", async () => {
  const f = owner();
  expect(await f.history("cd child")).toEqual({
    text: "cd child",
    cd: true,
    names: [],
    exports: false,
  });
  expect(f.syntax.native.$Or("A=one B=two", [])).toEqual({
    text: "A=one B=two",
    cd: false,
    names: ["A", "B"],
    exports: false,
  });
  expect(await f.history("export VALUE=one")).toEqual({
    text: "export VALUE=one",
    cd: false,
    names: ["VALUE"],
    exports: true,
  });
  expect(await f.history("unset -f fn")).toEqual({
    text: "unset -f fn",
    cd: false,
    names: [],
    exports: true,
  });
  expect(await f.history("unset -v fn")).toEqual({
    text: "unset -v fn",
    cd: false,
    names: ["fn"],
    exports: true,
  });
  expect(await f.history("echo one; echo two")).toBeUndefined();
});

test("redirect reconstruction uses byte spans and retains only words after redirect heads", async () => {
  const f = owner();
  const root = await f.tree("printf 雪 > output extra");
  const command = root.children[0];
  if (!command) throw new Error("Missing command");
  const reconstructed = f.syntax.native.MOr(command);
  expect(reconstructed?.whole).toBe("printf 雪 extra");
  expect(reconstructed?.heads).toEqual([[11, 19]]);
  const plain = await f.tree("echo value > output");
  expect(f.syntax.native.MOr(plain)).toBeUndefined();
  expect(f.syntax.native.MOr(plain.children[0] ?? plain)).toBeUndefined();
});

test("HOME alternate transformation preserves literal catastrophic targets and ignores other runtime variables", async () => {
  const f = owner(true);
  const run = async (text: string) => {
    const root = await f.tree(text);
    return f.syntax.withPolicyScope(policy(), "/work", () =>
      f.syntax.native.slt(root, "/work", policy()),
    ).result;
  };
  const root = await run('rm -rf "${HOME:+/}"');
  expect(root.map((entry) => entry.kind)).toEqual(["literalTarget"]);
  expect(f.removals).toEqual([{ name: "rm", args: ["-rf", "/"] }]);
  expect(await run('rm -rf "$UNRELATED"')).toEqual([]);
  expect(await run('echo 雪 > "${HOME:+/}"')).toEqual([]);
});
