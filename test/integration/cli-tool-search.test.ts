import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "bun:test";
import { z } from "zod";
import {
  startMockProvider,
  type MockProvider,
  type ScriptedResponse,
} from "../helpers/mock-provider.js";

const NOTEBOOK = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {},
      source: ["# Title\n", "text"],
    },
    {
      cell_type: "code",
      execution_count: 3,
      id: "calc",
      metadata: {},
      outputs: [{ name: "stdout", output_type: "stream", text: ["1\n"] }],
      source: "print(1)",
    },
  ],
  metadata: { language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
};
const NOTEBOOK_TEXT = `${JSON.stringify(NOTEBOOK, null, 1)}\n`;

const toolSchema = z.looseObject({
  name: z.string(),
  defer_loading: z.boolean().optional(),
});
const requestSchema = z.object({
  tools: z.array(toolSchema),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.array(
        z.looseObject({
          type: z.string(),
          text: z.string().optional(),
          tool_use_id: z.string().optional(),
          is_error: z.boolean().optional(),
          content: z.unknown().optional(),
        }),
      ),
    }),
  ),
});
const sessionSchema = z.object({ session_id: z.string() });

function request(provider: MockProvider, index: number) {
  return requestSchema.parse(provider.requests[index]?.body);
}
function tools(provider: MockProvider, index: number) {
  return request(provider, index).tools;
}
function toolResult(provider: MockProvider, index: number, id: string) {
  for (const message of request(provider, index).messages)
    for (const block of message.content)
      if (block.type === "tool_result" && block.tool_use_id === id)
        return block;
  return assert.fail(`missing tool_result ${id}`);
}
function texts(provider: MockProvider, index: number): string[] {
  return request(provider, index).messages.flatMap((message) =>
    message.content.flatMap((block) => (block.text ? [block.text] : [])),
  );
}
const call = (
  name: string,
  input: Record<string, unknown>,
  id: string,
): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const said = (text: string): ScriptedResponse => ({
  kind: "turn",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tau-tool-search-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  for (const directory of ["home", "config", "state", "managed", "work"])
    await mkdir(join(root, directory));
  await writeFile(join(cwd, "nb.ipynb"), NOTEBOOK_TEXT);
  const run = (
    provider: MockProvider,
    args: string[],
    env: Record<string, string> = {},
  ) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
            "--cwd",
            cwd,
            "--output-format",
            "json",
            "--permission-mode",
            "acceptEdits",
            ...args,
          ],
          {
            env: {
              PATH: process.env.PATH ?? "",
              ...(process.env.TAU_COVERAGE_DIR
                ? { TAU_COVERAGE_DIR: process.env.TAU_COVERAGE_DIR }
                : {}),
              HOME: join(root, "home"),
              CLAUDE_CONFIG_DIR: join(root, "config"),
              TAU_HOME: join(root, "state"),
              // Tool results here stay exact; cli-async-hooks pins the folded countdown.
              CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
              TAU_MANAGED_ROOT: join(root, "managed"),
              ANTHROPIC_MODEL: "claude-sonnet-4-5-20250929",
              ANTHROPIC_API_KEY: "tool-search-dummy",
              ANTHROPIC_BASE_URL: provider.url,
              ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => done({ code, out, err }));
      },
    );
  return { cwd, run };
}

const names = (list: readonly { name: string }[]) => list.map((t) => t.name);

test("ToolSearch select loads NotebookEdit, which then edits a Read notebook; discovery survives resume", async () => {
  const { cwd, run } = await workspace();
  const notebook = join(cwd, "nb.ipynb");
  const provider = await startMockProvider([
    call(
      "ToolSearch",
      { query: "select:NotebookEdit", max_results: 5 },
      "search",
    ),
    call("Read", { file_path: notebook }, "read"),
    call(
      "NotebookEdit",
      { notebook_path: notebook, cell_id: "calc", new_source: "print(2)" },
      "edit",
    ),
    said("edited"),
    // Read state is process-local, so the resumed process reads again.
    call("Read", { file_path: notebook }, "reread"),
    call(
      "NotebookEdit",
      {
        notebook_path: notebook,
        cell_id: "intro",
        new_source: "## Note",
        cell_type: "markdown",
        edit_mode: "insert",
      },
      "insert",
    ),
    said("inserted"),
  ]);
  const first = await run(provider, ["-p", "edit the notebook"]);
  assert.equal(first.code, 0, first.err);

  const before = tools(provider, 0);
  assert.equal(names(before).includes("NotebookEdit"), false);
  assert.equal(names(before).includes("TaskCreate"), false);
  assert.deepEqual(names(before).slice(-2), [
    "DeferredToolPlaceholder",
    "ToolSearch",
  ]);
  assert.equal(before.at(-2)?.defer_loading, true);
  const listing = texts(provider, 0).find((text) =>
    text.includes("deferred tools are now available"),
  );
  assert.ok(listing, "deferred tool listing reminder");
  assert.match(listing, /\nNotebookEdit\n/);

  assert.deepEqual(toolResult(provider, 1, "search").content, [
    { type: "tool_reference", tool_name: "NotebookEdit" },
  ]);
  const after = tools(provider, 1).find((tool) => tool.name === "NotebookEdit");
  assert.equal(after?.defer_loading, true);
  assert.ok(after && "input_schema" in after);

  const read = JSON.stringify(toolResult(provider, 2, "read").content);
  assert.match(read, /<cell id=\\"calc\\">print\(1\)<\/cell id=\\"calc\\">/);
  assert.match(read, /<cell_type>markdown<\/cell_type># Title\\ntext/);
  assert.equal(
    toolResult(provider, 3, "edit").content,
    "Updated cell calc with print(2)",
  );
  const edited = structuredClone(NOTEBOOK);
  Object.assign(edited.cells[1] ?? {}, {
    source: "print(2)",
    execution_count: null,
    outputs: [],
  });
  assert.equal(
    await readFile(notebook, "utf8"),
    JSON.stringify(edited, null, 1),
  );

  // The tool_reference in saved history keeps NotebookEdit loaded on resume.
  const session = sessionSchema.parse(JSON.parse(first.out)).session_id;
  const resumed = await run(provider, [
    "-p",
    "insert a cell",
    "--resume",
    session,
  ]);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(
    tools(provider, 4).find((tool) => tool.name === "NotebookEdit")
      ?.defer_loading,
    true,
  );
  assert.equal(
    texts(provider, 4).filter((text) =>
      text.includes("deferred tools are now available"),
    ).length,
    1,
  );
  const inserted = toolResult(provider, 6, "insert");
  assert.equal(inserted.is_error, undefined, JSON.stringify(inserted));
  const saved = z
    .object({ cells: z.array(z.looseObject({ id: z.string() })) })
    .parse(JSON.parse(await readFile(notebook, "utf8")));
  assert.equal(saved.cells.length, 3);
  assert.match(saved.cells[1]?.id ?? "", /^[0-9a-f]{8}$/);
  assert.equal(provider.unexpected, 0);
}, 30_000);

test("an undiscovered deferred tool is refused and the notebook is untouched", async () => {
  const { cwd, run } = await workspace();
  const notebook = join(cwd, "nb.ipynb");
  const provider = await startMockProvider([
    call("Read", { file_path: notebook }, "read"),
    call(
      "NotebookEdit",
      { notebook_path: notebook, cell_id: "calc", new_source: "x" },
      "early",
    ),
    call("ToolSearch", { query: "notebook jupyter" }, "search"),
    call("ToolSearch", { query: "select:Read,NotebookEdit" }, "again"),
    said("done"),
  ]);
  const result = await run(provider, ["-p", "go"]);
  assert.equal(result.code, 0, result.err);
  const early = toolResult(provider, 2, "early");
  assert.equal(early.is_error, true);
  assert.match(
    String(early.content),
    /^InputValidationError: NotebookEdit did not run: it was not loaded/,
  );
  assert.equal(await readFile(notebook, "utf8"), NOTEBOOK_TEXT);
  assert.deepEqual(toolResult(provider, 3, "search").content, [
    { type: "tool_reference", tool_name: "NotebookEdit" },
  ]);
  assert.equal(
    toolResult(provider, 4, "again").content,
    "No matching deferred tools found\n\nAlready available in this conversation: Read, NotebookEdit. Call whichever you need directly.",
  );
});

test("ENABLE_TOOL_SEARCH=false and a --tools list without ToolSearch send deferred tools eagerly", async () => {
  const { run } = await workspace();
  const provider = await startMockProvider([said("a"), said("b")]);
  assert.equal(
    (await run(provider, ["-p", "go"], { ENABLE_TOOL_SEARCH: "false" })).code,
    0,
  );
  assert.equal(
    (await run(provider, ["-p", "go", "--tools", "Read,NotebookEdit"])).code,
    0,
  );
  for (const index of [0, 1]) {
    const list = names(tools(provider, index));
    assert.ok(list.includes("NotebookEdit"), list.join(","));
    assert.equal(list.includes("ToolSearch"), false);
    assert.equal(
      texts(provider, index).some((text) => text.includes("deferred tools")),
      false,
    );
  }
});
