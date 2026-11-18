import { expect, test } from "bun:test";
import { createMainFixture as owner } from "./main-fixture.js";
import { policy } from "./security-fixture.js";
import { NativeBashSecurityUnsupported } from "../../../src/native-bash-security/security-types.js";
test("native main controller checks scoped Read after a matching Bash prefix rule", async () => {
  const f = owner();
  f.add("allow", "cat *");
  expect((await f.run("cat file")).behavior).toBe("allow");
  f.deny("/outside", "read");
  const result = await f.run("cat /outside");
  expect(result.behavior).toBe("deny");
  expect(
    f.permissionCalls.some((value) => value.startsWith("read:deny:/outside:")),
  ).toBe(true);
});

test("native main controller checks scoped Edit on output redirects after Bash rule matching", async () => {
  const f = owner();
  f.add("allow", "echo *");
  f.deny("/blocked", "edit");
  expect((await f.run("echo value > /blocked")).behavior).toBe("deny");
  expect(
    f.permissionCalls.some((value) => value.startsWith("edit:deny:/blocked:")),
  ).toBe(true);
});

test("native main compound path retains a denied operation among independently matched Bash rules", async () => {
  const f = owner();
  f.add("allow", "cat *");
  f.deny("/outside", "read");
  const result = await f.run("cat file; cat /outside");
  expect(result.behavior).toBe("deny");
  expect(result.decisionReason?.type).toBe("subcommandResults");
});

test("native main missing factual inspection cannot become a Bash prefix grant", async () => {
  const f = owner();
  f.add("allow", "cat *");
  delete f.policyHost.filesystem.canonicalInspection;
  let caught: unknown;
  try {
    await f.run("cat file");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeBashSecurityUnsupported);
});

test("native live policy transition scopes subsequent rule and file reads to the returned generation", async () => {
  const f = owner();
  f.add("allow", "cat *");
  const next = policy({ scope: { policyId: "next-generation", cwd: "/work" } });
  f.setPolicy(next);
  expect((await f.run("cat file")).behavior).toBe("allow");
  expect(f.permissionCalls.length).toBeGreaterThan(0);
  expect(
    f.permissionCalls.every((value) =>
      value.includes(":next-generation:/work"),
    ),
  ).toBe(true);
});
