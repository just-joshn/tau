import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import type { NativeBashSemanticCommand as Command } from "../native-bash-semantics.js";
import type { createNativeBashSecurityRecursiveSyntax } from "./recursive-syntax.js";
import type { createNativeBashDescendantDeny } from "./descendant-deny.js";
import type { NativeBashSecurityContext as Context } from "./security-recursion-types.js";
import {
  NativeBashSecurityUnsupported,
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
} from "./security-types.js";
export interface NativeBashCwdReadHost {
  statDirectory?: (
    path: string,
    scope: Scope,
  ) => Fact<
    | { status: "stat"; isDirectory: boolean }
    | { status: "error"; error: unknown }
  >;
  realpath?: (path: string, scope: Scope) => Promise<Fact<string>>;
  bigintStat?: (
    path: string,
    scope: Scope,
  ) => Promise<Fact<{ dev: bigint; ino: bigint }>>;
  delightfulGoblet?: (scope: Scope) => Fact<boolean>;
  cozyRaven?: (scope: Scope) => Fact<boolean>;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing native cwd/read scope");
  return value;
}
export function createNativeBashCwdReadControl(
  syntax: ReturnType<typeof createNativeBashSecurityRecursiveSyntax>,
  descendant: ReturnType<typeof createNativeBashDescendantDeny>,
  host: NativeBashCwdReadHost,
) {
  const { policy, semantic } = syntax;
  if (descendant.policy !== policy)
    throw new Error("Native Bash process owners must be shared");
  const path = policy.pathOwner;
  const paths = path.gate.bindings.P() === "windows" ? win32 : posix;
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(fact: Fact<T>) =>
    readNativeBashSecurityFact(fact, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const { P, ko, vy, tP, w: abn } = path.gate.bindings;
  const { l1 } = path.native;
  const { Ys } = semantic.native;
  const { klt, Wlt, Tbn, vbn } = policy.native;
  const { sb } = syntax.native;
  const { Oti } = descendant.native;
  const _x = (path: string) => paths.isAbsolute(path);
  const HF = (...parts: string[]) => paths.resolve(...parts);
  const hasControl = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 32 || code === 127) return true;
    }
    return false;
  };
  const b0e = (context: Context) => new Set(context.sessionEnvVars?.keys());
  const kzn = policy.native.kzn;
  const se = () => ({
    ...path.filesystem,
    statSync: (path: string) => {
      const result = use(
        need(host.statDirectory, "filesystem.followedStatDirectory")(
          path,
          frame().scope,
        ),
      );
      if (result.status === "error") throw result.error;
      return { isDirectory: () => result.isDirectory };
    },
  });
  const D1 = (
    pathValue: string,
    cwd: string,
    permission: Policy,
    operation: "read",
  ) => path.gate.check(pathValue, cwd, permission, operation);
  const Ks = { isReadOnly: policy.native.isReadOnly };
  const Q_n = () =>
    use(
      need(host.delightfulGoblet, "features.delightfulGoblet")(frame().scope),
    );
  const RIo = () =>
    use(need(host.cozyRaven, "features.cozyRaven")(frame().scope));
  const NMr = async (path: string) =>
    use(
      await need(host.realpath, "filesystem.followedRealpath")(
        path,
        frame().scope,
      ),
    );
  const FMr = async (path: string, _options: { bigint: true }) =>
    use(
      await need(host.bigintStat, "filesystem.followedBigintStat")(
        path,
        frame().scope,
      ),
    );
  const Ui = (inode: bigint) =>
    inode === 0n ||
    inode === -1n ||
    inode === 0xffffffffffffffffn ||
    inode === 1n << 64n;
  const U = <T>(values: T[], predicate: (value: T) => unknown) =>
    values.reduce((n, value) => n + +!!predicate(value), 0);
  const KPn = new Map<string, Set<string>>([
    ["python", new Set(["-c"])],
    ["node", new Set(["-e", "--eval", "-p", "--print"])],
    ["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
    ["bun", new Set(["-e", "--eval", "-p", "--print"])],
    ["perl", new Set(["-e", "-E"])],
    ["ruby", new Set(["-e"])],
    ["php", new Set(["-r"])],
    ["bash", new Set(["-c"])],
    ["sh", new Set(["-c"])],
    ["zsh", new Set(["-c"])],
    ["dash", new Set(["-c"])],
    ["ksh", new Set(["-c"])],
    ["lua", new Set(["-e"])],
    ["luajit", new Set(["-e"])],
    ["tsx", new Set(["-e", "--eval", "-p", "--print"])],
    ["deno", new Set(["eval"])],
    ["Rscript", new Set(["-e"])],
    ["julia", new Set(["-e", "-E"])],
    ["osascript", new Set(["-e"])],
  ]);
  function vlt(e: string[]): "cd" | "chdir" | "pushd" | "popd" | undefined {
    let n = e[0]?.replace(/^.*[\\/]/, "");
    return n === "cd" || n === "chdir" || n === "pushd" || n === "popd"
      ? n
      : void 0;
  }

  function bbn(e: string): string[] {
    let n = new Set([e]);
    if (/^-[^-]/.test(e)) for (let a = 2; a <= e.length; a++) n.add(e.slice(a));
    let r = e;
    for (;;) {
      let a = r.startsWith("@")
        ? r.slice(1)
        : r.includes("=")
          ? r.slice(r.indexOf("=") + 1)
          : r;
      if ((n.add(a), a === r)) break;
      r = a;
    }
    return [...n];
  }

  function fOr(e: string[]): boolean {
    let n = l1([...e]),
      r = n[0];
    if (r === void 0) return !1;
    let a = r.slice(r.lastIndexOf("/") + 1).replace(/[\d.]+$/, "");
    if (!KPn.has(a)) return !1;
    let h = n.slice(1);
    if (h.includes("-")) return !0;
    return h.every((y) => y.startsWith("-"));
  }

  function EOr(e: Command[], n: string, r: Policy, a: Context): boolean {
    if (P() === "windows") return !0;
    let [h, ...y] = e.map((_e) => ({ cmd: _e, argv: l1(_e.argv) })),
      k = h && vlt(h.argv);
    if (h === void 0 || k === void 0 || k === "popd") return !0;
    let E = h.argv.slice(1).filter((_e) => _e !== "--"),
      N = E[0];
    if (
      h.cmd.envVars.length > 0 ||
      E.length !== 1 ||
      N === void 0 ||
      Ys(N) ||
      hasControl(N) ||
      /^[-+~]|[$`*?[\]{}\\]|(^|\/)\.\.(\/|$)/.test(N)
    )
      return !0;
    let V = !_x(N) && N !== "." && !N.startsWith("./");
    if (V && kzn(b0e(a))?.has("CDPATH") !== !1) return !0;
    let oe = HF(n, N);
    if (!vy(oe, r, [oe])) return !0;
    try {
      if (!se().statSync(oe).isDirectory()) return !0;
    } catch (error) {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
      return !0;
    }
    let re = (_e: string) => Oti(_e, r) !== null;
    if (re(n) || re(oe) || (V && re(HF(abn(), N)))) return !0;
    for (let { cmd: _e, argv: ke } of y) {
      if (
        _e.hasUnquotedGlob ||
        _e.envVars.length > 0 ||
        vlt(ke) !== void 0 ||
        ke.some((Re) => Ys(Re) || /(^|[\\/])\.\.([\\/]|$)/.test(Re))
      )
        return !0;
      for (let Re of ke.slice(1))
        for (let xe of bbn(Re)) {
          if (xe === "") continue;
          if (/[*?[\]{}\\~]/.test(xe) || /(^|[\\/=])\.\.([\\/]|$)/.test(xe))
            return !0;
          for (let Pe of [n, oe])
            if (!D1(xe, Pe, r, "read").allowed || re(HF(Pe, xe))) return !0;
        }
    }
    return !1;
  }

  function vOr(e: Command[], n: string, r: Policy, a: Context): boolean {
    let [h, ...y] = e,
      k = h?.argv[1];
    if (
      P() === "windows" ||
      h === void 0 ||
      k === void 0 ||
      y.length === 0 ||
      h.argvSourceLiteral !== !0 ||
      h.text !== `cd ${k}` ||
      !klt(k)
    )
      return !1;
    let E = Wlt(h, n, r);
    if (E === null) return !1;
    let N = [n, E].map((V) => ko(se(), V));
    if (!N.every((V) => V.isCanonical)) return !1;
    return y.every((V) => {
      let oe =
        V.carveOutMayDesyncQuoteScan !== !0 &&
        V.argvUnquotedGlob?.length === V.argv.length;
      return (
        V.envVars.length === 0 &&
        V.argvSourceLiteral === !0 &&
        V.redirects.every(
          ({ op: re, target: _e, targetSourceLiteral: ke }) =>
            ke === !0 &&
            (re === ">&"
              ? /^\d+$/.test(_e)
              : (re === ">" || re === ">>") && _e === "/dev/null"),
        ) &&
        Ks.isReadOnly({ command: V.text }, a) &&
        V.argv.every(
          (re, _e) =>
            vlt([re]) === void 0 &&
            !/(^|[\\/])xargs$/.test(re) &&
            !/[{}]/.test(re) &&
            !Ys(re) &&
            (_x(re) ||
              !/[*?[]/.test(re) ||
              (oe && V.argvUnquotedGlob?.[_e] === !1)) &&
            bbn(re).every(
              (ke) =>
                ke === "" ||
                N.every((Re) => D1(ke, Re.resolvedPath, r, "read").allowed),
            ),
        )
      );
    });
  }

  function wbn(e: string): string | null {
    let n = e.trim();
    if (!n.startsWith("cd ")) return null;
    let r = n.slice(3).trim();
    if (r.length === 0) return null;
    let a = r[0];
    if (a === '"' || a === "'") {
      if (r.length < 2 || r.at(-1) !== a) return null;
      let h = r.slice(1, -1);
      if (h.includes(a)) return null;
      if (a === '"' && h.includes("\\") && P() !== "windows") return null;
      if (hasControl(h)) return null;
      return h;
    }
    if (/\s/.test(r)) return null;
    if (/['"]/.test(r)) return null;
    if (r.includes("\\")) return null;
    if (/[<>|&;(){}]/.test(r)) return null;
    return r;
  }

  async function Glt(e: string): Promise<string | null> {
    if (P() === "windows") {
      let n = e.split(/[\\/]/);
      for (let a = 0; a < n.length; a++) {
        let h = required(n[a]);
        if (h === "." || h === "..") continue;
        if (/[ .]$/.test(h)) return null;
        if (h.includes(":") && !(a === 0 && /^[A-Za-z]:$/.test(h))) return null;
      }
      let r = await FMr(e, { bigint: !0 }).catch((error: unknown) => {
        if (error instanceof NativeBashSecurityUnsupported) throw error;
        return null;
      });
      if (r === null || Ui(r.ino)) return null;
      return `${r.dev}:${r.ino}`;
    }
    return await NMr(e).catch((error: unknown) => {
      if (error instanceof NativeBashSecurityUnsupported) throw error;
      return null;
    });
  }

  async function Ebn(e: string, n: string, r: string): Promise<boolean> {
    if (e.startsWith("-")) return !1;
    if (!Tbn(e)) return !1;
    if (
      e.includes("$") ||
      e.includes("`") ||
      /[*?[]/.test(e) ||
      (P() !== "windows" && e.includes("\\")) ||
      (P() === "windows" && e.includes("%"))
    )
      return !1;
    if (tP(e) || (P() === "windows" && /^[\\/]{2}/.test(e))) return !1;
    if (P() === "windows" && !vbn(e, n)) return !1;
    {
      let y = _x(e),
        k = !1;
      for (let E of e.split(/[\\/]/)) {
        if (E === "" || E === ".") continue;
        if (E === "..") {
          if (!y || k) return !1;
          continue;
        }
        k = !0;
      }
    }
    let a = _x(e) ? e : HF(n, e),
      h = await Glt(a);
    if (h === null) return !1;
    return h === r;
  }

  async function TOr(e: string[], n: string): Promise<boolean> {
    let r = await Glt(n);
    if (r === null) return !1;
    if (U(e, (y) => sb(y.trim())) > 1) return !1;
    let h = !1;
    for (let y of e) {
      let k = y.trim();
      if (!sb(k)) continue;
      h = !0;
      let E = wbn(k);
      if (E === null) return !1;
      if (!(await Ebn(E, n, r))) return !1;
    }
    return h;
  }

  async function bOr(
    e: (Command | undefined)[],
    n: string[],
    r: string,
  ): Promise<boolean> {
    let a = await Glt(r);
    if (a === null) return !1;
    if (U(n, (k) => sb(k)) > 1) return !1;
    let y = !1;
    for (let k = 0; k < n.length; k++) {
      if (!sb(required(n[k]))) continue;
      y = !0;
      let E = e[k];
      if (!E) return !1;
      if (E.envVars.length > 0 || E.redirects.length > 0) return !1;
      if (E.argv.length !== 2 || E.argv[0] !== "cd") return !1;
      if (Ys(required(E.argv[1]))) return !1;
      let N = P() === "windows" ? wbn(required(n[k])) : required(E.argv[1]);
      if (N === null) return !1;
      if (!(await Ebn(N, r, a))) return !1;
    }
    return y;
  }

  return {
    syntax,
    descendant,
    host,
    native: { vlt, bbn, fOr, EOr, vOr, wbn, Glt, Ebn, TOr, bOr, Q_n, RIo },
    withPolicyScope<T>(
      permission: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: permission.scope.policyId, cwd }, receipts },
        () =>
          descendant.withPolicyScope(
            permission,
            cwd,
            () => syntax.withPolicyScope(permission, cwd, run, receipts).result,
            receipts,
          ),
      );
    },
  };
}
