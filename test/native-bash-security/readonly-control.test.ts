import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import { policy } from "./security-fixture.js";
import {
  NativePermissionDependencyError,
  type NativePermissionFact as Fact,
  type NativePermissionScope as Scope,
} from "../../src/native-permission-outcome.js";
import { createNativeBashReadonlyProfiles } from "../../src/native-bash-security/readonly-profiles.js";
import {
  createNativeBashReadonlyControl,
  type NativeBashReadonlyHost,
} from "../../src/native-bash-security/readonly-control.js";
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
function fixture() {
  const f = createSecurityProcessFixture();
  const reads: string[] = [];
  const profiles = createNativeBashReadonlyProfiles(f.process, {
    safeFeature: (_key, _safe, s) => known(true, s),
  });
  const host: NativeBashReadonlyHost = {
    disklessLaunch: (s) => {
      reads.push("diskless");
      return known(false, s);
    },
    currentCwd: (s) => {
      reads.push("cwd");
      return known(s.cwd, s);
    },
    originalCwd: (s) => known("/work", s),
    projectRoot: (s) => known("/work", s),
    lastCheckedSessionEnvVarKeys: (s) => {
      reads.push("last-env");
      return known(new Set(), s);
    },
    safeFeature: (key, _safe, s) => {
      reads.push(key);
      return known(true, s);
    },
    bareRepositoryInspection: (s) => {
      reads.push("bare-repo");
      return known(false, s);
    },
    cloudRemoteSurface: (s) => known(false, s),
    checkoutProbe: (_cwd, _may, s) => known("none", s),
    checkoutTrusted: (_cwd, s) => known(false, s),
    checkoutSessionTrusted: (_cwd, s) => known(false, s),
    startupAdditionalDirectoriesSupported: (s) => known(true, s),
  };
  const readonly = createNativeBashReadonlyControl(profiles, host);
  const run = <T>(fn: () => T) =>
    readonly.withPolicyScope(policy(), "/work", fn).result;
  const context = () => f.outerContext();
  return {
    ...f,
    readonly,
    readonlyHost: host,
    readonlyReads: reads,
    readonlyRun: run,
    readonlyCheck: (command: string) =>
      run(() => readonly.isReadOnly({ command }, context())),
  };
}

test("complete native readonly classifier accepts ordinary source forms and rejects redirection, network and compound execution", () => {
  const f = fixture();
  for (const command of [
    "echo hello",
    "cat file",
    "grep -n needle file",
    "git status",
    "sed -n '1,3p' file",
  ]) {
    expect(f.readonlyCheck(command)).toBe(true);
  }
  for (const command of [
    "echo hello > output",
    "echo hello &",
    "(echo hello)",
    "{ echo hello; }",
    "cat < /dev/tcp/host/80",
    "sed -i 's/x/y/' file",
    "cd sub && git status",
  ]) {
    expect(f.readonlyCheck(command)).toBe(false);
  }
  expect(f.readonlyCheck("echo hello > /dev/null")).toBe(true);
  expect(f.readonlyCheck("echo hello 2>&1")).toBe(true);
});

test("native readonly caller reads actual diskless before env keys and preserves context versus global key owner", () => {
  const f = fixture();
  expect(
    f.readonlyRun(() => f.readonly.isReadOnly({ command: "echo hello" })),
  ).toBe(true);
  expect(f.readonlyReads.slice(0, 2)).toEqual(["diskless", "last-env"]);
  f.readonlyReads.length = 0;
  expect(f.readonlyCheck("echo hello")).toBe(true);
  expect(f.readonlyReads).not.toContain("last-env");
  f.readonlyHost.disklessLaunch = (s) => {
    f.readonlyReads.push("diskless");
    return known(true, s);
  };
  f.readonlyReads.length = 0;
  expect(
    f.readonlyRun(() => f.readonly.isReadOnly({ command: "echo hello" })),
  ).toBe(false);
  expect(f.readonlyReads).toEqual(["diskless"]);
  const reason = f.readonlyRun(() =>
    f.readonly.notReadOnlyReason({ command: "echo hello" }),
  );
  expect(reason?.everyInput).toBe(true);
});

test("native readonly environment and semantic observations keep actual variable and assignment restrictions", () => {
  const f = fixture();
  expect(f.readonlyCheck("echo '$literal'")).toBe(true);
  expect(f.readonlyCheck('echo "$unknown"')).toBe(false);
  expect(f.readonlyCheck("LD_PRELOAD=module echo hello")).toBe(false);
  expect(f.readonlyCheck("GIT_SSH_COMMAND=program git status")).toBe(false);
  const context = f.outerContext();
  context.sessionEnvVars = new Map([["EXPORTED", "present"]]);
  expect(
    f.readonlyRun(() =>
      f.readonly.isReadOnly(
        { command: "EXPORTED=changed; echo okay" },
        context,
      ),
    ),
  ).toBe(false);
});

test("native readonly which fallback marks the shared by-name observer and only admits its reread", async () => {
  const f = fixture();
  const command = "which --not-a-safe-flag echo";
  const original = await f.readonlyRun(() =>
    f.process.observations.native.qat(() =>
      f.readonly.isReadOnly({ command }, f.outerContext()),
    ),
  );
  expect(original.verdict).toBe(false);
  expect(original.refused).toBe(true);
  const reread = await f.readonlyRun(() =>
    f.process.observations.native.qat(
      () => f.readonly.isReadOnly({ command }, f.outerContext()),
      { byName: true },
    ),
  );
  expect(reread.verdict).toBe(true);
  expect(reread.refused).toBe(false);
  expect(f.process.observations.contexts.byName.getStore()).toBeUndefined();
});

test("native readonly checkout warnings are deferred into the actual shared first-checkout observation", async () => {
  const f = fixture();
  f.readonlyHost.projectRoot = (s) => known("/project", s);
  f.readonlyHost.checkoutProbe = (_cwd, _may, s) =>
    known({ checkout: "/untrusted/雪" }, s);
  const plain = f.readonlyCheck("git status");
  expect(plain).toBe(false);
  const observed = await f.readonlyRun(() =>
    f.process.observations.native.Ekn(() =>
      f.readonly.isReadOnly({ command: "git status" }, f.outerContext()),
    ),
  );
  expect(observed.result).toBe(true);
  expect(observed.untrustedCheckout).toContain("/untrusted/雪");
  expect(observed.untrustedCheckout).toContain("--add-dir");
  expect(f.process.observations.contexts.checkout.getStore()).toBeUndefined();
});

test("native bare-repository inspection and actual metadata capabilities are never substituted with default safety", () => {
  const f = fixture();
  f.readonlyHost.bareRepositoryInspection = (s) => known("bare-indicators", s);
  expect(f.readonlyCheck("git status")).toBe(false);
  delete f.readonlyHost.bareRepositoryInspection;
  expect(() => f.readonlyCheck("git status")).toThrow(
    NativePermissionDependencyError,
  );
  delete f.readonlyHost.disklessLaunch;
  expect(() => f.readonlyCheck("echo hello")).toThrow(
    NativePermissionDependencyError,
  );
});

test("native offline estimate bypasses only its explicit host checks and keeps real command policy restrictions", () => {
  const f = fixture();
  delete f.readonlyHost.bareRepositoryInspection;
  delete f.readonlyHost.disklessLaunch;
  expect(f.readonlyRun(() => f.readonly.native.jxi("git status"))).toBe(true);
  expect(
    f.readonlyRun(() => f.readonly.native.jxi("sed -i 's/x/y/' file")),
  ).toBe(false);
  expect(f.readonlyRun(() => f.readonly.native.jxi("echo okay > out"))).toBe(
    false,
  );
  const result = f.readonlyRun(() =>
    f.readonly.native.XWt({ command: "x".repeat(10001) }, false),
  );
  expect(result).toEqual({
    behavior: "passthrough",
    message: "Command too long for read-only analysis",
  });
});

test("native readonly reason retains the first failing semantic command and parser guard presence", async () => {
  const f = fixture();
  const value = f.readonlyRun(() =>
    f.readonly.notReadOnlyReason(
      { command: "echo hello; touch file" },
      f.outerContext(),
    ),
  );
  expect(value?.part).toBe("touch file");
  const command =
    "while false; do ".repeat(6) + "echo okay; " + "done; ".repeat(6);
  expect(f.readonlyCheck(command)).toBe(false);
  const result = await f.process.semantic.parser.features.observeMayDiffer(() =>
    f.readonlyRun(() => f.readonly.native.PWo({ command }, new Set())),
  );
  expect(result.result).toMatchObject({ behavior: "allow" });
  expect(f.process.semantic.parser.features.hasMayDifferObservation()).toBe(
    false,
  );
});
