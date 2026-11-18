import { expect, test } from "bun:test";
import { posix } from "node:path";
import { createNativeBashLiteralRemoval } from "../../../src/native-bash-security/literal-removal.js";
import { createNativeBashSecurityNestedRemoval } from "../../../src/native-bash-security/nested-removal.js";
import type { NativeBashSecurityRecursiveCheck as Check } from "../../../src/native-bash-security/security-recursion-types.js";
import type { NativeBashSecurityDecision as Decision } from "../../../src/native-bash-security/security-types.js";
import { createNestedFixture } from "./nested-fixture.js";
import { known, policy } from "./security-fixture.js";

// The nested-removal scan looks inside command substitutions, process
// substitutions, function substitutions, groups and redirect-split argument
// lists for an rm whose target could be a critical path. It answers with the
// strongest removal prompt it found, or null when nothing needs review.

function owner(check?: Check) {
  const f = createNestedFixture();
  f.policyHost.protectedRoots = (s) => known([], s);
  f.policyHost.workingDirectories = (_p, s) => known(["/work"], s);
  f.policyHost.suggestionDirectory = (path, s) => known(posix.dirname(path), s);
  f.policyHost.nativePathSpelling = (path, s) =>
    known(posix.normalize(path.trim()), s);
  f.policyHost.mountedDriveRmPromptDisabled = (s) => known(false, s);
  f.policyHost.originalWorkingDirectory = (s) => known("/work", s);
  f.policyHost.pathPrimitive = (_k, path, s) => known(path, s);
  const nested =
    check === undefined
      ? f.nested
      : createNativeBashSecurityNestedRemoval(
          f.recurse,
          f.nested.literal,
          f.host,
          check,
        );
  async function scan(command: string, depth = 0) {
    const tree = await f.semantic.parse(command);
    if (tree === null || tree === f.semantic.parseAbort)
      throw new Error("Expected a syntax tree");
    const state = { ...f.context(command), depth };
    return nested.withPolicyScope(policy(), "/work", () =>
      nested.native.Pbn(
        tree,
        "/work",
        policy(),
        undefined,
        false,
        state,
        state.context,
      ),
    ).result;
  }
  function feature(key: string, value: boolean) {
    f.policyHost.feature = (name, _fallback, s) =>
      known(
        name === key
          ? { value, source: "payload" }
          : { value: true, source: "authored-test" },
        s,
      );
  }
  return { ...f, nested, scan, feature };
}

const allow: Check = async (input) => ({
  behavior: "allow",
  updatedInput: input,
});

async function kind(command: string): Promise<string | null> {
  const result = await owner().scan(command);
  return result === null ? null : result.kind;
}

test("a literal removal owner over another path owner is refused", () => {
  const f = owner();
  const g = owner();
  const literal = createNativeBashLiteralRemoval(
    g.semantic,
    g.syntax.preparation,
    g.syntax.policy.pathOwner,
  );
  expect(() =>
    createNativeBashSecurityNestedRemoval(f.recurse, literal, f.host, allow),
  ).toThrow("must be shared");
});

test("an unset-variable probe outside the nested-removal scope fails loudly", () => {
  const f = owner();
  const probe = f.recurse.withPolicyScope(policy(), "/work", () =>
    f.nested.native.Rbn(false, f.context("").context),
  ).result;
  expect(probe).toBeDefined();
  expect(() => probe?.mayBeUnset("X")).toThrow(
    "Missing native nested-removal invariant",
  );
});

test.each([
  ["echo $(rm -rf /)", "literalTarget"],
  ["echo <(rm -rf /)", "literalTarget"],
  ["cat >(rm -rf /)", "literalTarget"],
  ["echo `rm -rf /`", "literalTarget"],
  ["echo `rm -rf /", "literalTarget"],
  ['echo "`rm -rf \\"/\\"`"', "literalTarget"],
  ["echo ${ rm -rf /; }", "literalTarget"],
  ["{ rm -rf /; }", "literalTarget"],
  ["( rm -rf / )", "literalTarget"],
  ["if rm -rf /; then :; fi", "literalTarget"],
  ["sudo rm -rf /", "literalTarget"],
  ["rm -rf /$(pwd)", "literalTarget"],
  ["rm -rf -- /$(pwd)", "literalTarget"],
  ['rm -rf "/${X:-$(pwd)}"', "literalTarget"],
  ["rm -rf /tmp/$(date)", "emptyExpansion"],
  ["rm -rf -v /usr/$(x)", "emptyExpansion"],
  ["rm -rf -- /usr/$(x)", "emptyExpansion"],
  ["rm -rf ~/$(x)", "emptyExpansion"],
  ["echo hi | rm -rf /x/$(y)", "emptyExpansion"],
  ["rm -rf $(pwd)", "wholeSubstitution"],
  ['rm -rf "$(pwd)/"', "wholeSubstitution"],
  ["rm -rf $(echo /)/", "wholeSubstitution"],
  ['rm -rf "${X:-$(pwd)}"', "wholeSubstitution"],
  ["rm --recursive `pwd`", "wholeSubstitution"],
  ['rm -rf "$X/etc"', "emptyVariable"],
  ['echo "$(rm -rf "$UNSET/")"', "emptyVariable"],
  ["rm -rf /Volumes/Backup", "literalTarget"],
  // An assignment before a keyword is read both as a keyword and as a word.
  ["X=1 if true; then rm -rf /; fi", "literalTarget"],
  ['echo "`rm -rf \\"$X/\\"`"', "emptyVariable"],
  ["rm -rf /Volumes/$(x)", "emptyExpansion"],
  // Nothing here can reach a critical path.
  ["echo $(ls)", null],
  ['echo "`echo \\"x\\"`"', null],
  ["rm -rf ./build", null],
  ["rm -f $(cat list)", null],
  ["rmdir $(x)", null],
  ["rm -r /usr/$(x)/..", null],
])("nested removal scan of %p answers %p", async (command, expected) => {
  expect(await kind(command)).toBe(expected);
});

test("the strongest prompt wins over an earlier mounted-drive prompt", async () => {
  const f = owner();
  const result = await f.scan("rm -rf /Volumes/Backup; echo $(rm -rf /)");
  expect(result?.kind).toBe("literalTarget");
  expect(result?.result.decisionReason).toMatchObject({
    circuitBreaker: "dangerousRemoval",
  });
  expect(result?.result.message).toContain("critical system directory");
});

test("with the bright-lake gate off the unset-variable probe is skipped", async () => {
  const f = owner();
  f.feature("tengu_bright_lake", false);
  const result = await f.scan('rm -rf "$BUILD/*"');
  expect(result?.kind).toBe("emptyVariable");
  expect(f.reads).toEqual([]);
  expect(
    f.nested.withPolicyScope(policy(), "/work", () =>
      f.nested.native.qlt(
        'rm -rf "$BUILD/*"',
        true,
        undefined,
        false,
        f.context("").context,
      ),
    ).result,
  ).toBeNull();
});

test.each([
  ['rm -rf "$Y/etc"', "var_root_child"],
  ['X=$Y/etc; rm -rf "$X"', "derived_var"],
])("unset-variable removal %p is still reported (%p)", async (command) => {
  expect(await kind(command)).toBe("emptyVariable");
});

test("a removal hidden behind an eval-trap string is reported as an empty variable", async () => {
  const f = owner();
  const result = f.nested.withPolicyScope(policy(), "/work", () =>
    f.nested.native.qlt(
      'rm -rf "$BUILD/*"',
      true,
      undefined,
      false,
      f.context("").context,
    ),
  ).result;
  expect(result).not.toBeNull();
});

test("many substitutions without a removal word pass when the keyword guard is off", async () => {
  const f = owner();
  f.semantic.parser.features.registerKeywordReader(() => ({
    value: false,
    source: "payload",
    defaultHost: true,
  }));
  const many = Array.from({ length: 65 }, () => "$(echo x)").join(" ");
  expect(await f.scan(`echo ${many}`)).toBeNull();
  expect((await f.scan(`rm ${many}`))?.kind).toBe("tooManySubstitutions");
});

test("more than 128 nested backtick bodies are too many to analyse", async () => {
  const body = Array.from({ length: 130 }, () => '`echo \\"x\\"`').join(" ");
  expect(await kind(`echo "${body}"`)).toBe("tooManySubstitutions");
});

test("the substitution prompt can be turned off by a payload flag", async () => {
  const f = owner();
  f.host.iridescentBoot = (s) => known({ value: false, source: "payload" }, s);
  expect(await f.scan("rm -rf $(pwd)")).toBeNull();
  const g = owner();
  g.host.iridescentBoot = (s) => known({ value: false, source: "default" }, s);
  expect((await g.scan("rm -rf $(pwd)"))?.kind).toBe("wholeSubstitution");
});

test("HOME-based removals are reread only at the top level with removal review on", async () => {
  expect(await kind("rm -rf ${HOME}/$(x)")).not.toBeNull();
  const f = owner();
  f.host.removalReviewFeature = (s) =>
    known({ value: { enabled: false }, source: "payload" }, s);
  expect(await f.scan("echo ${HOME:+$(pwd)}")).toBeNull();
  const g = owner();
  expect(await g.scan("echo ${HOME:+$(pwd)}", 1)).toBeNull();
});

test.each([
  ["rm -rf ${HOME}", true],
  ["rm -rf ${HOME}/", true],
  ["echo $(rm -rf ${HOME})", true],
  ["echo ${HOME}", false],
])("top-level HOME removal %p is flagged: %p", async (command, flagged) => {
  expect((await kind(command)) !== null).toBe(flagged);
});

test.each([
  ["cd /tmp && rm -rf $(x)", "wholeSubstitution"],
  ["echo $(cd /; rm -rf *)", "literalTarget"],
])(
  "a directory change before a nested removal %p answers %p",
  async (command, expected) => {
    expect(await kind(command)).toBe(expected);
  },
);

function decide(decision: Decision): Check {
  return async () => decision;
}

const critical: Decision = {
  behavior: "ask",
  message: "critical",
  decisionReason: {
    type: "safetyCheck",
    reason: "critical",
    classifierApprovable: false,
    circuitBreaker: "dangerousRemoval",
  },
};

test.each<[string, Decision, string | null]>([
  ["critical removal", critical, "literalTarget"],
  [
    "removal inside subcommand results",
    {
      behavior: "ask",
      message: "nested",
      decisionReason: {
        type: "subcommandResults",
        reasons: new Map([["rm", critical]]),
      },
    },
    "literalTarget",
  ],
  [
    "deny",
    {
      behavior: "deny",
      message: "denied",
      decisionReason: { type: "other", reason: "denied" },
    },
    "literalTarget",
  ],
  [
    "ask rule",
    {
      behavior: "ask",
      message: "rule",
      decisionReason: {
        type: "rule",
        rule: {
          source: "projectSettings",
          ruleBehavior: "ask",
          ruleValue: { toolName: "Bash" },
        },
      },
    },
    "literalTarget",
  ],
  [
    "ordinary ask",
    {
      behavior: "ask",
      message: "plain",
      decisionReason: { type: "other", reason: "plain" },
    },
    null,
  ],
  ["allow", { behavior: "allow", updatedInput: { command: "" } }, null],
])(
  "a removal with arguments after a redirect is reread; a %s rereading answers %p",
  async (_label, decision, expected) => {
    const f = owner(decide(decision));
    const result = await f.scan("rm >/dev/null -rf $X");
    const actual: string | null = result === null ? null : result.kind;
    expect(actual).toBe(expected);
  },
);

test("a rereading that fails to finish holds the command for review", async () => {
  const f = owner(async () => {
    throw new Error("checker crashed");
  });
  expect((await f.scan("rm >/dev/null -rf $X"))?.kind).toBe(
    "nestedSpansOverrun",
  );
});

test("a reporter that is itself missing a capability is not swallowed", async () => {
  const f = owner();
  f.host.processEnvironment = () => {
    throw new Error("environment failed");
  };
  f.host.reportError = () => ({
    status: "unsupported",
    dependency: "errors.report",
    reason: "not supplied",
  });
  expect(f.scan('rm -rf "$BUILD/etc"')).rejects.toThrow("errors.report");
});
