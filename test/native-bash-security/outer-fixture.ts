import { createMainFixture } from "./main-fixture.js";
import { createNativeBashCwdAlternates } from "../../src/native-bash-security/cwd-alternates.js";
import { createNativeBashOuterPrimitives } from "../../src/native-bash-security/outer-primitives.js";
import {
  createNativeBashOuterControl,
  type NativeBashOuterHost,
} from "../../src/native-bash-security/outer-control.js";
import type { NativeBashSecurityContext as Context } from "../../src/native-bash-security/security-recursion-types.js";
import { known, policy } from "./security-fixture.js";
import type {
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityInput as Input,
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityProvenance as Provenance,
} from "../../src/native-bash-security/security-types.js";

/** Authored facts for algorithm tests; these do not supply a production capability. */
export function createOuterFixture() {
  const f = createMainFixture();
  const events: {
    event: string;
    metadata: Readonly<Record<string, string | number | boolean | undefined>>;
  }[] = [];
  const errors: unknown[] = [];
  let current = policy();
  const live = (context: Context) =>
    context.getAppState?.().toolPermissionContext ?? current;
  f.stateHost.livePolicy = (context, s) => known(live(context), s);
  const readLive = f.stateHost.livePolicy;
  const alternates = createNativeBashCwdAlternates(f.main, {
    wittyDove: (s) => known(true, s),
    immutableToucan: (s) => known(true, s),
  });
  const primitives = createNativeBashOuterPrimitives(f.main, {
    livePolicy: readLive,
    networkClassifierEnabled: (s) => known(true, s),
  });
  const host: NativeBashOuterHost = {
    livePolicy: readLive,
    currentCwd: (s) => known(s.cwd, s),
    safeFeature: (_key, _safe, s) => known(true, s),
    glimmeringGlacier: (_fallback, s) => known(true, s),
    servedValuesChangeCount: (s) => known(0, s),
    exportedVariablePromptDisabled: (s) => known("absent", s),
    replBridgeActive: (s) => known(false, s),
    backgroundMode: (s) => known(undefined, s),
    teammateAgentId: (s) => known(undefined, s),
    telemetry: (event, metadata, s) => {
      events.push({ event, metadata });
      return known(undefined, s);
    },
    reportError: (error, s) => {
      errors.push(error);
      return known(undefined, s);
    },
    isAbortError: (error, s) =>
      known(error instanceof Error && error.name === "AbortError", s),
  };
  const outer = createNativeBashOuterControl(primitives, alternates, host);
  function context(): Context {
    return {
      ...f.context("").context,
      getAppState: () => ({ toolPermissionContext: current }),
    };
  }
  function run(
    stage: keyof typeof outer.native,
    input: Input,
    ctx: Context = context(),
    transform?: (decision: Decision) => Decision | undefined,
  ) {
    const receipts: Provenance[] = [];
    const value = outer.withPolicyScope(
      current,
      "/work",
      () => {
        if (stage === "Qde" || stage === "iIr")
          return outer.native[stage](input, ctx);
        if (stage === "Zwn")
          return outer.native.Zwn({ behavior: "ask" }, input, current);
        if (stage === "obn")
          throw new Error("Use outerRun for synchronous observation keys");
        return outer.native[stage](input, ctx, undefined, transform);
      },
      receipts,
    );
    return { result: value.result, receipts };
  }
  const outerRun = <T>(run: () => T) =>
    outer.withPolicyScope(current, "/work", run).result;
  return {
    ...f,
    outer,
    primitives,
    alternates,
    outerHost: host,
    events,
    outerErrors: errors,
    outerContext: context,
    outerRun,
    stage: run,
    setOuterPolicy(value: Policy) {
      current = value;
      f.setPolicy(value);
    },
  };
}
