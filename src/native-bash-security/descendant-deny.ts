import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import type { createNativeBashSecurityPolicyControl } from "./policy-control.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityRule as Rule,
} from "./security-types.js";
export interface NativeBashDescendantDenyHost {
  platformProfile: "macos" | "linux" | "windows" | "wsl";
  compileErrorMessage?: (pattern: string, scope: Scope) => Fact<string | null>;
  denyReadRules?: (policy: Policy, scope: Scope) => Fact<readonly Rule[]>;
  denialRelativeRoots?: (
    policy: Policy,
    path: string,
    scope: Scope,
  ) => Fact<readonly string[]>;
  zestyPearl?: (scope: Scope) => Fact<boolean>;
  wslMountPoints?: (scope: Scope) => Fact<readonly string[]>;
  wslAdditionalRootMount?: (
    scope: Scope,
  ) => Fact<{ enabled: boolean; mountPoint: string }>;
  secondaryRootAliases?: (
    path: string,
    scope: Scope,
  ) => Fact<readonly string[] | undefined>;
  reportError?: (error: unknown, scope: Scope) => Fact<void>;
  patternWarning?: (
    pattern: string,
    message: string,
    action:
      | "dropping it"
      | "matching the literal path it spells"
      | "matching everything below its root",
    scope: Scope,
  ) => Fact<void>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native descendant-deny scope");
  return value;
}
export function createNativeBashDescendantDeny(
  policy: ReturnType<typeof createNativeBashSecurityPolicyControl>,
  host: NativeBashDescendantDenyHost,
) {
  if (
    policy.pathOwner.gate.bindings.P() !==
    (host.platformProfile === "wsl" ? "linux" : host.platformProfile)
  )
    throw new NativeBashSecurityUnsupported(
      "platform.profile",
      "Native descendant-deny platform profile must match its shared path owner",
    );
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(receipt: Fact<T>) =>
    readNativeBashSecurityFact(receipt, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const gs = policy.pathOwner.gate.bindings.gs;
  const { u7e, $t } = policy.pathOwner.native;
  const D = <T>(values: readonly T[]) => [...new Set(values)];
  const Bct = (permission: Policy, _tool: "Read", _behavior: "deny") =>
    use(
      need(host.denyReadRules, "rules.denialReadSet")(
        permission,
        frame().scope,
      ),
    );
  const Ewn = (_behavior: "deny", permission: Policy, path: string) =>
    use(
      need(host.denialRelativeRoots, "rules.denialRelativeRoots")(
        permission,
        path,
        frame().scope,
      ),
    );
  const We = "Read";
  const _e = "/";
  const Do = (value: string) =>
    value
      .toLowerCase()
      .replace(/\u0131/g, "i")
      .replace(/\u017f/g, "s");
  const zCache = new Map<string, string>();
  function zB(value: string): string {
    const cached = zCache.get(value);
    if (cached !== undefined) {
      zCache.delete(value);
      zCache.set(value, cached);
      return cached;
    }
    const drive = /^([A-Za-z]):[/\\]/.exec(value);
    const result = value.startsWith("\\\\")
      ? value.replaceAll("\\", "/")
      : drive
        ? "/" +
          required(drive[1]).toLowerCase() +
          value.slice(2).replaceAll("\\", "/")
        : value.replaceAll("\\", "/");
    zCache.set(value, result);
    if (zCache.size > 500) {
      const first = zCache.keys().next();
      if (!first.done) zCache.delete(first.value);
    }
    return result;
  }
  function c7e(from: string, to: string): string {
    return host.platformProfile === "windows"
      ? posix.relative(zB(from), zB(to))
      : posix.relative(from, to);
  }
  let reportedSecondRootMountFlagThrow = false;
  function Br(): boolean {
    if (host.platformProfile !== "wsl") return false;
    try {
      return (
        use(need(host.zestyPearl, "features.zestyPearl")(frame().scope)) ===
        true
      );
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
      if (!reportedSecondRootMountFlagThrow) {
        reportedSecondRootMountFlagThrow = true;
        use(need(host.reportError, "errors.report")(error, frame().scope));
      }
      return true;
    }
  }
  function Yn(): string[] {
    const points = use(
      need(host.wslMountPoints, "filesystem.wslMountPoints")(frame().scope),
    );
    const additional = use(
      need(
        host.wslAdditionalRootMount,
        "filesystem.wslAdditionalRootMount",
      )(frame().scope),
    );
    return (
      additional.enabled ? D([...points, additional.mountPoint]) : [...points]
    ).toSorted((a, b) => b.length - a.length);
  }
  function Bc(paths: readonly string[]): readonly string[] {
    return Br()
      ? D([
          ...paths,
          ...paths.flatMap(
            (path) =>
              use(
                need(
                  host.secondaryRootAliases,
                  "filesystem.secondaryRootAliases",
                )(path, frame().scope),
              ) ?? [],
          ),
        ])
      : paths;
  }
  const Pf = /^\s*$|^#|(?:^|[^\\])\\$/;
  const wQn = (pattern: string) =>
    use(
      need(host.compileErrorMessage, "rules.compileErrorMessage")(
        pattern,
        frame().scope,
      ),
    );
  const Ycr = (value: string) => /^[\\[\]!#()|+^$*?\s]$/.test(value);
  function Kcr(pattern: string): string {
    return pattern.replace(/\\([^])/g, (whole: string, char: string) =>
      Ycr(char) ? char : whole,
    );
  }
  function cPe(pattern: string, options?: { escapeGlobs?: boolean }): string {
    let escaped = pattern
      .replaceAll("\\", "\\\\")
      .replace(/[[\]()|+^$]/g, (char) => `\\${char}`);
    if (options?.escapeGlobs) escaped = escaped.replaceAll("*", "\\*");
    if (escaped.startsWith("!") || escaped.startsWith("#"))
      escaped = `\\${escaped}`;
    return escaped.replace(/\s+$/, (tail) =>
      Array.from(tail, (char) => `\\${char}`).join(""),
    );
  }
  const Uo = (
    _kind: "permission_rules",
    pattern: string,
    message: string,
    action:
      | "dropping it"
      | "matching the literal path it spells"
      | "matching everything below its root",
  ) => {
    use(
      need(host.patternWarning, "rules.patternWarning")(
        pattern,
        message,
        action,
        frame().scope,
      ),
    );
  };
  function Et(e: string, n: boolean): string {
    if (e.endsWith("/**")) {
      let r = e.slice(0, -3);
      return /[^/]/.test(r)
        ? r.includes("/") || !n || /^[!#]/.test(r)
          ? r
          : "/" + r
        : "/**";
    }
    return e;
  }

  function vr(e: string): string | null {
    return Pf.test(e)
      ? "skipped by the ignore library (blank, comment, or trailing backslash)"
      : wQn(e);
  }

  function Oi(e: string): string {
    let n = e.startsWith("!") ? "!" : "",
      r = e.endsWith("/**") ? "/**" : "",
      a = e.slice(n.length, e.length - r.length);
    return n + cPe(Kcr(a)) + r;
  }

  function jc(e: string): boolean {
    let n = Et(e, !1);
    return wQn(n) === null;
  }

  function Ur(e: string, n: boolean): string | null {
    let r = Et(e, n),
      a = !n && /^!\s*$/.test(r) ? "a negation of every path" : vr(r);
    if (a === null) return e;
    let h = e.startsWith("!") ? "!" : "",
      y = h ? !n : n,
      k = Oi(e),
      R = !y && jc(k);
    return (
      Uo(
        "permission_rules",
        e,
        a,
        y
          ? "dropping it"
          : R
            ? "matching the literal path it spells"
            : "matching everything below its root",
      ),
      y ? null : R ? k : h + "**"
    );
  }

  function Og(e: string[], n: string[]): boolean {
    for (let [r, a] of n.entries()) {
      let h = e[r];
      if (h === void 0 || h === "**") return !0;
      let y = Do(a),
        k = Do(h);
      if (!/[*?[\]{}\\]/.test(k)) {
        if (k !== y) return !1;
        continue;
      }
      if (/[[\]{}\\]/.test(k)) continue;
      if (
        !new RegExp(
          `^${k
            .replace(/[.+^$()|]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]")}$`,
        ).test(y)
      )
        return !1;
    }
    return !0;
  }

  function Oti(e: string, n: Policy): Rule | null {
    let r = Bct(n, We, "deny");
    if (r.length === 0) return null;
    let a = gs(e),
      y =
        Br() && Yn().some((E) => a.some((M) => E.startsWith(`${M}${_e}`)))
          ? [...a, _e]
          : Bc(a),
      k = new Map<string, readonly string[]>(),
      R = (E: string) => {
        let M = k.get(E);
        if (M !== void 0) return M;
        let O = Ewn("deny", n, E);
        return (k.set(E, O), O);
      };
    for (let E of r) {
      let M = E.ruleValue.ruleContent;
      if (M === void 0) continue;
      let { relativePattern: O, root: j } = u7e(M, E.source),
        N = $t(O);
      if (N.startsWith("!")) continue;
      let H = N.split("/").filter((X) => X !== ""),
        V = (H.length <= 1 && !N.startsWith("/")) || Ur(N, !1) === "**";
      for (let X of y)
        for (let re of j !== null ? [j] : R(X)) {
          let te = c7e(re, X)
            .split("/")
            .filter((fe) => fe !== "" && fe !== ".");
          if (te[0] === "..") {
            if (!c7e(X, re).split("/").includes("..")) return E;
            continue;
          }
          if (V || Og(H, te)) return E;
        }
    }
    return null;
  }

  return {
    policy,
    host,
    native: { Br, Yn, Bc, Do, zB, c7e, Et, vr, Oi, jc, Ur, Og, Oti },
    cache: { clear: () => zCache.clear(), size: () => zCache.size },
    withPolicyScope<T>(
      permission: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: permission.scope.policyId, cwd }, receipts },
        () => policy.withPolicyScope(permission, cwd, run, receipts),
      );
    },
  };
}
