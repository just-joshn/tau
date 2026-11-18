import { onTestFinished } from "bun:test";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { fixtureSse } from "./sse-fixture.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** One provider response, consumed by one request, in script order. */
export type ScriptedResponse =
  /** A streamed assistant turn. */
  | {
      kind: "turn";
      content: ContentBlock[];
      stopReason: StopReason;
      usage?: Usage;
    }
  /** An HTTP error with a JSON body, e.g. 429 with a retry-after header. */
  | {
      kind: "error";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  /** Accepts the request and never responds, for cancellation tests. */
  | { kind: "hang" }
  /** Streams the first `events` SSE events of a turn, then destroys the socket. */
  | { kind: "drop"; events: number; content?: ContentBlock[] };

export interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockProvider {
  url: string;
  requests: RecordedRequest[];
  /** Requests that arrived after the script ran out. Each got HTTP 500. */
  readonly unexpected: number;
  close(): Promise<void>;
}

/**
 * Serves `script` on loopback, one entry per request. It is strict: a request
 * beyond the script gets HTTP 500 and counts as unexpected, because a fake
 * that answers anything makes a broken harness look correct. Closes itself
 * when the current test finishes.
 */
export async function startMockProvider(
  script: readonly ScriptedResponse[],
): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  let unexpected = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += String(chunk);
    requests.push({
      path: request.url ?? "",
      headers: request.headers,
      body: parseBody(raw),
    });
    const next = script[requests.length - 1];
    if (next === undefined) {
      unexpected++;
      sendJson(response, 500, {
        type: "error",
        error: { type: "api_error", message: "mock provider script exhausted" },
      });
      return;
    }
    serve(response, next);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("mock provider has no TCP address");

  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
  onTestFinished(close);
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get unexpected() {
      return unexpected;
    },
    close,
  };
}

function parseBody(raw: string): unknown {
  try {
    const body: unknown = JSON.parse(raw);
    return body;
  } catch {
    return raw;
  }
}

function serve(response: ServerResponse, entry: ScriptedResponse): void {
  switch (entry.kind) {
    case "turn":
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        fixtureSse(turnEvents(entry.content, entry.stopReason, entry.usage)),
      );
      return;
    case "error":
      sendJson(response, entry.status, entry.body, entry.headers);
      return;
    case "hang":
      return;
    case "drop": {
      const content = entry.content ?? [{ type: "text", text: "partial" }];
      const events = turnEvents(content, "end_turn").slice(0, entry.events);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(fixtureSse(events), () => response.destroy());
      return;
    }
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function turnEvents(
  content: readonly ContentBlock[],
  stopReason: StopReason,
  usage: Usage = { input_tokens: 10, output_tokens: 4 },
): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    },
    ...content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: "message_stop" },
  ];
}
