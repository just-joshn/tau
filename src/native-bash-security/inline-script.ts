import type { NativeBashSemantics } from "../native-bash-semantics.js";
import type { NativeBashCommandPreparation } from "../native-bash-command-preparation.js";
import type { createNativeBashSecurityPathControl } from "./path-control.js";
import type {
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityProvenance as Provenance,
} from "./security-types.js";
export interface NativeBashInlineScript {
  script: string;
  judged: string | undefined;
  homeWritten: boolean;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native inline-script invariant");
  return value;
}
export function createNativeBashInlineScript(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  pathOwner: ReturnType<typeof createNativeBashSecurityPathControl>,
) {
  if (pathOwner.semantic !== semantic || pathOwner.preparation !== preparation)
    throw new Error("Native Bash process owners must be shared");
  const { KI, k6e, dLe } = semantic.native;
  const abn = pathOwner.gate.bindings.w;
  const U = <T>(values: T[], fn: (value: T) => unknown) =>
    values.reduce((n, value) => n + +!!fn(value), 0);
  const At = (text: string, needle: string, from = 0) => {
    let n = 0;
    for (
      let i = text.indexOf(needle, from);
      i !== -1;
      i = text.indexOf(needle, i + 1)
    )
      n++;
    return n;
  };
  var SOe = new Set([
    "do",
    "then",
    "else",
    "elif",
    "if",
    "while",
    "until",
    "!",
    "{",
    "coproc",
  ]);

  var wOe = new Set([
    "sudo",
    "doas",
    "exec",
    "command",
    "env",
    "nice",
    "nohup",
    "busybox",
    "time",
    "timeout",
    "stdbuf",
    "setsid",
    "ionice",
    "pkexec",
    "runuser",
    "eval",
    "xargs",
  ]);

  var Vlt = new Set([
    ...wOe,
    ...SOe,
    ..."builtin noglob toybox trap watch flock chroot script".split(" "),
  ]);

  var Ibn = 2000;

  var yx = "__INLINE_SHELL_VALUE__";

  function P5e(e: string | undefined): string {
    return KI(e ?? "")
      .toLowerCase()
      .replace(/-\d+(?:\.\d+)*$/, "");
  }

  function u2(e: string, n = true): string[][] {
    return e
      .replace(n ? /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\.)*"/g : /(?!)/g, (r) =>
        r.startsWith("\\") ? r : r.replace(/[\s;&|()`{}!]/g, "\x00"),
      )
      .replace(/\d*[<>]&(?:\d+-?|-)(?![^\s;&|()])/g, " ")
      .replace(/\d*[<>]&|&>>?|>\|/g, ">")
      .replace(/\$(?=['"])|['"\\]/g, "")
      .split(/[;&|()`{}\n!]|\$\(/)
      .map((r) => {
        let a = r.split(/[ \t]+/).filter(Boolean);
        return a.filter(
          (h, y) =>
            !/^\d*[<>]/.test(h) &&
            !/^\d*[<>]+$/.test(a[y - 1] ?? "") &&
            !(
              /^\w+\+?=/.test(h) &&
              a.slice(0, y).every((k) => /^\w+\+?=/.test(k))
            ),
        );
      });
  }

  function tIe(e: string): string[] {
    return e.match(/(?:[^\s'"\\]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
  }

  function Xlt(e: string): boolean {
    let n = /^([^{]*)\{([^{}]*)\}(.*)$/s.exec(e.replace(/["'\\]/g, ""));
    return (
      n !== null &&
      required(n[2])
        .split(/,|\.\./)
        .some((r) => /(?:^|\/)rm(?:dir)?$/i.test(`${n[1]}${r}${n[3]}`))
    );
  }

  function Qwn(e: string): boolean {
    return (
      /\bfunction\b|\balias\b|\bIFS\b|\w\s*\(\s*\)|(?:^|[\s;&|(){}])(?:argv|[0-9]+)(?:\[[^\]]*\])?=|(?:^|[\s;&|(){}!])set\s[^;&|\n]*(?:\$\(|`)/.test(
        e,
      ) ||
      u2(e).some((n) =>
        n.some(
          (r, a) =>
            n.slice(0, a).every((h) => Vlt.has(h) || /^(?:-|\d+$)/.test(h)) &&
            (/^(?:shift|source|\.|eval|trap)$/.test(r) ||
              /^\$(?!\{?[0-9@*#])/.test(r) ||
              (r === "set" &&
                n
                  .slice(a + 1)
                  .some(
                    (h, y, k) =>
                      h === "-" ||
                      h === "--" ||
                      (!/^[-+]/.test(h) && !/[oO]$/.test(k[y - 1] ?? "")),
                  ))),
        ),
      )
    );
  }

  function NOr(e: string): boolean {
    let n = e.replace(/\$\{[^{}]*\}/g, "$X"),
      r = U(Array.from(n), (E) => E === "{");
    if (r === 0 || !/,|\.\./.test(n)) return !1;
    let a = /^([^{]*)\{([^{}]*)\}(.*)$/s.exec(n);
    if (r > 1 || a === null) return !0;
    let [, h = "", y = "", k = ""] = a;
    if (!/,|\.\./.test(y)) return !1;
    return (
      /^["']?[/~$]|[{},\\'"]|\.\./.test(h) ||
      /[~{},\\'"]/.test(k) ||
      y
        .split(/,|\.\./)
        .map((E) => E.replace(/["'\\]/g, ""))
        .some(
          (E) =>
            /[/~$*?[]|^\.\.?$|\brm/.test(E) ||
            (E === "" && /[$]|^["']?\//.test(h + k)) ||
            Xlt(e),
        )
    );
  }

  function P8(e: string): boolean {
    let n = (a: string) =>
        /^(?:\w*=)?rm(?:dir)?$/i.test(KI(a.replace(/\d*[<>].*$/s, ""))) ||
        /(?:^|,)rm(?:dir)?(?:,|\$)/i.test(a),
      r = (a: string) => Vlt.has(KI(a).toLowerCase());
    return (
      [...u2(e), ...u2(e, !1)].some(
        (a) =>
          a.some(
            (h, y) =>
              n(h) &&
              a.some(
                (k, E) =>
                  E !== y &&
                  (r(k) ||
                    dLe(k, "c") ||
                    /^-(?:exec(?:dir)?|ok(?:dir)?)$/.test(k)),
              ),
          ) ||
          a.some(
            (h, y) =>
              (n(h) || h.startsWith("$")) && (y === 0 || r(required(a[y - 1]))),
          ) ||
          a.some((h) => /^\w+=(?:\S*\/)?rm(?:dir)?$/i.test(h)),
      ) || tIe(e).some(Xlt)
    );
  }

  function FOr(e: string[]): NativeBashInlineScript | undefined {
    let [n = "", ...r] =
      (P5e(e[0]) === "busybox" || P5e(e[0]) === "toybox") && k6e.has(P5e(e[1]))
        ? e.slice(1)
        : e;
    if (!k6e.has(P5e(n))) return;
    let a = !1,
      h = !1,
      y = 0;
    for (; y < r.length; y++) {
      let Ke = required(r[y]);
      if (Ke === "-" || Ke === "--") {
        y++;
        break;
      }
      if (!/^[-+]./.test(Ke)) break;
      let Qe = /^(?:r?ba)?sh$/.test(P5e(n))
        ? /^--?(?:login|posix|noprofile|norc|noediting|verbose|restricted|debugger|dump-(?:po-)?strings|wordexp|pretty-print|help|version|(rcfile|init-file))$/.exec(
            Ke,
          )
        : null;
      if (Qe !== null) y += Qe[1] === void 0 ? 0 : 1;
      else if (Ke.startsWith("--")) h = !0;
      else {
        h ||=
          (/^(?:r?ba)?sh$/.test(P5e(n)) &&
            /[^abcefhiklmnoprstuvxBCDEHIOPT]/.test(Ke.slice(1))) ||
          (P5e(n).endsWith("ksh") && /[oO]./.test(Ke));
        a ||= Ke.startsWith("-") && Ke.includes("c");
        y += Ke.match(/[oO]/g)?.length ?? 0;
      }
    }
    if (h)
      return r.some((Ke) => /^-[A-Za-z]*c/.test(Ke))
        ? { script: r.join(" "), judged: void 0, homeWritten: !1 }
        : void 0;
    let k = r[y];
    if (!a || k === void 0) return;
    if (k.length > Ibn) return { script: k, judged: void 0, homeWritten: !1 };
    if (
      tIe(k).some(NOr) ||
      /\balias\b/.test(k) ||
      /\bIFS\b/.test(
        k.replace(
          /(?:^|[;&|\n({]\s*)(?:(?:do|then|else|elif|if|while|until)\s+)?IFS=(?:'[^']*'|"[^"]*"|[^\s;&|'"\\])*[ \t]+read\b/g,
          " read",
        ),
      ) ||
      (P5e(n) === "zsh" &&
        /(?:^|[\s;&|(){}])=(?!=)\S|\$\{?\w+\}?(?::[htrelquQxsaAcP&]|\[)|\bargv\b|\$(?:[=~^]|\{[=~^(])|\(:/.test(
          k,
        ))
    )
      return { script: k, judged: void 0, homeWritten: !1 };
    let E = abn(),
      N = E.includes("\\") ? "$HOME" : E,
      V = !1,
      oe = (Ke: string, Qe: string | undefined) =>
        Ke.endsWith("$HOME") && /\w/.test(Qe ?? ""),
      re = (Ke: string | undefined): NativeBashInlineScript => ({
        script: k,
        judged:
          V &&
          (/[\s*?[]/.test(E) ||
            /HOME/.test(
              (Ke ?? "")
                .split("$HOME")
                .join("")
                .replace(/["'\\]/g, ""),
            ))
            ? void 0
            : Ke,
        homeWritten: V,
      }),
      _e = k;
    if (N !== E && k.includes(E)) {
      let Ke = k.split(E);
      if (
        k.includes("'") ||
        Ke.slice(1).some((Qe) => oe(N, Qe[0])) ||
        Ke.slice(0, -1).some((Qe) => Qe.endsWith("\\"))
      )
        return { script: k, judged: void 0, homeWritten: V };
      {
        _e = Ke.join(N);
        V = !0;
      }
    }
    if (!/\$(?:\{[!#@*0-9]|[#@*0-9])/.test(k)) return re(_e);
    let ke = [r[y + 1] ?? n, ...r.slice(y + 2)],
      Re = (Ke: string) => /^[\w./@%+=:,*?[\]!^{} \t\n-]*$/.test(Ke),
      xe = (Ke: string): string | undefined => {
        let Qe = /^~(?=\/|$)/.test(Ke)
          ? Ke.slice(1)
          : N !== E &&
              (Ke === E || Ke.startsWith(`${E}\\`) || Ke.startsWith(`${E}/`))
            ? Ke.slice(E.length).replace(/\\/g, "/")
            : void 0;
        if (Qe === void 0)
          return Ke.startsWith("~")
            ? void 0
            : Re(Ke)
              ? Ke.replace(/[\t\n]/g, " ")
              : yx;
        return (
          (V ||= N !== E),
          Re(N === E ? E + Qe : Qe) ? (N + Qe).replace(/[\t\n]/g, " ") : yx
        );
      },
      Pe = ke.map(xe);
    if (
      /\$\{(?![0-9]+(?:\}|:?\?[^}$`]*\})|[@*#]\})[!#@*0-9]/.test(k) ||
      k.includes("'") ||
      Qwn(k) ||
      Pe.includes(void 0)
    )
      return re(void 0);
    let Be = !0,
      Fe = _e.replace(
        /\\[\s\S]|"\$\{?@\}?"|\$\{([0-9]+)(:?)\?[^}]*\}|\$(?:\{([0-9]+|[@*#])\}|([0-9@*#]))/g,
        (
          Ke: string,
          Qe: string | undefined,
          ot: string | undefined,
          it: string | undefined,
          bt: string | undefined,
          vt: number,
        ) => {
          let Ct = it ?? bt,
            Pt = (Dt: string) => ((Be &&= !oe(Dt, _e[vt + Ke.length])), Dt);
          if (Ke.startsWith('"')) {
            let Dt = _e.slice(0, vt).replace(/\\[\s\S]/g, "");
            return (
              (Be &&= At(Dt, '"') % 2 === 0),
              Pe.slice(1)
                .map((Lt) => `"${Lt}"`)
                .join(" ")
            );
          }
          if (Qe !== void 0) {
            let Dt = Pe[Number(Qe)],
              _Lt = "${__INLINE_SHELL_GUARDED__:?}";
            return Dt === void 0
              ? "${__INLINE_SHELL_GUARDED__:?}"
              : Dt === "" || Dt === yx
                ? ot
                  ? "${__INLINE_SHELL_GUARDED__:?}"
                  : Dt
                : Pt(Dt);
          }
          if (Ct === void 0) return Ke;
          if (Ct === "#") return String(ke.length - 1);
          if (Ct === "@" || Ct === "*")
            return ((Be &&= ke.length <= 2), Pt(Pe[1] ?? ""));
          return Pt(Pe[Number(Ct)] ?? "");
        },
      );
    return re(Be && !Qwn(Fe) ? Fe : void 0);
  }

  return {
    semantic,
    preparation,
    pathOwner,
    constants: { Vlt, yx, Ibn },
    native: { P5e, u2, tIe, Xlt, Qwn, NOr, P8, FOr },
    withPolicyScope<T>(
      policy: Policy,
      cwd: string,
      run: () => T,
      receipts: Provenance[] = [],
    ) {
      return pathOwner.withPolicyScope(policy, cwd, run, receipts);
    },
  };
}
