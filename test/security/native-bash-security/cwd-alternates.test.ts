import { expect, test } from "bun:test";
import { createMainFixture } from "./main-fixture.js";
import { createNativeBashCwdAlternates } from "../../../src/native-bash-security/cwd-alternates.js";
import { known, policy } from "./security-fixture.js";
function owner() {
  const f = createMainFixture();
  const alternates = createNativeBashCwdAlternates(f.main, {
    wittyDove: (s) => known(true, s),
    immutableToucan: (s) => known(true, s),
  });
  const run = <T>(callback: () => T) =>
    alternates.withPolicyScope(policy(), "/work", callback).result;
  async function semantic(command: string) {
    const result = await f.semantic.analyze(command);
    if (result.kind !== "simple") throw new Error(result.reason);
    return result;
  }
  async function writes(command: string) {
    const result = await semantic(command);
    const first = result.commands[0];
    if (!first) throw new Error("Missing authored command");
    return run(() => alternates.native.AIo(first));
  }
  return { ...f, alternates, runAlternate: run, receipt: semantic, writes };
}

test("native cwd write profile retains cp destination, potential landings and separate read sources", async () => {
  const f = owner();
  expect(await f.writes("cp source dest")).toEqual({
    known: true,
    written: ["dest"],
    landings: ["dest/source"],
    copySources: ["source"],
    writesUnseen: false,
  });
  const uncertain = await f.writes("cp -R . dest");
  expect(uncertain.writesUnseen).toBe(true);
  const redirect = await f.writes("echo value > output");
  expect(redirect.written).toEqual(["output"]);
  expect(redirect.known).toBe(false);
});

test("native awk output scan distinguishes named files from computed and pipe writes", async () => {
  const f = owner();
  const simple = await f.writes("awk '{ print > \"out\" }' input");
  expect(simple.written).toEqual(["out"]);
  expect(simple.writesUnseen).toBe(false);
  const computed = await f.writes("awk '{ print > target }' input");
  expect(computed.writesUnseen).toBe(true);
  const output = await f.writes("sort -o out input");
  expect(output.writesUnseen).toBe(true);
});

test("native cwd alternatives use real semantic byte metadata and retain quoted/unquoted variants", async () => {
  const f = owner();
  const command = 'cat "$PWD/file"';
  const result = await f.receipt(command);
  expect(result.commands[0]?.atShellCwd).toBeDefined();
  expect(
    f.runAlternate(() =>
      f.alternates.native.Own(command, result, "/work", (text) =>
        text.startsWith("cat "),
      ),
    ),
  ).toEqual(["cat /work/file", 'cat "/work/file"']);
  const unicode = 'cat "$PWD/雪.txt"';
  const receipt = await f.receipt(unicode);
  expect(
    f.runAlternate(() =>
      f.alternates.native.Own(unicode, receipt, "/work", (text) =>
        text.startsWith("cat "),
      ),
    ),
  ).toEqual(['cat "/work/雪.txt"']);
});

test("native cwd alternative guard refuses cwd changes and unrelated observable PWD words", async () => {
  const f = owner();
  for (const command of [
    'cd ./sub && cat "$PWD/file"',
    'echo PWD; cat "$PWD/file"',
  ]) {
    const receipt = await f.receipt(command);
    expect(
      f.runAlternate(() =>
        f.alternates.native.Own(command, receipt, "/work", (text) =>
          text.startsWith("cat "),
        ),
      ),
    ).toEqual([]);
  }
  const command = 'cat "$PWD/file"';
  const receipt = await f.receipt(command);
  expect(
    f.runAlternate(() =>
      f.alternates.native.Own(command, receipt, '/work/"unsafe', () => true),
    ),
  ).toEqual([]);
});

test("native printf/environment consumers retain source format hazards and git-variable admission scope", () => {
  const f = owner();
  expect(f.alternates.native.own("literal %s %%")).toBe(true);
  expect(f.alternates.native.own("%n")).toBe(false);
  expect(f.alternates.native.own("\\u0041%s")).toBe(false);
  expect(
    f.runAlternate(() =>
      f.alternates.native.VOe(["GIT_SSH_COMMAND"], { command: "git status" }),
    ),
  ).toBe(false);
  const sandbox = f.policyHost.sandbox;
  if (!sandbox) throw new Error("Missing authored sandbox profile");
  f.policyHost.sandbox = (permission, s) => {
    const value = sandbox(permission, s);
    if (value.status !== "known") throw new Error("Missing sandbox fact");
    return known({ ...value.value, enabled: true }, s);
  };
  expect(
    f.runAlternate(() =>
      f.alternates.native.VOe(["GIT_SSH_COMMAND"], { command: "git status" }),
    ),
  ).toBe(true);
  expect(
    f.runAlternate(() =>
      f.alternates.native.VOe(["SAFE_NAME"], { command: "git status" }),
    ),
  ).toBe(false);
});
