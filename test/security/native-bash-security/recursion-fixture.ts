import { AsyncLocalStorage } from "node:async_hooks";
import { createNativeBashCommandPreparation } from "../../../src/native-bash-command-preparation.js";
import {
  createNativeBashSecurityPolicyControl,
  type NativeBashSecurityPolicyHost,
} from "../../../src/native-bash-security/policy-control.js";
import { createNativeBashSecurityObservations } from "../../../src/native-bash-security/security-observations.js";
import { createNativeBashInlineScript } from "../../../src/native-bash-security/inline-script.js";
import { createNativeBashSecurityOutcomeControl } from "../../../src/native-bash-security/outcome-control.js";
import { createNativeBashSecurityRemovalShapes } from "../../../src/native-bash-security/removal-shapes.js";
import { createNativeBashSecurityRecursiveSyntax } from "../../../src/native-bash-security/recursive-syntax.js";
import { createNativeBashSecurityInlineRecursion } from "../../../src/native-bash-security/inline-recursion.js";
import type {
  NativeBashSecurityContext as Context,
  NativeBashSecurityInlineContext as InlineContext,
  NativeBashSecurityRecursiveCheck as Check,
  NativeBashSecurityRemovalHistory as History,
} from "../../../src/native-bash-security/security-recursion-types.js";
import { fixture, known, policy } from "./security-fixture.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityScope as Scope,
} from "../../../src/native-bash-security/security-types.js";

export function removal(): Decision {
  return {
    behavior: "ask",
    message: "Dangerous __INLINE_SHELL_VALUE__ target",
    decisionReason: {
      type: "safetyCheck",
      reason: "Dangerous __INLINE_SHELL_VALUE__ target",
      classifierApprovable: false,
      circuitBreaker: "dangerousRemoval",
      removalRule: "literalTarget",
    },
    suggestions: [],
  };
}
export function createRecursionFixture(
  checker: Check,
  platform: "macos" | "linux" | "windows" = "macos",
) {
  const f = fixture();
  const prep = createNativeBashCommandPreparation(
    f.semantic.parser,
    {},
    f.semantic.features,
  );
  const host: NativeBashSecurityPolicyHost = {
    ...f.host,
    platform,
    feature: (_key, _default, s) =>
      known({ value: true, source: "authored-test" }, s),
    spawnEnvironmentOwner: (s) =>
      known({ spawnEnvKeys: (keys, scope) => known(keys, scope) }, s),
  };
  const control = createNativeBashSecurityPolicyControl(f.semantic, prep, host);
  const observations = createNativeBashSecurityObservations(control);
  const inline = createNativeBashInlineScript(
    f.semantic,
    prep,
    control.pathOwner,
  );
  const outcomes = createNativeBashSecurityOutcomeControl(control.native.El);
  const events: string[] = [];
  const shapes = createNativeBashSecurityRemovalShapes(
    observations,
    inline,
    outcomes,
    {
      strictInlineShellRemovalDisabled: (s) => known(false, s),
      paleKestrel: (s) => known(true, s),
      removalShapeEvent: (shape, s) => {
        events.push(shape);
        return known(undefined, s);
      },
    },
  );
  const syntax = createNativeBashSecurityRecursiveSyntax(control, {
    wildOctopus: (s) => known(true, s),
  });
  const cwdScope = new AsyncLocalStorage<string>();
  const cwdTransitions: string[] = [];
  let disabled = false;
  const recurse = createNativeBashSecurityInlineRecursion(
    syntax,
    shapes,
    {
      currentCwd: (s) => known(cwdScope.getStore() ?? "/work", s),
      livePolicy: (_context, s) => known(policy(), s),
      inlineShellRemovalDisabled: (s) => known(disabled, s),
      withCwd<T>(cwd: string, run: () => T, s: Scope) {
        cwdTransitions.push(cwd);
        return known(cwdScope.run(cwd, run), s);
      },
    },
    checker,
  );
  function context(command: string): InlineContext {
    const context: Context = {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
    };
    return {
      input: { command },
      context,
      depth: 0,
      divergentShapes: undefined,
      declarationPrefix: undefined,
      budget: {
        left: 32,
        chars: 20000,
        judged: new Map(),
        asked: new Map(),
        command,
        rereading: false,
      },
    };
  }
  async function run(
    command: string,
    state = context(command),
    history: History[] = [],
  ) {
    return recurse.withPolicyScope(policy(), "/work", () =>
      recurse.native.JOe(command, state, history),
    ).result;
  }
  return {
    ...f,
    policyHost: host,
    recurse,
    observations,
    inline,
    syntax,
    shapes,
    events,
    context,
    run,
    cwdTransitions,
    currentCwd: () => cwdScope.getStore() ?? "/work",
    setDisabled(value: boolean) {
      disabled = value;
    },
  };
}
