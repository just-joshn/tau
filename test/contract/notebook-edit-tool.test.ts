import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { ReadState } from "../../src/read-state.js";
import { createTools } from "../../src/tools.js";
import type { PermissionMode } from "../../src/types.js";

const NOTEBOOK = JSON.stringify(
  {
    cells: [
      { cell_type: "code", id: "a", metadata: {}, source: "1", outputs: [] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  },
  null,
  1,
);

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "tau-notebook-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "root");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "n.ipynb"), NOTEBOOK);
  const approvals: string[] = [];
  const readState = new ReadState();
  const tools = (mode: PermissionMode = "acceptEdits", allowed = true) =>
    createTools({
      cwd,
      mode,
      readState,
      approve: async (description) => {
        approvals.push(description);
        return allowed;
      },
    });
  const run = (
    executor: ReturnType<typeof createTools>,
    name: string,
    input: Record<string, unknown>,
  ) =>
    executor.execute(
      { type: "tool_use", id: "t", name, input },
      new AbortController().signal,
    );
  return { cwd, tools, run, approvals };
}
const edit = (extra: Record<string, unknown> = {}) => ({
  notebook_path: "n.ipynb",
  cell_id: "a",
  new_source: "2",
  ...extra,
});

test("NotebookEdit requires a prior Read, a notebook path and an insert cell type", async () => {
  const { cwd, tools, run } = await fixture();
  const notRead = await run(tools(), "NotebookEdit", edit());
  assert.equal(notRead.is_error, true);
  assert.equal(
    notRead.content,
    "File has not been read yet. Read it first before writing to it.",
  );
  await writeFile(path.join(cwd, "n.txt"), "x");
  assert.equal(
    (await run(tools(), "NotebookEdit", edit({ notebook_path: "n.txt" })))
      .content,
    "File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.",
  );
  assert.equal(
    (await run(tools(), "NotebookEdit", edit({ edit_mode: "insert" }))).content,
    "Cell type is required when using edit_mode=insert.",
  );
  assert.equal(
    (await run(tools(), "Read", { file_path: "missing.ipynb" })).is_error,
    true,
  );
  assert.equal(await readFile(path.join(cwd, "n.ipynb"), "utf8"), NOTEBOOK);
});

test("Read renders cells and NotebookEdit writes once the notebook is current", async () => {
  const { cwd, tools, run, approvals } = await fixture();
  const read = await run(tools(), "Read", { file_path: "n.ipynb" });
  assert.equal(read.content, '<cell id="a">1</cell id="a">');
  assert.deepEqual(read.apiContent, [
    { type: "text", text: '<cell id="a">1</cell id="a">' },
  ]);
  const result = await run(tools(), "NotebookEdit", edit());
  assert.equal(result.content, "Updated cell a with 2");
  const saved = await readFile(path.join(cwd, "n.ipynb"), "utf8");
  assert.equal(
    saved,
    NOTEBOOK.replace(
      '"source": "1",\n   "outputs": []',
      '"source": "2",\n   "outputs": [],\n   "execution_count": null',
    ),
  );
  assert.deepEqual(approvals, []);
  // The write refreshes read state, so a second edit needs no new Read.
  assert.equal(
    (await run(tools(), "NotebookEdit", edit({ new_source: "3" }))).content,
    "Updated cell a with 3",
  );
  await writeFile(path.join(cwd, "n.ipynb"), NOTEBOOK);
  const stale = await run(tools(), "NotebookEdit", edit());
  assert.equal(stale.is_error, true);
  assert.match(stale.content, /changed since it was read/);
});

test("NotebookEdit follows edit permissions: plan mode refuses and default mode asks", async () => {
  const { tools, run, approvals } = await fixture();
  await run(tools(), "Read", { file_path: "n.ipynb" });
  const plan = await run(tools("plan"), "NotebookEdit", edit());
  assert.equal(plan.permissionDenied, true);
  const denied = await run(tools("default", false), "NotebookEdit", edit());
  assert.equal(denied.content, "Permission denied");
  assert.match(
    approvals[0] ?? "",
    /^NotebookEdit .*n\.ipynb\nreplace cell a:\n2$/,
  );
});

test("Read returns notebook images as API blocks", async () => {
  const { cwd, tools, run } = await fixture();
  await writeFile(
    path.join(cwd, "img.ipynb"),
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          id: "p",
          source: "plot()",
          outputs: [
            {
              output_type: "display_data",
              data: { "image/png": "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    }),
  );
  const read = await run(tools(), "Read", { file_path: "img.ipynb" });
  assert.equal(read.content, '<cell id="p">plot()</cell id="p">');
  assert.equal(read.apiContent?.[1]?.type, "image");
});
