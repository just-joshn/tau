import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import { createNativeBashSecurityProcess } from "../../src/native-bash-security/security-process.js";
import { createNativeBashCommandPreparation } from "../../src/native-bash-command-preparation.js";
import { policy } from "./security-fixture.js";

test("assembled native security process retains one parser, preparation context and recursive callback graph", () => {
  const f = createSecurityProcessFixture();
  expect(f.process.semantic.parser).toBe(
    f.process.preparation.projection.parser,
  );
  expect(f.process.policy.pathOwner.semantic).toBe(f.process.semantic);
  expect(f.process.outer.main).toBe(f.process.main);
  expect(f.process.inline.shapes.observations).toBe(f.process.observations);
  const other = createNativeBashCommandPreparation(f.semantic.parser);
  expect(() =>
    createNativeBashSecurityProcess(f.semantic, other, f.hosts),
  ).toThrow("feature owners must be shared");
});

test("assembled full native process applies read and redirect denies to a matched compound command", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "cat:*");
  f.add("allow", "echo:*");
  f.deny("/work/private", "read");
  f.deny("/work/protected", "edit");
  for (const command of [
    "cat private",
    "echo okay > protected",
    "echo okay && cat private",
  ]) {
    const result = await f.check(command);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error(result.dependency);
    expect(result.outcome.behavior).toBe("deny");
    expect(result.provenance.length).toBeGreaterThan(0);
  }
  expect(
    f.permissionCalls.some((v) => v.startsWith("read:deny:/work/private")),
  ).toBe(true);
  expect(
    f.permissionCalls.some((v) => v.startsWith("edit:deny:/work/protected")),
  ).toBe(true);
});

test("assembled process reaches scoped Read denies inside native recursive inline shell checks", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "sh:*");
  f.add("allow", "cat:*");
  f.deny("/work/private", "read");
  const result = await f.check("sh -c 'cat private; rm -rf /'");
  if (result.status !== "resolved") throw new Error(result.dependency);
  expect(result.status).toBe("resolved");
  expect(result.outcome.behavior).not.toBe("allow");
  expect(
    f.permissionCalls.some((v) => v.startsWith("read:deny:/work/private")),
  ).toBe(true);
});

test("assembled process preserves native dangerous-removal floors despite a Bash prefix allow", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "rm:*");
  f.setSkip(false);
  const result = await f.check("rm -rf /");
  if (result.status !== "resolved") throw new Error(result.dependency);
  expect(result.status).toBe("resolved");
  expect(result.outcome.behavior).not.toBe("allow");
  expect(
    f.process.outcomes.Sa(
      result.outcome.decisionReason,
      (reason) => reason.circuitBreaker === "dangerousRemoval",
    ),
  ).toBeDefined();
});

test("assembled process returns unresolved for missing factual filesystem capabilities without changing an allow rule", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "cat:*");
  delete f.hosts.policy.filesystem.canonicalInspection;
  const result = await f.check("cat private");
  expect(result.status).toBe("unresolved");
  if (result.status !== "unresolved")
    throw new Error("Expected actual missing capability");
  expect(result.dependency).toBe("filesystem.canonicalInspection");
  expect(result.provenance.length).toBeGreaterThan(0);
  expect(f.rules.allow.has("cat:*")).toBe(true);
});

test("assembled process applies actual command clamp policy before every recursive native decision", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "cat:*");
  const result = await f.check(
    "cat private",
    {},
    policy({ bashCommandClamps: [["Bash(echo:*)"]] }),
  );
  if (result.status !== "resolved") throw new Error(result.dependency);
  expect(result.status).toBe("resolved");
  expect(result.outcome.behavior).toBe("deny");
  expect(result.outcome.decisionReason).toMatchObject({
    type: "other",
    reason: "bashCommandClamp: no clamp rule matches this command",
  });
  expect(f.permissionCalls).toEqual([]);
});

test("native inline removal recursion does not promise a general shell-script Read fence", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "sh:*");
  f.add("allow", "cat:*");
  f.deny("/work/private", "read");
  const result = await f.check("sh -c 'cat private'");
  if (result.status !== "resolved") throw new Error(result.dependency);
  expect(result.outcome.behavior).toBe("allow");
  expect(
    f.permissionCalls.some((value) =>
      value.startsWith("read:deny:/work/private"),
    ),
  ).toBe(false);
  // Source Jwn only inspects the script for its Dbn/dollar-quote removal-risk gate.
  // Source parity cannot be represented as an all-shell filesystem enforcement guarantee.
});
