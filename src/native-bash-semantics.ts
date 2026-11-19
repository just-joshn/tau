/** Complete source-backed semantic port; proofs: artifacts/native-bash-semantic-port.
 * Result metadata and v6e classifications require the separate native permission/security consumers. */
import { AsyncLocalStorage as ht } from "node:async_hooks";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type {
  NativeBashParser,
  NativeBashSyntaxNode,
} from "./native-bash-parser.js";
import type {
  NativeBashPreparationFeatures,
  NativeBashPreparationAstCommand,
  NativeBashPreparationRedirect,
  NativeBashPreparationEnvironment,
} from "./native-bash-command-preparation.js";
type Node = NativeBashSyntaxNode;
type Scope = Map<string, string>;
export interface NativeBashSemanticCommand extends NativeBashPreparationAstCommand {
  argvUnquotedGlob?: boolean[];
  andChainOperand?: boolean;
  operandAppends?: boolean;
  atShellCwd?: {
    start: number;
    end: number;
    words: { start: number; end: number }[];
  };
}
type Command = NativeBashSemanticCommand;
type Redirect = NativeBashPreparationRedirect;
type Environment = NativeBashPreparationEnvironment;
export interface NativeBashSemanticMetadata {
  tree?: Node;
  declarationPrefixes?: number;
  declarationPrefixBashKeeps?: boolean[];
  uncertainWrite?: boolean;
  usesAssignedValue?: boolean;
}
export interface NativeBashSemanticRefusal extends NativeBashSemanticMetadata {
  kind: "too-complex";
  reason: string;
  nodeType?: string | undefined;
  differential?: boolean;
  divergentShape?: boolean;
  keepsRemovalVerdict?: boolean;
  afterHeredocDelimiter?: boolean;
}
type Refusal = NativeBashSemanticRefusal;
export interface NativeBashSemanticSimple extends NativeBashSemanticMetadata {
  kind: "simple";
  commands: Command[];
  bareAssignmentNames: string[];
  hasLoop?: boolean;
  laterLoopPassesDiffer?: boolean;
}
export type NativeBashSemanticResult = NativeBashSemanticSimple | Refusal;
type Result = NativeBashSemanticResult;
export interface NativeBashSemanticOptions {
  readsDivergentShapes?: boolean;
  plainUnquotedHeredocs?: boolean;
  declarationPrefix?: boolean[];
  passesEscapedBlanks?: boolean;
}
export type NativeBashCommandSafety =
  { ok: true } | { ok: false; reason: string; kind?: "newline-hash" };
export interface NativeBashSemanticHost {
  /** Must be the actual source-backed subprocess scrub latch/reader. */
  subprocessEnvironmentScrubEnabled: () => boolean;
  /** Native telemetry queue/sink owner. Original source can observe thrown sink errors. */
  logParseEvent: (
    name: string,
    metadata: { cmdLength: number; panic: boolean },
  ) => void;
  /** CPU milliseconds, using native process CPU usage by default. */
  cpuNow?: () => number;
  home?: () => string;
}
interface BudgetScope {
  left: number;
  until: number | undefined;
  outOfTime?: boolean;
  spliced?: number;
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing semantic source invariant");
  return value;
}
function count<T>(
  values: readonly T[],
  predicate: (value: T) => unknown,
): number {
  let total = 0;
  for (const value of values) total += +!!predicate(value);
  return total;
}

/** Complete semantic producer/classifier over the existing retained parser and preparation context owner. */
export function createNativeBashSemantics(
  parser: NativeBashParser,
  features: NativeBashPreparationFeatures,
  host: NativeBashSemanticHost,
) {
  const V_ = () => parser;
  const QMa = (tree: Node, bytes: Buffer) =>
    parser.hasDifferentialSubstitution(tree, bytes);
  const KQn = parser.misreadingReasons;
  const YQn = parser.keywords;
  const BVo = (text: string) => parser.hasUnicodeVariable(text);
  const x3a = () => parser.features.semanticReadGuardEnabled();
  const AXt = (tree: Node) => parser.features.readMisreading(tree.misreading);
  const Tro = (text: string) => parser.features.inputMisreading(text);
  const DY = () => features.refuseEnvironment();
  const rmt = () => features.appendEnvironmentNeedsReview();
  const ero = (option: string) => features.removalOptionAccepted(option);
  const v4a = () => features.vastPuddleEnabled();
  const T4a = () => features.snappyTowerEnabled();
  const far = () => features.stagedPumpkinEnabled();
  const R4a = () => features.nestedRippleEnabled();
  const x4a = (reason: string) => features.markReadingRefusal(reason);
  const P4a = () => features.readingRuleOff();
  const GQo = () => features.readsAsBash();
  const cp = () => host.subprocessEnvironmentScrubEnabled();
  const l = (name: string, metadata: { cmdLength: number; panic: boolean }) =>
    host.logParseEvent(name, metadata);
  const U = count;
  const qr = <T>(
    record: Readonly<Record<string, T>>,
    key: string,
  ): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
  const vn = host.home ?? homedir;
  const Nn = isDeepStrictEqual;
  function KI(e: string): string {
    return e.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  }
  var mt = 5000,
    De = 65536,
    G = 1e4,
    V = new ht<BudgetScope>(),
    _e = new ht<{ cutShort: boolean }>();
  async function qMa<T>(
    e: () => T | Promise<T>,
  ): Promise<{ result: T; cutShort: boolean }> {
    let t = _e.getStore() ?? { cutShort: !1 };
    return { result: await _e.run(t, e), cutShort: t.cutShort };
  }
  function Me(): void {
    let e = _e.getStore();
    if (e !== void 0) e.cutShort = !0;
  }
  function KMa(): boolean {
    return _e.getStore()?.cutShort === !0;
  }
  class be extends Error {}
  function Uti(e: unknown): boolean {
    return e instanceof be;
  }
  const Le = {
    now:
      host.cpuNow ??
      (() => {
        const time = process.threadCpuUsage?.() ?? process.cpuUsage();
        return (time.user + time.system) / 1000;
      }),
  };
  function YMa<T>(e: () => T): T {
    return V.getStore() === void 0
      ? V.run({ left: mt, until: undefined }, e)
      : e();
  }
  async function M5r<T>(
    e: () => T | Promise<T>,
  ): Promise<{ result?: T; outOfTime: boolean }> {
    let t = Le.now(),
      n = V.getStore() ?? { left: mt, until: undefined },
      r = n.until !== void 0;
    n.until ??= t + n.left;
    try {
      return { result: await V.run(n, e), outOfTime: n.outOfTime === !0 };
    } catch (i) {
      if (i instanceof be) return { outOfTime: !0 };
      throw i;
    } finally {
      if (!r) {
        n.until = void 0;
        n.left -= Le.now() - t;
      }
    }
  }
  function Bti(e = 0): void {
    let t = V.getStore();
    if (t?.until !== void 0 && (e > G || Le.now() > t.until)) ze();
  }
  function XMa(): void {
    let e = V.getStore();
    if (e !== void 0) e.spliced = 0;
    Bti();
  }
  function gt(e: Command[]): boolean {
    let t = e.some(
      ({ argv: n, envVars: r, redirects: i }) =>
        n.some((s) => s.length > G) ||
        r.some(({ value: s }) => s.length > G) ||
        i.some(({ target: s }) => s.length > G),
    );
    if (t) ze();
    return t;
  }
  function ze(): void {
    let e = V.getStore();
    if (e?.until !== void 0) throw ((e.outOfTime = !0), new be());
  }
  function xt(e: number): void {
    let t = V.getStore();
    if (t?.until !== void 0) {
      if (((t.spliced = (t.spliced ?? 0) + e), t.spliced > De)) ze();
    }
  }
  function Qxt(e: string): boolean {
    return /^-[pvV]+$/.test(e) && /[vV]/.test(e);
  }
  function dLe(e: string, t: Iterable<string>): boolean {
    return /^-[a-zA-Z]+$/.test(e) && [...t].some((n) => e.includes(n));
  }
  function Fe(e: string): boolean {
    return /^[+-][^iEF]*$/.test(e) && /[aA]/.test(e);
  }
  function JMa(e: string, t: Iterable<string>): boolean {
    return /^-[a-z]+$/.test(e) && [...t].some((n) => e.includes(n));
  }
  var yt = 1e4,
    An = new Set([
      "export",
      "declare",
      "typeset",
      "readonly",
      "local",
      "unset",
      "unsetenv",
    ]),
    Tn = new Set(["word", "string", "raw_string", "number"]),
    We = new Set(["command_substitution", "process_substitution"]),
    Be = new Set(["command", "declaration_command"]);
  async function PVo(e: string): Promise<{
    rootNode: Node;
    envVars: string[];
    commandNode: Node | null;
    originalCommand: string;
  } | null> {
    if (!e || e.length > yt) return null;
    try {
      let t = V_().parse(e);
      if (!t) return null;
      let n = cLe(t, null),
        r = $n(n);
      return { rootNode: t, envVars: r, commandNode: n, originalCommand: e };
    } catch {
      return null;
    }
  }
  const $b = Symbol("parse-aborted");
  async function V1(e: string): Promise<Node | typeof $b | null> {
    if (!e) return null;
    if (e.length > yt)
      return (
        l("tengu_tree_sitter_parse_abort", { cmdLength: e.length, panic: !1 }),
        $b
      );
    try {
      let t = V_().parse(e);
      if (t === null)
        return (
          l("tengu_tree_sitter_parse_abort", {
            cmdLength: e.length,
            panic: !1,
          }),
          $b
        );
      return t;
    } catch {
      return (
        l("tengu_tree_sitter_parse_abort", { cmdLength: e.length, panic: !0 }),
        $b
      );
    }
  }
  function cLe(e: Node, t: Node | null): Node | null {
    let { type: n, children: r } = e;
    if (Be.has(n)) return e;
    if (n === "variable_assignment" && t)
      return (
        t.children.find((i) => Be.has(i.type) && i.startIndex > e.startIndex) ??
        null
      );
    if (n === "pipeline") {
      for (let i of r) {
        let s = cLe(i, e);
        if (s) return s;
      }
      return null;
    }
    if (n === "redirected_statement")
      return r.find((i) => Be.has(i.type)) ?? null;
    for (let i of r) {
      let s = cLe(i, e);
      if (s) return s;
    }
    return null;
  }
  function $n(e: Node | null): string[] {
    if (!e || e.type !== "command") return [];
    let t = [];
    for (let n of e.children)
      if (n.type === "variable_assignment") t.push(n.text);
      else if (n.type === "command_name" || n.type === "word") break;
    return t;
  }
  function Zxt(e: Node): string[] {
    if (e.type === "declaration_command") {
      let r = e.children[0];
      return r && An.has(r.text) ? [r.text] : [];
    }
    let t = [],
      n = !1;
    for (let r of e.children) {
      if (r.type === "variable_assignment") continue;
      if (r.type === "command_name" || (!n && r.type === "word")) {
        n = !0;
        let i = r.children[0] ?? r;
        if (i.type === "concatenation")
          t.push(
            i.children.some((s) => We.has(s.type))
              ? i.text
              : i.children.map(ke).join(""),
          );
        else t.push(ke(i));
        continue;
      }
      if (Tn.has(r.type)) t.push(ke(r));
      else if (r.type === "concatenation") {
        if (r.children.some((i) => We.has(i.type))) break;
        t.push(r.children.map(ke).join(""));
      } else if (We.has(r.type)) break;
    }
    return t;
  }
  function ke(e: Node): string {
    if (e.type === "word") return e.text.replace(/\\(.)/g, "$1");
    return Pn(e.text);
  }
  function Pn(e: string): string {
    return e.length >= 2 &&
      ((e[0] === '"' && e.at(-1) === '"') || (e[0] === "'" && e.at(-1) === "'"))
      ? e.slice(1, -1)
      : e;
  }
  var Mt = '"(?:\\$PWD|\\$\\(pwd\\))',
    jti = new RegExp(`${Mt}/`),
    OVo = new RegExp(`^${Mt}(/[^"$\`\\\\\\n]*)"$`),
    ot = new Set(["program", "list", "pipeline", "redirected_statement"]),
    he = new Set([
      "&&",
      "||",
      "|",
      ";",
      "&",
      "|&",
      `
`,
    ]),
    zt = new Set([
      "command",
      "pipeline",
      "list",
      "negated_command",
      "declaration_command",
      "unset_command",
    ]),
    In = new Set(["test_command", "redirected_statement"]),
    pJ = "__CMDSUB_OUTPUT__",
    O = "__TRACKED_VAR__",
    On = new Set(["file_redirect", "herestring_redirect", "heredoc_redirect"]),
    C = "__UNCERTAIN_VAR__";
  function Ys(e: string): boolean {
    return e.includes(pJ) || e.includes(O) || e.includes(C);
  }
  function IVo(e: string): string | undefined {
    let t = [pJ, O, C].find((n) => e.startsWith(n));
    return t === void 0 ? void 0 : e.slice(t.length);
  }
  function Wti(e: string): string {
    let t = [pJ, O, C].map((n) => e.indexOf(n));
    return e.slice(0, Math.min(...t.filter((n) => n !== -1), e.length));
  }
  function eB(e: string): string {
    return e.replaceAll(pJ, "$(\u2026)").replaceAll(O, "${\u2026}");
  }
  function Act(e: string): string {
    return e.replaceAll(pJ, "").replaceAll(O, "");
  }
  var D = 0,
    Ae = 0,
    H = 0,
    Cn = /["`\\]/;
  function Ln(e: string, t: number): boolean {
    return (
      t > 0 &&
      e[t - 1] ===
        `
`
    );
  }
  function Gti(e: string): boolean {
    if (e.includes(O) || e.includes(C)) return !0;
    let t = e.indexOf(pJ);
    while (t !== -1) {
      if (!Ln(e, t)) return !0;
      t = e.indexOf(pJ, t + pJ.length);
    }
    return !1;
  }
  function zti(e: string): boolean {
    return e.startsWith(pJ) || e.startsWith(O) || e.startsWith(C);
  }
  var _t = /[ \t\n*?[]/,
    Dn = /^-[ioe]$/,
    Mn = /^-[ioe]./,
    zn = /^--(input|output|error)=/,
    bt = new Set([
      "BASHOPTS",
      "BASH_VERSINFO",
      "EUID",
      "PPID",
      "SHELLOPTS",
      "UID",
      "FUNCNAME",
      "GROUPS",
      "BASH_ARGC",
      "BASH_ARGV",
      "BASH_LINENO",
      "BASH_SOURCE",
      "BASHPID",
    ]),
    qe = new Set([
      "HOME",
      "PWD",
      "OLDPWD",
      "USER",
      "LOGNAME",
      "SHELL",
      "PATH",
      "HOSTNAME",
      "UID",
      "EUID",
      "PPID",
      "RANDOM",
      "SECONDS",
      "LINENO",
      "TMPDIR",
      "BASH_VERSION",
      "BASHPID",
      "SHLVL",
      "HISTFILE",
      "IFS",
    ]),
    Fn = new Set(["?", "$", "!", "#", "0", "-"]),
    Wn = new Set([
      "command_substitution",
      "process_substitution",
      "expansion",
      "simple_expansion",
      "brace_expression",
      "subshell",
      "compound_statement",
      "for_statement",
      "while_statement",
      "until_statement",
      "if_statement",
      "case_statement",
      "function_definition",
      "test_command",
      "ansi_c_string",
      "translated_string",
      "herestring_redirect",
      "heredoc_redirect",
    ]),
    Bn = [...Wn];
  function MVo(e: string | undefined): number {
    if (!e) return -2;
    if (e === "ERROR") return -1;
    let t = Bn.indexOf(e);
    return t >= 0 ? t + 1 : 0;
  }
  var je: Readonly<Record<string, string>> = {
      ">": ">",
      ">>": ">>",
      "<": "<",
      ">&": ">&",
      "<&": "<&",
      ">|": ">|",
      "&>": "&>",
      "&>>": "&>>",
      "<<<": "<<<",
    },
    Te = {
      test: (e: string) =>
        e.split(/\s/).some((t) => {
          let n = t.indexOf("{"),
            r = t.lastIndexOf("}"),
            i = n < 0 || r < n ? "" : t.slice(n + 1, r);
          return i.includes(",") || i.includes("..");
        }),
    },
    Ye = /\{[^{]*\\}/,
    Ke = /\{[^}]*\\\{/,
    p7e = new RegExp(String.raw`[\x00-\x08\x0B-\x1F\x7F]`),
    ePt =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    tPt = /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/,
    XKt = /\\[ \t]/,
    D5r = /(?:^|[^ \t\\])(?:\\\\)*\\\n|[ \t](?:\\\\)+\\\n|\\[ \t]\\\n/,
    Un = new RegExp(`${XKt.source}|${D5r.source}`),
    L5r = /(?:^|[^\\])(?:\\\\)*(?:[`$]|[<>=]\()/,
    DVo = /(?:^|[^\\])(?:\\\\)*['"]/,
    H5r = /~\[/,
    N5r = /(?:^|[\s;&|])=[a-zA-Z_]/,
    LVo = /<\d*-\d*>/,
    Hn = /\{[^}]*['"]/;
  function F(e: string): boolean {
    let t = !1,
      n = !1,
      r = !1,
      i = !0,
      s = 0;
    while (s < e.length) {
      let o = e[s];
      if (r)
        if (
          o === "\\" &&
          (e[s + 1] === "`" || e[s + 1] === "\\" || e[s + 1] === "$")
        )
          s += 2;
        else {
          if (o === "`") r = !1;
          s++;
        }
      else if (t) {
        if (o === "'") t = !1;
        s++;
      } else if (n)
        if (
          o === "\\" &&
          (e[s + 1] === '"' || e[s + 1] === "\\" || e[s + 1] === "`")
        )
          s += 2;
        else if (o === "`") {
          r = !0;
          s++;
        } else {
          if (o === '"') n = !1;
          s++;
        }
      else if (o === "\\" && s + 1 < e.length) {
        if (
          e[s + 1] !==
          `
`
        )
          i = !1;
        s += 2;
      } else if (o === "#" && i) {
        while (
          s < e.length &&
          e[s] !==
            `
`
        )
          s++;
        i = !0;
      } else if (o === "`") {
        r = !0;
        i = !1;
        s++;
      } else {
        if (o === "*" || o === "?" || o === "[") return !0;
        if (o === "'") t = !0;
        else if (o === '"') n = !0;
        {
          i =
            o === " " ||
            o === "\t" ||
            o ===
              `
` ||
            o === ";" ||
            o === "|" ||
            o === "&" ||
            o === "(" ||
            o === ")" ||
            o === "<" ||
            o === ">";
          s++;
        }
      }
    }
    return !1;
  }
  var Zn = /[*?]|\[[^\]]*\]/;
  function Re(e: string): boolean {
    return Zn.test(e);
  }
  function E6e(e: Command): boolean {
    let t = e.argvUnquotedGlob;
    if (
      e.carveOutMayDesyncQuoteScan === !0 ||
      (t === void 0 && e.argv.some(Ys))
    )
      return (
        e.argv.some(Re) ||
        e.redirects.some((r) => r.op !== "<<" && r.op !== "<<<" && Re(r.target))
      );
    if (t === void 0) return !1;
    if (t.length !== e.argv.length) return e.argv.some(Re);
    return e.argv.some((r, i) => Re(r) && (t[i] === !0 || Ys(r)));
  }
  function Ft(e: string): string {
    if (!e.includes("{")) return e;
    let t = [],
      n = !1,
      r = !1,
      i = !1,
      s = !0,
      o = 0;
    while (o < e.length) {
      let u = e[o];
      if (i)
        if (
          u === "\\" &&
          (e[o + 1] === "`" || e[o + 1] === "\\" || e[o + 1] === "$")
        ) {
          t.push(u, e[o + 1]);
          o += 2;
        } else {
          if (u === "`") i = !1;
          {
            t.push(u === "{" ? " " : u);
            o++;
          }
        }
      else if (n) {
        if (u === "'") n = !1;
        {
          t.push(u === "{" ? " " : u);
          o++;
        }
      } else if (r)
        if (
          u === "\\" &&
          (e[o + 1] === '"' || e[o + 1] === "\\" || e[o + 1] === "`")
        ) {
          t.push(u, e[o + 1]);
          o += 2;
        } else if (u === "`") {
          i = !0;
          t.push(u);
          o++;
        } else {
          if (u === '"') r = !1;
          {
            t.push(u === "{" ? " " : u);
            o++;
          }
        }
      else if (u === "\\" && o + 1 < e.length) {
        if (
          (t.push(u, e[o + 1]),
          e[o + 1] !==
            `
`)
        )
          s = !1;
        o += 2;
      } else if (u === "#" && s) {
        while (
          o < e.length &&
          e[o] !==
            `
`
        ) {
          t.push(e[o]);
          o++;
        }
        s = !0;
      } else if (u === "`") {
        i = !0;
        s = !1;
        t.push(u);
        o++;
      } else {
        if (u === "'") n = !0;
        else if (u === '"') r = !0;
        {
          s =
            u === " " ||
            u === "\t" ||
            u ===
              `
` ||
            u === ";" ||
            u === "|" ||
            u === "&" ||
            u === "(" ||
            u === ")" ||
            u === "<" ||
            u === ">";
          t.push(u);
          o++;
        }
      }
    }
    return t.join("");
  }
  var kt = String.fromCharCode(36);
  function Ce(e: Node, t: string): boolean {
    if (e.type === t) return !0;
    for (let n of e.children) if (n && Ce(n, t)) return !0;
    return !1;
  }
  async function oR(
    e: string,
    {
      readsDivergentShapes: t = false,
    }: Pick<NativeBashSemanticOptions, "readsDivergentShapes"> = {},
  ): Promise<Result> {
    if (e === "")
      return { kind: "simple", commands: [], bareAssignmentNames: [] };
    let n = await V1(e);
    if (n === null)
      return { kind: "simple", commands: [], bareAssignmentNames: [] };
    let r = SG(e, n, { readsDivergentShapes: t });
    if (n !== $b && (r.kind === "simple" || r.nodeType !== void 0))
      return { ...r, tree: n };
    return r;
  }
  function F5r(
    e: number,
    t?: boolean[],
  ): { readings: boolean[][]; exhaustive: boolean } {
    let n = (i: (offset: number) => boolean) =>
      Array.from({ length: e }, (s, o) => i(o));
    if (e <= 3)
      return {
        readings: Array.from({ length: 2 ** e }, (i, s) =>
          n((o) => Math.floor(s / 2 ** o) % 2 === 1),
        ),
        exhaustive: !0,
      };
    let r = [n(() => !1), n(() => !0)];
    for (let i = 0; e <= 8 && i < e; i++) r.push(n((s) => s === i));
    if (t?.length === e && !r.some((i) => i.every((s, o) => s === t[o])))
      r.push([...t]);
    return { readings: r, exhaustive: !1 };
  }
  function SG(
    e: string,
    t: Node | typeof $b,
    n: NativeBashSemanticOptions = {},
  ): Result {
    let r = Gn(e, t, n);
    if (r.kind !== "simple") Tro(e);
    return r;
  }
  function Gn(
    e: string,
    t: Node | typeof $b,
    n: NativeBashSemanticOptions,
  ): Result {
    let r = Rt(e, t, n, "first"),
      i = r.kind === "simple" && gt(r.commands),
      s = t === $b ? void 0 : AXt(t);
    if (s !== void 0 && r.kind === "simple")
      return {
        kind: "too-complex",
        reason: required(qr(KQn, s)),
        differential: !0,
      };
    if (
      r.kind === "simple" &&
      n.readsDivergentShapes !== !0 &&
      t !== $b &&
      Iwn(e, t)
    )
      return {
        kind: "too-complex",
        reason:
          "A nested command in this command can't be checked before it runs",
        differential: !0,
        divergentShape: !0,
        keepsRemovalVerdict: !0,
      };
    if (i && n.readsDivergentShapes !== !0 && t !== $b) return xn(t);
    let o =
      r.kind === "simple" &&
      r.hasLoop === !0 &&
      T4a() &&
      !Nn(r, Rt(e, t, n, "later"))
        ? { ...r, laterLoopPassesDiffer: !0 }
        : r;
    if (!i || o.kind !== "simple") return o;
    return (Me(), { ...o, commands: o.commands.map(Vn) });
  }
  function Vn(e: Command): Command {
    return {
      ...e,
      argv: e.argv.map((t) => t.slice(0, G)),
      envVars: e.envVars.map((t) => ({ ...t, value: t.value.slice(0, G) })),
      redirects: e.redirects.map((t) => ({
        ...t,
        target: t.target.slice(0, G),
      })),
    };
  }
  function Iwn(e: string, t: Node): boolean {
    return e.includes("(") && x3a() && QMa(t, Buffer.from(e, "utf8"));
  }
  function Rt(
    e: string,
    t: Node | typeof $b,
    {
      plainUnquotedHeredocs: n = false,
      declarationPrefix: r,
      readsDivergentShapes: i = false,
      passesEscapedBlanks: s = false,
    }: NativeBashSemanticOptions,
    o: "first" | "later",
  ): Result {
    if (ePt.test(e))
      return {
        kind: "too-complex",
        reason: "Contains lone surrogate",
        differential: !0,
      };
    if (p7e.test(e))
      return {
        kind: "too-complex",
        reason: "Contains control characters",
        differential: !0,
      };
    if (tPt.test(e))
      return {
        kind: "too-complex",
        reason: "Contains Unicode whitespace",
        differential: !0,
      };
    if ((s ? D5r : Un).test(e))
      return {
        kind: "too-complex",
        reason: "Contains backslash-escaped whitespace",
        differential: !0,
      };
    if (H5r.test(e))
      return {
        kind: "too-complex",
        reason: "Contains zsh ~[ dynamic directory syntax",
        differential: !0,
      };
    if (N5r.test(e))
      return {
        kind: "too-complex",
        reason: "Contains zsh =cmd equals expansion",
        differential: !0,
      };
    if (LVo.test(e))
      return {
        kind: "too-complex",
        reason: "Contains zsh <N-M> numeric-range glob",
        differential: !0,
      };
    if (Hn.test(Ft(e)))
      return {
        kind: "too-complex",
        reason: "Contains brace with quote character (expansion obfuscation)",
        differential: !0,
      };
    if (e.trim() === "")
      return { kind: "simple", commands: [], bareAssignmentNames: [] };
    if (t === $b)
      return {
        kind: "too-complex",
        reason: "Parser aborted (timeout, resource limit, or over-length)",
        nodeType: "PARSE_ABORT",
      };
    for (let E of [
      "backtick_body_empty",
      "backtick_body_overrun",
      "backtick_escape_unsupported",
    ])
      if (Ce(t, E))
        return {
          kind: "too-complex",
          reason:
            E === "backtick_body_empty"
              ? "empty backtick substitution \u2014 bash joins the surrounding words, so the parsed command boundaries cannot be trusted"
              : "backtick substitution scan could not be trusted (" +
                E +
                ") \u2014 the parsed bytes may differ from what bash executes",
          differential: !0,
        };
    let a = Buffer.from(e, "utf8");
    {
      let E = Zt(t, a, 0);
      if (E) return E;
    }
    {
      let E = Gt(t);
      if (E) return E;
    }
    let f = (E: number | undefined) =>
        E === 32 || E === 9 || E === 10 || E === 13 || E === 59 || E === 38,
      g = (E: number, ee: number) => {
        let B = E;
        while (B < ee) {
          let pt = a[B];
          if (f(pt)) B++;
          else if (
            pt === 92 &&
            (a[B + 1] === 10 || (a[B + 1] === 13 && a[B + 2] === 10))
          )
            B += a[B + 1] === 13 ? 3 : 2;
          else break;
        }
        return B;
      },
      _ = t.children
        .filter((E) => E !== null)
        .map((E): [number, number] => [E.startIndex, E.endIndex])
        .sort((E, ee) => E[0] - ee[0]),
      h = 0;
    for (let [E, ee] of _) {
      if (g(h, E) < E)
        return {
          kind: "too-complex",
          reason: "Parser skipped input between top-level statements",
        };
      if (ee > h) h = ee;
    }
    if (g(h, a.length) < a.length)
      return {
        kind: "too-complex",
        reason: "Parser did not consume trailing input",
      };
    {
      let E = on(t, a);
      if (E !== null)
        return {
          kind: "too-complex",
          reason: `Redirect uses ${lt(E)} fd-variable assignment \u2014 modifies shell variable as side effect`,
        };
    }
    {
      let E = an(t);
      if (E) return E;
    }
    let p = i ? null : Wt(t);
    if (p !== null)
      return {
        kind: "too-complex",
        reason: p,
        nodeType: "ERROR",
        differential: !0,
        divergentShape: !0,
      };
    let c = ie,
      x = v,
      d = q,
      m = ue,
      b = Z,
      y = K,
      w = W,
      k = j,
      A = pe,
      R = X,
      P = Y;
    Y = !1;
    let L = fe;
    fe = 0;
    let wn = de,
      Sn = J,
      En = Q;
    {
      de = o === "later";
      J = null;
      Q = 0;
      ie = n;
      v = i;
      q = !1;
      ue = e.length * yr;
      Z = r;
      K = 0;
      W = new Map();
      j = !1;
      pe = new Set();
      X = void 0;
    }
    let N: Result;
    try {
      if (((N = rr(t)), Y && N.kind === "simple"))
        N = { ...N, usesAssignedValue: !0 };
      if (j && N.kind === "simple")
        N = {
          kind: "too-complex",
          reason:
            "A variable set in front of a declaration inside a branch or loop can't be checked before it runs",
        };
      let E = pr();
      if (r === void 0 && E !== void 0)
        N = {
          ...N,
          declarationPrefixes: E.length,
          declarationPrefixBashKeeps: E,
        };
      if (r !== void 0 && N.kind === "simple" && hr() !== r.length)
        N = {
          kind: "too-complex",
          reason:
            "The variables set in front of declarations in this command can't be checked before it runs",
        };
      if (q) N = { ...N, uncertainWrite: !0 };
    } finally {
      {
        ie = c;
        v = x;
        q = d;
        ue = m;
        Z = b;
        K = y;
        W = w;
        j = k;
        pe = A;
        X = R;
        Y = P;
        fe = L;
        de = wn;
        J = Sn;
        Q = En;
      }
    }
    if (N.kind === "too-complex" && N.nodeType !== "ERROR" && (Bt(t) || Ut(t)))
      return { ...N, nodeType: "ERROR" };
    return N;
  }
  function Wt(e: Node): string | null {
    if (e.children.length === 0)
      return e.startIndex === e.endIndex && !e.type.startsWith("heredoc_")
        ? "Parse error"
        : null;
    for (let t of e.children) {
      let n = t === null ? null : Wt(t);
      if (n !== null) return n;
    }
    return e.type === "test_command" &&
      e.children[0]?.type === "[" &&
      !/^\[[ \t]/.test(e.text)
      ? "[ glued to the next word names another command"
      : null;
  }
  function Bt(e: Node): boolean {
    if (e.type === "ERROR" && (e.text.startsWith("${") || Ht(e.text)))
      return !0;
    for (let t of e.children) if (t && Bt(t)) return !0;
    return !1;
  }
  function Ut(e: Node): boolean {
    let t = e.children;
    for (let n = 0; n < t.length; n++) {
      let r = t[n];
      if (!r) continue;
      if (
        r.type === "simple_expansion" &&
        r.children.some(
          (i) => i?.type === "special_variable_name" && i.text === "#",
        )
      ) {
        let i = "";
        for (let o = n + 1; o < t.length; o++) {
          let u = t[o]?.text ?? "";
          if (((i += u), !/^[\w\u0080-\uffff]*$/.test(u))) break;
        }
        let s = /^[\w\u0080-\uffff]*(?=\[|:[a-zA-Z&])/.exec(i);
        if (s && /[\u0080-\uffff]/.test(s[0])) return !0;
      }
      if (Ut(r)) return !0;
    }
    return !1;
  }
  function Ht(e: string): boolean {
    return (
      /^\$[#^=~+]*[\w\u0080-\uffff]+$/.test(e) && /[\u0080-\uffff]/.test(e)
    );
  }
  function Zt(e: Node, t: Buffer, n: number): Refusal | null {
    for (let r of e.children) {
      if (!r) continue;
      let i = r.startIndex - 1 - n;
      if (r.type === "comment" && i >= 0 && (t[i] === 41 || t[i] === 40))
        return {
          kind: "too-complex",
          reason:
            "comment glued to a paren \u2014 bash reads `)#\u2026` and `(#\u2026` as a comment, but zsh reads a keyword- or word-glued `(\u2026)` as a glob group whose `#\u2026` text is word content that executes",
          differential: !0,
        };
      let s = Zt(r, t, n);
      if (s) return s;
    }
    for (let r of e.children) {
      if (!r) continue;
      if (
        r.type === "case_item" &&
        !r.children.some((i) => i !== void 0 && i.type === ")") &&
        Yt(r)
      )
        return {
          kind: "too-complex",
          reason:
            "`case` pattern group holds a comment \u2014 bash reads no comment inside a pattern list, but zsh reads the group as one glob word and expands its contents",
          differential: !0,
        };
      if (
        r.type === "function" &&
        !e.children.some((i) => i !== void 0 && i.type === "(")
      ) {
        let i = e.children[1],
          s = e.children.find(
            (u) => u !== void 0 && u.type === "redirected_statement",
          )?.children[0],
          o =
            e.children.find((u) => u !== void 0 && u.type === "subshell") ??
            (s?.type === "subshell" ? s : void 0);
        if (
          i !== void 0 &&
          o !== void 0 &&
          tr(t, i.endIndex - n, o.startIndex - n)
        )
          return {
            kind: "too-complex",
            reason:
              "`function` with a parenthesised body and no `()` \u2014 bash reads a subshell body, but zsh reads one glob-group word and expands its contents",
            differential: !0,
          };
      }
      if (qn.has(r.type) && t[r.endIndex - n] === 40)
        return {
          kind: "too-complex",
          reason: `\`${r.type}\` glued to a paren \u2014 bash reads a keyword and a subshell, but zsh reads one glob-group word and expands its contents`,
          differential: !0,
        };
    }
    return null;
  }
  var qn = new Set(["if", "elif", "else", "while", "until", "case"]);
  function Gt(e: Node): Refusal | null {
    if (e.type === "declaration_command" || e.type === "unset_command") {
      if (
        e.type === "declaration_command" &&
        e.children.some(
          (s) =>
            s !== void 0 &&
            (/^(?:export|readonly)$/.test(e.children[0]?.text ?? "")
              ? Kn
              : at
            ).test(M(s.text)),
        ) &&
        !se(e)
      )
        return {
          kind: "too-complex",
          reason: `${e.children[0]?.text ?? "declare"} with a flag that changes assignment semantics and an operand it would evaluate`,
          differential: !0,
        };
      let t =
          e.type === "unset_command" ||
          /^(?:declare|typeset|local|export)$/.test(e.children[0]?.text ?? ""),
        n = /^(?:declare|typeset|local)$/.test(e.children[0]?.text ?? ""),
        r = e.children.some(
          (s) => s !== void 0 && /^[-+][A-Za-z]*[fF]/.test(M(s.text)),
        ),
        i;
      for (let [s, o] of e.children.entries()) {
        if (!o) continue;
        if (
          s > 1 &&
          i !== void 0 &&
          o.type !== "variable_assignment" &&
          o.startIndex === i.endIndex
        )
          return {
            kind: "too-complex",
            reason: `${e.children[0]?.text ?? e.type} operand '${i.text}${o.text}' is split across adjacent quoted segments \u2014 the shell joins them into one word the analyzer cannot verify`,
            differential: !0,
          };
        if (s > 0 && o.type === "ansi_c_string" && /^\$'[-+]/.test(o.text))
          return {
            kind: "too-complex",
            reason: `${e.children[0]?.text ?? e.type} flag ${o.text} \u2014 a $'\u2026' flag word the shell decodes`,
            differential: !0,
          };
        if (s > 0 && !/^[-+]/.test(M(o.text))) {
          let u =
            o.type === "word" ||
            o.type === "raw_string" ||
            o.type === "concatenation" ||
            o.type === "variable_name" ||
            o.type === "number";
          if (
            o.type === "ansi_c_string" &&
            (t || e.children[0]?.text === "readonly")
          )
            return {
              kind: "too-complex",
              reason: `${e.children[0]?.text ?? e.type} operand ${o.text} \u2014 a $'\u2026' word the shell decodes, which may carry a subscript the parser cannot read`,
              differential: !0,
            };
          if (n) {
            if (!ve(o, r))
              return {
                kind: "too-complex",
                reason: `${e.children[0]?.text ?? "declare"} operand '${o.text}' is not a plain NAME with an inert value \u2014 the shell may re-parse it as a subscript, an expanded name or a compound assignment`,
                differential: !0,
              };
            i = o;
            continue;
          }
          let a = ne(o.text),
            f = /^['"]?[A-Za-z_]\w*=/.test(o.text),
            g = u
              ? (t && a.includes("[")) ||
                (f ? a.slice(1).includes("\\") : o.text.slice(1).includes("\\"))
              : o.type === "string" &&
                (f ? a.includes("\\") : o.text.includes("\\")),
            _ = o.type === "variable_assignment" && /['\\]/.test(ne(o.text)),
            h = u && t && /^['"]?\$/.test(a) && /[[`'"]/.test(o.text);
          if (g || _ || h)
            return {
              kind: "too-complex",
              reason: `${e.children[0]?.text ?? e.type} operand '${o.text}' carries a subscript or escape the shell evaluates \u2014 the parser read it as literal text`,
              differential: !0,
            };
          if (
            o.type === "variable_name"
              ? !(ae.test(o.text) || (r && $e.test(o.text)))
              : (o.type === "word" ||
                  o.type === "concatenation" ||
                  o.type === "raw_string" ||
                  (o.type === "string" && ne(o.text) !== o.text)) &&
                !St(o.text, r, e.children[0]?.text === "readonly")
          )
            return {
              kind: "too-complex",
              reason: `${e.children[0]?.text ?? e.type} operand '${o.text}' is not a plain variable name \u2014 the shell expands or matches it before assigning`,
              differential: !0,
            };
        }
        i = o;
      }
    }
    if (e.type === "command") {
      let t = e.children.find((i) => i !== void 0 && i.type === "command_name"),
        n = t === void 0 ? -1 : e.children.indexOf(t),
        r = e.children.filter(
          (i, s) => i !== void 0 && s > n && i.type !== "command_name",
        );
      if (t !== void 0) {
        if (Pe(t) && r.some((f) => !/^[-+]/.test(M(f.text))))
          return {
            kind: "too-complex",
            reason: `command head ${t.text} \u2014 a $'\u2026' word the shell decodes before looking the command up`,
            differential: !0,
          };
        let i = He(t.text),
          s = r,
          o = !1,
          u = !1;
        while (jn.test(i) && s.length > 0) {
          o = !0;
          while (s.length > 0 && M(required(s[0]).text).startsWith("-")) {
            let f = M(required(s[0]).text);
            if (i === "command" && /^-[pP]*[vV]/.test(f)) u = !0;
            s = s.slice(i === "exec" && /^-[cl]*a$/.test(f) ? 2 : 1);
          }
          if (
            !u &&
            s.length > 0 &&
            Pe(required(s[0])) &&
            s.slice(1).some((f) => !/^[-+]/.test(M(f.text)))
          )
            return {
              kind: "too-complex",
              reason: `command head ${required(s[0]).text} after ${i} \u2014 a $'\u2026' word the shell decodes before looking the command up`,
              differential: !0,
            };
          {
            i = s.length > 0 ? He(required(s[0]).text) : "";
            s = s.slice(1);
          }
        }
        let a = o || He(t.text) !== t.text || wt.test(t.text);
        if (!u && a && wt.test(i)) {
          let f = i === "integer" || i === "float",
            g = {
              ...e,
              children: [t, ...(f ? [{ ...t, text: "-i" }] : []), ...s],
            },
            _ = s
              .map((d) => M(d.text))
              .filter((d) => /^[-+]/.test(d))
              .join(""),
            h =
              f ||
              (/^(?:declare|typeset|local|private)$/.test(i) && Yn.test(_)) ||
              (/^(?:export|readonly)$/.test(i) && Xn.test(_)),
            p = s.filter((d) => !/^[-+]/.test(M(d.text))),
            c = /[fF]/.test(_),
            x =
              (h && !se(g)) ||
              s.some(
                (d) => d.type === "ansi_c_string" && /^\$'[-+]/.test(d.text),
              );
          if (/^(?:declare|typeset|local|integer|float|private)$/.test(i))
            x ||= p.some((d) => !ve(d, c));
          else
            x ||= p.some((d) => {
              if (d.type === "ansi_c_string") return !0;
              let m = ne(d.text);
              return (
                /[\\'"]/.test(m.replace(/^['"]/, "").replace(/['"]$/, "")) ||
                (i !== "readonly" && m.includes("[")) ||
                /^['"]?\$/.test(m) ||
                ((d.type === "word" ||
                  d.type === "concatenation" ||
                  d.type === "raw_string" ||
                  (d.type === "string" && ne(d.text) !== d.text)) &&
                  !St(d.text, c, i === "readonly"))
              );
            });
          if (x)
            return {
              kind: "too-complex",
              reason: `${i} spelled '${o ? `${t.text} \u2026` : t.text}' with an operand the shell would evaluate \u2014 the parser did not read this as a declaration`,
              differential: !0,
            };
        }
      }
    }
    for (let t of e.children) {
      if (!t) continue;
      let n = Gt(t);
      if (n) return n;
    }
    return null;
  }
  var jn = /^(?:builtin|command|exec|time|coproc|noglob|nocorrect|-)$/,
    wt =
      /^(?:declare|typeset|local|export|readonly|unset|integer|float|private)$/,
    at = /^[-+].*[nialuAEFLRZ]/,
    Yn = /[nialuAEFLRZ]/,
    Kn = /^[-+].*[aAiluEFLRZ]/,
    Xn = /[aAiluEFLRZ]/,
    Ue = { assigning: /^[-+][rtx]+$/, listing: /^(?:-[fgprtxU]+|\+[grtx]+)$/ },
    Qn = new Map<string, { assigning?: RegExp; listing: RegExp }>([
      ["declare", Ue],
      ["typeset", Ue],
      ["local", { assigning: Ue.assigning, listing: /^-[fprtx]+$/ }],
      ["export", { listing: /^-[aAfnp]+$/ }],
      ["readonly", { listing: /^-[aAfpx]+$/ }],
    ]);
  function Vt(e: string, t: string[]): string | null {
    let n = Qn.get(e),
      r = new Set(),
      i = e === "readonly",
      s = !1,
      o;
    for (let u of t)
      if (!/^[-+]/.test(u)) {
        if (o !== void 0 && u.includes("="))
          return `${e} ${o} with an assignment \u2014 not every supported bash and zsh assigns under that option, so the value cannot be statically verified`;
        let a = u.replace(/\+?=.*/s, "");
        if (i && u.includes("=") && r.has(a))
          return `${e} names '${eB(a)}' twice \u2014 the first makes it read-only, so bash does not carry out the second`;
        {
          r.add(a);
          s = !0;
        }
      } else if (s)
        return `${e} word '${eB(u)}' comes after the options \u2014 the shell reads it as a name, which it cannot be, and bash and zsh go on from that error differently`;
      else if (u === "--") s = !0;
      else if (n?.assigning?.test(u)) i ||= /^-.*r/.test(u);
      else if (n?.listing.test(u)) o ??= u;
      else
        return `${e} option '${eB(u)}' is not one bash and zsh are both known to accept \u2014 a shell that rejects it assigns nothing, so the names it declares cannot be statically verified`;
    return null;
  }
  function qt(e: string, t: string[]): string | null {
    let n = t.filter((r) => !/^[-+]/.test(r));
    if (e === "local" && n.some((r) => r.includes("=")))
      return "'local' outside a function \u2014 bash refuses that and assigns nothing, so the value cannot be statically verified";
    if ((e === "export" || e === "readonly") && n.length > 0 && t.some(Fe))
      return `'${e}' gives a name the array attribute \u2014 zsh empties a value it held and bash keeps it, so it cannot be statically verified`;
    return null;
  }
  var ae = /^[A-Za-z_][A-Za-z0-9_]*$/,
    $e = /^[A-Za-z_][\w.:-]*$/;
  function St(e: string, t: boolean, n = false): boolean {
    let r = ne(e),
      i = e[0];
    if (i === "'" || i === '"') {
      if (((r = r.slice(1)), r.endsWith(i))) r = r.slice(0, -1);
    } else if (/^\\[A-Za-z_]/.test(r)) r = r.slice(1);
    if (n && (i === "'" || i === '"')) {
      let s = e.indexOf("["),
        o = e.indexOf(i, 1);
      if (s > 0 && o > s) r = r.replace(/\[[\s\S]*$/, "");
    }
    return ((r = r.replace(/\+$/, "")), ae.test(r) || (t && $e.test(r)));
  }
  function Pe(e: Node): boolean {
    return (
      e.type === "ansi_c_string" ||
      e.children.some((t) => t !== void 0 && Pe(t))
    );
  }
  function He(e: string): string {
    return e.replace(/\$(['"])/g, "$1").replace(/["'\\]/g, "");
  }
  var Jn = new Set([
      "command_substitution",
      "process_substitution",
      "arithmetic_expansion",
      "expansion",
      "simple_expansion",
    ]),
    Xe = "$_";
  function er(e: Node): string {
    let t: [number, number][] = [],
      n = (o: Node): void => {
        for (let u of o.children) {
          if (!u) continue;
          if (Jn.has(u.type))
            t.push([u.startIndex - e.startIndex, u.endIndex - e.startIndex]);
          else n(u);
        }
      };
    if ((n(e), t.length === 0)) return e.text;
    t.sort((o, u) => o[0] - u[0]);
    let r = Buffer.from(e.text, "utf8"),
      i = "",
      s = 0;
    for (let [o, u] of t) {
      if (o < s || u > r.length) return e.text;
      {
        i += r.subarray(s, o).toString("utf8") + Xe;
        s = u;
      }
    }
    return i + r.subarray(s).toString("utf8");
  }
  function jt(e: Node): boolean {
    if (
      e.type === "expansion" &&
      e.text.replace(/\$\(\(?|[<>]\(/g, "").includes("(")
    )
      return !0;
    return e.children.some((t) => t !== void 0 && jt(t));
  }
  function ve(e: Node, t: boolean): boolean {
    if (e.type === "number" || /^\d+$/.test(e.text)) return !0;
    let n = er(e);
    if (e.type !== "raw_string" && e.type !== "string" && Te.test(Ft(n)))
      return !1;
    let r = /^['"]/.test(n) ? n.slice(1) : n,
      i = r.indexOf("="),
      s = (i < 0 ? r : r.slice(0, i)).replace(/\+$/, "");
    if (!(t ? /^[A-Za-z_][\w.:-]*['"]?$/ : /^[A-Za-z_]\w*['"]?$/).test(s))
      return !1;
    if (i < 0) return !0;
    if (
      e.children.find(
        (f, g) => f !== void 0 && g >= 2 && f.type !== "=" && f.type !== "+=",
      )?.type === "array"
    )
      return !0;
    if (Pe(e) || /\$'./.test(n)) return !1;
    if (jt(e)) return !1;
    let a = r.slice(i + 1);
    for (;;)
      if (/^[\\'"]/.test(a)) a = a.slice(1);
      else if (/^\$['"]/.test(a)) a = a.slice(2);
      else if (a.startsWith(Xe)) a = a.slice(Xe.length);
      else break;
    return !a.startsWith("(");
  }
  function ne(e: string): string {
    let t = 0,
      n = null,
      r = e[0] === "'" || e[0] === '"' ? e[0] : null;
    for (let i = r === null ? 0 : 1; i < e.length; i += 1) {
      let s = e[i];
      if (n !== null) {
        if (s === n) n = null;
      } else if ((s === "'" || s === '"') && s !== r) n = s;
      else if (s === "[") t += 1;
      else if (s === "]" && t > 0) t -= 1;
      else if (s === "=" && t === 0) return e.slice(0, i);
    }
    return e;
  }
  function Yt(e: Node): boolean {
    return e.children.some(
      (t) => t !== void 0 && (t.type === "comment" || Yt(t)),
    );
  }
  function tr(e: Buffer, t: number, n: number): boolean {
    let r = t;
    while (r < n) {
      let i = e[r];
      if (i === 32 || i === 9) r += 1;
      else if (i === 92 && e[r + 1] === 10) r += 2;
      else return !1;
    }
    return !0;
  }
  function se(e: Node): boolean {
    let t = e.children
        .map((i) => (i === void 0 ? "" : M(i.text)))
        .filter((i) => /^[-+]/.test(i))
        .join(""),
      r = /[iEF]/.test(t)
        ? /^[A-Za-z_][\w.-]*=(?:(['"]?)[0-9+\-*/% ().]*\1|\([0-9+\-*/% ().\s]*\))$/
        : /^[A-Za-z_][\w.-]*(?:\+?=(?:(['"]?)[\w./ -]*\1|\([\w\s./-]*\)))?$/;
    return e.children.every((i, s) => {
      if (!i || s === 0 || /^[-+]/.test(M(i.text))) return !0;
      return r.test(i.text);
    });
  }
  function M(e: string): string {
    let t = /^\$?(['"])([-+][^'"]*)\1$/.exec(e);
    if (t) return required(t[2]);
    return /^\\[-+]/.test(e) ? e.slice(1) : e;
  }
  var Kt = new Set(["for_statement", "while_statement"]),
    nr = 5;
  function Et(e: Node): boolean {
    return Kt.has(e.type) && cp();
  }
  function rr(e: Node): Result {
    let t = $5r(e);
    if (t) return t;
    let n: Command[] = [],
      r = new Map<string, string>(),
      i: string[] = [],
      s = I(e, n, r, i, !1, !0);
    if (s) return s;
    let o = [...Kt].some((a) => Ce(e, a)),
      u = o ? void 0 : n.at(-1);
    for (let a of v ? [] : n) {
      let [f = "", ...g] = a.argv,
        _ = _n(f, g) ?? (a === u ? null : qt(f, g));
      if (_ !== null)
        return {
          kind: "too-complex",
          reason: _,
          divergentShape: !0,
          ...(a.argvUnquotedGlob === void 0 && {
            nodeType: "declaration_command",
          }),
        };
    }
    return { kind: "simple", commands: n, bareAssignmentNames: i, hasLoop: o };
  }
  function sr(e: Node, t: Node, n: Node): boolean {
    return !Buffer.from(e.text, "utf8")
      .subarray(t.endIndex - e.startIndex, n.startIndex - e.startIndex)
      .toString("utf8")
      .replace(/\\\r?\n/g, "").includes(`
`);
  }
  var ir = new Set([
      "command",
      "variable_assignment",
      "variable_assignments",
      "list",
      "pipeline",
      "redirected_statement",
      "negated_command",
      "declaration_command",
      "unset_command",
      "test_command",
      "subshell",
      "compound_statement",
      "if_statement",
      "while_statement",
      "for_statement",
      "case_statement",
      "function_definition",
      "ERROR",
    ]),
    or = new Set([
      "negated_command",
      "if_statement",
      "while_statement",
      "for_statement",
      "subshell",
    ]);
  function $5r(e: Node): Refusal | null {
    let t = null;
    for (let n of e.children) {
      if (!n) continue;
      if (ir.has(n.type)) {
        if (t !== null) {
          let i = n;
          while (ot.has(i.type)) {
            let s = i.children.find((o) => o != null);
            if (!s) break;
            i = s;
          }
          if (or.has(i.type) && sr(e, t, i))
            return {
              kind: "too-complex",
              reason:
                i.type === "subshell"
                  ? "`(\u2026)` group directly follows a statement or word on the same line \u2014 bash rejects the line, but zsh reads the glued `(\u2026)` as a glob-group word and expands what follows it"
                  : "statement directly follows another statement on the same line \u2014 bash reads the text as one command (`!` and shell keywords are plain words after an assignment), not two statements",
              differential: !0,
            };
        }
        t = n;
      } else t = null;
      let r = $5r(n);
      if (r) return r;
    }
    return null;
  }
  function I(
    e: Node,
    t: Command[],
    n: Scope,
    r: string[],
    i = false,
    s = false,
  ): Refusal | null {
    if (e.type === "command") {
      let o = _r(e, [], t, n, r);
      if (o.kind !== "simple") return o;
      if (s) for (let u of o.commands) u.andChainOperand = !0;
      return (t.push(...o.commands), null);
    }
    if (e.type === "redirected_statement") return ur(e, t, n, r, i, s);
    if (e.type === "comment") return null;
    if (ot.has(e.type)) {
      let o = e.type === "pipeline",
        u = t.length,
        a = !1;
      if (!o) {
        for (let p of e.children)
          if (p && (p.type === "||" || p.type === "&")) {
            a = !0;
            break;
          }
      }
      let f = a ? new Map(n) : null,
        g = o ? new Map(n) : n,
        _: Set<string> | null = null,
        h =
          s &&
          (e.type === "program"
            ? U(e.children, (p) => p && p.type !== "comment") === 1
            : e.type === "list" &&
              !e.children.some((p) => p && he.has(p.type) && p.type !== "&&"));
      for (let p of e.children) {
        if (!p) continue;
        if (he.has(p.type)) {
          if (
            p.type === "||" ||
            p.type === "|" ||
            p.type === "|&" ||
            p.type === "&"
          )
            if (p.type === "||") {
              if (((_ ??= new Set<string>()), Q === 0))
                for (let d of n.keys()) _.add(d);
              let x = f ?? n;
              g = new Map(x);
              for (let [d, m] of n) if (x.get(d) !== m) T(g, d);
              for (let d of x.keys()) if (!n.has(d)) T(g, d);
            } else g = new Map(f ?? n);
          else if (_ !== null) {
            for (let x of _) T(n, x);
            {
              _ = null;
              g = n;
            }
          }
          continue;
        }
        let c = I(p, t, g, r, e.type === "program", h);
        if (c) return c;
        if (_ !== null && Q > 0) te(n, g);
      }
      if (_ !== null) for (let p of _) T(n, p);
      if (o) {
        if ((te(n, g), t.length === u)) re(t, e);
      }
      return null;
    }
    if (e.type === "negated_command") {
      let o = t.length;
      for (let u of e.children) {
        if (!u) continue;
        if (u.type === "!") continue;
        let a = I(u, t, n, r);
        if (a) return a;
      }
      if (t.length === o) re(t, e);
      return null;
    }
    if (e.type === "declaration_command") {
      let o = t.length,
        u = e.children.some((m) => m !== null && oe(m)),
        a = (m: string, b: string): Refusal | null => {
          if (!u) return null;
          let y = n.get(m),
            w = o === 0 && !Ys(b),
            k = y !== void 0 && !Ys(y);
          return w || k
            ? xe(
                `'${m}' is assigned by a declaration carrying an expansion that can fail at runtime, which assigns nothing when it fails \u2014 its value cannot be statically verified`,
              )
            : null;
        },
        f = H,
        g = new Map(n),
        _ = !1,
        h = !1,
        p = !1,
        c = [],
        x = -1;
      for (let m of e.children) {
        if (!m) continue;
        let b = m.startIndex === x;
        switch (((x = m.endIndex), m.type)) {
          case "export":
          case "local":
          case "readonly":
          case "declare":
          case "typeset":
            c.push(m.text);
            break;
          case "word":
          case "number":
          case "raw_string":
          case "string":
          case "concatenation": {
            if (b)
              return {
                kind: "too-complex",
                reason: `${c[0] ?? "declaration"} operand is split across adjacent quoted segments \u2014 the shell joins them into one word the analyzer cannot verify`,
                differential: !0,
              };
            let y = z(m, t, g, r);
            if (typeof y !== "string") return y;
            if (/^[+-].*m/.test(y))
              return {
                kind: "too-complex",
                reason: `${c[0]} flag ${y} \u2014 zsh -m/+m pattern-assigns every matching variable; cannot statically model target set`,
                nodeType: "declaration_command",
              };
            if (
              c[0] === "declare" ||
              c[0] === "typeset" ||
              c[0] === "local" ||
              c[0] === "readonly"
            ) {
              if (/^[+-].*f/.test(y)) _ = !0;
              if (/^[+-].*[uU]/.test(y)) h = !0;
              if (_ && h)
                return {
                  kind: "too-complex",
                  reason: `${c[0]} with both -f and -u/-U flags \u2014 zsh marks a function for autoload (synonym of 'autoload'), creating a function from file contents at call time`,
                  nodeType: "declaration_command",
                };
            }
            if (
              (c[0] === "declare" || c[0] === "typeset" || c[0] === "local") &&
              at.test(y)
            )
              return {
                kind: "too-complex",
                reason: `declare flag ${y} changes assignment semantics (nameref/integer/float/array/width-truncation/case-conversion)`,
                ...(se(e)
                  ? { nodeType: "declaration_command" }
                  : { differential: !0 }),
              };
            if ((c[0] === "export" || c[0] === "readonly") && Fe(y) && !se(e))
              return {
                kind: "too-complex",
                reason: `${c[0]} flag ${y} with an operand bash would evaluate as a compound array assignment`,
                differential: !0,
              };
            if (
              (c[0] === "export" || c[0] === "readonly") &&
              /^[+-].*[iluEFLRZ]/.test(y)
            )
              return {
                kind: "too-complex",
                reason: `${c[0]} flag ${y} \u2014 zsh bin_typeset mathevals (-i/-E/-F), width-truncates (-L/-R/-Z), or case-converts (-l/-u) the assigned value`,
                ...(se(e)
                  ? { nodeType: "declaration_command" }
                  : { differential: !0 }),
              };
            if (/^[+-].*T/.test(y))
              return {
                kind: "too-complex",
                reason: `${c[0]} -T creates a user-defined zsh tied pair \u2014 tracked literals for its operands are unreliable`,
                nodeType: "declaration_command",
              };
            if (
              (c[0] === "declare" ||
                c[0] === "typeset" ||
                c[0] === "local" ||
                c[0] === "export") &&
              y[0] !== "-" &&
              /^[^=]*\[/.test(y)
            )
              return {
                kind: "too-complex",
                reason: `${c[0]} positional '${y}' contains array subscript \u2014 zsh/bash evaluate $(cmd) in subscripts`,
                differential: !0,
              };
            if (
              (c[0] === "declare" || c[0] === "typeset" || c[0] === "local") &&
              !/^[-+]/.test(y) &&
              !ve(
                m,
                c.some((w) => /^[-+][A-Za-z]*[fF]/.test(w)),
              )
            )
              return {
                kind: "too-complex",
                reason: `${c[0]} operand '${m.text}' is not a plain NAME with an inert value \u2014 the shell may re-parse it as a subscript, an expanded name or a compound assignment`,
                differential: !0,
              };
            if (y[0] !== "-") {
              let w = y.indexOf("=");
              if (w > 0) {
                let k = y.slice(0, w);
                if (/^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(k)) {
                  let A = k.endsWith("+");
                  p ||= A;
                  let R = A ? k.slice(0, -1) : k,
                    P = a(R, y.slice(w + 1));
                  if (P) return P;
                  {
                    Ve(
                      n,
                      { name: R, value: y.slice(w + 1), isAppend: A },
                      o > 0,
                    );
                    r.push(R);
                  }
                }
              }
            }
            c.push(y);
            break;
          }
          case "variable_assignment": {
            if (
              (c[0] === "declare" || c[0] === "typeset" || c[0] === "local") &&
              !ve(
                m,
                c.some((k) => /^[-+][A-Za-z]*[fF]/.test(k)),
              )
            )
              return {
                kind: "too-complex",
                reason: `${c[0]} operand '${m.text}' is not a plain NAME with an inert value \u2014 the shell may re-parse it as a subscript, an expanded name or a compound assignment`,
                differential: !0,
              };
            let y = rt(m, t, g, r);
            if ("kind" in y) return y;
            let w = a(y.name, y.value);
            if (w) return w;
            {
              Ve(n, y, o > 0);
              p ||= y.isAppend === true;
              r.push(y.name);
              c.push(`${y.name}=${y.value}`);
            }
            break;
          }
          case "variable_name": {
            let y = m.text;
            if (
              (c[0] === "declare" ||
                c[0] === "typeset" ||
                c[0] === "local" ||
                c[0] === "export") &&
              y[0] !== "-" &&
              /^[^=]*\[/.test(y)
            )
              return {
                kind: "too-complex",
                reason: `${c[0]} positional '${y}' contains array subscript \u2014 backslash-escaped form de-escapes to [$(cmd)] at runtime`,
                differential: !0,
              };
            let w = c.some((k) => /^-[A-Za-z]*[fF]/.test(k));
            if (!ae.test(y) && !(w && $e.test(y)))
              return {
                kind: "too-complex",
                reason: `${c[0]} operand '${y}' is not a plain variable name \u2014 the shell may turn it into an assignment the parser did not see`,
                differential: !0,
              };
            c.push(y);
            break;
          }
          case "ansi_c_string":
            return {
              kind: "too-complex",
              reason: `${c[0] ?? "declaration"} operand ${m.text} \u2014 a $'\u2026' word the shell decodes, which may carry a subscript the parser cannot read`,
              differential: !0,
            };
          default:
            return S(m);
        }
      }
      let d = Vt(c[0] ?? "", c.slice(1));
      if (d !== null && !v)
        return {
          kind: "too-complex",
          reason: d,
          divergentShape: !0,
          ...(se(e) && { nodeType: "declaration_command" }),
        };
      return (
        t.push({
          argv: c,
          envVars: [],
          redirects: [],
          text: e.text,
          hasUnquotedGlob: F(e.text),
          carveOutMayDesyncQuoteScan: H !== f,
          ...(p && { operandAppends: p }),
        }),
        null
      );
    }
    if (e.type === "variable_assignment") {
      let o = t.length,
        u = rt(e, t, n, r);
      if ("kind" in u) return u;
      if (qQn(u.name))
        return {
          kind: "too-complex",
          reason: `${u.name} assignment alters command lookup/execution for subsequent commands`,
          nodeType: "variable_assignment",
        };
      if (Rn(u.name, u.value))
        return {
          kind: "too-complex",
          reason: `${u.name} has integer attribute \u2014 assignment arith-evals RHS, which can execute subscript command substitution or abort/diverge at runtime`,
          nodeType: "variable_assignment",
        };
      if (
        (Ve(n, u, o > 0),
        r.push(u.name),
        t.length === o && (oe(e) || bt.has(u.name)))
      )
        re(t, e);
      return null;
    }
    if (e.type === "for_statement") {
      if (Et(e)) return S(e);
      let o = Nt(e, t, n, r);
      if ("kind" in o) return o;
      let u = null,
        a = null,
        f = t.length,
        g = !1;
      for (let p of e.children) {
        if (!p) continue;
        if (p.type === "variable_name") u = p.text;
        else if (p.type === "do_group") a = p;
        else if (p.type === "select")
          return {
            kind: "too-complex",
            reason:
              "select statement reads stdin into $REPLY; cannot statically model",
            nodeType: "for_statement",
          };
        else if (p.type === "for" || p.type === "in" || p.type === ";")
          continue;
        else if (p.type === "command_substitution") {
          let c = ut(p, t, n, r);
          if (c) return c;
        } else {
          let c = z(p, t, n, r);
          if (typeof c !== "string") return c;
          if (oe(p)) g = !0;
          else if ((F(p.text) || Ie(p)) && v4a()) g = !0;
        }
      }
      if (u === null || a === null) return S(e);
      if (
        u === "PS4" ||
        u === "IFS" ||
        bt.has(u) ||
        u === "BASH_ARGV0" ||
        qQn(u) ||
        dt.has(u) ||
        qe.has(u) ||
        hn.has(u)
      )
        return {
          kind: "too-complex",
          reason: `${u} as loop variable bypasses assignment validation`,
          nodeType: "for_statement",
        };
      let _ = n.get(u);
      if (_ !== void 0 && !Ys(_))
        return {
          kind: "too-complex",
          reason: `for-loop variable '${u}' would overwrite tracked literal ${JSON.stringify(_.slice(0, 40))}; post-loop value cannot be statically determined`,
          nodeType: "for_statement",
        };
      {
        n.delete(u);
        r.push(u);
      }
      let h = new Map(n);
      Ge(h, a);
      for (let p of o) T(h, p);
      h.delete(u);
      for (let p of a.children) {
        if (!p) continue;
        if (p.type === "do" || p.type === "done" || p.type === ";") continue;
        let c = I(p, t, h, r);
        if (c) return c;
      }
      if ((te(n, h), g && t.length === f)) re(t, e);
      return null;
    }
    if (e.type === "if_statement" || e.type === "while_statement") {
      if (Et(e)) return S(e);
      let o = null,
        u = null;
      if (e.type === "while_statement") {
        let f = Nt(e, t, n, r);
        if ("kind" in f) return f;
        {
          o = new Set(n.keys());
          u = new Map(n);
          Ge(n, e);
        }
        for (let g of f) {
          T(n, g);
          T(u, g);
        }
      }
      let a = !1;
      for (let f of e.children) {
        if (!f) continue;
        if (
          f.type === "if" ||
          f.type === "fi" ||
          f.type === "else" ||
          f.type === "elif" ||
          f.type === "while" ||
          f.type === "until" ||
          f.type === ";"
        )
          continue;
        if (f.type === "then") {
          a = !0;
          continue;
        }
        if (f.type === "do_group") {
          let p = new Map(n);
          Ge(p, f);
          for (let c of f.children) {
            if (!c) continue;
            if (c.type === "do" || c.type === "done" || c.type === ";")
              continue;
            let x = I(c, t, p, r);
            if (x) return x;
          }
          te(n, p);
          continue;
        }
        if (f.type === "elif_clause" || f.type === "else_clause") {
          let p = new Map(n);
          for (let c of f.children) {
            if (!c) continue;
            if (
              c.type === "elif" ||
              c.type === "else" ||
              c.type === "then" ||
              c.type === ";"
            )
              continue;
            let x = I(c, t, p, r);
            if (x) return x;
          }
          te(n, p);
          continue;
        }
        let g = new Map(n),
          _ = t.length,
          h = I(f, t, g, r);
        if (h) return h;
        if (!a) {
          for (let [p, c] of g) {
            let x = (u ?? n).get(p);
            if (x !== void 0 && !Ys(x) && c !== x)
              return {
                kind: "too-complex",
                reason: `'${p}' was tracked as literal '${x}' but condition may modify it (||/pipeline/unset/&&-short-circuit) \u2014 cannot prove downstream value`,
                nodeType: e.type,
              };
            if (x?.includes(C) === !0 && c !== x) {
              n.set(p, x);
              continue;
            }
            n.set(p, c);
          }
          for (let p of n.keys())
            if (!g.has(p)) {
              let c = (u ?? n).get(p);
              if (c !== void 0 && !Ys(c))
                return {
                  kind: "too-complex",
                  reason: `'${p}' was tracked as literal '${c}' but condition may unset it (&&-short-circuit) \u2014 cannot prove downstream value`,
                  nodeType: e.type,
                };
              T(n, p);
            }
          for (let p = _; p < t.length; p++) {
            let c = t[p];
            if (c?.argv[0] === "read" && !GQo()) {
              for (let d of c.argv.slice(1))
                if (!d.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(d)) {
                  let m = n.get(d);
                  if (m !== void 0 && !Ys(m))
                    return {
                      kind: "too-complex",
                      reason: `'read ${d}' in condition may not execute (||/pipeline/subshell); cannot prove it overwrites tracked literal '${m}'`,
                      nodeType: e.type,
                    };
                  T(n, d);
                }
              let x = n.get("REPLY");
              if (x !== void 0 && !Ys(x))
                return {
                  kind: "too-complex",
                  reason: `'read' in condition may write stdin to REPLY; cannot prove it overwrites tracked literal '${x}'`,
                  nodeType: e.type,
                };
              T(n, "REPLY");
            }
          }
        } else te(n, g);
      }
      if (o !== null) {
        for (let f of Array.from(n.keys())) if (!o.has(f)) n.delete(f);
      }
      return null;
    }
    if (e.type === "subshell") {
      let o = new Map(n),
        u = t.length,
        a = !1;
      for (let f of e.children) {
        if (!f) continue;
        if (f.type === "(" || f.type === ")") continue;
        if (f.type !== "comment") a = !0;
        let g = I(f, t, o, r);
        if (g) return g;
      }
      if (a && t.length === u) re(t, e);
      return null;
    }
    if (e.type === "test_command") {
      let o = e.children.some((g) => g?.type === "[["),
        u = Qt(e, o);
      if (u) return u;
      let a = ["[["],
        f = H;
      for (let g of e.children) {
        if (!g) continue;
        if (
          g.type === "[[" ||
          g.type === "]]" ||
          g.type === "[" ||
          g.type === "]"
        )
          continue;
        let _ = Jt(g, a, t, n, r, o);
        if (_) return _;
      }
      return (
        t.push({
          argv: a,
          envVars: [],
          redirects: [],
          text: e.text,
          hasUnquotedGlob: F(e.text),
          carveOutMayDesyncQuoteScan: H !== f,
        }),
        null
      );
    }
    if (e.type === "unset_command") {
      let o = [],
        u = H,
        a = t.length > 0,
        f = !1,
        g = !1,
        _ = !1;
      for (let h of e.children) {
        if (!h) continue;
        switch (h.type) {
          case "unset":
            {
              o.push(h.text);
              _ = h.text === "unsetenv";
            }
            break;
          case "variable_name":
            if (!ae.test(h.text) && !(f && $e.test(h.text)))
              return {
                kind: "too-complex",
                reason: `${o[0] ?? "unset"} operand '${h.text}' is not a plain variable name \u2014 the shell may expand or evaluate it`,
                differential: !0,
              };
            if ((o.push(h.text), (g = !0), f || _)) {
              let p = Qe(
                n.get(h.text),
                `'${h.text}' no longer has a statically known value at this unset \u2014 cannot verify what the command leaves behind`,
                "unset_command",
              );
              if (p !== null) return p;
              break;
            }
            if (epe(h.text))
              return {
                kind: "too-complex",
                reason: `'unset' targets shell variable ${h.text} (exec-influencing / integer-attr / IFS / PS4)`,
                nodeType: "unset_command",
              };
            Je(n, h.text, a);
            break;
          case "word": {
            let p = z(h, t, n, r);
            if (typeof p !== "string") return p;
            if (p.startsWith("-")) {
              if (g) return S(h);
              if (p !== "-f" && p !== "-v") return S(h);
              if (p === "-f") f = !0;
              o.push(p);
              break;
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) return S(h);
            if ((o.push(p), (g = !0), f || _)) {
              let c = Qe(
                n.get(p),
                `'${p}' no longer has a statically known value at this unset \u2014 cannot verify what the command leaves behind`,
                "unset_command",
              );
              if (c !== null) return c;
              break;
            }
            if (epe(p))
              return {
                kind: "too-complex",
                reason: `'unset' targets shell variable ${p} (exec-influencing / integer-attr / IFS / PS4)`,
                nodeType: "unset_command",
              };
            Je(n, p, a);
            break;
          }
          case "ansi_c_string":
          case "raw_string":
          case "string":
          case "concatenation":
            if (/\[/.test(h.text) || h.type === "ansi_c_string")
              return {
                kind: "too-complex",
                reason: `${o[0] ?? "unset"} operand ${h.text} carries a subscript \u2014 bash and zsh evaluate $(cmd) inside it`,
                differential: !0,
              };
            return S(h);
          default:
            return S(h);
        }
      }
      return (
        t.push({
          argv: o,
          envVars: [],
          redirects: [],
          text: e.text,
          hasUnquotedGlob: F(e.text),
          carveOutMayDesyncQuoteScan: H !== u,
        }),
        null
      );
    }
    return S(e);
  }
  var Xt = new Set([
    "unary_expression",
    "binary_expression",
    "negated_expression",
    "parenthesized_expression",
  ]);
  function At(e: string, t: boolean): boolean {
    let n = 0;
    while (n < e.length) {
      let r = e[n];
      if (r === " " || r === "\t") {
        n++;
        continue;
      }
      if (
        r === "\\" &&
        e[n + 1] ===
          `
`
      ) {
        n += 2;
        continue;
      }
      if (
        t &&
        r ===
          `
`
      ) {
        n++;
        continue;
      }
      if (t && r === "#") {
        n++;
        while (
          n < e.length &&
          e[n] !==
            `
`
        )
          n++;
        continue;
      }
      return !1;
    }
    return !0;
  }
  function Qt(e: Node, t: boolean): Refusal | null {
    let n = Buffer.from(e.text, "utf8"),
      r = e.startIndex;
    for (let i of e.children) {
      if (!i) continue;
      if (i.startIndex > r) {
        let s = n
          .subarray(r - e.startIndex, i.startIndex - e.startIndex)
          .toString("utf8");
        if (!At(s, t))
          return {
            kind: "too-complex",
            reason:
              "Test command has unparsed bytes between children \u2014 parser dropped content that shell will see",
          };
      }
      if (((r = Math.max(r, i.endIndex)), Xt.has(i.type))) {
        let s = Qt(i, t);
        if (s) return s;
      }
    }
    if (r < e.endIndex) {
      let i = n.subarray(r - e.startIndex).toString("utf8");
      if (!At(i, t))
        return {
          kind: "too-complex",
          reason:
            "Test command has unparsed bytes after its last child \u2014 parser dropped content that shell will see",
        };
    }
    return null;
  }
  function ar(e: string): boolean {
    let t = !1,
      n = !1,
      r = !1,
      i = 0,
      s;
    for (let o = 0; o < e.length; o++) {
      let u = e[o];
      if (!t && u === "\\") {
        o++;
        continue;
      }
      if (!n && u === "'") {
        t = !t;
        continue;
      }
      if (!t && u === '"') {
        n = !n;
        continue;
      }
      if (!t && !n) {
        if (u === "=" && e[o + 1] === "(" && (r || o === 0 || s === "|"))
          return !0;
        if (u === "(") i++;
        else if (u === ")") i = Math.max(0, i - 1);
        else if (i === 0 && (u === "|" || u === "&") && s === u) r = !0;
        s = u;
      }
    }
    return !1;
  }
  function Ze(e: string): boolean {
    let t = e.replace(
        /\[(?::[a-zA-Z]+:|=[A-Za-z0-9-]*=|\.[A-Za-z0-9-]*\.|[!^]?)\]\](?!\])/g,
        "\x00",
      ),
      n = /[A-Za-z0-9_]/,
      r = t.indexOf("]]");
    while (r !== -1) {
      let i = r > 0 ? required(t[r - 1]) : "",
        s = r + 2 < t.length ? required(t[r + 2]) : "";
      if (!(n.test(i) && n.test(s))) return !0;
      r = t.indexOf("]]", r + 1);
    }
    return !1;
  }
  var lr = /^([\w\u0080-\uffff]*|[-?*@!#])(\[|:[a-zA-Z&])/,
    cr = /^([\w\u0080-\uffff]*|[-?*@!#$])(\[|:[a-zA-Z&])/;
  function Jt(
    e: Node,
    t: string[],
    n: Command[],
    r: Scope,
    i: string[],
    s: boolean,
  ): Refusal | null {
    if (Xt.has(e.type)) {
      for (let o = 0; o < e.children.length; o++) {
        let u = e.children[o];
        if (!u) continue;
        if (
          (u.type === "simple_expansion" || u.type === "expansion") &&
          (e.children[o + 1]?.text.startsWith("[") ||
            /^:[a-zA-Z&]/.test(e.children[o + 1]?.text ?? "") ||
            (u.children.some((f) => f?.type === "special_variable_name") &&
              cr.test(e.children[o + 1]?.text ?? "")))
        )
          return {
            kind: "too-complex",
            reason:
              "zsh $name[expr] / $name:mod in [[ ]] operand \u2014 recursive eval",
            differential: !0,
          };
        if (s && u.type === "!" && e.children[o + 1]?.startIndex === u.endIndex)
          return {
            kind: "too-complex",
            reason: "zsh reads !( in [[ ]] as part of a word",
            differential: !0,
          };
        let a = Jt(u, t, n, r, i, s);
        if (a) return a;
      }
      return null;
    }
    switch (e.type) {
      case "test_operator":
      case "!":
      case "(":
      case ")":
      case "&&":
      case "||":
      case "==":
      case "=":
      case "!=":
      case "<":
      case ">":
      case "=~":
        return (t.push(e.text), null);
      case "regex":
      case "extglob_pattern":
        if (/\$([({[\w#?!*@$'"+~^=-]|[\u0080-\uffff])|`|[<>]\(/.test(e.text))
          return {
            kind: "too-complex",
            reason: `[[ ]] ${e.type === "extglob_pattern" ? "pattern" : e.type} contains expansion / command / process substitution`,
            differential: !0,
          };
        if (e.text.startsWith("=("))
          return {
            kind: "too-complex",
            reason: `[[ ]] ${e.type === "extglob_pattern" ? "pattern" : e.type} contains zsh =(CMD) process substitution`,
            differential: !0,
          };
        if (e.type === "regex" && ar(e.text))
          return {
            kind: "too-complex",
            reason: `[[ ]] ${e.type} contains zsh =(CMD) process substitution`,
            differential: !0,
          };
        if (e.type === "extglob_pattern") {
          let o = e.text,
            u = 0;
          while (u < o.length) {
            if (o[u] === "\\" && u + 1 < o.length) {
              u += 2;
              continue;
            }
            if (o[u] === "&")
              return {
                kind: "too-complex",
                reason:
                  "[[ ]] pattern contains unquoted & (zsh splits the word at & at any depth)",
                differential: !0,
              };
            u++;
          }
        }
        if (e.type === "regex") {
          let o = e.text,
            u = 0,
            a = 0;
          while (a < o.length) {
            let f = o[a];
            if (f === "\\" && a + 1 < o.length) {
              a += 2;
              continue;
            }
            if (u === 0 && f === "|" && o[a + 1] === f)
              return {
                kind: "too-complex",
                reason:
                  "[[ ]] regex contains glued || (zsh splits it as a cond operator)",
                differential: !0,
              };
            if (f === "&")
              return {
                kind: "too-complex",
                reason:
                  "[[ ]] regex contains unquoted & (zsh splits the word at & at any depth)",
                differential: !0,
              };
            if (f === '"' || f === "'") {
              let g = f;
              a++;
              while (a < o.length && o[a] !== g) {
                if (g === '"' && o[a] === "\\" && a + 1 < o.length) a++;
                a++;
              }
              if (a < o.length) a++;
              continue;
            }
            if (f === "(") u++;
            else if (f === ")") {
              if ((u--, u < 0))
                return {
                  kind: "too-complex",
                  reason:
                    "[[ ]] regex has unbalanced parentheses (parser desync)",
                  differential: !0,
                };
            }
            a++;
          }
          if (u !== 0)
            return {
              kind: "too-complex",
              reason: "[[ ]] regex has unbalanced parentheses (parser desync)",
              differential: !0,
            };
        }
        if (e.text.includes("&&"))
          return {
            kind: "too-complex",
            reason:
              "[[ ]] pattern leaf contains `&&` \u2014 shell cond-lexer divergence (zsh splits the word there)",
            differential: !0,
          };
        if (Ze(e.text))
          return {
            kind: "too-complex",
            reason:
              "[[ ]] pattern leaf contains a potential standalone `]]` closer \u2014 shell cond-lexer divergence (zsh may close the conditional early)",
            differential: !0,
          };
        return (t.push(e.text), null);
      case "test_rhs_missing":
        return {
          kind: "too-complex",
          reason:
            "Test command comparison is missing its right-hand side \u2014 parser dropped consumed bytes",
        };
      default: {
        let o = z(e, n, r, i);
        if (typeof o !== "string") {
          if (s && o.kind === "too-complex") {
            let { nodeType: _u, ...a } = o;
            return { ...a, differential: !0 };
          }
          return o;
        }
        if ((s && (Ze(o) || Ze(e.text))) || /]].*[;\n&|<>]/s.test(o))
          return {
            kind: "too-complex",
            reason: s
              ? "[[ ]] quoted operand contains `]]` closer or `]]`+separator bytes \u2014 possible parser quote-state desync"
              : "test command quoted operand contains `]]`+separator bytes \u2014 possible parser quote-state desync",
            differential: !0,
          };
        return (t.push(o), null);
      }
    }
  }
  function en(e: Node): Node | null {
    let t = null;
    for (let n of e.children) {
      if (!n || n.type === "!" || n.type === "comment" || he.has(n.type))
        continue;
      t = n;
    }
    if (!t) return null;
    if (t.type === "list" || t.type === "negated_command") return en(t);
    if (!zt.has(t.type) && !In.has(t.type)) return t;
    return null;
  }
  function T(e: Scope, t: string): void {
    if (e.get(t)?.includes(C)) return;
    e.set(t, O);
  }
  var me = `${C}\x00`;
  function ge(e: string): string {
    return v && e.startsWith(me) ? e.slice(me.length) : e;
  }
  function Qe(e: string | undefined, t: string, n: string): Refusal | null {
    if (e === void 0) return null;
    if (!Ys(ge(e))) return null;
    return !v && e.includes(C)
      ? { kind: "too-complex", reason: t, nodeType: n, divergentShape: !0 }
      : { kind: "too-complex", reason: t, nodeType: n };
  }
  function Je(e: Scope, t: string, n: boolean): void {
    if ((pe.add(t), n && v)) q = !0;
    e.set(t, !n ? "" : v ? me : C);
  }
  function tn(e: Scope, t: Scope): void {
    for (let [n, r] of e)
      if (t.get(n) !== r) {
        if (!v && W.get(n) === r) j = !0;
        {
          q ||= v;
          e.set(n, !v ? C : r.includes(C) ? r : me + r);
        }
      }
    for (let n of t.keys()) if (!e.has(n)) e.set(n, C);
  }
  function ur(
    e: Node,
    t: Command[],
    n: Scope,
    r: string[],
    i: boolean,
    s: boolean,
  ): Refusal | null {
    let o = [],
      u = null,
      a = [],
      f = [];
    for (let d of e.children) {
      if (!d) continue;
      if (d.type === "file_redirect") a.push(d);
      else if (d.type === "heredoc_redirect") f.push(d);
      else if (zt.has(d.type)) {
        if (d.type === "list" || d.type === "negated_command") {
          let m = en(d);
          if (m) return S(m);
        }
        u = d;
      } else return S(d);
    }
    if (!u) {
      for (let d of a) {
        let m = Ne(d, t, n, r);
        if ("kind" in m) return m;
        o.push(m);
      }
      for (let d of f) {
        let m = et(d, n);
        if (m) return m;
      }
      return (
        t.push({
          argv: [],
          envVars: [],
          redirects: o,
          text: e.text,
          hasUnquotedGlob: F(e.text),
        }),
        null
      );
    }
    let g = t.length,
      _ =
        ie && i && u.type === "command" && a.length === 0 && f.length === 1
          ? f[0]?.children.find((d) => d?.type === "pipeline")
          : void 0,
      h,
      p = !1;
    if (u.type === "list") {
      let d = u.children;
      if (d.length === 3 && d[0] && d[1]?.type === "&&" && d[2]) {
        let m = I(d[0], t, n, r, !1, s);
        if (m) return m;
        {
          h = new Map(n);
          p = !0;
        }
        let b = I(d[2], t, n, r, !1, s);
        if (b) return b;
      } else {
        let m = I(u, t, n, r, !1, s);
        if (m) return m;
        h = n;
      }
    } else if (ot.has(u.type)) {
      let d = I(u, t, n, r, !1, s);
      if (d) return d;
      h = n;
    } else {
      {
        h = new Map(n);
        p = !0;
      }
      let d = I(u, t, _ ? new Map(n) : n, r, !1, s && !_);
      if (d) return d;
    }
    if (p) tn(n, h);
    let c = t.length > g ? t.at(-1) : void 0,
      x = c?.envVars[0]?.name;
    if (x !== void 0 && a.some((d) => oe(d))) {
      let d = Se(x);
      if (d) return d;
    }
    for (let d of a) {
      let m = Ne(d, t, h, r);
      if ("kind" in m) return m;
      o.push(m);
    }
    if (c) {
      let d = dn(a, c, o, t, h, r);
      if (d) return d;
    }
    for (let d of f) {
      let m = et(d, h, _);
      if (m) return m;
    }
    if (_) {
      let d = I(_, t, n, r);
      if (d) return d;
    }
    if (f.length > 0)
      for (let d = g; d < t.length; d++) {
        let m = t[d];
        if (m) m.argvSourceLiteral = !1;
      }
    if (o.length > 0)
      if (t.length > g) {
        let d = t.at(-1);
        if (d) d.redirects.push(...o);
      } else
        t.push({
          argv: [],
          envVars: [],
          redirects: o,
          text: e.text,
          hasUnquotedGlob: F(e.text),
        });
    return null;
  }
  function nn(e: Node): Refusal | null {
    {
      let r = e.startIndex;
      for (let i of e.children) {
        if (!i) continue;
        if (i.startIndex > r) {
          let s = Buffer.from(e.text, "utf8")
            .subarray(r - e.startIndex, i.startIndex - e.startIndex)
            .toString("utf8");
          if (!/^(?:[ \t]|\\\n)*$/.test(s))
            return {
              kind: "too-complex",
              reason:
                "Redirect has unparsed bytes between children \u2014 parser dropped content that shell will see",
            };
        }
        r = i.endIndex;
      }
      if (r < e.endIndex) {
        let i = Buffer.from(e.text, "utf8")
          .subarray(r - e.startIndex)
          .toString("utf8");
        if (!/^(?:[ \t]|\\\n)*$/.test(i))
          return {
            kind: "too-complex",
            reason:
              "Redirect has unparsed trailing bytes \u2014 parser dropped content that shell will see",
          };
      }
    }
    let t = null,
      n = 0;
    for (let r of e.children) {
      if (!r) continue;
      if (r.type === "variable_name")
        return {
          kind: "too-complex",
          reason: `Redirect uses ${r.text} fd-variable assignment \u2014 modifies shell variable as side effect`,
        };
      if (r.type === "file_descriptor") continue;
      if (r.type === ">&-" || r.type === "<&-") {
        t = r.type;
        continue;
      }
      if (r.type in je) {
        t = r.type;
        continue;
      }
      if ((t === ">&" || t === "<&") && r.text.startsWith("-"))
        return {
          kind: "too-complex",
          reason:
            "Redirect target after >& or <& starts with - \u2014 bash treats the dash as close-fd and passes the rest to the command as a hidden argument",
        };
      if (t === ">&-" || t === "<&-")
        return {
          kind: "too-complex",
          reason:
            "Close-fd redirect is followed by a word \u2014 bash passes it to the command as a hidden argument",
        };
      {
        n++;
        t = null;
      }
    }
    if (n > 1)
      return {
        kind: "too-complex",
        reason:
          "Redirect has multiple targets \u2014 post-redirect args swallowed",
      };
    return null;
  }
  var rn = new Set([
      "heredoc_start",
      "heredoc_body",
      "<<",
      "<<-",
      "heredoc_end",
      "file_descriptor",
    ]),
    sn = new Set(["file_redirect", "pipeline"]),
    fr = new RegExp(String.raw`^\{(?:\w|[^\x00-\x7F])+(\[.*\])?\}$`, "su");
  function lt(e: string): string {
    let t = new RegExp(String.raw`^\{((?:\w|[^\x00-\x7F])+)`, "u").exec(e)?.[1];
    if (t === void 0) return "{\u2026}";
    let n = /^\w{1,64}$/.test(t) ? t : "\u2026";
    return e[t.length + 1] === "[" ? `{${n}[\u2026]}` : `{${n}}`;
  }
  function on(e: Node, t: Buffer): string | null {
    let n = t[e.startIndex] === 123 ? fr.exec(e.text) : null;
    if (n) {
      let r = e.endIndex,
        i = !1;
      for (;;) {
        let a = t[r];
        if (a === 32 || a === 9) {
          i = !0;
          r++;
        } else if (a === 92 && t[r + 1] === 10) r += 2;
        else break;
      }
      let s = t[r],
        o = t[r + 1];
      if (
        (((s === 62 || s === 60) && o !== 40) || (s === 38 && o === 62)) &&
        !(i && n[1] !== void 0)
      )
        return e.text;
    }
    for (let r of e.children)
      if (r) {
        let i = on(r, t);
        if (i !== null) return i;
      }
    return null;
  }
  function an(e: Node): Refusal | null {
    if (e.type === "file_redirect") {
      let t = nn(e);
      if (t) return t;
    }
    if (e.type === "herestring_redirect" || e.type === "heredoc_redirect") {
      for (let t of e.children)
        if (t?.type === "variable_name")
          return {
            kind: "too-complex",
            reason: `Redirect uses ${lt(t.text)} fd-variable assignment \u2014 modifies shell variable as side effect`,
          };
      if (e.type === "heredoc_redirect") {
        for (let t of e.children)
          if (t && !rn.has(t.type) && !sn.has(t.type))
            return {
              kind: "too-complex",
              reason:
                "Text after the heredoc start on the same line cannot be statically analyzed",
            };
      }
    }
    for (let t of e.children)
      if (t) {
        let n = an(t);
        if (n) return n;
      }
    return null;
  }
  function Ne(
    e: Node,
    t: Command[],
    n: Scope,
    r: string[],
  ): Redirect | Refusal {
    let i = D,
      s = Ae,
      o = null,
      u = null,
      a;
    {
      let f = nn(e);
      if (f) return f;
    }
    for (let f of e.children) {
      if (!f) continue;
      if (f.type === "file_descriptor") a = Number(f.text);
      else if (f.type === "variable_name")
        return {
          kind: "too-complex",
          reason: `Redirect uses ${f.text} fd-variable assignment \u2014 modifies shell variable as side effect`,
        };
      else if (f.type in je) o = je[f.type] ?? null;
      else if (f.type === ">&-" || f.type === "<&-") {
        if (e.children.some((g) => g !== f && g?.type !== "file_descriptor"))
          return {
            kind: "too-complex",
            reason:
              "Close-fd redirect is followed by a word \u2014 bash passes it to the command as a hidden argument",
          };
        return S(f);
      } else if (u !== null)
        return {
          kind: "too-complex",
          reason:
            "Redirect has multiple targets \u2014 post-redirect args swallowed",
        };
      else if ((o === ">&" || o === "<&") && f.text.startsWith("-"))
        return {
          kind: "too-complex",
          reason:
            "Redirect target after >& or <& starts with - \u2014 bash treats the dash as close-fd and passes the rest to the command as a hidden argument",
        };
      else if (f.type === "word" || f.type === "number") {
        if (f.children.length > 0) return S(f);
        if (Te.test(f.text)) return S(f);
        if (Ye.test(f.text)) return S(f);
        if (Ke.test(f.text)) return S(f);
        if (/(?:^|[^\\])(?:\\\\)*[`$]/.test(f.text)) return S(f);
        u = f.text.replace(/\\([\s\S])/g, (g: string, _: string) =>
          _ ===
          `
`
            ? ""
            : _,
        );
      } else if (f.type === "raw_string") u = mn(f.text);
      else if (f.type === "string") {
        let g = pn(f, t, n, r);
        if (typeof g !== "string") return g;
        u = g;
      } else if (f.type === "concatenation") {
        let g = z(f, t, n, r);
        if (typeof g !== "string") return g;
        if (/(?:^|[^\\])(?:\\\\)*[`$]/.test(f.text))
          return {
            kind: "too-complex",
            reason:
              "Redirect target concatenation contains $/` \u2014 unanalyzable gap or substitution",
            nodeType: "concatenation",
          };
        u = g;
      } else return S(f);
    }
    if (!o || u === null)
      return { kind: "too-complex", reason: "Unrecognized redirect shape" };
    if (Ys(u))
      return {
        kind: "too-complex",
        reason:
          "Redirect target contains $(cmd) output \u2014 path is runtime-determined",
        nodeType: e.type,
      };
    if (
      u.includes(`
`)
    )
      return {
        kind: "too-complex",
        reason:
          "Redirect target contains newline \u2014 potential path traversal",
        nodeType: e.type,
      };
    if (u.startsWith("!"))
      return {
        kind: "too-complex",
        reason:
          "Redirect target starts with ! \u2014 zsh clobber or history expansion",
        nodeType: e.type,
      };
    if (u.startsWith("="))
      return {
        kind: "too-complex",
        reason:
          "Redirect target starts with = \u2014 zsh expands to PATH binary",
        nodeType: e.type,
      };
    if ((o === ">&" || o === "<&") && u.startsWith("-"))
      return {
        kind: "too-complex",
        reason:
          "Redirect target after >& or <& starts with - \u2014 bash treats the dash as close-fd and passes the rest to the command as a hidden argument",
      };
    if (o === ">&" && !/^[A-Za-z0-9./_-]+$/.test(u))
      return {
        kind: "too-complex",
        reason:
          "bash `>&` applies a second word-expansion pass to its target \u2014 path cannot be statically validated",
        nodeType: e.type,
      };
    return {
      op: o,
      target: u,
      fd: a,
      targetSourceLiteral: D === i && Ae === s,
    };
  }
  var ie = !1,
    v = !1,
    q = !1,
    ue = 0,
    ln = new WeakMap<string[], Node[]>(),
    Z: boolean[] | undefined,
    K = 0,
    X: boolean[] | undefined,
    W = new Map<string, string>(),
    j = !1,
    Y = !1,
    fe = 0,
    dr = 256,
    de = !1,
    J: Node | null = null,
    Q = 0,
    pe = new Set<string>();
  function xe(e: string): Refusal | null {
    return v ? null : { kind: "too-complex", reason: e, divergentShape: !0 };
  }
  function Se(e: string): Refusal | null {
    return xe(
      `'${e}' is set for one command that carries an expansion which can fail at runtime \u2014 whether the assignment stands for later commands cannot be statically verified`,
    );
  }
  function pr(): boolean[] | undefined {
    return X;
  }
  function hr(): number {
    return K;
  }
  var mr = /`|\\[$`\\\n]/,
    Tt = ae.source.slice(1, -1),
    gr = new RegExp(
      `\\$(?:${Tt}(?![A-Za-z0-9_\\u0080-\\uffff])|\\{${Tt}\\})(?!\\[|:[A-Za-z&])`,
      "g",
    );
  function et(e: Node, t?: Scope, n?: Node): Refusal | null {
    let r = null,
      i = null,
      s = null,
      o = !1;
    for (let a of e.children) {
      if (!a) continue;
      if (rn.has(a.type)) {
        if (a.type === "heredoc_start") r = a.text;
        else if (a.type === "heredoc_body") s = a;
        else if (a.type === "<<-") o = !0;
        else if (a.type === "heredoc_end") i = a.text;
      } else if (
        a === n &&
        a.children.at(-1)?.type === "command" &&
        a.children.every(
          (f) =>
            f?.type === "|" ||
            (f?.type === "command" &&
              !f.children.some((g) => g?.type.endsWith("_redirect"))),
        )
      ) {
      } else if (sn.has(a.type)) {
        let f = S(a);
        return f.kind === "too-complex"
          ? { ...f, afterHeredocDelimiter: !0 }
          : f;
      } else
        return {
          kind: "too-complex",
          reason:
            "Text after the heredoc start on the same line cannot be statically analyzed",
        };
    }
    if (s === null)
      return {
        kind: "too-complex",
        reason: "Heredoc body was not scanned by the parser",
        nodeType: "heredoc_redirect",
      };
    if (n) {
      let a = Buffer.from(e.text, "utf8")
          .subarray(0, s.startIndex - e.startIndex)
          .toString("utf8"),
        f = e.children
          .slice(0, e.children.indexOf(s))
          .map((g) => (g === n ? "|" : "") + (g?.text ?? ""))
          .join("");
      if (
        a.indexOf(`
`) !==
          a.length - 1 ||
        a.includes("\\") ||
        a.replace(/[ \t\n]/g, "") !== f.replace(/[ \t]/g, "")
      )
        return {
          kind: "too-complex",
          reason:
            "More than a pipeline follows the heredoc delimiter on its line",
        };
    }
    let u =
      r !== null &&
      ((r.startsWith("'") && r.endsWith("'")) ||
        (r.startsWith('"') && r.endsWith('"')) ||
        r.startsWith("\\"));
    if (!u) {
      let a = s.children.filter((g) => g?.type !== "heredoc_content");
      if (!(
        ie &&
        t !== void 0 &&
        r !== null &&
        ae.test(r) &&
        i === r &&
        !mr.test(s.text) &&
        (s.text.match(/\$/g)?.length ?? 0) === a.length &&
        (s.text.match(gr)?.length ?? 0) === a.length &&
        a.every(
          (g) => (
            D++,
            (g?.type === "simple_expansion" || g?.type === "expansion") &&
              typeof ye(g, t, !0) === "string"
          ),
        )
      ))
        return {
          kind: "too-complex",
          reason: "Heredoc with unquoted delimiter undergoes shell expansion",
          nodeType: "heredoc_redirect",
          differential: !0,
        };
    }
    if (
      r !== null &&
      (r.startsWith("'") || r.startsWith('"')) &&
      r.slice(1, -1).includes("\\")
    )
      return {
        kind: "too-complex",
        reason: "Quoted heredoc delimiter contains backslash",
        nodeType: "heredoc_redirect",
      };
    if (u)
      for (let a of s.children) {
        if (!a) continue;
        if (a.type !== "heredoc_content") return S(a);
      }
    if (r !== null && s !== null) {
      let a = !u ? r : r.startsWith("\\") ? r.slice(1) : r.slice(1, -1);
      if (a.length > 0) {
        if (o && a.startsWith("\t"))
          return {
            kind: "too-complex",
            reason: "Heredoc uses <<- with a tab-prefixed delimiter",
            nodeType: "heredoc_redirect",
          };
        for (let f of s.text.split(`
`)) {
          let g = o ? f.replace(/^\t+/, "") : f;
          if (!g.startsWith(a)) continue;
          let _ = g.slice(a.length);
          if (/[)`}]/.test(_))
            return {
              kind: "too-complex",
              reason:
                "Heredoc body line starts with the delimiter and contains a shell metacharacter bash may treat as a terminator",
              nodeType: "heredoc_redirect",
            };
        }
      }
    }
    return null;
  }
  function cn(e: Node, t: Command[], n: Scope, r: string[]): Refusal | null {
    for (let i of e.children) {
      if (!i) continue;
      if (i.type === "<<<") continue;
      if (i.type === "variable_name")
        return {
          kind: "too-complex",
          reason: `Redirect uses ${lt(i.text)} fd-variable assignment \u2014 modifies shell variable as side effect`,
        };
      let s = z(i, t, n, r);
      if (typeof s !== "string") return s;
      if (Ee.test(s)) return S(i);
    }
    return null;
  }
  var tt = new Set(["command", "builtin", "noglob", "nocorrect", "time"]),
    un = /^[A-Za-z_][A-Za-z0-9_]*\+?=[A-Za-z0-9_.,:/@%+=-]*$/,
    nt = new Set(["builtin", "command", "noglob"]),
    ct = new Set(["declare", "typeset", "local", "export", "readonly"]),
    fn = new Set([...ct, "integer", "float", "private"]),
    U5r = new Set([
      ":",
      "break",
      "continue",
      "return",
      "exit",
      "shift",
      "times",
      "set",
      "export",
      "readonly",
      "unset",
    ]);
  function we(
    e: string | undefined,
    t: string | null,
    n: boolean,
    r: Scope,
    i: string[],
  ): Refusal | null {
    if (e === void 0) return null;
    let [, s = "", o = ""] =
      /^([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/.exec(e) ?? [];
    if (s === "" || (n ? o === "" : o !== "" && !/^[[?]/.test(o))) return null;
    let u = r.get(s);
    if (!i.includes(s) && !pe.has(s) && !W.has(s) && (u === void 0 || Ys(u)))
      return null;
    if (!R4a() || P4a()) return null;
    let a = o,
      f = s;
    if (a.startsWith("[")) {
      let h = 0,
        p = a.length;
      for (let c = 0; c < a.length; c++)
        if (a[c] === "[") h++;
        else if (a[c] === "]" && --h === 0) {
          p = c + 1;
          break;
        }
      {
        f += "[\u2026]";
        a = a.slice(p);
      }
    }
    if (a !== "") f += a.startsWith("?") ? "?\u2026" : "\u2026";
    let _ = `In zsh, 'read ${eB(t === null ? f : `${t} ${f}`)}' can set ${s} differently from bash or leave it unchanged, and this command set or unset ${s} earlier, so ${s}'s value after the read can't be checked before the command runs`;
    if (!de) x4a(_);
    return { kind: "too-complex", reason: _, differential: !0 };
  }
  function xr(
    e: string[],
    t: Environment[],
    n: Scope,
    r: string[],
    i: boolean,
    s: boolean,
  ): Refusal | null {
    let o = [],
      u: string[] = [],
      a = (d: string, m = true): void => {
        let b = d.match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (b) {
          if ((o.push(b[0]), m)) u.push(b[0]);
        }
      },
      f = e,
      g = !1,
      _,
      h = [];
    for (;;) {
      let d = f[0];
      if (d === void 0) break;
      if (tt.has(d)) {
        if (
          (_ === "builtin" || _ === "command") &&
          d !== "builtin" &&
          d !== "command"
        ) {
          if (d === "noglob" && !g)
            return {
              kind: "too-complex",
              reason: `'${_} noglob' runs the wrapped command on zsh (for 'command', under POSIX_BUILTINS) but not bash \u2014 cannot statically model whether it executes`,
              nodeType: "command",
            };
          g = !0;
        }
        let m = 1;
        while (m < f.length && /^-[-pvV]*$/.test(required(f[m]))) {
          if (
            /[vV]/.test(required(f[m])) ||
            (d === "builtin" && /p/.test(required(f[m])) && far())
          )
            g = !0;
          m++;
        }
        {
          f = f.slice(m);
          _ = d;
        }
      } else if (d === "!") {
        if (_ === "builtin" || _ === "command") g = !0;
        {
          f = f.slice(1);
          _ = void 0;
        }
      } else if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(d)) {
        if (_ !== void 0 && nt.has(_) && far()) {
          if (!(un.test(d) && !Ys(d)) && !g) {
            let y = $t(_, d);
            if (y) return y;
          }
          g = !0;
        }
        let m = o.length;
        {
          a(d);
          h.push({ word: d, target: o.length > m ? m : void 0 });
          f = f.slice(1);
          _ = void 0;
        }
      } else {
        if (
          _ !== void 0 &&
          nt.has(_) &&
          !g &&
          d !== "[" &&
          /[*?[]/.test(d) &&
          far()
        ) {
          let m = $t(_, d);
          if (m) return m;
        }
        break;
      }
    }
    let p = f[0];
    if (p === void 0) for (let d of t) a(d.name);
    else if (ct.has(p)) {
      let d = !1;
      for (let m = 1; m < f.length; m++) {
        let b = required(f[m]);
        if (!d && b === "--") {
          d = !0;
          continue;
        }
        if (!d && /^[+-].*m/.test(b))
          return {
            kind: "too-complex",
            reason: `'${p} ${b}' (wrapped form) \u2014 zsh -m/+m pattern-assigns every matching variable; cannot statically model target set`,
            nodeType: "command",
          };
        if (!d && b.startsWith("-")) continue;
        if (b.includes("=")) a(b);
      }
    } else if (p === "read" && GQo()) {
    } else if (p === "read") {
      let d = 1,
        m = !1,
        b = !1;
      while (d < f.length) {
        let y = required(f[d]);
        if (!m && y === "--") {
          {
            m = !0;
            d++;
          }
          continue;
        }
        if (!m && y.startsWith("-")) {
          if (le.has(y)) {
            if (Ct.has(y)) {
              let A = we(f[d + 1], y, !1, n, r);
              if (A) return A;
            }
            d += 2;
            continue;
          }
          let k = !1;
          for (let A = 1; A < y.length; A++) {
            let R = y[A];
            if (R === "a" || R === "A") {
              let P = A < y.length - 1 ? y.slice(A + 1) : f[d + 1];
              if (P) {
                let L = we(P, y.slice(0, A + 1), !0, n, r);
                if (L) return L;
                {
                  a(P);
                  b = !0;
                }
              }
              k = A === y.length - 1;
              break;
            }
            if (le.has("-" + R)) {
              if (((k = A === y.length - 1), k && Ct.has("-" + R))) {
                let P = we(f[d + 1], y, !1, n, r);
                if (P) return P;
              }
              break;
            }
          }
          d += k ? 2 : 1;
          continue;
        }
        let w = we(y, null, !0, n, r);
        if (w) return w;
        {
          a(y);
          b = !0;
          d++;
        }
      }
      if (!b) o.push("REPLY");
    } else if (p === "printf")
      for (let d = 1; d < f.length; d++) {
        let m = required(f[d]);
        if (m === "--" || !m.startsWith("-")) break;
        if (m === "-v") {
          if (f[d + 1]) a(required(f[d + 1]));
          d++;
          continue;
        }
        if (m.startsWith("-v")) a(m.slice(2));
      }
    else if (p === "getopts") {
      let d = f[1] === "--" ? 1 : 0;
      if (f[2 + d]) a(required(f[2 + d]));
      {
        o.push("OPTARG");
        T(n, "OPTIND");
      }
    } else if (p === "wait")
      for (let d = 1; d < f.length; d++) {
        let m = required(f[d]);
        if (m === "--" || !m.startsWith("-")) break;
        for (let b = 1; b < m.length; b++)
          if (m[b] === "p") {
            if (b < m.length - 1) a(m.slice(b + 1));
            else if (f[d + 1]) {
              a(required(f[d + 1]));
              d++;
            }
            break;
          }
      }
    else if (!g && (p === "unset" || p === "unsetenv")) {
      let d = !1,
        m = !1;
      for (let b = 1; b < f.length; b++) {
        let y = required(f[b]);
        if (y.startsWith("-")) {
          if (m)
            return {
              kind: "too-complex",
              reason: `'unset \u2026 ${y}' (wrapped form) \u2014 flag after name; getopt stops at first non-option`,
              nodeType: "command",
            };
          if (y !== "-f" && y !== "-v")
            return {
              kind: "too-complex",
              reason: `'unset ${y}' (wrapped form) \u2014 flag other than -f/-v (zsh -m pattern-unset, bash -n nameref) cannot be statically modelled`,
              nodeType: "command",
            };
          if (y === "-f") d = !0;
          continue;
        }
        if (((m = !0), !/^[A-Za-z_][A-Za-z0-9_]*$/.test(y)))
          return {
            kind: "too-complex",
            reason: `'unset ${y}' (wrapped form) \u2014 non-identifier operand may pathname-expand; cannot statically know which var is unset`,
            nodeType: "command",
          };
        if (d || p === "unsetenv") {
          let w = Qe(
            n.get(y),
            `'${y}' no longer has a statically known value at this unset (wrapped form) \u2014 cannot verify what the command leaves behind`,
            "command",
          );
          if (w !== null) return w;
          continue;
        }
        if (epe(y))
          return {
            kind: "too-complex",
            reason: `'unset' targets shell variable ${y} (exec-influencing / integer-attr / IFS / PS4)`,
            nodeType: "command",
          };
        if (s) {
          let w = xe(
            `'unset ${y}' is in a command carrying an expansion that can fail at runtime \u2014 whether the name is cleared cannot be statically verified`,
          );
          if (w) return w;
        }
        Je(n, y, i);
      }
    } else if (p === "print")
      for (let d = 1; d < f.length; d++) {
        let m = required(f[d]);
        if (m === "--" || m === "-" || !m.startsWith("-")) break;
        let b = !1;
        for (let y = 1; y < m.length; y++) {
          let w = m[y];
          if (w === "v") {
            let k = y < m.length - 1 ? m.slice(y + 1) : f[d + 1];
            if (k) a(k);
            b = y === m.length - 1;
            break;
          }
          if (Or.has("-" + w)) {
            b = y === m.length - 1;
            break;
          }
        }
        if (b) d++;
      }
    else if (p === "set")
      for (let d = 1; d < f.length; d++) {
        let m = required(f[d]);
        if (m === "--" || !/^[-+]/.test(m)) break;
        let b = m.indexOf("A", 1);
        if (b === -1) {
          if (m.endsWith("o")) d++;
          continue;
        }
        if (b < m.length - 1) a(m.slice(b + 1));
        else if (f[d + 1]) a(required(f[d + 1]));
        break;
      }
    else if (p === "mapfile" || p === "readarray") {
      let d = !1;
      for (let m = 1; m < f.length; m++) {
        let b = required(f[m]);
        if (b.startsWith("-")) {
          if (/^-[dnOsuCc]$/.test(b)) m++;
          continue;
        }
        {
          a(b);
          d = !0;
        }
      }
      if (!d) o.push("MAPFILE");
    } else if (
      !g &&
      (p === "cd" || p === "chdir" || p === "pushd" || p === "popd")
    ) {
      let d = !1;
      if (p === "pushd" || p === "popd")
        for (let m = 1; m < f.length; m++) {
          let b = required(f[m]);
          if (b === "--") break;
          if (dLe(b, "n")) {
            d = !0;
            break;
          }
          if (p === "popd" && (/^\+0*[1-9]/.test(b) || /^-0+$/.test(b))) {
            d = !0;
            break;
          }
        }
      if (!d) {
        T(n, "PWD");
        T(n, "OLDPWD");
      }
      if (p === "pushd" || p === "popd") {
        T(n, "DIRSTACK");
        T(n, "dirstack");
      }
    }
    let c = p !== void 0 && fn.has(p) ? t.length + h.length : 0,
      x = K;
    if (((K += c), c > 0 && Z === void 0)) {
      let d =
          p === "export" ||
          p === "readonly" ||
          f.some((b) => /^-[A-Za-z]*[xr]/.test(b)),
        m = new Set();
      for (let b of d ? f.slice(1) : []) {
        let y = /^[A-Za-z_]\w*/.exec(b);
        if (y !== null) m.add(y[0]);
      }
      X = [
        ...(X ?? []),
        ...t.map((b) => m.has(b.name)),
        ...h.map(({ word: b }) => m.has(/^[A-Za-z_]\w*/.exec(b)?.[0] ?? "")),
      ];
    }
    if (c > 0 && Z !== void 0) {
      let d: Refusal = {
          kind: "too-complex",
          reason: `A variable set in front of ${p} in this command can't be checked before it runs`,
        },
        m = [...t];
      for (let { word: b } of h) {
        let y = /^([A-Za-z_]\w*)(\+?)=([^]*)$/.exec(b);
        if (y === null) return d;
        let [, w = "", k, A = ""] = y;
        m.push(
          k === "+"
            ? { name: w, value: A, isAppend: !0 }
            : { name: w, value: A },
        );
      }
      if (Z.length < x + m.length || (h.length > 0 && m.length > 1)) return d;
      for (let b = h.length - 1; b >= 0; b--) {
        let y = h[b]?.target;
        if (y !== void 0) o.splice(y, 1);
      }
      for (let [b, y] of m.entries()) {
        if (Z[x + b] !== !0) continue;
        let w = y.isAppend ? n.get(y.name) : "",
          k = w === void 0 ? void 0 : ge(w);
        if (Ys(y.value) || epe(y.name)) return d;
        if (k === void 0 || Ys(k))
          return d.kind === "too-complex" && !v && w?.includes(C) === !0
            ? { ...d, divergentShape: !0 }
            : d;
        if (s) {
          let R = xe(
            `'${y.name}' is appended to by a command carrying an expansion that can fail at runtime \u2014 whether the append happens cannot be statically verified`,
          );
          if (R) return R;
        }
        let A = (k === w ? "" : me) + k + y.value;
        {
          n.set(y.name, A);
          W.set(y.name, k + y.value);
        }
      }
    }
    if (p !== void 0 && t.length > 0 && !(c > 0 && Z !== void 0) && U5r.has(p))
      for (let d of t) a(d.name);
    for (let d of o) {
      if (epe(d))
        return {
          kind: "too-complex",
          reason: `'${p ?? t[0]?.name}' writes shell variable ${d} (exec-influencing / integer-attr / IFS) \u2014 value cannot be statically verified`,
          nodeType: "command",
        };
      T(n, d);
    }
    return (r.push(...u), null);
  }
  function $t(e: string, t: string): Refusal | null {
    return v
      ? null
      : {
          kind: "too-complex",
          reason: `'${e} ${eB(t)}' has a pattern the shell may expand, so this command can't be checked before it runs`,
          nodeType: "command",
          divergentShape: !0,
          keepsRemovalVerdict: !0,
        };
  }
  var Pt = /^([A-Za-z_]\w*)(?:\[[\s\S]*?\])?(\+?)=([\s\S]*)$/,
    yr = 16;
  function dn(
    e: Node[],
    t: Pick<Command, "argv" | "envVars">,
    n: Redirect[],
    r: Command[],
    i: Scope,
    s: string[],
  ): Refusal | null {
    let o: (Environment & {
        word?: Node | undefined;
        isOtherElement?: boolean;
      })[] = [...t.envVars],
      u = ln.get(t.argv),
      a = !1;
    for (let [c, x] of t.argv.entries()) {
      let [, d, m, b] = Pt.exec(x) ?? [],
        [, y] = /^([A-Za-z_]\w*)\[/.exec(x) ?? [];
      if (d !== void 0 && b !== void 0)
        o.push({
          name: d,
          value: b,
          isAppend: m === "+",
          word: u?.[c],
          isOtherElement: /^\w+\[[1-9]\d*\]/.test(x),
        });
      else if (y !== void 0) {
        o.push({ name: y, value: O });
        a = !0;
      } else if (
        !a &&
        (o.length > t.envVars.length || !/^(?:time|coproc|!|-p|--)$/.test(x))
      )
        return null;
    }
    let f = new Set(o.map((c) => c.name)),
      g = e.filter(
        (c) =>
          (c?.type === "file_redirect" || c?.type === "herestring_redirect") &&
          Oe(c, f) !== null,
      );
    if (g.length === 0) return null;
    let _ = xe(
      "A redirect in this command may read a variable the same command sets, and shells can differ on which value it gets",
    );
    if (_)
      return _.kind === "too-complex" ? { ..._, keepsRemovalVerdict: !0 } : _;
    let h = new Map(i),
      p = new Set<string>();
    for (let {
      name: c,
      value: x,
      isAppend: d,
      word: m,
      isOtherElement: b,
    } of o) {
      let y: string | undefined = x;
      if (m !== void 0 && Oe(m, p) !== null) {
        let k: Command[] = [],
          A = vt(m) ? z(m, k, h, s) : void 0;
        if (
          ((y = typeof A === "string" ? Pt.exec(A)?.[3] : void 0), y !== void 0)
        ) {
          let R = r.findIndex((P) => P.argv === t.argv);
          r.splice(R === -1 ? r.length : R, 0, ...k);
        }
      }
      if (b) continue;
      let w = d ? h.get(c) : "";
      if (w === void 0 || y === void 0) T(h, c);
      else h.set(c, w + y);
      p.add(c);
    }
    for (let c of g) {
      if (!vt(c)) continue;
      let x = r.length;
      if (c.type === "file_redirect") {
        let m = Ne(c, r, h, s);
        if (((r.length = x), !("kind" in m))) n.push(m);
        continue;
      }
      if (cn(c, r, h, s)) r.length = x;
    }
    return null;
  }
  function vt(e: Node): boolean {
    if (e.text.length > ue) return !1;
    return ((ue -= e.text.length), !0);
  }
  function _r(
    e: Node,
    t: Redirect[],
    n: Command[],
    r: Scope,
    i: string[],
  ): Result {
    let s = D,
      o = H,
      u = n.length,
      a: string[] = [],
      f: Node[] = [];
    if (v) ln.set(a, f);
    let g = [],
      _ = [],
      h = [],
      p = [...t],
      c = e.children.some((k) => k && On.has(k.type)) ? new Map(r) : null,
      x = 0,
      d = !1;
    for (let k of e.children) {
      if (!k) continue;
      let A = oe(k);
      switch (((d ||= A), k.type)) {
        case "variable_assignment": {
          if (h.length > 0) {
            let P = Oe(k, new Set(h.map((L) => L.name)));
            if (P !== null)
              return {
                kind: "too-complex",
                reason: `Env-prefix value references \`$${P}\` assigned by an earlier env-prefix in the same command \u2014 runtime sees the earlier assignment, static analysis does not`,
                nodeType: "variable_assignment",
              };
          }
          let R = rt(k, n, r, i);
          if ("kind" in R) return R;
          if (Rn(R.name, R.value))
            return {
              kind: "too-complex",
              reason: `${R.name} has integer attribute \u2014 env-prefix arith-evals value, which can execute subscript command substitution or abort/diverge at runtime`,
              nodeType: "variable_assignment",
            };
          if (
            (h.push(
              R.isAppend
                ? { name: R.name, value: R.value, isAppend: !0 }
                : { name: R.name, value: R.value },
            ),
            A)
          )
            x = h.length - 1;
          break;
        }
        case "command_name": {
          let R = k.children[0] ?? k;
          if (cp()) {
            if (R.type === "simple_expansion" || R.type === "expansion")
              return S(R);
            if ((R.type === "string" || R.type === "concatenation") && gn(R))
              return S(R);
          }
          let P = z(R, n, r, i);
          if (typeof P !== "string") return P;
          {
            a.push(P);
            f.push(R);
            g.push(F(R.text) || Ie(R));
          }
          break;
        }
        case "word":
        case "number":
        case "raw_string":
        case "string":
        case "concatenation":
        case "arithmetic_expansion": {
          let R = z(k, n, r, i);
          if (typeof R !== "string") return R;
          if (/^--?[\nA-Za-z0-9_]/.test(R) && Ys(R))
            return {
              kind: "too-complex",
              reason:
                "Argument starting with `-` contains runtime-determined content",
              nodeType: k.type,
            };
          if (
            (a.push(R),
            f.push(k),
            g.push(F(k.text) || Ie(k)),
            k.type === "string" && !r.has("PWD") && OVo.test(k.text))
          )
            _.push({ start: k.startIndex, end: k.endIndex });
          break;
        }
        case "simple_expansion": {
          D++;
          let R = ye(k, r, !1);
          if (typeof R !== "string") return R;
          {
            a.push(R);
            f.push(k);
            g.push(!0);
          }
          break;
        }
        case "file_redirect": {
          let R = h[0]?.name;
          if (R !== void 0 && A) {
            let L = Se(R);
            if (L) return L;
          }
          let P = Ne(k, n, r, i);
          if ("kind" in P) return P;
          p.push(P);
          break;
        }
        case "herestring_redirect": {
          D++;
          let R = h[0]?.name;
          if (R !== void 0 && A) {
            let L = Se(R);
            if (L) return L;
          }
          let P = cn(k, n, r, i);
          if (P) return P;
          break;
        }
        default:
          return S(k);
      }
    }
    if (c) {
      let k = dn(e.children, { argv: a, envVars: h }, p, n, r, i);
      if (k) return k;
    }
    let m = h[0]?.name;
    if (x > 0 && m !== void 0) {
      let k = Se(m);
      if (k) return k;
    }
    {
      let k = xr(a, h, r, i, u > 0, d);
      if (k) return k;
    }
    if (c) tn(r, c);
    let b = (k: string, A?: number) =>
        k === "" ||
        /["'\\ \t\n$`;|&<>(){}#]/.test(k) ||
        (A === 0 && k.includes("="))
          ? `'${k.replaceAll("'", "'\\''")}'`
          : k,
      y =
        /\$[A-Za-z_]/.test(e.text) ||
        e.text.includes(`
`)
          ? [
              ...h.map(
                (k) =>
                  `${k.name}${k.isAppend && rmt() ? "+" : ""}=${b(k.value)}`,
              ),
              ...a.map((k, A) => b(k, A)),
            ].join(" ")
          : e.text,
      w = F(e.text);
    return {
      kind: "simple",
      commands: [
        {
          argv: a,
          envVars: h,
          redirects: p,
          text: y,
          hasUnquotedGlob: w,
          argvSourceLiteral: D === s,
          carveOutMayDesyncQuoteScan: H !== o,
          argvUnquotedGlob: g,
          ...(_.length > 0 && {
            atShellCwd: { start: e.startIndex, end: e.endIndex, words: _ },
          }),
        },
      ],
      bareAssignmentNames: [],
    };
  }
  var br = "*?[";
  function Ie(e: Node): boolean {
    switch (e.type) {
      case "word":
      case "number":
        for (let t = 0; t < e.text.length; t++)
          if (e.text[t] === "\\") t++;
          else if (br.includes(required(e.text[t]))) return !0;
        return !1;
      case "string":
      case "raw_string":
      case "simple_expansion":
      case "arithmetic_expansion":
        return !1;
      case "concatenation":
        return e.children.some((t) => t !== null && Ie(t));
      default:
        return !0;
    }
  }
  function ut(e: Node, t: Command[], n: Scope, r: string[]): Refusal | null {
    if (ie && Ce(e, "heredoc_redirect")) return S(e);
    let i = new Map(n),
      s = t.length,
      o = !1;
    {
      let u = Buffer.from(e.text, "utf8"),
        a = (_: number | undefined) =>
          _ === 32 || _ === 9 || _ === 10 || _ === 13 || _ === 59 || _ === 38,
        f = (_: number, h: number) => {
          let p = _;
          while (p < h) {
            let c = u[p];
            if (a(c)) p++;
            else if (
              c === 92 &&
              (u[p + 1] === 10 || (u[p + 1] === 13 && u[p + 2] === 10))
            )
              p += u[p + 1] === 13 ? 3 : 2;
            else return !1;
          }
          return !0;
        },
        g = 0;
      for (let _ of e.children) {
        if (!_) continue;
        let h = _.startIndex - e.startIndex;
        if (!f(g, h))
          return {
            kind: "too-complex",
            reason:
              "command substitution contains bytes no parsed node accounts for",
          };
        g = _.endIndex - e.startIndex;
      }
      if (!f(g, u.length))
        return {
          kind: "too-complex",
          reason:
            "command substitution contains bytes no parsed node accounts for",
        };
    }
    for (let u of e.children) {
      if (!u) continue;
      if (u.type === "$(" || u.type === "`" || u.type === ")") continue;
      if (u.type !== "comment") o = !0;
      let a = I(u, t, i, r);
      if (a) return a;
    }
    if (o && t.length === s) re(t, e);
    return null;
  }
  function z(
    e: Node | null | undefined,
    t: Command[],
    n: Scope,
    r: string[],
  ): string | Refusal {
    if (!e) return { kind: "too-complex", reason: "Null argument node" };
    switch (e.type) {
      case "word": {
        if (Te.test(e.text))
          return {
            kind: "too-complex",
            reason: "Word contains brace expansion syntax",
            nodeType: "word",
            differential: !0,
          };
        if (Ye.test(e.text) || Ke.test(e.text))
          return {
            kind: "too-complex",
            reason: "Brace body contains backslash-escaped brace",
            nodeType: "word",
            differential: !0,
          };
        if (L5r.test(e.text))
          return {
            kind: "too-complex",
            reason:
              "Word contains unescaped ` or $ \u2014 parser missed expansion",
            nodeType: "word",
            differential: !0,
          };
        if (DVo.test(e.text))
          return {
            kind: "too-complex",
            reason:
              "Word contains unescaped quote \u2014 parser absorbed quote into brace-body word",
            nodeType: "word",
          };
        return e.text.replace(/\\(.)/g, "$1");
      }
      case "number":
        if (e.children.length > 0)
          return {
            kind: "too-complex",
            reason:
              "Number node contains expansion (NN# arithmetic base syntax)",
            nodeType: e.children[0]?.type,
          };
        return e.text;
      case "raw_string":
        return mn(e.text);
      case "string":
        return pn(e, t, n, r);
      case "concatenation": {
        if (Te.test(e.text))
          return {
            kind: "too-complex",
            reason: "Brace expansion",
            nodeType: "concatenation",
            differential: !0,
          };
        if (Ye.test(e.text) || Ke.test(e.text))
          return {
            kind: "too-complex",
            reason: "Brace body contains backslash-escaped brace",
            nodeType: "concatenation",
            differential: !0,
          };
        let i = "",
          s = !1,
          o = e.startIndex;
        for (let u = 0; u < e.children.length; u++) {
          let a = e.children[u];
          if (!a) continue;
          if (a.startIndex > o)
            return {
              kind: "too-complex",
              reason:
                "Concatenation has unparsed bytes between children \u2014 parser dropped content that shell will see",
              nodeType: "concatenation",
            };
          if (((o = a.endIndex), a.type === "word" && a.text.includes("{")))
            s = !0;
          if (
            (a.type === "simple_expansion" || a.type === "expansion") &&
            (e.children[u + 1]?.text.startsWith("[") ||
              /^:[a-zA-Z&]/.test(e.children[u + 1]?.text ?? ""))
          )
            return {
              kind: "too-complex",
              reason:
                "zsh $name[expr] / $name:mod in bare concatenation \u2014 recursive eval",
              nodeType: "concatenation",
              differential: !0,
            };
          let f = z(a, t, n, r);
          if (typeof f !== "string") return f;
          i += f;
        }
        if (s && (i.includes(",") || i.includes("..")))
          return {
            kind: "too-complex",
            reason:
              "Brace expansion (unquoted `{` in concatenation with `,`/`..`)",
            nodeType: "concatenation",
          };
        if (H5r.test(i))
          return {
            kind: "too-complex",
            reason: "zsh ~[ dynamic directory syntax (post-collapse)",
            nodeType: "concatenation",
            differential: !0,
          };
        if (N5r.test(i))
          return {
            kind: "too-complex",
            reason: "zsh =cmd expansion (post-collapse)",
            nodeType: "concatenation",
            differential: !0,
          };
        return i;
      }
      case "arithmetic_expansion": {
        D++;
        let i = ft(e);
        if (i) return i;
        return O;
      }
      case "simple_expansion":
        return (D++, ye(e, n, !1));
      default:
        return S(e);
    }
  }
  function pn(e: Node, t: Command[], n: Scope, r: string[]): string | Refusal {
    let i = "",
      s = -1,
      o = !1,
      u = !1,
      a = !1;
    for (let f of e.children) {
      if (!f) continue;
      if (s !== -1 && f.startIndex > s) {
        let g = Buffer.from(e.text, "utf8")
          .subarray(s - e.startIndex, f.startIndex - e.startIndex)
          .toString("utf8");
        if (g.includes("`"))
          return {
            kind: "too-complex",
            reason:
              "Unanalyzable backtick body in double-quoted string gap \u2014 shell-evaluated value unknown",
            nodeType: "string",
            differential: !0,
          };
        if (g.length > 0) {
          i += g;
          u = !0;
        }
      }
      switch (((s = f.endIndex), f.type)) {
        case '"':
          s = f.endIndex;
          break;
        case "string_content":
          {
            i += f.text.replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1");
            u = !0;
          }
          break;
        case kt: {
          let g = e.children.indexOf(f),
            _ = e.children[g + 1];
          if (_?.type === "string_content") {
            if (_.text.startsWith("["))
              return {
                kind: "too-complex",
                reason:
                  "Legacy $[...] arithmetic inside double-quotes \u2014 recursive subscript eval",
                nodeType: "string",
                differential: !0,
              };
            if (/^[+^=~]/.test(_.text))
              return {
                kind: "too-complex",
                reason:
                  "zsh $+/$^/$=/$~ prefix-flag expansion \u2014 value defeats downstream content checks",
                nodeType: "string",
                differential: !0,
              };
            let h = e.children[g - 1];
            if (
              /^:[a-zA-Z&]/.test(_.text) &&
              h?.type === "simple_expansion" &&
              h.endIndex === f.startIndex &&
              h.children.some((p) => p?.type === "special_variable_name")
            )
              return {
                kind: "too-complex",
                reason:
                  'zsh "$name[expr]" / "$name:mod" inside double-quotes \u2014 recursive eval',
                nodeType: "string",
                differential: !0,
              };
          }
          {
            i += kt;
            u = !0;
          }
          break;
        }
        case "command_substitution": {
          let g = Rr(f);
          if (g === "DANGEROUS") return S(f);
          if (g !== null) {
            let h = g.replace(/\n+$/, "");
            if (Cn.test(f.text)) H++;
            if (
              h.includes(`
`)
            ) {
              if (/^--?[A-Za-z0-9]/.test(i + h))
                return {
                  kind: "too-complex",
                  reason:
                    "cat-heredoc body would make the argument start with option syntax",
                  nodeType: "command_substitution",
                };
              {
                Ae++;
                i +=
                  `
` + pJ;
                u = !0;
              }
              break;
            }
            {
              Ae++;
              i += h;
              u = !0;
            }
            break;
          }
          let _ = ut(f, t, n, r);
          if (_) return _;
          {
            D++;
            i += pJ;
            o = !0;
          }
          break;
        }
        case "simple_expansion": {
          D++;
          let g = ye(f, n, !0);
          if (typeof g !== "string") return g;
          {
            let _ = e.children[e.children.indexOf(f) + 1],
              h = f.children.some((p) => p?.type === "special_variable_name");
            if (
              _?.type === "string_content" &&
              (_.text.startsWith("[") ||
                /^:[a-zA-Z&]/.test(_.text) ||
                (h && lr.test(_.text)))
            )
              return {
                kind: "too-complex",
                reason:
                  'zsh "$name[expr]" / "$name:mod" inside double-quotes \u2014 recursive eval',
                nodeType: "string",
                differential: !0,
              };
          }
          if (Ys(g)) o = !0;
          else if (g !== "") u = !0;
          else a = !0;
          i += g;
          break;
        }
        case "arithmetic_expansion": {
          let g = ft(f);
          if (g) return g;
          {
            D++;
            i += O;
            o = !0;
          }
          break;
        }
        default:
          return S(f);
      }
    }
    if (o) {
      if (Array.from(i.replaceAll(pJ, "").replaceAll(O, "")).length <= 1)
        return S(e);
    }
    if (!u && !o && !a && e.text.length > 2) {
      let f = e.text.slice(1, -1);
      if (f.includes("`") || f.includes("$("))
        return {
          kind: "too-complex",
          reason:
            "Delimiters-only string node contains unparsed command substitution",
          nodeType: "string",
          differential: !0,
        };
      return f;
    }
    return i;
  }
  var kr =
    /^(?:[0-9]+|0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[-+*/%^&|~!<>=?:(),]+|<<|>>|\*\*|&&|\|\||[<>=!]=|\$\(\(|\)\))$/;
  function ft(e: Node): Refusal | null {
    for (let t of e.children) {
      if (!t) continue;
      if (t.children.length === 0) {
        if (!kr.test(t.text))
          return {
            kind: "too-complex",
            reason: `Arithmetic expansion references variable or non-literal: ${t.text}`,
            nodeType: "arithmetic_expansion",
          };
        continue;
      }
      switch (t.type) {
        case "binary_expression":
        case "unary_expression":
        case "ternary_expression":
        case "parenthesized_expression": {
          let n = ft(t);
          if (n) return n;
          break;
        }
        default:
          return S(t);
      }
    }
    return null;
  }
  function re(e: Command[], t: Node): void {
    e.push({
      argv: ["true"],
      envVars: [],
      redirects: [],
      text: t.text,
      hasUnquotedGlob: F(t.text),
    });
  }
  function oe(e: Node): boolean {
    if (e.type === "arithmetic_expansion") return !0;
    for (let t of e.children) if (t && oe(t)) return !0;
    return !1;
  }
  function Rr(e: Node): string | null {
    let t = null;
    for (let i of e.children) {
      if (!i) continue;
      if (i.type === "$(" || i.type === ")") continue;
      if (i.type === "redirected_statement" && t === null) t = i;
      else return null;
    }
    if (!t) return null;
    let n = !1,
      r = null;
    for (let i of t.children) {
      if (!i) continue;
      if (i.type === "command") {
        let s = i.children.filter((u) => u);
        if (s.length !== 1) return null;
        let o = s[0];
        if (o?.type !== "command_name" || o.text !== "cat") return null;
        n = !0;
      } else if (i.type === "heredoc_redirect") {
        if (et(i) !== null) return null;
        for (let s of i.children) {
          if (s?.type === "<<-") return null;
          if (s?.type === "heredoc_body") r = s.text;
        }
      } else return null;
    }
    if (!n || r === null) return null;
    if (it.test(r)) return "DANGEROUS";
    if (Dwn(r) !== !1) return "DANGEROUS";
    return r;
  }
  function rt(
    e: Node,
    t: Command[],
    n: Scope,
    r: string[],
  ): Environment | Refusal {
    let i = null,
      s = "",
      o = !1;
    for (let u of e.children) {
      if (!u) continue;
      if (u.type === "variable_name") i = u.text;
      else if (u.type === "=" || u.type === "+=") {
        o = u.type === "+=";
        continue;
      } else if (u.type === "command_substitution") {
        let a = ut(u, t, n, r);
        if (a) return a;
        s = pJ;
      } else if (u.type === "simple_expansion") {
        let a = ye(u, n, !0);
        if (typeof a !== "string") return a;
        s = a;
      } else {
        let a = z(u, t, n, r);
        if (typeof a !== "string") return a;
        s = a;
      }
    }
    if (i === null)
      return {
        kind: "too-complex",
        reason: "Variable assignment without name",
        nodeType: "variable_assignment",
      };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(i))
      return {
        kind: "too-complex",
        reason: `Invalid variable name (bash treats as command): ${i}`,
        nodeType: "variable_assignment",
      };
    if (i === "IFS")
      return {
        kind: "too-complex",
        reason:
          "IFS assignment changes word-splitting \u2014 cannot model statically",
        nodeType: "variable_assignment",
      };
    if (i === "PS4" || i === "PROMPT4") {
      if (o)
        return {
          kind: "too-complex",
          reason:
            "PS4 += cannot be statically verified \u2014 combine into a single PS4= assignment",
          nodeType: "variable_assignment",
        };
      if (Ys(s))
        return {
          kind: "too-complex",
          reason:
            "PS4 value derived from cmdsub/variable \u2014 runtime unknowable",
          nodeType: "variable_assignment",
        };
      if (
        !/^[A-Za-z0-9 _+:./=[\]-]*$/.test(
          s.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""),
        )
      )
        return {
          kind: "too-complex",
          reason:
            "PS4 value outside safe charset \u2014 only ${VAR} refs and [A-Za-z0-9 _+:.=/[]-] allowed",
          nodeType: "variable_assignment",
        };
    }
    if (s.includes("~") && !v)
      return {
        kind: "too-complex",
        reason:
          "Tilde in assignment value \u2014 bash may expand at assignment time",
        nodeType: "variable_assignment",
      };
    return { name: i, value: s, isAppend: o };
  }
  var hn = new Set([
    "_",
    "RANDOM",
    "SECONDS",
    "LINENO",
    "BASH_COMMAND",
    "FUNCNAME",
    "EPOCHSECONDS",
    "EPOCHREALTIME",
    "SRANDOM",
    "BASHPID",
    "BASH_MONOSECONDS",
    "BASH_TRAPSIG",
    "HISTCMD",
    "ERRNO",
    "REPLY",
    "reply",
    "PIPESTATUS",
    "pipestatus",
    "BASH_SOURCE",
    "DIRSTACK",
    "GROUPS",
    "BASH_ARGV",
    "BASH_ARGC",
    "BASH_SUBSHELL",
    "BASH_LINENO",
    "BASH_ARGV0",
    "BASH_REMATCH",
    "MATCH",
    "match",
    "MBEGIN",
    "MEND",
    "mbegin",
    "mend",
    "OPTARG",
    "OPTIND",
    "argv",
    "FIGNORE",
    "fignore",
    "PSVAR",
    "psvar",
    "WATCH",
    "watch",
    "HISTCHARS",
    "histchars",
    "PS1",
    "PROMPT",
    "prompt",
    "PS2",
    "PROMPT2",
    "PS3",
    "PROMPT3",
    "PS4",
    "PROMPT4",
    "RPS1",
    "RPROMPT",
    "RPS2",
    "RPROMPT2",
  ]);
  function ye(e: Node, t: Scope, n: boolean): string | Refusal {
    let r = null,
      i = !1;
    for (let f of e.children) {
      if (f?.type === "variable_name") {
        r = f.text;
        break;
      }
      if (f?.type === "special_variable_name") {
        {
          r = f.text;
          i = !0;
        }
        break;
      }
    }
    if (r === null) return S(e);
    let s = t.get(r);
    {
      xt(s?.length ?? 0);
      fe += s?.length ?? 0;
    }
    let o = fe > De;
    if (o && !v) return xn(e);
    let u = o ? s?.slice(0, dr) : s;
    if (u !== s) Me();
    let a = u === void 0 ? void 0 : ge(u);
    if (a !== void 0) {
      if (a.includes(C)) {
        let f = S(e);
        return f.kind === "too-complex" && !v
          ? { ...f, divergentShape: !0 }
          : f;
      }
      if (hn.has(r)) return n && qe.has(r) && r !== "BASHPID" ? O : S(e);
      if (Ys(a)) {
        if (!n) return S(e);
        return ((Y ||= a !== O && a !== pJ), a);
      }
      if (!n) {
        if (a === "") return S(e);
        if (_t.test(a)) return S(e);
      }
      return ((Y = !0), a);
    }
    if (r === "HOME") {
      let f = vn();
      if (!n && (f === "" || _t.test(f))) return S(e);
      return f;
    }
    if (n) {
      if (qe.has(r)) return O;
      if (i && (Fn.has(r) || /^[0-9]+$/.test(r))) return O;
    }
    return S(e);
  }
  function Ge(e: Scope, t: Node): void {
    ce(t, e);
  }
  function Nt(
    e: Node,
    t: Command[],
    n: Scope,
    r: string[],
  ): string[] | Refusal {
    if (!de || e === J) return [];
    if (Q >= nr)
      return {
        kind: "too-complex",
        reason: "Loops nested too deeply to follow the variables they change",
        nodeType: e.type,
      };
    let i = new Map(n),
      s = J,
      o = Y,
      u = q,
      a = K,
      f = X,
      g = W,
      _ = j;
    {
      W = new Map(g);
      J = e;
      Q++;
    }
    let h = I(e, [...t], i, [...r]);
    return (
      Q--,
      (J = s),
      (Y = o),
      (q = u),
      (K = a),
      (X = f),
      (W = g),
      (j = _),
      h ?? Array.from(n.keys()).filter((p) => i.get(p) !== n.get(p))
    );
  }
  function It(e: Node[], t: Scope): void {
    let n = () => {
      for (let r of t.keys()) T(t, r);
    };
    for (let r of e) {
      if (r?.type === "unset" && r.text === "unsetenv") return;
      if (
        !r ||
        r.type === "unset" ||
        r.type === "file_redirect" ||
        r.type === "heredoc_redirect" ||
        r.type === "herestring_redirect"
      )
        continue;
      if (r.type === "variable_name") {
        T(t, r.text.replace(/\\/g, ""));
        continue;
      }
      if (r.type === "word") {
        if (r.text.startsWith("-")) {
          if (r.text === "--" || /^-[fvn]+$/.test(r.text)) continue;
          n();
          continue;
        }
        if (/^\\?[A-Za-z_][A-Za-z0-9_]*$/.test(r.text)) {
          T(t, r.text.replace(/^\\/, ""));
          continue;
        }
      }
      n();
    }
  }
  function st(e: Node | null | undefined): string | null {
    if (!e) return null;
    switch (e.type) {
      case "word":
      case "number":
        return e.text.replace(/\\(.)/g, "$1");
      case "raw_string":
        return e.text.slice(1, -1);
      case "string": {
        let t = e.children.filter((n) => n && n.type !== '"');
        if (t.length === 0) return "";
        if (t.length === 1 && t[0]?.type === "string_content") return t[0].text;
        return null;
      }
      case "concatenation": {
        let t = "";
        for (let n of e.children) {
          let r = st(n);
          if (r === null) return null;
          t += r;
        }
        return t;
      }
      default:
        return null;
    }
  }
  function ce(e: Node, t: Scope): void {
    if (
      e.type === "function_definition" ||
      e.type === "subshell" ||
      e.type === "command_substitution" ||
      e.type === "process_substitution"
    )
      return;
    if (e.type === "pipeline") {
      let n = null;
      for (let r of e.children) if (r && !he.has(r.type)) n = r;
      if (n) ce(n, t);
      return;
    }
    if (e.type === "list" || e.type === "program") {
      let n = e.children;
      for (let r = 0; r < n.length; r++) {
        let i = n[r];
        if (!i || he.has(i.type)) continue;
        let s = r + 1;
        while (s < n.length && !n[s]) s++;
        if (n[s]?.type === "&") continue;
        ce(i, t);
      }
      return;
    }
    if (e.type === "variable_assignment") {
      for (let n of e.children)
        if (n?.type === "variable_name") {
          T(t, n.text);
          break;
        }
    }
    if (e.type === "for_statement") {
      for (let n of e.children)
        if (n?.type === "variable_name") {
          T(t, n.text);
          break;
        }
    }
    if (e.type === "unset_command") It(e.children, t);
    if (e.type === "command") {
      let n: string | undefined,
        r: Node | undefined,
        i: string[] = [],
        s: Node[] = [],
        o = !1;
      for (let c of e.children) {
        if (!c) continue;
        if (c.type === "command_name") {
          r = c;
          n = st(c.children[0] ?? c) ?? void 0;
          o = !0;
        } else if (
          !o ||
          c.type === "file_redirect" ||
          c.type === "herestring_redirect" ||
          c.type === "heredoc_redirect"
        ) {
        } else {
          i.push(st(c) ?? "");
          s.push(c);
        }
      }
      let u = !1,
        a;
      while (n !== void 0 && (tt.has(n) || n === "!")) {
        if (
          (a === "builtin" || a === "command") &&
          n !== "builtin" &&
          n !== "command" &&
          n !== "noglob"
        )
          u = !0;
        let c = n === "!" ? void 0 : n;
        while (i.length > 0) {
          let x = required(i[0]);
          if (/^-[-pvV]*$/.test(x)) {
            if (/[vV]/.test(x) || (c === "builtin" && /p/.test(x) && far()))
              u = !0;
            {
              i.shift();
              s.shift();
            }
          } else if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(x)) {
            if (
              c !== void 0 &&
              nt.has(c) &&
              ((un.test(x) && !Ys(x)) || v) &&
              far()
            )
              u = !0;
            let d = required(x.match(/^[A-Za-z_][A-Za-z0-9_]*/))[0];
            {
              T(t, d);
              i.shift();
              s.shift();
              c = void 0;
            }
          } else break;
        }
        {
          a = c;
          n = i.shift();
          s.shift();
        }
      }
      let f = i,
        g = (c: string): void => {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) T(t, c);
        };
      if (n === "read" && !GQo()) {
        T(t, "REPLY");
        let c = 0,
          x = !1;
        while (c < f.length) {
          let d = required(f[c]);
          if (!x && d === "--") {
            {
              x = !0;
              c++;
            }
            continue;
          }
          if (!x && d.startsWith("-")) {
            if (le.has(d)) {
              c += 2;
              continue;
            }
            let m = !1;
            for (let b = 1; b < d.length; b++) {
              let y = d[b];
              if (y === "a" || y === "A") {
                {
                  g(b < d.length - 1 ? d.slice(b + 1) : (f[c + 1] ?? ""));
                  m = b === d.length - 1;
                }
                break;
              }
              if (le.has("-" + y)) {
                m = b === d.length - 1;
                break;
              }
            }
            c += m ? 2 : 1;
            continue;
          }
          {
            g(d);
            c++;
          }
        }
      } else if (n === "mapfile" || n === "readarray") {
        T(t, "MAPFILE");
        for (let c = 0; c < f.length; c++) {
          let x = required(f[c]);
          if (x.startsWith("-")) {
            if (/^-[dnOsuCc]$/.test(x)) c++;
            continue;
          }
          g(x);
        }
      } else if (n === "unset" && !u) It(s, t);
      let _ = r?.children[0],
        h = _?.type === "word" ? _.text.replace(/\\(.)/g, "$1") : void 0,
        p =
          h !== void 0 &&
          !U5r.has(h) &&
          !tt.has(h) &&
          !(Z === void 0 ? ct : fn).has(h);
      for (let c of e.children)
        if (c && (c.type !== "variable_assignment" || !p)) ce(c, t);
      return;
    }
    if (e.type === "declaration_command") {
      for (let n of e.children)
        if (
          n?.type === "string" ||
          n?.type === "raw_string" ||
          n?.type === "word" ||
          n?.type === "number" ||
          n?.type === "concatenation" ||
          n?.type === "variable_name"
        ) {
          let r = n.text.replace(/['"\\]/g, ""),
            i = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(r);
          if (i) T(t, required(i[1]));
          else {
            let s = r.indexOf("=");
            if (s > 0 && r.lastIndexOf("$", s - 1) !== -1)
              for (let o of Array.from(t.keys())) T(t, o);
          }
        }
    }
    for (let n of e.children) if (n) ce(n, t);
  }
  function te(e: Scope, t: Scope): void {
    for (let [n, r] of t) {
      let i = e.get(n);
      if (i !== void 0 && i !== r) {
        let s = ge(r);
        if (W.get(n) === s && ge(i) !== s) j = !0;
        T(e, n);
      }
    }
    for (let n of e.keys()) if (!t.has(n)) T(e, n);
  }
  function Ve(e: Scope, t: Environment, n = false): void {
    if (n) {
      T(e, t.name);
      return;
    }
    if (t.isAppend && !e.has(t.name)) return;
    let r = e.get(t.name);
    if (r !== void 0 && r !== t.value && !t.isAppend && !Ys(t.value)) {
      T(e, t.name);
      return;
    }
    let i = t.isAppend ? (r ?? "") + t.value : t.value;
    e.set(t.name, i);
  }
  function mn(e: string): string {
    return e.slice(1, -1);
  }
  function gn(e: Node): boolean {
    for (let t of e.children) {
      if (!t) continue;
      if (t.type === "simple_expansion" || t.type === "expansion") return !0;
      if (gn(t)) return !0;
    }
    return !1;
  }
  function wr(e: string): string | null {
    if (e === "~" || e.startsWith("~/")) return "HOME";
    if (e === "~+" || e.startsWith("~+/")) return "PWD";
    if (e === "~-" || e.startsWith("~-/")) return "OLDPWD";
    return null;
  }
  function Oe(e: Node, t: ReadonlySet<string>): string | null {
    let n = e.type === "variable_assignment";
    for (let r of e.children) {
      if (!r) continue;
      if (r.type === "variable_name") {
        if (n) continue;
        if (t.has(r.text)) return r.text;
      }
      if (r.type === "word") {
        let s = wr(r.text);
        if (s !== null && t.has(s)) return s;
      }
      let i = Oe(r, t);
      if (i !== null) return i;
    }
    return null;
  }
  function xn(e: Node): Refusal {
    let t = S(e);
    return t.kind === "too-complex"
      ? { ...t, divergentShape: !0, keepsRemovalVerdict: !0 }
      : t;
  }
  function S(e: Node): Refusal {
    if (e.type === "ERROR")
      return {
        kind: "too-complex",
        reason:
          Ht(e.text) || (e.text.startsWith("${") && BVo(e.text))
            ? "A $ followed by non-ASCII text in this command can't be checked before it runs"
            : "Parse error",
        nodeType: e.type,
      };
    let t = Sr.get(e.type);
    return {
      kind: "too-complex",
      reason: `${t === void 0 ? "This command" : `${t} in this command`} can't be checked before it runs`,
      nodeType: e.type,
    };
  }
  var Sr = new Map([
    ["simple_expansion", "A variable"],
    ["expansion", "A variable in braces"],
    ["command_substitution", "A nested command"],
    ["process_substitution", "A command used as a file"],
    ["brace_expression", "A brace pattern"],
    ["ansi_c_string", "Text with escape codes"],
    ["translated_string", "Translatable text"],
    ["test_command", "A test in brackets"],
    ["herestring_redirect", "A here-string"],
    ["heredoc_redirect", "A here-document"],
    ["subshell", "A group in parentheses"],
    ["compound_statement", "A group in braces or double parentheses"],
    ["for_statement", "A for or select loop"],
    ["c_style_for_statement", "A counting for loop"],
    ["while_statement", "A while or until loop"],
    ["until_statement", "An until loop"],
    ["if_statement", "An if statement"],
    ["case_statement", "A case statement"],
    ["function_definition", "A function definition"],
    ["array", "A list of values"],
    ["string", "Quoted text"],
    ["file_redirect", "A file redirect"],
    ["pipeline", "A pipeline"],
    ["concatenation", "Joined pieces of text"],
    ["variable_assignment", "A variable assignment"],
    ["variable_assignments", "Variable assignments"],
  ]);
  function Vti(e: string): string[] {
    let t = [],
      n = 0,
      r = !1,
      i = !1;
    while (n < e.length) {
      let s = e[n];
      if (s === "\\" && !r) {
        n += 2;
        continue;
      }
      if (s === "'" && !i) {
        {
          r = !r;
          n++;
        }
        continue;
      }
      if (s === '"' && !r) {
        {
          i = !i;
          n++;
        }
        continue;
      }
      if (!r && s === "$" && e[n + 1] === "{") {
        let o = 1,
          u = n + 2,
          a = !1,
          f = !1;
        while (u < e.length && o > 0) {
          let g = e[u];
          if (g === "\\" && !a) {
            u += 2;
            continue;
          }
          if (g === "'" && !f) a = !a;
          else if (g === '"' && !a) f = !f;
          else if (!a && !f) {
            if (g === "{") o++;
            else if (g === "}") o--;
          }
          u++;
        }
        {
          t.push(e.slice(n + 2, o === 0 ? u - 1 : u));
          n = u;
        }
        continue;
      }
      n++;
    }
    return t;
  }
  function JKt(e: string): string {
    let t = "",
      n = !1,
      r = !1;
    for (let i = 0; i < e.length; i++) {
      let s = e[i];
      if (n) {
        if (s === "'") {
          n = !1;
          t += s;
        }
        continue;
      }
      if (s === "\\" && !n) {
        let o = e[i + 1];
        if ((i++, o !== void 0 && !"$'\"`\\".includes(o))) t += o;
        continue;
      }
      if (s === '"') {
        {
          r = !r;
          t += s;
        }
        continue;
      }
      if (s === "'" && !r) {
        {
          n = !0;
          t += s;
        }
        continue;
      }
      t += s;
    }
    return t;
  }
  function Rct(e: string): string {
    let t = "",
      n;
    for (let r = 0; r < e.length; r++) {
      let i = e[r];
      if (n === "'") {
        if (i === "'") n = void 0;
        continue;
      }
      if (n === '"') {
        if (i === "\\") r++;
        else if (i === '"') n = void 0;
        continue;
      }
      if (i === "\\") {
        r++;
        continue;
      }
      if (i === "'" || i === '"') {
        n = i;
        continue;
      }
      t += i;
    }
    return t;
  }
  var B5r = [
      "strftime",
      "pcre_match",
      "zstat",
      "zselect",
      "zgetattr",
      "zlistattr",
      "ztie",
      "zuntie",
      "syserror",
      "zsystem",
      "zftp",
      "zcurses",
    ],
    yn = new Set([
      "zformat",
      "zparseopts",
      "zstyle",
      "zregexparse",
      "getln",
      "vared",
      ...B5r,
    ]);
  function _n(e: string, t: string[]): string | null {
    return e === "stat" && t.some((n) => /^-[gnNolLtTrs]*[AH]/.test(n)) && DY()
      ? "'stat' with -A or -H \u2014 zsh's stat builtin stores its result in the variable that option names, so a tracked value cannot be statically verified"
      : null;
  }
  var xct = new Set([
      "zmodload",
      "emulate",
      "sysopen",
      "sysread",
      "syswrite",
      "sysseek",
      "zpty",
      "ztcp",
      "zsocket",
      "zf_rm",
      "zf_mv",
      "zf_ln",
      "zf_chmod",
      "zf_chown",
      "zf_mkdir",
      "zf_rmdir",
      "zf_chgrp",
      "repeat",
      "foreach",
      "zcompile",
      "setopt",
      "unsetopt",
      "disable",
      "shopt",
      "autoload",
      "functions",
      ...yn,
    ]),
    Er = new Set([
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-delete",
      "-rm",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-fls",
      "-files0-from",
    ]);
  function QKt(e: string): boolean {
    return Er.has(e) && ero(e);
  }
  var Ar = new Set([
      "-name",
      "-iname",
      "-path",
      "-ipath",
      "-lname",
      "-ilname",
      "-regex",
      "-iregex",
      "-wholename",
      "-iwholename",
      "-samefile",
      "-newer",
      "-anewer",
      "-cnewer",
      "-mnewer",
      "-perm",
      "-user",
      "-group",
      "-uid",
      "-gid",
      "-size",
      "-type",
      "-xtype",
      "-fstype",
      "-inum",
      "-links",
      "-used",
      "-context",
      "-amin",
      "-cmin",
      "-mmin",
      "-atime",
      "-ctime",
      "-mtime",
      "-mindepth",
      "-maxdepth",
      "-printf",
      "-regextype",
      "-D",
      "-f",
      "-flags",
      "-Bnewer",
      "-Btime",
      "-Bmin",
      "-files0-from",
      "-xattrname",
    ]),
    Tr = /^-newer[aBcm][aBcmt]$/,
    bn = /^-(?:[EHLPXdsx]*D|f|[dsx]*[EHLPX][EHLPXdsx]*f)$/,
    $r = /^-[dsx]+f$/;
  function Mwn(e: string): boolean {
    return Ar.has(e) || Tr.test(e) || bn.test(e);
  }
  function zQn(e: string): boolean {
    return bn.test(e);
  }
  function VQn(e: string): boolean {
    return $r.test(e);
  }
  var uLe = new Set([
      "eval",
      "source",
      ".",
      "exec",
      "nocorrect",
      "fc",
      "coproc",
      "trap",
      "enable",
      "mapfile",
      "readarray",
      "hash",
      "bind",
      "complete",
      "compgen",
      "alias",
      "let",
    ]),
    m7e = new Set(["awk", "gawk", "mawk", "nawk"]),
    Pr = /^(?:-[FvW]$|--(?:fie|a$|as))/;
  function Dwn(e: string): string | false {
    if (/(?<![A-Za-z_])system[\s\\]*\(/.test(e))
      return "awk program contains system() which executes arbitrary commands";
    if (
      /(?:^|[^|])\|&?[^/|%";#{}]*"/.test(e) ||
      /(?:^|[^|])\|&?[\s\\]*getline\b/.test(e)
    )
      return 'awk program contains a command pipe (| "cmd" or | getline) which executes arbitrary commands';
    if (
      /@[\s\\]*(?:load|include)\b|@[\s\\]*\w+(?:::\w+)?(?:\[[^\]]*\])*[\s\\]*\(/.test(
        e,
      )
    )
      return "awk program contains @load/@include or an @indirect call which can execute arbitrary code";
    if (/(?<![A-Za-z_])extension[\s\\]*\(/.test(e))
      return "awk program contains extension() which loads arbitrary native code (legacy gawk)";
    if (/"\/inet[46]?\//.test(e))
      return "awk program opens a gawk /inet/ network socket which can exfiltrate data";
    return !1;
  }
  var k6e = new Set([
      "bash",
      "sh",
      "zsh",
      "dash",
      "ksh",
      "mksh",
      "ash",
      "hush",
      "rbash",
    ]),
    vr = new Set(["busybox", "toybox", "wsl", "su", "runuser"]),
    Nte = new Set([
      ...k6e,
      "fish",
      "csh",
      "tcsh",
      "rsh",
      ...vr,
      "cmd",
      "powershell",
      "pwsh",
    ]),
    fLe = new Set([
      "time",
      "command",
      "builtin",
      "noglob",
      "env",
      "nice",
      "nohup",
      "sudo",
      "doas",
      "stdbuf",
      "timeout",
    ]),
    pAe = new Set([
      "watch",
      "ionice",
      "chrt",
      "setsid",
      "taskset",
      "strace",
      "ltrace",
      "script",
      "flock",
      "unshare",
      "nsenter",
      "sandbox-exec",
    ]);
  function kn(e: string): boolean {
    return xct.has(e) && (!yn.has(e) || DY());
  }
  function qti(e: string): boolean {
    let t = KI(e);
    return (
      uLe.has(e) ||
      kn(e) ||
      pAe.has(e) ||
      pAe.has(t) ||
      t === "rm" ||
      t === "rmdir"
    );
  }
  var HVo: Readonly<Record<string, ReadonlySet<string> | undefined>> = {
      test: new Set(["-v", "-R", "-t"]),
      "[": new Set(["-v", "-R", "-t"]),
      "[[": new Set(["-v", "-R", "-t"]),
      printf: new Set(["-v"]),
      read: new Set(["-a"]),
      unset: new Set(["-v"]),
      wait: new Set(["-p"]),
    },
    Lwn = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]),
    ZKt = /^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/,
    NVo = new Set(["read", "unset"]),
    Ot = new Set([
      "declare",
      "typeset",
      "local",
      "export",
      "readonly",
      "private",
      "float",
      "integer",
    ]),
    FVo = /^[+-][-+\w:]*P/,
    nPt = new Set([
      "declare",
      "typeset",
      "local",
      "export",
      "readonly",
      "print",
      "getopts",
      "set",
      "zparseopts",
      "zformat",
      "zstyle",
      ...B5r,
      "autoload",
      "shift",
      "exit",
      "return",
      "break",
      "continue",
      "bye",
      "logout",
      "vared",
      "private",
      "getln",
      "zregexparse",
      "float",
      "integer",
    ]),
    $Vo = new Set([
      "pipefail",
      "errexit",
      "nounset",
      "xtrace",
      "noglob",
      "noclobber",
      "verbose",
      "monitor",
      "notify",
      "vi",
      "emacs",
      "errtrace",
      "functrace",
      "hashall",
      "physical",
      "ignoreeof",
    ]),
    UVo = new Set([
      "e",
      "u",
      "x",
      "f",
      "C",
      "v",
      "m",
      "b",
      "E",
      "T",
      "h",
      "P",
      "n",
    ]),
    Nr = new Set([
      "path",
      "home",
      "dirstack",
      "tmpprefix",
      "bash_env",
      "env",
      "cdpath",
      "globignore",
      "shell",
      "fpath",
      "bash_loadables_path",
      "module_path",
      "manpath",
      "mailpath",
      "readnullcmd",
      "nullcmd",
      "histfile",
      "zdotdir",
      "functions",
      "commands",
      "aliases",
      "galiases",
      "saliases",
      "bash_cmds",
      "bash_aliases",
      "execignore",
      "bash_source_path",
      "lang",
      "language",
      "lc_all",
      "lc_ctype",
      "lc_collate",
      "lc_messages",
      "lc_numeric",
      "lc_time",
      "histchars",
      "textdomain",
      "textdomaindir",
    ]),
    dt = new Set([
      "RANDOM",
      "SECONDS",
      "LINENO",
      "OPTIND",
      "MAILCHECK",
      "HISTCMD",
      "SRANDOM",
      "EPOCHSECONDS",
      "EPOCHREALTIME",
      "BASHPID",
      "BASH_MONOSECONDS",
      "BASH_TRAPSIG",
      "COLUMNS",
      "LINES",
      "SHLVL",
      "ERRNO",
      "TMOUT",
      "HISTSIZE",
      "SAVEHIST",
      "TRY_BLOCK_ERROR",
      "TRY_BLOCK_INTERRUPT",
      "KEYTIMEOUT",
      "LISTMAX",
      "LOGCHECK",
      "PERIOD",
      "FUNCNEST",
      "UID",
      "EUID",
      "GID",
      "EGID",
      "REPORTTIME",
      "REPORTMEMORY",
      "DIRSTACKSIZE",
      "BAUD",
      "ZLE_RPROMPT_INDENT",
      "MBEGIN",
      "MEND",
      "PPID",
      "ARGC",
      "ZSH_SUBSHELL",
      "TTYIDLE",
      "status",
    ]);
  function Rn(e: string, t: string): boolean {
    if (!dt.has(e)) return !1;
    if (t.includes("[") || t.includes("`") || /\$\(/.test(t) || Ys(t))
      return !0;
    if (!/^(0|[1-9][0-9]{0,17})$/.test(t)) return !0;
    return !1;
  }
  function qQn(e: string): boolean {
    let t = e.toLowerCase();
    return (
      Nr.has(t) ||
      t.startsWith("ld_") ||
      t.startsWith("dyld_") ||
      t.startsWith("bash_func_")
    );
  }
  function epe(e: string): boolean {
    return qQn(e) || e === "IFS" || e === "PS4" || e === "PROMPT4" || dt.has(e);
  }
  var le = new Set(["-p", "-d", "-n", "-N", "-t", "-u", "-i"]),
    Ct = new Set(["-p", "-t", "-n"]),
    Lt = new Set(["-t", "-n", "-N"]),
    Dt = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/,
    Ir = /^[A-Za-z_][A-Za-z0-9_]*\[/,
    Or = new Set(["-f", "-C", "-x", "-X", "-u"]),
    it = /\/proc\/.*\/environ/,
    Ee = /\n\s*#/;
  function v6e(
    e: Command[],
    t?: { sourceGlobRecord?: boolean; hasLoop?: boolean },
  ): NativeBashCommandSafety {
    let n = t?.sourceGlobRecord !== !1,
      r: NativeBashCommandSafety | null = null;
    for (let i of e) {
      let s = i.argv,
        o = !1;
      for (;;) {
        let h = s[0] === void 0 ? void 0 : KI(s[0]),
          p =
            h === "time" ||
            h === "nohup" ||
            h === "timeout" ||
            h === "nice" ||
            h === "stdbuf" ||
            h === "env" ||
            h === "command" ||
            h === "xargs"
              ? h
              : s[0];
        if (p === "time" || p === "nohup") {
          if (((s = s.slice(1)), s[0] !== void 0 && !/^[\w./~+-]+$/.test(s[0])))
            return {
              ok: !1,
              reason: `'${p} ${s[0]}' can't be checked before it runs`,
            };
        } else if (p === "timeout") {
          let c = 1;
          while (c < s.length) {
            let x = required(s[c]);
            if (
              x === "--foreground" ||
              x === "--preserve-status" ||
              x === "--verbose"
            )
              c++;
            else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(x)) c++;
            else if (
              (x === "--kill-after" || x === "--signal") &&
              s[c + 1] &&
              /^[A-Za-z0-9_.+-]+$/.test(required(s[c + 1]))
            )
              c += 2;
            else if (x.startsWith("--"))
              return {
                ok: !1,
                reason: `'timeout ${x}' can't be checked before it runs`,
              };
            else if (x === "-v") c++;
            else if (
              (x === "-k" || x === "-s") &&
              s[c + 1] &&
              /^[A-Za-z0-9_.+-]+$/.test(required(s[c + 1]))
            )
              c += 2;
            else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(x)) c++;
            else if (x.startsWith("-"))
              return {
                ok: !1,
                reason: `'timeout ${x}' can't be checked before it runs`,
              };
            else break;
          }
          if (s[c] && /^\d+(?:\.\d+)?[smhd]?$/.test(required(s[c])))
            s = s.slice(c + 1);
          else if (s[c])
            return {
              ok: !1,
              reason: `timeout duration '${s[c]}' can't be checked before it runs`,
            };
          else break;
        } else if (p === "nice")
          if (s[1] === "-n" && s[2] && /^-?\d+$/.test(s[2])) s = s.slice(3);
          else if (s[1] && /^-\d+$/.test(s[1])) s = s.slice(2);
          else if (s[1] && (/[$(`]/.test(s[1]) || Ys(s[1])))
            return {
              ok: !1,
              reason: `nice argument '${s[1]}' contains expansion \u2014 cannot statically determine wrapped command`,
            };
          else s = s.slice(1);
        else if (p === "env") {
          let c = 1;
          while (c < s.length) {
            let x = required(s[c]);
            if (x.includes("=") && !x.startsWith("-")) c++;
            else if (x === "-i" || x === "-0" || x === "-v") c++;
            else if (x === "-u" && s[c + 1]) c += 2;
            else if (x.startsWith("-"))
              return {
                ok: !1,
                reason: `'env ${x}' can't be checked before it runs`,
              };
            else break;
          }
          if (c < s.length) s = s.slice(c);
          else break;
        } else if (p === "stdbuf") {
          let c = 1;
          while (c < s.length) {
            let x = required(s[c]);
            if (Dn.test(x) && s[c + 1]) c += 2;
            else if (Mn.test(x)) c++;
            else if (zn.test(x)) c++;
            else if (x.startsWith("-"))
              return {
                ok: !1,
                reason: `'stdbuf ${x}' can't be checked before it runs`,
              };
            else break;
          }
          if (c > 1 && c < s.length) s = s.slice(c);
          else break;
        } else if (p === "command") {
          let c = 1,
            x = !1;
          while (
            c < s.length &&
            required(s[c]).startsWith("-") &&
            s[c] !== "--"
          ) {
            let d = required(s[c]);
            if (!/^-[pvV]+$/.test(d))
              return {
                ok: !1,
                reason: `'command ${d}' can't be checked before it runs`,
              };
            if (d.includes("v") || d.includes("V")) x = !0;
            c++;
          }
          if (s[c] === "--") c++;
          if (x || c >= s.length) break;
          s = s.slice(c);
        } else if (s[0] === "builtin" || s[0] === "noglob") {
          let c = s[0] === "builtin" && s[1] === "--" ? 2 : 1;
          if (c < s.length) s = s.slice(c);
          else break;
        } else if (p === "xargs")
          if (s.length >= 2 && !required(s[1]).startsWith("-")) {
            s = s.slice(1);
            o = !0;
          } else break;
        else break;
      }
      let u = s[0];
      if (u === void 0) continue;
      let a = KI(u);
      if (u === "")
        return {
          ok: !1,
          reason:
            "Empty command name \u2014 argv[0] may not reflect what bash runs",
        };
      if (Ys(u))
        return {
          ok: !1,
          reason: "Command name is runtime-determined (placeholder argv[0])",
        };
      if (u.startsWith("-") || u.startsWith("|") || u.startsWith("&"))
        return {
          ok: !1,
          reason: "Command appears to be an incomplete fragment",
        };
      let f = qr(HVo, a),
        g = a === "test" || a === "[" || a === "[[";
      if (f !== void 0)
        for (let h = 1; h < s.length; h++) {
          let p = required(s[h]),
            c = s[h + 1];
          if (f.has(p) && c !== void 0 && (c.includes("[") || Ys(c)))
            return {
              ok: !1,
              reason: `'${a} ${p}' operand contains array subscript or runtime-determined value \u2014 bash evaluates $(cmd) in subscripts`,
            };
          if (g) {
            if (p === "-t" && c !== void 0 && !ZKt.test(c))
              return {
                ok: !1,
                reason: `'${a} -t' operand is non-numeric \u2014 zsh arith-evals identifiers (may run $(cmd))`,
              };
            continue;
          }
          if (
            p.length > 2 &&
            p[0] === "-" &&
            p[1] !== "-" &&
            !p.includes("[")
          ) {
            for (let x of f)
              if (x.length === 2 && p.includes(required(x[1]))) {
                let d = s[h + 1];
                if (d !== void 0 && (d.includes("[") || Ys(d)))
                  return {
                    ok: !1,
                    reason: `'${a} ${x}' (combined in '${p}') operand contains array subscript \u2014 bash evaluates $(cmd) in subscripts`,
                  };
              }
          }
          if (p.length > 2 && p[0] === "-" && a !== "read")
            for (let x of f) {
              if (x.length !== 2) continue;
              let d = p.indexOf(required(x[1]), 1);
              if (d === -1 || d === p.length - 1) continue;
              let m = p.slice(d + 1);
              if (/[A-Za-z_][A-Za-z0-9_]*\[/.test(m) || Ys(m))
                return {
                  ok: !1,
                  reason: `'${a} ${x}' (fused in '${p}') operand contains array subscript \u2014 bash evaluates $(cmd) in subscripts`,
                };
            }
        }
      if (g)
        for (let h = 2; h < s.length; h++) {
          if (!Lwn.has(required(s[h]))) continue;
          for (let p of [s[h - 1], s[h + 1]]) {
            if (p === void 0) continue;
            if (p.includes("[") || !ZKt.test(p))
              return {
                ok: !1,
                reason: `'${a} ... ${s[h]} ...' operand is non-numeric \u2014 \`[[\` arithmetically evaluates identifiers/subscripts (may run $(cmd))`,
              };
          }
        }
      if (NVo.has(a)) {
        let h: boolean | "numeric" | "prompt" | "string" = false;
        for (let p = 1; p < s.length; p++) {
          let c = required(s[p]);
          if (h !== !1) {
            let x = h;
            if (((h = !1), x === "numeric" && !Dt.test(c)))
              return {
                ok: !1,
                reason: `'read ${s[p - 1]}' operand '${c}' is non-numeric \u2014 zsh arith-evals subscripts/expressions (may run $(cmd))`,
              };
            if (
              x === "prompt" &&
              (Ir.test(c) ||
                (c[0] === "-" && /[A-Za-z_][A-Za-z0-9_]*\[/.test(c)) ||
                c.includes(pJ))
            )
              return {
                ok: !1,
                reason: `'read ${s[p - 1]}' operand '${c}' is a subscripted NAME, dash-prefixed with a subscript, or runtime-determined \u2014 zsh -p takes no operand; may arith-eval the subscript and run $(cmd)`,
              };
            continue;
          }
          if (c[0] === "-") {
            if (a === "read") {
              if (Lt.has(c)) h = "numeric";
              else if (c === "-p") h = "prompt";
              else if (le.has(c)) h = "string";
              else if (c.length > 2)
                for (let x = 1; x < c.length; x++) {
                  let d = "-" + c[x],
                    m = Lt.has(d);
                  if (m || le.has(d)) {
                    if (x === c.length - 1)
                      h = m ? "numeric" : d === "-p" ? "prompt" : "string";
                    else if (m && !Dt.test(c.slice(x + 1)))
                      return {
                        ok: !1,
                        reason: `'read ${d}' (fused in '${c}') operand is non-numeric \u2014 zsh arith-evals subscripts/expressions (may run $(cmd))`,
                      };
                    else if (d === "-p") {
                      let b = c.slice(x + 1);
                      if (/[A-Za-z_][A-Za-z0-9_]*\[/.test(b) || b.includes(pJ))
                        return {
                          ok: !1,
                          reason: `'read -p' fused remainder '${b}' contains a subscripted identifier or cmdsub \u2014 on zsh (-p is no-arg) this may reach matheval via a following option and run $(cmd)`,
                        };
                    }
                    break;
                  }
                }
            }
            continue;
          }
          if (c.includes("[") || Ys(c))
            return {
              ok: !1,
              reason: `'${a}' positional NAME '${c}' contains array subscript or runtime-determined value \u2014 bash evaluates $(cmd) in subscripts`,
            };
        }
      }
      if (nPt.has(a)) {
        let h = a === "declare" || a === "typeset" || a === "local",
          p = h || a === "export" || a === "readonly",
          c = h || a === "readonly",
          x = !1,
          d = !1;
        for (let y = 1; y < s.length; y++) {
          let w = required(s[y]);
          if (c) {
            if (/^[+-].*f/.test(w)) x = !0;
            if (/^[+-].*[uU]/.test(w)) d = !0;
            if (x && d)
              return {
                ok: !1,
                reason: `'${a}' with both -f and -u/-U flags (reached as plain command via wrapper/quote) \u2014 zsh marks a function for autoload (synonym of 'autoload')`,
              };
          }
          if (h && at.test(w))
            return {
              ok: !1,
              reason: `'${a}' with -n/-i/-a/-A/-E/-F/-L/-R/-Z/-l/-u flag (reached as plain command via wrapper/quote) changes assignment eval semantics`,
            };
          if (Ot.has(a) && /^[+-].*[iluEFLRZ]/.test(w))
            return {
              ok: !1,
              reason: `'${a}' with -i/-E/-F/-L/-R/-Z/-l/-u flag (reached as plain command via wrapper/quote) \u2014 zsh bin_typeset mathevals, width-truncates, or case-converts the value`,
            };
          if ((p || a === "private") && /^[+-].*m/.test(w))
            return {
              ok: !1,
              reason: `'${a}' with -m/+m flag (reached as plain command via wrapper/quote) \u2014 zsh pattern-assigns every matching variable`,
            };
          if (Ot.has(a) && /^[+-].*T/.test(w))
            return {
              ok: !1,
              reason: `'${a} -T' creates a user-defined zsh tied pair \u2014 tracked literals for its operands are unreliable`,
            };
          let k = w.includes("[") && /[$`]/.test(w);
          if (k || Ys(w))
            return {
              ok: !1,
              reason: k
                ? `'${a}' operand '${eB(w)}' contains array subscript with expansion \u2014 shell arith-evals $(cmd) in subscripts`
                : `'${a}' operand '${eB(w)}' is runtime-determined and may carry an array subscript \u2014 shell arith-evals $(cmd) in subscripts`,
            };
          if ((a === "float" || a === "integer") && !/^[+-]/.test(w))
            return {
              ok: !1,
              reason: `zsh '${a}' operand \u2014 implicit typeset -E/-i arithmetically evaluates the (existing or assigned) value`,
            };
        }
        let m = p && u === a ? Vt(a, s.slice(1)) : null;
        if (m !== null) return { ok: !1, reason: m };
        let b =
          u === a && (t?.hasLoop !== !1 || i !== e.at(-1))
            ? qt(a, s.slice(1))
            : null;
        if (b !== null) return { ok: !1, reason: b };
      }
      if (a === "printf")
        for (let h = 1; h < s.length; h++) {
          let p = required(s[h]),
            c = p.includes("[") && /[$`]/.test(p);
          if (c || Ys(p))
            return {
              ok: !1,
              reason: c
                ? `printf operand '${eB(p)}' contains array subscript with expansion \u2014 zsh arith-evals %d/%i operands (may run $(cmd))`
                : `printf operand '${eB(p)}' is runtime-determined and may carry an array subscript \u2014 zsh arith-evals %d/%i operands (may run $(cmd))`,
            };
        }
      if (a === "set")
        for (let h = 1; h < s.length; h++) {
          let p = required(s[h]);
          if (p === "--") break;
          if (!/^[-+]/.test(p)) continue;
          for (let c = 1; c < p.length; c++) {
            let x = required(p[c]);
            if (x === "o") {
              let d = c < p.length - 1 ? p.slice(c + 1) : s[h + 1];
              if (
                d !== void 0 &&
                d !== "" &&
                !$Vo.has(d.toLowerCase().replace(/[_-]/g, ""))
              )
                return {
                  ok: !1,
                  reason: `'set -o/+o ${d}' changes shell parsing/globbing state \u2014 can enable globsubst/extendedglob and defeat static analysis`,
                };
              if (c === p.length - 1) h++;
              break;
            }
            if (x === "A") break;
            if (!UVo.has(x))
              return {
                ok: !1,
                reason: `'set ${p[0]}${x}' changes shell option state (allexport/keyword/\u2026) \u2014 defeats static env-var analysis; see SET_O_SAFE_LETTERS`,
              };
          }
        }
      if (a === "print" && s.some((h) => FVo.test(h)))
        return {
          ok: !1,
          reason: "What 'print -P' expands can't be checked before it runs",
        };
      if (a === "jobs")
        for (let h = 1; h < s.length; h++) {
          let p = required(s[h]);
          if (/^[+-].*x/.test(p))
            return {
              ok: !1,
              reason: "What 'jobs -x' starts can't be checked before it runs",
            };
        }
      if (YQn.has(u))
        return {
          ok: !1,
          reason: `Shell keyword '${a}' as command name \u2014 tree-sitter mis-parse`,
        };
      if (o) {
        if (a === "find" || a === "jq")
          return {
            ok: !1,
            reason: `What xargs adds to ${a} can't be checked before it runs`,
          };
        if (m7e.has(a)) {
          let h: boolean | "numeric" | "prompt" | "string" = false;
          for (let p = 1; p < s.length; p++) {
            let c = required(s[p]);
            if (c === "--") {
              h = p + 1 < s.length;
              break;
            }
            if (c === "-" || !c.startsWith("-")) {
              h = !0;
              break;
            }
            if (!c.includes("=") && Pr.test(c)) p++;
          }
          if (!h)
            return {
              ok: !1,
              reason: `The program xargs gives ${a} can't be checked before it runs`,
            };
        }
      }
      if (a === "jq") {
        for (let h of s) {
          if (/\bsystem\s*\(/.test(h))
            return {
              ok: !1,
              reason:
                "jq command contains system() function which executes arbitrary commands",
            };
          if (/\b(?:include|import)\b/.test(h))
            return {
              ok: !1,
              reason:
                'jq command contains include/import \u2014 modules can load arbitrary .jq files via {search:"."} and call env or other builtins',
            };
        }
        if (
          s.some((h) =>
            /^(?:-[A-Za-z]*[fL]|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(
              h,
            ),
          )
        )
          return {
            ok: !1,
            reason:
              "jq command contains dangerous flags that could execute code or read arbitrary files",
          };
      }
      if (m7e.has(a)) {
        if (i.hasUnquotedGlob || (n && E6e(i)))
          return {
            ok: !1,
            reason:
              "awk command contains unquoted glob characters \u2014 could glob-expand to a planted program or flag before awk runs",
          };
        for (let h of s) {
          let p = Dwn(h);
          if (p !== !1) return { ok: !1, reason: p };
          if (Ys(h))
            return {
              ok: !1,
              reason: "awk is given text that can't be checked before it runs",
            };
        }
        if (
          s.some(
            (h) =>
              /^-[bcCghIkMnNOPrsStV]*[fEileDW]/.test(h) ||
              /^--(?:fil|e|i|lo|s|de)/.test(h),
          )
        )
          return {
            ok: !1,
            reason: "awk has an option that can't be checked before it runs",
          };
      }
      if (a === "find") {
        if (i.hasUnquotedGlob || (n && E6e(i)))
          return {
            ok: !1,
            reason:
              "find contains unquoted glob characters \u2014 could glob-expand to a dangerous action before find runs",
          };
        let h: boolean | "numeric" | "prompt" | "string" = false;
        for (let p = 1; p < s.length; p++) {
          let c = required(s[p]),
            x = h;
          if (((h = !1), QKt(c)))
            return {
              ok: !1,
              reason: `find with '${c}' executes commands or modifies files \u2014 cannot be auto-allowed by a Bash(find:*) prefix rule`,
            };
          if (VQn(c))
            return {
              ok: !1,
              reason: `find option '${c}' is read differently by different versions of find \u2014 could hide a following action`,
            };
          if (!x && zQn(c)) {
            h = !0;
            continue;
          }
          if (!x && Mwn(c)) {
            p++;
            continue;
          }
          if (Ys(c))
            return {
              ok: !1,
              reason:
                "find argument is runtime-determined \u2014 could resolve to a dangerous action",
            };
          if (/[[\]*?]/.test(c))
            return {
              ok: !1,
              reason: `find argument '${c}' contains glob characters \u2014 could glob-expand to a dangerous action`,
            };
        }
      }
      if (kn(u))
        return {
          ok: !1,
          reason: `Zsh builtin '${a}' can bypass security checks`,
        };
      let _ = _n(u, s.slice(1));
      if (_ !== null) return { ok: !1, reason: _ };
      if (uLe.has(u))
        if (a === "fc" && !s.slice(1).some((h) => /^[+-].*[es]/.test(h))) {
        } else if (
          a === "compgen" &&
          !s.slice(1).some((h) => /^[+-].*[CFW]/.test(h))
        ) {
        } else
          return { ok: !1, reason: `'${a}' evaluates arguments as shell code` };
      if (pAe.has(a) && s.length > 1)
        return {
          ok: !1,
          reason: `What '${a}' starts can't be checked before it runs`,
        };
      for (let h of i.argv)
        if (h.includes("/proc/") && it.test(h))
          return {
            ok: !1,
            reason: "Accesses /proc/*/environ which may expose secrets",
          };
      for (let h of i.redirects)
        if (h.target.includes("/proc/") && it.test(h.target))
          return {
            ok: !1,
            reason: "Accesses /proc/*/environ which may expose secrets",
          };
      for (let h of i.argv)
        if (
          h.includes(`
`) &&
          Ee.test(h)
        )
          r ??= {
            ok: !1,
            kind: "newline-hash",
            reason:
              "Newline followed by # inside a quoted argument can hide arguments from path validation",
          };
      for (let h of i.envVars)
        if (
          h.value.includes(`
`) &&
          Ee.test(h.value)
        )
          r ??= {
            ok: !1,
            kind: "newline-hash",
            reason:
              "Newline followed by # inside an env var value can hide arguments from path validation",
          };
      for (let h of i.redirects)
        if (
          h.target.includes(`
`) &&
          Ee.test(h.target)
        )
          r ??= {
            ok: !1,
            kind: "newline-hash",
            reason:
              "Newline followed by # inside a redirect target can hide arguments from path validation",
          };
    }
    if (r) return r;
    return { ok: !0 };
  }

  const parseAbortReceipt: { parseAbort: typeof $b } = { parseAbort: $b };
  const nativeAbortReceipt: { $b: typeof $b } = { $b };

  return {
    parser,
    features,
    analyze: oR,
    analyzeTree: SG,
    commandSafety: v6e,
    observeCutShort: qMa,
    isCutShort: KMa,
    isBudgetError: Uti,
    withBudget: YMa,
    observeBudget: M5r,
    checkBudget: Bti,
    resetSplicedBudget: XMa,
    parseCommand: PVo,
    parse: V1,
    ...parseAbortReceipt,
    native: {
      KI,
      QMa,
      KMa,
      Uti,
      YMa,
      M5r,
      Bti,
      XMa,
      Qxt,
      dLe,
      JMa,
      PVo,
      ...nativeAbortReceipt,
      V1,
      cLe,
      Zxt,
      jti,
      OVo,
      pJ,
      Ys,
      IVo,
      Wti,
      eB,
      Act,
      Gti,
      zti,
      MVo,
      p7e,
      ePt,
      tPt,
      XKt,
      D5r,
      L5r,
      DVo,
      H5r,
      N5r,
      LVo,
      E6e,
      oR,
      F5r,
      SG,
      Iwn,
      $5r,
      U5r,
      Vti,
      JKt,
      Rct,
      B5r,
      xct,
      QKt,
      Mwn,
      zQn,
      VQn,
      uLe,
      m7e,
      Dwn,
      k6e,
      Nte,
      fLe,
      pAe,
      qti,
      HVo,
      Lwn,
      ZKt,
      NVo,
      FVo,
      nPt,
      $Vo,
      UVo,
      qQn,
      epe,
      v6e,
    },
  };
}
export type NativeBashSemantics = ReturnType<typeof createNativeBashSemantics>;
