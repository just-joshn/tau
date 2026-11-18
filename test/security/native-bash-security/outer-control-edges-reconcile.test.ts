import { expect, test } from "bun:test";
import { createOuterFixture } from "./outer-fixture.js";
import { known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityRule as Rule,
} from "../../../src/native-bash-security/security-types.js";

/** Settles a promise and returns its rejection, or "resolved" when it fulfils. */
async function rejection(pending: unknown): Promise<unknown> {
  try {
    await Promise.resolve(pending);
  } catch (error) {
    return error;
  }
  return "resolved";
}

const allow: Decision = {
  behavior: "allow",
  message: "inner allow",
  decisionReason: { type: "mode", mode: "default" },
};
const ordinaryAsk: Decision = {
  behavior: "ask",
  message: "ordinary ask",
  decisionReason: { type: "other", reason: "ordinary ask" },
};
const backgroundAsk: Decision = {
  behavior: "ask",
  message: "background",
  decisionReason: {
    type: "safetyCheck",
    reason: "background",
    circuitBreaker: "backgroundOperator",
    classifierApprovable: false,
  },
};
const restrictedAsk: Decision = {
  behavior: "ask",
  message: "restricted",
  decisionReason: {
    type: "safetyCheck",
    reason: "restricted",
    circuitBreaker: "restrictedMode",
    classifierApprovable: false,
  },
  suggestions: [{ type: "setMode", mode: "default", destination: "session" }],
};
const askRule: Rule = {
  source: "projectSettings",
  ruleBehavior: "ask",
  ruleValue: { toolName: "Bash", ruleContent: "cat:*" },
};
const ruleAsk: Decision = {
  behavior: "ask",
  message: "ask rule",
  decisionReason: { type: "rule", rule: askRule },
};
const unfinished = {
  type: "safetyCheck",
  circuitBreaker: "unfinishedCheck",
};
type Fixture = ReturnType<typeof createOuterFixture>;
type Inner = Decision | (() => never);
const answer = (inner: Inner) =>
  typeof inner === "function" ? inner() : inner;
const fail = (error: Error) => () => {
  throw error;
};
function aborted() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

// Each wrapper reruns the inner check under an alternate reading; these
// helpers return `first` for the ordinary reading and `second` for the rerun.
function unicode(f: Fixture, first: Inner, second: Inner) {
  f.main.native.nIe = async (input) =>
    answer(input.command.includes("�") ? second : first);
}
const privateUse = "echo private";

test("Unicode reread: an ordinary replacement ask does not override the original", async () => {
  const f = createOuterFixture();
  unicode(f, allow, ordinaryAsk);
  expect(await f.stage("zOr", { command: privateUse }).result).toBe(allow);
});

test("Unicode reread: a non-waivable replacement circuit replaces the original", async () => {
  const f = createOuterFixture();
  unicode(f, allow, restrictedAsk);
  expect(await f.stage("zOr", { command: privateUse }).result).toEqual({
    ...restrictedAsk,
    suggestions: [],
  });
});

test("Unicode reread: a replacement ask rule replaces the original", async () => {
  const f = createOuterFixture();
  unicode(f, allow, ruleAsk);
  expect(await f.stage("zOr", { command: privateUse }).result).toEqual({
    ...ruleAsk,
    suggestions: [],
  });
});

test("Unicode reread: a lower-ranked replacement keeps the original", async () => {
  const f = createOuterFixture();
  unicode(f, restrictedAsk, ordinaryAsk);
  expect(await f.stage("zOr", { command: privateUse }).result).toBe(
    restrictedAsk,
  );
});

test("Unicode reread: auto mode keeps an ordinary safety ask when removal review is off", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "auto" }));
  f.nested.host.dangerousRemovalTimeoutDisabled = (s) => known(true, s);
  unicode(f, backgroundAsk, restrictedAsk);
  expect(await f.stage("zOr", { command: privateUse }).result).toBe(
    backgroundAsk,
  );
  unicode(f, allow, restrictedAsk);
  expect(
    await f.stage("zOr", {
      command: privateUse,
      dangerouslyDisableSandbox: true,
    }).result,
  ).toBe(allow);
});

test("Unicode reread: removal review on lets the replacement circuit through in auto mode", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "auto" }));
  unicode(f, backgroundAsk, restrictedAsk);
  expect(
    (await f.stage("zOr", { command: privateUse }).result).decisionReason,
  ).toMatchObject({ circuitBreaker: "restrictedMode" });
});

test("Unicode reread: an ordinary failure reports and falls back to an unfinished check", async () => {
  const f = createOuterFixture();
  const failure = new Error("replacement failed");
  unicode(f, allow, fail(failure));
  expect(
    (await f.stage("zOr", { command: privateUse }).result).decisionReason,
  ).toMatchObject(unfinished);
  expect(f.outerErrors).toEqual([failure]);
});

test("Unicode reread: a failing error reporter does not hide the fallback", async () => {
  const f = createOuterFixture();
  f.outerHost.reportError = () => {
    throw new Error("reporter down");
  };
  unicode(f, allow, fail(new Error("replacement failed")));
  expect(
    (await f.stage("zOr", { command: privateUse }).result).decisionReason,
  ).toMatchObject(unfinished);
  f.outerHost.reportError = () => {
    throw new NativeBashSecurityUnsupported("errors.report", "missing");
  };
  expect(
    await rejection(f.stage("zOr", { command: privateUse }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
});

test("Unicode reread: unsupported facts and aborts of an aborted call propagate", async () => {
  const f = createOuterFixture();
  unicode(
    f,
    allow,
    fail(new NativeBashSecurityUnsupported("authored.fact", "missing")),
  );
  expect(
    await rejection(f.stage("zOr", { command: privateUse }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
  const abort = aborted();
  unicode(f, allow, fail(abort));
  const context = f.outerContext();
  context.abortController.abort();
  expect(
    await rejection(f.stage("zOr", { command: privateUse }, context).result),
  ).toBe(abort);
  // The same abort error on a live call is an ordinary failure.
  expect(
    (await f.stage("zOr", { command: privateUse }).result).decisionReason,
  ).toMatchObject(unfinished);
});

const pwd = 'cat "$PWD/file"';
function cwdSpelling(f: Fixture, first: Inner, second: Inner) {
  f.policyHost.readOnly = (input, _context, s) =>
    known(input.command.startsWith("cat "), s);
  f.main.native.nIe = async (input) =>
    answer(input.command.includes("$PWD") ? first : second);
}

test("cwd spelling: a stricter expanded ask keeps the original input", async () => {
  const f = createOuterFixture();
  const second: Decision = {
    ...backgroundAsk,
    updatedInput: { command: 'cat "/work/file"' },
  };
  cwdSpelling(f, { behavior: "passthrough", message: "first" }, second);
  expect(await f.stage("ebn", { command: pwd }).result).toEqual({
    ...second,
    updatedInput: { command: pwd },
  });
});

test("cwd spelling: an expanded ask rule replaces an allow", async () => {
  const f = createOuterFixture();
  cwdSpelling(f, allow, ruleAsk);
  expect(await f.stage("ebn", { command: pwd }).result).toBe(ruleAsk);
});

test("cwd spelling: a too-complex original is not rewritten", async () => {
  const f = createOuterFixture();
  const command = 'cat "$PWD/$(x)"';
  cwdSpelling(f, ordinaryAsk, () => {
    throw new Error("must not reread");
  });
  expect(await f.stage("ebn", { command }).result).toBe(ordinaryAsk);
  expect(f.outerErrors).toEqual([]);
});

test("cwd spelling: a milder expanded reading downgrades only in plain interactive modes", async () => {
  const f = createOuterFixture();
  const second: Decision = { behavior: "passthrough", message: "expanded" };
  cwdSpelling(f, ordinaryAsk, second);
  expect(await f.stage("ebn", { command: pwd }).result).toBe(second);
  f.setOuterPolicy(policy({ mode: "acceptEdits" }));
  expect(await f.stage("ebn", { command: pwd }).result).toBe(second);
  f.setOuterPolicy(policy({ mode: "plan" }));
  expect(await f.stage("ebn", { command: pwd }).result).toBe(ordinaryAsk);
  f.setOuterPolicy(policy({ alwaysAskRules: { session: ["Read(/x)"] } }));
  expect(await f.stage("ebn", { command: pwd }).result).toBe(ordinaryAsk);
  f.setOuterPolicy(policy({ alwaysAskRules: { session: undefined } }));
  expect(await f.stage("ebn", { command: pwd }).result).toBe(second);
});

test("cwd spelling: a failed reread reports and asks unless the original already asks", async () => {
  const f = createOuterFixture();
  const failure = new Error("reread failed");
  cwdSpelling(f, allow, fail(failure));
  expect(await f.stage("ebn", { command: pwd }).result).toEqual({
    behavior: "ask",
    message: "This command could not be fully checked",
    decisionReason: { type: "other", reason: "permission_check_crashed" },
  });
  expect(f.outerErrors).toEqual([failure]);
  cwdSpelling(f, ordinaryAsk, fail(failure));
  expect(await f.stage("ebn", { command: pwd }).result).toBe(ordinaryAsk);
});

test("cwd spelling: reporter failures, unsupported facts and aborts", async () => {
  const f = createOuterFixture();
  f.outerHost.reportError = () => {
    throw new Error("reporter down");
  };
  cwdSpelling(f, ordinaryAsk, fail(new Error("reread failed")));
  expect(await f.stage("ebn", { command: pwd }).result).toBe(ordinaryAsk);
  f.outerHost.reportError = () => {
    throw new NativeBashSecurityUnsupported("errors.report", "missing");
  };
  expect(
    await rejection(f.stage("ebn", { command: pwd }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
  cwdSpelling(
    f,
    allow,
    fail(new NativeBashSecurityUnsupported("authored.fact", "missing")),
  );
  expect(
    await rejection(f.stage("ebn", { command: pwd }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
  const abort = aborted();
  cwdSpelling(f, allow, fail(abort));
  const context = f.outerContext();
  context.abortController.abort();
  expect(
    await rejection(f.stage("ebn", { command: pwd }, context).result),
  ).toBe(abort);
});

function keyword(f: Fixture, first: Inner, second: Inner) {
  const features = f.semantic.parser.features;
  f.main.native.nIe = async () => {
    const off = features.keywordGuardOff();
    features.markKeywordDesynchronization();
    return answer(off ? second : first);
  };
}

test("keyword reread: only a deny from the guard-off reading replaces the original", async () => {
  const f = createOuterFixture();
  keyword(f, allow, ordinaryAsk);
  expect(await f.stage("XOr", { command: "echo hi" }).result).toBe(allow);
});

test("keyword reread: failures report and keep the original; unsupported and aborts propagate", async () => {
  const f = createOuterFixture();
  const failure = new Error("keyword reread failed");
  keyword(f, allow, fail(failure));
  expect(await f.stage("XOr", { command: "echo hi" }).result).toBe(allow);
  expect(f.outerErrors).toEqual([failure]);
  keyword(
    f,
    allow,
    fail(new NativeBashSecurityUnsupported("authored.fact", "missing")),
  );
  expect(
    await rejection(f.stage("XOr", { command: "echo hi" }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
  const abort = aborted();
  keyword(f, allow, fail(abort));
  expect(await rejection(f.stage("XOr", { command: "echo hi" }).result)).toBe(
    abort,
  );
});

function arithmetic(f: Fixture, first: Inner, second: Inner) {
  const features = f.semantic.parser.features;
  f.main.native.nIe = async () =>
    answer(
      features.arithmeticGuardOff() || features.dollarOperandGuardOff()
        ? second
        : first,
    );
}

test("arithmetic reread: an unchanged arithmetic command reading is not reread", async () => {
  const f = createOuterFixture();
  arithmetic(f, ordinaryAsk, fail(new Error("must not reread")));
  expect(await f.stage("YOr", { command: "(( 1 ))" }).result).toEqual(
    ordinaryAsk,
  );
  expect(f.outerErrors).toEqual([]);
});

test("dollar-operand reread: a deny without the operand guard replaces the original", async () => {
  const f = createOuterFixture();
  const deny: Decision = { behavior: "deny", message: "operand deny" };
  arithmetic(f, ordinaryAsk, deny);
  const command = "echo $$(id)";
  const result = await f.stage("YOr", { command }).result;
  expect(result.behavior).toBe("deny");
  expect(result.decisionReason?.type).toBe("subcommandResults");
});

test("dollar-operand reread: failures report and keep the original; unsupported and aborts propagate", async () => {
  const f = createOuterFixture();
  const command = "echo $$(id)";
  const failure = new Error("operand reread failed");
  arithmetic(f, ordinaryAsk, fail(failure));
  expect(await f.stage("YOr", { command }).result).toEqual(ordinaryAsk);
  expect(f.outerErrors).toEqual([failure]);
  f.outerHost.reportError = () => {
    throw new Error("reporter down");
  };
  expect(await f.stage("YOr", { command }).result).toEqual(ordinaryAsk);
  f.outerHost.reportError = () => {
    throw new NativeBashSecurityUnsupported("errors.report", "missing");
  };
  expect(await rejection(f.stage("YOr", { command }).result)).toBeInstanceOf(
    NativeBashSecurityUnsupported,
  );
  arithmetic(
    f,
    allow,
    fail(new NativeBashSecurityUnsupported("authored.fact", "missing")),
  );
  expect(await rejection(f.stage("YOr", { command }).result)).toBeInstanceOf(
    NativeBashSecurityUnsupported,
  );
  const abort = aborted();
  arithmetic(f, ordinaryAsk, fail(abort));
  const context = f.outerContext();
  context.abortController.abort();
  expect(await rejection(f.stage("YOr", { command }, context).result)).toBe(
    abort,
  );
});

test("dangerous removal telemetry: unsupported telemetry propagates, ordinary failures do not block", async () => {
  const f = createOuterFixture();
  const removal: Decision = {
    behavior: "ask",
    message: "removal",
    decisionReason: {
      type: "safetyCheck",
      reason: "removal",
      circuitBreaker: "dangerousRemoval",
      classifierApprovable: false,
    },
  };
  f.main.native.nIe = async () => removal;
  f.outerHost.telemetry = () => {
    throw new Error("telemetry down");
  };
  expect(
    (await f.stage("OIo", { command: "rm -rf build" }).result).behavior,
  ).toBe("ask");
  f.outerHost.telemetry = () => {
    throw new NativeBashSecurityUnsupported("telemetry.outer", "missing");
  };
  expect(
    await rejection(f.stage("OIo", { command: "rm -rf build" }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
});

test("arithmetic feature reader: a failing error reporter is contained, unsupported propagates", () => {
  const f = createOuterFixture();
  f.outerHost.servedValuesChangeCount = () => {
    throw new Error("count failed");
  };
  f.outerHost.reportError = () => {
    throw new Error("reporter down");
  };
  expect(f.outerRun(() => f.outer.native.obn("echo $((1))"))).toBeUndefined();
  f.outerHost.reportError = () => {
    throw new NativeBashSecurityUnsupported("errors.report", "missing");
  };
  expect(() => f.outerRun(() => f.outer.native.obn("echo $((1))"))).toThrow(
    NativeBashSecurityUnsupported,
  );
});
