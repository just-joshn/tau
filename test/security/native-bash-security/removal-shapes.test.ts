import { expect, test } from "bun:test";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import { createNativeBashSecurityPolicyControl } from "../../../src/native-bash-security/policy-control.js";
import { createNativeBashSecurityObservations } from "../../../src/native-bash-security/security-observations.js";
import { createNativeBashInlineScript } from "../../../src/native-bash-security/inline-script.js";
import { createNativeBashSecurityOutcomeControl } from "../../../src/native-bash-security/outcome-control.js";
import { createNativeBashSecurityRemovalShapes } from "../../../src/native-bash-security/removal-shapes.js";
import { fixture, known, policy } from "./security-fixture.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
} from "../../../src/native-bash-security/security-types.js";

function owner() {
  const f = fixture();
  const prep = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const control = createNativeBashSecurityPolicyControl(
    f.semantic,
    prep,
    f.host,
  );
  const observations = createNativeBashSecurityObservations(control);
  const inline = createNativeBashInlineScript(
    f.semantic,
    prep,
    control.pathOwner,
  );
  const outcomes = createNativeBashSecurityOutcomeControl(
    (_tool: string, reason?: Reason) =>
      reason?.type === "other" ? reason.reason : "authored-reason",
  );
  const events: string[] = [];
  const reads: string[] = [];
  let strict = false;
  let enabled = true;
  const shapes = createNativeBashSecurityRemovalShapes(
    observations,
    inline,
    outcomes,
    {
      strictInlineShellRemovalDisabled: (s) => {
        reads.push("strict");
        return known(strict, s);
      },
      paleKestrel: (s) => {
        reads.push("feature");
        return known(enabled, s);
      },
      removalShapeEvent: (shape, s) => {
        events.push(shape);
        return known(undefined, s);
      },
    },
  );
  function run<T>(callback: () => T) {
    return shapes.withPolicyScope(policy(), "/work", callback).result;
  }
  return {
    ...f,
    shapes,
    events,
    reads,
    run,
    observations,
    inline,
    outcomes,
    setStrict(value: boolean) {
      strict = value;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
  };
}
function safety(reason: string, removalRule = "literalTarget"): Decision {
  return {
    behavior: "ask",
    message: reason,
    decisionReason: {
      type: "safetyCheck",
      reason,
      circuitBreaker: "dangerousRemoval",
      classifierApprovable: false,
      removalRule,
    },
    suggestions: [],
  };
}

test("native inline shape tests retain quoting, variable joining, continuations and ANSI encoding", () => {
  const f = owner();
  for (const text of [
    "rm -rf /",
    "r\\\nm -rf /",
    'r""m /',
    "r${EMPTY}m /",
    "${CMD:-rm} /",
    "C:/bin/rm.exe /",
  ])
    expect(f.shapes.native.Xde(text)).toBe(true);
  for (const text of ["perform task", "confirm", "wormhole", "echo harmless"])
    expect(f.shapes.native.Xde(text)).toBe(false);
  expect(f.shapes.native.Ylt("$'r\\x6d' -rf /")).toBe(true);
  expect(f.shapes.native.Ylt("$'plain' argument")).toBe(false);
  expect(f.shapes.native.Dbn("echo {one,two}")).toBe(true);
  expect(f.shapes.native.Dbn("$COMMAND /tmp")).toBe(true);
  expect(f.shapes.native.ZOe("one && two")).toBe(true);
  for (const text of ["one || two", "one; two", "one\ntwo", "one & two"])
    expect(f.shapes.native.ZOe(text)).toBe(false);
});

test("strict inline feature reads retain short-circuit order and absent capabilities stay unsupported", () => {
  const f = owner();
  expect(f.run(() => f.shapes.native.XOe("echo harmless"))).toBe(false);
  expect(f.reads).toEqual(["strict", "feature"]);
  f.setStrict(true);
  expect(f.run(() => f.shapes.native.XOe("echo harmless"))).toBe(true);
  expect(f.reads).toEqual(["strict", "feature", "strict"]);
  f.setStrict(false);
  f.setEnabled(false);
  expect(f.run(() => f.shapes.native.XOe("echo harmless"))).toBe(true);
  const unsupported = createNativeBashSecurityRemovalShapes(
    f.observations,
    f.inline,
    f.outcomes,
    {},
  );
  expect(() =>
    unsupported.withPolicyScope(policy(), "/work", () =>
      unsupported.native.XOe("rm /"),
    ),
  ).toThrow(NativeBashSecurityUnsupported);
});

test("native unchecked-shell prompts preserve depth telemetry and counterfactual suppression", () => {
  const f = owner();
  const denied = f.run(() => f.shapes.native.QOe(true, 0));
  expect(denied.behavior).toBe("ask");
  expect(denied.decisionReason).toMatchObject({
    removalRule: "inline_shell_unchecked",
    classifierApprovable: false,
  });
  expect(denied.message).toContain("permission rule denies");
  f.run(() => f.shapes.native.QOe(false, 1));
  f.run(() => f.observations.native.N6(() => f.shapes.native.QOe(false, 0)));
  expect(f.events).toEqual(["inline_shell_unchecked"]);
});

test("placeholder descriptions retain actual rules and source ask-only generic-complexity membership", () => {
  const f = owner();
  const input = safety("Dangerous rm on __CMDSUB__", "emptyExpansion");
  const rewritten = f.shapes.native.BOr(input);
  expect(rewritten).not.toBe(input);
  expect(rewritten.decisionReason).toMatchObject({
    removalRule: "emptyExpansion",
    circuitBreaker: "dangerousRemoval",
  });
  expect(rewritten.message).toContain("${NAME:?}");
  const literal = safety("Dangerous rm on /literal");
  expect(f.shapes.native.BOr(literal)).toBe(literal);
  expect(
    f.shapes.native.WOr({
      behavior: "ask",
      decisionReason: {
        type: "other",
        reason: "complex",
        bashMissKind: "too-complex",
      },
    }),
  ).toBe("too-complex");
  expect(
    f.shapes.native.WOr({
      behavior: "deny",
      decisionReason: {
        type: "other",
        reason: "complex",
        bashMissKind: "too-complex",
      },
    }),
  ).toBeUndefined();
  expect(
    f.shapes.native.WOr({
      behavior: "ask",
      decisionReason: {
        type: "other",
        reason: "path",
        bashMissKind: "dangerous-path",
      },
    }),
  ).toBeUndefined();
});

test("nested removal combination retains mounted-drive ambiguity until a definitive removal verdict", () => {
  const f = owner();
  expect(
    f.shapes.native.oat(
      "Dangerous rm operation on possibly-empty variable path: ${…}VALUE (use a literal path: when the expansion is empty this removes /tmp)",
    ),
  ).toBe("placeholder_root_child");
  expect(
    f.shapes.native.oat("Dangerous rmdir operation on drive root: \\\\"),
  ).toBe("backslash_only");
  const mounted = {
    result: safety("Dangerous rm operation on mounted drive path: /c/work"),
    kind: "literalTarget",
  };
  expect(f.shapes.native.rlt(mounted.result)).toBe(true);
  expect(f.shapes.native.rlt({ ...mounted.result, behavior: "allow" })).toBe(
    false,
  );
  const previous = { result: mounted.result, kind: "literalTarget" };
  const denied: Decision = { behavior: "deny" };
  const later = { result: denied, kind: "emptyExpansion" };
  expect(
    f.shapes.native.v8(
      { result: previous.result, kind: "literalTarget" },
      { result: later.result, kind: "emptyExpansion" },
    ).result,
  ).toBe(previous.result);
  const definitive = f.shapes.native.C8();
  expect(
    f.shapes.native.v8(
      { result: previous.result, kind: "literalTarget" },
      definitive,
    ),
  ).toBe(definitive);
});
