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

// A catastrophic removal must stay behind the dangerous-removal floor even
// when a Bash prefix rule allows the wrapper in front of it; `env rm -rf /`
// and `nice sh -c 'rm -rf /'` already do. These wrappers currently get the
// allow. Remove `.failing` once the floor sees through them.
test.failing.each([
  ["sudo", "sudo rm -rf /"],
  ["chroot", "chroot / sh -c 'rm -rf /'"],
])(
  "KNOWN-GAP an allowed %p prefix lets %p through the dangerous-removal floor",
  async (prefix, command) => {
    const f = createSecurityProcessFixture();
    f.add("allow", `${prefix}:*`);
    f.setSkip(false);
    const result = await f.check(command);
    if (result.status !== "resolved") throw new Error(result.dependency);
    expect(result.outcome.behavior).not.toBe("allow");
  },
);

test.each([
  ["env", "env rm -rf /"],
  ["nice", "nice sh -c 'rm -rf /'"],
  ["bash", "bash -c 'rm -rf /'"],
])(
  "an allowed %p prefix keeps %p behind the dangerous-removal floor",
  async (prefix, command) => {
    const f = createSecurityProcessFixture();
    f.add("allow", `${prefix}:*`);
    f.setSkip(false);
    const result = await f.check(command);
    if (result.status !== "resolved") throw new Error(result.dependency);
    expect(result.outcome.behavior).toBe("ask");
    expect(result.outcome.decisionReason).toMatchObject({
      circuitBreaker: "dangerousRemoval",
    });
  },
);
