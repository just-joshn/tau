import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityReason as Reason,
} from "./security-types.js";
type SafetyReason = Extract<Reason, { type: "safetyCheck" }>;
export function createNativeBashSecurityOutcomeControl(
  El: (tool: string, reason?: Reason) => string,
) {
  const Ks = { name: "Bash" };
  const Abn = " (removal)";
  const iPe = "Read-only command is allowed";
  const bypassImmune = new Set([
    "dangerousRemoval",
    "isolatePeerMachines",
    "restrictedMode",
    "outsideReadsBlocked",
    "connectorFileSend",
    "unfinishedCheck",
  ]);
  const classifierRouted = new Set([
    "dangerousRemoval",
    "backgroundOperator",
    "suspiciousWindowsPath",
  ]);
  const Az = (reason: SafetyReason) =>
    [
      ...(reason.circuitBreaker !== undefined ? [reason.circuitBreaker] : []),
      ...(reason.also ?? []),
    ].some((key) => bypassImmune.has(key));
  const bF = (reason: SafetyReason) =>
    reason.circuitBreaker !== undefined &&
    classifierRouted.has(reason.circuitBreaker);
  const D = <T>(a: readonly T[]) => [...new Set(a)];
  function Sa(
    e: Reason | undefined,
    n: (reason: SafetyReason) => boolean = () => true,
  ): SafetyReason | undefined {
    if (!e) return;
    if (e.type === "safetyCheck") return n(e) ? e : void 0;
    if (e.type === "subcommandResults")
      for (let r of e.reasons.values()) {
        let a = Sa(r.decisionReason, n);
        if (a) return a;
      }
    return;
  }

  function t6t(e: Reason | undefined): boolean {
    if (e?.type === "rule" && e.rule.ruleBehavior === "ask") return !0;
    if (e?.type === "subcommandResults") {
      for (let n of e.reasons.values())
        if (n.behavior === "ask" && t6t(n.decisionReason)) return !0;
    }
    return !1;
  }

  function bk(e: Decision): boolean {
    return t6t(e.decisionReason) || e.matchedAskRule?.ruleBehavior === "ask";
  }

  function OEt(e: Reason | undefined): boolean {
    if (e?.type === "rule") return !0;
    if (e?.type === "subcommandResults")
      return [...e.reasons.values()].every((n) => OEt(n.decisionReason));
    return !1;
  }

  function VS(e: Decision): boolean {
    if (e.behavior !== "ask" || bk(e)) return !1;
    let n = e.decisionReason;
    if (n === void 0 || n.type === "other") return !0;
    return (
      n.type === "subcommandResults" &&
      [...n.reasons.values()].every(
        (r) => r.behavior === "allow" || r.behavior === "passthrough" || VS(r),
      )
    );
  }

  function nS(e: Decision): number {
    switch (e.behavior) {
      case "allow":
        return OEt(e.decisionReason) ? 0 : 1;
      case "passthrough":
        return 2;
      case "ask":
        if (VS(e)) return 3;
        return bk(e) || Sa(e.decisionReason, Az) !== void 0 ? 5 : 4;
      case "deny":
        return 6;
    }
  }

  function eIe(e: Decision): number {
    if (Sa(e.decisionReason, (n) => Az(n) && !bF(n)) !== void 0) return 2;
    return Sa(e.decisionReason, Az) !== void 0 ? 1 : 0;
  }

  function YOe(
    e: readonly (readonly [string, Decision])[],
  ): Map<string, Decision> {
    let n = new Map<string, Decision>();
    for (let [r, a] of e) {
      let h = r;
      for (let y = 2; n.has(h); y++) h = `${r} #${y}`;
      n.set(h, a);
    }
    return n;
  }

  function qOr(e: Decision, n: Decision): Decision {
    switch (e.behavior) {
      case "deny":
        return e;
      case "ask":
        return VS(e) && VS(n) ? n : e;
      case "allow":
      case "passthrough":
        if (nS(n) <= nS(e)) return e;
        if (n.behavior === "ask" && VS(n))
          return {
            behavior: "passthrough",
            message: n.message,
            ...(n.decisionReason !== void 0 && {
              decisionReason: n.decisionReason,
            }),
            ...(n.suggestions !== void 0 && { suggestions: n.suggestions }),
            ...(n.blockedPath !== void 0 && { blockedPath: n.blockedPath }),
          };
        return n;
    }
  }

  function IOr(e: Decision, n: Decision[], r: boolean, a: boolean): Decision {
    let h = [e, ...n].find((E) => E.behavior === "deny");
    if (h !== void 0) return h;
    if (!a && e.behavior === "ask" && !VS(e)) return e;
    let y = e;
    for (let E of n) if (nS(E) > nS(y)) y = E;
    if (r || y.behavior === "ask") return y;
    let k: Reason = {
      type: "other",
      reason:
        "Variables set in front of a declaration in this command can't all be checked before it runs",
      bashMissKind: "too-complex",
    };
    return {
      behavior: "ask",
      decisionReason: k,
      message: El(Ks.name, k),
      suggestions: [],
    };
  }

  function Ywn(e: Decision, n: Decision, r: boolean): Decision {
    return (e.behavior === "deny" ||
      (r && e.behavior === "ask" && !e.bashAllowRuleOverridable)) &&
      nS(e) > nS(n)
      ? e
      : n;
  }

  function A8(e: string, n: Decision, r: Decision): Decision {
    return {
      ...n,
      decisionReason: {
        type: "subcommandResults",
        reasons: new Map([
          [e, n],
          [`${e}${Abn}`, r],
        ]),
      },
    };
  }

  function wU(e: Decision, n: Decision | undefined): Decision {
    let r = e.decisionReason,
      a = n?.decisionReason;
    if (r?.type !== "safetyCheck" || a?.type !== "safetyCheck") return e;
    let h = D([
      ...(r.also ?? []),
      ...(a.circuitBreaker !== void 0 ? [a.circuitBreaker] : []),
      ...(a.also ?? []),
    ]).filter((y) => y !== r.circuitBreaker);
    return h.length === 0 ? e : { ...e, decisionReason: { ...r, also: h } };
  }

  function gbn(e: Reason | undefined): boolean {
    switch (e?.type) {
      case "subcommandResults":
        return [...e.reasons.values()].some((n) => gbn(n.decisionReason));
      case "other":
        return e.reason === iPe;
      case "rule":
      case "mode":
      case "classifier":
      case "hook":
      case "permissionPromptTool":
      case "asyncAgent":
      case "sandboxOverride":
      case "workingDir":
      case "safetyCheck":
      case void 0:
        return !1;
    }
  }

  return {
    Sa,
    t6t,
    bk,
    OEt,
    VS,
    nS,
    eIe,
    YOe,
    qOr,
    IOr,
    Ywn,
    A8,
    wU,
    gbn,
    Az,
    bF,
  };
}
