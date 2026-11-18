import type {
  HookDispatchCandidate,
  HookInput,
  HookRunOptions,
  PreparedHookDispatch,
} from "./hooks.js";
import type { HookRegistryLike } from "./composite-hooks.js";
import {
  nativeLifecycleCommandRegistry,
  NativeLifecycleCaptureError,
  type NativeLifecycleCommandFacts,
  type NativeLifecycleRunner,
} from "./native-lifecycle-hooks.js";
import {
  nativeHookProgressDispatch,
  type NativeHookProgressAdmission,
  type NativeHookProgressHost,
} from "./native-hook-progress.js";
import {
  reduceMatchedOrdinaryCommandHooks,
  type NativeCommandHookOrigin,
} from "./scoped-hook-dispatch.js";
import type { NativePromptFact } from "./native-prompt-snapshot.js";
import { isNativeObject } from "./native-session-codec.js";
import { snapshotNativeResponseJson } from "./native-response-recording.js";

export interface NativeLifecycleFinalDispatchFacts {
  admission: NativeHookProgressAdmission;
  /** Actual source provenance for every final candidate; port origin.source is insufficient. */
  origins: NativePromptFact<
    readonly { id: string; nativeOrigin: NativeCommandHookOrigin }[]
  >;
  defaultShell: NativePromptFact<"bash" | "powershell">;
  personalConfigRestricted: NativePromptFact<boolean>;
  dispatchToolUseID: string;
  matchQuery?: string;
}
function actual<T>(fact: NativePromptFact<T>): T {
  if (fact.status !== "known")
    throw new Error("Native final dispatch provenance is unavailable");
  return fact.value;
}
/** Real final winners, one lazy global prefix, then exactly one bound execution. */
export function nativeLifecyclePreparedCommandRegistry(options: {
  registry: HookRegistryLike;
  runOptions(): Omit<HookRunOptions, "signal" | "validateUpdatedInput">;
  facts: Parameters<typeof nativeLifecycleCommandRegistry>[0]["facts"];
  finalDispatch(
    input: Readonly<HookInput>,
    plan: Readonly<{
      selection: NonNullable<PreparedHookDispatch["selection"]>;
      candidates: readonly HookDispatchCandidate[];
    }>,
  ): NativeLifecycleFinalDispatchFacts;
  progressHost: NativeHookProgressHost;
}): NativeLifecycleRunner {
  return {
    progressProtocol: "actual-created-prefix",
    async run(input, signal, onResult, prefix) {
      if (!prefix)
        throw new NativeLifecycleCaptureError(
          new Error("Actual progress consumer is required"),
        );
      const rows = new Map<string, string>(),
        observed = new Set<string>();
      const adapter = nativeLifecycleCommandRegistry({
        runOptions: () => options.runOptions(),
        facts(result, context): NativeLifecycleCommandFacts {
          if (!rows.has(result.id) || observed.has(result.id))
            throw new Error(
              "Lifecycle settlement is not an unobserved final progress candidate",
            );
          observed.add(result.id);
          const facts = options.facts(result, context);
          if (
            actual(facts.hasProgress) !== true ||
            actual(facts.command) !== rows.get(result.id)
          )
            throw new Error(
              "Lifecycle facts disagree with actual created progress",
            );
          return facts;
        },
        registry: {
          list: (event) => options.registry.list(event),
          close: async () => {},
          async run(hookInput, runOptions) {
            if (!options.registry.prepareDispatch)
              throw new Error(
                "Native lifecycle registry lacks prepared dispatch",
              );
            const plan = await options.registry.prepareDispatch(hookInput, {
              ...runOptions,
              preparedSelection: "bound-final",
            });
            let iterator:
              ReturnType<typeof nativeHookProgressDispatch> | undefined;
            let failure: unknown;
            try {
              if (!plan.selection)
                throw new Error(
                  "Native lifecycle registry lacks final execution proof",
                );
              const facts = options.finalDispatch(structuredClone(hookInput), {
                selection: plan.selection,
                candidates: plan.candidates,
              });
              // Capture all facts before invoking any identity/display host or awaiting a consumer.
              const savedFacts = snapshotNativeResponseJson(facts);
              if (!isNativeObject(savedFacts))
                throw new NativeLifecycleCaptureError(
                  new Error("Invalid native final dispatch facts"),
                );
              const admitted = structuredClone(facts);
              if (
                admitted.admission.status === "admitted" &&
                (admitted.origins.status !== "known" ||
                  admitted.defaultShell.status !== "known" ||
                  admitted.personalConfigRestricted.status !== "known" ||
                  admitted.personalConfigRestricted.value ||
                  admitted.origins.value.some(
                    (entry) => entry.nativeOrigin.namespace === "goal",
                  ))
              ) {
                await prefix.unsupported(
                  [
                    "Actual native origin/default-shell/restricted/goal dispatch requires its source adapter",
                  ],
                  savedFacts,
                );
                return emptyExecution();
              }
              if (admitted.admission.status === "admitted") {
                const origins = actual(admitted.origins),
                  defaultShell = actual(admitted.defaultShell);
                if (
                  origins.length !== plan.candidates.length ||
                  new Set(origins.map((v) => v.id)).size !== origins.length
                )
                  throw new Error(
                    "Native final origins do not cover actual candidates",
                  );
                const candidates = plan.candidates.map((candidate) => {
                  const origin = origins.find((v) => v.id === candidate.id);
                  if (!origin)
                    throw new Error(
                      "Native final candidate has no actual origin",
                    );
                  return {
                    ...candidate,
                    backendId: "bound-plan",
                    nativeOrigin: origin.nativeOrigin,
                  };
                });
                const reduced = reduceMatchedOrdinaryCommandHooks(candidates, {
                  defaultShell,
                  personalConfigRestricted: actual(
                    admitted.personalConfigRestricted,
                  ),
                });
                if (
                  reduced.length !== candidates.length ||
                  reduced.some((entry, i) => entry.id !== candidates[i]?.id)
                )
                  throw new Error(
                    "Bound port selection differs from actual native command reduction",
                  );
              }
              if (
                hookInput.hook_event_name !== "SessionStart" &&
                hookInput.hook_event_name !== "Stop" &&
                hookInput.hook_event_name !== "UserPromptSubmit"
              )
                throw new Error("Wrong native lifecycle event");
              iterator = nativeHookProgressDispatch(
                {
                  event: hookInput.hook_event_name,
                  dispatchToolUseID: admitted.dispatchToolUseID,
                  admission: admitted.admission,
                  ...(admitted.matchQuery === undefined
                    ? {}
                    : { matchQuery: admitted.matchQuery }),
                  candidates: plan.candidates.map((v) => {
                    const hook = snapshotNativeResponseJson(v.hook);
                    if (!isNativeObject(hook))
                      throw new Error("Invalid declared command hook");
                    return { id: v.id, hook };
                  }),
                },
                options.progressHost,
                signal,
              );
              let index = 0;
              for (;;) {
                const next = await iterator.next();
                if (next.done) {
                  if (next.value?.status === "unsupported") {
                    await prefix.unsupported(
                      next.value.reasons,
                      next.value.facts,
                    );
                    return emptyExecution();
                  }
                  if (next.value?.status !== "drained") return emptyExecution();
                  break;
                }
                const candidate = plan.candidates[index++];
                if (!candidate)
                  throw new Error("Progress prefix exceeds final candidates");
                rows.set(candidate.id, next.value.data.command);
                if (!(await prefix.progress(next.value)))
                  return emptyExecution(true);
              }
              return await plan.runSelected(
                new Set(plan.candidates.map((v) => v.id)),
              );
            } catch (error) {
              failure = error;
              if (error instanceof NativeLifecycleCaptureError) throw error;
              throw new NativeLifecycleCaptureError(error);
            } finally {
              await closePrepared(plan, iterator, failure);
            }
          },
        },
      });
      return adapter.run(input, signal, onResult);
    },
  };
}
function emptyExecution(
  cancelled = false,
): import("./hooks.js").HookBatchResult {
  return {
    results: [],
    background: [],
    additionalContext: [],
    systemMessages: [],
    blockingErrors: [],
    preventContinuation: false,
    cancelled,
    watchPaths: [],
    reloadSkills: false,
  };
}

async function closePrepared(
  plan: PreparedHookDispatch,
  iterator: ReturnType<typeof nativeHookProgressDispatch> | undefined,
  failure: unknown,
): Promise<void> {
  const settled = await Promise.allSettled([
    iterator?.return(undefined),
    plan.close(),
  ]);
  const errors = settled.flatMap((value): unknown[] =>
    value.status === "rejected" ? [value.reason] : [],
  );
  if (errors.length)
    throw new NativeLifecycleCaptureError(
      new AggregateError(
        failure === undefined ? errors : [failure, ...errors],
        "Native prepared dispatch cleanup failed",
      ),
    );
}
