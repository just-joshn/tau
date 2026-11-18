import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import {
  NativePermissionDependencyError,
  type NativePermissionScope as Scope,
  type NativePermissionFact as Fact,
} from "../../src/native-permission-outcome.js";
import {
  createNativeBashReadonlyProfiles,
  type NativeBashReadonlyProfileHost,
} from "../../src/native-bash-security/readonly-profiles.js";
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
  const reads: string[] = [];
  const host: NativeBashReadonlyProfileHost = {
    safeFeature: (key, _safe, scope) => {
      reads.push(key);
      return known(true, scope);
    },
  };
  const profiles = createNativeBashReadonlyProfiles(f.process, host);
  const run = <T>(fn: () => T) =>
    profiles.withPolicyScope(policy(), "/work", fn).result;
  return {
    ...f,
    profiles,
    profileHost: host,
    profileReads: reads,
    profileRun: run,
    read: (text: string) => run(() => profiles.native.rMr(text)),
    fast: (args: string[]) => run(() => profiles.native.fMr(args)),
  };
}

test("complete readonly profiles preserve native git subcommand and callback restrictions", () => {
  const f = fixture();
  expect(f.read("git diff --stat")).toBe(true);
  expect(f.read("git log --format=oneline")).toBe(true);
  expect(f.read("git log --format=arbitrary_named_format")).toBe(false);
  expect(f.read("git log --format=%G?")).toBe(false);
  expect(f.read("git reflog show")).toBe(true);
  expect(f.read("git reflog expire")).toBe(false);
  expect(f.read("git remote show -n origin")).toBe(true);
  expect(f.read("git remote show origin")).toBe(false);
  expect(f.read("git branch --list topic")).toBe(true);
  expect(f.read("git branch topic")).toBe(false);
  expect(f.read("git status --porcelain")).toBe(true);
  expect(f.read("git status --exec-path=evil")).toBe(false);
});

test("native readonly flag engine retains value types, attached forms, bundles and xargs target boundary", () => {
  const f = fixture();
  const h = f.profiles.native.hct;
  expect(
    f.profileRun(() =>
      h(
        ["rg", "-A3", "needle", "file"],
        1,
        f.profiles.profiles.rg ?? { safeFlags: {} },
        { commandName: "rg" },
      ),
    ),
  ).toBe(true);
  expect(f.read("rg --max-count=-1 needle file")).toBe(false);
  expect(f.read("rg --max-count=3 needle file")).toBe(true);
  expect(f.read("rg -in needle file")).toBe(true);
  expect(f.read("rg -inA3 needle file")).toBe(false);
  expect(f.read("git branch --sort=-committerdate")).toBe(true);
  expect(f.read("xargs -n 2 echo")).toBe(true);
  expect(f.read("xargs -n 2 rm")).toBe(false);
  expect(f.read("xargs -- echo")).toBe(true);
  expect(f.read("xargs -- rm")).toBe(false);
  expect(f.profiles.native.Yl("9", "number")).toBe(true);
  expect(f.profiles.native.Yl("-9", "number")).toBe(false);
  expect(f.profiles.native.Yl("雪", "char")).toBe(true);
  expect(f.profiles.native.Yl("😀", "char")).toBe(false);
  expect(f.profiles.native.Yl("anything", "none")).toBe(false);
  expect(f.profiles.native.Yl("{}", "{}")).toBe(true);
  expect(f.profiles.native.Yl("target", "{}")).toBe(false);
  expect(f.profiles.native.Yl("EOF", "EOF")).toBe(true);
  expect(f.profiles.native.Yl("END", "EOF")).toBe(false);
});

test("readonly command profiles retain source sed, sort, docker and grep differences", () => {
  const f = fixture();
  expect(f.read("sed -n '1,3p' file")).toBe(true);
  expect(f.read("sed -i 's/x/y/' file")).toBe(false);
  expect(f.read("sed 's/x/y/e' file")).toBe(false);
  expect(f.read("sort --reverse file")).toBe(true);
  expect(f.read("sort --output=result file")).toBe(false);
  expect(f.read("docker logs --tail=10 container")).toBe(true);
  expect(f.read("docker logs --host=tcp://host container")).toBe(false);
  expect(f.read("grep --line-number needle file")).toBe(true);
  expect(f.read("grep 'needle\nother' file")).toBe(false);
  expect(f.read("date -s 2026-11-18")).toBe(false);
});

test("native fast readonly commands retain explicit printf numeric hazards and find actions", () => {
  const f = fixture();
  expect(f.fast(["pwd"])).toBe(true);
  expect(f.fast(["pwd", "extra"])).toBe(false);
  expect(f.fast(["echo", "anything"])).toBe(true);
  expect(f.fast(["printf", "%s", "text"])).toBe(true);
  expect(f.fast(["printf", "%n", "name[code]"])).toBe(false);
  expect(f.fast(["printf", "%d", "42"])).toBe(true);
  expect(f.fast(["printf", "%d", "1[code]"])).toBe(false);
  expect(f.fast(["printf", "-v", "target", "%s", "text"])).toBe(false);
  expect(f.fast(["find", ".", "-name", "*.ts"])).toBe(true);
  expect(f.fast(["find", ".", "-delete"])).toBe(false);
  expect(f.fast(["find", ".", "-exec", "command", ";"])).toBe(false);
  expect(f.fast(["unknown-command"])).toBeNull();
});

test("native man section profile records actual shared path-list refusal and honors its reread scope", async () => {
  const f = fixture();
  const refused = await f.profileRun(() =>
    f.process.observations.native.Mat(false, () =>
      f.profiles.native.rMr("man -S '../section' page"),
    ),
  );
  expect(refused.result).toBe(false);
  expect(refused.refused).toBe(true);
  expect(refused.pathListRefused).toBe(false);
  const accepted = await f.profileRun(() =>
    f.process.observations.native.Mat(true, () =>
      f.profiles.native.rMr("man -S '../section' page"),
    ),
  );
  expect(accepted.result).toBe(true);
  expect(accepted.refused).toBe(false);
  expect(f.process.policy.contexts.pathList.getStore()).toBeUndefined();
  expect(f.profileReads).toContain("tengu_tender_thunder");
});

test("native profile missing features and stale facts propagate instead of permitting unknown options", () => {
  const f = fixture();
  delete f.profileHost.safeFeature;
  expect(() => f.read("file -? target")).toThrow(
    NativePermissionDependencyError,
  );
  f.profileHost.safeFeature = (_key, _safe, scope) =>
    known(true, { ...scope, policyId: "wrong" });
  expect(() => f.read("file -? target")).toThrow(
    NativePermissionDependencyError,
  );
});

test("native readonly text scan retains quoting, comments, continuations and literal glob categories", () => {
  const f = fixture(),
    scan = f.profiles.native.Aat;
  expect(scan("echo '$value'")).toBe(false);
  expect(scan('echo "$value"')).toBe("variable");
  expect(scan("echo glob*name")).toBe("glob");
  expect(scan("echo 'glob*name'")).toBe(false);
  expect(scan("echo name # $ignored\n")).toBe(false);
  expect(scan("echo \\\nname")).toBe(false);
  expect(scan("echo [ab]")).toBe("glob");
  expect(scan("echo [abc")).toBe(false);
});
