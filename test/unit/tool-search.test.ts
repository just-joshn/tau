import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  deferredToolsDelta,
  discoveredToolNames,
  searchTools,
  toolCatalog,
  toolSearchEnabled,
  wrapToolSearch,
  type CatalogEntry,
} from "../../src/tool-search.js";
import type { Message, ToolDefinition, ToolExecutor } from "../../src/types.js";

const tool = (name: string, description = `${name} tool`): ToolDefinition => ({
  name,
  description,
  input_schema: { type: "object", properties: {} },
});
const deferred = (
  definitions: ToolDefinition[],
  alwaysLoad?: (name: string) => boolean,
): CatalogEntry[] =>
  toolCatalog(definitions, alwaysLoad).filter(
    (entry) => entry.loading === "deferred",
  );
const pool = deferred([
  tool("NotebookEdit", "Edit a Jupyter notebook cell"),
  tool("TaskCreate", "Create a task"),
  tool("WebFetch", "Fetch a URL"),
  tool("mcp__slack__send_message", "Send a Slack message"),
  tool("mcp__slack__list_channels", "List channels"),
  tool("mcp__github__create_issue", "Open an issue"),
]);
const names = (entries: CatalogEntry[]) =>
  entries.map((entry) => entry.definition.name);

test("the catalog defers shouldDefer built-ins and MCP tools unless MCP always loads", () => {
  const catalog = toolCatalog(
    [tool("Read"), tool("NotebookEdit"), tool("mcp__a__x"), tool("mcp__b__y")],
    (name) => name === "mcp__b__y",
  );
  assert.deepEqual(
    catalog.map((entry) => [entry.definition.name, entry.loading]),
    [
      ["Read", "eager"],
      ["NotebookEdit", "deferred"],
      ["mcp__a__x", "deferred"],
      ["mcp__b__y", "eager"],
    ],
  );
  assert.equal(catalog[1]?.searchHint, "edit Jupyter notebook cells (.ipynb)");
  assert.deepEqual(names(deferred([tool("mcp__a__x")])), ["mcp__a__x"]);
});

test("the tool search gate follows ENABLE_TOOL_SEARCH, experimental betas and model support", () => {
  const model = "claude-sonnet-4-5";
  assert.equal(toolSearchEnabled({}, model), true);
  assert.equal(toolSearchEnabled({ ENABLE_TOOL_SEARCH: "true" }, model), true);
  assert.equal(toolSearchEnabled({ ENABLE_TOOL_SEARCH: "auto" }, model), true);
  assert.equal(
    toolSearchEnabled({ ENABLE_TOOL_SEARCH: "auto:50" }, model),
    true,
  );
  assert.equal(
    toolSearchEnabled({ ENABLE_TOOL_SEARCH: "auto:x" }, model),
    true,
  );
  assert.equal(
    toolSearchEnabled({ ENABLE_TOOL_SEARCH: "auto:100" }, model),
    false,
  );
  assert.equal(toolSearchEnabled({ ENABLE_TOOL_SEARCH: "0" }, model), false);
  assert.equal(
    toolSearchEnabled({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, model),
    false,
  );
  assert.equal(toolSearchEnabled({}, "claude-3-5-haiku-20241022"), false);
});

test("select fetches exact or case-insensitive deferred names and reports loaded ones", () => {
  assert.deepEqual(
    searchTools("select:notebookedit, TaskCreate,,Missing,NotebookEdit", pool, [
      "Read",
    ]),
    { matches: ["NotebookEdit", "TaskCreate"], alreadyLoaded: [] },
  );
  assert.deepEqual(searchTools("SELECT:Read,read,WebFetch", pool, ["Read"]), {
    matches: ["WebFetch"],
    alreadyLoaded: ["Read"],
  });
  assert.deepEqual(searchTools("select:NotebookEdit", pool, ["NotebookEdit"]), {
    matches: [],
    alreadyLoaded: ["NotebookEdit"],
  });
});

test("keyword search ranks names, hints and descriptions with +required terms", () => {
  assert.deepEqual(searchTools("notebook jupyter", pool, []).matches, [
    "NotebookEdit",
  ]);
  assert.deepEqual(searchTools("webfetch", pool, []).matches, ["WebFetch"]);
  assert.deepEqual(searchTools("Read", pool, ["Read"]), {
    matches: [],
    alreadyLoaded: ["Read"],
  });
  assert.deepEqual(searchTools("+slack send", pool, []).matches, [
    "mcp__slack__send_message",
    "mcp__slack__list_channels",
  ]);
  assert.deepEqual(searchTools("+slack", pool, [], 1).matches, [
    "mcp__slack__send_message",
  ]);
  assert.deepEqual(searchTools("mcp__slack__", pool, []).matches, [
    "mcp__slack__send_message",
    "mcp__slack__list_channels",
  ]);
  assert.deepEqual(searchTools("mcp__nothing", pool, []).matches, []);
  assert.deepEqual(searchTools("issue", pool, []).matches, [
    "mcp__github__create_issue",
  ]);
  assert.deepEqual(searchTools("cre", pool, []).matches, [
    "mcp__github__create_issue",
    "TaskCreate",
  ]);
  assert.deepEqual(searchTools("+nomatch task", pool, []).matches, []);
  assert.deepEqual(searchTools("url", pool, []).matches, ["WebFetch"]);
  assert.deepEqual(searchTools("zzz", pool, []).matches, []);
  const words = Array.from({ length: 40 }, (_, index) => `w${index}`);
  assert.deepEqual(
    searchTools(`${words.join(" ")} notebook`, pool, []).matches,
    [],
  );
});

test("the deferred listing announces additions once and withdraws departed names", () => {
  const initial = deferredToolsDelta(["TaskCreate", "NotebookEdit"], []);
  assert.deepEqual(initial?.attachment, {
    type: "deferred_tools_delta",
    addedNames: ["NotebookEdit", "TaskCreate"],
    removedNames: [],
  });
  assert.match(
    initial?.text ?? "",
    /^<system-reminder>\nThe following deferred tools are now available via ToolSearch\.[^\n]*\nNotebookEdit\nTaskCreate\n<\/system-reminder>$/,
  );
  assert.ok(initial);
  const history = [initial.attachment];
  assert.equal(
    deferredToolsDelta(["NotebookEdit", "TaskCreate"], history),
    undefined,
  );
  const removed = deferredToolsDelta(["NotebookEdit", "WebFetch"], history);
  assert.deepEqual(removed?.attachment.addedNames, ["WebFetch"]);
  assert.deepEqual(removed?.attachment.removedNames, ["TaskCreate"]);
  assert.match(removed?.text ?? "", /no longer available[^\n]*:\nTaskCreate/);
});

function message(names: string[], boundary = false): Message {
  return {
    role: "user",
    content: [
      { type: "text", text: "x" },
      {
        type: "tool_result",
        tool_use_id: "t",
        content: "",
        apiContent: names.map((tool_name) => ({
          type: "tool_reference" as const,
          tool_name,
        })),
      },
      { type: "tool_result", tool_use_id: "u", content: "plain" },
    ],
    ...(boundary
      ? {
          contextBoundary: {
            beforeTokens: 1,
            afterTokens: 1,
            reason: "manual" as const,
          },
        }
      : {}),
  };
}

test("discovery is the tool_reference set after the last compaction boundary", () => {
  assert.deepEqual(
    [...discoveredToolNames([message(["A"]), message(["B", "C"])])],
    ["A", "B", "C"],
  );
  assert.deepEqual(
    [...discoveredToolNames([message(["A"]), message(["B"], true)])],
    ["B"],
  );
});

function executor(definitions: ToolDefinition[]): ToolExecutor & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    definitions,
    async execute(call) {
      calls.push(call.name);
      return { type: "tool_result", tool_use_id: call.id, content: "ran" };
    },
  };
}

test("the wrapper projects tools, answers ToolSearch and refuses unloaded deferred calls", async () => {
  const base = executor([
    tool("Read"),
    tool("NotebookEdit"),
    tool("mcp__s__t"),
  ]);
  const messages: Message[] = [];
  let enabled = true;
  const wrapped = wrapToolSearch(base, messages, {
    enabled: () => enabled,
    alwaysLoad: (name) => name === "mcp__s__t",
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    wrapped.definitions.map((definition) => definition.name),
    ["Read", "mcp__s__t", "DeferredToolPlaceholder", "ToolSearch"],
  );
  assert.deepEqual(wrapped.deferredNames(), ["NotebookEdit"]);
  const refused = await wrapped.execute(
    { type: "tool_use", id: "n", name: "NotebookEdit", input: {} },
    signal,
  );
  assert.equal(refused.is_error, true);
  assert.equal(refused.inputRejected, true);
  const invalid = await wrapped.execute(
    { type: "tool_use", id: "i", name: "ToolSearch", input: { query: 1 } },
    signal,
  );
  assert.match(invalid.content, /^InputValidationError: /);
  const found = await wrapped.execute(
    {
      type: "tool_use",
      id: "s",
      name: "ToolSearch",
      input: { query: "select:NotebookEdit" },
    },
    signal,
  );
  assert.deepEqual(found.apiContent, [
    { type: "tool_reference", tool_name: "NotebookEdit" },
  ]);
  assert.match(found.content, /^<functions>\n<function>\{"description"/);
  const none = await wrapped.execute(
    { type: "tool_use", id: "z", name: "ToolSearch", input: { query: "zzz" } },
    signal,
  );
  assert.equal(none.content, "No matching deferred tools found");
  messages.push({ role: "user", content: [found] });
  assert.equal(
    wrapped.definitions.find((definition) => definition.name === "NotebookEdit")
      ?.defer_loading,
    true,
  );
  const loadedNote = await wrapped.execute(
    {
      type: "tool_use",
      id: "l",
      name: "ToolSearch",
      input: { query: "select:NotebookEdit,TaskCreate" },
    },
    signal,
  );
  assert.equal(
    loadedNote.content,
    "No matching deferred tools found\n\nAlready available in this conversation: NotebookEdit. Call it directly.",
  );
  await wrapped.execute(
    { type: "tool_use", id: "e", name: "NotebookEdit", input: {} },
    signal,
  );
  await wrapped.execute(
    { type: "tool_use", id: "r", name: "Read", input: {} },
    signal,
  );
  assert.deepEqual(base.calls, ["NotebookEdit", "Read"]);
  enabled = false;
  assert.equal(wrapped.definitions, base.definitions);
  assert.deepEqual(wrapped.deferredNames(), []);
  await wrapped.execute(
    { type: "tool_use", id: "x", name: "ToolSearch", input: {} },
    signal,
  );
  assert.deepEqual(base.calls, ["NotebookEdit", "Read", "ToolSearch"]);
  assert.equal(wrapped.prepareCompaction, undefined);
  await wrapped.beforeModelRequest?.(signal);
  wrapped.setReadContext?.(undefined);
});

test("the wrapper delegates compaction preparation when the base provides it", async () => {
  const base: ToolExecutor = {
    ...executor([]),
    prepareCompaction: async () => ({ messages: [], commit() {} }),
  };
  const wrapped = wrapToolSearch(base, [], { enabled: () => true });
  assert.deepEqual(
    (
      await wrapped.prepareCompaction?.({
        keptMessages: [],
        signal: new AbortController().signal,
      })
    )?.messages,
    [],
  );
});
