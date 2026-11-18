import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import { policy } from "./security-fixture.js";
import type {
  NativePermissionFact as Fact,
  NativePermissionScope as Scope,
} from "../../../src/native-permission-outcome.js";
import { createNativeBashReadonlyProfiles } from "../../../src/native-bash-security/readonly-profiles.js";
import {
  createNativeBashReadonlyControl,
  type NativeBashReadonlyHost,
} from "../../../src/native-bash-security/readonly-control.js";

function known<T>(value: T, scope: Scope): Fact<T> {
  return {
    status: "known",
    value,
    provenance: {
      provider: "authored-readonly-control-facts",
      sourceContracts: ["Ks.isReadOnly/ABt/PWo/XWt"],
      scope,
    },
  };
}

function fixture(
  options: { sandbox?: boolean; host?: Partial<NativeBashReadonlyHost> } = {},
) {
  const f = createSecurityProcessFixture();
  const sandbox = f.hosts.policy.sandbox;
  if (options.sandbox === true && sandbox !== undefined)
    f.hosts.policy.sandbox = (permission, s) => {
      const fact = sandbox(permission, s);
      return fact.status === "known"
        ? known({ ...fact.value, enabled: true }, s)
        : fact;
    };
  const profiles = createNativeBashReadonlyProfiles(f.process, {
    safeFeature: (_key, _safe, s) => known(true, s),
  });
  const host: NativeBashReadonlyHost = {
    disklessLaunch: (s) => known(false, s),
    currentCwd: (s) => known(s.cwd, s),
    originalCwd: (s) => known("/work", s),
    projectRoot: (s) => known("/work", s),
    lastCheckedSessionEnvVarKeys: (s) => known(new Set(), s),
    safeFeature: (_key, _safe, s) => known(true, s),
    bareRepositoryInspection: (s) => known(false, s),
    cloudRemoteSurface: (s) => known(false, s),
    checkoutProbe: (_cwd, _may, s) => known("none", s),
    checkoutTrusted: (_cwd, s) => known(false, s),
    checkoutSessionTrusted: (_cwd, s) => known(false, s),
    startupAdditionalDirectoriesSupported: (s) => known(true, s),
    ...options.host,
  };
  const readonly = createNativeBashReadonlyControl(profiles, host);
  return (command: string) =>
    readonly.withPolicyScope(policy(), "/work", () =>
      readonly.notReadOnlyReason({ command }, f.outerContext()),
    ).result;
}

const notReadOnly =
  "Command is not read-only, requires further permission checks";

test("each command of the input must be a plain read without unsafe redirects, appends or user homes", () => {
  const reason = fixture();
  const rows: readonly (readonly [
    string,
    { message: string; part?: string } | undefined,
  ])[] = [
    ["git status >&2", undefined],
    ["cat file > /dev/null 2>&1", undefined],
    ["cat <<< hi", undefined],
    ["cat ~/file", undefined],
    ["cat '*'; ls *", undefined],
    ["grep needle *", undefined],
    ["command ls", undefined],
    ["command -p cat file", undefined],
    ["builtin -- echo hi", undefined],
    ["timeout 5s cat file", undefined],
    ["which -a ls", undefined],
    ["sha256sum -c sums", undefined],
    ["cat < /dev/tcp/host/80", { message: notReadOnly, part: "cat" }],
    // `X+=1 cmd` appends to an inherited value the check cannot see.
    ["X+=1 echo hi", { message: notReadOnly, part: "X+=1 echo hi" }],
    // ~user names another account's home directory.
    ["cat ~user/file", { message: notReadOnly, part: "cat ~user/file" }],
    ["cat < ~user/file", { message: notReadOnly, part: "cat" }],
    ["rm *", { message: notReadOnly, part: "rm *" }],
    ["noglob rm x", { message: notReadOnly, part: "noglob rm x" }],
    ["timeout 5 rm file", { message: notReadOnly, part: "timeout 5 rm file" }],
    [
      "timeout 5 [ -f x ]",
      { message: notReadOnly, part: "timeout 5 [ -f x ]" },
    ],
    [
      "sha256sum __CMDSUB_OUTPUT__",
      { message: notReadOnly, part: "sha256sum __CMDSUB_OUTPUT__" },
    ],
    // With no command there is nothing to name as the failing part.
    ["", { message: notReadOnly }],
    ["# only a comment", { message: notReadOnly }],
  ];
  for (const [command, expected] of rows)
    expect({ command, reason: reason(command) }).toEqual({
      command,
      reason: expected,
    });
});

test("variables, loops and git-internal file creation are refused before per-command checks", () => {
  const reason = fixture();
  expect(reason("x=a; cat ${x}")?.message).toStartWith(
    "Not a simple read-only command:",
  );
  expect(reason("for f in a b; do cat $f; done")?.message).toStartWith(
    "Not a simple read-only command:",
  );
  expect(reason("touch HEAD && git status")).toEqual({
    message:
      "Compound commands that create git internal files and run git require permission checks for enhanced security",
  });
  expect(reason("x".repeat(10001))).toEqual({
    message: "Command too long for read-only analysis",
  });
});

test("under a sandbox, git-program variables and git outside the original directory need approval", () => {
  expect(fixture({ sandbox: true })("GIT_SSH_COMMAND=x; git status")).toEqual({
    message: "This command sets a variable that can make git run a program",
  });
  expect(fixture({ sandbox: true })("git status")).toBeUndefined();
  const moved = fixture({
    sandbox: true,
    host: { currentCwd: (s) => known("/work/sub", s) },
  });
  expect(moved("git status")).toEqual({
    message:
      "Git commands outside the original working directory require permission checks when sandbox is enabled",
  });
  expect(moved("cat file")).toBeUndefined();
});

test("a .git redirect that an archive could plant makes git need approval", () => {
  const reason = fixture({
    host: {
      bareRepositoryInspection: (s) => known("gitdir-redirect-plantable", s),
    },
  });
  expect(reason("git status")?.message).toStartWith(
    "The .git file or symlink here redirects to a location Claude cannot verify",
  );
  expect(reason("cat file")).toBeUndefined();
});

test("a diskless launch verifies no command as read-only", () => {
  const reason = fixture({ host: { disklessLaunch: (s) => known(true, s) } });
  expect(reason("cat file")).toEqual({
    message:
      "This session runs shell commands only in its cloud environment, so none can be verified as read-only here",
    everyInput: true,
  });
});

test("git outside the project asks about a repository it cannot match, unless that repository is trusted", () => {
  const away = (host: Partial<NativeBashReadonlyHost>) =>
    fixture({
      host: {
        projectRoot: (s) => known("/project", s),
        checkoutProbe: (_cwd, _may, s) => known({ checkout: "/other" }, s),
        ...host,
      },
    })("git status");
  expect(
    away({ checkoutProbe: (_cwd, _may, s) => known("unexaminable", s) }),
  ).toEqual({
    message:
      "Claude Code cannot tell which repository git would use here, and a repository's settings can make git run programs.",
  });
  expect(
    away({ checkoutProbe: (_cwd, _may, s) => known("none", s) }),
  ).toBeUndefined();
  expect(
    away({ checkoutTrusted: (_cwd, s) => known(true, s) }),
  ).toBeUndefined();
  expect(away({ projectRoot: (s) => known("/work", s) })).toBeUndefined();
  expect(away({ cloudRemoteSurface: (s) => known(true, s) })).toBeUndefined();
  expect(
    away({
      safeFeature: (key, _safe, s) =>
        known(key !== "bot_protected_tengu_frolicking_pelican", s),
    }),
  ).toBeUndefined();

  const sessionTrusted = away({
    checkoutSessionTrusted: (_cwd, s) => known(true, s),
  });
  expect(sessionTrusted?.message).toContain(
    "If you trust it, name it with --add-dir at the start",
  );
  expect(sessionTrusted?.message).not.toContain("accept the trust dialog");
  const noStartupDirectories = away({
    startupAdditionalDirectoriesSupported: (s) => known(false, s),
  });
  expect(noStartupDirectories?.message).toContain(
    "An allow rule for git would apply in every repository.",
  );
  expect(noStartupDirectories?.message).not.toContain("--add-dir");
  // Control characters and runs of spaces in the folder are masked.
  expect(
    away({
      checkoutProbe: (_cwd, _may, s) =>
        known({ checkout: "/x/a\u0007b  c" }, s),
    })?.message,
  ).toEndWith('Its folder: "/x/a?b?c"');
});
