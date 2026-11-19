import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  compileWorkflowBody,
  stripWorkflowMeta,
  workflowTool,
} from "../../src/workflow-tool.js";

const meta = `export const meta = { name: "w", description: "d", phases: [] };\n`;

test("good body compiles, meta is stripped", () => {
  const text = `${meta}const r = await agent("x");\nreturn r;`;
  assert.equal(compileWorkflowBody(text), undefined);
  assert.ok(!stripWorkflowMeta(text).includes("export"));
});

test("broken body reports SyntaxError", () => {
  const msg = compileWorkflowBody(`${meta}const = ;`);
  assert.ok(msg?.startsWith("SyntaxError: "));
});

test("script without meta is checked as-is", () => {
  assert.equal(compileWorkflowBody("await 1;"), undefined);
  assert.ok(compileWorkflowBody("if (")?.startsWith("SyntaxError: "));
});

test("validate fails broken inline script", async () => {
  const tool = workflowTool();
  const input = { script: `${meta}let = = 1` };
  assert.ok(
    (await tool.validate?.(input, {} as never))?.startsWith("SyntaxError: "),
  );
  assert.equal(
    await tool.validate?.({ script: `${meta}await 1;` }, {} as never),
    undefined,
  );
});
