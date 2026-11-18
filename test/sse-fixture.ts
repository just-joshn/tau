import { streamEventSchema } from "../src/message-stream.js";

type StreamEvent = ReturnType<typeof streamEventSchema.parse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Convenience fixture blocks are encoded as genuine empty-start + delta API events. */
function expandEvents(events: readonly unknown[]): unknown[] {
  return events.flatMap((event) => {
    const block =
      isRecord(event) && event.type === "content_block_start"
        ? event.content_block
        : undefined;
    if (!isRecord(event) || !isRecord(block)) return [event];
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text !== ""
    )
      return [
        { ...event, content_block: { ...block, text: "" } },
        {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "text_delta", text: block.text },
        },
      ];
    if (
      block.type === "tool_use" &&
      isRecord(block.input) &&
      Object.keys(block.input).length
    )
      return [
        { ...event, content_block: { ...block, input: {} } },
        {
          type: "content_block_delta",
          index: event.index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      ];
    return [event];
  });
}
export function fixtureEvents(events: readonly unknown[]): StreamEvent[] {
  return expandEvents(events).map((event) => streamEventSchema.parse(event));
}
export function fixtureSse(events: readonly unknown[], newline = "\n"): string {
  return expandEvents(events)
    .map(
      (event) =>
        `event: ${String(isRecord(event) ? event.type : undefined)}${newline}data: ${JSON.stringify(event)}${newline}${newline}`,
    )
    .join("");
}
