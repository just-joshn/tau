import { AsyncLocalStorage } from "node:async_hooks";
import type {
  NativeBashSemanticCommand as Command,
  NativeBashSemanticSimple as Simple,
} from "../native-bash-semantics.js";
import type { createNativeBashMainControl } from "./main-control.js";
import {
  readNativeBashSecurityFact,
  needNativeBashSecurityCapability,
  type NativeBashSecurityFact as Fact,
  type NativeBashSecurityScope as Scope,
  type NativeBashSecurityProvenance as Provenance,
  type NativeBashSecurityPolicy as Policy,
  type NativeBashSecurityInput as Input,
} from "./security-types.js";
export interface NativeBashCwdAlternatesHost {
  wittyDove?: (scope: Scope) => Fact<boolean>;
  immutableToucan?: (scope: Scope) => Fact<boolean>;
}
export interface NativeBashCwdWriteProfile {
  known: boolean;
  written: string[];
  landings: string[];
  copySources: string[];
  writesUnseen: boolean;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native cwd-alternate invariant");
  return value;
}
export function createNativeBashCwdAlternates(
  main: ReturnType<typeof createNativeBashMainControl>,
  host: NativeBashCwdAlternatesHost,
) {
  const { state } = main;
  const { complexity } = state;
  const { nested } = complexity;
  const { syntax } = nested.recursion;
  const { policy, semantic, preparation } = syntax;
  const path = policy.pathOwner;
  const frames = new AsyncLocalStorage<{
    scope: Scope;
    receipts: Provenance[];
  }>();
  const frame = () => required(frames.getStore());
  const use = <T>(receipt: Fact<T>) =>
    readNativeBashSecurityFact(receipt, frame().scope, frame().receipts);
  const need = needNativeBashSecurityCapability;
  const je = (
    key: "tengu_witty_dove" | "bot_protected_tengu_immutable_toucan",
    _options: { safe: true },
  ) =>
    key === "tengu_witty_dove"
      ? use(need(host.wittyDove, "features.wittyDove")(frame().scope))
      : use(
          need(host.immutableToucan, "features.immutableToucan")(frame().scope),
        );
  const { l1 } = path.native;
  const { extractors: aM, operations: DF } = path.arguments;
  const { fat, vSn, ESn, TSn, hat, yat, UOe } = path.arguments.native;
  const $Oe = Object.keys(aM);
  const PF = path.sed.isReadOnly;
  const oE = preparation.stripSimpleWrappers;
  const { Ge } = complexity.native;
  const Vh = policy.native.Vh;
  const { jxt } = complexity.native;
  const { QKt, m7e, Ys, Dwn, OVo, nPt, E6e } = semantic.native;
  const b4a = <T>(run: () => T) =>
    preparation.features.withAcceptedEnvironment(run);
  const D = <T>(values: T[]) => [...new Set(values)];
  const At = (text: string, needle: string) => {
    let count = 0;
    for (
      let i = text.indexOf(needle);
      i !== -1;
      i = text.indexOf(needle, i + 1)
    )
      count++;
    return count;
  };
  const FPr = "tengu_witty_dove";

  const LMr = "bot_protected_tengu_immutable_toucan";

  const Vrt = /^(?:[A-Za-z0-9./]|~(?:\/|$))/;

  const WPr = new Set([">", ">|", "&>", ">>", "&>>", ">&"]);

  const JSn = "[lLhqjzZt]*";

  const ZSn = new RegExp(`%[^%a-zA-Z]*${JSn}\\\\[0-7xX]`);

  const twn = new RegExp(`%[-+ 0#']*[0-9.*]*${JSn}[diouxXeEfFgGaAn]`);

  const nwn = /%(?:%|[-+ 0#']*(?:[1-9][0-9]*)?(?:b|(?:\.[0-9]*)?[scq]))/g;

  const tIr = new Set([
    ...nPt,
    "printf",
    "read",
    "wait",
    "jobs",
    "compgen",
    "fc",
  ]);

  const ZMr =
    /^(?:SRT_SSH_PROXY_COMMAND|GIT_(?:SSH_COMMAND|CONFIG_(?:GLOBAL|COUNT|(?:KEY|VALUE)_\d+)))$/;

  const Akn = 64;

  const Lxr =
    /^(?:--?|-V|--version|--help|-[Fv][^]*|--(?:field-separator|assign)=[^]*)$/;

  const Nxr = /^-[Fv]$/;

  const jxr = /^(?:[A-Za-z_]\w*\+?=(?:[^]*:)?)?~/;

  const Fxr = /(?:^|[^A-Za-z_])printf?(?![A-Za-z0-9_])/g;

  const $xr =
    /"(?:[^"\\\n]|\\[^])*"|#[^\n]*|\|\||\|&?|>>?|[^"#\\|>;}\n/]+|[^]/g;

  const Wxr =
    /^[ \t]*((?:\([ \t]*)*)("[^"\\\n]*"(?:[ \t]*"[^"\\\n]*")*)((?:[ \t]*\))*)[ \t\r]*(?:[;}\n]|$)/;

  const Uxr = /in(?!\w)/;

  const Hxr = /[\w")\]]$/;

  const Bxr = /(?:length|getline)$/;
  function own(e: string): boolean {
    let n = e.replaceAll("%%", "");
    return (
      !/\\[uU]/.test(e) &&
      !ZSn.test(n) &&
      !twn.test(n) &&
      !e.replace(nwn, "").includes("%")
    );
  }

  function nIr(e: Command): boolean {
    let n = l1(e.argv),
      [r = "", a = ""] = n;
    if (!tIr.has(r) || !(E6e(e) || n.some(jxt))) return !1;
    if (r !== "printf") return !(r === "set" && a === "--");
    let h = a === "--" ? 2 : 1,
      y = n[h] ?? "",
      k = e.argv.length - n.length;
    return (
      (h === 1 && y.startsWith("-")) ||
      e.carveOutMayDesyncQuoteScan === !0 ||
      e.argvUnquotedGlob?.length !== e.argv.length ||
      e.argvUnquotedGlob[k + h] !== !1 ||
      jxt(y) ||
      !own(y)
    );
  }

  function VOe(e: string[], n: Input): boolean {
    return e.some((r) => ZMr.test(r)) && mbn(n);
  }

  function mbn(e: Input): boolean {
    return Ge.isSandboxingEnabled() || Vh(e);
  }

  function xkn(
    e: string[],
    n: (index: number) => boolean,
  ): { files: string[]; unseen: boolean } {
    let r: string[] = [],
      a = !1,
      h = !1,
      y = !1;
    for (let [k, E] of e.entries()) {
      let N: boolean = y,
        V = Lxr.test(E);
      if (((y = !N && Nxr.test(E)), (!h || N || !Vrt.test(E)) && n(k))) a = !0;
      if (!h && !N && jxr.test(E)) a = !0;
      h ||= !N && !E.startsWith("-");
      let oe = [...E.matchAll(Fxr)];
      if (
        oe.length > Akn ||
        (!N && E.startsWith("-") && !V) ||
        Ys(E) ||
        Dwn(E) !== !1
      )
        a = !0;
      for (let re of oe.slice(0, Akn)) {
        let _e = E.slice(re.index + re[0].length),
          ke = !0,
          Re = !1,
          xe = !1;
        for (let Pe of _e.matchAll($xr)) {
          let Be = Pe[0],
            Fe = Pe.index + Be.length;
          if (Be === ";" || Be === "}") break;
          if (Be === "|" || Be === "|&" || Be === '"' || Be === "\\") {
            a = !0;
            break;
          }
          if (Be === ">" || Be === ">>") {
            let Ke = Wxr.exec(_e.slice(Fe));
            if (Ke === null) {
              a = !0;
              break;
            }
            let [, Qe = "", ot = "", it = ""] = Ke,
              bt = [...ot.matchAll(/"([^"]*)"/g)].map((vt) => required(vt[1]));
            if (At(Qe, "(") !== At(it, ")") || (Qe === "" && bt.length > 1))
              a = !0;
            else {
              let vt = bt.join("");
              r.push(vt.startsWith("~") ? `./${vt}` : vt);
            }
            break;
          }
          if (Be === "/" && !Re) {
            let Ke = _e.indexOf("/", Fe);
            if (Ke !== -1 && /["#;}[]/.test(_e.slice(Fe, Ke))) {
              a = !0;
              break;
            }
          }
          if (
            Be ===
            `
`
          ) {
            if (ke || Re) break;
          } else if (!Be.startsWith("#") && Be.trim() !== "") {
            ke = !1;
            let Ke = Be.trimEnd();
            {
              xe ||= !Ke.startsWith('"') && Uxr.test(Ke);
              Re = !xe && Hxr.test(Ke) && !Bxr.test(Ke);
            }
          }
        }
      }
    }
    return { files: r, unseen: a };
  }

  function AIo(e: Command): NativeBashCwdWriteProfile {
    let n = l1(e.argv),
      [r, ...a] = n,
      h = r?.replace(/^.*[\\/]/, ""),
      y: string[] = [],
      k: string[] = [],
      E: string[] = [],
      N = !1,
      V = h !== void 0 && h !== "git" && $Oe.includes(h);
    if (V) {
      let oe = required(h),
        re = required(aM[oe])(a),
        _e = oe === "sed" ? oE(e.text) : "";
      if (DF[oe] === "read") {
        let ke = a.some(
          (Re) => /^-[A-Za-z]*o/.test(Re) || Re.startsWith("--o"),
        );
        if (
          ((N =
            (oe === "sort" && ke) ||
            (oe === "uniq" && re.length >= 2) ||
            (oe === "find" && a.some((Re) => QKt(Re)))),
          (oe === "base64" || oe === "sort" || m7e.has(oe)) &&
            je(FPr, { safe: !0 }))
        ) {
          let Re = e.argvUnquotedGlob,
            xe = (Re?.length ?? 0) - a.length,
            Pe = (Be: number) =>
              Re === void 0 ||
              Re.length < e.argv.length ||
              Re[xe + Be] === !0 ||
              (e.argvSourceLiteral !== !0 &&
                /^-*\\|[@+!]\(/.test(a[Be] ?? "")) ||
              /^~[-+0-9]/.test(a[Be] ?? "");
          if (m7e.has(oe)) {
            let Be = xkn(a, Pe);
            {
              y.push(...Be.files);
              N = Be.unseen;
            }
          } else
            N = ke || a.some((Be, Fe) => !Vrt.test(Be) && (Pe(Fe) || Ys(Be)));
        }
      } else if (oe !== "sed" || !PF(_e, { source: e })) {
        N = oe === "sed" && !PF(_e, { allowFileWrites: !0, source: e });
        let { targetDirectoryGiven: ke, attachedDestinations: Re } = fat(oe, a),
          xe = (oe === "cp" || oe === "mv") && !ke && re.length >= 2;
        if (xe && oe === "cp" && vSn(a)) {
          E = re.slice(0, -1);
          y.push(...re.slice(-1));
        } else y.push(...re);
        if ((y.push(...Re), (oe === "cp" || oe === "mv") && ESn(a))) N = !0;
        if (oe === "cp" && TSn(a, xe ? re.slice(0, -1) : ke ? re : [])) N = !0;
        k.push(...yat(re, oe === "cp" || oe === "mv" ? hat(a, re, Re) : []));
      }
    }
    for (let oe of e.redirects)
      if (WPr.has(oe.op) && !(oe.op === ">&" && /^(?:\d+|-)$/.test(oe.target)))
        y.push(oe.target);
    return {
      known: V,
      written: D(y).filter((oe) => !UOe(oe)),
      landings: D(k),
      copySources: D(E),
      writesUnseen: N,
    };
  }

  function xwn(
    e: Buffer,
    n: number,
    r: number,
    a: { start: number; end: number }[],
    h: { cwd: string; quoted: boolean },
  ): string | undefined {
    let y = "",
      k = n;
    for (let E of a) {
      let N = OVo.exec(e.subarray(E.start, E.end).toString())?.[1];
      if (
        N === void 0 ||
        E.start < k ||
        E.end > r ||
        (!h.quoted && !/^[\w./+@%:,-]+$/.test(h.cwd + N))
      )
        return;
      {
        y +=
          e.subarray(k, E.start).toString() +
          (h.quoted ? `"${h.cwd}${N}"` : h.cwd + N);
        k = E.end;
      }
    }
    return y + e.subarray(k, r).toString();
  }

  function Ewn(
    e: string,
    { commands: n, hasLoop: r }: Simple,
    a: string,
    h: (command: string) => boolean,
    y: (command: Command) => NativeBashCwdWriteProfile,
    k: (command: string) => boolean,
  ): string[] {
    if (/["$`\\!*?[\]{}\n\r]/.test(a)) return [];
    let E = Buffer.from(e),
      N = n.map(({ atShellCwd: ke }) => {
        let Re =
          ke && xwn(E, ke.start, ke.end, ke.words, { cwd: a, quoted: !0 });
        return Re !== void 0 && h(Re) ? Re : void 0;
      }),
      V = N.findLastIndex((ke) => ke !== void 0),
      oe = n
        .slice(0, r === !1 ? V : void 0)
        .findIndex(
          (ke, Re) =>
            ke.argv.includes("cd") ||
            (N[Re] === void 0 && !h(ke.text) && !y(ke).known),
        ),
      re = oe === -1 ? n.length : oe + 1;
    if (
      (oe !== -1 && r !== !1) ||
      N.slice(0, re).every((ke) => ke === void 0) ||
      N.slice(re).some((ke) => ke !== void 0 && k(ke))
    )
      return [];
    if (
      e.replaceAll("$PWD", "").includes("PWD") ||
      n.some(({ argv: ke }) => ke.some((Re) => Re.includes("PWD")))
    )
      return [];
    let _e = n
      .slice(0, re)
      .flatMap(({ atShellCwd: ke }, Re) =>
        N[Re] === void 0 ? [] : (ke?.words ?? []),
      )
      .sort((ke, Re) => ke.start - Re.start);
    return [!1, !0].flatMap(
      (ke) => xwn(E, 0, E.length, _e, { cwd: a, quoted: ke }) ?? [],
    );
  }

  function Own(
    e: string,
    n: Simple,
    r: string,
    a: (command: string) => boolean,
    h: (command: Command) => NativeBashCwdWriteProfile = AIo,
  ): string[] {
    return D([
      ...Ewn(e, n, r, a, h, a),
      ...Ewn(
        e,
        n,
        r,
        (y) => a(y) || (b4a(() => a(y)) && je(LMr, { safe: !0 })),
        h,
        a,
      ),
    ]);
  }

  return {
    main,
    host,
    native: { own, nIr, VOe, mbn, xkn, AIo, xwn, Ewn, Own },
    withPolicyScope<T>(
      permission: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return frames.run(
        { scope: { policyId: permission.scope.policyId, cwd }, receipts },
        () => main.withPolicyScope(permission, cwd, run, receipts),
      );
    },
  };
}
