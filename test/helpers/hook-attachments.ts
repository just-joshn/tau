import type { ToolFailureHookResult } from "../../src/tool-hook-runtime.js";
import type { HookAttachment } from "../../src/types.js";

/** A failure hook's blocking feedback, as the hook runtime reports it. */
export const failureFeedback = (text: string): ToolFailureHookResult => ({
  attachments: [
    {
      phase: "failure",
      type: "hook_blocking_error",
      hookName: "PostToolUseFailure:Tool",
      command: "hook",
      blockingError: text,
    },
  ],
});

/** The hook texts a result carries: context lines and blocking feedback, in order. */
export const hookTexts = (attachments?: readonly HookAttachment[]) =>
  attachments?.flatMap((attachment) =>
    attachment.type === "hook_additional_context"
      ? attachment.content
      : attachment.type === "hook_blocking_error"
        ? [attachment.blockingError]
        : [],
  );
