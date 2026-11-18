import type { NativeLifecycleDecision } from "./native-lifecycle-hooks.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";

export interface NativeStopQueryState {
  readonly stopHookActive: boolean;
  readonly blockingCount: number;
}
export type NativeStopQueryTransition =
  | { kind: "continue"; state: NativeStopQueryState; nextTurn: number }
  | {
      kind: "end";
      reason: "completed" | "prevented" | "max-turns" | "block-cap";
      state: NativeStopQueryState;
      attemptedBlockingCount?: number;
      nextTurn?: number;
      warning?: string;
    };

const goalTools = new Set(["SetGoal", "ProposeGoal", "PauseGoal", "GetGoal"]);

/** Wa + pp: tool work resets the consecutive counter, except a nonempty all-goal batch. */
export function nativeStopStateAfterTools(
  state: NativeStopQueryState,
  names: readonly string[],
): NativeStopQueryState {
  return Object.freeze({
    stopHookActive: state.stopHookActive,
    blockingCount:
      names.length > 0 && names.every((name) => goalTools.has(name))
        ? state.blockingCount
        : 0,
  });
}

/** Bl's ordinary query guard; retained source rows are already owned by the lifecycle consumer. */
export function advanceNativeStopQuery(input: {
  state: NativeStopQueryState;
  decision: NativeLifecycleDecision;
  turn: number;
  maxTurns: number;
  blockCap: NativePromptFact<number | undefined>;
}): NativeStopQueryTransition {
  const { decision, turn, maxTurns } = input;
  const state = Object.freeze({ ...input.state });
  if (
    !Number.isSafeInteger(turn) ||
    turn < 1 ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 1 ||
    !Number.isSafeInteger(state.blockingCount) ||
    state.blockingCount < 0
  )
    throw new Error(
      "Native Stop query requires its actual ordinary query counters",
    );
  if (decision.event !== "Stop" || decision.unsupported.length)
    throw new Error(
      "Native Stop query lacks its supported actual lifecycle decision",
    );
  if (decision.preventContinuation)
    return Object.freeze({ kind: "end", reason: "prevented", state });
  if (!decision.continuationEvents.length)
    return Object.freeze({ kind: "end", reason: "completed", state });
  if (!decision.continue)
    throw new Error(
      "A reaction-only lifecycle decision cannot drive another query",
    );
  const nextTurn = turn + 1,
    count = state.blockingCount + 1;
  if (nextTurn > maxTurns)
    return Object.freeze({
      kind: "end",
      reason: "max-turns",
      state,
      attemptedBlockingCount: count,
      nextTurn,
    });
  if (input.blockCap.status !== "known") throw new Error(input.blockCap.reason);
  const cap = input.blockCap.value ?? 8;
  if (!Number.isFinite(cap))
    throw new Error("Native Stop cap requires its actual finite setting");
  if (cap > 0 && count > cap)
    return Object.freeze({
      kind: "end",
      reason: "block-cap",
      state,
      attemptedBlockingCount: count,
      nextTurn,
      warning:
        `A hook blocked the turn from ending ${count} consecutive times — overriding and ending turn. ` +
        "For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.",
    });
  return Object.freeze({
    kind: "continue",
    nextTurn,
    state: Object.freeze({ stopHookActive: true, blockingCount: count }),
  });
}
