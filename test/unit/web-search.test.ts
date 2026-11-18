import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  assembleSearchOutput,
  blocksFromSse,
  formatSearchOutput,
  runWebSearch,
  validateWebSearchInput,
  WEB_SEARCH_SYSTEM,
  webSearchDescription,
  webSearchRequestBody,
  type WebSearchHost,
} from "../../src/web-search.js";

const sse = (events: unknown[]) =>
  events
    .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
const hit = {
  type: "web_search_result",
  title: "T",
  url: "https://t.test/",
  page_age: null,
};

test("input validation refuses empty queries and both domain lists", () => {
  assert.throws(
    () => validateWebSearchInput({ query: "" }),
    /Error: Missing query/,
  );
  assert.throws(
    () =>
      validateWebSearchInput({
        query: "qq",
        allowed_domains: ["a.com"],
        blocked_domains: ["b.com"],
      }),
    /Cannot specify both allowed_domains and blocked_domains/,
  );
  assert.doesNotThrow(() =>
    validateWebSearchInput({
      query: "qq",
      allowed_domains: [],
      blocked_domains: ["b"],
    }),
  );
});

test("the side query carries the server tool, forced tool choice and query turn", () => {
  assert.deepEqual(
    webSearchRequestBody(
      { query: "news", allowed_domains: ["a.com"] },
      "model-x",
      100,
    ),
    {
      model: "model-x",
      max_tokens: 100,
      system: WEB_SEARCH_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Perform a web search for the query: news" },
          ],
        },
      ],
      temperature: 1,
      thinking: { type: "disabled" },
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_domains: ["a.com"],
          max_uses: 8,
        },
      ],
      tool_choice: { type: "tool", name: "web_search" },
      stream: true,
    },
  );
  const blocked = webSearchRequestBody(
    { query: "q", blocked_domains: ["b"] },
    "m",
    1,
  );
  assert.deepEqual(blocked.tools, [
    {
      type: "web_search_20250305",
      name: "web_search",
      blocked_domains: ["b"],
      max_uses: 8,
    },
  ]);
});

test("stream folding keeps text deltas, server blocks and search errors in order", () => {
  const blocks = blocksFromSse(
    sse([
      { type: "message_start", message: {} },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Looking" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "server_tool_use",
          id: "s1",
          name: "web_search",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "s1",
          content: [hit],
        },
      },
      {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "server_tool_use",
          id: "s2",
          name: "web_search",
          input: {},
        },
      },
      {
        type: "content_block_start",
        index: 4,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "s2",
          content: {
            type: "web_search_tool_result_error",
            error_code: "max_uses_exceeded",
          },
        },
      },
      {
        type: "content_block_start",
        index: 5,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "s3",
          content: [],
        },
      },
      {
        type: "content_block_start",
        index: 6,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 6,
        delta: { type: "text_delta", text: "Summary" },
      },
      {
        type: "content_block_delta",
        index: 9,
        delta: { type: "text_delta", text: "orphan" },
      },
      {
        type: "content_block_start",
        index: 7,
        content_block: { type: "mystery" },
      },
    ]) + "data: not json\n\n",
  );
  const output = assembleSearchOutput(blocks, "q", 1.5);
  assert.deepEqual(output, {
    query: "q",
    durationSeconds: 1.5,
    searchCount: 3,
    results: [
      "Looking",
      { tool_use_id: "s1", content: [{ title: "T", url: "https://t.test/" }] },
      "Web search error: max_uses_exceeded",
      { tool_use_id: "s3", content: [] },
      "Summary",
    ],
  });
  assert.equal(
    formatSearchOutput(output),
    'Web search results for query: "q"\n\nLooking\n\nLinks: [{"title":"T","url":"https://t.test/"}]\n\nWeb search error: max_uses_exceeded\n\nNo links found.\n\nSummary\n\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.',
  );
  assert.throws(
    () =>
      blocksFromSse(
        sse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ]),
      ),
    /Overloaded/,
  );
});

function searchHost(response: Response): WebSearchHost & { bodies: unknown[] } {
  const bodies: unknown[] = [];
  let clock = 0;
  return {
    bodies,
    send: async (body) => {
      bodies.push(body);
      return response;
    },
    model: () => "main",
    maxTokens: () => 64,
    now: () => (clock += 500),
  };
}

test("a search runs the side query over SSE or JSON and reports API errors", async () => {
  const streamed = searchHost(
    new Response(
      sse([
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "s",
            content: [hit],
          },
        },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const output = await runWebSearch(
    { query: "qq" },
    streamed,
    new AbortController().signal,
  );
  assert.equal(output.durationSeconds, 0.5);
  assert.equal(output.searchCount, 1);
  assert.equal(streamed.bodies.length, 1);
  const json = await runWebSearch(
    { query: "qq" },
    searchHost(
      Response.json({ content: [{ type: "text", text: "only text" }] }),
    ),
    new AbortController().signal,
  );
  assert.deepEqual(json.results, ["only text"]);
  await assert.rejects(
    runWebSearch(
      { query: "qq" },
      searchHost(
        Response.json(
          { error: { type: "x", message: "bad tool" } },
          { status: 400 },
        ),
      ),
      new AbortController().signal,
    ),
    /API Error: 400 bad tool/,
  );
  await assert.rejects(
    runWebSearch(
      { query: "qq" },
      searchHost(new Response("", { status: 502 })),
      new AbortController().signal,
    ),
    /^WebSearchError: API Error: 502$/,
  );
});

test("description fills in the current month", () => {
  assert.match(
    webSearchDescription(new Date(2026, 10, 18)),
    /The current month is November 2026\. You MUST use this year/,
  );
});
