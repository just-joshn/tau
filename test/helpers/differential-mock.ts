import { onTestFinished } from "bun:test";
import { createServer } from "node:http";

/**
 * The text/files/failures scenarios of scripts/differential/mock_api.py, byte
 * for byte, so tau runs see the SSE the original's oracle captures saw.
 */
export const DIFFERENTIAL_MODEL = "claude-sonnet-4-5-20250929";
export type DifferentialScenario = "text" | "files" | "failures";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object };

const STEPS: Record<"files" | "failures", [string, object][]> = {
  files: [
    ["Read", { file_path: "a.txt" }],
    ["Edit", { file_path: "a.txt", old_string: "alpha", new_string: "beta" }],
    ["Write", { file_path: "a.txt", content: "final\n" }],
  ],
  failures: [
    ["Edit", { file_path: "a.txt", old_string: "alpha", new_string: "beta" }],
    ["Read", { file_path: "missing.txt" }],
    ["Read", { file_path: "a.txt" }],
    ["Edit", { file_path: "a.txt", old_string: "absent", new_string: "beta" }],
    ["Write", { file_path: "a.txt", content: "final\n" }],
  ],
};

function response(
  scenario: DifferentialScenario,
  generation: number,
): { content: Block[]; stop: string } {
  if (scenario === "text")
    return { content: [{ type: "text", text: "mock done" }], stop: "end_turn" };
  const step = STEPS[scenario][generation - 1];
  if (step === undefined)
    return {
      content: [{ type: "text", text: "file workflow done" }],
      stop: "end_turn",
    };
  const [name, input] = step;
  return {
    content: [{ type: "tool_use", id: `fixture-${generation}`, name, input }],
    stop: "tool_use",
  };
}

/** Python json.dumps separators, so the SSE bytes match mock_api.py. */
function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
      .join(", ")}}`;
  return JSON.stringify(value);
}

function events(content: Block[], stop: string, model: string): object[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_disposable_mock",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    ...content.flatMap((block, index) => [
      {
        type: "content_block_start",
        index,
        content_block:
          block.type === "text"
            ? { ...block, text: "" }
            : { ...block, input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta:
          block.type === "text"
            ? { type: "text_delta", text: block.text }
            : {
                type: "input_json_delta",
                partial_json: pythonJson(block.input),
              },
      },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
}

export interface DifferentialMock {
  url: string;
  /** Message request bodies in arrival order; count_tokens calls are excluded. */
  requests: unknown[];
}

export async function startDifferentialMock(
  scenario: DifferentialScenario,
): Promise<DifferentialMock> {
  const requests: unknown[] = [];
  const server = createServer(async (request, reply) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const path = (request.url ?? "").split("?")[0];
    if (path === "/v1/messages/count_tokens") {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end('{"input_tokens":32}');
      return;
    }
    const body: unknown = JSON.parse(raw);
    requests.push(body);
    const model =
      typeof body === "object" &&
      body !== null &&
      "model" in body &&
      typeof body.model === "string"
        ? body.model
        : DIFFERENTIAL_MODEL;
    const { content, stop } = response(scenario, requests.length);
    reply.writeHead(200, { "content-type": "text/event-stream" });
    reply.end(
      events(content, stop, model)
        .map(
          (event) =>
            `event: ${String(Reflect.get(event, "type"))}\ndata: ${pythonJson(event)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("differential mock has no TCP address");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
