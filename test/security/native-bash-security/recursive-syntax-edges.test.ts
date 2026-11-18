import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import type { NativeBashSyntaxNode as Node } from "../../../src/native-bash-parser.js";
import { createNativeBashSecurityPolicyControl } from "../../../src/native-bash-security/policy-control.js";
import { createNativeBashSecurityRecursiveSyntax } from "../../../src/native-bash-security/recursive-syntax.js";
import type { NativeBashSecurityDecision as Decision } from "../../../src/native-bash-security/security-types.js";
import { fixture, known, policy } from "./security-fixture.js";

// Recursive syntax helpers feed the removal checks: separators between
// commands, the history a statement leaves for a later shell -c, words after
// a mid-command redirect, and the HOME-alternate reading of rm targets.

function owner() {
  const f = fixture();
  const prep = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const controller = createNativeBashSecurityPolicyControl(f.semantic, prep, {
    ...f.host,
    protectedRoots: (s) => known([], s),
    workingDirectories: (_p, s) => known(["/work"], s),
    mountedDriveRmPromptDisabled: (s) => known(false, s),
    feature: (_key, _default, s) =>
      known({ value: true, source: "authored-test" }, s),
    pathPrimitive: (_kind, path, s) => known(path, s),
  });
  const removals: string[][] = [];
  const o2 = controller.pathOwner.native.o2;
  controller.pathOwner.native.o2 = (name, args, ...rest) => {
    removals.push([name, ...args]);
    return o2(name, args, ...rest);
  };
  const syntax = createNativeBashSecurityRecursiveSyntax(controller, {
    wildOctopus: (s) => known(true, s),
  });
  function run<T>(callback: () => T) {
    return syntax.withPolicyScope(policy(), "/work", callback).result;
  }
  async function tree(text: string): Promise<Node> {
    const node = await f.semantic.parse(text);
    if (node === null || node === f.semantic.parseAbort)
      throw new Error("Expected a syntax tree");
    return node;
  }
  async function first(text: string): Promise<Node> {
    const node = (await tree(text)).children[0];
    if (node === undefined) throw new Error("Expected a statement");
    return node;
  }
  async function history(text: string) {
    const receipt = await f.semantic.analyze(text);
    if (receipt.kind !== "simple") throw new Error(receipt.reason);
    return run(() => syntax.native.$Or(text, receipt.commands));
  }
  async function home(
    node: Node,
    forced = false,
    absoluteOnly = false,
  ): Promise<string[]> {
    const results = await run(() =>
      syntax.native.slt(node, "/work", policy(), forced, absoluteOnly),
    );
    return results.map((entry) => entry.kind);
  }
  return { ...f, syntax, run, tree, first, history, home, removals };
}

test("a cd recognition outside a policy scope fails loudly", () => {
  expect(() => owner().syntax.native.sb("echo value")).toThrow(
    "Missing native recursive syntax invariant",
  );
});

test("a time prefix is stripped before the rewritten argv is judged", () => {
  const f = owner();
  const seen: string[][] = [];
  f.run(() =>
    f.syntax.native.jbn(
      "time -- echo value",
      (argv) => {
        seen.push(argv);
        return argv;
      },
      () => false,
    ),
  );
  expect(seen).toEqual([["echo", "value"]]);
});

test.each<[string, number, { after: number; type: string }[] | null]>([
  ["echo a > f && echo b", 2, [{ after: 0, type: "&&" }]],
])(
  "separators of %p over %p commands are %p",
  async (text, count, expected) => {
    expect(await owner().syntax.native.Lbn(text, count)).toEqual(expected);
  },
);

test.each([
  ["> out", undefined],
  ["declare -x X=1", { names: ["X"], exports: true }],
  ["declare X=1", { names: ["X"], exports: false }],
  ["readonly X", { names: ["X"], exports: false }],
  ["export X+=a", { names: ["X"], exports: true }],
])("statement %p leaves history %p", async (text, expected) => {
  const result = await owner().history(text);
  if (expected === undefined) expect(result).toBeUndefined();
  else expect(result).toMatchObject(expected);
});

test.each<[string, string | undefined]>([
  ["! printf a > f extra", "printf a extra"],
  ["echo a | printf b > f extra", "printf b extra"],
  ["printf a 2>&- extra", "printf a extra"],
  ["{ echo; } > f", undefined],
])("words after the redirect in %p read as %p", async (text, expected) => {
  const f = owner();
  expect(f.syntax.native.MOr(await f.first(text))?.whole).toBe(expected);
});

test.each<[string, Decision, Decision]>([
  [
    "a non-ask",
    { behavior: "allow", updatedInput: { command: "" } },
    { behavior: "allow", updatedInput: { command: "" } },
  ],
  [
    "an ask without a safety reason",
    {
      behavior: "ask",
      message: "m",
      decisionReason: { type: "other", reason: "r" },
    },
    {
      behavior: "ask",
      message: "m",
      decisionReason: { type: "other", reason: "r" },
    },
  ],
  [
    "a safety ask",
    {
      behavior: "ask",
      message: "m",
      decisionReason: {
        type: "safetyCheck",
        reason: "r",
        classifierApprovable: false,
      },
    },
    {
      behavior: "ask",
      message: "m",
      decisionReason: {
        type: "safetyCheck",
        reason: "r",
        classifierApprovable: false,
        removalRule: "emptyExpansion",
      },
    },
  ],
])(
  "relabelling %s as an empty expansion gives the expected decision",
  (_label, input, expected) => {
    expect(owner().syntax.native.xbn(input)).toEqual(expected);
  },
);

test.each<[string, string[], string[][]]>([
  ['rm -rf "${HOME}"', ["literalTarget"], [["rm", "-rf", "/home/test"]]],
  ['rm -rf "${HOME:+/;}"', ["literalTarget"], [["rm", "-rf", "/home/test"]]],
  ['rm -rf "${HOME:-/}"', ["literalTarget"], [["rm", "-rf", "/home/test"]]],
  [
    'rm -rf "${HOME:+/}$(x)"',
    ["literalTarget", "emptyExpansion"],
    [
      ["rm", "-rf", "/__CMDSUB__"],
      ["rm", "-rf", "/"],
    ],
  ],
  ['rm -rf "${HOME:+/}" "$Y"', ["literalTarget"], [["rm", "-rf", "/"]]],
  ['X=1; rm -rf "$X/${HOME:+x}"', [], [["rm", "-rf", "1/x"]]],
])("the HOME reading of %p yields %p", async (text, kinds, removals) => {
  const f = owner();
  expect(await f.home(await f.tree(text))).toEqual(kinds);
  expect(f.removals).toEqual(removals);
});

test.each<[string, string[]]>([
  ["X=${HOME} rm -rf /", ["literalTarget"]],
  ['rm -rf "${HOME:+/}" > out', ["literalTarget"]],
  ['X=/ rm -rf "${HOME:+$X}"', []],
])("the HOME reading of statement %p yields %p", async (text, kinds) => {
  const f = owner();
  expect(await f.home(await f.first(text))).toEqual(kinds);
});

test("a forced absolute-only reading keeps only absolute and home targets", async () => {
  const f = owner();
  expect(await f.home(await f.tree("rm -rf rel /abs ~/x"), true, true)).toEqual(
    ["literalTarget"],
  );
  expect(f.removals).toEqual([["rm", "-rf", "/abs", "~/x"]]);
});
