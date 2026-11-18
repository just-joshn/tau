import { test, expect } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPathControl,
  type NativeBashSecurityPathHost,
} from "../../../src/native-bash-security/path-control.js";
import { createNativeBashSecurityGitStructure } from "../../../src/native-bash-security/git-structure.js";
import { NativeBashSecurityUnsupported } from "../../../src/native-bash-security/security-types.js";
import { fixture, policy, known } from "./security-fixture.js";
function owner() {
  const f = fixture();
  let lstatCalls = 0;
  const preparation = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const host: NativeBashSecurityPathHost = {
    ...f.host,
    originalWorkingDirectory: (s) => known("/work", s),
  };
  host.filesystem.realpathSpelling = (path, s) => known(path, s);
  host.filesystem.lstat = (_path, s) => {
    lstatCalls++;
    return known(
      { status: "stat", isSymbolicLink: false, isDirectory: false },
      s,
    );
  };
  const path = createNativeBashSecurityPathControl(
    f.semantic,
    preparation,
    host,
  );
  const git = createNativeBashSecurityGitStructure(
    f.semantic,
    preparation,
    path,
    host,
  );
  async function writes(command: string) {
    const r = await f.semantic.analyze(command);
    if (r.kind !== "simple") throw new Error(r.reason);
    return git.withPolicyScope(policy(), "/work", () =>
      git.native.qOe(r.commands, "/work"),
    );
  }
  return { ...f, host, git, writes, lstatCalls: () => lstatCalls };
}
test("native git-structure detector reads full semantic write families and redirect targets", async () => {
  const f = owner();
  for (const command of [
    "touch HEAD",
    "mkdir -p objects/sub",
    "printf x > refs/main",
    "cp source hooks",
    "touch HİAD; touch HEAD",
  ]) {
    expect((await f.writes(command)).result).toBe(true);
  }
  for (const command of [
    "touch ordinary",
    "cat HEAD",
    "rm HEAD",
    "rmdir hooks",
    "sed -i 's/a/b/' HEAD",
  ]) {
    expect((await f.writes(command)).result).toBe(false);
  }
});
test("source raw fallback checks copied directory basenames and output redirects", () => {
  const f = owner();
  const n = f.git.native;
  expect(n.zde("cp /outside/hooks .")).toBe(true);
  expect(n.zde("printf x > objects/new")).toBe(true);
  expect(n.zde("cat hooks")).toBe(false);
  expect(n.zde("touch unrelated")).toBe(false);
  expect(n.Eat("./REFS/main")).toBe(true);
  expect(n.Eat("objects/../ordinary")).toBe(false);
  expect(n.Eat("hoоks/main")).toBe(false);
  expect(n.Eat("hооks/main")).toBe(false);
  expect(n.Eat("hookſ/main")).toBe(true);
});
test("unknown canonical and lstat facts cannot silently become a safe git-structure result", async () => {
  const f = owner();
  delete f.host.filesystem.realpathSpelling;
  expect(f.writes("touch ordinary")).rejects.toThrow(
    NativeBashSecurityUnsupported,
  );
  const g = owner();
  delete g.host.filesystem.lstat;
  expect(g.writes("touch 'sub/../HEAD'")).rejects.toThrow(
    NativeBashSecurityUnsupported,
  );
});
test("source lexical dotdot walks distinguish symbolic-link routes from known ordinary paths", async () => {
  const f = owner();
  f.host.filesystem.lstat = (path, s) =>
    known(
      {
        status: "stat",
        isSymbolicLink: path === "/work/link",
        isDirectory: false,
      },
      s,
    );
  expect((await f.writes("touch link/../ordinary")).result).toBe(true);
  expect(f.lstatCalls()).toBe(0);
  const g = owner();
  expect((await g.writes("touch sub/../ordinary")).result).toBe(false);
  expect(g.lstatCalls()).toBeGreaterThan(0);
});
test("native alias prefix cache retains Unicode folds and dotdot-sensitive early boundaries", () => {
  const n = owner().git.native;
  expect(n.KPe("/Network/Servers/host/repo")).toBe("/Network/Servers/host");
  expect(n.KPe("/\u200cNET/host/path")).toBe("/\u200cNET/host");
  expect(n.KPe("/a/../net/host/path")).toBe("/net/host");
  expect(n.KPe("relative/net/host")).toBeNull();
  expect(n.kb("/./.vol/file")).toBe(true);
  expect(n.kb("relative/.vol/file")).toBe(false);
});
test("native path component budget refuses before unavailable host capabilities", () => {
  const f = owner();
  delete f.host.filesystem.realpathSpelling;
  const r = f.git.withPolicyScope(policy(), "/work", () => {
    f.git.native.qOe([], "/work");
    return f.git.native.b8("/".repeat(33000), "/work");
  });
  expect(r.result).toBe(true);
});
