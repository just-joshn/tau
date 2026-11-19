import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowBody } from "../../src/workflow-runtime.js";

const meta = "export const meta = { name: 'x', description: 'x' }\n";

test("return-only scripts complete", async () => {
  const one = await runWorkflowBody(`${meta}return 1`);
  assert.equal(one.kind === "completed" && one.result, 1);
  const obj = await runWorkflowBody(`${meta}return { ok: true }`);
  assert.deepEqual(obj.kind === "completed" && obj.result, { ok: true });
  const none = await runWorkflowBody(`${meta}await 0`);
  assert.equal(none.kind === "completed" && none.result, undefined);
});

test("args are JSON-cloned", async () => {
  const input = { a: [1] };
  const out = await runWorkflowBody(`${meta}return args`, { args: input });
  assert.deepEqual(out.kind === "completed" && out.result, input);
  assert.notEqual(out.kind === "completed" && out.result, input);
});

test("host functions fail clearly", async () => {
  for (const name of ["agent", "parallel", "pipeline", "phase", "log"]) {
    const out = await runWorkflowBody(`${meta}return ${name}('x')`);
    assert.equal(out.kind, "failed");
    assert.match(
      out.kind === "failed" ? out.error : "",
      new RegExp(`${name}\\(\\) is not available`),
    );
  }
});

test("bad scripts fail", async () => {
  const noMeta = await runWorkflowBody("return 1");
  assert.equal(noMeta.kind, "failed");
  const syntax = await runWorkflowBody(`${meta}return (`);
  assert.equal(syntax.kind, "failed");
  const thrown = await runWorkflowBody(`${meta}throw 'boom'`);
  assert.equal(thrown.kind === "failed" && thrown.error, "boom");
});
