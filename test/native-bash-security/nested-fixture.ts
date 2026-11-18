import { createRecursionFixture } from "./recursion-fixture.js";
import { createNativeBashLiteralRemoval } from "../../src/native-bash-security/literal-removal.js";
import {
  createNativeBashSecurityNestedRemoval,
  type NativeBashSecurityNestedRemovalHost,
} from "../../src/native-bash-security/nested-removal.js";
import { policy, known } from "./security-fixture.js";

export function createNestedFixture(captureRemoval = false) {
  const f = createRecursionFixture(async (input) => ({
    behavior: "allow",
    updatedInput: input,
  }));
  const literal = createNativeBashLiteralRemoval(
    f.semantic,
    f.syntax.preparation,
    f.syntax.policy.pathOwner,
  );
  const removalCalls: { name: string; args: string[] }[] = [];
  if (captureRemoval)
    f.syntax.policy.pathOwner.native.o2 = (name, args) => {
      removalCalls.push({ name, args });
      return { behavior: "passthrough" };
    };
  const reads: string[] = [];
  const errors: unknown[] = [];
  const environment = new Map<
    string,
    { kind: "string"; empty: boolean } | { kind: "absent" }
  >();
  const exports = new Set<string>();
  const host: NativeBashSecurityNestedRemovalHost = {
    processEnvironment: (name, s) => {
      reads.push(`env:${name}`);
      return known(environment.get(name) ?? { kind: "absent" }, s);
    },
    shellExportHasOwn: (name, s) => {
      reads.push(`export:${name}`);
      return known(exports.has(name), s);
    },
    removalReviewFeature: (s) =>
      known({ value: undefined, source: "default" }, s),
    dangerousRemovalTimeoutDisabled: (s) => known(false, s),
    substitutionRemovalDisabled: (s) => known(false, s),
    iridescentBoot: (s) => known({ value: true, source: "default" }, s),
    tooComplexTelemetry: (_kind, s) => known(undefined, s),
    isAbortError: (_error, s) => known(false, s),
    reportError: (error, s) => {
      errors.push(error);
      return known(undefined, s);
    },
  };
  const nested = createNativeBashSecurityNestedRemoval(
    f.recurse,
    literal,
    host,
    async (input) => ({ behavior: "allow", updatedInput: input }),
  );
  const run = <T>(callback: () => T) =>
    nested.withPolicyScope(policy(), "/work", callback).result;
  async function scan(command: string, forceUnset = false, safeCatch = true) {
    const tree = await f.semantic.parse(command);
    if (tree === null || tree === f.semantic.parseAbort)
      throw new Error("Expected authored syntax tree");
    const state = f.context(command);
    return run(() =>
      (safeCatch ? nested.native.Pbn : nested.native.OOr)(
        tree,
        "/work",
        policy(),
        undefined,
        forceUnset,
        state,
        state.context,
      ),
    );
  }
  return {
    ...f,
    nested,
    host,
    removalCalls,
    environment,
    exports,
    reads,
    errors,
    run,
    scan,
  };
}
