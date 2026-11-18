/**
 * Typed port of the complete pinned 2.1.326 shell grammar and its syntax contract.
 * Source provenance: artifacts/native-bash-parser-research/CONTRACT.md.
 * This module neither loads recovered code nor authorizes command execution.
 */
import {
  createNativeBashParserFeatures,
  nativeBashDollarOperandPattern,
  nativeBashAlternateArithmeticPattern,
  type NativeBashParserFeatures,
} from "./native-bash-parser-features.js";

export interface NativeBashSyntaxNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  children: NativeBashSyntaxNode[];
  misreading?: string;
  keywordAfterPrefix?: boolean;
}
interface Token {
  type: string;
  value: string;
  start: number;
  end: number;
}
interface FeatureState {
  asked: number;
  answers: number;
}
interface PendingHeredoc {
  delim: string;
  stripTabs: boolean;
  quoted: boolean;
  bodyStart: number;
  bodyEnd: number;
  endStart: number;
  endEnd: number;
}
interface Lexer {
  src: string;
  len: number;
  i: number;
  b: number;
  heredocs: PendingHeredoc[];
  byteTable: Uint32Array | null;
  zshCondParenDiff: boolean;
  dollarEnds: Map<number, number>;
  dollarStarts: number[];
}
interface WordState {
  brackets: number;
  subscriptDepth: number;
  holdsDollar: boolean;
  partsSeen: number;
  afterExpansion: boolean;
  subscriptRunsQuotes: boolean;
}
interface Replacement {
  start: number;
  end: number;
  left: string;
}
interface ParseContext {
  L: Lexer;
  src: string;
  srcBytes: number;
  isAscii: boolean;
  nodeCount: number;
  deadline: number;
  aborted: boolean;
  timedOut: boolean;
  inBacktick: number;
  inDquote: number;
  stopToken: string | null;
  sawIfOrLoop: boolean;
  misreading: string | undefined;
  dollarQuotes: number[] | undefined;
  quotedCode: number[] | undefined;
  plainQuotedCode: number[] | undefined;
  bracketOffsets: number[] | undefined;
  quoteOffsets: number[] | undefined;
  quoteOrBackslashOffsets: number[] | undefined;
  operandsRead: Set<NativeBashSyntaxNode> | undefined;
  subscriptRead: number;
  zshBraceDiff: boolean;
  dollarOperandDiff: boolean;
  keywordDesync: boolean;
  switches: FeatureState;
  zshMathClosesAlike: boolean;
  zshMathDiff: boolean;
  inForHead: boolean;
}
export interface NativeBashParserOptions {
  features?: NativeBashParserFeatures;
  now?: () => number;
}
function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing parser invariant");
  return value;
}
/** Source-backed typed grammar. It returns syntax evidence, never execution permission. */
export function createNativeBashParser(options: NativeBashParserOptions = {}) {
  const features = options.features ?? createNativeBashParserFeatures();
  const now = options.now ?? (() => performance.now());
  const wro = () => features.keywordGuardEnabled();
  const FMt = () => features.keywordGuardOff();
  const nxn = () => features.markKeywordDesynchronization();
  const Rar = nativeBashDollarOperandPattern;
  const CXt = nativeBashAlternateArithmeticPattern;
  const be = Symbol("timed-out");
  const k3a = () => features.repeatedDollarGuardEnabled();
  const x_i = () => features.dollarQuoteGuardEnabled();
  const v3a = () => features.braceRereadGuardEnabled();
  const T3a = () => features.prefixFunctionGuardEnabled();
  const Ero = () => features.alternateArithmeticRead();
  const kro = () => features.markMayDiffer();
  const xar = () => features.arithmeticGuardEnabled();
  const wxe = (input: string) => features.dollarOperandGuardEnabled(input);
  const R3a = () => features.bracketWordGuardEnabled();
  const M3a = () => features.quotedSubscriptGuardEnabled();
  var oe = 1,
    ae = 2,
    ce = 4,
    le = 8,
    ue = 16,
    Se = 32,
    ke = 512,
    ve = 64,
    P = 1024,
    fe = 65536,
    Qt = oe | ae | ce | le | P | fe;
  function st(e: FeatureState): boolean {
    return (e.asked & ~Qt) !== 0;
  }
  /** Read the ten lazily queried source feature bits. Source production Hwn. */
  function Hwn(e: number, s: string): number {
    let n = 0;
    if ((e & oe) !== 0 && wro() && !FMt()) n |= oe;
    if ((e & ae) !== 0 && M3a()) n |= ae;
    if ((e & ce) !== 0 && k3a()) n |= ce;
    if ((e & le) !== 0 && wxe(s)) n |= le;
    if ((e & ue) !== 0 && xar()) n |= ue;
    if ((e & Se) !== 0 && Ero() && xar()) n |= Se;
    if ((e & ke) !== 0 && x_i()) n |= ke;
    if ((e & ve) !== 0 && T3a() && !FMt()) n |= ve;
    if ((e & P) !== 0 && R3a()) n |= P;
    if ((e & fe) !== 0 && v3a()) n |= fe;
    return n;
  }
  function q(e: FeatureState, s: string, n: number): boolean {
    if ((e.asked & n) === 0) {
      e.asked |= n;
      e.answers |= Hwn(n, s);
    }
    return (e.answers & n) !== 0;
  }
  /** Check substitution text after masking quoted/opaque AST children. Source production QMa. */
  function QMa(e: NativeBashSyntaxNode, s: Buffer): boolean {
    let n = Ue(e, s, "line"),
      t = n.search(Zt);
    return (t !== -1 && it.test(n.slice(t + 2))) || ot(e, s, !1);
  }
  var We = "\x03",
    Gt = "\x02",
    Zt = new RegExp(String.raw`[$<>]\((?!\(?\x03)`),
    it = new RegExp(
      String.raw`(?:^|[ \t\n;&|()<>])(?:#|(?:case|esac)(?=$|[ \t\n;&|()<>]))|(?:^|[^<])(?:<<(?![<\x02])|<<<+[<\x02])|\$(?=$|[ \t\n;&|)<>])`,
    );
  function ot(e: NativeBashSyntaxNode, s: Buffer, n: boolean): boolean {
    let t = e.children[0]?.type;
    if (
      e.type === "process_substitution" ||
      (e.type === "command_substitution" && t === "$(")
    ) {
      let o = Ue(e, s, "substitution");
      if (n || it.test(o.slice(2, -1)) || !rt(o.slice(1))) return !0;
    } else if (t === "$((" && !rt(Ue(e, s, "substitution").slice(1))) return !0;
    let r =
      n ||
      e.type === "arithmetic_expansion" ||
      e.type === "c_style_for_statement" ||
      t === "((" ||
      (e.type === "string" &&
        e.children.some(
          (o, a) => o.type === "$" && e.children[a + 1]?.text.startsWith("["),
        ));
    return e.children.some((o) => ot(o, s, r));
  }
  function rt(e: string): boolean {
    let s = 0;
    for (let n = 0; n < e.length; n++)
      if (e[n] === "(") s++;
      else if (e[n] === ")" && --s === 0) return n === e.length - 1;
    return !1;
  }
  function Ue(e: NativeBashSyntaxNode, s: Buffer, n: string): string {
    let t = "",
      r = e.startIndex,
      o = at(e, n).sort((a, c) => a.start - c.start);
    for (let a of o)
      if (a.start >= r) {
        t += s.toString("latin1", r, a.start) + a.left;
        r = a.end;
      }
    return (t + s.toString("latin1", r, e.endIndex)).replace(
      /\\([^])/g,
      (a: string, c: string) =>
        c ===
        `
`
          ? ""
          : c === " " || c === "\t"
            ? c
            : "_",
    );
  }
  function at(e: NativeBashSyntaxNode, s: string): Replacement[] {
    return e.children.flatMap((n) => {
      let t = jt(n, s);
      return t === null
        ? at(n, s)
        : [{ start: n.startIndex, end: n.endIndex, left: t }];
    });
  }
  function jt(e: NativeBashSyntaxNode, s: string): string | null {
    switch (e.type) {
      case "raw_string":
        return "''";
      case "string":
        return '""';
      case "ansi_c_string":
        return "$''";
      case "simple_expansion":
        return "$x";
      case "comment":
        return " #";
      case "heredoc_body":
        return s === "line" ? " " : null;
      case "heredoc_redirect":
        return s === "substitution" && Xt(e) ? "<<" + Gt : null;
      case "command_substitution":
        return e.children[0]?.type === "$(" ? "$(" + We + ")" : "``";
      case "process_substitution":
        return e.text.charAt(0) + "(" + We + ")";
      case "arithmetic_expansion":
        return e.children[0]?.type === "$((" ? "$((" + We + "))" : null;
      default:
        return null;
    }
  }
  function Xt(e: NativeBashSyntaxNode): boolean {
    let [s, n, t, r] = e.children;
    if (
      !s ||
      !n ||
      !t ||
      !r ||
      (s.type !== "<<" && s.type !== "<<-") ||
      n.type !== "heredoc_start" ||
      !/^(?:(?!(?:case|esac)$)\w+|'[^'\\\s()]+'|"[^"$`\\\s()]+")$/.test(
        n.text,
      ) ||
      t.type !== "heredoc_body" ||
      t.startIndex !== n.endIndex + 1 ||
      r.type !== "heredoc_end"
    )
      return !1;
    return ct(s, t, r);
  }
  function ct(
    e: NativeBashSyntaxNode,
    s: NativeBashSyntaxNode,
    n: NativeBashSyntaxNode,
  ): boolean {
    let t = s.text + n.text;
    return [t, t.replaceAll("\\\n", "")].every((r) => {
      let o = r.split(`
`);
      return (
        o.findIndex((c) => {
          let u = e.type === "<<-" ? c.replace(/^\t+/, "") : c;
          return u === n.text || u.startsWith(n.text + ")");
        }) ===
        o.length - 1
      );
    });
  }
  function lt(e: NativeBashSyntaxNode): NativeBashSyntaxNode | undefined {
    let [s, n] = e.children,
      t = e.children.at(-2),
      r = e.children.at(-1);
    if (
      s &&
      n?.type === "heredoc_start" &&
      /^(?:'[^'\\\s()]+'|"[^"$`\\\s()]+")$/.test(n.text) &&
      t?.type === "heredoc_body" &&
      t.children.length === 0 &&
      r?.type === "heredoc_end" &&
      r.text === n.text.slice(1, -1) &&
      !e.children.some((o) => o.type === "ERROR") &&
      e.text.slice(
        e.text.indexOf(`
`) + 1,
      ) ===
        t.text + r.text &&
      ct(s, t, r)
    )
      return t;
    return;
  }
  /** Scan a delimited arithmetic operand with known nested dollar boundaries. Source production qe. */
  function qe(
    e: string,
    s: number,
    n: string,
    t: Map<number, number>,
    r: boolean,
  ): number {
    let o = r || n === ")" || n === "]",
      a = 0,
      c = 0,
      u = 0,
      f = s;
    while (f < e.length) {
      let L = need(e[f]);
      if ((f++, L === n && u === 0 && !(o && (a > 0 || c > 0)))) return f - 1;
      if (L === "\\") {
        let b = e[f];
        if (
          (f++,
          b ===
            `
` ||
            b === "$" ||
            b === "\\" ||
            b === "`" ||
            b === n ||
            (b === "}" && u > 0) ||
            (n === "]" && b !== void 0 && "[](){}".includes(b)))
        )
          continue;
        L = b ?? "";
      }
      switch (L) {
        case "$": {
          let b = e[f];
          if (b === "(" || b === "[") {
            let h = t.get(f - 1);
            if (h === void 0) return -1;
            f = h;
          } else if (b === "{") {
            f++;
            u++;
          } else if (b === "$") f++;
          break;
        }
        case "}":
          if (u > 0) u--;
          break;
        case "`":
          return -1;
        case "(":
          if (!o || u === 0) a++;
          break;
        case ")":
          if (!o || u === 0) {
            if (o && a === 0) return -1;
            a--;
          }
          break;
        case "[":
          if (!o || u === 0) c++;
          break;
        case "]":
          if (!o || u === 0) {
            if (o && c === 0) return -1;
            c--;
          }
          break;
        case '"': {
          if (n !== '"' && u === 0) break;
          if (u === 0) return -1;
          let b = qe(e, f, '"', t, r);
          if (b < 0) return b;
          f = b + 1;
          break;
        }
      }
    }
    return -1;
  }
  var KQn = {
      words_after_test:
        "Text after a closing ] in this command can't be checked before it runs",
      words_after_redirect:
        "Words after a redirect in this command can't be checked before it runs",
      reserved_word_after_prefix:
        "A shell keyword or opening brace in this command can't be checked before it runs",
      equals_in_test:
        "Text right after an = inside [[ ]] in this command can't be checked before it runs",
      hash_in_test:
        "Text after a # inside [ ] or [[ ]] in this command can't be checked before it runs",
      hash_in_for_list:
        "Text after a # in a for or select list in this command can't be checked before it runs",
      digits_before_redirect:
        "Your shell may read the digits just before a redirect in this command differently from Claude Code, so it can't be checked before it runs. To pass the digits as an argument, put a space after them.",
      dollar_quote_string:
        "A $'\u2026' string in this command may hide code that can't be checked before it runs",
      brace_text_read_again:
        "Text in or next to a brace pattern in this command can't be checked before it runs",
      pattern_flag:
        "A $ followed by ~ in this command may make zsh read a value as a pattern, which may run code that can't be checked before it runs",
      quoted_code_in_subscript:
        "Quoted text in square brackets in this command may run as code that can't be checked before it runs",
      bracket_word:
        "A bracket word or a ( ) list in this command can't be checked before it runs: your shell may read it as going on past where Claude Code ended it",
    },
    Yt = 50,
    Vt = 50000,
    Ne = 67108864,
    Jt = Ne,
    Pt = { parse: dn },
    en = 64,
    tn = 1e4,
    nn = 32000,
    ee = new Map<
      string,
      { root: NativeBashSyntaxNode; switches: FeatureState }
    >();
  function V_(): { parse: typeof dn } {
    return Pt;
  }
  var se = new Set(["?", "$", "@", "*", "#", "-", "!", "_"]),
    Oe = new Set(["#", "^", "=", "~", "+"]);
  function Tt(e: ParseContext, s: number): number {
    let n = e.L.src,
      t = s;
    while (t < e.L.len && Oe.has(need(n[t]))) t++;
    let r = !1;
    while (t < e.L.len) {
      let o = n[t];
      if (z(o)) t++;
      else if (need(o) >= "\x80") {
        r = !0;
        t++;
      } else break;
    }
    return r ? t : -1;
  }
  var sn = new Set(["export", "declare", "typeset", "readonly", "local"]),
    YQn = new Set([
      "if",
      "then",
      "elif",
      "else",
      "fi",
      "while",
      "until",
      "for",
      "in",
      "do",
      "done",
      "case",
      "esac",
      "function",
      "select",
    ]);
  /** Initialize independent UTF-16 and UTF-8 lexer cursors. Source production rn. */
  function rn(e: string): Lexer {
    return {
      src: e,
      len: e.length,
      i: 0,
      b: 0,
      heredocs: [],
      byteTable: null,
      zshCondParenDiff: !1,
      dollarEnds: new Map(),
      dollarStarts: [],
    };
  }
  function i(e: Lexer): void {
    let s = e.src.charCodeAt(e.i);
    if ((e.i++, s < 128)) e.b++;
    else if (s < 2048) e.b += 2;
    else if (s >= 55296 && s <= 56319) {
      e.b += 4;
      e.i++;
    } else e.b += 3;
  }
  function l(e: Lexer, s = 0): string {
    return e.i + s < e.len ? need(e.src[e.i + s]) : "";
  }
  function re(e: Lexer, s: number): number {
    if (e.byteTable) return need(e.byteTable[s]);
    let n = new Uint32Array(e.len + 1),
      t = 0,
      r = 0;
    while (r < e.len) {
      n[r] = t;
      let o = e.src.charCodeAt(r);
      if (o < 128) {
        t++;
        r++;
      } else if (o < 2048) {
        t += 2;
        r++;
      } else if (o >= 55296 && o <= 56319) {
        n[r + 1] = t + 2;
        t += 4;
        r += 2;
      } else {
        t += 3;
        r++;
      }
    }
    return ((n[e.len] = t), (e.byteTable = n), need(n[s]));
  }
  function St(e: string | undefined): boolean {
    if (e === undefined) return false;
    return (
      (e >= "a" && e <= "z") ||
      (e >= "A" && e <= "Z") ||
      (e >= "0" && e <= "9") ||
      e === "_" ||
      e === "/" ||
      e === "." ||
      e === "-" ||
      e === "+" ||
      e === ":" ||
      e === "@" ||
      e === "%" ||
      e === "," ||
      e === "~" ||
      e === "^" ||
      e === "?" ||
      e === "*" ||
      e === "!" ||
      e === "=" ||
      e === "[" ||
      e === "]" ||
      e >= "\x80"
    );
  }
  function on(e: string | undefined): boolean {
    return St(e) || e === "\\";
  }
  function kt(e: string | undefined): boolean {
    return (
      e === "" ||
      e === " " ||
      e === "\t" ||
      e ===
        `
` ||
      e === "\r" ||
      e === ";" ||
      e === "&" ||
      e === "|" ||
      e === "(" ||
      e === ")" ||
      e === "<" ||
      e === ">"
    );
  }
  function Qe(e: string | undefined): boolean {
    return kt(e) && e !== "(";
  }
  function M(e: string | undefined): boolean {
    if (e === undefined) return false;
    return (e >= "a" && e <= "z") || (e >= "A" && e <= "Z") || e === "_";
  }
  function z(e: string | undefined): boolean {
    if (e === undefined) return false;
    return M(e) || (e >= "0" && e <= "9");
  }
  function D(e: string | undefined): boolean {
    if (e === undefined) return false;
    return e >= "0" && e <= "9";
  }
  function an(e: string | undefined): boolean {
    if (e === undefined) return false;
    return D(e) || (e >= "a" && e <= "f") || (e >= "A" && e <= "F");
  }
  function cn(e: string | undefined): boolean {
    return z(e) || e === "@";
  }
  function ln(e: string | undefined): boolean {
    return (
      e !== "" &&
      e !== " " &&
      e !== "\t" &&
      e !==
        `
` &&
      e !== "<" &&
      e !== ">" &&
      e !== "|" &&
      e !== "&" &&
      e !== ";" &&
      e !== "(" &&
      e !== ")" &&
      e !== "'" &&
      e !== '"' &&
      e !== "`" &&
      e !== "\\"
    );
  }
  function m(e: Lexer): void {
    while (e.i < e.len) {
      let s = e.src[e.i];
      if (s === " " || s === "\t" || s === "\r") i(e);
      else if (s === "\\")
        if (
          e.src[e.i + 1] ===
          `
`
        ) {
          i(e);
          i(e);
        } else break;
      else break;
    }
  }
  function un(e: Lexer): void {
    while (e.i < e.len) {
      let s = e.src[e.i];
      if (s === " " || s === "\t") i(e);
      else if (
        s === "\\" &&
        e.src[e.i + 1] ===
          `
`
      ) {
        i(e);
        i(e);
      } else break;
    }
  }
  /** Tokenize shell words, operators, quotes and descriptors. Source production S. */
  function S(e: Lexer, s = "arg"): Token {
    m(e);
    let n = e.b;
    if (e.i >= e.len) return { type: "EOF", value: "", start: n, end: n };
    let t = e.src[e.i],
      r = l(e, 1),
      o = l(e, 2);
    if (
      t ===
      `
`
    )
      return (
        i(e),
        {
          type: "NEWLINE",
          value: `
`,
          start: n,
          end: e.b,
        }
      );
    if (t === "#") {
      let a = e.i > 0 ? e.src[e.i - 1] : "";
      if (a === "" || " \t\n;&|<>()`".includes(need(a))) {
        let c = e.i;
        while (
          e.i < e.len &&
          e.src[e.i] !==
            `
`
        )
          i(e);
        return {
          type: "COMMENT",
          value: e.src.slice(c, e.i),
          start: n,
          end: e.b,
        };
      }
    }
    if (t === "&" && r === "&")
      return (i(e), i(e), { type: "OP", value: "&&", start: n, end: e.b });
    if (t === "|" && r === "|")
      return (i(e), i(e), { type: "OP", value: "||", start: n, end: e.b });
    if (t === "|" && r === "&")
      return (i(e), i(e), { type: "OP", value: "|&", start: n, end: e.b });
    if (t === ";" && r === ";" && o === "&")
      return (
        i(e),
        i(e),
        i(e),
        { type: "OP", value: ";;&", start: n, end: e.b }
      );
    if (t === ";" && r === ";")
      return (i(e), i(e), { type: "OP", value: ";;", start: n, end: e.b });
    if (t === ";" && r === "&")
      return (i(e), i(e), { type: "OP", value: ";&", start: n, end: e.b });
    if (t === ">" && r === ">")
      return (i(e), i(e), { type: "OP", value: ">>", start: n, end: e.b });
    if (t === ">" && r === "&" && o === "-")
      return (
        i(e),
        i(e),
        i(e),
        { type: "OP", value: ">&-", start: n, end: e.b }
      );
    if (t === ">" && r === "&")
      return (i(e), i(e), { type: "OP", value: ">&", start: n, end: e.b });
    if (t === ">" && r === "|")
      return (i(e), i(e), { type: "OP", value: ">|", start: n, end: e.b });
    if (t === "&" && r === ">" && o === ">")
      return (
        i(e),
        i(e),
        i(e),
        { type: "OP", value: "&>>", start: n, end: e.b }
      );
    if (t === "&" && r === ">")
      return (i(e), i(e), { type: "OP", value: "&>", start: n, end: e.b });
    if (t === "<" && r === "<" && o === "<")
      return (
        i(e),
        i(e),
        i(e),
        { type: "OP", value: "<<<", start: n, end: e.b }
      );
    if (t === "<" && r === "<" && o === "-")
      return (
        i(e),
        i(e),
        i(e),
        { type: "OP", value: "<<-", start: n, end: e.b }
      );
    if (t === "<" && r === "<")
      return (i(e), i(e), { type: "OP", value: "<<", start: n, end: e.b });
    if (t === "<" && r === "&" && o === "-")
      return (
        i(e),
        i(e),
        i(e),
        { type: "OP", value: "<&-", start: n, end: e.b }
      );
    if (t === "<" && r === "&")
      return (i(e), i(e), { type: "OP", value: "<&", start: n, end: e.b });
    if (t === "<" && r === "(")
      return (
        i(e),
        i(e),
        { type: "LT_PAREN", value: "<(", start: n, end: e.b }
      );
    if (t === ">" && r === "(")
      return (
        i(e),
        i(e),
        { type: "GT_PAREN", value: ">(", start: n, end: e.b }
      );
    if (t === "(" && r === "(")
      return (i(e), i(e), { type: "OP", value: "((", start: n, end: e.b });
    if (t === ")" && r === ")")
      return (i(e), i(e), { type: "OP", value: "))", start: n, end: e.b });
    if (t === "|" || t === "&" || t === ";" || t === ">" || t === "<")
      return (i(e), { type: "OP", value: need(t), start: n, end: e.b });
    if (t === "(" || t === ")")
      return (i(e), { type: "OP", value: need(t), start: n, end: e.b });
    if (s === "cmd") {
      if (t === "[") {
        let a = !1,
          c = (f: number) => {
            while (e.src[f] === "\\")
              if (
                e.src[f + 1] ===
                `
`
              ) {
                f += 2;
                a = !0;
              } else if (
                e.src[f + 1] === "\r" &&
                e.src[f + 2] ===
                  `
`
              ) {
                f += 3;
                a = !0;
              } else break;
            return f;
          },
          u = c(e.i + 1);
        if (e.src[u] === "[") {
          let f = c(u + 1);
          if (a && e.src[f] === "(") e.zshCondParenDiff = !0;
        }
      }
      if (
        t === "[" &&
        r === "[" &&
        (o === " " ||
          o === "\t" ||
          o ===
            `
` ||
          o === "" ||
          o === "(")
      ) {
        if (o === "(") e.zshCondParenDiff = !0;
        return (i(e), i(e), { type: "OP", value: "[[", start: n, end: e.b });
      }
      if (t === "[")
        return (i(e), { type: "OP", value: "[", start: n, end: e.b });
      if (
        t === "{" &&
        (r === " " ||
          r === "\t" ||
          r ===
            `
`)
      )
        return (i(e), { type: "OP", value: "{", start: n, end: e.b });
      if (t === "}")
        return (i(e), { type: "OP", value: "}", start: n, end: e.b });
      if (t === "!" && (r === " " || r === "\t"))
        return (i(e), { type: "OP", value: "!", start: n, end: e.b });
    }
    if (t === '"')
      return (i(e), { type: "DQUOTE", value: '"', start: n, end: e.b });
    if (t === "'") {
      let a = e.i;
      i(e);
      while (e.i < e.len && e.src[e.i] !== "'") i(e);
      if (e.i < e.len) i(e);
      return { type: "SQUOTE", value: e.src.slice(a, e.i), start: n, end: e.b };
    }
    if (t === "$") {
      if (r === "(" && o === "(")
        return (
          i(e),
          i(e),
          i(e),
          { type: "DOLLAR_DPAREN", value: "$((", start: n, end: e.b }
        );
      if (r === "(")
        return (
          i(e),
          i(e),
          { type: "DOLLAR_PAREN", value: "$(", start: n, end: e.b }
        );
      if (r === "{")
        return (
          i(e),
          i(e),
          { type: "DOLLAR_BRACE", value: "${", start: n, end: e.b }
        );
      if (r === "'") {
        let a = e.i;
        {
          i(e);
          i(e);
        }
        while (e.i < e.len && e.src[e.i] !== "'") {
          if (e.src[e.i] === "\\" && e.i + 1 < e.len) i(e);
          i(e);
        }
        if (e.i < e.len) i(e);
        return {
          type: "ANSI_C",
          value: e.src.slice(a, e.i),
          start: n,
          end: e.b,
        };
      }
      return (i(e), { type: "DOLLAR", value: "$", start: n, end: e.b });
    }
    if (t === "`")
      return (i(e), { type: "BACKTICK", value: "`", start: n, end: e.b });
    if (D(t)) {
      let a = e.i;
      while (a < e.len && D(e.src[a])) a++;
      let c = a < e.len ? e.src[a] : "";
      if (c === ">" || c === "<") {
        let u = e.i;
        while (e.i < a) i(e);
        return { type: "WORD", value: e.src.slice(u, e.i), start: n, end: e.b };
      }
    }
    if (on(t) || t === "{" || t === "}") {
      let a = e.i;
      while (e.i < e.len) {
        let c = e.src[e.i];
        if (c === "\\") {
          if (e.i + 1 >= e.len) break;
          if (
            e.src[e.i + 1] ===
            `
`
          ) {
            {
              i(e);
              i(e);
            }
            continue;
          }
          {
            i(e);
            i(e);
          }
          continue;
        }
        if (!St(c) && c !== "{" && c !== "}" && c !== "#") break;
        i(e);
      }
      if (e.i > a) {
        let c = e.src.slice(a, e.i);
        if (/^-?\d+$/.test(c))
          return { type: "NUMBER", value: c, start: n, end: e.b };
        return { type: "WORD", value: c, start: n, end: e.b };
      }
    }
    return (i(e), { type: "WORD", value: need(t), start: n, end: e.b });
  }
  /** Public parse entry: feature-aware insertion-order cache and one timeout retry. Source production dn. */
  function dn(e: string, s?: number): NativeBashSyntaxNode | null {
    if (s !== void 0 || e.length > tn) {
      let a = { asked: 0, answers: 0 },
        c = He(e, s, a),
        u = c === be ? null : c;
      return (Fe(u, a), u);
    }
    let n = ee.get(e);
    if (n !== void 0 && n.switches.answers === Hwn(n.switches.asked, e)) {
      if (n.root.keywordAfterPrefix) nxn();
      return (Fe(n.root, n.switches), n.root);
    }
    ee.delete(e);
    let t = { asked: 0, answers: 0 },
      r = He(e, void 0, t);
    if (r === be) {
      t = { asked: 0, answers: 0 };
      r = He(e, void 0, t);
    }
    let o = r === be ? null : r;
    if ((Fe(o, t), o !== null)) {
      let a = e.length;
      for (let c of ee.keys()) a += c.length;
      for (let c of ee.keys()) {
        if (ee.size < en && a <= nn) break;
        {
          ee.delete(c);
          a -= c.length;
        }
      }
      ee.set(e, { root: o, switches: t });
    }
    return o;
  }
  function Fe(e: NativeBashSyntaxNode | null, s: FeatureState): void {
    if (e === null || st(s)) kro();
  }
  /** Single bounded parse attempt; syntax errors remain AST evidence. Source production He. */
  function He(
    e: string,
    s: number | undefined,
    n: FeatureState,
  ): NativeBashSyntaxNode | null | typeof be {
    let t = rn(e),
      r = fn(e);
    if (r >= Jt) return null;
    let o: ParseContext = {
      L: t,
      src: e,
      srcBytes: r,
      isAscii: r === e.length,
      nodeCount: 0,
      deadline: now() + (s ?? Yt),
      aborted: !1,
      timedOut: !1,
      inBacktick: 0,
      inDquote: 0,
      stopToken: null,
      sawIfOrLoop: !1,
      misreading: void 0,
      dollarQuotes: void 0,
      quotedCode: void 0,
      plainQuotedCode: void 0,
      bracketOffsets: void 0,
      quoteOffsets: void 0,
      quoteOrBackslashOffsets: void 0,
      operandsRead: void 0,
      subscriptRead: 0,
      zshBraceDiff: e.includes("$\\\n"),
      dollarOperandDiff: !1,
      keywordDesync: !1,
      switches: n,
      zshMathClosesAlike: !1,
      zshMathDiff: !1,
      inForHead: !1,
    };
    try {
      let a = bn(o);
      if (o.aborted) return o.timedOut ? be : null;
      if (!o.zshMathDiff) {
        let c = [];
        for (let u of e.matchAll(/(\$+)(\[|\((?:\\\n)*\()?/g)) {
          let f = u[1]?.length ?? 1,
            L = 0;
          while (e[u.index - L - 1] === "\\") L++;
          let b = u.index + f - 1,
            h = u[2]?.includes(`
`);
          if (
            u[2] !== void 0 &&
            (f - (L % 2)) % 2 === 1 &&
            (h || !o.L.dollarEnds.has(b))
          )
            c.push(re(o.L, b));
        }
        if (c.length > 0) {
          let u = [],
            f = [a];
          for (let L = f.pop(); L; L = f.pop())
            if (jn.has(L.type)) u.push(L);
            else {
              f.push(...L.children);
              let b = L.type === "heredoc_redirect" && lt(L);
              if (b) u.push(b);
            }
          o.zshMathDiff =
            c.some(
              (L) =>
                !u.some((b) => need(b).startIndex <= L && L < need(b).endIndex),
            ) && q(o.switches, e, ue);
        }
      }
      if (Rar.test(e) && q(o.switches, e, le)) o.dollarOperandDiff = !0;
      if (
        o.zshBraceDiff ||
        o.L.zshCondParenDiff ||
        o.dollarOperandDiff ||
        o.zshMathDiff ||
        o.keywordDesync
      ) {
        let c = {
          ...d(o, "ERROR", need(a).startIndex, need(a).endIndex, [a]),
          ...(o.misreading !== void 0 && { misreading: o.misreading }),
        };
        if (o.keywordDesync) return { ...c, keywordAfterPrefix: !0 };
        return c;
      }
      return o.misreading === void 0 ? a : { ...a, misreading: o.misreading };
    } catch {
      return o.timedOut ? be : null;
    }
  }
  /** Count source UTF-8 bytes using the native surrogate cursor rules. Source production fn. */
  function fn(e: string): number {
    let s = 0;
    for (let n = 0; n < e.length; n++) {
      let t = e.charCodeAt(n);
      if (t < 128) s++;
      else if (t < 2048) s += 2;
      else if (t >= 55296 && t <= 56319) {
        s += 4;
        n++;
      } else s += 3;
    }
    return s;
  }
  /** Charge node creation and sample the deadline every 128 nodes. Source production Ln. */
  function Ln(e: ParseContext): void {
    if ((e.nodeCount++, e.nodeCount > Vt))
      throw ((e.aborted = !0), Error("budget"));
    if ((e.nodeCount & 127) === 0 && now() > e.deadline)
      throw ((e.aborted = !0), (e.timedOut = !0), Error("timeout"));
  }
  function d(
    e: ParseContext,
    s: string,
    n: number,
    t: number,
    r: NativeBashSyntaxNode[],
  ): NativeBashSyntaxNode {
    return (
      Ln(e),
      { type: s, text: F(e, n, t), startIndex: n, endIndex: t, children: r }
    );
  }
  function BVo(e: string): boolean {
    return /\$(?:\{(?:\([^)}]{0,32}\))?)?[#^=~+!]*(?:[A-Za-z_]\w*)?[\u0080-\uffff]/.test(
      e,
    );
  }
  /** Recover exact node text from UTF-8 byte offsets. Source production F. */
  function F(e: ParseContext, s: number, n: number): string {
    if (e.isAscii) return e.src.slice(s, n);
    let t = e.L;
    if (!t.byteTable) re(t, 0);
    let r = need(t.byteTable),
      o = 0,
      a = e.src.length;
    while (o < a) {
      let u = (o + a) >>> 1;
      if (need(r[u]) < s) o = u + 1;
      else a = u;
    }
    let c = o;
    {
      o = c;
      a = e.src.length;
    }
    while (o < a) {
      let u = (o + a) >>> 1;
      if (need(r[u]) < n) o = u + 1;
      else a = u;
    }
    return e.src.slice(c, o);
  }
  function g(e: ParseContext, s: string, n: Token): NativeBashSyntaxNode {
    return d(e, s, n.start, n.end, []);
  }
  /** Parse the full program, preserving comments and error nodes. Source production bn. */
  function bn(e: ParseContext): NativeBashSyntaxNode {
    let s = [];
    m(e.L);
    for (;;) {
      let r = k(e.L);
      if (S(e.L, "cmd").type === "NEWLINE") {
        m(e.L);
        continue;
      }
      y(e.L, r);
      break;
    }
    let n = e.L.b;
    while (e.L.i < e.L.len) {
      let r = k(e.L),
        o = S(e.L, "cmd");
      if (o.type === "EOF") break;
      if (o.type === "NEWLINE") continue;
      if (o.type === "COMMENT") {
        s.push(g(e, "comment", o));
        continue;
      }
      y(e.L, r);
      let a = B(e, null);
      for (let c of a) s.push(c);
      if (a.length === 0) {
        let c = S(e.L, "cmd");
        if (c.type === "EOF") break;
        if (c.type === "OP" && c.value === ";;" && s.length > 0) continue;
        s.push(d(e, "ERROR", c.start, c.end, []));
      }
    }
    let t = s.length > 0 ? e.srcBytes : n;
    return d(e, "program", n, t, s);
  }
  function k(e: Lexer): number {
    return e.b * Ne + e.i;
  }
  function y(e: Lexer, s: number): void {
    let n = Math.floor(s / Ne);
    {
      e.i = s - n * Ne;
      e.b = n;
      vt(e);
    }
  }
  function vt(e: Lexer): void {
    for (
      let s = e.dollarStarts.at(-1);
      s !== void 0 && s >= e.i;
      s = e.dollarStarts.at(-1)
    ) {
      e.dollarEnds.delete(s);
      e.dollarStarts.pop();
    }
  }
  function Ke(e: Lexer, s: number, n: number): void {
    {
      e.dollarEnds.set(s, n);
      e.dollarStarts.push(s);
    }
  }
  /** Parse a command list up to its lexical stop boundary. Source production B. */
  function B(e: ParseContext, s: string | null): NativeBashSyntaxNode[] {
    let n = [];
    for (;;) {
      m(e.L);
      let t = k(e.L),
        r = S(e.L, "cmd");
      if (r.type === "EOF") {
        y(e.L, t);
        break;
      }
      if (r.type === "NEWLINE") {
        if (e.L.heredocs.length > 0) Xe(e);
        continue;
      }
      if (r.type === "COMMENT") {
        n.push(g(e, "comment", r));
        continue;
      }
      if (s && r.type === "OP" && r.value === s) {
        y(e.L, t);
        break;
      }
      if (
        r.type === "OP" &&
        (r.value === ")" ||
          r.value === "}" ||
          r.value === ";;" ||
          r.value === ";&" ||
          r.value === ";;&" ||
          r.value === "))" ||
          r.value === "]]" ||
          r.value === "]")
      ) {
        y(e.L, t);
        break;
      }
      if (r.type === "BACKTICK" && e.inBacktick > 0) {
        y(e.L, t);
        break;
      }
      if (
        r.type === "WORD" &&
        (r.value === "then" ||
          r.value === "elif" ||
          r.value === "else" ||
          r.value === "fi" ||
          r.value === "do" ||
          r.value === "done" ||
          r.value === "esac")
      ) {
        y(e.L, t);
        break;
      }
      y(e.L, t);
      let o = wt(e);
      if (!o) break;
      {
        n.push(o);
        m(e.L);
      }
      let a = k(e.L),
        c = S(e.L, "cmd");
      if (c.type === "OP" && (c.value === ";" || c.value === "&")) {
        let u = k(e.L),
          f = S(e.L, "cmd");
        if (
          (y(e.L, u),
          n.push(g(e, c.value, c)),
          f.type === "EOF" ||
            (f.type === "OP" &&
              (f.value === ")" ||
                f.value === "}" ||
                f.value === ";;" ||
                f.value === ";&" ||
                f.value === ";;&")) ||
            (f.type === "WORD" &&
              (f.value === "then" ||
                f.value === "elif" ||
                f.value === "else" ||
                f.value === "fi" ||
                f.value === "do" ||
                f.value === "done" ||
                f.value === "esac")))
        )
          continue;
      } else if (c.type === "NEWLINE") {
        if (e.L.heredocs.length > 0) Xe(e);
        continue;
      } else y(e.L, a);
    }
    return n;
  }
  /** Parse boolean command lists. Source production wt. */
  function wt(e: ParseContext): NativeBashSyntaxNode | null {
    let s = ut(e);
    if (!s) return null;
    for (;;) {
      let n = k(e.L),
        t = S(e.L, "cmd");
      if (t.type === "OP" && (t.value === "&&" || t.value === "||")) {
        let r = g(e, t.value, t);
        Z(e);
        let o = ut(e);
        if (!o) {
          s = d(e, "ERROR", s.startIndex, r.endIndex, [s, r]);
          break;
        }
        if (o.type === "redirected_statement" && o.children.length >= 2) {
          let a = need(o.children[0]),
            c = o.children.slice(1),
            u = d(e, "list", s.startIndex, need(a).endIndex, [s, r, a]),
            f = c.at(-1);
          s = d(e, "redirected_statement", u.startIndex, need(f).endIndex, [
            u,
            ...c,
          ]);
        } else s = d(e, "list", s.startIndex, need(o).endIndex, [s, r, o]);
      } else {
        y(e.L, n);
        break;
      }
    }
    return s;
  }
  function Z(e: ParseContext): void {
    for (;;) {
      let s = k(e.L);
      if (S(e.L, "cmd").type !== "NEWLINE") {
        y(e.L, s);
        break;
      }
    }
  }
  /** Parse pipelines and stderr pipelines. Source production ut. */
  function ut(e: ParseContext): NativeBashSyntaxNode | null {
    let s = j(e);
    if (!s) return null;
    let n = [s];
    for (;;) {
      let r = k(e.L),
        o = S(e.L, "cmd");
      if (o.type === "OP" && (o.value === "|" || o.value === "|&")) {
        let a = g(e, o.value, o);
        Z(e);
        let c = j(e);
        if (!c) {
          n.push(a);
          break;
        }
        if (
          c.type === "redirected_statement" &&
          c.children.length >= 2 &&
          n.length >= 1
        ) {
          let u = need(c.children[0]),
            f = c.children.slice(1),
            L = [...n, a, need(u)],
            b = d(e, "pipeline", need(L[0]).startIndex, need(u).endIndex, L),
            h = f.at(-1),
            p = d(
              e,
              "redirected_statement",
              need(b).startIndex,
              need(h).endIndex,
              [b, ...f],
            );
          {
            n.length = 0;
            n.push(p);
            s = p;
          }
          continue;
        }
        n.push(a, c);
      } else {
        y(e.L, r);
        break;
      }
    }
    if (n.length === 1) return need(n[0]);
    let t = n.at(-1);
    return d(e, "pipeline", need(n[0]).startIndex, need(t).endIndex, n);
  }
  /** Parse compound statements, groups, subshells and reserved productions. Source production j. */
  function j(e: ParseContext): NativeBashSyntaxNode | null {
    m(e.L);
    let s = k(e.L),
      n = S(e.L, "cmd");
    if (n.type === "EOF") return (y(e.L, s), null);
    if (n.type === "OP" && n.value === "!") {
      let t = g(e, "!", n),
        r = j(e);
      if (!r) return d(e, "negated_command", t.startIndex, t.endIndex, [t]);
      if (r.type === "redirected_statement" && r.children.length >= 2) {
        let o = need(r.children[0]),
          a = r.children.slice(1),
          c = d(e, "negated_command", t.startIndex, need(o).endIndex, [t, o]),
          u = a.at(-1);
        return d(e, "redirected_statement", c.startIndex, need(u).endIndex, [
          c,
          ...a,
        ]);
      }
      return d(e, "negated_command", t.startIndex, r.endIndex, [t, r]);
    }
    if (n.type === "OP" && n.value === "(") {
      let t = g(e, "(", n),
        r = B(e, ")"),
        o = S(e.L, "cmd"),
        a =
          o.type === "OP" && o.value === ")"
            ? g(e, ")", o)
            : d(e, ")", t.endIndex, t.endIndex, []),
        c = d(e, "subshell", t.startIndex, need(a).endIndex, [t, ...r, a]);
      return K(e, c);
    }
    if (n.type === "OP" && n.value === "((") {
      let t = g(e, "((", n),
        r = e.L.i,
        o = _e(e, "))", "var");
      m(e.L);
      let a = De(e, r, ")", !0),
        c = [t, ...o];
      if ((l(e.L) !== ")" || l(e.L, 1) !== ")") && Ut(e, a, !0))
        c.push(d(e, "))", t.endIndex, t.endIndex, []));
      let u = S(e.L, "cmd"),
        f =
          u.value === "))"
            ? g(e, "))", u)
            : d(e, "))", t.endIndex, t.endIndex, []);
      return d(e, "compound_statement", t.startIndex, f.endIndex, [...c, f]);
    }
    if (n.type === "OP" && n.value === "{") {
      let t = g(e, "{", n),
        r = B(e, "}"),
        o = S(e.L, "cmd"),
        a =
          o.type === "OP" && o.value === "}"
            ? g(e, "}", o)
            : d(e, "}", t.endIndex, t.endIndex, []),
        c = d(e, "compound_statement", t.startIndex, need(a).endIndex, [
          t,
          ...r,
          a,
        ]);
      return K(e, c);
    }
    if (n.type === "OP" && (n.value === "[" || n.value === "[[")) {
      let t = g(e, n.value, n),
        r = n.value === "[" ? "]" : "]]",
        o = k(e.L),
        a = xt(e, r);
      if ((m(e.L), n.value === "[" && l(e.L) !== "]")) {
        y(e.L, o);
        let h = e.stopToken;
        e.stopToken = "]";
        let p = j(e);
        if (((e.stopToken = h), p && p.type === "redirected_statement")) a = p;
        else {
          y(e.L, o);
          a = xt(e, r);
        }
        m(e.L);
      }
      let c = k(e.L),
        u = S(e.L, "arg"),
        f;
      if (u.value === r && Qe(l(e.L))) f = g(e, r, u);
      else {
        y(e.L, c);
        f = d(e, r, t.endIndex, t.endIndex, []);
      }
      let L = a ? [t, a, f] : [t, f],
        b = K(e, d(e, "test_command", t.startIndex, f.endIndex, L));
      if (f.text === "]" && qt(e)) e.misreading ??= "words_after_test";
      return b;
    }
    if (n.type === "WORD" && kt(l(e.L))) {
      if (n.value === "if") return K(e, zn(e, n), !0);
      if (n.value === "while" || n.value === "until") return K(e, Wn(e, n), !0);
      if (n.value === "for") return K(e, ht(e, n), !0);
      if (n.value === "select") return K(e, ht(e, n), !0);
      if (n.value === "case") return K(e, Un(e, n), !0);
      if (n.value === "function") return Kn(e, n);
      if (sn.has(n.value)) return K(e, Qn(e, n));
      if (n.value === "unset" || n.value === "unsetenv") {
        let t = k(e.L);
        m(e.L);
        let r = !1;
        if (l(e.L) === "(") {
          S(e.L, "cmd");
          m(e.L);
          r = l(e.L) === ")";
        }
        if ((y(e.L, t), !r)) return K(e, Gn(e, n));
      }
    }
    return (y(e.L, s), pn(e));
  }
  /** Parse simple commands, declarations and leading assignments/redirects. Source production pn. */
  function pn(e: ParseContext): NativeBashSyntaxNode | null {
    let s = e.L.b,
      n = [],
      t = [];
    for (;;) {
      m(e.L);
      let T = At(e);
      if (T) {
        n.push(T);
        continue;
      }
      let N = ne(e);
      if (N) {
        t.push(N);
        continue;
      }
      break;
    }
    m(e.L);
    let r = k(e.L),
      o = S(e.L, "cmd");
    if (
      o.type === "EOF" ||
      o.type === "NEWLINE" ||
      o.type === "COMMENT" ||
      o.type === "BACKTICK" ||
      (o.type === "OP" &&
        o.value !== "{" &&
        o.value !== "[" &&
        o.value !== "[[") ||
      (o.type === "WORD" && YQn.has(o.value) && o.value !== "in")
    ) {
      if (
        (y(e.L, r),
        (n.length > 0 || t.length > 0) &&
          o.type === "WORD" &&
          YQn.has(o.value) &&
          o.value !== "in" &&
          q(e.switches, e.src, oe))
      ) {
        let T = [...n, ...t].sort((N, E) => N.startIndex - E.startIndex);
        return (
          (e.keywordDesync = !0),
          nxn(),
          d(e, "ERROR", s, need(T.at(-1)).endIndex, T)
        );
      }
      if (n.length === 1 && t.length === 0) return need(n[0]);
      if (t.length > 0 && n.length === 0) {
        let T = t.at(-1);
        return d(
          e,
          "redirected_statement",
          need(t[0]).startIndex,
          need(T).endIndex,
          t,
        );
      }
      if (n.length > 1 && t.length === 0) {
        let T = n.at(-1);
        return d(
          e,
          "variable_assignments",
          need(n[0]).startIndex,
          need(T).endIndex,
          n,
        );
      }
      if (n.length > 0 || t.length > 0) {
        let T = [...n, ...t],
          N = T.at(-1);
        return d(e, "command", s, need(N).endIndex, T);
      }
      return null;
    }
    y(e.L, r);
    let a = k(e.L),
      c = W(e, "cmd");
    if (c && c.type === "word") {
      m(e.L);
      let T = !1;
      if (l(e.L) === "(") {
        let N = k(e.L);
        {
          S(e.L, "cmd");
          m(e.L);
          T = l(e.L) === ")";
          y(e.L, N);
        }
      }
      if (T) {
        let N = S(e.L, "cmd");
        m(e.L);
        let E = S(e.L, "cmd"),
          A = g(e, "(", N),
          H = g(e, ")", E);
        {
          m(e.L);
          Z(e);
        }
        let U = j(e);
        if (U) {
          let ie = [U];
          if (
            U.type === "redirected_statement" &&
            U.children.length >= 2 &&
            need(U.children[0]).type === "compound_statement"
          )
            ie = U.children;
          let ze = ie.at(-1),
            V = d(e, "function_definition", c.startIndex, need(ze).endIndex, [
              c,
              A,
              H,
              ...ie,
            ]),
            J = [...n, ...t].sort((Ht, Kt) => Ht.startIndex - Kt.startIndex);
          if (J.length === 0 || !q(e.switches, e.src, ve)) return V;
          return (
            (e.keywordDesync = !0),
            nxn(),
            d(e, "ERROR", s, V.endIndex, [...J, V])
          );
        }
      }
    }
    y(e.L, a);
    let u = W(e, "cmd");
    if (!u) {
      if (n.length === 1) return need(n[0]);
      return null;
    }
    let f = d(e, "command_name", u.startIndex, need(u).endIndex, [u]);
    if (
      (n.length + t.length > 0 &&
        bt(u) &&
        (u.text !== "time" || e.sawIfOrLoop)) ||
      u.text.startsWith("{")
    )
      e.misreading ??= "reserved_word_after_prefix";
    let b = [],
      h = [],
      p = null;
    for (;;) {
      m(e.L);
      let T = ne(e, !0);
      if (T) {
        if (T.type === "heredoc_redirect") p = T;
        else if (T.type === "herestring_redirect") b.push(T);
        else h.push(T);
        continue;
      }
      if (h.length > 0) {
        if (!(e.stopToken === "]" && l(e.L) === "]") && qt(e))
          e.misreading ??= "words_after_redirect";
        break;
      }
      if (e.stopToken === "]" && l(e.L) === "]") break;
      let N = k(e.L),
        E = S(e.L, "arg");
      if (
        E.type === "EOF" ||
        E.type === "NEWLINE" ||
        E.type === "COMMENT" ||
        (E.type === "OP" &&
          (E.value === "|" ||
            E.value === "|&" ||
            E.value === "&&" ||
            E.value === "||" ||
            E.value === ";" ||
            E.value === ";;" ||
            E.value === ";&" ||
            E.value === ";;&" ||
            E.value === "&" ||
            E.value === ")" ||
            E.value === "}" ||
            E.value === "))"))
      ) {
        y(e.L, N);
        break;
      }
      y(e.L, N);
      let A = W(e, "arg");
      if (!A) {
        if (l(e.L) === "(") {
          if (l(e.L, 1) === "(" && Y(e)) e.zshMathDiff = !0;
          let H = S(e.L, "cmd"),
            U = g(e, "(", H),
            ie = B(e, ")"),
            ze = k(e.L),
            V = S(e.L, "cmd"),
            J;
          if (V.type === "OP" && V.value === ")") J = g(e, ")", V);
          else {
            y(e.L, ze);
            J = d(e, ")", U.endIndex, U.endIndex, []);
          }
          b.push(d(e, "subshell", U.startIndex, J.endIndex, [U, ...ie, J]));
          continue;
        }
        break;
      }
      if (A.type === "word" && A.text === "=") {
        b.push(d(e, "ERROR", A.startIndex, A.endIndex, [A]));
        continue;
      }
      if (
        (A.type === "word" || A.type === "concatenation") &&
        l(e.L) === "(" &&
        e.L.b === A.endIndex
      ) {
        b.push(d(e, "ERROR", A.startIndex, A.endIndex, [A]));
        continue;
      }
      b.push(A);
    }
    let x = gn(u, b, h, p);
    if ((ft(u) || x.some(ft)) && q(e.switches, e.src, P))
      e.misreading ??= "bracket_word";
    let I =
      u.text === "time" && n.length + t.length === 0 && b[0]?.text === "!"
        ? b[0]
        : null;
    if (x.some((T) => T !== I && bt(T)))
      e.misreading ??= "reserved_word_after_prefix";
    let v = [...n, ...t, f, ...b],
      R = v.length > 0 ? need(v.at(-1)).endIndex : f.endIndex,
      w = need(v[0]).startIndex,
      O = d(e, "command", w, R, v);
    if (p) {
      Xe(e);
      let T = e.L.heredocs.shift();
      if (T && p.children.length >= 2) {
        let A = d(
            e,
            "heredoc_body",
            T.bodyStart,
            T.bodyEnd,
            T.quoted ? [] : vn(e, T.bodyStart, T.bodyEnd),
          ),
          H = d(e, "heredoc_end", T.endStart, T.endEnd, []);
        p = {
          type: p.type,
          text: F(e, p.startIndex, T.endEnd),
          startIndex: p.startIndex,
          endIndex: T.endEnd,
          children: [...p.children, A, H],
        };
      }
      let N = [...t, p, ...h],
        E =
          t.length > 0
            ? Math.min(O.startIndex, need(t[0]).startIndex)
            : O.startIndex;
      return d(e, "redirected_statement", E, p.endIndex, [O, ...N]);
    }
    if (h.length > 0) {
      let T = h.at(-1);
      return d(e, "redirected_statement", O.startIndex, need(T).endIndex, [
        O,
        ...h,
      ]);
    }
    return O;
  }
  function K(
    e: ParseContext,
    s: NativeBashSyntaxNode,
    n = false,
  ): NativeBashSyntaxNode {
    let t = [];
    for (;;) {
      m(e.L);
      let o = k(e.L),
        a = ne(e);
      if (!a) break;
      if (a.type === "herestring_redirect" && !n) {
        y(e.L, o);
        break;
      }
      t.push(a);
    }
    if (t.length === 0) return s;
    let r = t.at(-1);
    return d(e, "redirected_statement", s.startIndex, need(r).endIndex, [
      s,
      ...t,
    ]);
  }
  var hn = 20000,
    xn = /#|<<|`|\$'|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?/g,
    Et = /^(?:[#`]|<<|\$'$|".*(?:`|\$[([]|\$\{(?!\w*\})))/s,
    Le =
      /\\[\s\S]|\$'(?:\\[\s\S]|[^'\\])*'?|'[^']*'?|"(?:\\[\s\S]|[^"\\])*"?|\$\{|[}[\];\n]/g;
  function Ge(e: NativeBashSyntaxNode, s: string): boolean {
    return e.type === "word" && e.endIndex - e.startIndex === 1 && e.text === s;
  }
  function Rt(e: NativeBashSyntaxNode, s = true): boolean {
    let n = e.type === "concatenation" ? e.children : [e],
      t = 0;
    for (let r of n)
      if (Ge(r, "[")) t++;
      else if (Ge(r, "]")) t = Math.max(0, t - 1);
      else if (t > 0 && !(s ? yn(r) : Nt(r))) return !0;
    return t > 0;
  }
  function Nt(e: NativeBashSyntaxNode): boolean {
    return (
      (e.type === "word" || (e.type === "number" && e.children.length === 0)) &&
      !/[{}"'`$\\]/.test(e.text)
    );
  }
  var Ot = `[](){}"'\`\\;|&<>#$
`,
    mn = /^\$\{#?[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z0-9_@*]+\])?\}/,
    _n = /^\$\(\([A-Za-z0-9_+\-*/% ]*\)\)/;
  function Ze(e: string, s: number): number {
    let n = e.slice(s, s + 80),
      t = mn.exec(n) ?? _n.exec(n);
    return t ? t[0].length : 0;
  }
  function yn(e: NativeBashSyntaxNode): boolean {
    if (Nt(e)) return !0;
    switch (e.type) {
      case "raw_string":
        return !/[[\]\n]/.test(e.text);
      case "string": {
        if (!e.text.startsWith('"')) return !1;
        let s = e.text.slice(1, -1);
        for (let n = s.indexOf("$"); n !== -1; n = s.indexOf("$", n + 1)) {
          let t = Ze(s, n);
          if (t > 0) {
            s = s.slice(0, n) + s.slice(n + t);
            n--;
          }
        }
        return !/[[\]\n\\`]|\$[({['"]/.test(s);
      }
      case "simple_expansion":
        return !0;
      case "expansion": {
        if (Ze(e.text, 0) === e.text.length) return !0;
        let s = e.text.slice(2, -1);
        return (
          e.text.startsWith("${") &&
          e.text.endsWith("}") &&
          /^[A-Za-z0-9_!@*?-]/.test(s) &&
          !/[ \t]/.test(s) &&
          !dt(s)
        );
      }
      case "arithmetic_expansion":
        return (
          e.text.startsWith("$((") &&
          e.text.endsWith("))") &&
          !dt(e.text.slice(3, -2))
        );
      default:
        return !1;
    }
  }
  function dt(e: string): boolean {
    for (let s of e) if (Ot.includes(s)) return !0;
    return !1;
  }
  function ft(e: NativeBashSyntaxNode): boolean {
    return (
      e.type === "concatenation" &&
      need(e.children[0]).type === "word" &&
      In(need(e.children[0]).text) &&
      e.children.some((s) => Ge(s, "[")) &&
      Rt(e, !1)
    );
  }
  var Lt = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*(?:\[.*\])?\+?=/s,
    Dt = new Set([...YQn, "{", "}", "!", "[[", "]]", "time", "coproc"]);
  function bt(e: NativeBashSyntaxNode): boolean {
    return Dt.has(e.text) || e.text.startsWith("{");
  }
  function gn(
    e: NativeBashSyntaxNode,
    s: NativeBashSyntaxNode[],
    n: NativeBashSyntaxNode[],
    t: NativeBashSyntaxNode | null | undefined,
  ): NativeBashSyntaxNode[] {
    if (e.text !== "time" && e.text !== "coproc" && !Lt.test(e.text)) return [];
    let r = [],
      o = [...s, ...n, ...(t ? [t] : [])];
    for (let f of o.sort((L, b) => L.startIndex - need(b).startIndex)) {
      if (!f.type.endsWith("_redirect")) {
        r.push(f);
        continue;
      }
      let L = f.children.findIndex((b) => /^[<>&|]+-?$/.test(b.type));
      if (L !== -1) {
        let b = /^[<>]&-$/.test(need(f.children[L]).type);
        r.push(...f.children.slice(b ? L + 1 : L + 2));
      }
    }
    let a = e.text === "coproc" ? 2 : 1,
      c = e.text === "time" ? 2 : 0,
      u = [];
    for (let f of r) {
      if (a === 0) break;
      if ((u.push(f), c === 2 && f.text === "-p")) {
        c = 1;
        continue;
      } else if (c > 0 && f.text === "--") {
        c = 0;
        continue;
      } else if (Dt.has(f.text)) a = 1 / 0;
      else if (
        Lt.test(f.text) ||
        !/^(?:word|number|concatenation|string|raw_string)$/.test(f.type)
      ) {
        /* Preserve the candidate without decrementing the prefix count. */
      } else a--;
      c = 0;
    }
    return u;
  }
  function In(e: string): boolean {
    let s = e[0] ?? "";
    if (!M(s) && s < "\x80") return !1;
    for (let n = 1; n < e.length; n++) {
      let t = e[n];
      if (!z(t) && need(t) < "\x80") return !1;
    }
    return !0;
  }
  function Tn(e: string, s: number, n: number): boolean {
    let t = "",
      r = 0,
      o = s;
    while (o < n) {
      let a = need(e[o]);
      if (r === 0 && a === "$" && (t === "" || t === '"')) r = Ze(e, o);
      if (r > 0) r--;
      else if (t !== "") {
        if (e.startsWith(t, o)) {
          o += t.length - 1;
          t = "";
        } else if (
          t === "'"
            ? `[]
`.includes(a)
            : t === '"'
              ? `[]
\\\``.includes(a) ||
                (a === "$" && `({['"`.includes(e[o + 1] ?? " "))
              : Ot.includes(a) || (t === "}" && (a === " " || a === "\t"))
        )
          return !0;
      } else if (a === "[") return !0;
      else if (a === '"' || a === "'") t = a;
      else if (a === "$" && e.startsWith("((", o + 1)) {
        t = "))";
        o += 2;
      } else if (a === "$" && e[o + 1] === "{") {
        if (!/[A-Za-z0-9_!@*?-]/.test(e[o + 2] ?? " ")) return !0;
        {
          t = "}";
          o += 1;
        }
      } else if (a === "$" && `('"`.includes(e[o + 1] ?? " ")) return !0;
      else if (" \t\n;&|<>(){}`\\".includes(a)) return !0;
      o++;
    }
    return t !== "";
  }
  /** Parse shell assignments, arrays and subscripts. Source production At. */
  function At(e: ParseContext): NativeBashSyntaxNode | null {
    let s = k(e.L);
    m(e.L);
    let n = e.L.b;
    if (!M(l(e.L))) return (y(e.L, s), null);
    while (z(l(e.L))) i(e.L);
    let t = e.L.b,
      r = t,
      o = e.L.i + 1;
    if (l(e.L) === "[") {
      {
        je(e);
        i(e.L);
      }
      let R = 1;
      while (e.L.i < e.L.len && R > 0) {
        let w = l(e.L);
        if (w === "[") R++;
        else if (w === "]") R--;
        i(e.L);
      }
      r = e.L.b;
    }
    let a = r > t && Tn(e.src, o, e.L.i - 1),
      c = l(e.L),
      u = l(e.L, 1),
      f;
    if (c === "=" && u !== "=") f = "=";
    else if (c === "+" && u === "=") f = "+=";
    else return (y(e.L, s), null);
    let L = d(e, "variable_name", n, t, []),
      b = L;
    if (r > t) {
      ye(e, t);
      let R = d(e, "[", t, t + 1, []),
        w = kn(e, t + 1, r - 1),
        O = d(e, "]", r - 1, r, []);
      if (
        ((b = d(e, "subscript", n, r, [L, R, w, O])),
        a && q(e.switches, e.src, P))
      )
        e.misreading ??= "bracket_word";
    }
    let h = e.L.b;
    if ((i(e.L), f === "+=")) i(e.L);
    let p = e.L.b,
      x = d(e, f, h, p, []),
      _ = null;
    if (l(e.L) === "(") {
      let R = S(e.L, "cmd"),
        w = g(e, "(", R),
        O = [w];
      for (;;) {
        if ((m(e.L), l(e.L) === ")")) break;
        let H = l(e.L) === "[";
        if (H) je(e);
        let U = W(e, "arg", H);
        if (!U) break;
        O.push(U);
      }
      let T = S(e.L, "cmd"),
        N =
          T.value === ")"
            ? g(e, ")", T)
            : d(e, ")", w.endIndex, w.endIndex, []),
        E = l(e.L),
        A =
          T.value === ")" &&
          !(
            E === "" ||
            ` 	
;&|)`.includes(E)
          ) &&
          !(E === "`" && e.inBacktick > 0);
      if (
        (T.value !== ")" ||
          A ||
          O.some((H) => H.text.startsWith("#") || Rt(H))) &&
        q(e.switches, e.src, P)
      )
        e.misreading ??= "bracket_word";
      {
        O.push(N);
        _ = d(e, "array", w.startIndex, N.endIndex, O);
      }
    } else {
      let R = l(e.L);
      if (
        R &&
        R !== " " &&
        R !== "\t" &&
        R !==
          `
` &&
        R !== ";" &&
        R !== "&" &&
        R !== "|" &&
        R !== ")" &&
        R !== "}"
      )
        _ = W(e, "arg");
    }
    let I = _ ? [b, x, _] : [b, x],
      v = _ ? _.endIndex : p;
    return d(e, "variable_assignment", n, v, I);
  }
  function je(e: ParseContext, s = 0, n = true): void {
    if (!zt(e)) return;
    if (e.subscriptRead > hn) {
      xe(e, e.L.b, e.srcBytes, n);
      return;
    }
    let t = s,
      r = 0,
      o = e.L.len,
      a = !1;
    Le.lastIndex = e.L.i;
    for (let c = Le.exec(e.src); c; c = Le.exec(e.src)) {
      if (Et.test(c[0])) {
        a = n && X(tt(e), e.L.b, e.srcBytes);
        break;
      }
      if (((a ||= n && /^'.*(?:`|\$\()/s.test(c[0])), c[0] === "${")) r++;
      else if (c[0] === "}") r = Math.max(r - 1, 0);
      else if (r > 0) continue;
      else if (c[0] === "[") t++;
      else if (/^['"]/.test(c[0]) && c[0].includes("[")) t = 1 / 0;
      else if (
        c[0] === ";" ||
        c[0] ===
          `
` ||
        (c[0] === "]" && --t === 0 && e.src[Le.lastIndex] !== "[")
      ) {
        o = Le.lastIndex;
        break;
      }
    }
    {
      e.subscriptRead += o - e.L.i;
      xe(e, e.L.b, re(e.L, o), a);
    }
  }
  function Sn(e: ParseContext): NativeBashSyntaxNode | null {
    m(e.L);
    let s = l(e.L);
    if ((s === "@" || s === "*") && l(e.L, 1) === "]") {
      let n = e.L.b;
      return (i(e.L), d(e, "word", n, e.L.b, []));
    }
    if (s === "(" && l(e.L, 1) === "(") {
      let n = e.L.b;
      {
        i(e.L);
        i(e.L);
      }
      let t = d(e, "((", n, e.L.b, []),
        r = me(e, "))", "var");
      m(e.L);
      let o;
      if (l(e.L) === ")" && l(e.L, 1) === ")") {
        let c = e.L.b;
        {
          i(e.L);
          i(e.L);
          o = d(e, "))", c, e.L.b, []);
        }
      } else o = d(e, "))", e.L.b, e.L.b, []);
      let a = r ? [t, r, o] : [t, o];
      return d(e, "compound_statement", t.startIndex, need(o).endIndex, a);
    }
    return me(e, "]", "word");
  }
  function kn(e: ParseContext, s: number, n: number): NativeBashSyntaxNode {
    let t = F(e, s, n);
    if (/^\d+$/.test(t)) return d(e, "number", s, n, []);
    if (/^\$([a-zA-Z_]\w*)$/.exec(t)) {
      let o = d(e, "$", s, s + 1, []),
        a = d(e, "variable_name", s + 1, n, []);
      return d(e, "simple_expansion", s, n, [o, a]);
    }
    if (t.length === 2 && t[0] === "$" && se.has(need(t[1]))) {
      let o = d(e, "$", s, s + 1, []),
        a = d(e, "special_variable_name", s + 1, n, []);
      return d(e, "simple_expansion", s, n, [o, a]);
    }
    return d(e, "word", s, n, []);
  }
  function pt(e: ParseContext): boolean {
    let s = l(e.L);
    if (
      s === "" ||
      s ===
        `
`
    )
      return !1;
    if (s === "|" || s === "&" || s === ";" || s === "(" || s === ")")
      return !1;
    if (s === "<" || s === ">") return l(e.L, 1) === "(";
    if (D(s) && $t(e).isDescriptor) return !1;
    if (s === "}") return !1;
    if (e.stopToken === "]" && s === "]") return !1;
    return !0;
  }
  function $t(e: ParseContext): { end: number; isDescriptor: boolean } {
    let s = e.L.i;
    while (s < e.L.len && D(e.L.src[s])) s++;
    let n = s < e.L.len ? e.L.src[s] : "",
      t = n === ">" || n === "<";
    if (
      t
        ? s - e.L.i > 1 && e.L.src[s + 1] !== "("
        : s - e.L.i === 1 && e.L.src.startsWith("&>", s)
    )
      e.misreading ??= "digits_before_redirect";
    return { end: s, isDescriptor: t };
  }
  /** Parse file redirects, heredocs, here strings and descriptors. Source production ne. */
  function ne(e: ParseContext, s = false): NativeBashSyntaxNode | null {
    let n = k(e.L);
    m(e.L);
    let t = null;
    if (D(l(e.L))) {
      let a = e.L.b,
        { end: c, isDescriptor: u } = $t(e);
      if (u) {
        while (e.L.i < c) i(e.L);
        t = d(e, "file_descriptor", a, e.L.b, []);
      }
    }
    if (t === null && l(e.L) === "{") {
      let a = e.L.i + 1;
      if (a < e.L.len && /[A-Za-z_]/.test(need(e.L.src[a]))) {
        while (a < e.L.len && /[A-Za-z0-9_]/.test(need(e.L.src[a]))) a++;
        if (e.L.src[a] === "[") {
          let c = 0,
            u = !1,
            f = !1;
          while (a < e.L.len) {
            let L = e.L.src[a];
            if (u) {
              if (L === "'") u = !1;
            } else if (f) {
              if (L === "\\" && a + 1 < e.L.len) a++;
              else if (L === '"') f = !1;
            } else if (L === "\\" && a + 1 < e.L.len) a++;
            else if (L === "'") u = !0;
            else if (L === '"') f = !0;
            else if (L === "[") c++;
            else if (L === "]") {
              if ((c--, c === 0)) {
                a++;
                break;
              }
            } else if (
              L === "\\" &&
              e.L.src[a + 1] ===
                `
`
            ) {
              a += 2;
              continue;
            } else if (
              L ===
              `
`
            )
              break;
            a++;
          }
        }
        if (e.L.src[a] === "}") {
          let c = a + 1 < e.L.len ? e.L.src[a + 1] : "";
          if (c === ">" || c === "<") {
            let u = e.L.b;
            while (e.L.i <= a) i(e.L);
            t = d(e, "variable_name", u, e.L.b, []);
          }
        }
      }
    }
    let r = S(e.L, "arg");
    if (r.type !== "OP") return (y(e.L, n), null);
    let o = r.value;
    if (o === "<<<") {
      let a = g(e, "<<<", r);
      m(e.L);
      let c = W(e, "arg"),
        u = c ? c.endIndex : need(a).endIndex,
        f = c ? [a, c] : [a];
      return d(
        e,
        "herestring_redirect",
        t ? t.startIndex : need(a).startIndex,
        u,
        t ? [t, ...f] : f,
      );
    }
    if (o === "<<" || o === "<<-") {
      let a = g(e, o, r);
      un(e.L);
      let c = e.L.b,
        u = !1,
        f = "",
        L = l(e.L);
      if (L === "'" || L === '"') {
        {
          u = !0;
          i(e.L);
        }
        while (e.L.i < e.L.len && l(e.L) !== L) {
          f += l(e.L);
          i(e.L);
        }
        if (e.L.i < e.L.len) i(e.L);
      } else if (L === "\\") {
        if (
          ((u = !0),
          i(e.L),
          e.L.i < e.L.len &&
            l(e.L) !==
              `
`)
        ) {
          f += l(e.L);
          i(e.L);
        }
        while (e.L.i < e.L.len && z(l(e.L))) {
          f += l(e.L);
          i(e.L);
        }
      } else
        while (e.L.i < e.L.len && ln(l(e.L))) {
          f += l(e.L);
          i(e.L);
        }
      let b = e.L.b;
      if (L === '"' && /[`$\\\n]/.test(f))
        throw (
          (e.aborted = !0),
          Error("heredoc delimiter contains substitution/escape chars")
        );
      if (e.L.i < e.L.len) {
        let _ = l(e.L);
        if (
          _ !== " " &&
          _ !== "\t" &&
          _ !==
            `
` &&
          _ !== "<" &&
          _ !== ">" &&
          _ !== "|" &&
          _ !== "&" &&
          _ !== ";" &&
          _ !== "(" &&
          _ !== ")"
        )
          throw (
            (e.aborted = !0),
            Error("heredoc delimiter word continues past scanned segment")
          );
      }
      if (/[\uD800-\uDFFF]/.test(f))
        throw (
          (e.aborted = !0),
          Error("heredoc delimiter contains astral/surrogate code unit")
        );
      let h = d(e, "heredoc_start", c, b, []);
      e.L.heredocs.push({
        delim: f,
        stripTabs: o === "<<-",
        quoted: u,
        bodyStart: 0,
        bodyEnd: 0,
        endStart: 0,
        endEnd: 0,
      });
      let p = t ? [t, a, h] : [a, h],
        x = t ? t.startIndex : need(a).startIndex;
      for (;;) {
        m(e.L);
        let _ = l(e.L);
        if (
          _ ===
            `
` ||
          _ === "" ||
          e.L.i >= e.L.len
        )
          break;
        if (_ === ">" || _ === "<" || D(_)) {
          let R = k(e.L),
            w = ne(e);
          if (w && w.type === "file_redirect") {
            p.push(w);
            continue;
          }
          y(e.L, R);
        }
        if (_ === "|" && l(e.L, 1) !== "|") {
          let R = e.L.b;
          {
            i(e.L);
            m(e.L);
          }
          let w = [];
          for (;;) {
            let O = j(e);
            if (!O) break;
            if ((w.push(O), m(e.L), l(e.L) === "|" && l(e.L, 1) !== "|")) {
              let T = e.L.b;
              {
                i(e.L);
                w.push(d(e, "|", T, e.L.b, []));
                m(e.L);
              }
              continue;
            }
            break;
          }
          if (w.length > 0) {
            let O = w.at(-1);
            p.push(
              d(e, "pipeline", need(w[0]).startIndex, need(O).endIndex, w),
            );
          } else p.push(d(e, "ERROR", R, e.L.b, []));
          continue;
        }
        if (
          (_ === "&" && l(e.L, 1) === "&") ||
          (_ === "|" && l(e.L, 1) === "|")
        ) {
          let R = e.L.b;
          {
            i(e.L);
            i(e.L);
            m(e.L);
          }
          let w = j(e);
          if (w) p.push(w);
          else p.push(d(e, "ERROR", R, e.L.b, []));
          continue;
        }
        if (_ === "&" || _ === ";" || _ === "(" || _ === ")") {
          let R = e.L.b;
          while (
            e.L.i < e.L.len &&
            l(e.L) !==
              `
`
          )
            i(e.L);
          p.push(d(e, "ERROR", R, e.L.b, []));
          break;
        }
        let I = W(e, "arg");
        if (I) {
          p.push(I);
          continue;
        }
        let v = e.L.b;
        while (
          e.L.i < e.L.len &&
          l(e.L) !==
            `
`
        )
          i(e.L);
        if (e.L.b > v) p.push(d(e, "ERROR", v, e.L.b, []));
        break;
      }
      return d(e, "heredoc_redirect", x, e.L.b, p);
    }
    if (o === "<&-" || o === ">&-") {
      let a = g(e, o, r),
        c = [];
      if (t) c.push(t);
      {
        c.push(a);
        m(e.L);
      }
      let u = k(e.L),
        f = pt(e) ? W(e, "arg") : null;
      if (f) c.push(f);
      else y(e.L, u);
      let L = t ? t.startIndex : need(a).startIndex,
        b = f ? f.endIndex : need(a).endIndex;
      return d(e, "file_redirect", L, b, c);
    }
    if (
      o === ">" ||
      o === ">>" ||
      o === ">&" ||
      o === ">|" ||
      o === "&>" ||
      o === "&>>" ||
      o === "<" ||
      o === "<&"
    ) {
      let a = g(e, o, r),
        c = [];
      if (t) c.push(t);
      c.push(a);
      let u = need(a).endIndex,
        f = 0;
      for (;;) {
        if ((m(e.L), !pt(e))) break;
        if (!s && f >= 1) break;
        let b = l(e.L),
          h = l(e.L, 1),
          p = null;
        if ((b === "<" || b === ">") && h === "(") p = $e(e);
        else p = W(e, "arg");
        if (!p) break;
        {
          c.push(p);
          u = p.endIndex;
          f++;
        }
      }
      let L = t ? t.startIndex : need(a).startIndex;
      return d(e, "file_redirect", L, u, c);
    }
    return (y(e.L, n), null);
  }
  function $e(e: ParseContext): NativeBashSyntaxNode | null {
    let s = l(e.L);
    if ((s !== "<" && s !== ">") || l(e.L, 1) !== "(") return null;
    let n = e.L.b;
    {
      i(e.L);
      i(e.L);
    }
    let t = d(e, s + "(", n, e.L.b, []),
      r = B(e, ")");
    m(e.L);
    let o;
    if (l(e.L) === ")") {
      let a = e.L.b;
      {
        i(e.L);
        o = d(e, ")", a, e.L.b, []);
      }
    } else o = d(e, ")", e.L.b, e.L.b, []);
    return d(e, "process_substitution", n, need(o).endIndex, [t, ...r, o]);
  }
  /** Read queued heredoc bodies and exact terminators. Source production Xe. */
  function Xe(e: ParseContext): void {
    while (
      e.L.i < e.L.len &&
      e.L.src[e.L.i] !==
        `
`
    )
      i(e.L);
    if (e.L.i < e.L.len) i(e.L);
    for (let s of e.L.heredocs) {
      s.bodyStart = e.L.b;
      let n = s.delim.length;
      if (s.stripTabs && s.delim.startsWith("\t"))
        throw (
          (e.aborted = !0),
          Error("ambiguous heredoc terminator (<<- tab-prefixed delim)")
        );
      while (e.L.i < e.L.len) {
        let t = e.L.i,
          r = e.L.b,
          o = t;
        if (s.stripTabs) while (o < e.L.len && e.L.src[o] === "\t") o++;
        if (e.L.src.startsWith(s.delim, o)) {
          let a = o + n,
            c = a < e.L.len ? e.L.src[a] : "";
          if (
            c === "" ||
            c ===
              `
` ||
            c === "\r"
          ) {
            s.bodyEnd = r;
            while (e.L.i < o) i(e.L);
            s.endStart = e.L.b;
            for (let f = 0; f < n; f++) i(e.L);
            if (
              ((s.endEnd = e.L.b),
              e.L.i < e.L.len &&
                e.L.src[e.L.i] ===
                  `
`)
            )
              i(e.L);
            return;
          }
          let u = a;
          while (u < e.L.len) {
            let f = e.L.src[u];
            if (
              f ===
              `
`
            )
              break;
            if (f === ")" || f === "`" || f === "}")
              throw (
                (e.aborted = !0),
                Error("ambiguous heredoc terminator (shell_eof_token)")
              );
            u++;
          }
        }
        while (
          e.L.i < e.L.len &&
          e.L.src[e.L.i] !==
            `
`
        )
          i(e.L);
        if (e.L.i < e.L.len) i(e.L);
      }
      {
        s.bodyEnd = e.L.b;
        s.endStart = e.L.b;
        s.endEnd = e.L.b;
      }
    }
  }
  function vn(e: ParseContext, s: number, n: number): NativeBashSyntaxNode[] {
    let t = k(e.L);
    wn(e, s);
    let r = [],
      o = e.L.b,
      a = !1;
    while (e.L.b < n) {
      let c = l(e.L);
      if (c === "\\") {
        let u = l(e.L, 1);
        if (u === "$" || u === "`" || u === "\\") {
          {
            i(e.L);
            i(e.L);
          }
          continue;
        }
        i(e.L);
        continue;
      }
      if (c === "$" || c === "`") {
        if (c === "$" && l(e.L, 1) === "'") {
          i(e.L);
          continue;
        }
        let u = e.L.b;
        e.inDquote++;
        let f = Q(e);
        if (
          (e.inDquote--,
          f &&
            (f.type === "simple_expansion" ||
              f.type === "expansion" ||
              f.type === "command_substitution" ||
              f.type === "arithmetic_expansion" ||
              f.type === "ERROR"))
        ) {
          if (a && u > o) r.push(d(e, "heredoc_content", o, u, []));
          {
            r.push(f);
            o = e.L.b;
            a = !0;
          }
        }
        continue;
      }
      i(e.L);
    }
    if (a) r.push(d(e, "heredoc_content", o, n, []));
    return (y(e.L, t), r);
  }
  function wn(e: ParseContext, s: number): void {
    if (!e.L.byteTable) re(e.L, 0);
    let n = need(e.L.byteTable),
      t = 0,
      r = e.src.length;
    while (t < r) {
      let o = (t + r) >>> 1;
      if (need(n[o]) < s) t = o + 1;
      else r = o;
    }
    {
      e.L.i = t;
      e.L.b = s;
      vt(e.L);
    }
  }
  function Ct(e: ParseContext): WordState | null {
    return zt(e)
      ? {
          brackets: 0,
          subscriptDepth: 0,
          holdsDollar: !1,
          partsSeen: 0,
          afterExpansion: !1,
          subscriptRunsQuotes: !1,
        }
      : null;
  }
  function pe(
    e: ParseContext,
    s: NativeBashSyntaxNode[],
    n: WordState | null,
  ): void {
    if (!n) return;
    let t = s.at(-1);
    if (
      n.brackets > 0 &&
      t &&
      (n.subscriptDepth > 0 || t.type !== "raw_string")
    )
      xe(
        e,
        t.startIndex,
        t.endIndex,
        n.subscriptRunsQuotes &&
          (t.type === "raw_string" ||
            (t.type !== "word" && X(tt(e), t.startIndex, t.endIndex))),
      );
    for (; n.partsSeen < s.length; n.partsSeen++) {
      let { text: r, type: o } = need(s[n.partsSeen]),
        a = s[n.partsSeen - 1];
      if (
        ((n.holdsDollar ||= !o.endsWith("_substitution") && r.includes("$")),
        (n.afterExpansion =
          o.endsWith("expansion") ||
          o === "ansi_c_string" ||
          o === "number" ||
          r === "]" ||
          (o === "word" &&
            (/\$[#^=~+]*\w+$/.test(r) ||
              (/^\$#?$/.test(a?.text ?? "") && /^[\^=~+]*\w+$/.test(r)) ||
              (r === "}" && a?.type === "word" && /\$\{\w*$/.test(a.text))))),
        n.subscriptDepth > 0 && /^['"`<>]/.test(r) && r.includes("["))
      )
        n.brackets = 1 / 0;
    }
  }
  function Ye(e: WordState | null, s: string): void {
    if (!e) return;
    if (s === "[") {
      if (e.subscriptDepth === 0 && e.holdsDollar)
        e.subscriptDepth = e.brackets + 1;
      {
        e.subscriptRunsQuotes ||= e.afterExpansion;
        e.brackets++;
      }
    } else if (s === "]") {
      if (
        ((e.afterExpansion = !0),
        (e.brackets = Math.max(e.brackets - 1, 0)),
        e.brackets < e.subscriptDepth)
      ) {
        e.subscriptDepth = 0;
        e.subscriptRunsQuotes = !1;
      }
    }
  }
  /** Parse a shell word with concatenation and tracked subscript state. Source production W. */
  function W(
    e: ParseContext,
    s: string,
    n = false,
  ): NativeBashSyntaxNode | null {
    m(e.L);
    let t = [],
      r = Ct(e),
      o = !1;
    while (e.L.i < e.L.len) {
      pe(e, t, r);
      let u = l(e.L);
      if (
        u === " " ||
        u === "\t" ||
        u ===
          `
` ||
        u === "\r" ||
        u === "" ||
        u === "|" ||
        u === "&" ||
        u === ";" ||
        u === "(" ||
        u === ")"
      )
        break;
      if (o && Bt(e)) e.misreading ??= "brace_text_read_again";
      if (u === "<" || u === ">") {
        if (l(e.L, 1) === "(") {
          let L = $e(e);
          if (L) t.push(L);
          continue;
        }
        break;
      }
      if (u === '"') {
        t.push(G(e));
        continue;
      }
      if (u === "'") {
        let L = S(e.L, "arg");
        t.push(g(e, "raw_string", L));
        continue;
      }
      if (u === "$") {
        if (Ve(e, Nn)) e.misreading ??= "brace_text_read_again";
        let L = l(e.L, 1);
        if (L === "'") {
          let h = S(e.L, "arg");
          t.push(g(e, "ansi_c_string", h));
          continue;
        }
        if (L === '"') {
          let h = { type: "DOLLAR", value: "$", start: e.L.b, end: e.L.b + 1 };
          {
            i(e.L);
            t.push(g(e, "$", h));
            t.push(G(e));
          }
          continue;
        }
        if (L === "`") {
          let h = { type: "DOLLAR", value: "$", start: e.L.b, end: e.L.b + 1 };
          {
            i(e.L);
            t.push(g(e, "$", h));
          }
          continue;
        }
        let b = Q(e);
        if (b) t.push(b);
        continue;
      }
      if (u === "`") {
        if (e.inBacktick > 0) break;
        let L = Me(e);
        t.push(L);
        continue;
      }
      if (u === "{") {
        let L = $n(e);
        if (L) {
          t.push(L);
          continue;
        }
        let b = l(e.L, 1);
        if (
          b === ";" ||
          b === "|" ||
          b === "&" ||
          b ===
            `
` ||
          b === "" ||
          b === ")" ||
          b === " " ||
          b === "\t"
        ) {
          let p = e.L.b;
          {
            i(e.L);
            t.push(d(e, "word", p, e.L.b, []));
          }
          continue;
        }
        let h = Cn(e);
        if (h) {
          o ||= Dn(e, h);
          for (let p of h) {
            Ye(r, p.text);
            t.push(p);
            pe(e, t, r);
          }
          continue;
        }
      }
      if (u === "}") {
        let L = e.L.b;
        {
          i(e.L);
          t.push(d(e, "word", L, e.L.b, []));
        }
        continue;
      }
      if (u === "[" || u === "]") {
        if (t.length > 0 || n) Ye(r, u);
        let L = e.L.b;
        {
          i(e.L);
          t.push(d(e, "word", L, e.L.b, []));
        }
        continue;
      }
      let f = En(e);
      if (!f) break;
      if (
        f.type === "word" &&
        /^-?(0x)?[0-9]+#$/.test(f.text) &&
        l(e.L) === "$" &&
        (l(e.L, 1) === "{" || l(e.L, 1) === "(")
      ) {
        let L = Q(e);
        if (L) {
          t.push(d(e, "number", f.startIndex, L.endIndex, [L]));
          continue;
        }
      }
      t.push(f);
    }
    if ((pe(e, t, r), r && r.subscriptDepth > 0))
      je(e, need(r).brackets, need(r).subscriptRunsQuotes);
    if (t.some(An) && t.some((u) => /(?<!\$)\{/.test(u.text)))
      e.misreading ??= "brace_text_read_again";
    if (t.length === 0) return null;
    if (t.length === 1) return need(t[0]);
    let a = t[0],
      c = t.at(-1);
    return d(e, "concatenation", need(a).startIndex, need(c).endIndex, t);
  }
  function En(e: ParseContext): NativeBashSyntaxNode | null {
    let s = e.L.b,
      n = e.L.i;
    while (e.L.i < e.L.len) {
      let o = l(e.L);
      if (o === "\\") {
        if (e.L.i + 1 >= e.L.len) break;
        if (
          e.L.src[e.L.i + 1] ===
          `
`
        )
          break;
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (
        o === " " ||
        o === "\t" ||
        o ===
          `
` ||
        o === "\r" ||
        o === "" ||
        o === "|" ||
        o === "&" ||
        o === ";" ||
        o === "(" ||
        o === ")" ||
        o === "<" ||
        o === ">" ||
        o === '"' ||
        o === "'" ||
        o === "$" ||
        o === "`" ||
        o === "{" ||
        o === "}" ||
        o === "[" ||
        o === "]"
      )
        break;
      i(e.L);
    }
    if (e.L.b === s) return null;
    let t = e.src.slice(n, e.L.i),
      r = /^-?\d+$/.test(t) ? "number" : "word";
    return d(e, r, s, e.L.b, []);
  }
  var Mt = /(?:^|\{)(?:[A-Z]\.\.[a-z]|[a-z]\.\.[A-Z])(?:\.\.[-+]?\d+)?$/,
    Rn = /\$\$?(?:\[[^,}]*)?[,}]/y,
    Nn = /\$\[[^{]*\{/y,
    On = /\$\{\w+(?:(?::?[-=+?]|%%?|##?)[\w./*-]*)?\}/y;
  function Ve(e: ParseContext, s: RegExp): boolean {
    return ((s.lastIndex = e.L.i), s.test(e.src));
  }
  function Dn(e: ParseContext, s: NativeBashSyntaxNode[]): boolean {
    return (
      need(s.at(-1)).text !== "}" ||
      s.slice(1).some((n) => n.text.includes("{")) ||
      (!s.some((n) => n.text.replace(/\\[^]/g, "").includes(",")) &&
        e.src.includes("}", e.L.i))
    );
  }
  function An(e: NativeBashSyntaxNode): boolean {
    return (
      e.type === "string" &&
      e.children.some((s) => /^(?:`|\$\{)/.test(s.text) && s.text.includes('"'))
    );
  }
  function Bt(e: ParseContext): boolean {
    let s = l(e.L);
    if (s === "`" || s === "'" || s === '"') return !0;
    let n = l(e.L, 1);
    return (
      Ve(e, Rn) ||
      (s === "$" && (n === "(" || n === "'" || (n === "{" && !Ve(e, On))))
    );
  }
  function $n(e: ParseContext): NativeBashSyntaxNode | null {
    let s = k(e.L);
    if (l(e.L) !== "{") return null;
    let n = e.L.b;
    i(e.L);
    let t = e.L.b,
      r = e.L.b;
    while (D(l(e.L)) || M(l(e.L))) i(e.L);
    let o = e.L.b;
    if (o === r || l(e.L) !== "." || l(e.L, 1) !== ".")
      return (y(e.L, s), null);
    let a = e.L.b;
    {
      i(e.L);
      i(e.L);
    }
    let c = e.L.b,
      u = e.L.b;
    while (D(l(e.L)) || M(l(e.L))) i(e.L);
    let f = e.L.b;
    if (f === u || l(e.L) !== "}") return (y(e.L, s), null);
    let L = e.L.b;
    i(e.L);
    let b = e.L.b,
      h = F(e, r, o),
      p = F(e, u, f),
      x = /^\d+$/.test(h),
      _ = /^\d+$/.test(p);
    if (x !== _) return (y(e.L, s), null);
    if (!x && (h.length !== 1 || p.length !== 1)) return (y(e.L, s), null);
    if (Mt.test(`${h}..${p}`)) e.misreading ??= "brace_text_read_again";
    let I = x ? "number" : "word",
      v = _ ? "number" : "word";
    return d(e, "brace_expression", n, b, [
      d(e, "{", n, t, []),
      d(e, I, r, o, []),
      d(e, "..", a, c, []),
      d(e, v, u, f, []),
      d(e, "}", L, b, []),
    ]);
  }
  function Cn(e: ParseContext): NativeBashSyntaxNode[] | null {
    if (l(e.L) !== "{") return null;
    let s = e.L.b;
    i(e.L);
    let n = e.L.b,
      t = [d(e, "word", s, n, [])];
    while (e.L.i < e.L.len) {
      let r = l(e.L);
      if (
        r === "}" ||
        r ===
          `
` ||
        r === ";" ||
        r === "|" ||
        r === "&" ||
        r === " " ||
        r === "\t" ||
        r === "<" ||
        r === ">" ||
        r === "(" ||
        r === ")"
      )
        break;
      if (r === "[" || r === "]") {
        let c = e.L.b;
        {
          i(e.L);
          t.push(d(e, "word", c, e.L.b, []));
        }
        continue;
      }
      let o = e.L.b;
      while (e.L.i < e.L.len) {
        let c = l(e.L);
        if (c === "\\" && e.L.i + 1 < e.L.len) {
          {
            i(e.L);
            i(e.L);
          }
          continue;
        }
        if (
          c === "}" ||
          c ===
            `
` ||
          c === ";" ||
          c === "|" ||
          c === "&" ||
          c === " " ||
          c === "\t" ||
          c === "<" ||
          c === ">" ||
          c === "(" ||
          c === ")" ||
          c === "[" ||
          c === "]"
        )
          break;
        if (Bt(e)) e.misreading ??= "brace_text_read_again";
        i(e.L);
      }
      let a = e.L.b;
      if (a > o) {
        let c = F(e, o, a);
        if (l(e.L) === "}" && Mt.test(c))
          e.misreading ??= "brace_text_read_again";
        let u = /^-?\d+$/.test(c) ? "number" : "word";
        t.push(d(e, u, o, a, []));
      } else break;
    }
    if (l(e.L) === "}") {
      let r = e.L.b;
      {
        i(e.L);
        t.push(d(e, "word", r, e.L.b, []));
      }
    }
    return (ye(e, s), t);
  }
  function ye(e: ParseContext, s: number): void {
    te(e, s, e.L.b);
    let n = ge(e, s, e.srcBytes);
    if (n && !e.plainQuotedCode) {
      e.plainQuotedCode = [];
      for (let t of e.src.matchAll(xn)) {
        if (Et.test(t[0])) {
          e.plainQuotedCode = e.quotedCode;
          break;
        }
        let r = t[0].startsWith("'") ? t[0].search(/`|\$\(/) : -1;
        if (r >= 0) e.plainQuotedCode.push(re(e.L, t.index + r));
      }
    }
    if (
      (Ce(e, s, e.srcBytes) ||
        (n && X(need(e.plainQuotedCode), s, e.srcBytes))) &&
      /\$\{(?!\w*\})/.test(F(e, s, e.L.b))
    )
      te(e, s, e.srcBytes);
  }
  /** Parse a double-quoted string and its nested expressions. Source production G. */
  function G(e: ParseContext): NativeBashSyntaxNode {
    let s = e.L.b;
    {
      i(e.L);
      e.inDquote++;
    }
    let n = e.L.b,
      r = [d(e, '"', s, n, [])],
      o = e.L.b,
      a = e.L.i,
      c = () => {
        if (e.L.b > o) {
          let f = e.src.slice(a, e.L.i);
          if (!/^[ \t]+$/.test(f)) r.push(d(e, "string_content", o, e.L.b, []));
        }
      };
    while (e.L.i < e.L.len) {
      let f = l(e.L);
      if (f === '"') break;
      if (f === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (
        f ===
        `
`
      ) {
        {
          c();
          i(e.L);
          o = e.L.b;
          a = e.L.i;
        }
        continue;
      }
      if (f === "$") {
        let L = l(e.L, 1);
        if (
          L === "(" ||
          L === "{" ||
          (L === "[" && Y(e)) ||
          M(L) ||
          se.has(L) ||
          D(L) ||
          L >= "\x80" ||
          (Oe.has(L) && Tt(e, e.L.i + 1) !== -1)
        ) {
          c();
          let b = Q(e);
          if (b) r.push(b);
          {
            o = e.L.b;
            a = e.L.i;
          }
          continue;
        }
        if (L !== '"' && L !== "") {
          c();
          let b = e.L.b;
          {
            i(e.L);
            r.push(d(e, "$", b, e.L.b, []));
            o = e.L.b;
            a = e.L.i;
          }
          continue;
        }
      }
      if (f === "`") {
        c();
        let L = Me(e);
        {
          r.push(L);
          o = e.L.b;
          a = e.L.i;
        }
        continue;
      }
      i(e.L);
    }
    c();
    let u;
    if (l(e.L) === '"') {
      let f = e.L.b;
      {
        i(e.L);
        u = d(e, '"', f, e.L.b, []);
      }
    } else u = d(e, '"', e.L.b, e.L.b, []);
    return (r.push(u), e.inDquote--, d(e, "string", s, need(u).endIndex, r));
  }
  /** Parse dollar expansions, arithmetic and command substitutions. Source production Q. */
  function Q(e: ParseContext): NativeBashSyntaxNode {
    let s = e.L.i,
      n = l(e.L, 1),
      t = e.L.b;
    if (n === "(" && l(e.L, 2) === "(") {
      {
        i(e.L);
        i(e.L);
        i(e.L);
      }
      let u = d(e, "$((", t, e.L.b, []),
        f = k(e.L),
        L = e.L.i,
        b = _e(e, "))", "var");
      m(e.L);
      let h = De(e, L, ")", !0),
        p,
        x = !1;
      if (l(e.L) !== ")" || l(e.L, 1) !== ")") {
        gt(e, f, "))");
        x = !0;
        It(e, h);
      }
      if ((Ke(e.L, s, e.L.i + 2), l(e.L) === ")" && l(e.L, 1) === ")")) {
        let _ = e.L.b;
        {
          i(e.L);
          i(e.L);
          p = d(e, "))", _, e.L.b, []);
        }
      } else p = d(e, "))", e.L.b, e.L.b, []);
      return d(e, x ? "ERROR" : "arithmetic_expansion", t, p.endIndex, [
        u,
        ...b,
        p,
      ]);
    }
    if (n === "[") {
      {
        i(e.L);
        i(e.L);
      }
      let u = d(e, "$[", t, e.L.b, []),
        f = k(e.L),
        L = e.L.i,
        b = _e(e, "]", "var");
      m(e.L);
      let h = De(e, L, "]", !1),
        p,
        x = !1;
      if (l(e.L) !== "]") {
        gt(e, f, "]");
        x = !0;
        It(e, h);
      }
      if ((Ke(e.L, s, e.L.i + 1), l(e.L) === "]")) {
        let _ = e.L.b;
        {
          i(e.L);
          p = d(e, "]", _, e.L.b, []);
        }
      } else p = d(e, "]", e.L.b, e.L.b, []);
      return d(e, x ? "ERROR" : "arithmetic_expansion", t, p.endIndex, [
        u,
        ...b,
        p,
      ]);
    }
    if (n === "(") {
      {
        i(e.L);
        i(e.L);
      }
      let u = d(e, "$(", t, e.L.b, []),
        { inDquote: f, inForHead: L } = e;
      {
        e.inDquote = 0;
        e.inForHead = !1;
      }
      let b = B(e, ")");
      {
        e.inDquote = f;
        e.inForHead = L;
        m(e.L);
      }
      let h,
        p = !1;
      if (l(e.L) === ")") {
        let x = e.L.b;
        {
          i(e.L);
          h = d(e, ")", x, e.L.b, []);
        }
      } else {
        {
          p = !0;
          e.zshBraceDiff = !0;
        }
        let x = e.L.b,
          _ = 1;
        while (e.L.i < e.L.len) {
          let I = l(e.L);
          if (I === "\\" && e.L.i + 1 < e.L.len) {
            {
              i(e.L);
              i(e.L);
            }
            continue;
          }
          if (I === '"' || I === "'") {
            if ((C(e, I), e.L.i < e.L.len)) i(e.L);
            continue;
          }
          if (I === "`") {
            i(e.L);
            while (e.L.i < e.L.len && l(e.L) !== "`") {
              if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
              i(e.L);
            }
            if (e.L.i < e.L.len) i(e.L);
            continue;
          }
          if (I === "$" && l(e.L, 1) === "$") {
            {
              i(e.L);
              i(e.L);
            }
            continue;
          }
          if (I === "$" && l(e.L, 1) === "'") {
            if ((C(e, "$'"), e.L.i < e.L.len)) i(e.L);
            continue;
          }
          if (I === "(") _++;
          else if (I === ")") {
            if ((_--, _ === 0)) break;
          }
          i(e.L);
        }
        if ((b.push(d(e, "ERROR", x, e.L.b, [])), l(e.L) === ")")) {
          let I = e.L.b;
          {
            i(e.L);
            h = d(e, ")", I, e.L.b, []);
          }
        } else h = d(e, "ERROR", e.L.b, e.L.b, []);
      }
      if (
        !p &&
        b.length === 1 &&
        need(b[0]).type === "redirected_statement" &&
        need(b[0]).children.length === 1 &&
        need(need(b[0]).children[0]).type === "file_redirect"
      )
        b = [...need(b[0]).children];
      return (
        Ke(e.L, s, e.L.i),
        d(e, p ? "ERROR" : "command_substitution", t, h.endIndex, [u, ...b, h])
      );
    }
    if (n === "{") {
      {
        i(e.L);
        i(e.L);
      }
      let u = d(e, "${", t, e.L.b, []),
        f = Mn(e),
        L,
        b = !1;
      while (
        l(e.L) ===
        `
`
      )
        i(e.L);
      if (l(e.L) === "}") {
        let h = e.L.b;
        {
          i(e.L);
          L = d(e, "}", h, e.L.b, []);
        }
      } else {
        {
          b = !0;
          e.zshBraceDiff = !0;
        }
        let h = e.L.b,
          p = 1;
        while (e.L.i < e.L.len) {
          let _ = l(e.L);
          if (_ === "\\" && e.L.i + 1 < e.L.len) {
            {
              i(e.L);
              i(e.L);
            }
            continue;
          }
          if (_ === '"' || _ === "'") {
            if ((C(e, _), e.L.i < e.L.len)) i(e.L);
            continue;
          }
          if (_ === "$" && l(e.L, 1) === "(") {
            let I = 1;
            {
              i(e.L);
              i(e.L);
            }
            while (e.L.i < e.L.len && I > 0) {
              let v = l(e.L);
              if (v === "\\" && e.L.i + 1 < e.L.len) i(e.L);
              else if (v === "$" && l(e.L, 1) === "$") i(e.L);
              else if (v === "$" && l(e.L, 1) === "'") C(e, "$'");
              else if (v === '"' || v === "'") C(e, v);
              else if (v === "`") {
                i(e.L);
                while (e.L.i < e.L.len && l(e.L) !== "`") {
                  if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
                  i(e.L);
                }
              } else if (v === "(") I++;
              else if (v === ")") I--;
              i(e.L);
            }
            continue;
          }
          if (_ === "`") {
            i(e.L);
            while (e.L.i < e.L.len && l(e.L) !== "`") {
              if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
              i(e.L);
            }
            if (e.L.i < e.L.len) i(e.L);
            continue;
          }
          if (_ === "$" && l(e.L, 1) === "$") {
            {
              i(e.L);
              i(e.L);
            }
            continue;
          }
          if (_ === "$" && l(e.L, 1) === "'") {
            if ((C(e, "$'"), e.L.i < e.L.len)) i(e.L);
            continue;
          }
          if (_ === "$" && l(e.L, 1) === "{") {
            p++;
            i(e.L);
          } else if (_ === "}") {
            if ((p--, p === 0)) break;
          }
          i(e.L);
        }
        let x = d(e, "ERROR", h, e.L.b, []);
        if (l(e.L) === "}") {
          let _ = e.L.b;
          {
            i(e.L);
            L = d(e, "}", _, e.L.b, []);
          }
        } else L = d(e, "ERROR", e.L.b, e.L.b, []);
        f.push(x);
      }
      if (
        !b &&
        e.inDquote > 0 &&
        F(e, need(u).endIndex, L.startIndex).includes("'")
      )
        b = !0;
      if (!b && BVo(F(e, t, L.startIndex))) b = !0;
      if (/\\\n|\$\[|\$\{[ \t\n|]/.test(F(e, need(u).endIndex, L.startIndex)))
        e.zshBraceDiff = !0;
      return d(
        e,
        b || e.zshBraceDiff || e.dollarOperandDiff ? "ERROR" : "expansion",
        t,
        L.endIndex,
        [u, ...f, L],
      );
    }
    if (n === "'") {
      if ((C(e, "$'"), l(e.L) === "'")) i(e.L);
      return (xe(e, t, e.L.b), d(e, "ansi_c_string", t, e.L.b, []));
    }
    i(e.L);
    let r = e.L.b,
      o = d(e, "$", t, r, []),
      a = l(e.L);
    if (a >= "\x80") {
      while (z(l(e.L)) || l(e.L) >= "\x80") i(e.L);
      return d(e, "ERROR", t, e.L.b, []);
    }
    if (a === "_" && !z(l(e.L, 1)) && l(e.L, 1) < "\x80") {
      let u = e.L.b;
      i(e.L);
      let f = d(e, "special_variable_name", u, e.L.b, []);
      return d(e, "simple_expansion", t, e.L.b, [o, f]);
    }
    if (M(a)) {
      let u = e.L.b;
      while (z(l(e.L))) i(e.L);
      if (l(e.L) >= "\x80") {
        while (z(l(e.L)) || l(e.L) >= "\x80") i(e.L);
        return d(e, "ERROR", t, e.L.b, []);
      }
      let f = d(e, "variable_name", u, e.L.b, []);
      return d(e, "simple_expansion", t, e.L.b, [o, f]);
    }
    let c = a === "#" && !Oe.has(l(e.L, 1));
    if (Oe.has(a) && !c) {
      let u = Tt(e, e.L.i);
      if (u !== -1) {
        while (e.L.i < u) i(e.L);
        return d(e, "ERROR", t, e.L.b, []);
      }
    }
    if (D(a)) {
      let u = e.L.b;
      i(e.L);
      let f = d(e, "variable_name", u, e.L.b, []);
      return d(e, "simple_expansion", t, e.L.b, [o, f]);
    }
    if (se.has(a)) {
      let u = e.L.b;
      i(e.L);
      let f = d(e, "special_variable_name", u, e.L.b, []);
      return d(e, "simple_expansion", t, e.L.b, [o, f]);
    }
    return o;
  }
  function Mn(e: ParseContext): NativeBashSyntaxNode[] {
    let s: NativeBashSyntaxNode[] = [];
    m(e.L);
    {
      let o = l(e.L),
        a = l(e.L, 1);
      if (o === "#" && a === "!" && l(e.L, 2) === "}")
        return (i(e.L), i(e.L), s);
      if (o === "!" && a === "#") {
        let c = 2;
        if (l(e.L, c) === "#") c++;
        if (l(e.L, c) === " ") c++;
        if (l(e.L, c) === "}") {
          while (c-- > 0) i(e.L);
          return s;
        }
      }
    }
    if (l(e.L) === "#") {
      let o = e.L.b;
      {
        i(e.L);
        s.push(d(e, "#", o, e.L.b, []));
      }
    }
    let n = l(e.L);
    if (
      (n === "!" || n === "=" || n === "~") &&
      (M(l(e.L, 1)) || D(l(e.L, 1)))
    ) {
      let o = e.L.b;
      {
        i(e.L);
        s.push(d(e, n, o, e.L.b, []));
      }
    }
    if ((m(e.L), M(l(e.L)))) {
      let o = e.L.b;
      while (z(l(e.L))) i(e.L);
      s.push(d(e, "variable_name", o, e.L.b, []));
    } else if (D(l(e.L))) {
      let o = e.L.b;
      while (D(l(e.L))) i(e.L);
      s.push(d(e, "variable_name", o, e.L.b, []));
    } else if (se.has(l(e.L))) {
      let o = e.L.b;
      {
        i(e.L);
        s.push(d(e, "special_variable_name", o, e.L.b, []));
      }
    }
    if (l(e.L) === "[") {
      let o = s.at(-1),
        a = e.L.b;
      i(e.L);
      let c = d(e, "[", a, e.L.b, []),
        u = Sn(e);
      m(e.L);
      let f = e.L.b;
      if (l(e.L) === "]") i(e.L);
      let L = d(e, "]", f, e.L.b, []);
      if (o) {
        let b = u ? [o, c, u, L] : [o, c, L];
        s[s.length - 1] = d(e, "subscript", o.startIndex, e.L.b, b);
      } else {
        let b = u ? [c, u, L] : [c, L];
        s.push(d(e, "ERROR", a, e.L.b, b));
      }
    }
    m(e.L);
    let t = l(e.L);
    if ((t === "*" || t === "@") && l(e.L, 1) === "}") {
      let o = e.L.b;
      return (i(e.L), s.push(d(e, t, o, e.L.b, [])), s);
    }
    if (t === "@" && M(l(e.L, 1))) {
      let o = e.L.b;
      {
        i(e.L);
        s.push(d(e, "@", o, e.L.b, []));
      }
      while (z(l(e.L))) i(e.L);
      return s;
    }
    let r = l(e.L);
    if (r === ":") {
      let o = l(e.L, 1);
      if (o === "}") return (i(e.L), s);
      if (o !== "-" && o !== "=" && o !== "?" && o !== "+") {
        {
          i(e.L);
          m(e.L);
        }
        let a = l(e.L),
          c;
        if (a === "-" && D(l(e.L, 1))) {
          let u = e.L.b;
          i(e.L);
          while (D(l(e.L))) i(e.L);
          c = d(e, "number", u, e.L.b, []);
        } else c = me(e, ":}", "var");
        if (c) s.push(c);
        if ((m(e.L), l(e.L) === ":")) {
          {
            i(e.L);
            m(e.L);
          }
          let u = l(e.L),
            f;
          if (u === "-" && D(l(e.L, 1))) {
            let L = e.L.b;
            i(e.L);
            while (D(l(e.L))) i(e.L);
            f = d(e, "number", L, e.L.b, []);
          } else f = me(e, "}", "var");
          if (f) s.push(f);
        }
        return s;
      }
    }
    if (
      r === ":" ||
      r === "#" ||
      r === "%" ||
      r === "/" ||
      r === "^" ||
      r === "," ||
      r === "-" ||
      r === "=" ||
      r === "?" ||
      r === "+"
    ) {
      let o = e.L.b,
        a = l(e.L, 1),
        c = r;
      if (r === ":" && (a === "-" || a === "=" || a === "?" || a === "+")) {
        i(e.L);
        i(e.L);
        c = r + a;
      } else if (
        (r === "#" || r === "%" || r === "/" || r === "^" || r === ",") &&
        a === r
      ) {
        i(e.L);
        i(e.L);
        c = r + r;
      } else i(e.L);
      let u = s.at(-1)?.type,
        f =
          u === "variable_name" ||
          (u === "special_variable_name" &&
            !(s[0]?.type === "#" && s[1]?.text === "#")) ||
          u === "subscript";
      s.push(d(e, c, o, e.L.b, []));
      let L = e.L.b,
        b = s.length,
        h =
          c === "#" ||
          c === "##" ||
          c === "%" ||
          c === "%%" ||
          c === "/" ||
          c === "//" ||
          c === "^" ||
          c === "^^" ||
          c === "," ||
          c === ",,";
      if (c === "/" || c === "//") {
        let p = l(e.L);
        if (p === "#" || p === "%") {
          let _ = e.L.b;
          {
            i(e.L);
            s.push(d(e, p, _, e.L.b, []));
          }
        }
        if (l(e.L) === '"') {
          s.push(G(e));
          let _ = we(e, "regex", !0);
          if (_) s.push(_);
        } else {
          let _ = we(e, "regex", !0);
          if (_) s.push(_);
        }
        let x = e.L.b;
        if ((te(e, L, x), l(e.L) === "/")) {
          let _ = e.L.b;
          {
            i(e.L);
            s.push(d(e, "/", _, e.L.b, []));
          }
          let I = we(e, "replword", !1);
          if (
            (Ce(e, L, e.L.b) || ge(e, L, e.L.b)) &&
            (s[0]?.type === "#" || /^#?%?$|\[/.test(F(e, L, x)))
          )
            te(e, L, e.L.b);
          if (I)
            if (
              I.type === "concatenation" &&
              I.children.length === 2 &&
              need(I.children[0]).type === "command_substitution"
            ) {
              s.push(need(I.children[0]));
              s.push(need(I.children[1]));
            } else s.push(I);
        }
      } else if (c === "#" || c === "##" || c === "%" || c === "%%")
        for (let p of Bn(e)) s.push(p);
      else {
        let p = we(e, h ? "regex" : "word", !1);
        if (p) s.push(p);
      }
      if (
        c[0] !== "/" &&
        (h || s[0]?.type === "#" || (!f && (c === "+" || c === "=")))
      )
        te(e, L, e.L.b);
      if (!f && X((e.quoteOrBackslashOffsets ??= Ie(e, /['\\]/g)), L, e.L.b)) {
        let p = (e.operandsRead ??= new Set()),
          x = s.slice(b).reverse(),
          _ = "",
          I = L;
        for (let v = x.pop(); v; v = x.pop())
          if (
            p.has(v) ||
            (v.type === "command_substitution" && v.children[0]?.type === "$(")
          ) {
            _ += F(e, I, v.startIndex);
            I = v.endIndex;
          } else x.push(...v.children.toReversed());
        for (let v of s.slice(b)) p.add(v);
        if (/['\\]/.test(_ + F(e, I, e.L.b)) && q(e.switches, e.src, fe))
          e.zshBraceDiff = !0;
      }
    }
    return s;
  }
  function xe(e: ParseContext, s: number, n: number, t = false): void {
    let r = Ce(e, s, n)
      ? "dollar_quote_string"
      : t && ge(e, s, n)
        ? "quoted_code_in_subscript"
        : void 0;
    if (r && q(e.switches, e.src, ke)) e.misreading = r;
  }
  function te(e: ParseContext, s: number, n: number): void {
    let t =
      ge(e, s, n) &&
      X((e.bracketOffsets ??= Ie(e, /\[/g)), s, n) &&
      X(tt(e), s, n);
    xe(e, s, n, t);
  }
  function zt(e: ParseContext): boolean {
    return Ce(e, e.L.b, e.srcBytes) || ge(e, e.L.b, e.srcBytes);
  }
  function Ce(e: ParseContext, s: number, n: number): boolean {
    if (e.misreading !== void 0) return !1;
    return (
      (e.dollarQuotes ??= Ie(e, /\$(?='(?!(?:\\[nrt]| )+'))/g)),
      X(e.dollarQuotes, s, n)
    );
  }
  function ge(e: ParseContext, s: number, n: number): boolean {
    if (e.misreading !== void 0) return !1;
    return (
      (e.quotedCode ??= Ie(e, /'[^'`]*?(?:`|\$\()/g)),
      X(e.quotedCode, s, n)
    );
  }
  function tt(e: ParseContext): number[] {
    return (e.quoteOffsets ??= Ie(e, /'/g));
  }
  function Ie(e: ParseContext, s: RegExp): number[] {
    return Array.from(e.src.matchAll(s), (n) =>
      re(e.L, n.index + n[0].length - 1),
    );
  }
  function X(e: number[], s: number, n: number): boolean {
    let t = 0,
      r = e.length;
    while (t < r) {
      let o = (t + r) >>> 1;
      if (need(e[o]) < s) t = o + 1;
      else r = o;
    }
    return t < e.length && need(e[t]) < n;
  }
  function we(
    e: ParseContext,
    s: string,
    n: boolean,
  ): NativeBashSyntaxNode | null {
    let t = e.L.b;
    if (s === "word" && l(e.L) === "(") {
      i(e.L);
      let b = [d(e, "(", t, e.L.b, [])];
      while (e.L.i < e.L.len) {
        m(e.L);
        let h = l(e.L);
        if (
          h === ")" ||
          h === "}" ||
          h ===
            `
` ||
          h === ""
        )
          break;
        let p = e.L.b;
        while (e.L.i < e.L.len) {
          let x = l(e.L);
          if (
            x === ")" ||
            x === "}" ||
            x === " " ||
            x === "\t" ||
            x ===
              `
` ||
            x === ""
          )
            break;
          if (x === "\\" && e.L.i + 1 < e.L.len) {
            {
              i(e.L);
              i(e.L);
            }
            continue;
          }
          if (x === "$" && l(e.L, 1) === "$") {
            {
              i(e.L);
              i(e.L);
            }
            continue;
          }
          if (x === "$" && l(e.L, 1) === "'") {
            if ((C(e, "$'"), l(e.L) === "'")) i(e.L);
            continue;
          }
          if (x === "$" && l(e.L, 1) === "(") e.zshBraceDiff = !0;
          if (x === '"' || x === "'") {
            if ((C(e, x), l(e.L) === x)) i(e.L);
            continue;
          }
          if (x === "`") {
            {
              e.zshBraceDiff = !0;
              i(e.L);
            }
            while (e.L.i < e.L.len && l(e.L) !== "`") {
              if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
              i(e.L);
            }
            if (l(e.L) === "`") i(e.L);
            continue;
          }
          if (x === "{") e.zshBraceDiff = !0;
          i(e.L);
        }
        if (e.L.b > p) b.push(d(e, "word", p, e.L.b, []));
        else break;
      }
      if (l(e.L) === ")") {
        let h = e.L.b;
        {
          i(e.L);
          b.push(d(e, ")", h, e.L.b, []));
        }
      }
      while (
        l(e.L) ===
        `
`
      )
        i(e.L);
      return d(e, "array", t, e.L.b, b);
    }
    if (s === "regex") {
      while (e.L.i < e.L.len) {
        let b = l(e.L);
        if (b === "{") e.zshBraceDiff = !0;
        if (b === "}") break;
        if (n && b === "/") break;
        if (b === "\\" && e.L.i + 1 < e.L.len) {
          {
            i(e.L);
            i(e.L);
          }
          continue;
        }
        if (b === '"' || b === "'") {
          i(e.L);
          let h = q(e.switches, e.src, ae);
          while (e.L.i < e.L.len && l(e.L) !== b) {
            if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) {
              if (b === "'" && h && l(e.L, 1) === "'") e.zshBraceDiff = !0;
              i(e.L);
            } else if (b === '"' && h && !e.zshBraceDiff) {
              if (l(e.L) === "`") e.zshBraceDiff = !0;
              else if (l(e.L) === "$") {
                let p = 1;
                while (
                  l(e.L, p) === "\\" &&
                  l(e.L, p + 1) ===
                    `
`
                )
                  p += 2;
                let x = l(e.L, p);
                if (x === "{" || x === "(" || x === "[") e.zshBraceDiff = !0;
              }
            }
            i(e.L);
          }
          if (l(e.L) === b) i(e.L);
          continue;
        }
        if (b === "`") {
          {
            e.zshBraceDiff = !0;
            i(e.L);
          }
          while (e.L.i < e.L.len && l(e.L) !== "`") {
            if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
            i(e.L);
          }
          if (l(e.L) === "`") i(e.L);
          continue;
        }
        if (b === "$") {
          let h = l(e.L, 1);
          if (h === "$" && q(e.switches, e.src, ce)) {
            let p = 2;
            while (l(e.L, p) === "$") p++;
            if (p % 2 === 0 && l(e.L, p) === "{") e.dollarOperandDiff = !0;
            for (let x = 1; x < p; x++) i(e.L);
            continue;
          }
          if (h === "{") {
            let p = 0;
            {
              i(e.L);
              i(e.L);
              p++;
            }
            while (e.L.i < e.L.len && p > 0) {
              let x = l(e.L);
              if (x === "\\" && e.L.i + 1 < e.L.len) i(e.L);
              else if (x === "$" && l(e.L, 1) === "$") i(e.L);
              else if (x === "$" && l(e.L, 1) === "'") C(e, "$'");
              else if (x === '"' || x === "'") C(e, x);
              else if (x === "`") {
                {
                  e.zshBraceDiff = !0;
                  i(e.L);
                }
                while (e.L.i < e.L.len && l(e.L) !== "`") {
                  if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
                  i(e.L);
                }
              } else if (x === "$" && l(e.L, 1) === "{") {
                p++;
                i(e.L);
              } else if (x === "$" && l(e.L, 1) === "(") e.zshBraceDiff = !0;
              else if (x === "{") e.zshBraceDiff = !0;
              else if (x === "}") p--;
              i(e.L);
            }
            continue;
          }
          if (h === "(") {
            e.zshBraceDiff = !0;
            let p = 0;
            {
              i(e.L);
              i(e.L);
              p++;
            }
            while (e.L.i < e.L.len && p > 0) {
              let x = l(e.L);
              if (x === "\\" && e.L.i + 1 < e.L.len) i(e.L);
              else if (x === "$" && l(e.L, 1) === "$") i(e.L);
              else if (x === "$" && l(e.L, 1) === "'") C(e, "$'");
              else if (x === '"' || x === "'") C(e, x);
              else if (x === "`") {
                i(e.L);
                while (e.L.i < e.L.len && l(e.L) !== "`") {
                  if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
                  i(e.L);
                }
              } else if (x === "(") p++;
              else if (x === ")") p--;
              i(e.L);
            }
            continue;
          }
        }
        i(e.L);
      }
      let L = e.L.b;
      if (L === t) return null;
      return d(e, "regex", t, L, []);
    }
    let r = [],
      o = e.L.b,
      a = Ct(e),
      c = e.L.b,
      u = () => {
        if (e.L.b > o) {
          r.push(d(e, "word", o, e.L.b, []));
          pe(e, r, a);
        }
      };
    while (e.L.i < e.L.len) {
      if (e.L.b === o) pe(e, r, a);
      let L = l(e.L);
      if (L === "}") break;
      if (L === "{") e.zshBraceDiff = !0;
      if (n && L === "/") break;
      if (L === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (a) {
        if (
          L === " " ||
          L === "\t" ||
          L ===
            `
`
        )
          c = e.L.b + 1;
        else if (L === "]" || a.brackets > 0 || e.L.b > c) Ye(a, L);
      }
      let b = l(e.L, 1);
      if (L === "$") {
        if (b === "{" || b === "(" || b === "[") {
          u();
          let h = Q(e);
          if (h) r.push(h);
          o = e.L.b;
          continue;
        }
        if (b === "'") {
          u();
          let h = e.L.b;
          if ((C(e, "$'"), l(e.L) === "'")) i(e.L);
          {
            r.push(d(e, "ansi_c_string", h, e.L.b, []));
            o = e.L.b;
          }
          continue;
        }
        if (M(b) || D(b) || se.has(b) || b >= "\x80") {
          u();
          let h = Q(e);
          if (h) r.push(h);
          o = e.L.b;
          continue;
        }
        if (a) {
          a.holdsDollar = !0;
          a.afterExpansion = !0;
        }
      }
      if (L === '"') {
        {
          u();
          r.push(G(e));
          o = e.L.b;
        }
        continue;
      }
      if (L === "'") {
        u();
        let h = e.L.b;
        if ((C(e, L), l(e.L) === "'")) i(e.L);
        {
          r.push(d(e, "raw_string", h, e.L.b, []));
          o = e.L.b;
        }
        continue;
      }
      if ((L === "<" || L === ">") && b === "(") {
        {
          e.zshBraceDiff = !0;
          u();
        }
        let h = $e(e);
        if (h) r.push(h);
        o = e.L.b;
        continue;
      }
      if (L === "`") {
        u();
        let h = Me(e);
        {
          r.push(h);
          o = e.L.b;
        }
        continue;
      }
      i(e.L);
    }
    if (
      (u(),
      r.length > 1 &&
        need(r[0]).type === "word" &&
        /^[ \t]+$/.test(need(r[0]).text))
    )
      r.shift();
    if (r.length === 0) return null;
    if (r.length === 1) return need(r[0]);
    let f = r.at(-1);
    return d(e, "concatenation", need(r[0]).startIndex, need(f).endIndex, r);
  }
  function Bn(e: ParseContext): NativeBashSyntaxNode[] {
    let s = [],
      n = e.L.b,
      t = () => {
        if (e.L.b > n) s.push(d(e, "regex", n, e.L.b, []));
      };
    while (e.L.i < e.L.len) {
      let r = l(e.L);
      if (r === "}") break;
      if (r === "{") e.zshBraceDiff = !0;
      if (r === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (r === '"') {
        {
          t();
          s.push(G(e));
          n = e.L.b;
        }
        continue;
      }
      if (r === "'") {
        t();
        let o = e.L.b;
        i(e.L);
        while (e.L.i < e.L.len && l(e.L) !== "'") i(e.L);
        if (l(e.L) === "'") i(e.L);
        {
          s.push(d(e, "raw_string", o, e.L.b, []));
          n = e.L.b;
        }
        continue;
      }
      if (r === "`") {
        {
          e.zshBraceDiff = !0;
          i(e.L);
        }
        while (e.L.i < e.L.len && l(e.L) !== "`") {
          if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
          i(e.L);
        }
        if (l(e.L) === "`") i(e.L);
        continue;
      }
      if (r === "$") {
        let o = l(e.L, 1);
        if (o === "$") {
          {
            i(e.L);
            i(e.L);
          }
          continue;
        }
        if (o === "'") {
          t();
          let a = e.L.b;
          if ((C(e, "$'"), l(e.L) === "'")) i(e.L);
          {
            s.push(d(e, "ansi_c_string", a, e.L.b, []));
            n = e.L.b;
          }
          continue;
        }
        if (o === "{") {
          let a = 1;
          {
            i(e.L);
            i(e.L);
          }
          while (e.L.i < e.L.len && a > 0) {
            let c = l(e.L);
            if (c === "\\" && e.L.i + 1 < e.L.len) i(e.L);
            else if (c === "$" && l(e.L, 1) === "$") i(e.L);
            else if (c === "$" && l(e.L, 1) === "'") C(e, "$'");
            else if (c === '"' || c === "'") C(e, c);
            else if (c === "`") {
              {
                e.zshBraceDiff = !0;
                i(e.L);
              }
              while (e.L.i < e.L.len && l(e.L) !== "`") {
                if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
                i(e.L);
              }
            } else if (c === "$" && l(e.L, 1) === "{") {
              a++;
              i(e.L);
            } else if (c === "$" && l(e.L, 1) === "(") e.zshBraceDiff = !0;
            else if (c === "{") e.zshBraceDiff = !0;
            else if (c === "}") a--;
            i(e.L);
          }
          continue;
        }
        if (o === "(") {
          e.zshBraceDiff = !0;
          let a = 1;
          {
            i(e.L);
            i(e.L);
          }
          while (e.L.i < e.L.len && a > 0) {
            let c = l(e.L);
            if (c === "\\" && e.L.i + 1 < e.L.len) i(e.L);
            else if (c === "$" && l(e.L, 1) === "$") i(e.L);
            else if (c === "$" && l(e.L, 1) === "'") C(e, "$'");
            else if (c === '"' || c === "'") C(e, c);
            else if (c === "`") {
              i(e.L);
              while (e.L.i < e.L.len && l(e.L) !== "`") {
                if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
                i(e.L);
              }
            } else if (c === "(") a++;
            else if (c === ")") a--;
            i(e.L);
          }
          continue;
        }
      }
      i(e.L);
    }
    return (t(), s);
  }
  function Me(e: ParseContext): NativeBashSyntaxNode {
    let s = e.L.b;
    i(e.L);
    let n = d(e, "`", s, e.L.b, []),
      t = e.L.i;
    {
      let f = !1;
      while (t < e.L.len) {
        let L = e.L.src[t];
        if (L === "\\") {
          let b = e.L.src[t + 1];
          if (
            b === "`" ||
            b === "$" ||
            b === "\\" ||
            b === '"' ||
            b ===
              `
`
          )
            f = !0;
          t += 2;
          continue;
        }
        if (L === "`") break;
        t++;
      }
      if (f) {
        let L = e.L.b;
        while (e.L.i < t) i(e.L);
        let b = d(e, "backtick_escape_unsupported", L, e.L.b, []);
        e.zshMathDiff ||= CXt.test(b.text) && Y(e);
        let h;
        if (l(e.L) === "`") {
          let p = e.L.b;
          {
            i(e.L);
            h = d(e, "`", p, e.L.b, []);
          }
        } else h = d(e, "`", e.L.b, e.L.b, []);
        return d(e, "command_substitution", s, h.endIndex, [n, b, h]);
      }
    }
    e.inBacktick++;
    let r = e.inDquote;
    e.inDquote = 0;
    let o = k(e.L),
      a = e.L.heredocs;
    e.L.heredocs = [];
    let c = [];
    for (;;) {
      if ((m(e.L), l(e.L) === "`" || l(e.L) === "")) break;
      let f = k(e.L),
        L = S(e.L, "cmd");
      if (L.type === "EOF" || L.type === "BACKTICK") {
        y(e.L, f);
        break;
      }
      if (L.type === "NEWLINE") continue;
      y(e.L, f);
      let b = wt(e);
      if (!b) break;
      if ((c.push(b), m(e.L), l(e.L) === "`")) break;
      let h = k(e.L),
        p = S(e.L, "cmd");
      if (p.type === "OP" && (p.value === ";" || p.value === "&"))
        c.push(g(e, p.value, p));
      else if (p.type !== "NEWLINE") y(e.L, h);
    }
    if (((e.L.heredocs = a), e.inBacktick--, (e.inDquote = r), e.L.i !== t)) {
      y(e.L, o);
      while (e.L.i < t) i(e.L);
      c.length = 0;
      let f = d(e, "backtick_body_overrun", n.endIndex, e.L.b, []);
      {
        e.zshMathDiff ||= CXt.test(f.text) && Y(e);
        c.push(f);
      }
    }
    let u;
    if (l(e.L) === "`") {
      let f = e.L.b;
      {
        i(e.L);
        u = d(e, "`", f, e.L.b, []);
      }
    } else u = d(e, "`", e.L.b, e.L.b, []);
    if (c.length === 0)
      c.push(d(e, "backtick_body_empty", n.endIndex, e.L.b, []));
    return d(e, "command_substitution", s, need(u).endIndex, [n, ...c, u]);
  }
  /** Parse if/elif/else statements. Source production zn. */
  function zn(e: ParseContext, s: Token): NativeBashSyntaxNode {
    e.sawIfOrLoop = !0;
    let n = g(e, "if", s),
      t = [n],
      r = B(e, null);
    {
      t.push(...r);
      he(e, "then", t);
    }
    let o = B(e, null);
    t.push(...o);
    for (;;) {
      let c = k(e.L),
        u = S(e.L, "cmd");
      if (u.type === "WORD" && u.value === "elif") {
        let f = g(e, "elif", u),
          L = B(e, null),
          b = [f, ...L];
        he(e, "then", b);
        let h = B(e, null);
        b.push(...h);
        let p = b.at(-1);
        t.push(d(e, "elif_clause", f.startIndex, need(p).endIndex, b));
      } else if (u.type === "WORD" && u.value === "else") {
        let f = g(e, "else", u),
          L = B(e, null),
          b = L.length > 0 ? L.at(-1) : f;
        t.push(d(e, "else_clause", f.startIndex, need(b).endIndex, [f, ...L]));
      } else {
        y(e.L, c);
        break;
      }
    }
    he(e, "fi", t);
    let a = t.at(-1);
    return d(e, "if_statement", n.startIndex, need(a).endIndex, t);
  }
  /** Parse while/until loops. Source production Wn. */
  function Wn(e: ParseContext, s: Token): NativeBashSyntaxNode {
    e.sawIfOrLoop = !0;
    let n = g(e, s.value, s),
      t = [n],
      r = B(e, null);
    t.push(...r);
    let o = Je(e);
    if (o) t.push(o);
    let a = t.at(-1);
    return d(e, "while_statement", n.startIndex, need(a).endIndex, t);
  }
  /** Parse for/select and C-style loop heads. Source production ht. */
  function ht(e: ParseContext, s: Token): NativeBashSyntaxNode {
    let n = g(e, s.value, s);
    if ((m(e.L), s.value === "for" && l(e.L) === "(" && l(e.L, 1) === "(")) {
      let b = e.L.b;
      {
        i(e.L);
        i(e.L);
      }
      let h = d(e, "((", b, e.L.b, []),
        p = [n, h],
        x = e.inForHead;
      for (let w = 0; w < 3; w++) {
        let O = e.L.i;
        {
          e.inForHead = w < 2;
          m(e.L);
        }
        let T = _e(e, w < 2 ? ";" : "))", "assign");
        {
          p.push(...T);
          m(e.L);
        }
        let N = w < 2 ? ";" : ")",
          E = De(e, O, N, w === 2);
        if (
          !(w < 2 ? l(e.L) === ";" : l(e.L) === ")" && l(e.L, 1) === ")") &&
          Ut(e, E, w === 2)
        )
          p.push(d(e, "ERROR", e.L.b, e.L.b, []));
        if (w < 2) {
          if (l(e.L) === ";") {
            let H = e.L.b;
            {
              i(e.L);
              p.push(d(e, ";", H, e.L.b, []));
            }
          }
        }
      }
      if (((e.inForHead = x), m(e.L), l(e.L) === ")" && l(e.L, 1) === ")")) {
        let w = e.L.b;
        {
          i(e.L);
          i(e.L);
          p.push(d(e, "))", w, e.L.b, []));
        }
      } else p.push(d(e, "))", e.L.b, e.L.b, []));
      let _ = k(e.L),
        I = S(e.L, "cmd");
      if (I.type === "OP" && I.value === ";") p.push(g(e, ";", I));
      else if (I.type !== "NEWLINE") y(e.L, _);
      let v = Je(e);
      if (v) p.push(v);
      else if ((Z(e), m(e.L), l(e.L) === "{")) {
        let w = e.L.b;
        i(e.L);
        let O = d(e, "{", w, e.L.b, []),
          T = B(e, "}"),
          N;
        if (l(e.L) === "}") {
          let E = e.L.b;
          {
            i(e.L);
            N = d(e, "}", E, e.L.b, []);
          }
        } else N = d(e, "}", e.L.b, e.L.b, []);
        p.push(
          d(e, "compound_statement", O.startIndex, N.endIndex, [O, ...T, N]),
        );
      }
      let R = p.at(-1);
      return d(e, "c_style_for_statement", n.startIndex, need(R).endIndex, p);
    }
    let t = [n],
      r = S(e.L, "arg");
    if (
      r.type === "WORD" &&
      M(r.value[0] ?? "") &&
      Array.from(r.value).every(z)
    )
      t.push(d(e, "variable_name", r.start, r.end, []));
    else t.push(d(e, "ERROR", r.start, r.end, []));
    m(e.L);
    let o = k(e.L),
      a = S(e.L, "arg");
    if (a.type === "WORD" && a.value === "in") {
      t.push(g(e, "in", a));
      let b;
      for (;;) {
        m(e.L);
        let h = l(e.L);
        if (
          h === ";" ||
          h ===
            `
` ||
          h === ""
        )
          break;
        if (h === "#")
          b ??= e.L.src.indexOf(
            `
`,
            e.L.i,
          );
        let p = W(e, "arg");
        if (!p) break;
        t.push(p);
      }
      if (b !== void 0 && e.L.i !== b) e.misreading ??= "hash_in_for_list";
    } else y(e.L, o);
    let c = k(e.L),
      u = S(e.L, "cmd");
    if (u.type === "OP" && u.value === ";") t.push(g(e, ";", u));
    else if (u.type !== "NEWLINE") y(e.L, c);
    let f = Je(e);
    if (f) t.push(f);
    let L = t.at(-1);
    return d(e, "for_statement", n.startIndex, need(L).endIndex, t);
  }
  function Je(e: ParseContext): NativeBashSyntaxNode | null {
    Z(e);
    let s = k(e.L),
      n = S(e.L, "cmd");
    if (n.type !== "WORD" || n.value !== "do") return (y(e.L, s), null);
    let t = g(e, "do", n),
      r = B(e, null),
      o = [t, ...r];
    he(e, "done", o);
    let a = o.at(-1);
    return d(e, "do_group", t.startIndex, need(a).endIndex, o);
  }
  /** Parse case statements. Source production Un. */
  function Un(e: ParseContext, s: Token): NativeBashSyntaxNode {
    let n = g(e, "case", s),
      t = [n];
    m(e.L);
    let r = W(e, "arg");
    if (r) t.push(r);
    {
      m(e.L);
      he(e, "in", t);
      Z(e);
    }
    for (;;) {
      {
        m(e.L);
        Z(e);
      }
      let a = k(e.L),
        c = S(e.L, "arg");
      if (c.type === "WORD" && c.value === "esac") {
        t.push(g(e, "esac", c));
        break;
      }
      if (c.type === "EOF") break;
      y(e.L, a);
      let u = qn(e);
      if (!u) break;
      t.push(u);
    }
    let o = t.at(-1);
    return d(e, "case_statement", n.startIndex, need(o).endIndex, t);
  }
  function qn(e: ParseContext): NativeBashSyntaxNode | null {
    m(e.L);
    let s = e.L.b,
      n = [];
    if (l(e.L) === "(") {
      let u = e.L.b;
      {
        i(e.L);
        n.push(d(e, "(", u, e.L.b, []));
      }
    }
    let t = !0;
    for (;;) {
      m(e.L);
      let u = l(e.L);
      if (u === ")" || u === "") break;
      let f = Fn(e);
      if (f.length === 0) break;
      if (!t && f.length > 1) {
        let L = f.map((p) =>
            p.type === "extglob_pattern"
              ? d(e, "word", p.startIndex, p.endIndex, [])
              : p,
          ),
          b = L[0],
          h = L.at(-1);
        n.push(d(e, "concatenation", need(b).startIndex, need(h).endIndex, L));
      } else n.push(...f);
      if (
        ((t = !1),
        m(e.L),
        l(e.L) === "\\" &&
          l(e.L, 1) ===
            `
`)
      ) {
        i(e.L);
        i(e.L);
        m(e.L);
      }
      if (l(e.L) === "|") {
        let L = e.L.b;
        if (
          (i(e.L),
          n.push(d(e, "|", L, e.L.b, [])),
          l(e.L) === "\\" &&
            l(e.L, 1) ===
              `
`)
        ) {
          i(e.L);
          i(e.L);
        }
      } else break;
    }
    if (l(e.L) === ")") {
      let u = e.L.b;
      {
        i(e.L);
        n.push(d(e, ")", u, e.L.b, []));
      }
    }
    let r = B(e, null);
    n.push(...r);
    let o = k(e.L),
      a = S(e.L, "cmd");
    if (
      a.type === "OP" &&
      (a.value === ";;" || a.value === ";&" || a.value === ";;&")
    )
      n.push(g(e, a.value, a));
    else y(e.L, o);
    if (n.length === 0) return null;
    if (r.length === 0)
      for (let u = 0; u < n.length; u++) {
        let f: NativeBashSyntaxNode = need(n[u]);
        if (f.type !== "extglob_pattern") continue;
        let L = F(e, f.startIndex, f.endIndex);
        if (/^[-+?*@!][a-zA-Z]/.test(L) && !/[*?(]/.test(L))
          n[u] = d(e, "word", f.startIndex, f.endIndex, []);
      }
    let c = n.at(-1);
    return d(e, "case_item", s, need(c).endIndex, n);
  }
  function Fn(e: ParseContext): NativeBashSyntaxNode[] {
    m(e.L);
    let s = k(e.L),
      n = e.L.b,
      t = e.L.i,
      r = 0,
      o = !1,
      a = !1,
      c = !1;
    while (e.L.i < e.L.len) {
      let b = l(e.L);
      if (b === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (b === "$" && l(e.L, 1) === "$") {
        {
          o = !0;
          i(e.L);
          i(e.L);
        }
        continue;
      }
      let h = b === "$" && l(e.L, 1) === "'";
      if (b === '"' || b === "'" || h) {
        c = !0;
        let p = h ? "'" : b;
        if (h) i(e.L);
        i(e.L);
        while (e.L.i < e.L.len && l(e.L) !== p) {
          if (b !== "'" && l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
          i(e.L);
        }
        if (l(e.L) === p) i(e.L);
        continue;
      }
      if (b === "(") {
        {
          r++;
          i(e.L);
        }
        continue;
      }
      if (r > 0) {
        if (b === ")") {
          {
            r--;
            i(e.L);
          }
          continue;
        }
        if (
          b ===
          `
`
        )
          break;
        i(e.L);
        continue;
      }
      if (
        b === ")" ||
        b === "|" ||
        b === " " ||
        b === "\t" ||
        b ===
          `
`
      )
        break;
      if (b === "$") o = !0;
      if (b === "[") a = !0;
      i(e.L);
    }
    if (e.L.b === n) return [];
    let u = e.src.slice(t, e.L.i),
      f = /[*?+@!]\(/.test(u);
    if (c && !f) return (y(e.L, s), Hn(e));
    if (!f && (o || a)) {
      y(e.L, s);
      let b = W(e, "arg");
      return b ? [b] : [];
    }
    let L =
      f || /[*?]/.test(u) || /^[-+?*@!][a-zA-Z]/.test(u)
        ? "extglob_pattern"
        : "word";
    return (ye(e, n), [d(e, L, n, e.L.b, [])]);
  }
  function Hn(e: ParseContext): NativeBashSyntaxNode[] {
    let s = [],
      n = e.L.b,
      t = e.L.b,
      r = e.L.i,
      o = () => {
        if (e.L.i > r) {
          let a = e.src.slice(r, e.L.i),
            c = /[*?]/.test(a) ? "extglob_pattern" : "word";
          s.push(d(e, c, t, e.L.b, []));
        }
      };
    while (e.L.i < e.L.len) {
      let a = l(e.L);
      if (a === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (a === '"') {
        {
          o();
          s.push(G(e));
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if (a === "'") {
        o();
        let c = S(e.L, "arg");
        {
          s.push(g(e, "raw_string", c));
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if (a === "$" && l(e.L, 1) === "$") {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (a === "$" && l(e.L, 1) === "'") {
        o();
        let c = S(e.L, "arg");
        {
          s.push(g(e, "ansi_c_string", c));
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if (
        a === ")" ||
        a === "|" ||
        a === " " ||
        a === "\t" ||
        a ===
          `
`
      )
        break;
      i(e.L);
    }
    return (o(), ye(e, n), s);
  }
  /** Parse function definitions. Source production Kn. */
  function Kn(e: ParseContext, s: Token): NativeBashSyntaxNode {
    let n = g(e, "function", s);
    m(e.L);
    let t = S(e.L, "arg"),
      r = d(e, "word", t.start, t.end, []),
      o = [n, r];
    if ((m(e.L), l(e.L) === "(" && l(e.L, 1) === ")")) {
      let u = S(e.L, "cmd");
      o.push(g(e, "(", u));
      let f = e.L.b;
      {
        i(e.L);
        o.push(d(e, ")", f, e.L.b, []));
      }
    }
    {
      m(e.L);
      Z(e);
    }
    let a = j(e);
    if (a)
      if (
        a.type === "redirected_statement" &&
        a.children.length >= 2 &&
        need(a.children[0]).type === "compound_statement"
      )
        o.push(...a.children);
      else o.push(a);
    let c = o.at(-1);
    return d(e, "function_definition", n.startIndex, need(c).endIndex, o);
  }
  function Qn(e: ParseContext, s: Token): NativeBashSyntaxNode {
    let n = g(e, s.value, s),
      t = [n],
      r = [];
    for (;;) {
      m(e.L);
      let f = ne(e);
      if (f) {
        r.push(f);
        continue;
      }
      let L = l(e.L);
      if (L === "(") {
        t.push(d(e, "variable_name", e.L.b, e.L.b + 1, []));
        break;
      }
      if (
        L === "" ||
        L ===
          `
` ||
        L === ";" ||
        L === "&" ||
        L === "|" ||
        L === ")" ||
        L === "<" ||
        L === ">"
      )
        break;
      let b = At(e);
      if (b) {
        t.push(b);
        continue;
      }
      if (L === '"' || L === "'" || L === "$") {
        let x = W(e, "arg");
        if (x) {
          t.push(x);
          continue;
        }
        break;
      }
      let h = k(e.L),
        p = S(e.L, "arg");
      if (p.type === "WORD" || p.type === "NUMBER")
        if (p.value.startsWith("-")) t.push(g(e, "word", p));
        else if (M(p.value[0] ?? ""))
          t.push(d(e, "variable_name", p.start, p.end, []));
        else t.push(g(e, "word", p));
      else {
        y(e.L, h);
        break;
      }
    }
    let o = t.at(-1),
      a = d(e, "declaration_command", n.startIndex, need(o).endIndex, t);
    if (r.length === 0) return a;
    let c = r.at(-1),
      u = Math.max(need(a).endIndex, need(c).endIndex);
    return d(e, "redirected_statement", n.startIndex, u, [a, ...r]);
  }
  function Gn(e: ParseContext, s: Token): NativeBashSyntaxNode {
    let n = g(e, "unset", s),
      t = [n],
      r = [];
    for (;;) {
      m(e.L);
      let f = ne(e);
      if (f) {
        r.push(f);
        continue;
      }
      let L = l(e.L);
      if (L === "(") {
        t.push(d(e, "variable_name", e.L.b, e.L.b + 1, []));
        break;
      }
      if (
        L === "" ||
        L ===
          `
` ||
        L === ";" ||
        L === "&" ||
        L === "|" ||
        L === ")" ||
        L === "<" ||
        L === ">"
      )
        break;
      let b = W(e, "arg");
      if (!b) break;
      if (b.type === "word")
        if (b.text.startsWith("-")) t.push(b);
        else
          t.push(
            d(e, "variable_name", need(b).startIndex, need(b).endIndex, []),
          );
      else t.push(b);
    }
    let o = t.at(-1),
      a = d(e, "unset_command", n.startIndex, need(o).endIndex, t);
    if (r.length === 0) return a;
    let c = r.at(-1),
      u = Math.max(need(a).endIndex, need(c).endIndex);
    return d(e, "redirected_statement", n.startIndex, u, [a, ...r]);
  }
  function he(e: ParseContext, s: string, n: NativeBashSyntaxNode[]): void {
    Z(e);
    let t = k(e.L),
      r = S(e.L, "cmd");
    if (r.type === "WORD" && r.value === s) n.push(g(e, s, r));
    else y(e.L, t);
  }
  function xt(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    return nt(e, s);
  }
  function nt(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    let n = mt(e, s);
    if (!n) return null;
    for (;;) {
      m(e.L);
      let t = k(e.L);
      if (s === "]]" && l(e.L) === "|" && l(e.L, 1) === "|") {
        let r = e.L.b;
        {
          i(e.L);
          i(e.L);
        }
        let o = d(e, "||", r, e.L.b, []);
        Be(e, s);
        let a = mt(e, s);
        if (!a) {
          y(e.L, t);
          break;
        }
        n = d(e, "binary_expression", n.startIndex, need(a).endIndex, [
          n,
          o,
          a,
        ]);
      } else break;
    }
    return n;
  }
  function mt(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    let n = _t(e, s);
    if (!n) return null;
    for (;;) {
      m(e.L);
      let t = k(e.L);
      if (s === "]]" && l(e.L) === "&" && l(e.L, 1) === "&") {
        let r = e.L.b;
        {
          i(e.L);
          i(e.L);
        }
        let o = d(e, "&&", r, e.L.b, []);
        Be(e, s);
        let a = _t(e, s);
        if (!a) {
          y(e.L, t);
          break;
        }
        n = d(e, "binary_expression", n.startIndex, need(a).endIndex, [
          n,
          o,
          a,
        ]);
      } else break;
    }
    return n;
  }
  function Be(e: ParseContext, s: string): void {
    if ((m(e.L), s === "]]"))
      for (;;) {
        let n = l(e.L);
        if (
          n ===
          `
`
        ) {
          i(e.L);
          m(e.L);
        } else if (n === "#")
          while (
            l(e.L) &&
            l(e.L) !==
              `
`
          )
            i(e.L);
        else break;
      }
  }
  function _t(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    if ((Be(e, s), l(e.L) === "(")) {
      let t = e.L.b;
      i(e.L);
      let r = d(e, "(", t, e.L.b, []),
        o = nt(e, s);
      m(e.L);
      let a;
      if (l(e.L) === ")") {
        let u = e.L.b;
        {
          i(e.L);
          a = d(e, ")", u, e.L.b, []);
        }
      } else a = d(e, ")", e.L.b, e.L.b, []);
      let c = o ? [r, o, a] : [r, a];
      return d(
        e,
        "parenthesized_expression",
        r.startIndex,
        need(a).endIndex,
        c,
      );
    }
    return Zn(e, s);
  }
  function Wt(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    Be(e, s);
    let n = l(e.L),
      t = (r: string) =>
        r === " " ||
        r === "\t" ||
        r ===
          `
` ||
        r === "";
    if (n === "!" && (t(l(e.L, 1)) || l(e.L, 1) === "(")) {
      let r = e.L.b;
      i(e.L);
      let o = d(e, "!", r, e.L.b, []),
        a = Wt(e, s);
      if (!a) return o;
      return d(e, "unary_expression", o.startIndex, need(a).endIndex, [o, a]);
    }
    if (n === "(") {
      let r = e.L.b;
      i(e.L);
      let o = d(e, "(", r, e.L.b, []),
        a = nt(e, s);
      m(e.L);
      let c;
      if (l(e.L) === ")") {
        let f = e.L.b;
        {
          i(e.L);
          c = d(e, ")", f, e.L.b, []);
        }
      } else c = d(e, ")", e.L.b, e.L.b, []);
      let u = a ? [o, a, c] : [o, c];
      return d(e, "parenthesized_expression", o.startIndex, c.endIndex, u);
    }
    if (n === "-" && M(l(e.L, 1))) {
      let r = k(e.L),
        o = e.L.b;
      i(e.L);
      while (z(l(e.L))) i(e.L);
      if (!t(l(e.L))) return (y(e.L, r), Re(e, s));
      let a = d(e, "test_operator", o, e.L.b, []),
        c = e.L.i;
      m(e.L);
      let u = Re(e, s);
      if (!u) {
        let f = e.src.slice(c, e.L.i);
        if (!/^(?:[ \t]|\\\n)*$/.test(f)) {
          let L = d(e, "test_rhs_missing", need(a).endIndex, e.L.b, []);
          return d(e, "unary_expression", need(a).startIndex, e.L.b, [a, L]);
        }
        return a;
      }
      return d(e, "unary_expression", need(a).startIndex, need(u).endIndex, [
        a,
        u,
      ]);
    }
    return Re(e, s);
  }
  function Ee(
    e: ParseContext,
    s: NativeBashSyntaxNode,
    n: NativeBashSyntaxNode,
  ): NativeBashSyntaxNode {
    let t = d(e, "test_rhs_missing", n.endIndex, e.L.b, []);
    return d(e, "binary_expression", s.startIndex, e.L.b, [s, n, t]);
  }
  function Zn(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    m(e.L);
    let n = Wt(e, s);
    if (!n) return null;
    m(e.L);
    let t = l(e.L),
      r = l(e.L, 1),
      o = null,
      a = e.L.b;
    if (t === "=" && r === "=") {
      i(e.L);
      i(e.L);
      o = d(e, "==", a, e.L.b, []);
    } else if (t === "!" && r === "=") {
      i(e.L);
      i(e.L);
      o = d(e, "!=", a, e.L.b, []);
    } else if (t === "=" && r === "~") {
      i(e.L);
      i(e.L);
      o = d(e, "=~", a, e.L.b, []);
    } else if (t === "=" && r !== "=") {
      i(e.L);
      o = d(e, "=", a, e.L.b, []);
    } else if (s === "]]" && t === "<" && r !== "<") {
      i(e.L);
      o = d(e, "<", a, e.L.b, []);
    } else if (s === "]]" && t === ">" && r !== ">") {
      i(e.L);
      o = d(e, ">", a, e.L.b, []);
    } else if (t === "-" && M(r)) {
      i(e.L);
      while (z(l(e.L))) i(e.L);
      o = d(e, "test_operator", a, e.L.b, []);
    }
    if (!o) return n;
    if (
      s === "]]" &&
      o.type === "=" &&
      ![
        " ",
        "\t",
        `
`,
        "",
      ].includes(l(e.L))
    )
      e.misreading ??= "equals_in_test";
    if ((Ft(e), s === "]]")) {
      let u = o.type;
      if (u === "=~") {
        m(e.L);
        let f = l(e.L),
          L = null;
        if (f === '"' || f === "'") {
          let b = k(e.L),
            h = f === '"' ? G(e) : g(e, "raw_string", S(e.L, "arg")),
            p = e.L.i,
            x = p;
          while (x < e.L.len && (e.src[x] === " " || e.src[x] === "\t")) x++;
          let _ = e.src[x] ?? "",
            I = x + 1;
          while (e.src[I] === "\\")
            if (
              e.src[I + 1] ===
              `
`
            )
              I += 2;
            else if (
              e.src[I + 1] === "\r" &&
              e.src[I + 2] ===
                `
`
            )
              I += 3;
            else break;
          let v = e.src[I] ?? "";
          if (
            (_ === "]" && v === "]" && x > p) ||
            (_ === "&" && v === "&") ||
            (_ === "|" && v === "|" && x > p) ||
            _ ===
              `
` ||
            _ === ""
          )
            L = h;
          else y(e.L, b);
        }
        if (!L) L = yt(e, !0);
        if (!L) return Ee(e, n, o);
        return d(e, "binary_expression", n.startIndex, L.endIndex, [n, o, L]);
      }
      if (u === "=") {
        let f = yt(e, !1);
        if (!f) return Ee(e, n, o);
        return d(e, "binary_expression", n.startIndex, f.endIndex, [n, o, f]);
      }
      if (u === "==" || u === "!=") {
        let f = Xn(e);
        if (f.length === 0) return Ee(e, n, o);
        let L = f.at(-1);
        return d(e, "binary_expression", n.startIndex, need(L).endIndex, [
          n,
          o,
          ...f,
        ]);
      }
    }
    let c = Re(e, s);
    if (!c) return Ee(e, n, o);
    return d(e, "binary_expression", n.startIndex, c.endIndex, [n, o, c]);
  }
  function yt(e: ParseContext, s: boolean): NativeBashSyntaxNode | null {
    m(e.L);
    let n = e.L.b,
      t = 0;
    while (e.L.i < e.L.len) {
      let r = l(e.L);
      if (r === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (
        r ===
        `
`
      ) {
        if (t === 0) break;
        i(e.L);
        continue;
      }
      if (r === '"' || r === "'") {
        let o = r;
        i(e.L);
        while (e.L.i < e.L.len && l(e.L) !== o) {
          if (o === '"' && l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
          i(e.L);
        }
        if (e.L.i < e.L.len) i(e.L);
        continue;
      }
      if (r === "`") {
        i(e.L);
        while (e.L.i < e.L.len && l(e.L) !== "`") {
          if (l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
          i(e.L);
        }
        if (e.L.i < e.L.len) i(e.L);
        continue;
      }
      if (t === 0) {
        if (r === " " || r === "\t") break;
        if (r === "&" || (!s && r === "|")) break;
        if (r === ")") break;
      }
      if (r === "(") t++;
      else if (r === ")" && t > 0) t--;
      i(e.L);
    }
    if (e.L.b === n) return null;
    return (ye(e, n), d(e, "regex", n, e.L.b, []));
  }
  var jn = new Set(["raw_string", "ansi_c_string", "comment", "subscript"]);
  function Xn(e: ParseContext): NativeBashSyntaxNode[] {
    m(e.L);
    let s = [],
      n = e.L.b,
      t = e.L.b,
      r = e.L.i,
      o = 0,
      a = () => {
        if (e.L.i > r) {
          let c = e.src.slice(r, e.L.i),
            u = /^\d+$/.test(c) ? "number" : "extglob_pattern";
          s.push(d(e, u, t, e.L.b, []));
        }
      };
    while (e.L.i < e.L.len) {
      let c = l(e.L);
      if (c === "\\" && e.L.i + 1 < e.L.len) {
        {
          i(e.L);
          i(e.L);
        }
        continue;
      }
      if (
        c ===
        `
`
      ) {
        if (o === 0) break;
        i(e.L);
        continue;
      }
      if (o === 0) {
        if (c === "&" || c === "|") break;
        if (c === " " || c === "\t") {
          let u = e.L.i;
          for (;;) {
            let h = e.L.src[u];
            if (h === " " || h === "\t") u++;
            else if (
              h === "\\" &&
              e.L.src[u + 1] ===
                `
`
            )
              u += 2;
            else if (
              h === "\\" &&
              e.L.src[u + 1] === "\r" &&
              e.L.src[u + 2] ===
                `
`
            )
              u += 3;
            else break;
          }
          let f = e.L.src[u] ?? "",
            L = u + 1;
          while (e.L.src[L] === "\\")
            if (
              e.L.src[L + 1] ===
              `
`
            )
              L += 2;
            else if (
              e.L.src[L + 1] === "\r" &&
              e.L.src[L + 2] ===
                `
`
            )
              L += 3;
            else break;
          let b = e.L.src[L] ?? "";
          if (
            (f === "]" && b === "]") ||
            (f === "&" && b === "&") ||
            (f === "|" && b === "|") ||
            f === "#" ||
            f ===
              `
`
          )
            break;
          i(e.L);
          continue;
        }
      }
      if (c === "$") {
        let u = l(e.L, 1);
        if (u === "'") {
          a();
          let f = S(e.L, "arg");
          {
            s.push(g(e, "ansi_c_string", f));
            t = e.L.b;
            r = e.L.i;
          }
          continue;
        }
        if (u === '"') {
          a();
          let f = { type: "DOLLAR", value: "$", start: e.L.b, end: e.L.b + 1 };
          {
            i(e.L);
            s.push(g(e, "$", f));
            s.push(G(e));
            t = e.L.b;
            r = e.L.i;
          }
          continue;
        }
        if (
          u === "(" ||
          u === "{" ||
          (u === "[" && Y(e)) ||
          M(u) ||
          se.has(u) ||
          u >= "\x80"
        ) {
          a();
          let f = Q(e);
          if (f) s.push(f);
          {
            t = e.L.b;
            r = e.L.i;
          }
          continue;
        }
      }
      if (c === '"') {
        {
          a();
          s.push(G(e));
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if (c === "'") {
        a();
        let u = S(e.L, "arg");
        {
          s.push(g(e, "raw_string", u));
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if (c === "`") {
        a();
        let u = Me(e);
        {
          s.push(u);
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if ((c === "<" || c === ">") && l(e.L, 1) === "(") {
        a();
        let u = $e(e);
        if (u) s.push(u);
        {
          t = e.L.b;
          r = e.L.i;
        }
        continue;
      }
      if (c === ")" && o === 0) break;
      if (c === "(") o++;
      else if (c === ")" && o > 0) o--;
      i(e.L);
    }
    return (a(), te(e, n, e.L.b), s);
  }
  function Re(e: ParseContext, s: string): NativeBashSyntaxNode | null {
    if ((Ft(e), s === "]" && l(e.L) === "]" && Qe(l(e.L, 1) ?? "")))
      return null;
    if (
      s === "]]" &&
      l(e.L) === "]" &&
      l(e.L, 1) === "]" &&
      Qe(l(e.L, 2) ?? "")
    )
      return null;
    return W(e, "arg");
  }
  var Yn: Record<string, number> = {
      "=": 2,
      "+=": 2,
      "-=": 2,
      "*=": 2,
      "/=": 2,
      "%=": 2,
      "<<=": 2,
      ">>=": 2,
      "&=": 2,
      "^=": 2,
      "|=": 2,
      "||": 4,
      "&&": 5,
      "|": 6,
      "^": 7,
      "&": 8,
      "==": 9,
      "!=": 9,
      "<": 10,
      ">": 10,
      "<=": 10,
      ">=": 10,
      "<<": 11,
      ">>": 11,
      "+": 12,
      "-": 12,
      "*": 13,
      "/": 13,
      "%": 13,
      "**": 14,
    },
    Vn = new Set([
      "=",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "<<=",
      ">>=",
      "&=",
      "^=",
      "|=",
      "**",
    ]);
  function gt(e: ParseContext, s: number, n: string): void {
    y(e.L, s);
    let t = 0;
    while (e.L.i < e.L.len) {
      let r = l(e.L);
      if (n === "))" || n === ")") {
        if (r === "(") t++;
        else if (r === ")")
          if (t === 0) {
            if (n === ")" || l(e.L, 1) === ")") return;
          } else t--;
      } else if (n === "]") {
        if (r === "[") t++;
        else if (r === "]") {
          if (t === 0) return;
          t--;
        }
      } else if (Te(e, n)) return;
      i(e.L);
    }
  }
  var Jn = /^(?!.*<<)(?:[\w\s$+\-*/%<>=!&|^~?:,.()[\];]|\$\{#?\w+\})*$/s;
  function Y(e: ParseContext): boolean {
    return q(e.switches, e.src, ue);
  }
  function De(e: ParseContext, s: number, n: string, t: boolean): number {
    if (!Y(e)) return -1;
    let r = e.L,
      o = qe(r.src, s, n, r.dollarEnds, e.inForHead),
      a = l(r) === n && (!t || l(r, 1) === ")"),
      c =
        o < r.i ||
        (a && o !== r.i) ||
        (t && r.src[o + 1] !== ")") ||
        !Jn.test(r.src.slice(r.i, o)) ||
        (!a && /["']/.test(r.src.slice(s, o)));
    return ((e.zshMathDiff ||= c), (e.zshMathClosesAlike = !c), o);
  }
  function Ut(e: ParseContext, s: number, n: boolean): boolean {
    let t = e.L;
    if (
      !(e.zshMathClosesAlike || q(e.switches, e.src, Se)) ||
      s < t.i ||
      (n && t.src[s + 1] !== ")")
    )
      return !1;
    while (t.i < s) i(t);
    return !0;
  }
  function It(e: ParseContext, s: number): void {
    if (e.L.i !== s && Y(e)) e.zshMathDiff = !0;
  }
  function me(
    e: ParseContext,
    s: string,
    n = "var",
  ): NativeBashSyntaxNode | null {
    e.inDquote++;
    let t = Ae(e, s, n);
    return (e.inDquote--, t);
  }
  function _e(e: ParseContext, s: string, n = "var"): NativeBashSyntaxNode[] {
    let t = [];
    for (;;) {
      let r = me(e, s, n);
      if (r) t.push(r);
      if ((m(e.L), l(e.L) === "," && !Te(e, s))) {
        i(e.L);
        continue;
      }
      break;
    }
    return t;
  }
  function Ae(
    e: ParseContext,
    s: string,
    n: string,
  ): NativeBashSyntaxNode | null {
    let t = Pe(e, s, 0, n);
    if (!t) return null;
    if ((m(e.L), l(e.L) === "?")) {
      let r = e.L.b;
      i(e.L);
      let o = d(e, "?", r, e.L.b, []),
        a = Pe(e, ":", 0, n);
      m(e.L);
      let c;
      if (l(e.L) === ":") {
        let b = e.L.b;
        {
          i(e.L);
          c = d(e, ":", b, e.L.b, []);
        }
      } else c = d(e, ":", e.L.b, e.L.b, []);
      let u = Ae(e, s, n),
        f = u ?? c,
        L = [t, o];
      if (a) L.push(a);
      if ((L.push(c), u)) L.push(u);
      return d(e, "ternary_expression", t.startIndex, f.endIndex, L);
    }
    return t;
  }
  function Pn(e: ParseContext): [string, number] | null {
    let s = l(e.L),
      n = l(e.L, 1),
      t = l(e.L, 2);
    if (s === "<" && n === "<" && t === "=") return ["<<=", 3];
    if (s === ">" && n === ">" && t === "=") return [">>=", 3];
    if (s === "*" && n === "*") return ["**", 2];
    if (s === "<" && n === "<") return ["<<", 2];
    if (s === ">" && n === ">") return [">>", 2];
    if (s === "=" && n === "=") return ["==", 2];
    if (s === "!" && n === "=") return ["!=", 2];
    if (s === "<" && n === "=") return ["<=", 2];
    if (s === ">" && n === "=") return [">=", 2];
    if (s === "&" && n === "&") return ["&&", 2];
    if (s === "|" && n === "|") return ["||", 2];
    if (s === "+" && n === "=") return ["+=", 2];
    if (s === "-" && n === "=") return ["-=", 2];
    if (s === "*" && n === "=") return ["*=", 2];
    if (s === "/" && n === "=") return ["/=", 2];
    if (s === "%" && n === "=") return ["%=", 2];
    if (s === "&" && n === "=") return ["&=", 2];
    if (s === "^" && n === "=") return ["^=", 2];
    if (s === "|" && n === "=") return ["|=", 2];
    if (s === "+" && n !== "+") return ["+", 1];
    if (s === "-" && n !== "-") return ["-", 1];
    if (s === "*") return ["*", 1];
    if (s === "/") return ["/", 1];
    if (s === "%") return ["%", 1];
    if (s === "<") return ["<", 1];
    if (s === ">") return [">", 1];
    if (s === "&") return ["&", 1];
    if (s === "|") return ["|", 1];
    if (s === "^") return ["^", 1];
    if (s === "=") return ["=", 1];
    return null;
  }
  /** Parse precedence-climbing arithmetic expressions. Source production Pe. */
  function Pe(
    e: ParseContext,
    s: string,
    n: number,
    t: string,
  ): NativeBashSyntaxNode | null {
    let r = et(e, s, t);
    if (!r) return null;
    for (;;) {
      if ((m(e.L), Te(e, s))) break;
      if (l(e.L) === ",") break;
      let o = Pn(e);
      if (!o) break;
      let [a, c] = o,
        u = Yn[a];
      if (u === void 0 || u < n) break;
      let f = e.L.b;
      for (let p = 0; p < c; p++) i(e.L);
      let L = d(e, a, f, e.L.b, []),
        b = Vn.has(a) ? u : u + 1,
        h = Pe(e, s, b, t);
      if (!h) break;
      r = d(e, "binary_expression", r.startIndex, h.endIndex, [r, L, h]);
    }
    return r;
  }
  function et(
    e: ParseContext,
    s: string,
    n: string,
  ): NativeBashSyntaxNode | null {
    if ((m(e.L), Te(e, s))) return null;
    let t = l(e.L),
      r = l(e.L, 1);
    if ((t === "+" && r === "+") || (t === "-" && r === "-")) {
      let o = e.L.b;
      {
        i(e.L);
        i(e.L);
      }
      let a = d(e, t + r, o, e.L.b, []),
        c = et(e, s, n);
      if (!c) return a;
      return d(e, "unary_expression", need(a).startIndex, c.endIndex, [a, c]);
    }
    if (t === "-" || t === "+" || t === "!" || t === "~") {
      if (n !== "var" && t === "-" && D(r)) {
        let u = e.L.b;
        i(e.L);
        while (D(l(e.L))) i(e.L);
        return d(e, "number", u, e.L.b, []);
      }
      let o = e.L.b;
      i(e.L);
      let a = d(e, t, o, e.L.b, []),
        c = et(e, s, n);
      if (!c) return a;
      return d(e, "unary_expression", need(a).startIndex, c.endIndex, [a, c]);
    }
    return es(e, s, n);
  }
  function es(
    e: ParseContext,
    s: string,
    n: string,
  ): NativeBashSyntaxNode | null {
    let t = ts(e, s, n);
    if (!t) return null;
    let r = l(e.L),
      o = l(e.L, 1);
    if ((r === "+" && o === "+") || (r === "-" && o === "-")) {
      let a = e.L.b;
      {
        i(e.L);
        i(e.L);
      }
      let c = d(e, r + o, a, e.L.b, []);
      return d(e, "postfix_expression", t.startIndex, c.endIndex, [t, c]);
    }
    return t;
  }
  function ts(
    e: ParseContext,
    s: string,
    n: string,
  ): NativeBashSyntaxNode | null {
    if ((m(e.L), Te(e, s))) return null;
    let t = l(e.L);
    if (t === "(") {
      let r = e.L.b;
      i(e.L);
      let o = d(e, "(", r, e.L.b, []),
        a = _e(e, ")", n);
      m(e.L);
      let c;
      if (l(e.L) === ")") {
        let u = e.L.b;
        {
          i(e.L);
          c = d(e, ")", u, e.L.b, []);
        }
      } else c = d(e, ")", e.L.b, e.L.b, []);
      return d(e, "parenthesized_expression", o.startIndex, c.endIndex, [
        o,
        ...a,
        c,
      ]);
    }
    if (t === '"') return G(e);
    if (t === "$") return Q(e);
    if (D(t)) {
      let r = e.L.b;
      while (D(l(e.L))) i(e.L);
      if (e.L.b - r === 1 && t === "0" && (l(e.L) === "x" || l(e.L) === "X")) {
        i(e.L);
        while (an(l(e.L))) i(e.L);
      } else if (l(e.L) === "#") {
        i(e.L);
        while (cn(l(e.L))) i(e.L);
        if (l(e.L) === "$" && Y(e)) {
          let o = d(e, "number", r, e.L.b, []),
            a = Q(e);
          return a ? d(e, "binary_expression", r, e.L.b, [o, a]) : o;
        }
      }
      return d(e, "number", r, e.L.b, []);
    }
    if (M(t)) {
      let r = e.L.b;
      while (z(l(e.L))) i(e.L);
      let o = l(e.L);
      if (n === "assign") {
        m(e.L);
        let c = l(e.L),
          u = l(e.L, 1);
        if (c === "=" && u !== "=") {
          let f = d(e, "variable_name", r, e.L.b, []),
            L = e.L.b;
          i(e.L);
          let b = d(e, "=", L, e.L.b, []),
            h = Ae(e, s, n),
            p = h ? h.endIndex : need(b).endIndex;
          return d(e, "variable_assignment", r, p, h ? [f, b, h] : [f, b]);
        }
      }
      if (o === "[") {
        let c = d(e, "variable_name", r, e.L.b, []),
          u = e.L.b;
        i(e.L);
        let f = d(e, "[", u, e.L.b, []),
          L = Ae(e, "]", "var") ?? Q(e);
        m(e.L);
        let b;
        if (l(e.L) === "]") {
          let p = e.L.b;
          {
            i(e.L);
            b = d(e, "]", p, e.L.b, []);
          }
        } else b = d(e, "]", e.L.b, e.L.b, []);
        let h = L ? [c, f, L, b] : [c, f, b];
        return d(e, "subscript", r, need(b).endIndex, h);
      }
      return d(e, n === "var" ? "variable_name" : "word", r, e.L.b, []);
    }
    return null;
  }
  function Te(e: ParseContext, s: string): boolean {
    let n = l(e.L);
    if (s === "))") return n === ")" && l(e.L, 1) === ")";
    if (s === ")") return n === ")";
    if (s === ";") return n === ";";
    if (s === ":") return n === ":";
    if (s === "]") return n === "]";
    if (s === "}") return n === "}";
    if (s === ":}") return n === ":" || n === "}";
    return (
      n === "" ||
      n ===
        `
`
    );
  }
  function C(e: ParseContext, s: string): void {
    let n = s.at(-1);
    if (s === "$'") i(e.L);
    i(e.L);
    while (e.L.i < e.L.len && l(e.L) !== n) {
      if (s !== "'" && l(e.L) === "\\" && e.L.i + 1 < e.L.len) i(e.L);
      else if (
        (n === '"' || e.inDquote > 0) &&
        (l(e.L) === "$" || l(e.L) === "`")
      )
        e.zshBraceDiff = !0;
      i(e.L);
    }
  }
  function qt(e: ParseContext): boolean {
    let s = k(e.L),
      n = S(e.L, "arg");
    return (
      y(e.L, s),
      (!["EOF", "NEWLINE", "COMMENT", "OP"].includes(n.type) ||
        n.value === "<<<") &&
        !(n.type === "BACKTICK" && e.inBacktick > 0)
    );
  }
  function Ft(e: ParseContext): void {
    if ((m(e.L), l(e.L) === "#")) e.misreading ??= "hash_in_test";
  }

  return {
    ...V_(),
    features,
    featureAnswers: Hwn,
    hasDifferentialSubstitution: QMa,
    misreadingReasons: KQn,
    keywords: YQn,
    hasUnicodeVariable: BVo,
    clearCache() {
      ee.clear();
    },
    cacheKeys(): readonly string[] {
      return [...ee.keys()];
    },
  };
}
export type NativeBashParser = ReturnType<typeof createNativeBashParser>;
