import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type {
  NativeBashSemanticCommand as Command,
  NativeBashSemantics,
} from "../native-bash-semantics.js";
import type { NativeBashCommandPreparation } from "../native-bash-command-preparation.js";
import type {
  createNativeBashSecurityPathControl,
  NativeBashSecurityPathHost,
} from "./path-control.js";
import {
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  NativeBashSecurityUnsupported,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityFilesystemHost as Filesystem,
} from "./security-types.js";
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native git-structure invariant");
  return value;
}
export function createNativeBashSecurityGitStructure(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  pathOwner: ReturnType<typeof createNativeBashSecurityPathControl>,
  host: NativeBashSecurityPathHost,
) {
  if (pathOwner.semantic !== semantic || pathOwner.preparation !== preparation)
    throw new Error("Native Bash process owners must be shared");
  const frames = new AsyncLocalStorage<{
    policy: Policy;
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const paths = host.platform === "windows" ? win32 : posix;
  const Cat = (...parts: string[]) => paths.resolve(...parts);
  const PSn = (path: string) => paths.basename(path);
  const WOe = (from: string, to: string) => paths.relative(from, to);
  const Wde = (path: string) => paths.dirname(path);
  const jOe = (path: string) => paths.isAbsolute(path);
  const ISn = (path: string) => paths.parse(path);
  const LF = paths.sep;
  const VPr = posix;
  const { OA, op } = pathOwner.gate.bindings;
  const { rat, NOe, l1, sD } = pathOwner.native;
  const { extractors: aM, operations: DF } = pathOwner.arguments;
  const { Ys } = semantic.native;
  const {
    splitCommands: Sy,
    staticArgv: iC,
    redirections: KX,
  } = preparation.projection;
  const se = () => host.filesystem;
  const jz = (_fs: Filesystem, path: string) =>
    use(
      need(host.filesystem.realpathSpelling, "filesystem.jz")(
        path,
        frame().scope,
      ),
    );
  const Te = () =>
    use(need(host.originalWorkingDirectory, "cwd.original")(frame().scope));
  const lstatIsSymlink = (path: string) => {
    const stat = use(
      need(host.filesystem.lstat, "filesystem.lstat")(path, frame().scope),
    );
    if (stat.status === "error") throw stat.error;
    return stat.isSymbolicLink;
  };
  const pt = /^[\\/]\?\?[\\/]/;
  const Ar = (path: string) =>
    /^[\\/]{2}/.test(path) ||
    pt.test(path) ||
    (path.includes("??") && pt.test(win32.normalize(path)));
  const Ti = (path: string) => Ar(path) && !oc(path);
  const Va = (path: string) => KPe(path) !== null;
  const canonicalAliasCache = new Map<string, string | null>();
  const P = canonicalAliasCache;
  const wt = 4096;
  const xt = 1024;
  const cwn = new Set(["rm", "rmdir", "sed"]);
  const SMr = new Set(["<", "<<", "<<<", "<&"]);
  const dwn = [/^head$/, /^objects(?:\/|$)/, /^refs(?:\/|$)/, /^hooks(?:\/|$)/];
  const pwn = 32768;
  let xat = pwn;
  function oc(t: string): boolean {
    let n = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]*)/i.exec(t);
    return n !== null && !/^\.{0,2}[. ]*$/.test(n[1] ?? "");
  }

  function kb(t: string): boolean {
    if (!/\/\.(?:vol|file|nofollow|resolve)(?:\/|$)/i.test(t)) return !1;
    if (!t.startsWith("/")) return !1;
    let n = [];
    for (let e of t.split("/")) {
      if (e === "" || e === ".") continue;
      if (e === "..") {
        n.pop();
        continue;
      }
      if (
        (n.push(e),
        n.length === 1 && /^\.(?:vol|file|nofollow|resolve)$/i.test(e))
      )
        return !0;
    }
    return !1;
  }

  function Gv(t: string): string {
    return t
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
      .toUpperCase()
      .toLowerCase();
  }

  function v(t: string[]): boolean {
    return (
      (t.length === 2 && Gv(required(t[0])) === "net") ||
      (t.length === 3 &&
        Gv(required(t[0])) === "network" &&
        Gv(required(t[1])) === "servers")
    );
  }

  function ut(t: string): string | null {
    let n = [];
    for (let e of t.split("/")) {
      if (e === "" || e === ".") continue;
      if (e === "..") {
        n.pop();
        continue;
      }
      if ((n.push(e), v(n))) return "/" + n.join("/");
    }
    return null;
  }

  function KPe(t: string): string | null {
    if (!t.startsWith("/")) return null;
    if (t.length > wt) return ut(t);
    let n = P.get(t);
    if (n === void 0) {
      if (((n = ut(t)), P.size >= xt)) P.clear();
      P.set(t, n);
    }
    return n;
  }

  function fwn(e: Filesystem, n: string): string {
    return Ti(n) || kb(n) ? n : (jz(e, n) ?? n);
  }

  function Gde(e: string, n: string): boolean {
    if (e === "") return !1;
    if (rat(e)) return !0;
    let r = NOe(e);
    if (r !== void 0 && Gde(r, n)) return !0;
    if (e.startsWith("~")) {
      let a = op(e);
      if (a.startsWith("~")) return !0;
      return b8(a, n) || b8(e, n);
    }
    return b8(e, n);
  }

  function wMr(e: string, n: string): boolean {
    if (Gde(e, n)) return !0;
    for (let r = 1; r < e.length; r++) {
      let a = e[r],
        h = e[r - 1];
      if ((a === "/" || a === LF) && h !== "/" && h !== LF) {
        if (Gde(e.slice(0, r), n)) return !0;
      }
    }
    return !1;
  }

  function bMr(e: string, n: string): boolean {
    let r = e.toLowerCase();
    if (r === n.toLowerCase()) return !0;
    let a = se(),
      h = (jz(a, Te()) ?? Te()).normalize("NFC"),
      y = WOe(h, n);
    if (y === ".." || y.startsWith(".." + LF) || jOe(y)) return !1;
    let k = n;
    for (;;) {
      if (k.toLowerCase() === r) return !0;
      if (k === h || k === Wde(k)) return !1;
      k = Wde(k);
    }
  }

  function b8(e: string, n: string): boolean {
    if (((xat -= e.split(/[/\\]/).length + n.split(/[/\\]/).length), xat < 0))
      return !0;
    let r = se();
    if (kb(e)) return !0;
    Ti(e);
    if (!Va(e) && /(^|[/\\])\.\.(?:[/\\]|$)/.test(e)) {
      let _e = /\/+/,
        ke = jOe(e) ? ISn(e).root : "",
        Re = ke ? ISn(Cat(n, e)).root : n,
        xe = (ke ? e.slice(ke.length) : e).split(_e),
        Pe = Re;
      for (let Be = 0; Be < xe.length; Be++) {
        let Fe = required(xe[Be]);
        if (Fe === "" || Fe === ".") continue;
        if (Fe === "..") {
          Pe = Wde(Pe);
          continue;
        }
        if (((Pe = Pe.endsWith(LF) ? Pe + Fe : Pe + LF + Fe), Va(Pe))) break;
        if (kb(Pe)) return !0;
        try {
          if (lstatIsSymlink(Pe) && xe.slice(Be + 1).includes("..")) return !0;
        } catch (error) {
          if (error instanceof NativeBashSecurityUnsupported) throw error;
        }
      }
    }
    let a = Cat(n, e),
      h = fwn(r, a).normalize("NFC"),
      y = (jz(r, n) ?? n).normalize("NFC");
    function k(_e: string): boolean {
      let ke = WOe(_e, h);
      if (ke === "" || ke.startsWith(".." + LF) || jOe(ke)) return !1;
      let Re = ke
        .split(LF)
        .join("/")
        .toLowerCase()
        .replace(/\u0131/g, "i")
        .replace(/\u017f/g, "s");
      return dwn.some((xe) => xe.test(Re));
    }
    if (k(y)) return !0;
    if (!WOe(y, h).startsWith(".." + LF)) return !1;
    let N = Te(),
      V = (jz(r, N) ?? N).normalize("NFC"),
      oe = WOe(V, h);
    if (oe === "" || oe.startsWith(".." + LF) || jOe(oe)) return !1;
    let re = y;
    do if (((re = Wde(re)), k(re))) return !0;
    while (re !== V && re !== Wde(re));
    return !1;
  }

  function Eat(e: string): boolean {
    let n = VPr.normalize(e.replace(/\/+/g, "/"));
    return (
      (n = n
        .replace(/^\.?\//, "")
        .toLowerCase()
        .replace(/\u0131/g, "i")
        .replace(/\u017f/g, "s")),
      dwn.some((r) => r.test(n))
    );
  }

  function kMr(e: string): string[] {
    let n = l1(iC(e));
    if (n.length === 0) return [];
    let r = sD(n[0]?.replace(/[\\'"]/g, ""));
    if (!r) return [];
    if (!Object.hasOwn(DF, r)) return [];
    let a = DF[r];
    if ((a !== "write" && a !== "create") || cwn.has(r)) return [];
    let h = aM[r];
    if (!h) return [];
    return h(n.slice(1));
  }

  function qOe(e: (Command | undefined)[], n: string): boolean {
    xat = pwn;
    for (let r of e) {
      if (!r) continue;
      for (let N of r.redirects) {
        if (SMr.has(N.op)) continue;
        if (Ys(N.target)) return !0;
        if (Gde(N.target, n)) return !0;
      }
      let a = l1(r.argv);
      if (a[0] !== void 0 && Ys(a[0])) return !0;
      let h = sD(a[0]);
      if (!h || !Object.hasOwn(DF, h)) continue;
      let y = DF[h];
      if ((y !== "write" && y !== "create") || cwn.has(h)) continue;
      let k = required(aM[h])(a.slice(1)),
        E =
          h === "mkdir" &&
          a
            .slice(1)
            .some(
              (N) =>
                /^-[^-]*p/.test(N) ||
                (N.startsWith("--p") && "--parents".startsWith(N)),
            );
      for (let N of k) {
        if (Ys(N)) return !0;
        if (E ? wMr(N, n) : Gde(N, n)) return !0;
      }
      if ((h === "cp" || h === "mv") && k.length >= 1) {
        let N = a.slice(1),
          V = N.some((_e) => {
            if (/^-[^-]*t/.test(_e)) return !0;
            let ke = _e.indexOf("="),
              Re = ke >= 0 ? _e.slice(0, ke) : _e;
            return Re.startsWith("--t") && "--target-directory".startsWith(Re);
          }),
          oe = N.some(
            (_e) =>
              /^-[^-]*T/.test(_e) ||
              (_e.startsWith("--n") && "--no-target-directory".startsWith(_e)),
          ),
          re = !1;
        if (!V && k.length >= 2) {
          let _e = required(k.at(-1)),
            ke = [_e],
            Re = NOe(_e);
          if (Re !== void 0) ke.push(Re);
          if (_e.startsWith("~")) {
            let xe = op(_e);
            if (xe.startsWith("~")) re = !0;
            else ke.push(xe);
          }
          if (!re) {
            let xe = se(),
              Pe = (jz(xe, n) ?? n).normalize("NFC");
            for (let Be of ke) {
              let Fe = Cat(n, Be),
                Ke = fwn(xe, Fe).normalize("NFC");
              if (bMr(Ke, Pe)) {
                re = !0;
                break;
              }
            }
          }
        }
        if (V || re) {
          let _e = V ? k : k.slice(0, -1);
          if (oe) return !0;
          for (let ke of _e) {
            if (OA(ke) !== -1 || Ys(ke)) return !0;
            let Re = PSn(ke);
            if (Re === "." || Re === "..") return !0;
            if (ke.startsWith("~")) {
              let xe = op(ke);
              if (xe.startsWith("~")) return !0;
              if (b8(PSn(xe), n) || b8(Re, n)) return !0;
            } else if (b8(Re, n)) return !0;
          }
        }
      }
    }
    return !1;
  }

  function zde(e: string): boolean {
    let n = Sy(e);
    for (let a of n) {
      let h = a.trim(),
        y = kMr(h),
        E = l1(iC(h))[0]?.replace(/[\\'"]/g, ""),
        N = E === "cp" || E === "mv",
        V = y.at(-1),
        oe =
          V !== void 0 &&
          (V === "." ||
            V === "./" ||
            V === "" ||
            /^(?:\.\.\/)*\.\.\/?$/.test(V));
      for (let re of y) {
        if (Eat(re)) return !0;
        if (N && oe && re !== V) {
          let _e = re.replace(/\/+$/, "").split("/").pop() ?? "";
          if (Eat(_e)) return !0;
        }
      }
    }
    let { redirections: r } = KX(e);
    for (let { target: a } of r) if (Eat(a)) return !0;
    return !1;
  }

  return {
    semantic,
    preparation,
    pathOwner,
    native: { qOe, zde, Gde, wMr, bMr, b8, fwn, Eat, kMr, Ti, Va, kb, oc, KPe },
    withPolicyScope<T>(
      policy: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { policy, scope: { policyId: policy.scope.policyId, cwd }, receipts },
        () => pathOwner.withPolicyScope(policy, cwd, run, receipts),
      );
    },
  };
}
