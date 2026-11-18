import { expect, test } from "bun:test";
import { createSecurityProcessFixture } from "./security-process-fixture.js";
import { known } from "./security-fixture.js";

// The assembled process judges a whole command line. A pipeline is split and
// every segment goes back through the outer check; an unexpected host
// failure surfaces to the caller instead of turning into a decision.

test("each segment of a pipeline is judged again", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "cat:*");
  f.add("allow", "grep:*");
  f.hosts.policy.readOnly = (input, _context, s) =>
    known(/^(?:cat|grep) /.test(input.command), s);
  const allowed = await f.check("cat notes | grep x");
  if (allowed.status !== "resolved") throw new Error(allowed.dependency);
  expect(allowed.outcome.behavior).toBe("allow");
  const mixed = await f.check("cat notes | sh");
  if (mixed.status !== "resolved") throw new Error(mixed.dependency);
  expect(mixed.outcome.behavior).not.toBe("allow");
});

test("an ordinary host failure is raised, not reported as unresolved", async () => {
  const f = createSecurityProcessFixture();
  f.add("allow", "cat:*");
  const failure = new Error("filesystem crashed");
  f.hosts.policy.filesystem.canonicalInspection = () => {
    throw failure;
  };
  expect(f.check("cat private")).rejects.toBe(failure);
});
