/** Convenience fixture blocks are encoded as genuine empty-start + delta API events. */
export function fixtureEvents(events: readonly any[]): any[] {
  return events.flatMap(event => {
    const block = event.type === "content_block_start" ? event.content_block : undefined;
    if (block?.type === "text" && typeof block.text === "string" && block.text !== "") return [
      { ...event, content_block: { ...block, text: "" } },
      { type: "content_block_delta", index: event.index, delta: { type: "text_delta", text: block.text } },
    ];
    if (block?.type === "tool_use" && block.input && typeof block.input === "object" && Object.keys(block.input).length) return [
      { ...event, content_block: { ...block, input: {} } },
      { type: "content_block_delta", index: event.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
    ];
    return [event];
  });
}
export function fixtureSse(events: readonly any[], newline = "\n"): string {
  return fixtureEvents(events).map(event => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join("");
}
