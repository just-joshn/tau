import { NativeBashSecurityUnsupported } from "./security-types.js";
import type { NativeBashCommandProjection } from "../native-bash-command-projection.js";
import type {
  NativeBashSemantics,
  NativeBashSemanticCommand,
} from "../native-bash-semantics.js";
function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("Missing native sed invariant");
  return v;
}
export function createNativeBashSecuritySed(
  projection: NativeBashCommandProjection,
  semantics: NativeBashSemantics,
  quietPeacock: () => boolean,
) {
  const { staticArgv: iC, requiresComplexRead: JKs } = projection;
  const { Ys, E6e } = semantics.native;
  const Gxr = "bot_protected_tengu_quiet_peacock";
  const Lkn = "__SED_MULTIPLE_I_FLAGS__";
  const je = (_key: string, _options: { safe: boolean }) => quietPeacock();
  function Dkn(e: string[], n: string[]): boolean {
    for (let r of e)
      if (r.startsWith("-") && !r.startsWith("--") && r.length > 2)
        for (let a = 1; a < r.length; a++) {
          let h = "-" + r[a];
          if (!n.includes(h)) return !1;
        }
      else if (!n.includes(r)) return !1;
    return !0;
  }

  function zxr(e: string): boolean {
    if (!e) return !1;
    return /^(?:\d+|\d+,\d+)?p$/.test(e);
  }

  function Pkn(e: string, n: string[]): boolean {
    let r = iC(e);
    if (r[0] !== "sed") return !1;
    let h = r.slice(1).filter((E) => E.startsWith("-") && E !== "--");
    if (
      !Dkn(h, [
        "-n",
        "--quiet",
        "--silent",
        "-E",
        "--regexp-extended",
        "-r",
        "-z",
        "--zero-terminated",
        "--posix",
      ])
    )
      return !1;
    let k = !1;
    for (let E of h) {
      if (E === "-n" || E === "--quiet" || E === "--silent") {
        k = !0;
        break;
      }
      if (E.startsWith("-") && !E.startsWith("--") && E.includes("n")) {
        k = !0;
        break;
      }
    }
    if (!k) return !1;
    if (n.length === 0) return !1;
    for (let E of n) {
      let N = E.split(";");
      for (let V of N) if (!zxr(V.trim())) return !1;
    }
    return !0;
  }

  function Mkn(
    e: string,
    n: string[],
    r: boolean,
    a?: { allowFileWrites: boolean },
  ): boolean {
    let h = a?.allowFileWrites ?? !1;
    if (!h && r) return !1;
    let y = iC(e);
    if (y[0] !== "sed") return !1;
    let E = y.slice(1).filter((Be) => Be.startsWith("-") && Be !== "--"),
      N = ["-E", "--regexp-extended", "-r", "--posix"];
    if (h) N.push("-i", "--in-place");
    if (!Dkn(E, N)) return !1;
    if (n.length !== 1) return !1;
    let V = required(n[0]).trim();
    if (!V.startsWith("s")) return !1;
    let oe = V.match(/^s\/(.*?)$/);
    if (!oe) return !1;
    let re = required(oe[1]),
      _e = 0,
      ke = -1,
      Re = 0;
    while (Re < re.length) {
      if (re[Re] === "\\") {
        Re += 2;
        continue;
      }
      if (re[Re] === "/") {
        _e++;
        ke = Re;
      }
      Re++;
    }
    if (_e !== 2) return !1;
    let xe = re.slice(ke + 1);
    if (!/^[gpimIM]*[1-9]?[gpimIM]*$/.test(xe)) return !1;
    return !0;
  }

  function Vxr(e: string): string[] {
    let n: string[] = [],
      r = iC(e);
    if (r[0] !== "sed") return n;
    let a = r.slice(1);
    if (a.some((h) => /^-e[wWe]/.test(h) || /^-w[eE]/.test(h)))
      throw Error("Dangerous flag combination detected");
    if (a.length === 0) throw Error("No sed arguments");
    try {
      let h = !1,
        y = !1;
      for (let k = 0; k < a.length; k++) {
        let E = a[k];
        if (typeof E !== "string") continue;
        if ((E === "-e" || E === "--expression") && k + 1 < a.length) {
          h = !0;
          let N = a[k + 1];
          if (typeof N === "string") {
            n.push(N);
            k++;
          }
          continue;
        }
        if (E.startsWith("--expression=")) {
          {
            h = !0;
            n.push(E.slice(13));
          }
          continue;
        }
        if (E.startsWith("-e=")) {
          {
            h = !0;
            n.push(E.slice(3));
          }
          continue;
        }
        if (E.startsWith("-")) continue;
        if (!h && !y) {
          {
            n.push(E);
            y = !0;
          }
          continue;
        }
        break;
      }
    } catch (h) {
      throw Error(
        `Failed to parse sed command: ${h instanceof Error ? h.message : "Unknown error"}`,
      );
    }
    return n;
  }

  function qxr(e: string): boolean {
    let n = iC(e);
    if (n[0] !== "sed") return !1;
    let r = n.slice(1),
      a = 0,
      h = !1;
    for (let y = 0; y < r.length; y++) {
      let k = required(r[y]);
      if ((k === "-e" || k === "--expression") && y + 1 < r.length) {
        {
          h = !0;
          y++;
        }
        continue;
      }
      if (k.startsWith("--expression=")) {
        h = !0;
        continue;
      }
      if (k.startsWith("-e=")) {
        h = !0;
        continue;
      }
      if (k.startsWith("-")) continue;
      if ((a++, h)) return !0;
      if (a > 1) return !0;
    }
    return !1;
  }

  function Kxr(e: string): string | null {
    let n = iC(e);
    if (n[0] !== "sed") return null;
    let r = n.slice(1),
      a = [];
    for (let k = 0; k < r.length; k++) {
      let E = required(r[k]);
      if (E === "-i" || /^-[Er]+i$/.test(E)) a.push(k);
    }
    if (a.length === 0) return null;
    if (a.length > 1) return Lkn;
    let h = required(a[0]),
      y = r[h + 1];
    if (y === void 0) return null;
    if (y === "" || y.startsWith(".") || y.startsWith("-")) return null;
    for (let k = h + 2; k < r.length; k++) {
      let E = required(r[k]);
      if (E === "-e" || E === "--expression") return r[k + 1] ?? null;
      if (E.startsWith("--expression=")) return E.slice(13);
      if (E.startsWith("-")) continue;
      return E;
    }
    return null;
  }

  function Okn(e: string): boolean {
    let n = e.trim();
    if (!n) return !1;
    if (
      n.split("").some((c) => {
        const point = c.charCodeAt(0);
        return point < 1 || point > 127;
      })
    )
      return !0;
    if (n.includes("{") || n.includes("}")) return !0;
    if (
      n.includes(`
`) ||
      n.includes("\r")
    )
      return !0;
    let r = n.indexOf("#");
    if (r !== -1 && !(r > 0 && n[r - 1] === "s")) return !0;
    if (n.startsWith("!") || /[/\d$]!/.test(n)) return !0;
    if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(n)) return !0;
    if (n.startsWith(",")) return !0;
    if (/,\s*[+-]/.test(n)) return !0;
    if (/s\\/.test(n) || /\\[|#%@]/.test(n)) return !0;
    if (/\\\/.*[wW]/.test(n)) return !0;
    if (/\/[^/]*\s+[wWeE]/.test(n)) return !0;
    if (n.startsWith("s/") && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(n)) return !0;
    if (/^s./.test(n) && /[wWeE]$/.test(n)) {
      if (!/^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(n)) return !0;
    }
    if (
      /^[wW]\s*\S+/.test(n) ||
      /^\d+\s*[wW]\s*\S+/.test(n) ||
      /^\$\s*[wW]\s*\S+/.test(n) ||
      /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(n) ||
      /^\d+,\d+\s*[wW]\s*\S+/.test(n) ||
      /^\d+,\$\s*[wW]\s*\S+/.test(n) ||
      /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(n)
    )
      return !0;
    if (
      n.startsWith("e") ||
      /^\d+\s*e/.test(n) ||
      /^\$\s*e/.test(n) ||
      /^\/[^/]*\/[IMim]*\s*e/.test(n) ||
      /^\d+,\d+\s*e/.test(n) ||
      /^\d+,\$\s*e/.test(n) ||
      /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(n)
    )
      return !0;
    let a = n.match(/s([^\\\n]).*?\1.*?\1(.*?)$/);
    if (a) {
      let y = a[2] || "";
      if (y.includes("w") || y.includes("W")) return !0;
      if (y.includes("e") || y.includes("E")) return !0;
    }
    if (n.match(/y([^\\\n])/)) {
      if (/[wWeE]/.test(n)) return !0;
    }
    return !1;
  }

  function PF(
    e: string,
    n: {
      source: "none" | NativeBashSemanticCommand;
      allowFileWrites?: boolean;
    },
  ): boolean {
    let r = n.allowFileWrites ?? !1;
    if (JKs(e) || Ys(e)) return !1;
    if (n.source !== "none" && E6e(n.source) && je(Gxr, { safe: !0 }))
      return !1;
    let a;
    try {
      a = Vxr(e);
    } catch (N) {
      if (N instanceof NativeBashSecurityUnsupported) throw N;
      return !1;
    }
    let h = qxr(e),
      y = !1,
      k = !1;
    if (r) {
      y = Pkn(e, a);
      k = Mkn(e, a, h, { allowFileWrites: !0 });
    } else {
      y = Pkn(e, a);
      k = Mkn(e, a, h);
    }
    if (!y && !k) return !1;
    for (let N of a) if (k && N.includes(";")) return !1;
    for (let N of a) if (Okn(N)) return !1;
    let E = Kxr(e);
    if (E !== null) {
      if (E === Lkn) return !1;
      if (Okn(E)) return !1;
      let N = E.trimStart();
      if (/^[sy][^a-zA-Z0-9]/.test(N)) return !1;
      if (/^[\\$:={]/.test(N)) return !1;
      if (/^\d+[ \t]*[,!~=aAcCdDegGhHiIlnNpPqQrRsStTwWxyz]/.test(N)) return !1;
      if (/^[aAcCdDgGhHiIlnNpPqQtTwWxz=]([\s\\;]|$)/.test(N)) return !1;
      if (/^[rR]([\s\\;/]|\.{1,2}\/|$)/.test(N)) return !1;
      if (
        /^\/(?:[^/\\]|\\.)*\/[IMim]*[ \t]*([aAcCdDgGhHiIlnNpPqQtTwWxz=]([\s\\;]|$)|[rR]([\s\\;/]|\.{1,2}\/|$)|[sy][^a-zA-Z0-9]|[,!~])/.test(
          N,
        )
      )
        return !1;
      let V = N.replace(/^(\.{1,2}\/)+/, "");
      if (
        N.includes(";") ||
        N.includes("[") ||
        N.includes("\\") ||
        V.includes("..")
      )
        return !1;
    }
    return !0;
  }

  return {
    isReadOnly: PF,
    native: { PF, Dkn, zxr, Pkn, Mkn, Vxr, qxr, Kxr, Okn },
  };
}
