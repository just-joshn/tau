/**
 * Request fields the original gates per model and per conversation:
 * `context_management` with its beta, and `thinking.display` with the
 * "updates" beta and the probe that drops it after an unexplained 400.
 */
import { triBoolean } from "./env-settings.js";
import { betaHeaderRejected } from "./http-error.js";
import {
  resolveModelFacts,
  supportsInterleavedThinking,
  type ThinkingRequest,
} from "./reasoning.js";

export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
export const THINKING_DISPLAY_UPDATES_BETA =
  "thinking-display-updates-2026-08-18";
/** Source `HMn` with thinking on and no tool clearing. */
const CLEAR_THINKING = {
  edits: [{ type: "clear_thinking_20251015", keep: "all" }],
} as const;

/** The session's own display, before any per-request upgrade to "updates". */
export type SessionThinkingDisplay = "summarized" | "omitted" | undefined;

/** Source `yfi` without `--thinking-display`. */
export function sessionThinkingDisplay(session: {
  interactive: boolean;
  format: "text" | "json" | "stream-json";
  verbose: boolean;
  showThinkingSummaries?: boolean;
}): SessionThinkingDisplay {
  if (session.interactive)
    return session.showThinkingSummaries ? "summarized" : undefined;
  return session.format === "text" ||
    (session.format === "json" && !session.verbose)
    ? "omitted"
    : undefined;
}

export interface DisplayOptions {
  session: SessionThinkingDisplay;
  showThinkingSummaries?: boolean;
}

/**
 * Source `tf`, one per query: after an unexplained 400 the request is sent
 * once more without the field. The original's "withoutUpdates" step needs
 * an explicit --thinking-display, which tau does not take.
 */
export type DisplayProbe = "idle" | "withoutField" | "spent";

export type WireThinking = ThinkingRequest & { display?: string };
export interface RequestPlan {
  thinking: WireThinking | undefined;
  contextManagement: typeof CLEAR_THINKING | undefined;
  betas: string[];
  /** The display this request carries, if any (source `yoe`). */
  display: string | undefined;
}

/** Source `Ir().thinkingDisplayProbeFailures`: two failed probes end probing for the process. */
let displayProbeFailures = 0;
export function resetRequestFeatureLatches(): void {
  displayProbeFailures = 0;
}

/** Source `zqn` reduced to whether "updates" applies. */
function connectorText(
  display: DisplayOptions,
  env: NodeJS.ProcessEnv,
): boolean {
  if (display.session !== undefined || display.showThinkingSummaries)
    return false;
  return triBoolean(env.CLAUDE_CODE_THINKING_DISPLAY_UPDATES) !== false;
}

/** Conversation-level refusals (source `Fh`), kept across queries. */
export class RequestFeatures {
  private readonly contextManagementRefused = new Set<string>();
  private displayRefused = false;
  private updatesRefused = false;

  constructor(
    private readonly display: DisplayOptions | undefined,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  plan(
    model: string,
    thinking: ThinkingRequest | undefined,
    probe: DisplayProbe,
  ): RequestPlan {
    const thinkingOn =
      thinking?.type === "enabled" || thinking?.type === "adaptive";
    const experimentalOff =
      triBoolean(this.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) === true;
    const facts = resolveModelFacts(model, this.env);
    // Source `mV` for the first-party provider.
    const contextBeta =
      !experimentalOff &&
      !facts.canonical.includes("claude-3-") &&
      !this.contextManagementRefused.has(facts.wire.toLowerCase());
    // Source `uz`/`F6t`.
    const displayable =
      this.display !== undefined &&
      thinkingOn &&
      !experimentalOff &&
      supportsInterleavedThinking(model, this.env) &&
      !this.displayRefused &&
      probe === "idle";
    const updates =
      displayable &&
      !this.updatesRefused &&
      this.env.CLAUDE_CODE_SIMULATE_PROXY_USAGE === undefined &&
      this.display !== undefined &&
      connectorText(this.display, this.env);
    const display = updates
      ? "updates"
      : displayable
        ? this.display?.session
        : undefined;
    return {
      thinking:
        thinking && display !== undefined ? { ...thinking, display } : thinking,
      contextManagement: contextBeta && thinkingOn ? CLEAR_THINKING : undefined,
      betas: [
        contextBeta ? CONTEXT_MANAGEMENT_BETA : "",
        updates ? THINKING_DISPLAY_UPDATES_BETA : "",
      ].filter(Boolean),
      display,
    };
  }

  /** Source `Sgt` for these two betas: a named refusal drops the beta for the conversation. */
  refusedBeta(model: string, message: string, plan: RequestPlan): boolean {
    if (
      plan.betas.includes(CONTEXT_MANAGEMENT_BETA) &&
      (betaHeaderRejected(message, CONTEXT_MANAGEMENT_BETA) ||
        message.includes(
          "context_management: Extra inputs are not permitted",
        ) ||
        /Input tag 'clear_(?:thinking|tool_uses)_\d+'/.test(message))
    ) {
      this.contextManagementRefused.add(
        resolveModelFacts(model, this.env).wire.toLowerCase(),
      );
      return true;
    }
    if (
      plan.betas.includes(THINKING_DISPLAY_UPDATES_BETA) &&
      betaHeaderRejected(message, THINKING_DISPLAY_UPDATES_BETA)
    ) {
      this.updatesRefused = true;
      return true;
    }
    return false;
  }

  /**
   * Source `cUt`: the probe's next state after an otherwise unclaimed 400 or
   * 422. Only "withoutField" resends. Off against api.anthropic.com (`cPt`).
   */
  probeAfterRefusal(
    probe: DisplayProbe,
    plan: RequestPlan,
    firstPartyHost: boolean,
  ): DisplayProbe {
    if (probe === "withoutField") {
      displayProbeFailures++;
      return "spent";
    }
    return probe === "idle" &&
      plan.display !== undefined &&
      displayProbeFailures < 2 &&
      !firstPartyHost
      ? "withoutField"
      : probe;
  }

  /** Source `AG`: an answer to the resend without the field stops this conversation sending it. */
  settle(probe: DisplayProbe): void {
    if (probe !== "withoutField") return;
    this.displayRefused = true;
    this.updatesRefused = true;
  }
}
