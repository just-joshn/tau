import { expect, test } from "bun:test";
import { createOuterFixture } from "./outer-fixture.js";
import { known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityRule as Rule,
} from "../../src/native-bash-security/security-types.js";
const allow: Decision = {
  behavior: "allow",
  message: "authored inner decision",
  decisionReason: { type: "mode", mode: "default" },
};

function includesRule(result: Decision, rule: Rule): boolean {
  const reason = result.decisionReason;
  if (reason?.type === "rule") return reason.rule === rule;
  if (reason?.type === "subcommandResults")
    return [...reason.reasons.values()].some((value) =>
      includesRule(value, rule),
    );
  return false;
}
test("complete outer control retains scoped Read and Edit denies after native Bash prefix matches", async () => {
  const f = createOuterFixture();
  f.add("allow", "cat:*");
  f.add("allow", "echo:*");
  const read = f.deny("/work/private", "read");
  const edit = f.deny("/work/protected", "edit");
  const first = await f.stage("OIo", { command: "cat private" }).result;
  expect(first.behavior).toBe("deny");
  expect(includesRule(first, read)).toBe(true);
  const second = await f.stage("OIo", { command: "echo value > protected" })
    .result;
  expect(second.behavior).toBe("deny");
  expect(includesRule(second, edit)).toBe(true);
  expect(
    f.permissionCalls.some((v) => v.startsWith("read:deny:/work/private")),
  ).toBe(true);
  expect(
    f.permissionCalls.some((v) => v.startsWith("edit:deny:/work/protected")),
  ).toBe(true);
});

test("native command clamps run before the main controller and retain distinct structural failure", async () => {
  const f = createOuterFixture();
  let mainCalls = 0;
  f.main.native.nIe = async () => {
    mainCalls++;
    return allow;
  };
  f.setOuterPolicy(policy({ bashCommandClamps: [["Bash(echo:*)"]] }));
  const okay = await f.stage("Qde", { command: "echo hello" }).result;
  expect(okay.behavior).toBe("allow");
  expect(mainCalls).toBe(1);
  const no = await f.stage("Qde", { command: "cat secret" }).result;
  expect(no.behavior).toBe("deny");
  expect(no.message).toContain('the span "cat secret"');
  expect(mainCalls).toBe(1);
  const structured = await f.stage("Qde", { command: "echo $(cat secret)" })
    .result;
  expect(structured.message).toContain("structure the clamp cannot verify");
  expect(mainCalls).toBe(1);
  expect(
    f.events.filter((v) => v.event === "tengu_bash_command_clamp_denied"),
  ).toHaveLength(2);
});

test("native later-loop and background checks cannot preserve an ordinary inner allow", async () => {
  const f = createOuterFixture();
  f.setSkip(false);
  f.main.native.nIe = async (...args) => {
    args[8]?.();
    return allow;
  };
  const loop = await f.stage("iIr", {
    command: "for x in a b; do echo $x; done",
  }).result;
  expect(loop.behavior).toBe("passthrough");
  expect(loop.decisionReason).toMatchObject({
    type: "other",
    bashMissKind: "loop-later-pass",
  });
  expect(loop.suggestions).toEqual([]);
  f.main.native.nIe = async () => allow;
  const background = await f.stage("iIr", { command: "echo hello &" }).result;
  expect(background.behavior).toBe("ask");
  expect(background.decisionReason).toMatchObject({
    type: "safetyCheck",
    circuitBreaker: "backgroundOperator",
    classifierApprovable: false,
  });
  const ordinary = await f.stage("iIr", { command: "echo 'a&b'" }).result;
  expect(ordinary).toBe(allow);
});

test("native environment counterfactual preserves refusal order and the actual named owner", async () => {
  const f = createOuterFixture();
  const reads: boolean[] = [];
  f.main.native.nIe = async () => {
    const refused = f.syntax.preparation.features.refuseEnvironment();
    reads.push(refused);
    return refused
      ? { behavior: "passthrough", message: "refused" }
      : { behavior: "deny", message: "counterfactual deny" };
  };
  const result = await f.stage("sbn", { command: "echo hello" }).result;
  expect(reads).toEqual([true, false]);
  expect(result.behavior).toBe("deny");
  expect(result.message).toBe("counterfactual deny");
  expect(f.syntax.preparation.features.refuseEnvironment()).toBe(true);
});

test("native keyword and arithmetic counterfactuals retain parser ALS restoration and denial provenance", async () => {
  const f = createOuterFixture();
  const feature = f.semantic.parser.features;
  const keywordReads: boolean[] = [];
  f.main.native.nIe = async () => {
    const off = feature.keywordGuardOff();
    keywordReads.push(off);
    feature.markKeywordDesynchronization();
    return off
      ? { behavior: "deny", message: "keyword counterfactual" }
      : allow;
  };
  expect(
    (await f.stage("XOr", { command: "echo hello" }).result).behavior,
  ).toBe("deny");
  expect(keywordReads).toEqual([false, true]);
  expect(feature.keywordGuardOff()).toBe(false);
  const arithmeticReads: { off: boolean; alternate: boolean }[] = [];
  f.main.native.nIe = async () => {
    const off = feature.arithmeticGuardOff();
    const alternate = feature.alternateArithmeticRead();
    arithmeticReads.push({ off, alternate });
    return off
      ? { behavior: "deny", message: "arithmetic counterfactual" }
      : allow;
  };
  const command = "echo $((1+2))";
  const result = await f.stage("YOr", { command }).result;
  expect(result.behavior).toBe("deny");
  expect(result.decisionReason?.type).toBe("subcommandResults");
  if (result.decisionReason?.type === "subcommandResults")
    expect([...result.decisionReason.reasons.keys()]).toEqual([
      command,
      `${command} (as refused)`,
    ]);
  expect(arithmeticReads.some((v) => v.off)).toBe(true);
  expect(feature.arithmeticGuardOff()).toBe(false);
  expect(feature.alternateArithmeticRead()).toBe(false);
});

test("native dollar operand observer reads the exact independent feature receipts before evaluation", async () => {
  const f = createOuterFixture();
  const keys: string[] = [];
  f.semantic.parser.features.registerGrammarReader((key, fallback) => {
    keys.push(key);
    return { value: fallback, source: "default", defaultHost: false };
  });
  f.main.native.nIe = async () => allow;
  await f.stage("YOr", { command: "echo $$[operand]" }).result;
  expect(keys.slice(0, 2)).toEqual([
    "tengu_deep_locket",
    "tengu_moonlit_crayon",
  ]);
  const event = f.events.find((v) => v.event === "tengu_bash_plain_line_check");
  expect(event?.metadata.guard_enabled).toBe(true);
  expect(event?.metadata.exemption_enabled).toBe(false);
});

test("native final observation converts only ordinary allows for misreading or untrusted checkout", async () => {
  const f = createOuterFixture();
  f.setSkip(false);
  f.main.native.nIe = async () => {
    f.semantic.parser.features.readMisreading("words_after_redirect");
    return allow;
  };
  const misread = await f.stage("OIo", { command: "echo hello" }).result;
  expect(misread.behavior).toBe("passthrough");
  expect(misread.decisionReason).toMatchObject({
    type: "other",
    bashMissKind: "too-complex",
    reason:
      "Words after a redirect in this command can't be checked before it runs",
  });
  f.main.native.nIe = async () => {
    f.shapes.observations.native.Rkn("authored untrusted checkout");
    return allow;
  };
  const checkout = await f.stage("OIo", { command: "echo hello" }).result;
  expect(checkout.behavior).toBe("passthrough");
  expect(checkout.decisionReason).toMatchObject({
    type: "other",
    bashMissKind: "git-untrusted-checkout",
    reason: "authored untrusted checkout",
  });
  f.main.native.nIe = async () => {
    f.semantic.parser.features.readMisreading("words_after_redirect");
    return { behavior: "deny", message: "deny remains" };
  };
  expect(
    (await f.stage("OIo", { command: "echo hello" }).result).behavior,
  ).toBe("deny");
});

test("native Unicode reconciliation resets command clamps and keeps alternate deny ordered with original", async () => {
  const f = createOuterFixture();
  const commands: string[] = [];
  f.main.native.nIe = async (input) => {
    commands.push(input.command);
    return input.command.includes("\uFFFD")
      ? { behavior: "deny", message: "replacement denied" }
      : allow;
  };
  const command = "echo private\uE000";
  const result = await f.stage("zOr", { command }).result;
  expect(result.behavior).toBe("deny");
  expect(commands).toEqual([command, "echo private\uFFFD"]);
  expect(result.decisionReason?.type).toBe("subcommandResults");
});

test("native unsupported facts propagate through every fallback while ordinary failures retain source outcomes", async () => {
  const f = createOuterFixture();
  f.main.native.nIe = async () => allow;
  f.outerHost.servedValuesChangeCount = () => {
    throw new NativeBashSecurityUnsupported("feature.count", "unknown");
  };
  expect(() => f.outerRun(() => f.outer.native.obn("echo $((1))"))).toThrow(
    NativeBashSecurityUnsupported,
  );
  const failure = new Error("ordinary reader failure");
  f.outerHost.servedValuesChangeCount = () => {
    throw failure;
  };
  expect(f.outerRun(() => f.outer.native.obn("echo $((1))"))).toBeUndefined();
  expect(f.outerErrors).toContain(failure);
  f.outerHost.glimmeringGlacier = (_fallback, s) => known(false, s);
  expect(f.outerRun(() => f.outer.native.obn("echo $((1))"))).toBeUndefined();
});

test("native path-list and by-name rereads preserve their separate observation stores", async () => {
  const f = createOuterFixture();
  const pathReads: boolean[] = [];
  f.main.native.nIe = async () => {
    const scope = f.syntax.policy.contexts.pathList.getStore();
    if (!scope) throw new Error("Missing source path-list observer");
    pathReads.push(scope.off === true);
    scope.pathListRefused = true;
    return scope.off
      ? { behavior: "deny", message: "path-list denied" }
      : { behavior: "passthrough", message: "path-list refused" };
  };
  const path = await f.stage("JOr", { command: "echo hello" }).result;
  expect(path.behavior).toBe("deny");
  expect(pathReads).toEqual([false, true]);
  expect(f.syntax.policy.contexts.pathList.getStore()).toBeUndefined();
  const names: boolean[] = [];
  f.main.native.nIe = async () => {
    const byName = f.shapes.observations.native.yMr();
    names.push(byName);
    return byName ? { behavior: "deny", message: "by-name denied" } : allow;
  };
  const named = await f.stage("tbn", { command: "echo hello" }).result;
  expect(named.behavior).toBe("deny");
  expect(names).toEqual([false, true]);
  expect(f.shapes.observations.contexts.byName.getStore()).toBeUndefined();
});

test("native reading reconciliation requests the actual network classifier for allowed domains", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "auto" }));
  const reads: { asBash: boolean; off: boolean }[] = [];
  f.main.native.nIe = async () => {
    const features = f.syntax.preparation.features;
    reads.push({
      asBash: features.readsAsBash(),
      off: features.readingRuleOff(),
    });
    features.markReadingRefusal("authored reading differs");
    return reads.length === 1
      ? {
          behavior: "ask",
          message: "reading refused",
          decisionReason: { type: "other", reason: "refused" },
        }
      : { behavior: "passthrough", message: "alternate reading" };
  };
  const result = await f.stage("QOr", {
    command: "echo hello",
    allowed_domains: ["example.test"],
  }).result;
  expect(reads).toEqual([
    { asBash: false, off: false },
    { asBash: true, off: true },
    { asBash: false, off: true },
  ]);
  expect(result.behavior).toBe("ask");
  expect(result.decisionReason).toMatchObject({
    type: "safetyCheck",
    classifierApprovable: true,
  });
  expect(result.message).toContain("allowed_domains");
  expect(result.standsInUnderHookAsk).toBe(true);
});

test("native cwd spelling reread enforces scoped deny using semantic UTF8 metadata", async () => {
  const f = createOuterFixture();
  const commands: string[] = [];
  f.policyHost.readOnly = (input, _context, s) =>
    known(input.command.startsWith("cat "), s);
  f.main.native.nIe = async (input) => {
    commands.push(input.command);
    return input.command.includes("/work/")
      ? { behavior: "deny", message: "expanded cwd read denied" }
      : { behavior: "passthrough", message: "unexpanded" };
  };
  const command = 'cat "$PWD/雪.txt"';
  const result = await f.stage("ebn", { command }).result;
  expect(result.behavior).toBe("deny");
  expect(commands).toEqual([command, 'cat "/work/雪.txt"']);
  expect(result.decisionReason?.type).toBe("subcommandResults");
  if (result.decisionReason?.type === "subcommandResults")
    expect([...result.decisionReason.reasons.keys()]).toEqual([
      "expanded cwd read denied",
      command,
    ]);
});

test("native final removal asks remove only addRules suggestions while preserving reason and other effects", async () => {
  const f = createOuterFixture();
  const decision: Decision = {
    behavior: "ask",
    message: "authored dangerous removal",
    decisionReason: {
      type: "safetyCheck",
      reason: "authored dangerous removal",
      circuitBreaker: "dangerousRemoval",
      classifierApprovable: false,
    },
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
      { type: "setMode", mode: "default", destination: "session" },
    ],
  };
  f.main.native.nIe = async () => decision;
  const result = await f.stage("OIo", { command: "echo hello" }).result;
  expect(result.behavior).toBe("ask");
  expect(result.decisionReason).toBe(decision.decisionReason);
  expect(result.suggestions).toEqual(decision.suggestions?.slice(1));
  expect(
    f.events.find((v) => v.event === "tengu_bash_dangerous_rm_ask")?.metadata
      .permissionMode,
  ).toBe("default");
});

test("native environment counterfactual contexts remain isolated across concurrent outer evaluations", async () => {
  const f = createOuterFixture();
  let arrivals = 0;
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observations: { command: string; before: boolean; after: boolean }[] =
    [];
  f.main.native.nIe = async (input) => {
    const before = f.syntax.preparation.features.refuseEnvironment();
    if (before) {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    }
    const after = f.syntax.preparation.features.refuseEnvironment();
    observations.push({ command: input.command, before, after });
    return before
      ? { behavior: "passthrough", message: "refused" }
      : { behavior: "deny", message: input.command };
  };
  const [left, right] = await Promise.all([
    f.stage("sbn", { command: "echo left" }).result,
    f.stage("sbn", { command: "echo right" }).result,
  ]);
  expect(left.message).toBe("echo left");
  expect(right.message).toBe("echo right");
  expect(observations).toHaveLength(4);
  expect(observations.every((value) => value.before === value.after)).toBe(
    true,
  );
  expect(
    observations
      .filter((value) => value.before)
      .map((value) => value.command)
      .sort(),
  ).toEqual(["echo left", "echo right"]);
});

test("native cwd downgrade admission reads bridge, background and teammate facts in source short-circuit order", async () => {
  const f = createOuterFixture();
  const reads: string[] = [];
  f.policyHost.readOnly = (input, _context, s) =>
    known(input.command.startsWith("cat "), s);
  const original: Decision = {
    behavior: "ask",
    message: "original cwd spelling",
    decisionReason: { type: "other", reason: "authored ambiguity" },
  };
  f.main.native.nIe = async (input) =>
    input.command.includes("$PWD") ? original : allow;
  f.outerHost.replBridgeActive = (s) => {
    reads.push("bridge");
    return known(true, s);
  };
  f.outerHost.backgroundMode = (s) => {
    reads.push("background");
    return known(undefined, s);
  };
  f.outerHost.teammateAgentId = (s) => {
    reads.push("teammate");
    return known(undefined, s);
  };
  const command = 'cat "$PWD/file"';
  expect(await f.stage("ebn", { command }).result).toBe(original);
  expect(reads).toEqual(["bridge"]);
  reads.length = 0;
  f.outerHost.replBridgeActive = (s) => {
    reads.push("bridge");
    return known(false, s);
  };
  f.outerHost.backgroundMode = (s) => {
    reads.push("background");
    return known("bg", s);
  };
  expect(await f.stage("ebn", { command }).result).toBe(original);
  expect(reads).toEqual(["bridge", "background"]);
  reads.length = 0;
  f.outerHost.backgroundMode = (s) => {
    reads.push("background");
    return known(undefined, s);
  };
  const result = await f.stage("ebn", { command }).result;
  expect(result.behavior).toBe("allow");
  expect(reads).toEqual(["bridge", "background", "teammate"]);
});
