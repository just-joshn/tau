import { expect, test } from "bun:test";
import { posix } from "node:path";
import { createNativeBashSecurityInlineRecursion } from "../../../src/native-bash-security/inline-recursion.js";
import type { NativeBashSecurityDecision as Decision } from "../../../src/native-bash-security/security-types.js";
import { createRecursionFixture, removal } from "./recursion-fixture.js";
import { known, policy } from "./security-fixture.js";

// A shell -c script is judged again as its own command. Statements that ran
// before it in the same command line (assignments, exports, cd) are prepended
// the way the inner shell would see them, so the recursive checker judges
// what the inner shell would actually run. The checker's inputs are what the
// tests observe, together with the returned decision.

type Verdict = "allow" | "removal" | "deny";

function owner(verdict: Verdict = "allow") {
  const calls: string[] = [];
  const f = createRecursionFixture(async (input) => {
    calls.push(input.command);
    if (verdict === "removal") return removal();
    if (verdict === "deny")
      return {
        behavior: "deny",
        decisionReason: { type: "other", reason: "rule denial" },
      };
    return { behavior: "allow", updatedInput: input };
  });
  f.policyHost.protectedRoots = (s) => known([], s);
  f.policyHost.workingDirectories = (_p, s) => known(["/work"], s);
  f.policyHost.nativePathSpelling = (path, s) =>
    known(posix.normalize(path.trim()), s);
  f.policyHost.originalWorkingDirectory = (s) => known("/work", s);
  f.policyHost.pathPrimitive = (_k, path, s) => known(path, s);
  return { ...f, calls };
}

async function judged(command: string, verdict: Verdict = "allow") {
  const f = owner(verdict);
  const result = await f.run(command);
  return { result, calls: f.calls, cwd: f.cwdTransitions };
}

test("an inline-recursion owner over another policy owner is refused", () => {
  const f = owner();
  const g = owner();
  expect(() =>
    createNativeBashSecurityInlineRecursion(f.syntax, g.shapes, {}, () =>
      Promise.resolve({ behavior: "passthrough", message: "" }),
    ),
  ).toThrow("must be shared");
});

test("an inline-shell check outside a policy scope fails loudly", () => {
  const f = owner();
  expect(
    f.recurse.native.JOe("sh -c 'rm -rf /'", f.context("")),
  ).rejects.toThrow("Missing native inline-recursion invariant");
});

test.each<[string, string[]]>([
  // Exported values reach the inner shell.
  ["export X=/; sh -c 'rm -rf $X'", ["export X=/ ; rm -rf $X"]],
  // A plain assignment may or may not reach it, so both readings are judged.
  ["X=/; sh -c 'rm -rf $X'", ["X=/ ; rm -rf $X", "rm -rf $X"]],
  ["X=/; { sh -c 'rm -rf $X'; }", ["X=/ ; rm -rf $X", "rm -rf $X"]],
  // sudo, env -i and exec -c drop the inherited environment, sudo -E keeps it.
  [
    "export X=/; sudo sh -c 'rm -rf $X'",
    ["export X=/ ; rm -rf $X", "rm -rf $X"],
  ],
  ["export X=/; sudo -E sh -c 'rm -rf $X'", ["export X=/ ; rm -rf $X"]],
  [
    "export X=/; env -i sh -c 'rm -rf $X'",
    ["export X=/ ; rm -rf $X", "rm -rf $X"],
  ],
  [
    "export X=/; exec -c sh -c 'rm -rf $X'",
    ["export X=/ ; rm -rf $X", "rm -rf $X"],
  ],
  // Removing the export attribute also yields the reading without it.
  [
    "export X=/; export -n X; sh -c 'rm -rf $X'",
    ["export X=/ ; export -n X ; rm -rf $X", "rm -rf $X"],
  ],
  [
    "export X=/; declare +x X; sh -c 'rm -rf $X'",
    [
      "export X=/ ; declare +x X ; rm -rf $X",
      "export X=/ ; rm -rf $X",
      "rm -rf $X",
    ],
  ],
  // Prefix assignments are exported to the inner shell only.
  ["X=/ sh -c 'rm -rf $X'", ["export X=/ && rm -rf $X"]],
  ["sudo X=/ sh -c 'rm -rf $X'", ["export X=/ && rm -rf $X"]],
  [
    "X='a b' sh -c 'rm -rf $X'",
    ["export X=${__INLINE_SHELL_VALUE__} && rm -rf $X"],
  ],
  // A directory change before the script is replayed in front of it.
  ["cd sub && sh -c 'rm -rf x'", ["cd sub && rm -rf x"]],
  ["cd sub; sh -c 'rm -rf x'", ["cd sub ; rm -rf x"]],
  [
    "cd sub; cd x; sh -c 'rm -rf x'",
    ['cd "${__INLINE_SHELL_VALUE__}" ; rm -rf x'],
  ],
  ["sh -c 'cd /; rm -rf x'", ["cd /; rm -rf x"]],
  // A login shell or a non-&& chain does not simply inherit the directory.
  ["cd /work/sub && sudo -i sh -c 'rm -rf x'", ["cd /work/sub && rm -rf x"]],
  [
    "cd /work/sub && sudo --login sh -c 'rm -rf x'",
    ["cd /work/sub && rm -rf x"],
  ],
  ["cd /work/sub; sh -c 'rm -rf x'", ["cd /work/sub ; rm -rf x"]],
  // After a mixed && / || chain the script may run without the exports.
  [
    "export X=/ && true || sh -c 'rm -rf $X'",
    ["export X=/ ; rm -rf $X", "rm -rf $X"],
  ],
  ["sh -c 'source x'; sh -c 'rm -rf x'", ["rm -rf x"]],
  [`sh -c 'echo $'"'"'a'"'"''`, ["echo $'a'"]],
  ["sh -c 'rm -rf x'", ["rm -rf x"]],
  ["echo hi | sh -c 'rm -rf x'", ["rm -rf x"]],
  // Parent-shell expansion inside double quotes happens before the script.
  ['X=/; sh -c "rm -rf $X"', ["rm -rf /"]],
  ['export X=/; bash -c "rm -rf $X"', ["rm -rf /"]],
  ['X=/ ; unset X; sh -c "rm -rf $X"', ["rm -rf "]],
  ['X+=a; sh -c "rm -rf $X"', ["rm -rf a"]],
  ['X=/; export Y=1; sh -c "rm -rf $X$Y"', ["rm -rf /1"]],
  ['X=/ && sh -c "rm -rf $X" || true', ["rm -rf /"]],
  ['X=/; (Y=1 && Z=2); sh -c "rm -rf $X"', ["rm -rf /"]],
  ['read X; sh -c "rm -rf $X"', ["rm -rf ${__INLINE_SHELL_VALUE__}"]],
  ['eval X=/; sh -c "rm -rf $X"', ["rm -rf ${__INLINE_SHELL_VALUE__}"]],
  ['declare -n X=Y; sh -c "rm -rf $X"', ["rm -rf ${__INLINE_SHELL_VALUE__}"]],
  ['X=$(pwd); sh -c "rm -rf $X"', ["rm -rf ${__INLINE_SHELL_VALUE__}"]],
  ["X=$'\\x2f'; sh -c \"rm -rf $X\"", ["rm -rf ${__INLINE_SHELL_VALUE__}"]],
  ['sh -c "rm -rf $(pwd)"', ["rm -rf $(__CMDSUB__)"]],
  [
    'X+=a sh -c "rm -rf $X"',
    ["export X+=a && rm -rf ${__INLINE_SHELL_VALUE__}"],
  ],
])("%p judges the inner script as %p", async (command, expected) => {
  const { result, calls } = await judged(command);
  expect(result).toBeNull();
  expect(calls).toEqual(expected);
});

test("a cd into a known working directory runs the inner check from there", async () => {
  const { calls, cwd } = await judged("cd /work/sub && sh -c 'rm -rf x'");
  expect(calls).toEqual(["rm -rf x"]);
  expect(cwd).toEqual(["/work/sub"]);
});

test("a cd into a working directory and a prefix assignment combine", async () => {
  const { calls, cwd } = await judged("cd /work/sub && X=1 sh -c 'rm -rf x'");
  expect(calls).toEqual(["export X=1 && rm -rf x"]);
  expect(cwd).toEqual(["/work/sub"]);
});

test("a command bound for remote execution keeps the cd in the script", async () => {
  const f = owner();
  const command = "cd /work/sub && sh -c 'rm -rf x'";
  const state = f.context(command);
  state.context.forRemoteExecution = true;
  await f.run(command, state);
  expect(f.calls).toEqual(["cd /work/sub && rm -rf x"]);
  expect(f.cwdTransitions).toEqual([]);
});

test("a clean answer is cached too", async () => {
  const f = owner();
  const state = f.context("x");
  expect(await f.run("sh -c 'rm -rf x'", state)).toBeNull();
  expect(await f.run("sh -c 'rm -rf x'", state)).toBeNull();
  expect(f.calls).toEqual(["rm -rf x"]);
});

test("a removal found below the top level is still reported", async () => {
  const f = owner("removal");
  const state = { ...f.context("x"), depth: 1 };
  const result = await f.run("sh -c 'rm -rf /'", state);
  expect(result?.decisionReason).toMatchObject({
    circuitBreaker: "dangerousRemoval",
  });
});

test("semantic commands that the text split did not reach are judged too", async () => {
  const f = owner("removal");
  const analyzed = await f.semantic.analyze("sh -c 'rm -rf /'");
  if (analyzed.kind !== "simple") throw new Error(analyzed.reason);
  const state = f.context("true");
  const result = await f.recurse.withPolicyScope(policy(), "/work", () =>
    f.recurse.native.JOe("true", state, [], analyzed.commands),
  ).result;
  expect(f.calls).toEqual(["rm -rf /"]);
  expect(result?.behavior).toBe("ask");
});

test("a dangerous inner removal is reported as a shell -c removal", async () => {
  const { result, calls } = await judged(
    "export X=/; sh -c 'rm -rf $X'",
    "removal",
  );
  expect(calls).toEqual(["export X=/ ; rm -rf $X"]);
  expect(result?.behavior).toBe("ask");
  expect(result?.decisionReason).toMatchObject({
    circuitBreaker: "dangerousRemoval",
  });
  expect(result?.message).toContain("shell -c script");
});

test.each([
  ['X=/ & sh -c "rm -rf $X"'],
  ['export X=/ & sh -c "rm -rf $X"'],
  ["sh -c $'rm -rf /'"],
  ["eval \"$Y\"; sh -c 'rm -rf $X'"],
])("%p runs rm in a script that cannot be checked", async (command) => {
  const { result, calls } = await judged(command);
  expect(calls).toEqual([]);
  expect(result?.behavior).toBe("ask");
  expect(result?.decisionReason).toMatchObject({
    classifierApprovable: false,
  });
  expect(result?.message).toContain("could not");
});

test("a denied inner script that removes is held for explicit approval", async () => {
  const { result } = await judged("X=/; sh -c 'rm -rf $X'", "deny");
  expect(result?.behavior).toBe("ask");
  expect(result?.message).toContain("permission rule denies");
});

test("the inline-shell removal check can be switched off", async () => {
  const f = owner("removal");
  f.setDisabled(true);
  expect(await f.run("sh -c 'rm -rf /'")).toBeNull();
  const g = owner("removal");
  g.policyHost.feature = (key, _fallback, s) =>
    known(
      key === "tengu_bright_lake"
        ? { value: false, source: "payload" }
        : { value: true, source: "authored-test" },
      s,
    );
  expect(await g.run("sh -c 'rm -rf /'")).toBeNull();
  expect(f.calls).toEqual([]);
  expect(g.calls).toEqual([]);
});

test("deeply nested groups stop recursing and hold a removing script", async () => {
  const open = "{ ".repeat(9);
  const close = " ; }".repeat(9);
  const { result, calls } = await judged(`${open}sh -c 'rm -rf /'${close}`);
  expect(calls).toEqual([]);
  expect(result?.behavior).toBe("ask");
});

test("an answer already reached for the same script and history is reused", async () => {
  const f = owner("removal");
  const state = f.context("x");
  const first = await f.run("sh -c 'rm -rf /'", state);
  const second = await f.run("sh -c 'rm -rf /'", state);
  expect(second).toBe(first);
  expect(f.calls).toEqual(["rm -rf /"]);
});

test("a decision that reaches the inner shell budget is not judged again", async () => {
  const f = owner("allow");
  const state = f.context("x");
  state.budget.chars = 3;
  const result = await f.run("sh -c 'rm -rf /'", state);
  expect(f.calls).toEqual([]);
  expect(result?.behavior).toBe("ask");
});

test.each<[string, Decision]>([
  [
    "a nested subcommand removal",
    {
      behavior: "passthrough",
      message: "",
      decisionReason: {
        type: "subcommandResults",
        reasons: new Map([["rm (removal)", removal()]]),
      },
    },
  ],
])("%s inside the inner script is reported", async (_label, decision) => {
  const f = createRecursionFixture(async () => decision);
  const result = await f.run("sh -c 'rm -rf /'");
  expect(result?.decisionReason).toMatchObject({
    circuitBreaker: "dangerousRemoval",
  });
  expect(result?.behavior).toBe("ask");
  expect(f.recurse.withPolicyScope(policy(), "/work", () => 1).result).toBe(1);
});
