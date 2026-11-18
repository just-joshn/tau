import type { HookBatchResult, HookPermission, HookRegistry } from "./hooks.js";

export type HookRegistryLike = Pick<HookRegistry, "list" | "run" | "close"> &
  Partial<Pick<HookRegistry, "prepareDispatch">>;

/** Keep static one-shot state alive while session registrations change. */
export function composeHookRegistries(
  ...registries: HookRegistryLike[]
): HookRegistryLike {
  return {
    list(event) {
      return registries.flatMap((registry) => registry.list(event));
    },
    async run(input, options) {
      const batches = await Promise.all(
        registries.map((registry) => registry.run(input, options)),
      );
      const merged: HookBatchResult = {
        results: [],
        background: [],
        additionalContext: [],
        systemMessages: [],
        blockingErrors: [],
        preventContinuation: false,
        cancelled: false,
        watchPaths: [],
        reloadSkills: false,
      };
      const rank: Record<HookPermission, number> = {
        allow: 1,
        defer: 2,
        ask: 3,
        deny: 4,
      };
      for (const batch of batches) {
        merged.results.push(...batch.results);
        merged.background.push(...batch.background);
        merged.additionalContext.push(...batch.additionalContext);
        merged.systemMessages.push(...batch.systemMessages);
        merged.blockingErrors.push(...batch.blockingErrors);
        merged.watchPaths.push(...batch.watchPaths);
        merged.preventContinuation ||= batch.preventContinuation;
        merged.cancelled ||= batch.cancelled;
        merged.reloadSkills ||= batch.reloadSkills;
        if (
          batch.permission !== undefined &&
          (merged.permission === undefined ||
            rank[batch.permission] >= rank[merged.permission])
        ) {
          merged.permission = batch.permission;
          if (batch.reason !== undefined) merged.reason = batch.reason;
        }
        for (const key of [
          "updatedInput",
          "updatedToolOutput",
          "updatedMCPToolOutput",
          "stopReason",
          "initialUserMessage",
          "sessionTitle",
        ] as const) {
          if (batch[key] !== undefined)
            Object.assign(merged, { [key]: batch[key] });
        }
      }
      if (
        input.hook_event_name === "PreToolUse" &&
        merged.blockingErrors.length
      )
        merged.permission = "deny";
      return merged;
    },
    async close() {
      await Promise.allSettled(registries.map((registry) => registry.close()));
    },
  };
}
