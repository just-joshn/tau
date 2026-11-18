import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { z } from "zod";
import {
  normalizeHistoryMessages,
  type HistoryProjectionMessage,
} from "../../src/history-normalization.js";
import { AnthropicProvider } from "../../src/provider.js";
import type { Message } from "../../src/types.js";
import { forAll, type Rng } from "../helpers/seeded.js";

// INV-08 for tau (test/helpers/invariants.ts): every tool_result sent to the
// API refers to a tool_use id issued earlier in the same history, and stale
// or foreign ids are dropped before the next request.

const CASES = 250;

type Block = Message["content"][number];

interface History {
  messages: Message[];
  /** Ids the history issues, in order. */
  issued: string[];
}

function generateHistory(rng: Rng, prefix: string): History {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "start" }] },
  ];
  const issued: string[] = [];
  for (let round = rng.int(1, 6); round > 0; round--) {
    const ids = Array.from(
      { length: rng.int(0, 3) },
      () => `${prefix}${issued.length}_${rng.int(0, 1e9)}`,
    ).filter((id, index, all) => all.indexOf(id) === index);
    const blocks: Block[] = [
      ...(rng.bool(0.7)
        ? [{ type: "text" as const, text: rng.pick(["ok", " ", "plan"]) }]
        : []),
      ...ids.map((id) => ({
        type: "tool_use" as const,
        id,
        name: rng.pick(["Read", "Bash"]),
        input: { n: rng.int(0, 9) },
      })),
    ];
    // Tools before text and split responses exercise reordering and merging.
    const ordered = rng.bool(0.3) ? [...blocks].reverse() : blocks;
    if (ordered.length > 1 && rng.bool(0.3)) {
      const cut = rng.int(1, ordered.length - 1);
      const responseId = `msg_${prefix}${round}`;
      messages.push(
        { role: "assistant", content: ordered.slice(0, cut), responseId },
        { role: "assistant", content: ordered.slice(cut), responseId },
      );
    } else
      messages.push({
        role: "assistant",
        content: ordered.length ? ordered : [{ type: "text", text: "done" }],
      });
    issued.push(...ids);
    const results: Block[] = rng
      .shuffle(ids)
      .map((id) => ({ type: "tool_result", tool_use_id: id, content: "r" }));
    messages.push({
      role: "user",
      content: [
        ...results,
        ...(results.length === 0 || rng.bool(0.3)
          ? [{ type: "text" as const, text: "more" }]
          : []),
      ],
    });
  }
  return { messages, issued };
}

/** Adds results for ids the history never issued, or issues only later. */
function corrupt(rng: Rng, history: History): Message[] {
  const messages = structuredClone(history.messages);
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  for (let count = rng.int(1, 3); count > 0; count--) {
    const at = rng.pick(userIndexes);
    const later = history.issued.filter((id) =>
      messages
        .slice(at)
        .some((message) =>
          message.content.some(
            (block) => block.type === "tool_use" && block.id === id,
          ),
        ),
    );
    const id =
      later.length > 0 && rng.bool()
        ? rng.pick(later)
        : `toolu_foreign_${rng.int(0, 1e9)}`;
    messages[at]?.content.unshift({
      type: "tool_result",
      tool_use_id: id,
      content: "stale",
    });
  }
  return messages;
}

const wireSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.array(
        z.looseObject({
          type: z.string(),
          id: z.string().optional(),
          tool_use_id: z.string().optional(),
        }),
      ),
    }),
  ),
});
type Wire = z.infer<typeof wireSchema>["messages"];

const EMPTY_TURN = [
  {
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

/** What the provider sends for `messages`, captured at fetch. */
async function sent(messages: Message[]): Promise<Wire> {
  let body: unknown;
  const respond = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
    return new Response(EMPTY_TURN, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  );
  try {
    await new AnthropicProvider({
      apiKey: "fixture",
      baseUrl: "http://127.0.0.1:9",
      maxRetries: 0,
    }).complete({
      model: "fixture",
      system: "",
      messages,
      tools: [],
      maxTokens: 10,
      signal: new AbortController().signal,
      onText: () => {},
    });
  } finally {
    fetchSpy.mockRestore();
  }
  return wireSchema.parse(body).messages;
}

/** Ids of tool_result blocks with no tool_use earlier in `wire`. */
function unpaired(wire: Wire): string[] {
  const issued = new Set<string>();
  const answered = new Set<string>();
  const bad: string[] = [];
  for (const message of wire)
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id !== undefined)
        issued.add(block.id);
      if (block.type === "tool_result" && block.tool_use_id !== undefined) {
        if (!issued.has(block.tool_use_id) || answered.has(block.tool_use_id))
          bad.push(block.tool_use_id);
        answered.add(block.tool_use_id);
      }
    }
  return bad;
}

test("INV-08 normalization keeps every tool_result after its tool_use and is idempotent", async () => {
  await forAll(
    "tool_result pairing",
    CASES,
    (rng) => generateHistory(rng, "toolu_"),
    async ({ messages, issued }) => {
      const wire = await sent(messages);
      assert.deepEqual(unpaired(wire), []);
      // Nothing issued is lost: each id is used and answered exactly once.
      const results = wire.flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "tool_result" && block.tool_use_id !== undefined
            ? [block.tool_use_id]
            : [],
        ),
      );
      assert.deepEqual([...results].sort(), [...issued].sort());
      const rows: HistoryProjectionMessage[] = messages.map(
        ({ role, content, responseId }) => ({
          role,
          content,
          ...(responseId === undefined ? {} : { responseId }),
        }),
      );
      const once = normalizeHistoryMessages(rows);
      assert.deepEqual(normalizeHistoryMessages(once), once);
    },
  );
});

// KNOWN-GAP: tau forwards results for foreign or not-yet-issued ids. A resumed
// session file containing one sends it unchanged (src/thinking-history.ts
// projectMessages and src/history-normalization.ts never check pairing).
test.failing(
  "KNOWN-GAP INV-08 tool_results for foreign or later ids are dropped before the request",
  async () => {
    await forAll(
      "orphan tool_result removal",
      CASES,
      (rng) => corrupt(rng, generateHistory(rng, "toolu_")),
      async (messages) => {
        assert.deepEqual(unpaired(await sent(messages)), []);
      },
    );
  },
);
