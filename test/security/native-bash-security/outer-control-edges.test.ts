import { expect, test } from "bun:test";
import { createOuterFixture } from "./outer-fixture.js";
import { policy } from "./security-fixture.js";
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
const passthrough: Decision = {
  behavior: "passthrough",
  message: "inner passthrough",
  suggestions: [{ type: "setMode", mode: "default", destination: "session" }],
};
const ordinaryAsk: Decision = {
  behavior: "ask",
  message: "ordinary ask",
  decisionReason: { type: "other", reason: "ordinary ask" },
  suggestions: [{ type: "setMode", mode: "default", destination: "session" }],
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
const deny: Decision = { behavior: "deny", message: "inner deny" };
const sandboxReason =
  "Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)";
const loop = "for x in a b; do echo $x; done";

function laterPasses(f: ReturnType<typeof createOuterFixture>, d: Decision) {
  f.main.native.nIe = async (...args) => {
    args[8]?.();
    return d;
  };
}

test.each([
  { name: "passthrough", inner: passthrough, behavior: "passthrough" },
  { name: "ordinary ask", inner: ordinaryAsk, behavior: "ask" },
])(
  "a loop whose later passes differ clears suggestions from an inner $name",
  async ({ inner, behavior }) => {
    const f = createOuterFixture();
    laterPasses(f, inner);
    const result = await f.stage("iIr", { command: loop }).result;
    expect(result.behavior).toBe(behavior);
    expect(result.suggestions).toEqual([]);
  },
);

test("a loop whose later passes differ cannot allow in auto mode", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "auto" }));
  laterPasses(f, allow);
  const result = await f.stage("iIr", { command: loop }).result;
  expect(result.behavior).toBe("passthrough");
  expect(result.decisionReason).toMatchObject({
    bashMissKind: "loop-later-pass",
    acceptEditsCannotAllow: true,
  });
});

test("a loop whose later passes differ asks behind the read block", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ blockReadsOutsideWorkingDirectories: true }));
  laterPasses(f, allow);
  const result = await f.stage("iIr", { command: loop }).result;
  expect(result.behavior).toBe("ask");
  expect(result.decisionReason).toMatchObject({
    type: "safetyCheck",
    circuitBreaker: "outsideReadsBlocked",
  });
  expect(result.suggestions).toEqual([]);
});

test("an exact allow rule for the whole loop keeps the inner allow", async () => {
  const f = createOuterFixture();
  f.add("allow", loop);
  laterPasses(f, allow);
  expect(await f.stage("iIr", { command: loop }).result).toBe(allow);
});

test("a later-pass loop never turns an inner deny into anything else", async () => {
  const f = createOuterFixture();
  laterPasses(f, deny);
  expect(await f.stage("iIr", { command: loop }).result).toBe(deny);
});

test("a sandbox auto-allow is kept for a background command", async () => {
  const f = createOuterFixture();
  const sandboxed: Decision = {
    behavior: "allow",
    decisionReason: { type: "other", reason: sandboxReason },
  };
  f.main.native.nIe = async () => sandboxed;
  expect(await f.stage("iIr", { command: "sleep 1 &" }).result).toBe(sandboxed);
});

function zwn(
  f: ReturnType<typeof createOuterFixture>,
  decision: Decision,
  command: string,
) {
  return f.outerRun(() =>
    f.outer.native.Zwn(decision, { command }, policy({ mode: "default" })),
  );
}

test("prefix rules: a deny rule on any subcommand of an ask denies", () => {
  const f = createOuterFixture();
  const rule = f.add("deny", "rm:*");
  const result = zwn(f, ordinaryAsk, "echo a; rm -rf build");
  expect(result.behavior).toBe("deny");
  expect(result.decisionReason).toEqual({ type: "rule", rule });
});

test("prefix rules: an ask rule on a subcommand is attached to the ask", () => {
  const f = createOuterFixture();
  const rule = f.add("ask", "git push:*");
  expect(zwn(f, ordinaryAsk, "echo a && git push origin")).toEqual({
    ...ordinaryAsk,
    matchedAskRule: rule,
  });
  expect(zwn(f, ordinaryAsk, "git status")).toBe(ordinaryAsk);
});

test("prefix rules: subcommand reasons and arithmetic rereads are also checked", () => {
  const f = createOuterFixture();
  const rule = f.add("deny", "rm:*");
  const nested: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "subcommandResults",
      reasons: new Map([["rm -rf build", ordinaryAsk]]),
    },
  };
  expect(zwn(f, nested, "echo hidden").decisionReason).toEqual({
    type: "rule",
    rule,
  });
  expect(zwn(f, ordinaryAsk, "echo $[1+1]; rm x").behavior).toBe("deny");
});

test("prefix rules do not touch non-asks or asks already from an ask rule", () => {
  const f = createOuterFixture();
  const rule: Rule = f.add("ask", "git push:*");
  f.add("deny", "rm:*");
  expect(zwn(f, allow, "rm x")).toBe(allow);
  const ruled: Decision = {
    behavior: "ask",
    decisionReason: { type: "rule", rule },
  };
  expect(zwn(f, ruled, "rm x")).toBe(ruled);
});

function declarations(
  f: ReturnType<typeof createOuterFixture>,
  names: number,
  first: Decision,
  reading: (prefix: boolean[]) => Decision,
  uncertainWrite = false,
) {
  f.main.native.nIe = async (...args) => {
    const prefix = args[5];
    if (prefix !== undefined) return reading(prefix);
    args[6]?.(names, undefined, uncertainWrite);
    return first;
  };
}

test("declaration-prefix readings: any denying reading denies", async () => {
  const f = createOuterFixture();
  declarations(f, 1, allow, (prefix) => (prefix[0] === true ? deny : allow));
  expect(
    (await f.stage("ibn", { command: "declare x=1" }).result).behavior,
  ).toBe("deny");
});

test("declaration-prefix readings: a non-waivable reading ask replaces an allow", async () => {
  const f = createOuterFixture();
  declarations(f, 1, allow, (prefix) =>
    prefix[0] === true ? backgroundAsk : allow,
  );
  expect(await f.stage("ibn", { command: "declare x=1" }).result).toEqual(
    backgroundAsk,
  );
});

test("declaration-prefix readings: an ordinary reading ask lowers an allow to passthrough", async () => {
  const f = createOuterFixture();
  declarations(f, 1, allow, (prefix) =>
    prefix[0] === true ? ordinaryAsk : allow,
  );
  expect(await f.stage("ibn", { command: "declare x=1" }).result).toEqual({
    behavior: "passthrough",
    message: ordinaryAsk.message,
    decisionReason: ordinaryAsk.decisionReason,
  });
});

test("declaration-prefix readings: an inner passthrough stays when a reading asks", async () => {
  const f = createOuterFixture();
  const first: Decision = { behavior: "passthrough", message: "first" };
  declarations(f, 1, first, () => ordinaryAsk);
  expect(await f.stage("ibn", { command: "declare x=1" }).result).toBe(first);
});

test("declaration-prefix readings: an incomplete reading set cannot confirm an allow", async () => {
  const f = createOuterFixture();
  declarations(f, 4, allow, () => allow);
  const result = await f.stage("ibn", { command: "declare a b c d" }).result;
  expect(result.behavior).toBe("passthrough");
  expect(result.decisionReason).toMatchObject({ bashMissKind: "too-complex" });
});

test("declaration-prefix readings pass through the caller's transform", async () => {
  const f = createOuterFixture();
  declarations(f, 1, allow, (prefix) => (prefix[0] === true ? deny : allow));
  const seen: string[] = [];
  const result = await f.stage(
    "ibn",
    { command: "declare x=1" },
    f.outerContext(),
    (decision) => {
      seen.push(decision.behavior);
      return undefined;
    },
  ).result;
  expect(result.behavior).toBe("deny");
  expect(seen).toEqual(["allow", "allow", "deny"]);
});

test.each([
  {
    command: "A=1; echo $A",
    reason: "A variable set in this command can't be checked before it runs",
  },
  {
    command: "OLDPWD=/x | cat",
    reason: "A variable set in this command can't be checked before it runs",
  },
  {
    command: "PWD=/tmp; echo hi",
    reason: "A variable set in this command can't be checked before it runs",
  },
  {
    command: "wait *",
    reason:
      "A pattern or ~ word here may become an option, a variable name or a number, so this command can't be checked before it runs",
  },
  {
    command: "echo $((x))",
    reason: "This command couldn't be checked automatically",
  },
])(
  "an inner allow for $command becomes passthrough",
  async ({ command, reason }) => {
    const f = createOuterFixture();
    f.main.native.nIe = async () => allow;
    const result = await f.stage("ibn", { command }).result;
    expect(result).toMatchObject({
      behavior: "passthrough",
      decisionReason: {
        type: "other",
        reason,
        bashMissKind: "assigned-variable",
      },
      suggestions: [],
    });
  },
);

test.each(["export PWD=/tmp", "read ~", "echo *"])(
  "an inner allow for %s stays allowed",
  async (command) => {
    const f = createOuterFixture();
    f.main.native.nIe = async () => allow;
    expect(await f.stage("ibn", { command }).result).toBe(allow);
  },
);

test("an exact allow rule for the command skips the assigned-variable check", async () => {
  const f = createOuterFixture();
  const rule = f.add("allow", "A=1; echo $A");
  const exact: Decision = {
    behavior: "allow",
    decisionReason: { type: "rule", rule },
  };
  f.main.native.nIe = async () => exact;
  expect(await f.stage("ibn", { command: "A=1; echo $A" }).result).toBe(exact);
});

test("an inner ask for an assigned-variable command loses its suggestions", async () => {
  const f = createOuterFixture();
  f.main.native.nIe = async () => ordinaryAsk;
  const result = await f.stage("ibn", { command: "A=1; echo $A" }).result;
  expect(result).toEqual({ ...ordinaryAsk, suggestions: [] });
});

function environment(
  f: ReturnType<typeof createOuterFixture>,
  refused: Decision,
  accepted: Decision | (() => never),
) {
  f.main.native.nIe = async () => {
    if (f.syntax.preparation.features.refuseEnvironment()) return refused;
    if (typeof accepted === "function") return accepted();
    return accepted;
  };
}

test("environment reread: a stricter accepted reading replaces a refused passthrough", async () => {
  const f = createOuterFixture();
  environment(f, passthrough, backgroundAsk);
  expect(await f.stage("sbn", { command: "echo hi" }).result).toEqual({
    ...backgroundAsk,
    suggestions: [],
  });
});

test("environment reread: bypass mode keeps the refused reading over an ordinary safety ask", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "bypassPermissions" }));
  environment(f, passthrough, backgroundAsk);
  expect(await f.stage("sbn", { command: "echo hi" }).result).toBe(passthrough);
});

test("environment reread: an ordinary accepted ask over a refused allow stands in under hook asks", async () => {
  const f = createOuterFixture();
  environment(f, allow, ordinaryAsk);
  expect(await f.stage("sbn", { command: "echo hi" }).result).toEqual({
    ...ordinaryAsk,
    standsInUnderHookAsk: true,
  });
});

test("environment reread: equal ordinary asks keep the refused reading", async () => {
  const f = createOuterFixture();
  const refused: Decision = { ...ordinaryAsk, message: "refused" };
  environment(f, refused, ordinaryAsk);
  expect(await f.stage("sbn", { command: "echo hi" }).result).toEqual({
    ...refused,
    standsInUnderHookAsk: true,
  });
});

test("environment reread: an accepted deny wins", async () => {
  const f = createOuterFixture();
  environment(f, allow, deny);
  expect(await f.stage("sbn", { command: "echo hi" }).result).toBe(deny);
});

test("environment reread: allowed domains in auto mode go to the classifier", async () => {
  const f = createOuterFixture();
  f.setOuterPolicy(policy({ mode: "auto" }));
  environment(f, allow, ordinaryAsk);
  const result = await f.stage("sbn", {
    command: "curl example.test",
    allowed_domains: ["example.test"],
  }).result;
  expect(result).toMatchObject({
    behavior: "ask",
    decisionReason: { type: "safetyCheck", classifierApprovable: true },
    standsInUnderHookAsk: true,
  });
});

test("environment reread: an ordinary failure reports and falls back to an unfinished check", async () => {
  const f = createOuterFixture();
  const failure = new Error("accepted reading failed");
  environment(f, allow, () => {
    throw failure;
  });
  const result = await f.stage("sbn", { command: "echo hi" }).result;
  expect(result.decisionReason).toMatchObject({
    type: "safetyCheck",
    circuitBreaker: "unfinishedCheck",
  });
  expect(f.outerErrors).toEqual([failure]);
});

test("environment reread: unsupported facts and aborts propagate", async () => {
  const f = createOuterFixture();
  environment(f, allow, () => {
    throw new NativeBashSecurityUnsupported("authored.fact", "missing");
  });
  expect(
    await rejection(f.stage("sbn", { command: "echo hi" }).result),
  ).toBeInstanceOf(NativeBashSecurityUnsupported);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  environment(f, allow, () => {
    throw abort;
  });
  expect(await rejection(f.stage("sbn", { command: "echo hi" }).result)).toBe(
    abort,
  );
  expect(f.outerErrors).toEqual([]);
});

function pathList(
  f: ReturnType<typeof createOuterFixture>,
  first: Decision,
  second: Decision,
  flag: "refused" | "pathListRefused" = "refused",
) {
  f.main.native.nIe = async () => {
    const store = f.syntax.policy.contexts.pathList.getStore();
    if (!store) throw new Error("Missing path-list observer");
    if (store.off) return second;
    store[flag] = true;
    return first;
  };
}

test("path-list reread: a stricter second ask replaces a refused passthrough", async () => {
  const f = createOuterFixture();
  pathList(f, passthrough, ordinaryAsk);
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual(
    ordinaryAsk,
  );
});

test("path-list reread: a non-waivable second ask wins", async () => {
  const f = createOuterFixture();
  pathList(f, allow, backgroundAsk);
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual(
    backgroundAsk,
  );
});

test("path-list reread: an ordinary first ask lowers to passthrough when the second does not ask", async () => {
  const f = createOuterFixture();
  const first: Decision = {
    ...ordinaryAsk,
    blockedPath: "/outside/file",
  };
  pathList(f, first, allow);
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual({
    behavior: "passthrough",
    message: first.message,
    decisionReason: first.decisionReason,
    suggestions: first.suggestions,
    blockedPath: "/outside/file",
  });
  const bare: Decision = { behavior: "ask", message: "bare" };
  pathList(f, bare, allow);
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual({
    behavior: "passthrough",
    message: "bare",
  });
});

test("path-list reread: a non-waivable first ask stays when the second does not ask", async () => {
  const f = createOuterFixture();
  pathList(f, backgroundAsk, allow);
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual(
    backgroundAsk,
  );
});

test("path-list reread: equal rank keeps the refused reading but takes a path-list reread", async () => {
  const f = createOuterFixture();
  const second: Decision = { behavior: "allow", message: "second" };
  pathList(f, allow, second, "refused");
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual(allow);
  pathList(f, allow, second, "pathListRefused");
  expect(await f.stage("JOr", { command: "echo hi" }).result).toEqual(second);
});
