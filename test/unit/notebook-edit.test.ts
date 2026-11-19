import assert from "node:assert/strict";
import { test } from "bun:test";
import { z } from "zod";
import { applyNotebookEdit, renderNotebook } from "../../src/notebook-edit.js";

const notebook = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    cells: [
      { cell_type: "markdown", id: "m", metadata: {}, source: ["# A\n", "b"] },
      {
        cell_type: "code",
        id: "c",
        metadata: {},
        execution_count: 1,
        outputs: [{ output_type: "stream", text: "out" }],
        source: "x = 1",
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    ...extra,
  });
const cells = (text: string) =>
  z
    .object({ cells: z.array(z.record(z.string(), z.unknown())) })
    .parse(JSON.parse(text)).cells;

test("replace resets code outputs, changes type on request and keeps CRLF", () => {
  const result = applyNotebookEdit(
    notebook(),
    { notebook_path: "n.ipynb", cell_id: "c", new_source: "y = 2" },
    "/w/n.ipynb",
  );
  assert.equal(result.message, "Updated cell c with y = 2");
  assert.deepEqual(cells(result.updated)[1], {
    cell_type: "code",
    id: "c",
    metadata: {},
    execution_count: null,
    outputs: [],
    source: "y = 2",
  });
  assert.equal(
    result.updated,
    JSON.stringify(JSON.parse(result.updated), null, 1),
  );
  assert.deepEqual(result.hookResponse, {
    new_source: "y = 2",
    old_source: "x = 1",
    cell_type: "code",
    language: "python",
    edit_mode: "replace",
    cell_id: "c",
    error: "",
    notebook_path: "/w/n.ipynb",
    original_file: notebook(),
    updated_file: result.updated,
  });
  const retyped = applyNotebookEdit(
    JSON.stringify(JSON.parse(notebook()), null, 1).replace(/\n/g, "\r\n"),
    {
      notebook_path: "n.ipynb",
      cell_id: "cell-0",
      new_source: "text",
      cell_type: "code",
    },
    "n",
  );
  assert.match(retyped.updated, /\r\n/);
  assert.equal(cells(retyped.updated)[0]?.cell_type, "code");
  assert.equal(
    applyNotebookEdit(
      notebook(),
      {
        notebook_path: "n",
        cell_id: "m",
        new_source: "same",
        cell_type: "markdown",
      },
      "n",
    ).message,
    "Updated cell m with same",
  );
});

test("insert places new cells after the id, or first, with ids only from nbformat 4.5", () => {
  const after = applyNotebookEdit(
    notebook(),
    {
      notebook_path: "n",
      cell_id: "m",
      new_source: "## B",
      cell_type: "markdown",
      edit_mode: "insert",
    },
    "n",
  );
  const inserted = cells(after.updated)[1];
  assert.equal(inserted?.cell_type, "markdown");
  assert.match(String(inserted?.id), /^[0-9a-f]{8}$/);
  assert.equal(
    after.message,
    `Inserted cell ${String(inserted?.id)} with ## B`,
  );
  const first = applyNotebookEdit(
    notebook({ nbformat_minor: 4 }),
    {
      notebook_path: "n",
      new_source: "z",
      cell_type: "code",
      edit_mode: "insert",
    },
    "n",
  );
  assert.deepEqual(cells(first.updated)[0], {
    cell_type: "code",
    source: "z",
    metadata: {},
    execution_count: null,
    outputs: [],
  });
  assert.equal(first.message, "Inserted a new cell with z");
  const v5 = applyNotebookEdit(
    notebook({ nbformat: 5 }),
    {
      notebook_path: "n",
      new_source: "z",
      cell_type: "code",
      edit_mode: "insert",
    },
    "n",
  );
  assert.equal(typeof cells(v5.updated)[0]?.id, "string");
  const bare = applyNotebookEdit(
    JSON.stringify({ cells: [] }),
    {
      notebook_path: "n",
      new_source: "z",
      cell_type: "code",
      edit_mode: "insert",
    },
    "n",
  );
  assert.equal(cells(bare.updated)[0]?.id, undefined);
});

test("delete removes the cell and reports its source", () => {
  const result = applyNotebookEdit(
    notebook(),
    { notebook_path: "n", cell_id: "m", new_source: "", edit_mode: "delete" },
    "n",
  );
  assert.equal(result.message, "Deleted cell m");
  assert.equal(result.hookResponse.old_source, "# A\nb");
  assert.deepEqual(
    cells(result.updated).map((cell) => cell.id),
    ["c"],
  );
});

test("edit errors use the original messages", () => {
  const edit = (text: string, cell_id?: string) => () =>
    applyNotebookEdit(
      text,
      {
        notebook_path: "n",
        new_source: "x",
        ...(cell_id === undefined ? {} : { cell_id }),
      },
      "n",
    );
  assert.throws(edit("{"), /^Error: Notebook is not valid JSON\.$/);
  assert.throws(
    edit('{"cells":[{"source":1}]}', "c"),
    /not a valid Jupyter notebook/,
  );
  assert.throws(edit("null", "c"), /not a valid Jupyter notebook/);
  assert.throws(edit('{"cells":[null]}', "c"), /not a valid Jupyter notebook/);
  assert.throws(edit(notebook()), /Cell ID must be specified/);
  assert.throws(edit(notebook(), "nope"), /Cell with ID "nope" not found/);
  assert.throws(edit(notebook(), "cell-9"), /Cell with index 9 does not exist/);
});

test("Read renders cells, outputs, images and the large-output notice like the original", () => {
  const png = "iVBORw0KGgo=";
  const blocks = renderNotebook(
    JSON.stringify({
      cells: [
        { cell_type: "markdown", source: "md" },
        {
          cell_type: "code",
          id: "c1",
          source: ["a", "b"],
          outputs: [
            { output_type: "stream", text: ["s1", "s2"] },
            {
              output_type: "execute_result",
              data: { "text/plain": "res", "image/png": `${png}\n` },
            },
            { output_type: "display_data", data: {} },
            {
              output_type: "error",
              ename: "E",
              evalue: "bad",
              traceback: ["t1", "t2"],
            },
            { output_type: "unknown" },
          ],
        },
        { cell_type: "code", id: "c2", source: "x", outputs: [] },
        {
          cell_type: "code",
          id: "big",
          source: "y",
          outputs: [{ output_type: "stream", text: "x".repeat(10001) }],
        },
      ],
      metadata: { language_info: { name: "julia" } },
    }),
  );
  assert.deepEqual(blocks, [
    {
      type: "text",
      text: '<cell id="cell-0"><cell_type>markdown</cell_type>md</cell id="cell-0">\n<cell id="c1"><language>julia</language>ab</cell id="c1">\n\ns1s2\n\nres',
    },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png },
    },
    {
      type: "text",
      text: '\nE: bad\nt1\nt2\n<cell id="c2"><language>julia</language>x</cell id="c2">\n<cell id="big"><language>julia</language>y</cell id="big">\n\nOutputs are too large to include. Use Bash with: cat <notebook_path> | jq \'.cells[3].outputs\'',
    },
  ]);
  const long = renderNotebook(
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "",
          outputs: [
            { output_type: "stream", text: `${"a".repeat(30000)}\nb\nc` },
          ],
        },
      ],
    }),
  );
  assert.equal(long.length, 1);
  assert.equal(
    long[0]?.type === "text" && long[0].text.length < 30000 + 200,
    true,
  );
  assert.throws(() => renderNotebook("nope"), /not valid JSON/);
});
