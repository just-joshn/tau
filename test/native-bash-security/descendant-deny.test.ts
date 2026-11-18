import { expect, test } from "bun:test";
import { createNativeIgnoreBackend } from "../../src/native-file-permission-host.js";
import { createRecursionFixture } from "./recursion-fixture.js";
import {
  createNativeBashDescendantDeny,
  type NativeBashDescendantDenyHost,
} from "../../src/native-bash-security/descendant-deny.js";
import { known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityRule as Rule,
} from "../../src/native-bash-security/security-types.js";

function owner(
  profile: NativeBashDescendantDenyHost["platformProfile"] = "macos",
) {
  const f = createRecursionFixture(
    async (input) => ({ behavior: "allow", updatedInput: input }),
    profile === "wsl" ? "linux" : profile,
  );
  f.policyHost.sourceRuleRoot = (_source, s) => known("/work", s);
  const rules: Rule[] = [];
  const rootReads: string[] = [];
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const host: NativeBashDescendantDenyHost = {
    platformProfile: profile,
    compileErrorMessage: (pattern, s) =>
      known(createNativeIgnoreBackend().validate(pattern), s),
    denyReadRules: (_permission, s) => known(rules, s),
    denialRelativeRoots: (_permission, path, s) => {
      rootReads.push(path);
      return known(["/work"], s);
    },
    patternWarning: (_pattern, _message, action, s) => {
      warnings.push(action);
      return known(undefined, s);
    },
    reportError: (error, s) => {
      errors.push(error);
      return known(undefined, s);
    },
  };
  const descendant = createNativeBashDescendantDeny(f.syntax.policy, host);
  const run = <T>(callback: () => T) =>
    descendant.withPolicyScope(policy(), "/work", callback).result;
  function add(pattern: string) {
    const rule: Rule = {
      source: "projectSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Read", ruleContent: pattern },
    };
    rules.push(rule);
    return rule;
  }
  return {
    ...f,
    descendant,
    host,
    rules,
    rootReads,
    warnings,
    errors,
    run,
    add,
    probe: (path: string) => run(() => descendant.native.Oti(path, policy())),
  };
}

test("native possible-descendant deny catches parent directories and ancestors while excluding sibling trees", () => {
  const f = owner();
  const rule = f.add("/project/secrets/**");
  for (const path of [
    "/work",
    "/work/project",
    "/work/project/secrets/deeper",
    "/",
  ])
    expect(f.probe(path)).toBe(rule);
  expect(f.probe("/work/unrelated")).toBeNull();
  expect(f.probe("/tmp")).toBeNull();
});

test("native basename and partial-glob probes retain conservative component semantics and Unicode folding", () => {
  const f = owner();
  const basename = f.add("secrets");
  expect(f.probe("/work/ordinary")).toBe(basename);
  f.rules.length = 0;
  const wildcard = f.add("/proj*/secret");
  expect(f.probe("/work/project")).toBe(wildcard);
  expect(f.probe("/work/other")).toBeNull();
  expect(f.descendant.native.Og(["DIR", "ſecret"], ["dir", "Secret"])).toBe(
    true,
  );
  expect(
    f.descendant.native.Og(["project", "[ab]", "secret"], ["project", "other"]),
  ).toBe(true);
});

test("native relative-root reads cache within each directory probe and negative patterns do not participate", () => {
  const f = owner();
  f.add("!secret/**");
  f.add("unmatched/one");
  f.add("unmatched/two");
  expect(f.probe("/work/other")).toBeNull();
  expect(f.rootReads).toEqual(["/work/other"]);
  expect(f.probe("/work/other")).toBeNull();
  expect(f.rootReads).toEqual(["/work/other", "/work/other"]);
  f.rules.length = 0;
  f.host.denialRelativeRoots = () => {
    throw new Error("Unexpected root read");
  };
  expect(f.probe("/anything")).toBeNull();
  delete f.host.denyReadRules;
  expect(() => f.probe("/anything")).toThrow(NativeBashSecurityUnsupported);
});

test("native unusable-pattern warnings preserve literalization, negation drop and missing-effect behavior", () => {
  const f = owner();
  expect(f.run(() => f.descendant.native.Ur("#comment", false))).toBe(
    "\\#comment",
  );
  expect(f.warnings).toEqual(["matching the literal path it spells"]);
  expect(f.run(() => f.descendant.native.Ur("!", false))).toBeNull();
  expect(f.warnings).toEqual([
    "matching the literal path it spells",
    "dropping it",
  ]);
  delete f.host.patternWarning;
  expect(() => f.run(() => f.descendant.native.Ur("#comment", false))).toThrow(
    NativeBashSecurityUnsupported,
  );
});

test("native WSL mount-feature exception fallback reports once and never swallows unknown capability", () => {
  const f = owner("wsl");
  const failure = new Error("author mount-feature failure");
  f.host.zestyPearl = () => {
    throw failure;
  };
  expect(f.run(f.descendant.native.Br)).toBe(true);
  expect(f.run(f.descendant.native.Br)).toBe(true);
  expect(f.errors).toEqual([failure]);
  delete f.host.zestyPearl;
  expect(() => f.run(f.descendant.native.Br)).toThrow(
    NativeBashSecurityUnsupported,
  );
  expect(f.errors).toEqual([failure]);
});

test("native Windows descendant relative paths share bounded drive/UNC transformation cache", () => {
  const f = owner("windows");
  expect(f.descendant.native.c7e("C:\\work", "C:\\work\\project")).toBe(
    "project",
  );
  expect(f.descendant.native.zB("\\\\host\\share\\path")).toBe(
    "//host/share/path",
  );
  for (let index = 0; index < 600; index++)
    f.descendant.native.zB(`C:\\work\\${index}`);
  expect(f.descendant.cache.size()).toBe(500);
  expect(f.descendant.native.c7e("C:\\work", "D:\\other")).toBe(
    "../../d/other",
  );
  f.descendant.cache.clear();
  expect(f.descendant.cache.size()).toBe(0);
});
