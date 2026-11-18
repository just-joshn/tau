import { test, expect } from "bun:test";
import { createNativeBashSecurityShellDocument } from "../../src/native-bash-security/shell-document.js";
import { fixture } from "./security-fixture.js";
function owner() {
  const f = fixture();
  let calls = 0;
  const semantic = {
    ...f.semantic,
    parseCommand: async (input: string) => {
      calls++;
      return f.semantic.parseCommand(input);
    },
  };
  return {
    ...f,
    document: createNativeBashSecurityShellDocument(semantic),
    calls: () => calls,
  };
}
test("native shell document records UTF8 pipe boundaries and output redirects separately", async () => {
  const f = owner();
  const doc = await f.document.parse("printf '雪' > out | wc -c");
  if (doc === null) throw new Error("Missing native shell document");
  expect(doc.getPipeSegments()).toEqual(["printf '雪' > out", "wc -c"]);
  expect(doc.withoutOutputRedirections()).toBe("printf '雪' | wc -c");
  expect(doc.compoundStructure.hasPipeline).toBe(true);
  expect(doc.originalCommand).toBe("printf '雪' > out | wc -c");
  const input = await f.document.parse("cat < input >| forced");
  if (input === null) throw new Error("Missing input redirect document");
  expect(input.withoutOutputRedirections()).toBe("cat < input >| forced");
});
test("native document preserves group, subshell and assignment-stage observations", async () => {
  const f = owner();
  const group = await f.document.parse("{ echo x; } | cat");
  expect(group?.compoundStructure.hasCommandGroup).toBe(true);
  const shell = await f.document.parse("(echo x) | cat");
  expect(shell?.compoundStructure.hasSubshell).toBe(true);
  const assignment = await f.document.parse("A=1 | cat");
  expect(assignment?.hasAssignmentStage).toBe(true);
});
test("process-owner wrapper cache retains identity and invalidates on feature answers", async () => {
  const f = owner();
  const one = await f.document.parse("echo value");
  expect(await f.document.parse("echo value")).toBe(one);
  expect(f.calls()).toBe(1);
  f.semantic.parser.features.registerGrammarReader(() => ({
    value: false,
    source: "payload",
    defaultHost: true,
  }));
  const two = await f.document.parse("echo value");
  expect(two).not.toBe(one);
  expect(f.calls()).toBe(2);
});
test("each source alternate-reader context bypasses wrapper cache and restores its parent", async () => {
  const f = owner();
  const p = f.semantic.parser.features;
  const initial = await f.document.parse("echo value");
  const alternate = [
    () => p.withoutKeywordGuard(() => f.document.parse("echo value")),
    () => p.withoutDollarOperandGuard(() => f.document.parse("echo value")),
    () => p.withoutArithmeticGuard(() => f.document.parse("echo value")),
    () => p.withAlternateArithmeticRead(() => f.document.parse("echo value")),
  ];
  for (const run of alternate) expect(await run()).not.toBe(initial);
  expect(f.calls()).toBe(5);
  expect(await f.document.parse("echo value")).toBe(initial);
  expect(f.calls()).toBe(5);
});
test("cached parser guard observations replay into the current shared observer", async () => {
  const f = fixture();
  let calls = 0;
  const features = f.semantic.parser.features;
  const semantic = {
    ...f.semantic,
    parseCommand: async (input: string) => {
      calls++;
      features.markKeywordDesynchronization();
      features.markMayDiffer();
      return f.semantic.parseCommand(input);
    },
  };
  const doc = createNativeBashSecurityShellDocument(semantic);
  await doc.parse("echo value");
  const observed = await features.observeMayDiffer(() =>
    features.observeKeywordGuard(false, () => doc.parse("echo value")),
  );
  expect(observed.mayDiffer).toBe(true);
  expect(observed.result.fired).toBe(true);
  expect(calls).toBe(1);
});
test("native wrapper parse cap and empty text return null without recovered code execution", async () => {
  const f = owner();
  expect(await f.document.parse("")).toBeNull();
  expect(f.calls()).toBe(0);
  expect(await f.document.parse("x".repeat(10001))).toBeNull();
  expect(f.calls()).toBe(1);
});
