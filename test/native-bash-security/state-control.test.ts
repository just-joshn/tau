import { expect, test } from "bun:test";
import {
  createStateFixture as owner,
  removal,
  denyRule,
} from "./state-fixture.js";
import { policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
} from "../../src/native-bash-security/security-types.js";
test("native removal waiver preserves typed flag and child-session short circuits", () => {
  const f = owner();
  f.setSkip(false);
  expect(f.stateRun(() => f.state.native.gVo(policy()))).toBe(false);
  expect(f.reads).toEqual(["skip"]);
  f.reads.length = 0;
  f.setSkip(true);
  f.setChild(true);
  expect(f.stateRun(() => f.state.native.gVo(policy()))).toBe(false);
  expect(f.reads).toEqual(["skip", "child"]);
  f.reads.length = 0;
  f.setChild(false);
  expect(f.stateRun(() => f.state.native.gVo(policy()))).toBe(true);
  expect(f.reads).toEqual([
    "skip",
    "child",
    "skip",
    "deny",
    "ask",
    "state",
    "remote",
    "helper",
    "plist",
    "hklm",
    "hkcu",
    "file",
    "parent",
  ]);
});

test("native rule restrictions invalidate the shared waiver owner and skip managed-source reads", () => {
  const f = owner();
  f.denied.push(denyRule("Read"));
  expect(f.stateRun(() => f.state.native.gVo(policy()))).toBe(false);
  expect(f.waiver.removalWaiverRulesClear).toBe(false);
  expect(f.reads).not.toContain("remote");
  f.denied.length = 0;
  const wholeTool = denyRule("Read", "toolsNarrowing");
  wholeTool.ruleValue.ruleContent = undefined;
  f.denied.push(wholeTool);
  f.waiver.removalWaiverRulesClear = true;
  expect(f.stateRun(() => f.state.native.Zl(policy()))).toBe(false);
  expect(
    f.stateRun(() =>
      f.state.native.Zl(policy({ blockReadsOutsideWorkingDirectories: true })),
    ),
  ).toBe(true);
});

test("native managed-source ordinary errors log once while unknown providers propagate", () => {
  const f = owner();
  const failure = new Error("authored managed-source read failure");
  f.stateHost.managedSourceReadable = () => {
    throw failure;
  };
  expect(f.stateRun(f.state.native.Xl)).toBe(false);
  expect(f.stateRun(f.state.native.Xl)).toBe(false);
  expect(f.waiver.managedSourcesReadErrorLogged).toBe(true);
  expect(f.errors).toEqual([failure]);
  delete f.stateHost.managedSourceReadable;
  expect(() => f.stateRun(f.state.native.Xl)).toThrow(
    NativeBashSecurityUnsupported,
  );
});

test("native mode eligibility reads actual launch and auto-mode owner without inferred policy labels", () => {
  const f = owner();
  expect(f.stateRun(() => f.state.native.fxe(policy({ mode: "auto" })))).toBe(
    true,
  );
  expect(f.reads).toEqual([]);
  expect(
    f.stateRun(() =>
      f.state.native.fxe(policy({ mode: "plan", servedCall: true })),
    ),
  ).toBe(false);
  expect(f.reads).toEqual([]);
  expect(f.stateRun(() => f.state.native.fxe(policy({ mode: "plan" })))).toBe(
    true,
  );
  expect(f.reads).toEqual(["auto"]);
  f.reads.length = 0;
  f.setPolicy(policy({ mode: "plan", isBypassPermissionsModeAvailable: true }));
  const context = f.context("").context;
  context.forRemoteExecution = true;
  expect(f.stateRun(() => f.state.native.edt(context))).toBe(false);
  expect(f.reads).toEqual(["interactive"]);
});

test("native removal ask ranking and unfinished fallback preserve nonwaivable circuits and suppression flags", () => {
  const f = owner();
  f.setPolicy(policy({ mode: "auto" }));
  const dangerous = removal();
  expect(
    f.stateRun(() => f.state.native.Zde(dangerous, f.context("").context)),
  ).toBe(true);
  expect(
    f.stateRun(() => f.state.native.Qlt(dangerous, f.context("").context)),
  ).toBe(dangerous);
  f.setPolicy(policy());
  const outside: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "safetyCheck",
      reason: "read fence",
      circuitBreaker: "outsideReadsBlocked",
      classifierApprovable: false,
    },
  };
  expect(
    f.stateRun(() => f.state.native.Qlt(outside, f.context("").context)),
  ).toBe(outside);
  const unfinished = f.stateRun(() =>
    f.state.native.Qlt({ behavior: "allow" }, f.context("").context),
  );
  expect(unfinished).toMatchObject({
    behavior: "ask",
    suppressAlwaysAllowRule: true,
    checkIncomplete: true,
    suggestions: [],
  });
  expect(unfinished.decisionReason).toMatchObject({
    circuitBreaker: "unfinishedCheck",
    classifierApprovable: false,
  });
});

test("native cutshort deny floor uses exact Bash/Edit/Read set and preserves restricted circuit provenance", () => {
  const f = owner();
  f.denied.push(denyRule("Write"));
  expect(
    f.stateRun(() =>
      f.state.native.ZOr({ behavior: "allow" }, f.context("").context),
    ).behavior,
  ).toBe("ask");
  f.denied.push(denyRule("Read"));
  expect(
    f.stateRun(() =>
      f.state.native.ZOr({ behavior: "allow" }, f.context("").context),
    ).behavior,
  ).toBe("deny");
  f.denied.length = 0;
  f.setPolicy(policy({ restricted: true }));
  const result = f.stateRun(() =>
    f.state.native.Qlt({ behavior: "allow" }, f.context("").context),
  );
  expect(result.decisionReason).toMatchObject({
    circuitBreaker: "restrictedMode",
    also: ["unfinishedCheck"],
  });
});
