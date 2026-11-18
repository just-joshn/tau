import type { NativeBashSemantics } from "../native-bash-semantics.js";
import type { NativeBashCommandPreparation } from "../native-bash-command-preparation.js";
import type { createNativeBashSecurityPathControl } from "./path-control.js";
import type {
  NativeBashSecurityDecision as Decision,
  NativeBashSecurityPolicy as Policy,
  NativeBashSecurityProvenance as Provenance,
} from "./security-types.js";
export interface NativeBashLiteralDerivedValue {
  value: string;
  becomes: string;
}
export interface NativeBashLiteralAssignments {
  set: ReadonlySet<string>;
  emptied: ReadonlySet<string>;
  rootValued: ReadonlySet<string>;
  derived: ReadonlyMap<string, NativeBashLiteralDerivedValue>;
}
export interface NativeBashLiteralRemovalOptions {
  mayBeUnset: (name: string) => boolean;
  wholeCommand?: string | undefined;
  skipAssignedOriginalHits?: boolean | undefined;
  assignments?: NativeBashLiteralAssignments | undefined;
}
interface Config {
  mayBeUnset: (name: string) => boolean;
  derived: ReadonlyMap<string, NativeBashLiteralDerivedValue>;
  assigned: ReadonlySet<string>;
  evalStrings: boolean;
  skipAssignedOriginalHits?: boolean | undefined;
}
export interface NativeBashLiteralRemovalCandidate {
  command: "rm" | "rmdir";
  target: string;
  invocation: string;
  reparsed: boolean;
  rootChild?: string;
  assigned?: boolean;
  derived?: NativeBashLiteralDerivedValue;
}
type Candidate = NativeBashLiteralRemovalCandidate;
interface Head {
  command: "rm" | "rmdir";
  word: string;
  tokens: string[];
  reparsed: boolean;
}
type Quote = "'" | '"' | null;
interface AssignmentEvent {
  index: number;
  names: string[];
  bound: boolean | null;
  rootish: boolean;
  until: number;
}
interface AssignmentTail {
  end: number;
  prefix: boolean;
  conditional: boolean;
}
function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing native literal-removal invariant");
  return value;
}
export function createNativeBashLiteralRemoval(
  semantic: NativeBashSemantics,
  preparation: NativeBashCommandPreparation,
  pathOwner: ReturnType<typeof createNativeBashSecurityPathControl>,
) {
  if (pathOwner.semantic !== semantic || pathOwner.preparation !== preparation)
    throw new Error("Native Bash process owners must be shared");
  const { D, op } = pathOwner.gate.bindings;
  const { OOe, nb } = pathOwner.native;
  const Sy = preparation.projection.splitCommands;
  const k6e = semantic.native.k6e;
  var tPr = new Set([
    "HOME",
    "USERPROFILE",
    "HOMEPATH",
    "HOMEDRIVE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "WINDIR",
    "PROGRAMFILES",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "HOMESHARE",
    "XDG_RUNTIME_DIR",
    "PWD",
    "OLDPWD",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]);

  const Z = (text: string, end: number) => {
    if (end <= 0) return "";
    if (text.length <= end) return text;
    let value = text.slice(0, end),
      last = value.charCodeAt(end - 1);
    if (last >= 55296 && last <= 56319) value = value.slice(0, -1);
    return Buffer.from(value, "utf16le").toString("utf16le");
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

  var Qkn =
    /^[\uE020"']*\$(?:\{[A-Za-z_][A-Za-z0-9_]*(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|[A-Za-z_][A-Za-z0-9_]*)[\uE020"']*\\?\/(?:[*?[{]|\$|\/|["']|\uE020|$)/;

  var aPr =
    /^[\uE020"']*\$(?:\{(?:[0-9]+|[@*!])(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|[0-9@*!])[\uE020"']*\\?\/(?:[*?[{]|\$|\/|["']|\uE020|$)/;

  var Zkn =
    "bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|snap|nix|lost\\+found|private|cores|Applications|Library|System|Users|Volumes|Windows|ProgramData|cygdrive";

  var dPr = new RegExp(
    String.raw`^[\uE020"']*\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-(?:["']{2}|"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?)?)?\}|([A-Za-z_][A-Za-z0-9_]*))[\uE020"']*\\?\/(${Zkn})(?:[\\/]+\*+)*\/?[\uE020"']*$`,
    "i",
  );

  var uPr = /^\s*(?:(cd|pwd|dirname)(?![A-Za-z0-9_-])|git\s+(rev-parse)\b)/;

  const cPr: Config = {
    mayBeUnset: () => !1,
    derived: new Map(),
    assigned: new Set(),
    evalStrings: !1,
  };

  var $kn = 1e4;

  var bOe = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=/g;

  var fPr =
    /(?:^|[;&|({\n]|\b(?:then|do|else|elif)\b|!)[ \t]*unset[ \t]+(?:-[a-z][ \t]+)*((?:[A-Za-z_][A-Za-z0-9_]*[ \t]*)+)/g;

  var pPr =
    /(?:^|[;&|({\n]|\b(?:then|do|else|elif)\b)\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]*)/g;

  var AOe = "\uE020";

  var SPr =
    /(?:^|[;&|(\n])[ \t]*(?:function[ \t]+[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\))/;

  var wPr =
    /(?:^|[;&|(\n])[ \t]*set[ \t]+--[ \t]+(?!["']{2}(?:[\s;&|]|$)|["']?\$)[^\s;&|]/;

  var bPr = new RegExp(
    String.raw`(?:^|[\s;&|(])(?:[^\s=]*\/)?(?:busybox\s+)?(?:${[...k6e].join("|")})\s+(?:(?:--?|\+)[A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z0-9_][A-Za-z0-9_-]*)?\s+)*-[A-Za-z]*c[A-Za-z]*\s+(?:--\s+)?\$?(["'])`,
    "gi",
  );

  var dat = 2;

  var Bde = 120;

  var TPr =
    /^-(?:exec|execdir|ok|okdir|name|iname|path|ipath|regex|prune|type|maxdepth|mindepth|newer|mtime|mmin|size|print0?|delete|o|a|not|and|or)$/;

  var IOe = ";|&\n\r()` \t";

  var Ude = 57345;

  var vPr = new RegExp(
    `[\\u${Ude.toString(16)}-\\u${(Ude + IOe.length - 1).toString(16)}]`,
    "g",
  );

  var EOe = "\uE010";

  function Bkn(e: string): string {
    return e.replace(/(^|[^\\])\)+$/, "$1");
  }

  function CPr(e: string): string {
    if (!e.includes('"') && !e.includes("'") && !/\\[ \t]/.test(e)) return e;
    if (DOe(e, e.length) !== null) return e;
    let n = "",
      r: Quote = null;
    for (let a = 0; a < e.length; a++) {
      let h = e[a];
      if (h === "\\" && w8(e, a, r)) {
        let k = e[a + 1] ?? "",
          E = r === null ? IOe.indexOf(k) : -1;
        {
          n +=
            h +
            (E !== -1 && (k === " " || k === "\t")
              ? String.fromCharCode(Ude + E)
              : k);
          a++;
        }
        continue;
      }
      if (r === null) {
        if (h === '"' || h === "'") r = h;
        n += h;
        continue;
      }
      if (h === r) {
        {
          r = null;
          n += h;
        }
        continue;
      }
      let y = IOe.indexOf(required(h));
      n += y === -1 ? h : String.fromCharCode(Ude + y);
    }
    return n;
  }

  function DOe(e: string, n: number): Quote {
    let r: Quote = null;
    for (let a = 0; a < n; a++) {
      let h = e[a];
      if (h === "\\" && w8(e, a, r)) {
        a++;
        continue;
      }
      if (r === null) {
        if (h === '"' || h === "'") r = h;
      } else if (h === r) r = null;
    }
    return r;
  }

  function EPr(
    e: Head,
    n: boolean,
    r: boolean,
    a: boolean,
    h: Config,
  ): Candidate | null {
    let { command: y, tokens: k } = e;
    for (let E = 0; E < k.length; E++) {
      let N = required(k[E]).replace(/[)\]}]+$/, "");
      if (N === "" || N.startsWith("-") || (!r && /^'[^']*\$/.test(N)))
        continue;
      if (/^[\d&]*[<>]/.test(N)) {
        if (/^(?:[0-9]+|&)?(?:>>?[|&]?|<<?<?|<>)$/.test(N)) E++;
        continue;
      }
      let V = h.derived.get(aSn(iSn(N)) ?? ""),
        oe = tSn(N, h.mayBeUnset),
        re = Qkn.test(N) || (n && aPr.test(N)),
        _e = h.assigned.has(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(N)?.[1] ?? "");
      if (re && h.skipAssignedOriginalHits === !0 && _e) continue;
      if (re || oe !== void 0 || V !== void 0) {
        let ke = Zrt([Bkn(required(k[E]))]),
          Re = [e.word, ...k.slice(0, -1), Bkn(required(k.at(-1)))],
          xe = Zrt(Re),
          Pe = xe;
        if (xe.length > Bde) {
          let Be = Z(xe, Bde);
          Pe =
            Zrt(Re.slice(0, E + 2)).length <= Bde
              ? `${Be}\u2026`
              : `${Be}\u2026 ${ke}`;
        }
        return {
          command: y,
          target: ke,
          invocation: Pe,
          reparsed: a || e.reparsed,
          ...(oe !== void 0 && { rootChild: oe }),
          ...(re && _e && { assigned: _e }),
          ...(V !== void 0 && {
            derived: {
              becomes: V.becomes,
              value: ((Be) => (Be.length > Bde ? `${Z(Be, Bde)}\u2026` : Be))(
                V.value.replace(/[\s\p{Cc}]+/gu, " "),
              ),
            },
          }),
        };
      }
    }
    return null;
  }

  function FOe(
    e: string,
    n?: NativeBashLiteralRemovalOptions,
  ): Candidate | null {
    if (!e.includes("$") || !/\brm(?:dir)?\b/i.test(e)) return null;
    e = e.replace(/[\uE000-\uF8FF]/g, "");
    let r = cPr;
    if (n !== void 0) {
      let {
        set: y,
        emptied: k,
        rootValued: E,
        derived: N,
      } = n.assignments ?? aat(n.wholeCommand ?? e, n.mayBeUnset);
      r = {
        mayBeUnset: (V) =>
          k.has(V) || (!y.has(V) && !eSn(V) && n.mayBeUnset(V)),
        derived: N,
        assigned: new Set([...y].filter((V) => !E.has(V))),
        evalStrings: !0,
        skipAssignedOriginalHits: n.skipAssignedOriginalHits,
      };
    }
    let a = !SPr.test(YK(e, !0)) && !wPr.test(YK(e, !1)),
      h = Sy(e);
    for (let y of h) {
      let k = Xit(y, a, 0, !0, !1, r);
      if (k !== null) return k;
    }
    for (let y of h) {
      let k = Xit(y, !1, 0, !1, !1, r);
      if (k !== null) return k;
    }
    return null;
  }

  function Hkn(e: string, n: boolean): Head | null {
    let r = e.split(/\s+/).filter((V) => V !== ""),
      a = 0;
    while (a < r.length) {
      let V = required(r[a]);
      if (TOe(V) !== null) break;
      if (
        SOe.has(V.toLowerCase()) ||
        /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(V) ||
        /^[$\uE020]/.test(V)
      )
        a++;
      else if (/^[\d&]*[<>]/.test(V)) {
        if ((a++, /^(?:[0-9]+|&)?(?:>>?[|&]?|<<?<?|<>)$/.test(V))) a++;
      } else break;
    }
    let h = (V: string) =>
        V.replace(/^\\/, "")
          .replace(/^[^\s=]*\//, "")
          .toLowerCase(),
      y = !1,
      k = (V: string) => (n && y ? V.replace(/^\$?['"]/, "") : V),
      E = (V: string) => {
        let oe = h(k(V));
        return wOe.has(oe) || (n && oe === "trap");
      };
    while (a < r.length && E(required(r[a]))) {
      let V = h(k(required(r[a])));
      {
        y ||= V === "eval" || V === "trap";
        a++;
      }
      while (a < r.length) {
        let oe = k(required(r[a]));
        if (TOe(oe) !== null || E(oe)) break;
        if (/^[\d&]*[<>]/.test(oe)) {
          if ((a++, /^(?:[0-9]+|&)?(?:>>?[|&]?|<<?<?|<>)$/.test(oe))) a++;
          continue;
        }
        if (oe.startsWith("-")) {
          a++;
          let re = r[a] === void 0 ? void 0 : k(required(r[a]));
          if (
            re !== void 0 &&
            !re.startsWith("-") &&
            !re.includes("=") &&
            TOe(re) === null &&
            !E(re)
          )
            a++;
          continue;
        }
        if (
          /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(oe) ||
          /^\d/.test(oe) ||
          /^[$\uE020]/.test(oe)
        ) {
          a++;
          continue;
        }
        break;
      }
    }
    let N = a < r.length ? TOe(k(required(r[a]))) : null;
    return N === null
      ? null
      : {
          command: N,
          word: required(r[a]),
          tokens: r.slice(a + 1),
          reparsed: y,
        };
  }

  function Jrt(e: string): boolean {
    let n = e.replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/(.)\/+$/, "$1"),
      r = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$`]*)\}$/.exec(n)?.[1];
    return (
      /^\/+$/.test(n) ||
      /(?:^|\/)\.\.?\/*$/.test(n) ||
      /^\$\{?HOME\}?$/.test(n) ||
      (!/[$`]/.test(n) && OOe(op(n))) ||
      (r !== void 0 && r !== "" && OOe(op(r)))
    );
  }

  function LOe(e: Candidate, n: boolean): Decision {
    let { command: r, target: a, invocation: h, reparsed: y } = e,
      k: string[] = [],
      E: { name: string; written: string; guarded: string }[] = [],
      N = a.replace(
        /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*!])(?::?-(?:["']{2}|"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?)?)?\}|([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*!]))/g,
        (
          ke: string,
          Re: string | undefined,
          xe: string | undefined,
          Pe: string | undefined,
          Be: number,
        ) => {
          let Fe = required(Re ?? Pe);
          k.push(Fe);
          let Ke = `\${${Fe}:?}`;
          if (xe !== void 0) {
            k.push(xe);
            Ke = `\${${Fe}:-\${${xe}:?}}`;
          }
          if (DOe(a, Be) === null) Ke = `"${Ke}"`;
          return (E.push({ name: Fe, written: ke, guarded: Ke }), Ke);
        },
      ),
      V = k.length === 0 ? ["VAR"] : D(k),
      oe = V.map((ke) => `$${ke}`).join(" or "),
      re = (ke: boolean): string => {
        let Re = ke ? "`" : "";
        if (e.rootChild !== void 0) {
          if (y)
            return ke
              ? `use a literal absolute path: when ${oe} is empty this ${r} removes /${e.rootChild}, and the ${r} is parsed again before it runs (it is inside a quoted string or after eval), so a pasted guard's quotes would not protect it`
              : `use a literal path: when ${oe} is empty this removes /${e.rootChild}, and the ${r} is parsed again before it runs`;
          return ke
            ? `rewrite it as ${Re}${N}${Re}, which makes the shell stop with an error instead of removing /${e.rootChild} when ${oe} is unset or empty (it is not set in the environment this command inherits), or use a literal absolute path`
            : `rewrite it as ${N} or use a literal path: when ${oe} is empty this removes /${e.rootChild}`;
        }
        let xe = V.filter((Ke) => tPr.has(Ke.toUpperCase()))
          .map((Ke) => `$${Ke}`)
          .join(" or ");
        if (xe !== "")
          return ke
            ? `use a literal absolute path: ${xe} is normally set, so a guard on it would not stop this ${r}`
            : `use a literal path: ${xe} is normally set, so a guard would not stop this`;
        let Pe = (Ke: string) => /^(?:[0-9]+|[@*!])$/.test(Ke),
          Be = V.filter(Pe);
        if (Be.length > 0) {
          let Ke = E.filter((ot) => !Pe(ot.name) && !y)
              .map(
                ({ written: ot, guarded: it }) =>
                  `${Re}${ot}${Re} as ${Re}${it}${Re}`,
              )
              .join(" and "),
            Qe =
              `bind ${Be.map((ot) => `$${ot}`).join(" or ")}` +
              (Ke === "" ? "" : ` and rewrite its ${Ke}`);
          return ke
            ? `${Qe} (in an inline \`sh -c\` script, single-quote the script so this shell does not expand the positional) or use a literal absolute path`
            : `${Qe} or use a literal path`;
        }
        if (y)
          return ke
            ? `use a literal absolute path: this ${r} is parsed again before it runs (it is inside a quoted string or after eval), so a pasted guard's quotes would not protect it`
            : `use a literal path: the ${r} is parsed again before it runs`;
        let Fe = E.reduce((Ke, Qe) => Ke.replace(Qe.guarded, ""), N);
        if (E.length === 0 || Fe.includes("$"))
          return ke
            ? "use a literal absolute path: this check cannot verify part of this target"
            : "use a literal path: this check cannot verify part of this target";
        return ke
          ? `rewrite it as ${Re}${N}${Re}, which makes the shell stop with an error instead of running ${r} when ${oe} is unset or empty, or use a literal absolute path`
          : `rewrite it as ${N} or use a literal path`;
      },
      _e = n ? " (inside a command substitution)" : "";
    if (e.derived !== void 0) {
      let { value: ke, becomes: Re } = e.derived,
        xe = aSn(iSn(a)) ?? required(V[0]);
      return nb(
        r,
        `Dangerous ${r} operation detected in \`${h}\`${_e}. This command sets $${xe} from \`${ke}\`, which ${Re}, so this ${r} can remove that directory. A \`\${${xe}:?}\` guard does not help, because $${xe} is not empty. This requires explicit approval and cannot be auto-allowed by permission rules.

Use a literal absolute path instead.`,
        `on possibly-empty variable path${n ? " inside command substitution" : ""}: ${a} in \`${h}\` (use a literal path: $${xe} is set in this command from ${ke}, which ${Re})`,
        "derived_var",
      );
    }
    return nb(
      r,
      `Dangerous ${r} operation detected in \`${h}\`${_e}. The target '${a}' is a shell variable expansion: when ${oe} is unset or empty it ` +
        (e.rootChild === void 0
          ? "becomes `/`, `/*` or a top-level path. "
          : `becomes \`/${e.rootChild}\`. `) +
        `This requires explicit approval and cannot be auto-allowed by permission rules.

` +
        (e.rootChild === void 0
          ? `This check does not fire on a target that cannot expand to the filesystem root: ${re(!0)}.`
          : `This check does not fire on a target that cannot expand to a top-level directory: ${re(!0)}.`),
      `on possibly-empty variable path${n ? " inside command substitution" : ""}: ${a} in \`${h}\` (${re(!1)})`,
      e.rootChild !== void 0
        ? "var_root_child"
        : e.assigned
          ? "variable_path_set_in_command"
          : "variable_path",
    );
  }

  function RPr(e: string, n: boolean, r: number, a: Config): Candidate | null {
    let h = DOe(e, e.length) === null;
    for (let y of e.matchAll(bPr)) {
      if (h && DOe(e, y.index) !== null) continue;
      let k = y[1],
        N = y.index + y[0].length - 1,
        V: Quote = null,
        oe: { q: Quote; text: string }[] = [],
        re = "";
      for (; N < e.length; N++) {
        let Fe = required(e[N]);
        if (Fe === "\\" && w8(e, N, V)) {
          {
            re += Fe + (e[N + 1] ?? "");
            N++;
          }
          continue;
        }
        if (V === null) {
          if (/\s/.test(Fe)) break;
          if (Fe === '"' || Fe === "'") {
            if (re !== "") {
              oe.push({ q: V, text: re });
              re = "";
            }
            V = Fe;
            continue;
          }
        } else if (Fe === V) {
          {
            oe.push({ q: V, text: re });
            re = "";
            V = null;
          }
          continue;
        }
        re += Fe;
      }
      if (re !== "") oe.push({ q: V, text: re });
      let _e = uat(
          oe
            .map((Fe) =>
              Fe.q === '"'
                ? Fe.text
                    .replace(/\\(["\\$`])/g, (Ke: string, Qe: string) =>
                      Qe === "$" ? EOe : Qe,
                    )
                    .replace(/\uE010(?=[A-Za-z_]|\{[A-Za-z_])/g, "$")
                    .replace(/\\+(?=\$)/g, "")
                : Fe.q === "'"
                  ? `'${Fe.text}'`
                  : Fe.text,
            )
            .join(""),
        ),
        ke = e
          .slice(N)
          .replace(/\\ /g, "\uE022")
          .replace(/(?:^|\s)[\d&]*(?:>>?[|&]?|<<?<?|<>|&>)(?:\S+|\s+\S+)/g, " ")
          .replace(/\s*(?:\\;|\\|\+)\s*$/, "")
          .trim(),
        Re =
          (ke !== "" && ke.split(/\s+/).length >= 2) ||
          /(?:^|\s)xargs(?:\s+(?!-[In]\b)\S+)*\s*$/.test(e.slice(0, y.index)),
        xe = _e,
        Pe;
      if (k === '"') {
        if (!Re) xe = xe.replaceAll(EOe, "$");
        Pe = n || !Re;
      } else {
        xe = xe.replace(/^'([\s\S]*)'$/, "$1");
        Pe = !Re;
      }
      let Be = Xit(xe, Pe, r, !0, k === '"', a);
      if (Be !== null)
        return {
          ...Be,
          target: Be.target.replaceAll(EOe, "\\$"),
          invocation: Be.invocation.replaceAll(EOe, "\\$"),
        };
    }
    return null;
  }

  function TOe(e: string): "rm" | "rmdir" | null {
    let n = e
      .replace(/[<>].*$/, "")
      .replace(/^\\/, "")
      .replace(/^[^\s=]*\//, "")
      .toLowerCase();
    return n === "rm" ? "rm" : n === "rmdir" ? "rmdir" : null;
  }

  function Ukn(e: string): string {
    return uat(e.replace(/['"]/g, ""));
  }

  function Xit(
    e: string,
    n: boolean,
    r: number,
    a: boolean,
    h: boolean,
    y: Config,
  ): Candidate | null {
    let k = e.replace(/\\\r?\n/g, " "),
      E = (a ? CPr(k) : k).replace(/(?<!\\)`[^`]*`/g, AOe).trimStart();
    while (E.startsWith("(") || E.startsWith("{")) E = E.slice(1).trimStart();
    for (let N = ""; N !== E;) {
      N = E;
      E = E.replace(/\$\([^()]*\)/g, AOe).replace(
        /(?<![$\\])\([^()]*(?<!\\)\)/g,
        AOe,
      );
    }
    E = E.replace(/(?<![<>&])&(?![<>&])/g, ";");
    for (let N of E.split(/[;|\n\r]|&&/)) {
      let V = N.replace(/^[\s\uE020]+/, ""),
        oe = Hkn(V, y.evalStrings),
        re = oe === null ? [] : [oe];
      for (let _e of V.matchAll(/(?:^|\s)-(?:exec|ok)(?:dir)?\s+/g)) {
        if (re.length >= 8) break;
        let ke = Hkn(V.slice(_e.index + _e[0].length), y.evalStrings);
        if (ke !== null) {
          let Re = !1,
            xe = ke.tokens.findIndex((Pe, Be, Fe) => {
              let Ke = Ukn(Pe);
              if (Ke === "--") Re = !0;
              return (
                Ke === "\\;" ||
                Ke === ";" ||
                Ke === "\\" ||
                (Ke === "+" && Ukn(Fe[Be - 1] ?? "") === "{}") ||
                (!Re && TPr.test(Ke))
              );
            });
          re.push(xe === -1 ? ke : { ...ke, tokens: ke.tokens.slice(0, xe) });
        }
      }
      for (let _e of re) {
        let ke = EPr(_e, n, h, !a || h, y);
        if (ke !== null) return ke;
      }
      if (a && r < dat) {
        let _e = RPr(V, r === 0 || n, r + 1, y);
        if (_e !== null) return _e;
      }
    }
    return null;
  }

  function YK(e: string, n: boolean): string {
    let r = "",
      a: Quote = null,
      h = !1;
    for (let y = 0; y < e.length; y++) {
      let k = required(e[y]);
      if (h) {
        if (
          k ===
          `
`
        ) {
          h = !1;
          r += k;
        } else r += " ";
        continue;
      }
      if (a === null) {
        if (k === "\\") {
          {
            r += k + (e[y + 1] ?? "");
            y++;
          }
          continue;
        }
        if (k === "#" && (y === 0 || /[\s;&|()]/.test(required(e[y - 1])))) {
          {
            h = !0;
            r += " ";
          }
          continue;
        }
        if (k === '"' || k === "'") a = k;
        r += k;
        continue;
      }
      if (k === "\\" && w8(e, y, a)) {
        {
          r += n ? "  " : k + (e[y + 1] ?? "");
          y++;
        }
        continue;
      }
      if (k === a) {
        {
          a = null;
          r += k;
        }
        continue;
      }
      r += n ? " " : k;
    }
    return r;
  }

  function Zrt(e: string[]): string {
    return uat(e.join(" "))
      .replaceAll(AOe, "$(\u2026)")
      .replace(/[\s\p{Cc}]+/gu, " ");
  }

  function _Pr(e: string): boolean {
    let n = e.split("&&");
    return (
      required(n[0]).trim() === "" && n.slice(1).every((r) => !/[;|&]/.test(r))
    );
  }

  function aSn(e: string): string | undefined {
    let n =
      /^[\uE020"']*\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[?-][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))[\uE020"']*$/.exec(
        e,
      );
    return n === null ? void 0 : (n[1] ?? n[2]);
  }

  function aat(
    e: string,
    n: (name: string) => boolean,
  ): NativeBashLiteralAssignments {
    let r = gPr(
        mPr(
          (e.length > $kn ? e.slice(0, $kn) : e).replace(
            /[\uE000-\uF8FF]/g,
            "",
          ),
        ),
      ),
      a = YK(r, !0),
      h = YK(r, !1),
      y = /(?:^|[\s;&|({])trap\s+(?:--\s+)?\$?'[^']*\brm\b/.test(h)
        ? r.length
        : Math.max(
            ...[...h.matchAll(/\brm(?:dir)?\b/gi)].map((Qe) => Qe.index),
            -1,
          ),
      k = new Set<string>(),
      E = new Set<string>(),
      N = new Set<string>(),
      V = new Set<string>(),
      oe = new Map<string, NativeBashLiteralDerivedValue>(),
      re = (Qe: string) =>
        E.has(Qe) || N.has(Qe) || (!k.has(Qe) && !eSn(Qe) && n(Qe)),
      _e: AssignmentEvent[] = [
        ...[...a.matchAll(fPr)].map((Qe) => ({
          index: Qe.index,
          names: required(Qe[1]).trim().split(/\s+/),
          bound: !1,
          rootish: !1,
          until: -1,
        })),
        ...[...a.matchAll(pPr)].map((Qe) => {
          let ot = Qe.index + Qe[0].length,
            it = r.slice(ot - required(Qe[2]).length, ot).trim(),
            bt =
              it !== "" &&
              !/""|''/.test(it) &&
              !/(?:^|\s)"[^"]*[$`][^"]*"(?=\s|$)/.test(it),
            vt = /[$`]/.test(it) ? /\bdone\b/.exec(a.slice(ot)) : null;
          return {
            index: Qe.index,
            names: [required(Qe[1])],
            bound: bt ? !0 : null,
            rootish: bt && !/\s/.test(it) && Jrt(it),
            until: vt === null ? -1 : ot + vt.index,
          };
        }),
      ]
        .flatMap((Qe) =>
          Qe.until >= 0
            ? [Qe, { ...Qe, index: Qe.until, bound: null, rootish: !1 }]
            : [Qe],
        )
        .filter((Qe) => Qe.index < y)
        .sort((Qe, ot) => Qe.index - ot.index),
      ke = (Qe: number) => {
        while (_e.length > 0 && required(_e[0]).index < Qe) {
          let { names: ot, bound: it, rootish: bt } = required(_e.shift());
          for (let vt of ot)
            if (
              (k.delete(vt),
              E.delete(vt),
              N.delete(vt),
              V.delete(vt),
              oe.delete(vt),
              it === !0)
            ) {
              if ((k.add(vt), bt)) V.add(vt);
            } else if (it === !1) E.add(vt);
        }
      },
      Re = 0,
      xe: AssignmentTail | null = null,
      Pe = 0,
      Be = !1,
      Fe = 0,
      Ke = 0;
    bOe.lastIndex = 0;
    for (let Qe = bOe.exec(a); Qe !== null && Qe.index < y; Qe = bOe.exec(a)) {
      let ot = required(Qe[1]),
        it = Qe.index + Qe[0].length,
        bt = sSn(r, it);
      bOe.lastIndex = bt;
      let vt = it - ot.length - 1;
      for (; Ke < vt; Ke++) {
        let co = required(a[Ke]);
        if (
          co ===
            `
` &&
          Be &&
          a.slice(Pe, Ke).trim() === ""
        ) {
          Fe = Ke + 1;
          continue;
        }
        if (/[;&|(\n]/.test(co)) {
          Pe = Ke + 1;
          Be = co === "|" && a[Ke - 1] === "|";
        }
      }
      let Ct = Math.max(Re, Pe, Fe),
        Pt: AssignmentTail | null = xe !== null && vt < xe.end ? xe : null,
        Dt = Pt !== null ? Pt.conditional : Pe >= Re && Be;
      if (
        !/^[\s)]*(?:(?:do|then|else|elif|if|while|until|time|!|\{)\s+)*(?:(?:export|local|declare|typeset|readonly)(?:\s+-\w+)*\s+)?$/.test(
          r.slice(Ct, vt),
        )
      )
        continue;
      Re = bt;
      let Lt: AssignmentTail = Pt ?? { ...yPr(a, bt), conditional: Dt };
      if (((xe = Lt), Lt.prefix)) continue;
      ke(vt);
      let $t = r.slice(it, bt),
        gn = kPr($t),
        Ht;
      if (gn !== void 0) {
        let co = uPr.exec(gn);
        if (co?.[2] === "rev-parse")
          Ht = "prints a git value such as the repository root";
        else if (co?.[1] === "pwd") Ht = "prints the current directory";
        else if (co?.[1] === "dirname" || co?.[1] === "cd") {
          let ao = /^\s*(?:cd|dirname)\s+(?:--?\w*\s+)*([^\s;&|]*)/.exec(gn),
            Hn = ao?.[1],
            jn = (oo: string) =>
              oo.replace(/\/+[^/]*\/*$/, "") ||
              (oo.startsWith("/") ? "/" : ".");
          if (!(
            ao !== null &&
            Hn !== void 0 &&
            Hn !== "" &&
            !/[$`]/.test(Hn) &&
            !/^(?:""|'')$/.test(Hn) &&
            (co[1] === "dirname"
              ? !OOe(op(jn(Hn.replace(/^(["'])(.*)\1$/, "$2"))))
              : _Pr(gn.slice(ao[0].length)))
          ))
            Ht =
              co[1] === "dirname"
                ? Hn !== void 0 && Hn !== "" && !/[$`]/.test(Hn)
                  ? `prints ${jn(Hn.replace(/^(["'])(.*)\1$/, "$2"))}`
                  : "prints the current directory (as `.`) when its input is empty"
                : 'prints the current directory when its input is empty (`cd ""` stays put)';
        }
      } else if (!/[$`]/.test($t) || /^"?\$\{?[A-Za-z_]/.test($t)) {
        let co = tSn($t, re);
        if (co !== void 0) Ht = `is /${co} when the variable in it is empty`;
        else if (Qkn.test($t))
          Ht = "is the filesystem root when the variable in it is empty";
      }
      let Qt = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\/*$/.exec($t)?.[1],
        nn =
          Qt === "PWD"
            ? { value: $t, becomes: "is the current directory" }
            : Qt === void 0
              ? void 0
              : oe.get(Qt);
      if (Ht !== void 0) oe.set(ot, { value: $t, becomes: Ht });
      else if (nn !== void 0) oe.set(ot, nn);
      else if (!Dt) oe.delete(ot);
      let yn = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?(?:\/[^\s"'$`]*)?"?$/.exec(
          $t,
        )?.[1],
        Cn = /(?:^|\/)\.\.(?:\/|$)/.test($t.replace(/["']/g, "")),
        vn = /^(?:""|''|\(\s*\))?$/.test($t),
        An = /\/([^\s/$`"')}]+)"?$/.exec($t)?.[1],
        io = /^"?\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^\s}$`]+)\}"?$/.exec($t)?.[1],
        Qn =
          io === void 0 ||
          /^(?:|\/+|(?:[^/]*\/)*\.\.?\/*)$/.test(
            io.replace(/^(["'])([\s\S]*)\1$/, "$2"),
          ),
        Ao =
          (!Cn && An !== void 0 && !/^[.?*[\]{}]+$/.test(An)) ||
          !Qn ||
          (yn !== void 0 && !Cn ? !re(yn) : !vn && !/[$`]/.test($t)),
        _o = k.has(ot),
        Mo = V.has(ot);
      if ((k.delete(ot), E.delete(ot), N.delete(ot), V.delete(ot), Ao && Dt))
        if (_o) {
          if ((k.add(ot), Mo || Jrt($t))) V.add(ot);
        } else N.add(ot);
      else if (Ao) {
        if ((k.add(ot), Jrt($t) || (yn !== void 0 && V.has(yn)))) V.add(ot);
      } else if (vn) E.add(ot);
      else N.add(ot);
    }
    return (
      ke(Number.POSITIVE_INFINITY),
      { set: k, emptied: new Set([...E, ...N]), rootValued: V, derived: oe }
    );
  }

  function eSn(e: string): boolean {
    return e === "HOME" || e === "PWD";
  }

  function gPr(e: string): string {
    let n = YK(e, !0),
      r = e;
    for (let a = n.length - 1; a > 0; a--)
      if (
        n[a] ===
          `
` &&
        n[a - 1] === "\\" &&
        !(n[a - 2] === "\\" && e[a - 1] === "\\")
      )
        r = r.slice(0, a - 1) + r.slice(a + 1);
    return r;
  }

  function iSn(e: string): string {
    let n = e.length;
    while (n > 0 && /[\uE020"']/.test(required(e[n - 1]))) n--;
    let r = n;
    while (r > 0 && /[/*.]/.test(required(e[r - 1]))) r--;
    return r < n && e[r] === "/" ? e.slice(0, r) : e;
  }

  function kPr(e: string): string | undefined {
    let n = e.replace(/^"([\s\S]*)"$/, "$1").replace(/\/+$/, ""),
      r = /^`([^`]*)`$/.exec(n);
    if (r !== null) return r[1];
    if (!n.startsWith("$(")) return;
    let a = 0,
      h: Quote = null;
    for (let y = 1; y < n.length; y++) {
      let k = required(n[y]);
      if (k === "\\" && w8(n, y, h)) y++;
      else if (h !== null) h = k === h ? null : h;
      else if (k === '"' || k === "'") h = k;
      else if (k === "(") a++;
      else if (k === ")" && --a === 0)
        return y === n.length - 1 ? n.slice(2, y) : void 0;
    }
    return;
  }

  function mPr(e: string): string {
    let n = e,
      r = YK(n, !0),
      a = /(?:^|[^<$(])<<(?!<)/g;
    for (let h = a.exec(r); h !== null; h = a.exec(r)) {
      let y = h.index + h[0].length - 2,
        k = /^<<-?\s*\\?["']?([A-Za-z_][A-Za-z0-9_]*)["']?[^\n]*\n/.exec(
          n.slice(y),
        );
      if (k === null) continue;
      let E = y + k[0].length,
        V = new RegExp(String.raw`^\t*${k[1]}[ \t]*$`, "m").exec(n.slice(E)),
        oe = V === null ? n.length : E + V.index + V[0].length;
      {
        n = n.slice(0, E) + n.slice(E, oe).replace(/[^\n]/g, " ") + n.slice(oe);
        r = YK(n, !0);
        a.lastIndex = oe;
      }
    }
    return n;
  }

  function sSn(e: string, n: number): number {
    let r = (a: boolean): number | undefined => {
      let h = n,
        y = 0,
        k: Quote | "`" = null;
      for (; h < e.length; h++) {
        let E = required(e[h]);
        if (E === "\\" && (k === "`" || w8(e, h, k))) {
          h++;
          continue;
        }
        if (k !== null) {
          if (E === k) k = null;
          continue;
        }
        if (y === 0 && (E === '"' || E === "'" || E === "`")) k = E;
        else if (
          a &&
          (E === "(" ||
            (E === "{" &&
              e[h - 1] === "$" &&
              e[h - 2] !== "$" &&
              e[h - 2] !== "\\"))
        )
          y++;
        else if (a && (E === ")" || E === "}") && y > 0) y--;
        else if (y === 0 && /[\s;&|]/.test(E)) break;
      }
      return y === 0 && k === null ? h : void 0;
    };
    return r(!0) ?? r(!1) ?? e.length;
  }

  function tSn(e: string, n: (name: string) => boolean): string | undefined {
    let r = dPr.exec(e.replace(/\/(?:\.\/)+/g, "/").replace(/\/{2,}/g, "/"));
    if (r === null) return;
    let a = required(r[1] ?? r[3]),
      h = r[2];
    return n(a) && (h === void 0 || n(h)) ? r[4] : void 0;
  }

  function uat(e: string): string {
    return e.replace(vPr, (n) => required(IOe[n.charCodeAt(0) - Ude]));
  }

  function w8(e: string, n: number, r: Quote | "`"): boolean {
    if (r === "'") return !1;
    if (r === null) return !0;
    let a = e[n + 1];
    return a === '"' || a === "\\" || a === "$" || a === "`";
  }

  function yPr(e: string, n: number): { end: number; prefix: boolean } {
    let r = n;
    for (;;) {
      while (r < e.length && (e[r] === " " || e[r] === "\t")) r++;
      if (r >= e.length || /[;\n)#]/.test(required(e[r])))
        return { end: r, prefix: !1 };
      if (e[r] === "&" || e[r] === "|")
        return { end: r, prefix: e[r + 1] !== e[r] };
      let a = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.exec(
        e.slice(r, r + 1024),
      );
      if (a === null) return { end: r, prefix: !0 };
      r = sSn(e, r + a[0].length);
    }
  }

  return {
    semantic,
    preparation,
    pathOwner,
    native: {
      Bkn,
      CPr,
      DOe,
      EPr,
      FOe,
      Hkn,
      Jrt,
      LOe,
      RPr,
      TOe,
      Ukn,
      Xit,
      YK,
      Zrt,
      _Pr,
      aSn,
      aat,
      eSn,
      gPr,
      iSn,
      kPr,
      mPr,
      sSn,
      tSn,
      uat,
      w8,
      yPr,
    },
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
