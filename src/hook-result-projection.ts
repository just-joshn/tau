import type { HookResult } from "./hooks.js";

/** One actual result object has one public identity in each owning registry. */
export function createHookResultProjection(identity: (id: string) => string) {
  const results = new WeakMap<HookResult, HookResult>();
  const project = (source: HookResult): HookResult => {
    let result = results.get(source);
    if (!result) {
      result = { ...source, id: identity(source.id) };
      results.set(source, result);
    }
    return result;
  };
  return {
    project,
    observe(
      this: void,
      source: HookResult,
      listener: (result: HookResult) => void | Promise<void>,
    ): void | Promise<void> {
      const result = project(source),
        ownedIdentity = result.id;
      const reconcile = () => {
        if (result.id !== ownedIdentity)
          throw new Error("Hook result observer changed its owning identity");
        // Existing observers may update/delete body fields before phase reduction.
        // Preserve that behavior across a namespace without changing the inner ID
        // or invoking an accessor newly installed by an observer.
        for (const key of Reflect.ownKeys(source))
          if (key !== "id" && !Object.hasOwn(result, key))
            Reflect.deleteProperty(source, key);
        for (const key of Reflect.ownKeys(result)) {
          if (key === "id") continue;
          const descriptor = Object.getOwnPropertyDescriptor(result, key);
          if (descriptor) Object.defineProperty(source, key, descriptor);
        }
      };
      const failed = (error: unknown): never => {
        try {
          reconcile();
        } catch (reconciliation) {
          throw new AggregateError(
            [error, reconciliation],
            "Hook observation and owning result projection failed",
          );
        }
        throw error;
      };
      let completed: void | Promise<void>;
      try {
        // Call at actual settlement; an async sink must not defer its first stamp.
        completed = listener(result);
      } catch (error) {
        return failed(error);
      }
      // Await an owned asynchronous observer even if its eventual body is invalid.
      // The inner registry reduces fields only after this observation settles.
      if (completed) return Promise.resolve(completed).then(reconcile, failed);
      reconcile();
    },
  };
}
