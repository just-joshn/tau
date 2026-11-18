import { createComplexityFixture } from "./complexity-fixture.js";
import {
  createNativeBashStateControl,
  type NativeBashStateControlHost,
  type NativeBashRemovalWaiverState,
} from "../../src/native-bash-security/state-control.js";
import { known, policy } from "./security-fixture.js";
import {
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityRule as Rule,
} from "../../src/native-bash-security/security-types.js";

export function createStateFixture() {
  const f = createComplexityFixture();
  const waiver: NativeBashRemovalWaiverState = {
    removalWaiverRulesClear: true,
  };
  const reads: string[] = [];
  const denied: Rule[] = [];
  const asked: Rule[] = [];
  const errors: unknown[] = [];
  let current = policy();
  let skip = true;
  let child = false;
  const host: NativeBashStateControlHost = {
    livePolicy: (_context, s) => known(current, s),
    interactiveLaunch: (s) => {
      reads.push("interactive");
      return known(true, s);
    },
    autoModeActive: (s) => {
      reads.push("auto");
      return known(true, s);
    },
    evenMoreDangerouslySkipPermissions: (s) => {
      reads.push("skip");
      return known(skip, s);
    },
    childSession: (s) => {
      reads.push("child");
      return known(child, s);
    },
    waiverState: (s) => {
      reads.push("state");
      return known(waiver, s);
    },
    allDenyRules: (_permission, s) => {
      reads.push("deny");
      return known(denied, s);
    },
    allAskRules: (_permission, s) => {
      reads.push("ask");
      return known(asked, s);
    },
    targetsNamedTool: (_permission, tool, rule, s) => {
      reads.push(`tool:${tool}`);
      return known(rule.ruleValue.toolName === tool, s);
    },
    managedSourceReadable: (source, s) => {
      reads.push(source);
      return known(true, s);
    },
    reportError: (error, s) => {
      errors.push(error);
      return known(undefined, s);
    },
  };
  const state = createNativeBashStateControl(f.complex, host);
  const run = <T>(callback: () => T) =>
    state.withPolicyScope(current, "/work", callback).result;
  return {
    ...f,
    state,
    stateHost: host,
    waiver,
    reads,
    denied,
    asked,
    errors,
    stateRun: run,
    setPolicy(value: typeof current) {
      current = value;
    },
    setSkip(value: boolean) {
      skip = value;
    },
    setChild(value: boolean) {
      child = value;
    },
  };
}
export function removal(): Decision {
  return {
    behavior: "ask",
    message: "authored removal",
    decisionReason: {
      type: "safetyCheck",
      reason: "authored removal",
      circuitBreaker: "dangerousRemoval",
      classifierApprovable: false,
    },
    suggestions: [],
  };
}
export function denyRule(
  toolName = "Read",
  source = "projectSettings",
  content: string | undefined = "/secret",
): Rule {
  return {
    source,
    ruleBehavior: "deny",
    ruleValue: { toolName, ruleContent: content },
  };
}
