import { createNestedFixture } from "./nested-fixture.js";
import {
  createNativeBashComplexityControl,
  type NativeBashComplexityHost,
} from "../../src/native-bash-security/complexity-control.js";
import { policy, known } from "./security-fixture.js";
import {
  type NativeBashSecurityRule as Rule,
  type NativeBashSecurityPolicy as Policy,
} from "../../src/native-bash-security/security-types.js";

export function createComplexityFixture() {
  const f = createNestedFixture();
  const rules = {
    allow: new Map<string, Rule>(),
    ask: new Map<string, Rule>(),
    deny: new Map<string, Rule>(),
  };
  const raw: { deny: Rule[]; ask: Rule[] } = { deny: [], ask: [] };
  const originalSandbox = f.policyHost.sandbox;
  if (!originalSandbox) throw new Error("Missing authored sandbox profile");
  f.policyHost.sandbox = (permission, s) => {
    const fact = originalSandbox(permission, s);
    if (fact.status !== "known")
      throw new Error("Missing authored sandbox fact");
    return known(
      {
        ...fact.value,
        enabled: true,
        autoAllowBashIfSandboxed: true,
        autoAllowSupported: true,
      },
      s,
    );
  };
  f.policyHost.isConfined = (s) => known(false, s);
  f.policyHost.executingConfined = (s) => known(false, s);
  f.policyHost.evalConfined = (s) => known(false, s);
  f.policyHost.sandboxCommandExempt = (_command, _shell, s) => known(false, s);
  f.policyHost.ruleSuggestions = (_command, s) => known([], s);
  f.policyHost.orderedRules = (_permission, behavior, s) =>
    known(rules[behavior], s);
  const events: string[] = [];
  let tender = true;
  const host: NativeBashComplexityHost = {
    currentCwd: (s) => known(s.cwd, s),
    rawBashRules: (_permission, behavior, s) => known(raw[behavior], s),
    readFeature: (_kind, key, fallback, s) =>
      known(
        key === "tengu_tender_quill"
          ? tender
          : key === "tengu_humble_hartmanis"
            ? true
            : fallback,
        s,
      ),
    sandboxPolicyDataSuspended: (_permission, s) => known(false, s),
    sandboxCommandExempt: (_command, s) => known(false, s),
    unsandboxedFallbackClosedByTrustedSource: (s) => known(true, s),
    permissionMode: (s) => known("default", s),
    reportError: (error) => {
      throw error;
    },
    escapedWhitespaceStackOverflow: (s) => known(undefined, s),
    telemetry: (event, metadata, s) => {
      events.push(`${event}:${metadata.behavior ?? metadata.kind}`);
      return known(undefined, s);
    },
  };
  const complex = createNativeBashComplexityControl(f.nested, host);
  function run<T>(callback: () => T, permission: Policy = policy()) {
    return complex.withPolicyScope(permission, "/work", callback).result;
  }
  function add(
    behavior: "allow" | "ask" | "deny",
    content: string,
    source = "projectSettings",
    textual = true,
  ) {
    const rule: Rule = {
      source,
      ruleBehavior: behavior,
      ruleValue: { toolName: "Bash", ruleContent: content },
    };
    rules[behavior].set(content, rule);
    if (behavior !== "allow" && textual) raw[behavior].push(rule);
    return rule;
  }
  async function analyze(text: string) {
    const result = await f.semantic.analyze(text);
    if (result.kind !== "simple") throw new Error(result.reason);
    return result;
  }
  return {
    ...f,
    complex,
    host,
    rules,
    raw,
    events,
    run,
    add,
    analyze,
    setTender(value: boolean) {
      tender = value;
    },
  };
}
