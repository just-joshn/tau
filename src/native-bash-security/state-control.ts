import { AsyncLocalStorage } from "node:async_hooks";
import type { createNativeBashComplexityControl } from "./complexity-control.js";
import type { NativeBashSecurityContext as Context } from "./security-recursion-types.js";
import { nativeBashRemovalReviewConfig } from "./security-recursion-types.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityInput as Input,
  type NativeBashSecurityRule as Rule,
} from "./security-types.js";
type Safety = Extract<Reason, { type: "safetyCheck" }>;
export interface NativeBashRemovalWaiverState {
  removalWaiverRulesClear?: boolean | undefined;
  settingsChangesUnfinished?: number | undefined;
  managedSourcesReadErrorLogged?: boolean | undefined;
}
export interface NativeBashStateControlHost {
  livePolicy?: (context: Context, scope: Scope) => Fact<Policy>;
  interactiveLaunch?: (scope: Scope) => Fact<boolean>;
  autoModeActive?: (scope: Scope) => Fact<boolean>;
  evenMoreDangerouslySkipPermissions?: (scope: Scope) => Fact<boolean>;
  childSession?: (scope: Scope) => Fact<boolean>;
  waiverState?: (scope: Scope) => Fact<NativeBashRemovalWaiverState>;
  allAskRules?: (policy: Policy, scope: Scope) => Fact<readonly Rule[]>;
  allDenyRules?: (policy: Policy, scope: Scope) => Fact<readonly Rule[]>;
  /** Actual nh with source proxy/glob/toolAliases metadata for these named registered tools. */
  targetsNamedTool?: (
    policy: Policy,
    tool: "Bash" | "Edit" | "Read",
    rule: Rule,
    scope: Scope,
  ) => Fact<boolean>;
  managedSourceReadable?: (
    source: "remote" | "helper" | "plist" | "hklm" | "hkcu" | "file" | "parent",
    scope: Scope,
  ) => Fact<boolean>;
  reportError?: (error: unknown, scope: Scope) => Fact<void>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing native state scope");
  return value;
}
export function createNativeBashStateControl(
  complexity: ReturnType<typeof createNativeBashComplexityControl>,
  host: NativeBashStateControlHost,
) {
  const { nested } = complexity;
  const { recursion } = nested;
  const { syntax, shapes } = recursion;
  const { policy } = syntax;
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const ee = (context: Context) => {
    const value = use(
      need(host.livePolicy, "policy.live")(context, frame().scope),
    );
    frame().scope = { ...frame().scope, policyId: value.scope.policyId };
    return value;
  };
  const ge = () =>
    !use(need(host.interactiveLaunch, "launch.interactive")(frame().scope));
  const ru = () =>
    use(need(host.autoModeActive, "mode.autoActive")(frame().scope));
  const Ir = () =>
    use(need(host.waiverState, "state.removalWaiverOwner")(frame().scope));
  const s = {
    get CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS() {
      return use(
        need(
          host.evenMoreDangerouslySkipPermissions,
          "environment.evenMoreDangerouslySkipPermissions",
        )(frame().scope),
      );
    },
    get CLAUDE_CODE_CHILD_SESSION() {
      return use(
        need(host.childSession, "environment.childSession")(frame().scope),
      );
    },
  };
  const i = (error: unknown) => {
    use(need(host.reportError, "errors.report")(error, frame().scope));
  };
  const managedSources = [
    "remote",
    "helper",
    "plist",
    "hklm",
    "hkcu",
    "file",
    "parent",
  ] satisfies readonly (
    "remote" | "helper" | "plist" | "hklm" | "hkcu" | "file" | "parent"
  )[];
  const na = (permission: Policy) =>
    use(need(host.allDenyRules, "rules.allDeny")(permission, frame().scope));
  const jd = (permission: Policy) =>
    use(need(host.allAskRules, "rules.allAsk")(permission, frame().scope));
  const nh = (
    permission: Policy,
    tool: { name: "Bash" | "Edit" | "Read" },
    rule: Rule,
  ) =>
    use(
      need(host.targetsNamedTool, "rules.targetsNamedTool")(
        permission,
        tool.name,
        rule,
        frame().scope,
      ),
    );
  const Ce = "Bash",
    lt = "Edit",
    We = "Read";
  const F6e: string[] = ["toolsNarrowing", "command"];
  const { Sa, bk, bF, nS, eIe, wU, VS } = shapes.outcomes;
  const { El } = policy.native;
  const Aun = (input: Input, permission: Policy) =>
    policy.withPolicyScope(
      permission,
      frame().scope.cwd,
      () => policy.native.Aun(input, permission),
      frame().receipts,
    ).result;
  const { Vh, lM, bQ } = policy.native;
  const { WOr } = shapes.native;
  const iM = () => {
    const receipt = use(
      need(
        nested.host.removalReviewFeature,
        "features.removalReview",
      )(frame().scope),
    );
    return nativeBashRemovalReviewConfig(
      receipt,
      use(
        need(
          nested.host.dangerousRemovalTimeoutDisabled,
          "environment.dangerousRemovalTimeoutDisabled",
        )(frame().scope),
      ),
    );
  };
  const Ks = { name: "Bash" };
  const eIr = new Set([Ce, lt, We]);
  const phe = (reason: Safety) => reason.circuitBreaker === "dangerousRemoval";
  const gio = (reason: Safety) =>
    [
      ...(reason.circuitBreaker !== undefined ? [reason.circuitBreaker] : []),
      ...(reason.also ?? []),
    ].some((key) =>
      new Set([
        "isolatePeerMachines",
        "restrictedMode",
        "outsideReadsBlocked",
        "connectorFileSend",
        "unfinishedCheck",
      ]).has(key),
    );
  function IQn(
    reason: {
      classifierApprovable?: boolean;
      circuitBreaker?: string;
      also?: string[];
    },
    restricted: boolean,
  ): {
    classifierApprovable?: boolean | undefined;
    circuitBreaker?: string;
    also?: string[];
  } {
    if (!restricted)
      return {
        classifierApprovable: reason.classifierApprovable,
        ...(reason.circuitBreaker
          ? { circuitBreaker: reason.circuitBreaker }
          : {}),
        ...(reason.also ? { also: reason.also } : {}),
      };
    const also = [
      ...(reason.circuitBreaker ? [reason.circuitBreaker] : []),
      ...(reason.also ?? []),
    ];
    return {
      classifierApprovable: false,
      circuitBreaker: "restrictedMode",
      ...(also.length > 0 ? { also } : {}),
    };
  }
  function L$(e: string, n: boolean | undefined): boolean {
    return e === "plan" && n === !0 && !ge();
  }

  function fxe(e: Policy): boolean {
    return (
      e.mode === "auto" ||
      (e.mode === "plan" &&
        e.servedCall !== !0 &&
        ru() &&
        !e.isBypassPermissionsModeAvailable)
    );
  }

  function Zl(e: Policy): boolean {
    return (
      e.blockReadsOutsideWorkingDirectories === !0 ||
      [...na(e), ...jd(e)].some(
        (n) =>
          !(F6e.includes(n.source) && n.ruleValue.ruleContent === void 0) &&
          ([Ce, lt, We] satisfies ("Bash" | "Edit" | "Read")[]).some((r) =>
            nh(e, { name: r }, n),
          ),
      )
    );
  }

  function AQn(e: Policy): void {
    if (s.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS && Zl(e))
      Ir().removalWaiverRulesClear = !1;
  }

  function Xl(): boolean {
    try {
      return managedSources.every((source) =>
        use(
          need(host.managedSourceReadable, "managed.readable")(
            source,
            frame().scope,
          ),
        ),
      );
    } catch (e) {
      if (e instanceof NativeBashSecurityUnsupported) throw e;
      let n = Ir();
      if (n.managedSourcesReadErrorLogged !== !0) {
        n.managedSourcesReadErrorLogged = true;
        i(e);
      }
      return !1;
    }
  }

  function gVo(e: Policy): boolean {
    if (
      !s.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS ||
      s.CLAUDE_CODE_CHILD_SESSION
    )
      return !1;
    AQn(e);
    let n = Ir();
    return (
      n.removalWaiverRulesClear === !0 &&
      (n.settingsChangesUnfinished ?? 0) === 0 &&
      Xl()
    );
  }

  function edt(e: Context): boolean {
    let { mode: n, isBypassPermissionsModeAvailable: r } = ee(e);
    return (
      n === "bypassPermissions" || (L$(n, r) && e.forRemoteExecution !== !0)
    );
  }

  function Zde(e: Decision, n: Context): boolean {
    let r = ee(n);
    return (
      e.behavior === "ask" &&
      !bk(e) &&
      Sa(e.decisionReason, phe) !== void 0 &&
      (fxe(r) || (r.mode === "bypassPermissions" && !gVo(r))) &&
      iM().enabled
    );
  }

  function Ubn(e: Decision, n: Decision, r: Context): boolean {
    let a = nS(e) - nS(n);
    return (
      a > 0 ||
      (a === 0 &&
        !Zde(n, r) &&
        (Zde(e, r) || (!(n.behavior === "ask" && bk(n)) && eIe(e) > eIe(n))))
    );
  }

  function Qlt(e: Decision, n: Context): Decision {
    if (
      e.behavior === "ask" &&
      (Zde(e, n) || Sa(e.decisionReason, (a) => gio(a) && !bF(a)) !== void 0)
    )
      return e;
    let r =
      "The permission check for this command did not finish, so its safety checks did not run.";
    return wU(
      {
        behavior: "ask",
        message: r,
        decisionReason: {
          type: "safetyCheck",
          reason: r,
          ...IQn(
            { classifierApprovable: !1, circuitBreaker: "unfinishedCheck" },
            ee(n).restricted,
          ),
        },
        suggestions: [],
        suppressAlwaysAllowRule: !0,
        checkIncomplete: !0,
      },
      e,
    );
  }

  function ZOr(e: Decision, n: Context): Decision {
    if (e.behavior === "deny") return e;
    let r = ee(n);
    if (
      na(r).some(
        (a) =>
          eIr.has(a.ruleValue.toolName) && a.ruleValue.ruleContent !== void 0,
      )
    )
      return {
        behavior: "deny",
        message:
          "This command holds more text than the permission check reads, so it could not be checked against your deny rules. Use shorter values, or put the long text in a file.",
        decisionReason: {
          type: "other",
          reason:
            "This command holds more text than the permission check reads, so it could not be checked against your deny rules. Use shorter values, or put the long text in a file.",
        },
      };
    return e.behavior === "ask" &&
      !edt(n) &&
      !fxe(r) &&
      Sa(e.decisionReason, (a) => a.circuitBreaker === "dangerousRemoval") !==
        void 0
      ? e
      : Qlt(e, n);
  }

  function Hbn(e: Input, n: Context): boolean {
    let { behavior: r, decisionReason: a } = Aun(e, ee(n));
    return (
      r === "allow" &&
      a?.type === "rule" &&
      a.rule.ruleValue.ruleContent === e.command.trim()
    );
  }

  function Bbn(e: string): Decision {
    let n: Reason = { type: "other", reason: e, bashMissKind: "too-complex" };
    return {
      behavior: "ask",
      decisionReason: n,
      message: El(Ks.name, n),
      suggestions: [],
    };
  }

  function Ilt(e: Decision): boolean {
    return e.behavior === "passthrough" || (e.behavior === "ask" && VS(e));
  }

  function rbn(e: Decision, n: Decision, r: string): Decision {
    if (e.behavior === "deny") return e;
    if (n.behavior === "deny") return n;
    if (n.behavior === "ask" && !VS(n)) return { ...n, suggestions: [] };
    if (e.behavior === "allow" && n.behavior !== "allow") return Bbn(r);
    return e;
  }

  function Plt(e: Decision, n: Input, r: Policy): Decision {
    if (e.behavior !== "ask") return e;
    let a = e.decisionReason;
    if (
      a?.type !== "other" ||
      a.bashMissKind === void 0 ||
      WOr(e) === undefined
    )
      return e;
    if (r.blockReadsOutsideWorkingDirectories === !0 && !(Vh(n) && lM(r)))
      return bQ(a.reason);
    return e;
  }

  return {
    complexity,
    host,
    native: {
      L$,
      fxe,
      Zl,
      AQn,
      Xl,
      gVo,
      edt,
      Zde,
      Ubn,
      Qlt,
      ZOr,
      Hbn,
      Bbn,
      Ilt,
      rbn,
      Plt,
    },
    withPolicyScope<T>(
      permission: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: permission.scope.policyId, cwd }, receipts },
        () => complexity.withPolicyScope(permission, cwd, run, receipts),
      );
    },
  };
}
