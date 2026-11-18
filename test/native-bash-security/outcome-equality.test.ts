import { expect, test } from "bun:test";
import type { NativeJson } from "../../src/native-session-codec.js";
import { equalNativeBashOutcomes as equal } from "../../src/native-bash-security/outcome-equality.js";
import {
  NativeBashSecurityUnsupported,
  type NativeBashSecurityDecision as Decision,
} from "../../src/native-bash-security/security-types.js";

function suggestions(reverse = false): Decision {
  const directories = ["/one", "/two"];
  return {
    behavior: "ask",
    suggestions: (reverse ? directories.toReversed() : directories).map(
      (directory) => ({
        type: "addDirectories",
        directories: [directory],
        destination: "session",
      }),
    ),
  };
}
function compound(value: Decision): Decision {
  return {
    behavior: "ask",
    decisionReason: {
      type: "subcommandResults",
      reasons: new Map([["command", value]]),
    },
  };
}

test("native outcome comparison retains key presence, NaN and signed-zero semantics", () => {
  expect(
    equal({ behavior: "ask" }, { behavior: "ask", message: undefined }),
  ).toBe(false);
  expect(
    equal(
      { behavior: "allow", metadata: NaN },
      { behavior: "allow", metadata: NaN },
    ),
  ).toBe(true);
  expect(
    equal(
      { behavior: "allow", metadata: -0 },
      { behavior: "allow", metadata: 0 },
    ),
  ).toBe(true);
  expect(equal({ behavior: "deny" }, { behavior: "ask" })).toBe(false);
});

test("native Map comparison propagates unordered flags into nested suggestion arrays", () => {
  expect(equal(suggestions(), suggestions(true))).toBe(false);
  expect(equal(compound(suggestions()), compound(suggestions(true)))).toBe(
    true,
  );
  const first: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "subcommandResults",
      reasons: new Map([
        ["one", { behavior: "allow" }],
        ["two", { behavior: "deny" }],
      ]),
    },
  };
  const second: Decision = {
    behavior: "ask",
    decisionReason: {
      type: "subcommandResults",
      reasons: new Map([
        ["two", { behavior: "deny" }],
        ["one", { behavior: "allow" }],
      ]),
    },
  };
  expect(equal(first, second)).toBe(true);
  expect(
    equal(first, {
      behavior: "ask",
      decisionReason: {
        type: "subcommandResults",
        reasons: new Map([["one", { behavior: "deny" }]]),
      },
    }),
  ).toBe(false);
});

test("native outcome comparison retains cyclic object and subcommand-map pair identity", () => {
  const one: Record<string, NativeJson> = {};
  const two: Record<string, NativeJson> = {};
  one.self = one;
  two.self = two;
  expect(
    equal(
      { behavior: "ask", metadata: one },
      { behavior: "ask", metadata: two },
    ),
  ).toBe(true);
  const first: Decision = { behavior: "ask" };
  const second: Decision = { behavior: "ask" };
  first.decisionReason = {
    type: "subcommandResults",
    reasons: new Map([["self", first]]),
  };
  second.decisionReason = {
    type: "subcommandResults",
    reasons: new Map([["self", second]]),
  };
  expect(equal(first, second)).toBe(true);
  second.message = "different";
  expect(equal(first, second)).toBe(false);
});

test("native sparse arrays compare as indexed values and stack promotes at its source threshold", () => {
  const sparse = Array<NativeJson>(2);
  const dense = Array<NativeJson>(2);
  expect(
    equal(
      { behavior: "ask", metadata: sparse },
      { behavior: "ask", metadata: dense },
    ),
  ).toBe(true);
  const first: Record<string, NativeJson> = {};
  const second: Record<string, NativeJson> = {};
  let one = first;
  let two = second;
  for (let index = 0; index < 220; index++) {
    const nextOne: Record<string, NativeJson> = {};
    const nextTwo: Record<string, NativeJson> = {};
    one.child = nextOne;
    two.child = nextTwo;
    one = nextOne;
    two = nextTwo;
  }
  expect(
    equal(
      { behavior: "ask", metadata: first },
      { behavior: "ask", metadata: second },
    ),
  ).toBe(true);
  two.changed = true;
  expect(
    equal(
      { behavior: "ask", metadata: first },
      { behavior: "ask", metadata: second },
    ),
  ).toBe(false);
});

test("native own enumerable symbols participate while absent inherited constructors do not", () => {
  const symbol = Symbol("authored outcome");
  const first: Decision = { behavior: "ask" };
  const second: Decision = { behavior: "ask" };
  Object.defineProperty(first, symbol, { enumerable: true, value: "one" });
  Object.defineProperty(second, symbol, { enumerable: true, value: "two" });
  expect(equal(first, second)).toBe(false);
  const nullPrototype: Decision = { behavior: "ask" };
  Object.setPrototypeOf(nullPrototype, null);
  expect(equal(nullPrototype, { behavior: "ask" })).toBe(true);
});

test("non-native class/accessor outcomes remain explicit unsupported instead of a false comparison", () => {
  class ExoticOutcome {
    readonly behavior = "ask";
  }
  const one = new ExoticOutcome();
  expect(equal(one, one)).toBe(true);
  expect(() => equal(one, new ExoticOutcome())).toThrow(
    NativeBashSecurityUnsupported,
  );
  const getter: Decision = { behavior: "ask" };
  Object.defineProperty(getter, "message", {
    enumerable: true,
    get: () => "observed",
  });
  expect(() => equal(getter, { behavior: "ask", message: "observed" })).toThrow(
    NativeBashSecurityUnsupported,
  );
});
