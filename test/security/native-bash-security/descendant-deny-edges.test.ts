import { expect, test } from "bun:test";
import { createNativeIgnoreBackend } from "../../../src/native-file-permission-host.js";
import {
  createNativeBashDescendantDeny,
  type NativeBashDescendantDenyHost,
} from "../../../src/native-bash-security/descendant-deny.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityRule as Rule,
} from "../../../src/native-bash-security/security-types.js";
import { createRecursionFixture } from "./recursion-fixture.js";
import { known, policy } from "./security-fixture.js";

// Oti answers whether a Read deny rule could match something at or below a
// directory, so a cd into it cannot be trusted for later reads. The helpers
// normalise patterns the ignore library would refuse and map Windows and WSL
// paths into the rule's root.

function owner(
  profile: NativeBashDescendantDenyHost["platformProfile"] = "macos",
) {
  const f = createRecursionFixture(
    async (input) => ({ behavior: "allow", updatedInput: input }),
    profile === "wsl" ? "linux" : profile,
  );
  f.policyHost.sourceRuleRoot = (_source, s) => known("/work", s);
  const rules: Rule[] = [];
  const warnings: string[] = [];
  const host: NativeBashDescendantDenyHost = {
    platformProfile: profile,
    compileErrorMessage: (pattern, s) =>
      known(createNativeIgnoreBackend().validate(pattern), s),
    denyReadRules: (_permission, s) => known(rules, s),
    denialRelativeRoots: (_permission, _path, s) => known(["/work"], s),
    patternWarning: (_pattern, _message, action, s) => {
      warnings.push(action);
      return known(undefined, s);
    },
    reportError: (_error, s) => known(undefined, s),
    zestyPearl: (s) => known(true, s),
    wslMountPoints: (s) => known(["/mnt/c", "/mnt/wsl"], s),
    wslAdditionalRootMount: (s) =>
      known({ enabled: true, mountPoint: "/mnt/wslg/distro" }, s),
    secondaryRootAliases: (path, s) =>
      known(path === "/work" ? ["/mnt/wsl/work"] : undefined, s),
  };
  const descendant = createNativeBashDescendantDeny(f.syntax.policy, host);
  function run<T>(callback: () => T) {
    return descendant.withPolicyScope(policy(), "/work", callback).result;
  }
  function add(pattern?: string) {
    const rule: Rule = {
      source: "projectSettings",
      ruleBehavior: "deny",
      ruleValue:
        pattern === undefined
          ? { toolName: "Read" }
          : { toolName: "Read", ruleContent: pattern },
    };
    rules.push(rule);
    return rule;
  }
  return {
    ...f,
    descendant,
    host,
    rules,
    warnings,
    run,
    add,
    probe: (path: string) => run(() => descendant.native.Oti(path, policy())),
  };
}

test("a descendant-deny owner on another platform than its path owner is refused", () => {
  const f = createRecursionFixture(
    async (input) => ({ behavior: "allow", updatedInput: input }),
    "macos",
  );
  expect(() =>
    createNativeBashDescendantDeny(f.syntax.policy, {
      platformProfile: "windows",
    }),
  ).toThrow(NativeBashSecurityUnsupported);
});

test("a probe outside a descendant-deny scope fails loudly", () => {
  const f = owner();
  expect(() => f.descendant.native.Oti("/work", policy())).toThrow(
    "Missing native descendant-deny scope",
  );
});

test("a rule without a path pattern never matches a directory", () => {
  const f = owner();
  f.add();
  expect(f.probe("/work/project")).toBeNull();
});

test.each<[string, string]>([
  ["C:\\work", "/c/work"],
  ["relative\\path", "relative/path"],
  ["\\\\host\\share", "//host/share"],
])("Windows path %p maps to %p, also on a second lookup", (path, mapped) => {
  const n = owner("windows").descendant.native;
  expect(n.zB(path)).toBe(mapped);
  expect(n.zB(path)).toBe(mapped);
});

test.each<[string, boolean, string]>([
  ["/**", false, "/**"],
  ["a/**", true, "/a"],
  ["a/**", false, "a"],
  ["!a/**", true, "!a"],
  ["a/b/**", true, "a/b"],
  ["plain", true, "plain"],
])("rule %p (anchored %p) probes as %p", (pattern, anchored, expected) => {
  expect(owner().descendant.native.Et(pattern, anchored)).toBe(expected);
});

test.each<[string, string]>([
  ["a\\*b", "a*b"],
  ["a\\qb", "a\\\\qb"],
  ["x/**", "x/**"],
  ["!x(y)", "!x\\(y\\)"],
])("unusable pattern %p is literalised as %p", (pattern, expected) => {
  expect(owner().descendant.native.Oi(pattern)).toBe(expected);
});

test("a usable negation is kept and an unusable anchored rule is dropped", () => {
  const f = owner();
  expect(f.run(() => f.descendant.native.Ur("!#x", false))).toBe("!#x");
  expect(f.run(() => f.descendant.native.Ur("#x", true))).toBeNull();
  expect(f.warnings).toEqual(["dropping it"]);
});

test("WSL mount points include the additional root mount, longest first", () => {
  const f = owner("wsl");
  expect(f.run(() => f.descendant.native.Yn())).toEqual([
    "/mnt/wslg/distro",
    "/mnt/wsl",
    "/mnt/c",
  ]);
  f.host.wslAdditionalRootMount = (s) =>
    known({ enabled: false, mountPoint: "/mnt/wslg/distro" }, s);
  expect(f.run(() => f.descendant.native.Yn())).toEqual(["/mnt/wsl", "/mnt/c"]);
});

test("WSL directories are also probed through their secondary root aliases", () => {
  const f = owner("wsl");
  expect(f.run(() => f.descendant.native.Bc(["/work", "/other"]))).toEqual([
    "/work",
    "/other",
    "/mnt/wsl/work",
  ]);
  const rule = f.add("/project/secret");
  expect(f.probe("/work")).toBe(rule);
  expect(f.probe("/mnt")).toBe(rule);
});
