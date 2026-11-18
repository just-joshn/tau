import { onTestFinished } from "bun:test";
import { createServer } from "node:http";
import { fixtureSse } from "./sse-fixture.js";

/**
 * Serves each raw SSE event list in order, one per request, and ends every
 * response normally. Unlike the mock provider's "drop", a stream cut short
 * before message_stop arrives whole, so truncation tests are deterministic.
 * Requests beyond the script get HTTP 500. Closes when the test finishes.
 */
export async function startSseServer(
  responses: readonly (readonly unknown[])[],
): Promise<{ url: string; requests: () => number }> {
  let served = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const events = responses[served++];
      if (events === undefined) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(fixtureSse(events));
    });
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
  return { url: `http://127.0.0.1:${address.port}`, requests: () => served };
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
