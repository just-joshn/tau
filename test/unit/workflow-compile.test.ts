import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  compileWorkflowBody,
  parseWorkflowScript,
  stripWorkflowMeta,
  workflowTool,
} from "../../src/workflow-tool.js";

const meta = `export const meta = { name: "w", description: "d", phases: [] };\n`;

test("good body compiles, meta is stripped", () => {
  const text = `${meta}const r = await agent("x");\nreturn r;`;
  assert.equal(compileWorkflowBody(text), undefined);
  assert.ok(!stripWorkflowMeta(text).includes("export"));
});

test("broken body reports parse error", () => {
  const msg = compileWorkflowBody(`${meta}const = ;`);
  assert.ok(msg?.startsWith("Script parse error: "));
});

test("script without leading meta fails like XT", () => {
  assert.match(compileWorkflowBody("await 1;") ?? "", /must be the FIRST/);
  assert.match(compileWorkflowBody("if (") ?? "", /^Script parse error: /);
});

test("parseWorkflowScript reads nested phases without false name match", () => {
  const text = `export const meta = { name: "outer", description: "d", phases: [{ title: "t", name: "inner", model: "m" }] };\nreturn 1;`;
  const parsed = parseWorkflowScript(text);
  assert.ok("meta" in parsed);
  assert.equal(parsed.meta.name, "outer");
  assert.deepEqual(parsed.meta.phases, [{ title: "t", model: "m" }]);
  assert.equal(parsed.scriptBody, "return 1;");
});

test("meta validation and purity errors", () => {
  const err = (t: string) => {
    const p = parseWorkflowScript(t);
    return "error" in p ? p.error : "";
  };
  assert.match(err(`export const meta = { name: "", description: "d" };`), /meta.name must be/);
  assert.match(err(`export const meta = { name: "n" };`), /meta.description must be/);
  assert.match(err(`export const meta = { name: x, description: "d" };`), /pure literal: non-literal node type in meta: Identifier/);
  assert.match(err(`export const meta = { ["a"]: 1 };`), /computed keys/);
});

test("validate fails broken inline script", async () => {
  const tool = workflowTool();
  const input = { script: `${meta}let = = 1` };
  assert.ok((await tool.validate?.(input))?.startsWith("Script parse error: "));
  assert.equal(await tool.validate?.({ script: `${meta}await 1;` }), undefined);
});
