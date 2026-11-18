/** Factual error signatures; upstream text is used only to make a decision. */
const contextPhrases = [
  "maximum context length", "context_length_exceeded", "exceeds the context window", "contextwindowexceedederror",
  "longer than the maximum model length", "longer than the model's context length", "exceeds the available context size",
  "exceeds the maximum number of tokens allowed", "exceeded model token limit", "input token length too long",
  "input tokens exceed the configured limit", "maximum context limit", "maximum prompt length", "prompt exceeds max length",
  "tokens in request more than max tokens allowed", "range of input length should be", "context window exceeds limit",
  "but model only supports up to", "reduce the length of the messages", "`inputs` tokens + `max_new_tokens` must be",
  "context exceeds your deployment",
];
export interface ContextRejection { kind: "prompt" | "combined"; actualTokens?: number; limitTokens?: number; gap?: number }

export function capabilityRejected(message: string, capability: string): boolean {
  const marker = `capability_rejected: ${capability}`;
  for (let from = 0;;) {
    const index = message.indexOf(marker, from); if (index < 0) return false;
    const next = message[index + marker.length];
    if (next === undefined || !/[A-Za-z0-9_:.-]/.test(next)) return true;
    from = index + 1;
  }
}

export function combinedContextOverflow(message: string): boolean {
  return message.toLowerCase().includes("input length and `max_tokens` exceed context limit") || capabilityRejected(message, "max_tokens_context_overflow");
}
export function broadContextOverflow(message: string): boolean {
  const value = message.toLowerCase();
  return !specificPromptOverflow(message) && contextPhrases.some(phrase => value.includes(phrase)) &&
    !["policy_blocked", "dlp_request_denied", "output blocked by content filtering policy", "string too long. expected a string with maximum length", "expected maxlength"].some(phrase => value.includes(phrase));
}
function specificPromptOverflow(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("prompt is too long") || value.includes("input is too long for requested model");
}
export function contextRejection(status: number, message: string): ContextRejection | undefined {
  if (combinedContextOverflow(message)) return { kind: "combined" };
  if (!specificPromptOverflow(message) && !capabilityRejected(message, "prompt_too_long") &&
      !([400, 413, 422].includes(status) && broadContextOverflow(message))) return;
  const match = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(message);
  const actualTokens = Number(match?.[1]), limitTokens = Number(match?.[2]);
  if (!Number.isSafeInteger(actualTokens) || !Number.isSafeInteger(limitTokens) || actualTokens < 0 || limitTokens < 0) return { kind: "prompt" };
  return { kind: "prompt", actualTokens, limitTokens, ...(actualTokens > limitTokens ? { gap: actualTokens - limitTokens } : {}) };
}

/** Conservative subset of the source's specialized-error exclusions for guessed output caps. */
export function excludesGuessedOutputCap(status: number, message: string, code?: string): boolean {
  const value = message.toLowerCase();
  return (contextRejection(status, message)?.kind === "prompt" && !broadContextOverflow(message)) ||
    ["policy_blocked", "dlp_request_denied", "safety_monitor_blocked", "claude_code_version_too_old"].includes(code ?? "") ||
    ["could not process image", "image exceeds", "image dimensions exceed", "image does not match the provided media type",
      "image cannot be empty", "exceeds api limit", "images exceed the api limit", "unable to resize image",
      "unable to compress image", "image file is empty", "policy_blocked", "dlp_request_denied"].some(phrase => value.includes(phrase));
}
