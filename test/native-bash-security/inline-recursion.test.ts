import { expect, test } from "bun:test";
import {
  createRecursionFixture as owner,
  removal,
} from "./recursion-fixture.js";
test("inline recursion retains safety provenance, shared observation owners and exact cache budgets", async () => {
  const calls: string[] = [];
  let observe: (() => void) | undefined;
  const f = owner(async (input, _context, _prefix, _original, recursion) => {
    calls.push(input.command);
    expect(recursion?.depth).toBe(1);
    observe?.();
    return removal();
  });
  observe = () => {
    expect(f.observations.contexts.removal.getStore()).toEqual({
      ignoreBelowRm: false,
    });
    expect(f.observations.contexts.divergentRead.getStore()).toBe(false);
    expect(f.observations.contexts.checkout.getStore()).toEqual({});
  };
  const command = "sh -c 'rm -rf /'";
  const state = f.context(command);
  const result = await f.run(command, state);
  expect(result?.decisionReason).toMatchObject({
    circuitBreaker: "dangerousRemoval",
    removalRule: "literalTarget",
  });
  expect(result?.message).toContain("shell -c script");
  expect(calls).toEqual(["rm -rf /"]);
  expect(state.budget.left).toBe(31);
  expect(state.budget.chars).toBe(20000 - "rm -rf /".length);
  expect(await f.run(command, state)).toBe(result);
  expect(calls).toHaveLength(1);
  expect(f.events).toEqual(["inline_shell_script"]);
  expect(state.budget.asked.size).toBe(1);
  expect(state.budget.judged.size).toBe(1);
});

test("inline source environment-clearing variants rerun the script without inherited exports", async () => {
  const calls: string[] = [];
  const f = owner(async (input) => {
    calls.push(input.command);
    return { behavior: "allow", updatedInput: input };
  });
  const command = "env -i sh -c 'rm -rf \"$ROOT/cache\"'";
  const result = await f.run(command, f.context(command), [
    { text: "export ROOT=/", cd: false, names: ["ROOT"], exports: true },
  ]);
  expect(result).toBeNull();
  expect(calls).toEqual([
    'export ROOT=/ && rm -rf "$ROOT/cache"',
    'rm -rf "$ROOT/cache"',
  ]);
});

test("denied inner commands and exhausted budgets produce native explicit unchecked prompts", async () => {
  let calls = 0;
  const f = owner(async () => {
    calls++;
    return {
      behavior: "deny",
      decisionReason: { type: "other", reason: "authored rule denial" },
    };
  });
  const command = "bash -c 'rm -rf /'";
  const denied = await f.run(command);
  expect(denied?.message).toContain("permission rule denies");
  expect(denied?.behavior).toBe("ask");
  const state = f.context(command);
  state.budget.left = 0;
  const exhausted = await f.run(command, state);
  expect(exhausted?.decisionReason).toMatchObject({
    removalRule: "inline_shell_unchecked",
    classifierApprovable: false,
  });
  expect(exhausted?.message).toContain("could not check");
  expect(calls).toBe(1);
  expect(state.budget.judged.size).toBe(0);
});

test("native declaration alternate readings consume the same budget before selecting a removal verdict", async () => {
  const readings: (boolean[] | undefined)[] = [];
  const f = owner(
    async (
      input,
      _context,
      _prefix,
      _original,
      _recursion,
      declaration,
      onDeclarations,
    ) => {
      readings.push(declaration);
      if (declaration === undefined) onDeclarations?.(1, [false], false);
      return declaration?.[0] === true
        ? removal()
        : { behavior: "allow", updatedInput: input };
    },
  );
  const command = "sh -c 'rm -rf /'";
  const state = f.context(command);
  const result = await f.run(command, state);
  expect(result?.behavior).toBe("ask");
  expect(readings).toEqual([undefined, [false], [true]]);
  expect(state.budget.left).toBe(29);
});

test("native cwd inference uses factual Bm scope and restores the original getter after recursion", async () => {
  let readCwd: (() => string) | undefined;
  const observed: string[] = [];
  const f = owner(async (input) => {
    observed.push(readCwd?.() ?? "missing");
    return { behavior: "allow", updatedInput: input };
  });
  readCwd = f.currentCwd;
  const command = "cd /work/sub && sh -c 'rm -rf /'";
  expect(await f.run(command)).toBeNull();
  expect(observed).toEqual(["/work/sub"]);
  expect(f.cwdTransitions).toEqual(["/work/sub"]);
  expect(f.currentCwd()).toBe("/work");
});

test("native typed disable flag returns before grammar, feature and recursion caches", async () => {
  let calls = 0;
  const f = owner(async () => {
    calls++;
    return removal();
  });
  const command = "sh -c 'rm -rf /'";
  const state = f.context(command);
  f.setDisabled(true);
  expect(await f.run(command, state)).toBeNull();
  expect(calls).toBe(0);
  expect(state.budget.asked.size).toBe(0);
  expect(state.budget.left).toBe(32);
  f.setDisabled(false);
  expect((await f.run(command, state))?.behavior).toBe("ask");
});
