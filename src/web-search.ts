import { z } from "zod";

export const WEB_SEARCH_TOOL = "WebSearch";
/** Original sn.call: the side query's system prompt (chunk-fkkma3m4). */
export const WEB_SEARCH_SYSTEM =
  "You run a web search for another Claude model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results.";

export const webSearchInputSchema = z.strictObject({
  query: z.string().min(2).describe("The search query to use"),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe("Only include search results from these domains"),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe("Never include search results from these domains"),
});
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface SearchHit {
  title: string;
  url: string;
}
/** Original el(): commentary strings interleaved with each search's hits. */
export type SearchResultItem =
  string | { tool_use_id: string; content: SearchHit[] };
export interface WebSearchOutput {
  query: string;
  results: SearchResultItem[];
  durationSeconds: number;
  searchCount: number;
}

const hitSchema = z.object({ title: z.string(), url: z.string() });
/** The response blocks this tool reads; other block types pass through ignored. */
const responseBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("server_tool_use"), id: z.string() }),
  z.object({
    type: z.literal("web_search_tool_result"),
    tool_use_id: z.string(),
    content: z.union([
      z.array(hitSchema.loose()),
      z.object({ error_code: z.string() }).loose(),
    ]),
  }),
]);
type ResponseBlock = z.infer<typeof responseBlockSchema>;

export class WebSearchError extends Error {
  override name = "WebSearchError";
}

/** Original sn.validateInput, after schema parsing. */
export function validateWebSearchInput(input: WebSearchInput): void {
  if (!input.query.length) throw new WebSearchError("Error: Missing query");
  if (input.allowed_domains?.length && input.blocked_domains?.length)
    throw new WebSearchError(
      "Error: Cannot specify both allowed_domains and blocked_domains in the same request",
    );
}

/** The Messages request body for the side query that runs the server tool. */
export function webSearchRequestBody(
  input: WebSearchInput,
  model: string,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    system: WEB_SEARCH_SYSTEM,
    messages: [
      {
        role: "user",
        content: "Perform a web search for the query: " + input.query,
      },
    ],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        ...(input.allowed_domains === undefined
          ? {}
          : { allowed_domains: input.allowed_domains }),
        ...(input.blocked_domains === undefined
          ? {}
          : { blocked_domains: input.blocked_domains }),
        max_uses: 8,
      },
    ],
    tool_choice: { type: "tool", name: "web_search" },
    stream: true,
  };
}

function parseBlocks(raw: unknown[]): ResponseBlock[] {
  return raw.flatMap((block) => {
    const parsed = responseBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}
const sseEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("content_block_start"),
    index: z.number(),
    content_block: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({ message: z.string() }).loose(),
  }),
]);
/** Fold a Messages SSE stream into its final content blocks. */
export function blocksFromSse(text: string): ResponseBlock[] {
  const blocks = new Map<number, Record<string, unknown>>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    const event = sseEvent.safeParse(value);
    if (!event.success) continue;
    const data = event.data;
    if (data.type === "error") throw new WebSearchError(data.error.message);
    if (data.type === "content_block_start")
      blocks.set(data.index, { ...data.content_block });
    else {
      const block = blocks.get(data.index);
      const delta = data.delta;
      if (
        block &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      )
        block.text =
          (typeof block.text === "string" ? block.text : "") + delta.text;
    }
  }
  return parseBlocks(
    [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
  );
}

/** Original el(). */
export function assembleSearchOutput(
  blocks: readonly ResponseBlock[],
  query: string,
  durationSeconds: number,
): WebSearchOutput {
  const results: SearchResultItem[] = [];
  let text = "",
    uses = 0,
    resultsSeen = 0;
  for (const block of blocks) {
    if (block.type === "server_tool_use") {
      uses++;
      if (text.trim()) results.push(text.trim());
      text = "";
    } else if (block.type === "web_search_tool_result") {
      resultsSeen++;
      results.push(
        Array.isArray(block.content)
          ? {
              tool_use_id: block.tool_use_id,
              content: block.content.map(({ title, url }) => ({ title, url })),
            }
          : `Web search error: ${block.content.error_code}`,
      );
    } else text += block.text;
  }
  if (text.trim()) results.push(text.trim());
  return {
    query,
    results,
    durationSeconds,
    searchCount: Math.max(uses, resultsSeen),
  };
}

/** Original sn.mapToolResultToToolResultBlockParam, without search_result citations. */
export function formatSearchOutput(output: WebSearchOutput): string {
  let text = `Web search results for query: "${output.query}"\n\n`;
  for (const item of output.results) {
    if (typeof item === "string") text += item + "\n\n";
    else if (item.content.length > 0)
      text += `Links: ${JSON.stringify(item.content)}\n\n`;
    else text += "No links found.\n\n";
  }
  text +=
    "\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";
  return text.trim();
}

export interface WebSearchHost {
  /** POST a Messages request body through the session's provider transport. */
  send(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  model(): string;
  maxTokens(model: string): number;
  now?: () => number;
}

export async function runWebSearch(
  input: WebSearchInput,
  host: WebSearchHost,
  signal: AbortSignal,
): Promise<WebSearchOutput> {
  validateWebSearchInput(input);
  const now = host.now ?? (() => performance.now());
  const started = now();
  const model = host.model();
  const response = await host.send(
    webSearchRequestBody(input, model, host.maxTokens(model)),
    signal,
  );
  const body = await response.text();
  signal.throwIfAborted();
  if (!response.ok) {
    const message = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(JSON.parse(body || "null"));
    throw new WebSearchError(
      message.success
        ? `API Error: ${response.status} ${message.data.error.message}`
        : `API Error: ${response.status}`,
    );
  }
  const blocks = (response.headers.get("content-type") ?? "").includes(
    "application/json",
  )
    ? parseBlocks(
        z.object({ content: z.array(z.unknown()) }).parse(JSON.parse(body))
          .content,
      )
    : blocksFromSse(body);
  return assembleSearchOutput(blocks, input.query, (now() - started) / 1000);
}

/** Original vLa (non-lean, citations off) with the current month filled in like kLa. */
export function webSearchDescription(date = new Date()): string {
  const month = date.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  return `
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is ${month}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`;
}
