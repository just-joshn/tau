import { onTestFinished } from "bun:test";
import { createServer } from "node:http";
import { fixtureSse } from "./sse-fixture.js";

type Events = readonly unknown[];

/** Picks the SSE events for request `index` (0-based) from its parsed body. */
export type Responder = (
  body: unknown,
  index: number,
) => Events | Promise<Events>;

/**
 * Serves raw SSE event lists, one per request, and ends every response
 * normally. Unlike the mock provider's "drop", a stream cut short before
 * message_stop arrives whole, so truncation tests are deterministic. A list
 * script answers requests beyond its end with HTTP 500; a responder function
 * sees each request body, for ids only known at run time. Closes when the
 * test finishes.
 */
export async function startSseServer(
  script: readonly Events[] | Responder,
): Promise<{ url: string; requests: () => number; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const respond: Responder =
    typeof script === "function"
      ? script
      : (_body, index) => script[index] ?? [];
  const server = createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += String(chunk);
    const index = bodies.length;
    const body: unknown = JSON.parse(raw);
    bodies.push(body);
    const events = await respond(body, index);
    if (events.length === 0) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(fixtureSse(events));
  });
  await new Promise<void>((listening) =>
    server.listen(0, "127.0.0.1", listening),
  );
  onTestFinished(
    () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("SSE server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => bodies.length,
    bodies,
  };
}

export function messageStart(): unknown {
  return {
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
}

export function textBlock(index: number, text: string): unknown {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "text", text },
  };
}

/** A complete single-block turn: text ends the turn, a tool call asks for its result. */
export function turn(
  block:
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      },
): Events {
  return [
    messageStart(),
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
}
