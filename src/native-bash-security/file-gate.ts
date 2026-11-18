import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type { NativeBashSemantics } from "../native-bash-semantics.js";
import {
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityScope,
  type NativeBashSecurityProvenance,
  type NativeBashSecurityFileHost,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityFileOperation as Operation,
  type NativeBashSecurityInspection as Inspection,
  type NativeBashSecurityReason as Reason,
  type NativeBashSecurityDecision as Decision,
  type NativeBashSecuritySentence as Sentence,
  type NativeBashSecurityFileVerdict as FileVerdict,
  type NativeBashSecurityResolvedFileVerdict as ResolvedFileVerdict,
} from "./security-types.js";
type SafetyReason = Extract<Reason, { type: "safetyCheck" }>;
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing native file-gate invariant");
  return value;
}
const circuitFacts: Readonly<Record<string, { hostPersonOnly: boolean }>> = {
  dangerousRemoval: { hostPersonOnly: false },
  backgroundOperator: { hostPersonOnly: false },
  suspiciousWindowsPath: { hostPersonOnly: false },
  isolatePeerMachines: { hostPersonOnly: false },
  restrictedMode: { hostPersonOnly: false },
  outsideReadsBlocked: { hostPersonOnly: false },
  claudeSettingsFile: { hostPersonOnly: true },
  internalHardDeny: { hostPersonOnly: false },
  connectorFileSend: { hostPersonOnly: false },
  unfinishedCheck: { hostPersonOnly: true },
};
function KW(reason: SafetyReason): boolean {
  return [
    ...(reason.circuitBreaker !== undefined ? [reason.circuitBreaker] : []),
    ...(reason.also ?? []),
  ].some((key) => circuitFacts[key]?.hostPersonOnly === true);
}
export function createNativeBashSecurityFileGate(
  semantic: NativeBashSemantics,
  host: NativeBashSecurityFileHost,
  receipts:
    NativeBashSecurityProvenance[] | (() => NativeBashSecurityProvenance[]),
) {
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: NativeBashSecurityScope;
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(
    value: Parameters<typeof readNativeBashSecurityFact<T>>[0],
  ): T =>
    readNativeBashSecurityFact(
      value,
      frame().scope,
      typeof receipts === "function" ? receipts() : receipts,
    );
  const need = needNativeBashSecurityCapability;
  const P = () => host.platform;
  const paths = host.platform === "windows" ? win32 : posix;
  const S = (path: string) => paths.dirname(path);
  const v = (path: string) => paths.isAbsolute(path);
  const g = (...values: string[]) => paths.resolve(...values);
  const w = () => use(need(host.home, "filesystem.home")(frame().scope));
  const D = <T>(values: readonly T[]) => [...new Set(values)];
  const OA = (path: string): number => {
    for (let index = 0; index < path.length; index++) {
      const c = path[index];
      if (
        c === "*" ||
        c === "?" ||
        (c === "[" && path.indexOf("]", index + 1) !== -1)
      )
        return index;
    }
    return -1;
  };
  const op = (path: string) =>
    path === "~" || path.startsWith("~/") ? w() + path.slice(1) : path;
  const Bti = (length: number) => semantic.checkBudget(length);
  const se = () => host.filesystem;
  const pa = (path: string) =>
    use(
      need(host.filesystem.inspect, "filesystem.inspect")(path, frame().scope),
    );
  const ko = (_fs: NativeBashSecurityFileHost["filesystem"], path: string) =>
    use(
      need(host.filesystem.canonical, "filesystem.canonical")(
        path,
        frame().scope,
      ),
    );
  const gs = (path: string) =>
    use(
      need(host.filesystem.spellings, "filesystem.spellings")(
        path,
        frame().scope,
      ),
    );
  const wet = (path: string) =>
    use(
      need(
        host.filesystem.canonicalInspection,
        "filesystem.canonicalInspection",
      )(path, frame().scope),
    );
  const Ge = {
    isSandboxingEnabled: () =>
      use(need(host.sandbox, "sandbox.facts")(frame().policy, frame().scope))
        .enabled,
    storedDenyListsMayBeShort: () =>
      use(need(host.sandbox, "sandbox.facts")(frame().policy, frame().scope))
        .storedDenyListsMayBeShort,
    getFsWriteConfig: () =>
      use(need(host.sandbox, "sandbox.facts")(frame().policy, frame().scope)),
    isOnButNotRunning: () =>
      use(need(host.sandbox, "sandbox.facts")(frame().policy, frame().scope))
        .onButNotRunning,
  };
  const caches = {
    resolvedSandboxConfigPaths: new Map<string, readonly string[]>(),
    canonicalHomedirByHome: new Map<string, string>(),
  };
  const q_ = () => caches;
  const Oa = (
    path: string,
    policy: Policy,
    family: "read" | "edit",
    behavior: "deny" | "ask" | "allow",
  ) =>
    use(
      need(host.filePolicy.matchRule, "filePolicy.matchRule")(
        path,
        policy,
        family,
        behavior,
        frame().scope,
      ),
    );
  const Qd = (
    path: string,
    root: string,
    options: {
      caseFold?: boolean;
      uncShapeParity?: boolean;
      skipPrivateAlias?: boolean;
    } = {},
  ) =>
    use(
      need(host.filePolicy.sandboxContains, "filePolicy.sandboxContains")(
        path,
        root,
        options,
        frame().scope,
      ),
    );
  const C5r = (_spellings: Iterable<string>): string | undefined => undefined; // Observed fixed native 326 C5r body.
  const formatPath = (path: string) =>
    use(need(host.formatPath, "display.hx")(path, frame().scope));
  const $7t = (path: string) =>
    `Where ${formatPath(path)} leads on disk could not be determined (a link or directory on the way could not be examined, or the links do not resolve)`;
  const Uie = (path: string, policy: Policy, spellings: readonly string[]) =>
    use(
      need(host.filePolicy.outsideReadBlocked, "filePolicy.outsideReadBlocked")(
        path,
        spellings,
        policy,
        frame().scope,
      ),
    );
  const vct = (
    path: string,
    _input: Record<string, never>,
    spellings: readonly string[],
    _options: { restricted: boolean },
  ) =>
    use(
      need(host.filePolicy.protectedWrite, "filePolicy.protectedWrite")(
        path,
        spellings,
        frame().policy,
        frame().scope,
      ),
    );
  const $Qn = (decision: Decision, policy: Policy) =>
    !(policy.servedCall === true && decision.behavior === "allow");
  const g6e = (policy: Policy) =>
    policy.isRemoteMode === true &&
    !policy.restricted &&
    policy.mode !== "auto" &&
    !(
      policy.mode === "plan" &&
      (policy.prePlanMode === "auto" || !!policy.strippedDangerousRules)
    ) &&
    policy.modeBeforeRewrite !== "auto";
  const uJ = (
    path: string,
    spellings: readonly string[],
    _unused?: undefined,
    _remote: boolean = false,
    _trusted?: readonly string[],
  ) =>
    use(
      need(host.filePolicy.sensitiveWrite, "filePolicy.sensitiveWrite")(
        path,
        spellings,
        frame().policy,
        { remote: _remote, trustedNetworkDirectories: _trusted },
        frame().scope,
      ),
    );
  const vVo = (path: string, inspection: Inspection, policy: Policy) =>
    use(
      need(host.filePolicy.writeNote, "filePolicy.writeNote")(
        path,
        inspection,
        policy,
        frame().scope,
      ),
    );
  const Pwn = (path: string, policy: Policy) =>
    use(
      need(host.filePolicy.pathWriteProtected, "filePolicy.pathWriteProtected")(
        path,
        policy,
        frame().scope,
      ),
    );
  const S6e = (inspection: Inspection, policy: Policy) =>
    use(
      need(host.filePolicy.symlinkNote, "filePolicy.symlinkNote")(
        inspection,
        policy,
        frame().scope,
      ),
    );
  const f7e = (path: string, note: NonNullable<ReturnType<typeof S6e>>) =>
    `${formatPath(path)} resolves through a symlink to ${formatPath(note.landing)}${note.landingOutside ? ", which is outside the allowed working directories" : ""}`;
  const vy = (path: string, policy: Policy, spellings: readonly string[]) =>
    use(
      need(
        host.filePolicy.inWorkingDirectories,
        "filePolicy.inWorkingDirectories",
      )(path, spellings, policy, frame().scope),
    );
  const lLe = (
    path: string,
    _input: Record<string, never>,
    spellings: readonly string[],
    options: {
      restricted: boolean;
      transcriptsJudged?: boolean;
      forTheModelHere?: boolean;
    },
  ) =>
    use(
      need(host.filePolicy.protectedRead, "filePolicy.protectedRead")(
        path,
        spellings,
        frame().policy,
        options,
        frame().scope,
      ),
    );
  const sLe = (policy: Policy) =>
    use(
      need(host.filePolicy.modelReadMode, "filePolicy.modelReadMode")(
        policy,
        frame().scope,
      ),
    );
  const Mti = (reason: Reason | undefined): Reason | undefined =>
    reason?.type !== "safetyCheck"
      ? reason
      : { type: "other", reason: reason.reason, wasSafetyCheck: true };
  const sc = () =>
    use(
      need(host.servedMachine, "host.servedMachine")(
        frame().policy,
        frame().scope,
      ),
    );
  const Xxt = (
    spellings: readonly string[],
    policy: Policy,
    family: "read" | "edit",
  ) => {
    let first: ReturnType<typeof Oa> = null;
    for (const path of spellings) {
      let rule = Oa(path, policy, family, "allow");
      if (!rule) {
        const alias = use(
          need(host.filePolicy.trustedAlias, "filePolicy.trustedAlias")(
            path,
            frame().scope,
          ),
        );
        if (alias !== path) rule = Oa(alias, policy, family, "allow");
      }
      if (!rule) return null;
      first ??= rule;
    }
    return first;
  };
  const Tpr = () =>
    use(
      need(host.earlierSessionIds, "host.earlierSessionIds")(
        frame().policy,
        frame().scope,
      ),
    );
  const Ar = (path: string) =>
    /^[\\/]{2}/.test(path) ||
    /^[\\/]\?\?[\\/]/.test(path) ||
    (path.includes("??") && /^[\\/]\?\?[\\/]/.test(win32.normalize(path)));
  const Hl = /^--?[A-Za-z0-9][\w-]*=/;
  const mp = /(?:^|[^A-Za-z0-9_])[\\/]\?\?(?:[\\/]|$)/;
  function tP(e: string, n = false): boolean {
    if (P() !== "windows") return !1;
    if (n && Ar(e)) return !0;
    if (n && /^-[A-Za-z0-9]/.test(e)) {
      let k = e.replace(/^(?:-[A-Za-z0-9]+)+/, "");
      if (k.length > 0 && tP(k, !0)) return !0;
    }
    if (n && Hl.test(e)) {
      let k = e;
      while (Hl.test(k)) k = k.slice(k.indexOf("=") + 1);
      if (k.length > 0 && tP(k, !0)) return !0;
    }
    if (/\\\\[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i.test(e))
      return !0;
    if (mp.test(e)) return !0;
    if (/(?<!:)\/\/[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i.test(e))
      return !0;
    if (
      (n
        ? /(?<![:\w])\/\\{1,}[^ \t\r\n\f\v\\/]+[\\/]/
        : /\/\\{2,}[^ \t\r\n\f\v\\/]/
      ).test(e)
    )
      return !0;
    if (
      (n
        ? /(?<![:\w])\\{1,}\/[^ \t\r\n\f\v\\/]+[\\/]/
        : /\\{2,}\/[^ \t\r\n\f\v\\/]/
      ).test(e)
    )
      return !0;
    if (/@SSL@\d+/i.test(e) || /@\d+@SSL/i.test(e)) return !0;
    if (/DavWWWRoot/i.test(e)) return !0;
    if (
      /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(e) ||
      /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(e)
    )
      return !0;
    if (
      /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(e) ||
      /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(e)
    )
      return !0;
    return !1;
  }

  const primitive = (
    kind: "Vdo" | "o7n" | "r7n" | "Y4e" | "y4" | "Do",
    path: string,
  ) => use(need(host.pathPrimitive, "path." + kind)(kind, path, frame().scope));
  const Vdo = (path: string) => primitive("Vdo", path);
  const o7n = (path: string) => primitive("o7n", path);
  const r7n = (path: string) => primitive("r7n", path);
  const Y4e = (path: string) => primitive("Y4e", path);
  const y4 = (path: string) => primitive("y4", path);
  const Do = (path: string) => primitive("Do", path);
  const zIi =
    /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/]mnt[\\/]([a-z])(?=$|[\\/])/i;
  const zdo = (home: string, path: string) =>
    use(need(host.windowsPathAliases, "path.zdo")(home, path, frame().scope));
  const C3t = (path: string) =>
    use(need(host.networkHostShape, "path.C3t")(path, frame().scope));
  const We = "Read";
  const ZB =
    "Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.";
  const mhe =
    "Reads outside the working directories are blocked (permissions.blockFileToolReadsOutsideWorkingDirectories).";
  var A = 5,
    N = /[{}]/;
  function Zzr(e: readonly string[]): string {
    let n = e.length;
    if (n <= A) return e.map((s) => `'${s}'`).join(", ");
    return `${e
      .slice(0, A)
      .map((s) => `'${s}'`)
      .join(", ")}, and ${n - A} more`;
  }
  function bol(e: string): string {
    let n = OA(e);
    if (n === -1) return e;
    let r = e.substring(0, n),
      s =
        P() === "windows"
          ? Math.max(r.lastIndexOf("/"), r.lastIndexOf("\\"))
          : r.lastIndexOf("/");
    if (s === -1) return ".";
    return r.substring(0, s) || "/";
  }
  function pyn(e: string, n?: readonly string[]): boolean {
    if (!Ge.isSandboxingEnabled() || Ge.storedDenyListsMayBeShort()) return !1;
    let { allowOnly: r, denyWithinAllow: s } = Ge.getFsWriteConfig(),
      t = n ?? gs(e),
      d = r.flatMap(_),
      f = s.flatMap(_);
    return t.every((i) => {
      for (let a of f) if (Qd(i, a)) return !1;
      return d.some((a) => Qd(i, a, { caseFold: !0, uncShapeParity: !0 }));
    });
  }
  function _(e: string): readonly string[] {
    let { resolvedSandboxConfigPaths: n } = q_(),
      r = n.get(e);
    if (r !== void 0) return r;
    let s = gs(e);
    return (n.set(e, s), s);
  }
  function eVr(e: Reason | undefined): string | undefined {
    return e?.type === "safetyCheck" || e?.type === "other" ? e.reason : void 0;
  }
  function tVr(e: Reason | undefined): string | undefined {
    return e?.type === "safetyCheck" && e.circuitBreaker !== void 0 && KW(e)
      ? e.circuitBreaker
      : void 0;
  }
  function Y2o(e: Decision, n: boolean, r?: Sentence): SafetyReason {
    let s =
        eVr(e.decisionReason) ?? need(e.message, "protected decision.message"),
      t = tVr(e.decisionReason);
    return {
      type: "safetyCheck",
      reason:
        r === void 0 ? s : `${s.endsWith(".") ? s : `${s}.`} ${r.sentence}.`,
      ...(n
        ? {
            classifierApprovable: !1,
            circuitBreaker: "restrictedMode",
            also: ["internalHardDeny", ...(t !== void 0 ? [t] : [])],
          }
        : t !== void 0
          ? {
              classifierApprovable: !1,
              circuitBreaker: t,
              also: ["internalHardDeny"],
            }
          : {
              classifierApprovable: r?.personOnly !== !0,
              circuitBreaker: "internalHardDeny",
            }),
    };
  }
  function IAt(e: FileVerdict): boolean {
    return (
      !e.allowed &&
      e.refusedByDefault === !0 &&
      e.decisionReason === void 0 &&
      e.isInWorkingDir === !1
    );
  }
  function pie(
    e: string,
    n: Policy,
    r: Operation,
    s?: Inspection,
    t?: Iterable<string>,
    d?: { toSend?: boolean },
  ): FileVerdict {
    let f: "read" | "edit" = r === "read" ? "read" : "edit",
      i = s ?? pa(e),
      a = i.spellings,
      l = t ? new Set([...a, ...t]) : a;
    for (let o of l) {
      let R = Oa(o, n, f, "deny");
      if (R !== null)
        return { allowed: !1, decisionReason: { type: "rule", rule: R } };
    }
    let c = C5r(l);
    if (c !== void 0)
      return {
        allowed: !1,
        decisionReason: {
          type: "safetyCheck",
          reason: c,
          classifierApprovable: !1,
        },
      };
    if (i.unresolved) {
      let o = $7t(e);
      if (r === "read" && !n.restricted)
        return n.blockReadsOutsideWorkingDirectories === !0
          ? {
              allowed: !1,
              decisionReason: {
                type: "safetyCheck",
                reason: o,
                classifierApprovable: !1,
                circuitBreaker: "outsideReadsBlocked",
              },
            }
          : { allowed: !1, decisionReason: { type: "other", reason: o } };
      return {
        allowed: !1,
        decisionReason: {
          type: "safetyCheck",
          reason: o,
          classifierApprovable: !1,
          ...(n.restricted && { circuitBreaker: "restrictedMode" }),
        },
      };
    }
    if (r === "read" && Uie(e, n, a))
      return {
        allowed: !1,
        decisionReason: {
          type: "safetyCheck",
          reason: n.blockReadsOutsideWorkingDirectories ? ZB : mhe,
          classifierApprovable: !1,
          circuitBreaker: "outsideReadsBlocked",
        },
      };
    let u: Decision | undefined;
    if (r !== "read") {
      let o = vct(e, {}, a, { restricted: n.restricted });
      if (o.behavior === "deny") u = o;
      if (o.behavior === "allow" && $Qn(o, n))
        return { allowed: !0, decisionReason: o.decisionReason };
    }
    if (r !== "read") {
      let o = uJ(e, a, void 0, g6e(n), n.trustedNetworkDirectories);
      if (!o.safe) {
        let R = vVo(i.requested, i, n),
          y = eVr(u?.decisionReason) ?? o.message,
          k = tVr(u?.decisionReason),
          F = u !== void 0 && R !== null && !Pwn(i.requested, n),
          b = n.restricted ? "restrictedMode" : (o.circuitBreaker ?? k),
          E = [
            ...(o.circuitBreaker !== void 0 ? [o.circuitBreaker] : []),
            ...(o.also ?? []),
            ...(u !== void 0 ? ["internalHardDeny"] : []),
            ...(k !== void 0 ? [k] : []),
          ].filter((I, H, x) => I !== b && x.indexOf(I) === H);
        return {
          allowed: !1,
          decisionReason: {
            type: "safetyCheck",
            reason:
              R === null
                ? y
                : `${y.endsWith(".") ? y : `${y}.`} ${R.sentence}.`,
            ...(n.restricted
              ? { classifierApprovable: !1, circuitBreaker: "restrictedMode" }
              : {
                  classifierApprovable:
                    o.classifierApprovable &&
                    !R?.personOnly &&
                    !F &&
                    k === void 0,
                  ...(b !== void 0 && { circuitBreaker: b }),
                }),
            ...(E.length > 0 && { also: E }),
          },
        };
      }
    }
    if (u !== void 0) {
      let o = S6e(i, n);
      return {
        allowed: !1,
        decisionReason: Y2o(
          u,
          n.restricted,
          o === null
            ? void 0
            : {
                sentence: f7e(i.requested, o),
                personOnly: o.carriedOut || !Pwn(i.requested, n),
              },
        ),
      };
    }
    let h = vy(e, n, a);
    if (h) {
      if (r === "read" || n.mode === "acceptEdits") return { allowed: !0 };
    }
    if (r === "read") {
      let o = lLe(e, {}, a, {
        restricted: n.restricted,
        transcriptsJudged: !0,
        forTheModelHere:
          !d?.toSend &&
          !sLe(n) &&
          ![...l].some((R) => Oa(R, n, "read", "ask") !== null),
      });
      if (o.behavior === "deny")
        return { allowed: !1, decisionReason: Mti(o.decisionReason) };
      if (o.behavior === "allow" && $Qn(o, n))
        return { allowed: !0, decisionReason: o.decisionReason };
    }
    if (
      r !== "read" &&
      !h &&
      !sc() &&
      n.servedCall !== !0 &&
      !Ge.isOnButNotRunning() &&
      pyn(e, a)
    )
      return {
        allowed: !0,
        decisionReason: {
          type: "other",
          reason: "Path is in sandbox write allowlist",
        },
      };
    let p = Xxt(a, n, f);
    if (p !== null)
      return { allowed: !0, decisionReason: { type: "rule", rule: p } };
    if (r !== "read") {
      let o = S6e(i, n);
      if (o?.carriedOut)
        return {
          allowed: !1,
          isInWorkingDir: h,
          decisionReason: {
            type: "safetyCheck",
            reason: f7e(i.requested, o),
            classifierApprovable: !1,
          },
        };
    }
    return { allowed: !1, isInWorkingDir: h, refusedByDefault: !0 };
  }
  function m(
    e: string,
    n: Policy,
    ...r: [Operation, Inspection?, Iterable<string>?, { toSend?: boolean }?]
  ): FileVerdict {
    return pie(
      e,
      n.blockFileToolReadsOutsideWorkingDirectories === !0
        ? { ...n, blockFileToolReadsOutsideWorkingDirectories: !1 }
        : n,
      ...r,
    );
  }
  function W(e: Policy): boolean {
    return [
      e.alwaysDenyRules,
      ...(Tpr().length > 0 ? [e.alwaysAskRules] : []),
    ].some((n) => Object.values(n).some((r) => (r?.length ?? 0) > 0));
  }
  function Qje(e: string, n: Policy): FileVerdict {
    return pie(e, n, "read", void 0, void 0, { toSend: !0 });
  }
  function M(
    e: string,
    n: string,
    r: Policy,
    s: Operation,
  ): ResolvedFileVerdict {
    let t = se(),
      d = bol(e),
      f = v(d) ? d : g(n, d),
      i = v(e) ? e : g(n, e);
    for (;;) {
      let { resolvedPath: a, isSymlink: l, isCanonical: c } = ko(t, i),
        u = S(i);
      if (c || i === f || u === i)
        return {
          ...m(a, r, s, c ? wet(a) : void 0, c && l && W(r) ? gs(i) : void 0),
          resolvedPath: a,
        };
      i = u;
    }
  }
  var G = /^[A-Za-z]:\/?$/,
    L = /^[A-Za-z]:\/[^/]+$/,
    q = /^[A-Za-z]:\//,
    B = /^\\\\([^\\]+)\\([a-z])\$(?=$|\\)/,
    X = /^\/\.(?:vol|file)(?:\/|$)/i,
    z = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|[\\/]\?\?[\\/])/,
    U = /^[\\/]{2}(?:[?.][\\/]|;|[^\\/]+[\\/]admin\$(?=$|[\\/]))/i;
  function Blt(e: string): boolean {
    return j(e).some((n) => {
      let r = O(n);
      if (U.test(r) || V(r)) return !0;
      let s = r.replace(/[\\/]+/g, "/");
      if (P() === "macos" && X.test(s)) return !0;
      return K(s);
    });
  }
  function j(e: string): string[] {
    let n = [
      e,
      e
        .split("/")
        .filter((r, s) => r !== "." || s === 0)
        .join("/") || (e.startsWith("/") ? "/" : ""),
    ];
    if (z.test(e) || P() === "windows")
      for (let r of D([e, Vdo(e)]))
        n.push(
          ...C(o7n(r)),
          ...C(
            o7n(
              r.replace(/[^\\/]+/g, (s) => {
                let t = y4(s);
                return t === "." || t === ".." ? t : s;
              }),
            ),
          ),
        );
    return D(n);
  }
  function C(e: string): string[] {
    let n = B.exec(e);
    return n !== null && T(required(n[1])) === "own_host"
      ? [e, `${n[2]}:${e.slice(n[0].length) || "\\"}`]
      : [e];
  }
  function T(
    e: string,
  ):
    | "own_host"
    | "numeric_host"
    | "odd_host"
    | "wsl_host"
    | "short_name"
    | "device_namespace"
    | "drive_relative"
    | "webdav_host"
    | undefined {
    return C3t(`\\\\${e}\\`);
  }
  function V(e: string): boolean {
    if (!/^[\\/]{2}/.test(e)) return !1;
    let n = B.exec(o7n(e)),
      r = n === null ? void 0 : T(required(n[1]));
    return r === "numeric_host" || r === "odd_host";
  }
  function K(e: string): boolean {
    if (e === "*" || e.endsWith("/*")) return !0;
    let n = P() === "macos",
      r = (l: string) =>
        n ? l.replace(/^\/private\/(etc|var|tmp|home)(\/|$)/i, "/$1$2") : l,
      s = r(e),
      t = s === "/" ? s : s.replace(/\/$/, "");
    if (t === "/") return !0;
    if (G.test(t)) return !0;
    let d = r(O(w()).replace(/[\\/]+/g, "/")).replace(/\/$/, "");
    if (Do(t) === Do(d)) return !0;
    let f = Y(w()),
      i = D([
        d,
        f,
        ...(/^[\\/]{2}/.test(w())
          ? C(o7n(Vdo(w()))).map((l) =>
              l.replace(/[\\/]+/g, "/").replace(/\/$/, ""),
            )
          : []),
      ]);
    if (i.some((l) => l !== d && Do(t) === Do(l))) return !0;
    for (let l of i) {
      let c = q.exec(l)?.[0];
      if (
        c !== void 0 &&
        Do(t.slice(0, c.length)) === Do(c) &&
        zdo(l.slice(c.length), t.slice(c.length)).some((u) => u.length === 0)
      )
        return !0;
    }
    if (S(t) === "/") return !0;
    if (L.test(t)) return !0;
    return !1;
  }
  function O(e: string): string {
    return Y4e(r7n(Vdo(e).replace(zIi, "$1:")));
  }
  function Y(e: string): string {
    let { canonicalHomedirByHome: n } = q_(),
      r = n.get(e);
    if (r !== void 0) return r;
    let s = O(ko(se(), e).resolvedPath)
      .replace(/[\\/]+/g, "/")
      .replace(/\/$/, "");
    return (n.set(e, s), s);
  }
  function cYn(e: string): string[] {
    let n = e.split(/\/+/);
    return P() === "windows" ? [...e.split(/[\\/]+/), ...n] : n;
  }
  function Zje(e: string): boolean {
    let n = e.split(P() === "windows" ? /[\\/]/ : "/"),
      r = !1;
    for (let s of n) {
      if (s === "" || s === ".") continue;
      if (s === "..") {
        if (r) return !0;
      } else r = !0;
    }
    return !1;
  }
  function uYn(e: string): boolean {
    let n = e.split(/[\\/]+/);
    return n.some((r, s) => {
      if (r !== "..") return !1;
      let t = n.slice(0, s).join("/");
      return (
        OA(t) !== -1 ||
        (t.includes("[") &&
          n
            .slice(s + 1)
            .join("/")
            .includes("]"))
      );
    });
  }
  function Z(e: Policy): boolean {
    return Object.values(e.alwaysDenyRules).some((n) =>
      n?.some((r) => r === We || r.startsWith(`${We}(`)),
    );
  }
  function J(
    e: string,
    n: string,
    r: Policy,
    s: Operation,
  ): ResolvedFileVerdict | undefined {
    if (P() === "windows") return;
    let t = Q(e, n, r, s);
    if (
      s === "read" &&
      t?.decisionReason?.type !== "rule" &&
      uYn(e) &&
      (r.blockReadsOutsideWorkingDirectories === !0 || Z(r))
    )
      return {
        allowed: !1,
        resolvedPath: e,
        decisionReason: {
          type: "safetyCheck",
          reason: `A glob before the '..' in '${e}' is expanded by the shell before the path is opened, so the target cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories) or the Read deny rules. Spell the path without the glob.`,
          classifierApprovable: !1,
          circuitBreaker: "outsideReadsBlocked",
        },
      };
    return t;
  }
  function Q(
    e: string,
    n: string,
    r: Policy,
    s: Operation,
  ): ResolvedFileVerdict | undefined {
    let t = se(),
      d = v(e) ? e : `${n}/${e}`,
      f = "/",
      i = [];
    for (let h of d.split("/")) {
      if (h === "" || h === ".") continue;
      if (h !== "..") {
        i.push(h);
        continue;
      }
      if (i.length > 0) {
        let p = ko(t, g(f, ...i));
        if (!p.isCanonical) return;
        {
          f = p.resolvedPath;
          i = [];
        }
      }
      f = S(f);
    }
    let a = g(f, ...i);
    if (s !== "read") {
      let h = { ...pa(a), requested: d },
        p = m(h.unresolved ? a : h.landing, r, s, h);
      if (p.allowed || (p.isInWorkingDir === !0 && p.decisionReason === void 0))
        return;
      let o = S6e(h, r);
      return { ...p, resolvedPath: o?.carriedOut ? o.landing : a };
    }
    let { resolvedPath: l, isCanonical: c } = ko(t, a),
      u = m(l, r, s, c ? wet(l) : void 0);
    if (u.allowed || (u.isInWorkingDir === !0 && u.decisionReason === void 0))
      return;
    return { ...u, resolvedPath: l };
  }
  function D1(
    e: string,
    n: string,
    r: Policy,
    s: Operation,
  ): ResolvedFileVerdict {
    Bti(e.length);
    let t = op(e);
    if (tP(t, !0))
      return {
        allowed: !1,
        resolvedPath: t,
        decisionReason: {
          type: "other",
          reason: "UNC network paths require manual approval",
        },
      };
    if (t.startsWith("~"))
      return {
        allowed: !1,
        resolvedPath: t,
        decisionReason: {
          type: "other",
          reason:
            "Tilde expansion variants (~user, ~+, ~-) in paths require manual approval",
        },
      };
    if (
      t.includes("$") ||
      (P() === "windows" && t.includes("%")) ||
      t.includes("`") ||
      t.startsWith("=")
    )
      return {
        allowed: !1,
        resolvedPath: t,
        decisionReason: {
          type: "other",
          reason: "Shell expansion syntax in paths requires manual approval",
        },
      };
    if (Zje(t))
      return (
        J(t, n, r, s) ?? {
          allowed: !1,
          resolvedPath: t,
          decisionReason: {
            type: "other",
            reason:
              "Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory",
          },
        }
      );
    if ((s === "write" || s === "create") && N.test(t))
      return {
        allowed: !1,
        resolvedPath: t,
        decisionReason: {
          type: "other",
          reason:
            "Brace characters in write target require manual approval \u2014 bash may brace-expand to paths outside the working directory",
        },
      };
    if (OA(t) !== -1) {
      if (s === "write" || s === "create")
        return {
          allowed: !1,
          resolvedPath: t,
          decisionReason: {
            type: "other",
            reason:
              "Glob patterns are not allowed in write operations. Please specify an exact file path.",
          },
        };
      return M(t, n, r, s);
    }
    let d = v(t) ? t : g(n, t);
    return X2o(d, r, s);
  }
  function X2o(e: string, n: Policy, r: Operation): ResolvedFileVerdict {
    if (r !== "read") {
      let i = pa(e),
        a = i.unresolved ? e : i.landing,
        l = m(a, n, r, i),
        c = l.allowed ? null : S6e(i, n);
      return { ...l, resolvedPath: c?.carriedOut ? c.landing : e };
    }
    let { resolvedPath: s, isSymlink: t, isCanonical: d } = ko(se(), e);
    return {
      ...m(s, n, r, d ? wet(s) : void 0, d && t && W(n) ? gs(e) : void 0),
      resolvedPath: s,
    };
  }

  return {
    withPolicyScope<T>(policy: Policy, cwd: string, run: () => T): T {
      return frames.run(
        { policy, scope: { policyId: policy.scope.policyId, cwd } },
        run,
      );
    },
    bindings: {
      P,
      S,
      v,
      g,
      w,
      D,
      OA,
      op,
      pa,
      ko,
      gs,
      wet,
      Ge,
      Oa,
      Qd,
      C5r,
      Uie,
      vct,
      $Qn,
      g6e,
      uJ,
      vVo,
      Pwn,
      S6e,
      f7e,
      vy,
      lLe,
      sLe,
      Mti,
      sc,
      Xxt,
      Tpr,
      tP,
      formatPath,
    },
    check(
      path: string,
      cwd: string,
      policy: Policy,
      operation: Operation,
    ): ResolvedFileVerdict {
      return frames.run(
        { policy, scope: { policyId: policy.scope.policyId, cwd } },
        () => D1(path, cwd, policy, operation),
      );
    },
    native: {
      Zzr,
      bol,
      pyn,
      eVr,
      tVr,
      Y2o,
      IAt,
      pie,
      Qje,
      Blt,
      cYn,
      Zje,
      uYn,
      D1,
      X2o,
    },
  };
}
