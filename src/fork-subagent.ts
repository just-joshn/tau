import { triBoolean } from "./env-settings.js";
import type { Message, ToolUse } from "./types.js";

/** Environment values the fork gate reads. Same shape as a prompt env. */
export type ForkSubagentEnv = Readonly<Record<string, string | undefined>>;
export type ForkSubagentGate = "disabled" | "default" | "env";
export interface ForkSubagentGateOptions {
  forkSubagentDisabled?: boolean;
  coordinator?: boolean;
  /** Background default for the ordinary "default" gate. */
  interactive?: boolean;
}

export const FORK_SUBAGENT_TYPE = "fork";
export const FORK_BOILERPLATE_TAG = "fork-boilerplate";
export const FORK_STARTED_TEXT = "Fork started \u2014 that fork is you.";
export const FORK_PARENT_CALL_TEXT =
  "This is the parent's call, not yours. It may not have run yet, and its result goes to the parent.";
const FORK_OTHER_CALL_TEXT =
  "This call started a fork, and that fork is you. The call's other work and its result belong to the parent.";
export const FORK_REMOTE_ISOLATION_MESSAGE =
  'Fork cannot use isolation: "remote" \u2014 a remote session cannot inherit the conversation context. Omit isolation (or use "worktree"), or spawn a named agent type for remote work.';
export const FORK_RECURSIVE_MESSAGE =
  "Fork is not available inside a forked worker. Complete your task directly using your tools.";

/** `LWn`. Disabled wins over an explicit env enable. */
export function resolveForkSubagentGate(
  env: ForkSubagentEnv,
  options: ForkSubagentGateOptions = {},
): ForkSubagentGate {
  if (
    triBoolean(env.CLAUDE_CODE_FORK_SUBAGENT) === false ||
    options.forkSubagentDisabled === true ||
    options.coordinator === true
  )
    return "disabled";
  if (triBoolean(env.CLAUDE_CODE_FORK_SUBAGENT) === true) return "env";
  return "default";
}

/** `bTe`. */
export function isForkSubagentEnabled(
  env: ForkSubagentEnv,
  options?: ForkSubagentGateOptions,
): boolean {
  return resolveForkSubagentGate(env, options) !== "disabled";
}

/** `DWt` for this host: env gate, or the ordinary gate in an interactive session. */
export function isForkBackgroundDefault(
  env: ForkSubagentEnv,
  options: ForkSubagentGateOptions = {},
): boolean {
  const gate = resolveForkSubagentGate(env, options);
  return gate === "env" || (gate === "default" && options.interactive === true);
}

/** `GSt` with an empty extra rule. The tag is `fork-boilerplate`. */
export function buildForkDirective(prompt: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
You are a worker fork. The transcript above is the parent's history \u2014 inherited reference, not your situation. You are NOT a continuation of that agent. Execute ONE directive, then stop.

Hard rules:
- Do NOT spawn subagents with the Agent tool. The "default to forking" guidance is for the parent; you ARE the fork, execute directly.
- One shot: report once and stop. No follow-up questions, no proposed next steps, no waiting for the user.

Guidelines (your directive may override any of these):
- Stay in scope. Other forks may be handling adjacent work; if you spot something outside your directive, note it in a sentence and move on.
- Open with one line restating your task, so the parent can spot scope drift at a glance.
- Be concise \u2014 as short as the answer allows, no shorter. Plain text, no preamble, no meta-commentary.
- If you committed changes, list the paths and commit hashes in your report.
</${FORK_BOILERPLATE_TAG}>

Your directive: ${prompt}`;
}

/** `YEe` / `_Ns` over tau messages. */
export function hasForkDirective(
  messages: readonly Message[] | undefined,
): boolean {
  const prefix = `<${FORK_BOILERPLATE_TAG}>`;
  return (
    messages?.some(
      (message) =>
        message.role === "user" &&
        message.content.some(
          (block) => block.type === "text" && block.text.startsWith(prefix),
        ),
    ) ?? false
  );
}

function forkResultText(block: ToolUse, selectedId: string): string {
  if (block.id !== selectedId) return FORK_PARENT_CALL_TEXT;
  return block.name === "Agent" || block.name === "Task"
    ? FORK_STARTED_TEXT
    : FORK_OTHER_CALL_TEXT;
}

/** Clone the parent transcript and close its trailing assistant tool calls. `SNs`. */
export function buildForkMessages(
  parentMessages: readonly Message[],
  prompt: string,
  toolUseId: string,
): Message[] {
  const messages = parentMessages.map((message) => structuredClone(message));
  const directive = buildForkDirective(prompt);
  const trailing = messages.at(-1);
  const toolUses =
    trailing?.role === "assistant"
      ? trailing.content.filter(
          (block): block is ToolUse => block.type === "tool_use",
        )
      : [];
  if (toolUses.length === 0) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: directive }],
    });
    return messages;
  }
  const only = toolUses[0];
  const selectedId = toolUses.length === 1 && only ? only.id : toolUseId;
  messages.push({
    role: "user",
    content: [
      ...toolUses.map((block) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: forkResultText(block, selectedId),
      })),
      { type: "text" as const, text: directive },
    ],
  });
  return messages;
}
