import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { AnthropicProvider } from "../../src/provider.js";
import type { ProviderStreamProgress } from "../../src/types.js";
import { forAll, type Rng } from "../helpers/seeded.js";

// Metamorphic relation (STRATEGY section 4): how the network splits one SSE
// byte stream into chunks is irrelevant. Every split of the same bytes must
// give the same completion, visible text and progress events as the unsplit
// stream, and those must equal the blocks the stream encodes.

const CASES = 300;
const SPLITS_PER_CASE = 3;

// One-, two-, three- and four-byte UTF-8, plus text that looks like SSE syntax.
const TEXT = [
  "a",
  "Z",
  " ",
  "é",
  "ß",
  "€",
  "中",
  "🌍",
  "👩‍💻",
  ":",
  "data: ",
  "\n",
  "\r",
  '"',
  "\\",
];

type Block =
  | { type: "text"; text: string; deltas: string[] }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, string>;
      fragments: string[];
    };

interface Case {
  blocks: Block[];
  newline: "\n" | "\r\n" | "\r";
  noise: boolean;
  wire: Uint8Array;
  splits: number[][];
}

/** Splits `text` into 1..parts pieces at code point boundaries. */
function pieces(rng: Rng, text: string, parts: number): string[] {
  const points = Array.from(text);
  if (points.length < 2) return [text];
  const cuts = [
    ...new Set(
      Array.from({ length: rng.int(0, parts - 1) }, () =>
        rng.int(1, points.length - 1),
      ),
    ),
  ].sort((a, b) => a - b);
  const result: string[] = [];
  let start = 0;
  for (const cut of [...cuts, points.length]) {
    result.push(points.slice(start, cut).join(""));
    start = cut;
  }
  return result;
}

function generateBlocks(rng: Rng): Block[] {
  return Array.from({ length: rng.int(1, 4) }, (_, index): Block => {
    if (rng.bool(0.6)) {
      const text = rng.string(TEXT, 1, 40);
      return { type: "text", text, deltas: pieces(rng, text, 5) };
    }
    const input: Record<string, string> = {};
    for (let key = rng.int(0, 3); key > 0; key--)
      input[`k${key}`] = rng.string(TEXT, 0, 20);
    return {
      type: "tool_use",
      id: `toolu_${index}_${rng.int(0, 1e6)}`,
      name: rng.pick(["Read", "Bash", "Glob"]),
      input,
      fragments: pieces(rng, JSON.stringify(input), 6),
    };
  });
}

function events(blocks: readonly Block[]): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        role: "assistant",
        content: [],
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((block, index): unknown[] =>
      block.type === "text"
        ? [
            {
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            },
            ...block.deltas.map((text) => ({
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text },
            })),
            { type: "content_block_stop", index },
          ]
        : [
            {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: {},
              },
            },
            ...block.fragments.map((partial_json) => ({
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json },
            })),
            { type: "content_block_stop", index },
          ],
    ),
    {
      type: "message_delta",
      delta: {
        stop_reason: blocks.some((block) => block.type === "tool_use")
          ? "tool_use"
          : "end_turn",
      },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
}

function encode(
  rng: Rng,
  list: readonly unknown[],
  newline: string,
  noise: boolean,
): Uint8Array {
  let wire = "";
  for (const event of list) {
    const type =
      typeof event === "object" && event !== null && "type" in event
        ? String(event.type)
        : "";
    if (noise && rng.bool(0.2)) wire += `: keep-alive 🌍${newline}`;
    if (noise && rng.bool(0.15))
      wire += `event: ping${newline}data: {"type":"ping"}${newline}${newline}`;
    wire += `event: ${type}${newline}`;
    if (noise && rng.bool(0.2)) wire += `id: ${rng.int(0, 99)}${newline}`;
    wire += `data: ${JSON.stringify(event)}${newline}${newline}`;
  }
  return new TextEncoder().encode(wire);
}

/** Cut points biased toward UTF-8 continuation bytes, data: prefixes and line ends. */
function cutPoints(rng: Rng, wire: Uint8Array): number[] {
  const interesting: number[] = [];
  for (let index = 1; index < wire.length; index++) {
    const byte = wire[index] ?? 0;
    const previous = wire[index - 1] ?? 0;
    if ((byte & 0xc0) === 0x80) interesting.push(index);
    if (byte === 0x0a || byte === 0x0d || previous === 0x0d)
      interesting.push(index);
    if (previous === 0x64 && wire[index] === 0x61) interesting.push(index); // d|ata
    if (previous === 0x3a) interesting.push(index); // after ':'
  }
  const count = rng.int(1, 24);
  const cuts = new Set<number>();
  for (let index = 0; index < count; index++)
    cuts.add(
      rng.bool(0.6) && interesting.length > 0
        ? rng.pick(interesting)
        : rng.int(1, wire.length - 1),
    );
  if (rng.bool(0.1))
    for (let index = 1; index < Math.min(wire.length, 200); index++)
      cuts.add(index);
  return [...cuts].sort((a, b) => a - b);
}

function chunk(wire: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts, wire.length]) {
    chunks.push(wire.slice(start, cut));
    start = cut;
  }
  return chunks;
}

function generate(rng: Rng): Case {
  const blocks = generateBlocks(rng);
  const newline = rng.pick(["\n", "\r\n", "\r"] as const);
  const noise = rng.bool(0.5);
  const wire = encode(rng, events(blocks), newline, noise);
  return {
    blocks,
    newline,
    noise,
    wire,
    splits: Array.from({ length: SPLITS_PER_CASE }, () => cutPoints(rng, wire)),
  };
}

interface Observed {
  completion: unknown;
  text: string;
  progress: ProviderStreamProgress[];
  requests: number;
}

async function parse(chunks: readonly Uint8Array[]): Promise<Observed> {
  let requests = 0;
  const respond = async (): Promise<Response> => {
    requests++;
    const queue = [...chunks];
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = queue.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(next);
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  );
  try {
    const provider = new AnthropicProvider({
      apiKey: "fixture",
      baseUrl: "http://127.0.0.1:9",
      maxRetries: 0,
      allowNonStreamingFallback: false,
    });
    let text = "";
    const progress: ProviderStreamProgress[] = [];
    const completion = await provider.complete({
      model: "fixture",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
      onText: (value) => {
        text += value;
      },
      onStreamProgress: (event) => progress.push(event),
    });
    return { completion, text, progress, requests };
  } finally {
    fetchSpy.mockRestore();
  }
}

test("SSE chunk boundaries, including inside UTF-8 and data: lines, never change the parsed stream", async () => {
  await forAll("SSE chunking", CASES, generate, async (input) => {
    const whole = await parse([input.wire]);
    assert.equal(whole.requests, 1);
    // The unsplit stream must decode to exactly the generated blocks.
    assert.deepEqual(whole.completion, {
      content: input.blocks.map((block) =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            },
      ),
      stop_reason: input.blocks.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
      responseId: "msg_fixture",
    });
    assert.equal(
      whole.text,
      input.blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(""),
    );
    for (const cuts of input.splits) {
      const split = await parse(chunk(input.wire, cuts));
      assert.deepEqual(
        split,
        whole,
        `differs when cut at bytes ${cuts.join(",")}`,
      );
    }
  });
});
