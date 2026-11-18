import type {
  NativeLifecycleEnd,
  NativeLifecycleYield,
} from "./native-lifecycle-hooks.js";
import {
  createNativeStopHookSummary,
  validateNativeHookProgressRow,
  type NativeHookProgressRow,
  type NativeStopHookInfo,
  type NativeStopHookSummaryCreation,
  type NativeStopHookSummaryHost,
} from "./native-hook-progress.js";
import { isNativeObject } from "./native-session-codec.js";

/** Source kc ordinary command consumer state, updated from actual ordered yields. */
export function createNativeStopHookAccumulator() {
  const progress: NativeHookProgressRow[] = [],
    infos: NativeStopHookInfo[] = [],
    errors: string[] = [],
    contexts: string[] = [];
  let prevented = false,
    reason = "",
    output = false,
    unsupported = false,
    finished = false;
  return {
    progress(row: NativeHookProgressRow) {
      if (finished) throw new Error("Stop accumulator is finished");
      row = validateNativeHookProgressRow(row);
      progress.push(row);
      if (row.data.command)
        infos.push({
          command: row.data.command,
          ...(row.data.promptText === undefined
            ? {}
            : { promptText: row.data.promptText }),
        });
    },
    observed(value: Exclude<NativeLifecycleYield, { kind: "progress" }>) {
      if (finished) throw new Error("Stop accumulator is finished");
      if (value.kind === "unsupported") unsupported = true;
      else if (value.kind === "blocking") {
        errors.push(value.text);
        output = true;
      } else if (value.kind === "context" && value.content.length) {
        contexts.push(...value.content);
        output = true;
      } else if (value.kind === "prevent") {
        prevented = true;
        reason = value.reason || "Stop hook prevented continuation";
      } else if (value.kind === "message") {
        const attachment = value.creation.event.attachment;
        if (
          !isNativeObject(attachment) ||
          (attachment.hookEvent !== "Stop" &&
            attachment.hookEvent !== "SubagentStop")
        )
          return;
        if (attachment.type === "hook_non_blocking_error") {
          if (typeof attachment.exitCode !== "number")
            throw new Error("Missing observed hook exit code");
          errors.push(
            (typeof attachment.stderr === "string" && attachment.stderr) ||
              `Exit code ${attachment.exitCode}`,
          );
          output = true;
        } else if (attachment.type === "hook_error_during_execution") {
          if (typeof attachment.content !== "string")
            throw new Error("Invalid observed hook error");
          errors.push(attachment.content);
          output = true;
        } else if (attachment.type === "hook_success") {
          if (
            (typeof attachment.stdout === "string" &&
              attachment.stdout.trim()) ||
            (typeof attachment.stderr === "string" && attachment.stderr.trim())
          )
            output = true;
        }
        if (
          typeof attachment.command === "string" &&
          typeof attachment.durationMs === "number"
        ) {
          const index = infos.findIndex(
            (info) =>
              info.command === attachment.command &&
              info.durationMs === undefined,
          );
          const info = infos[index];
          if (info)
            infos[index] = { ...info, durationMs: attachment.durationMs };
        }
      }
    },
    finish(
      end: NativeLifecycleEnd,
      host: NativeStopHookSummaryHost,
    ): NativeStopHookSummaryCreation {
      if (finished) throw new Error("Stop summary already finalized");
      finished = true;
      const last = progress.at(-1);
      return createNativeStopHookSummary(
        {
          phase: "blockable-turn-end",
          end: unsupported
            ? "failed"
            : end.kind === "completed"
              ? "normally-drained"
              : end.kind === "orphaned"
                ? "consumer-closed"
                : end.kind,
          observedProgress: progress,
          accumulators: {
            hookCount: progress.length,
            hookInfos: infos,
            hookErrors: errors,
            hookAdditionalContext: contexts,
            preventedContinuation: prevented,
            stopReason: reason,
            hasOutput: output,
            level: "suggestion",
            ...(last ? { toolUseID: last.toolUseID } : {}),
          },
        },
        host,
      );
    },
  };
}
