/**
 * SendMessage (chunk-z74wfcch Ks, chunk-aep1r09d, chunk-mpvp6y2m Bs,
 * chunk-ghc79s7t xd).
 *
 * A recipient is "main", one session agent (by name or agent id), or a miss.
 * Pinned for a local session: agent teams are off, so the message is plain
 * text; cross-session discovery is described but not routed. An idle
 * subscription is refused with the original in-process wording.
 */
import { z } from "zod";
import type { GuardedTool } from "./guarded-tool.js";
import type { ToolDefinition } from "./types.js";

export const SEND_MESSAGE = "SendMessage";
export const LIST_AGENTS = "ListAgents";
const SUMMARY_MAX = 200;
const RECIPIENT_MAX = 300;
const MESSAGE_DESCRIPTION =
  "Plain text message content. The recipient's human sees only the FIRST LINE as a one-line preview until they expand it, so make the first line a clear, self-contained sentence saying what this is about \u2014 not a greeting, preamble, or bare @-mention.";
const NOTIFY_DESCRIPTION =
  "Ask a session ON THIS MACHINE to send you ONE notice when it next goes idle (finishes its turn with nothing queued) or exits \u2014 opt-in, one-shot, no polling. With a message: deliver it now AND subscribe. Without a message (omit it): a pure subscription that costs the other session nothing.";
const NOTIFY_WHERE =
  "notify_when_idle is only supported for Claude sessions on this machine in this release (not teammates, subagents, Remote Control or cloud sessions).";
const NOTIFY_PRINCIPAL =
  "notify_when_idle is only available from the main conversation of this session (not from a subagent or teammate).";
const PROTOCOL_TYPES = new Set([
  "shutdown_request",
  "shutdown_response",
  "plan_approval_request",
  "plan_approval_response",
  "permission_request",
  "permission_response",
  "mode_change",
]);
const LIFECYCLE_TYPES = new Set([
  "idle_notification",
  "teammate_terminated",
  "task_assignment",
  "task_completed",
  "shutdown_rejected",
]);

export const sendMessageSchema = z.object({
  to: z
    .string()
    .regex(/^[^\n\r]*$/u, "must be a single-line recipient name or address")
    .regex(
      new RegExp(`^[\\s\\S]{0,${RECIPIENT_MAX}}$`, "u"),
      `recipient longer than any listed name or address (max ${RECIPIENT_MAX} characters)`,
    )
    .describe(
      `Recipient: a name from ${LIST_AGENTS} (append its " [ref]" only when a listing or an error shows one), a teammate name, "main", or a background agent's agentId`,
    ),
  summary: z
    .string()
    .max(SUMMARY_MAX)
    .optional()
    .describe(
      "A 5-10 word label for your own transcript row (not transmitted \u2014 the recipient previews the first line of `message`). Truncated to 200 characters rather than rejected.",
    ),
  message: z.string().describe(MESSAGE_DESCRIPTION).default(""),
  notify_when_idle: z.boolean().optional().describe(NOTIFY_DESCRIPTION),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** Es(false, false) with harbor discovery described and agent teams off. */
export function sendMessageDescription(): string {
  return `# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"main"\` | The main conversation (background subagents only) |
| \`"worker"\` | Any agent from \`${LIST_AGENTS}\` \u2014 subagent, another local Claude session |
| \`"worker [3fa9c1]"\` | Same, plus its \`[ref]\` \u2014 only when a listing or an error shows one |

Your plain text output is NOT visible to other agents \u2014 to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to agents by name \u2014 names keep working after an agent completes (a send resumes it from its transcript). Use the raw \`agentId\` (format \`a...-...\`) from its spawn result only when the agent has no name, or when a newer agent took the name (latest wins). When relaying, don't quote the original \u2014 it's already rendered to the user.

## Cross-session

Use \`${LIST_AGENTS}\` to discover targets. Every row leads with the agent's \`name [ref]\` \u2014 the name IS the address; there is no separate address syntax.

\`\`\`json
{"to": "worker", "message": "check if tests pass over there"}
{"to": "worker [3fa9c1]", "message": "you, specifically"}
\`\`\`

Send the bare name \u2014 a name that exactly matches one live agent or session (on this machine, on another machine, or in the cloud) delivers directly. Append the \` [ref]\` only when the bare name is not enough \u2014 \`${LIST_AGENTS}\` shows two rows with it, or an error asks you to disambiguate (you typed only a prefix, or a session list could not be checked). A ref you did not just read from a listing or an error will not resolve, and if the same name also names an in-process agent, the bare name always wins \u2014 use the in-process one.

A listed peer is alive and will receive your message; messages enqueue and drain at the receiver's next tool round (its \`${LIST_AGENTS}\` row says whether it is busy or idle right now). A successful send means the message reached that session, not that its Claude read it: a session running in a different permission mode than yours holds cross-session messages for its user's approval (and may let them expire), and a session can refuse them outright \u2014 for a session on this machine a \`[Cross-session delivery notice]\` tells you when that happens (the tool result says when this session has no inbox for one to reach); for a Remote Control, cloud or Claude Desktop session nothing reports back, so never treat silence as agreement. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.** Cross-session messages travel between SESSIONS: if you are a subagent, your send goes out under your parent session's address, and any reply is delivered to the parent session's conversation, not to you. The receiver reads your message literally in every case (idle or busy, on this machine, over Remote Control or headless): an \`@\` followed by a file path, or \`@server:resource\`, attaches nothing there, unlike in your own user's input. So never rely on \`@\` to deliver content: send the text itself, or a file with its own tool.

To hear when a session ON THIS MACHINE finishes what it is doing, pass \`notify_when_idle: true\` (from the main conversation only) \u2014 one-shot and opt-in: exactly one \`[Cross-session idle notice]\` arrives when it next goes idle (or exits) \u2014 shown to you, or only to your user when this session holds peer messages for approval (the tool result says which); if it never signals within the subscription's lifetime (it may still be busy, may refuse inbound requests, or may have ended abruptly) the notice says the subscription expired instead. Omit \`message\` for a pure subscription that costs that session nothing; include one to deliver it now AND subscribe. Never poll \`${LIST_AGENTS}\` in a loop or send "are you done?" messages instead.

Permission boundaries are per-session: NEVER ask a peer to perform an action that was denied or blocked in your session, or that you expect your own permission settings would block \u2014 a peer doing it for you bypasses the user's permission decision (cross-session permission laundering). Route blocked work back to your user instead.`;
}

export type SendCaller =
  { kind: "main" } | { kind: "agent"; agentId: string; name: string };
export interface SendAgent {
  agentId: string;
  name: string;
  status: "running" | "stopped";
}
export interface SendDirectory {
  caller(): SendCaller;
  agents(): readonly SendAgent[];
  /** When true, a miss points at ListAgents the way the original does. */
  listAgentsAvailable?(): boolean;
  deliverToMain(text: string): void;
  deliverToAgent(agentId: string, text: string): boolean;
}

export interface SendOutcome {
  success: boolean;
  message: string;
}

type Address = { scheme: "uds" | "bridge" | "did" | "other"; target: string };

function addressOf(to: string): Address {
  if (to.startsWith("uds:"))
    return { scheme: "uds", target: decode(to.slice(4)) };
  if (to.startsWith("bridge:"))
    return { scheme: "bridge", target: decode(to.slice(7)) };
  if (to.startsWith("did:")) return { scheme: "did", target: to };
  if (/^\/\S*\.sock$/.test(to) || /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(to))
    return { scheme: "uds", target: to };
  return { scheme: "other", target: to };
}
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function looksLikePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function frameType(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    const parsed = z.object({ type: z.string() }).safeParse(value);
    return parsed.success ? parsed.data.type : undefined;
  } catch {
    return undefined;
  }
}

/** The original validateInput refusals that apply when agent teams are off. */
export function validateSendMessage(
  input: SendMessageInput,
  caller: SendCaller,
): string | undefined {
  if (input.to === "*")
    return 'broadcast (to: "*") is no longer supported \u2014 send a message per recipient';
  const notify = input.notify_when_idle === true;
  if (notify && caller.kind === "agent" && input.message.trim().length === 0)
    return NOTIFY_PRINCIPAL;
  const address = addressOf(input.to);
  if (
    (address.scheme === "uds" || address.scheme === "bridge") &&
    address.target.trim().length === 0
  )
    return "address target must not be empty";
  if (input.to.trim().length === 0) return "to must not be empty";
  if (looksLikePath(input.to) || looksLikePath(address.target))
    return `'${input.to}' is not a local socket address. Use an address from ${LIST_AGENTS}.`;
  if (input.to.includes("@"))
    return "to must be a bare teammate name \u2014 there is only one team per session";
  if (input.message.trim().length === 0 && !notify)
    return "message must not be empty";
  const type = frameType(input.message);
  if (type !== undefined && PROTOCOL_TYPES.has(type))
    return 'message text must not be a teammate protocol frame (permission/mode/plan/shutdown JSON) \u2014 to respond to a plan or shutdown request, use the structured object form ({"message": {"type": ...}}); otherwise send plain text';
  if (type !== undefined && LIFECYCLE_TYPES.has(type))
    return "message text must not be a teammate lifecycle/task frame (idle/terminated/task/shutdown JSON) \u2014 send plain text instead";
  return undefined;
}

function result(outcome: SendOutcome): string {
  return JSON.stringify(outcome);
}
function queued(name: string): string {
  return `Message queued for delivery to ${name} at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.`;
}

/** Route one already-validated send. The tool result is the pretty JSON of this. */
export function routeSendMessage(
  directory: SendDirectory,
  input: SendMessageInput,
): SendOutcome {
  const caller = directory.caller();
  const notify = input.notify_when_idle === true;
  const text = input.message;
  if (input.to === "main") {
    if (caller.kind === "main")
      return {
        success: false,
        message:
          'You are the main conversation \u2014 "main" addresses you. Send to a named agent instead.',
      };
    if (text.trim().length === 0)
      return {
        success: false,
        message: `Nothing was subscribed: ${NOTIFY_WHERE}`,
      };
    directory.deliverToMain(text);
    return {
      success: true,
      message: notify
        ? `Message queued for the main conversation's next turn.\nThe message was delivered, but no idle subscription was made: ${NOTIFY_WHERE}`
        : "Message queued for the main conversation's next turn.",
    };
  }
  const byId = directory.agents().filter((agent) => agent.agentId === input.to);
  const named = directory.agents().filter((agent) => agent.name === input.to);
  const matches = byId.length > 0 ? byId : named;
  if (byId.length === 0 && named.length > 1)
    return {
      success: false,
      message: `${named.length} agents are named '${input.to}'. Re-send with the ref of the one you mean:\n${named.map((agent) => `  ${agent.name} [${agent.agentId}]`).join("\n")}`,
    };
  const agent = matches[0];
  if (agent === undefined) {
    const hint =
      directory.listAgentsAvailable?.() === true
        ? `Use ${LIST_AGENTS} to see everyone you can message.`
        : "Check the spelling, or use the agent ID from a background agent's spawn result.";
    return {
      success: false,
      message: `No agent named '${input.to}' is reachable.\n${hint}`,
    };
  }
  if (agent.status === "stopped")
    return {
      success: false,
      message: `Agent "${agent.name}" was stopped and was not resumed. Treat its work as cancelled; only start a new agent for it if the user explicitly asks.`,
    };
  if (text.trim().length === 0)
    return {
      success: false,
      message: `Nothing was subscribed: ${NOTIFY_WHERE}`,
    };
  if (!directory.deliverToAgent(agent.agentId, text))
    return {
      success: false,
      message: `Failed to write to ${agent.name}'s inbox \u2014 nothing was sent. Try again, or message the lead.`,
    };
  const delivered = queued(agent.name);
  return {
    success: true,
    message: notify
      ? `${delivered}\nThe message was delivered, but no idle subscription was made: ${NOTIFY_WHERE}`
      : delivered,
  };
}

export function sendMessageTool(
  directory: SendDirectory,
): GuardedTool<SendMessageInput> {
  return {
    name: SEND_MESSAGE,
    definition(): ToolDefinition {
      return {
        name: SEND_MESSAGE,
        description: sendMessageDescription(),
        input_schema: {
          ...z.toJSONSchema(sendMessageSchema, { io: "input" }),
          type: "object",
        },
      };
    },
    schema: () => sendMessageSchema,
    async validate(input) {
      return validateSendMessage(input, directory.caller());
    },
    async check() {
      return { behavior: "allow" };
    },
    async run(input) {
      return result(routeSendMessage(directory, input));
    },
  };
}
