import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import type {
  NativePermissionScope as Scope,
  NativePermissionFact as Fact,
} from "../../../src/native-permission-outcome.js";
import { createNativeBashReadonlyProfiles } from "../../../src/native-bash-security/readonly-profiles.js";
import { policy } from "./security-fixture.js";

function known<T>(value: T, scope: Scope): Fact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-readonly-profile",
      sourceContracts: ["YSn/vQn/hct"],
      scope,
    },
  };
}

function fixture() {
  const f = createSecurityProcessFixture();
  const profiles = createNativeBashReadonlyProfiles(f.process, {
    safeFeature: (_key, _safe, scope) => known(true, scope),
  });
  const run = <T>(fn: () => T) =>
    profiles.withPolicyScope(policy(), "/work", fn).result;
  return {
    read: (text: string) => run(() => profiles.native.rMr(text)),
  };
}

// Each row is [command, whether the profile admits it as read-only].
function expectReadonly(rows: readonly (readonly [string, boolean])[]) {
  const f = fixture();
  for (const [command, readonly] of rows)
    expect({ command, readonly: f.read(command) }).toEqual({
      command,
      readonly,
    });
}

test("the readonly flag engine admits only declared flags with well-typed values", () => {
  expectReadonly([
    // A lone dash is the stdin operand, not a flag.
    ["sort -", true],
    // A dash followed by punctuation is still an undeclared flag.
    ["sort -. file", false],
    // Short bundles may only combine flags that take no value.
    ["sort -rn file", true],
    ["sort -rk 2 file", false],
    // A no-value flag cannot be given a value.
    ["sort --reverse=yes file", false],
    // A value flag needs a value that is not itself a flag.
    ["sort -k", false],
    ["sort -k -r file", false],
    ["sort -k '' file", true],
    // Numeric flags take digits only.
    ["sort --parallel=4 file", true],
    ["sort --parallel=x file", false],
    // After the end-of-options marker every word is an operand.
    ["sort -- -r", true],
    // grep accepts a value attached to a short value flag.
    ["grep -e5 file", true],
    ["grep -iA needle file", false],
    ["grep -A -1 needle file", false],
    ["grep -e '' file", true],
    // String values may not begin with a dash, except git sort keys.
    ["git log --grep=-x", false],
    ["git tag --sort=-v:refname", true],
    ["git branch --sort=--x", false],
    // git accepts the numeric -<n> count shorthand.
    ["git log -5", true],
    ["git reflog -5", true],
    // An empty word is an empty operand.
    ["git log ''", true],
  ]);
});

test("command substitution and spoofed expansion markers never count as literal text", () => {
  expectReadonly([
    ["grep -e `id` file", false],
    ["grep needle `id`", false],
    ["grep -e __CMDSUB_OUTPUT__ file", false],
    ["grep needle __TRACKED_VAR__", false],
    ["grep needle __UNCERTAIN_VAR__", false],
    // Brace expansion multiplies operands the profile never saw.
    ["grep needle {a,b}", false],
    ["grep needle {a}", true],
    // A single-quoted dollar is literal, but the profile still fails closed.
    ["grep 'end$' file", false],
    ["", false],
    ["$(id)", false],
    // Newlines end the grep command, so a pattern cannot contain one.
    ["rg 'a\nb' file", false],
  ]);
});

test("xargs only runs a known readonly target command", () => {
  expectReadonly([
    ["xargs", true],
    ["xargs --", false],
    ["xargs -- grep needle", true],
    ["xargs -0 grep -l needle", true],
    ["xargs -n1 -- rm", false],
    ["xargs -I {} cat {}", false],
    ["xargs -I {} head {}", true],
    ["xargs -E EOF echo", true],
    ["xargs -d , wc -l", true],
    ["xargs -d ,, wc -l", false],
  ]);
});

test("git format and sort values reject signature checks and configured aliases", () => {
  expectReadonly([
    ["git log --format oneline", true],
    ["git log --pretty fuller", true],
    // A bare name other than a builtin format is a configured pretty alias.
    ["git log --pretty myalias", false],
    ["git log --format=", true],
    ["git log --format=%h", true],
    ["git log --pretty=format:%s", true],
    ["git log --pretty=tformat:%s", true],
    ["git log --pretty=format:short", true],
    ["git log --format", false],
    // Signature placeholders and keys run gpg verification.
    ["git log --format=%GS", false],
    ["git branch --sort=signature", false],
    ["git for-each-ref '--format=%(signature)'", false],
    // A tilde value expands to a home path.
    ["git branch --sort=~x", false],
  ]);
});

test("git reflog, remote and ls-remote stay within their read-only subcommands", () => {
  expectReadonly([
    ["git reflog", true],
    ["git reflog show HEAD", true],
    ["git reflog list", true],
    ["git reflog topic", false],
    ["git reflog show delete", false],
    ["git remote", true],
    ["git remote -v", true],
    ["git remote --verbose", true],
    ["git remote add origin url", false],
    ["git remote show -n -- origin", true],
    ["git remote show -n", false],
    ["git remote show -n origin upstream", false],
    ["git remote show -n ../origin", false],
    // ls-remote queries a remote, so it may name none and pass no options to it.
    ["git ls-remote --tags", true],
    ["git ls-remote --tags --", true],
    ["git ls-remote --sort=-refname", true],
    ["git ls-remote --sort ''", true],
    ["git ls-remote '' --tags", true],
    ["git ls-remote --sort=signature", false],
    ["git ls-remote origin", false],
    ["git ls-remote -- origin", false],
    ["git ls-remote -", false],
    ["git ls-remote -o x", false],
    ["git ls-remote --server-option x", false],
    ["git ls-remote --server-option=x", false],
  ]);
});

test("git tag and git branch accept names only in list mode", () => {
  expectReadonly([
    ["git tag", true],
    ["git tag -l 'v*'", true],
    ["git tag --list -- v1", true],
    ["git tag -il 'v*'", true],
    ["git tag -l --contains HEAD", true],
    ["git tag -l --contains=HEAD 'v*'", true],
    ["git tag -n 5 -l", true],
    ["git tag -l ''", true],
    ["git branch -l ''", true],
    ["git tag -l --sort=signature", false],
    ["git tag v1", false],
    ["git tag -- v1", false],
    ["git branch --merged main", true],
    ["git branch --contains HEAD", true],
    ["git branch -l -- 'feat*'", true],
    ["git branch -al 'feat*'", true],
    ["git branch --list --sort=refname 'feat*'", true],
    ["git branch -- topic", false],
    ["git branch --points-at=HEAD topic", false],
    ["git branch --no-merged=main", false],
  ]);
});

test("brace sequences that would hide operands from the profile are asked before classification", async () => {
  // The readonly projection drops a bare sequence such as {a..a}, so bash's
  // `git branch a` would look like `git branch`. The outer check must ask.
  for (const command of ["git branch {a..a}", "date {0101..0101}"]) {
    const f = createSecurityProcessFixture();
    const decision = await f.check(command);
    expect({
      command,
      behavior:
        decision.status === "resolved" ? decision.outcome.behavior : undefined,
    }).toEqual({ command, behavior: "ask" });
  }
});
