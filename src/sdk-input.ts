import { z } from "zod";
import { NativeStructuredInput } from "./native-structured-input.js";
import { textBlockSchema } from "./types.js";

/** Malformed --input-format stream-json input; the run exits 1 with this message. */
export class SdkInputFatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkInputFatal";
  }
}

export interface SdkUserTurn {
  content: z.infer<typeof textBlockSchema>[];
}

const userLineSchema = z.object({
  message: z.object({
    content: z.union([z.string(), z.array(textBlockSchema)]),
  }),
});

/** The original's Ve diagnostic for a line that does not parse. */
function parseFailure(line: string, error: unknown): string {
  const type = /"type"\s*:\s*"([\w-]{1,40})"/.exec(line)?.[1] ?? "unknown";
  return `Error parsing streaming input line (type=${type}, ${line.length} chars): ${error instanceof Error ? error.name : typeof error}`;
}

/**
 * The structured IO processLine contract (chunk-9enk3ymf.js) reduced to the
 * messages tau acts on: blank lines and keep_alive are skipped, unknown and
 * unported types are dropped, a non-user role or unparsable line is fatal.
 */
export function parseSdkInputLine(line: string): SdkUserTurn | undefined {
  if (!line.trim()) return;
  let value: unknown;
  try {
    value = JSON.parse(line);
    if (value === null)
      throw new TypeError("null is not an object (evaluating 'n.type')");
  } catch (error) {
    throw new SdkInputFatal(parseFailure(line, error));
  }
  // keep_alive, control and other non-user frames have no tau consumer.
  if (typeof value !== "object" || !("type" in value) || value.type !== "user")
    return;
  const role =
    "message" in value &&
    typeof value.message === "object" &&
    value.message !== null &&
    "role" in value.message
      ? value.message.role
      : undefined;
  if (role !== "user")
    throw new SdkInputFatal(
      `Error: Expected message role 'user', got '${String(role)}'`,
    );
  const parsed = userLineSchema.safeParse(value);
  if (!parsed.success)
    throw new SdkInputFatal(
      "Error: tau stream-json input accepts string or text-block user content only",
    );
  const { content } = parsed.data.message;
  return {
    content:
      typeof content === "string" ? [{ type: "text", text: content }] : content,
  };
}

/** Successive user turns from newline-delimited stream-json input. */
export function sdkUserTurns(
  input: AsyncIterable<string>,
): AsyncGenerator<SdkUserTurn, void> {
  return new NativeStructuredInput<SdkUserTurn>({
    input,
    host: {
      processLine: parseSdkInputLine,
      serialize: (value) => JSON.stringify(value),
      configProbe: () => false,
      probeDiscarded: () => {},
      yieldTick: () => new Promise((resolve) => setImmediate(resolve)),
      parsed: () => {},
      lineBudgetExceeded: () => {},
      fatalInput: (message) => Promise.reject(new SdkInputFatal(message)),
      inputClosed: () => {},
    },
  }).structuredInput;
}
