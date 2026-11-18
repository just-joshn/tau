import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { combineToolPolicy, type ToolPolicy } from "../../src/tool-policy.js";
import { createTools } from "../../src/tools.js";
import type { PermissionMode } from "../../src/types.js";
import { forAll, type Rng } from "../helpers/seeded.js";

// docs/permission-contract.md: explicit deny defeats allow and every mode,
// including bypass; plan mode never runs Write, Edit or Bash, even with an
// allow; rule lists are sets, so their order cannot change a decision.

const CASES = 300;
const BUILTINS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;
const CALLED = ["Read", "Write", "Edit", "Glob", "Bash"] as const;
const MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
const SOURCES = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "policySettings",
];
// Rules for other tools must not affect a built-in decision.
const NOISE = ["TaskStop", "Agent", "mcp__srv__read*", "mcp__other"];

type Called = (typeof CALLED)[number];
type Sourced = NonNullable<ToolPolicy["sourcedRules"]>[number];

interface Case {
  mode: PermissionMode;
  tools: Called[] | undefined;
  allowedTools: string[];
  disallowedTools: string[];
  askedTools: string[];
  sourcedRules: Sourced[];
  call: Called;
  approves: boolean;
}

function wholeToolRule(rng: Rng, name: string): string {
  return rng.pick([name, `${name}(*)`, `${name}()`]);
}

function generate(rng: Rng): Case {
  const rules = () => rng.subset([...BUILTINS, ...NOISE], 0.2);
  return {
    mode: rng.pick(MODES),
    tools: rng.bool(0.25) ? rng.subset(CALLED, 0.8) : undefined,
    allowedTools: rules(),
    disallowedTools: rng.bool(0.5) ? rng.subset(BUILTINS, 0.15) : [],
    askedTools: rng.bool(0.3) ? rng.subset(BUILTINS, 0.2) : [],
    sourcedRules: Array.from({ length: rng.int(0, 5) }, () => ({
      source: rng.pick(SOURCES),
      behavior: rng.pick(["allow", "allow", "deny", "ask"] as const),
      // Read denies also protect Write/Edit; keep them rare so other paths run.
      rule: wholeToolRule(
        rng,
        rng.pick(
          rng.bool(0.1) ? BUILTINS : CALLED.filter((name) => name !== "Read"),
        ),
      ),
    })),
    call: rng.pick(CALLED),
    approves: rng.bool(),
  };
}

function permute(rng: Rng, input: Case): Case {
  return {
    ...input,
    tools: input.tools && rng.shuffle(input.tools),
    allowedTools: rng.shuffle(input.allowedTools),
    disallowedTools: rng.shuffle(input.disallowedTools),
    askedTools: rng.shuffle(input.askedTools),
    sourcedRules: rng.shuffle(input.sourcedRules),
  };
}

/** True when a rule in the contract's whole-tool grammar names `name`. */
function namesTool(rule: string, name: string): boolean {
  return rule === name || rule === `${name}(*)` || rule === `${name}()`;
}

interface Outcome {
  asked: boolean;
  executed: boolean;
  isError: boolean;
  permissionDenied: boolean;
}

async function workspace() {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "tau-prop-perm-")),
  );
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  await writeFile(path.join(base, "existing.txt"), "hello\n");
  return base;
}

async function decide(cwd: string, input: Case, id: string): Promise<Outcome> {
  const policy: ToolPolicy = combineToolPolicy(
    {
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      askedTools: input.askedTools,
    },
    input.sourcedRules,
  );
  let asked = false;
  const tools = createTools({
    cwd,
    mode: input.mode,
    policy,
    approve: async () => {
      asked = true;
      return input.approves;
    },
  });
  const marker = path.join(cwd, `${id}.out`);
  const call = {
    Read: { file_path: "existing.txt" },
    Glob: { pattern: "*.txt" },
    Write: { file_path: marker, content: "x" },
    Edit: { file_path: marker, old_string: "", new_string: "x" },
    Bash: { command: `printf x > '${marker}'` },
  }[input.call];
  const result = await tools.execute(
    { type: "tool_use", id, name: input.call, input: call },
    new AbortController().signal,
  );
  const readonly = input.call === "Read" || input.call === "Glob";
  return {
    asked,
    executed: readonly ? result.is_error !== true : existsSync(marker),
    isError: result.is_error === true,
    permissionDenied: result.permissionDenied === true,
  };
}

test("INV-01 a matching deny never yields allow and rule order never changes a decision", async () => {
  const cwd = await workspace();
  let denied = 0;
  let executed = 0;
  await forAll(
    "permission decisions",
    CASES,
    (rng) => {
      const input = generate(rng);
      return { input, permuted: permute(rng, input) };
    },
    async ({ input, permuted }, index) => {
      const outcome = await decide(cwd, input, `c${index}`);
      const deny =
        input.disallowedTools.includes(input.call) ||
        input.sourcedRules.some(
          (rule) =>
            rule.behavior === "deny" && namesTool(rule.rule, input.call),
        );
      if (deny) {
        denied++;
        assert.deepEqual(outcome, {
          asked: false,
          executed: false,
          isError: true,
          permissionDenied: true,
        });
      }
      if (
        input.mode === "plan" &&
        input.call !== "Read" &&
        input.call !== "Glob"
      )
        assert.equal(outcome.executed, false, "plan mode ran a mutating tool");
      if (outcome.executed) executed++;
      // An approval prompt answered "no" can never run the tool.
      if (outcome.asked && !input.approves)
        assert.equal(outcome.executed, false);
      assert.deepEqual(
        await decide(cwd, permuted, `p${index}`),
        outcome,
        "permuting the rule lists changed the decision",
      );
    },
  );
  // The generator must reach both sides of the decision.
  assert.ok(denied > CASES / 10, `only ${denied} deny cases`);
  assert.ok(executed > CASES / 10, `only ${executed} executed cases`);
});
