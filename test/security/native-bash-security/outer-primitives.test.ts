import { expect, test } from "bun:test";
import { createMainFixture } from "./main-fixture.js";
import { createNativeBashOuterPrimitives } from "../../../src/native-bash-security/outer-primitives.js";
import { known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
} from "../../../src/native-bash-security/security-types.js";
function owner() {
  const f = createMainFixture();
  const reads: string[] = [];
  let active = policy();
  const primitives = createNativeBashOuterPrimitives(f.main, {
    livePolicy: (context, s) => {
      reads.push("policy");
      return known(context.getAppState?.().toolPermissionContext ?? active, s);
    },
    networkClassifierEnabled: (s) => {
      reads.push("network");
      return known(true, s);
    },
  });
  const run = <T>(callback: () => T) =>
    primitives.withPolicyScope(active, "/work", callback).result;
  return {
    ...f,
    primitives,
    primitiveRun: run,
    reads,
    setActive(value: typeof active) {
      active = value;
    },
  };
}

test("native clamp requires every command span to match every group and ignores whole-tool rows", async () => {
  const f = owner();
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "cat file" }, [["Bash(cat:*)"]]),
    ),
  ).toBeNull();
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "cat file; rm target" }, [
        ["Bash(cat:*)"],
      ]),
    ),
  ).toMatchObject({ span: "rm target", kind: "unmatched" });
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "cat file" }, [
        ["Bash(cat:*)"],
        ["Bash(git:*)"],
      ]),
    ),
  ).toMatchObject({
    span: "cat file",
    group: ["Bash(git:*)"],
    kind: "unmatched",
  });
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "cat file" }, [["Bash(*)"]]),
    ),
  ).toMatchObject({ span: "cat file", kind: "unmatched" });
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "cat $(compute)" }, [["Bash(cat:*)"]]),
    ),
  ).toMatchObject({ kind: "unverifiable" });
});

test("native clamp cannot manufacture a semantic certificate from certified rule text", async () => {
  const f = owner();
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "cat file" }, [
        ["Bash(certified: cat)"],
      ]),
    ),
  ).toMatchObject({ kind: "unmatched" });
  expect(
    await f.primitiveRun(() =>
      f.primitives.native.cOr({ command: "anything" }, []),
    ),
  ).toBeNull();
});

test("native background scan distinguishes shell operators from quoted and arithmetic ampersands", async () => {
  const f = owner();
  const read = async (text: string) => {
    const root = await f.semantic.parse(text);
    if (!root || root === f.semantic.parseAbort)
      throw new Error("Missing authored tree");
    return f.primitives.native.Fbn(root);
  };
  expect(await read("echo a & echo b")).toBe(true);
  expect(await read("printf 'a&b'")).toBe(false);
  expect(await read("echo $((1&2))")).toBe(false);
});

test("native allowed-domain reader retains source bounds and unreadable-element behavior", () => {
  const f = owner();
  expect(
    f.primitives.native.Fce({
      command: "echo",
      allowed_domains: ["one.example", "two.example"],
    }),
  ).toEqual({ allow: ["one.example", "two.example"] });
  for (const value of [
    undefined,
    "one.example",
    [],
    ["one.example", 7],
    Array(4097),
  ])
    expect(
      f.primitives.native.Fce({ command: "echo", allowed_domains: value }),
    ).toBeUndefined();
  const unreadable: unknown[] = ["one.example"];
  Object.defineProperty(unreadable, 0, {
    get() {
      throw new Error("authored unreadable entry");
    },
  });
  expect(
    f.primitives.native.Fce({ command: "echo", allowed_domains: unreadable }),
  ).toBeUndefined();
  Object.defineProperty(unreadable, 0, {
    get() {
      throw new NativeBashSecurityUnsupported("actual.field", "not supplied");
    },
  });
  expect(() =>
    f.primitives.native.Fce({ command: "echo", allowed_domains: unreadable }),
  ).toThrow(NativeBashSecurityUnsupported);
});

test("native network classifier floor preserves existing refusals and actual policy-read order", () => {
  const f = owner();
  f.setActive(policy({ mode: "auto" }));
  const input = { command: "echo", allowed_domains: ["one.example"] };
  const tool = { name: "Bash", sandboxNetworkLists: f.primitives.native.Fce };
  const deny: Decision = { behavior: "deny" };
  expect(
    f.primitiveRun(() =>
      f.primitives.native.zK(tool, input, f.context("").context, deny),
    ),
  ).toBeUndefined();
  expect(f.reads).toEqual([]);
  const updated = { command: "echo normalized" };
  const result = f.primitiveRun(() =>
    f.primitives.native.zK(tool, input, f.context("").context, {
      behavior: "allow",
      updatedInput: updated,
    }),
  );
  expect(result?.behavior).toBe("ask");
  expect(result?.updatedInput).toBe(updated);
  expect(result?.decisionReason).toMatchObject({
    type: "safetyCheck",
    classifierApprovable: true,
  });
  expect(f.reads).toEqual(["policy", "network"]);
  f.reads.length = 0;
  expect(
    f.primitiveRun(() =>
      f.primitives.native.zK(
        tool,
        { command: "echo" },
        f.context("").context,
        undefined,
      ),
    ),
  ).toBeUndefined();
  expect(f.reads).toEqual(["policy"]);
});

test("native clamp-removal context preserves app-state fields and original getter observations", () => {
  const f = owner();
  let appReads = 0;
  const original = policy({ bashCommandClamps: [["Bash(cat:*)"]] });
  const context = f.context("").context;
  context.permissionLayers = [
    { kind: "bash_command_clamp" },
    { kind: "sandbox_auto_allow_suspended", allowOnly: true },
    { kind: "other" },
  ];
  context.getAppState = () => {
    appReads++;
    return { toolPermissionContext: original, owned: "retained" };
  };
  const alternate = f.primitiveRun(() => f.primitives.native.yoi(context));
  expect(alternate.permissionLayers?.map((layer) => layer.kind)).toEqual([
    "sandbox_auto_allow_suspended",
    "other",
  ]);
  expect(f.primitiveRun(() => alternate.getAppState?.())).toMatchObject({
    owned: "retained",
    toolPermissionContext: { bashCommandClamps: [] },
  });
  expect(appReads).toBe(2);
  expect(original.bashCommandClamps).toEqual([["Bash(cat:*)"]]);
  expect(
    f.primitives.native
      .rIr(context)
      .permissionLayers?.map((layer) => layer.kind),
  ).toEqual(["bash_command_clamp", "other"]);
  expect(() =>
    f.primitiveRun(() => f.primitives.native.yoi(f.context("").context)),
  ).toThrow(NativeBashSecurityUnsupported);
});
