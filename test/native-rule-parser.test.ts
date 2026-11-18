import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  nativeIsAllowCompatibility,
  nativeNgRuleValue,
  nativeRawRuleSyntax,
  type NativeNgContext,
} from "../src/native-rule-parser.js";

function context(feature = true): NativeNgContext {
  return {
    aliases: { Task: "Agent", Eval: "REPL" },
    selectedCompatibilityTools: new Set([
      "Read",
      "Edit",
      "Write",
      "NotebookEdit",
      "Glob",
      "Grep",
      "LSP",
      "SendUserFile",
    ]),
    loneStarFeature: () => feature,
  };
}

test("actual Ng preserves allow-only selected compatibility instead of collapsing it into bare", () => {
  for (const toolName of context().selectedCompatibilityTools)
    for (const text of [`${toolName}(*)`, `${toolName}()`]) {
      assert.deepEqual(nativeNgRuleValue(text, "allow", context()), {
        toolName,
        ruleContent: "*",
      });
      assert.deepEqual(nativeNgRuleValue(text, "deny", context()), {
        toolName,
      });
      assert.deepEqual(nativeNgRuleValue(text, "ask", context()), {
        toolName,
      });
    }
  assert.deepEqual(nativeNgRuleValue("Read", "allow", context()), {
    toolName: "Read",
  });
});

test("feature owner is reached only for an eligible raw selected allow form", () => {
  let calls = 0;
  const owner = {
    ...context(),
    loneStarFeature() {
      calls++;
      return true;
    },
  };
  for (const text of ["Read", "Read(path)", "Unknown(*)", "Task(*)"])
    nativeNgRuleValue(text, "allow", owner);
  nativeNgRuleValue("Read(*)", "deny", owner);
  assert.equal(calls, 0);
  nativeNgRuleValue("Read(*)", "allow", owner);
  assert.equal(calls, 1);
});

test("inactive compatibility feature follows actual xr bare output", () => {
  assert.deepEqual(nativeNgRuleValue("Write(*)", "allow", context(false)), {
    toolName: "Write",
  });
  assert.deepEqual(nativeNgRuleValue("Write()", "allow", context(false)), {
    toolName: "Write",
  });
});

test("actual alias table applies at xr while joi eligibility uses the literal selected name", () => {
  const owner = context();
  assert.deepEqual(nativeNgRuleValue("Task(path)", "allow", owner), {
    toolName: "Agent",
    ruleContent: "path",
  });
  assert.deepEqual(nativeNgRuleValue("Eval", "deny", owner), {
    toolName: "REPL",
  });
  assert.deepEqual(
    nativeNgRuleValue("Reader(*)", "allow", {
      ...owner,
      aliases: { Reader: "Read" },
    }),
    { toolName: "Read" },
  );
});

test("raw syntax keeps empty-name calls separate from malformed literal fallback", () => {
  assert.deepEqual(nativeRawRuleSyntax("(x)"), {
    kind: "call",
    toolName: "",
    rawContent: "x",
  });
  assert.deepEqual(nativeNgRuleValue("(x)", "allow", context()), {
    toolName: "(x)",
  });
  assert.deepEqual(nativeRawRuleSyntax("Read(path) tail"), {
    kind: "malformed",
  });
  assert.deepEqual(nativeNgRuleValue("Read(path) tail", "allow", context()), {
    toolName: "Read(path) tail",
  });
});

test("native delimiter parity and content escape order preserve literal path syntax", () => {
  const text = String.raw`Read(folder\(literal\)\\file)`;
  assert.deepEqual(nativeRawRuleSyntax(text), {
    kind: "call",
    toolName: "Read",
    rawContent: String.raw`folder\(literal\)\\file`,
  });
  assert.deepEqual(nativeNgRuleValue(text, "allow", context()), {
    toolName: "Read",
    ruleContent: String.raw`folder(literal)\file`,
  });
  assert.deepEqual(nativeRawRuleSyntax(String.raw`Read\(name\)`), {
    kind: "bare",
  });
});

test("actual aW still requires the selected native set and current feature owner", () => {
  assert.equal(
    nativeIsAllowCompatibility(
      { toolName: "Read", ruleContent: "*" },
      context(),
    ),
    true,
  );
  assert.equal(
    nativeIsAllowCompatibility({ toolName: "Read" }, context()),
    false,
  );
  assert.equal(
    nativeIsAllowCompatibility(
      { toolName: "Other", ruleContent: "*" },
      context(),
    ),
    false,
  );
  assert.equal(
    nativeIsAllowCompatibility(
      { toolName: "Read", ruleContent: "*" },
      context(false),
    ),
    false,
  );
});
